// Kasa i rachunek w księdze (#199). Prototyp — nie jest wdrożony.
//
//   GET  /api/ledger/transfers?schoolYearId=…                 lista przeniesień kasa ↔ rachunek
//   POST /api/ledger/transfers                                 (Idempotency-Key)
//        { schoolYearId, direction: 'cash_to_bank'|'bank_to_cash', amountCents, transferredOn,
//          description, sourceDocumentId? }  albo storno: { reversesId, description }
//   GET  /api/ledger/opening-balance?schoolYearId=…           bilans otwarcia z podziałem i poprawkami
//   POST /api/ledger/opening-balance                           (Idempotency-Key) — pierwszy rok
//        { schoolYearId, bankCents, cashCents, note, sourceDocumentId? }
//   POST /api/ledger/opening-balance/adjustments               (Idempotency-Key)
//        { schoolYearId, amountCents, cashCents, reason, sourceDocumentId? }
//
// Przeniesienie jest operacją wewnętrzną: nie jest przychodem ani wydatkiem
// (ledger_year_summary bez zmian), zmienia tylko podział rachunek/kasa
// (ledger_non_bank_net_at). Wszystkie zapisy są niezmienne; korekta to nowy
// wiersz (storno przeniesienia, poprawka bilansu otwarcia). Zapis i zdarzenie
// audytu w jednej transakcji; audyt bez kwot i opisów.
//
// Założenia do decyzji (wariant zachowawczy, zarząd nic jeszcze nie zdecydował):
//   * D-13: jedna kasa i jeden rachunek; „kasa” = wszystko poza rachunkiem.
//   * Bilans otwarcia i jego poprawki: wyłącznie zarząd z MFA (bez admina
//     i skarbnika); zasada czterech oczu dla poprawek zależy od D-12 — nie ma jej.
//   * Ręczny bilans otwarcia tylko dla PIERWSZEGO roku w systemie (brak roku
//     o wcześniejszym starts_on). Kolejne lata dostają bilans z zamknięcia roku.
//   * Przeniesienia: admin, zarząd, skarbnik z MFA (jak wpisy księgi).

import { isSameOrigin } from '../../auth.js';
import { isAuthorizedScoped, loadAuthorizationContext, logAccessDenied } from '../authorization.js';
import { insertAuditEvent } from '../audit.js';
import { gateFreeText, piiAuditMetadata } from '../pii-gate.js';
import { toSafeInteger } from './payments.js';
import { createIdempotencyKeyReader, createJsonReader } from '../input.js';

export const name = 'ledger-cash';

const TRANSFER_ROLES = ['admin', 'board', 'treasurer'];
const READ_ROLES = ['admin', 'board', 'treasurer'];
const OPENING_ROLES = ['board'];
const DIRECTIONS = new Set(['cash_to_bank', 'bank_to_cash']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_AMOUNT_CENTS = 100_000_000;
// ledger_opening_balances.amount_cents i adjustments.amount_cents to INTEGER.
const MAX_OPENING_CENTS = 2_000_000_000;

const TRANSFER_COLUMNS = `id, school_year_id, direction, amount_cents,
  to_char(transferred_on, 'YYYY-MM-DD') AS transferred_on, description, source_document_id,
  reverses_id, created_by`;

class RequestError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

// #152: błąd 422 bramki pól wolnego tekstu (src/pg/pii-gate.js).
function piiFail(code, categories) {
  return new RequestError(code, 422, { categories });
}

class Replay {
  constructor(body) {
    this.body = body;
  }
}

const validId = (value) => typeof value === 'string' && ID_PATTERN.test(value);

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function text(value, min, max, code) {
  if (typeof value !== 'string') throw new RequestError(code);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) throw new RequestError(code);
  return normalized;
}

function optionalId(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!validId(value)) throw new RequestError('invalid_request');
  return value;
}

function readCents(value, { min, max, code = 'invalid_amount' }) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RequestError(code);
  return value;
}

const readJson = createJsonReader({
  maxBytes: MAX_BODY_BYTES,
  error: (code, status) => new RequestError(code, status),
});

const readIdempotencyKey = createIdempotencyKeyReader({ error: (code, status) => new RequestError(code, status) });

// Przydział z class_id nie daje dostępu (isAuthorizedScoped bez classId).
async function requireAccess(request, env, roles, schoolYearId) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) throw new RequestError('unauthenticated', 401);
  if (!isAuthorizedScoped(context, { roles, schoolYearId, requireMfa: true })) {
    // #184: ślad odmowy 403 (przed transakcją żądania).
    await logAccessDenied(env, context, { roles }, request);
    throw new RequestError('forbidden', 403);
  }
  return context;
}

function mapDatabaseError(error) {
  if (error instanceof RequestError) throw error;
  const message = String(error?.message ?? '');
  if (message.includes('school_year_closed')) throw new RequestError('school_year_closed', 409);
  if (message.includes('date_outside_school_year')) throw new RequestError('date_outside_school_year', 422);
  if (message.includes('ledger_transfer_reversal_mismatch')) throw new RequestError('invalid_reversal', 409);
  if (error?.code === '23503') throw new RequestError('invalid_reference');
  throw error;
}

const REPLAYED = { 'Idempotency-Replayed': 'true' };
const CREATED = { 'Idempotency-Replayed': 'false' };

async function requireSchoolYear(executor, schoolYearId) {
  const { rows } = await executor.query(
    `SELECT id, to_char(starts_on, 'YYYY-MM-DD') AS starts_on FROM school_years WHERE id = $1`, [schoolYearId],
  );
  if (!rows[0]) throw new RequestError('school_year_not_found', 404);
  return rows[0];
}

// #87: jak w księdze — tylko dokument finansowy z API tego samego roku; każdy
// inny przypadek (w tym nieistniejący) daje ten sam kod.
async function requireDocument(executor, documentId, schoolYearId) {
  if (!documentId) return;
  const { rows } = await executor.query(
    `SELECT 1 FROM documents
      WHERE id = $1 AND kind = 'financial' AND school_year_id IS NOT NULL AND school_year_id = $2`,
    [documentId, schoolYearId],
  );
  if (!rows.length) throw new RequestError('invalid_source_document');
}

// --- przeniesienia -----------------------------------------------------------

function transferFromRow(row) {
  return {
    id: row.id,
    schoolYearId: row.school_year_id,
    direction: row.direction,
    amountCents: toSafeInteger(row.amount_cents),
    transferredOn: row.transferred_on,
    description: row.description,
    sourceDocumentId: row.source_document_id ?? null,
    reversesId: row.reverses_id ?? null,
  };
}

function parseTransfer(data) {
  if (!validId(data.schoolYearId)) throw new RequestError('invalid_request');
  const description = text(data.description, 3, 500, 'invalid_description');
  const sourceDocumentId = optionalId(data.sourceDocumentId);
  if (data.reversesId !== undefined && data.reversesId !== null) {
    if (!validId(data.reversesId)) throw new RequestError('invalid_request');
    return { schoolYearId: data.schoolYearId, reversesId: data.reversesId, description, sourceDocumentId };
  }
  if (!DIRECTIONS.has(data.direction) || !validDate(data.transferredOn)) throw new RequestError('invalid_request');
  return {
    schoolYearId: data.schoolYearId,
    direction: data.direction,
    amountCents: readCents(data.amountCents, { min: 1, max: MAX_AMOUNT_CENTS }),
    transferredOn: data.transferredOn,
    description,
    sourceDocumentId,
    reversesId: null,
  };
}

function transferMatches(row, input, actorId) {
  return row.created_by === actorId
    && row.school_year_id === input.schoolYearId
    && row.description === input.description
    && (row.source_document_id ?? null) === input.sourceDocumentId
    && (row.reverses_id ?? null) === input.reversesId
    && (input.reversesId !== null || (row.direction === input.direction
      && toSafeInteger(row.amount_cents) === input.amountCents && row.transferred_on === input.transferredOn));
}

async function listTransfers(request, env, url, json) {
  const schoolYearId = url.searchParams.get('schoolYearId');
  if (!validId(schoolYearId)) throw new RequestError('invalid_request');
  await requireAccess(request, env, READ_ROLES, schoolYearId);
  await requireSchoolYear(env.db, schoolYearId);
  const { rows } = await env.db.query(
    `SELECT ${TRANSFER_COLUMNS} FROM ledger_transfers WHERE school_year_id = $1
      ORDER BY transferred_on, created_at, id`,
    [schoolYearId],
  );
  return json({ transfers: rows.map(transferFromRow) });
}

async function createTransfer(request, env, json) {
  const key = readIdempotencyKey(request);
  const transferData = await readJson(request);
  const input = parseTransfer(transferData);
  const confirmPersonalData = transferData.confirmPersonalData === true;
  const context = await requireAccess(request, env, TRANSFER_ROLES, input.schoolYearId);
  const actorId = context.session.user.id;
  const byKey = async (executor) => (await executor.query(
    `SELECT ${TRANSFER_COLUMNS} FROM ledger_transfers WHERE idempotency_key = $1`, [key],
  )).rows[0] ?? null;
  const replayOrConflict = (row) => {
    if (!row) return null;
    if (!transferMatches(row, input, actorId)) throw new RequestError('idempotency_conflict', 409);
    return new Replay({ transfer: transferFromRow(row) });
  };

  let result;
  try {
    result = await env.db.transaction(async (tx) => {
      const replay = replayOrConflict(await byKey(tx));
      if (replay) return replay;
      await requireSchoolYear(tx, input.schoolYearId);
      await requireDocument(tx, input.sourceDocumentId, input.schoolYearId);
      const gate = gateFreeText([['ledger_transfers.description', input.description]], { confirm: confirmPersonalData, fail: piiFail });
      let values = input;
      if (input.reversesId) {
        // Storno: przeciwny kierunek, ta sama kwota i data pierwotnego zapisu.
        const { rows } = await tx.query(
          `SELECT ${TRANSFER_COLUMNS} FROM ledger_transfers WHERE id = $1 FOR UPDATE`, [input.reversesId],
        );
        const original = rows[0];
        if (!original || original.school_year_id !== input.schoolYearId) throw new RequestError('transfer_not_found', 404);
        if (original.reverses_id) throw new RequestError('invalid_reversal', 409);
        const { rows: reversed } = await tx.query('SELECT 1 FROM ledger_transfers WHERE reverses_id = $1', [original.id]);
        if (reversed.length) throw new RequestError('transfer_already_reversed', 409);
        values = {
          ...input,
          direction: original.direction === 'cash_to_bank' ? 'bank_to_cash' : 'cash_to_bank',
          amountCents: toSafeInteger(original.amount_cents),
          transferredOn: original.transferred_on,
        };
      }
      const id = crypto.randomUUID();
      await tx.query(
        `INSERT INTO ledger_transfers (id, school_year_id, direction, amount_cents, transferred_on, description,
           source_document_id, reverses_id, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, values.schoolYearId, values.direction, values.amountCents, values.transferredOn, values.description,
          values.sourceDocumentId, values.reversesId, actorId, key],
      );
      await insertAuditEvent(tx, {
        actorId, action: values.reversesId ? 'ledger.transfer.reversed' : 'ledger.transfer.created',
        entityType: 'ledger_transfer', entityId: id,
        metadata: { schoolYearId: values.schoolYearId, reversesId: values.reversesId, ...piiAuditMetadata(gate) },
      });
      return { transfer: transferFromRow((await tx.query(`SELECT ${TRANSFER_COLUMNS} FROM ledger_transfers WHERE id = $1`, [id])).rows[0]) };
    });
  } catch (error) {
    if (error?.code === '23505') {
      // Równoległe żądanie z tym samym kluczem albo drugie storno tego samego zapisu.
      const replay = replayOrConflict(await byKey(env.db));
      if (replay) return json(replay.body, 200, REPLAYED);
      throw new RequestError('transfer_already_reversed', 409);
    }
    mapDatabaseError(error);
  }
  if (result instanceof Replay) return json(result.body, 200, REPLAYED);
  return json(result, 201, CREATED);
}

// --- bilans otwarcia ---------------------------------------------------------

async function loadOpening(executor, schoolYearId) {
  const { rows } = await executor.query(
    `SELECT id, school_year_id, amount_cents, cash_cents, source_document_id, note, created_by, created_at, idempotency_key
       FROM ledger_opening_balances WHERE school_year_id = $1`,
    [schoolYearId],
  );
  return rows[0] ?? null;
}

async function openingView(executor, schoolYearId) {
  const opening = await loadOpening(executor, schoolYearId);
  if (!opening) return { schoolYearId, openingBalance: null, adjustments: [], current: null };
  const { rows } = await executor.query(
    `SELECT id, amount_cents, cash_cents, reason, created_by, created_at
       FROM ledger_opening_balance_adjustments WHERE opening_balance_id = $1 ORDER BY created_at, id`,
    [opening.id],
  );
  const { rows: carried } = await executor.query(
    'SELECT school_year_id FROM school_year_closures WHERE carried_opening_balance_id = $1', [opening.id],
  );
  const adjustments = rows.map((row) => ({
    id: row.id,
    amountCents: toSafeInteger(row.amount_cents),
    cashCents: toSafeInteger(row.cash_cents),
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
  }));
  const amountCents = toSafeInteger(opening.amount_cents) + adjustments.reduce((sum, a) => sum + a.amountCents, 0);
  const cashCents = toSafeInteger(opening.cash_cents) + adjustments.reduce((sum, a) => sum + a.cashCents, 0);
  const baseAmount = toSafeInteger(opening.amount_cents);
  const baseCash = toSafeInteger(opening.cash_cents);
  return {
    schoolYearId,
    openingBalance: {
      id: opening.id,
      amountCents: baseAmount,
      cashCents: baseCash,
      bankCents: baseAmount - baseCash,
      note: opening.note ?? null,
      sourceDocumentId: opening.source_document_id ?? null,
      carriedFromSchoolYearId: carried[0]?.school_year_id ?? null,
      createdBy: opening.created_by,
    },
    adjustments,
    current: { amountCents, cashCents, bankCents: amountCents - cashCents },
  };
}

async function getOpening(request, env, url, json) {
  const schoolYearId = url.searchParams.get('schoolYearId');
  if (!validId(schoolYearId)) throw new RequestError('invalid_request');
  await requireAccess(request, env, READ_ROLES, schoolYearId);
  await requireSchoolYear(env.db, schoolYearId);
  return json(await openingView(env.db, schoolYearId));
}

async function createOpening(request, env, json) {
  const key = readIdempotencyKey(request);
  const data = await readJson(request);
  if (!validId(data.schoolYearId)) throw new RequestError('invalid_request');
  const bankCents = readCents(data.bankCents, { min: -MAX_OPENING_CENTS, max: MAX_OPENING_CENTS });
  // Gotówki w kasie nie może być mniej niż zero.
  const cashCents = readCents(data.cashCents, { min: 0, max: MAX_OPENING_CENTS });
  if (Math.abs(bankCents + cashCents) > MAX_OPENING_CENTS) throw new RequestError('invalid_amount');
  const note = text(data.note, 3, 500, 'invalid_note');
  const sourceDocumentId = optionalId(data.sourceDocumentId);
  const schoolYearId = data.schoolYearId;
  const context = await requireAccess(request, env, OPENING_ROLES, schoolYearId);
  const actorId = context.session.user.id;

  try {
    return await env.db.transaction(async (tx) => {
      // Jeden bilans otwarcia na rok: blokada serializuje równoległe próby.
      await tx.query('LOCK TABLE ledger_opening_balances IN SHARE ROW EXCLUSIVE MODE');
      const existing = await loadOpening(tx, schoolYearId);
      if (existing) {
        const same = existing.idempotency_key === key && existing.created_by === actorId
          && toSafeInteger(existing.amount_cents) === bankCents + cashCents
          && toSafeInteger(existing.cash_cents) === cashCents && existing.note === note
          && (existing.source_document_id ?? null) === sourceDocumentId;
        if (same) return json(await openingView(tx, schoolYearId), 200, REPLAYED);
        if (existing.idempotency_key === key) throw new RequestError('idempotency_conflict', 409);
        throw new RequestError('opening_balance_exists', 409);
      }
      const year = await requireSchoolYear(tx, schoolYearId);
      const { rows: earlier } = await tx.query(
        'SELECT 1 FROM school_years WHERE starts_on < $1::date LIMIT 1', [year.starts_on],
      );
      if (earlier.length) throw new RequestError('not_first_school_year', 409);
      await requireDocument(tx, sourceDocumentId, schoolYearId);
      const gate = gateFreeText([['ledger_opening_balances.note', note]], { confirm: data.confirmPersonalData === true, fail: piiFail });
      const id = crypto.randomUUID();
      await tx.query(
        `INSERT INTO ledger_opening_balances (id, school_year_id, amount_cents, cash_cents, source_document_id,
           note, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, schoolYearId, bankCents + cashCents, cashCents, sourceDocumentId, note, actorId, key],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'ledger_opening_balance.created', entityType: 'ledger_opening_balance', entityId: id,
        metadata: { schoolYearId, ...piiAuditMetadata(gate) },
      });
      return json(await openingView(tx, schoolYearId), 201, CREATED);
    });
  } catch (error) {
    if (error?.code === '23505') throw new RequestError('opening_balance_exists', 409);
    mapDatabaseError(error);
  }
}

async function createAdjustment(request, env, json) {
  const key = readIdempotencyKey(request);
  const data = await readJson(request);
  if (!validId(data.schoolYearId)) throw new RequestError('invalid_request');
  const amountCents = readCents(data.amountCents ?? 0, { min: -MAX_OPENING_CENTS, max: MAX_OPENING_CENTS });
  const cashCents = readCents(data.cashCents ?? 0, { min: -MAX_OPENING_CENTS, max: MAX_OPENING_CENTS });
  if (amountCents === 0 && cashCents === 0) throw new RequestError('invalid_amount');
  const reason = text(data.reason, 3, 500, 'invalid_reason');
  const schoolYearId = data.schoolYearId;
  const context = await requireAccess(request, env, OPENING_ROLES, schoolYearId);
  const actorId = context.session.user.id;

  const byKey = async (executor) => (await executor.query(
    `SELECT a.id, a.amount_cents, a.cash_cents, a.reason, a.created_by, o.school_year_id
       FROM ledger_opening_balance_adjustments a JOIN ledger_opening_balances o ON o.id = a.opening_balance_id
      WHERE a.idempotency_key = $1`, [key],
  )).rows[0] ?? null;
  const replayOrConflict = async (row, executor) => {
    if (!row) return null;
    if (row.created_by !== actorId || row.school_year_id !== schoolYearId || row.reason !== reason
      || toSafeInteger(row.amount_cents) !== amountCents || toSafeInteger(row.cash_cents) !== cashCents) {
      throw new RequestError('idempotency_conflict', 409);
    }
    return json({ adjustmentId: row.id, ...(await openingView(executor, schoolYearId)) }, 200, REPLAYED);
  };

  try {
    return await env.db.transaction(async (tx) => {
      const replay = await replayOrConflict(await byKey(tx), tx);
      if (replay) return replay;
      await requireSchoolYear(tx, schoolYearId);
      const { rows } = await tx.query(
        'SELECT id, amount_cents, cash_cents FROM ledger_opening_balances WHERE school_year_id = $1 FOR UPDATE',
        [schoolYearId],
      );
      const opening = rows[0];
      if (!opening) throw new RequestError('opening_balance_not_found', 404);
      const view = await openingView(tx, schoolYearId);
      const totalAfter = view.current.amountCents + amountCents;
      const cashAfter = view.current.cashCents + cashCents;
      if (Math.abs(totalAfter) > MAX_OPENING_CENTS) throw new RequestError('invalid_amount');
      if (cashAfter < 0) throw new RequestError('cash_below_zero', 409);
      const gate = gateFreeText([['ledger_opening_balance_adjustments.reason', reason]], { confirm: data.confirmPersonalData === true, fail: piiFail });
      const id = crypto.randomUUID();
      await tx.query(
        `INSERT INTO ledger_opening_balance_adjustments (id, opening_balance_id, amount_cents, cash_cents, reason,
           created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, opening.id, amountCents, cashCents, reason, actorId, key],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'ledger_opening_balance.adjusted', entityType: 'ledger_opening_balance_adjustment', entityId: id,
        metadata: { schoolYearId, openingBalanceId: opening.id, ...piiAuditMetadata(gate) },
      });
      return json({ adjustmentId: id, ...(await openingView(tx, schoolYearId)) }, 201, CREATED);
    });
  } catch (error) {
    if (error?.code === '23505') {
      const replay = await replayOrConflict(await byKey(env.db), env.db);
      if (replay) return replay;
    }
    mapDatabaseError(error);
  }
}

// --- router ------------------------------------------------------------------

export async function handle(request, env, url, json) {
  const path = url.pathname;
  const isTransfers = path === '/api/ledger/transfers';
  const isOpening = path === '/api/ledger/opening-balance';
  const isAdjustments = path === '/api/ledger/opening-balance/adjustments';
  if (!isTransfers && !isOpening && !isAdjustments) return null;
  const method = request.method;
  if (method === 'POST' && !isSameOrigin(request)) return json({ error: 'invalid_origin' }, 403);
  try {
    if (isTransfers && method === 'GET') return await listTransfers(request, env, url, json);
    if (isTransfers && method === 'POST') return await createTransfer(request, env, json);
    if (isOpening && method === 'GET') return await getOpening(request, env, url, json);
    if (isOpening && method === 'POST') return await createOpening(request, env, json);
    if (isAdjustments && method === 'POST') return await createAdjustment(request, env, json);
    const allow = isTransfers || isOpening ? 'GET, POST' : 'POST';
    return json({ error: 'method_not_allowed' }, 405, { Allow: allow });
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.code, ...error.extra }, error.status);
    throw error;
  }
}
