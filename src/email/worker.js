// Jednorazowy przebieg kolejki e-mail (Railway cron). Prototyp — nie jest wdrożony.
//
// runEmailBatch(env, { transport, dryRun, now })
//   1. (live) wiersze „sending” z wygasłą dzierżawą (LEASE_MINUTES): jeśli
//      wysyłka się rozpoczęła (send_started_at) albo wiersz pochodzi sprzed
//      tokenu przebiegu → failed/delivery_unknown (nie wiemy, czy wyszły — nie
//      ponawiamy); jeśli przebieg nie zdążył ich przekazać dostawcy → z powrotem
//      do „queued” (lease_expired). Stary przebieg traci je, bo nie ma już tokenu;
//   2. w jednej transakcji pod blokadą advisory: liczy pozostały limit dnia
//      (EMAIL_DAILY_LIMIT − EMAIL_DAILY_RESERVED − wszystkie wpisy dziennika dnia,
//      także „other”), dzienny przydział kampanii (daily_cap), pobiera wiersze
//      FOR UPDATE SKIP LOCKED i dla każdego przy przejęciu sprawdza:
//      wpłatę (kampania „brak wpisu wpłaty”), listę wyłączeń, zgodę na kontakt,
//      listę adresów testowych poza produkcją; rezerwuje limit wpisem w dzienniku;
//   3. przed KAŻDĄ wysyłką potwierdza wiersz jedną instrukcją UPDATE … RETURNING
//      (confirmSend): nadal „sending”, nadal z tokenem tego przebiegu
//      (claim_token), kampania nadal „sending”, brak wpłaty (dla „brak wpisu
//      wpłaty”), adres nie na liście wyłączeń, zgoda nadal jest. Tylko wtedy
//      ustawia send_started_at i woła transport. W przeciwnym razie, w tej samej
//      transakcji, wiersz dostaje cancelled/skipped/suppressed z powodem
//      i zdarzeniem audytu (albo — gdy należy już do innego przebiegu — jest
//      pomijany ze zdarzeniem email.send_aborted). Anulowanie w trakcie partii
//      zatrzymuje więc wszystko poza wiadomością, której wysyłka już trwa (#210);
//   4. wynik zapisuje tylko, jeśli wiersz nadal należy do przebiegu; inaczej
//      zdarzenie email.sent_after_lease_lost zamiast email.sent (#177).
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
  return db.transaction(async (tx) => {
    // Wiersz z tokenem, którego wysyłka się nie rozpoczęła, na pewno nie wyszedł —
    // wraca do kolejki. Pozostałe (wysyłka rozpoczęta albo wiersz sprzed
    // migracji 0025 bez tokenu) → delivery_unknown, bez ponawiania.
    const { rows } = await tx.query(
      `UPDATE email_outbox
          SET state = CASE WHEN claim_token IS NOT NULL AND send_started_at IS NULL THEN 'queued' ELSE 'failed' END,
              last_error = CASE WHEN claim_token IS NOT NULL AND send_started_at IS NULL THEN 'lease_expired' ELSE 'delivery_unknown' END,
              next_attempt_at = CASE WHEN claim_token IS NOT NULL AND send_started_at IS NULL THEN $1::timestamptz ELSE next_attempt_at END,
              updated_at = $1
        WHERE state = 'sending' AND claimed_at < $1::timestamptz - make_interval(mins => $2)
        RETURNING id, campaign_id, state`,
      [now.toISOString(), LEASE_MINUTES],
    );
    for (const row of rows) {
      await insertAuditEvent(tx, {
        action: row.state === 'queued' ? 'email.lease_expired_requeued' : 'email.delivery_unknown',
        entityType: 'email_outbox', entityId: row.id,
        metadata: { campaignId: row.campaign_id },
      });
    }
    return rows.length;
  });
}

// Przejmuje wiersze do wysyłki. W dry-run tylko liczy i nic nie zapisuje.
async function claim(db, { config, now, day, dryRun, run, runToken }) {
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
          `UPDATE email_outbox SET state = 'sending', attempts = attempts + 1, claimed_at = $2, updated_at = $2,
                  claim_token = $3, send_started_at = NULL
            WHERE id = $1 AND state = 'queued'`,
          [row.id, now.toISOString(), runToken],
        );
        await tx.query(
          `INSERT INTO email_send_ledger (id, day, source, campaign_id, outbox_id, attempt, message_count)
           VALUES ($1, $2, 'campaign', $3, $4, $5, 1)`,
          [crypto.randomUUID(), day, campaign.id, row.id, row.attempts + 1],
        );
        claimed.push({
          ...row, attempts: row.attempts + 1, campaignId: campaign.id, message,
          campaign: { id: campaign.id, audience: campaign.audience, school_year_id: campaign.school_year_id },
        });
      }
    }
    if (remaining <= 0 && !run.stoppedReason) run.stoppedReason = 'daily_quota_reached';
    return claimed;
  });
}

// Potwierdzenie wysyłki: jedna instrukcja UPDATE … RETURNING sprawdza atomowo
// własność wiersza i wszystkie warunki. Zwraca null (wysyłaj) albo werdykt.
async function confirmSend(db, item, { runToken, config, sendAt }) {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE email_outbox o SET send_started_at = $3, claimed_at = $3, updated_at = $3
        WHERE o.id = $1 AND o.claim_token = $2 AND o.state = 'sending' AND o.send_started_at IS NULL
          AND EXISTS (SELECT 1 FROM email_campaigns c WHERE c.id = o.campaign_id AND c.status = 'sending')
          AND NOT EXISTS (
            SELECT 1 FROM email_campaigns c
              JOIN household_payment_totals p ON p.household_id = o.household_id AND p.school_year_id = c.school_year_id
             WHERE c.id = o.campaign_id AND c.audience = 'no_payment_record' AND p.net_amount_cents > 0)
          AND NOT EXISTS (
            SELECT 1 FROM email_campaign_recipients r JOIN email_suppressions s ON s.email_hash = r.email_hash
             WHERE r.id = o.recipient_id)
          AND EXISTS (
            SELECT 1
              FROM email_campaign_recipients r
              JOIN guardians g ON g.id = r.guardian_id
              JOIN student_guardians sg ON sg.guardian_id = g.id
              JOIN students s ON s.id = sg.student_id
             WHERE r.id = o.recipient_id AND s.household_id = o.household_id
               AND g.contact_allowed AND sg.contact_allowed
               AND lower(btrim(g.email)) = r.email
               AND (sg.starts_on IS NULL OR sg.starts_on <= $4::date)
               AND (sg.ends_on IS NULL OR sg.ends_on >= $4::date))
        RETURNING o.id`,
      [item.id, runToken, sendAt.toISOString(), item.day],
    );
    if (rows[0]) return null;
    const { rows: current } = await tx.query(
      `SELECT o.state, o.claim_token, o.send_started_at, c.status AS campaign_status
         FROM email_outbox o JOIN email_campaigns c ON c.id = o.campaign_id
        WHERE o.id = $1 FOR UPDATE OF o`,
      [item.id],
    );
    const row = current[0];
    if (!row || row.state !== 'sending' || row.claim_token !== runToken || row.send_started_at) {
      // Wiersz przejął inny przebieg albo został już rozstrzygnięty — nie ruszamy go.
      await insertAuditEvent(tx, {
        action: 'email.send_aborted', entityType: 'email_outbox', entityId: item.id,
        metadata: { campaignId: item.campaignId, reason: 'lease_lost', runId: runToken },
      });
      return { state: null, error: 'lease_lost' };
    }
    let verdict;
    if (row.campaign_status !== 'sending') verdict = { state: 'cancelled', error: 'campaign_cancelled' };
    else verdict = await recheckRow(tx, item.campaign, item, config);
    // Warunek zmienił się z powrotem między dwoma odczytami — nie wysyłamy w tym
    // przebiegu, wiersz wraca do kolejki (zachowawczo).
    if (!verdict) verdict = { state: 'queued', error: 'send_recheck_changed' };
    await tx.query(
      `UPDATE email_outbox SET state = $2, last_error = $3, updated_at = $4,
              next_attempt_at = CASE WHEN $2 = 'queued' THEN $4::timestamptz ELSE next_attempt_at END
        WHERE id = $1 AND claim_token = $5 AND state = 'sending' AND send_started_at IS NULL`,
      [item.id, verdict.state, verdict.error, sendAt.toISOString(), runToken],
    );
    await insertAuditEvent(tx, {
      action: verdict.state === 'queued' ? 'email.send_deferred' : `email.${verdict.state}`,
      entityType: 'email_outbox', entityId: item.id,
      metadata: { campaignId: item.campaignId, reason: verdict.error, stage: 'before_send' },
    });
    return verdict;
  });
}

async function deliver(db, item, { transport, config, now, runToken }) {
  try {
    const result = await transport.send({
      to: item.email,
      sender: config.sender,
      subject: item.message.subject,
      text: item.message.text,
      outboxId: item.id,
      idempotencyKey: item.idempotency_key,
    });
    const messageId = result?.messageId ?? null;
    return await db.transaction(async (tx) => {
      const { rows } = await tx.query(
        `UPDATE email_outbox SET state = 'sent', sent_at = $2, provider_message_id = $3, last_error = NULL, updated_at = $2
          WHERE id = $1 AND state = 'sending' AND claim_token = $4
          RETURNING id`,
        [item.id, now.toISOString(), messageId, runToken],
      );
      if (!rows[0]) {
        // Dostawca przyjął wiadomość, ale dzierżawa wygasła i wiersz został już
        // rozstrzygnięty (delivery_unknown). Zapisujemy fakt wysyłki, nie „sent”.
        await insertAuditEvent(tx, {
          action: 'email.sent_after_lease_lost', entityType: 'email_outbox', entityId: item.id,
          metadata: { campaignId: item.campaignId, householdId: item.household_id, providerMessageId: messageId, runId: runToken },
        });
        return 'lease_lost';
      }
      await insertAuditEvent(tx, {
        action: 'email.sent', entityType: 'email_outbox', entityId: item.id,
        metadata: { campaignId: item.campaignId, householdId: item.household_id },
      });
      return 'sent';
    });
  } catch (error) {
    const known = error instanceof EmailTransportError;
    const code = known && /^[a-z0-9_]{1,60}$/.test(error.code) ? error.code : 'transport_error';
    const retry = known && error.retryable && item.attempts < config.maxAttempts;
    return db.transaction(async (tx) => {
      const { rows } = retry
        ? await tx.query(
          `UPDATE email_outbox SET state = 'queued', last_error = $2, updated_at = $3, send_started_at = NULL,
                  next_attempt_at = $3::timestamptz + make_interval(mins => $4)
            WHERE id = $1 AND state = 'sending' AND claim_token = $5 RETURNING id`,
          [item.id, code, now.toISOString(), backoffMinutes(item.attempts), runToken],
        )
        : await tx.query(
          `UPDATE email_outbox SET state = 'failed', last_error = $2, updated_at = $3
            WHERE id = $1 AND state = 'sending' AND claim_token = $4 RETURNING id`,
          [item.id, code, now.toISOString(), runToken],
        );
      if (!rows[0]) {
        await insertAuditEvent(tx, {
          action: 'email.send_aborted', entityType: 'email_outbox', entityId: item.id,
          metadata: { campaignId: item.campaignId, reason: 'lease_lost', transportError: code, runId: runToken },
        });
        return 'lease_lost';
      }
      await insertAuditEvent(tx, {
        action: retry ? 'email.retry_scheduled' : 'email.failed', entityType: 'email_outbox', entityId: item.id,
        metadata: { campaignId: item.campaignId, reason: code },
      });
      return retry ? 'retried' : 'failed';
    });
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
  // Token własności dzierżawy: tylko ten przebieg może wysłać przejęte wiersze.
  const runToken = crypto.randomUUID();
  const claimed = await claim(db, { config, now, day, dryRun, run, runToken });
  // Zegar przebiegu: wstrzyknięte „now” + rzeczywisty upływ czasu, aby dzierżawa
  // liczyła się od chwili wysyłki danej wiadomości, a nie od startu przebiegu.
  const startedMs = Date.now();
  const clock = () => new Date(now.getTime() + (Date.now() - startedMs));
  for (const item of claimed) {
    const verdict = await confirmSend(db, item, { runToken, config, sendAt: clock() });
    if (verdict) {
      if (verdict.state === 'cancelled' || verdict.state === 'skipped') run.skipped += 1;
      else if (verdict.state === 'suppressed') run.suppressed += 1;
      else if (verdict.state === 'failed') run.failed += 1;
      if (verdict.error === 'campaign_cancelled' || verdict.error === 'lease_lost') run.stoppedReason ??= verdict.error;
      continue;
    }
    const outcome = await deliver(db, item, { transport, config, now, runToken });
    if (outcome === 'lease_lost') run.stoppedReason ??= 'lease_lost';
    else run[outcome] += 1;
  }
  if (!dryRun) await completeCampaigns(db, now);
  await recordRun(db, run);
  return run;
}
