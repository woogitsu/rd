// #102: rejestr uchwał roku — numeracja (podpowiedź), relacje zmienia/uchyla
// i śledzenie wykonania. Dane wyłącznie syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  correctResolution,
  createMeeting,
  createResolution,
  determineQuorum,
  findAdoptedResolution,
  handle,
  listResolutionRegister,
  recordAttendance,
  recordResolutionExecution,
} from '../src/pg/meetings.js';
import { updateMeeting } from './helpers/with-revision.js';
import { createPgliteTestDb } from './helpers/pg.js';

const ORIGIN = 'https://rd.example.invalid';

const grant = (role, extra = {}) => ({ role, classId: null, schoolYearId: 'year', expiresAt: null, ...extra });
const board = { userId: 'board', grants: [grant('board')], mfaVerified: true };
const auditor = { userId: 'auditor', grants: [grant('audit')], mfaVerified: true };
const rep = { userId: 'rep', grants: [grant('representative', { classId: 'class-a' })], mfaVerified: true };
const boardA = { userId: 'board-a', grants: [grant('board', { classId: 'class-a' })], mfaVerified: true };
// Drugi członek zarządu bez przydziału klasy: potrzebny do zasady czterech oczu
// (#135) — zatwierdzający musi być inną osobą niż autor wersji protokołu.
const board2 = { userId: 'board-2', grants: [grant('board')], mfaVerified: true };

let keySeq = 0;
const key = () => `res-test-key-${++keySeq}`;

async function resolutionsDb({ pattern = null } = {}) {
  const db = await createPgliteTestDb();
  await db.query(`INSERT INTO school_years (id, label, starts_on, ends_on, resolution_number_pattern)
    VALUES ('year','2026/27','2026-09-01','2027-08-31', $1),
           ('other','2027/28','2027-09-01','2028-08-31', NULL)`, [pattern]);
  await db.query("INSERT INTO classes (id, school_year_id, name) VALUES ('class-a','year','1A'), ('class-b','year','1B')");
  for (const id of ['board', 'board-a', 'board-2', 'auditor', 'rep', 'u1', 'u2', 'u3']) {
    await db.query('INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)',
      [id, `${id}@example.invalid`, `Synthetic ${id}`]);
  }
  // #205 (0150): osoba na liście obecności musi mieć w bazie aktywny przydział w roku zebrania.
  for (const id of ['u1', 'u2', 'u3']) {
    await db.query("INSERT INTO role_grants (id, user_id, role) VALUES ($1, $2, 'board')", [`grant-${id}`, id]);
  }
  return db;
}

async function heldMeetingWithQuorum(db, extra = {}) {
  const { meeting } = await createMeeting(db, board, {
    idempotencyKey: key(), schoolYearId: 'year', kind: 'plenary', title: 'Zebranie plenarne',
    scheduledAt: '2026-10-10T17:00:00Z', status: 'scheduled',
    quorumMode: 'minimum_count', quorumMinCount: 1, quorumRuleSource: 'Założenie testowe', ...extra,
  });
  await updateMeeting(db, board, { meetingId: meeting.id, status: 'held' });
  await recordAttendance(db, board, { meetingId: meeting.id, userId: 'u1', capacity: 'board_member',
    votingEligible: true, present: true });
  const { quorumCheck } = await determineQuorum(db, board, { idempotencyKey: key(), meetingId: meeting.id });
  return { meeting, quorumCheck };
}

async function adopt(db, meeting, quorumCheck, number, overrides = {}) {
  return (await createResolution(db, board, {
    idempotencyKey: key(), meetingId: meeting.id, title: `Uchwała ${number}`, body: 'Treść syntetyczna.',
    status: 'adopted', number, votesFor: 1, votesAgainst: 0, votesAbstain: 0,
    quorumCheckId: quorumCheck.id, ...overrides,
  })).resolution;
}

// ---------- numbering hint ----------

test('suggestedNumber follows the year pattern and updates after each chain-start', async () => {
  const db = await resolutionsDb({ pattern: '{seq}/{year}' });
  try {
    const { meeting, quorumCheck } = await heldMeetingWithQuorum(db);
    const first = await createResolution(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Projekt 1', body: 'Treść.',
    });
    assert.equal(first.suggestedNumber, '1/2026');
    await adopt(db, meeting, quorumCheck, '1/2026');
    const second = await createResolution(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Projekt 2', body: 'Treść.',
    });
    assert.equal(second.suggestedNumber, '2/2026');
  } finally { await db.close(); }
});

test('no pattern configured (D-15 undecided): suggestedNumber is null, nothing enforced', async () => {
  const db = await resolutionsDb({ pattern: null });
  try {
    const { meeting } = await heldMeetingWithQuorum(db);
    const created = await createResolution(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Projekt', body: 'Treść.',
    });
    assert.equal(created.suggestedNumber, null);
  } finally { await db.close(); }
});

test('two parallel drafts using the same suggested number: the second gets 409 with a fresh suggestion (PGlite: po kolei, nie wyścig)', async () => {
  const db = await resolutionsDb({ pattern: '{seq}/{year}' });
  try {
    const { meeting, quorumCheck } = await heldMeetingWithQuorum(db);
    const hint = (await createResolution(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Projekt', body: 'Treść.',
    })).suggestedNumber;
    assert.equal(hint, '1/2026');
    // Both secretaries saw "1/2026" and both submit it.
    await adopt(db, meeting, quorumCheck, hint);
    await assert.rejects(
      createResolution(db, board, {
        idempotencyKey: key(), meetingId: meeting.id, title: 'Projekt równoległy', body: 'Treść.',
        status: 'adopted', number: hint, votesFor: 1, votesAgainst: 0, votesAbstain: 0,
        quorumCheckId: quorumCheck.id,
      }),
      (error) => {
        assert.equal(error.code, 'resolution_number_taken');
        assert.equal(error.status, 409);
        assert.equal(error.details?.suggestedNumber, '2/2026');
        return true;
      },
    );
  } finally { await db.close(); }
});

// ---------- amends / repeals relations ----------

test('an adopted resolution can be marked as amended or repealed by a later one', async () => {
  const db = await resolutionsDb();
  try {
    const { meeting, quorumCheck } = await heldMeetingWithQuorum(db);
    const budget = await adopt(db, meeting, quorumCheck, 'U-1/2026');
    const amendment = (await createResolution(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Zmiana budżetu', body: 'Treść.',
      status: 'adopted', number: 'U-2/2026', votesFor: 1, votesAgainst: 0, votesAbstain: 0,
      quorumCheckId: quorumCheck.id, amendsResolutionId: budget.id, relationKind: 'amends',
    })).resolution;
    assert.equal(amendment.relationKind, 'amends');

    const { resolutions } = await listResolutionRegister(db, board, { schoolYearId: 'year' });
    const budgetEntry = resolutions.find((r) => r.id === budget.id);
    assert.equal(budgetEntry.effectiveStatus, 'amended');
    assert.equal(budgetEntry.amendedBy.id, amendment.id);
    assert.equal(budgetEntry.repealedBy, null);

    const repeal = (await createResolution(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Uchylenie budżetu', body: 'Treść.',
      status: 'adopted', number: 'U-3/2026', votesFor: 1, votesAgainst: 0, votesAbstain: 0,
      quorumCheckId: quorumCheck.id, amendsResolutionId: budget.id, relationKind: 'repeals',
    })).resolution;

    const after = (await listResolutionRegister(db, board, { schoolYearId: 'year' })).resolutions
      .find((r) => r.id === budget.id);
    assert.equal(after.effectiveStatus, 'repealed');
    assert.equal(after.repealedBy.id, repeal.id);

    // findAdoptedResolution and ledger_resolution_links surface the repeal.
    const looked = (await findAdoptedResolution(db, board, { schoolYearId: 'year', number: 'U-1/2026' })).resolution;
    assert.equal(looked.effectiveStatus, 'repealed');
  } finally { await db.close(); }
});

test('relationKind is required together with amendsResolutionId, and must be a valid kind', async () => {
  const db = await resolutionsDb();
  try {
    const { meeting, quorumCheck } = await heldMeetingWithQuorum(db);
    const first = await adopt(db, meeting, quorumCheck, 'U-1/2026');
    await assert.rejects(createResolution(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Zmiana', body: 'Treść.',
      status: 'adopted', number: 'U-2/2026', votesFor: 1, votesAgainst: 0, votesAbstain: 0,
      quorumCheckId: quorumCheck.id, amendsResolutionId: first.id,
    }), { code: 'invalid_relation_kind' });
    await assert.rejects(createResolution(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Zmiana', body: 'Treść.',
      status: 'adopted', number: 'U-2/2026', votesFor: 1, votesAgainst: 0, votesAbstain: 0,
      quorumCheckId: quorumCheck.id, amendsResolutionId: first.id, relationKind: 'not-a-kind',
    }), { code: 'invalid_relation_kind' });
  } finally { await db.close(); }
});

test('amends must point to a current revision, not a superseded one', async () => {
  const db = await resolutionsDb();
  try {
    const { meeting, quorumCheck } = await heldMeetingWithQuorum(db);
    const original = await adopt(db, meeting, quorumCheck, 'U-1/2026');
    const corrected = (await correctResolution(db, board, {
      idempotencyKey: key(), resolutionId: original.id, reason: 'Pomyłka w liczbie głosów', votesAgainst: 0,
    })).resolution;
    assert.equal(corrected.revision, 2);
    // Pointing at the superseded revision (original.id) is refused.
    await assert.rejects(createResolution(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Zmiana', body: 'Treść.',
      status: 'adopted', number: 'U-2/2026', votesFor: 1, votesAgainst: 0, votesAbstain: 0,
      quorumCheckId: quorumCheck.id, amendsResolutionId: original.id, relationKind: 'amends',
    }), { code: 'resolution_amends_requires_adopted', status: 409 });
    // The current revision works.
    const amendment = (await createResolution(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Zmiana', body: 'Treść.',
      status: 'adopted', number: 'U-2/2026', votesFor: 1, votesAgainst: 0, votesAbstain: 0,
      quorumCheckId: quorumCheck.id, amendsResolutionId: corrected.id, relationKind: 'amends',
    })).resolution;
    assert.equal(amendment.amendsResolutionId, corrected.id);
  } finally { await db.close(); }
});

test('a cross-year amendment is refused without the explicit flag (409)', async () => {
  const db = await resolutionsDb();
  try {
    const { meeting: meetingYear1, quorumCheck: q1 } = await heldMeetingWithQuorum(db);
    const original = await adopt(db, meetingYear1, q1, 'U-1/2026');

    // 'board' is scoped to schoolYearId 'year' only; year 2's meeting needs its
    // own grant (a board member serving across both school years).
    const boardAnyYear = { userId: 'board', grants: [grant('board', { schoolYearId: null })], mfaVerified: true };
    const { meeting: meetingYear2 } = await createMeeting(db, boardAnyYear, {
      idempotencyKey: key(), schoolYearId: 'other', kind: 'plenary', title: 'Zebranie roku 2',
      scheduledAt: '2027-10-10T17:00:00Z', status: 'scheduled',
      quorumMode: 'minimum_count', quorumMinCount: 1, quorumRuleSource: 'Założenie testowe',
    });
    await updateMeeting(db, boardAnyYear, { meetingId: meetingYear2.id, status: 'held' });
    await recordAttendance(db, boardAnyYear, { meetingId: meetingYear2.id, userId: 'u1', capacity: 'board_member',
      votingEligible: true, present: true });
    const { quorumCheck: q2 } = await determineQuorum(db, boardAnyYear,
      { idempotencyKey: key(), meetingId: meetingYear2.id });

    await assert.rejects(createResolution(db, boardAnyYear, {
      idempotencyKey: key(), meetingId: meetingYear2.id, title: 'Zmiana z innego roku', body: 'Treść.',
      status: 'adopted', number: 'U-1/2027', votesFor: 1, votesAgainst: 0, votesAbstain: 0,
      quorumCheckId: q2.id, amendsResolutionId: original.id, relationKind: 'amends',
    }), { code: 'resolution_amends_cross_year_requires_flag', status: 409 });

    const crossYear = (await createResolution(db, boardAnyYear, {
      idempotencyKey: key(), meetingId: meetingYear2.id, title: 'Zmiana z innego roku', body: 'Treść.',
      status: 'adopted', number: 'U-1/2027', votesFor: 1, votesAgainst: 0, votesAbstain: 0,
      quorumCheckId: q2.id, amendsResolutionId: original.id, relationKind: 'amends', relationCrossYear: true,
    })).resolution;
    assert.equal(crossYear.relationCrossYear, true);
  } finally { await db.close(); }
});

// ---------- register access scope ----------

test('the register is scoped: a class board grant sees only its class, a representative gets 403', async () => {
  const db = await resolutionsDb();
  try {
    const { meeting: classA } = await createMeeting(db, board, {
      idempotencyKey: key(), schoolYearId: 'year', kind: 'class', classId: 'class-a',
      title: 'Zebranie 1A', scheduledAt: '2026-10-10T17:00:00Z', status: 'scheduled',
      quorumMode: 'minimum_count', quorumMinCount: 1, quorumRuleSource: 'Założenie testowe',
    });
    await updateMeeting(db, board, { meetingId: classA.id, status: 'held' });
    await recordAttendance(db, board, { meetingId: classA.id, userId: 'u1', capacity: 'board_member',
      votingEligible: true, present: true });
    const { quorumCheck: qa } = await determineQuorum(db, board, { idempotencyKey: key(), meetingId: classA.id });
    await adopt(db, classA, qa, 'U-A/2026');

    const { meeting: plenary, quorumCheck: qp } = await heldMeetingWithQuorum(db, {});
    await adopt(db, plenary, qp, 'U-P/2026');

    const asClassBoard = await listResolutionRegister(db, boardA, { schoolYearId: 'year' });
    assert.deepEqual(asClassBoard.resolutions.map((r) => r.number).sort(), ['U-A/2026']);

    await assert.rejects(listResolutionRegister(db, rep, { schoolYearId: 'year' }), { code: 'forbidden' });

    const asAudit = await listResolutionRegister(db, auditor, { schoolYearId: 'year' });
    assert.deepEqual(asAudit.resolutions.map((r) => r.number).sort(), ['U-A/2026', 'U-P/2026']);
  } finally { await db.close(); }
});

test('a different school year is not visible: audit of year 1 does not see year 2', async () => {
  const db = await resolutionsDb();
  try {
    const { meeting, quorumCheck } = await heldMeetingWithQuorum(db);
    await adopt(db, meeting, quorumCheck, 'U-1/2026');
    // The auditor's grant is scoped to 'year': asking for 'other' is refused by
    // role/scope before any row is read — year 2's register is not visible either way.
    await assert.rejects(listResolutionRegister(db, auditor, { schoolYearId: 'other' }), { code: 'forbidden' });

    // A school-wide Komisja Rewizyjna grant (both years) still only sees its own
    // year's resolutions per request — the register never mixes years.
    const auditorAnyYear = { userId: 'auditor', grants: [grant('audit', { schoolYearId: null })] };
    const otherYear = await listResolutionRegister(db, auditorAnyYear, { schoolYearId: 'other' });
    assert.deepEqual(otherYear.resolutions, []);
    const thisYear = await listResolutionRegister(db, auditorAnyYear, { schoolYearId: 'year' });
    assert.deepEqual(thisYear.resolutions.map((r) => r.number), ['U-1/2026']);
  } finally { await db.close(); }
});

test('status and text filters narrow the register', async () => {
  const db = await resolutionsDb();
  try {
    const { meeting, quorumCheck } = await heldMeetingWithQuorum(db);
    await adopt(db, meeting, quorumCheck, 'U-1/2026', { title: 'Budżet szkolny' });
    await createResolution(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Projekt regulaminu', body: 'Treść.',
    });
    const adoptedOnly = await listResolutionRegister(db, board, { schoolYearId: 'year', status: 'adopted' });
    assert.deepEqual(adoptedOnly.resolutions.map((r) => r.number), ['U-1/2026']);
    const byText = await listResolutionRegister(db, board, { schoolYearId: 'year', q: 'regulaminu' });
    assert.equal(byText.resolutions.length, 1);
    assert.equal(byText.resolutions[0].status, 'draft');
  } finally { await db.close(); }
});

// ---------- execution tracking ----------

test('execution events are append-only, immutable, and the register filters by latest execution status', async () => {
  const db = await resolutionsDb();
  try {
    const { meeting, quorumCheck } = await heldMeetingWithQuorum(db);
    const resolution = await adopt(db, meeting, quorumCheck, 'U-1/2026');
    const untouched = await adopt(db, meeting, quorumCheck, 'U-2/2026');

    const first = await recordResolutionExecution(db, board, {
      idempotencyKey: key(), resolutionId: resolution.id, status: 'not_started',
    });
    assert.equal(first.execution.status, 'not_started');
    const second = await recordResolutionExecution(db, board, {
      idempotencyKey: key(), resolutionId: resolution.id, status: 'in_progress',
      responsibleUserId: 'board', dueOn: '2026-12-01',
    });
    assert.equal(second.execution.status, 'in_progress');
    assert.equal(second.execution.responsibleUserId, 'board');
    assert.equal(second.execution.dueOn, '2026-12-01');

    // A correction is a new event, not an overwrite: history stays.
    const { rows } = await db.query(
      'SELECT count(*)::int AS n FROM resolution_execution_events WHERE resolution_id = $1', [resolution.id]);
    assert.equal(rows[0].n, 2);
    await assert.rejects(db.query("UPDATE resolution_execution_events SET status = 'done' WHERE resolution_id = $1",
      [resolution.id]), /cannot_be_changed/);
    await assert.rejects(db.query('DELETE FROM resolution_execution_events WHERE resolution_id = $1', [resolution.id]),
      /cannot_be_changed/);

    // The register's execution status is the latest event; filtering by it works,
    // and 'none' finds resolutions with no execution event yet.
    const inProgress = await listResolutionRegister(db, board, { schoolYearId: 'year', executionStatus: 'in_progress' });
    assert.deepEqual(inProgress.resolutions.map((r) => r.number), ['U-1/2026']);
    const none = await listResolutionRegister(db, board, { schoolYearId: 'year', executionStatus: 'none' });
    assert.deepEqual(none.resolutions.map((r) => r.number), ['U-2/2026']);
    assert.equal(untouched.number, 'U-2/2026');
  } finally { await db.close(); }
});

test('repeating the same Idempotency-Key records exactly one execution event', async () => {
  const db = await resolutionsDb();
  try {
    const { meeting, quorumCheck } = await heldMeetingWithQuorum(db);
    const resolution = await adopt(db, meeting, quorumCheck, 'U-1/2026');
    const idempotencyKey = key();
    const a = await recordResolutionExecution(db, board, { idempotencyKey, resolutionId: resolution.id, status: 'done' });
    const b = await recordResolutionExecution(db, board, { idempotencyKey, resolutionId: resolution.id, status: 'done' });
    assert.equal(a.execution.id, b.execution.id);
    assert.equal(b.replayed, true);
    const { rows } = await db.query(
      'SELECT count(*)::int AS n FROM resolution_execution_events WHERE resolution_id = $1', [resolution.id]);
    assert.equal(rows[0].n, 1);
  } finally { await db.close(); }
});

test('execution can be recorded even after the minutes are approved (meeting locked)', async () => {
  const db = await resolutionsDb();
  try {
    const { meeting, quorumCheck } = await heldMeetingWithQuorum(db);
    const resolution = await adopt(db, meeting, quorumCheck, 'U-1/2026');
    const { createMinutesVersion, approveMinutes } = await import('../src/pg/meetings.js');
    const minutes = (await createMinutesVersion(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, body: 'Protokół syntetyczny, kompletny.',
    })).minutes;
    // #135: zatwierdzający musi być inną osobą niż autor wersji protokołu.
    await approveMinutes(db, board2, { minutesId: minutes.id });
    // The meeting itself is now locked (cannot add a new resolution), but
    // execution tracking is a separate table and still accepts writes.
    await assert.rejects(createResolution(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Za późno', body: 'Treść.',
    }), { code: 'meeting_locked' });
    const executed = await recordResolutionExecution(db, board, {
      idempotencyKey: key(), resolutionId: resolution.id, status: 'done',
    });
    assert.equal(executed.execution.status, 'done');
  } finally { await db.close(); }
});

test('execution cannot be recorded for a draft resolution', async () => {
  const db = await resolutionsDb();
  try {
    const { meeting } = await heldMeetingWithQuorum(db);
    const draft = (await createResolution(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Projekt', body: 'Treść.',
    })).resolution;
    await assert.rejects(recordResolutionExecution(db, board, {
      idempotencyKey: key(), resolutionId: draft.id, status: 'not_started',
    }), { code: 'resolution_not_decided', status: 409 });
  } finally { await db.close(); }
});

// ---------- audit ----------

test('audit metadata for the register never carries resolution text', async () => {
  const db = await resolutionsDb();
  try {
    const { meeting, quorumCheck } = await heldMeetingWithQuorum(db);
    const resolution = await adopt(db, meeting, quorumCheck, 'U-1/2026', { title: 'Sekret budżetowy' });
    await recordResolutionExecution(db, board, {
      idempotencyKey: key(), resolutionId: resolution.id, status: 'not_started', note: 'Notatka poufna',
    });
    const { rows } = await db.query(
      "SELECT metadata_json FROM audit_events WHERE action IN ('resolution.created','resolution.execution.recorded')");
    const body = JSON.stringify(rows);
    assert.equal(body.includes('Sekret budżetowy'), false);
    assert.equal(body.includes('Notatka poufna'), false);
  } finally { await db.close(); }
});

// ---------- HTTP wiring ----------

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
function httpEnv(db, actor) {
  return {
    db,
    loadAuthorizationContext: async () => (actor
      ? { session: { user: { id: actor.userId }, mfaVerified: actor.mfaVerified }, grants: actor.grants }
      : null),
  };
}
async function call(env, method, path, { body, headers = {} } = {}) {
  const url = new URL(path, ORIGIN);
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['Content-Type'] ??= 'application/json';
  }
  const response = await handle(new Request(url, init), env, url, jsonResponse);
  return response && { status: response.status, headers: response.headers, data: await response.json() };
}

test('HTTP: GET /api/meetings/resolutions and POST .../execution are wired and scoped', async () => {
  const db = await resolutionsDb();
  try {
    const { meeting, quorumCheck } = await heldMeetingWithQuorum(db);
    const resolution = await adopt(db, meeting, quorumCheck, 'U-1/2026');

    const list = await call(httpEnv(db, board), 'GET', '/api/meetings/resolutions?schoolYearId=year');
    assert.equal(list.status, 200);
    assert.deepEqual(list.data.resolutions.map((r) => r.number), ['U-1/2026']);

    assert.equal((await call(httpEnv(db, rep), 'GET', '/api/meetings/resolutions?schoolYearId=year')).status, 403);
    assert.equal((await call(httpEnv(db, null), 'GET', '/api/meetings/resolutions?schoolYearId=year')).status, 401);

    const exec = await call(httpEnv(db, board), 'POST', `/api/meetings/resolutions/${resolution.id}/execution`, {
      body: { status: 'not_started' },
      headers: { Origin: ORIGIN, 'Idempotency-Key': 'exec-key-0001' },
    });
    assert.equal(exec.status, 201);
    assert.equal(exec.data.execution.status, 'not_started');
    const replay = await call(httpEnv(db, board), 'POST', `/api/meetings/resolutions/${resolution.id}/execution`, {
      body: { status: 'not_started' },
      headers: { Origin: ORIGIN, 'Idempotency-Key': 'exec-key-0001' },
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
  } finally { await db.close(); }
});
