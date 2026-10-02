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
//      listę adresów testowych poza produkcją. Limit liczy wpisy dziennika
//      i wiadomości w locie („sending” bez wpisu); wpis w dzienniku powstaje
//      dopiero z wynikiem, po którym wiadomość mogła wyjść (przyjęcie, wynik
//      niepewny) — jawna odmowa dostawcy nie zużywa limitu (#172);
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
//   5. zapis wyniku jest oddzielony od transportu: błąd bazy po przyjęciu
//      wiadomości nie daje failed/transport_error; zapis jest ponawiany, a gdy
//      się nie uda, wiersz zostaje w „sending” (wysłano, wynik niezapisany) do
//      rozstrzygnięcia przez recoverStale (webhook → sent, inaczej
//      delivery_unknown). Odmowa konta (401/402/403), SIGTERM i awaria bazy
//      zatrzymują przebieg; niewysłana reszta partii wraca do „queued” bez
//      zużycia próby (#172, #209). Wyłącznik (#180): 429 i brak połączenia
//      z dostawcą zatrzymują przebieg bez zużycia próby i limitu; seria
//      EMAIL_BREAKER_UNCERTAIN kolejnych wyników niepewnych (5xx, timeout)
//      zatrzymuje partię, reszta zostaje w kolejce.
//   6. odmowa konta zapisuje trwałą pauzę (email_provider_pauses, #209): do jej
//      jawnego zdjęcia przez zarząd (POST /api/email/provider-pause/lift) każdy
//      przebieg kończy się od razu z stopped_reason = 'provider_account_paused',
//      bez przejmowania kolejki i bez połączenia z dostawcą.
// Każda zmiana stanu kolejki lub kampanii i jej zdarzenie audytu powstają w tej
// samej transakcji (#178). Niezgodność treści z zatwierdzonym skrótem daje
// jedno zdarzenie email.campaign.integrity_mismatch na kampanię i stan skrótów.
// Dry-run wykonuje te same sprawdzenia i renderuje treść, ale nie zmienia stanu
// kolejki ani dziennika limitu i nie woła transportu — zapisuje tylko przebieg.
// Ponowne uruchomienie nie dubluje wiadomości: unikalny klucz kampania+rodzina,
// przejścia stanów pilnowane triggerem, a wysyłany jest tylko wiersz przejęty
// z „queued” do „sending” w tej samej transakcji.

import { EmailTransportError, emailConfig, liveRunRefusal, recipientRefusal, withinSendWindow } from './brevo.js';
import {
  contentHash, emailHash, inviteeGrantSql, MEETING_INVITEE_ROLES, normalizeEmail, preferencesToken, renderMessage,
  usesPaymentInstructions,
  usesStructuredReference,
} from './content.js';
import { insertAuditEvent } from '../pg/audit.js';
import { campaignPaymentInstructions } from '../pg/routes/payment-instructions.js';
import { campaignPrivacyNotice, loadNoticeById, noticeReference } from '../pg/routes/privacy-notice.js';
import {
  GUARDIAN_RESTRICTED_SQL, generateVerificationCode, hashVerificationCode, newCodeSalt, renderVerifyMessage,
  VERIFY_CODE_TTL_MS,
} from './guardian-verify.js';
import { meetingNoticeCampaignStale } from '../pg/meetings.js';
import { brusselsDay } from '../pg/today.js';

export const QUOTA_LOCK_ID = 732481707;
export const LEASE_MINUTES = 15;
// Zdarzenia dostawcy oznaczające, że adres nie przyjął wiadomości (#210):
// wiersz kończy jako „bounced”, nie „sent”. Wspólne dla webhooka i odzyskiwania.
export const BOUNCE_EVENTS = Object.freeze(['hard_bounce', 'invalid_email', 'blocked']);

const BACKOFF_BASE_MINUTES = 5;
const BACKOFF_MAX_MINUTES = 6 * 60;

export function utcDay(now) {
  return now.toISOString().slice(0, 10);
}

// Doba limitu w strefie konta Brevo (#84; domyślnie Europe/Brussels — patrz
// emailConfig/quotaTimezone). Osobna od brusselsDay() w pg/today.js, która
// liczy dobę obowiązywania członkostw i jest zawsze w Brukseli, niezależnie
// od tej konfiguracji.
export function accountDay(now, timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
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

// Wiadomości w locie: przejęte („sending”), dla których nie ma jeszcze wpisu
// w dzienniku limitu bieżącej próby. Wpis powstaje dopiero z wynikiem, który
// mógł zużyć limit dostawcy (przyjęcie albo wynik niepewny) — #172, #180.
const IN_FLIGHT = `SELECT COUNT(*)::int FROM email_outbox o
   WHERE o.state = 'sending'
     AND NOT EXISTS (SELECT 1 FROM email_send_ledger l WHERE l.outbox_id = o.id AND l.attempt = o.attempts)`;
// 0184 (#140 pkt 5): kody weryfikacyjne w locie — ta sama reguła dla kolejki
// guardian_update_verifications (wpis dziennika z source = 'verification').
const VERIFY_IN_FLIGHT = `SELECT COUNT(*)::int FROM guardian_update_verifications v
   WHERE v.state = 'sending'
     AND NOT EXISTS (SELECT 1 FROM email_send_ledger l WHERE l.verification_id = v.id AND l.attempt = v.attempts)`;

// Pula pozostała liczona ostrożnie (#84): dziennik `email_send_ledger.day` jest
// zawsze dobą UTC, ale konto Brevo może resetować limit w swojej strefie
// (domyślnie Europe/Brussels — `config.quotaTimezone`). Bierzemy WIĘKSZE
// z dwóch zużyć — dnia UTC (kolumna `day`) i doby konta (`recorded_at`
// przeliczone do jego strefy) — więc żadna z dwóch dób nie zostaje przekroczona.
// Gdy obie doby się pokrywają (quotaTimezone = UTC), wynik jest identyczny jak
// wcześniej.
export async function remainingQuota(executor, now, config) {
  const utc = utcDay(now);
  const account = accountDay(now, config.quotaTimezone);
  const { rows } = await executor.query(
    `SELECT GREATEST(
        (SELECT COALESCE(SUM(message_count), 0)::int FROM email_send_ledger WHERE day = $1),
        (SELECT COALESCE(SUM(message_count), 0)::int FROM email_send_ledger
           WHERE (recorded_at AT TIME ZONE $3) >= $2::date
             AND (recorded_at AT TIME ZONE $3) < $2::date + 1)
     ) + (${IN_FLIGHT}) + (${VERIFY_IN_FLIGHT}) AS used`,
    [utc, account, config.quotaTimezone],
  );
  return Math.max(0, config.dailyLimit - config.dailyReserved - Number(rows[0].used));
}

// 'YYYY-MM-DD' + n dni (arytmetyka na dacie kalendarzowej, nie na godzinach —
// zmiana czasu w strefie konta nie wpływa na wynik; #84).
export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Zużycie jednej doby: 'utc' po kolumnie `day`, 'account' po `recorded_at`
// przeliczonym do strefy konta. Same liczby (kampania / inne / razem).
async function dayUsage(executor, kind, day, timezone) {
  const { rows } = kind === 'utc'
    ? await executor.query(
      'SELECT source, COALESCE(SUM(message_count), 0)::int AS n FROM email_send_ledger WHERE day = $1 GROUP BY source',
      [day])
    : await executor.query(
      `SELECT source, COALESCE(SUM(message_count), 0)::int AS n FROM email_send_ledger
        WHERE (recorded_at AT TIME ZONE $2) >= $1::date AND (recorded_at AT TIME ZONE $2) < $1::date + 1
        GROUP BY source`,
      [day, timezone]);
  const by = Object.fromEntries(rows.map((row) => [row.source, Number(row.n)]));
  const campaign = by.campaign ?? 0;
  // 0184: kody weryfikacyjne (source = 'verification') liczą się jako „inne”.
  const other = (by.other ?? 0) + (by.verification ?? 0);
  return { day, campaign, other, total: campaign + other };
}

// Stan dziennego limitu do podglądu (GET /api/email/quota, #84): dziś i jutro
// w obu dobach (UTC i strefa konta), rezerwa, wiadomości w locie i pula, którą
// zobaczy najbliższy przebieg (remainingQuota). Tylko odczyt, same liczby.
export async function quotaOverview(executor, now, config) {
  const utcToday = utcDay(now);
  const accountToday = accountDay(now, config.quotaTimezone);
  const windows = {
    utc: {
      today: await dayUsage(executor, 'utc', utcToday),
      tomorrow: await dayUsage(executor, 'utc', addDays(utcToday, 1)),
    },
    account: {
      timezone: config.quotaTimezone,
      today: await dayUsage(executor, 'account', accountToday, config.quotaTimezone),
      tomorrow: await dayUsage(executor, 'account', addDays(accountToday, 1), config.quotaTimezone),
    },
  };
  const { rows } = await executor.query(IN_FLIGHT);
  const { rows: verifyRows } = await executor.query(VERIFY_IN_FLIGHT);
  return {
    dailyLimit: config.dailyLimit,
    dailyReserved: config.dailyReserved,
    inFlight: Number(rows[0].count) + Number(verifyRows[0].count),
    remaining: await remainingQuota(executor, now, config),
    windows,
    generatedAt: now.toISOString(),
  };
}

// Wpis w dzienniku limitu dla próby, która mogła wyjść (idempotentnie: jeden
// wpis na wiersz i próbę; wiersze przejęte przed tą zmianą mają go już).
async function recordLedger(tx, { day, campaignId, outboxId, attempt }) {
  await tx.query(
    `INSERT INTO email_send_ledger (id, day, source, campaign_id, outbox_id, attempt, message_count)
     VALUES ($1, $2, 'campaign', $3, $4, $5, 1)
     ON CONFLICT (outbox_id, attempt) DO NOTHING`,
    [crypto.randomUUID(), day, campaignId, outboxId, attempt],
  );
}

// Link wypisania (#110): tylko gdy oba sekrety/adresy są skonfigurowane —
// inaczej wiadomość wychodzi bez stopki (brak nadawcy publicznego URL nie
// blokuje wysyłki, ale wtedy trzeba się rozliczyć z tego w D-06/D-17).
export function unsubscribeUrlFor(config, { campaignId, category, emailHash }) {
  if (!config.unsubscribeSecret || !config.publicBaseUrl) return null;
  const token = preferencesToken(config.unsubscribeSecret, { campaignId, category, emailHash });
  return `${config.publicBaseUrl.replace(/\/+$/, '')}/api/email/preferences?t=${encodeURIComponent(token)}`;
}

// 0183 (#113): wiersz kolejki konta (zawiadomienie o zebraniu zarządu). Tuż przed
// wysyłką: blokada adresu i wypisanie z kategorii (jak dla rodzin), konto nadal
// istnieje i nie jest wyłączone, adres konta się nie zmienił (wiadomość idzie na
// adres z zatwierdzonej migawki, więc zmiana adresu = brak wysyłki do nowej
// migawki) i konto nadal ma aktywny przydział zapraszanej roli w roku kampanii
// (w chwili row.checkAt). Inaczej wiersz jest pomijany (suppressed z powodem),
// a reszta kampanii idzie dalej. Nowy zaproszony nie jest dobierany — to nowa migawka.
async function recheckAccountRow(tx, campaign, row, config) {
  const suppressed = await tx.query('SELECT 1 FROM email_active_suppressions WHERE email_hash = $1', [row.email_hash]);
  if (suppressed.rows[0]) return { state: 'suppressed', error: 'address_suppressed' };
  const preference = await tx.query(
    `SELECT action FROM email_preferences_events
      WHERE email_hash = $1 AND category = $2
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [row.email_hash, campaign.category],
  );
  if (preference.rows[0]?.action === 'opt_out') return { state: 'suppressed', error: 'category_opted_out' };
  const { rows } = await tx.query(
    `SELECT u.disabled_at IS NOT NULL AS disabled, lower(btrim(u.email)) AS email,
            ${inviteeGrantSql({ user: 'u.id', roles: '$2::text[]', at: '$3::timestamptz', year: '$4' })} AS invited
       FROM users u WHERE u.id = $1`,
    [row.user_id, MEETING_INVITEE_ROLES, row.checkAt ?? new Date().toISOString(), campaign.school_year_id],
  );
  const account = rows[0];
  if (!account || account.disabled) return { state: 'suppressed', error: 'account_disabled' };
  if (account.email !== row.email) return { state: 'suppressed', error: 'account_address_changed' };
  if (!account.invited) return { state: 'suppressed', error: 'role_grant_inactive' };
  const refusal = recipientRefusal(config, row.email);
  if (refusal) return { state: 'failed', error: refusal };
  return null;
}

async function recheckRow(tx, campaign, row, config) {
  if (row.user_id) return recheckAccountRow(tx, campaign, row, config);
  // #100 (art. 18 RODO): ograniczenie nałożone po zatwierdzeniu kampanii wstrzymuje wysyłkę
  // do ograniczonego gospodarstwa albo opiekuna; wiersz jest pomijany, nie usuwany.
  const restricted = await tx.query(
    'SELECT 1 FROM processing_restricted_subjects WHERE household_id = $1 OR guardian_id = $2 LIMIT 1',
    [row.household_id, row.guardian_id],
  );
  if (restricted.rows[0]) return { state: 'skipped', error: 'processing_restricted' };
  if (campaign.audience === 'no_payment_record') {
    const paid = await tx.query(
      `SELECT 1 FROM household_payment_totals
        WHERE household_id = $1 AND school_year_id = $2 AND net_amount_cents > 0 LIMIT 1`,
      [row.household_id, campaign.school_year_id],
    );
    if (paid.rows[0]) return { state: 'skipped', error: 'payment_recorded' };
  }
  // Tylko widok „aktywnej blokady” (#94) — po zdjęciu blokady zapis w
  // email_suppressions zostaje w historii, ale nie liczy się już jako blokada.
  const suppressed = await tx.query('SELECT 1 FROM email_active_suppressions WHERE email_hash = $1', [row.email_hash]);
  if (suppressed.rows[0]) return { state: 'suppressed', error: 'address_suppressed' };
  // Wypisanie z tej kategorii między zakolejkowaniem a wysyłką (#110): stan
  // preferencji to ostatnie zdarzenie dla (adres, kategoria).
  const preference = await tx.query(
    `SELECT action FROM email_preferences_events
      WHERE email_hash = $1 AND category = $2
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [row.email_hash, campaign.category],
  );
  if (preference.rows[0]?.action === 'opt_out') return { state: 'suppressed', error: 'category_opted_out' };
  // Gospodarstwo dziecka = główne członkostwo obowiązujące dziś w Brukseli
  // (#194), jak w migawce; nie kolumna students.household_id. Dzień limitu
  // Brevo (row.day) pozostaje w UTC.
  // Uczeń, przez którego opiekun jest adresatem, musi nadal być w szkole w roku
  // kampanii (enrollments_current, #86); zakończona relacja opiekun–dziecko
  // wypada już w student_guardians_current_on.
  const consent = await tx.query(
    `SELECT EXISTS (SELECT 1 FROM enrollments_current en
                     WHERE en.student_id = sg.student_id AND en.school_year_id = $5) AS enrolled,
            -- #113: kampania zebrania klasowego — to samo dziecko, przez które opiekun jest adresatem
            -- (jak w migawce), musi nadal być zapisane do klasy zebrania.
            ($6::text IS NULL OR EXISTS (SELECT 1 FROM enrollments_current en
                     WHERE en.student_id = sg.student_id AND en.school_year_id = $5 AND en.class_id = $6)) AS in_class
       FROM guardians g
       JOIN student_guardians_current_on($4::date) sg ON sg.guardian_id = g.id
       JOIN student_primary_household_on($4::date) p ON p.student_id = sg.student_id
      WHERE g.id = $1 AND p.household_id = $2
        AND g.contact_allowed AND sg.contact_allowed
        AND lower(btrim(g.email)) = $3`,
    [row.guardian_id, row.household_id, row.email, row.memberDay, campaign.school_year_id,
      campaign.audience === 'class_households' ? campaign.class_id : null],
  );
  if (!consent.rows.length) return { state: 'suppressed', error: 'consent_or_address_changed' };
  if (!consent.rows.some((r) => r.enrolled)) return { state: 'suppressed', error: 'student_withdrawn' };
  if (!consent.rows.some((r) => r.enrolled && r.in_class)) return { state: 'suppressed', error: 'student_left_class' };
  const refusal = recipientRefusal(config, row.email);
  if (refusal) return { state: 'failed', error: refusal };
  // #83: treść z {komunikat} — aktywna referencja rodziny w roku kampanii w chwili
  // wysyłki (nowa po unieważnieniu zastępuje starą). Brak = pominięcie, nigdy
  // wiadomość z pustym komunikatem.
  if (usesStructuredReference(campaign)) {
    const reference = await tx.query(
      `SELECT structured_reference FROM payment_references
        WHERE household_id = $1 AND school_year_id = $2 AND revoked_at IS NULL`,
      [row.household_id, campaign.school_year_id],
    );
    if (!reference.rows[0]) return { state: 'skipped', error: 'payment_reference_missing' };
    row.structured_reference = reference.rows[0].structured_reference;
  }
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

// Aktywna pauza po odmowie konta przez dostawcę (#209) albo null. Pauza dotyczy
// całego konta (wszystkich kampanii), nie jednej kampanii.
export async function activeProviderPause(executor) {
  const { rows } = await executor.query(
    `SELECT id, reason, error_code, campaign_id, created_at FROM email_provider_pauses
      WHERE lifted_at IS NULL ORDER BY created_at, id LIMIT 1`,
  );
  return rows[0] ?? null;
}

// Zapis pauzy w transakcji zwrotu wiadomości do kolejki. Równoległy przebieg
// mógł ją już utworzyć (unikalny indeks aktywnej pauzy) — wtedy bez nowego
// wiersza i bez drugiego zdarzenia.
async function recordProviderPause(tx, item, { code, runToken }) {
  const { rows } = await tx.query(
    `INSERT INTO email_provider_pauses (id, reason, error_code, campaign_id, run_id)
     VALUES ($1, 'account_rejected', $2, $3, $4)
     ON CONFLICT (reason) WHERE lifted_at IS NULL DO NOTHING
     RETURNING id`,
    [crypto.randomUUID(), code, item.campaignId, runToken],
  );
  if (!rows[0]) return;
  await insertAuditEvent(tx, {
    action: 'email.provider.paused', entityType: 'email_provider_pause', entityId: rows[0].id,
    metadata: { schoolYearId: item.campaign.school_year_id, campaignId: item.campaignId, reason: 'account_rejected', errorCode: code, runId: runToken },
  });
}

// Jeśli dla wiersza „sent” zapisano wcześniej zdarzenie bounce, ustawia
// „bounced” (idempotentnie: tylko z „sent”). Zwraca nazwę zdarzenia albo null.
async function applyStoredBounce(tx, outboxId) {
  const { rows } = await tx.query(
    `UPDATE email_outbox o SET state = 'bounced', last_error = w.event, updated_at = now()
       FROM (SELECT event FROM email_webhook_events
              WHERE outbox_id = $1 AND event = ANY($2::text[])
              ORDER BY received_at, id LIMIT 1) w
      WHERE o.id = $1 AND o.state = 'sent'
      RETURNING w.event`,
    [outboxId, BOUNCE_EVENTS],
  );
  return rows[0]?.event ?? null;
}

async function recoverStale(db, now) {
  return db.transaction(async (tx) => {
    // Wysyłka rozpoczęta, wynik niezapisany (#172), ale dostawca przysłał już
    // zdarzenie webhooka z X-Mailin-custom = id wiersza: wiadomość została
    // przyjęta → „sent”, nie delivery_unknown.
    const { rows: accepted } = await tx.query(
      `UPDATE email_outbox o
          SET state = 'sent', sent_at = o.send_started_at, last_error = NULL, updated_at = $1,
              provider_message_id = COALESCE(o.provider_message_id, w.provider_message_id)
         FROM (SELECT DISTINCT ON (outbox_id) outbox_id, provider_message_id
                 FROM email_webhook_events WHERE outbox_id IS NOT NULL
                ORDER BY outbox_id, provider_message_id NULLS LAST, received_at) w,
              email_campaigns c
        WHERE w.outbox_id = o.id AND o.state = 'sending' AND o.send_started_at IS NOT NULL
          AND o.claimed_at < $1::timestamptz - make_interval(mins => $2) AND c.id = o.campaign_id
        RETURNING o.id, o.campaign_id, o.attempts, c.school_year_id,
                  to_char(o.send_started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day`,
      [now.toISOString(), LEASE_MINUTES],
    );
    for (const row of accepted) {
      await recordLedger(tx, { day: row.day, campaignId: row.campaign_id, outboxId: row.id, attempt: row.attempts });
      // Zdarzenie zapisane, gdy wiersz był jeszcze w „sending” (#210), musi być
      // zastosowane teraz: bounce → „bounced” (przez „sent”, jedyną dozwoloną
      // ścieżkę), a nie nadpisane przez „sent”.
      const bounce = await applyStoredBounce(tx, row.id);
      await insertAuditEvent(tx, {
        action: 'email.sent_recovered', entityType: 'email_outbox', entityId: row.id,
        metadata: {
          schoolYearId: row.school_year_id, campaignId: row.campaign_id, reason: 'provider_webhook',
          ...(bounce ? { outcome: 'bounced', event: bounce } : {}),
        },
      });
    }
    // Wiersz z tokenem, którego wysyłka się nie rozpoczęła, na pewno nie wyszedł —
    // wraca do kolejki bez zużycia próby. Pozostałe (wysyłka rozpoczęta albo
    // wiersz sprzed migracji 0025 bez tokenu) → delivery_unknown, bez
    // ponawiania, z wpisem w dzienniku limitu (mogła wyjść).
    const { rows } = await tx.query(
      `UPDATE email_outbox eo
          SET state = CASE WHEN claim_token IS NOT NULL AND send_started_at IS NULL THEN 'queued' ELSE 'failed' END,
              attempts = CASE WHEN claim_token IS NOT NULL AND send_started_at IS NULL THEN GREATEST(0, attempts - 1) ELSE attempts END,
              last_error = CASE WHEN claim_token IS NOT NULL AND send_started_at IS NULL THEN 'lease_expired' ELSE 'delivery_unknown' END,
              next_attempt_at = CASE WHEN claim_token IS NOT NULL AND send_started_at IS NULL THEN $1::timestamptz ELSE next_attempt_at END,
              updated_at = $1
         FROM email_campaigns c
        WHERE eo.state = 'sending' AND eo.claimed_at < $1::timestamptz - make_interval(mins => $2) AND c.id = eo.campaign_id
        RETURNING eo.id, eo.campaign_id, eo.state, eo.attempts, c.school_year_id,
                  to_char(COALESCE(eo.send_started_at, eo.claimed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day`,
      [now.toISOString(), LEASE_MINUTES],
    );
    for (const row of rows) {
      if (row.state === 'failed' && row.attempts > 0) {
        await recordLedger(tx, { day: row.day, campaignId: row.campaign_id, outboxId: row.id, attempt: row.attempts });
      }
      await insertAuditEvent(tx, {
        action: row.state === 'queued' ? 'email.lease_expired_requeued' : 'email.delivery_unknown',
        entityType: 'email_outbox', entityId: row.id,
        metadata: { schoolYearId: row.school_year_id, campaignId: row.campaign_id },
      });
    }
    return rows.length + accepted.length;
  });
}

// Przejmuje wiersze do wysyłki. W dry-run tylko liczy i nic nie zapisuje.
async function claim(db, { config, now, day, dryRun, run, runToken }) {
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [QUOTA_LOCK_ID]);
    let remaining = await remainingQuota(tx, now, config);
    run.remainingQuota = remaining;
    let batchLeft = config.batchSize;
    const claimed = [];
    const { rows: campaigns } = await tx.query(
      `SELECT c.id, c.school_year_id, c.audience, c.class_id, c.meeting_notice_id, c.category, c.subject, c.body_text, c.content_hash,
              c.approved_content_hash, c.approved_recipients_hash, c.recipients_hash, c.daily_cap,
              c.status, c.approved_at, c.approved_payment_instructions_id, c.privacy_notice_id,
              y.label AS school_year_label,
              (SELECT COUNT(*)::int FROM email_send_ledger l WHERE l.day = $1 AND l.campaign_id = c.id)
                + (${IN_FLIGHT} AND o.campaign_id = c.id) AS sent_today
         FROM email_campaigns c JOIN school_years y ON y.id = c.school_year_id
        WHERE c.status = 'sending' AND (c.send_not_before IS NULL OR c.send_not_before <= $2::timestamptz)
        ORDER BY c.queued_at, c.id
        FOR UPDATE OF c`,
      [day, now.toISOString()],
    );
    for (const campaign of campaigns) {
      if (remaining <= 0 || batchLeft <= 0) break;
      // Ostatnia kontrola: treść w bazie odpowiada zatwierdzonemu skrótowi.
      const hash = contentHash({ schoolYearId: campaign.school_year_id, audience: campaign.audience, category: campaign.category, subject: campaign.subject, bodyText: campaign.body_text });
      if (hash !== campaign.content_hash || hash !== campaign.approved_content_hash
          || campaign.recipients_hash !== campaign.approved_recipients_hash) {
        run.stoppedReason = 'approval_mismatch';
        await recordIntegrityMismatch(tx, campaign, hash);
        continue;
      }
      // #92: {rachunek}/{odbiorca} — wyłącznie wersja danych do wpłaty zapisana
      // w kampanii przy zatwierdzeniu (approved_payment_instructions_id, 0162),
      // i tylko dopóki jest to nadal bieżąca wersja roku.
      // Korekta rachunku później (albo brak wersji) wstrzymuje kampanię bez zmian
      // w kolejce: wiersze zostają 'queued', nic nie wychodzi ani ze starym, ani
      // z nowym, niezatwierdzonym w kampanii rachunkiem. Zarząd anuluje kampanię
      // i zatwierdza nową.
      let paymentInstructions = null;
      if (usesPaymentInstructions(campaign)) {
        const payment = await campaignPaymentInstructions(tx, campaign);
        if (payment.changed || !payment.instructions) {
          run.stoppedReason = 'payment_instructions_changed';
          continue;
        }
        paymentInstructions = payment.instructions;
      }
      // #145 (D-06): wyłącznie wersja informacji zapamiętana przy zatwierdzeniu
      // (privacy_notice_id, 0179). Kampania zatwierdzona przed 0179 (NULL) jest
      // pomijana jak przy korekcie rachunku — wiersze zostają 'queued'.
      const privacyNotice = await campaignPrivacyNotice(tx, campaign, config.publicBaseUrl);
      if (!privacyNotice) {
        run.stoppedReason = 'privacy_notice_missing';
        continue;
      }
      // #113: kampania z zawiadomienia o zebraniu, które zmieniło się po utworzeniu
      // szkicu (porządek obrad, termin, miejsce, tytuł, nowsza wersja zawiadomienia),
      // nie wychodzi — wiersze zostają 'queued', jak przy korekcie rachunku. Zarząd
      // anuluje kampanię i przygotowuje nową z aktualnego zawiadomienia.
      if (campaign.meeting_notice_id && await meetingNoticeCampaignStale(tx, campaign)) {
        run.stoppedReason = 'meeting_notice_outdated';
        continue;
      }
      let capLeft = campaign.daily_cap - campaign.sent_today;
      if (capLeft <= 0) continue;
      const { rows } = await tx.query(
        `SELECT o.id, o.household_id, o.user_id, o.idempotency_key, o.attempts,
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
        row.memberDay = brusselsDay(now);
        row.checkAt = now.toISOString();
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
              metadata: { schoolYearId: campaign.school_year_id, campaignId: campaign.id, reason: verdict.error },
            });
          }
          continue;
        }
        const unsubscribeUrl = unsubscribeUrlFor(config, { campaignId: campaign.id, category: campaign.category, emailHash: row.email_hash });
        const message = {
          ...renderMessage(campaign, {
            schoolYearLabel: campaign.school_year_label, householdId: row.household_id,
            structuredReference: row.structured_reference ?? null, paymentInstructions, unsubscribeUrl, privacyNotice,
          }),
          unsubscribeUrl,
        };
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
        claimed.push({
          ...row, attempts: row.attempts + 1, campaignId: campaign.id, message,
          campaign: {
            id: campaign.id, audience: campaign.audience, school_year_id: campaign.school_year_id,
            class_id: campaign.class_id, category: campaign.category,
          },
        });
      }
    }
    if (remaining <= 0 && !run.stoppedReason) run.stoppedReason = 'daily_quota_reached';
    return claimed;
  });
}

// Potwierdzenie wysyłki: jedna instrukcja UPDATE … RETURNING sprawdza atomowo
// własność wiersza i wszystkie warunki. Gospodarstwo dziecka i relacje z opiekunem
// dotyczą dnia item.memberDay (Bruksela, jak w recheckRow i migawce), a nie
// kolumny students.household_id (#194) ani dnia UTC limitu Brevo. Zwraca null (wysyłaj) albo werdykt.
// #208/#210: odczyt kampanii jest blokujący (FOR SHARE), więc potwierdzenie i anulowanie
// (FOR UPDATE na kampanii) szeregują się: albo potwierdzenie zatwierdziło się przed
// liczeniem inFlight w anulowaniu (wiadomość jest wtedy policzona), albo czeka i widzi
// „cancelled”. Bez blokady wiadomość mogła wyjść po odpowiedzi „anulowano” z inFlight = 0.
async function confirmSend(db, item, { runToken, config, sendAt }) {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE email_outbox o SET send_started_at = $3, claimed_at = $3, updated_at = $3
        WHERE o.id = $1 AND o.claim_token = $2 AND o.state = 'sending' AND o.send_started_at IS NULL
          AND EXISTS (SELECT 1 FROM email_campaigns c WHERE c.id = o.campaign_id AND c.status = 'sending' FOR SHARE OF c)
          AND NOT EXISTS (
            SELECT 1 FROM email_campaigns c
              JOIN household_payment_totals p ON p.household_id = o.household_id AND p.school_year_id = c.school_year_id
             WHERE c.id = o.campaign_id AND c.audience = 'no_payment_record' AND p.net_amount_cents > 0)
          AND NOT EXISTS (
            SELECT 1 FROM email_campaign_recipients r JOIN email_active_suppressions s ON s.email_hash = r.email_hash
             WHERE r.id = o.recipient_id)
          AND NOT EXISTS (
            SELECT 1 FROM email_campaign_recipients r
              JOIN processing_restricted_subjects x ON x.household_id = o.household_id OR x.guardian_id = r.guardian_id
             WHERE r.id = o.recipient_id)
          AND ((o.user_id IS NULL AND EXISTS (
            SELECT 1
              FROM email_campaign_recipients r
              JOIN guardians g ON g.id = r.guardian_id
              JOIN student_guardians_current_on($4::date) sg ON sg.guardian_id = g.id
              JOIN student_primary_household_on($4::date) ph ON ph.student_id = sg.student_id
             WHERE r.id = o.recipient_id AND ph.household_id = o.household_id
               AND g.contact_allowed AND sg.contact_allowed
               AND lower(btrim(g.email)) = r.email
               AND EXISTS (SELECT 1 FROM enrollments_current en
                            WHERE en.student_id = sg.student_id
                              AND en.school_year_id = (SELECT c.school_year_id FROM email_campaigns c WHERE c.id = o.campaign_id)
                              AND (SELECT c.class_id IS NULL OR en.class_id = c.class_id FROM email_campaigns c WHERE c.id = o.campaign_id))))
            -- 0183: konto zaproszone na zebranie zarządu — nadal aktywne, z tym samym
            -- adresem i aktywnym przydziałem zapraszanej roli w roku kampanii w chwili wysyłki.
            OR (o.user_id IS NOT NULL AND EXISTS (
              SELECT 1
                FROM email_campaign_recipients r
                JOIN users u ON u.id = r.user_id
                JOIN email_campaigns c ON c.id = o.campaign_id
               WHERE r.id = o.recipient_id AND r.user_id = o.user_id
                 AND u.disabled_at IS NULL AND lower(btrim(u.email)) = r.email
                 AND ${inviteeGrantSql({ user: 'u.id', roles: '$5::text[]', at: '$3::timestamptz', year: 'c.school_year_id' })}
                 AND COALESCE((SELECT p.action FROM email_preferences_events p
                                 WHERE p.email_hash = r.email_hash AND p.category = c.category
                                 ORDER BY p.created_at DESC, p.id DESC LIMIT 1), '') <> 'opt_out')))
        RETURNING o.id`,
      [item.id, runToken, sendAt.toISOString(), item.memberDay, MEETING_INVITEE_ROLES],
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
        metadata: { schoolYearId: item.campaign.school_year_id, campaignId: item.campaignId, reason: 'lease_lost', runId: runToken },
      });
      return { state: null, error: 'lease_lost' };
    }
    let verdict;
    if (row.campaign_status !== 'sending') verdict = { state: 'cancelled', error: 'campaign_cancelled' };
    else verdict = await recheckRow(tx, item.campaign, { ...item, checkAt: sendAt.toISOString() }, config);
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
      metadata: { schoolYearId: item.campaign.school_year_id, campaignId: item.campaignId, reason: verdict.error, stage: 'before_send' },
    });
    return verdict;
  });
}

// Dostawca przyjął wiadomość, ale zapisu wyniku nie udało się utrwalić mimo
// ponowień (awaria bazy). Wiersz zostaje w „sending” z send_started_at —
// stan „wysłano, wynik niezapisany” do rozstrzygnięcia (webhook albo
// delivery_unknown), NIGDY failed/transport_error (#172).
export class ResultNotRecordedError extends Error {
  constructor(item, providerMessageId, cause) {
    super('result_not_recorded');
    this.code = 'result_not_recorded';
    this.outboxId = item.id;
    this.providerMessageId = providerMessageId;
    this.cause = cause;
  }
}

const RESULT_RETRY_DELAYS_MS = [250, 1000, 3000];
const sleep = (ms) => (ms > 0 ? new Promise((resolve) => { setTimeout(resolve, ms); }) : Promise.resolve());

// Zapis „sent” — idempotentny, bo poprzednia próba mogła zostać zatwierdzona
// mimo utraconego potwierdzenia COMMIT.
async function recordSent(db, item, { messageId, now, runToken }) {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE email_outbox SET state = 'sent', sent_at = $2, provider_message_id = $3, last_error = NULL, updated_at = $2
        WHERE id = $1 AND state = 'sending' AND claim_token = $4
        RETURNING id`,
      [item.id, now.toISOString(), messageId, runToken],
    );
    await recordLedger(tx, { day: item.day, campaignId: item.campaignId, outboxId: item.id, attempt: item.attempts });
    if (!rows[0]) {
      const { rows: current } = await tx.query('SELECT state, claim_token FROM email_outbox WHERE id = $1', [item.id]);
      if (current[0]?.state === 'sent' && current[0].claim_token === runToken) return 'sent';
      // Dostawca przyjął wiadomość, ale dzierżawa wygasła i wiersz został już
      // rozstrzygnięty (delivery_unknown). Zapisujemy fakt wysyłki, nie „sent”.
      await insertAuditEvent(tx, {
        action: 'email.sent_after_lease_lost', entityType: 'email_outbox', entityId: item.id,
        metadata: {
          schoolYearId: item.campaign.school_year_id, campaignId: item.campaignId,
          householdId: item.household_id, providerMessageId: messageId, runId: runToken,
        },
      });
      return 'lease_lost';
    }
    await insertAuditEvent(tx, {
      action: 'email.sent', entityType: 'email_outbox', entityId: item.id,
      metadata: {
        schoolYearId: item.campaign.school_year_id, campaignId: item.campaignId, householdId: item.household_id,
        // 0183: wiadomość do konta (zawiadomienie o zebraniu zarządu) — identyfikator, bez adresu.
        ...(item.user_id ? { userId: item.user_id } : {}),
      },
    });
    // Webhook bounce mógł dotrzeć między przyjęciem wiadomości a tym zapisem
    // (wiersz był w „sending”, więc tylko zapisał zdarzenie) — stosujemy go teraz.
    await applyStoredBounce(tx, item.id);
    return 'sent';
  });
}

async function recordSentWithRetries(db, item, options) {
  const delays = options.resultRetryDelaysMs ?? RESULT_RETRY_DELAYS_MS;
  let lastError;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await recordSent(db, item, options);
    } catch (error) {
      lastError = error;
      if (attempt < delays.length) await sleep(delays[attempt]);
    }
  }
  throw new ResultNotRecordedError(item, options.messageId, lastError);
}

// Wiadomość na pewno nie wyszła (odmowa konta, 429, brak połączenia): wiersz
// wraca do kolejki bez zużycia próby i bez wpisu w dzienniku limitu;
// delaySeconds odsuwa kolejną próbę (np. Retry-After).
async function requeueNotSent(db, item, { code, now, runToken, stage, delaySeconds = 0 }) {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE email_outbox SET state = 'queued', last_error = $2, updated_at = $3, send_started_at = NULL,
              attempts = GREATEST(0, attempts - 1), next_attempt_at = $3::timestamptz + make_interval(secs => $5)
        WHERE id = $1 AND state = 'sending' AND claim_token = $4 RETURNING id`,
      [item.id, code, now.toISOString(), runToken, delaySeconds],
    );
    if (!rows[0]) return 'lease_lost';
    await insertAuditEvent(tx, {
      action: 'email.requeued', entityType: 'email_outbox', entityId: item.id,
      metadata: { schoolYearId: item.campaign.school_year_id, campaignId: item.campaignId, reason: code, stage },
    });
    if (stage === 'provider_account_rejected') {
      await insertAuditEvent(tx, {
        action: 'email.campaign.provider_rejected', entityType: 'email_campaign', entityId: item.campaignId,
        metadata: { schoolYearId: item.campaign.school_year_id, reason: code, runId: runToken },
      });
      await recordProviderPause(tx, item, { code, runToken });
    }
    return 'requeued';
  });
}

// Zwraca wiersze przejęte przez ten przebieg, których wysyłka się nie
// rozpoczęła, z powrotem do kolejki (bez zużycia próby) — po zatrzymaniu
// przebiegu (SIGTERM, odmowa konta, awaria bazy), zamiast czekać na wygaśnięcie
// dzierżawy (#172).
async function releaseClaims(db, { runToken, now, reason }) {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE email_outbox eo SET state = 'queued', last_error = $3, updated_at = $2, next_attempt_at = $2::timestamptz,
              attempts = GREATEST(0, attempts - 1)
         FROM email_campaigns c
        WHERE eo.claim_token = $1 AND eo.state = 'sending' AND eo.send_started_at IS NULL AND c.id = eo.campaign_id
        RETURNING eo.id, eo.campaign_id, c.school_year_id`,
      [runToken, now.toISOString(), reason],
    );
    for (const row of rows) {
      await insertAuditEvent(tx, {
        action: 'email.requeued', entityType: 'email_outbox', entityId: row.id,
        metadata: { schoolYearId: row.school_year_id, campaignId: row.campaign_id, reason, stage: 'run_stopped' },
      });
    }
    return rows.length;
  });
}

async function deliver(db, item, { transport, config, now, runToken, resultRetryDelaysMs }) {
  let result;
  try {
    result = await transport.send({
      to: item.email,
      sender: config.sender,
      replyTo: config.replyTo,
      subject: item.message.subject,
      text: item.message.text,
      unsubscribeUrl: item.message.unsubscribeUrl,
      outboxId: item.id,
      idempotencyKey: item.idempotency_key,
    });
  } catch (error) {
    return recordTransportError(db, item, error, { config, now, runToken });
  }
  // Zapis wyniku osobno od transportu: błąd bazy po przyjęciu wiadomości nie
  // jest błędem transportu (#172).
  const messageId = result?.messageId ?? null;
  return { outcome: await recordSentWithRetries(db, item, { messageId, now, runToken, resultRetryDelaysMs }) };
}

async function recordTransportError(db, item, error, { config, now, runToken }) {
  const known = error instanceof EmailTransportError;
  const code = known && /^[a-z0-9_]{1,60}$/.test(error.code) ? error.code : 'transport_error';
  if (known && error.accountLevel) {
    const outcome = await requeueNotSent(db, item, { code, now, runToken, stage: 'provider_account_rejected' });
    return { outcome: outcome === 'lease_lost' ? 'lease_lost' : null, stop: 'provider_account_rejected' };
  }
  // Wyłącznik (#180): 429 i brak połączenia dotyczą dostawcy, nie odbiorcy.
  // Przebieg się zatrzymuje (kolejne wiadomości dostałyby to samo), wiersz
  // wraca do kolejki bez zużycia próby i limitu — więc nie staje się „failed”
  // po EMAIL_MAX_ATTEMPTS przy dłuższej przerwie.
  if (known && (error.code === 'provider_rate_limited' || error.notSent)) {
    const stage = error.notSent ? 'provider_unreachable' : 'provider_rate_limited';
    const delaySeconds = error.retryAfterSeconds ?? BACKOFF_BASE_MINUTES * 60;
    const outcome = await requeueNotSent(db, item, { code, now, runToken, stage, delaySeconds });
    return { outcome: outcome === 'lease_lost' ? 'lease_lost' : 'retried', stop: stage };
  }
  const retry = known && error.retryable && item.attempts < config.maxAttempts;
  // Wynik, po którym wiadomość mogła wyjść (niepewny albo wyjątek spoza
  // EmailTransportError), zużywa limit dnia; jawna odmowa dostawcy — nie.
  const mayHaveLeft = !known || error.uncertain;
  return { outcome: await db.transaction(async (tx) => {
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
    if (mayHaveLeft) await recordLedger(tx, { day: item.day, campaignId: item.campaignId, outboxId: item.id, attempt: item.attempts });
    if (!rows[0]) {
      await insertAuditEvent(tx, {
        action: 'email.send_aborted', entityType: 'email_outbox', entityId: item.id,
        metadata: {
          schoolYearId: item.campaign.school_year_id, campaignId: item.campaignId,
          reason: 'lease_lost', transportError: code, runId: runToken,
        },
      });
      return 'lease_lost';
    }
    await insertAuditEvent(tx, {
      action: retry ? 'email.retry_scheduled' : 'email.failed', entityType: 'email_outbox', entityId: item.id,
      metadata: { schoolYearId: item.campaign.school_year_id, campaignId: item.campaignId, reason: code },
    });
    return retry ? 'retried' : 'failed';
  }), uncertain: !retry && mayHaveLeft };
}

// Zmiana stanu i zdarzenie w jednej transakcji (#178): przerwanie po UPDATE nie
// może zostawić kampanii „done” bez śladu w dzienniku.
async function completeCampaigns(db, now) {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE email_campaigns c SET status = 'done', completed_at = $1
        WHERE c.status = 'sending'
          AND NOT EXISTS (SELECT 1 FROM email_outbox o WHERE o.campaign_id = c.id AND o.state IN ('queued', 'sending'))
        RETURNING id, school_year_id`,
      [now.toISOString()],
    );
    for (const row of rows) {
      await insertAuditEvent(tx, {
        action: 'email.campaign.done', entityType: 'email_campaign', entityId: row.id,
        metadata: { schoolYearId: row.school_year_id },
      });
    }
    return rows.length;
  });
}

// Niezgodność treści/listy z zatwierdzonym skrótem (#178): zdarzenie na
// kampanii raz dla danego stanu skrótów, nie przy każdym przebiegu. Kampania
// pozostaje w „sending” i nie jest wysyłana (stan docelowy — wstrzymana czy
// anulowana — do decyzji zarządu przy #130). Metadane: wyłącznie skróty.
async function recordIntegrityMismatch(tx, campaign, observedContentHash) {
  const metadata = {
    schoolYearId: campaign.school_year_id,
    observedContentHash,
    contentHash: campaign.content_hash,
    approvedContentHash: campaign.approved_content_hash,
    recipientsHash: campaign.recipients_hash,
    approvedRecipientsHash: campaign.approved_recipients_hash,
  };
  const { rows } = await tx.query(
    `SELECT 1 FROM audit_events
      WHERE entity_type = 'email_campaign' AND entity_id = $1 AND action = 'email.campaign.integrity_mismatch'
        AND metadata_json @> $2::jsonb
      LIMIT 1`,
    [campaign.id, JSON.stringify(metadata)],
  );
  if (rows[0]) return;
  await insertAuditEvent(tx, {
    action: 'email.campaign.integrity_mismatch', entityType: 'email_campaign', entityId: campaign.id,
    metadata: { ...metadata, reason: 'approval_mismatch' },
  });
}

// ---------------------------------------------------------------------------
// Kody weryfikacyjne nowego adresu z wniosku rodzica (#140 pkt 5, migracja 0184)
//
// Kolejka guardian_update_verifications (jeden wiersz na wniosek, klucz
// verify:{requestId}). Ten sam przebieg, limit dnia (remainingQuota, blokada
// QUOTA_LOCK_ID), okno wysyłki, pauza konta, lista adresów testowych
// (recipientRefusal) i transport co kampanie. Różnice:
//   * odbiorca = guardian_update_requests.proposed_email TEGO wniosku (kolumna
//     niezmienna — trigger 0087); innego adresu nie da się podstawić;
//   * kod (8 cyfr) powstaje dopiero przy przejęciu do wysyłki; w bazie zostaje
//     wyłącznie skrót z solą i termin ważności (VERIFY_CODE_TTL_MS od przejęcia);
//     kod jawny istnieje tylko w pamięci przebiegu i w wiadomości;
//   * przed wysyłką: flaga GUARDIAN_VERIFY_EMAIL_ENABLED, wniosek nadal
//     „pending”, adres nie na liście wyłączeń, brak ograniczenia przetwarzania;
//   * wynik niepewny (5xx, timeout) = failed/delivery_unknown bez ponawiania —
//     najwyżej jedna wiadomość, która mogła wyjść, na wniosek.
// Zdarzenia audytu: entity guardian_update_request (identyfikator wniosku),
// metadane bez adresu i bez kodu (pomocnik `audit` — skan słownika zdarzeń,
// tests/audit-actions-catalog.test.js).

async function audit(tx, action, row, metadata = {}) {
  await insertAuditEvent(tx, {
    action, entityType: 'guardian_update_request', entityId: row.request_id,
    metadata: { verificationId: row.id, ...metadata },
  });
}

async function recordVerificationLedger(tx, { day, verificationId, attempt }) {
  await tx.query(
    `INSERT INTO email_send_ledger (id, day, source, verification_id, attempt, message_count)
     VALUES ($1, $2, 'verification', $3, $4, 1)
     ON CONFLICT (verification_id, attempt) DO NOTHING`,
    [crypto.randomUUID(), day, verificationId, attempt],
  );
}

// Werdykt „nie wysyłać” albo null. Wspólny dla przejęcia i potwierdzenia przed wysyłką.
async function verificationRefusal(tx, row, config) {
  if (row.request_status !== 'pending') return { state: 'cancelled', error: 'request_decided' };
  const email = normalizeEmail(row.email);
  if (!email || email !== row.email) return { state: 'failed', error: 'no_valid_email' };
  const suppressed = await tx.query('SELECT 1 FROM email_active_suppressions WHERE email_hash = $1', [emailHash(email)]);
  if (suppressed.rows[0]) return { state: 'failed', error: 'address_suppressed' };
  if ((await tx.query(GUARDIAN_RESTRICTED_SQL, [row.guardian_id])).rows[0]) return { state: 'cancelled', error: 'processing_restricted' };
  const refusal = recipientRefusal(config, email);
  if (refusal) return { state: 'failed', error: refusal };
  return null;
}

const VERIFY_ROW_SQL = `SELECT v.id, v.request_id, v.state, v.attempts, v.idempotency_key, v.template_id, v.privacy_notice_id,
            r.status AS request_status, r.guardian_id, r.proposed_email AS email,
            t.subject, t.body_text, t.status AS template_status
       FROM guardian_update_verifications v
       JOIN guardian_update_requests r ON r.id = v.request_id
       JOIN guardian_verify_templates t ON t.id = v.template_id`;

async function closeVerification(tx, row, verdict, now) {
  await tx.query(
    `UPDATE guardian_update_verifications SET state = $2, last_error = $3, updated_at = $4 WHERE id = $1`,
    [row.id, verdict.state, verdict.error, now.toISOString()],
  );
  if (verdict.state === 'cancelled') await audit(tx, 'guardian_update_request.verification_cancelled', row, { reason: verdict.error });
  else await audit(tx, 'guardian_update_request.verification_failed', row, { reason: verdict.error });
}

// Dzierżawa wygasła (przebieg przerwany): wysyłka nierozpoczęta → z powrotem do
// kolejki; rozpoczęta → failed/delivery_unknown (mogła wyjść — bez ponawiania).
async function recoverStaleVerifications(db, now) {
  return db.transaction(async (tx) => {
    // Rodzic wpisał już kod z tej wiadomości (wynik wysyłki nie został
    // utrwalony, np. awaria bazy po przyjęciu przez dostawcę) — wiadomość
    // dotarła, więc „sent”, nie delivery_unknown.
    const { rows: delivered } = await tx.query(
      `UPDATE guardian_update_verifications
          SET state = 'sent', sent_at = send_started_at, last_error = NULL, updated_at = $1
        WHERE state = 'sending' AND confirmed_at IS NOT NULL AND send_started_at IS NOT NULL
          AND claimed_at < $1::timestamptz - make_interval(mins => $2)
        RETURNING id, request_id, attempts, to_char(send_started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day`,
      [now.toISOString(), LEASE_MINUTES],
    );
    for (const row of delivered) {
      await recordVerificationLedger(tx, { day: row.day, verificationId: row.id, attempt: row.attempts });
      await audit(tx, 'guardian_update_request.verification_sent', row, { attempt: row.attempts, reason: 'confirmed_by_recipient' });
    }
    const { rows } = await tx.query(
      `UPDATE guardian_update_verifications
          SET state = CASE WHEN send_started_at IS NULL THEN 'queued' ELSE 'failed' END,
              attempts = CASE WHEN send_started_at IS NULL THEN GREATEST(0, attempts - 1) ELSE attempts END,
              last_error = CASE WHEN send_started_at IS NULL THEN 'lease_expired' ELSE 'delivery_unknown' END,
              next_attempt_at = CASE WHEN send_started_at IS NULL THEN $1::timestamptz ELSE next_attempt_at END,
              claim_token = CASE WHEN send_started_at IS NULL THEN NULL ELSE claim_token END,
              updated_at = $1
        WHERE state = 'sending' AND confirmed_at IS NULL AND claimed_at < $1::timestamptz - make_interval(mins => $2)
        RETURNING id, request_id, state, attempts,
                  to_char(COALESCE(send_started_at, claimed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day`,
      [now.toISOString(), LEASE_MINUTES],
    );
    for (const row of rows) {
      if (row.state === 'failed') await recordVerificationLedger(tx, { day: row.day, verificationId: row.id, attempt: row.attempts });
      if (row.state === 'queued') await audit(tx, 'guardian_update_request.verification_requeued', row, { reason: 'lease_expired' });
      else await audit(tx, 'guardian_update_request.verification_failed', row, { reason: 'delivery_unknown' });
    }
  });
}

async function claimVerifications(db, { config, now, day, dryRun, run, runToken }) {
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [QUOTA_LOCK_ID]);
    let remaining = await remainingQuota(tx, now, config);
    run.remainingQuota = remaining;
    const { rows } = await tx.query(
      `${VERIFY_ROW_SQL}
        WHERE v.state = 'queued' AND v.next_attempt_at <= $1::timestamptz
        ORDER BY v.created_at, v.id
        LIMIT $2
        FOR UPDATE OF v SKIP LOCKED`,
      [now.toISOString(), config.batchSize],
    );
    const claimed = [];
    for (const row of rows) {
      if (remaining <= 0) { run.stoppedReason ??= 'daily_quota_reached'; break; }
      const verdict = row.template_status !== 'approved'
        ? { state: 'failed', error: 'template_not_approved' }
        : await verificationRefusal(tx, row, config);
      if (verdict) {
        run[verdict.state === 'cancelled' ? 'skipped' : 'failed'] += 1;
        if (!dryRun) await closeVerification(tx, row, verdict, now);
        continue;
      }
      const notice = noticeReference(await loadNoticeById(tx, row.privacy_notice_id), config.publicBaseUrl);
      run.planned += 1;
      remaining -= 1;
      if (dryRun) {
        if (!run.sample) run.sample = { verificationId: row.id, subject: row.subject };
        continue;
      }
      const code = generateVerificationCode();
      const salt = newCodeSalt();
      const expiresAt = new Date(now.getTime() + VERIFY_CODE_TTL_MS).toISOString();
      await tx.query(
        `UPDATE guardian_update_verifications
            SET state = 'sending', attempts = attempts + 1, claim_token = $2, claimed_at = $3, updated_at = $3,
                send_started_at = NULL, code_salt = $4, code_hash = $5, code_expires_at = $6
          WHERE id = $1 AND state = 'queued'`,
        [row.id, runToken, now.toISOString(), salt, hashVerificationCode(salt, code), expiresAt],
      );
      claimed.push({
        id: row.id, request_id: row.request_id, guardian_id: row.guardian_id, email: row.email, day,
        attempts: row.attempts + 1, idempotency_key: row.idempotency_key,
        message: renderVerifyMessage(row, { code, privacyNotice: notice }),
      });
    }
    return claimed;
  });
}

// Atomowe potwierdzenie tuż przed wysyłką: nadal „sending” z tokenem przebiegu,
// wniosek nadal oczekuje, adres nie zablokowany, brak ograniczenia. Zwraca null
// (wysyłaj) albo werdykt.
async function confirmVerificationSend(db, item, { runToken, config, sendAt }) {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `${VERIFY_ROW_SQL} WHERE v.id = $1 FOR UPDATE OF v`,
      [item.id],
    );
    const row = rows[0];
    const { rows: own } = await tx.query(
      `SELECT 1 FROM guardian_update_verifications WHERE id = $1 AND claim_token = $2 AND state = 'sending' AND send_started_at IS NULL`,
      [item.id, runToken],
    );
    if (!row || !own[0]) return { state: null, error: 'lease_lost' };
    const verdict = await verificationRefusal(tx, row, config);
    if (verdict) {
      await closeVerification(tx, row, verdict, sendAt);
      return verdict;
    }
    await tx.query(
      `UPDATE guardian_update_verifications SET send_started_at = $2, claimed_at = $2, updated_at = $2 WHERE id = $1`,
      [item.id, sendAt.toISOString()],
    );
    return null;
  });
}

async function releaseVerificationClaims(db, { runToken, now, reason }) {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE guardian_update_verifications
          SET state = 'queued', last_error = $3, updated_at = $2, next_attempt_at = $2::timestamptz,
              attempts = GREATEST(0, attempts - 1), claim_token = NULL
        WHERE claim_token = $1 AND state = 'sending' AND send_started_at IS NULL
        RETURNING id, request_id`,
      [runToken, now.toISOString(), reason],
    );
    for (const row of rows) await audit(tx, 'guardian_update_request.verification_requeued', row, { reason, stage: 'run_stopped' });
    return rows.length;
  });
}

async function recordVerificationPause(tx, { code, runToken }) {
  const { rows } = await tx.query(
    `INSERT INTO email_provider_pauses (id, reason, error_code, campaign_id, run_id)
     VALUES ($1, 'account_rejected', $2, NULL, $3)
     ON CONFLICT (reason) WHERE lifted_at IS NULL DO NOTHING
     RETURNING id`,
    [crypto.randomUUID(), code, runToken],
  );
  if (!rows[0]) return;
  await insertAuditEvent(tx, {
    action: 'guardian_verify.provider_paused', entityType: 'email_provider_pause', entityId: rows[0].id,
    metadata: { reason: 'account_rejected', errorCode: code, runId: runToken },
  });
}

// Wynik transportu dla kodu. Zwraca { outcome, stop }.
async function recordVerificationResult(db, item, { error = null, messageId = null, config, now, runToken }) {
  return db.transaction(async (tx) => {
    const owned = 'WHERE id = $1 AND state = \'sending\' AND claim_token = $2';
    // Niepowodzenie nie nadpisuje kodu, który rodzic już potwierdził (strażnik 0184).
    const ownedOpen = `${owned} AND confirmed_at IS NULL`;
    if (!error) {
      const { rows } = await tx.query(
        `UPDATE guardian_update_verifications SET state = 'sent', sent_at = $3, provider_message_id = $4, last_error = NULL, updated_at = $3
          ${owned} RETURNING id`,
        [item.id, runToken, now.toISOString(), messageId],
      );
      await recordVerificationLedger(tx, { day: item.day, verificationId: item.id, attempt: item.attempts });
      if (!rows[0]) {
        await audit(tx, 'guardian_update_request.verification_sent_after_lease_lost', item, { runId: runToken });
        return { outcome: null };
      }
      await audit(tx, 'guardian_update_request.verification_sent', item, { attempt: item.attempts });
      return { outcome: 'sent' };
    }
    const known = error instanceof EmailTransportError;
    const code = known && /^[a-z0-9_]{1,60}$/.test(error.code) ? error.code : 'transport_error';
    // Wiadomość na pewno nie wyszła: z powrotem do kolejki bez zużycia próby i limitu.
    const notSent = known && (error.accountLevel || error.notSent || error.code === 'provider_rate_limited');
    if (notSent) {
      const delaySeconds = error.accountLevel ? 0 : (error.retryAfterSeconds ?? BACKOFF_BASE_MINUTES * 60);
      const requeued = await tx.query(
        `UPDATE guardian_update_verifications SET state = 'queued', last_error = $3, updated_at = $4, send_started_at = NULL,
                claim_token = NULL, attempts = GREATEST(0, attempts - 1), next_attempt_at = $4::timestamptz + make_interval(secs => $5)
          ${ownedOpen} RETURNING id`,
        [item.id, runToken, code, now.toISOString(), delaySeconds],
      );
      if (requeued.rows[0]) await audit(tx, 'guardian_update_request.verification_requeued', item, { reason: code });
      if (error.accountLevel) await recordVerificationPause(tx, { code, runToken });
      const stop = error.accountLevel ? 'provider_account_rejected' : error.notSent ? 'provider_unreachable' : 'provider_rate_limited';
      return { outcome: error.accountLevel ? null : 'retried', stop };
    }
    const retry = known && error.retryable && item.attempts < config.maxAttempts;
    const mayHaveLeft = !known || error.uncertain;
    if (mayHaveLeft) await recordVerificationLedger(tx, { day: item.day, verificationId: item.id, attempt: item.attempts });
    if (retry) {
      const requeued = await tx.query(
        `UPDATE guardian_update_verifications SET state = 'queued', last_error = $3, updated_at = $4, send_started_at = NULL,
                claim_token = NULL, next_attempt_at = $4::timestamptz + make_interval(mins => $5)
          ${ownedOpen} RETURNING id`,
        [item.id, runToken, code, now.toISOString(), backoffMinutes(item.attempts)],
      );
      if (!requeued.rows[0]) return { outcome: null };
      await audit(tx, 'guardian_update_request.verification_requeued', item, { reason: code });
      return { outcome: 'retried' };
    }
    const failed = await tx.query(
      `UPDATE guardian_update_verifications SET state = 'failed', last_error = $3, updated_at = $4 ${ownedOpen} RETURNING id`,
      [item.id, runToken, code, now.toISOString()],
    );
    if (!failed.rows[0]) return { outcome: null };
    await audit(tx, 'guardian_update_request.verification_failed', item, { reason: code });
    return { outcome: 'failed' };
  });
}

// Faza kodów weryfikacyjnych w przebiegu workera. Zwraca kod zatrzymania
// przebiegu (dostawca/SIGTERM) albo null. Wyłączona flaga = brak przejęć
// (wiersze zostają „queued” do włączenia flagi albo rozstrzygnięcia wniosku).
export async function processGuardianVerifications(db, { config, now, day, dryRun, run, runToken, transport, signal }) {
  if (!config.guardianVerifyEnabled) return null;
  if (!dryRun) await recoverStaleVerifications(db, now);
  const claimed = await claimVerifications(db, { config, now, day, dryRun, run, runToken });
  if (dryRun || !claimed.length) return null;
  const startedMs = Date.now();
  const clock = () => new Date(now.getTime() + (Date.now() - startedMs));
  let stop = null;
  try {
    for (const item of claimed) {
      if (signal?.aborted) { stop = 'shutdown'; break; }
      const verdict = await confirmVerificationSend(db, item, { runToken, config, sendAt: clock() });
      if (verdict) {
        if (verdict.state === 'cancelled') run.skipped += 1;
        else if (verdict.state === 'failed') run.failed += 1;
        continue;
      }
      let sent = null;
      let transportError = null;
      try {
        sent = await transport.send({
          to: item.email,
          sender: config.sender,
          replyTo: config.replyTo,
          subject: item.message.subject,
          text: item.message.text,
          unsubscribeUrl: null,
          outboxId: item.id,
          idempotencyKey: item.idempotency_key,
        });
      } catch (error) {
        transportError = error;
      }
      // Zapis wyniku poza try transportu: błąd bazy po przyjęciu wiadomości nie
      // jest błędem transportu (#172) — wiersz zostaje w „sending” z rozpoczętą
      // wysyłką i rozstrzyga go recoverStaleVerifications (delivery_unknown).
      const result = transportError
        ? await recordVerificationResult(db, item, { error: transportError, config, now: clock(), runToken })
        : await recordVerificationResult(db, item, { messageId: sent?.messageId ?? null, config, now: clock(), runToken });
      if (result.outcome) run[result.outcome] += 1;
      if (result.stop) { stop = result.stop; break; }
    }
  } finally {
    run.requeued += await releaseVerificationClaims(db, { runToken, now: clock(), reason: stop ?? 'run_ended' });
  }
  return stop;
}

// signal: AbortSignal — po przerwaniu (SIGTERM w scripts/email-worker.js)
// przebieg kończy bieżącą wiadomość, nie zaczyna następnej, zwraca resztę
// przejętych wierszy do kolejki i zapisuje stopped_reason = 'shutdown'.
export async function runEmailBatch(env, {
  transport = null, dryRun = true, now = new Date(), config = emailConfig(env), signal = null, resultRetryDelaysMs,
} = {}) {
  const db = env?.db;
  if (!db) throw new Error('database_unavailable');
  const day = utcDay(now);
  const run = {
    mode: dryRun ? 'dry_run' : 'live', day, startedAt: now, remainingQuota: 0,
    planned: 0, sent: 0, retried: 0, failed: 0, skipped: 0, suppressed: 0, stoppedReason: null, sample: null,
    requeued: 0, unrecorded: [],
  };
  // Okno godzin wysyłki (#130): sprawdzane przed dotknięciem kolejki, żeby
  // przebieg poza oknem nie zmieniał niczego (kryterium akceptacji). Dotyczy
  // też dry-run, żeby podgląd przebiegu zgadzał się z rzeczywistym.
  if (!withinSendWindow(now, config.sendWindow)) {
    run.stoppedReason = 'outside_send_window';
    run.remainingQuota = await remainingQuota(db, now, config);
    await recordRun(db, run);
    return run;
  }
  if (!dryRun) {
    const refusal = liveRunRefusal(config) ?? (transport ? null : 'transport_missing');
    if (refusal) {
      run.stoppedReason = refusal;
      run.remainingQuota = await remainingQuota(db, now, config);
      await recordRun(db, run);
      return run;
    }
    await recoverStale(db, now);
  }
  // Trwała pauza po odmowie konta (#209): bez przejmowania kolejki i bez
  // wywołania dostawcy, dopóki zarząd jawnie nie potwierdzi naprawy. Dotyczy
  // też dry-run, żeby podgląd przebiegu zgadzał się z rzeczywistym.
  if (await activeProviderPause(db)) {
    run.stoppedReason = 'provider_account_paused';
    run.remainingQuota = await remainingQuota(db, now, config);
    await recordRun(db, run);
    return run;
  }
  // Token własności dzierżawy: tylko ten przebieg może wysłać przejęte wiersze.
  const runToken = crypto.randomUUID();
  // 0184 (#140 pkt 5): kody weryfikacyjne nowych adresów przed kampaniami (krótki
  // termin ważności), w tym samym limicie dnia i pod tą samą blokadą limitu.
  // Zatrzymanie po stronie dostawcy (odmowa konta, 429, brak połączenia,
  // SIGTERM) kończy cały przebieg — kampanie dostałyby to samo.
  const verifyStop = await processGuardianVerifications(db, { config, now, day, dryRun, run, runToken, transport, signal });
  if (verifyStop) {
    run.stoppedReason = verifyStop;
    await recordRun(db, run);
    return run;
  }
  const claimed = await claim(db, { config, now, day, dryRun, run, runToken });
  // Zegar przebiegu: wstrzyknięte „now” + rzeczywisty upływ czasu, aby dzierżawa
  // liczyła się od chwili wysyłki danej wiadomości, a nie od startu przebiegu.
  const startedMs = Date.now();
  const clock = () => new Date(now.getTime() + (Date.now() - startedMs));
  let stop = null;
  let fatal = null;
  let uncertainStreak = 0;
  const breakerUncertain = config.breakerUncertain ?? 2;
  const unrecorded = [];
  try {
    for (const item of claimed) {
      if (signal?.aborted) { stop = 'shutdown'; break; }
      const verdict = await confirmSend(db, item, { runToken, config, sendAt: clock() });
      if (verdict) {
        if (verdict.state === 'cancelled' || verdict.state === 'skipped') run.skipped += 1;
        else if (verdict.state === 'suppressed') run.suppressed += 1;
        else if (verdict.state === 'failed') run.failed += 1;
        if (verdict.error === 'campaign_cancelled' || verdict.error === 'lease_lost') run.stoppedReason ??= verdict.error;
        continue;
      }
      const { outcome, stop: stopped, uncertain } = await deliver(db, item, { transport, config, now, runToken, resultRetryDelaysMs });
      if (outcome === 'lease_lost') run.stoppedReason ??= 'lease_lost';
      else if (outcome) run[outcome] += 1;
      // Seria wyników niepewnych (5xx, timeout) = dostawca niedostępny:
      // zatrzymaj partię, zamiast zamieniać resztę w delivery_unknown (#180).
      uncertainStreak = uncertain ? uncertainStreak + 1 : 0;
      const breaker = stopped ?? (uncertainStreak >= breakerUncertain ? 'provider_unavailable' : null);
      if (breaker) {
        if (stopped && !outcome) run.requeued += 1;
        stop = breaker;
        break;
      }
    }
  } catch (error) {
    if (error instanceof ResultNotRecordedError) {
      unrecorded.push({ item: claimed.find((c) => c.id === error.outboxId), providerMessageId: error.providerMessageId });
      stop = 'result_not_recorded';
    } else {
      stop = 'database_error';
    }
    fatal = error;
  }
  if (!dryRun && claimed.length) {
    // Reszta partii, która nie trafiła do dostawcy, wraca do kolejki od razu.
    try {
      run.requeued += await releaseClaims(db, { runToken, now: clock(), reason: stop ?? 'run_ended' });
      // Baza znów odpowiada: dopisz wynik wiadomości przyjętych przez dostawcę.
      for (const entry of unrecorded.splice(0)) {
        try {
          const outcome = await recordSent(db, entry.item, { messageId: entry.providerMessageId, now, runToken });
          if (outcome === 'sent') run.sent += 1;
          else run.stoppedReason ??= 'lease_lost';
        } catch {
          unrecorded.push(entry);
        }
      }
      if (fatal instanceof ResultNotRecordedError && !unrecorded.length) fatal = null;
    } catch (error) {
      fatal ??= error;
    }
  }
  run.unrecorded = unrecorded.map((entry) => ({ outboxId: entry.item.id, providerMessageId: entry.providerMessageId }));
  if (stop) run.stoppedReason = stop;
  if (fatal) {
    // Baza nadal nie odpowiada: wiersze w „sending” rozstrzygnie recoverStale
    // po wygaśnięciu dzierżawy (niewysłane → queued, rozpoczęte → webhook albo
    // delivery_unknown). Identyfikatory przyjętych wiadomości — do logu.
    const error = fatal instanceof ResultNotRecordedError ? fatal : Object.assign(new Error('email_run_interrupted'), { cause: fatal });
    error.code ??= 'email_run_interrupted';
    error.run = run;
    throw error;
  }
  if (!dryRun) await completeCampaigns(db, now);
  await recordRun(db, run);
  return run;
}
