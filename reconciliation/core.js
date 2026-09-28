// Logika czysta ekranu uzgodnienia wyciągu bankowego (issue #147, część 2 —
// src/pg/routes/reconciliation.js). Bez sieci, bez DOM.

import { MoneyError, formatEur, parseStatementAmount } from '../panel/money.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_BALANCE_CENTS = 10_000_000_000; // jak MAX_BALANCE_CENTS w src/pg/routes/reconciliation.js

// Rola z WRITE_ROLES w src/pg/routes/reconciliation.js — parzystość pilnowana
// w tests/reconciliation-panel-core.test.js.
export const WRITE_ROLES = Object.freeze(['admin', 'board', 'treasurer']);
export const REPORT_ROLES = Object.freeze(['audit', 'board', 'treasurer']);

export const STATUS_LABELS = Object.freeze({ draft: 'Szkic', confirmed: 'Potwierdzone' });

// Powody z inconsistentMatches (src/pg/routes/reconciliation.js).
export const INCONSISTENCY_LABELS = Object.freeze({
  amount_mismatch: 'kwota dopasowania nie zgadza się z bieżącym wpisem',
  double_counted: 'wpłata policzona dwukrotnie (przez wpis księgi i przez wpłatę)',
});

export function isValidId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value.trim());
}

function hasRoleAccess(grants, roles, schoolYearId = '') {
  return (Array.isArray(grants) ? grants : []).some((grant) => roles.includes(grant?.role)
    && !grant.classId
    && (!schoolYearId || !grant.schoolYearId || grant.schoolYearId === String(schoolYearId).trim()));
}

export function hasWriteAccess(grants, schoolYearId = '') {
  return hasRoleAccess(grants, WRITE_ROLES, schoolYearId);
}

export function buildReconciliationsUrl(schoolYearId) {
  if (!isValidId(schoolYearId)) throw new Error('Podaj poprawny identyfikator roku szkolnego.');
  return `/api/reconciliations?schoolYearId=${encodeURIComponent(schoolYearId.trim())}`;
}

export function reconciliationUrl(id) {
  if (!isValidId(id)) throw new Error('Niepoprawny identyfikator uzgodnienia.');
  return `/api/reconciliations/${encodeURIComponent(id)}`;
}

export function reconciliationActionUrl(id, action) {
  return `${reconciliationUrl(id)}/${action}`;
}

export function auditReportUrl(schoolYearId, format = 'html') {
  if (!isValidId(schoolYearId)) throw new Error('Podaj poprawny identyfikator roku szkolnego.');
  return `/api/reports/audit?schoolYearId=${encodeURIComponent(schoolYearId.trim())}&format=${format}`;
}

// Saldo wyciągu: kwota ze znakiem (nadpłata/debet), większy zakres niż zwykłe
// kwoty wpłat (MAX_BALANCE_CENTS w src/pg/routes/reconciliation.js).
export function parseStatementBalance(value) {
  try {
    return parseStatementAmount(value, { max: MAX_BALANCE_CENTS });
  } catch (error) {
    if (error instanceof MoneyError && error.code === 'amount_out_of_range') {
      throw new Error('Saldo jest poza dopuszczalnym zakresem.');
    }
    throw new Error('Podaj saldo z maksymalnie dwoma miejscami po przecinku, np. 1234,56 albo -50,00.');
  }
}

export function formatCents(value) {
  return formatEur(value, { style: 'screen' });
}

export function makeIdempotencyKey(prefix, randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto)) {
  if (typeof randomUUID !== 'function') throw new Error('Ta przeglądarka nie obsługuje bezpiecznych identyfikatorów operacji.');
  return `${prefix}-${randomUUID()}`;
}

// Zasada czterech oczu (bank_reconciliation_four_eyes): zatwierdza inna osoba
// niż autor uzgodnienia. Serwer i tak to sprawdza — to tylko widoczność przycisku.
export function isLikelyOwnReconciliation(reconciliation, actorId) {
  return Boolean(reconciliation && actorId && reconciliation.createdBy === actorId);
}

export function canOfferConfirm(reconciliation, actorId) {
  return Boolean(reconciliation) && reconciliation.status === 'draft' && !isLikelyOwnReconciliation(reconciliation, actorId);
}

// Uzgodnienie z różnicą ≠ 0 wymaga wyjaśnienia (difference_requires_note).
export function requiresConfirmationNote(reconciliation) {
  return Boolean(reconciliation) && Number(reconciliation.differenceCents) !== 0;
}

export function formatDifference(cents) {
  if (cents === 0) return 'Bilans zgadza się (różnica 0,00 €).';
  return `Różnica: ${formatCents(cents)}.`;
}

// Etykieta pozycji CSV/ręcznej — kwota dodatnia to wpływ, ujemna to obciążenie.
export function lineDirectionLabel(amountCents) {
  return Number(amountCents) >= 0 ? 'Wpływ' : 'Obciążenie';
}

export function candidateLabel(candidate) {
  const type = candidate.type === 'ledger_entry' ? 'Wpis księgi' : 'Wpłata';
  const parts = [type, candidate.date, formatCents(candidate.amountCents)];
  if (candidate.referenceMatch) parts.push('tytuł zgodny');
  if (candidate.dayDistance === 0) parts.push('ta sama data');
  else parts.push(`${candidate.dayDistance} dni różnicy`);
  return parts.join(' · ');
}

export function summarizeInconsistencies(list) {
  return (Array.isArray(list) ? list : []).map((item) => ({
    ...item,
    reasonsText: item.reasons.map((code) => INCONSISTENCY_LABELS[code] ?? code).join(', '),
  }));
}

export function describeApiError(status, code) {
  if (status === 401 || code === 'unauthenticated') return 'Sesja wygasła. Zaloguj się ponownie.';
  if (code === 'mfa_required') return 'Potwierdź logowanie drugim składnikiem (MFA), aby korzystać z uzgodnień.';
  if (code === 'four_eyes_required') return 'Potwierdzić musi inna osoba niż ta, która utworzyła uzgodnienie.';
  if (status === 403 || code === 'forbidden') return 'Nie masz uprawnień do uzgodnień w wybranym roku szkolnym.';
  return null;
}
