import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { restoreSnapshot, SNAPSHOT_TABLES, verifySnapshot } from '../src/d1-postgres-migration.js';

const args = process.argv.slice(2);
const snapshotPath = args.find((arg) => !arg.startsWith('--'));
const apply = args.includes('--apply');

if (!snapshotPath) {
  console.error('Usage: npm run db:restore:postgres -- <private-snapshot.json> [--apply] [--allow-production]');
  process.exitCode = 1;
} else {
  try {
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
    verifySnapshot(snapshot);
    const sourceCount = SNAPSHOT_TABLES.reduce((sum, table) => sum + snapshot.tables[table].length, 0);
    if (!apply) {
      console.log(`Snapshot verified (${sourceCount} rows). Dry run only; database was not contacted.`);
    } else if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required with --apply');
    } else if (process.env.APP_ENV === 'production' && !args.includes('--allow-production')) {
      throw new Error('Production restore requires explicit --allow-production');
    } else {
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      try {
        await client.connect();
        const report = await restoreSnapshot(client, snapshot);
        console.log(JSON.stringify(report));
      } finally {
        await client.end().catch(() => {});
      }
    }
  } catch (error) {
    console.error(`Restore failed: ${error.message}`);
    process.exitCode = 1;
  }
}
