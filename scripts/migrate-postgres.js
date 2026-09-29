import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { appEnvWarning, guardDangerousOperation } from '../src/app-env.js';
import { applyMigrations, loadMigrations } from '../src/postgres-migrations.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. No migration was run.');
  process.exitCode = 1;
} else if (guardDangerousOperation(process.env.APP_ENV, { allowProduction: process.argv.includes('--allow-production') }).refused) {
  const warning = appEnvWarning(process.env.APP_ENV);
  if (warning) console.error(warning);
  console.error('Production (or unrecognised APP_ENV) migration requires explicit --allow-production. No migration was run.');
  process.exitCode = 1;
} else {
  const directory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    const allowOutOfOrder = process.argv.includes('--allow-out-of-order');
    const completed = await applyMigrations(client, await loadMigrations(directory), { allowOutOfOrder });
    console.log(completed.length ? `Applied migrations: ${completed.join(', ')}` : 'No pending migrations.');
  } catch (error) {
    console.error(`Migration failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}
