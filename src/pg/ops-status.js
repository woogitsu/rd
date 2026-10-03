// Stan techniczny systemu dla administratora (issue #149): migracje, worker
// e-mail, kolejka, ostatnia kopia zapasowa/próba odtworzenia/kopia bucketu
// (#90/#103), ostatni eksport roczny, tryb pracy i wersja aplikacji.
//
// WYŁĄCZNIE liczby, znaczniki czasu i kody — bez adresów, nazw rodzin i
// treści (kryterium akceptacji #149; test szuka `@`, IBAN i imion z seedu
// w odpowiedzi). Czyta bezpośrednio z tabel, żeby nie zależeć od modułów,
// które mogą być jeszcze niescalone na tej gałęzi (#90 backup_runs, #103
// storage_backup, #143 write-mode) — każdy blok sprawdza istnienie obiektu
// dynamicznie (`to_regclass`) i zwraca `null`/`'no_data'`, jeśli brakuje.

import { fileURLToPath } from 'node:url';
import { loadMigrations } from '../postgres-migrations.js';
import { accountsUnderPressure } from './login.js';
import { guardianVerifyEnabled } from '../email/guardian-verify.js';

async function tableExists(db, name) {
  const { rows } = await db.query('SELECT to_regclass($1) AS t', [name]);
  return rows[0]?.t != null;
}

async function migrationsStatus(db) {
  // schema_migrations jest tworzona przez migrator (src/postgres-migrations.js),
  // nie przez pliki migracji same w sobie — bazy testowe zbudowane innym
  // sposobem (np. db.exec() bezpośrednio z plików SQL) mogą jej nie mieć.
  if (!(await tableExists(db, 'schema_migrations'))) return { appliedCount: null, pendingCount: null, pending: [] };
  const directory = fileURLToPath(new URL('../../postgres/migrations/', import.meta.url));
  const onDisk = (await loadMigrations(directory)).map((m) => m.name);
  const { rows } = await db.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((row) => row.name));
  const pending = onDisk.filter((name) => !applied.has(name));
  return { appliedCount: applied.size, pendingCount: pending.length, pending: pending.slice(0, 20) };
}

export async function emailWorkerStatus(db) {
  if (!(await tableExists(db, 'email_worker_runs'))) return null;
  const { rows } = await db.query(
    `SELECT mode, finished_at, sent, retried, failed, stopped_reason
     FROM email_worker_runs ORDER BY finished_at DESC LIMIT 1`,
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    mode: row.mode,
    finishedAt: row.finished_at,
    sent: row.sent,
    retried: row.retried,
    failed: row.failed,
    stoppedReason: row.stopped_reason,
  };
}

export async function emailQueueStatus(db) {
  if (!(await tableExists(db, 'email_outbox'))) return null;
  const { rows } = await db.query(
    `SELECT state, count(*)::int AS n, min(created_at) AS oldest
     FROM email_outbox WHERE state IN ('queued', 'failed') GROUP BY state`,
  );
  const byState = { queued: 0, failed: 0 };
  let oldestQueued = null;
  for (const row of rows) {
    byState[row.state] = row.n;
    if (row.state === 'queued') oldestQueued = row.oldest;
  }
  return { pending: byState.queued, failed: byState.failed, oldestPendingAt: oldestQueued };
}

// Kolejka kodów weryfikacyjnych nowych adresów (#140 pkt 5, migracja 0184) — jak email_outbox,
// ale wyłącznie liczby i znacznik czasu: stany `queued` (czeka na worker) i `sending`
// (przejęte przez przebieg; zawieszone odzyskuje recoverStaleVerifications), najstarszy
// oczekujący (`created_at` najstarszego `queued`). Bez adresów, kodów, skrótów i identyfikatorów
// wniosków. Tabela nie istnieje przed migracją 0184 → null (jak pozostałe bloki).
export const DEFAULT_GUARDIAN_VERIFY_QUEUE_MAX_AGE_HOURS = 2;

// Kod jest ważny 24 h od przejęcia do wysyłki, a rodzic czeka na wiadomość po złożeniu
// wniosku — dlatego próg jest krótszy niż próg kolejki kampanii (24 h). Konfigurowalny.
export function guardianVerifyQueueMaxAgeHours(env) {
  const n = Number(env?.GUARDIAN_VERIFY_QUEUE_MAX_AGE_HOURS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_GUARDIAN_VERIFY_QUEUE_MAX_AGE_HOURS;
}

export async function guardianVerifyQueueStatus(db) {
  if (!(await tableExists(db, 'guardian_update_verifications'))) return null;
  const { rows } = await db.query(
    `SELECT state, count(*)::int AS n, min(created_at) AS oldest
     FROM guardian_update_verifications WHERE state IN ('queued', 'sending') GROUP BY state`,
  );
  const byState = { queued: 0, sending: 0 };
  let oldestQueued = null;
  for (const row of rows) {
    byState[row.state] = row.n;
    if (row.state === 'queued') oldestQueued = row.oldest;
  }
  return { queued: byState.queued, sending: byState.sending, oldestPendingAt: oldestQueued };
}

// Wspólne dla #90 (backup) i #103 (storage_backup) — patrz backup_runs.
export async function lastBackupRun(db, kind) {
  if (!(await tableExists(db, 'backup_runs'))) return { status: 'no_data', lastRun: null };
  const { rows } = await db.query(
    `SELECT result, finished_at FROM backup_runs WHERE kind = $1
     ORDER BY finished_at DESC LIMIT 1`,
    [kind],
  );
  if (!rows.length) return { status: 'no_data', lastRun: null };
  const row = rows[0];
  return {
    status: row.result === 'success' ? 'ok' : 'attention',
    lastRun: { result: row.result, finishedAt: row.finished_at },
  };
}

async function exportRunsStatus(db) {
  if (!(await tableExists(db, 'export_runs'))) return null;
  const { rows } = await db.query('SELECT kind, created_at FROM export_runs ORDER BY created_at DESC LIMIT 1');
  if (!rows.length) return null;
  return { kind: rows[0].kind, createdAt: rows[0].created_at };
}

// Godziny od `finishedAt` do `now` — null jeśli nie ma daty (brak danych).
export function ageHours(finishedAt, now = new Date()) {
  if (!finishedAt) return null;
  const ms = now.getTime() - new Date(finishedAt).getTime();
  return ms / (1000 * 60 * 60);
}

async function loginPressureStatus(db, env, now) {
  if (!(await tableExists(db, 'login_rate_limits'))) return null;
  return accountsUnderPressure(db, { env, now });
}

export async function computeOpsStatus({ db, env, now = () => new Date() }) {
  const [migrations, emailWorker, emailQueue, guardianVerifyQueue, backup, storageBackup, restoreDrill, exportRun, loginPressure] = await Promise.all([
    migrationsStatus(db),
    emailWorkerStatus(db),
    emailQueueStatus(db),
    guardianVerifyQueueStatus(db),
    lastBackupRun(db, 'backup'),
    lastBackupRun(db, 'storage_backup'),
    lastBackupRun(db, 'restore_drill'),
    exportRunsStatus(db),
    loginPressureStatus(db, env, now),
  ]);
  return {
    migrations,
    emailWorker,
    emailQueue,
    // #140 pkt 5: kolejka kodów weryfikacyjnych (liczby i czas najstarszego oczekującego);
    // `overdue` = najstarszy oczekujący starszy niż GUARDIAN_VERIFY_QUEUE_MAX_AGE_HOURS, tylko przy
    // włączonej fladze GUARDIAN_VERIFY_EMAIL_ENABLED (przy wyłączonej wiersze czekają celowo).
    guardianVerifyQueue: guardianVerifyQueue && {
      ...guardianVerifyQueue,
      overdue: guardianVerifyEnabled(env) && guardianVerifyQueue.queued > 0
        && (ageHours(guardianVerifyQueue.oldestPendingAt, now()) ?? 0) > guardianVerifyQueueMaxAgeHours(env),
    },
    backup,
    storageBackup,
    restoreDrill,
    lastExport: exportRun,
    // #126: sygnał, nie blokada; identyfikatory kont i liczby, bez e-maili i IP.
    loginPressure,
    // #143 nie musi być scalone na tej gałęzi — czytamy zmienną wprost,
    // zamiast importować moduł, który może jeszcze nie istnieć.
    writeMode: env.APP_WRITE_MODE === 'read_only' ? 'read_only' : 'normal',
    appVersion: env.RAILWAY_GIT_COMMIT_SHA ?? null,
    generatedAt: now().toISOString(),
  };
}
