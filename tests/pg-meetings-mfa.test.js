// #135 (SR-10): MFA i zasada czterech oczu przy rozstrzyganiu uchwał,
// zatwierdzaniu i publikacji protokołów. Dane wyłącznie syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../src/postgres-migrations.js';
import {
  approveMinutes, correctResolution, createMeeting, createMinutesVersion, createResolution,
  determineQuorum, recordAttendance, setMinutesVisibility, updateMeeting, updateResolution,
} from '../src/pg/meetings.js';

const directory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));

const grant = (role, extra = {}) => ({ role, classId: null, schoolYearId: 'year', expiresAt: null, ...extra });
// Dwie różne osoby zarządu (autor i zatwierdzający), oraz wariant bez MFA.
const boardA = { userId: 'board-a', grants: [grant('board')], mfaVerified: true };
const boardANoMfa = { userId: 'board-a', grants: [grant('board')], mfaVerified: false };
const boardB = { userId: 'board-b', grants: [grant('board')], mfaVerified: true };
const boardBNoMfa = { userId: 'board-b', grants: [grant('board')], mfaVerified: false };
const admin = { userId: 'admin', grants: [grant('admin', { schoolYearId: null })], mfaVerified: true };
const auditor = { userId: 'auditor', grants: [grant('audit')], mfaVerified: true };
const rep = { userId: 'rep', grants: [grant('representative', { classId: 'class-a' })], mfaVerified: true };

let keySeq = 0;
const key = () => `mfa-test-key-${++keySeq}`;

async function meetingsDb() {
  const db = new PGlite();
  for (const migration of await loadMigrations(directory)) await db.exec(migration.sql);
  await db.query("INSERT INTO school_years VALUES ('year','2026/27','2026-09-01','2027-08-31')");
  await db.query("INSERT INTO classes (id, school_year_id, name) VALUES ('class-a','year','1A')");
  for (const id of ['board-a', 'board-b', 'admin', 'auditor', 'rep', 'u1', 'u2', 'u3']) {
    await db.query('INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)',
      [id, `${id}@example.invalid`, `Synthetic ${id}`]);
  }
  // #205 (0134): osoba na liście obecności musi mieć w bazie aktywny przydział w roku zebrania.
  for (const id of ['u1', 'u2', 'u3']) {
    await db.query("INSERT INTO role_grants (id, user_id, role) VALUES ($1, $2, 'board')", [`grant-${id}`, id]);
  }
  return db;
}

async function heldMeetingWithQuorum(db) {
  const { meeting } = await createMeeting(db, boardA, {
    idempotencyKey: key(), schoolYearId: 'year', kind: 'plenary', title: 'Zebranie plenarne',
    scheduledAt: '2026-10-10T17:00:00Z', status: 'scheduled',
    quorumMode: 'minimum_count', quorumMinCount: 1, quorumRuleSource: 'Założenie testowe',
  });
  await updateMeeting(db, boardA, { meetingId: meeting.id, status: 'held' });
  await recordAttendance(db, boardA, { meetingId: meeting.id, userId: 'u1', capacity: 'board_member',
    votingEligible: true, present: true });
  const { quorumCheck } = await determineQuorum(db, boardA, { idempotencyKey: key(), meetingId: meeting.id });
  return { meeting, quorumCheck };
}

async function auditCount(db, action) {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM audit_events WHERE action = $1', [action]);
  return rows[0].n;
}

// ---------- resolutions: MFA to decide ----------

// #150 (SR-10) rozszerza #135: zarządzanie zebraniem (w tym createResolution
// dla PROJEKTU, nie tylko decyzja) wymaga teraz MFA na poziomie meetingForManage,
// niezależnie od statusu uchwały — stąd draft też wymaga MFA (inaczej niż
// pierwotna nazwa testu z #135 sugerowała).
test('deciding a resolution (adopted/rejected) requires MFA; a draft now also does (#150)', async () => {
  const db = await meetingsDb();
  try {
    const { meeting, quorumCheck } = await heldMeetingWithQuorum(db);
    // #150: nawet projekt (draft) wymaga MFA — zarządzanie zebraniem w ogóle.
    await assert.rejects(createResolution(db, boardANoMfa, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Projekt uchwały (bez MFA)', body: 'Treść syntetyczna.',
    }), { code: 'mfa_required', status: 403 });
    const draft = (await createResolution(db, boardA, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Projekt uchwały', body: 'Treść syntetyczna.',
    })).resolution;
    assert.equal(draft.status, 'draft');

    // Deciding it (adopted) without MFA: refused, nothing written.
    await assert.rejects(updateResolution(db, boardANoMfa, {
      resolutionId: draft.id, status: 'adopted', number: 'U-1/2026',
      votesFor: 1, votesAgainst: 0, votesAbstain: 0, quorumCheckId: quorumCheck.id,
    }), { code: 'mfa_required', status: 403 });
    assert.equal(await auditCount(db, 'resolution.updated'), 0);

    // With MFA: succeeds.
    const adopted = (await updateResolution(db, boardA, {
      resolutionId: draft.id, status: 'adopted', number: 'U-1/2026',
      votesFor: 1, votesAgainst: 0, votesAbstain: 0, quorumCheckId: quorumCheck.id,
    })).resolution;
    assert.equal(adopted.status, 'adopted');

    // createResolution straight to adopted without MFA: refused before any write.
    await assert.rejects(createResolution(db, boardANoMfa, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Uchwała druga', body: 'Treść.',
      status: 'adopted', number: 'U-2/2026', votesFor: 1, votesAgainst: 0, votesAbstain: 0,
      quorumCheckId: quorumCheck.id,
    }), { code: 'mfa_required', status: 403 });
    assert.equal((await db.query("SELECT count(*)::int AS n FROM resolutions WHERE number = 'U-2/2026'")).rows[0].n, 0);

    // Correction always decides again (adopted/rejected): always requires MFA.
    await assert.rejects(correctResolution(db, boardANoMfa, {
      idempotencyKey: key(), resolutionId: adopted.id, reason: 'Pomyłka w liczbie głosów', votesAgainst: 0,
    }), { code: 'mfa_required', status: 403 });
    const corrected = (await correctResolution(db, boardA, {
      idempotencyKey: key(), resolutionId: adopted.id, reason: 'Pomyłka w liczbie głosów', votesAgainst: 0,
    })).resolution;
    assert.equal(corrected.revision, 2);
  } finally { await db.close(); }
});

// ---------- minutes: MFA + four eyes to approve ----------

test('approving minutes requires MFA and a different person than the author', async () => {
  const db = await meetingsDb();
  try {
    const { meeting } = await heldMeetingWithQuorum(db);
    const v1 = (await createMinutesVersion(db, boardA, {
      idempotencyKey: key(), meetingId: meeting.id, body: 'Protokół syntetyczny, wersja pierwsza.',
    })).minutes;

    // The author (even with MFA) cannot approve their own version.
    await assert.rejects(approveMinutes(db, boardA, { minutesId: v1.id }),
      { code: 'minutes_four_eyes_required', status: 403 });
    assert.equal(await auditCount(db, 'meeting.minutes.approved'), 0);

    // A different board member without MFA: refused too.
    await assert.rejects(approveMinutes(db, boardBNoMfa, { minutesId: v1.id }),
      { code: 'mfa_required', status: 403 });
    assert.equal(await auditCount(db, 'meeting.minutes.approved'), 0);

    // A different board member with MFA: succeeds.
    const approved = await approveMinutes(db, boardB, { minutesId: v1.id });
    assert.equal(approved.minutes.status, 'approved');
    assert.equal(approved.replayed, false);

    // Double click by the same approver: replayed, no second audit entry.
    const again = await approveMinutes(db, boardB, { minutesId: v1.id });
    assert.equal(again.replayed, true);
    assert.equal(await auditCount(db, 'meeting.minutes.approved'), 1);

    // The database enforces the same rule directly, bypassing the service.
    const v2 = (await createMinutesVersion(db, boardA, {
      idempotencyKey: key(), meetingId: meeting.id, body: 'Protokół syntetyczny, poprawiony.',
    })).minutes;
    await assert.rejects(db.query(
      `UPDATE meeting_minutes SET status = 'approved', approved_by = 'board-a', approved_at = now() WHERE id = $1`,
      [v2.id]), /minutes_four_eyes_required/);
    // A different approver at the database level is accepted.
    await db.query(
      `UPDATE meeting_minutes SET status = 'approved', approved_by = 'board-b', approved_at = now() WHERE id = $1`,
      [v2.id]);
    assert.equal((await db.query('SELECT status FROM meeting_minutes WHERE id = $1', [v2.id])).rows[0].status, 'approved');
  } finally { await db.close(); }
});

test('retrying after MFA expired mid-session leaves no partial write', async () => {
  const db = await meetingsDb();
  try {
    const { meeting } = await heldMeetingWithQuorum(db);
    const v1 = (await createMinutesVersion(db, boardA, {
      idempotencyKey: key(), meetingId: meeting.id, body: 'Protokół syntetyczny.',
    })).minutes;
    await assert.rejects(approveMinutes(db, boardBNoMfa, { minutesId: v1.id }), { code: 'mfa_required', status: 403 });
    assert.equal((await db.query('SELECT status FROM meeting_minutes WHERE id = $1', [v1.id])).rows[0].status, 'draft');
    assert.equal(await auditCount(db, 'meeting.minutes.approved'), 0);
    // A fresh verification in the same session (mfaVerified true again) then succeeds.
    const approved = await approveMinutes(db, boardB, { minutesId: v1.id });
    assert.equal(approved.minutes.status, 'approved');
  } finally { await db.close(); }
});

// ---------- minutes visibility: MFA only for parents/public ----------

// #150 (SR-10) rozszerza #135: zarządzanie zebraniem (meetingForManage) wymaga
// teraz MFA niezależnie od widoczności — internal wymaga go już na poziomie
// dostępu do zebrania, nie dopiero przy parents/public.
test('sharing minutes with parents or publicly requires MFA; internal now also does (#150)', async () => {
  const db = await meetingsDb();
  try {
    const { meeting } = await heldMeetingWithQuorum(db);
    const v1 = (await createMinutesVersion(db, boardA, {
      idempotencyKey: key(), meetingId: meeting.id, body: 'Protokół syntetyczny.',
    })).minutes;
    await approveMinutes(db, boardB, { minutesId: v1.id });

    // #150: internal również wymaga MFA (meetingForManage sprawdza je jako pierwsze).
    await assert.rejects(setMinutesVisibility(db, boardANoMfa,
      { idempotencyKey: key(), minutesId: v1.id, visibility: 'internal' }), { code: 'mfa_required', status: 403 });
    await setMinutesVisibility(db, boardA, { idempotencyKey: key(), minutesId: v1.id, visibility: 'internal' });

    // parents/public: MFA required, refused otherwise with nothing written.
    await assert.rejects(setMinutesVisibility(db, boardANoMfa, {
      idempotencyKey: key(), minutesId: v1.id, visibility: 'parents',
    }), { code: 'mfa_required', status: 403 });
    assert.equal(await auditCount(db, 'meeting.minutes.visibility_set'), 1); // only the internal one above

    await setMinutesVisibility(db, boardA, { idempotencyKey: key(), minutesId: v1.id, visibility: 'parents' });
    assert.equal(await auditCount(db, 'meeting.minutes.visibility_set'), 2);
  } finally { await db.close(); }
});

// ---------- role boundaries ----------

test('role boundaries: audit and representative cannot decide or approve regardless of MFA', async () => {
  const db = await meetingsDb();
  try {
    const { meeting, quorumCheck } = await heldMeetingWithQuorum(db);
    const draft = (await createResolution(db, boardA, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Projekt', body: 'Treść.',
    })).resolution;
    await assert.rejects(updateResolution(db, auditor, {
      resolutionId: draft.id, status: 'adopted', number: 'U-3/2026',
      votesFor: 1, votesAgainst: 0, votesAbstain: 0, quorumCheckId: quorumCheck.id,
    }), { code: 'forbidden' });
    await assert.rejects(updateResolution(db, rep, {
      resolutionId: draft.id, status: 'adopted', number: 'U-3/2026',
      votesFor: 1, votesAgainst: 0, votesAbstain: 0, quorumCheckId: quorumCheck.id,
    }), { code: 'forbidden' });
    // Role checks run before the MFA check: neither write anything.
    assert.equal((await db.query('SELECT status FROM resolutions WHERE id = $1', [draft.id])).rows[0].status, 'draft');
    // Withdraw the still-open draft so it does not block minutes approval (#81).
    await updateResolution(db, boardA, { resolutionId: draft.id, status: 'withdrawn' });

    const minutes = (await createMinutesVersion(db, boardA, {
      idempotencyKey: key(), meetingId: meeting.id, body: 'Protokół syntetyczny.',
    })).minutes;
    await assert.rejects(approveMinutes(db, auditor, { minutesId: minutes.id }), { code: 'forbidden' });
    // admin is in MANAGE_ROLES (assumption pending D-08) and is a different
    // person than the author (boardA): MFA and four-eyes are both satisfied.
    const approved = await approveMinutes(db, admin, { minutesId: minutes.id });
    assert.equal(approved.minutes.status, 'approved');
  } finally { await db.close(); }
});

test('order of checks: authorization and scope, then MFA, before any database write', async () => {
  const db = await meetingsDb();
  try {
    const { meeting, quorumCheck } = await heldMeetingWithQuorum(db);
    const draft = (await createResolution(db, boardA, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Projekt', body: 'Treść.',
    })).resolution;
    // Out of role/scope (representative) is refused before MFA is even
    // considered — same input, no MFA either way, but the error is about scope.
    await assert.rejects(updateResolution(db, rep, {
      resolutionId: draft.id, status: 'adopted', number: 'U-5/2026',
      votesFor: 1, votesAgainst: 0, votesAbstain: 0, quorumCheckId: quorumCheck.id,
    }), { code: 'forbidden' });
    // In role/scope but no MFA: mfa_required, not a database-rule conflict.
    await assert.rejects(updateResolution(db, boardANoMfa, {
      resolutionId: draft.id, status: 'adopted', number: 'U-5/2026',
      votesFor: 1, votesAgainst: 0, votesAbstain: 0, quorumCheckId: quorumCheck.id,
    }), { code: 'mfa_required', status: 403 });
    assert.equal((await db.query('SELECT status FROM resolutions WHERE id = $1', [draft.id])).rows[0].status, 'draft');
    // With MFA and in scope: the database rule (resolution_number_required kind
    // of check) still applies normally afterwards.
    const adopted = (await updateResolution(db, boardA, {
      resolutionId: draft.id, status: 'adopted', number: 'U-5/2026',
      votesFor: 1, votesAgainst: 0, votesAbstain: 0, quorumCheckId: quorumCheck.id,
    })).resolution;
    assert.equal(adopted.status, 'adopted');
  } finally { await db.close(); }
});
