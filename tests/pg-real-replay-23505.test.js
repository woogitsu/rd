// #208: gałęzie `23505 → odtworzenie zapisu` (kryterium 3) na PRAWDZIWYM PostgreSQL
// dla dokumentów, wydarzeń, aktualności, zebrań i zamknięcia roku. Na PGlite (jedno
// połączenie, transakcje po kolei) druga transakcja nigdy nie dociera do indeksu
// unikalnego przed zatwierdzeniem pierwszej, więc te gałęzie nigdy się tam nie wykonują.
//
// Schemat jak w `pg-real-double-click.test.js`: pierwsze żądanie zatrzymuje się W TRANSAKCJI
// po zapisie wiersza z kluczem (przed COMMIT), drugie startuje osobnym połączeniem puli,
// nie widzi jeszcze klucza i dochodzi do INSERT, na którym czeka w bazie na transakcję
// pierwszego (`transactionid`) — tu NIE ma blokady wiersza `FOR UPDATE`, to właśnie indeks
// unikalny jest punktem serializacji. Po zatwierdzeniu pierwszego drugie dostaje `23505`
// (kod widoczny w `errors`), a kod trasy odtwarza zapis spoza transakcji. Każdy test sprawdza
// też, że po wyścigu zostaje jeden zapis, jedno zdarzenie audytu i brak osieroconych obiektów.
// Dwa testy to wyjątki: wersje protokołu zebrania numeruje wyzwalacz pod `FOR UPDATE` na zebraniu
// (druga transakcja dostaje P0001, nie 23505), a potwierdzenie punktu listy kontrolnej zamknięcia roku
// serializuje `FOR UPDATE` na istniejącym wierszu zamknięcia (mutant `year-close-closure-lock`).
// Poza zakresem zostaje `createSignup` w `events.js` (23505 po `FOR UPDATE` na wydarzeniu):
// `lockEvent` serializuje zapisy, więc ta gałąź jest nieosiągalna bez usunięcia tamtej blokady.
//
// Plik działa wyłącznie z RD_TEST_PG_URL (npm run test:pg-real); bez niej jest pomijany.
// Wyłącznie dane syntetyczne (@example.invalid). Żaden test nie wysyła wiadomości.
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { handlePgRequest } from '../src/pg/app.js';
import { resetUploadSlotsForTests } from '../src/documents.js';
import { createMemoryStorage } from '../src/storage.js';
import { CHECKLIST_ITEMS } from '../src/pg/routes/year-close.js';
import { request, seedClass, seedDocument, seedRoleGrant, seedSchoolYear, seedUserSession } from './helpers/pg.js';
import { callApi, countRows } from './helpers/pg-barrier.js';
import { assertWaitsOn, auditCount, race, raceKey as key, withReal } from './helpers/pg-race.js';

const skip = process.env.RD_TEST_PG_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';
const YEAR = 'y-2026';
const DAY = 24 * 3600 * 1000;
const PDF = new TextEncoder().encode('%PDF-1.4\n% syntetyczny dokument testowy\n1 0 obj <<>> endobj\n%%EOF\n');

const boardSession = (db, userId, extra = {}) => seedUserSession(db, { userId, mfa: true, roles: [{ role: 'board', schoolYearId: YEAR, ...extra }] });

// Wspólne dla testów, w których wygrywa pierwszy zapis, a drugi trafia w 23505:
// B czeka na transakcję A (nie na blokadę wiersza), a po COMMIT A dostaje błąd 23505.
function assertUniqueRace(r, insertPattern, message) {
  assertWaitsOn(r, insertPattern, message, { event: 'transactionid' });
  assert.ok(r.errors.includes('23505'), `${message}: druga transakcja musi dostać 23505, a dostała ${JSON.stringify(r.errors)}`);
}

// ---------------------------------------------------------------- dokumenty

test('#208 (bariera, 23505, dokumenty): podwójne wysłanie pliku z tym samym kluczem — druga transakcja dostaje 23505, odtwarza zapis i sprząta swój obiekt', { skip }, async () => {
  await withReal(async (db) => {
    resetUploadSlotsForTests();
    await seedSchoolYear(db, YEAR);
    const treasurer = await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
    const storage = createMemoryStorage();
    const idempotencyKey = key('upload');
    const upload = async (env) => {
      const response = await handlePgRequest(request(`/api/documents?kind=financial&schoolYearId=${YEAR}`, {
        method: 'POST', cookie: treasurer, body: PDF, headers: { 'Content-Type': 'application/pdf', 'Idempotency-Key': idempotencyKey },
      }), env);
      return { status: response.status, body: await response.json() };
    };
    const r = await race(db, { pauseAfter: /INSERT INTO documents/, extra: { storage }, first: upload, second: upload });
    assertUniqueRace(r, /^INSERT INTO documents/, 'drugi zapis dokumentu czeka na indeks klucza idempotencji');
    assert.equal(r.a.status, 201, JSON.stringify(r.a.body));
    assert.deepEqual([r.b.status, r.b.body.replayed], [200, true], JSON.stringify(r.b.body));
    assert.equal(r.b.body.document.id, r.a.body.document.id);
    assert.equal(await countRows(db, 'SELECT count(*)::int AS n FROM documents'), 1);
    assert.equal(await auditCount(db, 'document.uploaded'), 1);
    assert.equal(storage.keys().length, 1, 'obiekt przegranej transakcji usunięty z bucketu');
    const uploads = (await db.query('SELECT state, resolution FROM document_uploads ORDER BY state')).rows;
    assert.deepEqual(uploads, [
      { state: 'abandoned', resolution: 'duplicate_idempotency_key' },
      { state: 'committed', resolution: 'committed' },
    ]);
  });
});

// ---------------------------------------------------------------- wydarzenia

test('#208 (bariera, 23505, wydarzenia): podwójne utworzenie wydarzenia z tym samym kluczem — druga transakcja dostaje 23505 i odtwarza zapis (200 Idempotency-Replayed)', { skip }, async () => {
  await withReal(async (db) => {
    await seedSchoolYear(db, YEAR);
    const board = await boardSession(db, 'u-board-1');
    const body = {
      schoolYearId: YEAR, title: 'Festyn syntetyczny', startsAt: '2026-11-12T18:30', endsAt: '2026-11-12T20:00',
      location: 'Sala testowa', organizer: 'Rada Rodziców', audience: 'public',
    };
    const idempotencyKey = key('ev');
    const call = (env) => callApi(env, 'POST', '/api/events', board, body, idempotencyKey);
    const r = await race(db, { pauseAfter: /INSERT INTO events/, first: call, second: call });
    assertUniqueRace(r, /^INSERT INTO events/, 'drugie utworzenie wydarzenia czeka na indeks klucza idempotencji');
    assert.equal(r.a.status, 201, JSON.stringify(r.a.body));
    assert.deepEqual([r.b.status, r.b.replayed], [200, 'true'], JSON.stringify(r.b.body));
    assert.equal(r.b.body.event.id, r.a.body.event.id);
    assert.equal(await countRows(db, 'SELECT count(*)::int AS n FROM events'), 1);
    assert.equal(await auditCount(db, 'event.created'), 1);
  });
});

// ---------------------------------------------------------------- aktualności

test('#208 (bariera, 23505, aktualności): podwójne utworzenie wpisu z tym samym kluczem — druga transakcja dostaje 23505 i odtwarza zapis', { skip }, async () => {
  await withReal(async (db) => {
    await seedSchoolYear(db, YEAR);
    const board = await boardSession(db, 'u-board-1');
    const body = { schoolYearId: YEAR, title: 'Wpis syntetyczny', body: 'Treść syntetyczna.' };
    const idempotencyKey = key('news');
    const call = (env) => callApi(env, 'POST', '/api/news', board, body, idempotencyKey);
    const r = await race(db, { pauseAfter: /INSERT INTO news_posts/, first: call, second: call });
    assertUniqueRace(r, /^INSERT INTO news_posts/, 'drugie utworzenie wpisu czeka na indeks klucza idempotencji');
    assert.equal(r.a.status, 201, JSON.stringify(r.a.body));
    assert.deepEqual([r.b.status, r.b.replayed], [200, 'true'], JSON.stringify(r.b.body));
    assert.equal(r.b.body.post.id, r.a.body.post.id);
    assert.equal(await countRows(db, 'SELECT count(*)::int AS n FROM news_posts'), 1);
    assert.equal(await auditCount(db, 'news_post.created'), 1);
  });
});

async function registerPhotoBody(db) {
  return { documentId: await seedDocument(db, { id: crypto.randomUUID(), createdBy: 'u-admin' }), author: 'Fotograf testowy', source: 'own_work', takenOn: '2026-10-10',
    licenseText: 'Zdjęcie własne autora, udostępnione Radzie do publikacji.', altText: 'Stół kiermaszowy z ciastami', depictsChildren: false };
}

test('#208 (bariera, 23505, aktualności): podwójna rejestracja zdjęcia z tym samym kluczem — druga transakcja dostaje 23505 i odtwarza zapis', { skip }, async () => {
  await withReal(async (db) => {
    await seedSchoolYear(db, YEAR);
    const admin = await seedUserSession(db, { userId: 'u-admin', mfa: true, roles: [{ role: 'admin' }] });
    const body = await registerPhotoBody(db);
    const idempotencyKey = key('photo');
    const call = (env) => callApi(env, 'POST', '/api/news-photos', admin, body, idempotencyKey);
    const r = await race(db, { pauseAfter: /INSERT INTO news_photos/, first: call, second: call });
    assertUniqueRace(r, /^INSERT INTO news_photos/, 'druga rejestracja zdjęcia czeka na indeks klucza idempotencji');
    assert.equal(r.a.status, 201, JSON.stringify(r.a.body));
    assert.deepEqual([r.b.status, r.b.replayed], [200, 'true'], JSON.stringify(r.b.body));
    assert.equal(r.b.body.photo.id, r.a.body.photo.id);
    assert.equal(await countRows(db, 'SELECT count(*)::int AS n FROM news_photos'), 1);
    assert.equal(await auditCount(db, 'news_photo.registered'), 1);
  });
});

test('#208 (bariera, 23505, aktualności): podwójne wysłanie pliku zdjęcia — druga transakcja dostaje 23505 na (zdjęcie, wariant), zwraca istniejące pliki i usuwa swoje obiekty', { skip }, async () => {
  await withReal(async (db) => {
    await seedSchoolYear(db, YEAR);
    const board = await seedUserSession(db, { userId: 'u-board-1', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] });
    const admin = await seedUserSession(db, { userId: 'u-admin', mfa: true, roles: [{ role: 'admin' }] });
    const registered = await callApi({ db }, 'POST', '/api/news-photos', admin, await registerPhotoBody(db), key('photo'));
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const photoId = registered.body.photo.id;
    const source = await sharp({ create: { width: 30, height: 10, channels: 3, background: { r: 200, g: 40, b: 10 } } }).png().toBuffer();
    const storage = createMemoryStorage();
    const upload = async (env) => {
      const response = await handlePgRequest(request(`/api/news-photos/${photoId}/file`, {
        method: 'POST', cookie: board, body: source, headers: { 'Content-Type': 'image/png', 'Idempotency-Key': key('file') },
      }), env);
      return { status: response.status, body: await response.json() };
    };
    resetUploadSlotsForTests();
    const r = await race(db, { pauseAfter: /INSERT INTO news_photo_files/, extra: { storage }, first: upload, second: upload });
    assertUniqueRace(r, /^INSERT INTO news_photo_files/, 'drugie wysłanie pliku czeka na indeks (zdjęcie, wariant)');
    assert.equal(r.a.status, 201, JSON.stringify(r.a.body));
    assert.equal(r.b.status, 200, JSON.stringify(r.b.body));
    assert.deepEqual(r.b.body.files.map((f) => f.variant).sort(), r.a.body.files.map((f) => f.variant).sort());
    const stored = await countRows(db, 'SELECT count(*)::int AS n FROM news_photo_files WHERE photo_id = $1', [photoId]);
    assert.equal(stored, r.a.body.files.length, 'jeden komplet wariantów');
    assert.equal(storage.keys().length, stored, 'obiekty przegranej transakcji usunięte z bucketu');
    assert.equal(await auditCount(db, 'news_photo.file_uploaded'), 1);
  });
});

// ---------------------------------------------------------------- zebrania

const inDays = (days) => new Date(Date.now() + days * DAY).toISOString();

async function meetingSetup(db, { held = false } = {}) {
  await seedSchoolYear(db, YEAR);
  const board = await boardSession(db, 'u-board-1');
  const created = await callApi({ db }, 'POST', '/api/meetings', board, {
    schoolYearId: YEAR, kind: 'plenary', title: 'Zebranie plenarne', scheduledAt: inDays(20), location: 'Sala 1', status: 'scheduled',
  }, key('mt'));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  let meeting = created.body.meeting;
  if (held) {
    // Protokół wymaga zebrania w stanie „odbyte” (wyzwalacz minutes_require_held_meeting).
    const updated = await callApi({ db }, 'PATCH', `/api/meetings/${meeting.id}`, board, { status: 'held', revision: meeting.revisionNo });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    meeting = updated.body.meeting;
  }
  return { board, meeting };
}

test('#208 (bariera, 23505, zebrania): podwójne utworzenie zebrania z tym samym kluczem — druga transakcja dostaje 23505 na meeting_request_keys, wycofuje swój zapis i odtwarza pierwszy', { skip }, async () => {
  await withReal(async (db) => {
    await seedSchoolYear(db, YEAR);
    const board = await boardSession(db, 'u-board-1');
    const body = { schoolYearId: YEAR, kind: 'plenary', title: 'Zebranie plenarne', scheduledAt: inDays(20), location: 'Sala 1', status: 'scheduled' };
    const idempotencyKey = key('mt');
    const call = (env) => callApi(env, 'POST', '/api/meetings', board, body, idempotencyKey);
    const r = await race(db, { pauseAfter: /INSERT INTO meeting_request_keys/, first: call, second: call });
    assertUniqueRace(r, /^INSERT INTO meeting_request_keys/, 'drugie utworzenie zebrania czeka na klucz idempotencji');
    assert.equal(r.a.status, 201, JSON.stringify(r.a.body));
    assert.deepEqual([r.b.status, r.b.replayed], [200, 'true'], JSON.stringify(r.b.body));
    assert.equal(r.b.body.meeting.id, r.a.body.meeting.id);
    assert.equal(await countRows(db, 'SELECT count(*)::int AS n FROM meetings'), 1, 'zapis przegranej transakcji wycofany');
    assert.equal(await auditCount(db, 'meeting.created'), 1);
  });
});

test('#208 (bariera, wyzwalacz, zebrania): dwie wersje protokołu pod różnymi kluczami — drugi INSERT czeka na blokadę zebrania w wyzwalaczu i dostaje 409 minutes_version_mismatch, ponowienie zapisuje wersję 2', { skip }, async () => {
  await withReal(async (db) => {
    const { board, meeting } = await meetingSetup(db, { held: true });
    const path = `/api/meetings/${meeting.id}/minutes`;
    // Numer wersji wylicza wyzwalacz meeting_minutes_insert_guard (0009) pod `FOR UPDATE` na zebraniu, więc
    // do indeksu unikalnego (23505) druga transakcja nie dociera: widzi wersję pierwszej i odrzuca własną (P0001).
    const r = await race(db, {
      pauseAfter: /INSERT INTO meeting_minutes/,
      first: (env) => callApi(env, 'POST', path, board, { body: 'Treść protokołu A (syntetyczna).' }, key('min')),
      second: (env) => callApi(env, 'POST', path, board, { body: 'Treść protokołu B (syntetyczna).' }, key('min')),
    });
    assertWaitsOn(r, /^INSERT INTO meeting_minutes/, 'druga wersja protokołu czeka na blokadę zebrania w wyzwalaczu', { event: 'transactionid' });
    assert.deepEqual(r.errors, ['P0001'], 'odrzucenie przez wyzwalacz, nie 23505');
    assert.equal(r.a.status, 201, JSON.stringify(r.a.body));
    assert.deepEqual([r.b.status, r.b.body.error], [409, 'minutes_version_mismatch']);
    assert.equal(await countRows(db, 'SELECT count(*)::int AS n FROM meeting_minutes WHERE meeting_id = $1', [meeting.id]), 1);
    const retry = await callApi({ db }, 'POST', path, board, { body: 'Treść protokołu B (syntetyczna).' }, key('min'));
    assert.equal(retry.status, 201, JSON.stringify(retry.body));
    assert.equal(retry.body.minutes.version, 2);
  });
});

test('#208 (bariera, 23505, zebrania): dwa zapisy nowej osoby na liście obecności — drugi (ON CONFLICT DO NOTHING) nic nie wstawia i dostaje 409 concurrent_version', { skip }, async () => {
  await withReal(async (db) => {
    const { board, meeting } = await meetingSetup(db);
    await seedRoleGrant(db, { userId: 'u-att', role: 'board' });
    const path = `/api/meetings/${meeting.id}/attendance`;
    const body = { userId: 'u-att', capacity: 'board_member', votingEligible: true, present: true };
    const call = (env) => callApi(env, 'POST', path, board, body);
    const r = await race(db, { pauseAfter: /INSERT INTO meeting_attendees/, first: call, second: call });
    assertWaitsOn(r, /^INSERT INTO meeting_attendees/, 'drugi zapis obecności czeka na indeks (zebranie, osoba)', { event: 'transactionid' });
    assert.equal(r.a.status, 200, JSON.stringify(r.a.body));
    assert.deepEqual([r.b.status, r.b.body.error], [409, 'concurrent_version']);
    assert.equal(await countRows(db, 'SELECT count(*)::int AS n FROM meeting_attendees WHERE meeting_id = $1', [meeting.id]), 1);
    assert.equal(await auditCount(db, 'meeting.attendance.recorded'), 1);
    const retry = await callApi({ db }, 'POST', path, board, body);
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(await auditCount(db, 'meeting.attendance.corrected'), 1, 'ponowienie jest korektą istniejącego wiersza');
  });
});

// ---------------------------------------------------------------- zamknięcie roku

const OLD = 'y-2026';
const NEW = 'y-2027';

async function yearCloseSetup(db) {
  await db.query(`INSERT INTO school_years (id, label, starts_on, ends_on) VALUES
    ($1, '2026/27 test', '2026-09-01', '2027-08-31'), ($2, '2027/28 test', '2027-09-01', '2028-08-31')`, [OLD, NEW]);
  await seedClass(db, { id: 'c-1a', schoolYearId: OLD, name: '1A' });
  return seedUserSession(db, { userId: 'u-board-a', mfa: true, roles: [{ role: 'board', schoolYearId: OLD }] });
}

test('#208 (bariera, 23505, zamknięcie roku): podwójne „Rozpocznij zamykanie” — druga transakcja dostaje 23505 na school_year_closures i 409 conflict, ponowienie jest powtórką', { skip }, async () => {
  await withReal(async (db) => {
    const board = await yearCloseSetup(db);
    const path = `/api/year-close/${OLD}/start`;
    const body = { nextSchoolYearId: NEW };
    const call = (env) => callApi(env, 'POST', path, board, body);
    // Wiersz zamknięcia jeszcze nie istnieje, więc `FOR UPDATE` w loadClosure niczego nie blokuje:
    // o kolejności decyduje indeks unikalny roku, a przegrany dostaje 23505 (dziś 409, nie powtórkę).
    const r = await race(db, { pauseAfter: /INSERT INTO school_year_closures/, first: call, second: call });
    // 23505 jest mapowany na RequestError('conflict') w samej transakcji (mapDatabaseError), więc nie
    // trafia do `errors`; dowodem jest czekanie na transakcję pierwszego i 409 `conflict` (kod tylko z tej gałęzi).
    assertWaitsOn(r, /^INSERT INTO school_year_closures/, 'drugie rozpoczęcie zamykania czeka na indeks unikalny roku', { event: 'transactionid' });
    assert.equal(r.a.status, 201, JSON.stringify(r.a.body));
    assert.deepEqual([r.b.status, r.b.body.error], [409, 'conflict']);
    assert.equal(await countRows(db, 'SELECT count(*)::int AS n FROM school_year_closures WHERE school_year_id = $1', [OLD]), 1);
    assert.equal(await auditCount(db, 'year_close.started'), 1);
    const retry = await callApi({ db }, 'POST', path, board, body);
    assert.deepEqual([retry.status, retry.body.replayed], [200, true], JSON.stringify(retry.body));
  });
});

test('#208 (bariera, zamknięcie roku): podwójne potwierdzenie punktu listy kontrolnej — drugie czeka na blokadę wiersza zamknięcia i jest powtórką (jeden wpis)', { skip }, async () => {
  await withReal(async (db) => {
    const board = await yearCloseSetup(db);
    const started = await callApi({ db }, 'POST', `/api/year-close/${OLD}/start`, board, { nextSchoolYearId: NEW });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const path = `/api/year-close/${OLD}/checklist/${CHECKLIST_ITEMS[0]}`;
    const call = (env) => callApi(env, 'POST', path, board, { note: 'Potwierdzenie syntetyczne' });
    const r = await race(db, { pauseAfter: /INSERT INTO school_year_closure_checklist/, first: call, second: call });
    assertWaitsOn(r, /^SELECT \* FROM school_year_closures WHERE school_year_id = \$1/, 'drugie potwierdzenie czeka na blokadę wiersza zamknięcia');
    assert.equal(r.a.status, 201, JSON.stringify(r.a.body));
    assert.deepEqual([r.b.status, r.b.body.replayed], [200, true], JSON.stringify(r.b.body));
    assert.deepEqual(r.errors, [], 'bez błędów bazy: powtórka, nie 23505');
    assert.equal(await countRows(db, 'SELECT count(*)::int AS n FROM school_year_closure_checklist'), 1);
    assert.equal(await auditCount(db, 'year_close.checklist_confirmed'), 1);
  });
});
