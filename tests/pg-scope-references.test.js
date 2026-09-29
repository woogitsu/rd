// #205: identyfikatory w treści żądań sprawdzane względem zakresu (obecność na
// zebraniu klasowym, amendsResolutionId, documentId listy kontrolnej, wpłata
// na gospodarstwo z dzieckiem w roku) — nieistniejący i spoza zakresu dają ten
// sam kod. Wyłącznie dane syntetyczne.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMeeting, createResolution, determineQuorum, recordAttendance, updateMeeting } from '../src/pg/meetings.js';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedClass, seedEnrolledHousehold, seedRoleGrant, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';

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
      await seedRoleGrant(db, { userId: 'u-board', schoolYearId: YEAR });
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


// ---------- userId na liście obecności (migracja 0134) ----------

describe('#205: obecność — konto (userId) poza zakresem zebrania', () => {
  const YEAR_OTHER = 'y-205-drugi';

  async function setup() {
    const db = await createTestDb();
    await seedClass(db, { id: 'kl-1a', schoolYearId: YEAR, name: '1A' });
    await seedClass(db, { id: 'kl-1b', schoolYearId: YEAR, name: '1B' });
    await db.query(`INSERT INTO school_years (id, label, starts_on, ends_on) VALUES ($1, 'drugi rok', '2027-09-01', '2028-08-31')`, [YEAR_OTHER]);
    await seedRoleGrant(db, { userId: 'u-board-a', role: 'board', schoolYearId: YEAR, classId: 'kl-1a' });
    const board = { userId: 'u-board-a', grants: [{ role: 'board', classId: 'kl-1a', schoolYearId: YEAR, expiresAt: null }], mfaVerified: true };
    await household(db, { id: 'hh-a', classId: 'kl-1a', guardianId: 'g-1a' });
    await household(db, { id: 'hh-b', classId: 'kl-1b', guardianId: 'g-1b' });
    const { meeting } = await createMeeting(db, board, {
      idempotencyKey: key(), schoolYearId: YEAR, kind: 'class', classId: 'kl-1a', title: 'Zebranie 1A',
      scheduledAt: '2026-10-10T17:00:00Z', location: 'Sala 1', status: 'scheduled',
      quorumMode: 'minimum_count', quorumMinCount: 1, quorumRuleSource: 'Test',
    });
    await updateMeeting(db, board, { meetingId: meeting.id, status: 'held' });
    return { db, board, meeting };
  }
  const count = async (db, table) => Number((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
  const att = (meeting, extra) => ({ meetingId: meeting.id, capacity: 'guest', votingEligible: true, present: true, ...extra });

  test('konto bez przydziału, konto z przydziałem innej klasy/roku i nieistniejące: ta sama odmowa, nic nie zapisane', async () => {
    const { db, board, meeting } = await setup();
    try {
      await seedUser(db, { userId: 'u-bez-przydzialu' });
      await seedRoleGrant(db, { userId: 'u-klasa-1b', role: 'board', schoolYearId: YEAR, classId: 'kl-1b' });
      await seedRoleGrant(db, { userId: 'u-rok-2', role: 'treasurer', schoolYearId: YEAR_OTHER });
      const rows = await count(db, 'meeting_attendees');
      const events = await count(db, 'audit_events');
      const errors = [];
      for (const userId of ['u-bez-przydzialu', 'u-klasa-1b', 'u-rok-2', 'u-nie-istnieje']) {
        errors.push(await recordAttendance(db, board, att(meeting, { userId })).then(() => null, (error) => error));
      }
      for (const error of errors) assert.equal(error?.code, 'invalid_reference');
      assert.equal(new Set(errors.map((error) => `${error.status}|${error.message}`)).size, 1, 'odpowiedź nie odróżnia spoza zakresu od nieistniejącego');
      assert.equal(await count(db, 'meeting_attendees'), rows);
      assert.equal(await count(db, 'audit_events'), events);
    } finally { await db.close(); }
  });

  test('konto z przydziałem w roku zebrania (szkolnym albo klasy zebrania) jest przyjęte', async () => {
    const { db, board, meeting } = await setup();
    try {
      await seedRoleGrant(db, { userId: 'u-skarbnik', role: 'treasurer', schoolYearId: YEAR });
      await seedRoleGrant(db, { userId: 'u-wszystkie-lata', role: 'audit' });
      await seedRoleGrant(db, { userId: 'u-klasa-1a', role: 'representative', schoolYearId: YEAR, classId: 'kl-1a' });
      for (const userId of ['u-skarbnik', 'u-wszystkie-lata', 'u-klasa-1a']) {
        const { attendee } = await recordAttendance(db, board, att(meeting, { userId }));
        assert.equal(attendee.userId, userId);
      }
    } finally { await db.close(); }
  });

  test('przydział cofnięty albo wygasły przed wpisem: odmowa; korekta istniejącego wpisu po cofnięciu przydziału: przyjęta', async () => {
    const { db, board, meeting } = await setup();
    try {
      await seedRoleGrant(db, { userId: 'u-cofniety', role: 'treasurer', schoolYearId: YEAR });
      await seedRoleGrant(db, { userId: 'u-pozniej', role: 'treasurer', schoolYearId: YEAR });
      await seedUser(db, { userId: 'u-wygasly' });
      await db.query(`INSERT INTO role_grants (id, user_id, role, school_year_id, expires_at) VALUES ('g-wygasly', 'u-wygasly', 'audit', $1, now() - interval '1 day')`, [YEAR]);
      await db.query(`UPDATE role_grants SET revoked_at = now(), revoked_by = user_id WHERE user_id = 'u-cofniety'`);
      for (const userId of ['u-cofniety', 'u-wygasly']) {
        await assert.rejects(recordAttendance(db, board, att(meeting, { userId })), { code: 'invalid_reference' }, userId);
      }
      await recordAttendance(db, board, att(meeting, { userId: 'u-pozniej' }));
      await db.query(`UPDATE role_grants SET revoked_at = now(), revoked_by = user_id WHERE user_id = 'u-pozniej'`);
      const { attendee } = await recordAttendance(db, board, att(meeting, { userId: 'u-pozniej', present: false, votingEligible: false }));
      assert.equal(attendee.present, false);
    } finally { await db.close(); }
  });

  test('podwójne kliknięcie i równoległe wpisy tego samego konta: jeden wiersz', async () => {
    const { db, board, meeting } = await setup();
    try {
      await seedRoleGrant(db, { userId: 'u-skarbnik', role: 'treasurer', schoolYearId: YEAR });
      await Promise.all([
        recordAttendance(db, board, att(meeting, { userId: 'u-skarbnik' })),
        recordAttendance(db, board, att(meeting, { userId: 'u-skarbnik' })),
      ].map((call) => call.catch((error) => error)));
      await recordAttendance(db, board, att(meeting, { userId: 'u-skarbnik' }));
      assert.equal((await db.query("SELECT count(*)::int AS n FROM meeting_attendees WHERE user_id = 'u-skarbnik'")).rows[0].n, 1);
    } finally { await db.close(); }
  });

  test('SQL bezpośrednio: obcy opiekun i konto bez przydziału odrzucone przez trigger, quorum liczy tylko uprawnionych', async () => {
    const { db, board, meeting } = await setup();
    try {
      await seedUser(db, { userId: 'u-bez-przydzialu' });
      const insert = (column, reference, capacity) => db.query(
        `INSERT INTO meeting_attendees (id, meeting_id, ${column}, capacity, voting_eligible, present, recorded_by)
         VALUES ($1, $2, $3, $4, true, true, 'u-board-a')`, [`att-${column}-${reference}`, meeting.id, reference, capacity]);
      await assert.rejects(insert('guardian_id', 'g-1b', 'guardian'), /invalid_reference/);
      await assert.rejects(insert('user_id', 'u-bez-przydzialu', 'guest'), /invalid_reference/);
      await insert('guardian_id', 'g-1a', 'guardian');
      const { quorumCheck } = await determineQuorum(db, board, { idempotencyKey: key(), meetingId: meeting.id });
      assert.equal(quorumCheck.presentEligible, 1);
    } finally { await db.close(); }
  });

  test('zmiana funkcji obcego opiekuna z "guest" na "guardian" nie omija kontroli zakresu', async () => {
    const { db, board, meeting } = await setup();
    try {
      await recordAttendance(db, board, att(meeting, { guardianId: 'g-1b', capacity: 'guest', votingEligible: false }));
      await assert.rejects(
        recordAttendance(db, board, att(meeting, { guardianId: 'g-1b', capacity: 'guardian', votingEligible: true })),
        { code: 'invalid_reference' },
      );
      const row = (await db.query("SELECT capacity, voting_eligible FROM meeting_attendees WHERE guardian_id = 'g-1b'")).rows[0];
      assert.deepEqual(row, { capacity: 'guest', voting_eligible: false });
    } finally { await db.close(); }
  });

  test('poprawka obecności opiekuna, którego relacja właśnie się zakończyła, jest przyjęta; nowy wpis takiego opiekuna nie', async () => {
    const { db, board, meeting } = await setup();
    try {
      await db.query("INSERT INTO guardians (id, household_id, first_name, last_name) VALUES ('g-1a-2','hh-a','Syntetyczny','Drugi')");
      await db.query("INSERT INTO student_guardians (student_id, guardian_id, contact_allowed) VALUES ('hh-a-student','g-1a-2', true)");
      await recordAttendance(db, board, att(meeting, { guardianId: 'g-1a', capacity: 'guardian' }));
      await db.query("UPDATE student_guardians SET ends_on = rd_today() - 1 WHERE guardian_id IN ('g-1a', 'g-1a-2')");
      const { attendee } = await recordAttendance(db, board, att(meeting, { guardianId: 'g-1a', capacity: 'guardian', present: false, votingEligible: false }));
      assert.equal(attendee.present, false);
      await assert.rejects(
        recordAttendance(db, board, att(meeting, { guardianId: 'g-1a-2', capacity: 'guardian' })),
        { code: 'invalid_reference' },
      );
    } finally { await db.close(); }
  });
});

// ---------- householdId we wpłatach ----------

describe('#205: wpłaty — householdId w zakresie roku wpłaty', () => {
  const Y1 = 'y-205-p1';
  const Y2 = 'y-205-p2';

  async function setup() {
    const db = await createTestDb();
    await seedSchoolYear(db, Y1, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
    await seedSchoolYear(db, Y2, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
    await seedEnrolledHousehold(db, 'hh-ok', [Y1]);
    await seedEnrolledHousehold(db, 'hh-tylko-rok-2', [Y2]);
    await seedEnrolledHousehold(db, 'hh-archiwum', [Y1]);
    await db.query("UPDATE households SET archived_at = now() WHERE id = 'hh-archiwum'");
    await db.query("INSERT INTO households (id) VALUES ('hh-bez-ucznia')");
    // Dwoje rodzeństwa w jednym gospodarstwie (dwie klasy) i dwie osoby opiekujące się.
    await seedEnrolledHousehold(db, 'hh-rodzenstwo', [Y1]);
    await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ('st-rodz-2', 'hh-rodzenstwo', 'Syntetyczny', 'Brat')");
    await seedClass(db, { id: 'cls-p-2', schoolYearId: Y1, name: 'Inna' });
    await db.query("INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('enr-rodz-2', 'st-rodz-2', 'cls-p-2', $1)", [Y1]);
    const cookie = await seedUserSession(db, { userId: 'u-skarbnik-p', mfa: true, roles: [{ role: 'treasurer', schoolYearId: Y1 }] });
    const env = { db };
    let seq = 0;
    const post = async (path, body) => {
      const response = await handlePgRequest(request(path, {
        method: 'POST', cookie, body, headers: { 'Idempotency-Key': `pay-205-key-${++seq}-${Math.random().toString(36).slice(2, 8)}` },
      }), env);
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    const pay = (householdId, extra = {}) => post('/api/payments', {
      schoolYearId: Y1, householdId, amountCents: 1000, receivedOn: '2026-10-01', method: 'bank', ...extra,
    });
    const count = async (table) => Number((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
    return { db, env, cookie, post, pay, count };
  }

  test('POST /api/payments: archiwum, gospodarstwo bez ucznia w roku, dziecko tylko w roku 2 i nieistniejące — ta sama odpowiedź, bez zapisu', async () => {
    const { db, pay, count } = await setup();
    try {
      const payments = await count('payment_entries');
      const events = await count('audit_events');
      const results = [];
      for (const householdId of ['hh-archiwum', 'hh-bez-ucznia', 'hh-tylko-rok-2', 'hh-nie-istnieje']) results.push(await pay(householdId));
      for (const result of results) assert.deepEqual(result, { status: 400, body: { error: 'invalid_reference' } });
      assert.equal(await count('payment_entries'), payments);
      assert.equal(await count('audit_events'), events);
    } finally { await db.close(); }
  });

  test('POST /api/payments: gospodarstwo z rodzeństwem w dwóch klasach jest przyjęte; wpłata częściowa na gospodarstwo z dzieckiem tylko w roku 2 przez skarbnika roku 1 — nie', async () => {
    const { db, pay, count } = await setup();
    try {
      assert.equal((await pay('hh-rodzenstwo', { amountCents: 500 })).status, 201);
      assert.equal((await pay('hh-rodzenstwo', { amountCents: 300, receivedOn: '2026-10-02' })).status, 201);
      const before = await count('payment_entries');
      assert.equal((await pay('hh-tylko-rok-2', { amountCents: 250 })).status, 400);
      assert.equal(await count('payment_entries'), before);
      assert.equal((await pay(null, { amountCents: 250 })).body.payment.status, 'unmatched');
    } finally { await db.close(); }
  });

  test('podwójne kliknięcie z tym samym kluczem: jedna wpłata; powtórzenie po zarchiwizowaniu gospodarstwa zwraca zapis', async () => {
    const { db, env, cookie, count } = await setup();
    try {
      const send = () => handlePgRequest(request('/api/payments', {
        method: 'POST', cookie, headers: { 'Idempotency-Key': 'pay-205-double-click' },
        body: { schoolYearId: Y1, householdId: 'hh-ok', amountCents: 1200, receivedOn: '2026-10-03', method: 'bank' },
      }), env);
      const first = await send();
      assert.equal(first.status, 201);
      await db.query("UPDATE households SET archived_at = now() WHERE id = 'hh-ok'");
      const second = await send();
      assert.equal(second.status, 200);
      assert.equal(await count('payment_entries'), 1);
    } finally { await db.close(); }
  });

  test('assignment, allocations i reassignment: gospodarstwo spoza zakresu = nieistniejące, wpłata bez zmian', async () => {
    const { db, pay, post, count } = await setup();
    try {
      const unmatched = (await pay(null)).body.payment.id;
      const recorded = (await pay('hh-ok', { receivedOn: '2026-10-04' })).body.payment.id;
      const baseline = { assignments: await count('payment_assignments'), allocations: await count('payment_allocations'),
        reassignments: await count('payment_reassignments'), events: await count('audit_events') };
      for (const householdId of ['hh-archiwum', 'hh-bez-ucznia', 'hh-tylko-rok-2', 'hh-nie-istnieje']) {
        const expected = { status: 400, body: { error: 'invalid_reference' } };
        assert.deepEqual(await post(`/api/payments/${unmatched}/assignment`, { householdId }), expected, `assignment ${householdId}`);
        assert.deepEqual(await post(`/api/payments/${unmatched}/allocations`, { householdId, amountCents: 100 }), expected, `allocation ${householdId}`);
        assert.deepEqual(await post(`/api/payments/${recorded}/reassignment`, { householdId, reason: 'Korekta syntetyczna' }), expected, `reassignment ${householdId}`);
      }
      assert.deepEqual({ assignments: await count('payment_assignments'), allocations: await count('payment_allocations'),
        reassignments: await count('payment_reassignments'), events: await count('audit_events') }, baseline);
      assert.equal((await post(`/api/payments/${unmatched}/assignment`, { householdId: 'hh-rodzenstwo' })).status, 201);
      assert.equal((await post(`/api/payments/${recorded}/reassignment`, { householdId: 'hh-rodzenstwo', reason: 'Korekta syntetyczna' })).status, 201);
    } finally { await db.close(); }
  });
});
