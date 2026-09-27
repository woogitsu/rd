import { chmod, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import { createSnapshot, sourceReconciliation } from '../src/d1-postgres-migration.js';

const [dumpPath, outputPath] = process.argv.slice(2);
if (!dumpPath || !outputPath) {
  console.error('Usage: npm run db:snapshot:d1 -- <d1-export.sql> <private-snapshot.json>');
  process.exitCode = 1;
} else {
  try {
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    const SQL = await initSqlJs({ locateFile: () => wasmPath });
    const database = new SQL.Database();
    database.run(await readFile(dumpPath, 'utf8'));
    const snapshot = createSnapshot(database);
    database.close();
    await writeFile(outputPath, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(outputPath, 0o600);
    console.log(JSON.stringify(sourceReconciliation(snapshot.tables)));
  } catch (error) {
    console.error(`Snapshot creation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
