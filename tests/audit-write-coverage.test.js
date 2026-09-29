// #184: trasy zapisu, których przypadki w macierzy uprawnień (tests/pg-authz-matrix.test.js)
// wykonują wyłącznie powtórkę idempotentną albo podgląd, mają tu scenariusz ZMIENIAJĄCY stan.
// Sprawdzamy, że udany zapis zostawia zdarzenie audytu z aktorem, typem i identyfikatorem
// obiektu oraz metadata.schoolYearId tam, gdzie wymaga tego insertAuditEvent. Dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { assertNoPii } from '../src/pg/audit.js';
import { createMemoryStorage } from '../src/storage.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const Y1 = 'y-cov-1';
const Y2 = 'y-cov-2';

async function setup() {
  const db = await createTestDb();
  await seedSchoolYear(db, Y1, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, Y2, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  await seedClass(db, { id: 'kl-cov-a', schoolYearId: Y1 });
  await seedClass(db, { id: 'kl-cov-b', schoolYearId: Y1 });
  await seedClass(db, { id: 'kl-cov-prev', schoolYearId: Y2 });
  const cookie = await seedUserSession(db, {
    userId: 'u-cov-board', roles: [{ role: 'board', schoolYearId: Y1 }, { role: 'board', schoolYearId: Y2 }], mfa: true,
  });
  const env = { db, storage: createMemoryStorage() };
  const call = async (method, path, body) => {
    const response = await handlePgRequest(request(path, { method, body, cookie }), env);
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  return { db, call };
}

async function eventsAfter(db, action) {
  const { rows } = await db.query(
    'SELECT actor_id, entity_type, entity_id, metadata_json FROM audit_events WHERE action = $1', [action],
  );
  for (const row of rows) assertNoPii(row.metadata_json);
  return rows;
}

test('POST /api/students/:id/enrollments: utworzenie i zmiana klasy zostawiają zdarzenia audytu', async () => {
  const { db, call } = await setup();
  await db.query("INSERT INTO households (id) VALUES ('hh-cov')");
  await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ('st-cov', 'hh-cov', 'Ola', 'Syntetyczna')");
  // Uczeń bez żadnego przypisania jest poza zakresem (404); ma więc przypisanie w innym roku.
  await db.query("INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('en-cov-prev', 'st-cov', 'kl-cov-prev', $1)", [Y2]);
  const body = (classId) => ({ schoolYearId: Y1, classId, effectiveOn: '2026-10-01', reason: 'Przypisanie syntetyczne' });

  const created = await call('POST', '/api/students/st-cov/enrollments', body('kl-cov-a'));
  assert.equal(created.status, 201);
  const [createdEvent] = await eventsAfter(db, 'enrollment.created');
  assert.equal(createdEvent.actor_id, 'u-cov-board');
  assert.equal(createdEvent.entity_type, 'enrollment');
  assert.equal(createdEvent.entity_id, created.json.enrollment.id);

  // Powtórka tej samej operacji (podwójne kliknięcie) nie tworzy drugiego zdarzenia.
  assert.equal((await call('POST', '/api/students/st-cov/enrollments', body('kl-cov-a'))).status, 200);
  assert.equal((await eventsAfter(db, 'enrollment.created')).length, 1);

  const moved = await call('POST', '/api/students/st-cov/enrollments', body('kl-cov-b'));
  assert.equal(moved.status, 200);
  const [changedEvent] = await eventsAfter(db, 'enrollment.class_changed');
  assert.equal(changedEvent.actor_id, 'u-cov-board');
  assert.equal(changedEvent.entity_id, created.json.enrollment.id);
  assert.equal(changedEvent.metadata_json.schoolYearId, Y1);
});

test('POST /api/ledger/categories/copy: rzeczywiste kopiowanie zostawia zdarzenie, podgląd i powtórka nie', async () => {
  const { db, call } = await setup();
  await db.query(
    `INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by)
     VALUES ('cat-cov-1', $1, 'income', 'Wpływy syntetyczne', 'u-cov-board')`, [Y2],
  );
  const copy = (dryRun) => call('POST', '/api/ledger/categories/copy', { fromSchoolYearId: Y2, toSchoolYearId: Y1, dryRun });

  assert.equal((await copy(true)).status, 200);
  assert.equal((await eventsAfter(db, 'ledger_category.copied')).length, 0);
  assert.equal((await copy(false)).status, 200);
  const [event] = await eventsAfter(db, 'ledger_category.copied');
  assert.equal(event.actor_id, 'u-cov-board');
  assert.equal(event.entity_type, 'school_year');
  assert.equal(event.entity_id, Y1);
  assert.equal((await copy(false)).status, 200);
  assert.equal((await eventsAfter(db, 'ledger_category.copied')).length, 1);
});

test('POST /api/year-close/:id/start: rozpoczęcie zostawia zdarzenie ze schoolYearId, powtórka nie', async () => {
  const { db, call } = await setup();
  const start = () => call('POST', `/api/year-close/${Y1}/start`, { nextSchoolYearId: Y2 });

  assert.equal((await start()).status, 201);
  const [event] = await eventsAfter(db, 'year_close.started');
  assert.equal(event.actor_id, 'u-cov-board');
  assert.equal(event.entity_type, 'school_year_closure');
  assert.ok(event.entity_id);
  assert.equal(event.metadata_json.schoolYearId, Y1);
  assert.equal((await start()).status, 200);
  assert.equal((await eventsAfter(db, 'year_close.started')).length, 1);
});
