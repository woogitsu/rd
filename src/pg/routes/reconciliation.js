// Uzgodnienie rachunku bankowego z księgą i raport dla Komisji Rewizyjnej
// (issue #7, przygotowanie #15). Prototyp — nie jest wdrożony.
//
//   GET  /api/reconciliations?schoolYearId=…
//   POST /api/reconciliations                                 (Idempotency-Key)
//   GET  /api/reconciliations/{id}
//   POST /api/reconciliations/{id}/lines                      (Idempotency-Key) JSON lines, CSV, CODA albo CAMT.053
//   POST /api/reconciliations/{id}/lines/{lineId}/payment      (Idempotency-Key) wpłata + powiązanie naraz (#115)
//   GET  /api/reconciliations/{id}/suggestions?windowDays=…   tylko propozycje, nigdy zatwierdzenie
//   POST /api/reconciliations/{id}/matches                    (Idempotency-Key)
//   POST /api/reconciliations/{id}/matches/batch              (Idempotency-Key) jawna lista par, wszystko albo nic (#115)
//   POST /api/reconciliations/{id}/matches/{matchId}/revocation
//   POST /api/reconciliations/{id}/group-matches              (Idempotency-Key) przelew zbiorczy (#127)
//   POST /api/reconciliations/{id}/group-matches/{groupId}/revocation
//   POST /api/reconciliations/{id}/confirm                    zasada czterech oczu
//   POST /api/reconciliations/{id}/abandon                    porzucenie szkicu bez aktywnych powiązań (0107)
//   GET  /api/reports/audit?schoolYearId=…&format=json|html|xlsx   (xlsx: #141, arkusz na sekcję)
//
// Uzgodnienia: admin, board, treasurer z MFA w zakresie roku. Raport: audit,
// board, treasurer z MFA. Saldo księgi wylicza baza (0015_reconciliation.sql);
// klient podaje wyłącznie saldo z wyciągu. Treść tytułu przelewu nie jest
// zapisywana — tylko solony skrót SHA-256 (docs/RECONCILIATION.md).

import { isSameOrigin } from '../../auth.js';
import { isoTimestamp } from '../auth.js';
import { isAuthorizedScoped, loadAuthorizationContext, mfaAwareForbiddenCode } from '../authorization.js';
import { insertAuditEvent } from '../audit.js';
import { gateFreeText, piiAuditMetadata } from '../pii-gate.js';
import { toSafeInteger } from './payments.js';
import { MoneyError, parseStatementAmount } from '../../../panel/money.js';
import { detectDelimiter, parseCsvMatrix } from '../../../import/csv.js';
import { reportContentSecurityPolicy, renderAuditReportHtml } from '../audit-report.js';
import { auditReportContentSha256, buildAuditReportXlsx } from '../audit-report-xlsx.js';
import { xlsxResponse } from '../xlsx.js';
import { safeFileSegment } from '../csv.js';
import { archiveReadVia, recordArchiveRead } from '../archive-access.js';
import { buildBudgetExecution } from './ledger-budget.js';
import { costCenterReport } from './ledger-cost-centers.js';
import { readSnapshot } from '../db-snapshot.js';
import { StatementFileError, normalizeIban } from '../bank/common.js';
import { parseCoda } from '../bank/coda.js';
import { parseCamt053 } from '../bank/camt053.js';
import { createIdempotencyKeyReader, createJsonReader, isUniqueError } from '../input.js';

export const name = 'reconciliation';

const WRITE_ROLES = ['admin', 'board', 'treasurer'];
const REPORT_ROLES = ['audit', 'board', 'treasurer'];
// Raport zamkniętego roku (#195, tylko odczyt): zarząd/skarbnik roku następnego i admin.
const ARCHIVE_REPORT_ROLES = ['board', 'treasurer'];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_IMPORT_BYTES = 256 * 1024;
const MAX_LINES = 500;
const MAX_LINE_CENTS = 100_000_000;
const MAX_BALANCE_CENTS = 10_000_000_000;
const MAX_REFERENCE_LENGTH = 300;
const LARGE_EXPENSE_CENTS = 300_000;
const MAX_CANDIDATES = 5;
// Dopasowanie zbiorcze (#127, cz. 2): jedna pozycja wyciągu ↔ 2…50 wpłat/wpisów.
const MIN_GROUP_ITEMS = 2;
const MAX_GROUP_ITEMS = 50;
const MAX_BATCH_MATCHES = 50;

// #152: błąd 422 bramki pól wolnego tekstu (src/pg/pii-gate.js).
function piiFail(code, categories) {
  return new RequestError(code, 422, { categories });
}

class RequestError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

const REPLAYED = { 'Idempotency-Replayed': 'true' };
const CREATED = { 'Idempotency-Replayed': 'false' };

// --- walidacja -------------------------------------------------------------

function validId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function decodeId(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (!validId(decoded)) throw new Error();
    return decoded;
  } catch {
    throw new RequestError('invalid_id');
  }
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function optionalText(value, min, max, code = 'invalid_request') {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new RequestError(code);
  const text = value.trim();
  if (text.length < min || text.length > max) throw new RequestError(code);
  return text;
}

const readJson = createJsonReader({
  maxBytes: MAX_BODY_BYTES,
  declaredLength: true,
  error: (code, status) => new RequestError(code, status),
});

const readIdempotencyKey = createIdempotencyKeyReader({ error: (code, status) => new RequestError(code, status) });

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Normalizacja tytułu przelewu przed skrótem: NFKC, małe litery, jedna spacja.
export function normalizeReference(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new RequestError('invalid_reference_text');
  const text = value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length > MAX_REFERENCE_LENGTH) throw new RequestError('invalid_reference_text');
  return text;
}

export async function hashReference(salt, value) {
  const normalized = normalizeReference(value);
  return normalized ? sha256Hex(`${salt}:${normalized}`) : null;
}

// --- import wyciągu (ogólny CSV: data, kwota, tytuł) -----------------------

const HEADER_ALIASES = new Map([
  ['date', 'date'], ['data', 'date'], ['booking_date', 'date'], ['data_operacji', 'date'],
  ['amount', 'amount'], ['kwota', 'amount'],
  ['reference', 'reference'], ['tytul', 'reference'], ['tytuł', 'reference'], ['opis', 'reference'],
  ['description', 'reference'], ['communication', 'reference'],
]);

// #77: wspólny parser RFC 4180 (import/csv.js) — separator ; , albo tabulator liczony poza
// cudzysłowami w pierwszej linii. Remis nie jest zgadywany po cichu: błąd zamiast domyślnego przecinka.
function parseCsvRows(text) {
  if (text.includes('\uFFFD') || text.includes('\u0000')) throw new RequestError('invalid_csv_encoding');
  const detected = detectDelimiter(text);
  if (detected.tie) throw new RequestError('ambiguous_csv_delimiter');
  try {
    return parseCsvMatrix(text, { delimiter: detected.delimiter });
  } catch {
    // Komunikat parsera zawiera tylko pozycję znaku, ale kod błędu API pozostaje ogólny.
    throw new RequestError('invalid_csv');
  }
}

function parseCsvDate(value) {
  const text = value.trim();
  if (validDate(text)) return text;
  const match = text.match(/^(\d{2})[./-](\d{2})[./-](\d{4})$/);
  if (match) {
    const iso = `${match[3]}-${match[2]}-${match[1]}`;
    if (validDate(iso)) return iso;
  }
  return null;
}

// #173: jeden moduł kwot (panel/money.js) — akceptuje też „1 234,56”, „1.234,56”
// (zapis belgijski) i „12,50 €”; komunikat rozróżnia format od limitu kwoty.
function parseCsvAmount(value) {
  try {
    const cents = parseStatementAmount(value, { max: MAX_LINE_CENTS });
    if (cents === 0) return { error: 'invalid_statement_line' };
    return { cents };
  } catch (error) {
    if (error instanceof MoneyError) {
      return { error: error.code === 'amount_out_of_range' ? 'statement_amount_out_of_range' : 'invalid_statement_line' };
    }
    throw error;
  }
}

export function parseStatementCsv(text) {
  if (typeof text !== 'string' || !text.trim()) throw new RequestError('invalid_csv');
  const rows = parseCsvRows(text);
  const header = (rows.shift() ?? []).map((cell) => HEADER_ALIASES.get(cell.trim().toLowerCase()) ?? null);
  const column = (key) => header.indexOf(key);
  if (column('date') < 0 || column('amount') < 0) throw new RequestError('invalid_csv_header');
  return rows.map((cells, index) => {
    const bookedOn = parseCsvDate(cells[column('date')] ?? '');
    const amount = parseCsvAmount(cells[column('amount')] ?? '');
    if (!bookedOn || amount.error) {
      throw new RequestError(amount?.error ?? 'invalid_statement_line', 400, { line: index + 1 });
    }
    return { bookedOn, amountCents: amount.cents, reference: column('reference') >= 0 ? cells[column('reference')] ?? null : null };
  });
}

const FILE_PARSERS = { coda: parseCoda, camt053: parseCamt053 };
const MIN_HASH_KEY_LENGTH = 32;

function parseStatementLines(data) {
  const kinds = ['lines', 'csv', 'coda', 'camt053'].filter((kind) => data[kind] !== undefined);
  if (kinds.length !== 1) throw new RequestError('invalid_request');
  const [kind] = kinds;
  if (FILE_PARSERS[kind]) return parseStatementFile(kind, data[kind]);
  const source = kind === 'csv' ? 'csv' : 'manual';
  let lines;
  if (kind === 'csv') {
    lines = parseStatementCsv(data.csv);
  } else {
    if (!Array.isArray(data.lines)) throw new RequestError('invalid_request');
    lines = data.lines;
  }
  if (!lines.length || lines.length > MAX_LINES) throw new RequestError('invalid_line_count');
  return {
    source,
    lines: lines.map((line, index) => {
      if (!line || typeof line !== 'object' || !validDate(line.bookedOn)
          || !Number.isSafeInteger(line.amountCents) || line.amountCents === 0
          || Math.abs(line.amountCents) > MAX_LINE_CENTS) {
        throw new RequestError('invalid_statement_line', 400, { line: index + 1 });
      }
      try {
        return { bookedOn: line.bookedOn, amountCents: line.amountCents, reference: normalizeReference(line.reference) };
      } catch {
        throw new RequestError('invalid_statement_line', 400, { line: index + 1 });
      }
    }),
  };
}

// CODA / CAMT.053 (#105). Błąd pliku zwraca numer rekordu, nigdy fragment treści.
function parseStatementFile(source, text) {
  if (typeof text !== 'string' || !text.trim()) throw new RequestError('invalid_statement_file');
  const content = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let statement;
  try {
    statement = FILE_PARSERS[source](content);
  } catch (error) {
    if (error instanceof StatementFileError) {
      throw new RequestError(error.code, 400, error.record ? { record: error.record } : {});
    }
    throw error;
  }
  if (statement.movements.length > MAX_LINES) throw new RequestError('invalid_line_count');
  return {
    source,
    content,
    statement,
    lines: statement.movements.map((movement) => ({
      record: movement.record,
      bookedOn: movement.bookedOn,
      amountCents: movement.amountCents,
      transactionId: movement.transactionId,
      // Tytuł trafia wyłącznie do solonego skrótu; zbyt długi jest przycinany.
      reference: movement.reference
        ? normalizeReference(movement.reference.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, MAX_REFERENCE_LENGTH))
        : null,
    })),
  };
}

// Klucz HMAC skrótów transakcji i plików oraz zatwierdzony rachunek Rady (D-13)
// pochodzą z konfiguracji serwera. Bez nich import z pliku jest wyłączony.
function bankImportConfig(env) {
  const key = typeof env.BANK_TRANSACTION_HASH_KEY === 'string' ? env.BANK_TRANSACTION_HASH_KEY : '';
  const iban = normalizeIban(typeof env.RECONCILIATION_BANK_ACCOUNT_IBAN === 'string' ? env.RECONCILIATION_BANK_ACCOUNT_IBAN : '');
  if (key.length < MIN_HASH_KEY_LENGTH || !iban) throw new RequestError('bank_import_not_configured', 503);
  return { key, iban };
}

async function hmacHex(key, text) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(text));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// --- mapowanie wierszy -------------------------------------------------------

const RECONCILIATION_COLUMNS = `r.id, r.school_year_id, to_char(r.statement_date, 'YYYY-MM-DD') AS statement_date,
  r.statement_balance_cents,
  CASE WHEN r.status = 'draft' THEN ledger_balance_at(r.school_year_id, r.statement_date)
       ELSE r.ledger_balance_cents END AS ledger_balance_cents,
  CASE WHEN r.status = 'draft' THEN ledger_non_bank_net_at(r.school_year_id, r.statement_date)
       ELSE r.ledger_non_bank_cents END AS ledger_non_bank_cents,
  r.status, r.notes, r.reference_salt, r.created_by, r.created_at, r.confirmed_by, r.confirmed_at,
  r.confirmation_note, r.abandoned_by, r.abandoned_at, r.abandon_reason`;

function reconciliationFromRow(row) {
  const statementBalanceCents = toSafeInteger(row.statement_balance_cents);
  const ledgerBalanceCents = toSafeInteger(row.ledger_balance_cents);
  return {
    id: row.id,
    schoolYearId: row.school_year_id,
    statementDate: row.statement_date,
    statementBalanceCents,
    ledgerBalanceCents,
    ledgerNonBankCents: toSafeInteger(row.ledger_non_bank_cents),
    differenceCents: statementBalanceCents - ledgerBalanceCents,
    status: row.status,
    notes: row.notes ?? null,
    createdBy: row.created_by,
    createdAt: isoTimestamp(row.created_at),
    confirmedBy: row.confirmed_by ?? null,
    confirmedAt: isoTimestamp(row.confirmed_at),
    confirmationNote: row.confirmation_note ?? null,
    abandonedBy: row.abandoned_by ?? null,
    abandonedAt: isoTimestamp(row.abandoned_at),
    abandonReason: row.abandon_reason ?? null,
  };
}

// Zapis do uzgodnienia, które nie jest szkicem: zatwierdzone albo porzucone (0107).
function notDraftError(row) {
  return row.status === 'abandoned'
    ? new RequestError('reconciliation_abandoned', 409)
    : new RequestError('reconciliation_confirmed', 409);
}

function matchFromRow(row) {
  return {
    id: row.id,
    reconciliationId: row.reconciliation_id,
    statementLineId: row.statement_line_id,
    ledgerEntryId: row.ledger_entry_id ?? null,
    paymentEntryId: row.payment_entry_id ?? null,
    // Cel „zwrot” (0152, #138): pole tylko dla takich powiązań, kontrakt pozostałych bez zmian.
    ...(row.payment_refund_id ? { paymentRefundId: row.payment_refund_id } : {}),
    createdBy: row.created_by,
    createdAt: isoTimestamp(row.created_at),
    revokedAt: isoTimestamp(row.revoked_at),
    revokedBy: row.revoked_by ?? null,
    revokeReason: row.revoke_reason ?? null,
  };
}

async function loadReconciliation(executor, id, { lock = false } = {}) {
  if (lock) {
    // Najpierw blokada samego wiersza, potem odczyt z wyliczonym saldem.
    await executor.query('SELECT id FROM bank_reconciliations WHERE id = $1 FOR UPDATE', [id]);
  }
  const { rows } = await executor.query(
    `SELECT ${RECONCILIATION_COLUMNS}, r.idempotency_key FROM bank_reconciliations r WHERE r.id = $1`, [id],
  );
  return rows[0] ?? null;
}

// --- dostęp ----------------------------------------------------------------

// Uzgodnienie wyciągu dotyczy wpłat całego roku: przydział z class_id nie daje dostępu.
async function requireContext(request, env, roles, schoolYearId) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) throw new RequestError('unauthenticated', 401);
  if (!isAuthorizedScoped(context, { roles, schoolYearId, requireMfa: true })) throw new RequestError('forbidden', 403);
  return context;
}

function requireYear(context, roles, schoolYearId) {
  if (!isAuthorizedScoped(context, { roles, schoolYearId, requireMfa: true })) throw new RequestError('forbidden', 403);
}

function mapDatabaseError(error) {
  if (error instanceof RequestError) throw error;
  const message = String(error?.message ?? '');
  // Rok zamknięty (0017_year_close.sql, trigger a0_year_freeze, rozszerzony
  // w #80 na uzgodnienia rachunku) — stan, nie awaria bazy (#156).
  if (message.includes('school_year_closed')) throw new RequestError('school_year_closed', 409);
  if (message.includes('bank_reconciliation_confirmed_immutable')) throw new RequestError('reconciliation_confirmed', 409);
  if (message.includes('bank_reconciliation_abandoned')) throw new RequestError('reconciliation_abandoned', 409);
  if (message.includes('bank_reconciliation_has_active_matches')) throw new RequestError('reconciliation_has_active_matches', 409);
  // Równoległy import tego samego pliku/ruchu (0107) — API sprawdza to samo pod blokadą doradczą.
  if (message.includes('bank_statement_file_already_imported')
      || message.includes('bank_statement_transaction_already_imported')) {
    throw new RequestError('statement_already_imported', 409);
  }
  if (message.includes('bank_reconciliation_date_outside_year')) throw new RequestError('statement_date_outside_school_year');
  if (message.includes('bank_statement_line_after_statement_date')) throw new RequestError('statement_line_after_statement_date');
  // #169: wpłata tworzona z pozycji wyciągu dostaje datę księgowania pozycji.
  // Pozycja sprzed starts_on (np. 31.08 na pierwszym wyciągu roku) jest
  // dopuszczalna w wyciągu, ale wpłata z tą datą — nie (trigger 0027, ta sama
  // reguła i ten sam kod co POST /api/payments). Bez tej linii odmowa
  // spadała do app.js jako ogólne 409 business_rule_violation.
  if (message.includes('date_outside_school_year')) throw new RequestError('date_outside_school_year', 422);
  if (message.includes('bank_match_amount_mismatch')) throw new RequestError('match_amount_mismatch', 409);
  // Wpłata i wpis księgi, który ją ujmuje, to te same pieniądze (#162, 0024).
  if (message.includes('bank_match_already_matched_via_ledger')) throw new RequestError('already_matched_via_ledger', 409);
  if (message.includes('bank_match_already_matched_via_payment')) throw new RequestError('already_matched_via_payment', 409);
  if (message.includes('bank_match_method_mismatch')) throw new RequestError('match_method_mismatch', 409);
  if (message.includes('bank_match_target_mismatch')) throw new RequestError('invalid_match_target');
  if (message.includes('bank_match_line_mismatch')) throw new RequestError('invalid_statement_line');
  // Dopasowanie zbiorcze (0105): pozycja/cel zajęte przez inne dopasowanie, suma ≠ kwota pozycji.
  if (message.includes('bank_group_match_line_taken') || message.includes('bank_group_match_target_taken')) {
    throw new RequestError('already_matched', 409);
  }
  if (message.includes('bank_group_match_sum_mismatch')) throw new RequestError('group_match_sum_mismatch', 409);
  if (message.includes('bank_group_match_too_few_items')) throw new RequestError('invalid_request');
  if (message.includes('bank_group_match_direction_mismatch')) throw new RequestError('group_match_direction_mismatch', 409);
  // #105/#127: cel aktywnie dopasowany w innym uzgodnieniu tego roku (0089 dla 1:1, 0105 dla zbiorczych).
  if (message.includes('bank_match_in_other_reconciliation')) throw new RequestError('matched_in_other_reconciliation', 409);
  if (message.includes('bank_match_already_revoked')) throw new RequestError('match_already_revoked', 409);
  if (message.includes('bank_reconciliation_four_eyes')) throw new RequestError('four_eyes_required', 403);
  if (error?.code === '23503') throw new RequestError('invalid_reference');
  throw error;
}

// --- uzgodnienia -----------------------------------------------------------

async function listReconciliations(request, env, url, json) {
  const schoolYearId = url.searchParams.get('schoolYearId');
  if (!validId(schoolYearId)) throw new RequestError('invalid_request');
  await requireContext(request, env, WRITE_ROLES, schoolYearId);
  const { rows } = await env.db.query(
    `SELECT ${RECONCILIATION_COLUMNS} FROM bank_reconciliations r
      WHERE r.school_year_id = $1 ORDER BY r.statement_date DESC, r.created_at DESC, r.id`,
    [schoolYearId],
  );
  return json({ reconciliations: rows.map(reconciliationFromRow) });
}

async function createReconciliation(request, env, json) {
  const idempotencyKey = readIdempotencyKey(request);
  const data = await readJson(request);
  if (!validId(data.schoolYearId) || !validDate(data.statementDate)
      || !Number.isSafeInteger(data.statementBalanceCents)
      || Math.abs(data.statementBalanceCents) > MAX_BALANCE_CENTS) {
    throw new RequestError('invalid_request');
  }
  const input = {
    schoolYearId: data.schoolYearId,
    statementDate: data.statementDate,
    statementBalanceCents: data.statementBalanceCents,
    notes: optionalText(data.notes, 3, 1000, 'invalid_notes'),
  };
  const context = await requireContext(request, env, WRITE_ROLES, input.schoolYearId);
  const actorId = context.session.user.id;

  const replayOrConflict = (row) => {
    if (!row) return null;
    const same = row.created_by === actorId && row.school_year_id === input.schoolYearId
      && row.statement_date === input.statementDate
      && toSafeInteger(row.statement_balance_cents) === input.statementBalanceCents
      && (row.notes ?? null) === input.notes;
    if (!same) throw new RequestError('idempotency_conflict', 409);
    return json({ reconciliation: reconciliationFromRow(row) }, 200, REPLAYED);
  };
  const byKey = async (executor) => (await executor.query(
    `SELECT ${RECONCILIATION_COLUMNS} FROM bank_reconciliations r WHERE r.idempotency_key = $1`, [idempotencyKey],
  )).rows[0] ?? null;

  try {
    const response = await env.db.transaction(async (tx) => {
      const replay = replayOrConflict(await byKey(tx));
      if (replay) return replay;
      const gate = gateFreeText([['bank_reconciliations.notes', input.notes]], { confirm: data.confirmPersonalData === true, fail: piiFail });
      const id = crypto.randomUUID();
      await tx.query(
        `INSERT INTO bank_reconciliations (id, school_year_id, statement_date, statement_balance_cents,
           ledger_balance_cents, ledger_non_bank_cents, notes, reference_salt, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, 0, 0, $5, $6, $7, $8)`,
        [id, input.schoolYearId, input.statementDate, input.statementBalanceCents, input.notes, randomHex(16),
          actorId, idempotencyKey],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'reconciliation.created', entityType: 'bank_reconciliation', entityId: id,
        metadata: { schoolYearId: input.schoolYearId, ...piiAuditMetadata(gate) },
      });
      const row = await loadReconciliation(tx, id);
      return json({ reconciliation: reconciliationFromRow(row) }, 201, CREATED);
    });
    return response;
  } catch (error) {
    if (isUniqueError(error)) {
      const replay = replayOrConflict(await byKey(env.db));
      if (replay) return replay;
      throw new RequestError('idempotency_conflict', 409);
    }
    mapDatabaseError(error);
  }
}

// Aktywne powiązania o kwocie różnej od dzisiejszego netto celu albo liczące tę samą wpłatę dwa razy.
async function inconsistentMatches(executor, id) {
  const { rows } = await executor.query(
    `SELECT match_id, statement_line_id, ledger_entry_id, payment_entry_id, payment_refund_id, line_amount_cents, target_net_cents,
            amount_matches, double_counted
       FROM bank_match_consistency
      WHERE reconciliation_id = $1 AND (NOT amount_matches OR double_counted)
      ORDER BY statement_line_id, match_id`,
    [id],
  );
  return rows.map((row) => ({
    matchId: row.match_id,
    statementLineId: row.statement_line_id,
    ledgerEntryId: row.ledger_entry_id ?? null,
    paymentEntryId: row.payment_entry_id ?? null,
    ...(row.payment_refund_id ? { paymentRefundId: row.payment_refund_id } : {}),
    lineAmountCents: toSafeInteger(row.line_amount_cents),
    targetNetCents: row.target_net_cents === null ? null : toSafeInteger(row.target_net_cents),
    reasons: [...(row.amount_matches ? [] : ['amount_mismatch']), ...(row.double_counted ? ['double_counted'] : [])],
  }));
}

// Aktywne dopasowania zbiorcze (0105), w których suma dzisiejszego netto celów
// różni się od kwoty pozycji albo któryś cel zmienił netto od dopasowania.
async function inconsistentGroupMatches(executor, id) {
  const { rows } = await executor.query(
    `SELECT group_match_id, statement_line_id, line_amount_cents, matched_total_cents, target_net_cents, items_unchanged
       FROM bank_group_match_consistency
      WHERE reconciliation_id = $1 AND (target_net_cents <> line_amount_cents OR NOT items_unchanged)
      ORDER BY statement_line_id, group_match_id`,
    [id],
  );
  return rows.map((row) => ({
    groupMatchId: row.group_match_id,
    statementLineId: row.statement_line_id,
    lineAmountCents: toSafeInteger(row.line_amount_cents),
    matchedTotalCents: toSafeInteger(row.matched_total_cents),
    targetNetCents: toSafeInteger(row.target_net_cents),
    reasons: [
      ...(toSafeInteger(row.target_net_cents) !== toSafeInteger(row.line_amount_cents) ? ['amount_mismatch'] : []),
      ...(row.items_unchanged ? [] : ['target_changed']),
    ],
  }));
}

async function loadGroupMatches(executor, reconciliationId, groupId = null) {
  const values = [reconciliationId];
  let filter = '';
  if (groupId) { values.push(groupId); filter = ' AND g.id = $2'; }
  const { rows } = await executor.query(
    `SELECT g.id, g.reconciliation_id, g.statement_line_id, g.created_by, g.created_at, g.idempotency_key,
            v.created_at AS revoked_at, v.created_by AS revoked_by, v.reason AS revoke_reason
       FROM bank_reconciliation_group_matches g
       LEFT JOIN bank_reconciliation_group_match_revocations v ON v.group_match_id = g.id
      WHERE g.reconciliation_id = $1${filter}
      ORDER BY g.created_at, g.id`,
    values,
  );
  if (!rows.length) return [];
  const items = await executor.query(
    `SELECT id, group_match_id, ledger_entry_id, payment_entry_id, amount_cents
       FROM bank_reconciliation_group_match_items WHERE group_match_id = ANY($1::text[])
      ORDER BY group_match_id, id`,
    [rows.map((row) => row.id)],
  );
  const byGroup = new Map(rows.map((row) => [row.id, []]));
  for (const item of items.rows) {
    byGroup.get(item.group_match_id)?.push({
      id: item.id,
      ledgerEntryId: item.ledger_entry_id ?? null,
      paymentEntryId: item.payment_entry_id ?? null,
      amountCents: toSafeInteger(item.amount_cents),
    });
  }
  return rows.map((row) => ({
    id: row.id,
    reconciliationId: row.reconciliation_id,
    statementLineId: row.statement_line_id,
    items: byGroup.get(row.id),
    createdBy: row.created_by,
    createdAt: isoTimestamp(row.created_at),
    revokedAt: isoTimestamp(row.revoked_at),
    revokedBy: row.revoked_by ?? null,
    revokeReason: row.revoke_reason ?? null,
    idempotencyKey: row.idempotency_key,
  }));
}

const publicGroupMatch = ({ idempotencyKey, ...rest }) => rest;

// Kursor pozycji wyciągu wiąże uzgodnienie, które go wydało (#218, wzorzec z
// listPayments w payments.js): dociągnięcie strony innego uzgodnienia kończy
// się 400 invalid_cursor zamiast mieszać wiersze.
function encodeLinesCursor(row, reconciliationId) {
  return btoa(JSON.stringify([row.booked_on, row.id, reconciliationId]))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeLinesCursor(value, reconciliationId) {
  if (!value) return null;
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new RequestError('invalid_cursor');
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const decoded = JSON.parse(atob(base64 + padding));
    if (!Array.isArray(decoded) || decoded.length !== 3 || !validDate(decoded[0]) || !validId(decoded[1])
      || decoded[2] !== reconciliationId) {
      throw new Error();
    }
    return { bookedOn: decoded[0], id: decoded[1] };
  } catch {
    throw new RequestError('invalid_cursor');
  }
}

async function loadAuthorizedReconciliation(request, env, id, executor = env.db, lock = false) {
  const context = await requireContext(request, env, WRITE_ROLES);
  const row = await loadReconciliation(executor, id, { lock });
  if (!row) throw new RequestError('reconciliation_not_found', 404);
  requireYear(context, WRITE_ROLES, row.school_year_id);
  return { context, row };
}

const LINES_PAGE_DEFAULT = 500;
const LINES_PAGE_MAX = 500;

async function getReconciliation(request, env, id, url, json) {
  // Autoryzacja poza migawką (nie czyta danych uzgodnienia poza row.school_year_id
  // z loadReconciliation poniżej — patrz requireContext), ale sam odczyt
  // uzgodnienia i wszystkie zapytania pochodne muszą widzieć tę samą chwilę
  // (#213): dotąd Promise.all na env.db (pula) mógł trafić na inne połączenia
  // i inne migawki READ COMMITTED niż loadReconciliation, więc pozycja mogła
  // być pokazana jako niedopasowana razem z dopasowaniem, którego już nie
  // widać na liście. Ta sama migawka obejmuje teraz też stronicowane pozycje
  // i podsumowanie (#218).
  const context = await requireContext(request, env, WRITE_ROLES);

  const limitText = url.searchParams.get('limit') ?? String(LINES_PAGE_DEFAULT);
  if (!/^\d{1,3}$/.test(limitText)) throw new RequestError('invalid_limit');
  const limit = Number(limitText);
  if (limit < 1 || limit > LINES_PAGE_MAX) throw new RequestError('invalid_limit');
  const cursor = decodeLinesCursor(url.searchParams.get('cursor'), id);

  const lineValues = [id];
  const lineConditions = ['l.reconciliation_id = $1'];
  if (cursor) {
    lineValues.push(cursor.bookedOn, cursor.id);
    const dateParam = `$${lineValues.length - 1}::date`;
    const idParam = `$${lineValues.length}`;
    lineConditions.push(`(l.booked_on > ${dateParam} OR (l.booked_on = ${dateParam} AND l.id > ${idParam}))`);
  }
  lineValues.push(limit + 1);

  const {
    reconciliation, lines, matches, entries, inconsistent, summaryRow, inconsistentGroups, groupMatches,
  } = await readSnapshot(env.db, async (tx) => {
    const row = await loadReconciliation(tx, id);
    if (!row) throw new RequestError('reconciliation_not_found', 404);
    requireYear(context, WRITE_ROLES, row.school_year_id);
    const linesResult = await tx.query(
      `SELECT l.id, l.import_id, i.source, l.line_no, to_char(l.booked_on, 'YYYY-MM-DD') AS booked_on,
              l.amount_cents, l.reference_hash IS NOT NULL AS has_reference,
              m.id AS match_id, m.ledger_entry_id, m.payment_entry_id, m.payment_refund_id,
              g.id AS group_match_id,
              (SELECT count(*) FROM bank_reconciliation_group_match_items gi WHERE gi.group_match_id = g.id) AS group_item_count
         FROM bank_statement_lines l
         JOIN bank_statement_imports i ON i.id = l.import_id
         LEFT JOIN bank_reconciliation_matches m ON m.statement_line_id = l.id AND m.revoked_at IS NULL
         LEFT JOIN bank_reconciliation_group_matches_current g ON g.statement_line_id = l.id
        WHERE ${lineConditions.join(' AND ')}
        ORDER BY l.booked_on, l.id
        LIMIT $${lineValues.length}`,
      lineValues,
    );
    const matchesResult = await tx.query(
      `SELECT * FROM bank_reconciliation_matches WHERE reconciliation_id = $1 ORDER BY created_at, id`, [id],
    );
    // Wpisy bankowe księgi do daty wyciągu, których nie powiązano z żadną pozycją.
    // Pobrane 1001, żeby stwierdzić obcięcie bez osobnego zapytania COUNT.
    const entriesResult = await tx.query(
      `SELECT e.id, e.direction, to_char(e.occurred_on, 'YYYY-MM-DD') AS occurred_on, e.net_amount_cents,
              e.category_id, e.description
         FROM ledger_entry_net e
        WHERE e.school_year_id = $1 AND e.occurred_on <= $2::date AND e.method = 'bank'
          AND e.net_amount_cents > 0
          AND NOT EXISTS (
            SELECT 1 FROM bank_reconciliation_matches m
             WHERE m.reconciliation_id = $3 AND m.ledger_entry_id = e.id AND m.revoked_at IS NULL)
          -- Wpis, którego wpłata jest już powiązana, jest wyjaśniony przez tę wpłatę (#162).
          AND NOT EXISTS (
            SELECT 1 FROM bank_reconciliation_matches m
             WHERE m.reconciliation_id = $3 AND e.payment_entry_id IS NOT NULL
               AND m.payment_entry_id = e.payment_entry_id AND m.revoked_at IS NULL)
          -- To samo dla pozycji aktywnych dopasowań zbiorczych (#127, 0105).
          AND NOT EXISTS (
            SELECT 1 FROM bank_group_match_items_current gi
             WHERE gi.reconciliation_id = $3
               AND (gi.ledger_entry_id = e.id
                 OR (e.payment_entry_id IS NOT NULL AND gi.payment_entry_id = e.payment_entry_id)))
        ORDER BY e.occurred_on, e.id
        LIMIT 1001`,
      [row.school_year_id, row.statement_date, id],
    );
    const inconsistentResult = await inconsistentMatches(tx, id);
    const inconsistentGroupsResult = await inconsistentGroupMatches(tx, id);
    const groupMatchesResult = await loadGroupMatches(tx, id);
    // Podsumowanie liczone niezależnie od stronicowania `lines` (#218): stronicowanie
    // pokazuje tylko jedną stronę pozycji, ale liczby w summary muszą objąć wszystkie.
    const summaryResult = await tx.query(
      `SELECT count(*) AS line_count, count(m.id) + count(g.id) AS matched_line_count,
              count(g.id) AS group_matched_line_count,
              COALESCE(sum(l.amount_cents) FILTER (WHERE m.id IS NULL AND g.id IS NULL), 0) AS unmatched_line_total_cents
         FROM bank_statement_lines l
         LEFT JOIN bank_reconciliation_matches m ON m.statement_line_id = l.id AND m.revoked_at IS NULL
         LEFT JOIN bank_reconciliation_group_matches_current g ON g.statement_line_id = l.id
        WHERE l.reconciliation_id = $1`,
      [id],
    );
    return {
      reconciliation: reconciliationFromRow(row), lines: linesResult, matches: matchesResult,
      entries: entriesResult, inconsistent: inconsistentResult, summaryRow: summaryResult,
      inconsistentGroups: inconsistentGroupsResult, groupMatches: groupMatchesResult,
    };
  });

  const visibleLineRows = lines.rows.slice(0, limit);
  const nextCursor = lines.rows.length > limit && visibleLineRows.length
    ? encodeLinesCursor(visibleLineRows[visibleLineRows.length - 1], id)
    : null;
  const lineItems = visibleLineRows.map((line) => ({
    id: line.id,
    importId: line.import_id,
    source: line.source,
    lineNo: line.line_no,
    bookedOn: line.booked_on,
    amountCents: toSafeInteger(line.amount_cents),
    hasReference: Boolean(line.has_reference),
    match: line.match_id
      ? {
        id: line.match_id, ledgerEntryId: line.ledger_entry_id ?? null, paymentEntryId: line.payment_entry_id ?? null,
        ...(line.payment_refund_id ? { paymentRefundId: line.payment_refund_id } : {}),
      }
      : null,
    // Dopasowanie zbiorcze (#127): `match` zostaje null, pozycja jest dopasowana przez `groupMatch`.
    groupMatch: line.group_match_id
      ? { id: line.group_match_id, itemCount: toSafeInteger(line.group_item_count) }
      : null,
  }));
  const summary = summaryRow.rows[0];
  const lineCount = toSafeInteger(summary.line_count);
  // #165 pkt 4: matched_line_count z SQL liczy KAŻDĄ aktywną parę, także tę o
  // niezgodnej kwocie (inconsistentMatches poniżej). Pozycja z takim powiązaniem
  // nie jest „bez pary" (unmatchedLineCount ją pomija tak jak dotąd — to nie ona
  // się zmienia), ale też nie jest cicho liczona jako poprawnie dopasowana: ma
  // własną kategorię "do wyjaśnienia" (inconsistentMatchCount), więc odejmujemy
  // ją z matchedLineCount, żeby suma trzech liczników = lineCount.
  const rawMatchedLineCount = toSafeInteger(summary.matched_line_count);
  const inconsistentMatchCount = inconsistent.length;
  // #127 cz. 2: niespójne dopasowanie zbiorcze to też pozycja „do wyjaśnienia”.
  const inconsistentGroupMatchCount = inconsistentGroups.length;
  const matchedLineCount = rawMatchedLineCount - inconsistentMatchCount - inconsistentGroupMatchCount;
  return json({
    reconciliation,
    lines: lineItems,
    nextCursor,
    matches: matches.rows.map(matchFromRow),
    groupMatches: groupMatches.map(publicGroupMatch),
    summary: {
      lineCount,
      matchedLineCount,
      unmatchedLineCount: lineCount - rawMatchedLineCount,
      unmatchedLineTotalCents: toSafeInteger(summary.unmatched_line_total_cents),
      inconsistentMatchCount,
      groupMatchedLineCount: toSafeInteger(summary.group_matched_line_count),
      inconsistentGroupMatchCount,
    },
    inconsistentMatches: inconsistent,
    inconsistentGroupMatches: inconsistentGroups,
    unmatchedLedgerEntries: entries.rows.slice(0, 1000).map((entry) => ({
      id: entry.id,
      direction: entry.direction,
      occurredOn: entry.occurred_on,
      netAmountCents: toSafeInteger(entry.net_amount_cents),
      categoryId: entry.category_id,
      description: entry.description,
    })),
    unmatchedLedgerEntriesTruncated: entries.rows.length > 1000,
  });
}

async function importLines(request, env, id, json) {
  const idempotencyKey = readIdempotencyKey(request);
  const input = parseStatementLines(await readJson(request, MAX_IMPORT_BYTES));
  const context = await requireContext(request, env, WRITE_ROLES);
  const actorId = context.session.user.id;
  const fromFile = Boolean(input.statement);
  let fileHash = null;
  let transactionHashes = null;
  if (fromFile) {
    const config = bankImportConfig(env);
    if (input.statement.accountIban !== config.iban) throw new RequestError('statement_account_mismatch');
    fileHash = await hmacHex(config.key, `file:${input.content}`);
    transactionHashes = await Promise.all(input.lines.map(
      (line) => hmacHex(config.key, `tx:${config.iban}:${line.transactionId}`),
    ));
  }

  const byKey = async (executor) => (await executor.query(
    `SELECT id, reconciliation_id, source, line_count, request_hash, created_by, skipped_duplicate_count
       FROM bank_statement_imports WHERE idempotency_key = $1`,
    [idempotencyKey],
  )).rows[0] ?? null;

  let requestHash;
  const replayOrConflict = (row) => {
    if (!row) return null;
    if (row.created_by !== actorId || row.reconciliation_id !== id || row.request_hash !== requestHash) {
      throw new RequestError('idempotency_conflict', 409);
    }
    return json({
      import: { id: row.id, reconciliationId: id, source: row.source, lineCount: row.line_count },
      ...(fromFile ? { skippedDuplicateCount: row.skipped_duplicate_count } : {}),
    }, 200, REPLAYED);
  };

  try {
    return await env.db.transaction(async (tx) => {
      const row = await loadReconciliation(tx, id, { lock: true });
      if (!row) throw new RequestError('reconciliation_not_found', 404);
      requireYear(context, WRITE_ROLES, row.school_year_id);
      const hashed = await Promise.all(input.lines.map(async (line, index) => ({
        ...line,
        referenceHash: line.reference ? await sha256Hex(`${row.reference_salt}:${line.reference}`) : null,
        transactionHash: transactionHashes?.[index] ?? null,
      })));
      requestHash = fromFile
        ? await sha256Hex(JSON.stringify([input.source, fileHash]))
        : await sha256Hex(JSON.stringify([input.source,
          hashed.map((line) => [line.bookedOn, line.amountCents, line.referenceHash])]));
      const replay = replayOrConflict(await byKey(tx));
      if (replay) return replay;
      if (row.status !== 'draft') throw notDraftError(row);
      if (fromFile) return importStatementFile(tx, { context, actorId, row, input, hashed, fileHash, requestHash, idempotencyKey, json });

      const importId = crypto.randomUUID();
      await tx.query(
        `INSERT INTO bank_statement_imports (id, reconciliation_id, source, line_count, request_hash, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [importId, id, input.source, hashed.length, requestHash, actorId, idempotencyKey],
      );
      // Jeden INSERT … SELECT FROM unnest(...) zamiast 500 osobnych zapytań w
      // pętli (#218): tyle samo aktywacji triggera bank_statement_line_guard,
      // ale jedna podróż do bazy zamiast MAX_LINES. Kolejność z tablic JS
      // (tożsama z kolejnością w pliku, `index + 1`) jest zachowana przez
      // unnest na równoległych tablicach — bez polegania na WITH ORDINALITY.
      // Możliwe duplikaty z wcześniejszych importów (ta sama data, kwota i skrót
      // tytułu) liczy to samo zapytanie (CTE z RETURNING): porównanie idzie do
      // migawki sprzed instrukcji, więc widzi tylko wiersze INNYCH importów —
      // tak jak wcześniejsze osobne zapytanie z `o.import_id <> l.import_id`.
      let possibleDuplicateCount = 0;
      if (hashed.length > 0) {
        const inserted = await tx.query(
          `WITH ins AS (
             INSERT INTO bank_statement_lines (id, reconciliation_id, import_id, line_no, booked_on, amount_cents, reference_hash, created_by)
             SELECT t.id, $1, $2, t.line_no, t.booked_on, t.amount_cents, t.reference_hash, $3
               FROM unnest($4::text[], $5::int[], $6::date[], $7::bigint[], $8::text[])
                    AS t(id, line_no, booked_on, amount_cents, reference_hash)
             RETURNING booked_on, amount_cents, reference_hash
           )
           SELECT count(*) AS n FROM ins l WHERE EXISTS (
             SELECT 1 FROM bank_statement_lines o
              WHERE o.reconciliation_id = $1 AND o.import_id <> $2
                AND o.booked_on = l.booked_on AND o.amount_cents = l.amount_cents
                AND o.reference_hash IS NOT DISTINCT FROM l.reference_hash)`,
          [id, importId, actorId,
            hashed.map(() => crypto.randomUUID()),
            hashed.map((_, index) => index + 1),
            hashed.map((line) => line.bookedOn),
            hashed.map((line) => line.amountCents),
            hashed.map((line) => line.referenceHash)],
        );
        possibleDuplicateCount = toSafeInteger(inserted.rows[0].n);
      }
      await insertAuditEvent(tx, {
        actorId, action: 'reconciliation.lines.imported', entityType: 'bank_statement_import', entityId: importId,
        metadata: { reconciliationId: id, source: input.source, lineCount: hashed.length, schoolYearId: row.school_year_id },
      });
      return json({
        import: { id: importId, reconciliationId: id, source: input.source, lineCount: hashed.length },
        possibleDuplicateCount,
      }, 201, CREATED);
    });
  } catch (error) {
    if (isUniqueError(error) && requestHash) {
      const replay = replayOrConflict(await byKey(env.db));
      if (replay) return replay;
      throw new RequestError('idempotency_conflict', 409);
    }
    mapDatabaseError(error);
  }
}

// Import pliku CODA/CAMT.053 w otwartej transakcji (#105). Blokada doradcza
// szereguje importy z plików, więc sprawdzenie „ten plik / ten ruch już jest”
// nie przegra wyścigu z równoległym importem do innego uzgodnienia.
async function importStatementFile(tx, { context, actorId, row, input, hashed, fileHash, requestHash, idempotencyKey, json }) {
  const id = row.id;
  const { statement } = input;
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('bank_statement_file_import'))");
  const earlier = (await tx.query(
    `SELECT i.id, i.reconciliation_id, r.school_year_id
       FROM bank_statement_imports i JOIN bank_reconciliations r ON r.id = i.reconciliation_id
      WHERE i.file_hash = $1 AND r.status <> 'abandoned'`,
    [fileHash],
  )).rows[0];
  if (earlier) {
    // Odnośnik tylko dla osoby z dostępem do roku wcześniejszego importu.
    const visible = isAuthorizedScoped(context, { roles: WRITE_ROLES, schoolYearId: earlier.school_year_id, requireMfa: true });
    throw new RequestError('statement_already_imported', 409,
      visible ? { importId: earlier.id, reconciliationId: earlier.reconciliation_id } : {});
  }

  const known = new Map((await tx.query(
    `SELECT l.bank_transaction_hash, l.reconciliation_id, r.school_year_id
       FROM bank_statement_lines l JOIN bank_reconciliations r ON r.id = l.reconciliation_id
      WHERE l.bank_transaction_hash = ANY($1::text[]) AND r.status <> 'abandoned'`,
    [hashed.map((line) => line.transactionHash)],
  )).rows.map((item) => [item.bank_transaction_hash, item]));
  const seen = new Set();
  const fresh = [];
  const skipped = [];
  for (const line of hashed) {
    const previous = known.get(line.transactionHash);
    if (previous || seen.has(line.transactionHash)) {
      const visible = previous
        && isAuthorizedScoped(context, { roles: WRITE_ROLES, schoolYearId: previous.school_year_id, requireMfa: true });
      skipped.push({
        record: line.record, bookedOn: line.bookedOn, amountCents: line.amountCents,
        reconciliationId: visible ? previous.reconciliation_id : null,
      });
      continue;
    }
    seen.add(line.transactionHash);
    fresh.push(line);
  }

  // Kontrola ciągłości — tylko ostrzeżenia, nic nie blokuje.
  const warnings = [];
  const movementSum = statement.movements.reduce((sum, movement) => sum + movement.amountCents, 0);
  if (statement.openingBalanceCents + movementSum !== statement.closingBalanceCents) warnings.push('closing_balance_mismatch');
  const previousFile = (await tx.query(
    `SELECT i.closing_balance_cents FROM bank_statement_imports i
       JOIN bank_reconciliations r ON r.id = i.reconciliation_id
      WHERE r.school_year_id = $1 AND i.file_hash IS NOT NULL AND r.status <> 'abandoned'
      ORDER BY i.created_at DESC, i.id DESC LIMIT 1`,
    [row.school_year_id],
  )).rows[0];
  if (previousFile && toSafeInteger(previousFile.closing_balance_cents) !== statement.openingBalanceCents) {
    warnings.push('opening_balance_discontinuity');
  }
  if (statement.closingDate !== row.statement_date) warnings.push('statement_date_differs');
  else if (statement.closingBalanceCents !== toSafeInteger(row.statement_balance_cents)) warnings.push('statement_balance_differs');

  const fileBalances = {
    statementNumber: statement.statementNumber ?? null,
    openingBalanceCents: statement.openingBalanceCents,
    openingDate: statement.openingDate,
    closingBalanceCents: statement.closingBalanceCents,
    closingDate: statement.closingDate,
  };
  if (!fresh.length) {
    // Wszystkie ruchy są już zaimportowane: brak nowej paczki (line_count >= 1).
    return json({
      import: null, lineCount: 0, skippedDuplicateCount: skipped.length, skippedDuplicates: skipped,
      warnings, fileBalances,
    }, 200, { 'Idempotency-Replayed': 'false' });
  }

  const importId = crypto.randomUUID();
  await tx.query(
    `INSERT INTO bank_statement_imports (id, reconciliation_id, source, line_count, request_hash, created_by,
       idempotency_key, file_hash, statement_number, opening_balance_cents, closing_balance_cents, skipped_duplicate_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [importId, id, input.source, fresh.length, requestHash, actorId, idempotencyKey, fileHash,
      statement.statementNumber ? String(statement.statementNumber).slice(0, 35) : null,
      statement.openingBalanceCents, statement.closingBalanceCents, skipped.length],
  );
  for (const [index, line] of fresh.entries()) {
    await tx.query(
      `INSERT INTO bank_statement_lines (id, reconciliation_id, import_id, line_no, booked_on, amount_cents,
         reference_hash, bank_transaction_hash, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [crypto.randomUUID(), id, importId, index + 1, line.bookedOn, line.amountCents, line.referenceHash,
        line.transactionHash, actorId],
    );
  }
  await insertAuditEvent(tx, {
    actorId, action: 'reconciliation.lines.imported', entityType: 'bank_statement_import', entityId: importId,
    metadata: {
      reconciliationId: id, schoolYearId: row.school_year_id, source: input.source, lineCount: fresh.length,
      skippedDuplicateCount: skipped.length, warnings,
    },
  });
  return json({
    import: { id: importId, reconciliationId: id, source: input.source, lineCount: fresh.length },
    skippedDuplicateCount: skipped.length,
    skippedDuplicates: skipped,
    warnings,
    fileBalances,
  }, 201, CREATED);
}

// Kandydaci propozycji (#115, wydajność #217): wpisy księgi i wpłaty, które
// mogą zostać powiązane, wyliczane są RAZ na żądanie (CTE MATERIALIZED), a
// ranking — raz na parę (data, kwota) otwartych pozycji, nie osobno dla każdej
// pary pozycja × wpłata. Pozycje o tej samej dacie i kwocie mają identyczną
// listę kandydatów (kolejność zależy wyłącznie od odległości dni i
// identyfikatora), więc wynik jest taki sam jak przy rankingu per pozycja.
// `extra` to dodatkowy warunek WHERE (zakres dat, gospodarstwo).
function eligibleLedgerSql(extra) {
  return `SELECT e.id, e.occurred_on AS candidate_on, e.net_amount_cents, e.method, pe.household_id,
            NULL::text AS reference,
            CASE WHEN e.direction = 'income' THEN e.net_amount_cents ELSE -e.net_amount_cents END AS match_cents
       FROM ledger_entry_net e
       LEFT JOIN payment_entries pe ON pe.id = e.payment_entry_id
      WHERE e.school_year_id = $2
        -- Wyciąg dotyczy rachunku: wpis gotówkowy (kasa) nie jest kandydatem, tak jak
        -- saldo księgi (rachunek) i lista „wpisy bez pozycji wyciągu” liczą tylko method = 'bank'.
        AND e.method = 'bank'
        AND ${extra.replaceAll('{date}', 'e.occurred_on').replaceAll('{household}', 'pe.household_id')}
        -- #105: wpis powiązany w dowolnym uzgodnieniu roku nie jest już kandydatem.
        AND NOT EXISTS (SELECT 1 FROM bank_reconciliation_matches m
                          JOIN bank_reconciliations r ON r.id = m.reconciliation_id
                         WHERE r.school_year_id = $2 AND m.ledger_entry_id = e.id AND m.revoked_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM bank_group_match_items_current gi
                         WHERE gi.school_year_id = $2 AND gi.ledger_entry_id = e.id)`;
}

// Wpłaty nieujęte jeszcze w księdze (wpłata ujęta w księdze jest proponowana jako wpis księgi).
// Dopasowanie po kwocie „wpłata − korekty” (zwroty jej nie zmniejszają, #138).
function eligiblePaymentsSql(extra) {
  return `SELECT p.id, p.received_on AS candidate_on, p.amount_cents - COALESCE(c.corrected, 0) AS net_amount_cents,
            p.method, p.household_id, p.reference, p.amount_cents - COALESCE(c.corrected, 0) AS match_cents
       FROM payment_entries p
       LEFT JOIN (SELECT payment_entry_id, sum(amount_cents) AS corrected
                    FROM payment_corrections GROUP BY payment_entry_id) c ON c.payment_entry_id = p.id
      WHERE p.school_year_id = $2 AND p.status IN ('recorded', 'unmatched')
        AND p.method = 'bank'
        AND ${extra.replaceAll('{date}', 'p.received_on').replaceAll('{household}', 'p.household_id')}
        AND NOT EXISTS (SELECT 1 FROM ledger_entries le WHERE le.payment_entry_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM bank_reconciliation_matches m
                          JOIN bank_reconciliations r ON r.id = m.reconciliation_id
                         WHERE r.school_year_id = $2 AND m.payment_entry_id = p.id AND m.revoked_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM bank_group_match_items_current gi
                         WHERE gi.school_year_id = $2 AND gi.payment_entry_id = p.id)`;
}

// Warunek „pozycja otwarta” (bez aktywnego powiązania 1:1 i zbiorczego); $1 = uzgodnienie.
const OPEN_LINE_SQL = `l.reconciliation_id = $1 AND NOT EXISTS (
      SELECT 1 FROM bank_reconciliation_matches m WHERE m.statement_line_id = l.id AND m.revoked_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM bank_reconciliation_group_matches_current g WHERE g.statement_line_id = l.id)`;

// Ranking kandydatów per (data, kwota) otwartych pozycji; $3 okno dni, $4 limit.
function rankedCandidatesSql(eligible, lineFilter = '') {
  return `
    WITH open_keys AS MATERIALIZED (
      SELECT DISTINCT l.booked_on, l.amount_cents FROM bank_statement_lines l WHERE ${OPEN_LINE_SQL} ${lineFilter}
    ), eligible AS MATERIALIZED (
      ${eligible(`{date} BETWEEN (SELECT min(booked_on) - $3::int FROM open_keys)
                             AND (SELECT max(booked_on) + $3::int FROM open_keys)`)}
    )
    SELECT key_on, amount_key, id, candidate_on, reference, method, household_id, net_amount_cents, day_distance FROM (
      SELECT to_char(k.booked_on, 'YYYY-MM-DD') AS key_on, k.amount_cents::text AS amount_key, e.id,
             to_char(e.candidate_on, 'YYYY-MM-DD') AS candidate_on, e.reference, e.method, e.household_id,
             e.net_amount_cents, abs(e.candidate_on - k.booked_on) AS day_distance,
             row_number() OVER (PARTITION BY k.booked_on, k.amount_cents
                                ORDER BY abs(e.candidate_on - k.booked_on), e.id) AS rn
        FROM open_keys k
        JOIN eligible e ON e.match_cents = k.amount_cents
         AND e.candidate_on BETWEEN k.booked_on - $3::int AND k.booked_on + $3::int
    ) ranked WHERE rn <= $4`;
}

// Kandydaci gospodarstwa wskazanego komunikacją strukturalną: pary (pozycja,
// gospodarstwo) w $5/$6, bez zapasu candidateLimit — przy typowych kwotach
// składek wpłata tego gospodarstwa mogłaby się w nim nie zmieścić.
function householdCandidatesSql(eligible) {
  return `
    WITH pairs AS (SELECT * FROM unnest($5::text[], $6::text[]) AS x(line_id, household_id)),
         eligible AS MATERIALIZED (${eligible('{household} = ANY($6::text[])')})
    SELECT line_id, id, candidate_on, reference, method, household_id, net_amount_cents, day_distance FROM (
      SELECT x.line_id, e.id, to_char(e.candidate_on, 'YYYY-MM-DD') AS candidate_on, e.reference, e.method,
             e.household_id, e.net_amount_cents, abs(e.candidate_on - l.booked_on) AS day_distance,
             row_number() OVER (PARTITION BY x.line_id ORDER BY abs(e.candidate_on - l.booked_on), e.id) AS rn
        FROM pairs x
        JOIN bank_statement_lines l ON l.id = x.line_id AND l.reconciliation_id = $1
        JOIN eligible e ON e.household_id = x.household_id AND e.match_cents = l.amount_cents
         AND e.candidate_on BETWEEN l.booked_on - $3::int AND l.booked_on + $3::int
    ) ranked WHERE rn <= $4`;
}

// Warianty zapisu komunikacji strukturalnej OGM-VCS (#83), które — po
// normalizacji tytułu (normalizeReference) — mogą stanowić CAŁY tytuł pozycji:
// CODA typ 101 daje „+++ddd/dddd/ddddd+++”, CAMT (Strd/CdtrRefInf/Ref) zwykle
// 12 cyfr albo ten sam zapis z plusami. Serwer nie przechowuje tytułu, tylko
// solony skrót (sól uzgodnienia w $3), więc porównujemy skróty wariantów
// aktywnych referencji roku ze skrótem pozycji. Tytuł, w którym referencja jest
// otoczona innym tekstem, nie jest rozpoznawany — świadome ograniczenie
// (docs/RECONCILIATION.md).
const STRUCTURED_REFERENCE_LINES_SQL = `
  WITH variants AS MATERIALIZED (
    SELECT pr.household_id, v.variant
      FROM payment_references pr
      CROSS JOIN LATERAL (SELECT substr(pr.structured_reference, 1, 3) || '/' || substr(pr.structured_reference, 4, 4)
                                 || '/' || substr(pr.structured_reference, 8, 5) AS slashed) f
      CROSS JOIN LATERAL (VALUES (pr.structured_reference), ('+++' || f.slashed || '+++'),
                                 ('***' || f.slashed || '***'), (f.slashed)) AS v(variant)
     WHERE pr.school_year_id = $2 AND pr.revoked_at IS NULL
  ), hashed AS MATERIALIZED (
    SELECT household_id, encode(sha256(convert_to($3 || ':' || variant, 'UTF8')), 'hex') AS reference_hash
      FROM variants
  )
  SELECT DISTINCT l.id AS line_id, h.household_id
    FROM bank_statement_lines l
    JOIN hashed h ON h.reference_hash = l.reference_hash
   WHERE ${OPEN_LINE_SQL} AND l.amount_cents > 0 AND l.reference_hash IS NOT NULL
   ORDER BY l.id, h.household_id`;

function toCandidate(type, entry, extra = {}) {
  return {
    type, id: entry.id, date: entry.candidate_on, method: entry.method,
    amountCents: toSafeInteger(entry.net_amount_cents), dayDistance: toSafeInteger(entry.day_distance),
    referenceMatch: false, structuredReferenceMatch: false, ...extra,
  };
}

// Kolejność: najpierw istniejąca wpłata/wpis gospodarstwa wskazanego komunikacją
// strukturalną (żeby nie tworzyć drugiej wpłaty), potem propozycja nowej wpłaty
// dla tego gospodarstwa, dalej jak dotąd: zgodny tytuł, odległość dni, typ, id.
function candidateRank(candidate) {
  if (candidate.type === 'household') return 1;
  return candidate.structuredReferenceMatch ? 0 : 2;
}

function compareCandidates(a, b) {
  return candidateRank(a) - candidateRank(b)
    || Number(b.referenceMatch) - Number(a.referenceMatch)
    || (a.dayDistance ?? 0) - (b.dayDistance ?? 0)
    || (a.type === b.type ? a.id.localeCompare(b.id) : a.type === 'ledger_entry' ? -1 : 1);
}

async function suggestMatches(request, env, id, url, json) {
  const windowText = url.searchParams.get('windowDays') ?? '7';
  if (!/^\d{1,2}$/.test(windowText) || Number(windowText) > 31) throw new RequestError('invalid_window');
  const windowDays = Number(windowText);
  const { row } = await loadAuthorizedReconciliation(request, env, id);

  // Zapas ponad limit odpowiedzi (#158): dopasowanie po tytule (referenceMatch)
  // liczone jest dopiero w JS, więc SQL musi przepuścić więcej niż MAX_CANDIDATES,
  // żeby kandydat z trafionym tytułem, ale dalszą datą, mógł wypchnąć bliższego
  // dniowo, ale bez zgodności tytułu, kandydata na pierwsze miejsce.
  const candidateLimit = MAX_CANDIDATES * 4;
  const empty = { rows: [] };
  // Jedna migawka (REPEATABLE READ, READ ONLY) na jednym połączeniu: równoległe
  // potwierdzenie dopasowania (POST …/matches) na innym połączeniu nie może
  // sprawić, że ta sama pozycja/kandydat wygląda inaczej w kolejnych zapytaniach.
  const found = await env.db.transaction(async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const lines = await tx.query(
      `SELECT l.id, to_char(l.booked_on, 'YYYY-MM-DD') AS booked_on, l.amount_cents,
              l.amount_cents::text AS amount_key, l.reference_hash
         FROM bank_statement_lines l WHERE ${OPEN_LINE_SQL} ORDER BY l.booked_on, l.id`,
      [id],
    );
    if (!lines.rows.length) return { lines, ledger: empty, payments: empty, structured: empty, householdLedger: empty, householdPayments: empty };
    const ranked = [id, row.school_year_id, windowDays, candidateLimit];
    const ledger = await tx.query(rankedCandidatesSql(eligibleLedgerSql), ranked);
    const payments = await tx.query(rankedCandidatesSql(eligiblePaymentsSql, 'AND l.amount_cents > 0'), ranked);
    // #115 pkt 2: pozycja, której tytuł to aktywna komunikacja strukturalna
    // gospodarstwa z rejestru roku (payment_references, #83). Tylko wpływy.
    const structured = lines.rows.some((line) => line.reference_hash && toSafeInteger(line.amount_cents) > 0)
      ? await tx.query(STRUCTURED_REFERENCE_LINES_SQL, [id, row.school_year_id, row.reference_salt])
      : empty;
    if (!structured.rows.length) return { lines, ledger, payments, structured, householdLedger: empty, householdPayments: empty };
    const paired = [id, row.school_year_id, windowDays, MAX_CANDIDATES,
      structured.rows.map((r) => r.line_id), structured.rows.map((r) => r.household_id)];
    const householdLedger = await tx.query(householdCandidatesSql(eligibleLedgerSql), paired);
    const householdPayments = await tx.query(householdCandidatesSql(eligiblePaymentsSql), paired);
    return { lines, ledger, payments, structured, householdLedger, householdPayments };
  });

  const byKey = (rows) => {
    const map = new Map();
    for (const entry of rows) {
      const k = `${entry.key_on}|${entry.amount_key}`;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(entry);
    }
    return map;
  };
  const byLineId = (rows) => {
    const map = new Map();
    for (const entry of rows) {
      if (!map.has(entry.line_id)) map.set(entry.line_id, []);
      map.get(entry.line_id).push(entry);
    }
    return map;
  };
  const ledgerByKey = byKey(found.ledger.rows);
  const paymentsByKey = byKey(found.payments.rows);
  const householdLedger = byLineId(found.householdLedger.rows);
  const householdPayments = byLineId(found.householdPayments.rows);
  // Jedno gospodarstwo na pozycję: referencja jest unikalna w roku, a skrót
  // całego tytułu nie może odpowiadać dwóm różnym referencjom. Gdyby jednak
  // wskazywał więcej niż jedno (np. ręczny import), nie wskazujemy żadnego.
  const structuredHousehold = new Map();
  for (const [lineId, rows] of byLineId(found.structured.rows)) {
    if (rows.length === 1) structuredHousehold.set(lineId, rows[0].household_id);
  }

  // Skrót tytułu liczony co najwyżej raz na wpłatę-kandydata w całym żądaniu
  // (#158), nawet gdy ta sama wpłata jest kandydatem dla wielu pozycji.
  const hashCache = new Map();
  const cachedHashReference = (value) => {
    if (!hashCache.has(value)) hashCache.set(value, hashReference(row.reference_salt, value));
    return hashCache.get(value);
  };

  const suggestions = [];
  for (const line of found.lines.rows) {
    const lineKey = `${line.booked_on}|${line.amount_key}`;
    const householdId = structuredHousehold.get(line.id) ?? null;
    const seen = new Set();
    const candidates = [];
    const add = (type, entry) => {
      const dedupe = `${type}:${entry.id}`;
      if (seen.has(dedupe)) return null;
      seen.add(dedupe);
      const candidate = toCandidate(type, entry, {
        structuredReferenceMatch: Boolean(householdId) && entry.household_id === householdId,
      });
      candidates.push(candidate);
      return candidate;
    };
    for (const entry of [...(householdLedger.get(line.id) ?? []), ...(ledgerByKey.get(lineKey) ?? [])]) add('ledger_entry', entry);
    for (const entry of [...(householdPayments.get(line.id) ?? []), ...(paymentsByKey.get(lineKey) ?? [])]) {
      const candidate = add('payment_entry', entry);
      if (candidate && line.reference_hash && entry.reference) {
        candidate.referenceMatch = (await cachedHashReference(entry.reference)) === line.reference_hash;
      }
    }
    if (householdId) {
      // Propozycja nowej wpłaty z pozycji (POST …/lines/{lineId}/payment) dla
      // gospodarstwa z rejestru referencji — wymaga kliknięcia skarbnika.
      candidates.push({
        type: 'household', id: householdId, householdId, date: null, method: 'bank',
        amountCents: toSafeInteger(line.amount_cents), dayDistance: null,
        referenceMatch: false, structuredReferenceMatch: true,
      });
    }
    suggestions.push({
      statementLineId: line.id,
      bookedOn: line.booked_on,
      amountCents: toSafeInteger(line.amount_cents),
      candidates: candidates.sort(compareCandidates).slice(0, MAX_CANDIDATES),
    });
  }
  // Wyłącznie propozycje: zatwierdzenie wymaga osobnego POST …/matches
  // (albo …/lines/{lineId}/payment dla kandydata „household”).
  return json({ reconciliationId: id, windowDays, suggestions });
}

// Wpłata wprost z pozycji wyciągu (#115, część 2): kwota i data pochodzą z
// pozycji, nie z klienta; metoda jest zawsze 'bank' (pozycja jest z wyciągu
// bankowego). household_id — skarbnik wskazuje gospodarstwo albo zostawia
// NULL (status 'unmatched', przypisanie później przez istniejące
// POST /api/payments/{id}/assignment). Wpłata i powiązanie powstają w jednej
// transakcji z jednym kluczem idempotencji: ponowienie/podwójne kliknięcie
// daje ten sam wynik, nigdy drugą wpłatę ani drugie powiązanie. Triggery z
// 0015/0024_reconciliation.sql (bank_reconciliation_require_draft,
// bank_match_guard) są backstopem: zatwierdzone uzgodnienie odrzuca nowe
// powiązanie tak samo jak przy ręcznym POST …/matches.
async function createPaymentFromLine(request, env, id, lineId, json) {
  const idempotencyKey = readIdempotencyKey(request);
  const data = await readJson(request);
  if (data.householdId !== null && data.householdId !== undefined && !validId(data.householdId)) {
    throw new RequestError('invalid_request');
  }
  const householdId = data.householdId ?? null;
  const context = await requireContext(request, env, WRITE_ROLES);
  const actorId = context.session.user.id;

  const byKey = async (executor) => (await executor.query(
    `SELECT p.id AS payment_id, p.household_id, p.school_year_id, p.amount_cents,
            to_char(p.received_on, 'YYYY-MM-DD') AS received_on, p.method, p.status, p.created_by,
            m.id AS match_id, m.statement_line_id
       FROM payment_entries p
       JOIN bank_reconciliation_matches m ON m.payment_entry_id = p.id AND m.revoked_at IS NULL
      WHERE p.idempotency_key = $1`,
    [idempotencyKey],
  )).rows[0] ?? null;
  const replayOrConflict = (row) => {
    if (!row) return null;
    if (row.created_by !== actorId || row.statement_line_id !== lineId
        || (row.household_id ?? null) !== householdId) {
      throw new RequestError('idempotency_conflict', 409);
    }
    return json({
      payment: {
        id: row.payment_id, householdId: row.household_id ?? null, schoolYearId: row.school_year_id,
        amountCents: toSafeInteger(row.amount_cents), receivedOn: row.received_on, method: row.method,
        status: row.status,
      },
      match: { id: row.match_id, reconciliationId: id, statementLineId: row.statement_line_id, paymentEntryId: row.payment_id },
    }, 200, REPLAYED);
  };

  try {
    return await env.db.transaction(async (tx) => {
      const row = await loadReconciliation(tx, id, { lock: true });
      if (!row) throw new RequestError('reconciliation_not_found', 404);
      requireYear(context, WRITE_ROLES, row.school_year_id);
      const replay = replayOrConflict(await byKey(tx));
      if (replay) return replay;
      if (row.status !== 'draft') throw notDraftError(row);
      const line = await tx.query(
        `SELECT id, amount_cents, to_char(booked_on, 'YYYY-MM-DD') AS booked_on
           FROM bank_statement_lines WHERE id = $1 AND reconciliation_id = $2`,
        [lineId, id],
      );
      if (!line.rows[0]) throw new RequestError('statement_line_not_found', 404);
      const amountCents = toSafeInteger(line.rows[0].amount_cents);
      if (amountCents <= 0) throw new RequestError('statement_line_not_income');
      // Pozycja zajęta dopasowaniem 1:1 albo zbiorczym (0105) — trigger
      // bank_match_group_exclusive_guard sprawdza to samo w bazie.
      const taken = await tx.query(
        `SELECT 1 FROM bank_reconciliation_matches WHERE statement_line_id = $1 AND revoked_at IS NULL
         UNION ALL
         SELECT 1 FROM bank_reconciliation_group_matches_current WHERE statement_line_id = $1
         LIMIT 1`, [lineId],
      );
      if (taken.rows.length) throw new RequestError('already_matched', 409);

      const receivedOn = line.rows[0].booked_on;
      const status = householdId ? 'recorded' : 'unmatched';
      const paymentId = crypto.randomUUID();
      await tx.query(
        `INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on,
           method, reference, status, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, 'bank', NULL, $6, $7, $8)`,
        [paymentId, householdId, row.school_year_id, amountCents, receivedOn, status, actorId, idempotencyKey],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'payment.created', entityType: 'payment_entry', entityId: paymentId,
        metadata: {
          schoolYearId: row.school_year_id, source: 'reconciliation_line', reconciliationId: id, statementLineId: lineId,
        },
      });
      const matchId = crypto.randomUUID();
      await tx.query(
        `INSERT INTO bank_reconciliation_matches (id, reconciliation_id, statement_line_id, payment_entry_id, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [matchId, id, lineId, paymentId, actorId, idempotencyKey],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'reconciliation.match.confirmed', entityType: 'bank_reconciliation_match', entityId: matchId,
        metadata: {
          reconciliationId: id, statementLineId: lineId, paymentEntryId: paymentId, schoolYearId: row.school_year_id,
          source: 'line_payment',
        },
      });
      return json({
        payment: { id: paymentId, householdId, schoolYearId: row.school_year_id, amountCents, receivedOn, method: 'bank', status },
        match: { id: matchId, reconciliationId: id, statementLineId: lineId, paymentEntryId: paymentId },
      }, 201, CREATED);
    });
  } catch (error) {
    if (isUniqueError(error)) {
      const replay = replayOrConflict(await byKey(env.db));
      if (replay) return replay;
      throw new RequestError('idempotency_conflict', 409);
    }
    mapDatabaseError(error);
  }
}

async function confirmMatch(request, env, id, json) {
  const idempotencyKey = readIdempotencyKey(request);
  const data = await readJson(request);
  const ledgerEntryId = data.ledgerEntryId ?? null;
  const paymentEntryId = data.paymentEntryId ?? null;
  // Zwrot wpłaty (0152, #138) ↔ ujemna pozycja wyciągu: trzeci, wyłączny cel powiązania.
  const paymentRefundId = data.paymentRefundId ?? null;
  const targetIds = [ledgerEntryId, paymentEntryId, paymentRefundId];
  if (!validId(data.statementLineId) || targetIds.filter((value) => value !== null).length !== 1
      || targetIds.some((value) => value !== null && !validId(value))) {
    throw new RequestError('invalid_request');
  }
  const context = await requireContext(request, env, WRITE_ROLES);
  const actorId = context.session.user.id;

  const byKey = async (executor) => (await executor.query(
    'SELECT * FROM bank_reconciliation_matches WHERE idempotency_key = $1', [idempotencyKey],
  )).rows[0] ?? null;
  const replayOrConflict = (match) => {
    if (!match) return null;
    if (match.created_by !== actorId || match.reconciliation_id !== id || match.statement_line_id !== data.statementLineId
        || (match.ledger_entry_id ?? null) !== ledgerEntryId || (match.payment_entry_id ?? null) !== paymentEntryId
        || (match.payment_refund_id ?? null) !== paymentRefundId) {
      throw new RequestError('idempotency_conflict', 409);
    }
    return json({ match: matchFromRow(match) }, 200, REPLAYED);
  };

  try {
    return await env.db.transaction(async (tx) => {
      const row = await loadReconciliation(tx, id, { lock: true });
      if (!row) throw new RequestError('reconciliation_not_found', 404);
      requireYear(context, WRITE_ROLES, row.school_year_id);
      const replay = replayOrConflict(await byKey(tx));
      if (replay) return replay;
      if (row.status !== 'draft') throw notDraftError(row);
      const taken = await tx.query(
        `SELECT 1 FROM bank_reconciliation_matches
          WHERE revoked_at IS NULL AND (statement_line_id = $1
             OR (reconciliation_id = $2 AND (ledger_entry_id = $3 OR payment_entry_id = $4 OR payment_refund_id = $5)))`,
        [data.statementLineId, id, ledgerEntryId, paymentEntryId, paymentRefundId],
      );
      if (taken.rows.length) throw new RequestError('already_matched', 409);
      // Pozycja lub cel w aktywnym dopasowaniu zbiorczym (#127, 0105; trigger bank_matches_z_group_guard).
      const takenByGroup = await tx.query(
        `SELECT 1 FROM bank_reconciliation_group_matches_current g
          WHERE g.statement_line_id = $1
         UNION ALL
         SELECT 1 FROM bank_group_match_items_current i
          WHERE i.reconciliation_id = $2 AND (i.ledger_entry_id = $3 OR i.payment_entry_id = $4)
         LIMIT 1`,
        [data.statementLineId, id, ledgerEntryId, paymentEntryId],
      );
      if (takenByGroup.rows.length) throw new RequestError('already_matched', 409);
      if (paymentEntryId !== null) {
        // Pozycja wyciągu to przelew: wpłaty gotówkowej ani „innej” nie wolno z nią powiązać (#115).
        const payment = await tx.query('SELECT method FROM payment_entries WHERE id = $1', [paymentEntryId]);
        if (payment.rows[0] && payment.rows[0].method !== 'bank') throw new RequestError('match_method_mismatch', 409);
      }
      // Podwójne ujęcie (#162): wpłata i wpis księgi z tą wpłatą wykluczają się w jednym uzgodnieniu.
      // Trigger bank_match_guard (0024) sprawdza to samo pod blokadą.
      const counted = await tx.query(
        `SELECT m.ledger_entry_id IS NOT NULL AS via_ledger
           FROM bank_reconciliation_matches m
           LEFT JOIN ledger_entries matched ON matched.id = m.ledger_entry_id
          WHERE m.reconciliation_id = $1 AND m.revoked_at IS NULL
            AND (($2::text IS NOT NULL AND matched.payment_entry_id = $2)
              OR ($3::text IS NOT NULL AND m.payment_entry_id = (SELECT payment_entry_id FROM ledger_entries WHERE id = $3)))
          LIMIT 1`,
        [id, paymentEntryId, ledgerEntryId],
      );
      if (counted.rows.length) {
        throw new RequestError(counted.rows[0].via_ledger ? 'already_matched_via_ledger' : 'already_matched_via_payment', 409);
      }
      // #105: ten sam cel nie może być powiązany w dwóch uzgodnieniach roku —
      // 1:1 (trigger bank_match_year_unique_guard, 0089) ani zbiorczo
      // (bank_match_group_exclusive_guard, 0105); obie ścieżki pod blokadą roku.
      const elsewhere = (await tx.query(
        'SELECT bank_target_matched_elsewhere_in_year($1, $2, $3, $4, true) AS reconciliation_id',
        [row.school_year_id, id, ledgerEntryId, paymentEntryId],
      )).rows[0];
      if (elsewhere?.reconciliation_id) {
        throw new RequestError('matched_in_other_reconciliation', 409, { reconciliationId: elsewhere.reconciliation_id });
      }
      if (paymentRefundId !== null) {
        // Zwrot aktywnie powiązany w innym uzgodnieniu roku (trigger bank_match_guard, 0152).
        const refundElsewhere = (await tx.query(
          `SELECT m.reconciliation_id FROM bank_reconciliation_matches m
             JOIN bank_reconciliations r ON r.id = m.reconciliation_id
            WHERE r.school_year_id = $1 AND m.reconciliation_id <> $2 AND m.revoked_at IS NULL
              AND m.payment_refund_id = $3 LIMIT 1`,
          [row.school_year_id, id, paymentRefundId],
        )).rows[0];
        if (refundElsewhere) {
          throw new RequestError('matched_in_other_reconciliation', 409, { reconciliationId: refundElsewhere.reconciliation_id });
        }
      }
      const matchId = crypto.randomUUID();
      await tx.query(
        `INSERT INTO bank_reconciliation_matches (id, reconciliation_id, statement_line_id, ledger_entry_id,
           payment_entry_id, payment_refund_id, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [matchId, id, data.statementLineId, ledgerEntryId, paymentEntryId, paymentRefundId, actorId, idempotencyKey],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'reconciliation.match.confirmed', entityType: 'bank_reconciliation_match', entityId: matchId,
        metadata: {
          reconciliationId: id, statementLineId: data.statementLineId, ledgerEntryId, paymentEntryId,
          ...(paymentRefundId ? { paymentRefundId } : {}),
          schoolYearId: row.school_year_id,
        },
      });
      const { rows } = await tx.query('SELECT * FROM bank_reconciliation_matches WHERE id = $1', [matchId]);
      return json({ match: matchFromRow(rows[0]) }, 201, CREATED);
    });
  } catch (error) {
    if (isUniqueError(error)) {
      const replay = replayOrConflict(await byKey(env.db));
      if (replay) return replay;
      throw new RequestError('already_matched', 409);
    }
    mapDatabaseError(error);
  }
}

// Wsadowe zatwierdzenie wybranych propozycji (#115): klient podaje jawną listę
// par (statementLineId, paymentEntryId); serwer nigdy nie zatwierdza „wszystkich
// propozycji”. Wariant zachowawczy: wszystko albo nic — jedna transakcja, a przy
// jakiejkolwiek parze odrzuconej nic nie zostaje zapisane, odpowiedź wymienia
// odrzucone pary (409 match_batch_rejected). Reguły par są takie same jak dla
// POST …/matches (pozycja wolna, przelew, brak podwójnego ujęcia, kwota — baza).
const WHOLE_BATCH_ERRORS = new Set(['school_year_closed', 'reconciliation_confirmed', 'reconciliation_abandoned']);

function parseBatchPairs(data) {
  const list = data.matches;
  if (!Array.isArray(list) || list.length === 0) throw new RequestError('match_batch_empty');
  if (list.length > MAX_BATCH_MATCHES) throw new RequestError('match_batch_too_large');
  const lines = new Set();
  const payments = new Set();
  const pairs = list.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
        || Object.keys(item).some((key) => key !== 'statementLineId' && key !== 'paymentEntryId')
        || !validId(item.statementLineId) || !validId(item.paymentEntryId)) {
      throw new RequestError('invalid_request');
    }
    if (lines.has(item.statementLineId) || payments.has(item.paymentEntryId)) throw new RequestError('match_batch_duplicate');
    lines.add(item.statementLineId);
    payments.add(item.paymentEntryId);
    return { statementLineId: item.statementLineId, paymentEntryId: item.paymentEntryId };
  });
  // Kolejność w żądaniu nie ma znaczenia: ten sam zbiór par daje te same klucze par.
  return pairs.sort((a, b) => (a.statementLineId < b.statementLineId ? -1 : a.statementLineId > b.statementLineId ? 1 : 0));
}

// Klucze par wywodzą się z klucza żądania i pozycji na posortowanej liście.
async function batchPairKeys(idempotencyKey, count) {
  const prefix = `bm:${(await sha256Hex(idempotencyKey)).slice(0, 40)}`;
  return Array.from({ length: count }, (_, index) => `${prefix}:${index}`);
}

async function confirmMatchBatch(request, env, id, json) {
  const idempotencyKey = readIdempotencyKey(request);
  const data = await readJson(request);
  const pairs = parseBatchPairs(data);
  const context = await requireContext(request, env, WRITE_ROLES);
  const actorId = context.session.user.id;
  const keys = await batchPairKeys(idempotencyKey, pairs.length);
  const allKeys = await batchPairKeys(idempotencyKey, MAX_BATCH_MATCHES);

  const byKey = async (executor) => (await executor.query(
    'SELECT * FROM bank_reconciliation_matches WHERE idempotency_key = ANY($1::text[]) ORDER BY idempotency_key', [allKeys],
  )).rows;
  // Ten sam klucz i ten sam zbiór par → 200 z zapisanymi powiązaniami; inny zbiór → 409.
  const replayOrConflict = (rows) => {
    if (!rows.length) return null;
    const byIdempotencyKey = new Map(rows.map((row) => [row.idempotency_key, row]));
    const same = rows.length === pairs.length && pairs.every((pair, index) => {
      const row = byIdempotencyKey.get(keys[index]);
      return row && row.created_by === actorId && row.reconciliation_id === id
        && row.statement_line_id === pair.statementLineId && row.payment_entry_id === pair.paymentEntryId;
    });
    if (!same) throw new RequestError('idempotency_conflict', 409);
    return json({ matches: keys.map((key) => matchFromRow(byIdempotencyKey.get(key))) }, 200, REPLAYED);
  };

  try {
    return await env.db.transaction(async (tx) => {
      const row = await loadReconciliation(tx, id, { lock: true });
      if (!row) throw new RequestError('reconciliation_not_found', 404);
      requireYear(context, WRITE_ROLES, row.school_year_id);
      const replay = replayOrConflict(await byKey(tx));
      if (replay) return replay;
      if (row.status !== 'draft') throw notDraftError(row);

      const failures = [];
      const created = [];
      for (const [index, pair] of pairs.entries()) {
        const fail = (code) => failures.push({ statementLineId: pair.statementLineId, paymentEntryId: pair.paymentEntryId, error: code });
        const line = await tx.query('SELECT 1 FROM bank_statement_lines WHERE id = $1 AND reconciliation_id = $2',
          [pair.statementLineId, id]);
        if (!line.rows.length) { fail('statement_line_not_found'); continue; }
        const taken = await tx.query(
          `SELECT 1 FROM bank_reconciliation_matches
            WHERE revoked_at IS NULL AND (statement_line_id = $1 OR (reconciliation_id = $2 AND payment_entry_id = $3))
           UNION ALL
           SELECT 1 FROM bank_reconciliation_group_matches_current g WHERE g.statement_line_id = $1
           UNION ALL
           SELECT 1 FROM bank_group_match_items_current i WHERE i.reconciliation_id = $2 AND i.payment_entry_id = $3
           LIMIT 1`,
          [pair.statementLineId, id, pair.paymentEntryId],
        );
        if (taken.rows.length) { fail('already_matched'); continue; }
        const payment = await tx.query('SELECT method FROM payment_entries WHERE id = $1', [pair.paymentEntryId]);
        if (!payment.rows[0]) { fail('invalid_match_target'); continue; }
        if (payment.rows[0].method !== 'bank') { fail('match_method_mismatch'); continue; }
        // Reszta reguł (kwota, podwójne ujęcie, inne uzgodnienie roku) to triggery bazy;
        // punkt zapisu pozwala zebrać wszystkie odrzucone pary zamiast przerwać na pierwszej.
        const matchId = crypto.randomUUID();
        await tx.query('SAVEPOINT batch_pair');
        try {
          await tx.query(
            `INSERT INTO bank_reconciliation_matches (id, reconciliation_id, statement_line_id, payment_entry_id, created_by, idempotency_key)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [matchId, id, pair.statementLineId, pair.paymentEntryId, actorId, keys[index]],
          );
          await tx.query('RELEASE SAVEPOINT batch_pair');
          created.push({ matchId, pair });
        } catch (error) {
          await tx.query('ROLLBACK TO SAVEPOINT batch_pair');
          if (isUniqueError(error)) { fail('already_matched'); continue; }
          try {
            mapDatabaseError(error);
          } catch (mapped) {
            if (!(mapped instanceof RequestError) || WHOLE_BATCH_ERRORS.has(mapped.code)) throw mapped;
            fail(mapped.code);
          }
        }
      }
      if (failures.length) throw new RequestError('match_batch_rejected', 409, { failures });
      for (const { matchId, pair } of created) {
        // Bez kwot, tytułów i identyfikatorów gospodarstw (jak pojedyncze potwierdzenie).
        await insertAuditEvent(tx, {
          actorId, action: 'reconciliation.match.confirmed', entityType: 'bank_reconciliation_match', entityId: matchId,
          metadata: {
            reconciliationId: id, statementLineId: pair.statementLineId, paymentEntryId: pair.paymentEntryId,
            schoolYearId: row.school_year_id, source: 'batch',
          },
        });
      }
      const { rows } = await tx.query(
        'SELECT * FROM bank_reconciliation_matches WHERE id = ANY($1::text[])', [created.map((entry) => entry.matchId)],
      );
      const byId = new Map(rows.map((match) => [match.id, match]));
      return json({ matches: created.map((entry) => matchFromRow(byId.get(entry.matchId))) }, 201, CREATED);
    });
  } catch (error) {
    if (isUniqueError(error)) {
      const replay = replayOrConflict(await byKey(env.db));
      if (replay) return replay;
      throw new RequestError('already_matched', 409);
    }
    mapDatabaseError(error);
  }
}

async function revokeMatch(request, env, id, matchId, json) {
  const data = await readJson(request);
  const reason = optionalText(data.reason, 3, 500, 'invalid_reason');
  if (!reason) throw new RequestError('invalid_reason');
  const context = await requireContext(request, env, WRITE_ROLES);
  const actorId = context.session.user.id;
  try {
    return await env.db.transaction(async (tx) => {
      const row = await loadReconciliation(tx, id, { lock: true });
      if (!row) throw new RequestError('reconciliation_not_found', 404);
      requireYear(context, WRITE_ROLES, row.school_year_id);
      const { rows } = await tx.query(
        'SELECT * FROM bank_reconciliation_matches WHERE id = $1 AND reconciliation_id = $2 FOR UPDATE', [matchId, id],
      );
      const match = rows[0];
      if (!match) throw new RequestError('match_not_found', 404);
      if (match.revoked_at) {
        if (match.revoked_by === actorId && match.revoke_reason === reason) {
          return json({ match: matchFromRow(match) }, 200, REPLAYED);
        }
        throw new RequestError('match_already_revoked', 409);
      }
      if (row.status !== 'draft') throw notDraftError(row);
      const gate = gateFreeText([['bank_reconciliation_matches.revoke_reason', reason]], { confirm: data.confirmPersonalData === true, fail: piiFail });
      const updated = await tx.query(
        `UPDATE bank_reconciliation_matches SET revoked_at = now(), revoked_by = $2, revoke_reason = $3
          WHERE id = $1 RETURNING *`,
        [matchId, actorId, reason],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'reconciliation.match.revoked', entityType: 'bank_reconciliation_match', entityId: matchId,
        metadata: { reconciliationId: id, schoolYearId: row.school_year_id, ...piiAuditMetadata(gate) },
      });
      return json({ match: matchFromRow(updated.rows[0]) }, 200, CREATED);
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}

// --- dopasowanie zbiorcze (#127, część 2; 0105) -----------------------------

// Pozycje: [{ paymentEntryId } | { ledgerEntryId }], 2…50, bez powtórzeń.
// Kwot nie podaje klient: każda pozycja to pełne dzisiejsze netto celu,
// a suma musi równać się kwocie pozycji wyciągu (bez dopasowań „z różnicą”).
function parseGroupItems(value) {
  if (!Array.isArray(value) || value.length < MIN_GROUP_ITEMS || value.length > MAX_GROUP_ITEMS) {
    throw new RequestError('invalid_request');
  }
  const seen = new Set();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new RequestError('invalid_request');
    const keys = Object.keys(item);
    const ledgerEntryId = item.ledgerEntryId ?? null;
    const paymentEntryId = item.paymentEntryId ?? null;
    if (keys.length !== 1 || (ledgerEntryId === null) === (paymentEntryId === null)
        || (ledgerEntryId !== null && !validId(ledgerEntryId)) || (paymentEntryId !== null && !validId(paymentEntryId))) {
      throw new RequestError('invalid_request');
    }
    const signature = ledgerEntryId ? `l:${ledgerEntryId}` : `p:${paymentEntryId}`;
    if (seen.has(signature)) throw new RequestError('invalid_request');
    seen.add(signature);
    return { ledgerEntryId, paymentEntryId, signature };
  });
}

const groupSignature = (items) => items.map((item) => (item.ledgerEntryId ? `l:${item.ledgerEntryId}` : `p:${item.paymentEntryId}`))
  .sort().join('|');

async function confirmGroupMatch(request, env, id, json) {
  const idempotencyKey = readIdempotencyKey(request);
  const data = await readJson(request);
  if (!validId(data.statementLineId)) throw new RequestError('invalid_request');
  const items = parseGroupItems(data.items);
  const signature = groupSignature(items);
  const context = await requireContext(request, env, WRITE_ROLES);
  const actorId = context.session.user.id;

  const byKey = async (executor) => {
    const { rows } = await executor.query(
      'SELECT id, reconciliation_id FROM bank_reconciliation_group_matches WHERE idempotency_key = $1', [idempotencyKey],
    );
    if (!rows[0]) return null;
    return (await loadGroupMatches(executor, rows[0].reconciliation_id, rows[0].id))[0] ?? null;
  };
  const replayOrConflict = (group) => {
    if (!group) return null;
    if (group.createdBy !== actorId || group.reconciliationId !== id || group.statementLineId !== data.statementLineId
        || groupSignature(group.items) !== signature) {
      throw new RequestError('idempotency_conflict', 409);
    }
    return json({ groupMatch: publicGroupMatch(group) }, 200, REPLAYED);
  };

  try {
    return await env.db.transaction(async (tx) => {
      const row = await loadReconciliation(tx, id, { lock: true });
      if (!row) throw new RequestError('reconciliation_not_found', 404);
      requireYear(context, WRITE_ROLES, row.school_year_id);
      const replay = replayOrConflict(await byKey(tx));
      if (replay) return replay;
      if (row.status !== 'draft') throw notDraftError(row);

      const line = (await tx.query(
        'SELECT id, amount_cents FROM bank_statement_lines WHERE id = $1 AND reconciliation_id = $2',
        [data.statementLineId, id],
      )).rows[0];
      if (!line) throw new RequestError('invalid_statement_line');
      const lineTaken = await tx.query(
        `SELECT 1 FROM bank_reconciliation_matches WHERE statement_line_id = $1 AND revoked_at IS NULL
         UNION ALL
         SELECT 1 FROM bank_reconciliation_group_matches_current WHERE statement_line_id = $1
         LIMIT 1`,
        [line.id],
      );
      if (lineTaken.rows.length) throw new RequestError('already_matched', 409);
      const lineAmount = toSafeInteger(line.amount_cents);

      // Cele blokowane FOR SHARE w stałej kolejności (jak przy zatwierdzeniu), potem netto.
      const paymentIds = items.filter((item) => item.paymentEntryId).map((item) => item.paymentEntryId).sort();
      const ledgerIds = items.filter((item) => item.ledgerEntryId).map((item) => item.ledgerEntryId).sort();
      if (ledgerIds.length) {
        await tx.query('SELECT 1 FROM ledger_entries WHERE id = ANY($1::text[]) ORDER BY id FOR SHARE', [ledgerIds]);
      }
      if (paymentIds.length) {
        await tx.query('SELECT 1 FROM payment_entries WHERE id = ANY($1::text[]) ORDER BY id FOR SHARE', [paymentIds]);
      }
      const payments = new Map((await tx.query(
        `SELECT id, school_year_id, status, method, net_amount_cents FROM payment_entry_net WHERE id = ANY($1::text[])`,
        [paymentIds],
      )).rows.map((payment) => [payment.id, payment]));
      const entries = new Map((await tx.query(
        `SELECT id, school_year_id, direction, net_amount_cents, payment_entry_id FROM ledger_entry_net WHERE id = ANY($1::text[])`,
        [ledgerIds],
      )).rows.map((entry) => [entry.id, entry]));

      const resolved = [];
      for (const item of items) {
        let amountCents;
        if (item.paymentEntryId) {
          const payment = payments.get(item.paymentEntryId);
          if (!payment || payment.school_year_id !== row.school_year_id || !['recorded', 'unmatched'].includes(payment.status)) {
            throw new RequestError('invalid_match_target');
          }
          if (payment.method !== 'bank') throw new RequestError('match_method_mismatch', 409);
          amountCents = toSafeInteger(payment.net_amount_cents);
        } else {
          const entry = entries.get(item.ledgerEntryId);
          if (!entry || entry.school_year_id !== row.school_year_id) throw new RequestError('invalid_match_target');
          const net = toSafeInteger(entry.net_amount_cents);
          amountCents = entry.direction === 'income' ? net : -net;
        }
        if (amountCents === 0 || Math.sign(amountCents) !== Math.sign(lineAmount)) {
          throw new RequestError('group_match_direction_mismatch', 409);
        }
        resolved.push({ ...item, amountCents });
      }

      // Cel zajęty przez inne aktywne dopasowanie (1:1 albo zbiorcze) tego uzgodnienia.
      const taken = await tx.query(
        `SELECT 1 FROM bank_reconciliation_matches m
          WHERE m.reconciliation_id = $1 AND m.revoked_at IS NULL
            AND (m.payment_entry_id = ANY($2::text[]) OR m.ledger_entry_id = ANY($3::text[]))
         UNION ALL
         SELECT 1 FROM bank_group_match_items_current i
          WHERE i.reconciliation_id = $1
            AND (i.payment_entry_id = ANY($2::text[]) OR i.ledger_entry_id = ANY($3::text[]))
         LIMIT 1`,
        [id, paymentIds, ledgerIds],
      );
      if (taken.rows.length) throw new RequestError('already_matched', 409);
      // Podwójne ujęcie (#162): wpłata i wpis księgi z tą wpłatą — w tym samym
      // żądaniu albo w innym aktywnym dopasowaniu tego uzgodnienia.
      const entryPaymentIds = [...entries.values()].map((entry) => entry.payment_entry_id).filter(Boolean);
      if (entryPaymentIds.some((paymentId) => paymentIds.includes(paymentId))) {
        throw new RequestError('already_matched_via_ledger', 409);
      }
      const viaLedger = await tx.query(
        `SELECT 1 FROM bank_reconciliation_matches m JOIN ledger_entries le ON le.id = m.ledger_entry_id
          WHERE m.reconciliation_id = $1 AND m.revoked_at IS NULL AND le.payment_entry_id = ANY($2::text[])
         UNION ALL
         SELECT 1 FROM bank_group_match_items_current i JOIN ledger_entries le ON le.id = i.ledger_entry_id
          WHERE i.reconciliation_id = $1 AND le.payment_entry_id = ANY($2::text[])
         LIMIT 1`,
        [id, paymentIds],
      );
      if (viaLedger.rows.length) throw new RequestError('already_matched_via_ledger', 409);
      const viaPayment = await tx.query(
        `SELECT 1 FROM bank_reconciliation_matches m
          WHERE m.reconciliation_id = $1 AND m.revoked_at IS NULL AND m.payment_entry_id = ANY($2::text[])
         UNION ALL
         SELECT 1 FROM bank_group_match_items_current i
          WHERE i.reconciliation_id = $1 AND i.payment_entry_id = ANY($2::text[])
         LIMIT 1`,
        [id, entryPaymentIds],
      );
      if (viaPayment.rows.length) throw new RequestError('already_matched_via_payment', 409);
      // Jedno aktywne dopasowanie celu w roku (#105): ten sam cel (albo para wpłata–wpis)
      // nie może być dopasowany w innym uzgodnieniu tego roku. Trigger sprawdza to samo
      // pod blokadą doradczą roku.
      for (const item of resolved) {
        const { rows: [elsewhere] } = await tx.query(
          'SELECT bank_target_matched_elsewhere_in_year($1, $2, $3, $4, true) AS reconciliation_id',
          [row.school_year_id, id, item.ledgerEntryId ?? null, item.paymentEntryId ?? null],
        );
        if (elsewhere?.reconciliation_id) {
          throw new RequestError('matched_in_other_reconciliation', 409, { reconciliationId: elsewhere.reconciliation_id });
        }
      }

      const itemsTotalCents = resolved.reduce((sum, item) => sum + item.amountCents, 0);
      if (itemsTotalCents !== lineAmount) {
        throw new RequestError('group_match_sum_mismatch', 409, { lineAmountCents: lineAmount, itemsTotalCents });
      }

      const groupId = crypto.randomUUID();
      await tx.query(
        `INSERT INTO bank_reconciliation_group_matches (id, reconciliation_id, school_year_id, statement_line_id,
           created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [groupId, id, row.school_year_id, line.id, actorId, idempotencyKey],
      );
      for (const item of resolved) {
        await tx.query(
          `INSERT INTO bank_reconciliation_group_match_items (id, group_match_id, reconciliation_id, school_year_id,
             ledger_entry_id, payment_entry_id, amount_cents)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [crypto.randomUUID(), groupId, id, row.school_year_id, item.ledgerEntryId, item.paymentEntryId, item.amountCents],
        );
      }
      // Kontrola sumy (constraint trigger, domyślnie przy COMMIT) już teraz — błąd wraca w tej transakcji.
      await tx.query('SET CONSTRAINTS bank_group_matches_sum_check, bank_group_match_items_sum_check IMMEDIATE');
      // Bez kwot i bez identyfikatorów gospodarstw (jak reconciliation.match.confirmed).
      await insertAuditEvent(tx, {
        actorId, action: 'reconciliation.group_match.confirmed', entityType: 'bank_reconciliation_group_match',
        entityId: groupId,
        metadata: {
          reconciliationId: id, statementLineId: line.id, itemCount: resolved.length,
          paymentEntryIds: paymentIds, ledgerEntryIds: ledgerIds, schoolYearId: row.school_year_id,
        },
      });
      const [group] = await loadGroupMatches(tx, id, groupId);
      return json({ groupMatch: publicGroupMatch(group) }, 201, CREATED);
    });
  } catch (error) {
    if (isUniqueError(error)) {
      const replay = replayOrConflict(await byKey(env.db));
      if (replay) return replay;
      throw new RequestError('already_matched', 409);
    }
    mapDatabaseError(error);
  }
}

// Cofnięcie = nowy, niezmienny zapis z powodem (bank_reconciliation_group_match_revocations).
async function revokeGroupMatch(request, env, id, groupId, json) {
  const data = await readJson(request);
  const reason = optionalText(data.reason, 3, 500, 'invalid_reason');
  if (!reason) throw new RequestError('invalid_reason');
  const context = await requireContext(request, env, WRITE_ROLES);
  const actorId = context.session.user.id;
  try {
    return await env.db.transaction(async (tx) => {
      const row = await loadReconciliation(tx, id, { lock: true });
      if (!row) throw new RequestError('reconciliation_not_found', 404);
      requireYear(context, WRITE_ROLES, row.school_year_id);
      const [group] = await loadGroupMatches(tx, id, groupId);
      if (!group) throw new RequestError('match_not_found', 404);
      if (group.revokedAt) {
        if (group.revokedBy === actorId && group.revokeReason === reason) {
          return json({ groupMatch: publicGroupMatch(group) }, 200, REPLAYED);
        }
        throw new RequestError('match_already_revoked', 409);
      }
      if (row.status !== 'draft') throw notDraftError(row);
      const gate = gateFreeText([['bank_reconciliation_group_match_revocations.reason', reason]], { confirm: data.confirmPersonalData === true, fail: piiFail });
      const revocationId = crypto.randomUUID();
      await tx.query(
        `INSERT INTO bank_reconciliation_group_match_revocations (id, group_match_id, reconciliation_id, school_year_id,
           reason, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [revocationId, groupId, id, row.school_year_id, reason, actorId],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'reconciliation.group_match.revoked', entityType: 'bank_reconciliation_group_match',
        entityId: groupId, metadata: { reconciliationId: id, revocationId, schoolYearId: row.school_year_id, ...piiAuditMetadata(gate) },
      });
      const [updated] = await loadGroupMatches(tx, id, groupId);
      return json({ groupMatch: publicGroupMatch(updated) }, 200, CREATED);
    });
  } catch (error) {
    // Równoległe drugie cofnięcie: UNIQUE(group_match_id).
    if (isUniqueError(error)) {
      const [group] = await loadGroupMatches(env.db, id, groupId);
      if (group?.revokedBy === actorId && group.revokeReason === reason) {
        return json({ groupMatch: publicGroupMatch(group) }, 200, REPLAYED);
      }
      throw new RequestError('match_already_revoked', 409);
    }
    mapDatabaseError(error);
  }
}

async function confirmReconciliation(request, env, id, json) {
  const data = await readJson(request);
  const note = optionalText(data.confirmationNote, 3, 1000, 'invalid_confirmation_note');
  const context = await requireContext(request, env, WRITE_ROLES);
  const actorId = context.session.user.id;
  try {
    return await env.db.transaction(async (tx) => {
      const row = await loadReconciliation(tx, id, { lock: true });
      if (!row) throw new RequestError('reconciliation_not_found', 404);
      requireYear(context, WRITE_ROLES, row.school_year_id);
      if (row.status === 'confirmed') {
        if (row.confirmed_by === actorId) return json({ reconciliation: reconciliationFromRow(row) }, 200, REPLAYED);
        throw new RequestError('reconciliation_confirmed', 409);
      }
      if (row.status === 'abandoned') throw new RequestError('reconciliation_abandoned', 409);
      // Zasada czterech oczu: zatwierdza inna osoba niż autor uzgodnienia.
      if (row.created_by === actorId) throw new RequestError('four_eyes_required', 403);
      // Kwoty powiązań sprawdzane ponownie (#165): korekta po powiązaniu albo podwójne ujęcie (#162).
      const inconsistent = await inconsistentMatches(tx, id);
      const inconsistentGroups = await inconsistentGroupMatches(tx, id);
      if (inconsistent.length || inconsistentGroups.length) {
        throw new RequestError('inconsistent_matches', 409, { matches: inconsistent, groupMatches: inconsistentGroups });
      }
      const current = reconciliationFromRow(row);
      if (current.differenceCents !== 0 && !note) throw new RequestError('difference_requires_note');
      const gate = gateFreeText([['bank_reconciliations.confirmation_note', note]], { confirm: data.confirmPersonalData === true, fail: piiFail });
      await tx.query(
        `UPDATE bank_reconciliations
            SET status = 'confirmed', confirmed_by = $2, confirmed_at = now(), confirmation_note = $3
          WHERE id = $1`,
        [id, actorId, note],
      );
      const confirmed = await loadReconciliation(tx, id);
      const result = reconciliationFromRow(confirmed);
      // Saldo mogło się zmienić od odczytu; baza przelicza je przy zatwierdzeniu.
      if (result.differenceCents !== 0 && !note) throw new RequestError('difference_requires_note');
      await insertAuditEvent(tx, {
        actorId, action: 'reconciliation.confirmed', entityType: 'bank_reconciliation', entityId: id,
        metadata: { schoolYearId: row.school_year_id, balanced: result.differenceCents === 0, ...piiAuditMetadata(gate) },
      });
      return json({ reconciliation: result }, 200, CREATED);
    });
  } catch (error) {
    if (String(error?.message ?? '').includes('bank_reconciliation_difference_explained')) {
      throw new RequestError('difference_requires_note');
    }
    // Trigger (0024) wykrył niezgodność powstałą równolegle z odczytem w trasie.
    if (String(error?.message ?? '').includes('bank_reconciliation_inconsistent_matches')) {
      throw new RequestError('inconsistent_matches', 409, {
        matches: await inconsistentMatches(env.db, id), groupMatches: await inconsistentGroupMatches(env.db, id),
      });
    }
    mapDatabaseError(error);
  }
}

// Porzucenie szkicu (0107, przegląd #344): przejście stanu, nie usunięcie —
// importy, pozycje i cofnięte powiązania zostają w historii. Porzucony szkic
// nie blokuje ponownego importu tego samego pliku do nowego szkicu. Role jak
// przy zatwierdzeniu; bez zasady czterech oczu (porzucenie nie utrwala salda
// jako uzgodnionego) — założenie do potwierdzenia przez Radę (D-13).
// Idempotencja jak przy zatwierdzeniu: ponowienie tej samej osoby z tym samym
// powodem zwraca 200 z Idempotency-Replayed: true.
async function abandonReconciliation(request, env, id, json) {
  const data = await readJson(request);
  const reason = optionalText(data.reason, 3, 500, 'invalid_reason');
  if (!reason) throw new RequestError('invalid_reason');
  const context = await requireContext(request, env, WRITE_ROLES);
  const actorId = context.session.user.id;
  try {
    return await env.db.transaction(async (tx) => {
      const row = await loadReconciliation(tx, id, { lock: true });
      if (!row) throw new RequestError('reconciliation_not_found', 404);
      requireYear(context, WRITE_ROLES, row.school_year_id);
      if (row.status === 'abandoned') {
        if (row.abandoned_by === actorId && row.abandon_reason === reason) {
          return json({ reconciliation: reconciliationFromRow(row) }, 200, REPLAYED);
        }
        throw new RequestError('reconciliation_abandoned', 409);
      }
      if (row.status !== 'draft') throw new RequestError('reconciliation_confirmed', 409);
      const active = await tx.query(
        `SELECT count(*) AS n FROM bank_reconciliation_matches
          WHERE reconciliation_id = $1 AND revoked_at IS NULL`, [id],
      );
      const activeMatchCount = toSafeInteger(active.rows[0].n);
      if (activeMatchCount > 0) {
        throw new RequestError('reconciliation_has_active_matches', 409, { activeMatchCount });
      }
      // Dopasowania zbiorcze (#390, jeśli są) sprawdza trigger bazy (0107).
      const gate = gateFreeText([['bank_reconciliations.abandon_reason', reason]], { confirm: data.confirmPersonalData === true, fail: piiFail });
      await tx.query(
        `UPDATE bank_reconciliations
            SET status = 'abandoned', abandoned_by = $2, abandoned_at = now(), abandon_reason = $3
          WHERE id = $1`,
        [id, actorId, reason],
      );
      const abandoned = await loadReconciliation(tx, id);
      await insertAuditEvent(tx, {
        actorId, action: 'reconciliation.abandoned', entityType: 'bank_reconciliation', entityId: id,
        metadata: { schoolYearId: row.school_year_id, ...piiAuditMetadata(gate) },
      });
      return json({ reconciliation: reconciliationFromRow(abandoned) }, 200, CREATED);
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}

// --- raport dla Komisji Rewizyjnej -----------------------------------------

const MAX_DATE_DEVIATIONS = 50;

// Kontrole krzyżowe raportu KR (#169). Każda porównuje dwa niezależnie liczone
// źródła (inne tabele albo inny filtr), a nie widok sam ze sobą. Wynik to
// wskaźnik z liczbami: ok = true/false, albo null, gdy kontroli nie dało się
// policzyć (np. brak zatwierdzonego uzgodnienia). Nic tu nie blokuje zapisu.
async function buildCrossChecks(executor, year, balance, latestConfirmed) {
  const yearId = year.id;
  // 1. Saldo z wpisów datowanych do ends_on (jak w uzgodnieniu) vs bilans zamknięcia
  //    z ledger_year_summary (wszystkie wpisy roku bez względu na datę).
  const atEnd = (await executor.query(
    'SELECT ledger_balance_at($1, $2::date) AS cents', [yearId, year.ends_on],
  )).rows[0];
  const balanceAtEndCents = toSafeInteger(atEnd?.cents);

  // 2. Daty spoza [starts_on, ends_on] (widok z 0027) — wiersze sprzed walidacji.
  const deviations = (await executor.query(
    `SELECT kind, id, to_char(entry_date, 'YYYY-MM-DD') AS entry_date
       FROM school_year_date_deviations WHERE school_year_id = $1
      ORDER BY entry_date, kind, id`,
    [yearId],
  )).rows;
  const deviationCount = (kind) => deviations.filter((row) => row.kind === kind).length;

  // 3. Wpłaty (moduł wpłat) vs ujęcie wpłat w księdze (#138): dwie różne tabele.
  const payments = (await executor.query(
    `SELECT
       (SELECT COALESCE(sum(p.net_amount_cents), 0) FROM payment_entry_net p
         WHERE p.school_year_id = $1 AND p.status = 'recorded') AS payments_net_cents,
       (SELECT COALESCE(sum(e.net_amount_cents), 0) FROM ledger_entry_net e
         WHERE e.school_year_id = $1 AND e.payment_entry_id IS NOT NULL) AS ledger_linked_net_cents,
       (SELECT count(*) FROM payment_entries p
         WHERE p.school_year_id = $1 AND p.status = 'recorded'
           AND NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.payment_entry_id = p.id)) AS payments_without_entry`,
    [yearId],
  )).rows[0];
  const paymentsNetCents = toSafeInteger(payments.payments_net_cents);
  const ledgerLinkedNetCents = toSafeInteger(payments.ledger_linked_net_cents);

  // 4. Powiązania pozycji wyciągu niezgodne kwotowo (#165) albo podwójne (#162).
  // Osobno liczone powiązania w uzgodnieniach JUŻ ZATWIERDZONYCH — mogą stać się
  // niezgodne dopiero po zatwierdzeniu (późniejsza korekta wpisu/wpłaty); #165
  // blokuje korektę, dopóki takie powiązanie jest aktywne w SZKICU, więc
  // niezgodność w zatwierdzonym uzgodnieniu jest tym, co KR musi wyjaśnić ręcznie
  // (zatwierdzone uzgodnienie jest niezmienne — nie ma ścieżki jego poprawy).
  const matches = (await executor.query(
    `SELECT count(*) FILTER (WHERE NOT c.amount_matches) AS amount_mismatch,
            count(*) FILTER (WHERE c.double_counted) AS double_counted,
            count(*) FILTER (WHERE NOT c.amount_matches AND r.status = 'confirmed') AS amount_mismatch_confirmed
       FROM bank_match_consistency c
       JOIN bank_reconciliations r ON r.id = c.reconciliation_id
      WHERE r.school_year_id = $1`,
    [yearId],
  )).rows[0];
  const amountMismatch = toSafeInteger(matches.amount_mismatch);
  const doubleCounted = toSafeInteger(matches.double_counted);
  const amountMismatchConfirmed = toSafeInteger(matches.amount_mismatch_confirmed);
  // Dopasowania zbiorcze (#127, 0105): suma dzisiejszego netto celów ≠ kwota pozycji
  // albo cel zmieniony po dopasowaniu. Osobne pola — liczby dla 1:1 bez zmian.
  const groups = (await executor.query(
    `SELECT count(*) FILTER (WHERE c.target_net_cents <> c.line_amount_cents OR NOT c.items_unchanged) AS mismatch,
            count(*) FILTER (WHERE (c.target_net_cents <> c.line_amount_cents OR NOT c.items_unchanged)
                               AND r.status = 'confirmed') AS mismatch_confirmed
       FROM bank_group_match_consistency c
       JOIN bank_reconciliations r ON r.id = c.reconciliation_id
      WHERE r.school_year_id = $1`,
    [yearId],
  )).rows[0];
  const groupMismatch = toSafeInteger(groups.mismatch);
  const groupMismatchConfirmed = toSafeInteger(groups.mismatch_confirmed);

  // 5. Ostatnie zatwierdzone uzgodnienie: różnica (utrwalona) i przelewy księgi po jego dacie.
  let latest = { ok: null, statementDate: null, differenceCents: null, bankEntriesAfterStatement: null };
  if (latestConfirmed) {
    const after = (await executor.query(
      `SELECT count(*) AS n FROM ledger_entries
        WHERE school_year_id = $1 AND method = 'bank' AND occurred_on > $2::date`,
      [yearId, latestConfirmed.statementDate],
    )).rows[0];
    latest = {
      ok: latestConfirmed.differenceCents === 0,
      statementDate: latestConfirmed.statementDate,
      differenceCents: latestConfirmed.differenceCents,
      bankEntriesAfterStatement: toSafeInteger(after.n),
    };
  }

  return [
    {
      id: 'year_end_balance',
      ok: balanceAtEndCents === balance.closingBalanceCents,
      closingBalanceCents: balance.closingBalanceCents,
      balanceAtYearEndCents: balanceAtEndCents,
      differenceCents: balance.closingBalanceCents - balanceAtEndCents,
    },
    {
      id: 'dates_within_school_year',
      ok: deviations.length === 0,
      ledgerEntryCount: deviationCount('ledger_entry'),
      paymentCount: deviationCount('payment_entry'),
      items: deviations.slice(0, MAX_DATE_DEVIATIONS)
        .map((row) => ({ kind: row.kind, id: row.id, date: row.entry_date })),
    },
    {
      id: 'payments_in_ledger',
      ok: paymentsNetCents === ledgerLinkedNetCents,
      paymentsNetCents,
      ledgerLinkedNetCents,
      differenceCents: paymentsNetCents - ledgerLinkedNetCents,
      paymentsWithoutLedgerEntry: toSafeInteger(payments.payments_without_entry),
    },
    {
      id: 'reconciliation_matches',
      ok: amountMismatch === 0 && doubleCounted === 0 && groupMismatch === 0,
      amountMismatchCount: amountMismatch,
      doubleCountedCount: doubleCounted,
      // #165: podzbiór powyższego — powiązania niezgodne w uzgodnieniu JUŻ
      // zatwierdzonym (niezmiennym); powstały z korekty po zatwierdzeniu.
      amountMismatchConfirmedCount: amountMismatchConfirmed,
      groupAmountMismatchCount: groupMismatch,
      groupAmountMismatchConfirmedCount: groupMismatchConfirmed,
    },
    { id: 'latest_confirmed_reconciliation', ...latest },
  ];
}

export async function buildAuditReport(executor, schoolYearId) {
  // #213: chwila migawki z now() TEJ transakcji (stała przez cały
  // REPEATABLE READ), nie z zegara procesu Node — raport i jego "asOf"
  // zawsze opisują dokładnie te dane, które poniżej odczytał.
  const asOf = (await executor.query('SELECT now() AS now')).rows[0].now;
  const year = (await executor.query(
    `SELECT id, label, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on
       FROM school_years WHERE id = $1`, [schoolYearId],
  )).rows[0];
  if (!year) return null;

  const summary = (await executor.query(
    `SELECT s.opening_balance_cents, s.income_cents, s.expense_cents, s.closing_balance_cents,
            c.opening_cash_cents, c.closing_cash_cents
       FROM ledger_year_summary s
       JOIN ledger_year_cash_summary c ON c.school_year_id = s.school_year_id
      WHERE s.school_year_id = $1`, [schoolYearId],
  )).rows[0];

  const categories = (await executor.query(
    `SELECT c.id, c.direction, c.name, count(e.id) AS entry_count,
            COALESCE(sum(e.amount_cents), 0) AS gross_cents,
            COALESCE(sum(e.corrected_cents), 0) AS corrected_cents,
            COALESCE(sum(e.net_amount_cents), 0) AS net_cents
       FROM ledger_categories c
       LEFT JOIN ledger_entry_net e ON e.category_id = c.id AND e.school_year_id = c.school_year_id
      WHERE c.school_year_id = $1
      GROUP BY c.id, c.direction, c.name, c.active
     HAVING count(e.id) > 0 OR c.active
      ORDER BY CASE c.direction WHEN 'income' THEN 0 ELSE 1 END, c.name, c.id`,
    [schoolYearId],
  )).rows.map((row) => ({
    id: row.id, direction: row.direction, name: row.name, entryCount: toSafeInteger(row.entry_count),
    grossCents: toSafeInteger(row.gross_cents), correctedCents: toSafeInteger(row.corrected_cents),
    netCents: toSafeInteger(row.net_cents),
  }));

  // #107: preliminarz (przyjęty i bieżący) a wykonanie netto per kategoria.
  const budgetExecution = await buildBudgetExecution(executor, schoolYearId);

  const largeExpenses = await buildLargeExpenses(executor, schoolYearId);

  const evidence = await buildEvidenceSection(executor, schoolYearId);

  const corrections = (await executor.query(
    `SELECT k.id, k.ledger_entry_id, to_char(e.occurred_on, 'YYYY-MM-DD') AS entry_occurred_on, e.direction,
            k.amount_cents, k.reason, k.created_by, k.created_at
       FROM ledger_corrections k JOIN ledger_entries e ON e.id = k.ledger_entry_id
      WHERE e.school_year_id = $1 ORDER BY k.created_at, k.id`,
    [schoolYearId],
  )).rows.map((row) => ({
    id: row.id, ledgerEntryId: row.ledger_entry_id, entryOccurredOn: row.entry_occurred_on,
    direction: row.direction, amountCents: toSafeInteger(row.amount_cents), reason: row.reason,
    createdBy: row.created_by, createdAt: isoTimestamp(row.created_at),
  }));

  // #144: przeksięgowania (storno + wpis zastępczy). Bez danych osobowych: kategorie,
  // kwoty, powód i identyfikatory. „Dotyka zatwierdzonego uzgodnienia” = stary wpis
  // był powiązany z pozycją wyciągu w uzgodnieniu zatwierdzonym.
  const reclassifications = (await executor.query(
    `SELECT n.id, n.replaces_entry_id, n.created_by, n.created_at, n.direction, n.method,
            n.amount_cents, to_char(n.occurred_on, 'YYYY-MM-DD') AS occurred_on,
            o.direction AS old_direction, o.method AS old_method, o.amount_cents AS old_amount_cents,
            to_char(o.occurred_on, 'YYYY-MM-DD') AS old_occurred_on,
            oc.name AS old_category, nc.name AS new_category,
            k.amount_cents AS storno_cents, k.reason AS storno_reason,
            n.payment_entry_id IS NOT NULL AS payment_linked,
            (EXISTS (SELECT 1 FROM bank_reconciliation_matches m
                       JOIN bank_reconciliations r ON r.id = m.reconciliation_id
                      WHERE m.ledger_entry_id = o.id AND m.revoked_at IS NULL AND r.status = 'confirmed')
             OR EXISTS (SELECT 1 FROM bank_group_match_items_current i
                          JOIN bank_reconciliations r ON r.id = i.reconciliation_id
                         WHERE i.ledger_entry_id = o.id AND r.status = 'confirmed')) AS in_confirmed_reconciliation
       FROM ledger_entries n
       JOIN ledger_entries o ON o.id = n.replaces_entry_id
       JOIN ledger_categories oc ON oc.id = o.category_id
       JOIN ledger_categories nc ON nc.id = n.category_id
       LEFT JOIN ledger_corrections k ON k.ledger_entry_id = o.id AND k.idempotency_key LIKE 'ledrepl-storno-%'
      WHERE n.school_year_id = $1
      ORDER BY n.created_at, n.id`,
    [schoolYearId],
  )).rows.map((row) => ({
    id: row.id, replacesEntryId: row.replaces_entry_id, createdAt: isoTimestamp(row.created_at), createdBy: row.created_by,
    oldOccurredOn: row.old_occurred_on, occurredOn: row.occurred_on,
    oldDirection: row.old_direction, direction: row.direction,
    oldMethod: row.old_method, method: row.method,
    oldCategory: row.old_category, newCategory: row.new_category,
    stornoCents: toSafeInteger(row.storno_cents ?? 0), amountCents: toSafeInteger(row.amount_cents),
    reason: String(row.storno_reason ?? '').replace(/^Przeksięgowanie: /, ''),
    paymentLinked: row.payment_linked, inConfirmedReconciliation: row.in_confirmed_reconciliation,
  }));

  // #117: wynik wydarzeń z centrów kosztów (przypisania bieżących wersji), z tej samej
  // migawki co reszta raportu. Tylko nazwa wydarzenia i kwoty — bez danych osobowych.
  const eventResults = await costCenterReport(executor, schoolYearId, 'event');
  const resolutionExecution = await buildResolutionExecution(executor, schoolYearId);
  const expenseReviews = await buildExpenseReviews(executor, schoolYearId);

  const openingAdjustments = (await executor.query(
    `SELECT a.id, a.amount_cents, a.reason, a.created_by, a.created_at
       FROM ledger_opening_balance_adjustments a
       JOIN ledger_opening_balances o ON o.id = a.opening_balance_id
      WHERE o.school_year_id = $1 ORDER BY a.created_at, a.id`,
    [schoolYearId],
  )).rows.map((row) => ({
    id: row.id, amountCents: toSafeInteger(row.amount_cents), reason: row.reason,
    createdBy: row.created_by, createdAt: isoTimestamp(row.created_at),
  }));

  const reconciliationRows = (await executor.query(
    `SELECT ${RECONCILIATION_COLUMNS},
            (SELECT count(*) FROM bank_statement_lines l
              WHERE l.reconciliation_id = r.id AND NOT EXISTS (
                SELECT 1 FROM bank_reconciliation_matches m
                 WHERE m.statement_line_id = l.id AND m.revoked_at IS NULL)
                AND NOT EXISTS (
                SELECT 1 FROM bank_reconciliation_group_matches_current g
                 WHERE g.statement_line_id = l.id)) AS unmatched_line_count
       FROM bank_reconciliations r
      WHERE r.school_year_id = $1
      ORDER BY r.statement_date, r.created_at, r.id`,
    [schoolYearId],
  )).rows;
  const items = reconciliationRows.map((row) => {
    const item = reconciliationFromRow(row);
    return {
      id: item.id, statementDate: item.statementDate, status: item.status,
      statementBalanceCents: item.statementBalanceCents, ledgerBalanceCents: item.ledgerBalanceCents,
      ledgerNonBankCents: item.ledgerNonBankCents, differenceCents: item.differenceCents,
      unmatchedLineCount: toSafeInteger(row.unmatched_line_count),
      createdBy: item.createdBy, confirmedBy: item.confirmedBy, confirmedAt: item.confirmedAt,
      confirmationNote: item.confirmationNote,
      abandonedAt: item.abandonedAt, abandonReason: item.abandonReason,
    };
  });
  const confirmed = items.filter((item) => item.status === 'confirmed');

  const balance = {
    openingBalanceCents: toSafeInteger(summary?.opening_balance_cents),
    incomeCents: toSafeInteger(summary?.income_cents),
    expenseCents: toSafeInteger(summary?.expense_cents),
    closingBalanceCents: toSafeInteger(summary?.closing_balance_cents),
    // Podział rachunek/kasa (#199): kasa = środki poza rachunkiem.
    openingCashCents: toSafeInteger(summary?.opening_cash_cents),
    closingCashCents: toSafeInteger(summary?.closing_cash_cents),
  };
  balance.openingBankCents = balance.openingBalanceCents - balance.openingCashCents;
  balance.closingBankCents = balance.closingBalanceCents - balance.closingCashCents;
  const checks = await buildCrossChecks(executor, year, balance, confirmed.at(-1) ?? null);

  return {
    schoolYear: { id: year.id, label: year.label, startsOn: year.starts_on, endsOn: year.ends_on },
    // #213: asOf = chwila migawki, z której pochodzą WSZYSTKIE liczby raportu
    // (now() transakcji REPEATABLE READ). generatedAt zostaje dla zgodności
    // wstecznej (panel audit/, archiwalne odczyty) i ma tę samą wartość.
    asOf: isoTimestamp(asOf),
    generatedAt: isoTimestamp(asOf),
    balance,
    categories,
    budgetExecution,
    largeExpenseThresholdCents: LARGE_EXPENSE_CENTS,
    largeExpenses,
    eventResults: {
      events: eventResults.centers.map((c) => ({
        id: c.id, title: c.name, status: c.status, entryCount: c.entryCount,
        incomeCents: c.incomeCents, expenseCents: c.expenseCents, resultCents: c.resultCents,
      })),
      unallocated: eventResults.general,
      totals: eventResults.totals,
    },
    resolutionExecution,
    expenseReviews,
    corrections,
    reclassifications,
    openingAdjustments,
    reconciliations: {
      items,
      confirmedCount: confirmed.length,
      draftCount: items.filter((item) => item.status === 'draft').length,
      abandonedCount: items.filter((item) => item.status === 'abandoned').length,
      latestConfirmed: confirmed.at(-1) ?? null,
    },
    checks: {
      items: checks,
      largeExpensesWithoutAdoptedResolution: largeExpenses.filter((item) => item.flagged).length,
    },
    evidence,
  };
}

// Wydatki powyżej progu 3000 EUR wraz z powiązaniem z uchwałą (raport KR, #93; lista
// kontrolna zamknięcia roku, #80 — tylko liczby). Jedno źródło reguły „flagged”.
export async function buildLargeExpenses(executor, schoolYearId) {
  // Widok z 0009_meetings.sql; bez niego zgodność z uchwałą pozostaje niesprawdzona.
  const linksView = (await executor.query("SELECT to_regclass('ledger_resolution_links') IS NOT NULL AS present")).rows[0];
  const hasLinks = Boolean(linksView?.present);
  return (await executor.query(
    `SELECT e.id, to_char(e.occurred_on, 'YYYY-MM-DD') AS occurred_on, e.amount_cents, e.net_amount_cents,
            e.description, c.name AS category, e.resolution_reference,
            ${hasLinks ? 'link.resolution_id' : 'NULL::text AS resolution_id'},
            le.resolution_id AS explicit_resolution_id, explicit.status AS explicit_status
       FROM ledger_entry_net e
       JOIN ledger_categories c ON c.id = e.category_id
       JOIN ledger_entries le ON le.id = e.id
       -- #93: jawne powiązanie (resolution_id) — stan bieżącej rewizji uchwały.
       LEFT JOIN LATERAL (
         SELECT rs.status FROM resolution_spending rs
          WHERE le.resolution_id IN (SELECT resolution_chain_ids(rs.resolution_id)) LIMIT 1
       ) explicit ON le.resolution_id IS NOT NULL
       ${hasLinks ? 'LEFT JOIN ledger_resolution_links link ON link.ledger_entry_id = e.id' : ''}
      WHERE e.school_year_id = $1 AND e.direction = 'expense' AND e.amount_cents > $2
      ORDER BY e.occurred_on, e.id`,
    [schoolYearId, LARGE_EXPENSE_CENTS],
  )).rows.map((row) => ({
    id: row.id,
    occurredOn: row.occurred_on,
    amountCents: toSafeInteger(row.amount_cents),
    netAmountCents: toSafeInteger(row.net_amount_cents),
    description: row.description,
    category: row.category,
    resolutionReference: row.resolution_reference ?? null,
    resolutionId: row.explicit_resolution_id ?? row.resolution_id ?? null,
    // #93: 'explicit' = wskazana przy zapisie (resolution_id), 'text' = dopasowanie po numerze.
    resolutionLink: row.explicit_resolution_id ? 'explicit' : 'text',
    matchesAdoptedResolution: row.explicit_resolution_id ? row.explicit_status === 'adopted'
      : (hasLinks ? Boolean(row.resolution_id) : null),
    flagged: row.explicit_resolution_id ? row.explicit_status !== 'adopted' : !row.resolution_id,
  }));
}

// #87: dowody wydatków dla Komisji Rewizyjnej. Liczą się wydatki z netto > 0
// (wpis skorygowany do zera, np. storno przy przeksięgowaniu, nie wymaga już
// dowodu). Dowodem jest dokument główny (source_document_id) albo dokument
// dołączony przez documents.linked_entity_*. „Możliwy duplikat” = ten sam
// plik (sha256; dla wierszy bez skrótu — ten sam dokument) przy więcej niż
// jednym wydatku — informacja do sprawdzenia, nie zarzut. Numer faktury i
// wystawca (tabela ledger_entry_evidence z #87) wymagają osobnej migracji.
export async function buildEvidenceSection(executor, schoolYearId) {
  const evidenceCte = `WITH expense AS (
      SELECT e.id, e.occurred_on, e.description, e.net_amount_cents, e.category_id
        FROM ledger_entry_net e
       WHERE e.school_year_id = $1 AND e.direction = 'expense' AND e.net_amount_cents > 0
    ), evidence AS (
      SELECT x.id AS ledger_entry_id, l.source_document_id AS document_id
        FROM expense x JOIN ledger_entries l ON l.id = x.id
       WHERE l.source_document_id IS NOT NULL
      UNION
      SELECT x.id, d.id FROM expense x
        JOIN documents d ON d.linked_entity_type = 'ledger_entry' AND d.linked_entity_id = x.id
    )`;
  const missingRows = (await executor.query(
    `${evidenceCte}
     SELECT x.id, to_char(x.occurred_on, 'YYYY-MM-DD') AS occurred_on, x.description, x.net_amount_cents,
            c.name AS category
       FROM expense x JOIN ledger_categories c ON c.id = x.category_id
      WHERE NOT EXISTS (SELECT 1 FROM evidence v WHERE v.ledger_entry_id = x.id)
      ORDER BY x.occurred_on, x.id`,
    [schoolYearId],
  )).rows;
  const duplicateRows = (await executor.query(
    `${evidenceCte}
     SELECT COALESCE(d.sha256, v.document_id) AS evidence_key,
            array_agg(DISTINCT v.document_id ORDER BY v.document_id) AS document_ids,
            array_agg(DISTINCT v.ledger_entry_id ORDER BY v.ledger_entry_id) AS ledger_entry_ids
       FROM evidence v LEFT JOIN documents d ON d.id = v.document_id
      GROUP BY COALESCE(d.sha256, v.document_id)
     HAVING count(DISTINCT v.ledger_entry_id) > 1
      ORDER BY 1`,
    [schoolYearId],
  )).rows;
  const withoutEvidence = missingRows.map((row) => ({
    id: row.id, occurredOn: row.occurred_on, category: row.category, description: row.description,
    netAmountCents: toSafeInteger(row.net_amount_cents),
  }));
  return {
    expensesWithoutEvidence: {
      count: withoutEvidence.length,
      netCents: withoutEvidence.reduce((sum, item) => sum + item.netAmountCents, 0),
      items: withoutEvidence,
    },
    possibleDuplicateEvidence: duplicateRows.map((row) => ({
      documentIds: row.document_ids, ledgerEntryIds: row.ledger_entry_ids,
    })),
  };
}

// #93: wykonanie uchwał finansowych — uchwały roku (albo powiązane z wydatkiem
// tego roku) z kwotą upoważnienia i sumą netto wydatków (po korektach).
// Oznaczone: uchwała nie jest już przyjęta (np. poprawka zmieniła stan na
// „odrzucona”) albo suma przekracza kwotę.
async function buildResolutionExecution(executor, schoolYearId) {
  const { rows } = await executor.query(
    `SELECT rs.resolution_id, rs.school_year_id, rs.number, rs.title, rs.status, rs.authorized_amount_cents,
            to_char(rs.valid_until, 'YYYY-MM-DD') AS valid_until, rs.spent_net_cents, rs.remaining_cents, rs.entry_count
       FROM resolution_spending rs
      WHERE rs.school_year_id = $1 OR EXISTS (
        SELECT 1 FROM ledger_entries e
         WHERE e.school_year_id = $1 AND e.resolution_id IN (SELECT resolution_chain_ids(rs.resolution_id)))
      ORDER BY rs.number COLLATE "C", rs.resolution_id`,
    [schoolYearId],
  );
  return rows.map((row) => {
    const authorized = row.authorized_amount_cents === null ? null : toSafeInteger(row.authorized_amount_cents);
    const remaining = authorized === null ? null : toSafeInteger(row.remaining_cents);
    return {
      resolutionId: row.resolution_id, schoolYearId: row.school_year_id, number: row.number, title: row.title,
      status: row.status, authorizedAmountCents: authorized, validUntil: row.valid_until ?? null,
      spentNetCents: toSafeInteger(row.spent_net_cents), remainingCents: remaining,
      entryCount: toSafeInteger(row.entry_count),
      flagged: row.status !== 'adopted' || (remaining !== null && remaining < 0),
    };
  });
}

const SPLIT_WINDOW_DAYS = 30;

// #97: weryfikacja wydatków przez drugą osobę i sygnał możliwego podziału
// wydatku (kilka wydatków ≤ 3000 EUR w tej samej kategorii w oknie 30 dni,
// razem > 3000 EUR). Informacja do sprawdzenia, nie zarzut. Liczone są wydatki
// z netto > 0 (wpis skorygowany do zera nie wymaga weryfikacji).
async function buildExpenseReviews(executor, schoolYearId) {
  const { rows } = await executor.query(
    `SELECT e.id, to_char(e.occurred_on, 'YYYY-MM-DD') AS occurred_on, e.net_amount_cents, e.category_id,
            c.name AS category, s.review_status
       FROM ledger_entry_net e
       JOIN ledger_categories c ON c.id = e.category_id
       JOIN ledger_entry_review_status s ON s.ledger_entry_id = e.id
      WHERE e.school_year_id = $1 AND e.direction = 'expense' AND e.net_amount_cents > 0
      ORDER BY e.category_id, e.occurred_on, e.id`,
    [schoolYearId],
  );
  const expenses = rows.map((row) => ({
    id: row.id, occurredOn: row.occurred_on, netCents: toSafeInteger(row.net_amount_cents),
    categoryId: row.category_id, category: row.category, reviewStatus: row.review_status,
  }));
  const tally = (status) => {
    const matching = expenses.filter((item) => item.reviewStatus === status);
    return { count: matching.length, netCents: matching.reduce((sum, item) => sum + item.netCents, 0) };
  };
  const day = (text) => Date.parse(`${text}T00:00:00Z`) / 86_400_000;
  const possibleSplits = [];
  const small = expenses.filter((item) => item.netCents <= LARGE_EXPENSE_CENTS);
  let index = 0;
  while (index < small.length) {
    const start = small[index];
    const window = small.filter((item) => item.categoryId === start.categoryId
      && day(item.occurredOn) >= day(start.occurredOn) && day(item.occurredOn) < day(start.occurredOn) + SPLIT_WINDOW_DAYS);
    const total = window.reduce((sum, item) => sum + item.netCents, 0);
    if (window.length > 1 && total > LARGE_EXPENSE_CENTS) {
      possibleSplits.push({
        category: start.category, fromDate: start.occurredOn, toDate: window.at(-1).occurredOn,
        entryCount: window.length, netCents: total, ledgerEntryIds: window.map((item) => item.id),
      });
      // Następne okno zaczyna się po ostatnim wpisie tego okna (bez powtórzeń).
      index = small.indexOf(window.at(-1)) + 1;
    } else {
      index += 1;
    }
  }
  return {
    unverified: tally('unverified'),
    verified: tally('verified'),
    questioned: tally('questioned'),
    questionedEntryIds: expenses.filter((item) => item.reviewStatus === 'questioned').map((item) => item.id),
    splitWindowDays: SPLIT_WINDOW_DAYS,
    possibleSplits,
  };
}

async function auditReport(request, env, url, json) {
  const schoolYearId = url.searchParams.get('schoolYearId');
  const format = url.searchParams.get('format') ?? 'json';
  if (!validId(schoolYearId) || !['json', 'html', 'xlsx'].includes(format)) throw new RequestError('invalid_request');
  const context = await loadAuthorizationContext(request, env);
  if (!context) throw new RequestError('unauthenticated', 401);
  if (!isAuthorizedScoped(context, { roles: REPORT_ROLES, schoolYearId, requireMfa: true })) {
    const via = await archiveReadVia(env.db, context, schoolYearId, ARCHIVE_REPORT_ROLES);
    if (!via) {
      // #161: sam brak MFA (rola audit/board/treasurer i rok pasują) zwraca
      // mfa_required/mfa_enrollment_required zamiast ogólnego forbidden.
      const code = await mfaAwareForbiddenCode(context, { roles: REPORT_ROLES, schoolYearId, requireMfa: true }, env);
      throw new RequestError(code, 403);
    }
    await recordArchiveRead(env.db, {
      actorId: context.session.user.id, schoolYearId, viaSchoolYearId: via, route: 'reports.audit',
    });
  }
  // #213: jedna migawka REPEATABLE READ dla całego raportu — inaczej równoległy
  // zapis między którymikolwiek z zapytań buildAuditReport (bilans, kategorie,
  // korekty, uzgodnienia...) na osobnych połączeniach z puli daje wewnętrznie
  // sprzeczny wynik (patrz opis w issue: "sumy kategorii nie są zgodne z
  // bilansem" mimo poprawnej księgi).
  const report = await readSnapshot(env.db, (tx) => buildAuditReport(tx, schoolYearId));
  if (!report) throw new RequestError('school_year_not_found', 404);
  // #141: skrót treści (bez asOf/generatedAt) — ten sam dla JSON, HTML i XLSX
  // z tych samych danych; w zdarzeniu jako dowód, którą wersję pobrano (bez kwot).
  const contentSha256 = await auditReportContentSha256(report);
  await insertAuditEvent(env.db, {
    actorId: context.session.user.id, action: 'report.audit.generated', entityType: 'school_year',
    entityId: schoolYearId, metadata: { schoolYearId, format, asOf: report.asOf, contentSha256 },
  });
  if (format === 'json') return json({ report });
  if (format === 'xlsx') {
    return xlsxResponse(buildAuditReportXlsx(report, { contentSha256 }), `raport-kr-${safeFileSegment(schoolYearId)}.xlsx`, {
      'Referrer-Policy': 'no-referrer',
    });
  }
  return new Response(renderAuditReportHtml(report, { contentSha256 }), {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': await reportContentSecurityPolicy(),
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    },
  });
}

// --- router ----------------------------------------------------------------

export async function handle(request, env, url, json) {
  const path = url.pathname;
  const isReport = path === '/api/reports/audit';
  if (!isReport && path !== '/api/reconciliations' && !path.startsWith('/api/reconciliations/')) return null;
  const method = request.method;
  if (method === 'POST' && !isSameOrigin(request)) return json({ error: 'invalid_origin' }, 403);

  try {
    if (isReport) {
      if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
      return await auditReport(request, env, url, json);
    }
    if (path === '/api/reconciliations') {
      if (method === 'GET') return await listReconciliations(request, env, url, json);
      if (method === 'POST') return await createReconciliation(request, env, json);
      return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET, POST' });
    }
    const match = path.match(/^\/api\/reconciliations\/([^/]+)(?:\/(lines|suggestions|matches|group-matches|confirm|abandon))?(?:\/([^/]+)\/(revocation|payment)|\/(batch))?$/);
    if (!match) return null;
    const id = decodeId(match[1]);
    const action = match[2] ?? null;
    const subAction = match[4] ?? null;
    if (subAction === 'revocation' && action !== 'matches' && action !== 'group-matches') return null;
    if (subAction === 'payment' && action !== 'lines') return null;
    const batch = match[5] === 'batch';
    if (batch && action !== 'matches') return null;
    if (!action && method === 'GET') return await getReconciliation(request, env, id, url, json);
    if (action === 'suggestions' && method === 'GET') return await suggestMatches(request, env, id, url, json);
    if (method !== 'POST') {
      // GET, HEAD i inne — jedyne trasy tej ścieżki bez akcji/z 'suggestions' dopuszczają GET,
      // reszta akcji (lines/matches/group-matches/confirm/abandon/revocation/payment) wyłącznie POST.
      const allow = (!action || action === 'suggestions') ? 'GET' : 'POST';
      return json({ error: 'method_not_allowed' }, 405, { Allow: allow });
    }
    if (action === 'lines' && subAction === 'payment') return await createPaymentFromLine(request, env, id, decodeId(match[3]), json);
    if (action === 'lines') return await importLines(request, env, id, json);
    if (action === 'matches' && batch) return await confirmMatchBatch(request, env, id, json);
    if (action === 'matches' && subAction === 'revocation') return await revokeMatch(request, env, id, decodeId(match[3]), json);
    if (action === 'matches') return await confirmMatch(request, env, id, json);
    if (action === 'group-matches' && subAction === 'revocation') return await revokeGroupMatch(request, env, id, decodeId(match[3]), json);
    if (action === 'group-matches') return await confirmGroupMatch(request, env, id, json);
    if (action === 'confirm') return await confirmReconciliation(request, env, id, json);
    if (action === 'abandon') return await abandonReconciliation(request, env, id, json);
    return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.code, ...error.extra }, error.status);
    throw error;
  }
}
