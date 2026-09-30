// Propozycje rozstrzygnięć dla wiadomości `delivery_unknown` (#139). NIE wysyła
// poczty i NIE zapisuje niczego w bazie — rozstrzygnięcie zapisuje człowiek
// w panelu e-mail (POST /api/email/campaigns/{id}/resolutions).
//   npm run email:reconcile                          → tylko zapisane zdarzenia webhooka (bez sieci)
//   npm run email:reconcile -- --campaign <id>       → jedna kampania
//   npm run email:reconcile -- --query-brevo         → dodatkowo zapytanie tylko do odczytu
//     GET /v3/smtp/statistics/events po message-id (BREVO_API_KEY), wyłącznie
//     dla wierszy z zapisanym provider_message_id; adres odbiorcy nie jest wysyłany.
// Wynik: jedna linia JSON na wiersz (id wiersza/kampanii, kody), bez adresów.
// Skrypt nigdy nie proponuje `confirmed_not_sent` (patrz src/email/reconcile.js).

import { createPgDatabase } from '../src/db.js';
import { proposeResolutions } from '../src/email/reconcile.js';

export function parseReconcileArgs(argv) {
  const options = { campaignId: null, queryBrevo: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--query-brevo') options.queryBrevo = true;
    else if (argv[i] === '--campaign') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new Error('invalid_campaign_id');
      options.campaignId = value;
      i += 1;
    } else throw new Error('unknown_argument');
  }
  return options;
}

/* c8 ignore start -- ścieżka CLI, pokryta przez testy proposeResolutions */
async function main() {
  let options;
  try {
    options = parseReconcileArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[email-reconcile] ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error('[email-reconcile] DATABASE_URL is required.');
    process.exitCode = 1;
    return;
  }
  const db = createPgDatabase({ connectionString: process.env.DATABASE_URL, application_name: 'rd-email-reconcile', max: 1 });
  try {
    const result = await proposeResolutions(db, { ...options, apiKey: process.env.BREVO_API_KEY });
    for (const row of result.rows) console.log(`[email-reconcile] ${JSON.stringify(row)}`);
    console.log(`[email-reconcile] ${JSON.stringify({ rows: result.rows.length, lookups: result.lookups, stoppedCode: result.stoppedCode, written: 0 })}`);
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(error.code) ? error.code : 'error';
    console.error(`[email-reconcile] failed ${code}`);
    process.exitCode = 1;
  } finally {
    await db.close().catch(() => {});
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main();
}
/* c8 ignore stop */
