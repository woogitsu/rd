// #123: spis danych osobowych (privacy/data-inventory.json) musi obejmować
// 100% kolumn tabel bazowych po nałożeniu migracji, a eksport roczny nie może
// wykraczać poza kolumny oznaczone jako `exportable: true`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestDb, ownerDb } from './helpers/pg.js';
import { EXPORT_TABLES } from '../src/pg/export.js';
import { loadInventory, renderReport } from '../scripts/privacy-report.js';

const inventoryPath = fileURLToPath(new URL('../privacy/data-inventory.json', import.meta.url));

async function baseTableColumns(db) {
  const { rows } = await db.query(`
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_name = c.table_name AND t.table_schema = c.table_schema
     WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
     ORDER BY c.table_name, c.ordinal_position
  `);
  return rows;
}

test('każda kolumna każdej tabeli bazowej ma wpis w spisie danych osobowych', async () => {
  const db = await createTestDb();
  try {
    const columns = await baseTableColumns(db);
    const inventory = loadInventory();
    const missing = [];
    for (const { table_name: table, column_name: column } of columns) {
      if (!inventory[table]?.[column]) missing.push(`${table}.${column}`);
    }
    assert.deepEqual(missing, [], `Brakuje wpisu w privacy/data-inventory.json dla: ${missing.join(', ')}`);
  } finally {
    await db.close();
  }
});

test('spis nie zawiera kolumn, których już nie ma w schemacie (bez martwych wpisów)', async () => {
  const db = await createTestDb();
  try {
    const columns = await baseTableColumns(db);
    const present = new Set(columns.map(r => `${r.table_name}.${r.column_name}`));
    const inventory = loadInventory();
    const stale = [];
    for (const table of Object.keys(inventory)) {
      for (const column of Object.keys(inventory[table])) {
        if (!present.has(`${table}.${column}`)) stale.push(`${table}.${column}`);
      }
    }
    assert.deepEqual(stale, [], `Wpisy w spisie bez odpowiadającej kolumny w schemacie: ${stale.join(', ')}`);
  } finally {
    await db.close();
  }
});

test('sztuczna migracja dodająca kolumnę bez wpisu w spisie jest wykrywana (czerwony test)', async () => {
  const db = await createTestDb();
  try {
    // Sztuczna migracja = DDL: połączenie właściciela (SR-05); spis kolumn czyta rola aplikacji.
    await ownerDb(db).exec('ALTER TABLE guardians ADD COLUMN phone text');
    const columns = await baseTableColumns(db);
    const inventory = loadInventory();
    const missing = columns
      .filter(({ table_name: t, column_name: c }) => !inventory[t]?.[c])
      .map(({ table_name: t, column_name: c }) => `${t}.${c}`);
    assert.deepEqual(missing, ['guardians.phone']);
  } finally {
    await db.close();
  }
});

test('kolumny eksportowane w src/pg/export.js są podzbiorem kolumn oznaczonych jako exportable', async () => {
  const inventory = loadInventory();
  const db = await createTestDb();
  try {
    const columns = await baseTableColumns(db);
    const columnsByTable = new Map();
    for (const { table_name: t, column_name: c } of columns) {
      if (!columnsByTable.has(t)) columnsByTable.set(t, []);
      columnsByTable.get(t).push(c);
    }
    const violations = [];
    for (const spec of EXPORT_TABLES) {
      const exportedColumns = spec.columns ?? columnsByTable.get(spec.table) ?? [];
      for (const column of exportedColumns) {
        const entry = inventory[spec.table]?.[column];
        if (!entry) { violations.push(`${spec.table}.${column}: brak wpisu w spisie`); continue; }
        if (!entry.exportable) violations.push(`${spec.table}.${column}: eksportowana, ale exportable=false w spisie`);
      }
    }
    assert.deepEqual(violations, []);
  } finally {
    await db.close();
  }
});

test('każda kolumna free_text z danymi osobowymi ma wpis ryzyka w DPIA_CHECKLIST.md', () => {
  const inventory = loadInventory();
  const checklist = readFileSync(fileURLToPath(new URL('../docs/DPIA_CHECKLIST.md', import.meta.url)), 'utf8');
  const missing = [];
  for (const table of Object.keys(inventory)) {
    for (const [column, entry] of Object.entries(inventory[table])) {
      if (entry.free_text && entry.personal !== 'none' && !checklist.includes(`${table}.${column}`)) {
        missing.push(`${table}.${column}`);
      }
    }
  }
  assert.deepEqual(missing, [], `Brak wpisu ryzyka w DPIA_CHECKLIST.md dla: ${missing.join(', ')}`);
});

test('docs/PRIVACY_INVENTORY.md jest aktualny względem privacy/data-inventory.json', () => {
  const inventory = loadInventory();
  const rendered = renderReport(inventory);
  const current = readFileSync(fileURLToPath(new URL('../docs/PRIVACY_INVENTORY.md', import.meta.url)), 'utf8');
  assert.equal(current, rendered, 'Uruchom: node scripts/privacy-report.js');
});
