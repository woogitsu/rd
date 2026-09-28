// Treść kampanii e-mail: walidacja, skróty do zatwierdzenia i renderowanie.
// Czyste funkcje bez sieci i bazy. Składka jest dobrowolna — słownik
// niedozwolonych sformułowań jest wspólny z kartkami (print/core.js).

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { findForbiddenWording } from '../../print/core.js';

export { findForbiddenWording };

export const AUDIENCES = Object.freeze(['all_households', 'no_payment_record']);
// Kategoria komunikatu (#110). `organizational` bez linku wypisania wymaga
// osobnej decyzji zarządu/szkoły (D-06) — do tego czasu każda kategoria ma link.
export const CATEGORIES = Object.freeze(['contribution_reminder', 'organizational']);
export const DEFAULT_CATEGORY = 'contribution_reminder';
// {rok} — etykieta roku szkolnego, {rodzina} — identyfikator rodziny jako tytuł przelewu.
// Brak placeholderów z imieniem dziecka lub opiekuna (minimalizacja, EMAIL.md).
export const BODY_PLACEHOLDERS = Object.freeze(['rok', 'rodzina']);
export const SUBJECT_PLACEHOLDERS = Object.freeze(['rok']);

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

function checkText(value, { min, max, field, allowNewlines, placeholders }) {
  if (typeof value !== 'string') throw new ContentError(`invalid_${field}`);
  const text = value.replace(/\r\n/g, '\n').trim();
  if (text.length < min || text.length > max) throw new ContentError(`invalid_${field}`);
  if (CONTROL.test(text) || (!allowNewlines && /\n/.test(text))) throw new ContentError(`invalid_${field}`);
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
export function parseCampaignContent(data) {
  if (!data || typeof data !== 'object') throw new ContentError('invalid_request');
  const title = checkText(data.title, { min: 3, max: 200, field: 'title', allowNewlines: false, placeholders: [] });
  const subject = checkText(data.subject, { min: 3, max: 200, field: 'subject', allowNewlines: false, placeholders: SUBJECT_PLACEHOLDERS });
  const bodyText = checkText(data.bodyText, { min: 20, max: 10000, field: 'body', allowNewlines: true, placeholders: BODY_PLACEHOLDERS });
  if (!AUDIENCES.includes(data.audience)) throw new ContentError('invalid_audience');
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
export function recipientsHash(rows) {
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

// Jedna wiadomość = jedna rodzina. Czysty tekst (bez HTML), więc bez wstrzyknięć znaczników.
export function renderMessage(campaign, { schoolYearLabel, householdId, unsubscribeUrl = null }) {
  const values = { rok: schoolYearLabel, rodzina: householdId };
  const subject = fill(campaign.subject, values);
  const text = appendUnsubscribeFooter(fill(campaign.body_text ?? campaign.bodyText, values), unsubscribeUrl);
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
export function contentWarnings({ bodyText }) {
  const warnings = [];
  if (!SKIP_HINT.test(bodyText)) warnings.push('missing_skip_if_paid_sentence');
  if (!bodyText.includes('{rodzina}')) warnings.push('missing_payment_reference');
  warnings.push('template_requires_board_decision_d16');
  return warnings;
}
