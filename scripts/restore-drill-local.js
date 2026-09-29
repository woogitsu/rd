// Lokalna próba odtworzenia na danych syntetycznych (issue #90):
//
//   RD_LOCAL_PG_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres npm run restore:drill:local
//
// (zamiast RD_LOCAL_PG_ADMIN_URL zadziała RD_TEST_PG_URL z testów). Wymaga
// pg_dump/pg_restore w PATH i lokalnego serwera z prawem CREATE DATABASE.
// Nie używa Railway ani żadnych sekretów produkcji; odmawia hostu innego niż
// lokalny. Kod wyjścia 1 przy jakiejkolwiek niezgodności. Na stdout wyłącznie
// liczby i skróty (bez danych osobowych).

import { runLocalRestoreDrill } from './lib/local-restore-drill.js';

const adminUrl = process.env.RD_LOCAL_PG_ADMIN_URL || process.env.RD_TEST_PG_URL;
if (!adminUrl) {
  console.error('Local restore drill refused: set RD_LOCAL_PG_ADMIN_URL to a LOCAL PostgreSQL server (CREATE DATABASE privilege).');
  process.exit(1);
}
try {
  const result = await runLocalRestoreDrill({ adminUrl });
  console.log(JSON.stringify(result));
} catch (error) {
  const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,60}$/.test(error.code) ? error.code : 'local_restore_drill_failed';
  console.error(`Local restore drill failed: ${code}`);
  if (Array.isArray(error?.differences)) for (const d of error.differences.slice(0, 50)) console.error(`  ${d.section}: ${d.key}`);
  process.exitCode = 1;
}
