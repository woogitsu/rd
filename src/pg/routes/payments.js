// Wpłaty, korekty i przypisanie wpłat na PostgreSQL (issue #37). Prototyp — nie jest wdrożony.
//
// Ten sam kontrakt HTTP co stary Worker (src/payments.js): trasy, walidacja,
// kształty JSON, kody statusu i błędów oraz nagłówek Idempotency-Replayed.
//   GET  /api/payments?schoolYearId=…&status=…&limit=…&cursor=…
//   POST /api/payments                      (Idempotency-Key)
//   POST /api/payments/{id}/corrections     (Idempotency-Key)
//   POST /api/payments/{id}/assignment      (Idempotency-Key)
//
// Każdy zapis i jego zdarzenie audytu powstają w jednej transakcji. Korekta
// i przypisanie blokują wiersz wpłaty (SELECT … FOR UPDATE), więc równoległe
// żądania są serializowane; triggery z 0002_payments.sql pilnują tego samego
// na poziomie bazy. Składka jest dobrowolna: moduł nie wylicza należności,
// salda „do zapłaty” ani statusu dłużnika.

import { isSameOrigin } from '../../auth.js';
import { isAuthorizedScoped, loadAuthorizationContext } from '../authorization.js';
import { insertAuditEvent } from '../audit.js';

export const name = 'payments';

const FINANCIAL_ROLES = ['admin', 'board', 'treasurer'];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;
const METHODS = new Set(['bank', 'cash', 'other']);
const MAX_BODY_BYTES = 16 * 1024;
const MAX_AMOUNT_CENTS = 100_000_000;

const PAYMENT_COLUMNS = `id, household_id, school_year_id, amount_cents,
  to_char(received_on, 'YYYY-MM-DD') AS received_on, method, reference, status, created_by`;

class RequestError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
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
  return { amountCents: readAmount(data.amountCents), reason };
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

function paymentListItem(row) {
  const payment = paymentFromRow(row);
  const correctedCents = toSafeInteger(row.corrected_cents);
  return { ...payment, correctedCents, netAmountCents: payment.amountCents - correctedCents };
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

async function loadPaymentByKey(executor, key) {
  const { rows } = await executor.query(
    `SELECT ${PAYMENT_COLUMNS} FROM payment_entries WHERE idempotency_key = $1 LIMIT 1`,
    [key],
  );
  return rows[0] ?? null;
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

function encodeCursor(row) {
  return btoa(JSON.stringify([row.received_on, row.id]))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeCursor(value) {
  if (!value) return null;
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new RequestError('invalid_cursor');
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const decoded = JSON.parse(atob(base64 + padding));
    if (!Array.isArray(decoded) || decoded.length !== 2 || !validDate(decoded[0]) || !validId(decoded[1])) {
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
  if (message.includes('payment_not_unmatched')) {
    throw new RequestError('payment_already_assigned', 409);
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
    throw new RequestError('forbidden', 403);
  }
  return context;
}

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
  const cursor = decodeCursor(url.searchParams.get('cursor'));
  await requireFinancialContext(request, env, schoolYearId);

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
            ), 0) AS corrected_cents
       FROM payment_entries p
      WHERE ${conditions.join(' AND ')}
      ORDER BY p.received_on DESC, p.id DESC
      LIMIT $${values.length}`,
    values,
  );
  const visibleRows = rows.slice(0, limit);
  const nextCursor = rows.length > limit && visibleRows.length
    ? encodeCursor(visibleRows[visibleRows.length - 1])
    : null;
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
      const corrected = await tx.query(
        'SELECT COALESCE(SUM(amount_cents), 0) AS corrected_cents FROM payment_corrections WHERE payment_entry_id = $1',
        [paymentEntryId],
      );
      if (toSafeInteger(corrected.rows[0].corrected_cents) + input.amountCents > toSafeInteger(payment.amount_cents)) {
        throw new RequestError('correction_exceeds_remaining_amount', 409);
      }
      const correctionId = crypto.randomUUID();
      await tx.query(
        `INSERT INTO payment_corrections (id, payment_entry_id, amount_cents, reason, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [correctionId, paymentEntryId, input.amountCents, input.reason, actorId, idempotencyKey],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'payment.correction.created', entityType: 'payment_correction',
        entityId: correctionId, metadata: { paymentEntryId },
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
        entityId: assignmentId, metadata: { paymentEntryId },
      });
      return { assignment: { id: assignmentId, paymentEntryId, householdId } };
    });
  } catch (error) {
    if (isUniqueError(error)) {
      const replay = await loadAssignmentByKey(env.db, idempotencyKey);
      if (replay && assignmentMatches(replay, paymentEntryId, householdId, actorId)) {
        return json({ assignment: assignmentFromRow(replay) }, 200, REPLAYED);
      }
      throw new RequestError('payment_already_assigned', 409);
    }
    mapDatabaseError(error);
  }
  if (result instanceof Replay) return json(result.body, 200, REPLAYED);
  return json(result, 201, CREATED);
}

export async function handle(request, env, url, json) {
  const correctionMatch = url.pathname.match(/^\/api\/payments\/([^/]+)\/corrections$/);
  const assignmentMatch = url.pathname.match(/^\/api\/payments\/([^/]+)\/assignment$/);
  const isPaymentCreate = url.pathname === '/api/payments';
  const isPaymentList = request.method === 'GET' && url.pathname === '/api/payments';
  const isMutation = request.method === 'POST' && (isPaymentCreate || correctionMatch || assignmentMatch);
  if (!isPaymentList && !isMutation) return null;
  // handlePgRequest sprawdza Origin wcześniej; tu powtórnie, gdyby moduł użyto samodzielnie.
  if (isMutation && !isSameOrigin(request)) return json({ error: 'invalid_origin' }, 403);

  try {
    if (isPaymentList) return await listPayments(request, env, url, json);
    if (isPaymentCreate) return await createPayment(request, env, json);
    if (correctionMatch) return await createCorrection(request, env, decodeId(correctionMatch[1]), json);
    return await assignPayment(request, env, decodeId(assignmentMatch[1]), json);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.code }, error.status);
    throw error;
  }
}
