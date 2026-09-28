// Klient Brevo (transakcyjne API) i twarde bariery bezpieczeństwa wysyłki.
//
// Zasady (AGENTS.md, docs/EMAIL.md):
// - wysyłka jest WYŁĄCZONA, dopóki EMAIL_SENDING_ENABLED nie jest dokładnie "true";
// - prawdziwy transport HTTP odmawia pracy przy APP_ENV=test i pod `node --test`
//   (NODE_TEST_CONTEXT), zanim wywoła fetch;
// - poza APP_ENV=production każdy adres musi pasować do EMAIL_TEST_ALLOWLIST
//   (adresy techniczne, np. "*@example.invalid"); pusta lista = brak wysyłki;
// - jedna wiadomość = jeden odbiorca; idempotencję zapewnia kolejka (email_outbox),
//   a klucz trafia też w nagłówku wiadomości do diagnostyki;
// - klucz API wyłącznie z sekretu serwera (BREVO_API_KEY), nigdy w logach.

export const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
const REQUEST_TIMEOUT_MS = 15_000;

// Domeny darmowych skrzynek pocztowych (adres nadawcy nie może z nich pochodzić
// na produkcji — issue #148). Lista orientacyjna, do uzupełnienia przy D-17.
export const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.fr', 'outlook.com', 'hotmail.com',
  'hotmail.fr', 'live.com', 'live.fr', 'msn.com', 'aol.com', 'icloud.com', 'me.com',
  'gmx.com', 'gmx.net', 'protonmail.com', 'proton.me', 'mail.com', 'yandex.com',
  'wp.pl', 'o2.pl', 'interia.pl', 'onet.pl', 'gazeta.pl', 'skynet.be', 'telenet.be',
  'proximus.be', 'voo.be',
]);

export function senderDomain(email) {
  const address = String(email ?? '').toLowerCase();
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1) : '';
}

export function isFreeEmailDomain(email) {
  return FREE_EMAIL_DOMAINS.has(senderDomain(email));
}

function intFrom(value, fallback, { min = 0, max = 100_000 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return fallback;
  return number;
}

export function parseAllowlist(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^(\*|[^\s@*,]+)@[a-z0-9.-]+$/.test(item));
}

const DEFAULT_QUOTA_TIMEZONE = 'Europe/Brussels';

// Strefa doby limitu Brevo (#84): konto szkoły najpewniej pracuje w strefie
// belgijskiej, nie w UTC. Wartość niedozwolona dla Intl (literówka w env)
// wraca do domyślnej zamiast rzucać wyjątek przy starcie workera.
function quotaTimezoneFrom(value) {
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_QUOTA_TIMEZONE;
  try {
    // eslint-disable-next-line no-new -- tylko walidacja identyfikatora strefy
    new Intl.DateTimeFormat('en-CA', { timeZone: candidate });
    return candidate;
  } catch {
    return DEFAULT_QUOTA_TIMEZONE;
  }
}

// Ta sama walidacja, dla okna wysyłki (#130) — osobna funkcja, bo ma inną
// (parametryzowaną) wartość domyślną niż strefa limitu Brevo powyżej.
function validTimezone(value, fallback) {
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  try {
    // eslint-disable-next-line no-new -- tylko walidacja identyfikatora strefy
    new Intl.DateTimeFormat('en-CA', { timeZone: candidate });
    return candidate;
  } catch {
    return fallback;
  }
}

// 'HH:MM' -> minuty od północy, albo null jeśli nieprawidłowe.
function minutesFrom(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? '').trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

// Dni tygodnia ISO (1 = poniedziałek … 7 = niedziela), np. '1-5' albo '1,3,5'.
function daysFrom(value) {
  const text = String(value ?? '1-5').trim();
  const days = new Set();
  for (const part of text.split(',')) {
    const range = /^([1-7])(?:-([1-7]))?$/.exec(part.trim());
    if (!range) continue;
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : start;
    for (let d = start; d <= end; d += 1) days.add(d);
  }
  return days.size ? days : new Set([1, 2, 3, 4, 5]);
}

// Okno godzin wysyłki (#130). Wyłączone domyślnie — termin i godziny ustala
// zarząd/szkoła (D-16); włącza się jawnie przez EMAIL_SEND_WINDOW_ENABLED.
function sendWindowFrom(env) {
  const enabled = env.EMAIL_SEND_WINDOW_ENABLED === 'true';
  const startMinutes = minutesFrom(env.EMAIL_SEND_WINDOW_START) ?? 9 * 60;
  const endMinutes = minutesFrom(env.EMAIL_SEND_WINDOW_END) ?? 18 * 60;
  return {
    enabled,
    timezone: validTimezone(env.EMAIL_SEND_WINDOW_TIMEZONE, 'Europe/Brussels'),
    days: daysFrom(env.EMAIL_SEND_WINDOW_DAYS),
    // Okno puste (start >= end) po literówce w env liczy się jako zamknięte
    // przez całą dobę, nigdy jako "cały dzień otwarte".
    startMinutes, endMinutes: Math.max(startMinutes, endMinutes),
  };
}

// Konfiguracja z env (process.env w skrypcie, obiekt env w testach).
export function emailConfig(env = {}) {
  const dailyLimit = intFrom(env.EMAIL_DAILY_LIMIT, 300, { min: 0, max: 100_000 });
  return {
    appEnv: String(env.APP_ENV ?? 'development'),
    sendingEnabled: env.EMAIL_SENDING_ENABLED === 'true',
    dailyLimit,
    dailyReserved: Math.min(dailyLimit, intFrom(env.EMAIL_DAILY_RESERVED, 0, { min: 0, max: 100_000 })),
    quotaTimezone: quotaTimezoneFrom(env.EMAIL_QUOTA_TIMEZONE),
    minDays: intFrom(env.EMAIL_CAMPAIGN_MIN_DAYS, 7, { min: 1, max: 60 }),
    minDailyCap: intFrom(env.EMAIL_CAMPAIGN_MIN_DAILY, 50, { min: 1, max: 10_000 }),
    batchSize: intFrom(env.EMAIL_BATCH_SIZE, 50, { min: 1, max: 500 }),
    maxAttempts: intFrom(env.EMAIL_MAX_ATTEMPTS, 5, { min: 1, max: 20 }),
    // Wyłącznik (#180): po tylu kolejnych wynikach niepewnych (5xx, timeout)
    // przebieg się zatrzymuje, a reszta partii zostaje w kolejce.
    breakerUncertain: intFrom(env.EMAIL_BREAKER_UNCERTAIN, 2, { min: 1, max: 50 }),
    allowlist: parseAllowlist(env.EMAIL_TEST_ALLOWLIST),
    sender: { email: env.BREVO_FROM_EMAIL || null, name: env.BREVO_FROM_NAME || 'Rada Rodziców' },
    // Adres odpowiedzi (#148) — puste pole na produkcji jest odmową (rodzic bez odpowiedzi).
    replyTo: env.BREVO_REPLY_TO || null,
    sendWindow: sendWindowFrom(env),
  };
}

// #130: czy `now` mieści się w oknie dni/godzin wysyłki. Okno wyłączone
// (domyślnie) zawsze zwraca true.
export function withinSendWindow(now, sendWindow) {
  if (!sendWindow?.enabled) return true;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: sendWindow.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const weekdayName = parts.find((p) => p.type === 'weekday').value;
  const hour = Number(parts.find((p) => p.type === 'hour').value);
  const minute = Number(parts.find((p) => p.type === 'minute').value);
  const isoWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekdayName) + 1;
  const minutes = hour * 60 + minute;
  return sendWindow.days.has(isoWeekday) && minutes >= sendWindow.startMinutes && minutes < sendWindow.endMinutes;
}

export function isProduction(config) {
  return config.appEnv === 'production';
}

export function matchesAllowlist(allowlist, email) {
  const address = String(email).toLowerCase();
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return allowlist.some((pattern) => pattern === address || pattern === `*@${domain}`);
}

// Zwraca kod odmowy albo null. Sprawdzane przy każdym odbiorcy tuż przed wysyłką.
export function recipientRefusal(config, email) {
  if (isProduction(config)) return null;
  if (!config.allowlist.length || !matchesAllowlist(config.allowlist, email)) return 'recipient_not_allowlisted';
  return null;
}

// Kod odmowy całego przebiegu na żywo albo null.
export function liveRunRefusal(config) {
  if (!config.sendingEnabled) return 'sending_disabled';
  if (!config.sender.email) return 'sender_not_configured';
  // Darmowa domena (prywatna skrzynka) nie przechodzi DMARC/DKIM domeny szkoły/Rady (#148, D-17).
  if (isFreeEmailDomain(config.sender.email)) return 'sender_free_domain';
  // Na produkcji odpowiedzi rodzica muszą trafić na obsługiwaną skrzynkę (#148).
  if (isProduction(config) && !config.replyTo) return 'reply_to_not_configured';
  return null;
}

export class EmailTransportError extends Error {
  // retryable: dostawca jawnie odrzucił przed przyjęciem (np. 429) — można ponowić.
  // uncertain: nie wiadomo, czy wiadomość wyszła — NIE ponawiamy automatycznie.
  // accountLevel: dostawca odrzucił konto, nie odbiorcę (401/402/403: zły lub
  //   obrócony klucz, brak kredytów, nieuprawniony nadawca/IP) — wiadomość nie
  //   wyszła; przebieg się zatrzymuje, wiersz wraca do kolejki (#209).
  // notSent: żądanie na pewno nie dotarło do dostawcy (błąd połączenia przed
  //   wysłaniem: odmowa połączenia, DNS, TLS) — to nie jest „nie wiadomo” (#180).
  // retryAfterSeconds: z nagłówka Retry-After (429), jeśli podany.
  constructor(code, { retryable = false, uncertain = false, accountLevel = false, notSent = false, retryAfterSeconds = null } = {}) {
    super(code);
    this.code = code;
    this.retryable = retryable;
    this.uncertain = uncertain;
    this.accountLevel = accountLevel;
    this.notSent = notSent;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Błędy połączenia, przy których żądanie HTTP nie zostało wysłane: brak
// połączenia TCP, nieznany host, nieudany handshake TLS. Reset połączenia,
// zamknięcie gniazda i timeout mogą nastąpić po wysłaniu treści — te pozostają
// niepewne.
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export function connectionNotEstablished(error) {
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth += 1) {
    if (typeof current.code === 'string' && NOT_SENT_CODES.has(current.code)) return true;
  }
  return false;
}

const MAX_RETRY_AFTER_SECONDS = 24 * 3600;

export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const text = String(value).trim();
  let seconds = null;
  if (/^\d{1,9}$/.test(text)) seconds = Number(text);
  else {
    const at = Date.parse(text);
    if (Number.isFinite(at)) seconds = Math.ceil((at - now) / 1000);
  }
  if (seconds === null || seconds < 0) return null;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

function underTestRunner(processEnv) {
  return Boolean(processEnv?.NODE_TEST_CONTEXT);
}

// Transport HTTP do Brevo. W testach NIE jest używany — testy podają fałszywy
// transport; ten obiekt odmawia przy APP_ENV=test lub pod `node --test`.
export function createBrevoTransport({
  apiKey, appEnv, fetchImpl = globalThis.fetch, endpoint = BREVO_ENDPOINT, processEnv = process.env,
} = {}) {
  return {
    name: 'brevo',
    async send(message) {
      if (appEnv === 'test' || underTestRunner(processEnv)) {
        throw new EmailTransportError('transport_disabled_in_test');
      }
      if (!apiKey) throw new EmailTransportError('api_key_missing');
      if (!message?.to || Array.isArray(message.to)) throw new EmailTransportError('single_recipient_required');
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            sender: message.sender,
            to: [{ email: message.to }],
            ...(message.replyTo ? { replyTo: { email: message.replyTo } } : {}),
            subject: message.subject,
            textContent: message.text,
            headers: {
              'X-Mailin-custom': message.outboxId,
              'X-RD-Idempotency-Key': message.idempotencyKey,
            },
            tags: ['rd-campaign'],
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        // Połączenie nie powstało — żądanie nie wyszło, można ponowić.
        if (connectionNotEstablished(error)) throw new EmailTransportError('provider_unreachable', { retryable: true, notSent: true });
        // Przerwane połączenie/timeout: nie wiemy, czy Brevo przyjęło wiadomość.
        throw new EmailTransportError('delivery_unknown', { uncertain: true });
      }
      if (response.status === 429) {
        throw new EmailTransportError('provider_rate_limited', {
          retryable: true, retryAfterSeconds: parseRetryAfter(response.headers?.get?.('retry-after')),
        });
      }
      if (response.status >= 500) throw new EmailTransportError('delivery_unknown', { uncertain: true });
      if ([401, 402, 403].includes(response.status)) {
        throw new EmailTransportError(`provider_rejected_${response.status}`, { accountLevel: true });
      }
      if (!response.ok) throw new EmailTransportError(`provider_rejected_${response.status}`);
      let messageId = null;
      try {
        const body = await response.json();
        messageId = typeof body?.messageId === 'string' ? body.messageId.slice(0, 200) : null;
      } catch {
        messageId = null;
      }
      return { messageId };
    },
  };
}
