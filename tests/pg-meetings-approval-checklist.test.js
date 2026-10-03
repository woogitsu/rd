// #81: lista kontrolna przed zatwierdzeniem protokołu (GET /api/meetings/:id/approval-checklist),
// liczba otwartych projektów w 409 i hash idempotencji ustalenia quorum. Dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approveMinutes, createMeeting, createMinutesVersion, createResolution, determineQuorum,
  getApprovalChecklist, handle, recordAttendance,
} from '../src/pg/meetings.js';
import { updateMeeting, updateResolution } from './helpers/with-revision.js';
import { createPgliteTestDb, seedRoleGrant } from './helpers/pg.js';

const grant = (role, extra = {}) => ({ role, classId: null, schoolYearId: 'year', expiresAt: null, ...extra });
const board = { userId: 'board', grants: [grant('board')], mfaVerified: true };
const admin = { userId: 'admin', grants: [grant('admin', { schoolYearId: null })], mfaVerified: true };
const auditor = { userId: 'auditor', grants: [grant('audit')], mfaVerified: false };
const rep = { userId: 'rep', grants: [grant('representative', { classId: 'class-a' })], mfaVerified: true };
const treasurer = { userId: 'treasurer', grants: [grant('treasurer')], mfaVerified: true };
const boardA = { userId: 'board-a', grants: [grant('board', { classId: 'class-a' })], mfaVerified: true };

let keySeq = 0;
const key = () => `checklist-key-${++keySeq}`;

async function meetingsDb() {
  const db = await createPgliteTestDb();
  await db.query("INSERT INTO school_years VALUES ('year','2026/27','2026-09-01','2027-08-31')");
  await db.query("INSERT INTO classes (id, school_year_id, name) VALUES ('class-a','year','1A'), ('class-b','year','1B')");
  for (const id of ['board', 'admin', 'auditor', 'rep', 'treasurer', 'board-a', 'u1', 'u2', 'u3']) {
    await db.query('INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)',
      [id, `${id}@example.invalid`, `Synthetic ${id}`]);
  }
  // #205: osoba na liście obecności musi mieć aktywny przydział w roku zebrania (0150).
  for (const id of ['u1', 'u2', 'u3']) await seedRoleGrant(db, { userId: id });
  return db;
}

async function meeting(db, extra = {}, held = true) {
  const { meeting: created } = await createMeeting(db, board, {
    idempotencyKey: key(), schoolYearId: 'year', kind: 'plenary', title: 'Zebranie syntetyczne',
    scheduledAt: '2026-10-10T17:00:00Z', location: 'Sala 1', status: 'scheduled',
    quorumMode: 'fraction', quorumNumerator: 1, quorumDenominator: 2, quorumInclusive: true,
    votingBodySize: 4, quorumRuleSource: 'Założenie testowe', ...extra,
  });
  if (held) await updateMeeting(db, board, { meetingId: created.id, status: 'held' });
  return created;
}

const attend = (db, meetingId, userId, present) => recordAttendance(db, board,
  { meetingId, userId, capacity: 'representative', votingEligible: true, present });
const codes = (checklist) => checklist.items.map((item) => item.code);
const auditCount = async (db) => (await db.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n;

test('lista kontrolna: otwarte projekty blokują, brak ustalenia quorum ostrzega, bez treści i bez wpisu audytu', async () => {
  const db = await meetingsDb();
  try {
    const created = await meeting(db);
    await createResolution(db, board, { idempotencyKey: key(), meetingId: created.id,
      title: 'Tytuł nieujawniany', body: 'Treść nieujawniana.' });
    await createResolution(db, board, { idempotencyKey: key(), meetingId: created.id,
      title: 'Drugi projekt', body: 'Treść.' });
    const before = await auditCount(db);
    const checklist = await getApprovalChecklist(db, admin, { meetingId: created.id });
    assert.equal(checklist.ready, false);
    assert.deepEqual(checklist.items.find((item) => item.code === 'open_resolutions'), { code: 'open_resolutions', blocking: true, count: 2 });
    assert.ok(codes(checklist).includes('no_quorum_check'));
    assert.equal(checklist.items.find((item) => item.code === 'no_quorum_check').blocking, false);
    assert.doesNotMatch(JSON.stringify(checklist), /nieujawniana|Drugi projekt/);
    assert.equal(await auditCount(db), before, 'odczyt nie zapisuje audit_events');
  } finally { await db.close(); }
});

test('lista kontrolna: nieaktualne ustalenie quorum i uchwała na nim oparta są ostrzeżeniami', async () => {
  const db = await meetingsDb();
  try {
    const created = await meeting(db);
    for (const user of ['u1', 'u2', 'u3']) await attend(db, created.id, user, true);
    const early = (await determineQuorum(db, board, { idempotencyKey: key(), meetingId: created.id })).quorumCheck;
    await createResolution(db, board, { idempotencyKey: key(), meetingId: created.id, title: 'Przyjęta', body: 'Treść.',
      status: 'adopted', number: 'U-81/1', votesFor: 3, votesAgainst: 0, votesAbstain: 0, quorumCheckId: early.id });
    let checklist = await getApprovalChecklist(db, auditor, { meetingId: created.id });
    assert.equal(checklist.ready, true);
    assert.deepEqual(codes(checklist), []);

    await attend(db, created.id, 'u2', false);
    await attend(db, created.id, 'u3', false);
    checklist = await getApprovalChecklist(db, auditor, { meetingId: created.id });
    assert.equal(checklist.ready, true, 'nieaktualne ustalenie to ostrzeżenie, nie blokada zatwierdzenia');
    assert.deepEqual(codes(checklist).sort(), ['resolutions_on_stale_check', 'stale_quorum_check']);
    assert.equal(checklist.items.find((item) => item.code === 'resolutions_on_stale_check').count, 1);

    await determineQuorum(db, board, { idempotencyKey: key(), meetingId: created.id });
    checklist = await getApprovalChecklist(db, auditor, { meetingId: created.id });
    assert.deepEqual(codes(checklist), ['resolutions_on_stale_check'], 'uchwała nadal opiera się na starym ustaleniu');
  } finally { await db.close(); }
});

test('lista kontrolna: zebranie nieodbyte i brak reguły quorum', async () => {
  const db = await meetingsDb();
  try {
    const created = await meeting(db, { quorumMode: 'not_configured', quorumNumerator: null, quorumDenominator: null,
      quorumInclusive: null, votingBodySize: null, quorumRuleSource: null }, false);
    const checklist = await getApprovalChecklist(db, board, { meetingId: created.id });
    assert.equal(checklist.ready, false);
    assert.deepEqual(checklist.items.find((item) => item.code === 'meeting_not_held'), { code: 'meeting_not_held', blocking: true });
    assert.ok(codes(checklist).includes('quorum_rule_missing'));
  } finally { await db.close(); }
});

test('lista kontrolna: granice ról — przedstawiciel, skarbnik i zarząd innej klasy dostają 404', async () => {
  const db = await meetingsDb();
  try {
    const classB = await meeting(db, { kind: 'class', classId: 'class-b' });
    const classA = await meeting(db, { kind: 'class', classId: 'class-a' });
    for (const actor of [rep, treasurer, boardA]) {
      await assert.rejects(getApprovalChecklist(db, actor, { meetingId: classB.id }), { code: 'meeting_not_found', status: 404 });
    }
    await assert.rejects(getApprovalChecklist(db, rep, { meetingId: classA.id }), { code: 'meeting_not_found', status: 404 },
      'przedstawiciel nie widzi listy także własnej klasy');
    await assert.rejects(getApprovalChecklist(db, board, { meetingId: 'nieistnieje' }), { code: 'meeting_not_found', status: 404 });
    assert.equal((await getApprovalChecklist(db, boardA, { meetingId: classA.id })).meetingId, classA.id);
    assert.equal((await getApprovalChecklist(db, auditor, { meetingId: classB.id })).meetingId, classB.id);
  } finally { await db.close(); }
});

test('lista kontrolna przez HTTP: GET 200/404, POST 405, brak sesji', async () => {
  const db = await meetingsDb();
  try {
    const created = await meeting(db);
    const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data),
      { status, headers: { 'Content-Type': 'application/json', ...headers } });
    const call = (actor, method = 'GET') => {
      const url = new URL(`https://rd.example.invalid/api/meetings/${created.id}/approval-checklist`);
      const env = { db, async loadAuthorizationContext() {
        return actor ? { session: { user: { id: actor.userId }, mfaVerified: actor.mfaVerified }, grants: actor.grants } : null;
      } };
      const request = new Request(url, { method, headers: { Origin: 'https://rd.example.invalid' },
        ...(method === 'POST' ? { body: '{}' } : {}) });
      return handle(request, env, url, json);
    };
    assert.equal((await call(auditor)).status, 200);
    assert.equal((await call(rep)).status, 404);
    assert.equal((await call(board, 'POST')).status, 405);
    assert.equal((await call(null)).status, 401);
  } finally { await db.close(); }
});

test('409 minutes_open_resolutions niesie liczbę projektów, a po odmowie nie ma wpisu audytu', async () => {
  const db = await meetingsDb();
  try {
    const created = await meeting(db);
    await createResolution(db, board, { idempotencyKey: key(), meetingId: created.id, title: 'Projekt A', body: 'Treść.' });
    const second = (await createResolution(db, board, { idempotencyKey: key(), meetingId: created.id, title: 'Projekt B', body: 'Treść.' })).resolution;
    const { minutes } = await createMinutesVersion(db, board, { idempotencyKey: key(), meetingId: created.id,
      body: 'Protokół syntetyczny do zatwierdzenia.' });
    const approvals = async () => (await db.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'meeting.minutes.approved'")).rows[0].n;
    await assert.rejects(approveMinutes(db, admin, { minutesId: minutes.id }),
      (error) => error.code === 'minutes_open_resolutions' && error.status === 409 && error.details.openResolutions === 2);
    await updateResolution(db, board, { resolutionId: second.id, status: 'withdrawn' });
    await assert.rejects(approveMinutes(db, admin, { minutesId: minutes.id }),
      (error) => error.details.openResolutions === 1);
    assert.equal(await approvals(), 0);
  } finally { await db.close(); }
});

test('ponowienie ustalenia quorum po zmianie obecności nie odtwarza starego ustalenia', async () => {
  const db = await meetingsDb();
  try {
    const created = await meeting(db);
    for (const user of ['u1', 'u2']) await attend(db, created.id, user, true);
    const idempotencyKey = key();
    const first = await determineQuorum(db, board, { idempotencyKey, meetingId: created.id });
    const same = await determineQuorum(db, board, { idempotencyKey, meetingId: created.id });
    assert.equal(same.replayed, true);
    assert.equal(same.quorumCheck.id, first.quorumCheck.id);
    await attend(db, created.id, 'u2', false);
    await assert.rejects(determineQuorum(db, board, { idempotencyKey, meetingId: created.id }),
      { code: 'idempotency_conflict', status: 409 });
    const fresh = await determineQuorum(db, board, { idempotencyKey: key(), meetingId: created.id });
    assert.notEqual(fresh.quorumCheck.id, first.quorumCheck.id);
    assert.equal(fresh.quorumCheck.presentEligible, 1);
    const count = (await db.query('SELECT count(*)::int AS n FROM meeting_quorum_checks')).rows[0].n;
    assert.equal(count, 2);
  } finally { await db.close(); }
});
