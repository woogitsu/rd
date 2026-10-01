// #133: dziennik odczytu danych dzieci i opiekunów (lista klasy, karta
// gospodarstwa, kartki, lista wpłat). Wyłącznie dane syntetyczne (.invalid).
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUserSession, seedPublishedPrivacyNotice } from './helpers/pg.js';

const Y1 = 'y-2026';

async function seedFamilies(db) {
  await seedSchoolYear(db, Y1, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: Y1, name: '1A' });
  await seedClass(db, { id: 'c-2b', schoolYearId: Y1, name: '2B' });
  await db.exec(`
    INSERT INTO households (id) VALUES ('h-1'), ('h-2');
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
      ('g-1', 'h-1', 'Anna', 'Testowa', 'opiekun1@example.invalid', true);
    INSERT INTO students (id, household_id, first_name, last_name) VALUES
      ('s-1', 'h-1', 'Ola', 'Testowa'), ('s-2', 'h-2', 'Jan', 'Inny');
    INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact)
      VALUES ('s-1', 'g-1', true, true);
    INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
      ('e-1', 's-1', 'c-1a', '${Y1}'), ('e-2', 's-2', 'c-2b', '${Y1}');
  `);
}

let shared;
async function setup() {
  if (shared) return shared;
  const db = await createTestDb();
  await seedPublishedPrivacyNotice(db); // #145: kampanie i kartki wymagają opublikowanej informacji
  await seedFamilies(db);
  const env = { db };
  const call = async (path, options = {}) => {
    const response = await handlePgRequest(request(path, options), env);
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };
  const cookies = {
    repA: await seedUserSession(db, { userId: 'u-rep-a', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: Y1 }] }),
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: Y1 }], mfa: true }),
  };
  shared = { db, call, cookies };
  return shared;
}

async function logRows(db, actorId, accessKind) {
  const { rows } = await db.query(
    `SELECT access_kind, class_id, household_id, outcome, row_count, hit_count
       FROM data_access_log WHERE actor_id = $1 AND access_kind = $2 ORDER BY occurred_at`,
    [actorId, accessKind],
  );
  return rows;
}

describe('dziennik odczytu danych rodzin (#133)', () => {
  after(async () => { await shared?.db.close(); shared = null; });

  test('lista klasy: odczyt zapisuje wiersz, klasa poza zakresem — not_found bez ujawniania istnienia', async () => {
    const { db, call, cookies } = await setup();
    const own = await call('/api/classes/c-1a/students', { cookie: cookies.repA });
    assert.equal(own.status, 200);
    const other = await call('/api/classes/c-2b/students', { cookie: cookies.repA });
    assert.equal(other.status, 404);
    const rows = await logRows(db, 'u-rep-a', 'class_students');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => [r.class_id, r.outcome]).sort(), [['c-1a', 'ok'], ['c-2b', 'not_found']]);
    assert.equal(Number(rows.find((r) => r.class_id === 'c-1a').row_count), 1);
  });

  test('karta gospodarstwa: odczyt widoczny w zakresie zapisuje household_id; brak PII w wierszu', async () => {
    const { db, call, cookies } = await setup();
    const res = await call('/api/households/h-1', { cookie: cookies.repA });
    assert.equal(res.status, 200);
    const rows = await logRows(db, 'u-rep-a', 'household_card');
    const own = rows.find((r) => r.household_id === 'h-1');
    assert.ok(own);
    assert.equal(own.outcome, 'ok');
  });

  test('podwójne kliknięcie / odświeżenie w oknie 5 minut = jeden wiersz z licznikiem', async () => {
    const { db, call, cookies } = await setup();
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await call('/api/households/h-1', { cookie: cookies.repA })).status, 200);
    }
    const rows = await logRows(db, 'u-rep-a', 'household_card');
    const own = rows.filter((r) => r.household_id === 'h-1' && r.outcome === 'ok');
    assert.equal(own.length, 1);
    assert.ok(Number(own[0].hit_count) >= 5);
  });

  test('lista wpłat: rola finansowa zapisuje payment_list', async () => {
    const { db, call, cookies } = await setup();
    const res = await call(`/api/payments?schoolYearId=${Y1}`, { cookie: cookies.treasurer });
    assert.equal(res.status, 200);
    const rows = await logRows(db, 'u-treasurer', 'payment_list');
    assert.equal(rows.length >= 1, true);
    assert.equal(rows[0].outcome, 'ok');
  });

  test('kartki: odczyt zapisuje print_cards dla klasy', async () => {
    const { db, call, cookies } = await setup();
    const res = await call(`/api/print/cards?schoolYearId=${Y1}&classId=c-1a`, { cookie: cookies.repA });
    assert.equal(res.status, 200);
    const rows = await logRows(db, 'u-rep-a', 'print_cards');
    assert.equal(rows.some((r) => r.class_id === 'c-1a' && r.outcome === 'ok'), true);
  });

  test('wiersz dziennika nie zawiera adresu e-mail ani imienia/nazwiska', async () => {
    const { db, call, cookies } = await setup();
    await call('/api/households/h-1', { cookie: cookies.repA });
    const { rows } = await db.query('SELECT * FROM data_access_log');
    const text = JSON.stringify(rows);
    assert.doesNotMatch(text, /@/);
    assert.doesNotMatch(text, /Anna|Testowa|Ola/);
  });

  test('dziennik odczytu jest tylko do dopisywania: UPDATE innego pola i DELETE są odrzucane', async () => {
    const { db, call, cookies } = await setup();
    await call('/api/households/h-1', { cookie: cookies.repA });
    const { rows } = await db.query(`SELECT id FROM data_access_log WHERE household_id = 'h-1' LIMIT 1`);
    const id = rows[0].id;
    await assert.rejects(
      db.query('UPDATE data_access_log SET outcome = $2 WHERE id = $1', [id, 'not_found']),
      /data_access_log_entry_immutable/,
    );
    await assert.rejects(
      db.query('DELETE FROM data_access_log WHERE id = $1', [id]),
      /data_access_log_cannot_be_deleted/,
    );
  });
});
