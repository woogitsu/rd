// Manifest kolejności i sum kontrolnych migracji PostgreSQL (issue #79):
// postgres/migrations/MANIFEST.json — {name, sha256} w kolejności, w jakiej
// zostały HISTORYCZNIE nałożone (numeracja plików ≠ kolejność scalania do
// main, patrz postgres/README.md). Wpisy istniejących plików NIE zmieniają
// pozycji przy regeneracji; nowe pliki na dysku (jeszcze nieobecne w
// manifeście) trafiają na koniec, w kolejności alfabetycznej nazw.
//
//   npm run migrations:manifest           # regeneruje/aktualizuje plik
//   npm run migrations:manifest -- --check  # 0 = aktualny, 1 = trzeba regenerować
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadMigrations } from '../src/postgres-migrations.js';

const migrationsDir = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));
const manifestPath = join(migrationsDir, 'MANIFEST.json');

export async function readManifestFile(path = manifestPath) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

// Buduje manifest zgodny z regułą opisaną wyżej: zachowuje kolejność
// istniejących wpisów, aktualizuje ich sumę kontrolną (żeby CI wykrył zmianę
// już scalonego pliku — patrz scripts/check-migrations-order.js), dopisuje
// nowe pliki na końcu i usuwa wpisy plików, których już nie ma na dysku.
export function buildManifest(existing, migrations) {
  const byName = new Map(migrations.map((m) => [m.name, m]));
  const seen = new Set();
  const next = [];
  for (const entry of existing) {
    const migration = byName.get(entry.name);
    if (!migration) continue; // plik usunięty z repozytorium — wpis odpada
    seen.add(entry.name);
    next.push({ name: migration.name, sha256: migration.checksum });
  }
  const newOnes = migrations.filter((m) => !seen.has(m.name)).sort((a, b) => a.name.localeCompare(b.name));
  for (const migration of newOnes) next.push({ name: migration.name, sha256: migration.checksum });
  return next;
}

export function manifestsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  const migrations = await loadMigrations(migrationsDir);
  const existing = await readManifestFile();
  const next = buildManifest(existing, migrations);
  if (manifestsEqual(existing, next)) {
    console.log(`postgres/migrations/MANIFEST.json is up to date (${next.length} entries).`);
    return;
  }
  if (checkOnly) {
    console.error('postgres/migrations/MANIFEST.json is out of date. Run: npm run migrations:manifest');
    process.exitCode = 1;
    return;
  }
  await writeFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Wrote postgres/migrations/MANIFEST.json (${next.length} entries).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
