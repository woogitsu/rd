// Pulpit zarządu: statystyki szkoły per klasa (#131). Prototyp — nie jest
// wdrożony. Jedna trasa zbiorcza, informacyjna — bez rankingu i bez listy
// rodzin. Wzór zapytań i reguła kontaktu e-mail (#95) jak w
// representative.js (#118) i families.js, żeby te trzy widoki dawały te
// same liczby na tych samych danych.
//
//   GET /api/board/overview?schoolYearId=
//
// Zakres: admin i zarząd. Przydział szeroki (bez klasy) widzi wszystkie klasy
// roku przydziału (zarząd przydzielony do jednego roku widzi tylko ten rok —
// SR-01). Zarząd z przydziałem ograniczonym do klas widzi wyłącznie te klasy
// (wiersze i sumy tylko z nich, bez kolumny wpisów wpłat — wariant zachowawczy
// do decyzji D-08/D-09). Skarbnik i inne role nie mają tu dostępu: to pulpit
// zarządu, nie ogólny raport klas (families.js) ani raport finansowy (ledger.js).
// Wszystkie zapytania jednej odpowiedzi czytają jedną migawkę (readSnapshot,
// #213), więc wiersze klas i suma szkoły są ze sobą spójne. Uczniowie liczeni
// po widoku enrollments_current (odeszli ze szkoły — poza licznikami).
//
// Kolumna wpisów wpłat jest informacyjna i wymaga MFA oraz roli finansowej
// (admin/board/treasurer — jak families.financialYears): jej brak w
// odpowiedzi (nie `null`) sygnalizuje brak dostępu, wariant zachowawczy.
// Próg minimalny (propozycja do zatwierdzenia): klasa z mniej niż 5
// gospodarstwami dostaje `null` zamiast odsetka, żeby nie dało się
// wnioskować o pojedynczych rodzinach w małej klasie.
//
// Żadnego sortowania ani rankingu po odsetku (kolejność zawsze wg nazwy
// klasy), żadnego słowa „dłużnik”/„zaległość” — AGENTS.md, docs/PRODUCT.md.
// Odpowiedź nie zawiera identyfikatorów gospodarstw, imion ani e-maili.

import { isAuthorizedScoped, loadAuthorizationContext } from '../authorization.js';
import { readSnapshot } from '../db-snapshot.js';
import { scopeFromGrants } from './families.js';

export const name = 'board';

const BASE_ROLES = ['admin', 'board'];
const FINANCIAL_ROLES = ['admin', 'board', 'treasurer'];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MIN_HOUSEHOLDS_FOR_PAYMENT_RATE = 5;
const NOTE = 'Składka jest dobrowolna. Odsetek opisuje odnotowane wpisy, nie zobowiązania; '
  + 'wpłaty nieprzypisane nie są w nim ujęte (poza częściami przypisanymi gospodarstwom).';

function toSafeInteger(value) {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number)) throw new Error('unsafe_integer');
  return number;
}

function paymentRate(householdCount, householdsWithEntry) {
  if (householdCount < MIN_HOUSEHOLDS_FOR_PAYMENT_RATE) return null;
  return Math.round((householdsWithEntry / householdCount) * 100);
}

export async function handle(request, env, url, json) {
  if (url.pathname !== '/api/board/overview') return null;
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });

  const context = await loadAuthorizationContext(request, env);
  if (!context) return json({ error: 'unauthenticated' }, 401);

  // Przydział szeroki (admin/zarząd całej szkoły lub roku) albo klasowy
  // (zarząd klasy): klasowy zawęża wyniki do przypisanych klas.
  const scope = scopeFromGrants(context.grants, BASE_ROLES);
  if (!scope.any) return json({ error: 'forbidden' }, 403);

  const schoolYearId = url.searchParams.get('schoolYearId');
  if (!ID_PATTERN.test(schoolYearId ?? '')) return json({ error: 'invalid_request' }, 400);
  // Kolumna wpłat: rola finansowa + MFA; dodatkowo (w buildOverview) tylko
  // przy przydziale szerokim dla tego roku.
  const financial = isAuthorizedScoped(context, { roles: FINANCIAL_ROLES, requireMfa: true });

  const result = await readSnapshot(env.db, (tx) => buildOverview(tx, { schoolYearId, scope, financial }));
  if (!result) return json({ error: 'school_year_not_found' }, 404);
  return json(result);
}

async function buildOverview(db, { schoolYearId, scope, financial }) {
  const year = await db.query('SELECT id, label FROM school_years WHERE id = $1', [schoolYearId]);
  if (!year.rows[0]) return null;

  // Klasy w zakresie: wszystkie klasy roku (zakres szeroki dla tego roku) plus
  // klasy z przydziałów klasowych (przydział bez roku obowiązuje w każdym).
  const wideForYear = scope.allYears || scope.years.includes(schoolYearId);
  const grantedClasses = scope.classIds.filter((_, index) => scope.classYears[index] === null || scope.classYears[index] === schoolYearId);
  const visible = await db.query(
    `SELECT id FROM classes WHERE school_year_id = $1 AND ($2::boolean OR id = ANY($3::text[])) ORDER BY id`,
    [schoolYearId, wideForYear, grantedClasses],
  );
  if (!wideForYear && !grantedClasses.length) return null;
  const classIds = visible.rows.map((row) => row.id);
  const includePayments = financial && wideForYear;

  const { rows } = await db.query(
    `SELECT c.id, c.name,
            (SELECT count(*) FROM enrollments_current e WHERE e.class_id = c.id) AS student_count,
            (SELECT count(DISTINCT ph.household_id) FROM enrollments_current e
               JOIN student_primary_household_current ph ON ph.student_id = e.student_id
              WHERE e.class_id = c.id) AS household_count,
            (SELECT count(*) FROM role_grants g
              WHERE g.class_id = c.id AND g.role = 'representative'
                AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())) AS representative_active,
            (SELECT count(*) FROM invitations i
              WHERE i.class_id = c.id AND i.role = 'representative'
                AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()) AS representative_pending,
            (SELECT count(*) FROM enrollments_current e
              WHERE e.class_id = c.id AND EXISTS (
                SELECT 1 FROM student_guardians_current sg JOIN guardians g ON g.id = sg.guardian_id
                 WHERE sg.student_id = e.student_id AND sg.contact_allowed AND g.contact_allowed
                   AND g.email IS NOT NULL
              )) AS contact_count,
            (SELECT count(*) FROM enrollments_current e
              WHERE e.class_id = c.id AND NOT EXISTS (
                SELECT 1 FROM student_guardians_current sg JOIN guardians g ON g.id = sg.guardian_id
                 WHERE sg.student_id = e.student_id AND sg.contact_allowed AND g.contact_allowed
                   AND g.email IS NOT NULL
              )) AS no_contact_count,
            ${includePayments ? `(SELECT count(DISTINCT ph.household_id) FROM enrollments_current e
               JOIN student_primary_household_current ph ON ph.student_id = e.student_id
              WHERE e.class_id = c.id AND EXISTS (
                SELECT 1 FROM household_payment_totals t
                 WHERE t.household_id = ph.household_id AND t.school_year_id = c.school_year_id
                   AND t.net_amount_cents > 0
              )) AS households_with_entry` : 'NULL AS households_with_entry'}
       FROM classes c
      WHERE c.school_year_id = $1 AND c.id = ANY($2::text[])
      ORDER BY c.name, c.id`,
    [schoolYearId, classIds],
  );

  const classes = rows.map((row) => {
    const studentCount = toSafeInteger(row.student_count);
    const householdCount = toSafeInteger(row.household_count);
    const entry = {
      id: row.id,
      name: row.name,
      studentCount,
      householdCount,
      representative: {
        active: toSafeInteger(row.representative_active),
        pendingInvites: toSafeInteger(row.representative_pending),
      },
      contactEmailCount: toSafeInteger(row.contact_count),
      noContactCount: toSafeInteger(row.no_contact_count),
    };
    if (includePayments) {
      entry.paymentEntryRatePercent = paymentRate(householdCount, toSafeInteger(row.households_with_entry));
    }
    return entry;
  });

  // Wiersz sumaryczny: gospodarstwa i rodzeństwo w kilku klasach liczone raz
  // (osobne zapytanie po całym roku, nie suma kolumn klas).
  const totalsRow = await db.query(
    `SELECT (SELECT count(*) FROM enrollments_current e JOIN classes c ON c.id = e.class_id WHERE c.school_year_id = $1 AND c.id = ANY($2::text[])) AS student_count,
            (SELECT count(DISTINCT ph.household_id) FROM enrollments_current e
               JOIN classes c ON c.id = e.class_id
               JOIN student_primary_household_current ph ON ph.student_id = e.student_id
              WHERE c.school_year_id = $1 AND c.id = ANY($2::text[])) AS household_count,
            ${includePayments ? `(SELECT count(DISTINCT ph.household_id) FROM enrollments_current e
               JOIN classes c ON c.id = e.class_id
               JOIN student_primary_household_current ph ON ph.student_id = e.student_id
              WHERE c.school_year_id = $1 AND c.id = ANY($2::text[]) AND EXISTS (
                SELECT 1 FROM household_payment_totals t
                 WHERE t.household_id = ph.household_id AND t.school_year_id = $1
                   AND t.net_amount_cents > 0
              )) AS households_with_entry,
             (SELECT count(*) FROM payment_entries pe WHERE pe.school_year_id = $1 AND pe.status = 'unmatched') AS unmatched_count`
              : 'NULL AS households_with_entry, NULL AS unmatched_count'}`,
    [schoolYearId, classIds],
  );
  const totalsSource = totalsRow.rows[0];
  const totalHouseholdCount = toSafeInteger(totalsSource.household_count);
  const totals = {
    studentCount: toSafeInteger(totalsSource.student_count),
    householdCount: totalHouseholdCount,
    representative: {
      active: classes.reduce((sum, entry) => sum + entry.representative.active, 0),
      pendingInvites: classes.reduce((sum, entry) => sum + entry.representative.pendingInvites, 0),
    },
    contactEmailCount: classes.reduce((sum, entry) => sum + entry.contactEmailCount, 0),
    noContactCount: classes.reduce((sum, entry) => sum + entry.noContactCount, 0),
  };
  if (includePayments) {
    totals.paymentEntryRatePercent = paymentRate(totalHouseholdCount, toSafeInteger(totalsSource.households_with_entry));
    totals.unmatchedPaymentsCount = toSafeInteger(totalsSource.unmatched_count);
  }

  return {
    schoolYearId,
    schoolYearLabel: year.rows[0].label,
    note: NOTE,
    scope: wideForYear ? 'school' : 'classes',
    classes,
    totals,
  };
}
