// Treść kampanii e-mail: walidacja, skróty do zatwierdzenia i renderowanie.
// Czyste funkcje bez sieci i bazy. Składka jest dobrowolna — słownik
// niedozwolonych sformułowań jest wspólny z kartkami (print/core.js).

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { findForbiddenWording } from '../../print/core.js';
import { formatStructuredReference, isValidStructuredReference } from '../pg/ogm.js';
import { formatIbanForDisplay, isValidIban } from '../../print/iban.js';

export { findForbiddenWording };

export const AUDIENCES = Object.freeze(['all_households', 'no_payment_record']);
// #113: odbiorcy kampanii powiązanej z zebraniem klasowym (rodziny dzieci jednej
// klasy w roku). Nie do wyboru w ręcznie tworzonym szkicu — powstaje wyłącznie
// z zatwierdzonego zawiadomienia (src/pg/meetings.js) razem z class_id.
// 0183 (#113): 'meeting_invitees' — KONTA (users) zaproszonych na zebranie zarządu,
// nie rodziny: aktywny przydział jednej z ról MEETING_INVITEE_ROLES w roku kampanii.
export const MEETING_AUDIENCES = Object.freeze(['class_households', 'meeting_invitees']);
// Odbiorcy-konta (0183). Jedna wiadomość na konto, adres = users.email.
export const ACCOUNT_AUDIENCES = Object.freeze(['meeting_invitees']);
// Role zapraszane na zebranie zarządu (wskazania właściciela 2026-10-02, D-21):
// zarząd, skarbnik, przedstawiciele klas, Komisja Rewizyjna i dyrekcja. Admin
// techniczny — nie (rola techniczna, nie członek Rady).
export const MEETING_INVITEE_ROLES = Object.freeze(['board', 'treasurer', 'representative', 'audit', 'principal']);

export function isAccountAudience(audience) {
  return ACCOUNT_AUDIENCES.includes(audience);
}

// Warunek SQL „konto ma aktywny przydział zapraszanej roli w roku kampanii” —
// jedna definicja dla migawki (src/pg/routes/email.js) i dla ponownego sprawdzenia
// w workerze tuż przed wysyłką (src/email/worker.js). Argumenty to wyrażenia SQL
// (kolumna konta, parametr listy ról, chwila, parametr roku). Przydział aktywny =
// niecofnięty i niewygasły w tej chwili; obowiązuje w roku, gdy ma ten rok albo
// nie ma roku (jak resolver zakresu src/pg/scope.js). Przydział klasowy też się liczy.
export function inviteeGrantSql({ user, roles, at, year }) {
  return `EXISTS (SELECT 1 FROM role_grants g
             WHERE g.user_id = ${user} AND g.role = ANY(${roles})
               AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > ${at})
               AND (g.school_year_id IS NULL OR g.school_year_id = ${year}))`;
}
// Kategoria komunikatu (#110). `organizational` bez linku wypisania wymaga
// osobnej decyzji zarządu/szkoły (D-06) — do tego czasu każda kategoria ma link.
export const CATEGORIES = Object.freeze(['contribution_reminder', 'organizational']);
export const DEFAULT_CATEGORY = 'contribution_reminder';
// {rok} — etykieta roku szkolnego, {rodzina} — identyfikator rodziny jako tytuł przelewu,
// {komunikat} — aktywna komunikacja strukturalna OGM-VCS rodziny w roku kampanii
// (+++ddd/dddd/ddddd+++, rejestr payment_references, #83),
// {rachunek} / {odbiorca} — IBAN i nazwa odbiorcy z ZATWIERDZONEJ na rok wersji
// danych do wpłaty (payment_instructions, #92); bez zatwierdzonej wersji kampanii
// nie da się zatwierdzić, a zmiana rachunku po zatwierdzeniu kampanii wstrzymuje
// jej wysyłkę do ponownego zatwierdzenia.
// Brak placeholderów z imieniem dziecka lub opiekuna (minimalizacja, EMAIL.md).
export const BODY_PLACEHOLDERS = Object.freeze(['rok', 'rodzina', 'komunikat', 'rachunek', 'odbiorca']);
export const PAYMENT_INSTRUCTION_PLACEHOLDERS = Object.freeze(['rachunek', 'odbiorca']);
// Przykładowa referencja podglądu i wiadomości testowej: baza 0000000000,
// suma kontrolna 97 — poprawny format, niczyja referencja (generator nie
// losuje samych zer, src/pg/ogm.js randomBase).
export const SAMPLE_STRUCTURED_REFERENCE = '000000000097';
export const SUBJECT_PLACEHOLDERS = Object.freeze(['rok']);
// Wiadomość do konta (0183) nie dotyczy rodziny: bez {rodzina}, {komunikat},
// {rachunek} i {odbiorca} (nie ma czym ich wypełnić).
export const ACCOUNT_BODY_PLACEHOLDERS = Object.freeze(['rok']);

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const PLACEHOLDER = /\{([^{}]*)\}/g;
const SKIP_HINT = /pomin|pomiń/i;

export class ContentError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function placeholdersIn(text) {
  return [...String(text).matchAll(PLACEHOLDER)].map((match) => match[1]);
}

// `code` jest kodem błędu wprost (nie składanym z nazwy pola), żeby katalog docs/API_ERRORS.md
// i kontrakt OpenAPI (#160) widziały go w źródle.
function checkText(value, { min, max, code, allowNewlines, placeholders }) {
  if (typeof value !== 'string') throw new ContentError(code);
  const text = value.replace(/\r\n/g, '\n').trim();
  if (text.length < min || text.length > max) throw new ContentError(code);
  if (CONTROL.test(text) || (!allowNewlines && /\n/.test(text))) throw new ContentError(code);
  if (findForbiddenWording(text)) throw new ContentError('forbidden_wording');
  // Nawiasy klamrowe poza znanymi placeholderami są błędem (literówka = pusta treść u rodzica).
  const opened = (text.match(/[{}]/g) ?? []).length;
  const found = placeholdersIn(text);
  if (opened !== found.length * 2 || found.some((name) => !placeholders.includes(name))) {
    throw new ContentError('invalid_placeholder');
  }
  return text;
}

// Walidacja danych kampanii z żądania. Zwraca znormalizowane pola.
export function parseCampaignContent(data, { audiences = AUDIENCES } = {}) {
  if (!data || typeof data !== 'object') throw new ContentError('invalid_request');
  const title = checkText(data.title, { min: 3, max: 200, code: 'invalid_title', allowNewlines: false, placeholders: [] });
  const subject = checkText(data.subject, { min: 3, max: 200, code: 'invalid_subject', allowNewlines: false, placeholders: SUBJECT_PLACEHOLDERS });
  const bodyPlaceholders = isAccountAudience(data.audience) ? ACCOUNT_BODY_PLACEHOLDERS : BODY_PLACEHOLDERS;
  const bodyText = checkText(data.bodyText, { min: 20, max: 10000, code: 'invalid_body', allowNewlines: true, placeholders: bodyPlaceholders });
  if (!audiences.includes(data.audience)) throw new ContentError('invalid_audience');
  const category = data.category === undefined ? DEFAULT_CATEGORY : data.category;
  if (!CATEGORIES.includes(category)) throw new ContentError('invalid_category');
  return { title, subject, bodyText, audience: data.audience, category };
}

// Skrót dokładnej treści, którą zatwierdza zarząd. Tytuł wewnętrzny nie trafia
// do rodziców, więc nie wchodzi do skrótu. Kategoria wchodzi do skrótu (v2,
// #110) — decyduje o stopce wypisania, więc jest częścią zatwierdzanej treści.
export function contentHash({ schoolYearId, audience, subject, bodyText, category = DEFAULT_CATEGORY }) {
  return sha256Hex(JSON.stringify(['rd-email-content-v2', schoolYearId, audience, category, subject, bodyText]));
}

// Skrót migawki odbiorców: posortowane trójki (rodzina, opiekun, skrót adresu).
// Migawka kont (0183) ma osobną wersję skrótu: posortowane pary (konto, skrót
// adresu) — skrót kampanii rodzin pozostaje bajt w bajt taki sam jak wcześniej.
export function recipientsHash(rows) {
  if (rows.some((row) => (row.user_id ?? row.userId) != null)) {
    const accounts = rows
      .map((row) => [row.user_id ?? row.userId, row.email_hash ?? row.emailHash])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return sha256Hex(JSON.stringify(['rd-email-recipients-accounts-v1', accounts]));
  }
  const lines = rows
    .map((row) => [row.household_id ?? row.householdId, row.guardian_id ?? row.guardianId, row.email_hash ?? row.emailHash])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256Hex(JSON.stringify(['rd-email-recipients-v1', lines]));
}

// Adres: małe litery, bez spacji; odrzucamy wszystko, co nie wygląda na
// pojedynczą skrzynkę (przecinki, nawiasy, nagłówki, podwójne kropki).
const LOCAL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length < 6 || email.length > 254) return null;
  const at = email.lastIndexOf('@');
  if (at < 1 || email.indexOf('@') !== at) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || !LOCAL.test(local) || !DOMAIN.test(domain)) return null;
  return email;
}

export function emailHash(email) {
  return sha256Hex(`rd-email-address-v1:${email}`);
}

export function maskEmail(email) {
  const at = String(email).lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

function fill(text, values) {
  return text.replace(PLACEHOLDER, (_, name) => (Object.hasOwn(values, name) ? String(values[name]) : ''));
}

// Stopka wypisania (#110): dodawana przez serwer, poza edycją autora treści,
// ale zależna wyłącznie od kategorii (część zatwierdzanego content_hash — ta
// sama kategoria zawsze daje tę samą stopkę, tylko link jest inny na rodzinę).
const UNSUBSCRIBE_FOOTER = '\n\n--\nAby zrezygnować z tej kategorii wiadomości, otwórz: {link_wypisania}';

function appendUnsubscribeFooter(text, unsubscribeUrl) {
  if (!unsubscribeUrl) return text;
  return text + UNSUBSCRIBE_FOOTER.replace('{link_wypisania}', unsubscribeUrl);
}

// Odnośnik do opublikowanej informacji o przetwarzaniu danych (D-06, #145):
// dodawany przez serwer na podstawie wersji zapamiętanej w kampanii przy
// zatwierdzeniu (email_campaigns.privacy_notice_id). Sam mechanizm — treść
// informacji pochodzi od zarządu, nie z kodu. Bez adresu (brak PUBLIC_BASE_URL)
// zostaje numer wersji.
function appendPrivacyNoticeFooter(text, privacyNotice) {
  if (!privacyNotice) return text;
  const where = privacyNotice.url ? `: ${privacyNotice.url}` : '';
  return `${text}\n\n--\nInformacja o przetwarzaniu danych osobowych (wersja ${privacyNotice.version})${where}`;
}

// Czy treść kampanii używa {komunikat} — wtedy każda rodzina potrzebuje aktywnej
// referencji roku (migawka wyklucza rodzinę bez niej, worker pomija wiersz).
export function usesStructuredReference(campaign) {
  return String(campaign?.body_text ?? campaign?.bodyText ?? '').includes('{komunikat}');
}

// Czy treść kampanii używa {rachunek} lub {odbiorca} (#92) — wtedy zatwierdzenie,
// kolejka i wysyłka wymagają zatwierdzonej wersji danych do wpłaty roku.
export function usesPaymentInstructions(campaign) {
  const body = String(campaign?.body_text ?? campaign?.bodyText ?? '');
  return PAYMENT_INSTRUCTION_PLACEHOLDERS.some((name) => body.includes(`{${name}}`));
}

// Jedna wiadomość = jedna rodzina. Czysty tekst (bez HTML), więc bez wstrzyknięć znaczników.
// structuredReference: 12 cyfr aktywnej referencji rodziny; wymagana, gdy treść
// ma {komunikat} — pusty komunikat w wiadomości do rodzica byłby błędem.
// paymentInstructions: { iban, payeeName } zatwierdzonej wersji roku (#92);
// wymagana, gdy treść ma {rachunek}/{odbiorca} — nigdy wiadomość z pustym
// albo niepoprawnym rachunkiem. Kod QR nie trafia do e-maila: wiadomość jest
// czystym tekstem, a HTML/obraz wymaga decyzji D-17.
// privacyNotice: { version, url } wersji informacji o przetwarzaniu danych (#145);
// stopka przed linkiem wypisania. null = bez stopki (tylko dla starych wywołań/testów).
// missingPaymentText: TYLKO podgląd dla zatwierdzającego — znacznik w miejscu
// {rachunek}/{odbiorca}, gdy rok nie ma zatwierdzonej wersji (zatwierdzenie i
// wysyłka takiej kampanii są wtedy zablokowane, więc znacznik nie trafi do rodzica).
export function renderMessage(campaign, {
  schoolYearLabel, householdId, structuredReference = null, paymentInstructions = null, unsubscribeUrl = null,
  missingPaymentText = null, privacyNotice = null,
}) {
  const values = { rok: schoolYearLabel, rodzina: householdId };
  if (usesStructuredReference(campaign)) {
    if (!isValidStructuredReference(structuredReference)) throw new ContentError('payment_reference_missing');
    values.komunikat = formatStructuredReference(structuredReference);
  }
  if (usesPaymentInstructions(campaign)) {
    const payeeName = String(paymentInstructions?.payeeName ?? '').trim();
    if (paymentInstructions && isValidIban(paymentInstructions.iban) && payeeName) {
      values.rachunek = formatIbanForDisplay(paymentInstructions.iban);
      values.odbiorca = payeeName;
    } else if (missingPaymentText) {
      values.rachunek = missingPaymentText;
      values.odbiorca = missingPaymentText;
    } else {
      throw new ContentError('payment_instructions_missing');
    }
  }
  const subject = fill(campaign.subject, values);
  const text = appendUnsubscribeFooter(
    appendPrivacyNoticeFooter(fill(campaign.body_text ?? campaign.bodyText, values), privacyNotice),
    unsubscribeUrl,
  );
  if (findForbiddenWording(subject) || findForbiddenWording(text)) throw new ContentError('forbidden_wording');
  return { subject, text };
}

// --- Preferencje kontaktu i wypisanie jednym kliknięciem (#110) -----------

const PREF_TOKEN_VERSION = 'rd-email-pref-v1';

// Token nieprzezroczysty: koduje (kampania, kategoria, skrót adresu) i jest
// podpisany HMAC-SHA256 sekretem serwera. URL nie zawiera adresu ani osobnych
// identyfikatorów w postaci jawnej — tylko ten jeden nieprzezroczysty parametr.
export function preferencesToken(secret, { campaignId, category, emailHash }) {
  const body = Buffer.from(JSON.stringify([PREF_TOKEN_VERSION, campaignId, category, emailHash])).toString('base64url');
  const signature = createHmac('sha256', String(secret)).update(body).digest('base64url');
  return `${body}.${signature}`;
}

// Zwraca { campaignId, category, emailHash } albo null (zły/zmieniony token —
// odmowa bez ujawniania, która część jest niepoprawna).
export function verifyPreferencesToken(secret, token) {
  if (typeof token !== 'string' || token.length > 2000) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  let expected;
  try {
    expected = createHmac('sha256', String(secret)).update(body).digest('base64url');
  } catch { return null; }
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const [version, campaignId, category, emailHash] = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (version !== PREF_TOKEN_VERSION || typeof campaignId !== 'string' || typeof emailHash !== 'string'
        || !CATEGORIES.includes(category) || !/^[0-9a-f]{64}$/.test(emailHash)) return null;
    return { campaignId, category, emailHash };
  } catch {
    return null;
  }
}

// Uwagi dla zatwierdzającego (nie blokują — treść szablonu zatwierdza Rada, D-16).
// Zawiadomienie do kont (0183) nie dotyczy składki — bez ostrzeżeń o wpłacie.
export function contentWarnings({ bodyText, audience = null }) {
  const warnings = [];
  if (isAccountAudience(audience)) return ['template_requires_board_decision_d16'];
  if (!SKIP_HINT.test(bodyText)) warnings.push('missing_skip_if_paid_sentence');
  if (!bodyText.includes('{rodzina}') && !bodyText.includes('{komunikat}')) warnings.push('missing_payment_reference');
  // #83: identyfikator rodziny (UUID, bez sumy kontrolnej) łatwo przepisać z błędem.
  if (bodyText.includes('{rodzina}')) warnings.push('household_id_as_payment_reference');
  warnings.push('template_requires_board_decision_d16');
  return warnings;
}
