// Jeden przebieg kolejki e-mail — do uruchamiania ręcznie lub jako Railway cron.
//   npm run email:worker              → dry-run (domyślnie; nic nie wysyła)
//   npm run email:worker -- --send    → wysyłka, tylko gdy EMAIL_SENDING_ENABLED=true
// Proces kończy się po jednym przebiegu (wymóg zadań cron Railway).
// Log zawiera wyłącznie liczby i kody — bez adresów i treści.

import { createPgDatabase } from '../src/db.js';
import { createBrevoTransport, emailConfig } from '../src/email/brevo.js';
import { runEmailBatch } from '../src/email/worker.js';

const live = process.argv.includes('--send');

if (!process.env.DATABASE_URL) {
  console.error('[email-worker] DATABASE_URL is required. Nothing was sent.');
  process.exitCode = 1;
} else {
  const db = createPgDatabase({ connectionString: process.env.DATABASE_URL, application_name: 'rd-email-worker', max: 2 });
  try {
    const config = emailConfig(process.env);
    const transport = live
      ? createBrevoTransport({ apiKey: process.env.BREVO_API_KEY, appEnv: config.appEnv })
      : null;
    const run = await runEmailBatch({ db }, { transport, dryRun: !live, config });
    const { mode, day, remainingQuota, planned, sent, retried, failed, skipped, suppressed, stoppedReason } = run;
    console.log(`[email-worker] ${JSON.stringify({ mode, day, remainingQuota, planned, sent, retried, failed, skipped, suppressed, stoppedReason })}`);
    if (live && stoppedReason && ['sending_disabled', 'sender_not_configured', 'transport_missing'].includes(stoppedReason)) {
      process.exitCode = 2;
    }
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(error.code) ? error.code : 'error';
    console.error(`[email-worker] failed ${code}`);
    process.exitCode = 1;
  } finally {
    await db.close().catch(() => {});
  }
}
