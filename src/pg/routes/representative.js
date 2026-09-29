// Pulpit przedstawiciela klasy (#118) — jedna trasa zbiorcza z podsumowaniem
// każdej przypisanej dziś klasy: liczba uczniów i gospodarstw, liczba uczniów
// „do kartki papierowej” (bez opiekuna z obiema zgodami i e-mailem — ta sama
// reguła co lista klasy #95 i migawka kampanii) oraz stan wydarzeń klasy
// czekających na decyzję, data ostatniego wydruku kartek (z audytu
// `print.cards_requested`), najbliższe zebranie klasy i liczba aktywnych
// dokumentów klasy. Treść dla roli `representative`; UI w families/.
// „Nowe od ostatniego logowania” nie jest liczone (brak wiarygodnego
// znacznika logowania) — pokazujemy liczbę i datę najnowszego dokumentu.
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
// Liczy po widoku `enrollments_current` (#86/#285), nie po `enrollments`
// wprost — uczeń, który odszedł ze szkoły (ended_on w przeszłości), znika
// z liczników i z listy „do kartki papierowej” tego pulpitu, tak samo jak
// z listy klasy #95 i migawki kampanii. Follow-up po #294.

import { loadAuthorizationContext } from '../authorization.js';
import { emailHash, normalizeEmail } from '../../email/content.js';

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
            (SELECT count(*) FROM enrollments_current e WHERE e.class_id = c.id) AS student_count,
            (SELECT count(DISTINCT sh.household_id) FROM enrollments_current e
               JOIN student_households_current sh ON sh.student_id = e.student_id
              WHERE e.class_id = c.id) AS household_count,
            (SELECT max(a.occurred_at) FROM audit_events a
              WHERE a.action = 'print.cards_requested' AND a.entity_type = 'school_year'
                AND a.entity_id = c.school_year_id AND a.metadata_json->>'classId' = c.id) AS last_print_at,
            (SELECT row_to_json(m) FROM (
               SELECT mt.id, mt.title, mt.scheduled_at, mt.location FROM meetings mt
                WHERE mt.kind = 'class' AND mt.class_id = c.id AND mt.school_year_id = c.school_year_id
                  AND mt.status = 'scheduled' AND mt.scheduled_at >= now()
                ORDER BY mt.scheduled_at, mt.id LIMIT 1) m) AS next_meeting,
            (SELECT count(*) FROM documents d
              WHERE d.kind = 'class' AND d.class_id = c.id AND d.school_year_id = c.school_year_id
                AND NOT EXISTS (SELECT 1 FROM document_status_events se WHERE se.document_id = d.id)) AS document_count,
            (SELECT max(d.created_at) FROM documents d
              WHERE d.kind = 'class' AND d.class_id = c.id AND d.school_year_id = c.school_year_id
                AND NOT EXISTS (SELECT 1 FROM document_status_events se WHERE se.document_id = d.id)) AS document_latest_at,
            (SELECT count(*) FROM events ev WHERE ev.class_id = c.id AND ev.status = 'draft') AS draft_event_count,
            (SELECT count(*) FROM events ev WHERE ev.class_id = c.id AND ev.status = 'submitted') AS submitted_event_count
       FROM classes c
      WHERE c.id = ANY($1::text[]) AND c.school_year_id = $2
      ORDER BY c.name, c.id`,
    [classIds, schoolYearId],
  );

  // „Do kartki”: uczeń bez opiekuna z obiema zgodami i poprawnym adresem, który
  // nie ma aktywnej blokady (bounce/skarga, widok email_active_suppressions —
  // ta sama definicja co migawka kampanii). Adresy nie opuszczają serwera;
  // odpowiedź zawiera wyłącznie liczby. Wypisanie z kategorii kampanii jest
  // per kategoria, więc tu nie jest liczone (założenie opisane w PR).
  const { rows: contacts } = await env.db.query(
    `SELECT e.class_id, e.student_id, g.email
       FROM enrollments_current e
       JOIN student_guardians_current sg ON sg.student_id = e.student_id AND sg.contact_allowed
       JOIN guardians g ON g.id = sg.guardian_id AND g.contact_allowed AND g.email IS NOT NULL
      WHERE e.class_id = ANY($1::text[]) AND e.school_year_id = $2`,
    [rows.map((row) => row.id), schoolYearId],
  );
  for (const contact of contacts) {
    const normalized = normalizeEmail(contact.email);
    contact.hash = normalized ? emailHash(normalized) : null;
  }
  const hashes = [...new Set(contacts.map((contact) => contact.hash).filter(Boolean))];
  const suppressed = new Set();
  if (hashes.length) {
    const { rows: blocked } = await env.db.query(
      'SELECT email_hash FROM email_active_suppressions WHERE email_hash = ANY($1::text[])', [hashes],
    );
    for (const row of blocked) suppressed.add(row.email_hash);
  }
  const reachable = new Map();
  for (const contact of contacts) {
    if (!contact.hash || suppressed.has(contact.hash)) continue;
    if (!reachable.has(contact.class_id)) reachable.set(contact.class_id, new Set());
    reachable.get(contact.class_id).add(contact.student_id);
  }

  return json({
    schoolYearId,
    classes: rows.map((row) => ({
      id: row.id,
      name: row.name,
      studentCount: toSafeInteger(row.student_count),
      householdCount: toSafeInteger(row.household_count),
      needsPaperCardCount: toSafeInteger(row.student_count) - (reachable.get(row.id)?.size ?? 0),
      cards: { lastPrintedAt: row.last_print_at ? new Date(row.last_print_at).toISOString() : null },
      nextMeeting: row.next_meeting
        ? {
          id: row.next_meeting.id,
          title: row.next_meeting.title,
          scheduledAt: new Date(row.next_meeting.scheduled_at).toISOString(),
          location: row.next_meeting.location ?? null,
        }
        : null,
      documents: {
        activeCount: toSafeInteger(row.document_count),
        latestAt: row.document_latest_at ? new Date(row.document_latest_at).toISOString() : null,
      },
      events: {
        draftCount: toSafeInteger(row.draft_event_count),
        submittedCount: toSafeInteger(row.submitted_event_count),
      },
    })),
  });
}
