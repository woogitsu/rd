// Zadanie porządkowe dla osieroconych zamiarów uploadu (#168). Wyłącznie dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoPii } from '../src/pg/audit.js';
import { createMemoryStorage } from '../src/storage.js';
import { cleanupDocumentUploads } from '../scripts/document-uploads-cleanup.js';
import { createTestDb, seedUser } from './helpers/pg.js';

const MINUTE = 60_000;
const NOW = new Date('2026-10-05T12:00:00Z');

async function insertPendingUpload(db, { id, objectKey, ageMinutes, actorId = 'u-1' }) {
  await seedUser(db, { userId: actorId });
  await db.query(
    `INSERT INTO document_uploads (id, object_key, idempotency_key, sha256, byte_size, mime_type, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, objectKey, `key-${id}`, '0'.repeat(64), 10, 'application/pdf', actorId, new Date(NOW.getTime() - ageMinutes * MINUTE).toISOString()],
  );
}

async function auditRows(db, action) {
  return (await db.query('SELECT actor_id, entity_id, metadata_json FROM audit_events WHERE action = $1', [action])).rows;
}

test('orphaned object (put succeeded, insert never happened): deleted, marked abandoned, audited', async () => {
  const db = await createTestDb();
  const storage = createMemoryStorage();
  try {
    const key = 'docs/00000000-0000-4000-8000-000000000001';
    await storage.putObject(key, new Uint8Array([1, 2, 3]), 'application/pdf');
    await insertPendingUpload(db, { id: '00000000-0000-4000-8000-0000000000a1', objectKey: key, ageMinutes: 35 });

    const report = await cleanupDocumentUploads(db, storage, { pendingMinutes: 30, now: NOW });
    assert.equal(report.checked, 1);
    assert.equal(report.abandonedOrphanedObject, 1);
    assert.equal(storage.keys().length, 0, 'orphaned object removed');

    const row = (await db.query('SELECT state, resolution FROM document_uploads')).rows[0];
    assert.equal(row.state, 'abandoned');
    assert.equal(row.resolution, 'orphaned_object');

    const [event] = await auditRows(db, 'document_upload.abandoned');
    assert.equal(event.entity_id, '00000000-0000-4000-8000-0000000000a1');
    assertNoPii(event.metadata_json);
  } finally { await db.close(); }
});

test('crash before the object ever reached the bucket: marked abandoned, nothing to delete', async () => {
  const db = await createTestDb();
  const storage = createMemoryStorage();
  try {
    await insertPendingUpload(db, { id: '00000000-0000-4000-8000-0000000000a2', objectKey: 'docs/00000000-0000-4000-8000-000000000002', ageMinutes: 40 });
    const report = await cleanupDocumentUploads(db, storage, { pendingMinutes: 30, now: NOW });
    assert.equal(report.abandonedNoObject, 1);
    const row = (await db.query('SELECT state, resolution FROM document_uploads')).rows[0];
    assert.equal(row.state, 'abandoned');
    assert.equal(row.resolution, 'no_object');
  } finally { await db.close(); }
});

test('recent pending uploads (inside the grace period) are left untouched', async () => {
  const db = await createTestDb();
  const storage = createMemoryStorage();
  try {
    await insertPendingUpload(db, { id: '00000000-0000-4000-8000-0000000000a3', objectKey: 'docs/00000000-0000-4000-8000-000000000003', ageMinutes: 5 });
    const report = await cleanupDocumentUploads(db, storage, { pendingMinutes: 30, now: NOW });
    assert.equal(report.checked, 0);
    assert.equal((await db.query("SELECT state FROM document_uploads")).rows[0].state, 'pending');
  } finally { await db.close(); }
});

test('a pending upload whose document already exists is never abandoned (trigger also refuses it)', async () => {
  const db = await createTestDb();
  const storage = createMemoryStorage();
  try {
    await seedUser(db, { userId: 'u-treasurer' });
    const objectKey = 'docs/00000000-0000-4000-8000-000000000004';
    await insertPendingUpload(db, { id: '00000000-0000-4000-8000-0000000000a4', objectKey, ageMinutes: 60, actorId: 'u-treasurer' });
    await storage.putObject(objectKey, new Uint8Array([9]), 'application/pdf');
    await db.query("INSERT INTO school_years (id, label, starts_on, ends_on) VALUES ('y-cleanup', 'y', '2026-09-01', '2027-08-31') ON CONFLICT (id) DO NOTHING");
    await db.query(
      `INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by, school_year_id, sha256, idempotency_key)
       VALUES ('00000000-0000-4000-8000-0000000000d5', $1, 'application/pdf', 1, 'board', 'u-treasurer', 'y-cleanup', repeat('0', 64), 'doc-key-a5')`,
      [objectKey],
    );
    const report = await cleanupDocumentUploads(db, storage, { pendingMinutes: 30, now: NOW });
    assert.equal(report.hasDocument, 1);
    assert.equal((await db.query("SELECT state FROM document_uploads WHERE id = '00000000-0000-4000-8000-0000000000a4'")).rows[0].state, 'pending');
    assert.equal(storage.keys().length, 1, 'object with a documents row is never deleted');

    // Obrona w głąb: trigger odmawia bezpośredniej próby oznaczenia „abandoned”.
    await assert.rejects(
      db.query("UPDATE document_uploads SET state = 'abandoned', resolved_at = now(), resolution = 'x' WHERE id = '00000000-0000-4000-8000-0000000000a4'"),
      /document_upload_has_document/,
    );
  } finally { await db.close(); }
});

test('bucket unreachable: pending row is left for the next run, not guessed at', async () => {
  const db = await createTestDb();
  const storage = { headObject: async () => { throw Object.assign(new Error('storage_unreachable'), { code: 'storage_unreachable' }); } };
  try {
    await insertPendingUpload(db, { id: '00000000-0000-4000-8000-0000000000a6', objectKey: 'docs/00000000-0000-4000-8000-000000000006', ageMinutes: 60 });
    const report = await cleanupDocumentUploads(db, storage, { pendingMinutes: 30, now: NOW });
    assert.equal(report.headCheckFailed, 1);
    assert.equal((await db.query("SELECT state FROM document_uploads")).rows[0].state, 'pending');
  } finally { await db.close(); }
});

test('--dry-run reports without changing anything', async () => {
  const db = await createTestDb();
  const storage = createMemoryStorage();
  try {
    const key = 'docs/00000000-0000-4000-8000-000000000007';
    await storage.putObject(key, new Uint8Array([1]), 'application/pdf');
    await insertPendingUpload(db, { id: '00000000-0000-4000-8000-0000000000a7', objectKey: key, ageMinutes: 60 });
    const report = await cleanupDocumentUploads(db, storage, { pendingMinutes: 30, now: NOW, dryRun: true });
    assert.equal(report.abandonedOrphanedObject, 1);
    assert.equal(storage.keys().length, 1, 'dry run does not delete');
    assert.equal((await db.query("SELECT state FROM document_uploads")).rows[0].state, 'pending');
  } finally { await db.close(); }
});
