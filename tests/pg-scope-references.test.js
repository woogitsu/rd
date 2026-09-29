// #205: identyfikatory w treści żądań sprawdzane względem zakresu (obecność na
// zebraniu klasowym, amendsResolutionId, documentId listy kontrolnej, wpłata
// na gospodarstwo z dzieckiem w roku) — nieistniejący i spoza zakresu dają ten
// sam kod. Wyłącznie dane syntetyczne.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMeeting, createResolution, determineQuorum, recordAttendance } from '../src/pg/meetings.js';
import { updateMeeting } from './helpers/with-revision.js';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedClass, seedUser, seedUserSession } from './helpers/pg.js';

const YEAR = 'y-205';
let keySeq = 0;
const key = () => `k-205-test-key-${++keySeq}`;

// Gospodarstwo z dzieckiem zapisanym do danej klasy (domyślnie w YEAR), z opiekunem.
async function household(db, { id, classId, guardianId, schoolYearId = YEAR }) {
  await db.query('INSERT INTO households (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
  const studentId = `${id}-student`;
  await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1,$2,'Syntetyczny','Uczeń') ON CONFLICT DO NOTHING", [studentId, id]);
  await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
    [`${studentId}-enr`, studentId, classId, schoolYearId]);
  // student_households (primaire) jest tworzone automatycznie triggerem
  // students_household_sync (0014) z household_id ustawionego wyżej — nie
  // wstawiamy go ręcznie, żeby nie zderzyć się z tym samym wierszem.
  if (guardianId) {
    await db.query("INSERT INTO guardians (id, household_id, first_name, last_name) VALUES ($1,$2,'Syntetyczny','Opiekun') ON CONFLICT DO NOTHING",
      [guardianId, id]);
    await db.query('INSERT INTO student_guardians (student_id, guardian_id, contact_allowed) VALUES ($1,$2,true) ON CONFLICT DO NOTHING',
      [studentId, guardianId]);
  }
  return studentId;
}

describe('#205: obecność na zebraniu klasowym (capacity=guardian)', () => {
  async function setup() {
    const db = await createTestDb();
    await seedClass(db, { id: 'kl-1a', schoolYearId: YEAR, name: '1A' });
    await seedClass(db, { id: 'kl-1b', schoolYearId: YEAR, name: '1B' });
    await seedUser(db, { userId: 'u-board-a' });
    const board = { userId: 'u-board-a', grants: [{ role: 'board', classId: 'kl-1a', schoolYearId: YEAR, expiresAt: null }], mfaVerified: true };
    await household(db, { id: 'hh-a', classId: 'kl-1a', guardianId: 'g-1a' });
    await household(db, { id: 'hh-b', classId: 'kl-1b', guardianId: 'g-1b' });
    const { meeting } = await createMeeting(db, board, {
      idempotencyKey: key(), schoolYearId: YEAR, kind: 'class', classId: 'kl-1a', title: 'Zebranie 1A',
      scheduledAt: '2026-10-10T17:00:00Z', location: 'Sala 1', status: 'scheduled',
      quorumMode: 'fraction', quorumNumerator: 1, quorumDenominator: 2, quorumInclusive: true,
      votingBodySize: 2, quorumRuleSource: 'Test',
    });
    await updateMeeting(db, board, { meetingId: meeting.id, status: 'held' });
    return { db, board, meeting };
  }

  test('opiekun dziecka z 1B jako "guardian" na zebraniu 1A -> invalid_reference', async () => {
    const { db, board, meeting } = await setup();
    try {
      await assert.rejects(
        recordAttendance(db, board, {
          meetingId: meeting.id, guardianId: 'g-1b', capacity: 'guardian', votingEligible: true, present: true,
        }),
        { code: 'invalid_reference' },
      );
    } finally { await db.close(); }
  });

  test('opiekun nieistniejący jako "guardian" -> ten sam kod invalid_reference', async () => {
    const { db, board, meeting } = await setup();
    try {
      await assert.rejects(
        recordAttendance(db, board, {
          meetingId: meeting.id, guardianId: 'g-nie-istnieje', capacity: 'guardian', votingEligible: true, present: true,
        }),
        { code: 'invalid_reference' },
      );
    } finally { await db.close(); }
  });

  test('opiekun dziecka z 1A na zebraniu 1A -> zaakceptowany', async () => {
    const { db, board, meeting } = await setup();
    try {
      const { attendee } = await recordAttendance(db, board, {
        meetingId: meeting.id, guardianId: 'g-1a', capacity: 'guardian', votingEligible: true, present: true,
      });
      assert.equal(attendee.guardianId, 'g-1a');
    } finally { await db.close(); }
  });

  test('dwoje opiekunów jednego dziecka z 1A dopuszczonych, opiekun rodzeństwa z 1B odrzucony', async () => {
    const { db, board, meeting } = await setup();
    try {
      await db.query("INSERT INTO guardians (id, household_id, first_name, last_name) VALUES ('g-1a-2','hh-a','Syntetyczny','Drugi') ON CONFLICT DO NOTHING");
      await db.query("INSERT INTO student_guardians (student_id, guardian_id, contact_allowed) VALUES ('hh-a-student','g-1a-2', true) ON CONFLICT DO NOTHING");
      await recordAttendance(db, board, { meetingId: meeting.id, guardianId: 'g-1a', capacity: 'guardian', votingEligible: true, present: true });
      await recordAttendance(db, board, { meetingId: meeting.id, guardianId: 'g-1a-2', capacity: 'guardian', votingEligible: true, present: true });
      await assert.rejects(
        recordAttendance(db, board, { meetingId: meeting.id, guardianId: 'g-1b', capacity: 'guardian', votingEligible: true, present: true }),
        { code: 'invalid_reference' },
      );
    } finally { await db.close(); }
  });

  test('poprawka obecności (upsert) tego samego opiekuna 1A -> nadal zaakceptowana', async () => {
    const { db, board, meeting } = await setup();
    try {
      await recordAttendance(db, board, { meetingId: meeting.id, guardianId: 'g-1a', capacity: 'guardian', votingEligible: true, present: true });
      const { attendee } = await recordAttendance(db, board, { meetingId: meeting.id, guardianId: 'g-1a', capacity: 'guardian', votingEligible: false, present: false });
      assert.equal(attendee.present, false);
    } finally { await db.close(); }
  });
});

describe('#205: amendsResolutionId poza rokiem/klasą', () => {
  test('uchwała klasy 1A nie może "zmieniać" uchwały klasy 1B', async () => {
    const db = await createTestDb();
    try {
      await seedClass(db, { id: 'kl-1a', schoolYearId: YEAR, name: '1A' });
      await seedClass(db, { id: 'kl-1b', schoolYearId: YEAR, name: '1B' });
      await seedUser(db, { userId: 'u-board' });
      const board = { userId: 'u-board', grants: [{ role: 'board', schoolYearId: YEAR, expiresAt: null }], mfaVerified: true };
      const mk = async (classId, kind) => {
        const { meeting } = await createMeeting(db, board, {
          idempotencyKey: key(), schoolYearId: YEAR, kind, classId, title: 'Zebranie',
          scheduledAt: '2026-10-10T17:00:00Z', location: 'Sala', status: 'scheduled',
          quorumMode: 'fraction', quorumNumerator: 1, quorumDenominator: 2, quorumInclusive: true,
          votingBodySize: 2, quorumRuleSource: 'Test',
        });
        await updateMeeting(db, board, { meetingId: meeting.id, status: 'held' });
        return meeting;
      };
      const m1a = await mk('kl-1a', 'class');
      const m1b = await mk('kl-1b', 'class');
      await recordAttendance(db, board, { meetingId: m1b.id, userId: 'u-board', capacity: 'board_member', votingEligible: true, present: true });
      const { quorumCheck: qcB } = await determineQuorum(db, board, { idempotencyKey: key(), meetingId: m1b.id });
      const { resolution: adopted } = await createResolution(db, board, {
        idempotencyKey: key(), meetingId: m1b.id, number: '1/2026', title: 'Uchwała 1B', body: 'Treść uchwały testowej.',
        status: 'adopted', votesFor: 1, votesAgainst: 0, votesAbstain: 0, quorumCheckId: qcB.id,
      });
      await assert.rejects(
        createResolution(db, board, {
          idempotencyKey: key(), meetingId: m1a.id, number: '1/2026-a', title: 'Zmiana', body: 'Zmienia uchwałę innej klasy.',
          status: 'draft', amendsResolutionId: adopted.id, relationKind: 'amends',
        }),
        { code: 'invalid_reference' },
      );
    } finally { await db.close(); }
  });
});

describe('#205: documentId listy kontrolnej zamknięcia roku', () => {
  test('dokument innego roku nie potwierdza punktu listy kontrolnej', async () => {
    const db = await createTestDb();
    try {
      await seedClass(db, { id: 'kl-1a', schoolYearId: YEAR, name: '1A' });
      await db.query(`INSERT INTO school_years (id, label, starts_on, ends_on) VALUES ('y-205-other','y-other','2027-09-01','2028-08-31')
        ON CONFLICT DO NOTHING`);
      await seedClass(db, { id: 'kl-1b', schoolYearId: 'y-205-other', name: '1A' });
      const cookie = await seedUserSession(db, { userId: 'u-board', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] });
      await db.query(`INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by, school_year_id, sha256, idempotency_key)
        VALUES ('doc-other-year', 'docs/00000000-0000-0000-0000-0000000000aa', 'application/pdf', 10, 'board', 'u-board',
                'y-205-other', repeat('a', 64), 'doc-other-year-key')`);
      const start = await handlePgRequest(request(`/api/year-close/${YEAR}/start`, {
        method: 'POST', cookie, headers: { 'Idempotency-Key': 'yc-start-205' }, body: { nextSchoolYearId: 'y-205-other' },
      }), { db });
      assert.equal(start.status, 201, JSON.stringify(await start.clone().json()));
      const res = await handlePgRequest(request(`/api/year-close/${YEAR}/checklist/resolutions_archived`, {
        method: 'POST', cookie, headers: { 'Idempotency-Key': 'yc-checklist-205' },
        body: { note: 'Sprawdzone i archiwizowane.', documentId: 'doc-other-year' },
      }), { db });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, 'invalid_document_id');
    } finally { await db.close(); }
  });
});

// Wpłata na gospodarstwo bez dziecka w roku wpłaty (propozycja #4 z issue
// #205, householdId) NIE jest objęta tym PR — zablokowanie tego wymagałoby
// zmiany współdzielonych fixture'ów autoryzacyjnych (tests/helpers/pg.js,
// TARGETS w tests/helpers/route-matrix.js), które celowo tworzą gospodarstwa
// bez powiązanych uczniów/zapisów (testują zakres RÓL, nie kompletność
// danych) — próba wymuszenia tego warunku łamie tam 9 istniejących testów
// (macierz uprawnień, parytet z Workerem, wpłaty częściowe/równoległe).
// Do zrobienia osobno, razem z decyzją D-11 i przeglądem tych fixture'ów.
