import { migrationDatabaseUrl } from '../src/migration-url.js';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { appEnvWarning, guardDangerousOperation } from '../src/app-env.js';
import { assertConnectedDatabase, requireExpectedDatabase } from '../src/database-identity.js';
import { checkSnapshot, eventTimeSummary, normalizeSnapshot, restoreSnapshot, SNAPSHOT_TABLES, verifySnapshot } from '../src/d1-postgres-migration.js';

const args = process.argv.slice(2);
const snapshotPath = args.find((arg) => !arg.startsWith('--'));
const apply = args.includes('--apply');
const check = args.includes('--check');
// #183: godziny wydarzeń z D1 nie mają strefy; narzędzie jej nie zgaduje.
// #191: osoba prowadząca import (odtworzony administrator) trafia do zdarzenia migration.d1_import.
const actorArgs = args.filter((arg) => arg.startsWith('--actor='));
const actorId = actorArgs.length === 1 ? actorArgs[0].slice('--actor='.length) : undefined;
const zoneArgs = args.filter((arg) => /^--event(-local)?-time-zone=/.test(arg));
const eventTimeZone = zoneArgs.length === 1 ? zoneArgs[0].split('=')[1] : undefined;

if (!snapshotPath) {
  console.error('Usage: npm run db:restore:postgres -- <private-snapshot.json> [--check | --apply] --actor=<userId> --expect-database=<database name> [--allow-production] [--event-local-time-zone=Europe/Brussels | --event-time-zone=UTC]');
  process.exitCode = 1;
} else {
  try {
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
    if (actorArgs.length > 1) throw new Error('Specify only one --actor option');
    if (zoneArgs.length > 1) throw new Error('Specify only one event time zone option');
    verifySnapshot(snapshot);
    if (check && apply) throw new Error('--check and --apply are mutually exclusive');
    if (check) {
      // #179: bez bazy; wszystkie naruszenia naraz (tabela, id wiersza, reguła), bez wartości.
      const result = checkSnapshot(snapshot, { eventTimeZone });
      console.log(JSON.stringify({ ok: result.ok, violations: result.violations, otherError: result.otherError }, null, 2));
      if (!result.ok) process.exitCode = 1;
    } else {
    normalizeSnapshot(snapshot, { eventTimeZone }); // walidacja także w próbie bez bazy
    const timeSummary = eventTimeSummary(snapshot, eventTimeZone);
    const sourceCount = SNAPSHOT_TABLES.reduce((sum, table) => sum + snapshot.tables[table].length, 0);
    if (!apply) {
      console.log(`Snapshot verified (${sourceCount} rows). Dry run only; database was not contacted. Event times: ${JSON.stringify(timeSummary)}`);
    } else if (!migrationDatabaseUrl()) {
      throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL is required with --apply');
    } else if (guardDangerousOperation(process.env.APP_ENV, { allowProduction: args.includes('--allow-production') }).refused) {
      const warning = appEnvWarning(process.env.APP_ENV);
      if (warning) console.error(warning);
      throw new Error('Production (or unrecognised APP_ENV) restore requires explicit --allow-production');
    } else if (!actorId) {
      throw new Error('--actor=<userId> (restored admin conducting the import) is required with --apply');
    } else {
      // #166, #191: nazwa bazy docelowej potwierdzona jawnie, zanim cokolwiek zostanie zapisane.
      const expectedDatabase = requireExpectedDatabase({ url: migrationDatabaseUrl(), args });
      const client = new Client({ connectionString: migrationDatabaseUrl() });
      try {
        await client.connect();
        await assertConnectedDatabase(client, expectedDatabase);
        const report = await restoreSnapshot(client, snapshot, { eventTimeZone, actorId });
        console.log(JSON.stringify({ ...report, eventTimes: timeSummary }));
      } finally {
        await client.end().catch(() => {});
      }
    }
    }
  } catch (error) {
    console.error(`Restore failed: ${error.message}`);
    process.exitCode = 1;
  }
}
