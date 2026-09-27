import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../src/postgres-migrations.js';
import {
  approve, cancel, createDraft, formatBrusselsLocal, getInternal, handle, listInternal,
  listPublic, parseBrusselsLocal, publish, submit, updateDraft,
} from '../src/pg/events.js';

const directory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));
const ORIGIN = 'https://rd.example.invalid';

const board1 = { userId: 'board1', grants: [{ role: 'board', classId: null, schoolYearId: 'year' }], mfaVerified: true };
const board2 = { userId: 'board2', grants: [{ role: 'board', classId: null, schoolYearId: null }], mfaVerified: true };
const admin = { userId: 'admin', grants: [{ role: 'admin', classId: null, schoolYearId: null }], mfaVerified: true };
const rep1A = { userId: 'rep1a', grants: [{ role: 'representative', classId: 'c1a', schoolYearId: 'year' }], mfaVerified: false };
const rep1B = { userId: 'rep1b', grants: [{ role: 'representative', classId: 'c1b', schoolYearId: 'year' }], mfaVerified: false };
const treasurer = { userId: 'treasurer', grants: [{ role: 'treasurer', classId: null, schoolYearId: null }], mfaVerified: true };

async function eventsDb() {
  const db = new PGlite();
  for (const migration of await loadMigrations(directory)) await db.exec(migration.sql);
  await db.query("INSERT INTO school_years VALUES ('year','2026/27','2026-09-01','2027-08-31'), ('other','2027/28','2027-09-01','2028-08-31')");
  await db.query("INSERT INTO classes VALUES ('c1a','year','1A'), ('c1b','year','1B')");
  for (const id of ['board1', 'board2', 'admin', 'rep1a', 'rep1b', 'treasurer']) {
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
    idempotencyKey: `event-key-${String(keyCounter).padStart(4, '0')}`,
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

test('drafts, submitted and approved events never appear publicly', async () => {
  const db = await eventsDb();
  try {
    const draft = (await createDraft(db, board1, draftInput({ title: 'Szkic tajny' }))).event;
    const submitted = (await createDraft(db, board1, draftInput({ title: 'Zgłoszony tajny' }))).event;
    await submit(db, board1, { eventId: submitted.id, revision: 1 });
    const approved = (await createDraft(db, board1, draftInput({ title: 'Zatwierdzony tajny' }))).event;
    await submit(db, board1, { eventId: approved.id, revision: 1 });
    await approve(db, board2, { eventId: approved.id, revision: 1 });
    await createDraft(db, board1, draftInput({ title: 'Wewnętrzny', audience: 'internal' }));

    assert.equal(draft.status, 'draft');
    assert.deepEqual((await listPublic(db)).events, []);

    const published = await publishedEvent(db, { title: 'Publiczne zebranie' });
    const list = await listPublic(db);
    assert.deepEqual(list.events.map((e) => e.title), ['Publiczne zebranie']);
    assert.equal(list.events[0].id, published.id);
    const body = JSON.stringify(list);
    for (const leak of ['board1', 'board2', 'tajny', 'createdBy', 'approvedBy', 'revision', 'classId']) {
      assert.equal(body.includes(leak), false, `public payload leaks ${leak}`);
    }
  } finally { await db.close(); }
});

test('an internal-audience event cannot be published', async () => {
  const db = await eventsDb();
  try {
    const { event } = await createDraft(db, board1, draftInput({ audience: 'internal' }));
    await submit(db, board1, { eventId: event.id, revision: 1 });
    await approve(db, board2, { eventId: event.id, revision: 1 });
    await assert.rejects(publish(db, board2, { eventId: event.id, revision: 1 }), { code: 'event_not_public' });
    await assert.rejects(db.query(`UPDATE events SET status='published', published_revision_no=1, published_by='board2', published_at=now(), first_published_at=now() WHERE id=$1`, [event.id]), /event_invalid_publication/);
    assert.equal((await listPublic(db)).events.length, 0);
  } finally { await db.close(); }
});

test('edits after publication keep the published revision public until re-approved', async () => {
  const db = await eventsDb();
  try {
    const event = await publishedEvent(db, { title: 'Kiermasz pierwotny' });
    const edited = await updateDraft(db, board1, { eventId: event.id, revision: 1, title: 'Kiermasz – nowa godzina', startsAt: '2026-11-12T19:00' });
    assert.equal(edited.event.revision, 2);
    assert.equal(edited.event.status, 'draft');
    assert.equal(edited.event.publishedRevision, 1);

    let pub = (await listPublic(db)).events;
    assert.equal(pub[0].title, 'Kiermasz pierwotny');
    assert.equal(pub[0].startsAt, '2026-11-12T18:30:00+01:00');
    assert.equal(pub[0].changedAfterPublication, false);

    await submit(db, board1, { eventId: event.id, revision: 2 });
    await approve(db, board2, { eventId: event.id, revision: 2 });
    await publish(db, board2, { eventId: event.id, revision: 2 });
    pub = (await listPublic(db)).events;
    assert.equal(pub[0].title, 'Kiermasz – nowa godzina');
    assert.equal(pub[0].startsAt, '2026-11-12T19:00:00+01:00');
    assert.equal(pub[0].changedAfterPublication, true);

    const detail = await getInternal(db, board1, { eventId: event.id });
    assert.deepEqual(detail.revisions.map((r) => [r.revision, r.title]), [[1, 'Kiermasz pierwotny'], [2, 'Kiermasz – nowa godzina']]);
  } finally { await db.close(); }
});

test('revision history is immutable and cannot be bypassed', async () => {
  const db = await eventsDb();
  try {
    const { event } = await createDraft(db, board1, draftInput());
    await updateDraft(db, board1, { eventId: event.id, revision: 1, location: 'Inna sala' });
    await assert.rejects(db.query(`UPDATE event_revisions SET title='x' WHERE event_id=$1`, [event.id]), /cannot_be_changed/);
    await assert.rejects(db.query(`DELETE FROM event_revisions WHERE event_id=$1`, [event.id]), /cannot_be_changed/);
    await assert.rejects(db.query(`DELETE FROM events WHERE id=$1`, [event.id]), /events_cannot_be_deleted/);
    await assert.rejects(db.query(`INSERT INTO event_revisions (event_id,revision_no,title,begins_at,audience,created_by) VALUES ($1,3,'Fałszywa',now(),'public','board1')`, [event.id]), /event_revision_must_match_current_event/);
    await assert.rejects(db.query(`UPDATE events SET revision_no=7 WHERE id=$1`, [event.id]), /event_revision_without_change/);
    await assert.rejects(db.query(`UPDATE events SET school_year_id='other' WHERE id=$1`, [event.id]), /event_identity_immutable/);
    // Raw content update still creates a revision.
    await db.query(`UPDATE events SET organizer='Komitet', updated_by='board2' WHERE id=$1`, [event.id]);
    const { rows } = await db.query('SELECT revision_no, location, organizer, created_by FROM event_revisions WHERE event_id=$1 ORDER BY revision_no', [event.id]);
    assert.deepEqual(rows.map((r) => [r.revision_no, r.location, r.organizer, r.created_by]), [
      [1, 'Sala testowa', 'Rada Rodziców', 'board1'],
      [2, 'Inna sala', 'Rada Rodziców', 'board1'],
      [3, 'Inna sala', 'Komitet', 'board2'],
    ]);
    // Stale revision is rejected instead of overwriting someone else's change.
    await assert.rejects(updateDraft(db, board1, { eventId: event.id, revision: 2, title: 'Nadpisanie' }), { code: 'revision_conflict' });
  } finally { await db.close(); }
});

test('cancelled published event shows as cancelled without the internal reason and is final', async () => {
  const db = await eventsDb();
  try {
    const event = await publishedEvent(db);
    await assert.rejects(cancel(db, board1, { eventId: event.id, revision: 1, reason: 'x' }), { code: 'invalid_reason' });
    const result = await cancel(db, board1, { eventId: event.id, revision: 1, reason: 'Choroba prowadzącego (syntetyczne)' });
    assert.equal(result.event.status, 'cancelled');
    const pub = (await listPublic(db)).events;
    assert.equal(pub.length, 1);
    assert.equal(pub[0].status, 'cancelled');
    assert.equal(JSON.stringify(pub).includes('Choroba'), false);
    assert.equal((await cancel(db, board1, { eventId: event.id, revision: 1, reason: 'Ponowne kliknięcie' })).replayed, true);
    await assert.rejects(updateDraft(db, board1, { eventId: event.id, revision: 1, title: 'Wskrzeszone' }), { code: 'event_cancelled' });
    await assert.rejects(db.query(`UPDATE events SET status='draft', cancelled_at=NULL WHERE id=$1`, [event.id]), /event_cancelled_is_final/);
  } finally { await db.close(); }
});

test('cancelled unpublished draft stays hidden; representative may withdraw only unpublished own-class events', async () => {
  const db = await eventsDb();
  try {
    const draft = (await createDraft(db, rep1A, draftInput({ classId: 'c1a' }))).event;
    await cancel(db, rep1A, { eventId: draft.id, revision: 1, reason: 'Wycofana propozycja' });
    assert.equal((await listPublic(db)).events.length, 0);

    const published = await publishedEvent(db, { classId: 'c1a' });
    await assert.rejects(cancel(db, rep1A, { eventId: published.id, revision: 1, reason: 'Próba odwołania' }), { code: 'forbidden' });
  } finally { await db.close(); }
});

test('representative cannot read or touch another class and cannot create school-wide events', async () => {
  const db = await eventsDb();
  try {
    const own = (await createDraft(db, rep1A, draftInput({ classId: 'c1a', title: 'Wycieczka 1A' }))).event;
    const other = (await createDraft(db, rep1B, draftInput({ classId: 'c1b', title: 'Wycieczka 1B' }))).event;
    await assert.rejects(createDraft(db, rep1A, draftInput({ classId: 'c1b' })), { code: 'forbidden' });
    await assert.rejects(createDraft(db, rep1A, draftInput()), { code: 'forbidden' });
    await assert.rejects(createDraft(db, rep1A, draftInput({ classId: 'c1a', schoolYearId: 'other' })), { code: 'forbidden' });
    await assert.rejects(updateDraft(db, rep1A, { eventId: other.id, revision: 1, title: 'Przejęte' }), { code: 'forbidden' });
    await assert.rejects(submit(db, rep1A, { eventId: other.id, revision: 1 }), { code: 'forbidden' });
    await assert.rejects(cancel(db, rep1A, { eventId: other.id, revision: 1, reason: 'Nie moje' }), { code: 'forbidden' });
    await assert.rejects(getInternal(db, rep1A, { eventId: other.id }), { code: 'event_not_found' });
    const list = await listInternal(db, rep1A, { schoolYearId: 'year' });
    assert.deepEqual(list.events.map((e) => e.id), [own.id]);

    await submit(db, rep1A, { eventId: own.id, revision: 1 });
    await assert.rejects(approve(db, rep1A, { eventId: own.id, revision: 1 }), { code: 'forbidden' });
    await assert.rejects(approve(db, rep1B, { eventId: own.id, revision: 1 }), { code: 'forbidden' });
    await assert.rejects(listInternal(db, treasurer, { schoolYearId: 'year' }), { code: 'forbidden' });
    await assert.rejects(createDraft(db, treasurer, draftInput()), { code: 'forbidden' });
    // Assumption pending D-08: technical admin drafts but does not approve/publish.
    const adminDraft = (await createDraft(db, admin, draftInput())).event;
    await submit(db, admin, { eventId: adminDraft.id, revision: 1 });
    await assert.rejects(approve(db, admin, { eventId: adminDraft.id, revision: 1 }), { code: 'forbidden' });
    // Board approves the representative's proposal.
    const approved = await approve(db, board1, { eventId: own.id, revision: 1 });
    assert.equal(approved.event.status, 'approved');
  } finally { await db.close(); }
});

test('author cannot approve own event or own revision (four eyes, also in the database)', async () => {
  const db = await eventsDb();
  try {
    const { event } = await createDraft(db, board1, draftInput());
    await submit(db, board1, { eventId: event.id, revision: 1 });
    await assert.rejects(approve(db, board1, { eventId: event.id, revision: 1 }), { code: 'four_eyes_required' });
    await assert.rejects(db.query(`UPDATE events SET status='approved', approved_revision_no=1, approved_by='board1', approved_at=now() WHERE id=$1`, [event.id]), /event_four_eyes_required/);

    // board2 edits; now board2 is the revision author and cannot approve it either.
    await updateDraft(db, board2, { eventId: event.id, revision: 1, title: 'Poprawiony tytuł' });
    await submit(db, board2, { eventId: event.id, revision: 2 });
    await assert.rejects(approve(db, board2, { eventId: event.id, revision: 2 }), { code: 'four_eyes_required' });
    await assert.rejects(approve(db, board1, { eventId: event.id, revision: 2 }), { code: 'four_eyes_required' });

    // Skipping steps is rejected by the database.
    const other = (await createDraft(db, board1, draftInput())).event;
    await assert.rejects(approve(db, board2, { eventId: other.id, revision: 1 }), { code: 'invalid_transition' });
    await assert.rejects(db.query(`UPDATE events SET status='published' WHERE id=$1`, [other.id]), /event_invalid_transition/);
    // Approving a revision the approver did not see is refused.
    await submit(db, board1, { eventId: other.id, revision: 1 });
    await assert.rejects(approve(db, board2, { eventId: other.id, revision: 2 }), { code: 'revision_conflict' });
  } finally { await db.close(); }
});

test('double-click create is idempotent and conflicting reuse of a key is rejected', async () => {
  const db = await eventsDb();
  try {
    const input = draftInput();
    const [a, b] = await Promise.all([createDraft(db, board1, input), createDraft(db, board1, input)]);
    assert.equal(a.event.id, b.event.id);
    assert.deepEqual([a.replayed, b.replayed].sort(), [false, true]);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM events');
    assert.equal(rows[0].n, 1);
    const audits = await db.query(`SELECT action, actor_id, entity_id, metadata_json FROM audit_events WHERE entity_type='event'`);
    assert.equal(audits.rows.length, 1);
    assert.deepEqual(audits.rows[0].metadata_json, { revision: 1, status: 'draft' });
    await assert.rejects(createDraft(db, board1, { ...input, title: 'Inny tytuł' }), { code: 'idempotency_conflict' });
    await assert.rejects(createDraft(db, board2, input), { code: 'idempotency_conflict' });

    // Double transitions are replays without extra audit entries.
    await submit(db, board1, { eventId: a.event.id, revision: 1 });
    assert.equal((await submit(db, board1, { eventId: a.event.id, revision: 1 })).replayed, true);
    await approve(db, board2, { eventId: a.event.id, revision: 1 });
    assert.equal((await approve(db, board2, { eventId: a.event.id, revision: 1 })).replayed, true);
    // Double-submitted edit returns the revision already created.
    await updateDraft(db, board1, { eventId: a.event.id, revision: 1, title: 'Edycja raz' });
    const again = await updateDraft(db, board1, { eventId: a.event.id, revision: 1, title: 'Edycja raz' });
    assert.equal(again.replayed, true);
    assert.equal(again.event.revision, 2);
    const actions = (await db.query(`SELECT action FROM audit_events WHERE entity_type='event' ORDER BY occurred_at, action`)).rows.map((r) => r.action);
    assert.deepEqual(actions.sort(), ['event.approved', 'event.created', 'event.revised', 'event.submitted']);
  } finally { await db.close(); }
});

test('Europe/Brussels local times handle the end of summer time on 2026-10-25', async () => {
  assert.equal(parseBrusselsLocal('2026-10-24T18:00').toISOString(), '2026-10-24T16:00:00.000Z');
  assert.equal(parseBrusselsLocal('2026-10-25T18:00').toISOString(), '2026-10-25T17:00:00.000Z');
  assert.throws(() => parseBrusselsLocal('2026-10-25T02:30'), { code: 'ambiguous_local_time' });
  assert.equal(parseBrusselsLocal('2026-10-25T02:30+02:00').toISOString(), '2026-10-25T00:30:00.000Z');
  assert.equal(parseBrusselsLocal('2026-10-25T02:30+01:00').toISOString(), '2026-10-25T01:30:00.000Z');
  assert.throws(() => parseBrusselsLocal('2026-10-25T18:00+02:00'), { code: 'offset_not_valid_in_europe_brussels' });
  assert.throws(() => parseBrusselsLocal('2026-03-29T02:30'), { code: 'nonexistent_local_time' });
  assert.throws(() => parseBrusselsLocal('2026-02-30T10:00'), { code: 'invalid_datetime' });
  assert.equal(formatBrusselsLocal(new Date('2026-10-25T00:30:00Z')), '2026-10-25T02:30:00+02:00');
  assert.equal(formatBrusselsLocal(new Date('2026-10-25T01:30:00Z')), '2026-10-25T02:30:00+01:00');

  const db = await eventsDb();
  try {
    // An evening event spanning the switch: 25 Oct 01:00 CEST -> 03:00 CET lasts 3 hours.
    const event = await publishedEvent(db, { startsAt: '2026-10-25T01:00', endsAt: '2026-10-25T03:00' });
    assert.equal(event.startsAtUtc, '2026-10-24T23:00:00.000Z');
    assert.equal(event.endsAtUtc, '2026-10-25T02:00:00.000Z');
    const [pub] = (await listPublic(db)).events;
    assert.equal(pub.timezone, 'Europe/Brussels');
    assert.equal(pub.startsAt, '2026-10-25T01:00:00+02:00');
    assert.equal(pub.endsAt, '2026-10-25T03:00:00+01:00');
    await assert.rejects(createDraft(db, board1, draftInput({ startsAt: '2026-10-25T10:00', endsAt: '2026-10-25T09:00' })), { code: 'ends_before_start' });
  } finally { await db.close(); }
});

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function httpEnv(db, actor) {
  return {
    db,
    loadAuthorizationContext: async () => (actor
      ? { session: { user: { id: actor.userId }, mfaVerified: actor.mfaVerified }, grants: actor.grants }
      : null),
  };
}

async function call(env, method, path, { body, headers = {} } = {}) {
  const url = new URL(path, ORIGIN);
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['Content-Type'] ??= 'application/json';
  }
  const response = await handle(new Request(url, init), env, url, jsonResponse);
  return response && { status: response.status, headers: response.headers, data: await response.json() };
}

test('HTTP: public endpoint needs no session and returns only published events', async () => {
  const db = await eventsDb();
  try {
    await createDraft(db, board1, draftInput({ title: 'Szkic HTTP' }));
    await publishedEvent(db, { title: 'Opublikowane HTTP' });
    const res = await call(httpEnv(db, null), 'GET', '/api/public/events?schoolYearId=year');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.events.map((e) => e.title), ['Opublikowane HTTP']);
    assert.equal(res.data.timezone, 'Europe/Brussels');
    assert.equal((await call(httpEnv(db, null), 'GET', '/api/events?schoolYearId=year')).status, 401);
    assert.equal((await call(httpEnv(db, null), 'POST', '/api/public/events', { body: {} })).status, 405);
    assert.equal(await call(httpEnv(db, null), 'GET', '/api/payments'), null);
  } finally { await db.close(); }
});

test('HTTP: mutations require same origin, JSON limits and Idempotency-Key', async () => {
  const db = await eventsDb();
  try {
    const env = httpEnv(db, board1);
    const body = { schoolYearId: 'year', title: 'Zebranie HTTP', startsAt: '2026-12-03T18:00', audience: 'public' };
    const sameOrigin = { Origin: ORIGIN, 'Idempotency-Key': 'http-create-0001' };
    assert.equal((await call(env, 'POST', '/api/events', { body, headers: { ...sameOrigin, Origin: 'https://evil.example.invalid' } })).status, 403);
    assert.equal((await call(env, 'POST', '/api/events', { body, headers: { Origin: ORIGIN } })).data.error, 'invalid_idempotency_key');
    assert.equal((await call(env, 'POST', '/api/events', { body: 'x'.repeat(17 * 1024), headers: sameOrigin })).status, 413);
    assert.equal((await call(env, 'POST', '/api/events', { body: '[1]', headers: sameOrigin })).data.error, 'invalid_json');

    const first = await call(env, 'POST', '/api/events', { body, headers: sameOrigin });
    const second = await call(env, 'POST', '/api/events', { body, headers: sameOrigin });
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('Idempotency-Replayed'), 'true');
    assert.equal(first.data.event.id, second.data.event.id);
    assert.equal(first.data.event.startsAt, '2026-12-03T18:00:00+01:00');

    const id = first.data.event.id;
    const submitted = await call(env, 'POST', `/api/events/${id}/submit`, { body: { revision: 1 }, headers: { Origin: ORIGIN } });
    assert.equal(submitted.data.event.status, 'submitted');
    const selfApprove = await call(env, 'POST', `/api/events/${id}/approve`, { body: { revision: 1 }, headers: { Origin: ORIGIN } });
    assert.deepEqual([selfApprove.status, selfApprove.data.error], [409, 'four_eyes_required']);
    const env2 = httpEnv(db, board2);
    assert.equal((await call(env2, 'POST', `/api/events/${id}/approve`, { body: { revision: 1 }, headers: { Origin: ORIGIN } })).status, 200);
    assert.equal((await call(env2, 'POST', `/api/events/${id}/publish`, { body: { revision: 1 }, headers: { Origin: ORIGIN } })).data.event.status, 'published');
    const patched = await call(env, 'PATCH', `/api/events/${id}`, { body: { revision: 1, location: 'Sala 2' }, headers: { Origin: ORIGIN } });
    assert.equal(patched.data.event.revision, 2);
    const detail = await call(env, 'GET', `/api/events/${id}`);
    assert.equal(detail.data.revisions.length, 2);
    assert.equal((await call(httpEnv(db, rep1A), 'GET', `/api/events/${id}`)).status, 404);
  } finally { await db.close(); }
});

test('legacy D1 rows restore as published (no approval record) or draft', async () => {
  const db = await eventsDb();
  try {
    await db.query(`INSERT INTO events (id,school_year_id,title,begins_at,description,visibility,published_at,created_by)
      VALUES ('legacy-pub','year','Stare wydarzenie','2026-09-20T10:00:00Z',NULL,'published','2026-09-01T00:00:00Z','board1'),
             ('legacy-draft','year','Stary szkic','2026-09-21T10:00:00Z',NULL,'draft_public',NULL,'board1')`);
    const { rows } = await db.query(`SELECT e.id, e.status, e.visibility, r.source FROM events e JOIN event_revisions r ON r.event_id=e.id ORDER BY e.id`);
    assert.deepEqual(rows, [
      { id: 'legacy-draft', status: 'draft', visibility: 'draft_public', source: 'app' },
      { id: 'legacy-pub', status: 'published', visibility: 'published', source: 'legacy_d1' },
    ]);
    assert.deepEqual((await listPublic(db)).events.map((e) => e.id), ['legacy-pub']);
    await assert.rejects(db.query(`INSERT INTO events (id,school_year_id,title,begins_at,status,created_by) VALUES ('x','year','X',now(),'approved','board1')`), /event_must_start_as_draft/);
  } finally { await db.close(); }
});
