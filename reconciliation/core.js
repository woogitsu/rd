// Logika czysta ekranu uzgodnienia wyciągu bankowego (issue #147, część 2 —
// src/pg/routes/reconciliation.js). Bez sieci, bez DOM.

import { MoneyError, formatEur, parseStatementAmount } from '../panel/money.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_BALANCE_CENTS = 10_000_000_000; // jak MAX_BALANCE_CENTS w src/pg/routes/reconciliation.js

// Rola z WRITE_ROLES w src/pg/routes/reconciliation.js — parzystość pilnowana
// w tests/reconciliation-panel-core.test.js.
export const WRITE_ROLES = Object.freeze(['admin', 'board', 'treasurer']);
export const REPORT_ROLES = Object.freeze(['audit', 'board', 'treasurer']);

export const STATUS_LABELS = Object.freeze({ draft: 'Szkic', confirmed: 'Potwierdzone', abandoned: 'Porzucony szkic' });

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

export function reconciliationUrl(id, cursor = null) {
  if (!isValidId(id)) throw new Error('Niepoprawny identyfikator uzgodnienia.');
  const base = `/api/reconciliations/${encodeURIComponent(id)}`;
  return cursor ? `${base}?cursor=${encodeURIComponent(cursor)}` : base;
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

// Przegląd demo 4: kolumna „Źródło” pokazywała surowy kod („csv”). Kody jak
// w CHECK bank_statement_imports.source (0089); nieznany kod zostaje bez zmian.
export const LINE_SOURCE_LABELS = Object.freeze({ manual: 'Ręcznie', csv: 'CSV', coda: 'CODA', camt053: 'CAMT.053' });

export function lineSourceLabel(source) {
  if (source === null || source === undefined || source === '') return '—';
  return Object.hasOwn(LINE_SOURCE_LABELS, source) ? LINE_SOURCE_LABELS[source] : String(source);
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

// --- import pliku wyciągu CODA / CAMT.053 (#105) ---------------------------------
// Plik jest czytany w przeglądarce i wysyłany jako pole `coda` albo `camt053` trasy
// POST /api/reconciliations/{id}/lines. Treść nie jest pokazywana ani zapisywana w
// przeglądarce (zawiera dane kontrahentów); serwer nie zapisuje pliku, tylko skróty.

// Limit żądania na serwerze to 256 KiB (MAX_IMPORT_BYTES); zapas na znaki ucieczki w JSON.
export const MAX_STATEMENT_FILE_BYTES = 200 * 1024;

export const STATEMENT_FORMAT_LABELS = Object.freeze({ coda: 'CODA', camt053: 'CAMT.053 (XML)' });

// Format po treści, nie po rozszerzeniu: XML zaczyna się od „<”, CODA od rekordu „0”
// (nagłówek, rekordy stałej długości 128 znaków). Niejednoznaczne = null (użytkownik wybiera).
export function detectStatementFormat(text) {
  const head = String(text ?? '').replace(/^\uFEFF/, '').trimStart();
  if (head.startsWith('<')) return 'camt053';
  const first = head.split(/\r?\n/, 1)[0] ?? '';
  if (/^0/.test(first) && first.length >= 120 && first.length <= 130 && /^[\x20-\x7E\u00A0-\u00FF]+$/.test(first)) return 'coda';
  return null;
}

// UTF-8 (także z BOM) albo, gdy bajty nie są poprawnym UTF-8, Windows-1252 (starsze CODA).
export function decodeStatementBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes).replace(/^\uFEFF/, ''), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
}

export function statementFileProblem(file) {
  if (!file) return 'Wybierz plik wyciągu.';
  if (file.size === 0) return 'Plik jest pusty.';
  if (file.size > MAX_STATEMENT_FILE_BYTES) return 'Plik wyciągu przekracza 200 KB. Wyeksportuj krótszy okres.';
  return '';
}

// Treść żądania; format podany ręcznie ma pierwszeństwo przed wykrytym.
export function buildStatementFileBody(text, format) {
  if (!Object.hasOwn(STATEMENT_FORMAT_LABELS, format)) throw new Error('Wybierz format pliku: CODA albo CAMT.053.');
  if (typeof text !== 'string' || !text.trim()) throw new Error('Plik jest pusty.');
  if (/\u0000/.test(text)) throw new Error('Plik zawiera znaki binarne. Wybierz plik tekstowy CODA albo XML CAMT.053.');
  return { [format]: text };
}

// Ostrzeżenia z odpowiedzi importu (kontrola ciągłości sald) — nic nie blokują.
export const IMPORT_WARNING_LABELS = Object.freeze({
  closing_balance_mismatch: 'Saldo początkowe plus ruchy nie daje salda końcowego z pliku.',
  opening_balance_discontinuity: 'Saldo początkowe nie zgadza się z saldem końcowym poprzedniego wyciągu w tym roku.',
  statement_date_differs: 'Data zamknięcia wyciągu w pliku różni się od daty uzgodnienia.',
  statement_balance_differs: 'Saldo końcowe z pliku różni się od salda wpisanego w uzgodnieniu.',
});

export function describeImportWarnings(warnings) {
  return (Array.isArray(warnings) ? warnings : []).map((code) => IMPORT_WARNING_LABELS[code] ?? 'Nieznane ostrzeżenie kontroli wyciągu.');
}

// Podsumowanie po imporcie: liczby oraz salda z pliku (kwoty w centach).
export function summarizeStatementImport(result) {
  const imported = Number(result?.import?.lineCount ?? result?.lineCount ?? 0);
  const skipped = Number(result?.skippedDuplicateCount ?? 0);
  const parts = [];
  parts.push(imported > 0 ? `Wgrano ${imported} pozycji.` : 'Nie wgrano nowych pozycji.');
  if (skipped > 0) parts.push(`Pominięto ${skipped} ruchów już zaimportowanych wcześniej.`);
  const balances = result?.fileBalances;
  if (balances && Number.isSafeInteger(balances.openingBalanceCents) && Number.isSafeInteger(balances.closingBalanceCents)) {
    parts.push(`Saldo z pliku: początkowe ${formatCents(balances.openingBalanceCents)}, końcowe ${formatCents(balances.closingBalanceCents)}.`);
  }
  return { text: parts.join(' '), warnings: describeImportWarnings(result?.warnings) };
}

// Komunikat błędu pliku: serwer zwraca numer rekordu, nigdy fragment treści.
export function describeStatementImportError(error) {
  const record = error?.data?.record;
  const base = error?.message || 'Nie udało się wgrać pliku wyciągu.';
  return Number.isInteger(record) && record > 0 ? `${base} (rekord ${record})` : base;
}
