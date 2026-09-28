import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../src/postgres-migrations.js';
import {
  addAgendaItem, approveMinutes, correctResolution, createMeeting, createMinutesVersion,
  createResolution, determineQuorum, findAdoptedResolution, getMeeting, handle, listMeetings,
  listMinutesForParents, listPublicMinutes, listSharedMinutes, recordAttendance,
  setMinutesVisibility, updateMeeting, updateResolution,
} from '../src/pg/meetings.js';

const directory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));

const grant = (role, extra = {}) => ({ role, classId: null, schoolYearId: 'year', expiresAt: null, ...extra });
// #150 (SR-10): zarządzanie zebraniami/protokołami/uchwałami wymaga teraz jawnie
// potwierdzonego MFA (MANAGE_ROLES = admin, board) — board i classBoard dostają
// mfaVerified: true, tak jak pozostali aktorzy tego pliku, którzy naprawdę
// zarządzają (rep, principal, treasurer są tu wyłącznie do testów odmowy).
const board = { userId: 'board', grants: [grant('board')], mfaVerified: true };
const admin = { userId: 'admin', grants: [grant('admin', { schoolYearId: null })], mfaVerified: true };
const auditor = { userId: 'auditor', grants: [grant('audit')], mfaVerified: false };
const rep = { userId: 'rep', grants: [grant('representative', { classId: 'class-a' })], mfaVerified: true };
const principal = { userId: 'principal', grants: [grant('principal')], mfaVerified: true };
const treasurer = { userId: 'treasurer', grants: [grant('treasurer')], mfaVerified: true };
const classBoard = { userId: 'class-board', grants: [grant('board', { classId: 'class-a' })], mfaVerified: true };

let keySeq = 0;
const key = () => `test-key-${++keySeq}`;

async function meetingsDb() {
  const db = new PGlite();
  for (const migration of await loadMigrations(directory)) await db.exec(migration.sql);
  await db.query(`INSERT INTO school_years VALUES
    ('year','2026/27','2026-09-01','2027-08-31'), ('other','2027/28','2027-09-01','2028-08-31')`);
  await db.query("INSERT INTO classes (id, school_year_id, name) VALUES ('class-a','year','1A'), ('class-b','year','1B')");
  await db.query("INSERT INTO households (id) VALUES ('household-1')");
  await db.query(`INSERT INTO guardians (id, household_id, first_name, last_name)
    VALUES ('guardian-1','household-1','Syntetyczny','Opiekun')`);
  const users = ['board', 'admin', 'auditor', 'rep', 'principal', 'treasurer', 'class-board', 'u1', 'u2', 'u3'];
  for (const id of users) {
    await db.query('INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)',
      [id, `${id}@example.invalid`, `Synthetic ${id}`]);
  }
  return db;
}

async function heldMeeting(db, rule = {}, extra = {}) {
  const { meeting } = await createMeeting(db, board, {
    idempotencyKey: key(), schoolYearId: 'year', kind: 'plenary', title: 'Zebranie plenarne',
    scheduledAt: '2026-10-10T17:00:00Z', location: 'Sala 1', status: 'scheduled',
    quorumMode: 'fraction', quorumNumerator: 1, quorumDenominator: 2, quorumInclusive: true,
    votingBodySize: 4, quorumRuleSource: 'Założenie testowe', ...rule, ...extra,
  });
  await updateMeeting(db, board, { meetingId: meeting.id, status: 'held' });
  return meeting;
}

async function attend(db, meetingId, reference, votingEligible, present, capacity = 'representative') {
  return recordAttendance(db, board, { meetingId, ...reference, capacity, votingEligible, present });
}

test('quorum is met or not met from eligible present attendees only', async () => {
  const db = await meetingsDb();
  try {
    const meeting = await heldMeeting(db);
    await attend(db, meeting.id, { userId: 'u1' }, true, true);
    await attend(db, meeting.id, { userId: 'u2' }, true, true);
    await attend(db, meeting.id, { userId: 'u3' }, true, false);
    await attend(db, meeting.id, { guardianId: 'guardian-1' }, false, true, 'guest');
    const met = (await determineQuorum(db, board, { idempotencyKey: key(), meetingId: meeting.id })).quorumCheck;
    assert.equal(met.presentEligible, 2);
    assert.equal(met.requiredCount, 2);
    assert.equal(met.met, true);

    await attend(db, meeting.id, { userId: 'u2' }, true, false);
    const notMet = (await determineQuorum(db, board, { idempotencyKey: key(), meetingId: meeting.id })).quorumCheck;
    assert.equal(notMet.presentEligible, 1, 'ineligible guest present is not counted');
    assert.equal(notMet.met, false);

    // "more than half" of 4 requires 3; history of earlier checks is preserved
    await updateMeeting(db, board, { meetingId: meeting.id, quorumMode: 'fraction', quorumNumerator: 1,
      quorumDenominator: 2, quorumInclusive: false, votingBodySize: 4 });
    await attend(db, meeting.id, { userId: 'u2' }, true, true);
    const strict = (await determineQuorum(db, board, { idempotencyKey: key(), meetingId: meeting.id })).quorumCheck;
    assert.equal(strict.requiredCount, 3);
    assert.equal(strict.met, false);

    await updateMeeting(db, board, { meetingId: meeting.id, quorumMode: 'minimum_count', quorumMinCount: 2 });
    const count = (await determineQuorum(db, board, { idempotencyKey: key(), meetingId: meeting.id })).quorumCheck;
    assert.equal(count.requiredCount, 2);
    assert.equal(count.met, true);
    const { quorumChecks } = await getMeeting(db, auditor, { meetingId: meeting.id });
    assert.deepEqual(quorumChecks.map(check => check.met), [true, false, false, true]);
    await assert.rejects(db.query('UPDATE meeting_quorum_checks SET met = true'), /cannot_be_changed/);
  } finally { await db.close(); }
});

// #211: puste pola macierzy AGENTS.md dla zebrań — dwoje opiekunów jednego
// dziecka z prawem głosu, rodzeństwo (nie mnoży osób) i ta sama osoba policzona
// dwa razy (user_id i guardian_id).
test('quorum: two guardians of one child both vote; siblings do not inflate the count', async () => {
  const db = await meetingsDb();
  try {
    await db.query(`INSERT INTO guardians (id, household_id, first_name, last_name)
      VALUES ('guardian-2','household-1','Drugi','Opiekun')`);
    // Rodzeństwo w tym samym gospodarstwie: dwóch uczniów, ci sami opiekunowie —
    // liczba obecnych osób zależy od liczby opiekunów, nie od liczby dzieci.
    await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ('student-1','household-1','Uczeń','Jeden'), ('student-2','household-1','Uczeń','Dwa')");
    // #205: capacity='guardian' wymaga aktywnej relacji z uczniem zapisanym
    // w roku zebrania — oboje opiekunów, oboje dzieci.
    await db.query("INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('e-student-1','student-1','class-a','year'), ('e-student-2','student-2','class-a','year')");
    await db.query(`INSERT INTO student_guardians (student_id, guardian_id, contact_allowed) VALUES
      ('student-1','guardian-1',true), ('student-1','guardian-2',true),
      ('student-2','guardian-1',true), ('student-2','guardian-2',true)`);
    const meeting = await heldMeeting(db, { votingBodySize: 2, quorumMode: 'minimum_count', quorumMinCount: 2 });
    // Dwoje opiekunów jednego (i drugiego) dziecka, oboje z prawem głosu.
    // Brak decyzji zarządu co do regulaminu głosowania (docs/DECISIONS.md nie
    // ma dziś takiego wpisu — najbliższe D-11/D-21 dotyczą czego innego);
    // test dokumentuje dzisiejsze zachowanie kodu: każdy zapisany opiekun
    // liczy się osobno, kod nie ogranicza liczby głosów na jedno dziecko.
    await attend(db, meeting.id, { guardianId: 'guardian-1' }, true, true, 'guardian');
    await attend(db, meeting.id, { guardianId: 'guardian-2' }, true, true, 'guardian');
    const check = (await determineQuorum(db, board, { idempotencyKey: key(), meetingId: meeting.id })).quorumCheck;
    assert.equal(check.presentEligible, 2, 'dwoje opiekunów jednego dziecka liczy się dziś osobno — brak decyzji zarządu, patrz PR');
    assert.equal(check.met, true);
  } finally { await db.close(); }
});

// Znana luka (#211, #214): meeting_attendees ma osobną unikalność dla user_id
// i dla guardian_id (0009_meetings.sql:80-82), a konto nie ma powiązania z
// opiekunem. Ta sama fizyczna osoba zapisana raz jako user_id i raz jako
// guardian_id jest dziś liczona dwa razy do quorum — trigger liczy WIERSZE
// (`count(*) FROM meeting_attendees ... present AND voting_eligible`), nie
// odrębne osoby. Naprawa wymaga powiązania konta z opiekunem (nowa kolumna =
// migracja), poza zakresem tej poprawki („Bez migracji”) — opisane w PR.
// Test dokumentuje dzisiejsze zachowanie, żeby zmiana bez zamierzenia nie
// przeszła bez zauważenia.
test('known gap: the same person recorded as both user_id and guardian_id is counted twice (#211, needs a migration — see PR)', async () => {
  const db = await meetingsDb();
  try {
    // #205: capacity='guardian' wymaga aktywnej relacji z uczniem zapisanym
    // w roku zebrania.
    await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ('student-known-gap','household-1','Uczeń','Testowy')");
    await db.query("INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('e-student-known-gap','student-known-gap','class-a','year')");
    await db.query("INSERT INTO student_guardians (student_id, guardian_id, contact_allowed) VALUES ('student-known-gap','guardian-1',true)");
    const meeting = await heldMeeting(db, { votingBodySize: 2, quorumMode: 'minimum_count', quorumMinCount: 2 });
    // 'board' jest zarówno kontem (user_id), jak i — z założenia w tym teście —
    // tą samą fizyczną osobą co 'guardian-1' (np. członek zarządu i opiekun
    // ucznia jednocześnie). Nic w schemacie tego nie łączy ani nie zabrania.
    await attend(db, meeting.id, { userId: 'board' }, true, true, 'board_member');
    await attend(db, meeting.id, { guardianId: 'guardian-1' }, true, true, 'guardian');
    const check = (await determineQuorum(db, board, { idempotencyKey: key(), meetingId: meeting.id })).quorumCheck;
    // Dzisiejsze (błędne z punktu widzenia jednej osoby = jeden głos) zachowanie: 2, nie 1.
    assert.equal(check.presentEligible, 2, 'znana luka: brak powiązania konta z opiekunem pozwala policzyć tę samą osobę dwa razy');
  } finally { await db.close(); }
});

test('quorum requires a configured rule and a consistent voting body', async () => {
  const db = await meetingsDb();
  try {
    const meeting = await heldMeeting(db, { quorumMode: 'not_configured', quorumNumerator: undefined,
      quorumDenominator: undefined, quorumInclusive: undefined, votingBodySize: undefined });
    await assert.rejects(determineQuorum(db, board, { idempotencyKey: key(), meetingId: meeting.id }),
      { code: 'quorum_rule_not_configured' });
    await updateMeeting(db, board, { meetingId: meeting.id, quorumMode: 'minimum_count', quorumMinCount: 1,
      votingBodySize: 1 });
    await attend(db, meeting.id, { userId: 'u1' }, true, true);
    await attend(db, meeting.id, { userId: 'u2' }, true, true);
    await assert.rejects(determineQuorum(db, board, { idempotencyKey: key(), meetingId: meeting.id }),
      { code: 'quorum_attendance_exceeds_voting_body' });
    await assert.rejects(updateMeeting(db, board, { meetingId: meeting.id, quorumMode: 'fraction',
      quorumNumerator: 3, quorumDenominator: 2, quorumInclusive: true, votingBodySize: 4 }),
    { code: 'invalid_quorum_rule' });
    await assert.rejects(db.query("UPDATE meetings SET quorum_mode = 'fraction' WHERE id = $1", [meeting.id]));
    await assert.rejects(attend(db, meeting.id, { userId: 'u3' }, undefined, true), { code: 'invalid_request' });
  } finally { await db.close(); }
});

test('resolution number is unique per school year; corrections keep the number', async () => {
  const db = await meetingsDb();
  try {
    const meeting = await heldMeeting(db);
    await attend(db, meeting.id, { userId: 'u1' }, true, true);
    await attend(db, meeting.id, { userId: 'u2' }, true, true);
    const { quorumCheck } = await determineQuorum(db, board, { idempotencyKey: key(), meetingId: meeting.id });
    const adopted = (await createResolution(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, number: 'UCH/2026/1', title: 'Zakup sprzętu',
      body: 'Treść syntetyczna.', status: 'adopted', votesFor: 2, votesAgainst: 0, votesAbstain: 0,
      quorumCheckId: quorumCheck.id,
    })).resolution;
    assert.equal(adopted.status, 'adopted');
    assert.ok(adopted.decidedAt);
    await assert.rejects(createResolution(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, number: 'UCH/2026/1', title: 'Inny projekt', body: 'Treść.',
    }), { code: 'resolution_number_taken' });

    const otherYear = (await createMeeting(db, admin, {
      idempotencyKey: key(), schoolYearId: 'other', kind: 'board', title: 'Zebranie zarządu',
      scheduledAt: '2027-10-01T17:00:00+02:00',
    })).meeting;
    const sameNumber = await createResolution(db, admin, {
      idempotencyKey: key(), meetingId: otherYear.id, number: 'UCH/2026/1', title: 'Projekt', body: 'Treść.',
    });
    assert.equal(sameNumber.resolution.schoolYearId, 'other');

    const corrected = (await correctResolution(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, resolutionId: adopted.id,
      reason: 'Błąd w liczbie głosów', votesFor: 1, votesAbstain: 1,
    })).resolution;
    assert.equal(corrected.number, 'UCH/2026/1');
    assert.equal(corrected.revision, 2);
    await assert.rejects(correctResolution(db, board, {
      idempotencyKey: key(), resolutionId: adopted.id, reason: 'Druga gałąź',
    }), { code: 'concurrent_version' });

    const found = await findAdoptedResolution(db, treasurer, { schoolYearId: 'year', number: 'UCH/2026/1' });
    assert.equal(found.resolution.id, corrected.id);
    await assert.rejects(findAdoptedResolution(db, rep, { schoolYearId: 'year', number: 'UCH/2026/1' }),
      { code: 'forbidden' });

    // The ledger reference can be reconciled with the adopted resolution.
    await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by)
      VALUES ('expense','year','expense','Wydatki','board')`);
    await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id,
      description, occurred_on, method, resolution_reference, created_by, idempotency_key)
      VALUES ('large','year','expense',350000,'expense','Synthetic large expense','2026-10-20','bank',
      ' UCH/2026/1 ','board','ledger-large-1')`);
    const { rows } = await db.query('SELECT resolution_id FROM ledger_resolution_links');
    assert.deepEqual(rows, [{ resolution_id: corrected.id }]);
  } finally { await db.close(); }
});

test('final resolutions need a vote record and are immutable', async () => {
  const db = await meetingsDb();
  try {
    const meeting = await heldMeeting(db);
    await attend(db, meeting.id, { userId: 'u1' }, true, true);
    const { quorumCheck } = await determineQuorum(db, board, { idempotencyKey: key(), meetingId: meeting.id });
    const draft = (await createResolution(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Projekt uchwały', body: 'Treść.',
    })).resolution;
    await assert.rejects(updateResolution(db, board, { resolutionId: draft.id, status: 'adopted', number: 'U-1' }),
      { code: 'vote_record_required' });
    await assert.rejects(updateResolution(db, board, { resolutionId: draft.id, status: 'adopted', number: 'U-1',
      votesFor: 2, votesAgainst: 0, votesAbstain: 0, quorumCheckId: quorumCheck.id }),
    { code: 'resolution_votes_exceed_present_voters' });
    const rejected = (await updateResolution(db, board, { resolutionId: draft.id, status: 'rejected',
      votesFor: 0, votesAgainst: 1, votesAbstain: 0, quorumCheckId: quorumCheck.id })).resolution;
    assert.equal(rejected.status, 'rejected');
    await assert.rejects(updateResolution(db, board, { resolutionId: draft.id, title: 'Zmiana' }),
      { code: 'resolution_final_immutable' });
    await assert.rejects(db.query("UPDATE resolutions SET votes_for = 5 WHERE id = $1", [draft.id]),
      /resolution_final_immutable/);
    await assert.rejects(db.query('DELETE FROM resolutions WHERE id = $1', [draft.id]), /cannot_be_deleted/);
  } finally { await db.close(); }
});

test('approved minutes are immutable, lock the meeting and are corrected by new versions', async () => {
  const db = await meetingsDb();
  try {
    const meeting = await heldMeeting(db);
    await addAgendaItem(db, board, { idempotencyKey: key(), meetingId: meeting.id, title: 'Otwarcie zebrania' });
    await attend(db, meeting.id, { userId: 'u1' }, true, true);
    const v1 = (await createMinutesVersion(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, body: 'Protokół syntetyczny, wersja pierwsza.',
    })).minutes;
    assert.equal(v1.version, 1);
    await assert.rejects(db.query("UPDATE meeting_minutes SET body = 'Zmieniony tekst draftu' WHERE id = $1", [v1.id]),
      /minutes_version_immutable/);
    const approved = await approveMinutes(db, board, { meetingId: meeting.id, minutesId: v1.id });
    assert.equal(approved.minutes.status, 'approved');
    assert.equal((await approveMinutes(db, board, { minutesId: v1.id })).replayed, true);

    await assert.rejects(db.query("UPDATE meeting_minutes SET body = 'Zmieniony tekst' WHERE id = $1", [v1.id]),
      /minutes_approved_immutable/);
    await assert.rejects(db.query('DELETE FROM meeting_minutes WHERE id = $1', [v1.id]), /cannot_be_deleted/);
    await assert.rejects(attend(db, meeting.id, { userId: 'u2' }, true, true), { code: 'meeting_locked' });
    await assert.rejects(addAgendaItem(db, board, { idempotencyKey: key(), meetingId: meeting.id, title: 'Nowy punkt' }),
      { code: 'meeting_locked' });
    await assert.rejects(updateMeeting(db, board, { meetingId: meeting.id, title: 'Nowy tytuł zebrania' }),
      { code: 'meeting_locked' });

    const v2 = (await createMinutesVersion(db, board, { idempotencyKey: key(), meetingId: meeting.id,
      body: 'Protokół syntetyczny, poprawiony.', changeNote: 'Poprawka literówki' })).minutes;
    const v3 = (await createMinutesVersion(db, board, { idempotencyKey: key(), meetingId: meeting.id,
      body: 'Protokół syntetyczny, poprawiony drugi raz.' })).minutes;
    assert.deepEqual([v2.version, v3.version, v2.supersedesId, v3.supersedesId], [2, 3, v1.id, v2.id]);
    await assert.rejects(approveMinutes(db, board, { minutesId: v2.id }), { code: 'minutes_not_latest_version' });
    await approveMinutes(db, board, { minutesId: v3.id });
    await updateMeeting(db, board, { meetingId: meeting.id, status: 'archived' });
    await assert.rejects(createMinutesVersion(db, board, { idempotencyKey: key(), meetingId: meeting.id,
      body: 'Po archiwizacji nie wolno.' }), { code: 'minutes_require_held_meeting' });
    const { minutes } = await getMeeting(db, board, { meetingId: meeting.id });
    assert.deepEqual(minutes.map(item => item.status), ['approved', 'draft', 'approved']);
  } finally { await db.close(); }
});

test('minutes approval is refused while draft resolutions are open (#81)', async () => {
  const db = await meetingsDb();
  try {
    const meeting = await heldMeeting(db);
    await attend(db, meeting.id, { userId: 'u1' }, true, true);
    const { quorumCheck } = await determineQuorum(db, board, { idempotencyKey: key(), meetingId: meeting.id });
    const first = (await createResolution(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Projekt pierwszy', body: 'Treść syntetyczna.',
    })).resolution;
    const second = (await createResolution(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Projekt drugi', body: 'Treść syntetyczna.',
    })).resolution;
    const { minutes } = await createMinutesVersion(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, body: 'Protokół syntetyczny z otwartymi projektami.',
    });
    const approvals = () => db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'meeting.minutes.approved'");

    // Double click: both requests are refused, nothing changes.
    const clicks = await Promise.allSettled([
      approveMinutes(db, board, { meetingId: meeting.id, minutesId: minutes.id }),
      approveMinutes(db, board, { meetingId: meeting.id, minutesId: minutes.id }),
    ]);
    for (const click of clicks) {
      assert.equal(click.status, 'rejected');
      assert.equal(click.reason.code, 'minutes_open_resolutions');
      assert.equal(click.reason.status, 409);
    }
    assert.equal((await approvals()).rows[0].n, 0);
    assert.equal((await db.query('SELECT status FROM meeting_minutes WHERE id = $1', [minutes.id])).rows[0].status, 'draft');
    // The database refuses it too, not only the API.
    await assert.rejects(db.query(
      "UPDATE meeting_minutes SET status = 'approved', approved_by = 'board', approved_at = now() WHERE id = $1",
      [minutes.id]), /minutes_open_resolutions/);

    // Decide one, withdraw the other (a status change, the row stays in the register).
    await updateResolution(db, board, { resolutionId: first.id, status: 'rejected',
      votesFor: 0, votesAgainst: 1, votesAbstain: 0, quorumCheckId: quorumCheck.id });
    await assert.rejects(approveMinutes(db, board, { minutesId: minutes.id }), { code: 'minutes_open_resolutions' });
    await assert.rejects(updateResolution(db, rep, { resolutionId: second.id, status: 'withdrawn' }), { code: 'forbidden' });
    const withdrawn = (await updateResolution(db, board, { resolutionId: second.id, status: 'withdrawn' })).resolution;
    assert.equal(withdrawn.status, 'withdrawn');
    const { rows: history } = await db.query(
      "SELECT metadata_json FROM audit_events WHERE entity_id = $1 AND action = 'resolution.updated'", [second.id]);
    assert.equal(history.length, 1);
    assert.equal(history[0].metadata_json.toStatus, 'withdrawn');

    // Roles outside the board cannot approve.
    for (const actor of [rep, auditor, principal, treasurer]) {
      await assert.rejects(approveMinutes(db, actor, { minutesId: minutes.id }), { code: 'forbidden' });
    }
    const approved = await approveMinutes(db, board, { minutesId: minutes.id });
    assert.equal(approved.minutes.status, 'approved');
    assert.equal((await approveMinutes(db, board, { minutesId: minutes.id })).replayed, true);
    assert.equal((await approvals()).rows[0].n, 1);
    const { resolutions } = await getMeeting(db, board, { meetingId: meeting.id });
    assert.deepEqual(resolutions.map(item => item.status).sort(), ['rejected', 'withdrawn']);
  } finally { await db.close(); }
});

test('a resolution needs a quorum check made after the last attendance change (#81)', async () => {
  const db = await meetingsDb();
  try {
    const meeting = await heldMeeting(db);
    await attend(db, meeting.id, { userId: 'u1' }, true, true);
    await attend(db, meeting.id, { userId: 'u2' }, true, true);
    await attend(db, meeting.id, { userId: 'u3' }, true, true);
    const early = (await determineQuorum(db, board, { idempotencyKey: key(), meetingId: meeting.id })).quorumCheck;
    assert.equal(early.presentEligible, 3);
    // An earlier decision on the then-current check.
    const decided = (await createResolution(db, board, { idempotencyKey: key(), meetingId: meeting.id,
      title: 'Uchwała wcześniejsza', body: 'Treść.', status: 'adopted', number: 'U-81/1',
      votesFor: 3, votesAgainst: 0, votesAbstain: 0, quorumCheckId: early.id })).resolution;

    // Two people leave; their attendance is corrected.
    await attend(db, meeting.id, { userId: 'u2' }, true, false);
    await attend(db, meeting.id, { userId: 'u3' }, true, false);
    const draft = (await createResolution(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Projekt późniejszy', body: 'Treść.',
    })).resolution;
    await assert.rejects(updateResolution(db, board, { resolutionId: draft.id, status: 'adopted', number: 'U-81/2',
      votesFor: 3, votesAgainst: 0, votesAbstain: 0, quorumCheckId: early.id }),
    { code: 'resolution_quorum_check_stale', status: 409 });
    await assert.rejects(createResolution(db, board, { idempotencyKey: key(), meetingId: meeting.id,
      title: 'Nowa uchwała', body: 'Treść.', status: 'rejected',
      votesFor: 0, votesAgainst: 1, votesAbstain: 0, quorumCheckId: early.id }),
    { code: 'resolution_quorum_check_stale' });
    await assert.rejects(db.query(
      `UPDATE resolutions SET status = 'rejected', votes_for = 0, votes_against = 1, votes_abstain = 0,
         quorum_check_id = $2 WHERE id = $1`, [draft.id, early.id]), /resolution_quorum_check_stale/);
    // A draft may still point at any check; only the decision needs a current one.
    await updateResolution(db, board, { resolutionId: draft.id, title: 'Projekt późniejszy, poprawiony' });

    // A correction of the earlier decision keeps its original basis.
    const corrected = (await correctResolution(db, board, { idempotencyKey: key(), resolutionId: decided.id,
      reason: 'Pomyłka w zapisie głosów', votesFor: 2, votesAbstain: 1 })).resolution;
    assert.equal(corrected.quorumCheckId, early.id);

    const late = (await determineQuorum(db, board, { idempotencyKey: key(), meetingId: meeting.id })).quorumCheck;
    assert.equal(late.presentEligible, 1);
    await assert.rejects(updateResolution(db, board, { resolutionId: draft.id, status: 'adopted', number: 'U-81/2',
      votesFor: 3, votesAgainst: 0, votesAbstain: 0, quorumCheckId: late.id }),
    { code: 'resolution_votes_exceed_present_voters' });
    const adopted = (await updateResolution(db, board, { resolutionId: draft.id, status: 'adopted', number: 'U-81/2',
      votesFor: 1, votesAgainst: 0, votesAbstain: 0, quorumCheckId: late.id })).resolution;
    assert.equal(adopted.status, 'adopted');

    // Re-recording identical attendance is also a change of the list.
    await attend(db, meeting.id, { userId: 'u1' }, true, true);
    await assert.rejects(createResolution(db, board, { idempotencyKey: key(), meetingId: meeting.id,
      title: 'Kolejna uchwała', body: 'Treść.', status: 'rejected',
      votesFor: 0, votesAgainst: 1, votesAbstain: 0, quorumCheckId: late.id }),
    { code: 'resolution_quorum_check_stale' });
    const { quorumChecks } = await getMeeting(db, board, { meetingId: meeting.id });
    assert.deepEqual(quorumChecks.map(check => check.current), [false, false]);
  } finally { await db.close(); }
});

test('parents and representatives see only approved minutes explicitly shared with them', async () => {
  const db = await meetingsDb();
  try {
    const plenary = await heldMeeting(db);
    const classB = await heldMeeting(db, {}, { kind: 'class', classId: 'class-b', title: 'Zebranie klasy 1B' });
    const draft = (await createMinutesVersion(db, board, { idempotencyKey: key(), meetingId: plenary.id,
      body: 'Projekt protokołu, niezatwierdzony.' })).minutes;
    await assert.rejects(setMinutesVisibility(db, board, { idempotencyKey: key(), minutesId: draft.id,
      visibility: 'parents' }), { code: 'minutes_not_approved' });
    assert.deepEqual((await listMinutesForParents(db, { schoolYearId: 'year', classIds: ['class-a'] })).minutes, []);
    assert.deepEqual((await listSharedMinutes(db, rep, { schoolYearId: 'year' })).minutes, []);

    await approveMinutes(db, board, { minutesId: draft.id });
    assert.deepEqual((await listMinutesForParents(db, { schoolYearId: 'year', classIds: ['class-a'] })).minutes, [],
      'approved but internal minutes are not shared');
    await setMinutesVisibility(db, board, { idempotencyKey: key(), minutesId: draft.id, visibility: 'parents' });
    const classMinutes = (await createMinutesVersion(db, board, { idempotencyKey: key(), meetingId: classB.id,
      body: 'Protokół zebrania klasy 1B.' })).minutes;
    await approveMinutes(db, board, { minutesId: classMinutes.id });
    await setMinutesVisibility(db, board, { idempotencyKey: key(), minutesId: classMinutes.id, visibility: 'parents' });

    const parentsA = (await listMinutesForParents(db, { schoolYearId: 'year', classIds: ['class-a'] })).minutes;
    assert.deepEqual(parentsA.map(item => item.meetingId), [plenary.id]);
    const parentsB = (await listMinutesForParents(db, { schoolYearId: 'year', classIds: ['class-b'] })).minutes;
    assert.equal(parentsB.length, 2);
    assert.deepEqual((await listSharedMinutes(db, rep, { schoolYearId: 'year' })).minutes.map(item => item.meetingId),
      [plenary.id]);
    assert.equal((await listSharedMinutes(db, auditor, { schoolYearId: 'year' })).minutes.length, 2);
    assert.deepEqual((await listPublicMinutes(db, { schoolYearId: 'year' })).minutes, []);

    // A newer approved correction is internal until shared again; the draft never leaks.
    const v2 = (await createMinutesVersion(db, board, { idempotencyKey: key(), meetingId: plenary.id,
      body: 'Poprawiony protokół, jeszcze projekt.' })).minutes;
    const stillV1 = (await listMinutesForParents(db, { schoolYearId: 'year', classIds: [] })).minutes;
    assert.deepEqual(stillV1.map(item => [item.minutesId, item.version]), [[draft.id, 1]]);
    await approveMinutes(db, board, { minutesId: v2.id });
    assert.deepEqual((await listMinutesForParents(db, { schoolYearId: 'year', classIds: [] })).minutes, []);
    await setMinutesVisibility(db, board, { idempotencyKey: key(), minutesId: v2.id, visibility: 'public' });
    assert.deepEqual((await listPublicMinutes(db, { schoolYearId: 'year' })).minutes.map(item => item.version), [2]);
    await assert.rejects(db.query('DELETE FROM meeting_minutes_publications'), /cannot_be_changed/);
    await assert.rejects(listSharedMinutes(db, principal, { schoolYearId: 'year' }), { code: 'forbidden' });
  } finally { await db.close(); }
});

test('representative, principal and audit cannot manage meetings', async () => {
  const db = await meetingsDb();
  try {
    const base = { schoolYearId: 'year', title: 'Zebranie', scheduledAt: '2026-10-10T17:00:00Z' };
    await assert.rejects(createMeeting(db, rep, { ...base, idempotencyKey: key(), kind: 'class', classId: 'class-a' }),
      { code: 'forbidden' });
    await assert.rejects(createMeeting(db, rep, { ...base, idempotencyKey: key(), kind: 'plenary' }), { code: 'forbidden' });
    await assert.rejects(createMeeting(db, principal, { ...base, idempotencyKey: key(), kind: 'plenary' }),
      { code: 'forbidden' });
    await assert.rejects(createMeeting(db, auditor, { ...base, idempotencyKey: key(), kind: 'plenary' }),
      { code: 'forbidden' });
    await assert.rejects(createMeeting(db, { userId: 'board', grants: [grant('board', { schoolYearId: 'other' })] },
      { ...base, idempotencyKey: key(), kind: 'plenary' }), { code: 'forbidden' });
    await assert.rejects(createMeeting(db, null, { ...base, idempotencyKey: key(), kind: 'plenary' }),
      { code: 'unauthenticated' });

    const meeting = await heldMeeting(db);
    // SR-07: odczyt niedostępnego zebrania wygląda jak brak zebrania.
    await assert.rejects(getMeeting(db, rep, { meetingId: meeting.id }), { code: 'meeting_not_found' });
    await assert.rejects(getMeeting(db, rep, { meetingId: 'brak-zebrania' }), { code: 'meeting_not_found' });
    await assert.rejects(listMeetings(db, rep, { schoolYearId: 'year' }), { code: 'forbidden' });
    await assert.rejects(recordAttendance(db, rep, { meetingId: meeting.id, userId: 'rep', capacity: 'representative',
      votingEligible: true, present: true }), { code: 'forbidden' });
    await assert.rejects(updateMeeting(db, auditor, { meetingId: meeting.id, title: 'Zmiana' }), { code: 'forbidden' });
    assert.equal((await getMeeting(db, auditor, { meetingId: meeting.id })).meeting.id, meeting.id);

    // A board grant scoped to one class manages only that class.
    await assert.rejects(createMeeting(db, classBoard, { ...base, idempotencyKey: key(), kind: 'plenary' }),
      { code: 'forbidden' });
    await assert.rejects(createMeeting(db, classBoard, { ...base, idempotencyKey: key(), kind: 'class',
      classId: 'class-b' }), { code: 'forbidden' });
    const own = await createMeeting(db, classBoard, { ...base, idempotencyKey: key(), kind: 'class', classId: 'class-a' });
    assert.equal(own.meeting.classId, 'class-a');
    assert.deepEqual((await listMeetings(db, classBoard, { schoolYearId: 'year' })).meetings.map(m => m.id), [own.meeting.id]);
  } finally { await db.close(); }
});

test('double submit with the same Idempotency-Key creates one record', async () => {
  const db = await meetingsDb();
  try {
    const input = { idempotencyKey: 'meeting-create-1', schoolYearId: 'year', kind: 'plenary',
      title: 'Zebranie plenarne', scheduledAt: '2026-10-10T17:00:00Z' };
    const [first, second] = await Promise.all([createMeeting(db, board, input), createMeeting(db, board, input)]);
    assert.equal(first.meeting.id, second.meeting.id);
    assert.deepEqual([first.replayed, second.replayed].sort(), [false, true]);
    const third = await createMeeting(db, board, input);
    assert.equal(third.replayed, true);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM meetings');
    assert.equal(rows[0].n, 1);
    const audits = await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'meeting.created'");
    assert.equal(audits.rows[0].n, 1);
    await assert.rejects(createMeeting(db, board, { ...input, title: 'Inny tytuł zebrania' }),
      { code: 'idempotency_conflict' });
    await assert.rejects(createMeeting(db, admin, input), { code: 'idempotency_conflict' });
    await assert.rejects(createMeeting(db, board, { ...input, idempotencyKey: 'short' }),
      { code: 'invalid_idempotency_key' });

    await updateMeeting(db, board, { meetingId: first.meeting.id, status: 'scheduled' });
    await updateMeeting(db, board, { meetingId: first.meeting.id, status: 'held' });
    const minutesInput = { idempotencyKey: 'minutes-create-1', meetingId: first.meeting.id,
      body: 'Protokół syntetyczny do testu.' };
    const a = await createMinutesVersion(db, board, minutesInput);
    const b = await createMinutesVersion(db, board, minutesInput);
    assert.equal(a.minutes.id, b.minutes.id);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM meeting_minutes')).rows[0].n, 1);
  } finally { await db.close(); }
});

test('audit events carry identifiers only, without minutes or resolution text', async () => {
  const db = await meetingsDb();
  try {
    const meeting = await heldMeeting(db);
    await attend(db, meeting.id, { guardianId: 'guardian-1' }, false, true, 'guest');
    await createMinutesVersion(db, board, { idempotencyKey: key(), meetingId: meeting.id,
      body: 'Tajny tekst protokołu syntetycznego.' });
    const { rows } = await db.query('SELECT action, metadata_json FROM audit_events ORDER BY occurred_at, action');
    assert.ok(rows.length >= 4);
    const serialized = JSON.stringify(rows);
    assert.ok(!serialized.includes('Tajny'));
    assert.ok(!serialized.includes('guardian-1'));
    assert.ok(!serialized.includes('Syntetyczny'));
  } finally { await db.close(); }
});

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function httpEnv(db, actor) {
  return {
    db,
    async loadAuthorizationContext() {
      if (!actor) return null;
      return { session: { user: { id: actor.userId }, mfaVerified: actor.mfaVerified }, grants: actor.grants };
    },
  };
}

function post(path, body, headers = {}) {
  return new Request(`https://rd.example.invalid${path}`, {
    method: 'POST',
    headers: { Origin: 'https://rd.example.invalid', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('HTTP handler enforces origin, session, idempotency and roles', async () => {
  const db = await meetingsDb();
  try {
    const body = { schoolYearId: 'year', kind: 'plenary', title: 'Zebranie plenarne',
      scheduledAt: '2026-10-10T17:00:00Z' };
    const path = '/api/meetings';
    const call = (request, actor = board) => handle(request, httpEnv(db, actor), new URL(request.url), json);

    assert.equal(await handle(new Request('https://rd.example.invalid/api/payments'), httpEnv(db, board),
      new URL('https://rd.example.invalid/api/payments'), json), null);
    let response = await call(post(path, body, { Origin: 'https://evil.example.invalid', 'Idempotency-Key': key() }));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'invalid_origin');
    response = await call(post(path, body));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_idempotency_key');
    response = await call(post(path, body, { 'Idempotency-Key': 'http-create-1' }), null);
    assert.equal(response.status, 401);
    response = await call(post(path, body, { 'Idempotency-Key': 'http-create-1' }), rep);
    assert.equal(response.status, 403);

    response = await call(post(path, body, { 'Idempotency-Key': 'http-create-1' }));
    assert.equal(response.status, 201);
    const created = await response.json();
    response = await call(post(path, body, { 'Idempotency-Key': 'http-create-1' }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Idempotency-Replayed'), 'true');
    assert.equal((await response.json()).meeting.id, created.meeting.id);

    response = await call(new Request(`https://rd.example.invalid${path}/${created.meeting.id}`));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).meeting.title, 'Zebranie plenarne');
    response = await call(new Request(`https://rd.example.invalid${path}?schoolYearId=year`), auditor);
    assert.equal((await response.json()).meetings.length, 1);
    response = await call(new Request(`https://rd.example.invalid${path}/public-minutes?schoolYearId=year`), null);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).minutes, []);
    response = await call(new Request(`https://rd.example.invalid${path}/${created.meeting.id}`, {
      method: 'PATCH', headers: { Origin: 'https://rd.example.invalid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'held' }),
    }));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'meeting_status_transition_invalid');
    response = await call(new Request(`https://rd.example.invalid${path}/${created.meeting.id}`, { method: 'DELETE',
      headers: { Origin: 'https://rd.example.invalid' } }));
    assert.equal(response.status, 405);
  } finally { await db.close(); }
});

test('PATCH keeps unspecified quorum fields and a configured rule requires its source', async () => {
  const db = await meetingsDb();
  try {
    const base = { schoolYearId: 'year', kind: 'plenary', title: 'Zebranie', scheduledAt: '2026-10-10T17:00:00Z' };
    await assert.rejects(createMeeting(db, board, { ...base, idempotencyKey: key(), quorumMode: 'minimum_count', quorumMinCount: 3 }),
      { code: 'quorum_rule_source_required', status: 400 });
    await assert.rejects(createMeeting(db, board, { ...base, idempotencyKey: key(), quorumMode: 'fraction', quorumNumerator: 1,
      quorumDenominator: 2, quorumInclusive: true, votingBodySize: 10, quorumRuleSource: '  ' }), { code: 'quorum_rule_source_required' });
    const { meeting } = await createMeeting(db, board, {
      ...base, idempotencyKey: key(), quorumMode: 'fraction', quorumNumerator: 1, quorumDenominator: 2,
      quorumInclusive: true, votingBodySize: 10, quorumRuleSource: 'Założenie testowe § 1',
    });
    // Only the voting body size changes; mode, fraction and source stay.
    const resized = (await updateMeeting(db, board, { meetingId: meeting.id, votingBodySize: 12 })).meeting.quorumRule;
    assert.deepEqual(resized, { mode: 'fraction', numerator: 1, denominator: 2, inclusive: true, minCount: null,
      votingBodySize: 12, source: 'Założenie testowe § 1' });
    // Switching mode keeps the source and body size, drops the fraction.
    const counted = (await updateMeeting(db, board, { meetingId: meeting.id, quorumMode: 'minimum_count', quorumMinCount: 5 }))
      .meeting.quorumRule;
    assert.deepEqual(counted, { mode: 'minimum_count', numerator: null, denominator: null, inclusive: null, minCount: 5,
      votingBodySize: 12, source: 'Założenie testowe § 1' });
    // Explicit null clears the source — refused while a rule is configured.
    await assert.rejects(updateMeeting(db, board, { meetingId: meeting.id, quorumRuleSource: null }),
      { code: 'quorum_rule_source_required' });
    // A title-only PATCH does not touch the rule.
    const renamed = (await updateMeeting(db, board, { meetingId: meeting.id, title: 'Nowy tytuł' })).meeting;
    assert.deepEqual(renamed.quorumRule, counted);
    // Not configured needs no source.
    const off = (await updateMeeting(db, board, { meetingId: meeting.id, quorumMode: 'not_configured', quorumRuleSource: null }))
      .meeting.quorumRule;
    assert.equal(off.mode, 'not_configured');
    assert.equal(off.source, null);
  } finally { await db.close(); }
});
