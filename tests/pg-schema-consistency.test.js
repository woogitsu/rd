// #198: ograniczenia spójności schematu, część 1 (role_grants/invitations/
// export_runs — klasa musi należeć do roku; users/invitations.email —
// jedno konto na adres niezależnie od wielkości liter). Dane wyłącznie
// syntetyczne (@example.invalid).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedClass, seedSchoolYear, seedUser } from './helpers/pg.js';

async function setup() {
  const db = await createTestDb();
  await seedClass(db, { id: 'c-2025', schoolYearId: 'y-2025' });
  await seedClass(db, { id: 'c-2026', schoolYearId: 'y-2026' });
  await seedUser(db, { userId: 'u1' });
  return db;
}

test('role_grants: przydział klasy z innego roku niż school_year_id jest odrzucony na poziomie bazy', async () => {
  const db = await setup();
  // Trigger role_grant_year_freeze (0022, a0_year_freeze) już odrzuca to
  // przy INSERT; FK złożone (0081) jest dodatkową gwarancją niezależną od
  // triggera. Sprawdzamy tylko wynik — próba jest odrzucona.
  await assert.rejects(
    db.query(
      `INSERT INTO role_grants (id, user_id, role, class_id, school_year_id)
       VALUES ('rg-bad', 'u1', 'representative', 'c-2025', 'y-2026')`,
    ),
  );
  await db.close();
});

test('role_grants: klasa nieznana i school_year_id NULL jest odrzucona (CHECK role_grant_class_requires_year)', async () => {
  const db = await setup();
  // Klasa istniejąca ma rok uzupełniany automatycznie przez trigger
  // (role_grant_year_freeze, #201/0022), więc żeby dotrzeć do CHECK
  // (class_id wymaga school_year_id) potrzeba class_id, którego trigger nie
  // rozpozna (żadna klasa o tym id) — wtedy NEW.school_year_id zostaje NULL.
  await assert.rejects(
    db.query(
      `INSERT INTO role_grants (id, user_id, role, class_id, school_year_id)
       VALUES ('rg-null', 'u1', 'representative', 'c-brak-takiej-klasy', NULL)`,
    ),
  );
  await db.close();
});

test('invitations: zaproszenie do klasy z innego roku jest odrzucone na poziomie bazy', async () => {
  const db = await setup();
  await assert.rejects(
    db.query(
      `INSERT INTO invitations (id, email, token_hash, role, class_id, school_year_id, created_by, expires_at)
       VALUES ('inv-bad', 'rep@example.invalid', repeat('a', 64), 'representative', 'c-2025', 'y-2026', 'u1', now() + interval '1 day')`,
    ),
  );
  await db.close();
});

test('export_runs: eksport listy klasy z klasą spoza roku eksportu jest odrzucony', async () => {
  const db = await setup();
  await assert.rejects(
    db.query(
      `INSERT INTO export_runs (id, kind, school_year_id, class_id, format_version, requested_by, manifest_sha256, row_counts)
       VALUES ('exp-bad', 'class_roster', 'y-2026', 'c-2025', 1, 'u1', repeat('a', 64), '{}'::jsonb)`,
    ),
  );
  await db.close();
});

test('users.email: dwa konta różniące się tylko wielkością liter są odrzucone', async () => {
  const db = await setup();
  await assert.rejects(
    db.query(`INSERT INTO users (id, email, display_name) VALUES ('u2', 'U1@example.invalid', 'Duplikat')`),
  );
  await db.close();
});

test('users.email: zapis w innej postaci niż lower(btrim()) jest odrzucony przez CHECK', async () => {
  const db = await setup();
  await assert.rejects(
    db.query(`INSERT INTO users (id, email, display_name) VALUES ('u3', ' U3@Example.invalid ', 'Zła postać')`),
  );
  await db.close();
});

test('invitations.email: zapis w innej postaci niż lower(btrim()) jest odrzucony przez CHECK', async () => {
  const db = await setup();
  await assert.rejects(
    db.query(
      `INSERT INTO invitations (id, email, token_hash, role, created_by, expires_at)
       VALUES ('inv-bad-email', 'REP@example.invalid', repeat('b', 64), 'board', 'u1', now() + interval '1 day')`,
    ),
  );
  await db.close();
});

// Lint schematu: każda para kolumn class_id + school_year_id w jednej tabeli
// musi mieć złożony FK (class_id, school_year_id) -> classes(id, school_year_id).
// Nowa tabela z tymi dwiema kolumnami bez takiego klucza psuje ten test —
// to jest zamierzone (#198, kryterium 4).
test('lint schematu: każda tabela z class_id + school_year_id ma złożony FK do classes', async () => {
  const db = await createTestDb();
  try {
    const { rows: candidates } = await db.query(`
      SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'class_id' AND NOT a.attisdropped)
         AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'school_year_id' AND NOT a.attisdropped)
         AND c.relname <> 'classes'
    `);
    const { rows: guarded } = await db.query(`
      SELECT DISTINCT conrelid::regclass::text AS table_name
        FROM pg_constraint pc
       WHERE contype = 'f' AND confrelid = 'classes'::regclass
         AND (SELECT array_agg(k ORDER BY k) FROM unnest(pc.conkey) k) = (
           SELECT array_agg(attnum ORDER BY attnum) FROM pg_attribute
            WHERE attrelid = pc.conrelid AND attname IN ('class_id', 'school_year_id') AND NOT attisdropped
         )
    `);
    const guardedNames = new Set(guarded.map((row) => row.table_name));
    const missing = candidates.map((row) => row.table_name).filter((name) => !guardedNames.has(name));
    assert.deepEqual(missing, [], `Tabele z class_id+school_year_id bez złożonego FK do classes: ${missing.join(', ')}`);
  } finally {
    await db.close();
  }
});
