// Kod weryfikacyjny na nowy adres z wniosku rodzica o aktualizację kontaktu
// (#140 pkt 5, migracja 0184). Czyste funkcje bez sieci i bazy — wspólne dla
// trasy (src/pg/routes/guardian-updates.js) i workera (src/email/worker.js).
//
// Założenia do potwierdzenia (docs/DECISIONS.md, notatka techniczna 02.10.2026):
// kod 8 cyfr, ważny 24 godziny od przejęcia do wysyłki, najwyżej 5 błędnych
// prób; w bazie wyłącznie skrót SHA-256 z losową solą wiersza. Treść wiadomości
// to zatwierdzony przez zarząd szablon (guardian_verify_templates) — kod nie
// dostarcza treści domyślnej.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const VERIFY_CODE_LENGTH = 8;
export const VERIFY_CODE_TTL_HOURS = 24;
export const VERIFY_CODE_TTL_MS = VERIFY_CODE_TTL_HOURS * 60 * 60 * 1000;
// Ta sama wartość co CHECK guardian_update_verifications.failed_attempts (0184).
export const VERIFY_MAX_FAILED_ATTEMPTS = 5;
export const VERIFY_CODE_PATTERN = /^\d{8}$/;
// {kod} — kod (obowiązkowy w treści, zakazany w temacie: podgląd powiadomień
// telefonu pokazuje temat), {waznosc} — liczba godzin ważności.
export const VERIFY_BODY_PLACEHOLDERS = Object.freeze(['kod', 'waznosc']);
export const VERIFY_SUBJECT_PLACEHOLDERS = Object.freeze([]);

export const VERIFICATION_STATUSES = Object.freeze(['none', 'sent', 'confirmed', 'expired', 'failed']);

// Flaga GUARDIAN_VERIFY_EMAIL_ENABLED (domyślnie wyłączona): wyłącznie dokładnie
// `true`, tak jak EMAIL_SENDING_ENABLED. Obiekt env ma pierwszeństwo przed
// process.env (testy podają env jawnie).
export function guardianVerifyEnabled(env) {
  const raw = env && Object.hasOwn(env, 'GUARDIAN_VERIFY_EMAIL_ENABLED')
    ? env.GUARDIAN_VERIFY_EMAIL_ENABLED
    : process.env.GUARDIAN_VERIFY_EMAIL_ENABLED;
  return raw === 'true';
}

// #100 (art. 18 RODO): ograniczenie przetwarzania opiekuna albo któregokolwiek
// z jego gospodarstw wstrzymuje kod (przy złożeniu wniosku i tuż przed wysyłką).
// $1 = identyfikator opiekuna.
export const GUARDIAN_RESTRICTED_SQL = `SELECT 1 FROM processing_restricted_subjects x
   WHERE x.guardian_id = $1
      OR x.household_id IN (SELECT g.household_id FROM guardians g WHERE g.id = $1
                            UNION SELECT gh.household_id FROM guardian_households gh WHERE gh.guardian_id = $1)
   LIMIT 1`;

export function verifyTemplateHash({ subject, bodyText }) {
  return createHash('sha256').update(JSON.stringify(['rd-guardian-verify-template-v1', subject, bodyText])).digest('hex');
}

export function generateVerificationCode() {
  let code = '';
  for (let i = 0; i < VERIFY_CODE_LENGTH; i += 1) code += String(randomInt(0, 10));
  return code;
}

export function newCodeSalt() {
  return randomBytes(16).toString('hex');
}

export function hashVerificationCode(salt, code) {
  return createHash('sha256').update(`rd-guardian-verify-code-v1:${salt}:${code}`).digest('hex');
}

// Porównanie w stałym czasie (skróty mają zawsze 64 znaki hex).
export function codeMatches({ code_salt: salt, code_hash: hash }, code) {
  if (!salt || !hash || typeof code !== 'string' || !VERIFY_CODE_PATTERN.test(code)) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = Buffer.from(hashVerificationCode(salt, code), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const PLACEHOLDER = /\{([^{}]*)\}/g;

function fill(text, values) {
  return text.replace(PLACEHOLDER, (_, name) => (Object.hasOwn(values, name) ? String(values[name]) : ''));
}

// Wiadomość z kodem: czysty tekst, jeden odbiorca. Stopka informacji
// o przetwarzaniu danych (D-06) jak w kampaniach — wersja zapamiętana przy
// złożeniu wniosku. Bez stopki wypisania: to wiadomość transakcyjna na prośbę
// rodzica, nie komunikat kategorii (#110).
export function renderVerifyMessage(template, { code, privacyNotice }) {
  if (!VERIFY_CODE_PATTERN.test(String(code))) throw new Error('verification_code_invalid');
  const values = { kod: code, waznosc: String(VERIFY_CODE_TTL_HOURS) };
  const subject = fill(template.subject, values);
  let text = fill(template.body_text ?? template.bodyText, values);
  if (privacyNotice) {
    const where = privacyNotice.url ? `: ${privacyNotice.url}` : '';
    text = `${text}\n\n--\nInformacja o przetwarzaniu danych osobowych (wersja ${privacyNotice.version})${where}`;
  }
  return { subject, text };
}

// Stan weryfikacji widoczny w kolejce wniosków (API i panel families/):
//   none      — nic nie zlecono (wniosek bez nowego adresu, flaga wyłączona, brak
//               zatwierdzonego szablonu albo informacji o przetwarzaniu,
//               ograniczenie przetwarzania, wniosek rozstrzygnięty przed wysyłką);
//   sent      — kod zlecony (w kolejce, w wysyłce albo przyjęty przez dostawcę);
//   confirmed — rodzic wpisał poprawny kod;
//   expired   — termin kodu minął bez potwierdzenia;
//   failed    — wysyłka się nie udała albo wyczerpano próby wpisania kodu.
// `reason` to kod powodu (bez adresu), `delivery` — stan kolejki.
export function verificationStatus(row, now = new Date(), { hasNewEmail = true } = {}) {
  if (!row) return { status: 'none', reason: hasNewEmail ? 'not_requested' : 'no_new_email', delivery: null, expiresAt: null };
  const expiresAt = row.code_expires_at ? new Date(row.code_expires_at).toISOString() : null;
  const base = { delivery: row.state, expiresAt };
  if (row.confirmed_at) return { ...base, status: 'confirmed', reason: null };
  if (row.state === 'skipped' || row.state === 'cancelled') return { ...base, status: 'none', reason: row.last_error };
  if (row.state === 'failed') return { ...base, status: 'failed', reason: row.last_error };
  if (row.failed_attempts >= VERIFY_MAX_FAILED_ATTEMPTS) return { ...base, status: 'failed', reason: 'attempts_exhausted' };
  if (row.code_expires_at && new Date(row.code_expires_at) <= now) return { ...base, status: 'expired', reason: null };
  return { ...base, status: 'sent', reason: null };
}
