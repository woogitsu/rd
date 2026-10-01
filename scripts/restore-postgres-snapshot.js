import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { appEnvWarning, guardDangerousOperation } from '../src/app-env.js';
import { eventTimeSummary, normalizeSnapshot, restoreSnapshot, SNAPSHOT_TABLES, verifySnapshot } from '../src/d1-postgres-migration.js';

const args = process.argv.slice(2);
const snapshotPath = args.find((arg) => !arg.startsWith('--'));
const apply = args.includes('--apply');
// #183: godziny wydarzeń z D1 nie mają strefy; narzędzie jej nie zgaduje.
const zoneArgs = args.filter((arg) => /^--event(-local)?-time-zone=/.test(arg));
const eventTimeZone = zoneArgs.length === 1 ? zoneArgs[0].split('=')[1] : undefined;

if (!snapshotPath) {
  console.error('Usage: npm run db:restore:postgres -- <private-snapshot.json> [--apply] [--allow-production] [--event-local-time-zone=Europe/Brussels | --event-time-zone=UTC]');
  process.exitCode = 1;
} else {
  try {
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
    if (zoneArgs.length > 1) throw new Error('Specify only one event time zone option');
    verifySnapshot(snapshot);
    normalizeSnapshot(snapshot, { eventTimeZone }); // walidacja także w próbie bez bazy
    const timeSummary = eventTimeSummary(snapshot, eventTimeZone);
    const sourceCount = SNAPSHOT_TABLES.reduce((sum, table) => sum + snapshot.tables[table].length, 0);
    if (!apply) {
      console.log(`Snapshot verified (${sourceCount} rows). Dry run only; database was not contacted. Event times: ${JSON.stringify(timeSummary)}`);
    } else if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required with --apply');
    } else if (guardDangerousOperation(process.env.APP_ENV, { allowProduction: args.includes('--allow-production') }).refused) {
      const warning = appEnvWarning(process.env.APP_ENV);
      if (warning) console.error(warning);
      throw new Error('Production (or unrecognised APP_ENV) restore requires explicit --allow-production');
    } else {
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      try {
        await client.connect();
        const report = await restoreSnapshot(client, snapshot, { eventTimeZone });
        console.log(JSON.stringify({ ...report, eventTimes: timeSummary }));
      } finally {
        await client.end().catch(() => {});
      }
    }
  } catch (error) {
    console.error(`Restore failed: ${error.message}`);
    process.exitCode = 1;
  }
}
