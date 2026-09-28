// Wykrywa redefinicje funkcji triggerów gubiące gałęzie innych migracji (#79).
//
// `CREATE OR REPLACE FUNCTION` NIE łączy definicji przyrostowo — zastępuje
// całe ciało funkcji. Gdy dwie migracje pisane równolegle (numeracja plików
// ≠ kolejność scalania do main — patrz postgres/README.md) redefiniują tę
// samą funkcję dyspozytora opartą o TG_TABLE_NAME (np. year_freeze_via_parent),
// późniejsza wersja może po cichu zgubić gałąź (tabelę) dodaną przez
// wcześniejszą. Dokładnie tak zepsuło się main: 0038 nadpisało 0036 (naprawa
// w #279 — 0049_year_freeze_union.sql, suma obu gałęzi).
//
// Migrator (src/postgres-migrations.js) zawsze nakłada pliki w rosnącej
// kolejności numeru nazwy (loadMigrations() sortuje alfabetycznie == numeru
// prefiksu) — to jedyna kolejność, w jakiej ŚWIEŻA baza kiedykolwiek widzi te
// definicje. Dlatego kontrola porównuje OSTATNIĄ (najwyższy numer) definicję
// danej funkcji z SUMĄ tabel obsłużonych przez WSZYSTKIE jej wcześniejsze
// definicje — jeśli ostatnia wersja nie obejmuje którejś z nich, to błąd.
// (Ręczne `--allow-out-of-order` na już istniejącej bazie to osobny,
// świadomy wyjątek operacyjny — poza zakresem tej statycznej kontroli.)
//
//   node scripts/check-function-redefinitions.js [--cwd <repo>]
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadMigrations } from '../src/postgres-migrations.js';

const FUNCTION_PATTERN = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+([a-z0-9_]+)\s*\([^)]*\)[^$]*?\$\$([\s\S]*?)\$\$\s*;/gi;
// TG_TABLE_NAME IN ('a', 'b') albo TG_TABLE_NAME = 'a' (spacje/wielkość liter dowolne).
const TABLE_NAME_PATTERN = /TG_TABLE_NAME\s*(?:IN\s*\(([^)]*)\)|=\s*'([a-z0-9_]+)')/gi;

function extractTableNames(body) {
  const tables = new Set();
  let match;
  TABLE_NAME_PATTERN.lastIndex = 0;
  while ((match = TABLE_NAME_PATTERN.exec(body))) {
    if (match[1]) {
      for (const raw of match[1].split(',')) {
        const name = raw.trim().replace(/^'(.*)'$/, '$1');
        if (name) tables.add(name);
      }
    } else if (match[2]) {
      tables.add(match[2]);
    }
  }
  return tables;
}

/**
 * @param {Array<{name:string, sql:string}>} migrations w kolejności NAKŁADANIA
 *   na świeżą bazę — czyli rosnącej kolejności numeru nazwy pliku
 *   (loadMigrations() już tak sortuje; przy własnej liście zachowaj ten sam porządek).
 * @returns {string[]} opisy naruszeń (pusta lista = OK)
 */
export function checkFunctionRedefinitions(migrations) {
  // functionName -> { lastTables: Set, lastMigration: string, sources: Map<table, migrationName z pierwszym wystąpieniem> }
  const state = new Map();
  for (const migration of migrations) {
    FUNCTION_PATTERN.lastIndex = 0;
    let match;
    while ((match = FUNCTION_PATTERN.exec(migration.sql))) {
      const [, name, body] = match;
      const tables = extractTableNames(body);
      if (tables.size === 0) continue; // nie jest funkcją-dyspozytorem po TG_TABLE_NAME
      const entry = state.get(name) ?? { lastTables: new Set(), lastMigration: migration.name, sources: new Map() };
      for (const table of tables) {
        if (!entry.sources.has(table)) entry.sources.set(table, migration.name);
      }
      entry.lastTables = tables;
      entry.lastMigration = migration.name;
      state.set(name, entry);
    }
  }
  const problems = [];
  for (const [name, entry] of state) {
    const missing = [...entry.sources.keys()].filter((table) => !entry.lastTables.has(table));
    if (!missing.length) continue;
    const bySource = missing.map((table) => `${table} (z ${entry.sources.get(table)})`).join(', ');
    problems.push(
      `${name}(): ostatnia definicja (${entry.lastMigration}) gubi gałęzie wcześniejszych migracji: ${bySource}. `
      + 'CREATE OR REPLACE FUNCTION nie łączy definicji — nowa wersja musi zawierać SUMĘ gałęzi wszystkich migracji, które ją redefiniują '
      + '(wzorem postgres/migrations/0049_year_freeze_union.sql).',
    );
  }
  return problems;
}

export async function runCheck({ cwd = process.cwd() } = {}) {
  const migrationsDir = join(cwd, 'postgres/migrations/');
  const migrations = await loadMigrations(migrationsDir);
  return checkFunctionRedefinitions(migrations);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = await runCheck();
  if (problems.length) {
    console.error('Function redefinition check failed:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log('Function redefinition check passed: no dispatch function lost a branch.');
  }
}
