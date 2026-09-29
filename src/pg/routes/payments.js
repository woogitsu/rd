// Wpłaty, korekty i przypisanie wpłat na PostgreSQL (issue #37). Prototyp — nie jest wdrożony.
//
// Ten sam kontrakt HTTP co stary Worker (src/payments.js): trasy, walidacja,
// kształty JSON, kody statusu i błędów oraz nagłówek Idempotency-Replayed.
//   GET  /api/payments?schoolYearId=…&status=…&limit=…&cursor=…
//   POST /api/payments                      (Idempotency-Key)
//   POST /api/payments/{id}/corrections     (Idempotency-Key)
//   POST /api/payments/{id}/assignment      (Idempotency-Key)
// Nowe trasy (#138): zwrot i ponowne przypisanie jako osobne, niezmienne zdarzenia.
//   POST /api/payments/{id}/refunds         (Idempotency-Key)
//   POST /api/payments/{id}/reassignment    (Idempotency-Key)
// Podział wpłaty nieprzypisanej na gospodarstwa (#127, część 1):
//   GET  /api/payments/{id}/allocations
//   POST /api/payments/{id}/allocations                         (Idempotency-Key)
//   POST /api/payments/{id}/allocations/{allocationId}/reversal (Idempotency-Key)
//
// Każdy zapis i jego zdarzenie audytu powstają w jednej transakcji. Korekta
// i przypisanie blokują wiersz wpłaty (SELECT … FOR UPDATE), więc równoległe
// żądania są serializowane; triggery z 0002_payments.sql pilnują tego samego
// na poziomie bazy. Składka jest dobrowolna: moduł nie wylicza należności,
// salda „do zapłaty” ani statusu dłużnika.

import { isSameOrigin } from '../../auth.js';
import { isAuthorizedScoped, loadAuthorizationContext, logAccessDenied } from '../authorization.js';
import { insertAuditEvent } from '../audit.js';
import { csvCell, csvHeader, csvRow } from '../csv.js';
import { detectPossiblePersonalData } from '../pii-check.js';
import { recordDataAccess } from '../data-access.js';

export const name = 'payments';

const FINANCIAL_ROLES = ['admin', 'board', 'treasurer'];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;
const METHODS = new Set(['bank', 'cash', 'other']);
const MAX_BODY_BYTES = 16 * 1024;
const MAX_AMOUNT_CENTS = 100_000_000;
// #141: eksport CSV wpisów wpłat i korekt (skarbnik/zarząd/admin). Ten sam
// limit co eksport księgi (#7, ledger.js MAX_EXPORT_ROWS) — jeden wiersz
// arkusza tabelarycznego jako granica pamięci pojedynczego żądania.
const MAX_EXPORT_ROWS = 20_000;

const PAYMENT_COLUMNS = `id, household_id, school_year_id, amount_cents,
  to_char(received_on, 'YYYY-MM-DD') AS received_on, method, reference, status, created_by`;

class RequestError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

// Wynik odtworzenia zapisu po kluczu idempotencji — przerywa transakcję bez zapisu.
class Replay {
  constructor(body) {
    this.body = body;
  }
}

function validId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function decodeId(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new RequestError('invalid_payment_id');
  }
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function textOrNull(value, maxLength) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new RequestError('invalid_request');
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new RequestError('invalid_request');
  return normalized;
}

// BIGINT z PostgreSQL (SUM) przychodzi z `pg` jako tekst. Zamiana tylko
// w zakresie bezpiecznych liczb całkowitych; poza nim błąd zamiast cichej utraty precyzji.
export function toSafeInteger(value) {
  if (value === null || value === undefined) return 0;
  const number = typeof value === 'bigint' ? Number(value) : Number(String(value));
  if (!Number.isSafeInteger(number)) throw new Error('unsafe_integer');
  return number;
}

async function readJson(request) {
  const type = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw new RequestError('invalid_content_type', 415);
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new RequestError('request_too_large', 413);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new RequestError('request_too_large', 413);
  }
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

function readAmount(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_AMOUNT_CENTS) {
    throw new RequestError('invalid_amount');
  }
  return value;
}

function parsePaymentInput(data) {
  if (!validId(data.schoolYearId) || !validDate(data.receivedOn) || !METHODS.has(data.method)) {
    throw new RequestError('invalid_request');
  }
  if (data.householdId !== null && data.householdId !== undefined && !validId(data.householdId)) {
    throw new RequestError('invalid_request');
  }
  const householdId = data.householdId ?? null;
  return {
    householdId,
    schoolYearId: data.schoolYearId,
    amountCents: readAmount(data.amountCents),
    receivedOn: data.receivedOn,
    method: data.method,
    reference: textOrNull(data.reference, 200),
    status: householdId ? 'recorded' : 'unmatched',
  };
}

function parseCorrectionInput(data) {
  const reason = textOrNull(data.reason, 500);
  if (!reason || reason.length < 3) throw new RequestError('invalid_reason');
  return { amountCents: readAmount(data.amountCents), reason, confirmPersonalData: data.confirmPersonalData === true };
}

// Zwrot pieniędzy rodzinie (#138): własna data skutku i metoda, jak wpłata.
function parseRefundInput(data) {
  const reason = textOrNull(data.reason, 500);
  if (!reason || reason.length < 3) throw new RequestError('invalid_reason');
  if (!validDate(data.refundedOn) || !METHODS.has(data.method)) throw new RequestError('invalid_request');
  return { amountCents: readAmount(data.amountCents), refundedOn: data.refundedOn, method: data.method, reason };
}

function parseReassignmentInput(data) {
  const reason = textOrNull(data.reason, 500);
  if (!reason || reason.length < 3) throw new RequestError('invalid_reason');
  if (!validId(data.householdId)) throw new RequestError('invalid_request');
  return { householdId: data.householdId, reason };
}

function paymentFromRow(row) {
  return {
    id: row.id,
    householdId: row.household_id ?? null,
    schoolYearId: row.school_year_id,
    amountCents: toSafeInteger(row.amount_cents),
    receivedOn: row.received_on,
    method: row.method,
    reference: row.reference ?? null,
    status: row.status,
  };
}

function correctionFromRow(row) {
  return {
    id: row.id,
    paymentEntryId: row.payment_entry_id,
    amountCents: toSafeInteger(row.amount_cents),
    reason: row.reason,
  };
}

function assignmentFromRow(row) {
  return { id: row.id, paymentEntryId: row.payment_entry_id, householdId: row.household_id };
}

function refundFromRow(row) {
  return {
    id: row.id,
    paymentEntryId: row.payment_entry_id,
    amountCents: toSafeInteger(row.amount_cents),
    refundedOn: row.refunded_on,
    method: row.method,
    reason: row.reason,
  };
}

function reassignmentFromRow(row) {
  return {
    id: row.id,
    paymentEntryId: row.payment_entry_id,
    oldHouseholdId: row.old_household_id,
    newHouseholdId: row.new_household_id,
    reason: row.reason,
  };
}

function paymentListItem(row) {
  const payment = paymentFromRow(row);
  const correctedCents = toSafeInteger(row.corrected_cents);
  // #138: netto wpłaty na liście też pomniejsza zwrot, nie tylko korektę, ale
  // pole refundedCents celowo NIE jest dodane do odpowiedzi listy — zachowuje
  // to zgodność kontraktu ze starym Workerem (test parity), który zwrotów nie
  // ma. Kwotę zwrotu widać w szczegółach przez GET przyszłej trasy (poza
  // zakresem tego PR) albo wprost w tabeli payment_refunds.
  const refundedCents = toSafeInteger(row.refunded_cents ?? 0);
  return { ...payment, correctedCents, netAmountCents: payment.amountCents - correctedCents - refundedCents };
}

function paymentMatches(row, input, actorId) {
  return row.created_by === actorId
    && (row.household_id ?? null) === input.householdId
    && row.school_year_id === input.schoolYearId
    && toSafeInteger(row.amount_cents) === input.amountCents
    && row.received_on === input.receivedOn
    && row.method === input.method
    && (row.reference ?? null) === input.reference
    && row.status === input.status;
}

function correctionMatches(row, paymentEntryId, input, actorId) {
  return row.created_by === actorId
    && row.payment_entry_id === paymentEntryId
    && toSafeInteger(row.amount_cents) === input.amountCents
    && row.reason === input.reason;
}

function assignmentMatches(row, paymentEntryId, householdId, actorId) {
  return row.created_by === actorId
    && row.payment_entry_id === paymentEntryId
    && row.household_id === householdId;
}

function refundMatches(row, paymentEntryId, input, actorId) {
  return row.created_by === actorId
    && row.payment_entry_id === paymentEntryId
    && toSafeInteger(row.amount_cents) === input.amountCents
    && row.refunded_on === input.refundedOn
    && row.method === input.method
    && row.reason === input.reason;
}

// Porównuje wyłącznie treść żądania (wpłata, nowe gospodarstwo, powód, autor).
// Stare gospodarstwo jest wynikiem operacji, nie jej wejściem: po udanym
// przypisaniu bieżące household_id wpłaty to już nowe, więc jego porównanie
// dawałoby fałszywe 409 przy ponowieniu z tym samym kluczem (#138).
function reassignmentMatches(row, paymentEntryId, input, actorId) {
  return row.created_by === actorId
    && row.payment_entry_id === paymentEntryId
    && row.new_household_id === input.householdId
    && row.reason === input.reason;
}

async function loadPaymentByKey(executor, key) {
  const { rows } = await executor.query(
    `SELECT ${PAYMENT_COLUMNS} FROM payment_entries WHERE idempotency_key = $1 LIMIT 1`,
    [key],
  );
  return rows[0] ?? null;
}

// #152: kandydaci na "znane imię i nazwisko" w zakresie roku szkolnego —
// uczniowie zapisani w tym roku i opiekunowie ich gospodarstw. Przybliżenie
// (nie każdy opiekun gospodarstwa musi mieć aktywną relację z dzieckiem w tym
// roku) — świadomie szersze niż węziej, żeby nie przeoczyć trafienia.
async function loadKnownNames(executor, schoolYearId) {
  const { rows } = await executor.query(
    `SELECT first_name, last_name FROM students
      WHERE id IN (SELECT student_id FROM enrollments WHERE school_year_id = $1)
     UNION
     SELECT g.first_name, g.last_name FROM guardians g
      WHERE g.household_id IN (
        SELECT household_id FROM students
         WHERE id IN (SELECT student_id FROM enrollments WHERE school_year_id = $1)
      )`,
    [schoolYearId],
  );
  return rows.map((row) => ({ firstName: row.first_name, lastName: row.last_name }));
}

async function loadCorrectionByKey(executor, key) {
  const { rows } = await executor.query(
    `SELECT id, payment_entry_id, amount_cents, reason, created_by
       FROM payment_corrections WHERE idempotency_key = $1 LIMIT 1`,
    [key],
  );
  return rows[0] ?? null;
}

async function loadAssignmentByKey(executor, key) {
  const { rows } = await executor.query(
    `SELECT id, payment_entry_id, household_id, created_by
       FROM payment_assignments WHERE idempotency_key = $1 LIMIT 1`,
    [key],
  );
  return rows[0] ?? null;
}

async function loadRefundByKey(executor, key) {
  const { rows } = await executor.query(
    `SELECT id, payment_entry_id, amount_cents, to_char(refunded_on, 'YYYY-MM-DD') AS refunded_on,
            method, reason, created_by
       FROM payment_refunds WHERE idempotency_key = $1 LIMIT 1`,
    [key],
  );
  return rows[0] ?? null;
}

async function loadReassignmentByKey(executor, key) {
  const { rows } = await executor.query(
    `SELECT id, payment_entry_id, old_household_id, new_household_id, reason, created_by
       FROM payment_reassignments WHERE idempotency_key = $1 LIMIT 1`,
    [key],
  );
  return rows[0] ?? null;
}

// Kursor wiąże rok szkolny i filtr zapytania, które go wydało (#192): dociągnięcie
// strony z innym rokiem lub filtrem kończy się 400 invalid_cursor zamiast mieszać wiersze.
function encodeCursor(row, scope) {
  return btoa(JSON.stringify([row.received_on, row.id, scope.schoolYearId, scope.filter]))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeCursor(value, scope) {
  if (!value) return null;
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new RequestError('invalid_cursor');
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const decoded = JSON.parse(atob(base64 + padding));
    if (!Array.isArray(decoded) || decoded.length !== 4 || !validDate(decoded[0]) || !validId(decoded[1])
      || decoded[2] !== scope.schoolYearId || decoded[3] !== scope.filter) {
      throw new Error();
    }
    return { receivedOn: decoded[0], id: decoded[1] };
  } catch {
    throw new RequestError('invalid_cursor');
  }
}

function isUniqueError(error) {
  return error?.code === '23505';
}

// Tłumaczy błędy triggerów i ograniczeń na kody API (jak mapDatabaseError w Workerze).
function mapDatabaseError(error) {
  if (error instanceof RequestError) throw error;
  const message = String(error?.message ?? '');
  if (message.includes('payment_correction_exceeds_remaining_amount')) {
    throw new RequestError('correction_exceeds_remaining_amount', 409);
  }
  if (message.includes('legacy_reversed_payment_cannot_be_corrected')) {
    throw new RequestError('payment_cannot_be_corrected', 409);
  }
  // #127 (0104): podział wpłaty — suma części ≤ netto; korekta/zwrot nie schodzą poniżej części;
  // wpłata z częściami nie dostaje jednego gospodarstwa.
  if (message.includes('payment_allocation_exceeds_net')) throw new RequestError('payment_allocation_exceeds_net', 409);
  if (message.includes('payment_allocation_household_exists')) throw new RequestError('payment_allocation_household_exists', 409);
  if (message.includes('payment_has_allocations')) throw new RequestError('payment_has_allocations', 409);
  if (message.includes('payment_not_unmatched')) {
    throw new RequestError('payment_already_assigned', 409);
  }
  // #138: korekta/zwrot wpłaty powiązanej z wpisem księgi jest odrzucana,
  // dopóki skarbnik najpierw nie skoryguje wpisu księgi o tę samą kwotę
  // (wariant zachowawczy — bez automatycznej korekty księgi).
  if (message.includes('ledger_correction_required')) throw new RequestError('ledger_correction_required', 409);
  if (message.includes('payment_refund_exceeds_remaining_amount')) {
    throw new RequestError('refund_exceeds_remaining_amount', 409);
  }
  if (message.includes('payment_cannot_be_refunded')) throw new RequestError('payment_cannot_be_refunded', 409);
  if (message.includes('payment_reassignment_household_mismatch')) {
    throw new RequestError('payment_reassignment_household_mismatch', 409);
  }
  // Rok zamknięty (0017_year_close.sql, trigger a0_year_freeze) — stan, nie awaria.
  if (message.includes('school_year_closed')) throw new RequestError('school_year_closed', 409);
  // Data spoza [starts_on, ends_on] roku (0027, trigger po zamrożeniu roku): jedna
  // reguła w bazie, więc bezpośredni INSERT i API odrzucają to samo.
  if (message.includes('date_outside_school_year')) throw new RequestError('date_outside_school_year', 422);
  if (error?.code === '23503') throw new RequestError('invalid_reference');
  throw error;
}

async function requireFinancialContext(request, env, schoolYearId) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) throw new RequestError('unauthenticated', 401);
  // Wpłaty dotyczą rodzin, nie klas: przydział z class_id nie daje tu dostępu
  // (isAuthorizedScoped bez classId pomija przydziały klasowe).
  if (!isAuthorizedScoped(context, { roles: FINANCIAL_ROLES, schoolYearId, requireMfa: true })) {
    await logAccessDenied(env, context, { roles: FINANCIAL_ROLES }, request);
    throw new RequestError('forbidden', 403);
  }
  return context;
}

// #184: bez śladu access.denied tutaj — wywoływana wyłącznie po POST (korekta,
// przypisanie, zwrot, przeksięgowanie); logAccessDenied loguje tylko GET (patrz
// authorization.js), więc dodanie go tu byłoby martwym kodem.
function requireYear(context, schoolYearId) {
  if (!isAuthorizedScoped(context, { roles: FINANCIAL_ROLES, schoolYearId, requireMfa: true })) {
    throw new RequestError('forbidden', 403);
  }
}

async function listPayments(request, env, url, json) {
  const schoolYearId = url.searchParams.get('schoolYearId');
  const status = url.searchParams.get('status');
  const limitText = url.searchParams.get('limit') ?? '50';
  if (!validId(schoolYearId) || (status && !['recorded', 'unmatched'].includes(status))) {
    throw new RequestError('invalid_request');
  }
  if (!/^\d{1,3}$/.test(limitText)) throw new RequestError('invalid_limit');
  const limit = Number(limitText);
  if (limit < 1 || limit > 100) throw new RequestError('invalid_limit');
  const cursorScope = { schoolYearId, filter: status ?? '' };
  const cursor = decodeCursor(url.searchParams.get('cursor'), cursorScope);
  const context = await requireFinancialContext(request, env, schoolYearId);

  const values = [schoolYearId];
  const conditions = ["p.status IN ('recorded', 'unmatched')", 'p.school_year_id = $1'];
  if (status) {
    values.push(status);
    conditions.push(`p.status = $${values.length}`);
  }
  if (cursor) {
    values.push(cursor.receivedOn, cursor.id);
    const dateParam = `$${values.length - 1}::date`;
    const idParam = `$${values.length}`;
    conditions.push(`(p.received_on < ${dateParam} OR (p.received_on = ${dateParam} AND p.id < ${idParam}))`);
  }
  values.push(limit + 1);
  const { rows } = await env.db.query(
    `SELECT p.id, p.household_id, p.school_year_id, p.amount_cents,
            to_char(p.received_on, 'YYYY-MM-DD') AS received_on, p.method, p.reference, p.status,
            COALESCE((
              SELECT SUM(c.amount_cents) FROM payment_corrections c WHERE c.payment_entry_id = p.id
            ), 0) AS corrected_cents,
            COALESCE((
              SELECT SUM(r.amount_cents) FROM payment_refunds r WHERE r.payment_entry_id = p.id
            ), 0) AS refunded_cents
       FROM payment_entries p
      WHERE ${conditions.join(' AND ')}
      ORDER BY p.received_on DESC, p.id DESC
      LIMIT $${values.length}`,
    values,
  );
  const visibleRows = rows.slice(0, limit);
  const nextCursor = rows.length > limit && visibleRows.length
    ? encodeCursor(visibleRows[visibleRows.length - 1], cursorScope)
    : null;
  await recordDataAccess(env, {
    actorId: context.session.user.id, accessKind: 'payment_list', schoolYearId, outcome: 'ok', rowCount: visibleRows.length,
  });
  return json({ payments: visibleRows.map(paymentListItem), nextCursor });
}

const REPLAYED = { 'Idempotency-Replayed': 'true' };
const CREATED = { 'Idempotency-Replayed': 'false' };

async function createPayment(request, env, json) {
  const idempotencyKey = readIdempotencyKey(request);
  const input = parsePaymentInput(await readJson(request));
  const context = await requireFinancialContext(request, env, input.schoolYearId);
  const actorId = context.session.user.id;

  const replayOrConflict = (row) => {
    if (!row) return null;
    if (!paymentMatches(row, input, actorId)) throw new RequestError('idempotency_conflict', 409);
    return new Replay({ payment: paymentFromRow(row) });
  };

  let result;
  try {
    result = await env.db.transaction(async (tx) => {
      const replay = replayOrConflict(await loadPaymentByKey(tx, idempotencyKey));
      if (replay) return replay;
      const paymentId = crypto.randomUUID();
      await tx.query(
        `INSERT INTO payment_entries (
           id, household_id, school_year_id, amount_cents, received_on,
           method, reference, status, created_by, idempotency_key
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [paymentId, input.householdId, input.schoolYearId, input.amountCents, input.receivedOn,
          input.method, input.reference, input.status, actorId, idempotencyKey],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'payment.created', entityType: 'payment_entry', entityId: paymentId,
        metadata: { schoolYearId: input.schoolYearId },
      });
      return { payment: { id: paymentId, ...input } };
    });
  } catch (error) {
    if (isUniqueError(error)) {
      // Równoległe żądanie z tym samym kluczem zdążyło zapisać wpłatę.
      const replay = replayOrConflict(await loadPaymentByKey(env.db, idempotencyKey));
      if (replay) return json(replay.body, 200, REPLAYED);
      throw new RequestError('idempotency_conflict', 409);
    }
    mapDatabaseError(error);
  }
  if (result instanceof Replay) return json(result.body, 200, REPLAYED);
  return json(result, 201, CREATED);
}

async function createCorrection(request, env, paymentEntryId, json) {
  if (!validId(paymentEntryId)) throw new RequestError('invalid_payment_id');
  const idempotencyKey = readIdempotencyKey(request);
  const input = parseCorrectionInput(await readJson(request));
  const context = await requireFinancialContext(request, env);
  const actorId = context.session.user.id;

  const replayOrConflict = (row) => {
    if (!row) return null;
    if (!correctionMatches(row, paymentEntryId, input, actorId)) {
      throw new RequestError('idempotency_conflict', 409);
    }
    return new Replay({ correction: correctionFromRow(row) });
  };

  let result;
  try {
    result = await env.db.transaction(async (tx) => {
      // Blokada wiersza wpłaty: równoległe korekty tej samej wpłaty czekają na siebie.
      const { rows } = await tx.query(
        `SELECT id, school_year_id, status, amount_cents
           FROM payment_entries WHERE id = $1 FOR UPDATE`,
        [paymentEntryId],
      );
      const payment = rows[0];
      if (!payment) throw new RequestError('payment_not_found', 404);
      requireYear(context, payment.school_year_id);
      const replay = replayOrConflict(await loadCorrectionByKey(tx, idempotencyKey));
      if (replay) return replay;
      if (payment.status === 'reversed') throw new RequestError('payment_cannot_be_corrected', 409);
      // #165: korekta z aktywnym powiązaniem w SZKICU uzgodnienia jest zachowawczo
      // zablokowana — skarbnik najpierw cofa powiązanie (z powodem), dopiero potem
      // koryguje wpłatę. Trigger payment_correction_guard sprawdza to samo (0039).
      const activeMatch = await tx.query(
        `SELECT r.id AS reconciliation_id FROM bank_reconciliation_matches m
           JOIN bank_reconciliations r ON r.id = m.reconciliation_id
          WHERE m.payment_entry_id = $1 AND m.revoked_at IS NULL AND r.status = 'draft'
         UNION ALL
         -- Pozycja aktywnego dopasowania zbiorczego (#127, 0105) blokuje tak samo.
         SELECT r.id AS reconciliation_id FROM bank_group_match_items_current i
           JOIN bank_reconciliations r ON r.id = i.reconciliation_id
          WHERE i.payment_entry_id = $1 AND r.status = 'draft'
          LIMIT 1`,
        [paymentEntryId],
      );
      if (activeMatch.rows.length) {
        throw new RequestError('active_bank_match', 409, { reconciliationId: activeMatch.rows[0].reconciliation_id });
      }
      const corrected = await tx.query(
        'SELECT COALESCE(SUM(amount_cents), 0) AS corrected_cents FROM payment_corrections WHERE payment_entry_id = $1',
        [paymentEntryId],
      );
      if (toSafeInteger(corrected.rows[0].corrected_cents) + input.amountCents > toSafeInteger(payment.amount_cents)) {
        throw new RequestError('correction_exceeds_remaining_amount', 409);
      }
      // #152: pole wolnego tekstu w niezmiennej tabeli — ostrzeżenie przed
      // zapisem, nie twarda blokada. Kategorie i liczby trafień trafiają do
      // audytu (bez treści); wynik detekcji nigdy nie ujawnia dopasowanego
      // fragmentu ani nazwiska.
      const piiCheck = detectPossiblePersonalData(input.reason, { knownNames: await loadKnownNames(tx, payment.school_year_id) });
      if (piiCheck.categories.length && !input.confirmPersonalData) {
        throw new RequestError('possible_personal_data', 422, { categories: piiCheck.categories });
      }
      const correctionId = crypto.randomUUID();
      await tx.query(
        `INSERT INTO payment_corrections (id, payment_entry_id, amount_cents, reason, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [correctionId, paymentEntryId, input.amountCents, input.reason, actorId, idempotencyKey],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'payment.correction.created', entityType: 'payment_correction',
        entityId: correctionId,
        metadata: {
          paymentEntryId,
          schoolYearId: payment.school_year_id,
          ...(piiCheck.categories.length ? { piiConfirmed: true, piiCategories: piiCheck.categories } : {}),
        },
      });
      return { correction: { id: correctionId, paymentEntryId, amountCents: input.amountCents, reason: input.reason } };
    });
  } catch (error) {
    if (isUniqueError(error)) {
      const replay = replayOrConflict(await loadCorrectionByKey(env.db, idempotencyKey));
      if (replay) return json(replay.body, 200, REPLAYED);
      throw new RequestError('idempotency_conflict', 409);
    }
    mapDatabaseError(error);
  }
  if (result instanceof Replay) return json(result.body, 200, REPLAYED);
  return json(result, 201, CREATED);
}

async function assignPayment(request, env, paymentEntryId, json) {
  if (!validId(paymentEntryId)) throw new RequestError('invalid_payment_id');
  const idempotencyKey = readIdempotencyKey(request);
  const data = await readJson(request);
  if (!validId(data.householdId)) throw new RequestError('invalid_request');
  const householdId = data.householdId;
  const context = await requireFinancialContext(request, env);
  const actorId = context.session.user.id;

  const replayOrConflict = (row) => {
    if (!row) return null;
    if (!assignmentMatches(row, paymentEntryId, householdId, actorId)) {
      throw new RequestError('idempotency_conflict', 409);
    }
    return new Replay({ assignment: assignmentFromRow(row) });
  };

  let result;
  try {
    result = await env.db.transaction(async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, household_id, school_year_id, status
           FROM payment_entries WHERE id = $1 FOR UPDATE`,
        [paymentEntryId],
      );
      const payment = rows[0];
      if (!payment) throw new RequestError('payment_not_found', 404);
      requireYear(context, payment.school_year_id);
      const replay = replayOrConflict(await loadAssignmentByKey(tx, idempotencyKey));
      if (replay) return replay;
      if (payment.status !== 'unmatched' || payment.household_id !== null) {
        throw new RequestError('payment_already_assigned', 409);
      }
      const assignmentId = crypto.randomUUID();
      // Trigger payment_assignments_apply_insert ustawia household_id i status 'recorded'.
      await tx.query(
        `INSERT INTO payment_assignments (id, payment_entry_id, household_id, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5)`,
        [assignmentId, paymentEntryId, householdId, actorId, idempotencyKey],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'payment.assigned', entityType: 'payment_assignment',
        entityId: assignmentId, metadata: { paymentEntryId, schoolYearId: payment.school_year_id },
      });
      return { assignment: { id: assignmentId, paymentEntryId, householdId } };
    });
  } catch (error) {
    if (isUniqueError(error)) {
      const replay = await loadAssignmentByKey(env.db, idempotencyKey);
      if (replay && assignmentMatches(replay, paymentEntryId, householdId, actorId)) {
        return json({ assignment: assignmentFromRow(replay) }, 200, REPLAYED);
      }
      // Ten sam klucz zapisał już inne przypisanie (inna wpłata, gospodarstwo
      // lub osoba): to konflikt idempotencji (#6). Bez wiersza o tym kluczu
      // naruszona została unikalność wpłaty — inny klucz już ją przypisał.
      if (replay) throw new RequestError('idempotency_conflict', 409);
      throw new RequestError('payment_already_assigned', 409);
    }
    mapDatabaseError(error);
  }
  if (result instanceof Replay) return json(result.body, 200, REPLAYED);
  return json(result, 201, CREATED);
}

// Zwrot pieniędzy rodzinie (#138): niezmienny zapis, zmniejsza netto wpłaty
// jak korekta. Odrzucony, jeśli wpłata ma powiązany wpis księgi o innym
// netto niż to, co zostanie po zwrocie (`ledger_correction_required`) —
// skarbnik koryguje najpierw wpis księgi, potem ponawia zwrot.
async function createRefund(request, env, paymentEntryId, json) {
  if (!validId(paymentEntryId)) throw new RequestError('invalid_payment_id');
  const idempotencyKey = readIdempotencyKey(request);
  const input = parseRefundInput(await readJson(request));
  const context = await requireFinancialContext(request, env);
  const actorId = context.session.user.id;

  const replayOrConflict = (row) => {
    if (!row) return null;
    if (!refundMatches(row, paymentEntryId, input, actorId)) {
      throw new RequestError('idempotency_conflict', 409);
    }
    return new Replay({ refund: refundFromRow(row) });
  };

  let result;
  try {
    result = await env.db.transaction(async (tx) => {
      // Blokada wiersza wpłaty: równoległe korekty/zwroty tej samej wpłaty czekają na siebie.
      const { rows } = await tx.query(
        `SELECT id, school_year_id, status, amount_cents
           FROM payment_entries WHERE id = $1 FOR UPDATE`,
        [paymentEntryId],
      );
      const payment = rows[0];
      if (!payment) throw new RequestError('payment_not_found', 404);
      requireYear(context, payment.school_year_id);
      const replay = replayOrConflict(await loadRefundByKey(tx, idempotencyKey));
      if (replay) return replay;
      if (payment.status === 'reversed') throw new RequestError('payment_cannot_be_refunded', 409);
      const totals = await tx.query(
        `SELECT COALESCE((SELECT SUM(amount_cents) FROM payment_corrections WHERE payment_entry_id = $1), 0) AS corrected_cents,
                COALESCE((SELECT SUM(amount_cents) FROM payment_refunds WHERE payment_entry_id = $1), 0) AS refunded_cents`,
        [paymentEntryId],
      );
      const correctedCents = toSafeInteger(totals.rows[0].corrected_cents);
      const refundedCents = toSafeInteger(totals.rows[0].refunded_cents);
      if (correctedCents + refundedCents + input.amountCents > toSafeInteger(payment.amount_cents)) {
        throw new RequestError('refund_exceeds_remaining_amount', 409);
      }
      const refundId = crypto.randomUUID();
      await tx.query(
        `INSERT INTO payment_refunds (id, payment_entry_id, amount_cents, refunded_on, method, reason, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [refundId, paymentEntryId, input.amountCents, input.refundedOn, input.method, input.reason, actorId, idempotencyKey],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'payment.refund.created', entityType: 'payment_refund',
        entityId: refundId, metadata: { paymentEntryId, schoolYearId: payment.school_year_id },
      });
      return { refund: {
        id: refundId, paymentEntryId, amountCents: input.amountCents,
        refundedOn: input.refundedOn, method: input.method, reason: input.reason,
      } };
    });
  } catch (error) {
    if (isUniqueError(error)) {
      const replay = replayOrConflict(await loadRefundByKey(env.db, idempotencyKey));
      if (replay) return json(replay.body, 200, REPLAYED);
      throw new RequestError('idempotency_conflict', 409);
    }
    mapDatabaseError(error);
  }
  if (result instanceof Replay) return json(result.body, 200, REPLAYED);
  return json(result, 201, CREATED);
}

// Ponowne przypisanie do gospodarstwa (#138): niezmienne zdarzenie zamiast
// korekty do zera. Historia zostaje w payment_reassignments; widok
// gospodarstwa pokazuje wyłącznie bieżące household_id wpłaty.
async function reassignPayment(request, env, paymentEntryId, json) {
  if (!validId(paymentEntryId)) throw new RequestError('invalid_payment_id');
  const idempotencyKey = readIdempotencyKey(request);
  const input = parseReassignmentInput(await readJson(request));
  const context = await requireFinancialContext(request, env);
  const actorId = context.session.user.id;

  let result;
  try {
    result = await env.db.transaction(async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, household_id, school_year_id, status
           FROM payment_entries WHERE id = $1 FOR UPDATE`,
        [paymentEntryId],
      );
      const payment = rows[0];
      if (!payment) throw new RequestError('payment_not_found', 404);
      requireYear(context, payment.school_year_id);
      const oldHouseholdId = payment.household_id;
      const replay = ((row) => {
        if (!row) return null;
        if (!reassignmentMatches(row, paymentEntryId, input, actorId)) {
          throw new RequestError('idempotency_conflict', 409);
        }
        return new Replay({ reassignment: reassignmentFromRow(row) });
      })(await loadReassignmentByKey(tx, idempotencyKey));
      if (replay) return replay;
      if (payment.status !== 'recorded' || payment.household_id === null) {
        throw new RequestError('payment_not_assigned', 409);
      }
      if (payment.household_id === input.householdId) {
        throw new RequestError('payment_reassignment_same_household', 409);
      }
      if (!(await tx.query('SELECT 1 FROM households WHERE id = $1', [input.householdId])).rows.length) {
        throw new RequestError('invalid_reference');
      }
      const reassignmentId = crypto.randomUUID();
      // Trigger payment_reassignments_apply_insert ustawia nowe household_id.
      await tx.query(
        `INSERT INTO payment_reassignments (id, payment_entry_id, old_household_id, new_household_id, reason, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [reassignmentId, paymentEntryId, oldHouseholdId, input.householdId, input.reason, actorId, idempotencyKey],
      );
      // Dziennik bez identyfikatorów gospodarstw w metadanych, jak przy przypisaniu.
      await insertAuditEvent(tx, {
        actorId, action: 'payment.reassigned', entityType: 'payment_reassignment',
        entityId: reassignmentId, metadata: { paymentEntryId, schoolYearId: payment.school_year_id },
      });
      return { reassignment: {
        id: reassignmentId, paymentEntryId, oldHouseholdId, newHouseholdId: input.householdId, reason: input.reason,
      } };
    });
  } catch (error) {
    if (isUniqueError(error)) {
      const replay = await loadReassignmentByKey(env.db, idempotencyKey);
      if (replay && reassignmentMatches(replay, paymentEntryId, input, actorId)) {
        return json({ reassignment: reassignmentFromRow(replay) }, 200, REPLAYED);
      }
      throw new RequestError('idempotency_conflict', 409);
    }
    mapDatabaseError(error);
  }
  if (result instanceof Replay) return json(result.body, 200, REPLAYED);
  return json(result, 201, CREATED);
}

// Podział wpłaty na kilka gospodarstw (#127, część 1; migracja 0104).
// Dotyczy wyłącznie wpłaty nieprzypisanej ('unmatched'): przelew zbiorczy,
// rodzeństwo w różnych gospodarstwach. Część jest niezmienna; błąd = cofnięcie
// części (nowy zapis z powodem) + nowa część. Suma bieżących części ≤ netto
// wpłaty — pilnuje trigger payment_allocation_guard pod blokadą wiersza wpłaty.
// Dziennik bez kwot i identyfikatorów gospodarstw, jak przy payment.assigned.

function parseAllocationInput(data) {
  if (!validId(data.householdId)) throw new RequestError('invalid_request');
  return { householdId: data.householdId, amountCents: readAmount(data.amountCents) };
}

function allocationFromRow(row) {
  return {
    id: row.id,
    paymentEntryId: row.payment_entry_id,
    householdId: row.household_id,
    amountCents: toSafeInteger(row.amount_cents),
  };
}

function allocationMatches(row, paymentEntryId, input, actorId) {
  return row.created_by === actorId
    && row.payment_entry_id === paymentEntryId
    && row.household_id === input.householdId
    && toSafeInteger(row.amount_cents) === input.amountCents;
}

function allocationReversalMatches(row, paymentEntryId, allocationId, reason, actorId) {
  return row.created_by === actorId
    && row.payment_entry_id === paymentEntryId
    && row.allocation_id === allocationId
    && row.reason === reason;
}

async function loadAllocationByKey(executor, key) {
  const { rows } = await executor.query(
    `SELECT id, payment_entry_id, household_id, amount_cents, created_by
       FROM payment_allocations WHERE idempotency_key = $1 LIMIT 1`,
    [key],
  );
  return rows[0] ?? null;
}

async function loadAllocationReversalByKey(executor, key) {
  const { rows } = await executor.query(
    `SELECT r.id, r.allocation_id, a.payment_entry_id, r.reason, r.created_by
       FROM payment_allocation_reversals r JOIN payment_allocations a ON a.id = r.allocation_id
      WHERE r.idempotency_key = $1 LIMIT 1`,
    [key],
  );
  return rows[0] ?? null;
}

async function listAllocations(request, env, paymentEntryId, json) {
  if (!validId(paymentEntryId)) throw new RequestError('invalid_payment_id');
  const context = await requireFinancialContext(request, env);
  // Jedna migawka dla wpłaty, części i sum (REPEATABLE READ, tylko odczyt).
  const body = await env.db.transaction(async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows } = await tx.query(
      'SELECT id, school_year_id, status, household_id, net_amount_cents FROM payment_entry_net WHERE id = $1',
      [paymentEntryId],
    );
    const payment = rows[0];
    if (!payment) throw new RequestError('payment_not_found', 404);
    requireYear(context, payment.school_year_id);
    const parts = await tx.query(
      `SELECT a.id, a.payment_entry_id, a.household_id, a.amount_cents, a.created_at,
              r.id AS reversal_id, r.reason AS reversal_reason, r.created_at AS reversed_at
         FROM payment_allocations a
         LEFT JOIN payment_allocation_reversals r ON r.allocation_id = a.id
        WHERE a.payment_entry_id = $1
        ORDER BY a.created_at, a.id`,
      [paymentEntryId],
    );
    const allocations = parts.rows.map((row) => ({
      ...allocationFromRow(row),
      createdAt: new Date(row.created_at).toISOString(),
      reversal: row.reversal_id
        ? { id: row.reversal_id, reason: row.reversal_reason, createdAt: new Date(row.reversed_at).toISOString() }
        : null,
    }));
    const netAmountCents = toSafeInteger(payment.net_amount_cents);
    const allocatedCents = allocations.filter((item) => !item.reversal).reduce((sum, item) => sum + item.amountCents, 0);
    return {
      paymentEntryId,
      status: payment.status,
      householdId: payment.household_id ?? null,
      netAmountCents,
      allocatedCents,
      // „Nieprzypisana część” do wyjaśnienia; dla wpłaty z jednym gospodarstwem 0.
      unallocatedCents: payment.status === 'unmatched' ? netAmountCents - allocatedCents : 0,
      allocations,
    };
  });
  return json(body, 200, { 'Cache-Control': 'no-store' });
}

async function createAllocation(request, env, paymentEntryId, json) {
  if (!validId(paymentEntryId)) throw new RequestError('invalid_payment_id');
  const idempotencyKey = readIdempotencyKey(request);
  const input = parseAllocationInput(await readJson(request));
  const context = await requireFinancialContext(request, env);
  const actorId = context.session.user.id;

  const replayOrConflict = (row) => {
    if (!row) return null;
    if (!allocationMatches(row, paymentEntryId, input, actorId)) throw new RequestError('idempotency_conflict', 409);
    return new Replay({ allocation: allocationFromRow(row) });
  };

  let result;
  try {
    result = await env.db.transaction(async (tx) => {
      const { rows } = await tx.query(
        'SELECT id, household_id, school_year_id, status FROM payment_entries WHERE id = $1 FOR UPDATE',
        [paymentEntryId],
      );
      const payment = rows[0];
      if (!payment) throw new RequestError('payment_not_found', 404);
      requireYear(context, payment.school_year_id);
      const replay = replayOrConflict(await loadAllocationByKey(tx, idempotencyKey));
      if (replay) return replay;
      if (payment.status !== 'unmatched' || payment.household_id !== null) {
        throw new RequestError('payment_already_assigned', 409);
      }
      if (!(await tx.query('SELECT 1 FROM households WHERE id = $1', [input.householdId])).rows.length) {
        throw new RequestError('invalid_reference');
      }
      const allocationId = crypto.randomUUID();
      await tx.query(
        `INSERT INTO payment_allocations (id, payment_entry_id, school_year_id, household_id, amount_cents, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [allocationId, paymentEntryId, payment.school_year_id, input.householdId, input.amountCents, actorId, idempotencyKey],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'payment.allocation.created', entityType: 'payment_allocation',
        entityId: allocationId, metadata: { paymentEntryId, schoolYearId: payment.school_year_id },
      });
      return { allocation: { id: allocationId, paymentEntryId, householdId: input.householdId, amountCents: input.amountCents } };
    });
  } catch (error) {
    if (isUniqueError(error)) {
      const replay = replayOrConflict(await loadAllocationByKey(env.db, idempotencyKey));
      if (replay) return json(replay.body, 200, REPLAYED);
      throw new RequestError('idempotency_conflict', 409);
    }
    mapDatabaseError(error);
  }
  if (result instanceof Replay) return json(result.body, 200, REPLAYED);
  return json(result, 201, CREATED);
}

async function reverseAllocation(request, env, paymentEntryId, allocationId, json) {
  if (!validId(paymentEntryId)) throw new RequestError('invalid_payment_id');
  if (!validId(allocationId)) throw new RequestError('invalid_request');
  const idempotencyKey = readIdempotencyKey(request);
  const data = await readJson(request);
  const reason = textOrNull(data.reason, 500);
  if (!reason || reason.length < 3) throw new RequestError('invalid_reason');
  const context = await requireFinancialContext(request, env);
  const actorId = context.session.user.id;

  const replayOrConflict = (row) => {
    if (!row) return null;
    if (!allocationReversalMatches(row, paymentEntryId, allocationId, reason, actorId)) {
      throw new RequestError('idempotency_conflict', 409);
    }
    return new Replay({ reversal: { id: row.id, allocationId: row.allocation_id, paymentEntryId, reason: row.reason } });
  };

  let result;
  try {
    result = await env.db.transaction(async (tx) => {
      const { rows } = await tx.query(
        'SELECT id, school_year_id FROM payment_entries WHERE id = $1 FOR UPDATE',
        [paymentEntryId],
      );
      const payment = rows[0];
      if (!payment) throw new RequestError('payment_not_found', 404);
      requireYear(context, payment.school_year_id);
      const replay = replayOrConflict(await loadAllocationReversalByKey(tx, idempotencyKey));
      if (replay) return replay;
      const allocation = await tx.query(
        `SELECT a.id, r.id AS reversal_id FROM payment_allocations a
           LEFT JOIN payment_allocation_reversals r ON r.allocation_id = a.id
          WHERE a.id = $1 AND a.payment_entry_id = $2`,
        [allocationId, paymentEntryId],
      );
      if (!allocation.rows.length) throw new RequestError('payment_allocation_not_found', 404);
      if (allocation.rows[0].reversal_id) throw new RequestError('payment_allocation_already_reversed', 409);
      const reversalId = crypto.randomUUID();
      await tx.query(
        `INSERT INTO payment_allocation_reversals (id, allocation_id, school_year_id, reason, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [reversalId, allocationId, payment.school_year_id, reason, actorId, idempotencyKey],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'payment.allocation.reversed', entityType: 'payment_allocation',
        entityId: allocationId, metadata: { paymentEntryId, reversalId, schoolYearId: payment.school_year_id },
      });
      return { reversal: { id: reversalId, allocationId, paymentEntryId, reason } };
    });
  } catch (error) {
    if (isUniqueError(error)) {
      const replay = await loadAllocationReversalByKey(env.db, idempotencyKey);
      if (replay) return json(replayOrConflict(replay).body, 200, REPLAYED);
      // Równoległe cofnięcie tej samej części innym kluczem (UNIQUE allocation_id).
      throw new RequestError('payment_allocation_already_reversed', 409);
    }
    mapDatabaseError(error);
  }
  if (result instanceof Replay) return json(result.body, 200, REPLAYED);
  return json(result, 201, CREATED);
}

// --- Eksport CSV (#141, część 1: wpisy wpłat — raport KR i księga w #141 dalej poza zakresem) ---
//
// Jeden plik, dwa rodzaje wierszy (typ_wiersza): "wpis" (jeden na wpłatę) i
// "korekta" (jedna na każdą korektę — historia widoczna, nic nie jest zacierane,
// zgodnie z AGENTS.md). Eksport NIE generuje listy rodzin „bez wpłaty” ani
// statusu rodziny — opisuje wyłącznie zapisane wpisy (AGENTS.md: składki są
// dobrowolne). Imiona/nazwiska uczniów i pełny e-mail nigdy nie trafiają do
// pliku; numer rodziny to wewnętrzny household_id, nie dana ucznia.

const EXPORT_METHOD_LABELS = { bank: 'Przelew', cash: 'Gotówka', other: 'Inna' };
const EXPORT_ASSIGNMENT_LABELS = { recorded: 'przypisana', unmatched: 'nieprzypisana do wyjaśnienia' };

export const PAYMENT_EXPORT_COLUMNS = [
  ['typ_wiersza', 'text'], ['id', 'text'], ['data', 'text'], ['kwota_eur', 'amount'], ['metoda', 'text'],
  ['stan_przypisania', 'text'], ['numer_rodziny', 'text'], ['suma_korekt_eur', 'amount'],
  ['suma_zwrotow_eur', 'amount'], ['netto_eur', 'amount'], ['powod_korekty', 'text'], ['rola_aktora', 'text'],
].map(([header, type]) => ({ header, type }));

// Nagłówek arkusza wymagany przez #141: plik opisuje zapisane wpisy, nie
// należności rodzin. Nie jest to wiersz danych — pierwsza linia pliku.
const EXPORT_DISCLAIMER = 'Składki są dobrowolne; brak wpisu nie oznacza braku wpłaty.';

export function paymentExportEntryLine(row) {
  const assigned = row.status === 'recorded';
  return csvRow(PAYMENT_EXPORT_COLUMNS, [
    'wpis', row.id, row.received_on, row.amount_cents, EXPORT_METHOD_LABELS[row.method] ?? row.method,
    EXPORT_ASSIGNMENT_LABELS[row.status] ?? row.status, assigned ? row.household_id : '',
    row.corrected_cents, row.refunded_cents, row.net_amount_cents, '', '',
  ]);
}

export function paymentExportCorrectionLine(row) {
  return csvRow(PAYMENT_EXPORT_COLUMNS, [
    'korekta', row.id, row.created_on, row.amount_cents, '', '', row.household_id ?? '', 0, 0, 0,
    row.reason, row.actor_role ?? 'nieznana',
  ]);
}

function readExportFilters(url) {
  const schoolYearId = url.searchParams.get('schoolYearId');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const method = url.searchParams.get('method');
  if (!validId(schoolYearId)) throw new RequestError('invalid_request');
  if (from && !validDate(from)) throw new RequestError('invalid_date');
  if (to && !validDate(to)) throw new RequestError('invalid_date');
  if (from && to && from > to) throw new RequestError('invalid_window');
  if (method && !METHODS.has(method)) throw new RequestError('invalid_method');
  return { schoolYearId, from: from || null, to: to || null, method: method || null };
}

async function exportCsv(request, env, url) {
  const { schoolYearId, from, to, method } = readExportFilters(url);
  const context = await requireFinancialContext(request, env, schoolYearId);
  const actorId = context.session.user.id;

  const conditions = ["p.status IN ('recorded', 'unmatched')", 'p.school_year_id = $1'];
  const values = [schoolYearId];
  if (from) { values.push(from); conditions.push(`p.received_on >= $${values.length}::date`); }
  if (to) { values.push(to); conditions.push(`p.received_on <= $${values.length}::date`); }
  if (method) { values.push(method); conditions.push(`p.method = $${values.length}`); }
  const whereClause = conditions.join(' AND ');

  const { entryRows, correctionRows } = await env.db.transaction(async (tx) => {
    const year = await tx.query('SELECT id FROM school_years WHERE id = $1', [schoolYearId]);
    if (!year.rows.length) throw new RequestError('school_year_not_found', 404);
    const entries = await tx.query(
      `SELECT p.id, to_char(p.received_on, 'YYYY-MM-DD') AS received_on, p.amount_cents, p.method,
              p.status, p.household_id,
              COALESCE((SELECT SUM(c.amount_cents) FROM payment_corrections c WHERE c.payment_entry_id = p.id), 0) AS corrected_cents,
              COALESCE((SELECT SUM(r.amount_cents) FROM payment_refunds r WHERE r.payment_entry_id = p.id), 0) AS refunded_cents,
              p.amount_cents
                - COALESCE((SELECT SUM(c.amount_cents) FROM payment_corrections c WHERE c.payment_entry_id = p.id), 0)
                - COALESCE((SELECT SUM(r.amount_cents) FROM payment_refunds r WHERE r.payment_entry_id = p.id), 0)
                AS net_amount_cents
         FROM payment_entries p
        WHERE ${whereClause}
        ORDER BY p.received_on, p.id COLLATE "C"
        LIMIT $${values.length + 1}`,
      [...values, MAX_EXPORT_ROWS + 1],
    );
    if (entries.rows.length > MAX_EXPORT_ROWS) throw new RequestError('export_too_large', 413);
    const corrections = await tx.query(
      `SELECT c.id, to_char(c.created_at, 'YYYY-MM-DD') AS created_on, c.amount_cents, c.reason, p.household_id,
              COALESCE((
                SELECT rg.role FROM role_grants rg
                 WHERE rg.user_id = c.created_by AND rg.revoked_at IS NULL
                   AND (rg.school_year_id = p.school_year_id OR rg.school_year_id IS NULL)
                 ORDER BY rg.role LIMIT 1
              ), 'nieznana') AS actor_role
         FROM payment_corrections c
         JOIN payment_entries p ON p.id = c.payment_entry_id
        WHERE ${whereClause}
        ORDER BY c.created_at, c.id COLLATE "C"
        LIMIT $${values.length + 1}`,
      [...values, MAX_EXPORT_ROWS + 1],
    );
    if (corrections.rows.length > MAX_EXPORT_ROWS) throw new RequestError('export_too_large', 413);
    // Dziennik: kto, kiedy i ile wierszy wyeksportował — bez kwot i treści (#141).
    await insertAuditEvent(tx, {
      actorId, action: 'payment.exported', entityType: 'school_year', entityId: schoolYearId,
      metadata: {
        schoolYearId, format: 'csv', entryCount: entries.rows.length, correctionCount: corrections.rows.length,
      },
    });
    return { entryRows: entries.rows, correctionRows: corrections.rows };
  });

  const lines = [
    csvCell(EXPORT_DISCLAIMER),
    csvHeader(PAYMENT_EXPORT_COLUMNS),
    ...entryRows.map(paymentExportEntryLine),
    ...correctionRows.map(paymentExportCorrectionLine),
  ];
  // BOM UTF-8, żeby arkusz poprawnie odczytał polskie znaki (jak eksport księgi, #121).
  return new Response(`﻿${lines.join('\r\n')}\r\n`, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="wplaty-${schoolYearId.replace(/[^A-Za-z0-9_-]/g, '_')}.csv"`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function handle(request, env, url, json) {
  const correctionMatch = url.pathname.match(/^\/api\/payments\/([^/]+)\/corrections$/);
  const assignmentMatch = url.pathname.match(/^\/api\/payments\/([^/]+)\/assignment$/);
  const refundMatch = url.pathname.match(/^\/api\/payments\/([^/]+)\/refunds$/);
  const reassignmentMatch = url.pathname.match(/^\/api\/payments\/([^/]+)\/reassignment$/);
  const allocationsMatch = url.pathname.match(/^\/api\/payments\/([^/]+)\/allocations$/);
  const allocationReversalMatch = url.pathname.match(/^\/api\/payments\/([^/]+)\/allocations\/([^/]+)\/reversal$/);
  const isPaymentCreate = url.pathname === '/api/payments';
  const isPaymentList = request.method === 'GET' && url.pathname === '/api/payments';
  const isAllocationList = request.method === 'GET' && Boolean(allocationsMatch);
  const isExport = request.method === 'GET' && url.pathname === '/api/payments/export.csv';
  const isMutation = request.method === 'POST'
    && (isPaymentCreate || correctionMatch || assignmentMatch || refundMatch || reassignmentMatch
      || allocationsMatch || allocationReversalMatch);
  if (!isPaymentList && !isAllocationList && !isExport && !isMutation) return null;
  // handlePgRequest sprawdza Origin wcześniej; tu powtórnie, gdyby moduł użyto samodzielnie.
  if (isMutation && !isSameOrigin(request)) return json({ error: 'invalid_origin' }, 403);

  try {
    if (isPaymentList) return await listPayments(request, env, url, json);
    if (isExport) return await exportCsv(request, env, url);
    if (isAllocationList) return await listAllocations(request, env, decodeId(allocationsMatch[1]), json);
    if (allocationsMatch) return await createAllocation(request, env, decodeId(allocationsMatch[1]), json);
    if (allocationReversalMatch) {
      return await reverseAllocation(request, env, decodeId(allocationReversalMatch[1]), decodeId(allocationReversalMatch[2]), json);
    }
    if (isPaymentCreate) return await createPayment(request, env, json);
    if (correctionMatch) return await createCorrection(request, env, decodeId(correctionMatch[1]), json);
    if (refundMatch) return await createRefund(request, env, decodeId(refundMatch[1]), json);
    if (reassignmentMatch) return await reassignPayment(request, env, decodeId(reassignmentMatch[1]), json);
    return await assignPayment(request, env, decodeId(assignmentMatch[1]), json);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.code, ...error.extra }, error.status);
    throw error;
  }
}
