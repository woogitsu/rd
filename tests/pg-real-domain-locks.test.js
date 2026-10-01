// #208: testy z barierą na PRAWDZIWYM PostgreSQL dla blokad `FOR UPDATE` w modułach
// domenowych, których nie obejmuje pg-real-double-click: wydarzenia (limit miejsc
// i edycja szkicu), aktualności (zatwierdzenie kontra wycofanie), zebrania (zmiana
// terminu), dokumenty (zastąpienie) i rodziny (zmiana kontaktu opiekuna).
//
// Schemat jak w pg-real-double-click: pierwsze żądanie zatrzymuje się W TRANSAKCJI
// po zapisie, drugie startuje osobnym połączeniem puli, test sprawdza w
// pg_stat_activity, że drugie czeka na blokadę z KODU TRASY (a nie dopiero na
// indeksie czy wyzwalaczu), i dopiero potem wznawia pierwsze. Samo `Promise.all`
// na PGlite niczego tu nie dowodzi (PGlite wykonuje transakcje po kolei).
//
// Plik działa wyłącznie z RD_TEST_PG_URL (npm run test:pg-real); bez niej jest
// pomijany. Wyłącznie dane syntetyczne (@example.invalid). Żaden test nie wysyła
// wiadomości. Kontrola mutacyjna: scripts/check-lock-mutations.js (mutanty
// events-lock, news-lock, meetings-lock, documents-status, families-contact).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealTestDb, seedEnrolledHousehold, seedSchoolYear, seedUserSession } from './helpers/pg.js';
import { barrierEnv, callApi, countRows, settledWithin, waitForLockWaitersWithQuery } from './helpers/pg-barrier.js';

const skip = process.env.RD_TEST_PG_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';
const YEAR = 'y-2026';
const DAY = 24 * 3600 * 1000;
let seq = 0;
const key = (prefix) => `${prefix}-${String(++seq).padStart(6, '0')}-${crypto.randomUUID().slice(0, 8)}`;
const auditCount = (db, action) => countRows(db, 'SELECT count(*)::int AS n FROM audit_events WHERE action = $1', [action]);

async function withReal(fn) {
  const db = await createRealTestDb();
  try { return await fn(db); } finally { await db.close(); }
}

// B czeka w bazie dokładnie w jednym miejscu i jest to blokada z kodu trasy.
// pg_stat_activity.query jest obcinane (track_activity_query_size = 1024), więc
// wzorce opisują początek zapytania; zwykły SELECT czeka tylko na FOR UPDATE.
function assertWaitsOn({ waits, waitingSql }, pattern, message) {
  assert.equal(waits.length, 1, `${message}: ${JSON.stringify(waits)}`);
  assert.match(waitingSql, pattern, `${message} — czekające zapytanie: ${waitingSql}`);
}

// A z barierą (pauseAfter), potem B; sprawdza, że B czeka, i wznawia A.
async function race(db, { pauseAfter, first, second }) {
  const errors = [];
  const gated = barrierEnv(db, { pauseAfter, errors });
  const a = first(gated.env);
  const early = await Promise.race([gated.reached.then(() => null), a.then((r) => r, (e) => e)]);
  assert.equal(early, null, `pierwsze żądanie zakończyło się bez dojścia do bariery: ${JSON.stringify(early?.body ?? String(early))}`);
  const plain = barrierEnv(db, { errors }).env;
  const pending = second(plain);
  let waiters = [];
  try {
    waiters = await waitForLockWaitersWithQuery(db, 1);
    assert.equal(await settledWithin(pending, 150), 'pending', 'drugie żądanie nie może się zakończyć przed zatwierdzeniem pierwszego');
  } finally { gated.release(); }
  const [ra, rb] = await Promise.all([a, pending]);
  return { a: ra, b: rb, errors, waits: waiters.map((w) => w.event), waitingSql: waiters.map((w) => w.query).join('\n') };
}

const sessionFor = (db, userId, role, extra = {}) => seedUserSession(db, {
  userId, mfa: true, roles: [{ role, schoolYearId: YEAR, ...extra }],
});

// ---------------------------------------------------------------- wydarzenia

const eventBody = (patch = {}) => ({
  schoolYearId: YEAR, title: 'Festyn syntetyczny', startsAt: '2026-11-12T18:30', endsAt: '2026-11-12T20:00',
  location: 'Sala testowa', organizer: 'Rada Rodziców', audience: 'public', ...patch,
});

async function eventSetup(db) {
  await seedSchoolYear(db, YEAR);
  const board = await sessionFor(db, 'u-board-1', 'board');
  const board2 = await sessionFor(db, 'u-board-2', 'board');
  const created = await callApi({ db }, 'POST', '/api/events', board, eventBody(), key('ev'));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { board, board2, event: created.body.event };
}

test('#208 (bariera, wydarzenia): dwa zapisy na ostatnie miejsce zadania — drugi czeka na blokadę wydarzenia i dostaje 409 task_full', { skip }, async () => {
  await withReal(async (db) => {
    const { board, board2, event } = await eventSetup(db);
    await seedEnrolledHousehold(db, 'h1', [YEAR]);
    for (const id of ['g-1', 'g-2']) {
      await db.query("INSERT INTO guardians (id, household_id, first_name, last_name, contact_allowed) VALUES ($1, 'h1', 'Syntetyczny', 'Opiekun', true)", [id]);
    }
    const task = await callApi({ db }, 'POST', `/api/events/${event.id}/tasks`, board, { title: 'Stoisko z ciastami', slotsNeeded: 1 }, key('task'));
    assert.equal(task.status, 201, JSON.stringify(task.body));
    const path = `/api/events/${event.id}/tasks/${task.body.task.id}/signups`;
    const { a, b, waits, waitingSql } = await race(db, {
      pauseAfter: /INSERT INTO event_task_signups/,
      first: (env) => callApi(env, 'POST', path, board, { guardianId: 'g-1' }, key('su')),
      second: (env) => callApi(env, 'POST', path, board2, { guardianId: 'g-2' }, key('su')),
    });
    assertWaitsOn({ waits, waitingSql }, /FROM events WHERE id = \$1 FOR UPDATE/, 'drugi zapis czeka na blokadę wydarzenia');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.error], [409, 'task_full']);
    assert.equal(await countRows(db, "SELECT count(*)::int AS n FROM event_task_signups WHERE status = 'confirmed'"), 1);
    assert.equal(await auditCount(db, 'event.task_signup_created'), 1);
  });
});

test('#208 (bariera, wydarzenia): dwie edycje szkicu z tej samej rewizji — druga czeka na blokadę wydarzenia i dostaje 409 revision_conflict', { skip }, async () => {
  await withReal(async (db) => {
    const { board, board2, event } = await eventSetup(db);
    const path = `/api/events/${event.id}`;
    const { a, b, waits, waitingSql } = await race(db, {
      pauseAfter: /UPDATE events SET title/,
      first: (env) => callApi(env, 'PATCH', path, board, { revision: event.revision, title: 'Wersja A syntetyczna' }),
      second: (env) => callApi(env, 'PATCH', path, board2, { revision: event.revision, title: 'Wersja B syntetyczna' }),
    });
    assertWaitsOn({ waits, waitingSql }, /FROM events WHERE id = \$1 FOR UPDATE/, 'druga edycja czeka na blokadę wydarzenia');
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.error], [409, 'revision_conflict']);
    const row = (await db.query('SELECT title, revision_no FROM events WHERE id = $1', [event.id])).rows[0];
    assert.deepEqual({ title: row.title, revision: Number(row.revision_no) }, { title: 'Wersja A syntetyczna', revision: event.revision + 1 });
    assert.equal(await auditCount(db, 'event.revised'), 1);
  });
});

// ---------------------------------------------------------------- aktualności

test('#208 (bariera, aktualności): wycofanie równolegle z zatwierdzeniem — zatwierdzenie czeka na blokadę wpisu i dostaje 409 post_withdrawn', { skip }, async () => {
  await withReal(async (db) => {
    await seedSchoolYear(db, YEAR);
    const boardA = await sessionFor(db, 'u-board-1', 'board');
    const boardB = await sessionFor(db, 'u-board-2', 'board');
    const created = await callApi({ db }, 'POST', '/api/news', boardA, { schoolYearId: YEAR, title: 'Wpis syntetyczny', body: 'Treść syntetyczna.' }, key('news'));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.post.id;
    assert.equal((await callApi({ db }, 'POST', `/api/news/${id}/submit`, boardA, { revision: 1 })).status, 200);
    const { a, b, waits, waitingSql } = await race(db, {
      pauseAfter: /UPDATE news_posts SET status = 'withdrawn'/,
      first: (env) => callApi(env, 'POST', `/api/news/${id}/withdraw`, boardA, { revision: 1, reason: 'Wycofanie syntetyczne' }),
      second: (env) => callApi(env, 'POST', `/api/news/${id}/approve`, boardB, { revision: 1 }),
    });
    assertWaitsOn({ waits, waitingSql }, /FROM news_posts WHERE id = \$1 FOR UPDATE/, 'zatwierdzenie czeka na blokadę wpisu');
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.error], [409, 'post_withdrawn']);
    assert.equal((await db.query('SELECT status FROM news_posts WHERE id = $1', [id])).rows[0].status, 'withdrawn');
    assert.equal(await auditCount(db, 'news_post.approved'), 0);
    assert.equal(await auditCount(db, 'news_post.withdrawn'), 1);
  });
});

// ---------------------------------------------------------------- zebrania

test('#208 (bariera, zebrania): dwie zmiany terminu z tej samej rewizji — druga czeka na blokadę zebrania i dostaje 409 revision_conflict', { skip }, async () => {
  await withReal(async (db) => {
    await seedSchoolYear(db, YEAR);
    const board = await sessionFor(db, 'u-board-1', 'board');
    const inDays = (days) => new Date(Date.now() + days * DAY).toISOString();
    const created = await callApi({ db }, 'POST', '/api/meetings', board, {
      schoolYearId: YEAR, kind: 'plenary', title: 'Zebranie plenarne', scheduledAt: inDays(20), location: 'Sala 1', status: 'scheduled',
    }, key('mt'));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const meeting = created.body.meeting;
    const path = `/api/meetings/${meeting.id}/reschedule`;
    const { a, b, waits, waitingSql } = await race(db, {
      pauseAfter: /INSERT INTO meeting_reschedules/,
      first: (env) => callApi(env, 'POST', path, board, { scheduledAt: inDays(30), reason: 'Termin A syntetyczny', revision: meeting.revisionNo }),
      second: (env) => callApi(env, 'POST', path, board, { scheduledAt: inDays(40), reason: 'Termin B syntetyczny', revision: meeting.revisionNo }),
    });
    assertWaitsOn({ waits, waitingSql }, /FROM meetings WHERE id = \$1 FOR UPDATE/, 'druga zmiana terminu czeka na blokadę zebrania');
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.error], [409, 'revision_conflict']);
    assert.equal(await countRows(db, 'SELECT count(*)::int AS n FROM meeting_reschedules'), 1);
    assert.equal(await auditCount(db, 'meeting.rescheduled'), 1);
  });
});

// ---------------------------------------------------------------- dokumenty

test('#208 (bariera, dokumenty): zastąpienie jednego dokumentu dwoma różnymi — drugie czeka na blokadę dokumentu i dostaje 409', { skip }, async () => {
  await withReal(async (db) => {
    await seedSchoolYear(db, YEAR);
    const treasurer = await sessionFor(db, 'u-tr', 'treasurer');
    const ids = [0, 1, 2].map(() => crypto.randomUUID());
    for (const [i, id] of ids.entries()) {
      await db.query(
        `INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by, school_year_id, sha256, idempotency_key)
         VALUES ($1, $2, 'application/pdf', 10, 'financial', 'u-tr', $3, $4, $5)`,
        [id, `docs/${id}`, YEAR, String(i).repeat(64), `doc-key-${i}-0000`],
      );
    }
    const path = `/api/documents/${ids[0]}/supersede`;
    const { a, b, waits, waitingSql } = await race(db, {
      pauseAfter: /INSERT INTO document_status_events/,
      first: (env) => callApi(env, 'POST', path, treasurer, { replacementDocumentId: ids[1], reason: 'Nowa wersja A' }, key('sup')),
      second: (env) => callApi(env, 'POST', path, treasurer, { replacementDocumentId: ids[2], reason: 'Nowa wersja B' }, key('sup')),
    });
    assertWaitsOn({ waits, waitingSql }, /FROM documents WHERE id = \$1 FOR UPDATE/, 'drugie zastąpienie czeka na blokadę dokumentu');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(b.status, 409, JSON.stringify(b.body));
    const rows = (await db.query('SELECT replacement_document_id FROM document_status_events WHERE document_id = $1', [ids[0]])).rows;
    assert.deepEqual(rows, [{ replacement_document_id: ids[1] }]);
  });
});

// ---------------------------------------------------------------- rodziny

test('#208 (bariera, rodziny): dwie identyczne zmiany kontaktu opiekuna — druga czeka na blokadę opiekuna i nie dubluje historii ani audytu', { skip }, async () => {
  await withReal(async (db) => {
    await seedSchoolYear(db, YEAR);
    await seedEnrolledHousehold(db, 'h1', [YEAR]);
    await db.query("INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES ('g-1', 'h1', 'Syntetyczny', 'Opiekun', 'stary@example.invalid', true)");
    await db.query("INSERT INTO student_guardians (guardian_id, student_id) VALUES ('g-1', 'st-h1')");
    const boardA = await seedUserSession(db, { userId: 'u-board-1', mfa: true, roles: [{ role: 'board' }] });
    const boardB = await seedUserSession(db, { userId: 'u-board-2', mfa: true, roles: [{ role: 'board' }] });
    const body = { email: 'nowy@example.invalid' };
    const { a, b, waits, waitingSql } = await race(db, {
      pauseAfter: /UPDATE guardians SET email/,
      first: (env) => callApi(env, 'PATCH', '/api/guardians/g-1/contact', boardA, { ...body, reason: 'Zapis A' }),
      second: (env) => callApi(env, 'PATCH', '/api/guardians/g-1/contact', boardB, { ...body, reason: 'Zapis B' }),
    });
    assertWaitsOn({ waits, waitingSql }, /^SELECT g\.id, g\.email, g\.contact_allowed/, 'druga zmiana czeka na blokadę wiersza opiekuna');
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.deepEqual([a.body.changed, b.body.changed], [true, false], 'druga transakcja po blokadzie widzi już nowy adres');
    assert.equal(await countRows(db, "SELECT count(*)::int AS n FROM guardian_contact_changes WHERE guardian_id = 'g-1' AND new_email = 'nowy@example.invalid'"), 1);
    assert.equal(await auditCount(db, 'guardian.contact.updated'), 1);
  });
});
