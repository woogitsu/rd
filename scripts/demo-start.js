// Uruchamia serwer Node (src/server.js) na bazie utworzonej przez `npm run demo:seed`.
// WYŁĄCZNIE lokalnie, dane syntetyczne — patrz scripts/demo-seed.js i AGENTS.md.
//
//   npm run build && npm run demo:seed && npm run demo:start
//
// Domyślnie otwiera to samo trwałe PGlite (.demo-data/pgdata) co seed, więc panel
// pokazuje dokładnie te dane. Z DATABASE_URL (zweryfikowanym tak samo jak w seedzie)
// łączy się z lokalnym PostgreSQL zamiast PGlite. Klucz szyfrowania MFA jest
// odczytywany z pliku zapisanego przez seed (.demo-data/mfa-encryption-key.local),
// żeby czynniki TOTP założone podczas seeda dało się potwierdzić przy logowaniu.

import { access, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { startServer } from '../src/server.js';
import { createPgDatabase } from '../src/db.js';
import { dummyHash } from '../src/pg/password.js';
import {
  assertSafeEnvironment, demoAppEnv, DemoSeedRefused, DEMO_MFA_KEY_FILE, DEMO_PGLITE_DIR, SCHOOL_YEAR_ID,
} from './demo-seed.js';

async function readMfaKey() {
  try {
    return (await readFile(DEMO_MFA_KEY_FILE, 'utf8')).trim();
  } catch {
    throw new DemoSeedRefused(
      'demo_not_seeded',
      `Brak klucza MFA demo (${DEMO_MFA_KEY_FILE}). Uruchom najpierw „npm run demo:seed”.`,
    );
  }
}

async function openRuntimeDatabase(databaseUrl) {
  if (databaseUrl) {
    return { db: createPgDatabase({ connectionString: databaseUrl, max: 10 }), close: (db) => db.close() };
  }
  try {
    await access(DEMO_PGLITE_DIR);
  } catch {
    throw new DemoSeedRefused('demo_not_seeded', `Brak bazy demo (${DEMO_PGLITE_DIR}). Uruchom najpierw „npm run demo:seed”.`);
  }
  const db = new PGlite(DEMO_PGLITE_DIR);
  return { db, close: (instance) => instance.close() };
}

export async function startDemoServer({ port = Number(process.env.PORT || 3000) } = {}) {
  assertSafeEnvironment(process.env);
  const mfaEncryptionKey = await readMfaKey();
  const { db, close } = await openRuntimeDatabase(process.env.DATABASE_URL);
  const env = {
    db,
    MFA_ENCRYPTION_KEY: mfaEncryptionKey,
    APP_ENV: demoAppEnv(process.env),
    // Brak BREVO_WEBHOOK_SECRET/klucza Brevo — assertSafeEnvironment już odmówił,
    // gdyby BREVO_API_KEY był ustawiony; trasy e-mail działają tylko jako szkice.
  };
  await dummyHash(env).catch(() => {});
  const { handlePgRequest } = await import('../src/pg/app.js');
  const server = await startServer({ port, env, fetchHandler: handlePgRequest });
  const address = server.address();
  console.log(`Serwer demo działa na http://127.0.0.1:${address.port} (dane wyłącznie syntetyczne, WYŁĄCZNIE lokalnie).`);
  console.log('Konta i hasła demo zostały wypisane przez „npm run demo:seed” — nie są zapisane na dysku.');
  // site/core.js#defaultSchoolYearId zgaduje rok z dzisiejszej daty — jawne
  // „?rok=” pokazuje ten sam rok, do którego seed wpisał dane, niezależnie od tego.
  console.log(`Strona publiczna: http://127.0.0.1:${address.port}/site/?rok=${SCHOOL_YEAR_ID}`);
  const shutdown = async () => {
    await new Promise((resolve) => server.close(resolve));
    await close(db);
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return { server, close: shutdown };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  try {
    await startDemoServer();
  } catch (error) {
    if (error instanceof DemoSeedRefused) {
      console.error(error.message);
      process.exitCode = 2;
    } else {
      console.error('Nie udało się uruchomić serwera demo:', error.message);
      process.exitCode = 1;
    }
  }
}
