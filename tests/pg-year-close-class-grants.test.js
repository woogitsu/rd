// Przydziały klasy bez school_year_id a zamknięcie roku (#201, fragment #198).
// Wyłącznie dane syntetyczne (@example.invalid).
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { handlePgRequest } from '../src/pg/app.js';
import { CHECKLIST_ITEMS } from '../src/pg/routes/year-close.js';
import { loadMigrations } from '../src/postgres-migrations.js';
import { request, seedClass, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const OLD = 'y-2024';
const NEW = 'y-2025';
const BACKFILL = '0022_role_grant_class_year.sql';
const migrationsDirectory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));

// Baza w stanie sprzed 0022 z przydziałami „legacy”, potem migracja 0022.
async function legacyDb() {
  const migrations = await loadMigrations(migrationsDirectory);
  const db = new PGlite();
  for (const migration of migrations.filter((item) => item.name < BACKFILL)) await db.exec(migration.sql);

  await seedSchoolYear(db, OLD, { startsOn: '2024-09-01', endsOn: '2025-08-31' });
  await seedSchoolYear(db, NEW, { startsOn: '2025-09-01', endsOn: '2026-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: OLD, name: '1A' });
  await seedClass(db, { id: 'c-1b', schoolYearId: OLD, name: '1B' });
  await seedClass(db, { id: 'c-2a', schoolYearId: NEW, name: '2A' });
  await db.exec(`
    INSERT INTO households (id) VALUES ('h-1'), ('h-2');
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
      ('g-1', 'h-1', 'Anna', 'Testowa', 'opiekun1@example.invalid', true),
      ('g-2', 'h-1', 'Piotr', 'Testowy', 'opiekun2@example.invalid', true),
      ('g-3', 'h-2', 'Ewa', 'Inna', 'opiekun3@example.invalid', true);
    INSERT INTO students (id, household_id, first_name, last_name) VALUES
      ('s-1', 'h-1', 'Ola', 'Testowa'), ('s-2', 'h-1', 'Jan', 'Testowy'), ('s-3', 'h-2', 'Kuba', 'Inny');
    INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES
      ('s-1', 'g-1', true, true), ('s-1', 'g-2', true, false), ('s-2', 'g-1', true, true), ('s-3', 'g-3', true, true);
    INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
      ('e-1', 's-1', 'c-1a', '${OLD}'), ('e-2', 's-2', 'c-1b', '${OLD}'), ('e-3', 's-3', 'c-2a', '${NEW}');
  `);

  const cookies = {
    admin: await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true }),
    boardA: await seedUserSession(db, { userId: 'u-board-a', roles: [{ role: 'board', schoolYearId: OLD }], mfa: true }),
    boardB: await seedUserSession(db, { userId: 'u-board-b', roles: [{ role: 'board', schoolYearId: OLD }], mfa: true }),
    boardGlobal: await seedUserSession(db, { userId: 'u-board-global', roles: [{ role: 'board' }], mfa: true }),
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: OLD }], mfa: true }),
    // Przydziały klasy bez roku (np. z D1 albo spoza API administratora).
    repLegacy: await seedUserSession(db, { userId: 'u-rep-legacy', roles: [{ role: 'representative', classId: 'c-1a' }], mfa: true }),
    // Rodzeństwo s-1/s-2 w dwóch klasach starego roku; przedstawiciel obu klas.
    repTwo: await seedUserSession(db, {
      userId: 'u-rep-two',
      roles: [{ role: 'representative', classId: 'c-1b' }, { role: 'representative', classId: 'c-2a' }],
      mfa: true,
    }),
    repNew: await seedUserSession(db, { userId: 'u-rep-new', roles: [{ role: 'representative', classId: 'c-2a' }], mfa: true }),
  };
  // Niespójny wpis spoza API: rok nowy, klasa starego roku.
  await db.query(`INSERT INTO role_grants (id, user_id, role, class_id, school_year_id)
    VALUES ('g-mismatch', 'u-rep-new', 'representative', 'c-1b', $1)`, [NEW]);
  // Cofnięty przydział bez roku: po migracji też ma rok, cofnięcie zostaje.
  await db.query(`INSERT INTO role_grants (id, user_id, role, class_id, school_year_id, revoked_at, revoked_by)
    VALUES ('g-revoked', 'u-rep-legacy', 'representative', 'c-1b', NULL, now(), 'u-admin')`);

  const nullBefore = (await db.query(
    'SELECT count(*)::int AS n FROM role_grants WHERE class_id IS NOT NULL AND school_year_id IS NULL',
  )).rows[0].n;
  await db.exec(migrations.find((item) => item.name === BACKFILL).sql);
  // Pozostałe migracje po 0022: aplikacja korzysta z obiektów z późniejszych plików (np. 0028).
  for (const migration of migrations.filter((item) => item.name > BACKFILL)) await db.exec(migration.sql);
  return { db, env: { db }, cookies, nullBefore };
}

function post(env, path, cookie, body = {}) {
  return handlePgRequest(request(path, { method: 'POST', cookie, body }), env);
}

function get(env, path, cookie) {
  return handlePgRequest(request(path, { cookie }), env);
}

async function closeOldYear(env, cookies) {
  const started = await post(env, `/api/year-close/${OLD}/start`, cookies.boardA, { nextSchoolYearId: NEW });
  assert.equal(started.status, 201);
  for (const [index, item] of CHECKLIST_ITEMS.entries()) {
    const cookie = index % 2 ? cookies.treasurer : cookies.boardA;
    const response = await post(env, `/api/year-close/${OLD}/checklist/${item}`, cookie, { note: `Potwierdzenie ${item}` });
    assert.equal(response.status, 201, item);
  }
  const closed = await post(env, `/api/year-close/${OLD}/close`, cookies.boardB);
  assert.equal(closed.status, 200);
  return closed.json();
}

// Zbiór aktywnych przydziałów opisany bez losowych identyfikatorów.
async function activeGrants(db) {
  const { rows } = await db.query(`SELECT user_id, role, class_id, school_year_id FROM role_grants
    WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
    ORDER BY user_id, role, class_id NULLS FIRST, school_year_id NULLS FIRST`);
  return rows.map((row) => `${row.user_id}|${row.role}|${row.class_id ?? '-'}|${row.school_year_id ?? '-'}`);
}

describe('zamknięcie roku a przydziały klasy bez roku', () => {
  let closeDb; let expireDb;
  let beforeClose; let closeBody; let activeBeforeClose;

  before(async () => {
    closeDb = await legacyDb();
    expireDb = await legacyDb();
    const { env, cookies } = closeDb;
    beforeClose = {
      students: (await get(env, '/api/classes/c-1a/students', cookies.repLegacy)).status,
      household: (await get(env, '/api/households/h-1', cookies.repLegacy)).status,
      sibling: (await get(env, '/api/classes/c-1b/students', cookies.repTwo)).status,
    };
    activeBeforeClose = await activeGrants(closeDb.db);
    closeBody = await closeOldYear(env, cookies);
  });
  after(async () => {
    await closeDb?.db.close();
    await expireDb?.db.close();
  });

  test('migracja 0022 uzupełnia rok z klasy i zapisuje zdarzenie audytu', async () => {
    const { db, nullBefore } = expireDb;
    assert.equal(nullBefore, 5, 'przed migracją: 4 aktywne + 1 cofnięty przydział klasy bez roku');
    const { rows: nulls } = await db.query(
      'SELECT count(*)::int AS n FROM role_grants WHERE class_id IS NOT NULL AND school_year_id IS NULL',
    );
    assert.equal(nulls[0].n, 0);
    const { rows: grants } = await db.query(
      "SELECT class_id, school_year_id, revoked_at IS NOT NULL AS revoked FROM role_grants WHERE user_id = 'u-rep-legacy' ORDER BY class_id",
    );
    assert.deepEqual(grants, [
      { class_id: 'c-1a', school_year_id: OLD, revoked: false },
      { class_id: 'c-1b', school_year_id: OLD, revoked: true },
    ]);
    const { rows: mismatch } = await db.query("SELECT school_year_id FROM role_grants WHERE id = 'g-mismatch'");
    assert.equal(mismatch[0].school_year_id, NEW, 'niespójny wpis nie jest przepisywany');
    const { rows: audit } = await db.query(
      "SELECT actor_id, metadata_json FROM audit_events WHERE action = 'role_grant.school_year_backfilled'",
    );
    assert.equal(audit.length, 5);
    assert.ok(audit.every((row) => row.actor_id === null && row.metadata_json.previousSchoolYearId === null));
    assert.equal(JSON.stringify(audit).includes('@'), false, 'audyt bez danych osobowych');

    // Po migracji: przydział klasy dostaje rok klasy, niezgodny rok jest odrzucany.
    await db.query(`INSERT INTO role_grants (id, user_id, role, class_id) VALUES ('g-new', 'u-rep-new', 'representative', 'c-2a')`);
    const { rows: fresh } = await db.query("SELECT school_year_id FROM role_grants WHERE id = 'g-new'");
    assert.equal(fresh[0].school_year_id, NEW);
    await db.query("UPDATE role_grants SET revoked_at = now(), revoked_by = 'u-admin' WHERE id = 'g-new'");
    await assert.rejects(
      db.query(`INSERT INTO role_grants (id, user_id, role, class_id, school_year_id) VALUES ('g-bad', 'u-rep-new', 'representative', 'c-2a', $1)`, [OLD]),
      /class_not_in_school_year/,
    );
  });

  test('przedstawiciel z przydziałem bez roku traci dostęp po zamknięciu', async () => {
    const { env, cookies } = closeDb;
    assert.deepEqual(beforeClose, { students: 200, household: 200, sibling: 200 });
    assert.equal(closeBody.status, 'closed');
    assert.ok([403, 404].includes((await get(env, '/api/classes/c-1a/students', cookies.repLegacy)).status));
    assert.ok([403, 404].includes((await get(env, '/api/households/h-1', cookies.repLegacy)).status));
    // Przedstawiciel dwóch klas w dwóch latach: zostaje tylko przydział nowego roku.
    assert.ok([403, 404].includes((await get(env, '/api/classes/c-1b/students', cookies.repTwo)).status));
    assert.equal((await get(env, '/api/classes/c-2a/students', cookies.repTwo)).status, 200);
    assert.equal((await get(env, '/api/classes/c-2a/students', cookies.repNew)).status, 200);

    const { rows } = await closeDb.db.query(`SELECT count(*)::int AS n FROM role_grants g
      WHERE g.class_id IN (SELECT id FROM classes WHERE school_year_id = $1)
        AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())`, [OLD]);
    assert.equal(rows[0].n, 0, 'żaden aktywny przydział klasy zamkniętego roku');
  });

  test('przydziały innego roku są nietknięte', async () => {
    const after = await activeGrants(closeDb.db);
    const keptNew = activeBeforeClose.filter((row) => row.endsWith(`|${NEW}`) && !row.includes('|c-1b|'));
    assert.ok(keptNew.length >= 2);
    for (const row of keptNew) assert.ok(after.includes(row), row);
    assert.ok(after.includes('u-admin|admin|-|-'), 'przydział bez roku i bez klasy zostaje');
  });

  test('wstawienie przydziału klasy zamkniętego roku bez school_year_id jest odrzucane', async () => {
    const { db, env, cookies } = closeDb;
    await assert.rejects(
      db.query(`INSERT INTO role_grants (id, user_id, role, class_id) VALUES ('g-late', 'u-rep-new', 'representative', 'c-1a')`),
      /school_year_closed/,
    );
    const viaApi = await post(env, '/api/admin/grants', cookies.admin, { userId: 'u-rep-new', role: 'representative', classId: 'c-1a' });
    assert.equal(viaApi.status, 409);
    assert.equal((await viaApi.json()).error, 'school_year_closed');
    // Podwójne kliknięcie: druga próba ma ten sam wynik i nie zostawia wiersza.
    const again = await post(env, '/api/admin/grants', cookies.admin, { userId: 'u-rep-new', role: 'representative', classId: 'c-1a', schoolYearId: OLD });
    assert.equal(again.status, 409);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM role_grants WHERE user_id = 'u-rep-new' AND class_id = 'c-1a'");
    assert.equal(rows[0].n, 0);
  });

  test('expire-grants i zamknięcie wygaszają ten sam zbiór przydziałów', async () => {
    const { env, cookies, db } = expireDb;
    const expired = await post(env, `/api/admin/school-years/${OLD}/expire-grants`, cookies.admin, { confirm: OLD });
    assert.equal(expired.status, 200);
    const body = await expired.json();
    assert.equal(body.expired, closeBody.expiredGrantCount);
    assert.deepEqual(await activeGrants(db), await activeGrants(closeDb.db));
    assert.equal(
      (await db.query("SELECT expires_at IS NOT NULL AS expired FROM role_grants WHERE id = 'g-mismatch'")).rows[0].expired,
      true,
      'niespójny przydział (klasa starego roku) wygasa w obu ścieżkach',
    );
  });

  test('ponowienie zamknięcia nie tworzy drugiego zdarzenia role_grant.expired', async () => {
    const { db, env, cookies } = closeDb;
    const count = async () => (await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'role_grant.expired'")).rows[0].n;
    const before = await count();
    assert.equal(before, closeBody.expiredGrantCount);
    const replay = await post(env, `/api/year-close/${OLD}/close`, cookies.boardGlobal);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).replayed, true);
    assert.equal(await count(), before);
  });
});
