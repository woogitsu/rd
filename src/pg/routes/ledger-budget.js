// Preliminarz i kategorie księgi przez API (#107). Prototyp — nie jest wdrożony.
//
//   POST /api/ledger/categories/{id}/deactivation        (Idempotency-Key) { reason }
//   POST /api/ledger/budget                              (Idempotency-Key) { schoolYearId, categoryId, plannedCents, note? }
//   POST /api/ledger/budget/{lineId}/revisions           (Idempotency-Key) { plannedCents, reason }
//   POST /api/ledger/budget/adoptions                    (Idempotency-Key) { schoolYearId, adoptedOn, note, resolutionId? }
//   GET  /api/ledger/budget/history?schoolYearId=…       wszystkie wersje linii i przyjęcia
//   GET  /api/ledger/budget/execution?schoolYearId=…[&asOf=RRRR-MM-DD][&format=json|csv|html]
//
// Tworzenie kategorii (POST /api/ledger/categories) obsługuje ledger.js
// (#207) — ta sama trasa, z opcjonalnym nagłówkiem Idempotency-Key, którego
// ten moduł zawsze używa (patrz komentarz przy createCategory w ledger.js).
// Uniknięcie dwóch tras pod tym samym adresem (kolizja #107/#207 wykryta przy
// scaleniu z main: registerowany jako pierwszy moduł ledger.js zawsze
// przechwytywał POST /api/ledger/categories, więc trasa poniżej nigdy nie była
// wywoływana — klucz idempotencji nie trafiał do bazy).
//
// Bilans otwarcia i jego poprawki mają już trasy w ledger-cash.js (#199).
// Wszystkie zapisy są niezmienne: nowa wersja linii wskazuje poprzednią
// (supersedes_id UNIQUE — z dwóch równoległych rewizji jedna wygrywa, druga
// dostaje 409), wyłączenie kategorii ma własny wpis historii, przyjęcie
// preliminarza zapisuje zestaw bieżących wersji linii (0073). Zapis i zdarzenie
// audytu w jednej transakcji; audyt ma aktora, czas i identyfikatory, bez kwot.
//
// Założenia do decyzji (wariant zachowawczy):
//   * D-08: kategorie i linie preliminarza zapisują role finansowe (admin,
//     zarząd, skarbnik) z MFA — jak wpisy księgi; przyjęcie preliminarza
//     (fakt uchwalenia przez zebranie) zapisuje wyłącznie zarząd.
//   * D-09: zestawienie plan vs wykonanie przez tę trasę czytają role
//     finansowe; Komisja Rewizyjna widzi je w swoim raporcie (sekcja 2a).
//   * D-21: kto uchwala preliminarz — nie rozstrzygamy; uchwała jest
//     opcjonalna, a gdy wskazana, musi być przyjęta, bieżąca i z zebrania
//     ogólnego tego samego roku.
//   * „Wykonanie na dzień” (asOf) filtruje wpisy po dacie wpisu i przyjęcia po
//     dacie przyjęcia; korekty wpisów liczą się według stanu bieżącego.

import { isSameOrigin } from '../../auth.js';
import { isoTimestamp } from '../auth.js';
import {
  isAuthorizedScoped, loadAuthorizationContext, logAccessDenied, logDeferredAccessDenied, withDeferredAccessDenied,
} from '../authorization.js';
import { insertAuditEvent } from '../audit.js';
import { gateFreeText, piiAuditMetadata } from '../pii-gate.js';
import { csvResponse, csvRow, safeFileSegment, toCsv } from '../csv.js';
import { renderBudgetExecutionHtml } from '../budget-report.js';
import { reportContentSecurityPolicy } from '../audit-report.js';
import { toSafeInteger } from './payments.js';
import { createIdempotencyKeyReader, createJsonReader } from '../input.js';

export const name = 'ledger-budget';

const FINANCIAL_ROLES = ['admin', 'board', 'treasurer'];
const ADOPTION_ROLES = ['board'];
const DIRECTIONS = new Set(['income', 'expense']);
const FORMATS = new Set(['json', 'csv', 'html']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_PLANNED_CENTS = 100_000_000;

// #152: błąd 422 bramki pól wolnego tekstu (src/pg/pii-gate.js) — `RequestError` niżej.
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

class Replay {
  constructor(body) {
    this.body = body;
  }
}

const REPLAYED = { 'Idempotency-Replayed': 'true' };
const CREATED = { 'Idempotency-Replayed': 'false' };
const validId = (value) => typeof value === 'string' && ID_PATTERN.test(value);

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function text(value, min, max, code = 'invalid_request') {
  if (typeof value !== 'string') throw new RequestError(code);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) throw new RequestError(code);
  return normalized;
}

function optionalText(value, min, max) {
  if (value === undefined || value === null || value === '') return null;
  return text(value, min, max);
}

function optionalId(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!validId(value)) throw new RequestError('invalid_request');
  return value;
}

function readPlanned(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_PLANNED_CENTS) throw new RequestError('invalid_amount');
  return value;
}

function decodeId(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new RequestError('invalid_request');
  }
}

const readJson = createJsonReader({
  maxBytes: MAX_BODY_BYTES,
  error: (code, status) => new RequestError(code, status),
});

const readIdempotencyKey = createIdempotencyKeyReader({ error: (code, status) => new RequestError(code, status) });

// Rola i MFA przed odczytem obiektu (bez wyroczni istnienia); rok po odczycie.
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

function requireYear(context, roles, schoolYearId) {
  if (!isAuthorizedScoped(context, { roles, schoolYearId, requireMfa: true })) {
    throw withDeferredAccessDenied(new RequestError('forbidden', 403), context, { roles });
  }
}

function mapDatabaseError(error) {
  if (error instanceof RequestError) throw error;
  const message = String(error?.message ?? '');
  if (message.includes('school_year_closed')) throw new RequestError('school_year_closed', 409);
  if (message.includes('ledger_category_already_inactive')) throw new RequestError('category_inactive', 409);
  if (message.includes('ledger_budget_adoption_resolution_invalid')) throw new RequestError('resolution_not_found', 404);
  if (error?.code === '23505' && error?.constraint === 'ledger_categories_school_year_id_direction_name_key') {
    throw new RequestError('category_exists', 409);
  }
  if (error?.code === '23505' && error?.constraint === 'ledger_budget_initial_category_idx') {
    throw new RequestError('budget_line_exists', 409);
  }
  if (error?.code === '23505' && error?.constraint === 'ledger_budget_lines_supersedes_id_key') {
    throw new RequestError('budget_line_superseded', 409);
  }
  if (error?.code === '23503') throw new RequestError('invalid_reference');
  throw error;
}

// Wspólny przebieg zapisu z kluczem idempotencji: odtworzenie przed zapisem,
// a po naruszeniu unikalności — ponowne odczytanie klucza (równoległe
// podwójne kliknięcie); inne naruszenie mapuje mapDatabaseError.
async function idempotentWrite(env, { loadByKey, matches, toBody, write }) {
  const replayOf = (row) => {
    if (!row) return null;
    if (!matches(row)) throw new RequestError('idempotency_conflict', 409);
    return new Replay(toBody(row));
  };
  let result;
  try {
    result = await env.db.transaction(async (tx) => {
      const replay = replayOf(await loadByKey(tx));
      if (replay) return replay;
      return write(tx);
    });
  } catch (error) {
    if (error?.code === '23505') {
      const replay = replayOf(await loadByKey(env.db));
      if (replay) return { replayed: true, body: replay.body };
    }
    mapDatabaseError(error);
  }
  if (result instanceof Replay) return { replayed: true, body: result.body };
  return { replayed: false, body: result };
}

function respond(json, outcome) {
  return outcome.replayed ? json(outcome.body, 200, REPLAYED) : json(outcome.body, 201, CREATED);
}

// --- kategorie -----------------------------------------------------------------

function categoryFromRow(row) {
  return { id: row.id, schoolYearId: row.school_year_id, direction: row.direction, name: row.name, active: row.active };
}

async function deactivateCategory(request, env, categoryId, json) {
  if (!validId(categoryId)) throw new RequestError('invalid_request');
  const key = readIdempotencyKey(request);
  const deactivationData = await readJson(request);
  const reason = text(deactivationData.reason, 3, 500, 'invalid_reason');
  const confirmPersonalData = deactivationData.confirmPersonalData === true;
  const context = await requireAccess(request, env, FINANCIAL_ROLES);
  const actorId = context.session.user.id;
  const outcome = await idempotentWrite(env, {
    loadByKey: async (executor) => (await executor.query(
      'SELECT id, category_id, reason, created_by FROM ledger_category_deactivations WHERE idempotency_key = $1', [key],
    )).rows[0] ?? null,
    matches: (row) => row.created_by === actorId && row.category_id === categoryId && row.reason === reason,
    toBody: (row) => ({ deactivation: { id: row.id, categoryId: row.category_id, reason: row.reason } }),
    write: async (tx) => {
      const { rows } = await tx.query('SELECT id, school_year_id, active FROM ledger_categories WHERE id = $1 FOR UPDATE', [categoryId]);
      const category = rows[0];
      if (!category) throw new RequestError('category_not_found', 404);
      requireYear(context, FINANCIAL_ROLES, category.school_year_id);
      if (!category.active) throw new RequestError('category_inactive', 409);
      const gate = gateFreeText([['ledger_category_deactivations.reason', reason]], { confirm: confirmPersonalData, fail: piiFail });
      const id = crypto.randomUUID();
      await tx.query(
        `INSERT INTO ledger_category_deactivations (id, school_year_id, category_id, reason, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, category.school_year_id, categoryId, reason, actorId, key],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'ledger.category.deactivated', entityType: 'ledger_category', entityId: categoryId,
        metadata: { deactivationId: id, schoolYearId: category.school_year_id, ...piiAuditMetadata(gate) },
      });
      return { deactivation: { id, categoryId, reason } };
    },
  });
  return respond(json, outcome);
}

// --- linie preliminarza ---------------------------------------------------------

const LINE_COLUMNS = `l.id, l.school_year_id, l.category_id, l.planned_cents, l.note, l.supersedes_id, l.created_by,
  l.created_at, l.idempotency_key`;

function lineFromRow(row) {
  return {
    id: row.id,
    schoolYearId: row.school_year_id,
    categoryId: row.category_id,
    plannedCents: toSafeInteger(row.planned_cents),
    note: row.note ?? null,
    supersedesId: row.supersedes_id ?? null,
    createdBy: row.created_by,
    createdAt: isoTimestamp(row.created_at),
  };
}

async function loadLineByKey(executor, key) {
  return (await executor.query(`SELECT ${LINE_COLUMNS} FROM ledger_budget_lines l WHERE l.idempotency_key = $1`, [key])).rows[0] ?? null;
}

async function createLine(request, env, json) {
  const key = readIdempotencyKey(request);
  const data = await readJson(request);
  if (!validId(data.schoolYearId) || !validId(data.categoryId)) throw new RequestError('invalid_request');
  const input = {
    schoolYearId: data.schoolYearId, categoryId: data.categoryId,
    plannedCents: readPlanned(data.plannedCents), note: optionalText(data.note, 3, 500),
  };
  const context = await requireAccess(request, env, FINANCIAL_ROLES, input.schoolYearId);
  const actorId = context.session.user.id;
  const outcome = await idempotentWrite(env, {
    loadByKey: (executor) => loadLineByKey(executor, key),
    matches: (row) => row.created_by === actorId && row.school_year_id === input.schoolYearId && !row.supersedes_id
      && row.category_id === input.categoryId && toSafeInteger(row.planned_cents) === input.plannedCents
      && (row.note ?? null) === input.note,
    toBody: (row) => ({ line: lineFromRow(row) }),
    write: async (tx) => {
      const category = await tx.query(
        'SELECT 1 FROM ledger_categories WHERE id = $1 AND school_year_id = $2 AND active', [input.categoryId, input.schoolYearId],
      );
      if (!category.rows.length) throw new RequestError('invalid_category');
      const existing = await tx.query(
        'SELECT 1 FROM ledger_budget_lines WHERE school_year_id = $1 AND category_id = $2 LIMIT 1', [input.schoolYearId, input.categoryId],
      );
      if (existing.rows.length) throw new RequestError('budget_line_exists', 409);
      const gate = gateFreeText([['ledger_budget_lines.note', input.note]], { confirm: data.confirmPersonalData === true, fail: piiFail });
      const id = crypto.randomUUID();
      const { rows } = await tx.query(
        `INSERT INTO ledger_budget_lines AS l (id, school_year_id, category_id, planned_cents, note, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${LINE_COLUMNS}`,
        [id, input.schoolYearId, input.categoryId, input.plannedCents, input.note, actorId, key],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'ledger.budget_line.created', entityType: 'ledger_budget_line', entityId: id,
        metadata: { schoolYearId: input.schoolYearId, categoryId: input.categoryId, ...piiAuditMetadata(gate) },
      });
      return { line: lineFromRow(rows[0]) };
    },
  });
  return respond(json, outcome);
}

async function reviseLine(request, env, lineId, json) {
  if (!validId(lineId)) throw new RequestError('invalid_request');
  const key = readIdempotencyKey(request);
  const data = await readJson(request);
  const input = { plannedCents: readPlanned(data.plannedCents), note: text(data.reason, 3, 500, 'invalid_reason') };
  const context = await requireAccess(request, env, FINANCIAL_ROLES);
  const actorId = context.session.user.id;
  const outcome = await idempotentWrite(env, {
    loadByKey: (executor) => loadLineByKey(executor, key),
    matches: (row) => row.created_by === actorId && row.supersedes_id === lineId
      && toSafeInteger(row.planned_cents) === input.plannedCents && row.note === input.note,
    toBody: (row) => ({ line: lineFromRow(row) }),
    write: async (tx) => {
      const { rows } = await tx.query(`SELECT ${LINE_COLUMNS} FROM ledger_budget_lines l WHERE l.id = $1 FOR UPDATE`, [lineId]);
      const previous = rows[0];
      if (!previous) throw new RequestError('budget_line_not_found', 404);
      requireYear(context, FINANCIAL_ROLES, previous.school_year_id);
      const newer = await tx.query('SELECT id FROM ledger_budget_lines WHERE supersedes_id = $1', [lineId]);
      if (newer.rows.length) throw new RequestError('budget_line_superseded', 409, { currentLineId: newer.rows[0].id });
      const gate = gateFreeText([['ledger_budget_lines.note', input.note]], { confirm: data.confirmPersonalData === true, fail: piiFail });
      const id = crypto.randomUUID();
      const inserted = await tx.query(
        `INSERT INTO ledger_budget_lines AS l (id, school_year_id, category_id, planned_cents, note, supersedes_id, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${LINE_COLUMNS}`,
        [id, previous.school_year_id, previous.category_id, input.plannedCents, input.note, lineId, actorId, key],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'ledger.budget_line.revised', entityType: 'ledger_budget_line', entityId: id,
        metadata: { schoolYearId: previous.school_year_id, supersedesId: lineId, ...piiAuditMetadata(gate) },
      });
      return { line: lineFromRow(inserted.rows[0]) };
    },
  });
  return respond(json, outcome);
}

// --- przyjęcie preliminarza przez zebranie --------------------------------------

async function createAdoption(request, env, json) {
  const key = readIdempotencyKey(request);
  const data = await readJson(request);
  if (!validId(data.schoolYearId) || !validDate(data.adoptedOn)) throw new RequestError('invalid_request');
  const input = {
    schoolYearId: data.schoolYearId, adoptedOn: data.adoptedOn, note: text(data.note, 3, 500, 'invalid_reason'),
    resolutionId: optionalId(data.resolutionId),
  };
  const context = await requireAccess(request, env, ADOPTION_ROLES, input.schoolYearId);
  const actorId = context.session.user.id;
  const toBody = (row, lineIds) => ({
    adoption: {
      id: row.id, schoolYearId: row.school_year_id, adoptedOn: row.adopted_on, note: row.note,
      resolutionId: row.resolution_id ?? null, lineIds,
    },
  });
  const loadLines = async (executor, adoptionId) => (await executor.query(
    'SELECT line_id FROM ledger_budget_adoption_lines WHERE adoption_id = $1 ORDER BY line_id', [adoptionId],
  )).rows.map((row) => row.line_id);
  let replayLines = [];
  const outcome = await idempotentWrite(env, {
    loadByKey: async (executor) => {
      const row = (await executor.query(
        `SELECT id, school_year_id, to_char(adopted_on, 'YYYY-MM-DD') AS adopted_on, note, resolution_id, adopted_by
           FROM ledger_budget_adoptions WHERE idempotency_key = $1`, [key],
      )).rows[0] ?? null;
      if (row) replayLines = await loadLines(executor, row.id);
      return row;
    },
    matches: (row) => row.adopted_by === actorId && row.school_year_id === input.schoolYearId
      && row.adopted_on === input.adoptedOn && row.note === input.note && (row.resolution_id ?? null) === input.resolutionId,
    toBody: (row) => toBody(row, replayLines),
    write: async (tx) => {
      const year = await tx.query('SELECT 1 FROM school_years WHERE id = $1', [input.schoolYearId]);
      if (!year.rows.length) throw new RequestError('school_year_not_found', 404);
      if (input.resolutionId) {
        // Tylko przyjęta, bieżąca uchwała zebrania ogólnego tego roku; inaczej 404 jak nieistniejąca.
        const { rows } = await tx.query(
          `SELECT 1 FROM resolutions r JOIN meetings m ON m.id = r.meeting_id
            WHERE r.id = $1 AND r.school_year_id = $2 AND r.status = 'adopted' AND m.class_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM resolutions n WHERE n.corrects_id = r.id)`,
          [input.resolutionId, input.schoolYearId],
        );
        if (!rows.length) throw new RequestError('resolution_not_found', 404);
      }
      const lines = (await tx.query(
        'SELECT id FROM ledger_current_budget WHERE school_year_id = $1 ORDER BY id', [input.schoolYearId],
      )).rows.map((row) => row.id);
      if (!lines.length) throw new RequestError('budget_empty', 409);
      const gate = gateFreeText([['ledger_budget_adoptions.note', input.note]], { confirm: data.confirmPersonalData === true, fail: piiFail });
      const id = crypto.randomUUID();
      const { rows } = await tx.query(
        `INSERT INTO ledger_budget_adoptions (id, school_year_id, resolution_id, note, adopted_on, adopted_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, school_year_id, to_char(adopted_on, 'YYYY-MM-DD') AS adopted_on, note, resolution_id`,
        [id, input.schoolYearId, input.resolutionId, input.note, input.adoptedOn, actorId, key],
      );
      for (const lineId of lines) {
        await tx.query(
          'INSERT INTO ledger_budget_adoption_lines (adoption_id, school_year_id, line_id) VALUES ($1, $2, $3)',
          [id, input.schoolYearId, lineId],
        );
      }
      await insertAuditEvent(tx, {
        actorId, action: 'ledger.budget.adopted', entityType: 'ledger_budget_adoption', entityId: id,
        metadata: { schoolYearId: input.schoolYearId, resolutionId: input.resolutionId, lineCount: lines.length, ...piiAuditMetadata(gate) },
      });
      return toBody(rows[0], lines);
    },
  });
  return respond(json, outcome);
}

// --- odczyt: historia i wykonanie -----------------------------------------------

function readYear(url) {
  const schoolYearId = url.searchParams.get('schoolYearId');
  if (!validId(schoolYearId)) throw new RequestError('invalid_request');
  return schoolYearId;
}

async function history(request, env, url, json) {
  const schoolYearId = readYear(url);
  await requireAccess(request, env, FINANCIAL_ROLES, schoolYearId);
  const lines = (await env.db.query(
    `SELECT ${LINE_COLUMNS}, c.name AS category_name, c.direction,
            (SELECT n.id FROM ledger_budget_lines n WHERE n.supersedes_id = l.id) AS superseded_by
       FROM ledger_budget_lines l JOIN ledger_categories c ON c.id = l.category_id
      WHERE l.school_year_id = $1
      ORDER BY c.direction, c.name COLLATE "C", l.created_at, l.id COLLATE "C"`,
    [schoolYearId],
  )).rows.map((row) => ({
    ...lineFromRow(row), categoryName: row.category_name, direction: row.direction,
    supersededById: row.superseded_by ?? null, current: !row.superseded_by,
  }));
  const adoptions = (await env.db.query(
    `SELECT a.id, to_char(a.adopted_on, 'YYYY-MM-DD') AS adopted_on, a.note, a.resolution_id, r.number AS resolution_number,
            a.adopted_by, a.adopted_at,
            ARRAY(SELECT al.line_id FROM ledger_budget_adoption_lines al WHERE al.adoption_id = a.id ORDER BY al.line_id) AS line_ids
       FROM ledger_budget_adoptions a LEFT JOIN resolutions r ON r.id = a.resolution_id
      WHERE a.school_year_id = $1
      ORDER BY a.adopted_on, a.adopted_at, a.id`,
    [schoolYearId],
  )).rows.map((row) => ({
    id: row.id, adoptedOn: row.adopted_on, note: row.note, resolutionId: row.resolution_id ?? null,
    resolutionNumber: row.resolution_number ?? null, adoptedBy: row.adopted_by, adoptedAt: isoTimestamp(row.adopted_at),
    lineIds: row.line_ids,
  }));
  return json({ lines, adoptions });
}

function percent(executed, planned) {
  if (planned === null || planned === 0) return null;
  return Math.round((executed * 1000) / planned) / 10;
}

// Plan vs wykonanie per kategoria (#107). Kwoty w centach EUR. Wykonanie =
// suma netto wpisów (ledger_entry_net, z korektami). Kategoria bez linii
// preliminarza, ale z wpisami, jest „poza planem”. Bez asOf suma wykonania
// równa się przychodom/wydatkom z ledger_year_summary (checks).
export async function buildBudgetExecution(executor, schoolYearId, { asOf = null } = {}) {
  const { rows } = await executor.query(
    `WITH latest_adoption AS (
       SELECT id FROM ledger_budget_adoptions
        WHERE school_year_id = $1 AND ($2::date IS NULL OR adopted_on <= $2::date)
        ORDER BY adopted_on DESC, adopted_at DESC, id DESC LIMIT 1
     ), adopted AS (
       SELECT l.category_id, l.planned_cents FROM ledger_budget_adoption_lines al
         JOIN ledger_budget_lines l ON l.id = al.line_id
        WHERE al.adoption_id IN (SELECT id FROM latest_adoption)
     ), current_plan AS (
       SELECT id, category_id, planned_cents FROM ledger_current_budget WHERE school_year_id = $1
     ), executed AS (
       SELECT category_id, sum(net_amount_cents)::BIGINT AS net_cents, count(*) AS entry_count
         FROM ledger_entry_net
        WHERE school_year_id = $1 AND ($2::date IS NULL OR occurred_on <= $2::date)
        GROUP BY category_id
     )
     SELECT c.id, c.direction, c.name, c.active, a.planned_cents AS adopted_cents, p.id AS line_id,
            p.planned_cents AS current_cents, COALESCE(x.net_cents, 0) AS executed_cents, COALESCE(x.entry_count, 0) AS entry_count
       FROM ledger_categories c
       LEFT JOIN adopted a ON a.category_id = c.id
       LEFT JOIN current_plan p ON p.category_id = c.id
       LEFT JOIN executed x ON x.category_id = c.id
      WHERE c.school_year_id = $1 AND (a.planned_cents IS NOT NULL OR p.planned_cents IS NOT NULL OR x.entry_count > 0)
      ORDER BY CASE c.direction WHEN 'income' THEN 0 ELSE 1 END, c.name COLLATE "C", c.id COLLATE "C"`,
    [schoolYearId, asOf],
  );
  const adoption = (await executor.query(
    `SELECT a.id, to_char(a.adopted_on, 'YYYY-MM-DD') AS adopted_on, a.resolution_id, r.number AS resolution_number
       FROM ledger_budget_adoptions a LEFT JOIN resolutions r ON r.id = a.resolution_id
      WHERE a.school_year_id = $1 AND ($2::date IS NULL OR a.adopted_on <= $2::date)
      ORDER BY a.adopted_on DESC, a.adopted_at DESC, a.id DESC LIMIT 1`,
    [schoolYearId, asOf],
  )).rows[0] ?? null;
  const items = rows.map((row) => {
    const adoptedCents = row.adopted_cents === null ? null : toSafeInteger(row.adopted_cents);
    const currentCents = row.current_cents === null ? null : toSafeInteger(row.current_cents);
    const executedCents = toSafeInteger(row.executed_cents);
    return {
      categoryId: row.id, direction: row.direction, categoryName: row.name, active: row.active,
      lineId: row.line_id ?? null, adoptedPlanCents: adoptedCents, currentPlanCents: currentCents,
      executedNetCents: executedCents, entryCount: toSafeInteger(row.entry_count),
      differenceCents: currentCents === null ? null : currentCents - executedCents,
      executionPercent: percent(executedCents, currentCents),
      outsidePlan: currentCents === null,
      overBudget: row.direction === 'expense' && currentCents !== null && executedCents > currentCents,
    };
  });
  const totals = Object.fromEntries(['income', 'expense'].map((direction) => {
    const subset = items.filter((item) => item.direction === direction);
    const sum = (field) => subset.reduce((total, item) => total + (item[field] ?? 0), 0);
    return [direction, {
      adoptedPlanCents: adoption ? sum('adoptedPlanCents') : null,
      currentPlanCents: sum('currentPlanCents'),
      executedNetCents: sum('executedNetCents'),
      outsidePlanNetCents: subset.filter((item) => item.outsidePlan).reduce((total, item) => total + item.executedNetCents, 0),
    }];
  }));
  let check = null;
  if (!asOf) {
    const summary = (await executor.query(
      'SELECT income_cents, expense_cents FROM ledger_year_summary WHERE school_year_id = $1', [schoolYearId],
    )).rows[0];
    const incomeCents = toSafeInteger(summary?.income_cents ?? 0);
    const expenseCents = toSafeInteger(summary?.expense_cents ?? 0);
    check = {
      ok: incomeCents === totals.income.executedNetCents && expenseCents === totals.expense.executedNetCents,
      summaryIncomeCents: incomeCents, summaryExpenseCents: expenseCents,
    };
  }
  return {
    schoolYearId, asOf,
    adoption: adoption ? {
      id: adoption.id, adoptedOn: adoption.adopted_on, resolutionId: adoption.resolution_id ?? null,
      resolutionNumber: adoption.resolution_number ?? null,
    } : null,
    items, totals, check,
  };
}

const DIRECTION_LABELS = { income: 'Przychód', expense: 'Wydatek' };
export const BUDGET_CSV_COLUMNS = [
  ['rodzaj', 'text'], ['kategoria', 'text'], ['aktywna', 'text'], ['plan_przyjety_eur', 'amount_or_blank'],
  ['plan_biezacy_eur', 'amount_or_blank'], ['wykonanie_netto_eur', 'amount'], ['roznica_eur', 'amount_or_blank'],
  ['procent_wykonania', 'text'], ['poza_planem', 'text'], ['przekroczenie', 'text'], ['liczba_wpisow', 'text'],
].map(([header, type]) => ({ header, type }));

// Pusta komórka (a nie „0,00”), gdy planu nie ma — brak planu to nie plan zerowy.
export function budgetCsvValues(item) {
  return [
    DIRECTION_LABELS[item.direction], item.categoryName, item.active ? 'tak' : 'nie', item.adoptedPlanCents,
    item.currentPlanCents, item.executedNetCents, item.differenceCents,
    item.executionPercent === null ? '' : String(item.executionPercent).replace('.', ','),
    item.outsidePlan ? 'tak' : 'nie', item.overBudget ? 'tak' : 'nie', String(item.entryCount),
  ];
}
export function budgetCsvLine(item) { return csvRow(BUDGET_CSV_COLUMNS, budgetCsvValues(item)); }

async function execution(request, env, url, json) {
  const schoolYearId = readYear(url);
  const asOf = url.searchParams.get('asOf') || null;
  const format = url.searchParams.get('format') ?? 'json';
  if ((asOf && !validDate(asOf)) || !FORMATS.has(format)) throw new RequestError('invalid_request');
  const context = await requireAccess(request, env, FINANCIAL_ROLES, schoolYearId);
  const year = (await env.db.query(
    `SELECT id, label, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on
       FROM school_years WHERE id = $1`, [schoolYearId],
  )).rows[0];
  if (!year) throw new RequestError('school_year_not_found', 404);
  const report = await buildBudgetExecution(env.db, schoolYearId, { asOf });
  if (format !== 'json') {
    // Dziennik wydruku/eksportu: kto i kiedy, bez kwot.
    await insertAuditEvent(env.db, {
      actorId: context.session.user.id, action: 'ledger.budget_execution.exported', entityType: 'school_year',
      entityId: schoolYearId, metadata: { schoolYearId, format, asOf },
    });
  }
  if (format === 'json') return json({ execution: report });
  if (format === 'csv') {
    return csvResponse(toCsv(BUDGET_CSV_COLUMNS, report.items.map(budgetCsvValues)),
      `preliminarz-${safeFileSegment(schoolYearId)}.csv`);
  }
  const html = renderBudgetExecutionHtml({
    schoolYear: { id: year.id, label: year.label, startsOn: year.starts_on, endsOn: year.ends_on },
    generatedAt: new Date().toISOString(), ...report,
  });
  return new Response(html, {
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

// --- router ----------------------------------------------------------------------

export async function handle(request, env, url, json) {
  const path = url.pathname;
  const method = request.method;
  const deactivation = path.match(/^\/api\/ledger\/categories\/([^/]+)\/deactivation$/);
  const isBudget = path === '/api/ledger/budget' && method === 'POST';
  const revision = path.match(/^\/api\/ledger\/budget\/([^/]+)\/revisions$/);
  const isAdoptions = path === '/api/ledger/budget/adoptions';
  const isHistory = path === '/api/ledger/budget/history';
  const isExecution = path === '/api/ledger/budget/execution';
  if (!deactivation && !isBudget && !revision && !isAdoptions && !isHistory && !isExecution) return null;
  if (method === 'POST' && !isSameOrigin(request)) return json({ error: 'invalid_origin' }, 403);
  try {
    if (isHistory || isExecution) {
      if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
      return isHistory ? await history(request, env, url, json) : await execution(request, env, url, json);
    }
    if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
    if (deactivation) return await deactivateCategory(request, env, decodeId(deactivation[1]), json);
    if (isBudget) return await createLine(request, env, json);
    if (isAdoptions) return await createAdoption(request, env, json);
    return await reviseLine(request, env, decodeId(revision[1]), json);
  } catch (error) {
    if (error instanceof RequestError) {
      // #184: odmowa zakresu roku z wnętrza transakcji — ślad po jej wycofaniu.
      await logDeferredAccessDenied(env, error, request);
      return json({ error: error.code, ...error.extra }, error.status);
    }
    throw error;
  }
}
