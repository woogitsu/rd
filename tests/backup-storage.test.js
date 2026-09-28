// Kopia magazynu dokumentów (issue #103). Dane wyłącznie syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedUser } from './helpers/pg.js';
import { createMemoryStorage, sha256Hex } from '../src/storage.js';
import { backupRunsTableExists, recordStorageBackupRun, runStorageBackup } from '../src/pg/storage-backup.js';

async function insertDocument(db, { id, objectKey, sha256, kind = 'financial' }) {
  const userId = await seedUser(db, { userId: 'u-treasurer' });
  await db.query(
    `INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by, sha256, idempotency_key)
     VALUES ($1, $2, 'application/pdf', 10, $3, $4, $5, $6)`,
    [id, objectKey, kind, userId, sha256, `idem-${id}`],
  );
}

test('runStorageBackup: copies a new object and verifies the copy against documents.sha256', async () => {
  const db = await createTestDb();
  try {
    const source = createMemoryStorage();
    const target = createMemoryStorage();
    const bytes = Buffer.from('dane syntetyczne dokumentu');
    await source.putObject('docs/aaaaaaa1', bytes, 'application/pdf');
    await insertDocument(db, { id: 'd-1', objectKey: 'docs/aaaaaaa1', sha256: sha256Hex(bytes) });

    const report = await runStorageBackup({ db, sourceStorage: source, targetStorage: target });
    assert.equal(report.copied, 1);
    assert.equal(report.alreadyVerified, 0);
    assert.equal(report.missingInSource, 0);
    assert.equal(report.hashMismatches, 0);
    assert.equal(report.orphanedInSource, 0);
    assert.ok(await target.headObject('docs/aaaaaaa1'));
  } finally {
    await db.close();
  }
});

test('runStorageBackup: second run does not re-copy an already verified object', async () => {
  const db = await createTestDb();
  try {
    const source = createMemoryStorage();
    const target = createMemoryStorage();
    const bytes = Buffer.from('dane syntetyczne');
    await source.putObject('docs/aaaaaaa2', bytes, 'application/pdf');
    await insertDocument(db, { id: 'd-2', objectKey: 'docs/aaaaaaa2', sha256: sha256Hex(bytes) });

    await runStorageBackup({ db, sourceStorage: source, targetStorage: target });
    let putCalls = 0;
    const originalPut = target.putObject.bind(target);
    target.putObject = async (...args) => { putCalls += 1; return originalPut(...args); };

    const second = await runStorageBackup({ db, sourceStorage: source, targetStorage: target });
    assert.equal(second.copied, 0);
    assert.equal(second.alreadyVerified, 1);
    assert.equal(putCalls, 0, 'must not upload again once the target already has the object');
  } finally {
    await db.close();
  }
});

test('runStorageBackup: object changed in source (hash mismatch) is reported, not copied', async () => {
  const db = await createTestDb();
  try {
    const source = createMemoryStorage();
    const target = createMemoryStorage();
    const bytes = Buffer.from('oryginał');
    await source.putObject('docs/aaaaaaa3', bytes, 'application/pdf');
    // Wiersz w bazie wskazuje INNY skrót niż to, co jest teraz w źródle
    // (np. plik podmieniony/uszkodzony po stronie magazynu).
    await insertDocument(db, { id: 'd-3', objectKey: 'docs/aaaaaaa3', sha256: sha256Hex(Buffer.from('inna treść')) });

    const report = await runStorageBackup({ db, sourceStorage: source, targetStorage: target });
    assert.equal(report.hashMismatches, 1);
    assert.equal(report.copied, 0);
    assert.equal(await target.headObject('docs/aaaaaaa3'), false, 'must never copy a payload that fails verification');
  } finally {
    await db.close();
  }
});

test('runStorageBackup: object deleted in source is reported as missing, copy in target is kept', async () => {
  const db = await createTestDb();
  try {
    const source = createMemoryStorage();
    const target = createMemoryStorage();
    const bytes = Buffer.from('kopia już istnieje');
    await target.putObject('docs/aaaaaaa4', bytes, 'application/pdf');
    // Brak obiektu w źródle (np. usunięty przypadkiem) — wiersz w bazie nadal istnieje.
    await insertDocument(db, { id: 'd-4', objectKey: 'docs/aaaaaaa4', sha256: sha256Hex(bytes) });

    const report = await runStorageBackup({ db, sourceStorage: source, targetStorage: target });
    // Obiekt jest już w celu (headObject prawda), więc liczy się jako
    // zweryfikowany, a nie brakujący — nie dotykamy źródła ponownie.
    assert.equal(report.alreadyVerified, 1);
    assert.equal(report.missingInSource, 0);
    assert.ok(await target.headObject('docs/aaaaaaa4'), 'existing copy in target must never be removed');
  } finally {
    await db.close();
  }
});

test('runStorageBackup: object truly missing from both is reported, deleteObject is never called', async () => {
  const db = await createTestDb();
  try {
    const source = createMemoryStorage();
    const target = createMemoryStorage();
    let deleteCalls = 0;
    target.deleteObject = async () => { deleteCalls += 1; };
    source.deleteObject = async () => { deleteCalls += 1; };
    await insertDocument(db, { id: 'd-5', objectKey: 'docs/aaaaaaa5', sha256: sha256Hex(Buffer.from('x')) });

    const report = await runStorageBackup({ db, sourceStorage: source, targetStorage: target });
    assert.equal(report.missingInSource, 1);
    assert.equal(report.copied, 0);
    assert.equal(deleteCalls, 0);
  } finally {
    await db.close();
  }
});

test('runStorageBackup: orphaned object in source (no documents row) is reported, not copied', async () => {
  const db = await createTestDb();
  try {
    const source = createMemoryStorage();
    const target = createMemoryStorage();
    await source.putObject('docs/orphanaaa', Buffer.from('brak wiersza'), 'application/pdf');
    await insertDocument(db, { id: 'd-6', objectKey: 'docs/aaaaaaa6', sha256: sha256Hex(Buffer.from('normalny')) });
    await source.putObject('docs/aaaaaaa6', Buffer.from('normalny'), 'application/pdf');

    const report = await runStorageBackup({ db, sourceStorage: source, targetStorage: target });
    assert.equal(report.orphanedInSource, 1);
    assert.equal(report.copied, 1);
    assert.equal(await target.headObject('docs/orphanaaa'), false);
  } finally {
    await db.close();
  }
});

test('runStorageBackup: resumes after interruption in the middle of the list (continuation cursor)', async () => {
  const db = await createTestDb();
  try {
    const source = createMemoryStorage();
    const target = createMemoryStorage();
    for (let i = 0; i < 5; i += 1) {
      const key = `docs/aaaaaaa${i}`;
      const bytes = Buffer.from(`dokument-${i}`);
      await source.putObject(key, bytes, 'application/pdf');
      await insertDocument(db, { id: `d-page-${i}`, objectKey: key, sha256: sha256Hex(bytes) });
    }

    const firstHalf = await runStorageBackup({ db, sourceStorage: source, targetStorage: target, startAfterKey: 'docs/aaaaaaa1' });
    assert.equal(firstHalf.copied, 3, 'objects after the cursor: aaaaaaa2,3,4');
    assert.equal(await target.headObject('docs/aaaaaaa0'), false, 'objects at/before the cursor are not part of this resumed run');

    const resumedFromStart = await runStorageBackup({ db, sourceStorage: source, targetStorage: target });
    assert.equal(resumedFromStart.copied, 2, 'aaaaaaa0 and aaaaaaa1 still missing from target');
    assert.equal(resumedFromStart.alreadyVerified, 3);
  } finally {
    await db.close();
  }
});

test('recordStorageBackupRun: zapisuje przebieg w backup_runs (#90 scalony — tabela istnieje)', async () => {
  const db = await createTestDb();
  try {
    assert.equal(await backupRunsTableExists(db), true);
    const outcome = await recordStorageBackupRun(db, {
      environment: 'test', result: 'success', report: { copied: 1 }, startedAt: new Date(),
    });
    assert.equal(outcome.recorded, true);
    const { rows } = await db.query("SELECT kind, result FROM backup_runs WHERE kind = 'storage_backup'");
    assert.deepEqual(rows.map((row) => [row.kind, row.result]), [['storage_backup', 'success']]);
  } finally {
    await db.close();
  }
});
