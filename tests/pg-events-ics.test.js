import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approve, cancel, createDraft, handle, listPublic, publish, submit, updateDraft,
} from '../src/pg/events.js';
import { createPgliteTestDb } from './helpers/pg.js';

const ORIGIN = 'https://rd.example.invalid';

const board1 = { userId: 'board1', grants: [{ role: 'board', classId: null, schoolYearId: 'year' }], mfaVerified: true };
const board2 = { userId: 'board2', grants: [{ role: 'board', classId: null, schoolYearId: null }], mfaVerified: true };

async function eventsDb() {
  const db = await createPgliteTestDb();
  await db.query("INSERT INTO school_years VALUES ('year','2026/27','2026-09-01','2027-08-31')");
  for (const id of ['board1', 'board2']) {
    await db.query('INSERT INTO users (id,email,display_name) VALUES ($1,$2,$3)', [id, `${id}@example.invalid`, `Synthetic ${id}`]);
  }
  return db;
}

let keyCounter = 0;
function draftInput(overrides = {}) {
  keyCounter += 1;
  return {
    schoolYearId: 'year',
    title: 'Zebranie Rady (syntetyczne)',
    startsAt: '2026-11-12T18:30',
    endsAt: '2026-11-12T20:00',
    location: 'Sala testowa',
    organizer: 'Rada Rodziców',
    audience: 'public',
    idempotencyKey: `ics-key-${String(keyCounter).padStart(4, '0')}`,
    ...overrides,
  };
}

async function publishedEvent(db, overrides = {}) {
  const { event } = await createDraft(db, board1, draftInput(overrides));
  await submit(db, board1, { eventId: event.id, revision: 1 });
  await approve(db, board2, { eventId: event.id, revision: 1 });
  const result = await publish(db, board2, { eventId: event.id, revision: 1 });
  return result.event;
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function httpEnv(db, extra = {}) {
  return { db, loadAuthorizationContext: async () => null, ...extra };
}

async function callRaw(env, method, path, headers = {}) {
  const url = new URL(path, ORIGIN);
  const response = await handle(new Request(url, { method, headers }), env, url, jsonResponse);
  return response;
}

test('the .ics channel contains only what listPublic returns (same UID set)', async () => {
  const db = await eventsDb();
  try {
    await createDraft(db, board1, draftInput({ title: 'Szkic' }));
    const pub = await publishedEvent(db, { title: 'Zebranie jawne' });
    const { events: jsonEvents } = await listPublic(db, { schoolYearId: 'year' });

    const res = await callRaw(httpEnv(db), 'GET', '/api/public/events.ics?schoolYearId=year');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'text/calendar; charset=utf-8');
    const body = await res.text();
    const uids = [...body.matchAll(/UID:event-([^@]+)@/g)].map((m) => m[1]);
    assert.deepEqual(uids.sort(), jsonEvents.map((e) => e.id).sort());
    assert.ok(body.includes('Zebranie jawne'));
    assert.equal(body.includes('Szkic'), false);
    assert.equal(body.includes(pub.createdBy ?? 'board1'), false);
  } finally { await db.close(); }
});

test('SEQUENCE only rises after a re-publication, not while an edit awaits approval', async () => {
  const db = await eventsDb();
  try {
    const pub = await publishedEvent(db, { title: 'Kiermasz' });
    let res = await callRaw(httpEnv(db), 'GET', `/api/public/events/${pub.id}.ics`);
    let body = await res.text();
    assert.match(body, /SEQUENCE:1/);

    await updateDraft(db, board1, { eventId: pub.id, revision: 1, title: 'Kiermasz (zmiana terminu)' });
    res = await callRaw(httpEnv(db), 'GET', `/api/public/events/${pub.id}.ics`);
    body = await res.text();
    // Still the previously published revision/sequence: edit is unapproved.
    assert.match(body, /SEQUENCE:1/);
    assert.ok(body.includes('Kiermasz\r\n') || body.includes('SUMMARY:Kiermasz'));

    await submit(db, board1, { eventId: pub.id, revision: 2 });
    await approve(db, board2, { eventId: pub.id, revision: 2 });
    await publish(db, board2, { eventId: pub.id, revision: 2 });
    res = await callRaw(httpEnv(db), 'GET', `/api/public/events/${pub.id}.ics`);
    body = await res.text();
    assert.match(body, /SEQUENCE:2/);
    assert.ok(body.includes('Kiermasz (zmiana terminu)'));
  } finally { await db.close(); }
});

test('a cancelled event is STATUS:CANCELLED without the cancellation reason', async () => {
  const db = await eventsDb();
  try {
    const pub = await publishedEvent(db, { title: 'Odwołane zebranie' });
    await cancel(db, board2, { eventId: pub.id, revision: 1, reason: 'Powód wewnętrzny nieujawniany publicznie' });
    const res = await callRaw(httpEnv(db), 'GET', `/api/public/events/${pub.id}.ics`);
    const body = await res.text();
    assert.match(body, /STATUS:CANCELLED/);
    assert.equal(body.includes('Powód wewnętrzny'), false);
  } finally { await db.close(); }
});

test('an unknown schoolYearId gives an empty calendar, matching the JSON API', async () => {
  const db = await eventsDb();
  try {
    await publishedEvent(db);
    const res = await callRaw(httpEnv(db), 'GET', '/api/public/events.ics?schoolYearId=does-not-exist');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(body.includes('BEGIN:VEVENT'), false);
  } finally { await db.close(); }
});

test('a single-event .ics for a draft or internal event answers 404 like listPublic omits it', async () => {
  const db = await eventsDb();
  try {
    const { event } = await createDraft(db, board1, draftInput());
    const res = await callRaw(httpEnv(db), 'GET', `/api/public/events/${event.id}.ics`);
    assert.equal(res.status, 404);
  } finally { await db.close(); }
});

test('If-None-Match with the current ETag gives 304, and a change invalidates it', async () => {
  const db = await eventsDb();
  try {
    const pub = await publishedEvent(db, { title: 'Zebranie z ETag' });
    const first = await callRaw(httpEnv(db), 'GET', `/api/public/events/${pub.id}.ics`);
    const etag = first.headers.get('ETag');
    assert.ok(etag);
    const cached = await callRaw(httpEnv(db), 'GET', `/api/public/events/${pub.id}.ics`, { 'If-None-Match': etag });
    assert.equal(cached.status, 304);

    await cancel(db, board2, { eventId: pub.id, revision: 1, reason: 'Zmiana planu spotkania Rady' });
    const changed = await callRaw(httpEnv(db), 'GET', `/api/public/events/${pub.id}.ics`, { 'If-None-Match': etag });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get('ETag'), etag);
  } finally { await db.close(); }
});

test('POST is not allowed on the .ics routes, and unrelated paths still return null', async () => {
  const db = await eventsDb();
  try {
    const pub = await publishedEvent(db);
    assert.equal((await callRaw(httpEnv(db), 'POST', '/api/public/events.ics')).status, 405);
    assert.equal((await callRaw(httpEnv(db), 'POST', `/api/public/events/${pub.id}.ics`)).status, 405);
    assert.equal(await callRaw(httpEnv(db), 'GET', '/api/payments'), null);
  } finally { await db.close(); }
});

test('a title with a semicolon, comma and long Polish description survives line folding intact', async () => {
  const db = await eventsDb();
  try {
    const pub = await publishedEvent(db, {
      title: 'Zebranie; termin ważny, proszę potwierdzić',
      description: 'Bardzo długi opis zawierający polskie znaki: ąćęłńóśźż, powtórzony wielokrotnie aż przekroczy siedemdziesiąt pięć oktetów w jednej linii testowej, żeby sprawdzić zawijanie.',
    });
    const res = await callRaw(httpEnv(db), 'GET', `/api/public/events/${pub.id}.ics`);
    const body = await res.text();
    // Folded continuation lines start with CRLF + a single space.
    const unfolded = body.replace(/\r\n /g, '');
    assert.ok(unfolded.includes('SUMMARY:Zebranie\\; termin ważny\\, proszę potwierdzić'));
    assert.ok(unfolded.includes('ąćęłńóśźż'));
  } finally { await db.close(); }
});

function unfold(body) { return body.replace(/\r\n /g, ''); }
function field(body, name) { return unfold(body).split('\r\n').find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1); }

test('zmiana czasu: 25.10.2026 02:30+02:00 i 02:30+01:00 dają różne czasy UTC, a 29.03.2026 02:30 jest odrzucone przy zapisie', async () => {
  const db = await eventsDb();
  try {
    const first = await publishedEvent(db, { title: 'Pierwsze 02:30', startsAt: '2026-10-25T02:30+02:00', endsAt: '2026-10-25T02:45+02:00' });
    const second = await publishedEvent(db, { title: 'Drugie 02:30', startsAt: '2026-10-25T02:30+01:00', endsAt: '2026-10-25T03:00' });
    const across = await publishedEvent(db, { title: 'Przez zmianę czasu', startsAt: '2026-10-25T01:30', endsAt: '2026-10-25T03:30' });
    const bodies = {};
    for (const [key, ev] of Object.entries({ first, second, across })) {
      bodies[key] = await (await callRaw(httpEnv(db), 'GET', `/api/public/events/${ev.id}.ics`)).text();
    }
    assert.equal(field(bodies.first, 'DTSTART'), '20261025T003000Z');
    assert.equal(field(bodies.second, 'DTSTART'), '20261025T013000Z');
    assert.equal(field(bodies.second, 'DTEND'), '20261025T020000Z');
    assert.equal(field(bodies.across, 'DTSTART'), '20261024T233000Z');
    assert.equal(field(bodies.across, 'DTEND'), '20261025T023000Z');
    for (const body of Object.values(bodies)) assert.equal(body.includes('TZID'), false);

    await assert.rejects(
      () => createDraft(db, board1, draftInput({ startsAt: '2026-03-29T02:30' })),
      (error) => error.code === 'nonexistent_local_time' || error.message === 'nonexistent_local_time',
    );
    const march = await publishedEvent(db, { title: 'Po zmianie wiosennej', startsAt: '2026-03-29T03:00', endsAt: '2026-03-29T04:00' });
    const marchBody = await (await callRaw(httpEnv(db), 'GET', `/api/public/events/${march.id}.ics`)).text();
    assert.equal(field(marchBody, 'DTSTART'), '20260329T010000Z');
    assert.equal(field(marchBody, 'DTEND'), '20260329T020000Z');
  } finally { await db.close(); }
});

test('kanał .ics działa dla roku szkolnego po jego zakończeniu (odczyt) i ma CRLF oraz linie do 75 oktetów', async () => {
  const db = await eventsDb();
  try {
    await publishedEvent(db, {
      title: 'Zebranie; ważne, żółć', description: 'Opis z polskimi znakami ąęśćżźń i przecinkami, średnikami; '.repeat(6),
    });
    // Zamknięcie „na skróty” (wzorzec z tests/pg-ledger-categories-api.test.js): liczy się tylko odczyt.
    await db.query("INSERT INTO school_years VALUES ('year-next','2027/28','2027-09-01','2028-08-31')");
    await db.exec(`
      SET session_replication_role = replica;
      INSERT INTO school_year_closures (id, school_year_id, next_school_year_id, status, initiated_by,
        closed_by, closed_at, income_cents, expense_cents, opening_balance_cents, closing_balance_cents,
        carried_opening_balance_id, expired_grant_count)
      VALUES ('clo-ics-1', 'year', 'year-next', 'closed', 'board1', 'board2', now(), 0, 0, 0, 0, 'ob-next-ics', 0);
      SET session_replication_role = origin;
    `);
    const res = await callRaw(httpEnv(db), 'GET', '/api/public/events.ics?schoolYearId=year');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('BEGIN:VEVENT'));
    assert.equal(body.replace(/\r\n/g, '').includes('\n'), false);
    for (const physical of body.split('\r\n')) assert.ok(new TextEncoder().encode(physical).length <= 75);
    assert.equal(/ORGANIZER|ATTENDEE|mailto|board1|board2/.test(body), false);
  } finally { await db.close(); }
});
