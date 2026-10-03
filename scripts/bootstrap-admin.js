// Pierwszy administrator na pustej bazie PostgreSQL (issue #187).
//
//   DATABASE_URL=… APP_ENV=staging npm run auth:bootstrap-admin -- <email> --expect-database=<nazwa bazy> [--ttl-hours=24] [--allow-production]
//
// Działa tylko, gdy nie ma aktywnego administratora ani ważnego zaproszenia
// do roli admin. Token zaproszenia jest wypisywany RAZ na stdout (jedna linia
// `token: …`) i nigdzie nie jest zapisywany ani logowany. Komunikaty błędów
// idą na stderr bez adresu e-mail i bez tokenu. Szczegóły:
// docs/RAILWAY_OPERATIONS.md, „Pierwszy administrator (bootstrap)”.

import { appEnvWarning } from '../src/app-env.js';
import { fileURLToPath } from 'node:url';
import { assertConnectedDatabase, DatabaseIdentityError, requireExpectedDatabase } from '../src/database-identity.js';
import { createPgDatabase } from '../src/db.js';
import { BootstrapRefused, bootstrapAdmin } from '../src/pg/bootstrap-admin.js';

const USAGE = 'Usage: npm run auth:bootstrap-admin -- <email> --expect-database=<database name> [--ttl-hours=24] [--allow-production]';

const REFUSALS = {
  admin_exists: 'An active administrator already exists. Bootstrap refused; use the admin panel to invite further accounts.',
  pending_admin_invitation: 'An unused admin invitation is still valid. Bootstrap refused; accept it or wait until it expires',
  production_requires_flag: 'APP_ENV=production (or missing/unrecognised APP_ENV) requires explicit --allow-production (only within an approved cutover, D-20). Nothing was changed.',
  user_disabled: 'The account with this address is disabled. Bootstrap refused.',
  invalid_email: 'The e-mail address is invalid. Nothing was changed.',
};

export async function runBootstrapCli({ argv, env, db, stdout = process.stdout, stderr = process.stderr }) {
  const email = argv.find((arg) => !arg.startsWith('--'));
  const ttlArg = argv.find((arg) => arg.startsWith('--ttl-hours='));
  const ttlHours = ttlArg ? Number(ttlArg.slice('--ttl-hours='.length)) : 24;
  if (!email || !Number.isFinite(ttlHours) || ttlHours < 1 || ttlHours > 72) {
    stderr.write(`${USAGE}\n`);
    return 1;
  }
  if (!db && !env.DATABASE_URL) {
    stderr.write('DATABASE_URL is required. Nothing was changed.\n');
    return 1;
  }
  // #166: nazwa bazy docelowej potwierdzona jawnie (adres i current_database()), zanim cokolwiek zostanie zapisane.
  let expectedDatabase;
  try {
    expectedDatabase = requireExpectedDatabase({ url: db ? undefined : env.DATABASE_URL, args: argv });
  } catch (error) {
    if (!(error instanceof DatabaseIdentityError)) throw error;
    stderr.write(`${error.message}\n`);
    return 1;
  }
  const database = db ?? createPgDatabase({ connectionString: env.DATABASE_URL, max: 1 });
  try {
    await assertConnectedDatabase(database, expectedDatabase);
    const result = await bootstrapAdmin(database, {
      email, appEnv: env.APP_ENV, allowProduction: argv.includes('--allow-production'), ttlSeconds: ttlHours * 3600,
    });
    stdout.write([
      'Admin invitation issued (one-time; this token is shown only once and is not stored).',
      `user id: ${result.userId}${result.userCreated ? ' (new account)' : ' (existing account)'}`,
      `invitation id: ${result.invitationId}`,
      `expires at: ${result.expiresAt}`,
      `token: ${result.secret}`,
      'Accept via /login/#invite=<token> (POST /api/invitations/accept), then set up MFA.',
      '',
    ].join('\n'));
    return 0;
  } catch (error) {
    if (error instanceof DatabaseIdentityError) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
    if (error instanceof BootstrapRefused) {
      const suffix = error.code === 'pending_admin_invitation' ? ` (${error.detail.expiresAt}).` : '';
      if (error.code === 'production_requires_flag') { const w = appEnvWarning(env.APP_ENV); if (w) stderr.write(`${w}\n`); }
      stderr.write(`${REFUSALS[error.code] ?? error.code}${suffix}\n`);
      return 2;
    }
    stderr.write(`Bootstrap failed (${typeof error?.code === 'string' ? error.code : 'error'}). Nothing was changed.\n`);
    return 1;
  } finally {
    if (!db) await database.close().catch(() => {});
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runBootstrapCli({ argv: process.argv.slice(2), env: process.env });
}
