// #158: getMeeting czyta zebranie i jego listy z jednej migawki (REPEATABLE
// READ, READ ONLY), kolejno na jednym połączeniu. Dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestDb, seedSchoolYear, seedUser } from './helpers/pg.js';
import { getMeeting } from '../src/pg/meetings.js';

const source = readFileSync(fileURLToPath(new URL('../src/pg/meetings.js', import.meta.url)), 'utf8');
const body = source.slice(source.indexOf('export async function getMeeting('), source.indexOf('export async function createMeeting('));

test('getMeeting: jedna transakcja REPEATABLE READ, READ ONLY, bez Promise.all', () => {
  assert.match(body, /SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY/);
  assert.doesNotMatch(body, /Promise\.all/);
});

test('getMeeting: wszystkie zapytania idą przez jedną transakcję, a wynik ma te same listy', async () => {
  const db = await createTestDb();
  await seedSchoolYear(db, 'year');
  await seedUser(db, { userId: 'u' });
  await db.query(`INSERT INTO meetings (id, school_year_id, kind, title, scheduled_at, status, created_by)
    VALUES ('m-1','year','plenary','Zebranie ogólne','2026-10-05T18:00:00Z','scheduled', 'u')`);
  const seen = [];
  const spy = {
    query: (...a) => { seen.push({ scope: 'db', sql: String(a[0]) }); return db.query(...a); },
    transaction: (fn) => db.transaction((tx) => fn({
      query: (...a) => { seen.push({ scope: 'tx', sql: String(a[0]) }); return tx.query(...a); },
    })),
  };
  const actor = { userId: 'u', grants: [{ role: 'admin', classId: null, schoolYearId: 'year', expiresAt: null }], mfaVerified: true };
  const detail = await getMeeting(spy, actor, { meetingId: 'm-1' });
  assert.equal(detail.meeting.id, 'm-1');
  assert.deepEqual(detail.agenda, []);
  // SET + zebranie + osiem list (po #113: wersje porządku, zmiany terminu, zawiadomienia).
  assert.equal(seen.filter((q) => q.scope === 'tx').length, 10);
  assert.ok(seen.length > 0);
  assert.equal(seen.filter((q) => q.scope === 'db').length, 0, 'żadne zapytanie poza transakcją');
  assert.match(seen[0].sql, /SET TRANSACTION ISOLATION LEVEL REPEATABLE READ/);
  await db.close();
});
