import { isSameOrigin } from './auth.js';
import { isAuthorized, loadAuthorizationContext } from './authorization.js';

const FINANCIAL_ROLES = ['admin', 'board', 'treasurer'];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;
const METHODS = new Set(['bank', 'cash', 'other']);
const MAX_BODY_BYTES = 16 * 1024;
const MAX_AMOUNT_CENTS = 100_000_000;

class RequestError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
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

function parsePaymentInput(data, idempotencyKey) {
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
    idempotencyKey,
  };
}

function parseCorrectionInput(data, idempotencyKey) {
  const reason = textOrNull(data.reason, 500);
  if (!reason || reason.length < 3) throw new RequestError('invalid_reason');
  return { amountCents: readAmount(data.amountCents), reason, idempotencyKey };
}

function paymentFromRow(row) {
  return {
    id: row.id,
    householdId: row.household_id ?? null,
    schoolYearId: row.school_year_id,
    amountCents: row.amount_cents,
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
    amountCents: row.amount_cents,
    reason: row.reason,
  };
}

function paymentMatches(row, input, actorId) {
  return row.created_by === actorId
    && row.household_id === input.householdId
    && row.school_year_id === input.schoolYearId
    && row.amount_cents === input.amountCents
    && row.received_on === input.receivedOn
    && row.method === input.method
    && (row.reference ?? null) === input.reference
    && row.status === input.status;
}

function correctionMatches(row, paymentEntryId, input, actorId) {
  return row.created_by === actorId
    && row.payment_entry_id === paymentEntryId
    && row.amount_cents === input.amountCents
    && row.reason === input.reason;
}

async function loadPaymentByKey(env, key) {
  return env.DB.prepare(
    `SELECT id, household_id, school_year_id, amount_cents, received_on, method,
            reference, status, created_by
       FROM payment_entries WHERE idempotency_key = ? LIMIT 1`,
  ).bind(key).first();
}

async function loadCorrectionByKey(env, key) {
  return env.DB.prepare(
    `SELECT id, payment_entry_id, amount_cents, reason, created_by
       FROM payment_corrections WHERE idempotency_key = ? LIMIT 1`,
  ).bind(key).first();
}

function isUniqueError(error) {
  return String(error?.message ?? error).includes('UNIQUE constraint failed');
}

function mapDatabaseError(error) {
  const message = String(error?.message ?? error);
  if (message.includes('payment_correction_exceeds_remaining_amount')) {
    throw new RequestError('correction_exceeds_remaining_amount', 409);
  }
  if (message.includes('legacy_reversed_payment_cannot_be_corrected')) {
    throw new RequestError('payment_cannot_be_corrected', 409);
  }
  if (message.includes('FOREIGN KEY constraint failed')) throw new RequestError('invalid_reference');
  throw error;
}

async function requireFinancialAccess(request, env, schoolYearId) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) throw new RequestError('unauthenticated', 401);
  if (!isAuthorized(context, {
    roles: FINANCIAL_ROLES,
    schoolYearId,
    requireMfa: true,
  })) throw new RequestError('forbidden', 403);
  return context;
}

async function createPayment(request, env, json) {
  const idempotencyKey = readIdempotencyKey(request);
  const input = parsePaymentInput(await readJson(request), idempotencyKey);
  const context = await requireFinancialAccess(request, env, input.schoolYearId);
  const actorId = context.session.user.id;
  const existing = await loadPaymentByKey(env, idempotencyKey);
  if (existing) {
    if (!paymentMatches(existing, input, actorId)) throw new RequestError('idempotency_conflict', 409);
    return json({ payment: paymentFromRow(existing) }, 200, { 'Idempotency-Replayed': 'true' });
  }

  const paymentId = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO payment_entries (
          id, household_id, school_year_id, amount_cents, received_on,
          method, reference, status, created_by, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        paymentId, input.householdId, input.schoolYearId, input.amountCents, input.receivedOn,
        input.method, input.reference, input.status, actorId, idempotencyKey,
      ),
      env.DB.prepare(
        `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, metadata_json)
         VALUES (?, ?, 'payment.created', 'payment_entry', ?, '{}')`,
      ).bind(crypto.randomUUID(), actorId, paymentId),
    ]);
  } catch (error) {
    if (isUniqueError(error)) {
      const replay = await loadPaymentByKey(env, idempotencyKey);
      if (replay && paymentMatches(replay, input, actorId)) {
        return json({ payment: paymentFromRow(replay) }, 200, { 'Idempotency-Replayed': 'true' });
      }
      throw new RequestError('idempotency_conflict', 409);
    }
    mapDatabaseError(error);
  }

  return json({ payment: { id: paymentId, ...input, idempotencyKey: undefined } }, 201, {
    'Idempotency-Replayed': 'false',
  });
}

async function createCorrection(request, env, paymentEntryId, json) {
  if (!validId(paymentEntryId)) throw new RequestError('invalid_payment_id');
  const idempotencyKey = readIdempotencyKey(request);
  const input = parseCorrectionInput(await readJson(request), idempotencyKey);
  const context = await requireFinancialAccess(request, env);
  const payment = await env.DB.prepare(
    'SELECT id, school_year_id FROM payment_entries WHERE id = ? LIMIT 1',
  ).bind(paymentEntryId).first();
  if (!payment) throw new RequestError('payment_not_found', 404);
  if (!isAuthorized(context, {
    roles: FINANCIAL_ROLES,
    schoolYearId: payment.school_year_id,
    requireMfa: true,
  })) throw new RequestError('forbidden', 403);
  const actorId = context.session.user.id;
  const existing = await loadCorrectionByKey(env, idempotencyKey);
  if (existing) {
    if (!correctionMatches(existing, paymentEntryId, input, actorId)) {
      throw new RequestError('idempotency_conflict', 409);
    }
    return json({ correction: correctionFromRow(existing) }, 200, { 'Idempotency-Replayed': 'true' });
  }

  const correctionId = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO payment_corrections (
          id, payment_entry_id, amount_cents, reason, created_by, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(correctionId, paymentEntryId, input.amountCents, input.reason, actorId, idempotencyKey),
      env.DB.prepare(
        `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, metadata_json)
         VALUES (?, ?, 'payment.correction.created', 'payment_correction', ?, ?)`,
      ).bind(crypto.randomUUID(), actorId, correctionId, JSON.stringify({ paymentEntryId })),
    ]);
  } catch (error) {
    if (isUniqueError(error)) {
      const replay = await loadCorrectionByKey(env, idempotencyKey);
      if (replay && correctionMatches(replay, paymentEntryId, input, actorId)) {
        return json({ correction: correctionFromRow(replay) }, 200, { 'Idempotency-Replayed': 'true' });
      }
      throw new RequestError('idempotency_conflict', 409);
    }
    mapDatabaseError(error);
  }

  return json({
    correction: { id: correctionId, paymentEntryId, amountCents: input.amountCents, reason: input.reason },
  }, 201, { 'Idempotency-Replayed': 'false' });
}

export async function handlePaymentRequest(request, env, url, json) {
  const correctionMatch = url.pathname.match(/^\/api\/payments\/([^/]+)\/corrections$/);
  const isPaymentCreate = url.pathname === '/api/payments';
  if (request.method !== 'POST' || (!isPaymentCreate && !correctionMatch)) return null;
  if (!isSameOrigin(request)) return json({ error: 'invalid_origin' }, 403);

  try {
    if (isPaymentCreate) return await createPayment(request, env, json);
    return await createCorrection(request, env, decodeId(correctionMatch[1]), json);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.code }, error.status);
    throw error;
  }
}
