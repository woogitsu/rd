// Heartbeat zadań (issue #149): `GET /health/jobs` (chroniony tokenem,
// wywoływany przez zewnętrzny monitor obok `/health/ready`). Progi są
// konfiguracją (zmienne środowiskowe), nie kodem — kryterium akceptacji #149.
//
// WYŁĄCZNIE nazwy przekroczonych progów w odpowiedzi — bez liczb, dat i
// żadnych danych operacyjnych (monitor zewnętrzny nie powinien widzieć
// więcej niż "coś jest nie tak z X").

import { timingSafeEqual } from 'node:crypto';
import { guardianVerifyEnabled } from '../email/guardian-verify.js';
import {
  ageHours, emailQueueStatus, emailWorkerStatus, guardianVerifyQueueMaxAgeHours, guardianVerifyQueueStatus, lastBackupRun,
} from './ops-status.js';

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

  const guardianVerifyMaxAgeHours = guardianVerifyQueueMaxAgeHours(env);

  const [backup, worker, queue, verifyQueue] = await Promise.all([
    lastBackupRun(db, 'backup'),
    emailWorkerStatus(db),
    emailQueueStatus(db),
    // #140 pkt 5: kolejka kodów weryfikacyjnych. Przy wyłączonej fladze
    // GUARDIAN_VERIFY_EMAIL_ENABLED wiersze w kolejce czekają celowo — bez progu.
    guardianVerifyEnabled(env) ? guardianVerifyQueueStatus(db) : null,
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
  // Kody weryfikacyjne (#140 pkt 5) obsługuje ten sam worker, więc czekający kod też
  // wymaga świeżego przebiegu — ten sam próg `email_worker_stale`, bez drugiej nazwy.
  const campaignPending = Boolean(queue && queue.pending > 0);
  const verifyPending = Boolean(verifyQueue && verifyQueue.queued > 0);
  if (campaignPending || verifyPending) {
    const workerAge = ageHours(worker?.finishedAt, current);
    if (workerAge === null || workerAge > emailWorkerMaxAgeHours) failedThresholds.push('email_worker_stale');
  }
  if (campaignPending) {
    const oldestAge = ageHours(queue.oldestPendingAt, current);
    if (oldestAge !== null && oldestAge > emailQueueMaxAgeHours) failedThresholds.push('email_queue_too_old');
  }
  // Kod jest ważny 24 h od przejęcia do wysyłki, a rodzic czeka na wiadomość: najstarszy oczekujący wiersz
  // starszy niż GUARDIAN_VERIFY_QUEUE_MAX_AGE_HOURS (domyślnie 2 h) to osobny sygnał.
  if (verifyPending) {
    const oldestAge = ageHours(verifyQueue.oldestPendingAt, current);
    if (oldestAge !== null && oldestAge > guardianVerifyMaxAgeHours) failedThresholds.push('guardian_verify_queue_too_old');
  }

  return { ok: failedThresholds.length === 0, failedThresholds };
}
