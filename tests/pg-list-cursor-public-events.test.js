// Kursor keyset dla GET /api/public/events (#159). Wyłącznie dane syntetyczne.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const YEAR = 'y-pe';
const OTHER_YEAR = 'y-pe2';
const EVENTS = 230;
let db;
let env;

async function call(path, cookie) {
  const response = await handlePgRequest(request(path, cookie ? { cookie } : {}), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

async function walk(path, limit) {
  const ids = [];
  let cursor = null;
  let pages = 0;
  do {
    const query = new URLSearchParams();
    if (limit) query.set('limit', String(limit));
    if (cursor) query.set('cursor', cursor);
    const res = await call(`${path}${path.includes('?') ? '&' : '?'}${query}`);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    ids.push(...res.data.events.map((event) => event.id));
    assert.equal(res.data.truncated, res.data.nextCursor !== null);
    cursor = res.data.nextCursor;
    pages += 1;
    assert.ok(pages < 100);
  } while (cursor);
  return { ids, pages };
}

// Publikacja bez zatwierdzenia jest dozwolona tylko w trybie przywracania (0095).
async function insertEvent(id, year, begins, visibility) {
  const audience = visibility === 'published' ? 'public' : 'internal';
  await db.transaction(async (tx) => {
    await tx.query("SELECT set_config('rd.restore', 'on', true)");
    await tx.query(
    `INSERT INTO events (id, school_year_id, title, begins_at, visibility, audience, created_by, published_at)
     VALUES ($1, $2, 'Wydarzenie testowe', $3::timestamptz, $4, $5, 'u-adm', CASE WHEN $4 = 'published' THEN now() END)`,
    [id, year, begins, visibility, audience],
    );
  });
}

before(async () => {
  db = await createTestDb();
  env = { db };
  await seedSchoolYear(db, YEAR);
  await seedSchoolYear(db, OTHER_YEAR);
  await seedUserSession(db, { userId: 'u-adm', roles: [{ role: 'admin' }], mfa: true });
  // Co trzecie wydarzenie ma ten sam początek — remis rozstrzyga id.
  for (let i = 1; i <= EVENTS; i += 1) {
    const hour = String(Math.floor(i / 3) % 24).padStart(2, '0');
    const day = String(1 + Math.floor(Math.floor(i / 3) / 24)).padStart(2, '0');
    await insertEvent(`pe-${String(i).padStart(4, '0')}`, YEAR, `2027-01-${day}T${hour}:00:00Z`, 'published');
  }
  await insertEvent('pe-other', OTHER_YEAR, '2027-02-01T10:00:00Z', 'published');
  await insertEvent('pe-internal', YEAR, '2027-01-01T09:00:00Z', 'internal');
});

after(async () => { await db.close(); });

test('public events: all pages without duplicates or gaps, ties broken by id', async () => {
  const { ids, pages } = await walk(`/api/public/events?schoolYearId=${YEAR}`, 40);
  assert.ok(pages >= 6);
  assert.equal(ids.length, EVENTS);
  assert.equal(new Set(ids).size, EVENTS);
  assert.ok(!ids.includes('pe-other'));
  assert.ok(!ids.includes('pe-internal'));
});

test('public events: default page signals truncation instead of cutting silently', async () => {
  const res = await call(`/api/public/events?schoolYearId=${YEAR}`);
  assert.equal(res.status, 200);
  assert.equal(res.data.events.length, 100);
  assert.equal(res.data.limit, 100);
  assert.equal(res.data.truncated, true);
  assert.ok(res.data.nextCursor);
});

test('public events: same cursor twice gives the same page; a later event does not repeat rows', async () => {
  const first = await call(`/api/public/events?schoolYearId=${YEAR}&limit=50`);
  const url = `/api/public/events?schoolYearId=${YEAR}&limit=50&cursor=${first.data.nextCursor}`;
  const a = await call(url);
  const b = await call(url);
  assert.ok(a.data.events.length > 0);
  assert.deepEqual(a.data.events.map((e) => e.id), b.data.events.map((e) => e.id));
  await insertEvent('pe-late', YEAR, '2030-01-01T10:00:00Z', 'published');
  const seen = new Set(first.data.events.map((e) => e.id));
  assert.deepEqual(a.data.events.filter((e) => seen.has(e.id)), []);
  const c = await call(url);
  assert.deepEqual(c.data.events.map((e) => e.id), a.data.events.map((e) => e.id));
});

test('public events: invalid limit and foreign or broken cursor are rejected', async () => {
  const first = await call(`/api/public/events?schoolYearId=${YEAR}&limit=10`);
  assert.ok(first.data.nextCursor);
  const paths = [
    '/api/public/events?limit=0',
    '/api/public/events?limit=201',
    '/api/public/events?limit=abc',
    `/api/public/events?schoolYearId=${OTHER_YEAR}&cursor=${first.data.nextCursor}`,
    `/api/public/events?schoolYearId=${YEAR}&cursor=%24%24`,
  ];
  assert.equal(paths.length, 5);
  for (const path of paths) {
    const res = await call(path);
    assert.equal(res.status, 400, path);
    assert.match(res.data.error, /^invalid_(limit|cursor)$/);
  }
});

test('public events: a class representative sees exactly the public rows', async () => {
  const cookie = await seedUserSession(db, {
    userId: 'u-rep-pe', roles: [{ role: 'representative', classId: 'c-x', schoolYearId: YEAR }],
  });
  const anonymous = await call(`/api/public/events?schoolYearId=${YEAR}&limit=200`);
  const asRep = await call(`/api/public/events?schoolYearId=${YEAR}&limit=200`, cookie);
  assert.ok(anonymous.data.events.length > 0);
  assert.deepEqual(asRep.data.events.map((e) => e.id), anonymous.data.events.map((e) => e.id));
  assert.deepEqual(asRep.data.events.filter((e) => e.id === 'pe-internal'), []);
});
