// Jednorazowy przebieg kolejki e-mail (Railway cron). Prototyp — nie jest wdrożony.
//
// runEmailBatch(env, { transport, dryRun, now })
//   1. (live) wiersze „sending” starsze niż LEASE_MINUTES → failed/delivery_unknown
//      (nie wiemy, czy wyszły — nie ponawiamy, żeby nie zdublować wiadomości);
//   2. w jednej transakcji pod blokadą advisory: liczy pozostały limit dnia
//      (EMAIL_DAILY_LIMIT − EMAIL_DAILY_RESERVED − wszystkie wpisy dziennika dnia,
//      także „other”), dzienny przydział kampanii (daily_cap), pobiera wiersze
//      FOR UPDATE SKIP LOCKED i dla każdego tuż przed wysyłką sprawdza:
//      wpłatę (kampania „brak wpisu wpłaty”), listę wyłączeń, zgodę na kontakt,
//      listę adresów testowych poza produkcją; rezerwuje limit wpisem w dzienniku;
//   3. poza transakcją wysyła każdą wiadomość osobno i zapisuje wynik.
// Dry-run wykonuje te same sprawdzenia i renderuje treść, ale nie zmienia stanu
// kolejki ani dziennika limitu i nie woła transportu — zapisuje tylko przebieg.
// Ponowne uruchomienie nie dubluje wiadomości: unikalny klucz kampania+rodzina,
// przejścia stanów pilnowane triggerem, a wysyłany jest tylko wiersz przejęty
// z „queued” do „sending” w tej samej transakcji.

import { EmailTransportError, emailConfig, liveRunRefusal, recipientRefusal } from './brevo.js';
import { contentHash, renderMessage } from './content.js';
import { insertAuditEvent } from '../pg/audit.js';

const QUOTA_LOCK_ID = 732481707;
export const LEASE_MINUTES = 15;
const BACKOFF_BASE_MINUTES = 5;
const BACKOFF_MAX_MINUTES = 6 * 60;

export function utcDay(now) {
  return now.toISOString().slice(0, 10);
}

export function backoffMinutes(attempts) {
  return Math.min(BACKOFF_MAX_MINUTES, BACKOFF_BASE_MINUTES * 2 ** Math.max(0, attempts - 1));
}

// Dzienny przydział kampanii: rozłożenie na co najmniej minDays dni
// (~2000 adresatów → 286/dzień → 7 dni), ale nie mniej niż minDailyCap,
// żeby mała kampania nie trwała tygodnia; nigdy ponad limit konta.
export function campaignDailyCap(recipientCount, config) {
  const spread = Math.ceil(Math.max(1, recipientCount) / config.minDays);
  const accountDaily = Math.max(1, config.dailyLimit - config.dailyReserved);
  return Math.max(1, Math.min(accountDaily, Math.max(spread, config.minDailyCap)));
}

export function planDays(recipientCount, dailyCap, config) {
  if (!recipientCount) return 0;
  const perDay = Math.min(dailyCap, Math.max(0, config.dailyLimit - config.dailyReserved));
  return perDay > 0 ? Math.ceil(recipientCount / perDay) : null;
}

// Zużycie limitu przez inne wiadomości konta (np. zaproszenia), aby kolejka
// kampanii ich nie wypierała. Wpis jest trwały (dziennik tylko do dopisywania).
export async function recordOtherSends(executor, { day, count }) {
  await executor.query(
    `INSERT INTO email_send_ledger (id, day, source, message_count) VALUES ($1, $2, 'other', $3)`,
    [crypto.randomUUID(), day, count],
  );
}

export async function remainingQuota(executor, day, config) {
  const { rows } = await executor.query(
    'SELECT COALESCE(SUM(message_count), 0)::int AS used FROM email_send_ledger WHERE day = $1',
    [day],
  );
  return Math.max(0, config.dailyLimit - config.dailyReserved - Number(rows[0].used));
}

async function recheckRow(tx, campaign, row, config) {
  if (campaign.audience === 'no_payment_record') {
    const paid = await tx.query(
      `SELECT 1 FROM household_payment_totals
        WHERE household_id = $1 AND school_year_id = $2 AND net_amount_cents > 0 LIMIT 1`,
      [row.household_id, campaign.school_year_id],
    );
    if (paid.rows[0]) return { state: 'skipped', error: 'payment_recorded' };
  }
  const suppressed = await tx.query('SELECT 1 FROM email_suppressions WHERE email_hash = $1', [row.email_hash]);
  if (suppressed.rows[0]) return { state: 'suppressed', error: 'address_suppressed' };
  const consent = await tx.query(
    `SELECT 1
       FROM guardians g
       JOIN student_guardians sg ON sg.guardian_id = g.id
       JOIN students s ON s.id = sg.student_id
      WHERE g.id = $1 AND s.household_id = $2
        AND g.contact_allowed AND sg.contact_allowed
        AND lower(btrim(g.email)) = $3
        AND (sg.starts_on IS NULL OR sg.starts_on <= $4::date)
        AND (sg.ends_on IS NULL OR sg.ends_on >= $4::date)
      LIMIT 1`,
    [row.guardian_id, row.household_id, row.email, row.day],
  );
  if (!consent.rows[0]) return { state: 'suppressed', error: 'consent_or_address_changed' };
  const refusal = recipientRefusal(config, row.email);
  if (refusal) return { state: 'failed', error: refusal };
  return null;
}

async function recordRun(db, run) {
  await db.query(
    `INSERT INTO email_worker_runs (id, mode, day, started_at, remaining_quota, planned, sent, retried, failed, skipped, suppressed, stopped_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [crypto.randomUUID(), run.mode, run.day, run.startedAt.toISOString(), run.remainingQuota, run.planned,
      run.sent, run.retried, run.failed, run.skipped, run.suppressed, run.stoppedReason ?? null],
  );
}

async function recoverStale(db, now) {
  const { rows } = await db.query(
    `UPDATE email_outbox SET state = 'failed', last_error = 'delivery_unknown', updated_at = $1
      WHERE state = 'sending' AND claimed_at < $1::timestamptz - make_interval(mins => $2)
      RETURNING id, campaign_id`,
    [now.toISOString(), LEASE_MINUTES],
  );
  for (const row of rows) {
    await insertAuditEvent(db, {
      action: 'email.delivery_unknown', entityType: 'email_outbox', entityId: row.id,
      metadata: { campaignId: row.campaign_id },
    });
  }
  return rows.length;
}

// Przejmuje wiersze do wysyłki. W dry-run tylko liczy i nic nie zapisuje.
async function claim(db, { config, now, day, dryRun, run }) {
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [QUOTA_LOCK_ID]);
    let remaining = await remainingQuota(tx, day, config);
    run.remainingQuota = remaining;
    let batchLeft = config.batchSize;
    const claimed = [];
    const { rows: campaigns } = await tx.query(
      `SELECT c.id, c.school_year_id, c.audience, c.subject, c.body_text, c.content_hash,
              c.approved_content_hash, c.approved_recipients_hash, c.recipients_hash, c.daily_cap,
              y.label AS school_year_label,
              (SELECT COUNT(*)::int FROM email_send_ledger l WHERE l.day = $1 AND l.campaign_id = c.id) AS sent_today
         FROM email_campaigns c JOIN school_years y ON y.id = c.school_year_id
        WHERE c.status = 'sending'
        ORDER BY c.queued_at, c.id
        FOR UPDATE OF c`,
      [day],
    );
    for (const campaign of campaigns) {
      if (remaining <= 0 || batchLeft <= 0) break;
      // Ostatnia kontrola: treść w bazie odpowiada zatwierdzonemu skrótowi.
      const hash = contentHash({ schoolYearId: campaign.school_year_id, audience: campaign.audience, subject: campaign.subject, bodyText: campaign.body_text });
      if (hash !== campaign.content_hash || hash !== campaign.approved_content_hash
          || campaign.recipients_hash !== campaign.approved_recipients_hash) {
        run.stoppedReason = 'approval_mismatch';
        continue;
      }
      let capLeft = campaign.daily_cap - campaign.sent_today;
      if (capLeft <= 0) continue;
      const { rows } = await tx.query(
        `SELECT o.id, o.household_id, o.idempotency_key, o.attempts,
                r.guardian_id, r.email, r.email_hash, $2::date AS day
           FROM email_outbox o
           JOIN email_campaign_recipients r ON r.id = o.recipient_id
          WHERE o.campaign_id = $1 AND o.state = 'queued' AND o.next_attempt_at <= $3::timestamptz
          ORDER BY o.created_at, o.id
          LIMIT $4
          FOR UPDATE OF o SKIP LOCKED`,
        [campaign.id, day, now.toISOString(), batchLeft],
      );
      for (const row of rows) {
        if (remaining <= 0 || capLeft <= 0 || batchLeft <= 0) break;
        row.day = day;
        const verdict = await recheckRow(tx, campaign, row, config);
        if (verdict) {
          run[verdict.state === 'skipped' ? 'skipped' : verdict.state === 'suppressed' ? 'suppressed' : 'failed'] += 1;
          if (!dryRun) {
            await tx.query(
              `UPDATE email_outbox SET state = $2, last_error = $3, updated_at = $4 WHERE id = $1`,
              [row.id, verdict.state, verdict.error, now.toISOString()],
            );
            await insertAuditEvent(tx, {
              action: `email.${verdict.state}`, entityType: 'email_outbox', entityId: row.id,
              metadata: { campaignId: campaign.id, reason: verdict.error },
            });
          }
          continue;
        }
        const message = renderMessage(campaign, { schoolYearLabel: campaign.school_year_label, householdId: row.household_id });
        run.planned += 1;
        remaining -= 1;
        capLeft -= 1;
        batchLeft -= 1;
        if (dryRun) {
          if (!run.sample) run.sample = { campaignId: campaign.id, subject: message.subject };
          continue;
        }
        await tx.query(
          `UPDATE email_outbox SET state = 'sending', attempts = attempts + 1, claimed_at = $2, updated_at = $2
            WHERE id = $1 AND state = 'queued'`,
          [row.id, now.toISOString()],
        );
        await tx.query(
          `INSERT INTO email_send_ledger (id, day, source, campaign_id, outbox_id, attempt, message_count)
           VALUES ($1, $2, 'campaign', $3, $4, $5, 1)`,
          [crypto.randomUUID(), day, campaign.id, row.id, row.attempts + 1],
        );
        claimed.push({ ...row, attempts: row.attempts + 1, campaignId: campaign.id, message });
      }
    }
    if (remaining <= 0 && !run.stoppedReason) run.stoppedReason = 'daily_quota_reached';
    return claimed;
  });
}

async function deliver(db, item, { transport, config, now }) {
  try {
    const result = await transport.send({
      to: item.email,
      sender: config.sender,
      subject: item.message.subject,
      text: item.message.text,
      outboxId: item.id,
      idempotencyKey: item.idempotency_key,
    });
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE email_outbox SET state = 'sent', sent_at = $2, provider_message_id = $3, last_error = NULL, updated_at = $2
          WHERE id = $1 AND state = 'sending'`,
        [item.id, now.toISOString(), result?.messageId ?? null],
      );
      await insertAuditEvent(tx, {
        action: 'email.sent', entityType: 'email_outbox', entityId: item.id,
        metadata: { campaignId: item.campaignId, householdId: item.household_id },
      });
    });
    return 'sent';
  } catch (error) {
    const known = error instanceof EmailTransportError;
    const code = known && /^[a-z0-9_]{1,60}$/.test(error.code) ? error.code : 'transport_error';
    const retry = known && error.retryable && item.attempts < config.maxAttempts;
    await db.transaction(async (tx) => {
      if (retry) {
        await tx.query(
          `UPDATE email_outbox SET state = 'queued', last_error = $2, updated_at = $3,
                  next_attempt_at = $3::timestamptz + make_interval(mins => $4)
            WHERE id = $1 AND state = 'sending'`,
          [item.id, code, now.toISOString(), backoffMinutes(item.attempts)],
        );
      } else {
        await tx.query(
          `UPDATE email_outbox SET state = 'failed', last_error = $2, updated_at = $3 WHERE id = $1 AND state = 'sending'`,
          [item.id, code, now.toISOString()],
        );
      }
      await insertAuditEvent(tx, {
        action: retry ? 'email.retry_scheduled' : 'email.failed', entityType: 'email_outbox', entityId: item.id,
        metadata: { campaignId: item.campaignId, reason: code },
      });
    });
    return retry ? 'retried' : 'failed';
  }
}

async function completeCampaigns(db, now) {
  const { rows } = await db.query(
    `UPDATE email_campaigns c SET status = 'done', completed_at = $1
      WHERE c.status = 'sending'
        AND NOT EXISTS (SELECT 1 FROM email_outbox o WHERE o.campaign_id = c.id AND o.state IN ('queued', 'sending'))
      RETURNING id`,
    [now.toISOString()],
  );
  for (const row of rows) {
    await insertAuditEvent(db, { action: 'email.campaign.done', entityType: 'email_campaign', entityId: row.id });
  }
}

export async function runEmailBatch(env, { transport = null, dryRun = true, now = new Date(), config = emailConfig(env) } = {}) {
  const db = env?.db;
  if (!db) throw new Error('database_unavailable');
  const day = utcDay(now);
  const run = {
    mode: dryRun ? 'dry_run' : 'live', day, startedAt: now, remainingQuota: 0,
    planned: 0, sent: 0, retried: 0, failed: 0, skipped: 0, suppressed: 0, stoppedReason: null, sample: null,
  };
  if (!dryRun) {
    const refusal = liveRunRefusal(config) ?? (transport ? null : 'transport_missing');
    if (refusal) {
      run.stoppedReason = refusal;
      run.remainingQuota = await remainingQuota(db, day, config);
      await recordRun(db, run);
      return run;
    }
    await recoverStale(db, now);
  }
  const claimed = await claim(db, { config, now, day, dryRun, run });
  for (const item of claimed) {
    const outcome = await deliver(db, item, { transport, config, now });
    run[outcome] += 1;
  }
  if (!dryRun) await completeCampaigns(db, now);
  await recordRun(db, run);
  return run;
}
