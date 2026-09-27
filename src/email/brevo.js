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

// Konfiguracja z env (process.env w skrypcie, obiekt env w testach).
export function emailConfig(env = {}) {
  const dailyLimit = intFrom(env.EMAIL_DAILY_LIMIT, 300, { min: 0, max: 100_000 });
  return {
    appEnv: String(env.APP_ENV ?? 'development'),
    sendingEnabled: env.EMAIL_SENDING_ENABLED === 'true',
    dailyLimit,
    dailyReserved: Math.min(dailyLimit, intFrom(env.EMAIL_DAILY_RESERVED, 0, { min: 0, max: 100_000 })),
    minDays: intFrom(env.EMAIL_CAMPAIGN_MIN_DAYS, 7, { min: 1, max: 60 }),
    minDailyCap: intFrom(env.EMAIL_CAMPAIGN_MIN_DAILY, 50, { min: 1, max: 10_000 }),
    batchSize: intFrom(env.EMAIL_BATCH_SIZE, 50, { min: 1, max: 500 }),
    maxAttempts: intFrom(env.EMAIL_MAX_ATTEMPTS, 5, { min: 1, max: 20 }),
    allowlist: parseAllowlist(env.EMAIL_TEST_ALLOWLIST),
    sender: { email: env.BREVO_FROM_EMAIL || null, name: env.BREVO_FROM_NAME || 'Rada Rodziców' },
  };
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
  return null;
}

export class EmailTransportError extends Error {
  // retryable: dostawca jawnie odrzucił przed przyjęciem (np. 429) — można ponowić.
  // uncertain: nie wiadomo, czy wiadomość wyszła — NIE ponawiamy automatycznie.
  constructor(code, { retryable = false, uncertain = false } = {}) {
    super(code);
    this.code = code;
    this.retryable = retryable;
    this.uncertain = uncertain;
  }
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
      } catch {
        // Przerwane połączenie/timeout: nie wiemy, czy Brevo przyjęło wiadomość.
        throw new EmailTransportError('delivery_unknown', { uncertain: true });
      }
      if (response.status === 429) throw new EmailTransportError('provider_rate_limited', { retryable: true });
      if (response.status >= 500) throw new EmailTransportError('delivery_unknown', { uncertain: true });
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
