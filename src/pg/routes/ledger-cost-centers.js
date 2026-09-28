// Centra kosztów w księdze (#117): przypisanie wpisu do wydarzenia lub klasy
// i wynik per centrum. Prototyp — nie jest wdrożony.
//
//   GET  /api/ledger/{id}/allocations                           historia wersji przypisania wpisu
//   POST /api/ledger/{id}/allocations                           (Idempotency-Key) nowa wersja
//   GET  /api/ledger/cost-centers?schoolYearId=…&type=event|class&format=json|csv
//   GET  /api/ledger/cost-centers/events/{eventId}              rozliczenie jednego wydarzenia
//
// Dostęp: admin, board, treasurer z MFA w zakresie roku (jak księga). Przedstawiciel
// klasy, audit i principal: 403 (D-08, D-09 — domyślnie brak dostępu). Raport per
// klasa obejmuje wyłącznie wpisy księgi przypisane klasie (wydatki/dofinansowania),
// nigdy wpłat rodzin — składki są dobrowolne i nie mogą stać się wskaźnikiem klasy.
//
// Wpisy są niezmienne, więc przypisanie ma wersje (0090_ledger_cost_centers.sql):
// zmiana = nowa wersja wskazująca poprzednią (`supersedesId`) z powodem; historia
// zostaje. Suma pozycji wersji ≤ netto wpisu; korekta poniżej sumy przypisania jest
// odrzucana, dopóki nie powstanie nowa wersja z mniejszymi kwotami.

import { isAuthorizedScoped, loadAuthorizationContext, logAccessDenied } from '../authorization.js';
import { insertAuditEvent } from '../audit.js';
import { isoTimestamp } from '../auth.js';
import { toSafeInteger } from './payments.js';
import { csvHeader, csvRow } from '../csv.js';

export const name = 'ledger-cost-centers';

const FINANCIAL_ROLES = ['admin', 'board', 'treasurer'];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_ITEMS = 50;
const MAX_AMOUNT_CENTS = 100_000_000;
const TYPES = new Set(['event', 'class']);

class RequestError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

const validId = (value) => typeof value === 'string' && ID_PATTERN.test(value);

function decodeId(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (validId(decoded)) return decoded;
  } catch { /* niżej */ }
  throw new RequestError('invalid_id');
}

async function readJson(request) {
  const type = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw new RequestError('invalid_content_type', 415);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new RequestError('request_too_large', 413);
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

async function requireFinancial(request, env, schoolYearId) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) throw new RequestError('unauthenticated', 401);
  if (!isAuthorizedScoped(context, { roles: FINANCIAL_ROLES, schoolYearId, requireMfa: true })) {
    await logAccessDenied(env, context, { roles: FINANCIAL_ROLES }, request);
    throw new RequestError('forbidden', 403);
  }
  return context;
}

function requireYear(context, schoolYearId) {
  if (!isAuthorizedScoped(context, { roles: FINANCIAL_ROLES, schoolYearId, requireMfa: true })) {
    throw new RequestError('forbidden', 403);
  }
}

function mapDatabaseError(error) {
  const message = String(error?.message ?? '');
  if (message.includes('school_year_closed')) throw new RequestError('school_year_closed', 409);
  if (message.includes('ledger_allocation_exceeds_net')) throw new RequestError('allocation_exceeds_net', 409);
  if (message.includes('ledger_allocation_version_mismatch')) throw new RequestError('allocation_version_conflict', 409);
  if (error?.code === '23503') throw new RequestError('invalid_cost_center');
  throw error;
}

// --- przypisanie wpisu --------------------------------------------------------

async function loadEntry(executor, id, { lock = false } = {}) {
  if (lock) await executor.query('SELECT id FROM ledger_entries WHERE id = $1 FOR UPDATE', [id]);
  const { rows } = await executor.query(
    'SELECT id, school_year_id, direction, net_amount_cents FROM ledger_entry_net WHERE id = $1', [id],
  );
  return rows[0] ?? null;
}

async function loadVersions(executor, entryId) {
  const [versions, items] = await Promise.all([
    executor.query(
      `SELECT id, version_no, supersedes_id, reason, created_by, created_at
         FROM ledger_allocation_versions WHERE ledger_entry_id = $1 ORDER BY version_no`,
      [entryId],
    ),
    executor.query(
      `SELECT i.version_id, i.event_id, i.class_id, i.amount_cents
         FROM ledger_allocation_items i JOIN ledger_allocation_versions v ON v.id = i.version_id
        WHERE v.ledger_entry_id = $1 ORDER BY i.event_id NULLS LAST, i.class_id NULLS LAST`,
      [entryId],
    ),
  ]);
  return versions.rows.map((version) => ({
    id: version.id,
    versionNo: version.version_no,
    supersedesId: version.supersedes_id ?? null,
    reason: version.reason ?? null,
    createdBy: version.created_by,
    createdAt: isoTimestamp(version.created_at),
    items: items.rows.filter((item) => item.version_id === version.id).map((item) => ({
      eventId: item.event_id ?? null, classId: item.class_id ?? null, amountCents: toSafeInteger(item.amount_cents),
    })),
  }));
}

function allocationView(entry, versions) {
  const current = versions.at(-1) ?? null;
  const netAmountCents = toSafeInteger(entry.net_amount_cents);
  const allocatedCents = (current?.items ?? []).reduce((sum, item) => sum + item.amountCents, 0);
  return {
    ledgerEntryId: entry.id,
    schoolYearId: entry.school_year_id,
    direction: entry.direction,
    netAmountCents,
    currentVersionId: current?.id ?? null,
    allocatedCents,
    generalCents: netAmountCents - allocatedCents,
    versions,
  };
}

async function getAllocations(request, env, entryId, json) {
  const context = await requireFinancial(request, env);
  const entry = await loadEntry(env.db, entryId);
  if (!entry) throw new RequestError('ledger_entry_not_found', 404);
  requireYear(context, entry.school_year_id);
  return json({ allocation: allocationView(entry, await loadVersions(env.db, entryId)) });
}

function parseAllocationInput(data) {
  if (!Array.isArray(data.items) || data.items.length > MAX_ITEMS) throw new RequestError('invalid_allocation');
  const seen = new Set();
  const items = data.items.map((item) => {
    if (!item || typeof item !== 'object') throw new RequestError('invalid_allocation');
    const eventId = item.eventId ?? null;
    const classId = item.classId ?? null;
    if ((eventId === null) === (classId === null)
        || (eventId !== null && !validId(eventId)) || (classId !== null && !validId(classId))
        || !Number.isSafeInteger(item.amountCents) || item.amountCents <= 0 || item.amountCents > MAX_AMOUNT_CENTS) {
      throw new RequestError('invalid_allocation');
    }
    const keyName = eventId !== null ? `e:${eventId}` : `c:${classId}`;
    if (seen.has(keyName)) throw new RequestError('invalid_allocation');
    seen.add(keyName);
    return { eventId, classId, amountCents: item.amountCents };
  });
  const supersedesId = data.supersedesId ?? null;
  if (supersedesId !== null && !validId(supersedesId)) throw new RequestError('invalid_allocation');
  let reason = null;
  if (data.reason !== undefined && data.reason !== null && data.reason !== '') {
    if (typeof data.reason !== 'string' || data.reason.trim().length < 3 || data.reason.trim().length > 500) {
      throw new RequestError('invalid_reason');
    }
    reason = data.reason.trim();
  }
  if (supersedesId !== null && reason === null) throw new RequestError('allocation_reason_required');
  return { items, supersedesId, reason };
}

const sameItems = (a, b) => JSON.stringify(a.map((i) => [i.eventId, i.classId, i.amountCents]).sort())
  === JSON.stringify(b.map((i) => [i.eventId, i.classId, i.amountCents]).sort());

async function createAllocation(request, env, entryId, json) {
  const idempotencyKey = readIdempotencyKey(request);
  const input = parseAllocationInput(await readJson(request));
  const context = await requireFinancial(request, env);
  const actorId = context.session.user.id;

  const byKey = async (executor) => (await executor.query(
    'SELECT id, ledger_entry_id, supersedes_id, reason, created_by FROM ledger_allocation_versions WHERE idempotency_key = $1',
    [idempotencyKey],
  )).rows[0] ?? null;
  const replayOrConflict = async (executor, row) => {
    if (!row) return null;
    const versions = await loadVersions(executor, row.ledger_entry_id);
    const version = versions.find((item) => item.id === row.id);
    if (row.created_by !== actorId || row.ledger_entry_id !== entryId || (row.supersedes_id ?? null) !== input.supersedesId
        || (row.reason ?? null) !== input.reason || !sameItems(version.items, input.items)) {
      throw new RequestError('idempotency_conflict', 409);
    }
    const entry = await loadEntry(executor, entryId);
    return json({ allocation: allocationView(entry, versions), versionId: row.id }, 200, { 'Idempotency-Replayed': 'true' });
  };

  try {
    return await env.db.transaction(async (tx) => {
      const entry = await loadEntry(tx, entryId, { lock: true });
      if (!entry) throw new RequestError('ledger_entry_not_found', 404);
      requireYear(context, entry.school_year_id);
      const replay = await replayOrConflict(tx, await byKey(tx));
      if (replay) return replay;

      const versions = await loadVersions(tx, entryId);
      const current = versions.at(-1) ?? null;
      // Wersja „na podstawie” nieaktualnej (podwójne kliknięcie innym kluczem,
      // równoległa zmiana) — odrzucona, bez nadpisywania.
      if ((current?.id ?? null) !== input.supersedesId) {
        throw new RequestError('allocation_version_conflict', 409, { currentVersionId: current?.id ?? null });
      }
      const eventIds = input.items.map((item) => item.eventId).filter(Boolean);
      const classIds = input.items.map((item) => item.classId).filter(Boolean);
      const [events, classes] = await Promise.all([
        tx.query('SELECT id FROM events WHERE id = ANY($1::text[]) AND school_year_id = $2', [eventIds, entry.school_year_id]),
        tx.query('SELECT id FROM classes WHERE id = ANY($1::text[]) AND school_year_id = $2', [classIds, entry.school_year_id]),
      ]);
      if (events.rows.length !== eventIds.length || classes.rows.length !== classIds.length) {
        throw new RequestError('invalid_cost_center');
      }
      const total = input.items.reduce((sum, item) => sum + item.amountCents, 0);
      if (total > toSafeInteger(entry.net_amount_cents)) throw new RequestError('allocation_exceeds_net', 409);

      const versionId = crypto.randomUUID();
      const versionNo = (current?.versionNo ?? 0) + 1;
      await tx.query(
        `INSERT INTO ledger_allocation_versions (id, ledger_entry_id, school_year_id, version_no, supersedes_id, reason,
           created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [versionId, entryId, entry.school_year_id, versionNo, input.supersedesId, input.reason, actorId, idempotencyKey],
      );
      for (const item of input.items) {
        await tx.query(
          `INSERT INTO ledger_allocation_items (id, version_id, school_year_id, event_id, class_id, amount_cents)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [crypto.randomUUID(), versionId, entry.school_year_id, item.eventId, item.classId, item.amountCents],
        );
      }
      await insertAuditEvent(tx, {
        actorId, action: 'ledger.allocation.created', entityType: 'ledger_entry', entityId: entryId,
        metadata: { versionId, versionNo, supersedesId: input.supersedesId, itemCount: input.items.length },
      });
      const entryAfter = await loadEntry(tx, entryId);
      return json({ allocation: allocationView(entryAfter, await loadVersions(tx, entryId)), versionId }, 201,
        { 'Idempotency-Replayed': 'false' });
    });
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (error?.code === '23505') {
      const replay = await replayOrConflict(env.db, await byKey(env.db));
      if (replay) return replay;
      throw new RequestError('allocation_version_conflict', 409);
    }
    mapDatabaseError(error);
  }
}

// --- raporty ------------------------------------------------------------------

// Wynik per centrum z bieżących wersji przypisania; pozycja „ogólne” = reszta
// netto wpisów roku, więc suma centrów + ogólne = ledger_year_summary.
async function costCenterReport(executor, schoolYearId, type) {
  const column = type === 'event' ? 'event_id' : 'class_id';
  const [centers, summary] = await Promise.all([
    executor.query(
      type === 'event'
        ? `SELECT c.id, c.title AS name, c.status,
                  COALESCE(sum(a.amount_cents) FILTER (WHERE e.direction = 'income'), 0) AS income_cents,
                  COALESCE(sum(a.amount_cents) FILTER (WHERE e.direction = 'expense'), 0) AS expense_cents,
                  count(a.ledger_entry_id) AS entry_count
             FROM events c
             LEFT JOIN ledger_current_allocations a ON a.${column} = c.id
             LEFT JOIN ledger_entries e ON e.id = a.ledger_entry_id
            WHERE c.school_year_id = $1
            GROUP BY c.id, c.title, c.status
           HAVING count(a.ledger_entry_id) > 0
            ORDER BY c.title COLLATE "C", c.id COLLATE "C"`
        : `SELECT c.id, c.name, NULL AS status,
                  COALESCE(sum(a.amount_cents) FILTER (WHERE e.direction = 'income'), 0) AS income_cents,
                  COALESCE(sum(a.amount_cents) FILTER (WHERE e.direction = 'expense'), 0) AS expense_cents,
                  count(a.ledger_entry_id) AS entry_count
             FROM classes c
             LEFT JOIN ledger_current_allocations a ON a.${column} = c.id
             LEFT JOIN ledger_entries e ON e.id = a.ledger_entry_id
            WHERE c.school_year_id = $1
            GROUP BY c.id, c.name
           HAVING count(a.ledger_entry_id) > 0
            ORDER BY c.name COLLATE "C", c.id COLLATE "C"`,
      [schoolYearId],
    ),
    executor.query('SELECT income_cents, expense_cents FROM ledger_year_summary WHERE school_year_id = $1', [schoolYearId]),
  ]);
  if (!summary.rows[0]) throw new RequestError('school_year_not_found', 404);
  const rows = centers.rows.map((row) => {
    const incomeCents = toSafeInteger(row.income_cents);
    const expenseCents = toSafeInteger(row.expense_cents);
    return {
      type, id: row.id, name: row.name, status: row.status ?? null, entryCount: toSafeInteger(row.entry_count),
      incomeCents, expenseCents, resultCents: incomeCents - expenseCents,
    };
  });
  const incomeCents = toSafeInteger(summary.rows[0].income_cents);
  const expenseCents = toSafeInteger(summary.rows[0].expense_cents);
  const allocatedIncome = rows.reduce((sum, row) => sum + row.incomeCents, 0);
  const allocatedExpense = rows.reduce((sum, row) => sum + row.expenseCents, 0);
  const general = {
    incomeCents: incomeCents - allocatedIncome,
    expenseCents: expenseCents - allocatedExpense,
    resultCents: (incomeCents - allocatedIncome) - (expenseCents - allocatedExpense),
  };
  return {
    schoolYearId, type, centers: rows, general,
    totals: { incomeCents, expenseCents, resultCents: incomeCents - expenseCents },
  };
}

const COST_CENTER_CSV_COLUMNS = [
  { header: 'Rodzaj', type: 'text' },
  { header: 'Identyfikator', type: 'text' },
  { header: 'Nazwa', type: 'text' },
  { header: 'Status', type: 'text' },
  { header: 'Przychody (EUR)', type: 'amount' },
  { header: 'Wydatki (EUR)', type: 'amount' },
  { header: 'Wynik (EUR)', type: 'amount' },
];
const TYPE_LABEL = { event: 'wydarzenie', class: 'klasa' };

async function readCostCenters(request, env, url, json) {
  const schoolYearId = url.searchParams.get('schoolYearId');
  const type = url.searchParams.get('type') ?? 'event';
  const format = url.searchParams.get('format') ?? 'json';
  if (!validId(schoolYearId) || !TYPES.has(type) || !['json', 'csv'].includes(format)) {
    throw new RequestError('invalid_request');
  }
  await requireFinancial(request, env, schoolYearId);
  const report = await costCenterReport(env.db, schoolYearId, type);
  if (format === 'json') return json({ report });
  const lines = [
    csvHeader(COST_CENTER_CSV_COLUMNS),
    ...report.centers.map((row) => csvRow(COST_CENTER_CSV_COLUMNS,
      [TYPE_LABEL[type], row.id, row.name, row.status ?? '', row.incomeCents, row.expenseCents, row.resultCents])),
    csvRow(COST_CENTER_CSV_COLUMNS, ['ogólne', '', 'Bez przypisania', '', report.general.incomeCents,
      report.general.expenseCents, report.general.resultCents]),
    csvRow(COST_CENTER_CSV_COLUMNS, ['razem', '', 'Razem rok', '', report.totals.incomeCents,
      report.totals.expenseCents, report.totals.resultCents]),
  ];
  return new Response(`﻿${lines.join('\r\n')}\r\n`, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="centra-${type}-${schoolYearId.replace(/[^A-Za-z0-9_-]/g, '_')}.csv"`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function readEventFinance(request, env, eventId, json) {
  const context = await requireFinancial(request, env);
  const { rows } = await env.db.query('SELECT id, school_year_id, title, status FROM events WHERE id = $1', [eventId]);
  const event = rows[0];
  if (!event) throw new RequestError('event_not_found', 404);
  requireYear(context, event.school_year_id);
  const entries = await env.db.query(
    `SELECT a.ledger_entry_id, a.version_id, a.amount_cents, e.direction, to_char(e.occurred_on, 'YYYY-MM-DD') AS occurred_on,
            e.description, e.category_id, c.name AS category_name, n.net_amount_cents
       FROM ledger_current_allocations a
       JOIN ledger_entries e ON e.id = a.ledger_entry_id
       JOIN ledger_entry_net n ON n.id = e.id
       JOIN ledger_categories c ON c.id = e.category_id
      WHERE a.event_id = $1
      ORDER BY e.occurred_on, e.id`,
    [eventId],
  );
  const items = entries.rows.map((row) => ({
    ledgerEntryId: row.ledger_entry_id,
    versionId: row.version_id,
    direction: row.direction,
    occurredOn: row.occurred_on,
    categoryId: row.category_id,
    categoryName: row.category_name,
    description: row.description,
    entryNetCents: toSafeInteger(row.net_amount_cents),
    allocatedCents: toSafeInteger(row.amount_cents),
  }));
  const incomeCents = items.filter((i) => i.direction === 'income').reduce((sum, i) => sum + i.allocatedCents, 0);
  const expenseCents = items.filter((i) => i.direction === 'expense').reduce((sum, i) => sum + i.allocatedCents, 0);
  return json({ event: {
    id: event.id, schoolYearId: event.school_year_id, title: event.title, status: event.status,
    incomeCents, expenseCents, resultCents: incomeCents - expenseCents, entries: items,
  } });
}

export async function handle(request, env, url, json) {
  const allocationMatch = url.pathname.match(/^\/api\/ledger\/([^/]+)\/allocations$/);
  const eventMatch = url.pathname.match(/^\/api\/ledger\/cost-centers\/events\/([^/]+)$/);
  const isReport = url.pathname === '/api/ledger/cost-centers';
  if (!allocationMatch && !eventMatch && !isReport) return null;
  try {
    if (allocationMatch && allocationMatch[1] !== 'cost-centers') {
      if (request.method === 'GET') return await getAllocations(request, env, decodeId(allocationMatch[1]), json);
      if (request.method === 'POST') return await createAllocation(request, env, decodeId(allocationMatch[1]), json);
      return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET, POST' });
    }
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
    if (isReport) return await readCostCenters(request, env, url, json);
    if (eventMatch) return await readEventFinance(request, env, decodeId(eventMatch[1]), json);
    return null;
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.code, ...error.extra }, error.status);
    throw error;
  }
}
