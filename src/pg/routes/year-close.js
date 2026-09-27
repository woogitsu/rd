// Zamknięcie roku szkolnego i przekazanie dokumentacji nowej Radzie (#15).
// Prototyp — nie jest wdrożony. Opis procesu: docs/YEAR_CLOSE.md.
//
//   GET  /api/year-close/{schoolYearId}                    stan, lista kontrolna, bilans
//   POST /api/year-close/{schoolYearId}/start              { nextSchoolYearId }
//   POST /api/year-close/{schoolYearId}/checklist/{item}   { note?, documentId? }
//   POST /api/year-close/{schoolYearId}/close              zarząd + MFA, inna osoba niż rozpoczynająca
//   GET  /api/year-close/{schoolYearId}/handover           zestawienie przekazania (JSON, bez danych osobowych)
//
// Uprawnienia sprawdzane po stronie serwera. Każda trasa wymaga MFA i przydziału
// bez zawężenia do klasy, w zakresie zamykanego roku (albo bez zakresu roku).
// Komisja Rewizyjna, dyrekcja i admin techniczny nie mają dostępu do czasu D-08/D-09.
// Zapis i jego zdarzenie audytu powstają w jednej transakcji. Powtórzenie
// zakończonej operacji zwraca stan bez nowego zapisu (replayed: true).

import { isAuthorized, loadAuthorizationContext } from '../authorization.js';
import { insertAuditEvent } from '../audit.js';
import { isoTimestamp } from '../auth.js';

export const name = 'year-close';

export const CHECKLIST_ITEMS = Object.freeze([
  'financial_report',
  'audit_commission_report',
  'minutes_approved',
  'resolutions_archived',
  'reconciliation_confirmed',
  'documents_handed_over',
]);

const READ_ROLES = ['board', 'treasurer'];
const CHECKLIST_ROLES = ['board', 'treasurer'];
const CLOSE_ROLES = ['board'];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_BODY_BYTES = 8 * 1024;
const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;
const PATH = /^\/api\/year-close\/([^/]+)(?:\/(start|close|handover|checklist\/([a-z_]+)))?$/;

class RequestError extends Error {
  constructor(code, status = 400, details) {
    super(code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function toSafeInteger(value) {
  if (value === null || value === undefined) return null;
  const number = Number(String(value));
  if (!Number.isSafeInteger(number)) throw new Error('unsafe_integer');
  return number;
}

function decodeId(value) {
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { throw new RequestError('invalid_school_year_id'); }
  if (!ID_PATTERN.test(decoded)) throw new RequestError('invalid_school_year_id');
  return decoded;
}

async function readJson(request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new RequestError('request_too_large', 413);
  if (!text.trim()) return {};
  const type = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw new RequestError('invalid_content_type', 415);
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new RequestError('invalid_json');
  }
}

function optionalText(value, min, max, code) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new RequestError(code);
  const text = value.trim();
  if (text.length < min || text.length > max) throw new RequestError(code);
  return text;
}

// Przydział z zawężeniem do klasy nie daje prawa do zamknięcia całego roku.
async function authorize(request, env, schoolYearId, roles) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) throw new RequestError('unauthenticated', 401);
  const yearWide = { ...context, grants: context.grants.filter((grant) => !grant.classId) };
  if (!isAuthorized(yearWide, { roles, schoolYearId, requireMfa: true })) {
    throw new RequestError('forbidden', 403);
  }
  return context.session.user.id;
}

function mapDatabaseError(error) {
  const message = String(error?.message ?? '');
  const known = [
    ['year_close_next_year_must_follow', 'invalid_next_school_year', 409],
    ['year_close_next_year_not_open', 'next_school_year_not_open', 409],
    ['year_close_not_in_progress', 'year_close_not_in_progress', 409],
    ['year_close_checklist_incomplete', 'checklist_incomplete', 409],
    ['year_close_four_eyes', 'four_eyes_required', 409],
    ['year_close_next_year_differs', 'invalid_next_school_year', 409],
    ['school_year_closure_is_final', 'school_year_closed', 409],
    ['school_year_closed', 'school_year_closed', 409],
  ];
  for (const [needle, code, status] of known) {
    if (message.includes(needle)) throw new RequestError(code, status);
  }
  if (error?.code === '23503') throw new RequestError('invalid_reference');
  if (error?.code === '23505') throw new RequestError('conflict', 409);
  throw error;
}

async function loadYear(executor, schoolYearId) {
  const { rows } = await executor.query(
    `SELECT id, label, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on
       FROM school_years WHERE id = $1`,
    [schoolYearId],
  );
  return rows[0] ?? null;
}

async function loadClosure(executor, schoolYearId, { lock = false } = {}) {
  const { rows } = await executor.query(
    `SELECT * FROM school_year_closures WHERE school_year_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [schoolYearId],
  );
  return rows[0] ?? null;
}

async function loadChecklist(executor, closureId) {
  if (!closureId) return [];
  const { rows } = await executor.query(
    `SELECT item, note, document_id, confirmed_by, confirmed_at
       FROM school_year_closure_checklist WHERE closure_id = $1`,
    [closureId],
  );
  return rows;
}

async function liveSummary(executor, schoolYearId) {
  const { rows } = await executor.query(
    `SELECT opening_balance_cents, income_cents, expense_cents, closing_balance_cents
       FROM ledger_year_summary WHERE school_year_id = $1`,
    [schoolYearId],
  );
  const row = rows[0] ?? {};
  return {
    openingBalanceCents: toSafeInteger(row.opening_balance_cents) ?? 0,
    incomeCents: toSafeInteger(row.income_cents) ?? 0,
    expenseCents: toSafeInteger(row.expense_cents) ?? 0,
    closingBalanceCents: toSafeInteger(row.closing_balance_cents) ?? 0,
  };
}

function checklistView(rows) {
  const byItem = new Map(rows.map((row) => [row.item, row]));
  return CHECKLIST_ITEMS.map((item) => {
    const row = byItem.get(item);
    return {
      item,
      confirmed: Boolean(row),
      confirmedBy: row?.confirmed_by ?? null,
      confirmedAt: row ? isoTimestamp(row.confirmed_at) : null,
      note: row?.note ?? null,
      documentId: row?.document_id ?? null,
    };
  });
}

function balanceView(closure, live) {
  if (closure?.status === 'closed') {
    return {
      source: 'closed',
      openingBalanceCents: toSafeInteger(closure.opening_balance_cents),
      incomeCents: toSafeInteger(closure.income_cents),
      expenseCents: toSafeInteger(closure.expense_cents),
      closingBalanceCents: toSafeInteger(closure.closing_balance_cents),
    };
  }
  return { source: 'live', ...live };
}

async function statusView(executor, schoolYearId) {
  const closure = await loadClosure(executor, schoolYearId);
  const checklist = checklistView(await loadChecklist(executor, closure?.id));
  const live = await liveSummary(executor, schoolYearId);
  return {
    schoolYearId,
    status: closure?.status ?? 'open',
    closureId: closure?.id ?? null,
    nextSchoolYearId: closure?.next_school_year_id ?? null,
    initiatedBy: closure?.initiated_by ?? null,
    initiatedAt: closure ? isoTimestamp(closure.initiated_at) : null,
    closedBy: closure?.closed_by ?? null,
    closedAt: closure?.closed_at ? isoTimestamp(closure.closed_at) : null,
    carriedOpeningBalanceId: closure?.carried_opening_balance_id ?? null,
    expiredGrantCount: closure?.expired_grant_count ?? null,
    checklist,
    missingChecklistItems: checklist.filter((entry) => !entry.confirmed).map((entry) => entry.item),
    balance: balanceView(closure, live),
  };
}

async function requireYear(executor, schoolYearId) {
  const year = await loadYear(executor, schoolYearId);
  if (!year) throw new RequestError('school_year_not_found', 404);
  return year;
}

async function getStatus(request, env, schoolYearId, json) {
  await authorize(request, env, schoolYearId, READ_ROLES);
  await requireYear(env.db, schoolYearId);
  return json(await statusView(env.db, schoolYearId));
}

async function startClosing(request, env, schoolYearId, json) {
  const actorId = await authorize(request, env, schoolYearId, CLOSE_ROLES);
  const data = await readJson(request);
  if (typeof data.nextSchoolYearId !== 'string' || !ID_PATTERN.test(data.nextSchoolYearId)) {
    throw new RequestError('invalid_next_school_year');
  }
  const nextSchoolYearId = data.nextSchoolYearId;
  const result = await env.db.transaction(async (tx) => {
    await requireYear(tx, schoolYearId);
    if (!await loadYear(tx, nextSchoolYearId)) throw new RequestError('next_school_year_not_found', 404);
    const existing = await loadClosure(tx, schoolYearId, { lock: true });
    if (existing) {
      if (existing.status === 'closed') throw new RequestError('school_year_closed', 409);
      if (existing.next_school_year_id !== nextSchoolYearId) throw new RequestError('year_close_already_started', 409);
      return { replayed: true };
    }
    const id = crypto.randomUUID();
    try {
      await tx.query(
        `INSERT INTO school_year_closures (id, school_year_id, next_school_year_id, initiated_by)
         VALUES ($1, $2, $3, $4)`,
        [id, schoolYearId, nextSchoolYearId, actorId],
      );
    } catch (error) {
      mapDatabaseError(error);
    }
    await insertAuditEvent(tx, {
      actorId, action: 'year_close.started', entityType: 'school_year_closure', entityId: id,
      metadata: { schoolYearId, nextSchoolYearId },
    });
    return { replayed: false };
  });
  const body = { ...(await statusView(env.db, schoolYearId)), replayed: result.replayed };
  return json(body, result.replayed ? 200 : 201);
}

async function confirmChecklistItem(request, env, schoolYearId, item, json) {
  const actorId = await authorize(request, env, schoolYearId, CHECKLIST_ROLES);
  if (!CHECKLIST_ITEMS.includes(item)) throw new RequestError('invalid_checklist_item', 404);
  const data = await readJson(request);
  const note = optionalText(data.note, 3, 500, 'invalid_note');
  let documentId = null;
  if (data.documentId !== undefined && data.documentId !== null) {
    if (typeof data.documentId !== 'string' || !ID_PATTERN.test(data.documentId)) throw new RequestError('invalid_document_id');
    documentId = data.documentId;
  }
  const result = await env.db.transaction(async (tx) => {
    await requireYear(tx, schoolYearId);
    const closure = await loadClosure(tx, schoolYearId, { lock: true });
    if (!closure) throw new RequestError('year_close_not_started', 409);
    if (closure.status === 'closed') throw new RequestError('school_year_closed', 409);
    const { rows } = await tx.query(
      'SELECT 1 FROM school_year_closure_checklist WHERE closure_id = $1 AND item = $2',
      [closure.id, item],
    );
    if (rows.length) return { replayed: true };
    try {
      await tx.query(
        `INSERT INTO school_year_closure_checklist (closure_id, item, note, document_id, confirmed_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [closure.id, item, note, documentId, actorId],
      );
    } catch (error) {
      mapDatabaseError(error);
    }
    await insertAuditEvent(tx, {
      actorId, action: 'year_close.checklist_confirmed', entityType: 'school_year_closure', entityId: closure.id,
      metadata: { schoolYearId, item, documentId },
    });
    return { replayed: false };
  });
  const body = { ...(await statusView(env.db, schoolYearId)), replayed: result.replayed };
  return json(body, result.replayed ? 200 : 201);
}

async function closeYear(request, env, schoolYearId, json) {
  const actorId = await authorize(request, env, schoolYearId, CLOSE_ROLES);
  await readJson(request);
  const year = await requireYear(env.db, schoolYearId);

  const precheck = await loadClosure(env.db, schoolYearId);
  if (!precheck) throw new RequestError('year_close_not_started', 409);
  if (precheck.status === 'closed') {
    return json({ ...(await statusView(env.db, schoolYearId)), replayed: true });
  }

  await env.db.transaction(async (tx) => {
    // Kolejność: najpierw blokady tabel księgi (czekają na trwające zapisy),
    // potem wiersz zamknięcia. Nowe zapisy księgi czekają na koniec transakcji,
    // a trigger zamrożenia zobaczy już status 'closed'.
    await tx.query(`LOCK TABLE ledger_entries, ledger_corrections, ledger_opening_balances,
      ledger_opening_balance_adjustments IN SHARE MODE`);
    const closure = await loadClosure(tx, schoolYearId, { lock: true });
    if (closure.status === 'closed') return;
    if (closure.initiated_by === actorId) throw new RequestError('four_eyes_required', 409);

    const missing = checklistView(await loadChecklist(tx, closure.id))
      .filter((entry) => !entry.confirmed).map((entry) => entry.item);
    if (missing.length) throw new RequestError('checklist_incomplete', 409, { missingChecklistItems: missing });

    const { rows: existingOpening } = await tx.query(
      'SELECT id FROM ledger_opening_balances WHERE school_year_id = $1',
      [closure.next_school_year_id],
    );
    if (existingOpening.length) throw new RequestError('next_year_opening_balance_exists', 409);

    const summary = await liveSummary(tx, schoolYearId);
    if (summary.closingBalanceCents < INT4_MIN || summary.closingBalanceCents > INT4_MAX) {
      throw new RequestError('closing_balance_out_of_range', 409);
    }

    const openingId = crypto.randomUUID();
    try {
      await tx.query(
        `INSERT INTO ledger_opening_balances (id, school_year_id, amount_cents, note, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [openingId, closure.next_school_year_id, summary.closingBalanceCents,
          `Bilans zamknięcia roku ${year.label} przeniesiony przy zamknięciu roku`,
          actorId, `year-close:${closure.id}`],
      );
    } catch (error) {
      mapDatabaseError(error);
    }
    await insertAuditEvent(tx, {
      actorId, action: 'ledger_opening_balance.carried_forward', entityType: 'ledger_opening_balance', entityId: openingId,
      metadata: { fromSchoolYearId: schoolYearId, schoolYearId: closure.next_school_year_id, closureId: closure.id },
    });

    // Wygaszenie ról starej kadencji: przydziały należące do zamykanego roku
    // (school_year_id albo klasa tego roku) — ta sama reguła co expire-grants (0022).
    const { rows: expired } = await tx.query(
      `UPDATE role_grants SET expires_at = now()
        WHERE role_grant_in_school_year(class_id, school_year_id, $1) AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
        RETURNING id, role, class_id`,
      [schoolYearId],
    );
    for (const grant of expired) {
      await insertAuditEvent(tx, {
        actorId, action: 'role_grant.expired', entityType: 'role_grant', entityId: grant.id,
        metadata: { reason: 'year_close', role: grant.role, classId: grant.class_id ?? null, schoolYearId, closureId: closure.id },
      });
    }

    try {
      await tx.query(
        `UPDATE school_year_closures SET status = 'closed', closed_by = $2, closed_at = now(),
           opening_balance_cents = $3, income_cents = $4, expense_cents = $5, closing_balance_cents = $6,
           carried_opening_balance_id = $7, expired_grant_count = $8
         WHERE id = $1`,
        [closure.id, actorId, summary.openingBalanceCents, summary.incomeCents, summary.expenseCents,
          summary.closingBalanceCents, openingId, expired.length],
      );
    } catch (error) {
      mapDatabaseError(error);
    }
    await insertAuditEvent(tx, {
      actorId, action: 'year_close.closed', entityType: 'school_year_closure', entityId: closure.id,
      metadata: { schoolYearId, nextSchoolYearId: closure.next_school_year_id, openingBalanceId: openingId, expiredGrantCount: expired.length },
    });
  });
  return json({ ...(await statusView(env.db, schoolYearId)), replayed: false });
}

function countsBy(rows, key = 'status') {
  const result = {};
  for (const row of rows) result[row[key]] = toSafeInteger(row.count);
  return result;
}

async function handover(request, env, schoolYearId, json) {
  await authorize(request, env, schoolYearId, READ_ROLES);
  const db = env.db;
  const year = await requireYear(db, schoolYearId);
  const status = await statusView(db, schoolYearId);

  const [ledgerCounts, payments, meetings, meetingsWithoutMinutes, resolutions, events, nextOpening, nextGrants] = await Promise.all([
    db.query(
      `SELECT (SELECT count(*) FROM ledger_entries WHERE school_year_id = $1) AS entries,
              (SELECT count(*) FROM ledger_corrections c JOIN ledger_entries e ON e.id = c.ledger_entry_id
                WHERE e.school_year_id = $1) AS corrections`,
      [schoolYearId],
    ),
    db.query(
      `SELECT count(*) FILTER (WHERE status = 'recorded') AS recorded_count,
              COALESCE(sum(net_amount_cents) FILTER (WHERE status = 'recorded'), 0) AS recorded_net_cents,
              count(*) FILTER (WHERE status = 'unmatched') AS unmatched_count,
              COALESCE(sum(net_amount_cents) FILTER (WHERE status = 'unmatched'), 0) AS unmatched_net_cents,
              (SELECT count(*) FROM payment_corrections c JOIN payment_entries p ON p.id = c.payment_entry_id
                WHERE p.school_year_id = $1) AS correction_count
         FROM payment_entry_net WHERE school_year_id = $1`,
      [schoolYearId],
    ),
    db.query('SELECT status, count(*) AS count FROM meetings WHERE school_year_id = $1 GROUP BY status', [schoolYearId]),
    db.query(
      `SELECT count(*) AS count FROM meetings m
        WHERE m.school_year_id = $1 AND m.status IN ('held', 'archived')
          AND NOT meeting_has_approved_minutes(m.id)`,
      [schoolYearId],
    ),
    db.query(
      `SELECT r.status, count(*) AS count FROM resolutions r
        WHERE r.school_year_id = $1
          AND NOT EXISTS (SELECT 1 FROM resolutions newer WHERE newer.corrects_id = r.id)
        GROUP BY r.status`,
      [schoolYearId],
    ),
    db.query('SELECT status, count(*) AS count FROM events WHERE school_year_id = $1 GROUP BY status', [schoolYearId]),
    status.nextSchoolYearId
      ? db.query(
        `SELECT o.id, o.amount_cents, COALESCE(sum(a.amount_cents), 0) AS adjustments_cents
           FROM ledger_opening_balances o
           LEFT JOIN ledger_opening_balance_adjustments a ON a.opening_balance_id = o.id
          WHERE o.school_year_id = $1 GROUP BY o.id, o.amount_cents`,
        [status.nextSchoolYearId],
      )
      : Promise.resolve({ rows: [] }),
    status.nextSchoolYearId
      ? db.query(
        `SELECT role, count(*) AS count FROM role_grants
          WHERE school_year_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
          GROUP BY role`,
        [status.nextSchoolYearId],
      )
      : Promise.resolve({ rows: [] }),
  ]);

  const ledger = ledgerCounts.rows[0];
  const pay = payments.rows[0];
  const opening = nextOpening.rows[0];
  return json({
    final: status.status === 'closed',
    schoolYear: { id: year.id, label: year.label, startsOn: year.starts_on, endsOn: year.ends_on },
    status: status.status,
    closureId: status.closureId,
    nextSchoolYearId: status.nextSchoolYearId,
    initiatedBy: status.initiatedBy,
    closedBy: status.closedBy,
    closedAt: status.closedAt,
    finance: {
      ...status.balance,
      ledgerEntryCount: toSafeInteger(ledger.entries),
      ledgerCorrectionCount: toSafeInteger(ledger.corrections),
      nextYearOpeningBalance: opening ? {
        id: opening.id,
        amountCents: toSafeInteger(opening.amount_cents),
        adjustmentsCents: toSafeInteger(opening.adjustments_cents),
        carriedFromClosure: opening.id === status.carriedOpeningBalanceId,
      } : null,
    },
    payments: {
      recordedCount: toSafeInteger(pay.recorded_count),
      recordedNetCents: toSafeInteger(pay.recorded_net_cents),
      unmatchedCount: toSafeInteger(pay.unmatched_count),
      unmatchedNetCents: toSafeInteger(pay.unmatched_net_cents),
      correctionCount: toSafeInteger(pay.correction_count),
    },
    meetings: {
      byStatus: countsBy(meetings.rows),
      heldWithoutApprovedMinutes: toSafeInteger(meetingsWithoutMinutes.rows[0].count),
    },
    resolutions: { byStatus: countsBy(resolutions.rows) },
    events: { byStatus: countsBy(events.rows) },
    checklist: status.checklist,
    roles: {
      expiredGrantCount: status.expiredGrantCount,
      activeGrantsNextYearByRole: countsBy(nextGrants.rows, 'role'),
    },
  });
}

export async function handle(request, env, url, json) {
  const match = PATH.exec(url.pathname);
  if (!match) return null;
  try {
    const schoolYearId = decodeId(match[1]);
    const action = match[2] ?? null;
    if (action === null) {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      return await getStatus(request, env, schoolYearId, json);
    }
    if (action === 'handover') {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      return await handover(request, env, schoolYearId, json);
    }
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (action === 'start') return await startClosing(request, env, schoolYearId, json);
    if (action === 'close') return await closeYear(request, env, schoolYearId, json);
    return await confirmChecklistItem(request, env, schoolYearId, match[3], json);
  } catch (error) {
    if (error instanceof RequestError) {
      return json({ error: error.code, ...(error.details ?? {}) }, error.status);
    }
    throw error;
  }
}
