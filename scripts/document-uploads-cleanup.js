// Zadanie porządkowe dla zamiarów uploadu dokumentów (issue #168).
//
// Wiersz document_uploads w stanie 'pending' starszy niż --pending-minutes
// (domyślnie 30) oznacza upload, którego nie dokończono: awaria procesu,
// SIGTERM/SIGKILL albo timeout PUT między zapisem zamiaru a transakcją
// documents. Dla każdego takiego wiersza:
//   - jeśli documents ma wiersz z tym samym object_key -> transakcja się
//     jednak zatwierdziła (utracone potwierdzenie COMMIT); nic nie robimy,
//     trigger i tak nie pozwoliłby oznaczyć go jako 'abandoned';
//   - jeśli obiektu nie ma w buckecie (headObject) -> PUT się nie powiódł
//     albo bucketu nie da się sprawdzić dziś; oznaczamy 'abandoned' bez
//     usuwania niczego z bucketu;
//   - jeśli obiekt jest, a wiersza documents nie ma -> naprawdę osierocony;
//     usuwamy obiekt i oznaczamy 'abandoned', ze zdarzeniem audytu (aktor,
//     czas, identyfikator uploadu — bez adresu ani nazwy pliku).
// Jeżeli bucketu nie da się w ogóle sprawdzić (błąd headObject), wiersz
// zostaje 'pending' do następnego przebiegu — nie zgadujemy.
//
//   node scripts/document-uploads-cleanup.js [--pending-minutes=30] [--dry-run]
//
// Wymaga DATABASE_URL i BUCKET_* (patrz src/storage.js storageFromEnv).
// Raport na stdout: tylko liczności i kody, bez danych osobowych.

import { fileURLToPath } from 'node:url';
import { insertAuditEvent } from '../src/pg/audit.js';

const DEFAULT_PENDING_MINUTES = 30;

export async function cleanupDocumentUploads(db, storage, { pendingMinutes = DEFAULT_PENDING_MINUTES, now = new Date(), dryRun = false } = {}) {
  const cutoff = new Date(now.getTime() - pendingMinutes * 60_000);
  const { rows } = await db.query(
    `SELECT id, object_key FROM document_uploads WHERE state = 'pending' AND created_at < $1 ORDER BY created_at`,
    [cutoff.toISOString()],
  );
  const report = { checked: rows.length, hasDocument: 0, abandonedNoObject: 0, abandonedOrphanedObject: 0, headCheckFailed: 0 };

  for (const row of rows) {
    const owned = (await db.query('SELECT 1 FROM documents WHERE object_key = $1', [row.object_key])).rows[0];
    if (owned) {
      // Utracone potwierdzenie COMMIT: wiersz istnieje, upload jest już
      // 'committed' (albo zostanie przy następnym uruchomieniu — trigger
      // zablokuje 'abandoned' i tak). Nic do zrobienia.
      report.hasDocument += 1;
      continue;
    }
    let exists;
    try {
      exists = await storage.headObject(row.object_key);
    } catch {
      report.headCheckFailed += 1;
      continue;
    }
    if (dryRun) {
      if (exists) report.abandonedOrphanedObject += 1; else report.abandonedNoObject += 1;
      continue;
    }
    if (exists) await storage.deleteObject(row.object_key);
    await db.transaction(async (tx) => {
      const { rows: updated } = await tx.query(
        `UPDATE document_uploads SET state = 'abandoned', resolved_at = now(),
                resolution = $2 WHERE id = $1 AND state = 'pending' RETURNING id`,
        [row.id, exists ? 'orphaned_object' : 'no_object'],
      );
      if (!updated[0]) return; // ktoś inny (kolejny przebieg) już to rozstrzygnął
      await insertAuditEvent(tx, {
        action: 'document_upload.abandoned', entityType: 'document_upload', entityId: row.id,
        metadata: { reason: exists ? 'orphaned_object' : 'no_object' },
      });
    });
    if (exists) report.abandonedOrphanedObject += 1; else report.abandonedNoObject += 1;
  }
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const minutesArg = args.find((arg) => arg.startsWith('--pending-minutes='));
  const pendingMinutes = minutesArg ? Number.parseInt(minutesArg.split('=')[1], 10) : DEFAULT_PENDING_MINUTES;
  if (!Number.isInteger(pendingMinutes) || pendingMinutes < 1) throw new Error('--pending-minutes must be a positive integer');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const { createPgDatabase } = await import('../src/db.js');
  const { storageFromEnv } = await import('../src/storage.js');
  const db = createPgDatabase({ connectionString: process.env.DATABASE_URL });
  const storage = storageFromEnv(process.env);
  if (!storage) throw new Error('BUCKET_* variables are not set');
  try {
    const report = await cleanupDocumentUploads(db, storage, { pendingMinutes, dryRun });
    console.log(JSON.stringify({ dryRun, pendingMinutes, ...report }));
  } finally {
    await db.close().catch(() => {});
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const message = error?.code && /^[a-z_]+(:[A-Za-z0-9_.:]+)?$/.test(error.code) ? error.code : (error?.message ?? 'error');
    console.error(`Document uploads cleanup failed: ${message}`);
    process.exitCode = 1;
  }
}
