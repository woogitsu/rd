// #152: meta-test — każde pole free_text (z danymi osobowymi) w tabeli
// niezmiennej ma bramkę danych osobowych (src/pg/pii-gate.js) albo jawne,
// uzasadnione wyłączenie. Źródło prawdy o polach: privacy/data-inventory.json;
// niezmienność tabeli wynika ze schematu (wyzwalacz BEFORE UPDATE/DELETE).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createTestDb } from './helpers/pg.js';
import { loadInventory } from '../scripts/privacy-report.js';
import { EXEMPT_FIELDS, GATED_FIELDS } from '../src/pg/pii-gate.js';

const srcRoot = fileURLToPath(new URL('../src/pg/', import.meta.url));

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.js') ? [full] : [];
  });
}

// Tabele z wyzwalaczem blokującym zmianę lub usunięcie wierszy (BEFORE UPDATE
// albo BEFORE DELETE): zapisu wolnego tekstu nie da się w nich potem cofnąć.
async function protectedTables(db) {
  const { rows } = await db.query(`
    SELECT DISTINCT c.relname AS table_name
      FROM pg_trigger tg
      JOIN pg_class c ON c.oid = tg.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT tg.tgisinternal
       AND (tg.tgtype & 2) = 2 AND ((tg.tgtype & 8) = 8 OR (tg.tgtype & 16) = 16)
  `);
  return new Set(rows.map((row) => row.table_name));
}

function freeTextFields(inventory) {
  const fields = [];
  for (const [table, columns] of Object.entries(inventory)) {
    for (const [column, entry] of Object.entries(columns)) {
      if (entry.free_text && entry.personal !== 'none') fields.push(`${table}.${column}`);
    }
  }
  return fields;
}

test('każde pole free_text z tabeli niezmiennej ma bramkę albo uzasadnione wyłączenie', async () => {
  const db = await createTestDb();
  try {
    const protectedSet = await protectedTables(db);
    const missing = freeTextFields(loadInventory())
      .filter((key) => protectedSet.has(key.split('.')[0]))
      .filter((key) => !GATED_FIELDS.includes(key) && !(key in EXEMPT_FIELDS));
    assert.deepEqual(missing, [], `Brak bramki (src/pg/pii-gate.js) dla pól wolnego tekstu: ${missing.join(', ')}`);
  } finally {
    await db.close();
  }
});

test('każde pole z GATED_FIELDS i EXEMPT_FIELDS istnieje w spisie jako free_text', () => {
  const inventory = loadInventory();
  for (const key of [...GATED_FIELDS, ...Object.keys(EXEMPT_FIELDS)]) {
    const [table, column] = key.split('.');
    assert.ok(inventory[table]?.[column]?.free_text === true, `${key}: brak w spisie albo bez free_text`);
  }
});

test('każde pole z GATED_FIELDS jest faktycznie użyte w wywołaniu bramki w kodzie serwera', () => {
  const files = sourceFiles(srcRoot).filter((file) => !file.endsWith('pii-gate.js') && !file.endsWith('pii-check.js'));
  const sources = files.map((file) => readFileSync(file, 'utf8'));
  const unused = GATED_FIELDS.filter((key) => !sources.some((source) => (
    new RegExp(`(?:gateFreeText|gatePii)\\([\\s\\S]{0,400}?'${key.replace('.', '\\.')}'`).test(source)
  )));
  assert.deepEqual(unused, [], `Pola w GATED_FIELDS bez wywołania bramki: ${unused.join(', ')}`);
});

test('wywołania bramki (gateFreeText/gatePii) używają wyłącznie pól z rejestru', () => {
  const known = new Set(GATED_FIELDS);
  const unknown = [];
  for (const file of sourceFiles(srcRoot)) {
    if (file.endsWith('pii-gate.js')) continue;
    const source = readFileSync(file, 'utf8');
    for (const call of source.matchAll(/(?:gateFreeText|gatePii)\(\[([\s\S]*?)\],\s/g)) {
      for (const key of call[1].matchAll(/\['([a-z_]+\.[a-z_]+)'/g)) {
        if (!known.has(key[1])) unknown.push(`${path.basename(file)}: ${key[1]}`);
      }
    }
  }
  assert.deepEqual(unknown, []);
});

test('meta-test wykrywa pole free_text bez bramki (czerwony test)', () => {
  // Symulacja: nowe pole w spisie bez wpisu w rejestrze byłoby zgłoszone.
  const inventory = structuredClone(loadInventory());
  inventory.payment_corrections.nowe_pole = { personal: 'direct', free_text: true };
  const missing = freeTextFields(inventory).filter((key) => !GATED_FIELDS.includes(key) && !(key in EXEMPT_FIELDS));
  assert.deepEqual(missing, ['payment_corrections.nowe_pole']);
});
