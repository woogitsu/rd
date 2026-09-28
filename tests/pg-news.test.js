// Aktualności i galeria (#14). Wyłącznie dane syntetyczne: identyfikatory
// dokumentów i zgód są fikcyjne, bez imion dzieci i opiekunów.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { handlePgRequest } from '../src/pg/app.js';
import {
  addConsent, approve, createDraft, getInternal, getPhoto, listInternal, listPublic, publish,
  registerPhoto, revokePhoto, submit, updateDraft, verifyPhoto, withdraw, withdrawConsent, PUBLIC_CACHE_SECONDS,
  PHOTO_UPLOAD_MAX_BYTES, uploadPhotoFile,
} from '../src/pg/news.js';
import { newsItems } from '../site/core.js';
import { createMemoryStorage } from '../src/storage.js';
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
      takenOn: '2026-10-10', altText: 'Stół kiermaszowy z ciastami', decorative: false,
    }]);
    const body = JSON.stringify(list);
    for (const leak of ['board1', 'board2', 'admin', 'tajny', 'uploadedBy', 'createdBy', 'approvedBy',
      'documentId', photo.documentId, 'Notatka wewnętrzna', 'revision']) {
      assert.equal(body.includes(leak), false, `public payload leaks ${leak}`);
    }
  } finally { await db.close(); }
});

test('kontrakt API → strona: newsItems czyta rzeczywistą odpowiedź listPublic (#237)', async () => {
  const db = await newsDb();
  try {
    // Pusta lista: strona pokaże „Brak opublikowanych aktualności” tylko wtedy.
    assert.deepEqual(newsItems(await pub(db)), []);
    await publishedPost(db, { title: 'Starsza aktualność' });
    await publishedPost(db, { title: 'Nowsza aktualność' });
    const payload = JSON.parse(JSON.stringify(await pub(db))); // kształt jak z fetch().json()
    const items = newsItems(payload);
    assert.deepEqual(items.map((n) => n.title), ['Nowsza aktualność', 'Starsza aktualność']);
    for (const [index, item] of items.entries()) {
      assert.equal(item.id, payload.posts[index].id);
      assert.equal(item.body, payload.posts[index].body);
      assert.equal(item.publishedAt.toISOString(), new Date(payload.posts[index].publishedAt).toISOString());
      assert.deepEqual(Object.keys(item).sort(), ['body', 'id', 'publishedAt', 'title']);
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

// Zakres, ważność i wycofanie jednej zgody (#106, część — patrz PR).
test('zgoda na wizerunek: zakres, wygaśnięcie i wycofanie (rodzeństwo, dwoje opiekunów)', async () => {
  const db = await newsDb();
  try {
    // Zakres tylko `print` nie trafia na stronę Rady.
    const { photo: printOnly } = await registerPhoto(db, admin, photoInput({ depictsChildren: true, identifiableChildren: 1 }));
    await addConsent(db, admin, {
      photoId: printOnly.id, subjectNo: 1, subjectKind: 'child',
      consentDocumentRef: 'consent-doc-print-01', scope: ['print'],
    });
    await verifyPhoto(db, board1, { photoId: printOnly.id });
    const printPost = await publishedPost(db, { photoIds: [printOnly.id] });
    assert.deepEqual((await pub(db)).posts[0].photos, []);
    await withdraw(db, board1, { postId: printPost.id, revision: 1, reason: 'Sprzątanie po teście' });

    // Zgoda wygasła wczoraj nie jest widoczna publicznie.
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    const { photo: expired } = await registerPhoto(db, admin, photoInput({ depictsChildren: true, identifiableChildren: 1 }));
    await addConsent(db, admin, {
      photoId: expired.id, subjectNo: 1, subjectKind: 'child',
      consentDocumentRef: 'consent-doc-expired-01', scope: ['rada_website'], validUntil: yesterday,
    });
    await verifyPhoto(db, board1, { photoId: expired.id });
    const expiredPost = await publishedPost(db, { photoIds: [expired.id] });
    assert.deepEqual((await pub(db)).posts[0].photos, []);
    await withdraw(db, board1, { postId: expiredPost.id, revision: 1, reason: 'Sprzątanie po teście' });

    // Rodzeństwo: jedna zgoda (ten sam consentDocumentRef) na dwoje dzieci na
    // dwóch osobnych zdjęciach — wycofanie ukrywa oba.
    const ref = 'consent-doc-siblings-01';
    const { photo: siblingA } = await registerPhoto(db, admin, photoInput({ depictsChildren: true, identifiableChildren: 1 }));
    await addConsent(db, admin, { photoId: siblingA.id, subjectNo: 1, subjectKind: 'child', consentDocumentRef: ref });
    await verifyPhoto(db, board1, { photoId: siblingA.id });
    const { photo: siblingB } = await registerPhoto(db, admin, photoInput({ depictsChildren: true, identifiableChildren: 1 }));
    await addConsent(db, admin, { photoId: siblingB.id, subjectNo: 1, subjectKind: 'child', consentDocumentRef: ref });
    await verifyPhoto(db, board1, { photoId: siblingB.id });
    const siblingsPost = await publishedPost(db, { photoIds: [siblingA.id, siblingB.id] });
    assert.deepEqual((await pub(db)).posts[0].photos.map((p) => p.id).sort(), [siblingA.id, siblingB.id].sort());

    // Przedstawiciel klasy i skarbnik — brak dostępu do wycofania zgody.
    await assert.rejects(withdrawConsent(db, rep1A, { consentDocumentRef: ref }), { code: 'forbidden' });
    await assert.rejects(withdrawConsent(db, treasurer, { consentDocumentRef: ref }), { code: 'forbidden' });
    await assert.rejects(withdrawConsent(db, board1, { consentDocumentRef: 'consent-doc-brak' }), { code: 'consent_not_found' });

    const result = await withdrawConsent(db, board1, { consentDocumentRef: ref });
    assert.equal(result.replayed, false);
    assert.equal(result.affectedPhotos, 2);
    assert.deepEqual((await pub(db)).posts[0].photos, []);

    // Podwójne kliknięcie wycofania — jedno zdarzenie, bez błędu.
    const replay = await withdrawConsent(db, board1, { consentDocumentRef: ref });
    assert.equal(replay.replayed, true);
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM audit_events WHERE action = 'image_consent.withdrawn' AND entity_id = $1`, [ref],
    );
    assert.equal(rows[0].n, 1);

    await withdraw(db, board1, { postId: siblingsPost.id, revision: 1, reason: 'Sprzątanie po teście' });

    // Zakres i data ważności są walidowane.
    const { photo: badScope } = await registerPhoto(db, admin, photoInput());
    await assert.rejects(addConsent(db, admin, {
      photoId: badScope.id, subjectNo: 1, subjectKind: 'adult', consentDocumentRef: 'consent-doc-bad-01', scope: ['nieznany'],
    }), { code: 'invalid_consent_scope' });
    await assert.rejects(addConsent(db, admin, {
      photoId: badScope.id, subjectNo: 1, subjectKind: 'adult', consentDocumentRef: 'consent-doc-bad-02', validUntil: '31-12-2026',
    }), { code: 'invalid_consent_valid_until' });
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

// #124: opis zastępczy jest niezmienny (poprawka = nowe zdjęcie), więc musi
// być podany, albo zdjęcie zadeklarowane jako czysto dekoracyjne, już przy
// rejestracji — inaczej zablokowałaby to dopiero weryfikacja (0071).
test('alt text is required at registration unless the photo is marked decorative', async () => {
  const db = await newsDb();
  try {
    await assert.rejects(
      registerPhoto(db, admin, photoInput({ altText: undefined })),
      { code: 'alt_text_required', status: 422 },
    );
    const { photo: decorative } = await registerPhoto(db, admin, photoInput({ altText: undefined, decorative: true }));
    assert.equal(decorative.altText, null);
    assert.equal(decorative.decorative, true);
    const verified = await verifyPhoto(db, board1, { photoId: decorative.id });
    assert.equal(verified.photo.rightsStatus, 'verified');

    await publishedPost(db, { photoIds: [decorative.id] });
    const list = await pub(db);
    // Zdjęcie dekoracyjne: alt="" (celowo puste), nie null (brak opisu) — WCAG 1.1.1.
    assert.equal(list.posts[0].photos[0].altText, '');
    assert.equal(list.posts[0].photos[0].decorative, true);

    await assert.rejects(registerPhoto(db, admin, photoInput({ decorative: 'yes' })), { code: 'invalid_decorative' });
  } finally { await db.close(); }
});

// news_photo_alt_text_required (0071) jest dodane z NOT VALID: Postgres
// sprawdza je przy każdym kolejnym INSERT/UPDATE (co blokuje bezpośredni
// zapis bez opisu, jak niżej — więc od tej migracji nie da się już w ogóle
// stworzyć wiersza bez alt_text/decorative), ale NIE sprawdza wstecznie
// wierszy zapisanych PRZED tą migracją. Te sprzed migracji (jeśli istniały
// bez opisu) zostają czytelne i zweryfikowane bez zmian — dopóki ktoś nie
// spróbuje ich zaktualizować (np. weryfikacją), co i tak wymaga już opisu.
// Fizyczna symulacja „sprzed migracji” wymagałaby cofnięcia ALTER TABLE w
// trakcie testu, więc sprawdzamy to statycznie w pliku migracji.
test('news_photo_alt_text_required is added with NOT VALID (does not retroactively invalidate existing rows)', async () => {
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(new URL('../postgres/migrations/0071_news_photo_alt_text_required.sql', import.meta.url), 'utf8');
  assert.match(sql, /ADD CONSTRAINT news_photo_alt_text_required\s+CHECK \(alt_text IS NOT NULL OR decorative\) NOT VALID/);
});

test('a raw insert without alt text or decorative is rejected by the database, and the registry view stays empty otherwise', async () => {
  const db = await newsDb();
  try {
    await assert.rejects(db.query(
      `INSERT INTO news_photos (id, document_id, author, source, taken_on, license_text, depicts_children, uploaded_by)
       VALUES ('p-no-alt', 'doc-no-alt', 'Autor', 'own_work', '2020-01-01', 'Zdjęcie bez opisu', false, 'admin')`,
    ), /news_photo_alt_text_required/);
    const { photo } = await registerPhoto(db, admin, photoInput());
    const { rows } = await db.query('SELECT * FROM news_photos_missing_alt_text WHERE id = $1', [photo.id]);
    assert.equal(rows.length, 0, 'zdjęcie z opisem nie powinno trafić do rejestru braków');
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

// --- Plik zdjęcia (#96): warianty bez EXIF/GPS, publiczny odczyt tylko dla ---
// --- zdjęcia zweryfikowanego w opublikowanej wersji, sprzątanie po awarii. --

// JPEG syntetyczny z EXIF (orientacja 6 — obrót 90° w prawo do wyświetlenia)
// i wymiarami niekwadratowymi: po ponownym kodowaniu bez metadanych wymiary
// muszą się zamienić miejscami, co dowodzi, że orientacja została
// uwzględniona PRZED odrzuceniem EXIF (nie tylko że EXIF zniknął).
async function jpegWithExifOrientation() {
  return sharp({ create: { width: 30, height: 10, channels: 3, background: { r: 200, g: 40, b: 10 } } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

test('plik zdjęcia: EXIF/GPS usunięte, orientacja uwzględniona, publiczny odczyt tylko po weryfikacji i publikacji', async () => {
  const db = await newsDb();
  const storage = createMemoryStorage();
  const env = { db, storage };
  try {
    const source = await jpegWithExifOrientation();
    const sourceMeta = await sharp(source).metadata();
    assert.ok(sourceMeta.exif, 'atrapa testowa musi faktycznie nieść EXIF, inaczej test niczego nie sprawdza');

    const { photo } = await registerPhoto(db, admin, photoInput());
    const boardCookie = await seedUserSession(db, { userId: 'u-board-file', roles: [{ role: 'board', schoolYearId: year }], mfa: true });
    const repCookie = await seedUserSession(db, { userId: 'u-rep-file', roles: [{ role: 'representative', classId: `${year}-1a`, schoolYearId: year }], mfa: true });

    // Przedstawiciel klasy nie może przesłać pliku zdjęcia (NEWS.md).
    const denied = await handlePgRequest(request(`/api/news-photos/${photo.id}/file`, {
      method: 'POST', cookie: repCookie, headers: { 'Content-Type': 'image/jpeg', 'Idempotency-Key': key('file') }, body: source,
    }), env);
    assert.equal(denied.status, 403);

    // Nim zdjęcie jest opublikowane, trasa publiczna traktuje je jak nieistniejące.
    const beforeUpload = await handlePgRequest(request(`/api/public/news-photos/${photo.id}/web`), env);
    assert.equal(beforeUpload.status, 404);
    const unknownPhoto = await handlePgRequest(request('/api/public/news-photos/no-such-photo/web'), env);
    assert.equal(unknownPhoto.status, 404);
    assert.deepEqual(await unknownPhoto.json(), await beforeUpload.json());

    const uploadKey = key('file');
    const uploaded = await handlePgRequest(request(`/api/news-photos/${photo.id}/file`, {
      method: 'POST', cookie: boardCookie, headers: { 'Content-Type': 'image/jpeg', 'Idempotency-Key': uploadKey }, body: source,
    }), env);
    assert.equal(uploaded.status, 201);
    const { files } = await uploaded.json();
    assert.deepEqual(files.map((f) => f.variant).sort(), ['thumb', 'web']);
    const web = files.find((f) => f.variant === 'web');
    // Orientacja 6 na źródle 30x10 -> po rotate() wymiary zamienione (10x30),
    // poniżej maksymalnych wymiarów wariantu, więc bez powiększania.
    assert.equal(web.width, 10);
    assert.equal(web.height, 30);

    // Osobny prefiks od dokumentów (docs/) — nie miesza bucketu galerii z
    // bucketem dokumentów finansowych/zarządu/klas.
    const { rows: fileRows } = await db.query('SELECT object_key FROM news_photo_files WHERE photo_id = $1', [photo.id]);
    assert.ok(fileRows.every((r) => r.object_key.startsWith('photos/')));

    // Podwójne kliknięcie: ten sam klucz idempotencji i te same bajty -> powtórka.
    const replay = await handlePgRequest(request(`/api/news-photos/${photo.id}/file`, {
      method: 'POST', cookie: boardCookie, headers: { 'Content-Type': 'image/jpeg', 'Idempotency-Key': uploadKey }, body: source,
    }), env);
    assert.equal(replay.status, 200);
    const byVariant = (a) => [...a].sort((x, y) => x.variant.localeCompare(y.variant));
    assert.deepEqual(byVariant((await replay.json()).files), byVariant(files));

    // Inny plik dla zdjęcia, które ma już plik -> konflikt (nie nadpisujemy po cichu).
    const otherFile = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer();
    const conflict = await handlePgRequest(request(`/api/news-photos/${photo.id}/file`, {
      method: 'POST', cookie: boardCookie, headers: { 'Content-Type': 'image/jpeg', 'Idempotency-Key': key('file') }, body: otherFile,
    }), env);
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: 'photo_file_exists' });

    // Zdjęcie zweryfikowane, ale wpis jeszcze nieopublikowany -> nadal 404.
    await verifyPhoto(db, board1, { photoId: photo.id });
    const stillHidden = await handlePgRequest(request(`/api/public/news-photos/${photo.id}/web`), env);
    assert.equal(stillHidden.status, 404);

    await publishedPost(db, { title: 'Fotorelacja (syntetyczna)', photoIds: [photo.id] });

    const publicWeb = await handlePgRequest(request(`/api/public/news-photos/${photo.id}/web`), env);
    assert.equal(publicWeb.status, 200);
    assert.equal(publicWeb.headers.get('Content-Type'), 'image/jpeg');
    assert.equal(publicWeb.headers.get('Cache-Control'), `public, max-age=${PUBLIC_CACHE_SECONDS}`);
    const publicBytes = new Uint8Array(await publicWeb.arrayBuffer());
    const publicMeta = await sharp(publicBytes).metadata();
    assert.equal(publicMeta.exif, undefined, 'wariant publiczny nie może nieść EXIF/GPS');
    assert.equal(publicMeta.width, 10);
    assert.equal(publicMeta.height, 30);

    const publicThumb = await handlePgRequest(request(`/api/public/news-photos/${photo.id}/thumb`), env);
    assert.equal(publicThumb.status, 200);

    const badVariant = await handlePgRequest(request(`/api/public/news-photos/${photo.id}/original`), env);
    assert.equal(badVariant.status, 404);

    // Cofnięcie praw ukrywa wariant z trasy publicznej przy następnym żądaniu.
    await revokePhoto(db, board1, { photoId: photo.id, reason: 'Cofnięcie zgody (syntetyczne)' });
    const afterRevoke = await handlePgRequest(request(`/api/public/news-photos/${photo.id}/web`), env);
    assert.equal(afterRevoke.status, 404);

    // Zbyt duży plik: sprawdzany PRZED dekodowaniem, więc atrapa nie musi być poprawnym obrazem.
    const { photo: bigPhoto } = await registerPhoto(db, admin, photoInput());
    const tooBig = await handlePgRequest(request(`/api/news-photos/${bigPhoto.id}/file`, {
      method: 'POST', cookie: boardCookie,
      headers: { 'Content-Type': 'image/jpeg', 'Idempotency-Key': key('file') },
      body: new Uint8Array(PHOTO_UPLOAD_MAX_BYTES + 1),
    }), env);
    assert.equal(tooBig.status, 413);

    // Deklarowany typ niezgodny z wykrytym -> odrzucone przed dekodowaniem.
    const { photo: mismatchPhoto } = await registerPhoto(db, admin, photoInput());
    const mismatch = await handlePgRequest(request(`/api/news-photos/${mismatchPhoto.id}/file`, {
      method: 'POST', cookie: boardCookie,
      headers: { 'Content-Type': 'image/png', 'Idempotency-Key': key('file') },
      body: source, // JPEG prawdziwy, zadeklarowany jako PNG
    }), env);
    assert.equal(mismatch.status, 415);
  } finally { await db.close(); }
});

// #106 (poprawka po scaleniu z main): 0084 napisała news_photo_is_public
// niezależnie od 0083 i nie sprawdzała zgody — plik zdjęcia zostawał
// publicznie odczytywalny mimo wycofanej albo wygasłej zgody, chociaż
// public_news to samo zdjęcie już ukrywał. 0112 dokłada ten sam warunek.
test('plik zdjęcia: wycofanie i wygaśnięcie zgody chowają też publiczny odczyt pliku (0112)', async () => {
  const db = await newsDb();
  const storage = createMemoryStorage();
  const env = { db, storage };
  try {
    const source = await sharp({ create: { width: 6, height: 6, channels: 3, background: { r: 5, g: 6, b: 7 } } }).jpeg().toBuffer();

    // Zdjęcie z zakresem rada_website — plik i wpis publiczne po publikacji.
    const { photo: withdrawn } = await registerPhoto(db, admin, photoInput({ depictsChildren: true, identifiableChildren: 1 }));
    await addConsent(db, admin, {
      photoId: withdrawn.id, subjectNo: 1, subjectKind: 'child', consentDocumentRef: 'consent-doc-file-withdraw-01',
    });
    await uploadPhotoFile(db, storage, admin, { photoId: withdrawn.id, bytes: source, contentType: 'image/jpeg', idempotencyKey: key('file') });
    await verifyPhoto(db, board1, { photoId: withdrawn.id });
    await publishedPost(db, { photoIds: [withdrawn.id] });

    const { rows: beforeRows } = await db.query('SELECT news_photo_is_public($1) AS is_public', [withdrawn.id]);
    assert.equal(beforeRows[0].is_public, true);
    const beforeResponse = await handlePgRequest(request(`/api/public/news-photos/${withdrawn.id}/web`), env);
    assert.equal(beforeResponse.status, 200);

    // Wycofanie jedynej zgody -> plik przestaje być publicznie odczytywalny.
    await withdrawConsent(db, board1, { consentDocumentRef: 'consent-doc-file-withdraw-01' });
    const { rows: afterWithdrawRows } = await db.query('SELECT news_photo_is_public($1) AS is_public', [withdrawn.id]);
    assert.equal(afterWithdrawRows[0].is_public, false);
    const afterWithdrawResponse = await handlePgRequest(request(`/api/public/news-photos/${withdrawn.id}/web`), env);
    assert.equal(afterWithdrawResponse.status, 404);

    // Zgoda wygasła wczoraj -> plik też niepubliczny, choć nigdy nie wycofana.
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    const { photo: expired } = await registerPhoto(db, admin, photoInput({ depictsChildren: true, identifiableChildren: 1 }));
    await addConsent(db, admin, {
      photoId: expired.id, subjectNo: 1, subjectKind: 'child',
      consentDocumentRef: 'consent-doc-file-expired-01', validUntil: yesterday,
    });
    await uploadPhotoFile(db, storage, admin, { photoId: expired.id, bytes: source, contentType: 'image/jpeg', idempotencyKey: key('file') });
    await verifyPhoto(db, board1, { photoId: expired.id });
    await publishedPost(db, { photoIds: [expired.id] });

    const { rows: expiredRows } = await db.query('SELECT news_photo_is_public($1) AS is_public', [expired.id]);
    assert.equal(expiredRows[0].is_public, false);
    const expiredResponse = await handlePgRequest(request(`/api/public/news-photos/${expired.id}/web`), env);
    assert.equal(expiredResponse.status, 404);
  } finally { await db.close(); }
});

test('plik zdjęcia: ponowienie po awarii w połowie generowania wariantów nie zostawia osieroconych obiektów ani wierszy', async () => {
  const db = await newsDb();
  const realStorage = createMemoryStorage();
  let putCount = 0;
  // Drugi zapis do bucketu (wariant thumb) pada — symuluje awarię w połowie
  // przesyłania (issue #96: „ponowienie po awarii w połowie generowania
  // wariantów — brak osieroconych wariantów w bazie; obiekty sprzątane
  // best effort”).
  const flaky = {
    ...realStorage,
    async putObject(key, bytes, contentType) {
      putCount += 1;
      if (putCount === 2) throw new Error('storage_unreachable (syntetyczne)');
      return realStorage.putObject(key, bytes, contentType);
    },
  };
  const env = { db, storage: flaky };
  try {
    const source = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 5, g: 5, b: 5 } } }).jpeg().toBuffer();
    const { photo } = await registerPhoto(db, admin, photoInput());
    await assert.rejects(
      uploadPhotoFile(db, flaky, admin, { photoId: photo.id, bytes: source, contentType: 'image/jpeg', idempotencyKey: key('file') }),
    );
    const { rows } = await db.query('SELECT 1 FROM news_photo_files WHERE photo_id = $1', [photo.id]);
    assert.equal(rows.length, 0, 'żaden wariant nie powinien zostać zapisany w bazie po częściowej awarii');
    assert.equal(realStorage.keys().length, 0, 'obiekt zapisany przed awarią powinien zostać posprzątany best effort');
  } finally { await db.close(); }
});
