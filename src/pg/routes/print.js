// GET /api/print/cards?schoolYearId=…&classId=… — dane do kartek o dobrowolnej
// składce (issue #11). Prototyp na PostgreSQL — nie jest wdrożony.
//
// Odpowiedź ma kształt wejścia JSON modułu print/core.js (parseInputRows) plus
// zatwierdzoną konfigurację danych do wpłaty (#92, payment_instructions):
//   { schoolYearId, classId, paymentInfoIncluded, paymentInstructions, rows: [
//       { householdId, firstName, lastName, className, structuredReference, recordedNetCents? } ] }
// structuredReference (#83): 12 cyfr aktywnej komunikacji strukturalnej OGM-VCS
// rodziny w tym roku (payment_references) albo null. Widzi ją każda rola
// uprawniona do druku, ale wyłącznie dla rodzin z wierszy w jej zakresie —
// przedstawiciel tylko dla uczniów przypisanej klasy (printScope). Kartka
// pokazuje ją zamiast tytułu z identyfikatorem rodziny. Unieważniona referencja
// i referencja innego roku nie są zwracane.
// paymentInstructions: { id, iban, bic, payeeName, approvedAt } albo null, gdy rok
// nie ma jeszcze zatwierdzonej wersji (kartka jest wtedy szkicem, bez kodu QR —
// zob. print/core.js buildCard). Dostępne dla każdej roli uprawnionej do druku
// (także przedstawiciela klasy) — edycja/zatwierdzanie pozostaje w
// POST /api/payment-instructions (admin/board).
// Jeden wiersz na ucznia; rodzeństwo ma ten sam householdId.
//
// Zakres (założenie do potwierdzenia w D-08, macierz kompetencji):
// - admin/board/treasurer z przydziałem bez klasy: wszystkie klasy roku;
//   classId opcjonalny, a przy classId rodzina ma pełną listę rodzeństwa z roku,
// - przedstawiciel klasy (i przydział ograniczony do klasy): classId wymagany
//   i musi należeć do jego przydziałów; wiersze wyłącznie z tej klasy
//   (rodzeństwo z innych klas jest pomijane — minimalizacja danych),
// - audit/principal: 403 do czasu decyzji D-09.
// recordedNetCents pojawia się wyłącznie dla roli finansowej z potwierdzonym MFA
// obejmującej żądany zakres; w innym przypadku pole jest całkowicie pominięte.
// Kwota netto to suma wpisów wpłat pomniejszona o korekty — nie jest należnością
// ani statusem rodziny; brak wpisu może być nieaktualny.
// privacyNotice (#145, D-06): { id, version, url } opublikowanej informacji o
// przetwarzaniu danych; brak opublikowanej wersji => 409 privacy_notice_missing.
// Odpowiedź nigdy nie zawiera danych opiekunów (e-maili, imion, zgód).

import { loadAuthorizationContext, logAccessDenied } from '../authorization.js';
import { authorizedClassIds, isAuthorizedScoped } from '../scope.js';
import { insertAuditEvent } from '../audit.js';
import { recordDataAccess } from '../data-access.js';
import { toSafeInteger } from './payments.js';
import { loadCurrentPaymentInstructions } from './payment-instructions.js';
import { loadPublishedNotice, noticeReference } from './privacy-notice.js';
import { brusselsDay, effectiveDay } from '../today.js';

export const name = 'print';

const FINANCIAL_ROLES = ['admin', 'board', 'treasurer'];
const PRINT_ROLES = [...FINANCIAL_ROLES, 'representative'];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
// Taki sam limit jak w print/core.js (MAX_ROWS).
export const MAX_PRINT_ROWS = 5000;

const validId = (value) => typeof value === 'string' && ID_PATTERN.test(value);

// Wylicza zakres z przydziałów: pełny rok albo zbiór klas (src/pg/scope.js, #155).
// `schoolYearId` jest zawsze podany (trasa waliduje go przed wywołaniem).
export function printScope(context, { schoolYearId, classId }) {
  const full = isAuthorizedScoped(context, { roles: FINANCIAL_ROLES, schoolYearId });
  const classIds = new Set(authorizedClassIds(context, { roles: PRINT_ROLES, schoolYearId }));
  if (!full && !classIds.size) return { error: 'forbidden', status: 403 };
  if (!full && !classId) return { error: 'class_required', status: 400 };
  if (!full && !classIds.has(classId)) return { error: 'forbidden', status: 403 };
  // Kwoty tylko przy MFA i przydziale finansowym obejmującym cały żądany zakres.
  const paymentInfo = isAuthorizedScoped(context, {
    roles: FINANCIAL_ROLES, schoolYearId, classId: classId || undefined, requireMfa: true,
  });
  return { full, paymentInfo };
}

// Dzień, dla którego wyznaczamy gospodarstwo na kartce (#194): dziś ograniczone
// do zakresu roku szkolnego. Kartka starszego roku pokazuje gospodarstwo z końca
// tamtego roku (ends_on roku jako ostatni dzień), a rok przyszły — z jego początku,
// a nie dzisiejsze gospodarstwo. Daty jako 'YYYY-MM-DD' (porównanie tekstowe).
export function cardDay(year, today) {
  if (today < year.starts_on) return year.starts_on;
  if (today > year.ends_on) return year.ends_on;
  return today;
}

// Rodzina ucznia = główne gospodarstwo obowiązujące w dniu `on` (domyślnie
// rd_today(), Bruksela), a nie kolumna students.household_id (#194). Przy
// opiece naprzemiennej kartka powstaje tylko dla głównego gospodarstwa
// (założenie do D-11); uczeń bez obowiązującego głównego członkostwa nie ma kartki.
async function loadRows(db, { schoolYearId, classId, full, paymentInfo, on = null }) {
  const values = [schoolYearId, on];
  const primary = 'student_primary_household_on(COALESCE($2::date, rd_today()))';
  const conditions = ['e.school_year_id = $1', 'h.archived_at IS NULL'];
  if (classId) {
    values.push(classId);
    if (full) {
      conditions.push(`p.household_id IN (
        SELECT p2.household_id FROM enrollments_current e2 JOIN ${primary} p2 ON p2.student_id = e2.student_id
         WHERE e2.school_year_id = $1 AND e2.class_id = $3)`);
    } else {
      conditions.push('e.class_id = $3');
    }
  }
  values.push(MAX_PRINT_ROWS + 1);
  const paymentColumn = paymentInfo ? ', COALESCE(t.net_amount_cents, 0) AS net_amount_cents' : '';
  const paymentJoin = paymentInfo
    ? 'LEFT JOIN household_payment_totals t ON t.household_id = p.household_id AND t.school_year_id = $1'
    : '';
  const { rows } = await db.query(
    `SELECT p.household_id, s.first_name, s.last_name, c.name AS class_name,
            pr.structured_reference${paymentColumn}
       FROM enrollments_current e
       JOIN students s ON s.id = e.student_id
       JOIN ${primary} p ON p.student_id = e.student_id
       JOIN households h ON h.id = p.household_id
       JOIN classes c ON c.id = e.class_id
       LEFT JOIN payment_references pr
         ON pr.household_id = p.household_id AND pr.school_year_id = $1 AND pr.revoked_at IS NULL
       ${paymentJoin}
      WHERE ${conditions.join(' AND ')}
      ORDER BY c.name, p.household_id, s.last_name, s.first_name, s.id
      LIMIT $${values.length}`,
    values,
  );
  return rows;
}

// Zatwierdzona na rok konfiguracja danych do wpłaty (#92, payment-instructions.js).
// Czytana tu dla WSZYSTKICH ról uprawnionych do druku kartek (także przedstawiciela
// klasy) — to nie jest dana finansowa rodziny, tylko rachunek Rady sam w sobie
// drukowany na każdej kartce; edycja/zatwierdzanie zostaje ograniczone do
// admin/board (POST /api/payment-instructions). IBAN/BIC nigdy nie trafiają
// do audytu (assertNoPii + reguła ręczna w payment-instructions.js).
async function loadPaymentInstructions(db, schoolYearId) {
  const current = await loadCurrentPaymentInstructions(db, schoolYearId);
  if (!current) return null;
  // id = wersja konfiguracji (#92): drukowana w stopce kartki, żeby po korekcie
  // rachunku w trakcie roku odróżnić kartki wydrukowane ze starą wersją.
  return {
    id: current.id,
    iban: current.iban,
    bic: current.bic,
    payeeName: current.payeeName,
    approvedAt: current.approvedAt,
  };
}

function rowOut(row, paymentInfo) {
  const out = {
    householdId: row.household_id,
    firstName: row.first_name,
    lastName: row.last_name,
    className: row.class_name,
    structuredReference: row.structured_reference ?? null,
  };
  if (paymentInfo) out.recordedNetCents = Math.max(0, toSafeInteger(row.net_amount_cents));
  return out;
}

export async function handle(request, env, url, json) {
  if (url.pathname !== '/api/print/cards') return null;
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });

  const context = await loadAuthorizationContext(request, env);
  if (!context) return json({ error: 'unauthenticated' }, 401);

  const schoolYearId = url.searchParams.get('schoolYearId');
  const classId = url.searchParams.get('classId') || null;
  if (!validId(schoolYearId) || (classId !== null && !validId(classId))) {
    return json({ error: 'invalid_request' }, 400);
  }

  const scope = printScope(context, { schoolYearId, classId });
  if (scope.error) {
    // #184: ślad odmowy 403 (przed transakcją żądania).
    if (scope.status === 403) await logAccessDenied(env, context, { roles: PRINT_ROLES }, request);
    return json({ error: scope.error }, scope.status);
  }

  const actorId = context.session.user.id;
  if (classId) {
    const { rows } = await env.db.query('SELECT 1 FROM classes WHERE id = $1 AND school_year_id = $2', [classId, schoolYearId]);
    if (!rows.length) {
      await recordDataAccess(env, { actorId, accessKind: 'print_cards', schoolYearId, classId, outcome: 'not_found' });
      return json({ error: 'class_not_found' }, 404);
    }
  }
  const { rows: years } = await env.db.query('SELECT starts_on::text AS starts_on, ends_on::text AS ends_on FROM school_years WHERE id = $1', [schoolYearId]);
  if (!years.length) {
    await recordDataAccess(env, { actorId, accessKind: 'print_cards', schoolYearId, outcome: 'not_found' });
    return json({ error: 'school_year_not_found' }, 404);
  }

  // #145 (D-06): kartka trafia do rodziców, więc wymaga opublikowanej informacji o
  // przetwarzaniu danych (po autoryzacji i walidacji zakresu, przed odczytem
  // rodzin). Jej numer wersji i odnośnik wchodzą do odpowiedzi i na kartkę.
  const privacyNotice = await loadPublishedNotice(env.db);
  if (!privacyNotice) return json({ error: 'privacy_notice_missing' }, 409);
  const on = cardDay(years[0], effectiveDay(env) ?? brusselsDay());
  const rows = await loadRows(env.db, { schoolYearId, classId, ...scope, on });
  if (rows.length > MAX_PRINT_ROWS) return json({ error: 'too_many_rows' }, 413);

  const households = new Set(rows.map((row) => row.household_id));
  const paymentInstructions = await loadPaymentInstructions(env.db, schoolYearId);
  // Wyłącznie liczby i identyfikatory zakresu — bez identyfikatorów rodzin i danych osobowych.
  await insertAuditEvent(env.db, {
    actorId: context.session.user.id,
    action: 'print.cards_requested',
    entityType: 'school_year',
    entityId: schoolYearId,
    metadata: {
      classId,
      householdCount: households.size,
      studentCount: rows.length,
      paymentInfoIncluded: scope.paymentInfo,
      paymentInstructionsApproved: Boolean(paymentInstructions),
      privacyNoticeId: privacyNotice.id,
      privacyNoticeVersion: privacyNotice.version,
      // Liczba rodzin z komunikacją strukturalną — nigdy same referencje (#83).
      structuredReferenceCount: new Set(rows.filter((row) => row.structured_reference).map((row) => row.household_id)).size,
    },
  });
  await recordDataAccess(env, {
    actorId, accessKind: 'print_cards', schoolYearId, classId, outcome: 'ok', rowCount: rows.length,
  });

  return json({
    schoolYearId,
    classId,
    paymentInfoIncluded: scope.paymentInfo,
    paymentInstructions,
    privacyNotice: noticeReference(privacyNotice, env.PUBLIC_BASE_URL),
    rows: rows.map((row) => rowOut(row, scope.paymentInfo)),
  });
}
