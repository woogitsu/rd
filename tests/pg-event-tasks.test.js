// Zadania i zapisy wolontariuszy (issue #142, Etap 1). Wyłącznie syntetyczne dane.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../src/postgres-migrations.js';
import {
  cancel, cancelTask, createDraft, createSignup, createTask, listPublicTasks, listTasks, publish, approve, submit,
  updateDraft, withdrawSignup,
} from '../src/pg/events.js';

const directory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));

const board = { userId: 'board1', grants: [{ role: 'board', classId: null, schoolYearId: 'year' }], mfaVerified: true };
const board2 = { userId: 'board2', grants: [{ role: 'board', classId: null, schoolYearId: null }], mfaVerified: true };
const repA = { userId: 'repa', grants: [{ role: 'representative', classId: 'c1a', schoolYearId: 'year' }], mfaVerified: false };
const repB = { userId: 'repb', grants: [{ role: 'representative', classId: 'c1b', schoolYearId: 'year' }], mfaVerified: false };

async function tasksDb() {
  const db = new PGlite();
  for (const migration of await loadMigrations(directory)) await db.exec(migration.sql);
  await db.query("INSERT INTO school_years VALUES ('year','2026/27','2026-09-01','2027-08-31'), ('next','2027/28','2027-09-01','2028-08-31')");
  await db.query("INSERT INTO classes VALUES ('c1a','year','1A'), ('c1b','year','1B')");
  for (const id of ['board1', 'board2', 'repa', 'repb']) {
    await db.query('INSERT INTO users (id,email,display_name) VALUES ($1,$2,$3)', [id, `${id}@example.invalid`, `Synthetic ${id}`]);
  }
  await db.query("INSERT INTO households (id) VALUES ('h1'), ('h2')");
  // Rodzeństwo w 1A i 1B (dziecko d2), dwoje opiekunów jednego dziecka (d1: g1, g2).
  await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ('d1','h1','Jan','Syntetyczny'), ('d2','h2','Ola','Syntetyczna')");
  await db.query("INSERT INTO guardians (id, household_id, first_name, last_name) VALUES ('g1','h1','Opiekun','Jeden'), ('g2','h1','Opiekun','Dwa'), ('g3','h2','Opiekun','Trzy')");
  await db.query("INSERT INTO student_guardians (student_id, guardian_id, contact_allowed) VALUES ('d1','g1',true), ('d1','g2',true), ('d2','g3',true)");
  await db.query("INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('e1','d1','c1a','year'), ('e2','d2','c1b','year')");
  return db;
}

let keyCounter = 0;
function key(prefix = 'test-key') {
  keyCounter += 1;
  return `${prefix}-${String(keyCounter).padStart(4, '0')}`;
}

async function draftClassEvent(db, actor, classId, overrides = {}) {
  const { event } = await createDraft(db, actor, {
    schoolYearId: 'year', classId, title: 'Piknik klasowy (syntetyczny)',
    startsAt: '2026-11-12T10:00', endsAt: '2026-11-12T14:00', audience: 'internal',
    idempotencyKey: key('event'), ...overrides,
  });
  return event;
}

test('board creates a task for a class event; class representative signs up a guardian from that class', async () => {
  const db = await tasksDb();
  try {
    const event = await draftClassEvent(db, board, 'c1a');
    const created = await createTask(db, board, { eventId: event.id, title: 'Stoisko z ciastami', slotsNeeded: 2, idempotencyKey: key() });
    assert.equal(created.task.slotsNeeded, 2);

    const signup = await createSignup(db, repA, { eventId: event.id, taskId: created.task.id, guardianId: 'g1', idempotencyKey: key() });
    assert.equal(signup.signup.guardianId, 'g1');
    assert.equal(signup.signup.status, 'confirmed');

    const { tasks } = await listTasks(db, board, { eventId: event.id });
    assert.equal(tasks[0].confirmedCount, 1);
    assert.equal(tasks[0].signups[0].personName, 'Opiekun Jeden');
  } finally { await db.close(); }
});

test('representative of another class cannot see or sign up to a class event task (404, no oracle)', async () => {
  const db = await tasksDb();
  try {
    const event = await draftClassEvent(db, board, 'c1a');
    const created = await createTask(db, board, { eventId: event.id, title: 'Dyżur przy wejściu', slotsNeeded: 1, idempotencyKey: key() });
    await assert.rejects(
      createSignup(db, repB, { eventId: event.id, taskId: created.task.id, guardianId: 'g3', idempotencyKey: key() }),
      (error) => error.code === 'event_not_found' && error.status === 404,
    );
    await assert.rejects(listTasks(db, repB, { eventId: event.id }), (error) => error.code === 'event_not_found');
  } finally { await db.close(); }
});

test('representative can only sign up a guardian of a child in the assigned class', async () => {
  const db = await tasksDb();
  try {
    const event = await draftClassEvent(db, board, 'c1a');
    const created = await createTask(db, board, { eventId: event.id, title: 'Sprzątanie', slotsNeeded: 3, idempotencyKey: key() });
    // g3's child (d2) is enrolled in c1b, not c1a: rejected even though the task itself belongs to c1a.
    await assert.rejects(
      createSignup(db, repA, { eventId: event.id, taskId: created.task.id, guardianId: 'g3', idempotencyKey: key() }),
      (error) => error.code === 'guardian_outside_class' && error.status === 400,
    );
    // board is not restricted to a class.
    const boardSignup = await createSignup(db, board, { eventId: event.id, taskId: created.task.id, guardianId: 'g3', idempotencyKey: key() });
    assert.equal(boardSignup.signup.guardianId, 'g3');
  } finally { await db.close(); }
});

test('two guardians of the same child can each sign up to the same task; no duplicate for the same person', async () => {
  const db = await tasksDb();
  try {
    const event = await draftClassEvent(db, board, 'c1a');
    const created = await createTask(db, board, { eventId: event.id, title: 'Dyżur', slotsNeeded: 5, idempotencyKey: key() });
    await createSignup(db, repA, { eventId: event.id, taskId: created.task.id, guardianId: 'g1', idempotencyKey: key() });
    await createSignup(db, repA, { eventId: event.id, taskId: created.task.id, guardianId: 'g2', idempotencyKey: key() });
    const { tasks } = await listTasks(db, board, { eventId: event.id });
    assert.equal(tasks[0].confirmedCount, 2);

    const doubleClick = await createSignup(db, repA, { eventId: event.id, taskId: created.task.id, guardianId: 'g1', idempotencyKey: key() });
    assert.equal(doubleClick.replayed, true);
    const { tasks: after } = await listTasks(db, board, { eventId: event.id });
    assert.equal(after[0].confirmedCount, 2, 'no duplicate row for the same guardian');
  } finally { await db.close(); }
});

test('slot limit: the last concurrent signup gets task_full', async () => {
  const db = await tasksDb();
  try {
    const event = await draftClassEvent(db, board, 'c1a');
    const created = await createTask(db, board, { eventId: event.id, title: 'Jedno miejsce', slotsNeeded: 1, idempotencyKey: key() });
    await createSignup(db, repA, { eventId: event.id, taskId: created.task.id, guardianId: 'g1', idempotencyKey: key() });
    await assert.rejects(
      createSignup(db, repA, { eventId: event.id, taskId: created.task.id, guardianId: 'g2', idempotencyKey: key() }),
      (error) => error.code === 'task_full' && error.status === 409,
    );
  } finally { await db.close(); }
});

test('withdrawal and re-signup of the same person: state transition of the same row, with history', async () => {
  const db = await tasksDb();
  try {
    const event = await draftClassEvent(db, board, 'c1a');
    const created = await createTask(db, board, { eventId: event.id, title: 'Bufet', slotsNeeded: 1, idempotencyKey: key() });
    const first = await createSignup(db, repA, { eventId: event.id, taskId: created.task.id, guardianId: 'g1', idempotencyKey: key() });
    await withdrawSignup(db, repA, { eventId: event.id, taskId: created.task.id, signupId: first.signup.id });
    const { tasks: afterWithdraw } = await listTasks(db, board, { eventId: event.id });
    assert.equal(afterWithdraw[0].confirmedCount, 0);

    // Frees the slot for someone else...
    const second = await createSignup(db, repA, { eventId: event.id, taskId: created.task.id, guardianId: 'g2', idempotencyKey: key() });
    assert.equal(second.signup.guardianId, 'g2');
    // ...and re-signing up g1 now hits task_full again (slot taken by g2).
    await assert.rejects(
      createSignup(db, repA, { eventId: event.id, taskId: created.task.id, guardianId: 'g1', idempotencyKey: key() }),
      (error) => error.code === 'task_full',
    );

    // Repeated withdrawal of an already-withdrawn signup is a safe replay.
    const replay = await withdrawSignup(db, repA, { eventId: event.id, taskId: created.task.id, signupId: first.signup.id });
    assert.equal(replay.replayed, true);

    const rows = (await db.query(
      'SELECT count(*)::int AS n FROM event_task_signups WHERE task_id = $1 AND guardian_id = $2', [created.task.id, 'g1'],
    )).rows[0];
    assert.equal(rows.n, 1, 'withdrawal reuses the same row, does not create a new one');
  } finally { await db.close(); }
});

test('cancelling the event freezes its tasks: new signups are refused with 409, history is kept', async () => {
  const db = await tasksDb();
  try {
    const event = await draftClassEvent(db, board, 'c1a');
    const created = await createTask(db, board, { eventId: event.id, title: 'Parking', slotsNeeded: 2, idempotencyKey: key() });
    await createSignup(db, repA, { eventId: event.id, taskId: created.task.id, guardianId: 'g1', idempotencyKey: key() });
    await cancel(db, board, { eventId: event.id, revision: 1, reason: 'Odwołane z powodu pogody' });

    await assert.rejects(
      createSignup(db, repA, { eventId: event.id, taskId: created.task.id, guardianId: 'g2', idempotencyKey: key() }),
      (error) => error.code === 'event_cancelled' && error.status === 409,
    );
    const rows = (await db.query('SELECT count(*)::int AS n FROM event_task_signups WHERE task_id = $1', [created.task.id])).rows[0];
    assert.equal(rows.n, 1, 'the earlier signup is not erased');
  } finally { await db.close(); }
});

test('cancelling a task itself is a terminal, idempotent action and no audit metadata carries the reason', async () => {
  const db = await tasksDb();
  try {
    const event = await draftClassEvent(db, board, 'c1a');
    const created = await createTask(db, board, { eventId: event.id, title: 'Ognisko', slotsNeeded: 1, idempotencyKey: key() });
    const cancelled = await cancelTask(db, board, { eventId: event.id, taskId: created.task.id, reason: 'Nie ma już potrzeby' });
    assert.ok(cancelled.task.cancelledAt);
    const replay = await cancelTask(db, board, { eventId: event.id, taskId: created.task.id, reason: 'Inny powód' });
    assert.equal(replay.replayed, true);

    await assert.rejects(
      createSignup(db, repA, { eventId: event.id, taskId: created.task.id, guardianId: 'g1', idempotencyKey: key() }),
      (error) => error.code === 'event_cancelled',
    );

    const rows = (await db.query("SELECT metadata_json FROM audit_events WHERE action = 'event.task_cancelled'")).rows;
    assert.equal(rows.length, 1);
    assert.equal(JSON.stringify(rows[0].metadata_json).includes('Nie ma już potrzeby'), false);
  } finally { await db.close(); }
});

test('closed school year freezes new tasks and signups (409 school_year_closed)', async () => {
  const db = await tasksDb();
  try {
    const event = await draftClassEvent(db, board, 'c1a');
    const created = await createTask(db, board, { eventId: event.id, title: 'Kawiarenka', slotsNeeded: 2, idempotencyKey: key() });
    // Zamknięcie roku "na skróty", z pominięciem triggerów (jak w
    // tests/pg-year-close-finance-freeze.test.js) — interesuje nas wyłącznie
    // odpowiedź triggera zamrożenia na event_tasks/event_task_signups.
    await db.exec(`
      SET session_replication_role = replica;
      INSERT INTO school_year_closures (id, school_year_id, next_school_year_id, status, initiated_by,
        closed_by, closed_at, income_cents, expense_cents, opening_balance_cents, closing_balance_cents,
        carried_opening_balance_id, expired_grant_count)
      VALUES ('clo-1', 'year', 'next', 'closed', 'board1', 'board2', now(), 0, 0, 0, 0, 'ob-fake-1', 0);
      SET session_replication_role = origin;
    `);
    await assert.rejects(
      createTask(db, board, { eventId: event.id, title: 'Kolejne', slotsNeeded: 1, idempotencyKey: key() }),
      (error) => error.code === 'school_year_closed',
    );
    await assert.rejects(
      createSignup(db, repA, { eventId: event.id, taskId: created.task.id, guardianId: 'g1', idempotencyKey: key() }),
      (error) => error.code === 'school_year_closed',
    );
  } finally { await db.close(); }
});

test('public listing shows only public, non-cancelled tasks of a published event, with no person data', async () => {
  const db = await tasksDb();
  try {
    const event = await draftClassEvent(db, board, null, { audience: 'public' });
    const publicTask = await createTask(db, board, {
      eventId: event.id, title: 'Stoisko (publiczne)', slotsNeeded: 3, isPublic: true, idempotencyKey: key(),
    });
    const privateTask = await createTask(db, board, {
      eventId: event.id, title: 'Zadanie wewnętrzne', slotsNeeded: 2, isPublic: false, idempotencyKey: key(),
    });
    await createSignup(db, board, { eventId: event.id, taskId: publicTask.task.id, guardianId: 'g1', idempotencyKey: key() });

    // Not published yet: public endpoint 404s, same as an unknown event.
    await assert.rejects(listPublicTasks(db, { eventId: event.id }), (error) => error.code === 'event_not_found');

    await submit(db, board, { eventId: event.id, revision: 1 });
    await approve(db, board2, { eventId: event.id, revision: 1 });
    await publish(db, board2, { eventId: event.id, revision: 1 });

    const { tasks } = await listPublicTasks(db, { eventId: event.id });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, 'Stoisko (publiczne)');
    assert.equal(tasks[0].stillNeeded, 2);
    assert.equal('guardianId' in tasks[0], false);
    assert.equal('id' in privateTask.task ? tasks.some((t) => t.title === 'Zadanie wewnętrzne') : false, false);
  } finally { await db.close(); }
});

test('event_tasks and event_task_signups reject direct DELETE (immutability)', async () => {
  const db = await tasksDb();
  try {
    const event = await draftClassEvent(db, board, 'c1a');
    const created = await createTask(db, board, { eventId: event.id, title: 'Test', slotsNeeded: 1, idempotencyKey: key() });
    const signup = await createSignup(db, repA, { eventId: event.id, taskId: created.task.id, guardianId: 'g1', idempotencyKey: key() });
    await assert.rejects(db.query('DELETE FROM event_tasks WHERE id = $1', [created.task.id]), /event_tasks_are_immutable/);
    await assert.rejects(db.query('DELETE FROM event_task_signups WHERE id = $1', [signup.signup.id]), /event_task_signups_are_immutable/);
    await assert.rejects(
      db.query("UPDATE event_tasks SET title = 'x' WHERE id = $1", [created.task.id]),
      /event_tasks_are_immutable/,
    );
  } finally { await db.close(); }
});

test('double click and network retry with the same Idempotency-Key produce a single signup and a single audit event', async () => {
  const db = await tasksDb();
  try {
    const event = await draftClassEvent(db, board, 'c1a');
    const created = await createTask(db, board, { eventId: event.id, title: 'Stoisko', slotsNeeded: 3, idempotencyKey: key() });
    const sameKey = key('click');
    const results = await Promise.all([
      createSignup(db, repA, { eventId: event.id, taskId: created.task.id, guardianId: 'g1', idempotencyKey: sameKey }),
      createSignup(db, repA, { eventId: event.id, taskId: created.task.id, guardianId: 'g1', idempotencyKey: sameKey }),
    ]);
    assert.equal(results[0].signup.id, results[1].signup.id);
    assert.equal(results.filter((r) => r.replayed).length, 1);
    const again = await createSignup(db, repA, { eventId: event.id, taskId: created.task.id, guardianId: 'g1', idempotencyKey: sameKey });
    assert.equal(again.replayed, true);
    const rows = (await db.query('SELECT count(*)::int AS n FROM event_task_signups WHERE task_id = $1', [created.task.id])).rows[0];
    assert.equal(rows.n, 1);
    const audit = (await db.query("SELECT metadata_json FROM audit_events WHERE action = 'event.task_signup_created'")).rows;
    assert.equal(audit.length, 1, 'replay does not duplicate the audit event');
    const metadata = typeof audit[0].metadata_json === 'string' ? JSON.parse(audit[0].metadata_json) : audit[0].metadata_json;
    assert.equal(metadata.schoolYearId, 'year');
    assert.ok(!('guardianId' in metadata) && !('personName' in metadata), 'no personal data in audit metadata');
  } finally { await db.close(); }
});

test('siblings in 1A and 1B: each representative signs the guardian only for the event of their own class', async () => {
  const db = await tasksDb();
  try {
    // Rodzeństwo d2 (1B) i d3 (1A) z tym samym opiekunem g3.
    await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ('d3','h2','Ala','Syntetyczna')");
    await db.query("INSERT INTO student_guardians (student_id, guardian_id, contact_allowed) VALUES ('d3','g3',true)");
    await db.query("INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('e3','d3','c1a','year')");
    const eventA = await draftClassEvent(db, board, 'c1a');
    const eventB = await draftClassEvent(db, board, 'c1b');
    const taskA = await createTask(db, board, { eventId: eventA.id, title: 'Dyżur A', slotsNeeded: 2, idempotencyKey: key() });
    const taskB = await createTask(db, board, { eventId: eventB.id, title: 'Dyżur B', slotsNeeded: 2, idempotencyKey: key() });

    const a = await createSignup(db, repA, { eventId: eventA.id, taskId: taskA.task.id, guardianId: 'g3', idempotencyKey: key() });
    const b = await createSignup(db, repB, { eventId: eventB.id, taskId: taskB.task.id, guardianId: 'g3', idempotencyKey: key() });
    assert.notEqual(a.signup.id, b.signup.id);
    await assert.rejects(
      createSignup(db, repA, { eventId: eventB.id, taskId: taskB.task.id, guardianId: 'g3', idempotencyKey: key() }),
      (error) => error.status === 404,
    );
    await assert.rejects(
      createSignup(db, repB, { eventId: eventA.id, taskId: taskA.task.id, guardianId: 'g3', idempotencyKey: key() }),
      (error) => error.status === 404,
    );
  } finally { await db.close(); }
});

test('a new event revision keeps tasks and signups', async () => {
  const db = await tasksDb();
  try {
    const event = await draftClassEvent(db, board, 'c1a');
    const created = await createTask(db, board, { eventId: event.id, title: 'Bufet', slotsNeeded: 2, idempotencyKey: key() });
    await createSignup(db, repA, { eventId: event.id, taskId: created.task.id, guardianId: 'g1', idempotencyKey: key() });
    await updateDraft(db, board, { eventId: event.id, revision: event.revision, title: 'Piknik klasowy (zmieniony)' });
    const { tasks } = await listTasks(db, board, { eventId: event.id });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].confirmedCount, 1);
  } finally { await db.close(); }
});
