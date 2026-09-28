// Pulpit zarządu: statystyki szkoły per klasa (#131). Prototyp — nie jest
// wdrożony. Jedna trasa zbiorcza, informacyjna — bez rankingu i bez listy
// rodzin. Wzór zapytań i reguła kontaktu e-mail (#95) jak w
// representative.js (#118) i families.js, żeby te trzy widoki dawały te
// same liczby na tych samych danych.
//
//   GET /api/board/overview?schoolYearId=
//
// Zakres: admin i zarząd, wyłącznie w latach z własnego przydziału (zarząd
// przydzielony do jednego roku widzi tylko ten rok — SR-01). Skarbnik i
// inne role nie mają tu dostępu: to pulpit zarządu, nie ogólny raport klas
// (już istnieje w families.js) ani raport finansowy (ledger.js).
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
import { scopeFromGrants } from './families.js';

export const name = 'board';

const BASE_ROLES = ['admin', 'board'];
const FINANCIAL_ROLES = ['admin', 'board', 'treasurer'];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MIN_HOUSEHOLDS_FOR_PAYMENT_RATE = 5;
const NOTE = 'Składka jest dobrowolna. Odsetek opisuje odnotowane wpisy, nie zobowiązania; '
  + 'wpłaty nieprzypisane nie są w nim ujęte.';

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

  // Tylko przydziały szerokie (bez class_id) — ten pulpit nie jest dostępny
  // przez przydział klasowy, tylko przez rolę admin/zarząd całej szkoły/roku.
  const scope = scopeFromGrants(context.grants.filter((grant) => !grant.classId), BASE_ROLES);
  if (!scope.any) return json({ error: 'forbidden' }, 403);

  const schoolYearId = url.searchParams.get('schoolYearId');
  if (!ID_PATTERN.test(schoolYearId ?? '')) return json({ error: 'invalid_request' }, 400);
  if (!scope.allYears && !scope.years.includes(schoolYearId)) return json({ error: 'school_year_not_found' }, 404);

  const year = await env.db.query('SELECT id, label FROM school_years WHERE id = $1', [schoolYearId]);
  if (!year.rows[0]) return json({ error: 'school_year_not_found' }, 404);

  const includePayments = isAuthorizedScoped(context, { roles: FINANCIAL_ROLES, requireMfa: true });

  const { rows } = await env.db.query(
    `SELECT c.id, c.name,
            (SELECT count(*) FROM enrollments e WHERE e.class_id = c.id) AS student_count,
            (SELECT count(DISTINCT ph.household_id) FROM enrollments e
               JOIN student_primary_household_current ph ON ph.student_id = e.student_id
              WHERE e.class_id = c.id) AS household_count,
            (SELECT count(*) FROM role_grants g
              WHERE g.class_id = c.id AND g.role = 'representative'
                AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())) AS representative_active,
            (SELECT count(*) FROM invitations i
              WHERE i.class_id = c.id AND i.role = 'representative'
                AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()) AS representative_pending,
            (SELECT count(*) FROM enrollments e
              WHERE e.class_id = c.id AND EXISTS (
                SELECT 1 FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
                 WHERE sg.student_id = e.student_id AND sg.contact_allowed AND g.contact_allowed
                   AND g.email IS NOT NULL
                   AND (sg.starts_on IS NULL OR sg.starts_on <= CURRENT_DATE)
                   AND (sg.ends_on IS NULL OR sg.ends_on > CURRENT_DATE)
              )) AS contact_count,
            (SELECT count(*) FROM enrollments e
              WHERE e.class_id = c.id AND NOT EXISTS (
                SELECT 1 FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
                 WHERE sg.student_id = e.student_id AND sg.contact_allowed AND g.contact_allowed
                   AND g.email IS NOT NULL
                   AND (sg.starts_on IS NULL OR sg.starts_on <= CURRENT_DATE)
                   AND (sg.ends_on IS NULL OR sg.ends_on > CURRENT_DATE)
              )) AS no_contact_count,
            ${includePayments ? `(SELECT count(DISTINCT ph.household_id) FROM enrollments e
               JOIN student_primary_household_current ph ON ph.student_id = e.student_id
              WHERE e.class_id = c.id AND EXISTS (
                SELECT 1 FROM payment_entry_net pen
                 WHERE pen.household_id = ph.household_id AND pen.school_year_id = c.school_year_id
                   AND pen.status = 'recorded' AND pen.net_amount_cents > 0
              )) AS households_with_entry` : 'NULL AS households_with_entry'}
       FROM classes c
      WHERE c.school_year_id = $1
      ORDER BY c.name, c.id`,
    [schoolYearId],
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
  const totalsRow = await env.db.query(
    `SELECT (SELECT count(*) FROM enrollments e JOIN classes c ON c.id = e.class_id WHERE c.school_year_id = $1) AS student_count,
            (SELECT count(DISTINCT ph.household_id) FROM enrollments e
               JOIN classes c ON c.id = e.class_id
               JOIN student_primary_household_current ph ON ph.student_id = e.student_id
              WHERE c.school_year_id = $1) AS household_count,
            ${includePayments ? `(SELECT count(DISTINCT ph.household_id) FROM enrollments e
               JOIN classes c ON c.id = e.class_id
               JOIN student_primary_household_current ph ON ph.student_id = e.student_id
              WHERE c.school_year_id = $1 AND EXISTS (
                SELECT 1 FROM payment_entry_net pen
                 WHERE pen.household_id = ph.household_id AND pen.school_year_id = $1
                   AND pen.status = 'recorded' AND pen.net_amount_cents > 0
              )) AS households_with_entry,
             (SELECT count(*) FROM payment_entries pe WHERE pe.school_year_id = $1 AND pe.status = 'unmatched') AS unmatched_count`
              : 'NULL AS households_with_entry, NULL AS unmatched_count'}`,
    [schoolYearId],
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

  return json({
    schoolYearId,
    schoolYearLabel: year.rows[0].label,
    note: NOTE,
    classes,
    totals,
  });
}
