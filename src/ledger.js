import { isSameOrigin } from './auth.js';
import { isAuthorized, loadAuthorizationContext } from './authorization.js';

const FINANCIAL_ROLES = ['admin', 'board', 'treasurer'];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;
const DIRECTIONS = new Set(['income', 'expense']);
const METHODS = new Set(['bank', 'cash', 'card', 'other']);
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
    throw new RequestError('invalid_ledger_entry_id');
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

function optionalId(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!validId(value)) throw new RequestError('invalid_request');
  return value;
}

function parseEntryInput(data, idempotencyKey) {
  const description = textOrNull(data.description, 500);
  if (!validId(data.schoolYearId) || !DIRECTIONS.has(data.direction)
    || !validId(data.categoryId) || !validDate(data.occurredOn)
    || !METHODS.has(data.method) || !description || description.length < 3) {
    throw new RequestError('invalid_request');
  }
  const amountCents = readAmount(data.amountCents);
  const resolutionReference = textOrNull(data.resolutionReference, 200);
  if (data.direction === 'expense' && amountCents > 300_000 && !resolutionReference) {
    throw new RequestError('resolution_required');
  }
  return {
    schoolYearId: data.schoolYearId,
    direction: data.direction,
    amountCents,
    categoryId: data.categoryId,
    description,
    occurredOn: data.occurredOn,
    paymentEntryId: optionalId(data.paymentEntryId),
    sourceDocumentId: optionalId(data.sourceDocumentId),
    method: data.method,
    source: textOrNull(data.source, 200),
    resolutionReference,
    idempotencyKey,
  };
}

function parseCorrectionInput(data, idempotencyKey) {
  const reason = textOrNull(data.reason, 500);
  if (!reason || reason.length < 3) throw new RequestError('invalid_reason');
  return { amountCents: readAmount(data.amountCents), reason, idempotencyKey };
}

function entryFromRow(row) {
  return {
    id: row.id,
    schoolYearId: row.school_year_id,
    direction: row.direction,
    amountCents: row.amount_cents,
    categoryId: row.category,
    categoryName: row.category_name ?? undefined,
    description: row.description,
    occurredOn: row.occurred_on,
    paymentEntryId: row.payment_entry_id ?? null,
    sourceDocumentId: row.source_document_id ?? null,
    method: row.method,
    source: row.source ?? null,
    resolutionReference: row.resolution_reference ?? null,
    correctedCents: row.corrected_cents === undefined ? undefined : Number(row.corrected_cents),
    netAmountCents: row.net_amount_cents === undefined ? undefined : Number(row.net_amount_cents),
  };
}

function correctionFromRow(row) {
  return {
    id: row.id,
    ledgerEntryId: row.ledger_entry_id,
    amountCents: row.amount_cents,
    reason: row.reason,
  };
}

function entryMatches(row, input, actorId) {
  return row.created_by === actorId
    && row.school_year_id === input.schoolYearId
    && row.direction === input.direction
    && row.amount_cents === input.amountCents
    && row.category === input.categoryId
    && row.description === input.description
    && row.occurred_on === input.occurredOn
    && (row.payment_entry_id ?? null) === input.paymentEntryId
    && (row.source_document_id ?? null) === input.sourceDocumentId
    && row.method === input.method
    && (row.source ?? null) === input.source
    && (row.resolution_reference ?? null) === input.resolutionReference;
}

function correctionMatches(row, ledgerEntryId, input, actorId) {
  return row.created_by === actorId
    && row.ledger_entry_id === ledgerEntryId
    && row.amount_cents === input.amountCents
    && row.reason === input.reason;
}

async function loadEntryByKey(env, key) {
  return env.DB.prepare(
    `SELECT id, school_year_id, direction, amount_cents, category, description, occurred_on,
            payment_entry_id, source_document_id, method, source, resolution_reference, created_by
       FROM ledger_entries WHERE idempotency_key = ? LIMIT 1`,
  ).bind(key).first();
}

async function loadCorrectionByKey(env, key) {
  return env.DB.prepare(
    `SELECT id, ledger_entry_id, amount_cents, reason, created_by
       FROM ledger_corrections WHERE idempotency_key = ? LIMIT 1`,
  ).bind(key).first();
}

// Kursor wiąże rok szkolny i filtr zapytania, które go wydało (#192): dociągnięcie
// strony z innym rokiem lub filtrem kończy się 400 invalid_cursor zamiast mieszać wiersze.
function encodeCursor(row, scope) {
  return btoa(JSON.stringify([row.occurred_on, row.id, scope.schoolYearId, scope.filter]))
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
    return { occurredOn: decoded[0], id: decoded[1] };
  } catch {
    throw new RequestError('invalid_cursor');
  }
}

function isUniqueError(error) {
  return String(error?.message ?? error).includes('UNIQUE constraint failed');
}

function mapDatabaseError(error) {
  const message = String(error?.message ?? error);
  if (message.includes('ledger_correction_exceeds_remaining_amount')) {
    throw new RequestError('correction_exceeds_remaining_amount', 409);
  }
  if (message.includes('ledger_expense_resolution_required')) throw new RequestError('resolution_required');
  if (message.includes('ledger_category_mismatch')) throw new RequestError('invalid_category');
  if (message.includes('ledger_source_document_not_found')) throw new RequestError('invalid_source_document');
  if (message.includes('ledger_payment_link_mismatch')) throw new RequestError('invalid_payment_link');
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

async function listEntries(request, env, url, json) {
  const schoolYearId = url.searchParams.get('schoolYearId');
  const direction = url.searchParams.get('direction');
  const limitText = url.searchParams.get('limit') ?? '50';
  if (!validId(schoolYearId) || (direction && !DIRECTIONS.has(direction))) {
    throw new RequestError('invalid_request');
  }
  if (!/^\d{1,3}$/.test(limitText)) throw new RequestError('invalid_limit');
  const limit = Number(limitText);
  if (limit < 1 || limit > 100) throw new RequestError('invalid_limit');
  const cursorScope = { schoolYearId, filter: direction ?? '' };
  const cursor = decodeCursor(url.searchParams.get('cursor'), cursorScope);
  await requireFinancialAccess(request, env, schoolYearId);

  const conditions = ['entry.school_year_id = ?'];
  const values = [schoolYearId];
  if (direction) {
    conditions.push('entry.direction = ?');
    values.push(direction);
  }
  if (cursor) {
    conditions.push('(entry.occurred_on < ? OR (entry.occurred_on = ? AND entry.id < ?))');
    values.push(cursor.occurredOn, cursor.occurredOn, cursor.id);
  }
  values.push(limit + 1);
  const result = await env.DB.prepare(
    `SELECT entry.id, entry.school_year_id, entry.direction, entry.amount_cents,
            entry.category, category.name AS category_name, entry.description, entry.occurred_on,
            entry.payment_entry_id, entry.source_document_id, entry.method, entry.source,
            entry.resolution_reference, entry.corrected_cents, entry.net_amount_cents
       FROM ledger_entry_net entry
       JOIN ledger_categories category ON category.id = entry.category
      WHERE ${conditions.join(' AND ')}
      ORDER BY entry.occurred_on DESC, entry.id DESC
      LIMIT ?`,
  ).bind(...values).all();
  const rows = result.results ?? [];
  const visibleRows = rows.slice(0, limit);
  const nextCursor = rows.length > limit && visibleRows.length
    ? encodeCursor(visibleRows[visibleRows.length - 1], cursorScope)
    : null;
  return json({ entries: visibleRows.map(entryFromRow), nextCursor });
}

function readOverviewFilters(url, { allowDirection = false } = {}) {
  const schoolYearId = url.searchParams.get('schoolYearId');
  const direction = url.searchParams.get('direction');
  if (!validId(schoolYearId) || (!allowDirection && direction)
    || (direction && !DIRECTIONS.has(direction))) {
    throw new RequestError('invalid_request');
  }
  return { schoolYearId, direction };
}

async function listCategories(request, env, url, json) {
  const { schoolYearId, direction } = readOverviewFilters(url, { allowDirection: true });
  await requireFinancialAccess(request, env, schoolYearId);
  const conditions = ['school_year_id = ?', 'active = 1'];
  const values = [schoolYearId];
  if (direction) {
    conditions.push('direction = ?');
    values.push(direction);
  }
  const result = await env.DB.prepare(
    `SELECT id, direction, name
       FROM ledger_categories
      WHERE ${conditions.join(' AND ')}
      ORDER BY direction, name, id`,
  ).bind(...values).all();
  return json({ categories: (result.results ?? []).map(row => ({
    id: row.id,
    direction: row.direction,
    name: row.name,
  })) });
}

async function readSummary(request, env, url, json) {
  const { schoolYearId } = readOverviewFilters(url);
  await requireFinancialAccess(request, env, schoolYearId);
  const row = await env.DB.prepare(
    `SELECT school_year_id, opening_balance_cents, income_cents,
            expense_cents, closing_balance_cents
       FROM ledger_year_summary
      WHERE school_year_id = ?
      LIMIT 1`,
  ).bind(schoolYearId).first();
  if (!row) throw new RequestError('school_year_not_found', 404);
  return json({ summary: {
    schoolYearId: row.school_year_id,
    openingBalanceCents: Number(row.opening_balance_cents),
    incomeCents: Number(row.income_cents),
    expenseCents: Number(row.expense_cents),
    closingBalanceCents: Number(row.closing_balance_cents),
  } });
}

async function listBudget(request, env, url, json) {
  const { schoolYearId } = readOverviewFilters(url);
  await requireFinancialAccess(request, env, schoolYearId);
  const result = await env.DB.prepare(
    `SELECT line.id, line.category_id, category.direction, category.name AS category_name,
            line.planned_cents, line.note, line.supersedes_id
       FROM ledger_current_budget line
       JOIN ledger_categories category ON category.id = line.category_id
      WHERE line.school_year_id = ?
      ORDER BY category.direction, category.name, line.id`,
  ).bind(schoolYearId).all();
  return json({ budget: (result.results ?? []).map(row => ({
    id: row.id,
    categoryId: row.category_id,
    categoryName: row.category_name,
    direction: row.direction,
    plannedCents: Number(row.planned_cents),
    note: row.note ?? null,
    supersedesId: row.supersedes_id ?? null,
  })) });
}

async function createEntry(request, env, json) {
  const idempotencyKey = readIdempotencyKey(request);
  const input = parseEntryInput(await readJson(request), idempotencyKey);
  const context = await requireFinancialAccess(request, env, input.schoolYearId);
  const actorId = context.session.user.id;
  const existing = await loadEntryByKey(env, idempotencyKey);
  if (existing) {
    if (!entryMatches(existing, input, actorId)) throw new RequestError('idempotency_conflict', 409);
    return json({ entry: entryFromRow(existing) }, 200, { 'Idempotency-Replayed': 'true' });
  }

  const entryId = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO ledger_entries (
          id, school_year_id, direction, amount_cents, category, description, occurred_on,
          payment_entry_id, source_document_id, created_by, method, source,
          resolution_reference, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        entryId, input.schoolYearId, input.direction, input.amountCents, input.categoryId,
        input.description, input.occurredOn, input.paymentEntryId, input.sourceDocumentId,
        actorId, input.method, input.source, input.resolutionReference, idempotencyKey,
      ),
      env.DB.prepare(
        `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, metadata_json)
         VALUES (?, ?, 'ledger.entry.created', 'ledger_entry', ?, '{}')`,
      ).bind(crypto.randomUUID(), actorId, entryId),
    ]);
  } catch (error) {
    if (isUniqueError(error)) {
      const replay = await loadEntryByKey(env, idempotencyKey);
      if (replay && entryMatches(replay, input, actorId)) {
        return json({ entry: entryFromRow(replay) }, 200, { 'Idempotency-Replayed': 'true' });
      }
      if (String(error?.message ?? error).includes('ledger_entries.payment_entry_id')) {
        throw new RequestError('payment_already_linked', 409);
      }
      throw new RequestError('idempotency_conflict', 409);
    }
    mapDatabaseError(error);
  }

  return json({ entry: { id: entryId, ...input, idempotencyKey: undefined } }, 201, {
    'Idempotency-Replayed': 'false',
  });
}

async function createCorrection(request, env, ledgerEntryId, json) {
  if (!validId(ledgerEntryId)) throw new RequestError('invalid_ledger_entry_id');
  const idempotencyKey = readIdempotencyKey(request);
  const input = parseCorrectionInput(await readJson(request), idempotencyKey);
  const context = await loadAuthorizationContext(request, env);
  if (!context) throw new RequestError('unauthenticated', 401);
  const entry = await env.DB.prepare(
    'SELECT id, school_year_id FROM ledger_entries WHERE id = ? LIMIT 1',
  ).bind(ledgerEntryId).first();
  if (!entry) throw new RequestError('ledger_entry_not_found', 404);
  if (!isAuthorized(context, {
    roles: FINANCIAL_ROLES,
    schoolYearId: entry.school_year_id,
    requireMfa: true,
  })) throw new RequestError('forbidden', 403);
  const actorId = context.session.user.id;
  const existing = await loadCorrectionByKey(env, idempotencyKey);
  if (existing) {
    if (!correctionMatches(existing, ledgerEntryId, input, actorId)) {
      throw new RequestError('idempotency_conflict', 409);
    }
    return json({ correction: correctionFromRow(existing) }, 200, { 'Idempotency-Replayed': 'true' });
  }

  const correctionId = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO ledger_corrections (
          id, ledger_entry_id, amount_cents, reason, created_by, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(correctionId, ledgerEntryId, input.amountCents, input.reason, actorId, idempotencyKey),
      env.DB.prepare(
        `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, metadata_json)
         VALUES (?, ?, 'ledger.correction.created', 'ledger_correction', ?, ?)`,
      ).bind(crypto.randomUUID(), actorId, correctionId, JSON.stringify({ ledgerEntryId })),
    ]);
  } catch (error) {
    if (isUniqueError(error)) {
      const replay = await loadCorrectionByKey(env, idempotencyKey);
      if (replay && correctionMatches(replay, ledgerEntryId, input, actorId)) {
        return json({ correction: correctionFromRow(replay) }, 200, { 'Idempotency-Replayed': 'true' });
      }
      throw new RequestError('idempotency_conflict', 409);
    }
    mapDatabaseError(error);
  }

  return json({ correction: {
    id: correctionId,
    ledgerEntryId,
    amountCents: input.amountCents,
    reason: input.reason,
  } }, 201, { 'Idempotency-Replayed': 'false' });
}

export async function handleLedgerRequest(request, env, url, json) {
  const correctionMatch = url.pathname.match(/^\/api\/ledger\/([^/]+)\/corrections$/);
  const isEntryRoute = url.pathname === '/api/ledger';
  const isList = request.method === 'GET' && isEntryRoute;
  const isCategories = request.method === 'GET' && url.pathname === '/api/ledger/categories';
  const isSummary = request.method === 'GET' && url.pathname === '/api/ledger/summary';
  const isBudget = request.method === 'GET' && url.pathname === '/api/ledger/budget';
  const isMutation = request.method === 'POST' && (isEntryRoute || correctionMatch);
  if (!isList && !isCategories && !isSummary && !isBudget && !isMutation) return null;
  if (isMutation && !isSameOrigin(request)) return json({ error: 'invalid_origin' }, 403);

  try {
    if (isList) return await listEntries(request, env, url, json);
    if (isCategories) return await listCategories(request, env, url, json);
    if (isSummary) return await readSummary(request, env, url, json);
    if (isBudget) return await listBudget(request, env, url, json);
    if (isEntryRoute) return await createEntry(request, env, json);
    return await createCorrection(request, env, decodeId(correctionMatch[1]), json);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.code }, error.status);
    throw error;
  }
}
