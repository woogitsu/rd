// Propozycje rozstrzygnięć dla wierszy `failed/delivery_unknown` (#139, pkt 4).
//
// Zasady:
// - TYLKO odczyt: moduł nie zapisuje niczego w bazie (ani rozstrzygnięć, ani
//   dziennika) i nie wysyła poczty. Rozstrzygnięcie zapisuje człowiek przez
//   POST /api/email/campaigns/{id}/resolutions (panel email/).
// - Źródło podstawowe: zapisane zdarzenia webhooka Brevo z X-Mailin-custom =
//   id wiersza (email_webhook_events.outbox_id). Bez sieci.
// - Opcjonalnie (`queryBrevo`): zapytanie tylko do odczytu o zdarzenia po
//   message-id (GET /v3/smtp/statistics/events), wyłącznie dla wierszy, które
//   mają zapisany provider_message_id. Adres odbiorcy NIE jest wysyłany do
//   Brevo, a odpowiedź jest sprowadzana do samych nazw zdarzeń.
// - Nigdy nie proponujemy `confirmed_not_sent`: brak zdarzenia nie dowodzi,
//   że wiadomość nie wyszła (webhook mógł zostać odrzucony, zdarzenie mogło
//   jeszcze nie dojść). To twierdzenie wymaga sprawdzenia logów Brevo przez
//   człowieka i roli zarządu (docs/EMAIL.md).
// - Wynik zawiera wyłącznie identyfikatory wierszy/kampanii i kody — bez
//   adresów, imion i identyfikatorów rodzin.

export const BREVO_EVENTS_ENDPOINT = 'https://api.brevo.com/v3/smtp/statistics/events';
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
export const MAX_BREVO_LOOKUPS = 100;

// Zdarzenia świadczące o doręczeniu do skrzynki odbiorcy.
const DELIVERED_EVENTS = new Set(['delivered', 'opened', 'unique_opened', 'click', 'proxy_open', 'loaded_by_proxy']);
// Wiadomość wyszła, ale adres/skrzynka ją odrzuciły — nie „nie wysłano”.
const BOUNCED_EVENTS = new Set(['hard_bounce', 'invalid_email', 'blocked', 'spam', 'complaint']);

// Nazwy zdarzeń API statystyk Brevo → nazwy webhooka używane w aplikacji.
const API_EVENT_NAMES = Object.freeze({
  requests: 'request', delivered: 'delivered', opened: 'opened', clicks: 'click', loadedbyproxy: 'loaded_by_proxy',
  bounces: 'hard_bounce', hardbounces: 'hard_bounce', softbounces: 'soft_bounce', spam: 'spam', invalid: 'invalid_email',
  deferred: 'deferred', blocked: 'blocked', unsubscribed: 'unsubscribed', error: 'error',
});

function normalizeApiEvent(name) {
  const key = String(name ?? '').replace(/[^A-Za-z]/g, '').toLowerCase();
  return API_EVENT_NAMES[key] ?? null;
}

// Propozycja z zestawu zdarzeń. Kolejność ma znaczenie: doręczenie > odbicie >
// przyjęcie przez dostawcę > brak dowodu.
export function proposeFromEvents(events, source) {
  const set = new Set(events);
  if ([...set].some((event) => DELIVERED_EVENTS.has(event))) {
    return { proposal: 'confirmed_delivered', evidenceCode: `${source}_delivered` };
  }
  if ([...set].some((event) => BOUNCED_EVENTS.has(event))) {
    return { proposal: 'review_bounced', evidenceCode: null };
  }
  if (set.size > 0) return { proposal: 'review_accepted_by_provider', evidenceCode: null };
  return { proposal: 'check_brevo_logs', evidenceCode: null };
}

function underTestRunner(processEnv) {
  return Boolean(processEnv?.NODE_TEST_CONTEXT);
}

// Jedno zapytanie tylko do odczytu po message-id. Zwraca { code, events }.
export async function lookupBrevoEvents(messageId, {
  apiKey, fetchImpl = globalThis.fetch, endpoint = BREVO_EVENTS_ENDPOINT, processEnv = process.env,
} = {}) {
  if (underTestRunner(processEnv)) return { code: 'lookup_disabled_in_test', events: [] };
  if (!apiKey) return { code: 'api_key_missing', events: [] };
  const url = new URL(endpoint);
  url.searchParams.set('messageId', messageId);
  url.searchParams.set('limit', '100');
  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { 'api-key': apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { code: 'provider_unreachable', events: [] };
  }
  if (!response.ok) return { code: `provider_status_${response.status}`, events: [] };
  let body;
  try {
    body = await response.json();
  } catch {
    return { code: 'provider_invalid_response', events: [] };
  }
  const list = Array.isArray(body?.events) ? body.events : [];
  const events = [...new Set(list.map((item) => normalizeApiEvent(item?.event)).filter(Boolean))].sort();
  return { code: 'ok', events };
}

function clampLimit(value) {
  const number = Number(value ?? DEFAULT_LIMIT);
  if (!Number.isInteger(number) || number < 1) return DEFAULT_LIMIT;
  return Math.min(number, MAX_LIMIT);
}

// db: obiekt z metodą query (PGlite/pg). Zwraca { rows, lookups, stoppedCode }.
export async function proposeResolutions(db, {
  campaignId = null, limit, queryBrevo = false, apiKey, fetchImpl, processEnv = process.env,
} = {}) {
  const values = [];
  let filter = '';
  if (campaignId) {
    values.push(campaignId);
    filter = 'AND o.campaign_id = $1';
  }
  const { rows } = await db.query(
    `SELECT o.id AS outbox_id, o.campaign_id, o.provider_message_id,
            ARRAY(SELECT DISTINCT w.event FROM email_webhook_events w WHERE w.outbox_id = o.id ORDER BY w.event) AS events
       FROM email_outbox o
      WHERE o.state = 'failed' AND o.last_error = 'delivery_unknown'
        AND NOT EXISTS (SELECT 1 FROM email_outbox_resolutions r WHERE r.outbox_id = o.id)
        ${filter}
      ORDER BY o.campaign_id, o.id
      LIMIT ${clampLimit(limit)}`,
    values,
  );
  let lookups = 0;
  let stoppedCode = null;
  const out = [];
  for (const row of rows) {
    const events = Array.isArray(row.events) ? row.events : [];
    let source = events.length ? 'webhook' : 'none';
    let found = events;
    let lookupCode = null;
    if (!events.length && queryBrevo) {
      if (!row.provider_message_id) {
        lookupCode = 'no_message_id';
      } else if (stoppedCode) {
        lookupCode = stoppedCode;
      } else if (lookups >= MAX_BREVO_LOOKUPS) {
        lookupCode = 'lookup_limit_reached';
      } else {
        lookups += 1;
        const result = await lookupBrevoEvents(row.provider_message_id, { apiKey, fetchImpl, processEnv });
        lookupCode = result.code;
        // Odmowa klucza albo blokada testowa: dalsze zapytania nic nie dadzą.
        if (['api_key_missing', 'lookup_disabled_in_test', 'provider_status_401', 'provider_status_403'].includes(result.code)) {
          stoppedCode = result.code;
        }
        if (result.events.length) {
          source = 'brevo_api';
          found = result.events;
        }
      }
    }
    const { proposal, evidenceCode } = proposeFromEvents(found, source === 'brevo_api' ? 'brevo_api' : 'webhook');
    out.push({
      outboxId: row.outbox_id,
      campaignId: row.campaign_id,
      providerMessageId: row.provider_message_id ?? null,
      source,
      events: [...found].sort(),
      ...(lookupCode ? { lookupCode } : {}),
      proposal,
      evidenceCode,
    });
  }
  return { rows: out, lookups, stoppedCode };
}
