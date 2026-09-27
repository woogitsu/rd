// Aktualności i galeria (#14). Wyłącznie dane syntetyczne: identyfikatory
// dokumentów i zgód są fikcyjne, bez imion dzieci i opiekunów.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import {
  addConsent, approve, createDraft, getInternal, getPhoto, listInternal, listPublic, publish,
  registerPhoto, revokePhoto, submit, updateDraft, verifyPhoto, withdraw, PUBLIC_CACHE_SECONDS,
} from '../src/pg/news.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';

// Jedna baza PGlite na plik (oszczędność pamięci); testy izolowane rokiem szkolnym.
const board1 = { userId: 'board1', grants: [{ role: 'board', classId: null, schoolYearId: null }], mfaVerified: true };
const board2 = { userId: 'board2', grants: [{ role: 'board', classId: null, schoolYearId: null }], mfaVerified: true };
const admin = { userId: 'admin', grants: [{ role: 'admin', classId: null, schoolYearId: null }], mfaVerified: true };
const treasurer = { userId: 'treasurer', grants: [{ role: 'treasurer', classId: null, schoolYearId: null }], mfaVerified: true };

let shared;
let yearCounter = 0;
let year = 'y-test';
let rep1A;
let rep1B;

async function sharedDb() {
  if (!shared) {
    shared = await createTestDb();
    for (const userId of ['board1', 'board2', 'admin', 'rep1a', 'rep1b', 'treasurer']) await seedUser(shared, { userId });
  }
  return shared;
}

// Nowy rok szkolny i klasy dla każdego testu; zwraca wspólną bazę.
async function newsDb() {
  const db = await sharedDb();
  yearCounter += 1;
  year = `y-news-${yearCounter}`;
  await seedSchoolYear(db, year);
  await seedClass(db, { id: `${year}-1a`, schoolYearId: year });
  await seedClass(db, { id: `${year}-1b`, schoolYearId: year });
  rep1A = { userId: 'rep1a', grants: [{ role: 'representative', classId: `${year}-1a`, schoolYearId: year }] };
  rep1B = { userId: 'rep1b', grants: [{ role: 'representative', classId: `${year}-1b`, schoolYearId: year }] };
  return { query: (...a) => db.query(...a), transaction: (fn) => db.transaction(fn), close: async () => {} };
}

const pub = async (db) => listPublic(db, { schoolYearId: year });

after(async () => { if (shared) await shared.close(); });

let counter = 0;
const key = (prefix) => `${prefix}-${String(++counter).padStart(6, '0')}`;

function postInput(overrides = {}) {
  return {
    schoolYearId: year,
    title: 'Kiermasz – podsumowanie (syntetyczne)',
    body: 'Dziękujemy wszystkim za udział.\nZebrana kwota zostanie podana po rozliczeniu.',
    idempotencyKey: key('news'),
    ...overrides,
  };
}

function photoInput(overrides = {}) {
  return {
    documentId: key('doc'),
    author: 'Fotograf testowy',
    source: 'own_work',
    takenOn: '2026-10-10',
    licenseText: 'Zdjęcie własne autora, udostępnione Radzie do publikacji.',
    altText: 'Stół kiermaszowy z ciastami',
    depictsChildren: false,
    idempotencyKey: key('photo'),
    ...overrides,
  };
}

async function verifiedPhoto(db, overrides = {}) {
  const { photo } = await registerPhoto(db, admin, photoInput(overrides));
  return (await verifyPhoto(db, board1, { photoId: photo.id })).photo;
}

async function publishedPost(db, overrides = {}) {
  const { post } = await createDraft(db, board1, postInput(overrides));
  await submit(db, board1, { postId: post.id, revision: 1 });
  await approve(db, board2, { postId: post.id, revision: 1 });
  return (await publish(db, board2, { postId: post.id, revision: 1 })).post;
}

test('drafts, submitted and approved posts never appear publicly; public payload has no internal ids', async () => {
  const db = await newsDb();
  try {
    await createDraft(db, board1, postInput({ title: 'Szkic tajny' }));
    const submitted = (await createDraft(db, board1, postInput({ title: 'Zgłoszony tajny' }))).post;
    await submit(db, board1, { postId: submitted.id, revision: 1 });
    const approved = (await createDraft(db, board1, postInput({ title: 'Zatwierdzony tajny' }))).post;
    await submit(db, board1, { postId: approved.id, revision: 1 });
    await approve(db, board2, { postId: approved.id, revision: 1 });
    assert.deepEqual((await pub(db)).posts, []);

    const photo = await verifiedPhoto(db, { rightsNote: 'Notatka wewnętrzna o prawach' });
    await publishedPost(db, { title: 'Publiczna aktualność', photoIds: [photo.id] });
    const list = await pub(db);
    assert.deepEqual(list.posts.map((p) => p.title), ['Publiczna aktualność']);
    assert.deepEqual(Object.keys(list.posts[0]).sort(), ['body', 'id', 'photos', 'publishedAt', 'title']);
    assert.deepEqual(list.posts[0].photos, [{
      id: photo.id, author: 'Fotograf testowy', source: 'own_work',
      license: 'Zdjęcie własne autora, udostępnione Radzie do publikacji.',
      takenOn: '2026-10-10', altText: 'Stół kiermaszowy z ciastami',
    }]);
    const body = JSON.stringify(list);
    for (const leak of ['board1', 'board2', 'admin', 'tajny', 'uploadedBy', 'createdBy', 'approvedBy',
      'documentId', photo.documentId, 'Notatka wewnętrzna', 'revision']) {
      assert.equal(body.includes(leak), false, `public payload leaks ${leak}`);
    }
  } finally { await db.close(); }
});

test('a post with a photo without verified rights cannot be approved or published', async () => {
  const db = await newsDb();
  try {
    const { photo } = await registerPhoto(db, admin, photoInput());
    const { post } = await createDraft(db, board1, postInput({ photoIds: [photo.id] }));
    await submit(db, board1, { postId: post.id, revision: 1 });
    await assert.rejects(approve(db, board2, { postId: post.id, revision: 1 }), { code: 'photo_rights_unverified' });

    // Weryfikacja, zatwierdzenie, potem cofnięcie praw przed publikacją.
    await verifyPhoto(db, board1, { photoId: photo.id });
    await approve(db, board2, { postId: post.id, revision: 1 });
    await revokePhoto(db, board1, { photoId: photo.id, reason: 'Autor wycofał zgodę' });
    await assert.rejects(publish(db, board2, { postId: post.id, revision: 1 }), { code: 'photo_revoked' });

    // Bezpośredni UPDATE z pominięciem API też jest blokowany przez trigger.
    const { photo: pending } = await registerPhoto(db, admin, photoInput());
    const second = (await createDraft(db, board1, postInput({ photoIds: [pending.id] }))).post;
    await submit(db, board1, { postId: second.id, revision: 1 });
    await assert.rejects(db.query(
      `UPDATE news_posts SET status='approved', approved_revision_no=1, approved_by='board2', approved_at=now() WHERE id=$1`,
      [second.id],
    ), /news_post_photo_rights_unverified/);
    await assert.rejects(createDraft(db, board1, postInput({ photoIds: ['missing-photo'] })), { code: 'photo_not_found' });
    assert.deepEqual((await pub(db)).posts, []);
  } finally { await db.close(); }
});

test('photos with children require a consent reference for each identifiable child', async () => {
  const db = await newsDb();
  try {
    const { photo } = await registerPhoto(db, admin, photoInput({ depictsChildren: true, identifiableChildren: 2 }));
    await assert.rejects(verifyPhoto(db, board1, { photoId: photo.id }), { code: 'child_consent_required' });
    await addConsent(db, admin, { photoId: photo.id, subjectNo: 1, subjectKind: 'child', consentDocumentRef: 'consent-doc-0001' });
    // Podwójne kliknięcie tego samego wpisu nie dubluje zgody.
    assert.equal((await addConsent(db, admin, { photoId: photo.id, subjectNo: 1, subjectKind: 'child', consentDocumentRef: 'consent-doc-0001' })).replayed, true);
    await assert.rejects(addConsent(db, admin, { photoId: photo.id, subjectNo: 1, subjectKind: 'child', consentDocumentRef: 'consent-doc-9999' }), { code: 'consent_conflict' });
    await assert.rejects(verifyPhoto(db, board1, { photoId: photo.id }), { code: 'consent_missing' });
    // Rodzeństwo: jedna zgoda opiekuna może obejmować dwoje dzieci.
    await addConsent(db, admin, { photoId: photo.id, subjectNo: 2, subjectKind: 'child', consentDocumentRef: 'consent-doc-0001' });
    const verified = await verifyPhoto(db, board1, { photoId: photo.id });
    assert.equal(verified.photo.rightsStatus, 'verified');
    await assert.rejects(addConsent(db, admin, { photoId: photo.id, subjectNo: 3, subjectKind: 'adult', consentDocumentRef: 'consent-doc-0002' }), { code: 'consents_locked' });

    const detail = await getPhoto(db, board2, { photoId: photo.id });
    assert.deepEqual(detail.photo.consents.map((c) => [c.subjectNo, c.subjectKind, c.consentDocumentRef]),
      [[1, 'child', 'consent-doc-0001'], [2, 'child', 'consent-doc-0001']]);

    // Dorośli rozpoznawalni też wymagają odwołania do zgody.
    const { photo: adults } = await registerPhoto(db, admin, photoInput({ identifiableAdults: 1 }));
    await assert.rejects(verifyPhoto(db, board1, { photoId: adults.id }), { code: 'consent_missing' });
    // Nie da się zaznaczyć rozpoznawalnych dzieci bez flagi depictsChildren.
    await assert.rejects(registerPhoto(db, admin, photoInput({ identifiableChildren: 1 })), { code: 'invalid_depicts_children' });
    // Trigger bazy nie dopuszcza weryfikacji bez zgody także z pominięciem API.
    const { photo: raw } = await registerPhoto(db, admin, photoInput({ depictsChildren: true }));
    await assert.rejects(db.query(`UPDATE news_photos SET rights_status='verified', rights_verified_by='board1', rights_verified_at=now() WHERE id=$1`, [raw.id]), /news_photo_child_consent_required/);
  } finally { await db.close(); }
});

test('copies from a public website are rejected without an explicit licence', async () => {
  const db = await newsDb();
  try {
    await assert.rejects(registerPhoto(db, admin, photoInput({ source: 'public_website_copy' })), { code: 'public_copy_requires_license' });
    await assert.rejects(registerPhoto(db, admin, photoInput({ source: 'public_website_copy', explicitLicenseGranted: true })), { code: 'public_copy_requires_license' });
    await assert.rejects(db.query(
      `INSERT INTO news_photos (id, document_id, author, source, taken_on, license_text, depicts_children, uploaded_by)
       VALUES ('p-raw','doc-raw','Autor','public_website_copy','2020-01-01','Skopiowano ze strony szkoły',false,'admin')`,
    ), /news_photo_public_copy_requires_license/);
    const licensed = await registerPhoto(db, admin, photoInput({
      source: 'public_website_copy', explicitLicenseGranted: true, licenseDocumentRef: 'license-doc-0001',
      sourceDetail: 'Strona szkoły, zgoda pisemna na ponowną publikację',
    }));
    assert.equal(licensed.photo.rightsStatus, 'pending');
  } finally { await db.close(); }
});

test('four eyes: self-approval of posts and self-verification of photos are refused', async () => {
  const db = await newsDb();
  try {
    const { post } = await createDraft(db, board1, postInput());
    await submit(db, board1, { postId: post.id, revision: 1 });
    await assert.rejects(approve(db, board1, { postId: post.id, revision: 1 }), { code: 'four_eyes_required' });
    // Autor wersji (inny niż autor wpisu) też nie zatwierdza własnej wersji.
    await updateDraft(db, board2, { postId: post.id, revision: 1, body: 'Poprawiona treść.' });
    await submit(db, board2, { postId: post.id, revision: 2 });
    await assert.rejects(approve(db, board2, { postId: post.id, revision: 2 }), { code: 'four_eyes_required' });
    await assert.rejects(db.query(
      `UPDATE news_posts SET status='approved', approved_revision_no=2, approved_by='board2', approved_at=now() WHERE id=$1`, [post.id],
    ), /news_post_four_eyes_required/);

    const { photo } = await registerPhoto(db, board1, photoInput());
    await assert.rejects(verifyPhoto(db, board1, { photoId: photo.id }), { code: 'four_eyes_required' });
    await assert.rejects(db.query(
      `UPDATE news_photos SET rights_status='verified', rights_verified_by='board1', rights_verified_at=now() WHERE id=$1`, [photo.id],
    ), /news_photo_four_eyes_required/);
    // Admin rejestruje, ale nie weryfikuje praw ani nie zatwierdza.
    const { photo: other } = await registerPhoto(db, board2, photoInput());
    await assert.rejects(verifyPhoto(db, admin, { photoId: other.id }), { code: 'forbidden' });
    await assert.rejects(approve(db, admin, { postId: post.id, revision: 2 }), { code: 'forbidden' });
  } finally { await db.close(); }
});

test('withdrawal and photo revocation hide content from the public view immediately', async () => {
  const db = await newsDb();
  try {
    const photoA = await verifiedPhoto(db);
    const photoB = await verifiedPhoto(db);
    const post = await publishedPost(db, { photoIds: [photoA.id, photoB.id] });
    assert.equal((await pub(db)).posts[0].photos.length, 2);

    await revokePhoto(db, board1, { photoId: photoA.id, reason: 'Wycofanie zgody opiekuna' });
    assert.deepEqual((await pub(db)).posts[0].photos.map((p) => p.id), [photoB.id]);

    await assert.rejects(withdraw(db, board1, { postId: post.id, revision: 1 }), { code: 'invalid_reason' });
    await withdraw(db, board1, { postId: post.id, revision: 1, reason: 'Błąd w treści' });
    assert.deepEqual((await pub(db)).posts, []);
    assert.equal((await withdraw(db, board1, { postId: post.id, revision: 1, reason: 'Ponowne kliknięcie' })).replayed, true);
    await assert.rejects(updateDraft(db, board1, { postId: post.id, revision: 1, title: 'Wskrzeszenie' }), { code: 'post_withdrawn' });
    await assert.rejects(db.query(`UPDATE news_posts SET title='Obejście' WHERE id=$1`, [post.id]), /news_post_withdrawn_is_final/);

    // Wpis opublikowany wycofuje tylko zarząd.
    const other = await publishedPost(db);
    await assert.rejects(withdraw(db, admin, { postId: other.id, revision: 1, reason: 'Próba admina' }), { code: 'forbidden' });

    const { rows } = await db.query(
      `SELECT action, metadata_json FROM audit_events WHERE entity_id = $1 ORDER BY occurred_at, action`, [post.id],
    );
    assert.deepEqual(rows.map((r) => r.action).sort(),
      ['news_post.approved', 'news_post.created', 'news_post.published', 'news_post.submitted', 'news_post.withdrawn']);
    assert.equal(JSON.stringify(rows).includes('Błąd w treści'), false);
  } finally { await db.close(); }
});

test('edits after publication keep the published revision public; history is immutable', async () => {
  const db = await newsDb();
  try {
    const post = await publishedPost(db, { title: 'Wersja pierwsza' });
    const edited = await updateDraft(db, board1, { postId: post.id, revision: 1, title: 'Wersja druga' });
    assert.equal(edited.post.revision, 2);
    assert.equal(edited.post.status, 'draft');
    assert.equal((await pub(db)).posts[0].title, 'Wersja pierwsza');
    // Podwójne kliknięcie tej samej zmiany nie tworzy trzeciej wersji.
    assert.equal((await updateDraft(db, board1, { postId: post.id, revision: 1, title: 'Wersja druga' })).replayed, true);
    await assert.rejects(updateDraft(db, board2, { postId: post.id, revision: 1, title: 'Nadpisanie' }), { code: 'revision_conflict' });

    await assert.rejects(db.query(`UPDATE news_post_revisions SET title='x' WHERE post_id=$1`, [post.id]), /cannot_be_changed/);
    await assert.rejects(db.query(`DELETE FROM news_post_revisions WHERE post_id=$1`, [post.id]), /cannot_be_changed/);
    await assert.rejects(db.query(`DELETE FROM news_posts WHERE id=$1`, [post.id]), /cannot_be_changed/);
    await assert.rejects(db.query(
      `INSERT INTO news_post_revisions (post_id, revision_no, title, body, photo_ids, created_by) VALUES ($1, 9, 'Fałsz', 'x', '{}', 'board1')`, [post.id],
    ), /news_post_revision_must_match_current_post/);
    const photo = await verifiedPhoto(db);
    await assert.rejects(db.query(`UPDATE news_photos SET author='Ktoś inny' WHERE id=$1`, [photo.id]), /news_photo_metadata_immutable/);
    await assert.rejects(db.query(`DELETE FROM news_photos WHERE id=$1`, [photo.id]), /cannot_be_changed/);

    const detail = await getInternal(db, board2, { postId: post.id });
    assert.deepEqual(detail.revisions.map((r) => [r.revision, r.title]), [[1, 'Wersja pierwsza'], [2, 'Wersja druga']]);
  } finally { await db.close(); }
});

test('role boundaries: representative drafts only for own class and without photos', async () => {
  const db = await newsDb();
  try {
    const own = (await createDraft(db, rep1A, postInput({ classId: `${year}-1a` }))).post;
    await assert.rejects(createDraft(db, rep1A, postInput({ classId: `${year}-1b` })), { code: 'forbidden' });
    await assert.rejects(createDraft(db, rep1A, postInput()), { code: 'forbidden' });
    const photo = await verifiedPhoto(db);
    await assert.rejects(createDraft(db, rep1A, postInput({ classId: `${year}-1a`, photoIds: [photo.id] })), { code: 'photos_require_school_wide_role' });
    await assert.rejects(getInternal(db, rep1B, { postId: own.id }), { code: 'post_not_found' });
    await assert.rejects(submit(db, rep1B, { postId: own.id, revision: 1 }), { code: 'post_not_found' });
    await submit(db, rep1A, { postId: own.id, revision: 1 });
    await assert.rejects(approve(db, rep1A, { postId: own.id, revision: 1 }), { code: 'forbidden' });
    assert.deepEqual((await listInternal(db, rep1B, { schoolYearId: year })).posts, []);
    assert.equal((await listInternal(db, rep1A, { schoolYearId: year })).posts.length, 1);
    await assert.rejects(listInternal(db, treasurer, { schoolYearId: year }), { code: 'forbidden' });
    await assert.rejects(registerPhoto(db, rep1A, photoInput()), { code: 'forbidden' });
    await assert.rejects(registerPhoto(db, treasurer, photoInput()), { code: 'forbidden' });
    // Zarząd zatwierdza i publikuje wpis klasy.
    await approve(db, board1, { postId: own.id, revision: 1 });
    await publish(db, board1, { postId: own.id, revision: 1 });
    assert.equal((await pub(db)).posts.length, 1);
    // Idempotencja szkicu: ten sam klucz zwraca ten sam wpis, inna treść — konflikt.
    const input = postInput();
    const first = await createDraft(db, board1, input);
    const again = await createDraft(db, board1, input);
    assert.equal(again.replayed, true);
    assert.equal(again.post.id, first.post.id);
    await assert.rejects(createDraft(db, board1, { ...input, title: 'Inny tytuł' }), { code: 'idempotency_conflict' });
  } finally { await db.close(); }
});

test('HTTP: public route, sessions, cross-origin refusal and text stored verbatim', async () => {
  const db = await newsDb();
  try {
    const env = { db };
    const boardA = await seedUserSession(db, { userId: 'u-board-a', roles: [{ role: 'board', schoolYearId: year }], mfa: true });
    const boardB = await seedUserSession(db, { userId: 'u-board-b', roles: [{ role: 'board', schoolYearId: year }], mfa: true });

    assert.equal((await handlePgRequest(request(`/api/news?schoolYearId=${year}`), env)).status, 401);
    assert.equal((await handlePgRequest(request('/api/news-photos'), env)).status, 401);

    const crossOrigin = await handlePgRequest(request('/api/news', {
      method: 'POST', cookie: boardA, origin: 'https://evil.example', body: postInput(),
      headers: { 'Idempotency-Key': key('http') },
    }), env);
    assert.equal(crossOrigin.status, 403);
    assert.deepEqual(await crossOrigin.json(), { error: 'invalid_origin' });
    const crossPhoto = await handlePgRequest(request('/api/news-photos', {
      method: 'POST', cookie: boardA, origin: 'https://evil.example', body: photoInput(),
      headers: { 'Idempotency-Key': key('http') },
    }), env);
    assert.equal(crossPhoto.status, 403);

    const markup = '<script>alert(1)</script> & <b>pogrubienie</b> "cudzysłów"';
    const created = await handlePgRequest(request('/api/news', {
      method: 'POST', cookie: boardA, headers: { 'Idempotency-Key': key('http') },
      body: { schoolYearId: year, title: 'Tytuł <i>z tagiem</i>', body: `${markup}\r\nDruga linia` },
    }), env);
    assert.equal(created.status, 201);
    const { post } = await created.json();
    for (const [path, body] of [[`/api/news/${post.id}/submit`, { revision: 1 }]]) {
      assert.equal((await handlePgRequest(request(path, { method: 'POST', cookie: boardA, body }), env)).status, 200);
    }
    const selfApprove = await handlePgRequest(request(`/api/news/${post.id}/approve`, { method: 'POST', cookie: boardA, body: { revision: 1 } }), env);
    assert.equal(selfApprove.status, 409);
    assert.deepEqual(await selfApprove.json(), { error: 'four_eyes_required' });
    assert.equal((await handlePgRequest(request(`/api/news/${post.id}/approve`, { method: 'POST', cookie: boardB, body: { revision: 1 } }), env)).status, 200);

    let pub = await handlePgRequest(request(`/api/public/news?schoolYearId=${year}`), env);
    assert.deepEqual((await pub.json()).posts, []);
    assert.equal((await handlePgRequest(request(`/api/news/${post.id}/publish`, { method: 'POST', cookie: boardB, body: { revision: 1 } }), env)).status, 200);

    pub = await handlePgRequest(request(`/api/public/news?schoolYearId=${year}`), env);
    assert.equal(pub.status, 200);
    assert.match(pub.headers.get('Content-Type'), /^application\/json/);
    assert.equal(pub.headers.get('X-Content-Type-Options'), 'nosniff');
    const maxAge = Number(/max-age=(\d+)/.exec(pub.headers.get('Cache-Control'))[1]);
    assert.ok(maxAge <= 60 && maxAge === PUBLIC_CACHE_SECONDS);
    const [item] = (await pub.json()).posts;
    // API zwraca dokładny tekst (bez interpretacji HTML); escapowanie należy do UI.
    assert.equal(item.title, 'Tytuł <i>z tagiem</i>');
    assert.equal(item.body, `${markup}\nDruga linia`);

    const controls = await handlePgRequest(request('/api/news', {
      method: 'POST', cookie: boardA, headers: { 'Idempotency-Key': key('http') },
      body: { schoolYearId: year, title: 'Znak\u0000sterujący', body: 'x' },
    }), env);
    assert.equal(controls.status, 400);

    assert.equal((await handlePgRequest(request('/api/public/news', { method: 'POST', body: {} }), env)).status, 405);
    const withdrawn = await handlePgRequest(request(`/api/news/${post.id}/withdraw`, {
      method: 'POST', cookie: boardB, body: { revision: 1, reason: 'Wycofanie testowe' },
    }), env);
    assert.equal(withdrawn.status, 200);
    assert.deepEqual((await (await handlePgRequest(request(`/api/public/news?schoolYearId=${year}`), env)).json()).posts, []);
  } finally { await db.close(); }
});
