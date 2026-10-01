// Kopia bucketu: zdjęcia galerii (photos/), raport zgodności bucketu z bazą
// i autoryzacja pliku z odtworzonej kopii (issue #103). Dane syntetyczne,
// magazyny w pamięci, bez sieci.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createMemoryStorage, sha256Hex } from '../src/storage.js';
import { runStorageBackup } from '../src/pg/storage-backup.js';
import { buildStorageManifest, reportStorageConsistency, runStorageRestoreDrill, verifyStorageBackup } from '../src/pg/storage-backup-verify.js';
import { createTestDb, request, seedClass, seedDocument, seedUser, seedUserSession } from './helpers/pg.js';

const YEAR = 'y-2026';
const PHOTO_UUID = '11111111-1111-4111-8111-111111111111';
const PHOTO_UUID_2 = '22222222-2222-4222-8222-222222222222';
const PDF = new TextEncoder().encode('%PDF-1.4\n% syntetyczny dokument testowy\n1 0 obj <<>> endobj\n%%EOF\n');

async function insertPhotoFile(db, { uuid, bytes, sha256 = sha256Hex(bytes) }) {
  await seedUser(db, { userId: 'admin' });
  await seedDocument(db, { id: `doc-${uuid}` });
  await db.query(
    `INSERT INTO news_photos (id, document_id, author, source, taken_on, license_text, depicts_children, uploaded_by, alt_text)
     VALUES ($1, $2, 'Autor testowy', 'own_work', '2026-10-10', 'Zdjęcie własne autora (syntetyczne)', false, 'admin', 'Opis zdjęcia')`,
    [`p-${uuid}`, `doc-${uuid}`],
  );
  await db.query(
    `INSERT INTO news_photo_files (id, photo_id, variant, object_key, mime_type, width, height, byte_size, sha256, source_sha256, created_by)
     VALUES ($1, $2, 'web', $3, 'image/jpeg', 10, 10, $4, $5, $5, 'admin')`,
    [uuid, `p-${uuid}`, `photos/${uuid}`, bytes.length, sha256],
  );
}

test('runStorageBackup: kopiuje pliki zdjęć photos/, raportuje osobno i nie kopiuje osieroconych', async () => {
  const db = await createTestDb();
  try {
    const source = createMemoryStorage(); const target = createMemoryStorage();
    const bytes = Buffer.from('syntetyczny jpeg');
    await source.putObject(`photos/${PHOTO_UUID}`, bytes, 'image/jpeg');
    await source.putObject(`photos/${PHOTO_UUID_2}`, Buffer.from('osierocone zdjecie'), 'image/jpeg');
    await insertPhotoFile(db, { uuid: PHOTO_UUID, bytes });
    let deleteCalls = 0;
    target.deleteObject = async () => { deleteCalls += 1; };

    const report = await runStorageBackup({ db, sourceStorage: source, targetStorage: target });
    assert.equal(report.bySet.photos.copied, 1);
    assert.equal(report.bySet.photos.orphanedInSource, 1);
    assert.equal(report.bySet.documents.copied, 0);
    assert.equal(report.copied, 1);
    assert.equal(report.orphanedInSource, 1);
    assert.ok(await target.headObject(`photos/${PHOTO_UUID}`));
    assert.equal(await target.headObject(`photos/${PHOTO_UUID_2}`), false);
    assert.equal(deleteCalls, 0);

    const again = await runStorageBackup({ db, sourceStorage: source, targetStorage: target });
    assert.equal(again.copied, 0);
    assert.equal(again.bySet.photos.alreadyVerified, 1);
  } finally { await db.close(); }
});

test('runStorageBackup: zdjęcie ze zmienionym skrótem w źródle jest raportowane i nie kopiowane', async () => {
  const db = await createTestDb();
  try {
    const source = createMemoryStorage(); const target = createMemoryStorage();
    await source.putObject(`photos/${PHOTO_UUID}`, Buffer.from('podmieniony'), 'image/jpeg');
    await insertPhotoFile(db, { uuid: PHOTO_UUID, bytes: Buffer.from('oryginal') });
    const report = await runStorageBackup({ db, sourceStorage: source, targetStorage: target });
    assert.equal(report.bySet.photos.hashMismatches, 1);
    assert.equal(await target.headObject(`photos/${PHOTO_UUID}`), false);
  } finally { await db.close(); }
});

test('manifest, weryfikacja i próba odtworzenia obejmują photos/', async () => {
  const db = await createTestDb();
  try {
    const backup = createMemoryStorage(); const restore = createMemoryStorage();
    const bytes = Buffer.from('syntetyczny jpeg');
    await backup.putObject(`photos/${PHOTO_UUID}`, bytes, 'image/jpeg');
    await insertPhotoFile(db, { uuid: PHOTO_UUID, bytes });
    const manifest = await buildStorageManifest(backup);
    assert.equal(manifest.entries.length, 1);
    const report = await verifyStorageBackup({ db, manifest });
    assert.equal(report.ok, true);
    assert.equal(report.photoFilesWithObject, 1);

    const lost = await verifyStorageBackup({ db, manifest: await buildStorageManifest(createMemoryStorage()) });
    assert.equal(lost.ok, false);
    assert.equal(lost.missingInBackup.count, 1);

    const drill = await runStorageRestoreDrill({ db, backupStorage: backup, restoreStorage: restore, sampleSize: 5 });
    assert.equal(drill.ok, true);
    assert.equal(drill.restored, 1);
  } finally { await db.close(); }
});

test('reportStorageConsistency: obiekt osierocony (bucket bez wiersza) i wiersz bez obiektu, docs/ i photos/', async () => {
  const db = await createTestDb();
  try {
    const storage = createMemoryStorage();
    const bytes = Buffer.from('syntetyczny jpeg');
    await insertPhotoFile(db, { uuid: PHOTO_UUID, bytes }); // wiersz bez obiektu
    await storage.putObject('docs/orphan-doc-1', Buffer.from('x'), 'application/pdf'); // osierocony
    await storage.putObject(`photos/${PHOTO_UUID_2}`, bytes, 'image/jpeg'); // osierocony

    const report = await reportStorageConsistency({ db, storage });
    assert.equal(report.ok, false);
    assert.equal(report.sets.photos.rowsWithoutObject.count, 1);
    assert.deepEqual(report.sets.photos.rowsWithoutObject.documentIds, [PHOTO_UUID]);
    assert.equal(report.sets.photos.orphanedObjects, 1);
    assert.equal(report.sets.documents.orphanedObjects, 1);
    assert.equal(report.sets.documents.rowsWithoutObject.count, 0);
    assert.doesNotMatch(JSON.stringify(report), /photos\/|docs\//, 'raport nie zawiera kluczy obiektów');

    await storage.putObject(`photos/${PHOTO_UUID}`, bytes, 'image/jpeg');
    const fixed = await reportStorageConsistency({ db, storage });
    assert.equal(fixed.ok, true);
    assert.equal(fixed.sets.photos.orphanedObjects, 1, 'osierocony obiekt tylko ostrzega');
  } finally { await db.close(); }
});

test('plik z odtworzonej kopii nadal wymaga autoryzacji: bez sesji 401, inna klasa 404 jak dla nieznanego id', async () => {
  const db = await createTestDb();
  try {
    await seedClass(db, { id: 'c-1a', schoolYearId: YEAR });
    await seedClass(db, { id: 'c-1b', schoolYearId: YEAR });
    const live = createMemoryStorage();
    const repA = await seedUserSession(db, { userId: 'u-rep-a', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }] });
    const upload = await handlePgRequest(request(`/api/documents?kind=class&classId=c-1a&schoolYearId=${YEAR}`, {
      method: 'POST', cookie: repA, body: PDF,
      headers: { 'Content-Type': 'application/pdf', 'Idempotency-Key': 'restore-auth-test-1' },
    }), { db, storage: live });
    assert.equal(upload.status, 201);
    const id = (await upload.json()).document.id;

    // Kopia, a potem odtworzenie do NOWEGO, pustego magazynu.
    const backup = createMemoryStorage(); const restored = createMemoryStorage();
    await runStorageBackup({ db, sourceStorage: live, targetStorage: backup });
    for (const key of (await backup.listObjects('docs/')).keys) {
      const object = await backup.getObject(key);
      await restored.putObject(key, object.body, object.contentType);
    }
    const env = { db, storage: restored };
    const get = (path, cookie) => handlePgRequest(request(path, { cookie }), env);

    const owner = await get(`/api/documents/${id}/content`, repA);
    assert.equal(owner.status, 200);
    assert.equal(sha256Hex(new Uint8Array(await owner.arrayBuffer())), sha256Hex(PDF));

    assert.equal((await get(`/api/documents/${id}/content`)).status, 401);
    const repB = await seedUserSession(db, { userId: 'u-rep-b', roles: [{ role: 'representative', classId: 'c-1b', schoolYearId: YEAR }] });
    const denied = await get(`/api/documents/${id}/content`, repB);
    const unknown = await get(`/api/documents/${crypto.randomUUID()}/content`, repB);
    assert.equal(denied.status, 404);
    assert.deepEqual(await denied.json(), await unknown.json());
  } finally { await db.close(); }
});
