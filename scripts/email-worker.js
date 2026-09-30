// Jeden przebieg kolejki e-mail — do uruchamiania ręcznie lub jako Railway cron.
//   npm run email:worker              → dry-run (domyślnie; nic nie wysyła)
//   npm run email:worker -- --send    → wysyłka, tylko gdy EMAIL_SENDING_ENABLED=true
// Proces kończy się po jednym przebiegu (wymóg zadań cron Railway).
// Log zawiera wyłącznie liczby, kody i identyfikatory — bez adresów i treści.
// SIGTERM/SIGINT (redeploy lub zatrzymanie usługi na Railway): przebieg kończy
// bieżącą wiadomość, nie zaczyna następnej, zwraca resztę partii do kolejki
// i zapisuje stopped_reason = 'shutdown' (#172).

import { createPgDatabase } from '../src/db.js';
import { createBrevoTransport, emailConfig } from '../src/email/brevo.js';
import { runEmailBatch } from '../src/email/worker.js';
import { resolveWriteMode, WRITE_MODE_READ_ONLY } from '../src/write-mode.js';

const live = process.argv.includes('--send');
let writeMode;
try {
  writeMode = resolveWriteMode(process.env.APP_WRITE_MODE);
} catch (error) {
  console.error(`[email-worker] ${error.message}`);
  process.exitCode = 1;
}
const shutdown = new AbortController();
for (const name of ['SIGTERM', 'SIGINT']) {
  process.once(name, () => {
    console.log(`[email-worker] ${name}: finishing the current message and stopping`);
    shutdown.abort();
  });
}

// Wiadomości przyjęte przez dostawcę, których wyniku nie udało się zapisać:
// identyfikator wiersza i wiadomości dostawcy do ręcznego rozstrzygnięcia.
function logUnrecorded(run) {
  for (const entry of run?.unrecorded ?? []) {
    console.error(`[email-worker] sent_result_unrecorded ${JSON.stringify(entry)}`);
  }
}

if (writeMode === undefined) {
  // Błąd konfiguracji (APP_WRITE_MODE) już zalogowany powyżej; process.exitCode ustawiony.
} else if (writeMode === WRITE_MODE_READ_ONLY) {
  // Tryb tylko do odczytu (#143): przebieg kończy się bez dotykania kolejki
  // (żadnego połączenia z bazą) — zapisy są wstrzymane na czas okna serwisowego.
  console.log(`[email-worker] ${JSON.stringify({ stoppedReason: 'read_only', sent: 0, planned: 0 })}`);
} else if (!process.env.DATABASE_URL) {
  console.error('[email-worker] DATABASE_URL is required. Nothing was sent.');
  process.exitCode = 1;
} else {
  const db = createPgDatabase({ connectionString: process.env.DATABASE_URL, application_name: 'rd-email-worker', max: 2 });
  try {
    const config = emailConfig(process.env);
    const transport = live
      ? createBrevoTransport({ apiKey: process.env.BREVO_API_KEY, appEnv: config.appEnv })
      : null;
    const run = await runEmailBatch({ db }, { transport, dryRun: !live, config, signal: shutdown.signal });
    const { mode, day, remainingQuota, planned, sent, retried, failed, skipped, suppressed, requeued, stoppedReason } = run;
    console.log(`[email-worker] ${JSON.stringify({ mode, day, remainingQuota, planned, sent, retried, failed, skipped, suppressed, requeued, stoppedReason })}`);
    logUnrecorded(run);
    if (live && stoppedReason && ['sending_disabled', 'sender_not_configured', 'transport_missing', 'provider_account_rejected', 'provider_account_paused'].includes(stoppedReason)) {
      process.exitCode = 2;
    }
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(error.code) ? error.code : 'error';
    console.error(`[email-worker] failed ${code}`);
    logUnrecorded(error?.run);
    process.exitCode = 1;
  } finally {
    await db.close().catch(() => {});
  }
}
