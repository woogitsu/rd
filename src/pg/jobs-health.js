// Heartbeat zadań (issue #149): `GET /health/jobs` (chroniony tokenem,
// wywoływany przez zewnętrzny monitor obok `/health/ready`). Progi są
// konfiguracją (zmienne środowiskowe), nie kodem — kryterium akceptacji #149.
//
// WYŁĄCZNIE nazwy przekroczonych progów w odpowiedzi — bez liczb, dat i
// żadnych danych operacyjnych (monitor zewnętrzny nie powinien widzieć
// więcej niż "coś jest nie tak z X").

import { timingSafeEqual } from 'node:crypto';
import { ageHours, emailQueueStatus, emailWorkerStatus, lastBackupRun } from './ops-status.js';

const DEFAULT_BACKUP_MAX_AGE_HOURS = 26;
const DEFAULT_EMAIL_WORKER_MAX_AGE_HOURS = 6;
const DEFAULT_EMAIL_QUEUE_MAX_AGE_HOURS = 24;

function positiveHours(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Porównanie tokenu w czasie stałym (długość może różnić się jawnie —
// nie jest tajna, tylko wartość jest).
export function tokensMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function checkJobsHealth(env, { now = () => new Date() } = {}) {
  if (!env?.db) return { ok: false, failedThresholds: ['database_not_configured'] };
  const db = env.db;
  const current = now();
  const backupMaxAgeHours = positiveHours(env.BACKUP_MAX_AGE_HOURS, DEFAULT_BACKUP_MAX_AGE_HOURS);
  const emailWorkerMaxAgeHours = positiveHours(env.EMAIL_WORKER_MAX_AGE_HOURS, DEFAULT_EMAIL_WORKER_MAX_AGE_HOURS);
  const emailQueueMaxAgeHours = positiveHours(env.EMAIL_QUEUE_MAX_AGE_HOURS, DEFAULT_EMAIL_QUEUE_MAX_AGE_HOURS);

  const [backup, worker, queue] = await Promise.all([
    lastBackupRun(db, 'backup'),
    emailWorkerStatus(db),
    emailQueueStatus(db),
  ]);

  const failedThresholds = [];

  // Brak backupu > próg (świeża baza bez żadnego udanego przebiegu liczy się
  // jako przekroczony próg — to właśnie sygnał, że backup nigdy nie zadziałał).
  const backupAge = ageHours(backup.lastRun?.finishedAt, current);
  if (backup.status !== 'ok' || backupAge === null || backupAge > backupMaxAgeHours) {
    failedThresholds.push('backup_too_old');
  }

  // Worker/kolejka: tylko przy aktywnej kampanii (kolejka niepusta) —
  // kryterium z issue: "worker nie działał > N h przy aktywnej kampanii".
  if (queue && queue.pending > 0) {
    const workerAge = ageHours(worker?.finishedAt, current);
    if (workerAge === null || workerAge > emailWorkerMaxAgeHours) failedThresholds.push('email_worker_stale');

    const oldestAge = ageHours(queue.oldestPendingAt, current);
    if (oldestAge !== null && oldestAge > emailQueueMaxAgeHours) failedThresholds.push('email_queue_too_old');
  }

  return { ok: failedThresholds.length === 0, failedThresholds };
}
