// Treść kampanii e-mail: walidacja, skróty do zatwierdzenia i renderowanie.
// Czyste funkcje bez sieci i bazy. Składka jest dobrowolna — słownik
// niedozwolonych sformułowań jest wspólny z kartkami (print/core.js).

import { createHash } from 'node:crypto';
import { findForbiddenWording } from '../../print/core.js';

export { findForbiddenWording };

export const AUDIENCES = Object.freeze(['all_households', 'no_payment_record']);
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
  return { title, subject, bodyText, audience: data.audience };
}

// Skrót dokładnej treści, którą zatwierdza zarząd. Tytuł wewnętrzny nie trafia
// do rodziców, więc nie wchodzi do skrótu.
export function contentHash({ schoolYearId, audience, subject, bodyText }) {
  return sha256Hex(JSON.stringify(['rd-email-content-v1', schoolYearId, audience, subject, bodyText]));
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

// Jedna wiadomość = jedna rodzina. Czysty tekst (bez HTML), więc bez wstrzyknięć znaczników.
export function renderMessage(campaign, { schoolYearLabel, householdId }) {
  const values = { rok: schoolYearLabel, rodzina: householdId };
  const subject = fill(campaign.subject, values);
  const text = fill(campaign.body_text ?? campaign.bodyText, values);
  if (findForbiddenWording(subject) || findForbiddenWording(text)) throw new ContentError('forbidden_wording');
  return { subject, text };
}

// Uwagi dla zatwierdzającego (nie blokują — treść szablonu zatwierdza Rada, D-16).
export function contentWarnings({ bodyText }) {
  const warnings = [];
  if (!SKIP_HINT.test(bodyText)) warnings.push('missing_skip_if_paid_sentence');
  if (!bodyText.includes('{rodzina}')) warnings.push('missing_payment_reference');
  warnings.push('template_requires_board_decision_d16');
  return warnings;
}
