// Weryfikacja kopii bucketu i próba odtworzenia (issue #103). Dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, seedUser } from './helpers/pg.js';
import { createMemoryStorage, sha256Hex } from '../src/storage.js';
import { createDirectoryStorage } from '../src/storage-dir.js';
import {
  buildStorageManifest, parseStorageManifest, runStorageRestoreDrill, verifyStorageBackup,
} from '../src/pg/storage-backup-verify.js';

const root = fileURLToPath(new URL('..', import.meta.url));

async function insertDocument(db, { id, key, bytes, sha256 = sha256Hex(bytes), size = bytes.length }) {
  const userId = await seedUser(db, { userId: 'u-treasurer' });
  await db.query(
    `INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by, sha256, idempotency_key)
     VALUES ($1, $2, 'application/pdf', $3, 'financial', $4, $5, $6)`,
    [id, key, size, userId, sha256, `idem-${id}`],
  );
}

test('verifyStorageBackup: kopia zgodna z documents', async () => {
  const db = await createTestDb();
  try {
    const backup = createMemoryStorage();
    const a = Buffer.from('syntetyczny A'); const b = Buffer.from('syntetyczny B');
    await backup.putObject('docs/aaaaaaa1', a, 'application/pdf');
    await backup.putObject('docs/aaaaaaa2', b, 'application/pdf');
    await insertDocument(db, { id: 'd-1', key: 'docs/aaaaaaa1', bytes: a });
    await insertDocument(db, { id: 'd-2', key: 'docs/aaaaaaa2', bytes: b });
    const report = await verifyStorageBackup({ db, manifest: await buildStorageManifest(backup) });
    assert.equal(report.ok, true);
    assert.equal(report.documentsWithObject, 2);
    assert.equal(report.objectsInBackup, 2);
    assert.equal(report.expectedBytes, a.length + b.length);
    assert.equal(report.orphanedInBackup, 0);
  } finally { await db.close(); }
});

test('verifyStorageBackup: brak, zły skrót, zły rozmiar i osierocony; raport bez kluczy obiektów', async () => {
  const db = await createTestDb();
  try {
    const backup = createMemoryStorage();
    const ok = Buffer.from('dobry'); const changed = Buffer.from('zmieniony w kopii'); const sized = Buffer.from('rozmiar');
    await backup.putObject('docs/bbbbbbb1', ok, 'application/pdf');
    await backup.putObject('docs/bbbbbbb2', changed, 'application/pdf');
    await backup.putObject('docs/bbbbbbb3', sized, 'application/pdf');
    await backup.putObject('docs/bbbbbbb9', Buffer.from('osierocony'), 'application/pdf');
    await insertDocument(db, { id: 'd-ok', key: 'docs/bbbbbbb1', bytes: ok });
    await insertDocument(db, { id: 'd-bad', key: 'docs/bbbbbbb2', bytes: Buffer.from('oryginał') });
    await insertDocument(db, { id: 'd-size', key: 'docs/bbbbbbb3', bytes: sized, size: sized.length + 5 });
    await insertDocument(db, { id: 'd-gone', key: 'docs/bbbbbbb4', bytes: Buffer.from('brak w kopii') });
    const report = await verifyStorageBackup({ db, manifest: await buildStorageManifest(backup) });
    assert.equal(report.ok, false);
    assert.deepEqual(report.missingInBackup.documentIds, ['d-gone']);
    assert.deepEqual(report.hashMismatches.documentIds, ['d-bad']);
    assert.deepEqual(report.sizeMismatches.documentIds, ['d-size']);
    assert.equal(report.orphanedInBackup, 1);
    assert.doesNotMatch(JSON.stringify(report), /docs\/|bbbbbbb/, 'raport nie zawiera kluczy obiektów');
  } finally { await db.close(); }
});

test('verifyStorageBackup: sam osierocony obiekt nie psuje ok; uszkodzony manifest jest odrzucony', async () => {
  const db = await createTestDb();
  try {
    const backup = createMemoryStorage();
    await backup.putObject('docs/ccccccc1', Buffer.from('x'), 'application/pdf');
    const report = await verifyStorageBackup({ db, manifest: await buildStorageManifest(backup) });
    assert.equal(report.ok, true);
    assert.equal(report.orphanedInBackup, 1);
    assert.throws(() => parseStorageManifest({ format: 'x', entries: [] }), { code: 'storage_manifest_invalid' });
    assert.throws(() => parseStorageManifest({ format: 'rd-storage-manifest-v1', entries: [{ key: 'docs/a', sha256: 'zz', size: 1 }] }), { code: 'storage_manifest_invalid' });
  } finally { await db.close(); }
});

test('próba odtworzenia na katalogu lokalnym: próbka wraca ze zgodnym SHA-256', async () => {
  const db = await createTestDb();
  const dir = await mkdtemp(join(tmpdir(), 'rd-restore-'));
  try {
    const backup = createDirectoryStorage(join(dir, 'backup'));
    const restore = createDirectoryStorage(join(dir, 'restore'));
    for (let i = 1; i <= 5; i += 1) {
      const bytes = Buffer.from(`syntetyczny dokument ${i}`);
      await backup.putObject(`docs/ddddddd${i}`, bytes, 'application/pdf');
      await insertDocument(db, { id: `d-${i}`, key: `docs/ddddddd${i}`, bytes });
    }
    const report = await runStorageRestoreDrill({ db, backupStorage: backup, restoreStorage: restore, sampleSize: 3 });
    assert.deepEqual([report.ok, report.sampled, report.restored], [true, 3, 3]);
    const restoredKeys = (await restore.listObjects('docs/')).keys;
    assert.equal(restoredKeys.length, 3);
    for (const key of restoredKeys) {
      const { rows } = await db.query('SELECT sha256 FROM documents WHERE object_key = $1', [key]);
      assert.equal(sha256Hex((await restore.getObject(key)).body), rows[0].sha256);
      assert.equal((await restore.getObject(key)).contentType, 'application/pdf');
    }
  } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('próba odtworzenia: brak obiektu i uszkodzony obiekt w kopii dają ok=false; nic nie jest usuwane', async () => {
  const db = await createTestDb();
  try {
    const backup = createMemoryStorage();
    const restore = createMemoryStorage();
    await backup.putObject('docs/eeeeeee1', Buffer.from('uszkodzony'), 'application/pdf');
    await insertDocument(db, { id: 'd-bad', key: 'docs/eeeeeee1', bytes: Buffer.from('oryginał') });
    await insertDocument(db, { id: 'd-gone', key: 'docs/eeeeeee2', bytes: Buffer.from('brak') });
    let deletes = 0;
    backup.deleteObject = async () => { deletes += 1; };
    restore.deleteObject = async () => { deletes += 1; };
    const report = await runStorageRestoreDrill({ db, backupStorage: backup, restoreStorage: restore, sampleSize: 10 });
    assert.equal(report.ok, false);
    assert.equal(report.restored, 0);
    assert.deepEqual(report.hashFailures.documentIds, ['d-bad']);
    assert.deepEqual(report.missingInBackup.documentIds, ['d-gone']);
    assert.equal(restore.keys().length, 0, 'uszkodzony obiekt nie trafia do odtworzenia');
    assert.equal(deletes, 0);
  } finally { await db.close(); }
});

test('próba odtworzenia odmawia celu innego niż lokalny i błędnej próbki', async () => {
  const db = await createTestDb();
  try {
    const backup = createMemoryStorage();
    await assert.rejects(runStorageRestoreDrill({ db, backupStorage: backup, restoreStorage: { kind: 's3' } }), { code: 'storage_restore_target_not_local' });
    await assert.rejects(runStorageRestoreDrill({ db, backupStorage: backup, restoreStorage: createMemoryStorage(), sampleSize: 0 }), { code: 'storage_restore_sample_invalid' });
  } finally { await db.close(); }
});

test('magazyn katalogowy: listowanie ze stronicowaniem, brak wyjścia poza katalog, brak obiektu', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rd-dirstore-'));
  try {
    const storage = createDirectoryStorage(dir);
    await storage.putObject('docs/fffffff1', Buffer.from('a'), 'text/plain');
    await storage.putObject('photos/fffffff2', Buffer.from('b'), 'image/png');
    assert.deepEqual((await storage.listObjects('docs/')).keys, ['docs/fffffff1']);
    assert.deepEqual((await storage.listObjects('')).keys, ['docs/fffffff1', 'photos/fffffff2']);
    assert.equal(await storage.headObject('docs/fffffff1'), true);
    assert.equal(await storage.headObject('docs/fffffff3'), false);
    await assert.rejects(storage.getObject('docs/fffffff3'), { code: 'storage_object_not_found' });
    for (const key of ['../evil12345', 'docs/../../x1234567', '/etc/passwd']) {
      await assert.rejects(storage.getObject(key), { code: 'storage_invalid_key' }, key);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('verify-storage-backup.js: odmowa w produkcji przed jakimkolwiek połączeniem', () => {
  for (const appEnv of ['production', 'PROD', undefined, 'prodution']) {
    const env = { ...process.env, DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x' };
    if (appEnv === undefined) delete env.APP_ENV; else env.APP_ENV = appEnv;
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'verify-storage-backup.js'), '--backup-dir', '/nonexistent'], { env, encoding: 'utf8' });
    assert.equal(result.status, 1, String(appEnv));
    assert.match(result.stderr, /requires explicit --allow-production\. Nothing was checked/, String(appEnv));
  }
});
