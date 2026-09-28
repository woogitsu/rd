// Księga, korekty, kategorie, podsumowanie i preliminarz na PostgreSQL (issue #38).
// Prototyp — nie jest wdrożony.
//
// Ten sam kontrakt HTTP co stary Worker (src/ledger.js), z którego korzysta panel ledger/:
//   GET  /api/ledger?schoolYearId=…&direction=…&limit=…&cursor=…
//   GET  /api/ledger/categories?schoolYearId=…&direction=…
//   GET  /api/ledger/summary?schoolYearId=…
//   GET  /api/ledger/budget?schoolYearId=…
//   POST /api/ledger                        (Idempotency-Key)
//   POST /api/ledger/{id}/corrections       (Idempotency-Key)
// Nowa trasa (issue #7, tylko w routerze PostgreSQL):
//   GET  /api/ledger/export.csv?schoolYearId=…
//
// Każdy zapis i jego zdarzenie audytu powstają w jednej transakcji. Korekta
// blokuje wiersz wpisu (SELECT … FOR UPDATE), a wpis powiązany z wpłatą
// blokuje wiersz wpłaty, więc równoległe żądania są serializowane. Triggery
// z 0003_ledger.sql pilnują tych samych reguł na poziomie bazy.

import { isSameOrigin } from '../../auth.js';
import { isAuthorizedScoped, loadAuthorizationContext } from '../authorization.js';
import { insertAuditEvent } from '../audit.js';
import { toSafeInteger } from './payments.js';
import { csvCell, csvHeader, csvRow, formatEuro } from '../csv.js';

export const name = 'ledger';

const FINANCIAL_ROLES = ['admin', 'board', 'treasurer'];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;
const DIRECTIONS = new Set(['income', 'expense']);
const METHODS = new Set(['bank', 'cash', 'card', 'other']);
const MAX_BODY_BYTES = 16 * 1024;
const MAX_AMOUNT_CENTS = 100_000_000;
const RESOLUTION_THRESHOLD_CENTS = 300_000;
const MAX_EXPORT_ROWS = 20_000;

const ENTRY_COLUMNS = `id, school_year_id, direction, amount_cents, category_id,
  description, to_char(occurred_on, 'YYYY-MM-DD') AS occurred_on, payment_entry_id,
  source_document_id, method, source, resolution_reference, created_by`;

class RequestError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// Wynik odtworzenia zapisu po kluczu idempotencji — kończy transakcję bez zapisu.
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

function parseEntryInput(data) {
  const description = textOrNull(data.description, 500);
  if (!validId(data.schoolYearId) || !DIRECTIONS.has(data.direction)
    || !validId(data.categoryId) || !validDate(data.occurredOn)
    || !METHODS.has(data.method) || !description || description.length < 3) {
    throw new RequestError('invalid_request');
  }
  const amountCents = readAmount(data.amountCents);
  const resolutionReference = textOrNull(data.resolutionReference, 200);
  if (data.direction === 'expense' && amountCents > RESOLUTION_THRESHOLD_CENTS && !resolutionReference) {
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
  };
}

function parseCorrectionInput(data) {
  const reason = textOrNull(data.reason, 500);
  if (!reason || reason.length < 3) throw new RequestError('invalid_reason');
  return { amountCents: readAmount(data.amountCents), reason };
}

// Kształt jak entryFromRow w Workerze: pola kategorii i korekt tylko wtedy,
// gdy zapytanie je zwraca (lista), a nie przy odtworzeniu po kluczu.
function entryFromRow(row) {
  const entry = {
    id: row.id,
    schoolYearId: row.school_year_id,
    direction: row.direction,
    amountCents: toSafeInteger(row.amount_cents),
    categoryId: row.category_id,
    categoryName: row.category_name ?? undefined,
    description: row.description,
    occurredOn: row.occurred_on,
    paymentEntryId: row.payment_entry_id ?? null,
    sourceDocumentId: row.source_document_id ?? null,
    method: row.method,
    source: row.source ?? null,
    resolutionReference: row.resolution_reference ?? null,
  };
  if (row.corrected_cents !== undefined) entry.correctedCents = toSafeInteger(row.corrected_cents);
  if (row.net_amount_cents !== undefined) entry.netAmountCents = toSafeInteger(row.net_amount_cents);
  return entry;
}

function correctionFromRow(row) {
  return {
    id: row.id,
    ledgerEntryId: row.ledger_entry_id,
    amountCents: toSafeInteger(row.amount_cents),
    reason: row.reason,
  };
}

function entryMatches(row, input, actorId) {
  return row.created_by === actorId
    && row.school_year_id === input.schoolYearId
    && row.direction === input.direction
    && toSafeInteger(row.amount_cents) === input.amountCents
    && row.category_id === input.categoryId
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
    && toSafeInteger(row.amount_cents) === input.amountCents
    && row.reason === input.reason;
}

async function loadEntryByKey(executor, key) {
  const { rows } = await executor.query(
    `SELECT ${ENTRY_COLUMNS} FROM ledger_entries WHERE idempotency_key = $1 LIMIT 1`,
    [key],
  );
  return rows[0] ?? null;
}

async function loadCorrectionByKey(executor, key) {
  const { rows } = await executor.query(
    `SELECT id, ledger_entry_id, amount_cents, reason, created_by
       FROM ledger_corrections WHERE idempotency_key = $1 LIMIT 1`,
    [key],
  );
  return rows[0] ?? null;
}

function encodeCursor(row) {
  return btoa(JSON.stringify([row.occurred_on, row.id]))
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
    return { occurredOn: decoded[0], id: decoded[1] };
  } catch {
    throw new RequestError('invalid_cursor');
  }
}

function isUniqueError(error) {
  return error?.code === '23505';
}

// Tłumaczy błędy triggerów i ograniczeń na kody API (jak mapDatabaseError w Workerze).
// Zwykle nieosiągalne — moduł sprawdza te warunki jawnie przed zapisem.
function mapDatabaseError(error) {
  if (error instanceof RequestError) throw error;
  const message = String(error?.message ?? '');
  if (message.includes('ledger_correction_exceeds_remaining_amount')) {
    throw new RequestError('correction_exceeds_remaining_amount', 409);
  }
  if (error?.constraint === 'ledger_large_expense_resolution') throw new RequestError('resolution_required');
  if (message.includes('ledger_category_inactive')) throw new RequestError('invalid_category');
  if (message.includes('ledger_payment_link_mismatch')
    || error?.constraint === 'ledger_payment_is_income') throw new RequestError('invalid_payment_link');
  // Backstop triggera ledger_entry_insert_guard (#138): kwota wpisu musi
  // równać się bieżącemu netto wpłaty. Aplikacja sprawdza to wcześniej
  // (payment_amount_mismatch); ten kod chroni przed równoległym zapisem.
  if (message.includes('ledger_payment_amount_mismatch')) throw new RequestError('payment_amount_mismatch', 422);
  if (message.includes('school_year_closed')) throw new RequestError('school_year_closed', 409);
  // Data spoza [starts_on, ends_on] roku (0027, trigger po zamrożeniu roku): jedna
  // reguła w bazie, więc bezpośredni INSERT i API odrzucają to samo.
  if (message.includes('date_outside_school_year')) throw new RequestError('date_outside_school_year', 422);
  if (error?.code === '23503') throw new RequestError('invalid_reference');
  throw error;
}

// Księga jest ogólnoszkolna: przydział z class_id nie daje do niej dostępu
// (isAuthorizedScoped bez classId pomija przydziały klasowe, jak SR-01 we wpłatach).
function hasFinancialAccess(context, schoolYearId) {
  return isAuthorizedScoped(context, { roles: FINANCIAL_ROLES, schoolYearId, requireMfa: true });
}

// Bez schoolYearId sprawdza samą rolę i MFA (przed odczytem wpisu po id);
// zakres roku sprawdza wtedy requireYear po odczycie.
async function requireFinancialContext(request, env, schoolYearId) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) throw new RequestError('unauthenticated', 401);
  if (!hasFinancialAccess(context, schoolYearId)) throw new RequestError('forbidden', 403);
  return context;
}

function requireYear(context, schoolYearId) {
  if (!hasFinancialAccess(context, schoolYearId)) throw new RequestError('forbidden', 403);
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
  const cursor = decodeCursor(url.searchParams.get('cursor'));
  await requireFinancialContext(request, env, schoolYearId);

  const values = [schoolYearId];
  const conditions = ['entry.school_year_id = $1'];
  if (direction) {
    values.push(direction);
    conditions.push(`entry.direction = $${values.length}`);
  }
  if (cursor) {
    values.push(cursor.occurredOn, cursor.id);
    const dateParam = `$${values.length - 1}::date`;
    const idParam = `$${values.length}`;
    // COLLATE "C": porządek bajtowy identyfikatorów, jak w SQLite/D1.
    conditions.push(`(entry.occurred_on < ${dateParam}
      OR (entry.occurred_on = ${dateParam} AND entry.id COLLATE "C" < ${idParam}))`);
  }
  values.push(limit + 1);
  const { rows } = await env.db.query(
    `SELECT entry.id, entry.school_year_id, entry.direction, entry.amount_cents,
            entry.category_id, category.name AS category_name, entry.description,
            to_char(entry.occurred_on, 'YYYY-MM-DD') AS occurred_on,
            entry.payment_entry_id, entry.source_document_id, entry.method, entry.source,
            entry.resolution_reference, entry.corrected_cents, entry.net_amount_cents
       FROM ledger_entry_net entry
       JOIN ledger_categories category ON category.id = entry.category_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY entry.occurred_on DESC, entry.id COLLATE "C" DESC
      LIMIT $${values.length}`,
    values,
  );
  const visibleRows = rows.slice(0, limit);
  const nextCursor = rows.length > limit && visibleRows.length
    ? encodeCursor(visibleRows[visibleRows.length - 1])
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
  await requireFinancialContext(request, env, schoolYearId);
  const values = [schoolYearId];
  const conditions = ['school_year_id = $1', 'active'];
  if (direction) {
    values.push(direction);
    conditions.push(`direction = $${values.length}`);
  }
  const { rows } = await env.db.query(
    `SELECT id, direction, name
       FROM ledger_categories
      WHERE ${conditions.join(' AND ')}
      ORDER BY direction, name COLLATE "C", id COLLATE "C"`,
    values,
  );
  return json({ categories: rows.map((row) => ({ id: row.id, direction: row.direction, name: row.name })) });
}

async function readSummary(request, env, url, json) {
  const { schoolYearId } = readOverviewFilters(url);
  await requireFinancialContext(request, env, schoolYearId);
  const { rows } = await env.db.query(
    `SELECT school_year_id, opening_balance_cents, income_cents, expense_cents, closing_balance_cents
       FROM ledger_year_summary
      WHERE school_year_id = $1
      LIMIT 1`,
    [schoolYearId],
  );
  const row = rows[0];
  if (!row) throw new RequestError('school_year_not_found', 404);
  return json({ summary: {
    schoolYearId: row.school_year_id,
    openingBalanceCents: toSafeInteger(row.opening_balance_cents),
    incomeCents: toSafeInteger(row.income_cents),
    expenseCents: toSafeInteger(row.expense_cents),
    closingBalanceCents: toSafeInteger(row.closing_balance_cents),
  } });
}

async function listBudget(request, env, url, json) {
  const { schoolYearId } = readOverviewFilters(url);
  await requireFinancialContext(request, env, schoolYearId);
  const { rows } = await env.db.query(
    `SELECT line.id, line.category_id, category.direction, category.name AS category_name,
            line.planned_cents, line.note, line.supersedes_id
       FROM ledger_current_budget line
       JOIN ledger_categories category ON category.id = line.category_id
      WHERE line.school_year_id = $1
      ORDER BY category.direction, category.name COLLATE "C", line.id COLLATE "C"`,
    [schoolYearId],
  );
  return json({ budget: rows.map((row) => ({
    id: row.id,
    categoryId: row.category_id,
    categoryName: row.category_name,
    direction: row.direction,
    plannedCents: toSafeInteger(row.planned_cents),
    note: row.note ?? null,
    supersedesId: row.supersedes_id ?? null,
  })) });
}

const REPLAYED = { 'Idempotency-Replayed': 'true' };
const CREATED = { 'Idempotency-Replayed': 'false' };

// Kolejność sprawdzeń odpowiada kolejności triggerów w D1 (ostatnio utworzony
// działa pierwszy): powiązanie wpłaty, uchwała, dokument, kategoria, a na końcu
// unikalność powiązania wpłaty.
async function validateEntryReferences(tx, input, payment) {
  if (input.paymentEntryId && (!payment || payment.school_year_id !== input.schoolYearId
    || payment.status !== 'recorded' || input.direction !== 'income')) {
    throw new RequestError('invalid_payment_link');
  }
  // Kwota wpisu musi równać się bieżącemu netto wpłaty (kwota - korekty -
  // zwroty), inaczej wpłata 25 EUR mogłaby zostać ujęta w księdze jako
  // 250 EUR (#138). Trigger ledger_entry_insert_guard sprawdza to ponownie
  // na poziomie bazy (backstop przy równoległym zapisie).
  if (input.paymentEntryId && payment && toSafeInteger(payment.net_amount_cents) !== input.amountCents) {
    throw new RequestError('payment_amount_mismatch', 422);
  }
  // Referencja krótsza niż 3 znaki nie spełnia wymogu uchwały (jak trigger D1
  // i CHECK ledger_large_expense_resolution w 0003_ledger.sql).
  if (input.direction === 'expense' && input.amountCents > RESOLUTION_THRESHOLD_CENTS
    && (input.resolutionReference ?? '').length < 3) {
    throw new RequestError('resolution_required');
  }
  if (input.sourceDocumentId) {
    const { rows } = await tx.query('SELECT 1 FROM documents WHERE id = $1', [input.sourceDocumentId]);
    if (!rows.length) throw new RequestError('invalid_source_document');
  }
  const category = await tx.query(
    `SELECT 1 FROM ledger_categories
      WHERE id = $1 AND school_year_id = $2 AND direction = $3 AND active`,
    [input.categoryId, input.schoolYearId, input.direction],
  );
  if (!category.rows.length) throw new RequestError('invalid_category');
  if (input.paymentEntryId) {
    const linked = await tx.query('SELECT 1 FROM ledger_entries WHERE payment_entry_id = $1', [input.paymentEntryId]);
    if (linked.rows.length) throw new RequestError('payment_already_linked', 409);
  }
}

async function createEntry(request, env, json) {
  const idempotencyKey = readIdempotencyKey(request);
  const input = parseEntryInput(await readJson(request));
  const context = await requireFinancialContext(request, env, input.schoolYearId);
  const actorId = context.session.user.id;

  const replayOrConflict = (row) => {
    if (!row) return null;
    if (!entryMatches(row, input, actorId)) throw new RequestError('idempotency_conflict', 409);
    return new Replay({ entry: entryFromRow(row) });
  };

  let result;
  try {
    result = await env.db.transaction(async (tx) => {
      // Blokada wpłaty przed odczytem klucza: równoległe ujęcia tej samej wpłaty
      // czekają na siebie; po zwolnieniu blokady ponowienie widzi zapis i go odtwarza.
      let payment = null;
      if (input.paymentEntryId) {
        // Blokuje wiersz wpłaty (payment_entries), więc równoległa korekta lub
        // zwrot tej wpłaty czeka; netto czytane z widoku po blokadzie.
        await tx.query('SELECT id FROM payment_entries WHERE id = $1 FOR UPDATE', [input.paymentEntryId]);
        const { rows } = await tx.query(
          'SELECT id, school_year_id, status, net_amount_cents FROM payment_entry_net WHERE id = $1',
          [input.paymentEntryId],
        );
        payment = rows[0] ?? null;
      }
      const replay = replayOrConflict(await loadEntryByKey(tx, idempotencyKey));
      if (replay) return replay;
      await validateEntryReferences(tx, input, payment);
      const entryId = crypto.randomUUID();
      await tx.query(
        `INSERT INTO ledger_entries (
           id, school_year_id, direction, amount_cents, category_id, description, occurred_on,
           payment_entry_id, source_document_id, created_by, method, source,
           resolution_reference, idempotency_key
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [entryId, input.schoolYearId, input.direction, input.amountCents, input.categoryId,
          input.description, input.occurredOn, input.paymentEntryId, input.sourceDocumentId,
          actorId, input.method, input.source, input.resolutionReference, idempotencyKey],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'ledger.entry.created', entityType: 'ledger_entry', entityId: entryId,
      });
      return { entry: { id: entryId, ...input } };
    });
  } catch (error) {
    if (isUniqueError(error)) {
      // Równoległe żądanie z tym samym kluczem zdążyło zapisać wpis albo inna
      // osoba właśnie ujęła tę samą wpłatę.
      const replay = replayOrConflict(await loadEntryByKey(env.db, idempotencyKey));
      if (replay) return json(replay.body, 200, REPLAYED);
      throw new RequestError('payment_already_linked', 409);
    }
    mapDatabaseError(error);
  }
  if (result instanceof Replay) return json(result.body, 200, REPLAYED);
  return json(result, 201, CREATED);
}

async function createCorrection(request, env, ledgerEntryId, json) {
  if (!validId(ledgerEntryId)) throw new RequestError('invalid_ledger_entry_id');
  const idempotencyKey = readIdempotencyKey(request);
  const input = parseCorrectionInput(await readJson(request));
  const context = await requireFinancialContext(request, env);
  const actorId = context.session.user.id;

  const replayOrConflict = (row) => {
    if (!row) return null;
    if (!correctionMatches(row, ledgerEntryId, input, actorId)) {
      throw new RequestError('idempotency_conflict', 409);
    }
    return new Replay({ correction: correctionFromRow(row) });
  };

  let result;
  try {
    result = await env.db.transaction(async (tx) => {
      // Blokada wiersza wpisu: równoległe korekty tego samego wpisu czekają na siebie.
      const { rows } = await tx.query(
        'SELECT id, school_year_id, amount_cents FROM ledger_entries WHERE id = $1 FOR UPDATE',
        [ledgerEntryId],
      );
      const entry = rows[0];
      if (!entry) throw new RequestError('ledger_entry_not_found', 404);
      requireYear(context, entry.school_year_id);
      const replay = replayOrConflict(await loadCorrectionByKey(tx, idempotencyKey));
      if (replay) return replay;
      const corrected = await tx.query(
        'SELECT COALESCE(SUM(amount_cents), 0) AS corrected_cents FROM ledger_corrections WHERE ledger_entry_id = $1',
        [ledgerEntryId],
      );
      if (toSafeInteger(corrected.rows[0].corrected_cents) + input.amountCents > toSafeInteger(entry.amount_cents)) {
        throw new RequestError('correction_exceeds_remaining_amount', 409);
      }
      const correctionId = crypto.randomUUID();
      await tx.query(
        `INSERT INTO ledger_corrections (id, ledger_entry_id, amount_cents, reason, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [correctionId, ledgerEntryId, input.amountCents, input.reason, actorId, idempotencyKey],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'ledger.correction.created', entityType: 'ledger_correction',
        entityId: correctionId, metadata: { ledgerEntryId },
      });
      return { correction: { id: correctionId, ledgerEntryId, amountCents: input.amountCents, reason: input.reason } };
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

// --- Eksport CSV (issue #7) -------------------------------------------------

const DIRECTION_LABELS = { income: 'Przychód', expense: 'Wydatek' };
const METHOD_LABELS = { bank: 'Przelew', cash: 'Gotówka', card: 'Karta', other: 'Inna' };
// Typ kolumny: 'text' przechodzi przez neutralizację formuł, 'amount' (centy)
// jest formatowany jako liczba „-12,50” bez apostrofu (issue #121).
export const LEDGER_CSV_COLUMNS = [
  ['id_wpisu', 'text'], ['data', 'text'], ['rodzaj', 'text'], ['kategoria', 'text'], ['opis', 'text'],
  ['metoda', 'text'], ['zrodlo', 'text'], ['referencja_uchwaly', 'text'], ['id_wplaty', 'text'],
  ['id_dokumentu', 'text'], ['kwota_eur', 'amount'], ['korekty_eur', 'amount'], ['netto_eur', 'amount'],
].map(([header, type]) => ({ header, type }));

export { csvCell, formatEuro };

export function ledgerCsvLine(row) {
  return csvRow(LEDGER_CSV_COLUMNS, [
    row.id, row.occurred_on, DIRECTION_LABELS[row.direction], row.category_name, row.description,
    METHOD_LABELS[row.method], row.source, row.resolution_reference, row.payment_entry_id,
    row.source_document_id, row.amount_cents, row.corrected_cents, row.net_amount_cents,
  ]);
}

async function exportCsv(request, env, url) {
  const { schoolYearId } = readOverviewFilters(url);
  const context = await requireFinancialContext(request, env, schoolYearId);
  const actorId = context.session.user.id;
  const rows = await env.db.transaction(async (tx) => {
    const year = await tx.query('SELECT id FROM school_years WHERE id = $1', [schoolYearId]);
    if (!year.rows.length) throw new RequestError('school_year_not_found', 404);
    const result = await tx.query(
      `SELECT entry.id, to_char(entry.occurred_on, 'YYYY-MM-DD') AS occurred_on, entry.direction,
              category.name AS category_name, entry.description, entry.method, entry.source,
              entry.resolution_reference, entry.payment_entry_id, entry.source_document_id,
              entry.amount_cents, entry.corrected_cents, entry.net_amount_cents
         FROM ledger_entry_net entry
         JOIN ledger_categories category ON category.id = entry.category_id
        WHERE entry.school_year_id = $1
        ORDER BY entry.occurred_on, entry.id COLLATE "C"
        LIMIT $2`,
      [schoolYearId, MAX_EXPORT_ROWS + 1],
    );
    if (result.rows.length > MAX_EXPORT_ROWS) throw new RequestError('export_too_large', 413);
    // Dziennik: kto i kiedy wyeksportował który rok; bez kwot i treści wpisów.
    await insertAuditEvent(tx, {
      actorId, action: 'ledger.exported', entityType: 'school_year', entityId: schoolYearId,
      metadata: { format: 'csv', rowCount: result.rows.length },
    });
    return result.rows;
  });
  const lines = [csvHeader(LEDGER_CSV_COLUMNS), ...rows.map(ledgerCsvLine)];
  // BOM UTF-8, żeby arkusz poprawnie odczytał polskie znaki.
  return new Response(`﻿${lines.join('\r\n')}\r\n`, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="ksiega-${schoolYearId.replace(/[^A-Za-z0-9_-]/g, '_')}.csv"`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function handle(request, env, url, json) {
  const correctionMatch = url.pathname.match(/^\/api\/ledger\/([^/]+)\/corrections$/);
  const isEntryRoute = url.pathname === '/api/ledger';
  const isList = request.method === 'GET' && isEntryRoute;
  const isCategories = request.method === 'GET' && url.pathname === '/api/ledger/categories';
  const isSummary = request.method === 'GET' && url.pathname === '/api/ledger/summary';
  const isBudget = request.method === 'GET' && url.pathname === '/api/ledger/budget';
  const isExport = request.method === 'GET' && url.pathname === '/api/ledger/export.csv';
  const isMutation = request.method === 'POST' && (isEntryRoute || correctionMatch);
  if (!isList && !isCategories && !isSummary && !isBudget && !isExport && !isMutation) return null;
  // handlePgRequest sprawdza Origin wcześniej; tu powtórnie, gdyby moduł użyto samodzielnie.
  if (isMutation && !isSameOrigin(request)) return json({ error: 'invalid_origin' }, 403);

  try {
    if (isList) return await listEntries(request, env, url, json);
    if (isCategories) return await listCategories(request, env, url, json);
    if (isSummary) return await readSummary(request, env, url, json);
    if (isBudget) return await listBudget(request, env, url, json);
    if (isExport) return await exportCsv(request, env, url);
    if (isEntryRoute) return await createEntry(request, env, json);
    return await createCorrection(request, env, decodeId(correctionMatch[1]), json);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.code }, error.status);
    throw error;
  }
}
