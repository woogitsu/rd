// Zamknięcie roku szkolnego i przekazanie dokumentacji nowej Radzie (#15).
// Prototyp — nie jest wdrożony. Opis procesu: docs/YEAR_CLOSE.md.
//
//   GET  /api/year-close/{schoolYearId}                    stan, lista kontrolna, bilans
//   POST /api/year-close/{schoolYearId}/start              { nextSchoolYearId }
//   POST /api/year-close/{schoolYearId}/checklist/{item}   { note?, documentId? }
//   POST /api/year-close/{schoolYearId}/close              zarząd + MFA, inna osoba niż rozpoczynająca; krok w górę MFA (#150)
//   GET  /api/year-close/{schoolYearId}/handover           zestawienie przekazania (JSON, bez danych osobowych)
//
// Uprawnienia sprawdzane po stronie serwera. Każda trasa wymaga MFA i przydziału
// bez zawężenia do klasy, w zakresie zamykanego roku (albo bez zakresu roku).
// Komisja Rewizyjna, dyrekcja i admin techniczny nie mają dostępu do czasu D-08/D-09.
// Wyjątek (#195, tylko odczyt): zestawienie przekazania zamkniętego roku czyta
// też zarząd/skarbnik roku następnego i admin (src/pg/archive-access.js).
// Zapis i jego zdarzenie audytu powstają w jednej transakcji. Powtórzenie
// zakończonej operacji zwraca stan bez nowego zapisu (replayed: true).

import { freshMfaForbiddenCode, isAuthorized, loadAuthorizationContext, MFA_STEP_UP_MAX_AGE_SECONDS } from '../authorization.js';
import { insertAuditEvent } from '../audit.js';
import { isoTimestamp } from '../auth.js';
import { archiveReadVia, recordArchiveRead } from '../archive-access.js';
import { readSnapshot } from '../db-snapshot.js';

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

// #212 (dopisek do naprawy zakleszczenia): zamknięcie roku wygasza w tej samej
// transakcji przydziały zarządu/skarbnika zawężone do zamykanego roku
// (`role_grant_in_school_year`, patrz niżej w `closeYear`). Gdy dwie osoby
// (albo podwójne kliknięcie) próbują zamknąć ten sam rok, druga prośba może
// wejść do `authorize()` PO tym, jak pierwsza już w pełni zatwierdziła swoją
// transakcję — a wtedy własny przydział drugiej osoby (jeśli był zawężony do
// TEGO roku, jak `board` roku OLD) jest już wygasły i zwykłe sprawdzenie roli
// rzuca 403 `forbidden`. To nie przeplot testowy — kolejność w kodzie
// (authorize PRZED odczytem stanu zamknięcia) sprawia, że dowolna druga
// prośba osoby uprawnionej w chwili wysłania traci uprawnienie w trakcie
// przetwarzania. `wasAuthorizedAtOwnClosure` rozpoznaje DOKŁADNIE ten
// przypadek (przydział wygasł w tej samej transakcji, która zamknęła TEN
// rok — `expires_at` i `closed_at` to ten sam `now()` transakcji, patrz
// docs/YEAR_CLOSE.md).
//
// WAŻNE (najmniej uprawnień — nie pełny replay): rozpoznanie tego przypadku
// NIE wpuszcza aktora do pełnej odpowiedzi `replayed: true` z bilansem i
// identyfikatorami zamknięcia — jego przydział do tego roku już nie istnieje,
// więc nie ma dziś prawa czytać tych danych. Zamiast tego `closeYear` zwraca
// zwykłe `409 school_year_closed` (ten sam kod, którego już używa `start` po
// zamknięciu) — informacja „rok jest zamknięty” nie wykracza poza to, co ta
// osoba i tak wie (sama próbowała go zamknąć). Bez wymogu świeżego MFA (nic
// się nie zmienia w tej gałęzi) i bez zdarzenia audytu (stan bazy się nie
// zmienia — to czysty odczyt uprawnień, nie zapis).
async function wasAuthorizedAtOwnClosure(env, actorId, schoolYearId, roles) {
  const { rows } = await env.db.query(
    `SELECT 1 FROM role_grants g
       JOIN school_year_closures c
         ON c.school_year_id = $3 AND c.status = 'closed' AND g.expires_at = c.closed_at
      WHERE g.user_id = $1 AND g.role = ANY($2::text[]) AND g.class_id IS NULL
        AND g.school_year_id = $3 AND g.revoked_at IS NULL
      LIMIT 1`,
    [actorId, roles, schoolYearId],
  );
  return rows.length > 0;
}

// Przydział z zawężeniem do klasy nie daje prawa do zamknięcia całego roku.
// `requireFreshMfa` (#150, SR-10, krok w górę): wyłącznie samo zamknięcie
// roku (operacja nieodwracalna) wymaga MFA potwierdzonego od niedawna, nie
// tylko kiedyś w sesji — sprawdzane PO roli/zakresie (SR-07).
async function authorize(request, env, schoolYearId, roles, { requireFreshMfa = false, allowExpiredByOwnClosure = false } = {}) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) throw new RequestError('unauthenticated', 401);
  const yearWide = { ...context, grants: context.grants.filter((grant) => !grant.classId) };
  if (!isAuthorized(yearWide, { roles, schoolYearId, requireMfa: true })) {
    const actorId = context.session.user.id;
    if (allowExpiredByOwnClosure && context.session.mfaVerified
      && (await wasAuthorizedAtOwnClosure(env, actorId, schoolYearId, roles))) {
      throw new RequestError('school_year_closed', 409);
    }
    throw new RequestError('forbidden', 403);
  }
  if (requireFreshMfa) {
    const staleCode = freshMfaForbiddenCode(context, MFA_STEP_UP_MAX_AGE_SECONDS);
    if (staleCode) throw new RequestError(staleCode, 403);
  }
  return context.session.user.id;
}

// Odczyt zestawienia przekazania: jak authorize, a po zamknięciu roku także
// nowa Rada (przydział roku następnego) i admin — tylko odczyt (#195).
async function authorizeArchiveRead(request, env, schoolYearId, roles, route) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) throw new RequestError('unauthenticated', 401);
  const yearWide = { ...context, grants: context.grants.filter((grant) => !grant.classId) };
  if (isAuthorized(yearWide, { roles, schoolYearId, requireMfa: true })) return;
  const via = await archiveReadVia(env.db, context, schoolYearId, roles);
  if (!via) throw new RequestError('forbidden', 403);
  await recordArchiveRead(env.db, { actorId: context.session.user.id, schoolYearId, viaSchoolYearId: via, route });
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
    `SELECT s.opening_balance_cents, s.income_cents, s.expense_cents, s.closing_balance_cents,
            c.opening_cash_cents, c.closing_cash_cents
       FROM ledger_year_summary s
       JOIN ledger_year_cash_summary c ON c.school_year_id = s.school_year_id
      WHERE s.school_year_id = $1`,
    [schoolYearId],
  );
  const row = rows[0] ?? {};
  const closingBalanceCents = toSafeInteger(row.closing_balance_cents) ?? 0;
  const closingCashCents = toSafeInteger(row.closing_cash_cents) ?? 0;
  return {
    openingBalanceCents: toSafeInteger(row.opening_balance_cents) ?? 0,
    incomeCents: toSafeInteger(row.income_cents) ?? 0,
    expenseCents: toSafeInteger(row.expense_cents) ?? 0,
    closingBalanceCents,
    // Podział rachunek/kasa (#199, 0028): kasa = wszystko poza rachunkiem.
    openingCashCents: toSafeInteger(row.opening_cash_cents) ?? 0,
    closingCashCents,
    closingBankCents: closingBalanceCents - closingCashCents,
  };
}

// #169: kontrola salda końca roku. Dwa niezależnie liczone salda tego samego
// dnia: bilans zamknięcia (ledger_year_summary/ledger_year_cash_summary — wszystkie
// wpisy roku bez względu na datę) i saldo księgi na ends_on (ledger_balance_at /
// ledger_non_bank_net_at, jak w uzgodnieniu rachunku). Różnica ≠ 0 oznacza wpis
// datowany po końcu roku (wiersz sprzed walidacji 0027 albo zapis z pominięciem
// API). Rozbicie: rachunek = całość − kasa (D-13, #199), więc różnica gotówkowa
// i bankowa są podane osobno. Tylko liczby, bez danych osobowych.
async function yearEndCheck(executor, schoolYearId, live) {
  const { rows } = await executor.query(
    `SELECT ledger_balance_at(y.id, y.ends_on) AS balance_at_end,
            ledger_non_bank_net_at(y.id, y.ends_on) AS cash_at_end
       FROM school_years y WHERE y.id = $1`,
    [schoolYearId],
  );
  const balanceAtYearEndCents = toSafeInteger(rows[0]?.balance_at_end) ?? 0;
  const cashAtYearEndCents = toSafeInteger(rows[0]?.cash_at_end) ?? 0;
  const bankAtYearEndCents = balanceAtYearEndCents - cashAtYearEndCents;
  const balanceDifferenceCents = live.closingBalanceCents - balanceAtYearEndCents;
  const cashDifferenceCents = live.closingCashCents - cashAtYearEndCents;
  const bankDifferenceCents = live.closingBankCents - bankAtYearEndCents;
  return {
    ok: balanceDifferenceCents === 0 && cashDifferenceCents === 0,
    closingBalanceCents: live.closingBalanceCents,
    balanceAtYearEndCents,
    balanceDifferenceCents,
    closingCashCents: live.closingCashCents,
    cashAtYearEndCents,
    cashDifferenceCents,
    closingBankCents: live.closingBankCents,
    bankAtYearEndCents,
    bankDifferenceCents,
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
      // Zamknięcia sprzed 0028 nie mają utrwalonego podziału — null.
      openingCashCents: toSafeInteger(closure.opening_cash_cents),
      closingCashCents: toSafeInteger(closure.closing_cash_cents),
      closingBankCents: closure.closing_cash_cents === null || closure.closing_cash_cents === undefined ? null
        : toSafeInteger(closure.closing_balance_cents) - toSafeInteger(closure.closing_cash_cents),
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
    // #169: zgodność bilansu zamknięcia z saldem księgi na koniec roku.
    // Rozbieżność wymaga jawnego potwierdzenia z powodem przy zamknięciu.
    yearEndCheck: await yearEndCheck(executor, schoolYearId, live),
    // #97: informacja przed zamknięciem roku — wydatki bez weryfikacji drugiej
    // osoby lub zakwestionowane. Nie blokuje zamknięcia (D-08).
    expenseReviews: await expenseReviewSummary(executor, schoolYearId),
  };
}

async function expenseReviewSummary(executor, schoolYearId) {
  const { rows } = await executor.query(
    `SELECT s.review_status, count(*) AS entry_count, COALESCE(sum(e.net_amount_cents), 0) AS net_cents
       FROM ledger_entry_review_status s JOIN ledger_entry_net e ON e.id = s.ledger_entry_id
      WHERE s.school_year_id = $1 AND e.net_amount_cents > 0 AND s.review_status <> 'verified'
      GROUP BY s.review_status`,
    [schoolYearId],
  );
  const pick = (status) => rows.find((row) => row.review_status === status);
  const view = (row) => ({ count: toSafeInteger(row?.entry_count ?? 0), netCents: toSafeInteger(row?.net_cents ?? 0) });
  return { unverified: view(pick('unverified')), questioned: view(pick('questioned')) };
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
    if (documentId) {
      // #205: dokument spoza roku zamykanego albo rodzaju 'class' nie może
      // potwierdzać punktu listy kontrolnej — nieistniejący i spoza zakresu
      // dają ten sam kod, żeby odpowiedź nie była wyrocznią istnienia.
      const { rows: docRows } = await tx.query('SELECT kind, school_year_id FROM documents WHERE id = $1', [documentId]);
      const doc = docRows[0];
      if (!doc || doc.school_year_id !== schoolYearId || !['board', 'financial'].includes(doc.kind)) {
        throw new RequestError('invalid_document_id');
      }
    }
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

// #169: powody potwierdzenia rozbieżności salda końca roku — kody, nie wolny
// tekst: dziennik audytu nie przyjmuje wolnego tekstu w metadanych (src/pg/audit.js,
// klucz `reason` = tylko kod), a osobnej kolumny na wyjaśnienie nie dodajemy bez
// decyzji Rady (wariant zachowawczy; opis tekstowy to ewentualny follow-up).
export const YEAR_END_DISCREPANCY_REASONS = Object.freeze([
  'entry_dated_after_year_end', // wpis z datą po końcu roku do poprawy w roku następnym
  'explained_by_resolution', // rozbieżność wyjaśniona uchwałą/protokołem zarządu
  'explained_outside_system', // wyjaśniona poza systemem (dokumentacja u skarbnika)
]);

// #169: jawne potwierdzenie rozbieżności salda końca roku. Powtarza widziane
// różnice (kwoty w centach), żeby nie zatwierdzić rozbieżności innej niż
// oglądana; kod powodu trafia do dziennika zdarzeń (bez danych osobowych).
function parseYearEndConfirmation(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new RequestError('invalid_year_end_confirmation');
  const { reason, balanceDifferenceCents, cashDifferenceCents } = value;
  if (!YEAR_END_DISCREPANCY_REASONS.includes(reason) || !Number.isSafeInteger(balanceDifferenceCents) || !Number.isSafeInteger(cashDifferenceCents)) {
    throw new RequestError('invalid_year_end_confirmation');
  }
  return { reason, balanceDifferenceCents, cashDifferenceCents };
}

async function closeYear(request, env, schoolYearId, json) {
  const actorId = await authorize(request, env, schoolYearId, CLOSE_ROLES, {
    requireFreshMfa: true, allowExpiredByOwnClosure: true,
  });
  const body = await readJson(request);
  const confirmation = parseYearEndConfirmation(body.confirmYearEndDiscrepancy);
  const year = await requireYear(env.db, schoolYearId);

  const precheck = await loadClosure(env.db, schoolYearId);
  if (!precheck) throw new RequestError('year_close_not_started', 409);
  if (precheck.status === 'closed') {
    return json({ ...(await statusView(env.db, schoolYearId)), replayed: true });
  }

  const result = await env.db.transaction(async (tx) => {
    // #212: dwa równoległe zamknięcia (dwie osoby albo podwójne kliknięcie)
    // brały LOCK TABLE ... IN SHARE MODE jako pierwszą blokadę — SHARE nie
    // wyklucza sam siebie, więc obie transakcje ją dostawały, a potem każda
    // czekała na blokadę wiersza zamknięcia / INSERT bilansu otwarcia:
    // zakleszczenie (40P01) wykrywane dopiero po deadlock_timeout, przez co
    // księga WSZYSTKICH lat stała aż do wykrycia. Advisory lock w trybie
    // transakcyjnym (zwalniany automatycznie na COMMIT/ROLLBACK) szereguje
    // zamknięcia PRZED wzięciem jakiejkolwiek blokady na tabelach księgi —
    // druga transakcja czeka tutaj, a nie w środku zakleszczenia. Musi to być
    // pierwsze zapytanie transakcji i nigdy nie odwracać kolejności z LOCK
    // TABLE w innych trasach (patrz docs/YEAR_CLOSE.md).
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['rd_year_close']);
    // Kolejność: najpierw blokady tabel księgi (czekają na trwające zapisy),
    // potem wiersz zamknięcia. Nowe zapisy księgi czekają na koniec transakcji,
    // a trigger zamrożenia zobaczy już status 'closed'.
    await tx.query(`LOCK TABLE ledger_entries, ledger_corrections, ledger_opening_balances,
      ledger_opening_balance_adjustments, ledger_transfers IN SHARE MODE`);
    const closure = await loadClosure(tx, schoolYearId, { lock: true });
    // Druga transakcja (po zwolnieniu advisory locka przez pierwszą) widzi już
    // rok zamknięty — to nie błąd, tylko spóźniona odpowiedź na to samo
    // żądanie albo podwójne kliknięcie. Zwracamy replayed:true zamiast
    // cichego 200 bez zapisu (dotychczasowe zachowanie, patrz #212) i zamiast
    // zakleszczenia.
    if (closure.status === 'closed') return { replayed: true };
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

    // #169: bilans zamknięcia musi zgadzać się z saldem księgi na koniec roku;
    // inaczej zamknięcie wymaga jawnego potwierdzenia z powodem, które powtarza
    // aktualne różnice. Liczone pod blokadą księgi, więc bez wyścigu.
    const endCheck = await yearEndCheck(tx, schoolYearId, summary);
    if (!endCheck.ok) {
      if (!confirmation) {
        throw new RequestError('year_end_balance_mismatch', 409, { yearEndCheck: endCheck });
      }
      if (confirmation.balanceDifferenceCents !== endCheck.balanceDifferenceCents
        || confirmation.cashDifferenceCents !== endCheck.cashDifferenceCents) {
        throw new RequestError('year_end_confirmation_mismatch', 409, { yearEndCheck: endCheck });
      }
    }

    const openingId = crypto.randomUUID();
    try {
      await tx.query(
        `INSERT INTO ledger_opening_balances (id, school_year_id, amount_cents, cash_cents, note, created_by, idempotency_key)
         VALUES ($1, $2, $3, $7, $4, $5, $6)`,
        [openingId, closure.next_school_year_id, summary.closingBalanceCents,
          `Bilans zamknięcia roku ${year.label} przeniesiony przy zamknięciu roku`,
          actorId, `year-close:${closure.id}`, summary.closingCashCents],
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
           carried_opening_balance_id = $7, expired_grant_count = $8,
           opening_cash_cents = $9, closing_cash_cents = $10
         WHERE id = $1`,
        [closure.id, actorId, summary.openingBalanceCents, summary.incomeCents, summary.expenseCents,
          summary.closingBalanceCents, openingId, expired.length, summary.openingCashCents, summary.closingCashCents],
      );
    } catch (error) {
      mapDatabaseError(error);
    }
    if (!endCheck.ok) {
      await insertAuditEvent(tx, {
        actorId, action: 'year_close.year_end_discrepancy_confirmed', entityType: 'school_year_closure', entityId: closure.id,
        metadata: {
          schoolYearId, closureId: closure.id, reason: confirmation.reason,
          balanceDifferenceCents: endCheck.balanceDifferenceCents,
          cashDifferenceCents: endCheck.cashDifferenceCents,
          bankDifferenceCents: endCheck.bankDifferenceCents,
          closingBalanceCents: endCheck.closingBalanceCents,
          balanceAtYearEndCents: endCheck.balanceAtYearEndCents,
        },
      });
    }
    await insertAuditEvent(tx, {
      actorId, action: 'year_close.closed', entityType: 'school_year_closure', entityId: closure.id,
      metadata: { schoolYearId, nextSchoolYearId: closure.next_school_year_id, openingBalanceId: openingId, expiredGrantCount: expired.length,
        yearEndDiscrepancyConfirmed: !endCheck.ok },
    });
    return { replayed: false };
  });
  return json({ ...(await statusView(env.db, schoolYearId)), replayed: result.replayed });
}

function countsBy(rows, key = 'status') {
  const result = {};
  for (const row of rows) result[row[key]] = toSafeInteger(row.count);
  return result;
}

async function handover(request, env, schoolYearId, json) {
  await authorizeArchiveRead(request, env, schoolYearId, READ_ROLES, 'year_close.handover');
  // #213: zestawienie przekazania jest dokumentem podpisywanym/archiwizowanym
  // przez zarząd i następcę — jedna migawka REPEATABLE READ dla wszystkich
  // ośmiu zapytań poniżej (dotąd Promise.all na env.db, każde zapytanie mogło
  // trafić na inne połączenie z puli i inną chwilę bazy). W transakcji nie ma
  // sensu Promise.all: jedno połączenie i tak kolejkuje zapytania, więc idą
  // sekwencyjnie na tx.
  const { year, status, ledgerCounts, payments, meetings, meetingsWithoutMinutes, resolutions, events, nextOpening, nextGrants } =
    await readSnapshot(env.db, async (tx) => {
      const year = await requireYear(tx, schoolYearId);
      const status = await statusView(tx, schoolYearId);
      const ledgerCounts = await tx.query(
        `SELECT (SELECT count(*) FROM ledger_entries WHERE school_year_id = $1) AS entries,
              (SELECT count(*) FROM ledger_corrections c JOIN ledger_entries e ON e.id = c.ledger_entry_id
                WHERE e.school_year_id = $1) AS corrections`,
        [schoolYearId],
      );
      const payments = await tx.query(
        `SELECT count(*) FILTER (WHERE status = 'recorded') AS recorded_count,
              COALESCE(sum(net_amount_cents) FILTER (WHERE status = 'recorded'), 0) AS recorded_net_cents,
              count(*) FILTER (WHERE status = 'unmatched') AS unmatched_count,
              COALESCE(sum(net_amount_cents) FILTER (WHERE status = 'unmatched'), 0) AS unmatched_net_cents,
              -- #127: z tego część już podzielona na gospodarstwa (payment_allocations_current).
              (SELECT COALESCE(sum(a.amount_cents), 0) FROM payment_allocations_current a
                 JOIN payment_entries p ON p.id = a.payment_entry_id
                WHERE p.school_year_id = $1 AND p.status = 'unmatched') AS unmatched_allocated_cents,
              (SELECT count(*) FROM payment_corrections c JOIN payment_entries p ON p.id = c.payment_entry_id
                WHERE p.school_year_id = $1) AS correction_count
         FROM payment_entry_net WHERE school_year_id = $1`,
        [schoolYearId],
      );
      const meetings = await tx.query('SELECT status, count(*) AS count FROM meetings WHERE school_year_id = $1 GROUP BY status', [schoolYearId]);
      const meetingsWithoutMinutes = await tx.query(
        `SELECT count(*) AS count FROM meetings m
        WHERE m.school_year_id = $1 AND m.status IN ('held', 'archived')
          AND NOT meeting_has_approved_minutes(m.id)`,
        [schoolYearId],
      );
      const resolutions = await tx.query(
        `SELECT r.status, count(*) AS count FROM resolutions r
        WHERE r.school_year_id = $1
          AND NOT EXISTS (SELECT 1 FROM resolutions newer WHERE newer.corrects_id = r.id)
        GROUP BY r.status`,
        [schoolYearId],
      );
      const events = await tx.query('SELECT status, count(*) AS count FROM events WHERE school_year_id = $1 GROUP BY status', [schoolYearId]);
      const nextOpening = status.nextSchoolYearId
        ? await tx.query(
          `SELECT o.id, o.amount_cents, o.cash_cents, COALESCE(sum(a.amount_cents), 0) AS adjustments_cents,
                COALESCE(sum(a.cash_cents), 0) AS cash_adjustments_cents
           FROM ledger_opening_balances o
           LEFT JOIN ledger_opening_balance_adjustments a ON a.opening_balance_id = o.id
          WHERE o.school_year_id = $1 GROUP BY o.id, o.amount_cents, o.cash_cents`,
          [status.nextSchoolYearId],
        )
        : { rows: [] };
      const nextGrants = status.nextSchoolYearId
        ? await tx.query(
          `SELECT role, count(*) AS count FROM role_grants
          WHERE school_year_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
          GROUP BY role`,
          [status.nextSchoolYearId],
        )
        : { rows: [] };
      return { year, status, ledgerCounts, payments, meetings, meetingsWithoutMinutes, resolutions, events, nextOpening, nextGrants };
    });

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
        cashCents: toSafeInteger(opening.cash_cents),
        cashAdjustmentsCents: toSafeInteger(opening.cash_adjustments_cents),
        carriedFromClosure: opening.id === status.carriedOpeningBalanceId,
      } : null,
    },
    payments: {
      recordedCount: toSafeInteger(pay.recorded_count),
      recordedNetCents: toSafeInteger(pay.recorded_net_cents),
      unmatchedCount: toSafeInteger(pay.unmatched_count),
      unmatchedNetCents: toSafeInteger(pay.unmatched_net_cents),
      unmatchedAllocatedCents: toSafeInteger(pay.unmatched_allocated_cents),
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
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
      return await getStatus(request, env, schoolYearId, json);
    }
    if (action === 'handover') {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
      return await handover(request, env, schoolYearId, json);
    }
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
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
