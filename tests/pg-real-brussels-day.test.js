// Daty dzienne liczone z czasu (timestamptz) w strefie Europe/Brussels, niezależnie
// od TimeZone sesji i serwera PostgreSQL (wskazanie właściciela 2026-10-02).
// Plik wymaga RD_TEST_PG_URL (npm run test:pg-real -- tests/pg-real-brussels-day.test.js).
// Dane wyłącznie syntetyczne (@example.invalid).
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { brusselsDateSql, brusselsDaySql, brusselsStartOfDaySql, SCHOOL_TIME_ZONE } from '../src/pg/today.js';
import { createRealTestDb, request, seedClass, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';

const skip = process.env.RD_TEST_PG_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';
const SESSION_ZONES = ['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/New_York'];
// [chwila UTC, oczekiwany dzień brukselski]
const CASES = [
  ['2026-09-10T23:30:00Z', '2026-09-11'], // lato (UTC+2): 01:30 następnego dnia
  ['2026-09-10T21:59:00Z', '2026-09-10'], // lato: 23:59 tego samego dnia
  ['2026-09-10T22:00:00Z', '2026-09-11'], // lato: dokładnie północ
  ['2026-01-15T23:30:00Z', '2026-01-16'], // zima (UTC+1): 00:30 następnego dnia
  ['2026-01-15T22:59:00Z', '2026-01-15'], // zima: 23:59 tego samego dnia
];

test('stała strefy szkoły to Europe/Brussels', () => {
  assert.equal(SCHOOL_TIME_ZONE, 'Europe/Brussels');
});

for (const zone of SESSION_ZONES) test(`helpery SQL dają dzień brukselski przy TimeZone sesji ${zone}`, { skip }, async () => {
  const db = await createRealTestDb();
  try {
    await db.transaction(async (tx) => {
      await tx.query(`SET LOCAL TIME ZONE '${zone}'`);
      assert.equal((await tx.query('SHOW TIME ZONE')).rows[0].TimeZone, zone);
      for (const [instant, day] of CASES) {
        const { rows } = await tx.query(
          `SELECT ${brusselsDaySql('$1::timestamptz')} AS d, (${brusselsDateSql('$1::timestamptz')})::text AS dt`, [instant],
        );
        assert.equal(rows[0].d, day, `${instant} @ ${zone}`);
        assert.equal(rows[0].dt, day, `${instant} @ ${zone} (DATE)`);
      }
      // Początek dnia brukselskiego: 2026-09-11 00:00 Bruksela = 2026-09-10T22:00Z; zimą +1h.
      const { rows } = await tx.query(
        `SELECT ${brusselsStartOfDaySql("'2026-09-11'::date")} = '2026-09-10T22:00:00Z'::timestamptz AS summer,
                ${brusselsStartOfDaySql("'2026-01-16'::date")} = '2026-01-15T23:00:00Z'::timestamptz AS winter`,
      );
      assert.equal(rows[0].summer, true);
      assert.equal(rows[0].winter, true);
    });
  } finally { await db.close(); }
});

// Opakowanie: każde zapytanie i transakcja aplikacji działa z wybraną TimeZone sesji
// (helper testowy przypina UTC opcją startową, więc zmieniamy ją przez SET LOCAL).
function inSessionZone(db, zone) {
  const set = (tx) => tx.query(`SET LOCAL TIME ZONE '${zone}'`);
  return {
    ...db,
    query: (sql, params) => db.transaction(async (tx) => { await set(tx); return tx.query(sql, params); }),
    transaction: (fn) => db.transaction(async (tx) => { await set(tx); return fn(tx); }),
  };
}

for (const zone of SESSION_ZONES) test(`class-coverage: logowanie 23:30 UTC latem to dzień brukselski następnego dnia (TimeZone sesji ${zone})`, { skip }, async () => {
  const db = await createRealTestDb();
  try {
    const Y = 'y-2026';
    await seedSchoolYear(db, Y, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
    await seedClass(db, { id: 'c-1a', schoolYearId: Y, name: '1A' });
    const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
    await seedUser(db, { userId: 'u-rep-late' });
    await db.query(`INSERT INTO role_grants (id, user_id, role, class_id, school_year_id, granted_by)
      VALUES ('g-late', 'u-rep-late', 'representative', 'c-1a', $1, 'u-admin')`, [Y]);
    await db.query(`INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at)
      VALUES ('s-late', 'u-rep-late', repeat('a', 64), '2026-09-10T23:30:00Z', now() + interval '1 hour')`);
    const env = { db: inSessionZone(db, zone) };
    const response = await handlePgRequest(request(`/api/admin/class-coverage?schoolYearId=${Y}`, { cookie: admin }), env);
    assert.equal(response.status, 200);
    const data = await response.json();
    const row = data.classes.find((c) => c.id === 'c-1a');
    assert.ok(row, 'klasa 1A jest w odpowiedzi');
    assert.equal(row.lastRepresentativeLoginOn, '2026-09-11');
  } finally { await db.close(); }
});
