// Zadania i zapisy wolontariuszy (issue #142, Etap 1). Wyłącznie syntetyczne dane.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../src/postgres-migrations.js';
import {
  cancel, cancelTask, createDraft, createSignup, createTask, listPublic, listPublicTasks, listTaskCandidates, listTasks,
  publish, approve, submit, updateDraft, withdrawSignup,
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

// ---------- panel: lista opiekunów do wyboru, okno czasu, strona publiczna (#142) ----------

test('candidates: representative sees only current guardians of their own class, names only; read is logged', async () => {
  const db = await tasksDb();
  try {
    const eventA = await draftClassEvent(db, board, 'c1a');
    const eventB = await draftClassEvent(db, board, 'c1b');
    const result = await listTaskCandidates(db, repA, { eventId: eventA.id });
    assert.equal(result.classId, 'c1a');
    assert.deepEqual(result.guardians, [{ id: 'g2', name: 'Opiekun Dwa' }, { id: 'g1', name: 'Opiekun Jeden' }]);
    assert.deepEqual(Object.keys(result.guardians[0]).sort(), ['id', 'name'], 'bez e-maili, dzieci i gospodarstw');
    // Wydarzenie innej klasy: ten sam 404 co nieznane (SR-07).
    await assert.rejects(listTaskCandidates(db, repA, { eventId: eventB.id }), (error) => error.status === 404 && error.code === 'event_not_found');
    // Przedstawiciel nie przełączy klasy parametrem.
    await assert.rejects(listTaskCandidates(db, repA, { eventId: eventA.id, classId: 'c1b' }), (error) => error.code === 'invalid_class');
    const log = (await db.query("SELECT actor_id, access_kind, class_id, outcome, row_count FROM data_access_log WHERE actor_id = 'repa'")).rows;
    assert.deepEqual(log.map((r) => [r.access_kind, r.class_id, r.outcome, Number(r.row_count)]), [['class_students', 'c1a', 'ok', 2]]);
  } finally { await db.close(); }
});

test('candidates for a school-wide event: board must pick a class of the event year', async () => {
  const db = await tasksDb();
  try {
    const event = await draftClassEvent(db, board, null);
    await assert.rejects(listTaskCandidates(db, board, { eventId: event.id }), (error) => error.code === 'class_required');
    await assert.rejects(listTaskCandidates(db, board, { eventId: event.id, classId: 'nope' }), (error) => error.code === 'class_not_found' && error.status === 404);
    const result = await listTaskCandidates(db, board, { eventId: event.id, classId: 'c1b' });
    assert.deepEqual(result.guardians, [{ id: 'g3', name: 'Opiekun Trzy' }]);
    await assert.rejects(listTaskCandidates(db, repA, { eventId: event.id, classId: 'c1a' }), (error) => error.status === 404);
  } finally { await db.close(); }
});

test('ended guardian relation or a child who left the class: not a candidate and cannot be signed up by the representative', async () => {
  const db = await tasksDb();
  try {
    const event = await draftClassEvent(db, board, 'c1a');
    const created = await createTask(db, board, { eventId: event.id, title: 'Dyżur', slotsNeeded: 5, idempotencyKey: key() });
    // g2: relacja z d1 zakończona wczoraj; nowe dziecko d4 (g4) odeszło z klasy wczoraj.
    await db.query("UPDATE student_guardians SET ends_on = CURRENT_DATE - 1 WHERE guardian_id = 'g2'");
    await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ('d4','h2','Ewa','Syntetyczna')");
    await db.query("INSERT INTO guardians (id, household_id, first_name, last_name) VALUES ('g4','h2','Opiekun','Cztery')");
    await db.query("INSERT INTO student_guardians (student_id, guardian_id, contact_allowed) VALUES ('d4','g4',true)");
    await db.query("INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('e4','d4','c1a','year')");
    await db.query("UPDATE enrollments SET ended_on = CURRENT_DATE - 1, ended_at = now(), ended_reason = 'Odejście syntetyczne' WHERE id = 'e4'");

    const { guardians } = await listTaskCandidates(db, repA, { eventId: event.id });
    assert.deepEqual(guardians.map((g) => g.id), ['g1']);
    for (const guardianId of ['g2', 'g4']) {
      await assert.rejects(
        createSignup(db, repA, { eventId: event.id, taskId: created.task.id, guardianId, idempotencyKey: key() }),
        (error) => error.code === 'guardian_outside_class',
        guardianId,
      );
    }
  } finally { await db.close(); }
});

test('moving the event time outside a task window keeps the task and signups and is shown in the PATCH response and the list', async () => {
  const db = await tasksDb();
  try {
    const event = await draftClassEvent(db, board, 'c1a');
    const inside = await createTask(db, board, { eventId: event.id, title: 'Bez godzin', slotsNeeded: 2, idempotencyKey: key() });
    const timed = await createTask(db, board, {
      eventId: event.id, title: 'Rozstawienie stołów', slotsNeeded: 2, startsAt: '2026-11-12T10:00', endsAt: '2026-11-12T11:00', idempotencyKey: key(),
    });
    await createSignup(db, repA, { eventId: event.id, taskId: timed.task.id, guardianId: 'g1', idempotencyKey: key() });
    const moved = await updateDraft(db, repA, { eventId: event.id, revision: event.revision, startsAt: '2026-11-12T12:00', endsAt: '2026-11-12T16:00' });
    assert.deepEqual(moved.tasksOutsideEventTime, [{ id: timed.task.id, title: 'Rozstawienie stołów' }]);
    const { tasks } = await listTasks(db, repA, { eventId: event.id });
    assert.deepEqual(tasks.map((t) => [t.id, t.outsideEventTime, t.confirmedCount]), [[inside.task.id, false, 0], [timed.task.id, true, 1]]);
    // Powtórzenie tej samej zmiany (podwójne kliknięcie) też wykazuje zadanie.
    const replay = await updateDraft(db, repA, { eventId: event.id, revision: event.revision, startsAt: '2026-11-12T12:00', endsAt: '2026-11-12T16:00' });
    assert.equal(replay.replayed, true);
    assert.equal(replay.tasksOutsideEventTime.length, 1);
    // Odwołane zadanie nie jest już wykazywane.
    await cancelTask(db, repA, { eventId: event.id, taskId: timed.task.id, reason: 'Zmiana godzin' });
    const after = await updateDraft(db, repA, { eventId: event.id, revision: moved.event.revision, title: 'Piknik (nowy tytuł)' });
    assert.deepEqual(after.tasksOutsideEventTime, []);
  } finally { await db.close(); }
});

test('public events list carries only public tasks as { id, title, stillNeeded }; none for internal or cancelled', async () => {
  const db = await tasksDb();
  try {
    const event = await draftClassEvent(db, board, null, { audience: 'public' });
    const pub = await createTask(db, board, { eventId: event.id, title: 'Stoisko (publiczne)', slotsNeeded: 2, isPublic: true, idempotencyKey: key() });
    await createTask(db, board, { eventId: event.id, title: 'Zadanie wewnętrzne', slotsNeeded: 2, idempotencyKey: key() });
    await createSignup(db, board, { eventId: event.id, taskId: pub.task.id, guardianId: 'g1', idempotencyKey: key() });
    await submit(db, board, { eventId: event.id, revision: 1 });
    await approve(db, board2, { eventId: event.id, revision: 1 });
    await publish(db, board2, { eventId: event.id, revision: 1 });

    const { events } = await listPublic(db, {});
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].volunteerTasks, [{ id: pub.task.id, title: 'Stoisko (publiczne)', stillNeeded: 1 }]);
    const text = JSON.stringify(events);
    for (const secret of ['g1', 'Opiekun', 'Zadanie wewnętrzne', 'board1']) assert.ok(!text.includes(secret), secret);

    await cancel(db, board, { eventId: event.id, revision: 1, reason: 'Odwołanie syntetyczne' });
    const { events: afterCancel } = await listPublic(db, {});
    assert.deepEqual(afterCancel[0].volunteerTasks, []);
  } finally { await db.close(); }
});

// ---------- granice ról przy wycofaniu, odwołaniu zadania i kandydatach ----------

test('representative of another class and a treasurer cannot withdraw, cancel, create or list candidates for a class event task', async () => {
  const db = await tasksDb();
  try {
    const eventA = await draftClassEvent(db, board, 'c1a');
    const task = await createTask(db, board, { eventId: eventA.id, title: 'Dyżur', slotsNeeded: 2, idempotencyKey: key() });
    const signup = await createSignup(db, repA, { eventId: eventA.id, taskId: task.task.id, guardianId: 'g1', idempotencyKey: key() });
    const treasurer = { userId: 'board2', grants: [{ role: 'treasurer', classId: null, schoolYearId: null }], mfaVerified: true };

    for (const actor of [repB, treasurer]) {
      const denied = (error) => ['event_not_found', 'forbidden'].includes(error.code) && [403, 404].includes(error.status);
      await assert.rejects(withdrawSignup(db, actor, { eventId: eventA.id, taskId: task.task.id, signupId: signup.signup.id }), denied);
      await assert.rejects(cancelTask(db, actor, { eventId: eventA.id, taskId: task.task.id, reason: 'Odwołanie syntetyczne' }), denied);
      await assert.rejects(createTask(db, actor, { eventId: eventA.id, title: 'Obce zadanie', slotsNeeded: 1, idempotencyKey: key() }), denied);
      await assert.rejects(listTaskCandidates(db, actor, { eventId: eventA.id }), denied);
    }
    const { tasks } = await listTasks(db, board, { eventId: eventA.id });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].confirmedCount, 1, 'the signup was not withdrawn by the other class');
  } finally { await db.close(); }
});

test('withdrawal cannot reach a signup of another event through a mismatched event id in the path', async () => {
  const db = await tasksDb();
  try {
    const eventA = await draftClassEvent(db, board, 'c1a');
    const eventB = await draftClassEvent(db, board, 'c1b');
    const taskA = await createTask(db, board, { eventId: eventA.id, title: 'Dyżur A', slotsNeeded: 1, idempotencyKey: key() });
    const signupA = await createSignup(db, repA, { eventId: eventA.id, taskId: taskA.task.id, guardianId: 'g1', idempotencyKey: key() });

    // repB legitimately owns event B but supplies task and signup ids of event A.
    await assert.rejects(
      withdrawSignup(db, repB, { eventId: eventB.id, taskId: taskA.task.id, signupId: signupA.signup.id }),
      (error) => error.code === 'event_task_signup_not_found' && error.status === 404,
    );
    const { rows } = await db.query('SELECT status FROM event_task_signups WHERE id = $1', [signupA.signup.id]);
    assert.equal(rows[0].status, 'confirmed');
    const { rows: audits } = await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'event.task_signup_withdrawn'");
    assert.equal(audits[0].n, 0);
  } finally { await db.close(); }
});

// ---- Granice zadań i zapisów: zadanie musi należeć do wydarzenia z adresu ----

async function taskCounts(db) {
  const cancelled = (await db.query('SELECT count(*)::int AS n FROM event_tasks WHERE cancelled_at IS NOT NULL')).rows[0].n;
  const signups = (await db.query('SELECT count(*)::int AS n FROM event_task_signups')).rows[0].n;
  return { cancelled, signups };
}

test('task of another event in the URL: signup and cancel are refused with 404 and change nothing (board and representative)', async () => {
  const db = await tasksDb();
  try {
    const eventA = await draftClassEvent(db, board, 'c1a');
    const eventB = await draftClassEvent(db, board, 'c1b');
    const taskB = (await createTask(db, board, { eventId: eventB.id, title: 'Zadanie klasy B', slotsNeeded: 2, idempotencyKey: key() })).task;
    const before = await taskCounts(db);
    const notFound = (error) => error.code === 'event_task_not_found' && error.status === 404;

    // repA widzi wydarzenie A (własna klasa), ale podaje zadanie wydarzenia B (cudza klasa).
    await assert.rejects(createSignup(db, repA, { eventId: eventA.id, taskId: taskB.id, guardianId: 'g1', idempotencyKey: key() }), notFound);
    await assert.rejects(createSignup(db, board, { eventId: eventA.id, taskId: taskB.id, guardianId: 'g3', idempotencyKey: key() }), notFound);
    await assert.rejects(cancelTask(db, repA, { eventId: eventA.id, taskId: taskB.id, reason: 'Próba z cudzego wydarzenia' }), notFound);
    await assert.rejects(cancelTask(db, board, { eventId: eventA.id, taskId: taskB.id, reason: 'Próba z cudzego wydarzenia' }), notFound);

    assert.deepEqual(await taskCounts(db), before, 'no signup created, no task cancelled');
    // Adres wydarzenia B jest niedostępny dla repA — ten sam 404 co dla nieistniejącego.
    await assert.rejects(
      createSignup(db, repA, { eventId: eventB.id, taskId: taskB.id, guardianId: 'g3', idempotencyKey: key() }),
      (error) => error.code === 'event_not_found' && error.status === 404,
    );
    // Lista zadań wydarzenia A nie zawiera zadania wydarzenia B.
    const listed = await listTasks(db, repA, { eventId: eventA.id });
    assert.equal(listed.tasks.some((task) => task.id === taskB.id), false);
  } finally { await db.close(); }
});

test('a task idempotency key reused for another event does not return the foreign task', async () => {
  const db = await tasksDb();
  try {
    const eventA = await draftClassEvent(db, board, 'c1a');
    const eventB = await draftClassEvent(db, board, 'c1b');
    const sharedKey = key('shared');
    await createTask(db, board, { eventId: eventB.id, title: 'Zadanie klasy B', slotsNeeded: 1, idempotencyKey: sharedKey });
    await assert.rejects(
      createTask(db, repA, { eventId: eventA.id, title: 'Zadanie klasy B', slotsNeeded: 1, idempotencyKey: sharedKey }),
      (error) => error.code === 'idempotency_conflict' && error.status === 409,
    );
    assert.equal((await listTasks(db, repA, { eventId: eventA.id })).tasks.length, 0);
  } finally { await db.close(); }
});

test('cancelled event accepts no new tasks (409 event_cancelled); replay of an earlier task creation still works', async () => {
  const db = await tasksDb();
  try {
    const event = await draftClassEvent(db, board, 'c1a');
    const replayKey = key();
    await createTask(db, board, { eventId: event.id, title: 'Parking', slotsNeeded: 1, idempotencyKey: replayKey });
    await cancel(db, board, { eventId: event.id, revision: 1, reason: 'Odwołane z powodu pogody' });

    await assert.rejects(
      createTask(db, board, { eventId: event.id, title: 'Nowe zadanie', slotsNeeded: 1, idempotencyKey: key() }),
      (error) => error.code === 'event_cancelled' && error.status === 409,
    );
    assert.equal((await db.query('SELECT count(*)::int AS n FROM event_tasks')).rows[0].n, 1);
    const replay = await createTask(db, board, { eventId: event.id, title: 'Parking', slotsNeeded: 1, idempotencyKey: replayKey });
    assert.equal(replay.replayed, true);
  } finally { await db.close(); }
});

test('re-signup of a withdrawn person is refused for a full task, a cancelled task and a cancelled event', async () => {
  const db = await tasksDb();
  try {
    const event = await draftClassEvent(db, board, 'c1a');
    const full = (await createTask(db, board, { eventId: event.id, title: 'Jedno miejsce', slotsNeeded: 1, idempotencyKey: key() })).task;
    const toCancel = (await createTask(db, board, { eventId: event.id, title: 'Do odwołania', slotsNeeded: 2, idempotencyKey: key() })).task;
    const open = (await createTask(db, board, { eventId: event.id, title: 'Do końca', slotsNeeded: 2, idempotencyKey: key() })).task;

    const g1Full = (await createSignup(db, repA, { eventId: event.id, taskId: full.id, guardianId: 'g1', idempotencyKey: key() })).signup;
    await withdrawSignup(db, repA, { eventId: event.id, taskId: full.id, signupId: g1Full.id });
    await createSignup(db, repA, { eventId: event.id, taskId: full.id, guardianId: 'g2', idempotencyKey: key() });
    await assert.rejects(
      createSignup(db, repA, { eventId: event.id, taskId: full.id, guardianId: 'g1', idempotencyKey: key() }),
      (error) => error.code === 'task_full' && error.status === 409,
    );

    const g1Cancel = (await createSignup(db, repA, { eventId: event.id, taskId: toCancel.id, guardianId: 'g1', idempotencyKey: key() })).signup;
    await withdrawSignup(db, repA, { eventId: event.id, taskId: toCancel.id, signupId: g1Cancel.id });
    await cancelTask(db, board, { eventId: event.id, taskId: toCancel.id, reason: 'Nie ma już potrzeby' });
    await assert.rejects(
      createSignup(db, repA, { eventId: event.id, taskId: toCancel.id, guardianId: 'g1', idempotencyKey: key() }),
      (error) => error.code === 'event_cancelled' && error.status === 409,
    );

    const g1Open = (await createSignup(db, repA, { eventId: event.id, taskId: open.id, guardianId: 'g1', idempotencyKey: key() })).signup;
    await withdrawSignup(db, repA, { eventId: event.id, taskId: open.id, signupId: g1Open.id });
    await cancel(db, board, { eventId: event.id, revision: 1, reason: 'Odwołane z powodu pogody' });
    await assert.rejects(
      createSignup(db, repA, { eventId: event.id, taskId: open.id, guardianId: 'g1', idempotencyKey: key() }),
      (error) => error.code === 'event_cancelled' && error.status === 409,
    );

    const states = (await db.query("SELECT task_id, guardian_id, status FROM event_task_signups WHERE guardian_id = 'g1' ORDER BY task_id")).rows;
    assert.equal(states.length, 3);
    assert.equal(states.filter((row) => row.status === 'withdrawn').length, 3, 'refused re-signups leave the withdrawn rows untouched');
  } finally { await db.close(); }
});
