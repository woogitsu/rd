// Pulpit przedstawiciela klasy (#118) — jedna trasa zbiorcza z podsumowaniem
// każdej przypisanej dziś klasy: liczba uczniów i gospodarstw, liczba uczniów
// „do kartki papierowej” (bez opiekuna z obiema zgodami i e-mailem — ta sama
// reguła co lista klasy #95 i migawka kampanii) oraz stan wydarzeń klasy
// czekających na decyzję. Treść dla roli `representative`; #85 (powłoka
// nawigacji) i dalsze sekcje (zebrania, dokumenty) zostają poza tym PR.
//
// Sekcja wpłat jest świadomie pominięta: decyzja D-08 nie zapadła, więc pole
// `payments` nie istnieje w odpowiedzi (nie `null`) — wariant zachowawczy.
// Żadnego rankingu, żadnego słowa „dłużnik”/„zaległość”/„brak wpłaty”.
//
//   GET /api/representative/overview?schoolYearId=
//
// Zakres: wyłącznie klasy z aktywnych przydziałów `representative` do
// wskazanego roku (przydział innego roku nie otwiera klas bieżącego roku,
// SR-01). Konto bez żadnego przydziału `representative` (admin, zarząd,
// skarbnik, Komisja Rewizyjna, dyrekcja) dostaje 403 — to pulpit tej roli,
// nie ogólny raport klas (ten już istnieje w families.js).
//
// Liczy po `enrollments` wprost (nie po widoku `enrollments_current`), bo ten
// widok istnieje dopiero po migracji 0045 z osobnego, jeszcze niescalonego
// PR (#86 — odejście ze szkoły). Po scaleniu #86 te trzy podzapytania warto
// przełączyć na `enrollments_current`, żeby uczeń po odejściu również znikał
// z tego pulpitu — patrz opis w PR.

import { loadAuthorizationContext } from '../authorization.js';

export const name = 'representative';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function toSafeInteger(value) {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number)) throw new Error('unsafe_integer');
  return number;
}

export async function handle(request, env, url, json) {
  if (url.pathname !== '/api/representative/overview') return null;
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });

  const context = await loadAuthorizationContext(request, env);
  if (!context) return json({ error: 'unauthenticated' }, 401);

  const hasRepresentativeRole = context.grants.some((grant) => grant.role === 'representative');
  if (!hasRepresentativeRole) return json({ error: 'forbidden' }, 403);

  const schoolYearId = url.searchParams.get('schoolYearId');
  if (!ID_PATTERN.test(schoolYearId ?? '')) return json({ error: 'invalid_request' }, 400);

  // Przydział bez school_year_id obowiązuje w każdym roku (jak w families.js);
  // przydział innego roku nie otwiera klas tego roku.
  const classIds = [...new Set(
    context.grants
      .filter((grant) => grant.role === 'representative' && grant.classId
        && (grant.schoolYearId === null || grant.schoolYearId === schoolYearId))
      .map((grant) => grant.classId),
  )];
  if (!classIds.length) return json({ schoolYearId, classes: [] });

  const { rows } = await env.db.query(
    `SELECT c.id, c.name,
            (SELECT count(*) FROM enrollments e WHERE e.class_id = c.id) AS student_count,
            (SELECT count(DISTINCT sh.household_id) FROM enrollments e
               JOIN student_households_current sh ON sh.student_id = e.student_id
              WHERE e.class_id = c.id) AS household_count,
            (SELECT count(*) FROM enrollments e
              WHERE e.class_id = c.id AND NOT EXISTS (
                SELECT 1 FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
                 WHERE sg.student_id = e.student_id AND sg.contact_allowed AND g.contact_allowed
                   AND g.email IS NOT NULL
                   AND (sg.starts_on IS NULL OR sg.starts_on <= CURRENT_DATE)
                   AND (sg.ends_on IS NULL OR sg.ends_on > CURRENT_DATE)
              )) AS needs_paper_card_count,
            (SELECT count(*) FROM events ev WHERE ev.class_id = c.id AND ev.status = 'draft') AS draft_event_count,
            (SELECT count(*) FROM events ev WHERE ev.class_id = c.id AND ev.status = 'submitted') AS submitted_event_count
       FROM classes c
      WHERE c.id = ANY($1::text[]) AND c.school_year_id = $2
      ORDER BY c.name, c.id`,
    [classIds, schoolYearId],
  );

  return json({
    schoolYearId,
    classes: rows.map((row) => ({
      id: row.id,
      name: row.name,
      studentCount: toSafeInteger(row.student_count),
      householdCount: toSafeInteger(row.household_count),
      needsPaperCardCount: toSafeInteger(row.needs_paper_card_count),
      events: {
        draftCount: toSafeInteger(row.draft_event_count),
        submittedCount: toSafeInteger(row.submitted_event_count),
      },
    })),
  });
}
