// Logika kopii zapasowej PostgreSQL i próbnego odtworzenia (issue #90),
// niezależna od pg_dump/pg_restore i od dostawcy magazynu — obie strony są
// wstrzykiwane, żeby dało się to przetestować bez prawdziwej bazy/binariów
// (wzorzec jak runEmailBatch w src/email/worker.js).
//
// `db` to zawsze BAZA ŹRÓDŁOWA (ta z backup_runs); przy próbnym odtworzeniu
// dane trafiają do ODDZIELNEJ bazy docelowej przekazanej w `restore`.

import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../storage.js';
import { decryptEnvelope, encryptEnvelope } from '../backup-crypto.js';
import { compareRestoreReports } from './restore-report.js';

function backupError(code, extra) {
  return Object.assign(new Error(code), { code, ...extra });
}

// Klucz obiektu z datą (UTC) — ponowienie w tym samym oknie crona (ten sam
// dzień) trafia w ten sam klucz, więc `runBackup` je pomija zamiast dublować.
// Format zgodny z assertObjectKey (src/storage.js): "<prefix>/<8-64 znaków
// alfanumerycznych i myślników>" — bez kropek i podkreśleń.
export function dailyObjectKey(kind, now = new Date()) {
  const day = now.toISOString().slice(0, 10).replaceAll('-', '');
  const prefix = kind === 'storage_backup' ? 'storage' : 'postgres';
  return `backups/rd-${prefix}-${day}`;
}

export async function recordBackupRun(db, {
  kind, environment, startedAt, finishedAt = new Date(), result, objectKey = null,
  sizeBytes = null, sha256 = null, rowCounts = null, sums = null, errorCode = null,
}) {
  await db.query(
    `INSERT INTO backup_runs
       (id, kind, environment, started_at, finished_at, result, object_key, size_bytes, sha256, row_counts, sums, error_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [randomUUID(), kind, environment, startedAt, finishedAt, result, objectKey,
      sizeBytes, sha256, rowCounts ? JSON.stringify(rowCounts) : null, sums ? JSON.stringify(sums) : null, errorCode],
  );
}

export async function latestSuccessfulBackupRun(db, kind = 'backup') {
  const { rows } = await db.query(
    `SELECT id, object_key, size_bytes, sha256, finished_at, row_counts, sums FROM backup_runs
     WHERE kind = $1 AND result = 'success' ORDER BY finished_at DESC LIMIT 1`,
    [kind],
  );
  return rows[0] ?? null;
}

// Wykonuje jeden przebieg backupu. `dump()` zwraca surowy zrzut (Buffer);
// `storage` ma kontrakt z src/storage.js (headObject/putObject).
// Zwraca { skipped: true } bez wywołania `dump`, jeśli obiekt dnia już
// istnieje (drugi przebieg crona w tym samym oknie) i `force` nie jest ustawione.
export async function runBackup({
  db, dump, storage, encryptPublicKeyPem, kind = 'backup', environment,
  now = () => new Date(), force = false,
}) {
  if (!environment) throw backupError('backup_environment_required');
  const objectKey = dailyObjectKey(kind, now());
  if (!force && (await storage.headObject(objectKey))) return { skipped: true, objectKey };

  const startedAt = now();
  try {
    // `dump()` zwraca Buffer albo { plaintext, report } — raport (liczności i
    // sumy z tej samej migawki co zrzut) trafia do dziennika jako punkt
    // odniesienia dla próby odtworzenia.
    const dumped = await dump();
    const plaintext = Buffer.isBuffer(dumped) ? dumped : dumped.plaintext;
    const report = Buffer.isBuffer(dumped) ? null : dumped.report ?? null;
    const envelope = encryptEnvelope(plaintext, encryptPublicKeyPem);
    const sha256 = sha256Hex(envelope);
    await storage.putObject(objectKey, envelope, 'application/octet-stream');
    await recordBackupRun(db, {
      kind, environment, startedAt, finishedAt: now(), result: 'success',
      objectKey, sizeBytes: envelope.length, sha256,
      rowCounts: report?.rowCounts ?? null, sums: report?.sums ?? null,
    });
    return { skipped: false, objectKey, sha256, sizeBytes: envelope.length };
  } catch (error) {
    const errorCode = typeof error?.code === 'string' && /^[a-z0-9_]{1,60}$/.test(error.code) ? error.code : 'backup_failed';
    await recordBackupRun(db, { kind, environment, startedAt, finishedAt: now(), result: 'failure', errorCode }).catch(() => {});
    throw error;
  }
}

// Próbne odtworzenie: pobiera ostatni udany backup ze wskazanego dziennika,
// sprawdza SHA-256, odszyfrowuje i przekazuje do `restore(plaintext)` —
// zapis do bazy DOCELOWEJ jest wyłącznie po stronie wywołującego (pg_restore
// w CLI, albo atrapa w testach). `sourceUrl`/`targetUrl` muszą się różnić
// (host+baza) — twarda kontrola z kryteriów akceptacji #90.
export async function runRestoreDrill({
  db, storage, decryptPrivateKeyPem, restore, migrateTarget, reportQuery,
  sourceUrl, targetUrl, environment, kind = 'backup', now = () => new Date(),
}) {
  if (!environment) throw backupError('backup_environment_required');
  assertDifferentDatabase(sourceUrl, targetUrl);

  const startedAt = now();
  try {
    const latest = await latestSuccessfulBackupRun(db, kind);
    if (!latest) throw backupError('restore_no_backup_available');
    const object = await storage.getObject(latest.object_key);
    const actualSha256 = sha256Hex(object.body);
    if (actualSha256 !== latest.sha256) throw backupError('restore_checksum_mismatch');

    const plaintext = decryptEnvelope(object.body, decryptPrivateKeyPem);
    await restore(plaintext);
    const pendingMigrations = await migrateTarget();
    if (pendingMigrations && pendingMigrations.length) throw backupError('restore_migrations_pending', { pending: pendingMigrations });
    const report = await reportQuery();

    // Punkt odniesienia: raport z chwili zrzutu (backup_runs.row_counts/sums).
    // Niezgodność = błąd próby (kod ≠ 0), a nie „sukces z niepełnymi danymi”.
    // Kopia bez raportu (sprzed tej zmiany) nie ma z czym się porównać — próba
    // jest wtedy oznaczona `comparison: 'no_baseline'`, nigdy „zgodna”.
    const baseline = latest.row_counts && latest.sums ? { rowCounts: latest.row_counts, sums: latest.sums } : null;
    if (baseline) {
      const differences = compareRestoreReports(baseline, report);
      if (differences.length) throw backupError('restore_report_mismatch', { differences });
    }
    report.comparison = baseline ? 'matched' : 'no_baseline';

    await recordBackupRun(db, {
      kind: 'restore_drill', environment, startedAt, finishedAt: now(), result: 'success',
      objectKey: latest.object_key, sizeBytes: latest.size_bytes, sha256: latest.sha256,
      rowCounts: report.rowCounts, sums: report.sums,
    });
    return report;
  } catch (error) {
    const errorCode = typeof error?.code === 'string' && /^[a-z0-9_]{1,60}$/.test(error.code) ? error.code : 'restore_drill_failed';
    await recordBackupRun(db, { kind: 'restore_drill', environment, startedAt, finishedAt: now(), result: 'failure', errorCode }).catch(() => {});
    throw error;
  }
}

function parseDbIdentity(connectionString) {
  try {
    const url = new URL(connectionString);
    return `${url.host}${url.pathname}`;
  } catch {
    // Nie logujemy adresu — tylko odmawiamy, jeśli nie da się porównać.
    throw backupError('restore_target_url_invalid');
  }
}

export function assertDifferentDatabase(sourceUrl, targetUrl) {
  if (!sourceUrl || !targetUrl) throw backupError('restore_target_url_invalid');
  if (parseDbIdentity(sourceUrl) === parseDbIdentity(targetUrl)) throw backupError('restore_target_same_as_source');
}
