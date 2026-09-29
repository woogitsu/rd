// Kopia zapasowa PostgreSQL i próbne odtworzenie (issue #90).
// Dane wyłącznie syntetyczne. pg_dump/pg_restore nie są tu wywoływane —
// `dump`/`restore` są atrapami wstrzykniętymi w logikę (src/pg/backup.js),
// tak jak inne moduły biznesowe w repo są testowane bez prawdziwego
// transportu (np. runEmailBatch bez Brevo). Uruchomienie prawdziwych
// binariów pozostaje do ręcznej weryfikacji na stagingu (opisane w PR).

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createTestDb } from './helpers/pg.js';
import { createMemoryStorage, sha256Hex } from '../src/storage.js';
import { decryptEnvelope, encryptEnvelope } from '../src/backup-crypto.js';
import {
  assertDifferentDatabase, dailyObjectKey, latestSuccessfulBackupRun, runBackup, runRestoreDrill,
} from '../src/pg/backup.js';

function keyPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

test('encryptEnvelope/decryptEnvelope: round trip and tamper detection', () => {
  const { publicKey, privateKey } = keyPair();
  const plaintext = Buffer.from('dane syntetyczne @example.invalid, nie prawdziwe');
  const envelope = encryptEnvelope(plaintext, publicKey);
  assert.deepEqual(decryptEnvelope(envelope, privateKey), plaintext);

  // Uszkodzona paczka (ostatni bajt szyfrogramu) -> GCM wykrywa manipulację.
  const tampered = Buffer.from(envelope);
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => decryptEnvelope(tampered, privateKey), /backup_decryption_failed/);

  assert.throws(() => encryptEnvelope(plaintext, undefined), /backup_encryption_key_missing/);
  assert.throws(() => decryptEnvelope(envelope, undefined), /backup_decryption_key_missing/);
});

test('dailyObjectKey: same day -> same key (idempotent cron window)', () => {
  const day = new Date('2026-09-28T03:00:00Z');
  const later = new Date('2026-09-28T21:00:00Z');
  assert.equal(dailyObjectKey('backup', day), dailyObjectKey('backup', later));
  assert.notEqual(dailyObjectKey('backup', day), dailyObjectKey('backup', new Date('2026-09-29T03:00:00Z')));
  assert.notEqual(dailyObjectKey('backup', day), dailyObjectKey('storage_backup', day));
});

test('runBackup: encrypts, uploads, records success; second run in the same window is skipped', async () => {
  const db = await createTestDb();
  try {
    const { publicKey } = keyPair();
    const storage = createMemoryStorage();
    let dumpCalls = 0;
    const dump = async () => { dumpCalls += 1; return Buffer.from('dump syntetyczny'); };

    const first = await runBackup({ db, dump, storage, encryptPublicKeyPem: publicKey, environment: 'test' });
    assert.equal(first.skipped, false);
    assert.equal(dumpCalls, 1);

    const second = await runBackup({ db, dump, storage, encryptPublicKeyPem: publicKey, environment: 'test' });
    assert.equal(second.skipped, true);
    assert.equal(dumpCalls, 1, 'second run in the same day must not call dump again');

    const latest = await latestSuccessfulBackupRun(db, 'backup');
    assert.ok(latest);
    assert.equal(latest.sha256, first.sha256);

    const forced = await runBackup({ db, dump, storage, encryptPublicKeyPem: publicKey, environment: 'test', force: true });
    assert.equal(forced.skipped, false);
    assert.equal(dumpCalls, 2);
  } finally {
    await db.close();
  }
});

test('runBackup: dump failure is recorded and rethrown, no partial object left', async () => {
  const db = await createTestDb();
  try {
    const { publicKey } = keyPair();
    const storage = createMemoryStorage();
    const dump = async () => { throw Object.assign(new Error('boom'), { code: 'pg_dump_failed' }); };
    await assert.rejects(
      runBackup({ db, dump, storage, encryptPublicKeyPem: publicKey, environment: 'test' }),
      (error) => error.code === 'pg_dump_failed',
    );
    assert.equal(storage.keys().length, 0);
    const { rows } = await db.query("SELECT result, error_code FROM backup_runs WHERE kind = 'backup'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].result, 'failure');
    assert.equal(rows[0].error_code, 'pg_dump_failed');
  } finally {
    await db.close();
  }
});

test('assertDifferentDatabase: refuses when target equals source', () => {
  assert.throws(
    () => assertDifferentDatabase('postgres://u:p@host/db', 'postgres://other:p@host/db'),
    /restore_target_same_as_source/,
  );
  assert.doesNotThrow(() => assertDifferentDatabase('postgres://u:p@host/db', 'postgres://u:p@other-host/db'));
  assert.doesNotThrow(() => assertDifferentDatabase('postgres://u:p@host/db', 'postgres://u:p@host/other-db'));
});

test('runRestoreDrill: verifies checksum, restores, reports, records success', async () => {
  const db = await createTestDb();
  try {
    const { publicKey, privateKey } = keyPair();
    const storage = createMemoryStorage();
    const dump = async () => Buffer.from(JSON.stringify({ households: 3, ledgerNetCents: 12345 }));
    await runBackup({ db, dump, storage, encryptPublicKeyPem: publicKey, environment: 'test' });

    let restoredPayload = null;
    const report = await runRestoreDrill({
      db,
      storage,
      decryptPrivateKeyPem: privateKey,
      sourceUrl: 'postgres://u:p@source-host/rd',
      targetUrl: 'postgres://u:p@drill-host/rd_drill',
      environment: 'staging',
      restore: async (plaintext) => { restoredPayload = JSON.parse(plaintext.toString('utf8')); },
      migrateTarget: async () => [], // "No pending migrations." po świeżym pg_restore ze zgodnym zrzutem
      reportQuery: async () => ({
        rowCounts: { households: restoredPayload.households },
        sums: { ledger_net_cents: restoredPayload.ledgerNetCents },
      }),
    });

    assert.equal(restoredPayload.households, 3);
    assert.equal(report.rowCounts.households, 3);
    assert.equal(report.sums.ledger_net_cents, 12345);

    const { rows } = await db.query("SELECT result FROM backup_runs WHERE kind = 'restore_drill'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].result, 'success');
  } finally {
    await db.close();
  }
});

test('runRestoreDrill: refuses target same as source, without touching storage', async () => {
  const db = await createTestDb();
  try {
    await assert.rejects(
      runRestoreDrill({
        db,
        storage: createMemoryStorage(),
        decryptPrivateKeyPem: 'irrelevant',
        sourceUrl: 'postgres://u:p@host/rd',
        targetUrl: 'postgres://u:p@host/rd',
        environment: 'staging',
        restore: async () => { throw new Error('must not be called'); },
        migrateTarget: async () => [],
        reportQuery: async () => ({ rowCounts: {}, sums: {} }),
      }),
      /restore_target_same_as_source/,
    );
    const { rows } = await db.query('SELECT * FROM backup_runs');
    assert.equal(rows.length, 0, 'no run should be recorded when the guard rejects before starting');
  } finally {
    await db.close();
  }
});

test('runRestoreDrill: corrupted dump (checksum mismatch) fails the drill and is recorded', async () => {
  const db = await createTestDb();
  try {
    const { publicKey, privateKey } = keyPair();
    const storage = createMemoryStorage();
    const dump = async () => Buffer.from('dane syntetyczne');
    await runBackup({ db, dump, storage, encryptPublicKeyPem: publicKey, environment: 'test' });

    // Symulacja uszkodzenia obiektu w magazynie kopii po zapisie.
    const key = (await latestSuccessfulBackupRun(db, 'backup')).object_key;
    const corrupted = storage.raw(key);
    corrupted.body[0] ^= 0xff;

    await assert.rejects(
      runRestoreDrill({
        db,
        storage,
        decryptPrivateKeyPem: privateKey,
        sourceUrl: 'postgres://u:p@host/rd',
        targetUrl: 'postgres://u:p@other-host/rd',
        environment: 'staging',
        restore: async () => { throw new Error('must not be called after checksum mismatch'); },
        migrateTarget: async () => [],
        reportQuery: async () => ({ rowCounts: {}, sums: {} }),
      }),
      /restore_checksum_mismatch/,
    );
    const { rows } = await db.query("SELECT result, error_code FROM backup_runs WHERE kind = 'restore_drill'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].result, 'failure');
    assert.equal(rows[0].error_code, 'restore_checksum_mismatch');
  } finally {
    await db.close();
  }
});

test('sha256Hex is used consistently for the stored envelope (sanity check)', async () => {
  const db = await createTestDb();
  try {
    const { publicKey } = keyPair();
    const storage = createMemoryStorage();
    const dump = async () => Buffer.from('x');
    const result = await runBackup({ db, dump, storage, encryptPublicKeyPem: publicKey, environment: 'test' });
    const stored = storage.raw(result.objectKey);
    assert.equal(sha256Hex(stored.body), result.sha256);
  } finally {
    await db.close();
  }
});

// Punkt odniesienia z chwili kopii (backup_runs.row_counts/sums): próba
// odtworzenia porównuje z nim raport z bazy docelowej (#90).
async function backupWithBaseline(db, storage, publicKey, report) {
  await runBackup({
    db, storage, encryptPublicKeyPem: publicKey, environment: 'test',
    dump: async () => ({ plaintext: Buffer.from('dump syntetyczny'), report }),
  });
}

const drillArgs = (db, storage, privateKey, restoredReport) => ({
  db,
  storage,
  decryptPrivateKeyPem: privateKey,
  sourceUrl: 'postgres://u:p@host/rd',
  targetUrl: 'postgres://u:p@other-host/rd',
  environment: 'staging',
  restore: async () => {},
  migrateTarget: async () => [],
  reportQuery: async () => structuredClone(restoredReport),
});

test('runBackup/runRestoreDrill: raport z kopii jest punktem odniesienia — zgodność', async () => {
  const db = await createTestDb();
  try {
    const { publicKey, privateKey } = keyPair();
    const storage = createMemoryStorage();
    const report = { rowCounts: { payment_entries: 3 }, sums: { 'sum.payment_entries.amount_cents': 4500, 'sha256.payment_entries': 'a'.repeat(64) } };
    await backupWithBaseline(db, storage, publicKey, report);
    const stored = await latestSuccessfulBackupRun(db, 'backup');
    assert.deepEqual(stored.row_counts, report.rowCounts);
    assert.deepEqual(stored.sums, report.sums);

    const result = await runRestoreDrill(drillArgs(db, storage, privateKey, report));
    assert.equal(result.comparison, 'matched');
  } finally {
    await db.close();
  }
});

test('runRestoreDrill: niezgodny raport (brakująca wpłata) → błąd restore_report_mismatch, wpis failure', async () => {
  const db = await createTestDb();
  try {
    const { publicKey, privateKey } = keyPair();
    const storage = createMemoryStorage();
    const report = { rowCounts: { payment_entries: 3 }, sums: { 'sum.payment_entries.amount_cents': 4500 } };
    await backupWithBaseline(db, storage, publicKey, report);

    const restored = { rowCounts: { payment_entries: 2 }, sums: { 'sum.payment_entries.amount_cents': 3000 } };
    await assert.rejects(
      runRestoreDrill(drillArgs(db, storage, privateKey, restored)),
      (error) => error.code === 'restore_report_mismatch' && error.differences.length === 2,
    );
    const { rows } = await db.query("SELECT result, error_code, row_counts FROM backup_runs WHERE kind = 'restore_drill'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].result, 'failure');
    assert.equal(rows[0].error_code, 'restore_report_mismatch');
    assert.equal(rows[0].row_counts, null, 'niezgodny raport nie jest zapisywany jako wynik');
  } finally {
    await db.close();
  }
});

test('runRestoreDrill: kopia bez raportu → comparison no_baseline (nie „zgodna”)', async () => {
  const db = await createTestDb();
  try {
    const { publicKey, privateKey } = keyPair();
    const storage = createMemoryStorage();
    await runBackup({ db, dump: async () => Buffer.from('x'), storage, encryptPublicKeyPem: publicKey, environment: 'test' });
    const result = await runRestoreDrill(drillArgs(db, storage, privateKey, { rowCounts: { t: 1 }, sums: {} }));
    assert.equal(result.comparison, 'no_baseline');
  } finally {
    await db.close();
  }
});
