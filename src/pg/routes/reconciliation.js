// Uzgodnienie rachunku bankowego z księgą i raport dla Komisji Rewizyjnej
// (issue #7, przygotowanie #15). Prototyp — nie jest wdrożony.
//
//   GET  /api/reconciliations?schoolYearId=…
//   POST /api/reconciliations                                 (Idempotency-Key)
//   GET  /api/reconciliations/{id}
//   POST /api/reconciliations/{id}/lines                      (Idempotency-Key) JSON lines albo CSV
//   POST /api/reconciliations/{id}/lines/{lineId}/payment      (Idempotency-Key) wpłata + powiązanie naraz (#115)
//   GET  /api/reconciliations/{id}/suggestions?windowDays=…   tylko propozycje, nigdy zatwierdzenie
//   POST /api/reconciliations/{id}/matches                    (Idempotency-Key)
//   POST /api/reconciliations/{id}/matches/{matchId}/revocation
//   POST /api/reconciliations/{id}/confirm                    zasada czterech oczu
//   GET  /api/reports/audit?schoolYearId=…&format=json|html
//
// Uzgodnienia: admin, board, treasurer z MFA w zakresie roku. Raport: audit,
// board, treasurer z MFA. Saldo księgi wylicza baza (0015_reconciliation.sql);
// klient podaje wyłącznie saldo z wyciągu. Treść tytułu przelewu nie jest
// zapisywana — tylko solony skrót SHA-256 (docs/RECONCILIATION.md).

import { isSameOrigin } from '../../auth.js';
import { isoTimestamp } from '../auth.js';
import { isAuthorizedScoped, loadAuthorizationContext, mfaAwareForbiddenCode } from '../authorization.js';
import { insertAuditEvent } from '../audit.js';
import { toSafeInteger } from './payments.js';
import { MoneyError, parseStatementAmount } from '../../../panel/money.js';
import { reportContentSecurityPolicy, renderAuditReportHtml } from '../audit-report.js';
import { archiveReadVia, recordArchiveRead } from '../archive-access.js';
import { readSnapshot } from '../db-snapshot.js';

export const name = 'reconciliation';

const WRITE_ROLES = ['admin', 'board', 'treasurer'];
const REPORT_ROLES = ['audit', 'board', 'treasurer'];
// Raport zamkniętego roku (#195, tylko odczyt): zarząd/skarbnik roku następnego i admin.
const ARCHIVE_REPORT_ROLES = ['board', 'treasurer'];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_IMPORT_BYTES = 256 * 1024;
const MAX_LINES = 500;
const MAX_LINE_CENTS = 100_000_000;
const MAX_BALANCE_CENTS = 10_000_000_000;
const MAX_REFERENCE_LENGTH = 300;
const LARGE_EXPENSE_CENTS = 300_000;
const MAX_CANDIDATES = 5;

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

async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  const type = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw new RequestError('invalid_content_type', 415);
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new RequestError('request_too_large', 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new RequestError('request_too_large', 413);
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new RequestError('invalid_json');
  }
}

function readIdempotencyKey(request) {
  const key = request.headers.get('Idempotency-Key')?.trim();
  if (!key || !IDEMPOTENCY_PATTERN.test(key)) throw new RequestError('invalid_idempotency_key');
  return key;
}

function isUniqueError(error) {
  return error?.code === '23505';
}

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

function parseCsvRows(text) {
  const source = text.replace(/^﻿/, '');
  const firstLine = source.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === delimiter) { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += char;
  }
  if (quoted) throw new RequestError('invalid_csv');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
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

function parseStatementLines(data) {
  const hasLines = data.lines !== undefined;
  const hasCsv = data.csv !== undefined;
  if (hasLines === hasCsv) throw new RequestError('invalid_request');
  let source;
  let lines;
  if (hasCsv) {
    source = 'csv';
    lines = parseStatementCsv(data.csv);
  } else {
    if (!Array.isArray(data.lines)) throw new RequestError('invalid_request');
    source = 'manual';
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

// --- mapowanie wierszy -------------------------------------------------------

const RECONCILIATION_COLUMNS = `r.id, r.school_year_id, to_char(r.statement_date, 'YYYY-MM-DD') AS statement_date,
  r.statement_balance_cents,
  CASE WHEN r.status = 'draft' THEN ledger_balance_at(r.school_year_id, r.statement_date)
       ELSE r.ledger_balance_cents END AS ledger_balance_cents,
  CASE WHEN r.status = 'draft' THEN ledger_non_bank_net_at(r.school_year_id, r.statement_date)
       ELSE r.ledger_non_bank_cents END AS ledger_non_bank_cents,
  r.status, r.notes, r.reference_salt, r.created_by, r.created_at, r.confirmed_by, r.confirmed_at,
  r.confirmation_note`;

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
  };
}

function matchFromRow(row) {
  return {
    id: row.id,
    reconciliationId: row.reconciliation_id,
    statementLineId: row.statement_line_id,
    ledgerEntryId: row.ledger_entry_id ?? null,
    paymentEntryId: row.payment_entry_id ?? null,
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
  if (message.includes('bank_reconciliation_date_outside_year')) throw new RequestError('statement_date_outside_school_year');
  if (message.includes('bank_statement_line_after_statement_date')) throw new RequestError('statement_line_after_statement_date');
  if (message.includes('bank_match_amount_mismatch')) throw new RequestError('match_amount_mismatch', 409);
  // Wpłata i wpis księgi, który ją ujmuje, to te same pieniądze (#162, 0024).
  if (message.includes('bank_match_already_matched_via_ledger')) throw new RequestError('already_matched_via_ledger', 409);
  if (message.includes('bank_match_already_matched_via_payment')) throw new RequestError('already_matched_via_payment', 409);
  if (message.includes('bank_match_method_mismatch')) throw new RequestError('match_method_mismatch', 409);
  if (message.includes('bank_match_target_mismatch')) throw new RequestError('invalid_match_target');
  if (message.includes('bank_match_line_mismatch')) throw new RequestError('invalid_statement_line');
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
        metadata: { schoolYearId: input.schoolYearId },
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
    `SELECT match_id, statement_line_id, ledger_entry_id, payment_entry_id, line_amount_cents, target_net_cents,
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
    lineAmountCents: toSafeInteger(row.line_amount_cents),
    targetNetCents: row.target_net_cents === null ? null : toSafeInteger(row.target_net_cents),
    reasons: [...(row.amount_matches ? [] : ['amount_mismatch']), ...(row.double_counted ? ['double_counted'] : [])],
  }));
}

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

  const { reconciliation, lines, matches, entries, inconsistent, summaryRow } = await readSnapshot(env.db, async (tx) => {
    const row = await loadReconciliation(tx, id);
    if (!row) throw new RequestError('reconciliation_not_found', 404);
    requireYear(context, WRITE_ROLES, row.school_year_id);
    const linesResult = await tx.query(
      `SELECT l.id, l.import_id, i.source, l.line_no, to_char(l.booked_on, 'YYYY-MM-DD') AS booked_on,
              l.amount_cents, l.reference_hash IS NOT NULL AS has_reference,
              m.id AS match_id, m.ledger_entry_id, m.payment_entry_id
         FROM bank_statement_lines l
         JOIN bank_statement_imports i ON i.id = l.import_id
         LEFT JOIN bank_reconciliation_matches m ON m.statement_line_id = l.id AND m.revoked_at IS NULL
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
        ORDER BY e.occurred_on, e.id
        LIMIT 1001`,
      [row.school_year_id, row.statement_date, id],
    );
    const inconsistentResult = await inconsistentMatches(tx, id);
    // Podsumowanie liczone niezależnie od stronicowania `lines` (#218): stronicowanie
    // pokazuje tylko jedną stronę pozycji, ale liczby w summary muszą objąć wszystkie.
    const summaryResult = await tx.query(
      `SELECT count(*) AS line_count, count(m.id) AS matched_line_count,
              COALESCE(sum(l.amount_cents) FILTER (WHERE m.id IS NULL), 0) AS unmatched_line_total_cents
         FROM bank_statement_lines l
         LEFT JOIN bank_reconciliation_matches m ON m.statement_line_id = l.id AND m.revoked_at IS NULL
        WHERE l.reconciliation_id = $1`,
      [id],
    );
    return {
      reconciliation: reconciliationFromRow(row), lines: linesResult, matches: matchesResult,
      entries: entriesResult, inconsistent: inconsistentResult, summaryRow: summaryResult,
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
      ? { id: line.match_id, ledgerEntryId: line.ledger_entry_id ?? null, paymentEntryId: line.payment_entry_id ?? null }
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
  const matchedLineCount = rawMatchedLineCount - inconsistentMatchCount;
  return json({
    reconciliation,
    lines: lineItems,
    nextCursor,
    matches: matches.rows.map(matchFromRow),
    summary: {
      lineCount,
      matchedLineCount,
      unmatchedLineCount: lineCount - rawMatchedLineCount,
      unmatchedLineTotalCents: toSafeInteger(summary.unmatched_line_total_cents),
      inconsistentMatchCount,
    },
    inconsistentMatches: inconsistent,
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

  const byKey = async (executor) => (await executor.query(
    'SELECT id, reconciliation_id, source, line_count, request_hash, created_by FROM bank_statement_imports WHERE idempotency_key = $1',
    [idempotencyKey],
  )).rows[0] ?? null;

  let requestHash;
  const replayOrConflict = (row) => {
    if (!row) return null;
    if (row.created_by !== actorId || row.reconciliation_id !== id || row.request_hash !== requestHash) {
      throw new RequestError('idempotency_conflict', 409);
    }
    return json({ import: { id: row.id, reconciliationId: id, source: row.source, lineCount: row.line_count } }, 200, REPLAYED);
  };

  try {
    return await env.db.transaction(async (tx) => {
      const row = await loadReconciliation(tx, id, { lock: true });
      if (!row) throw new RequestError('reconciliation_not_found', 404);
      requireYear(context, WRITE_ROLES, row.school_year_id);
      const hashed = await Promise.all(input.lines.map(async (line) => ({
        ...line, referenceHash: line.reference ? await sha256Hex(`${row.reference_salt}:${line.reference}`) : null,
      })));
      requestHash = await sha256Hex(JSON.stringify([input.source,
        hashed.map((line) => [line.bookedOn, line.amountCents, line.referenceHash])]));
      const replay = replayOrConflict(await byKey(tx));
      if (replay) return replay;
      if (row.status !== 'draft') throw new RequestError('reconciliation_confirmed', 409);

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
      if (hashed.length > 0) {
        await tx.query(
          `INSERT INTO bank_statement_lines (id, reconciliation_id, import_id, line_no, booked_on, amount_cents, reference_hash, created_by)
           SELECT t.id, $1, $2, t.line_no, t.booked_on, t.amount_cents, t.reference_hash, $3
             FROM unnest($4::text[], $5::int[], $6::date[], $7::bigint[], $8::text[])
                  AS t(id, line_no, booked_on, amount_cents, reference_hash)`,
          [id, importId, actorId,
            hashed.map(() => crypto.randomUUID()),
            hashed.map((_, index) => index + 1),
            hashed.map((line) => line.bookedOn),
            hashed.map((line) => line.amountCents),
            hashed.map((line) => line.referenceHash)],
        );
      }
      // Możliwe duplikaty z wcześniejszych importów (ta sama data, kwota i skrót tytułu).
      const duplicates = await tx.query(
        `SELECT count(*) AS n FROM bank_statement_lines l
          WHERE l.import_id = $1 AND EXISTS (
            SELECT 1 FROM bank_statement_lines o
             WHERE o.reconciliation_id = l.reconciliation_id AND o.import_id <> l.import_id
               AND o.booked_on = l.booked_on AND o.amount_cents = l.amount_cents
               AND o.reference_hash IS NOT DISTINCT FROM l.reference_hash)`,
        [importId],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'reconciliation.lines.imported', entityType: 'bank_statement_import', entityId: importId,
        metadata: { reconciliationId: id, source: input.source, lineCount: hashed.length, schoolYearId: row.school_year_id },
      });
      return json({
        import: { id: importId, reconciliationId: id, source: input.source, lineCount: hashed.length },
        possibleDuplicateCount: toSafeInteger(duplicates.rows[0].n),
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

async function suggestMatches(request, env, id, url, json) {
  const windowText = url.searchParams.get('windowDays') ?? '7';
  if (!/^\d{1,2}$/.test(windowText) || Number(windowText) > 31) throw new RequestError('invalid_window');
  const windowDays = Number(windowText);
  const { row } = await loadAuthorizedReconciliation(request, env, id);

  const openLine = `l.reconciliation_id = $1 AND NOT EXISTS (
      SELECT 1 FROM bank_reconciliation_matches m WHERE m.statement_line_id = l.id AND m.revoked_at IS NULL)`;
  // Zapas ponad limit odpowiedzi (#158): dopasowanie po tytule (referenceMatch)
  // liczone jest dopiero w JS, więc SQL musi przepuścić więcej niż MAX_CANDIDATES,
  // żeby kandydat z trafionym tytułem, ale dalszą datą, mógł wypchnąć bliższego
  // dniowo, ale bez zgodności tytułu, kandydata na pierwsze miejsce.
  const candidateLimit = MAX_CANDIDATES * 4;
  // Jedna migawka (REPEATABLE READ, READ ONLY) na jednym połączeniu: równoległe
  // potwierdzenie dopasowania (POST …/matches) na innym połączeniu nie może
  // sprawić, że ta sama pozycja/kandydat wygląda inaczej w trzech zapytaniach.
  const [lines, ledger, payments] = await env.db.transaction(async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const linesResult = await tx.query(
      `SELECT l.id, to_char(l.booked_on, 'YYYY-MM-DD') AS booked_on, l.amount_cents, l.reference_hash
         FROM bank_statement_lines l WHERE ${openLine} ORDER BY l.booked_on, l.id`,
      [id],
    );
    const ledgerResult = await tx.query(
      `SELECT line_id, id, occurred_on, net_amount_cents, method, day_distance FROM (
         SELECT l.id AS line_id, e.id, to_char(e.occurred_on, 'YYYY-MM-DD') AS occurred_on, e.net_amount_cents,
                e.method, abs(e.occurred_on - l.booked_on) AS day_distance,
                row_number() OVER (PARTITION BY l.id ORDER BY abs(e.occurred_on - l.booked_on), e.id) AS rn
           FROM bank_statement_lines l
           JOIN ledger_entry_net e ON e.school_year_id = $2
            AND (CASE WHEN e.direction = 'income' THEN e.net_amount_cents ELSE -e.net_amount_cents END) = l.amount_cents
            AND e.occurred_on BETWEEN l.booked_on - $3::int AND l.booked_on + $3::int
          WHERE ${openLine}
            AND NOT EXISTS (SELECT 1 FROM bank_reconciliation_matches m
                             WHERE m.reconciliation_id = $1 AND m.ledger_entry_id = e.id AND m.revoked_at IS NULL)
         ) ranked WHERE rn <= $4
        ORDER BY line_id, day_distance, id`,
      [id, row.school_year_id, windowDays, candidateLimit],
    );
    // Wpłaty nieujęte jeszcze w księdze (wpłata ujęta w księdze jest proponowana jako wpis księgi).
    const paymentsResult = await tx.query(
      `SELECT line_id, id, received_on, reference, method, net_amount_cents, day_distance FROM (
         SELECT l.id AS line_id, p.id, to_char(p.received_on, 'YYYY-MM-DD') AS received_on, p.reference,
                p.method, p.amount_cents - COALESCE(c.corrected, 0) AS net_amount_cents,
                abs(p.received_on - l.booked_on) AS day_distance,
                row_number() OVER (PARTITION BY l.id ORDER BY abs(p.received_on - l.booked_on), p.id) AS rn
           FROM bank_statement_lines l
           JOIN payment_entries p ON p.school_year_id = $2 AND p.status IN ('recorded', 'unmatched')
            AND p.method = 'bank'
            AND p.received_on BETWEEN l.booked_on - $3::int AND l.booked_on + $3::int
           LEFT JOIN (SELECT payment_entry_id, sum(amount_cents) AS corrected
                        FROM payment_corrections GROUP BY payment_entry_id) c ON c.payment_entry_id = p.id
          WHERE ${openLine} AND l.amount_cents > 0
            AND p.amount_cents - COALESCE(c.corrected, 0) = l.amount_cents
            AND NOT EXISTS (SELECT 1 FROM ledger_entries le WHERE le.payment_entry_id = p.id)
            AND NOT EXISTS (SELECT 1 FROM bank_reconciliation_matches m
                             WHERE m.reconciliation_id = $1 AND m.payment_entry_id = p.id AND m.revoked_at IS NULL)
         ) ranked WHERE rn <= $4
        ORDER BY line_id, day_distance, id`,
      [id, row.school_year_id, windowDays, candidateLimit],
    );
    return [linesResult, ledgerResult, paymentsResult];
  });

  const byLine = new Map(lines.rows.map((line) => [line.id, { line, candidates: [] }]));
  for (const entry of ledger.rows) {
    byLine.get(entry.line_id)?.candidates.push({
      type: 'ledger_entry', id: entry.id, date: entry.occurred_on, method: entry.method,
      amountCents: toSafeInteger(entry.net_amount_cents), dayDistance: toSafeInteger(entry.day_distance),
      referenceMatch: false,
    });
  }
  // Skrót tytułu liczony co najwyżej raz na wpłatę-kandydata w całym żądaniu
  // (#158), nawet gdy ta sama wpłata jest kandydatem dla wielu pozycji.
  const hashCache = new Map();
  const cachedHashReference = (salt, value) => {
    if (!hashCache.has(value)) hashCache.set(value, hashReference(salt, value));
    return hashCache.get(value);
  };
  for (const payment of payments.rows) {
    const slot = byLine.get(payment.line_id);
    if (!slot) continue;
    let referenceMatch = false;
    if (slot.line.reference_hash && payment.reference) {
      referenceMatch = (await cachedHashReference(row.reference_salt, payment.reference)) === slot.line.reference_hash;
    }
    slot.candidates.push({
      type: 'payment_entry', id: payment.id, date: payment.received_on, method: payment.method,
      amountCents: toSafeInteger(payment.net_amount_cents), dayDistance: toSafeInteger(payment.day_distance),
      referenceMatch,
    });
  }
  const suggestions = [...byLine.values()].map(({ line, candidates }) => ({
    statementLineId: line.id,
    bookedOn: line.booked_on,
    amountCents: toSafeInteger(line.amount_cents),
    candidates: candidates
      .sort((a, b) => Number(b.referenceMatch) - Number(a.referenceMatch) || a.dayDistance - b.dayDistance
        || (a.type === b.type ? a.id.localeCompare(b.id) : a.type === 'ledger_entry' ? -1 : 1))
      .slice(0, MAX_CANDIDATES),
  }));
  // Wyłącznie propozycje: zatwierdzenie wymaga osobnego POST …/matches.
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
      if (row.status !== 'draft') throw new RequestError('reconciliation_confirmed', 409);
      const line = await tx.query(
        `SELECT id, amount_cents, to_char(booked_on, 'YYYY-MM-DD') AS booked_on
           FROM bank_statement_lines WHERE id = $1 AND reconciliation_id = $2`,
        [lineId, id],
      );
      if (!line.rows[0]) throw new RequestError('statement_line_not_found', 404);
      const amountCents = toSafeInteger(line.rows[0].amount_cents);
      if (amountCents <= 0) throw new RequestError('statement_line_not_income');
      const taken = await tx.query(
        'SELECT 1 FROM bank_reconciliation_matches WHERE statement_line_id = $1 AND revoked_at IS NULL', [lineId],
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
  if (!validId(data.statementLineId) || (ledgerEntryId === null) === (paymentEntryId === null)
      || (ledgerEntryId !== null && !validId(ledgerEntryId)) || (paymentEntryId !== null && !validId(paymentEntryId))) {
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
        || (match.ledger_entry_id ?? null) !== ledgerEntryId || (match.payment_entry_id ?? null) !== paymentEntryId) {
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
      if (row.status !== 'draft') throw new RequestError('reconciliation_confirmed', 409);
      const taken = await tx.query(
        `SELECT 1 FROM bank_reconciliation_matches
          WHERE revoked_at IS NULL AND (statement_line_id = $1
             OR (reconciliation_id = $2 AND (ledger_entry_id = $3 OR payment_entry_id = $4)))`,
        [data.statementLineId, id, ledgerEntryId, paymentEntryId],
      );
      if (taken.rows.length) throw new RequestError('already_matched', 409);
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
      const matchId = crypto.randomUUID();
      await tx.query(
        `INSERT INTO bank_reconciliation_matches (id, reconciliation_id, statement_line_id, ledger_entry_id,
           payment_entry_id, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [matchId, id, data.statementLineId, ledgerEntryId, paymentEntryId, actorId, idempotencyKey],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'reconciliation.match.confirmed', entityType: 'bank_reconciliation_match', entityId: matchId,
        metadata: {
          reconciliationId: id, statementLineId: data.statementLineId, ledgerEntryId, paymentEntryId,
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
      if (row.status !== 'draft') throw new RequestError('reconciliation_confirmed', 409);
      const updated = await tx.query(
        `UPDATE bank_reconciliation_matches SET revoked_at = now(), revoked_by = $2, revoke_reason = $3
          WHERE id = $1 RETURNING *`,
        [matchId, actorId, reason],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'reconciliation.match.revoked', entityType: 'bank_reconciliation_match', entityId: matchId,
        metadata: { reconciliationId: id, schoolYearId: row.school_year_id },
      });
      return json({ match: matchFromRow(updated.rows[0]) }, 200, CREATED);
    });
  } catch (error) {
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
      // Zasada czterech oczu: zatwierdza inna osoba niż autor uzgodnienia.
      if (row.created_by === actorId) throw new RequestError('four_eyes_required', 403);
      // Kwoty powiązań sprawdzane ponownie (#165): korekta po powiązaniu albo podwójne ujęcie (#162).
      const inconsistent = await inconsistentMatches(tx, id);
      if (inconsistent.length) throw new RequestError('inconsistent_matches', 409, { matches: inconsistent });
      const current = reconciliationFromRow(row);
      if (current.differenceCents !== 0 && !note) throw new RequestError('difference_requires_note');
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
        metadata: { schoolYearId: row.school_year_id, balanced: result.differenceCents === 0 },
      });
      return json({ reconciliation: result }, 200, CREATED);
    });
  } catch (error) {
    if (String(error?.message ?? '').includes('bank_reconciliation_difference_explained')) {
      throw new RequestError('difference_requires_note');
    }
    // Trigger (0024) wykrył niezgodność powstałą równolegle z odczytem w trasie.
    if (String(error?.message ?? '').includes('bank_reconciliation_inconsistent_matches')) {
      throw new RequestError('inconsistent_matches', 409, { matches: await inconsistentMatches(env.db, id) });
    }
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
      ok: amountMismatch === 0 && doubleCounted === 0,
      amountMismatchCount: amountMismatch,
      doubleCountedCount: doubleCounted,
      // #165: podzbiór powyższego — powiązania niezgodne w uzgodnieniu JUŻ
      // zatwierdzonym (niezmiennym); powstały z korekty po zatwierdzeniu.
      amountMismatchConfirmedCount: amountMismatchConfirmed,
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

  // Widok z 0009_meetings.sql; bez niego zgodność z uchwałą pozostaje niesprawdzona.
  const linksView = (await executor.query("SELECT to_regclass('ledger_resolution_links') IS NOT NULL AS present")).rows[0];
  const hasLinks = Boolean(linksView?.present);
  const largeExpenses = (await executor.query(
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
                 WHERE m.statement_line_id = l.id AND m.revoked_at IS NULL)) AS unmatched_line_count
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
    generatedAt: isoTimestamp(asOf),
    balance,
    categories,
    largeExpenseThresholdCents: LARGE_EXPENSE_CENTS,
    largeExpenses,
    resolutionExecution,
    expenseReviews,
    corrections,
    openingAdjustments,
    reconciliations: {
      items,
      confirmedCount: confirmed.length,
      draftCount: items.length - confirmed.length,
      latestConfirmed: confirmed.at(-1) ?? null,
    },
    checks: {
      items: checks,
      largeExpensesWithoutAdoptedResolution: largeExpenses.filter((item) => item.flagged).length,
    },
    evidence,
  };
}

// #87: dowody wydatków dla Komisji Rewizyjnej. Liczą się wydatki z netto > 0
// (wpis skorygowany do zera, np. storno przy przeksięgowaniu, nie wymaga już
// dowodu). Dowodem jest dokument główny (source_document_id) albo dokument
// dołączony przez documents.linked_entity_*. „Możliwy duplikat” = ten sam
// plik (sha256; dla wierszy bez skrótu — ten sam dokument) przy więcej niż
// jednym wydatku — informacja do sprawdzenia, nie zarzut. Numer faktury i
// wystawca (tabela ledger_entry_evidence z #87) wymagają osobnej migracji.
async function buildEvidenceSection(executor, schoolYearId) {
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
  if (!validId(schoolYearId) || !['json', 'html'].includes(format)) throw new RequestError('invalid_request');
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
  await insertAuditEvent(env.db, {
    actorId: context.session.user.id, action: 'report.audit.generated', entityType: 'school_year',
    entityId: schoolYearId, metadata: { format, asOf: report.generatedAt },
  });
  if (format === 'json') return json({ report });
  return new Response(renderAuditReportHtml(report), {
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
    const match = path.match(/^\/api\/reconciliations\/([^/]+)(?:\/(lines|suggestions|matches|confirm))?(?:\/([^/]+)\/(revocation|payment))?$/);
    if (!match) return null;
    const id = decodeId(match[1]);
    const action = match[2] ?? null;
    const subAction = match[4] ?? null;
    if (subAction === 'revocation' && action !== 'matches') return null;
    if (subAction === 'payment' && action !== 'lines') return null;
    if (!action && method === 'GET') return await getReconciliation(request, env, id, url, json);
    if (action === 'suggestions' && method === 'GET') return await suggestMatches(request, env, id, url, json);
    if (method !== 'POST') {
      // GET, HEAD i inne — jedyne trasy tej ścieżki bez akcji/z 'suggestions' dopuszczają GET,
      // reszta akcji (lines/matches/confirm/revocation/payment) wyłącznie POST.
      const allow = (!action || action === 'suggestions') ? 'GET' : 'POST';
      return json({ error: 'method_not_allowed' }, 405, { Allow: allow });
    }
    if (action === 'lines' && subAction === 'payment') return await createPaymentFromLine(request, env, id, decodeId(match[3]), json);
    if (action === 'lines') return await importLines(request, env, id, json);
    if (action === 'matches' && subAction === 'revocation') return await revokeMatch(request, env, id, decodeId(match[3]), json);
    if (action === 'matches') return await confirmMatch(request, env, id, json);
    if (action === 'confirm') return await confirmReconciliation(request, env, id, json);
    return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.code, ...error.extra }, error.status);
    throw error;
  }
}
