// Zgodność odtworzenia D1 -> PostgreSQL (#47) z aktualnymi migracjami PostgreSQL
// (0004 audyt tylko do dopisywania i strażnik role_grants, 0008 wydarzenia, 0009 zebrania).
// Snapshot powstaje tak jak w scripts/create-d1-snapshot.js: sql.js + migracje D1 + createSnapshot.
// Wyłącznie dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import {
  createSnapshot, reconciliationReport, restoreSnapshot, snapshotChecksum, sourceReconciliation, SNAPSHOT_TABLES,
} from '../src/d1-postgres-migration.js';
import { handlePgRequest } from '../src/pg/app.js';
import { revokeRoleGrant } from '../src/pg/authorization.js';
import { createTestDb, request, seedUserSession } from './helpers/pg.js';

const require = createRequire(import.meta.url);
const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
const legacyDir = new URL('../migrations/', import.meta.url);
const pgMigrations = readdirSync(new URL('../postgres/migrations/', import.meta.url)).filter((n) => n.endsWith('.sql')).sort();

// D1 w stanie po wszystkich migracjach D1, z danymi pokrywającymi każdą tabelę snapshotu:
// rodzeństwo, dwie osoby opiekujące się jednym dzieckiem, wpłaty częściowe, korekty,
// przypisanie nierozpoznanej wpłaty, role (także wygasłe), wydarzenia każdej widoczności.
function legacyD1() {
  const db = new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');
  for (const name of readdirSync(legacyDir).filter((n) => n.endsWith('.sql')).sort()) {
    db.run(readFileSync(new URL(name, legacyDir), 'utf8'));
  }
  db.run(`
    INSERT INTO school_years (id, label, starts_on, ends_on) VALUES
      ('y-2025', '2025/26', '2025-09-01', '2026-08-31'), ('y-2026', '2026/27', '2026-09-01', '2027-08-31');
    INSERT INTO classes (id, school_year_id, name) VALUES ('c-1a', 'y-2026', '1A'), ('c-2a', 'y-2026', '2A'), ('c-old', 'y-2025', '1A');
    INSERT INTO households (id, created_at) VALUES ('h-1', '2026-09-01 10:00:00'), ('h-2', '2026-09-01 10:00:00'), ('h-3', '2026-09-01 10:00:00');
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
      ('g-1', 'h-1', 'Anna', 'Testowa', 'anna@example.invalid', 1),
      ('g-2', 'h-1', 'Piotr', 'Testowy', NULL, 0),
      ('g-3', 'h-2', 'Ewa', 'Przykładowa', 'ewa@example.invalid', 1);
    INSERT INTO students (id, household_id, first_name, last_name) VALUES
      ('st-1', 'h-1', 'Jan', 'Testowy'), ('st-2', 'h-1', 'Ola', 'Testowa'), ('st-3', 'h-2', 'Kuba', 'Przykładowy');
    INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact, starts_on, ends_on, created_at) VALUES
      ('st-1', 'g-1', 1, 1, NULL, NULL, '2026-09-01 10:00:00'), ('st-1', 'g-2', 0, 0, '2026-09-01', NULL, '2026-09-01 10:00:00'),
      ('st-2', 'g-1', 1, 1, NULL, NULL, '2026-09-01 10:00:00'), ('st-3', 'g-3', 1, 1, NULL, '2027-06-30', '2026-09-01 10:00:00');
    INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
      ('e-1', 'st-1', 'c-1a', 'y-2026'), ('e-2', 'st-2', 'c-2a', 'y-2026'), ('e-3', 'st-3', 'c-1a', 'y-2026'), ('e-old', 'st-1', 'c-old', 'y-2025');
    INSERT INTO users (id, email, display_name, disabled_at, created_at) VALUES
      ('u-admin', 'admin@example.invalid', 'Test Admin', NULL, '2026-09-01 08:00:00'),
      ('u-treasurer', 'treasurer@example.invalid', 'Test Skarbnik', NULL, '2026-09-01 08:00:00'),
      ('u-rep', 'rep@example.invalid', 'Test Przedstawiciel', NULL, '2026-09-01 08:00:00'),
      ('u-off', 'off@example.invalid', 'Test Wyłączony', '2026-09-10 08:00:00', '2026-09-01 08:00:00');
    INSERT INTO role_grants (id, user_id, role, class_id, school_year_id, expires_at) VALUES
      ('rg-admin', 'u-admin', 'admin', NULL, NULL, NULL),
      ('rg-treasurer', 'u-treasurer', 'treasurer', NULL, 'y-2026', NULL),
      ('rg-rep', 'u-rep', 'representative', 'c-1a', 'y-2026', '2099-08-31 00:00:00'),
      ('rg-rep-old', 'u-rep', 'representative', 'c-old', 'y-2025', '2026-08-31 00:00:00'),
      ('rg-off', 'u-off', 'board', NULL, NULL, NULL);
    INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by, created_at) VALUES
      ('doc-1', 'private/synthetic/receipt-1.pdf', 'application/pdf', 12345, 'receipt', 'u-treasurer', '2026-09-15 12:00:00');
    INSERT INTO events (id, school_year_id, title, begins_at, description, visibility, published_at, created_by) VALUES
      ('ev-internal', 'y-2026', 'Zebranie zarządu', '2026-10-05 17:00:00', NULL, 'internal', NULL, 'u-admin'),
      ('ev-draft', 'y-2026', 'Kiermasz (szkic)', '2026-11-20T09:00:00Z', 'Opis roboczy', 'draft_public', NULL, 'u-admin'),
      ('ev-published', 'y-2026', 'Zebranie ogólne Rady', '2026-10-12 18:00:00', 'Sala 1', 'published', '2026-09-20 10:00:00', 'u-admin'),
      ('ev-published-no-date', 'y-2026', 'Dzień otwarty', '2026-12-01 10:00:00', NULL, 'published', NULL, 'u-admin');
    INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, reference, status, created_by, created_at, idempotency_key) VALUES
      ('p-1', 'h-1', 'y-2026', 3000, '2026-09-20', 'bank', 'synthetic-ref-1', 'recorded', 'u-treasurer', '2026-09-20 10:00:00', 'legacy-key-p1'),
      ('p-2', 'h-1', 'y-2026', 2000, '2026-10-01', 'cash', NULL, 'recorded', 'u-treasurer', '2026-10-01 10:00:00', 'legacy-key-p2'),
      ('p-3', 'h-2', 'y-2026', 5000, '2026-09-21', 'bank', NULL, 'recorded', 'u-treasurer', '2026-09-21 10:00:00', 'legacy-key-p3'),
      ('p-4', NULL, 'y-2026', 1500, '2026-09-22', 'bank', 'unknown sender', 'unmatched', 'u-treasurer', '2026-09-22 10:00:00', 'legacy-key-p4'),
      ('p-5', NULL, 'y-2026', 2500, '2026-09-23', 'bank', NULL, 'unmatched', 'u-treasurer', '2026-09-23 10:00:00', 'legacy-key-p5'),
      ('p-old', 'h-3', 'y-2025', 4000, '2025-10-01', 'other', NULL, 'recorded', 'u-treasurer', '2025-10-01 10:00:00', 'legacy-key-pold');
    INSERT INTO payment_assignments (id, payment_entry_id, household_id, created_by, created_at, idempotency_key) VALUES
      ('pa-5', 'p-5', 'h-3', 'u-treasurer', '2026-09-24 10:00:00', 'assign-key-5');
    UPDATE payment_entries SET status = 'recorded', household_id = 'h-3' WHERE id = 'p-5';
    INSERT INTO payment_corrections (id, payment_entry_id, amount_cents, reason, created_by, created_at, idempotency_key) VALUES
      ('pc-1', 'p-3', 1000, 'Błędna kwota w wyciągu', 'u-treasurer', '2026-09-25 10:00:00', 'corr-key-1'),
      ('pc-2', 'p-3', 500, 'Druga korekta częściowa', 'u-treasurer', '2026-09-26 10:00:00', 'corr-key-2');
    INSERT INTO ledger_categories (id, school_year_id, direction, name, active, created_by, created_at) VALUES
      ('cat-in', 'y-2026', 'income', 'Dobrowolne wpłaty', 1, 'u-treasurer', '2026-09-01 09:00:00'),
      ('cat-out', 'y-2026', 'expense', 'Materiały', 1, 'u-treasurer', '2026-09-01 09:00:00'),
      ('cat-in-old', 'y-2025', 'income', 'Dobrowolne wpłaty', 1, 'u-treasurer', '2025-09-01 09:00:00');
    INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category, description, occurred_on, payment_entry_id, source_document_id, created_by, created_at, method, source, resolution_reference, idempotency_key) VALUES
      ('le-1', 'y-2026', 'income', 3000, 'cat-in', 'Wpłata dobrowolna', '2026-09-20', 'p-1', NULL, 'u-treasurer', '2026-09-20 11:00:00', 'bank', 'payment', NULL, 'ledger-key-1'),
      ('le-2', 'y-2026', 'expense', 1200, 'cat-out', 'Papier i tusz', '2026-09-28', NULL, 'doc-1', 'u-treasurer', '2026-09-28 11:00:00', 'card', NULL, NULL, 'ledger-key-2'),
      ('le-3', 'y-2026', 'expense', 350000, 'cat-out', 'Wyjazd klasowy', '2026-10-02', NULL, NULL, 'u-treasurer', '2026-10-02 11:00:00', 'bank', NULL, 'Uchwała 3/2026', 'ledger-key-3'),
      ('le-old', 'y-2025', 'income', 4000, 'cat-in-old', 'Wpłata dobrowolna', '2025-10-01', 'p-old', NULL, 'u-treasurer', '2025-10-01 11:00:00', 'other', NULL, NULL, 'ledger-key-old');
    INSERT INTO ledger_corrections (id, ledger_entry_id, amount_cents, reason, created_by, created_at, idempotency_key) VALUES
      ('lc-1', 'le-2', 200, 'Zwrot części kosztów', 'u-treasurer', '2026-09-29 11:00:00', 'lcorr-key-1');
    INSERT INTO ledger_opening_balances (id, school_year_id, amount_cents, source_document_id, note, created_by, created_at, idempotency_key) VALUES
      ('ob-2026', 'y-2026', 150000, 'doc-1', 'Saldo z protokołu', 'u-treasurer', '2026-09-01 12:00:00', 'opening-key-2026');
    INSERT INTO ledger_opening_balance_adjustments (id, opening_balance_id, amount_cents, reason, created_by, created_at, idempotency_key) VALUES
      ('oba-1', 'ob-2026', -500, 'Korekta salda otwarcia', 'u-treasurer', '2026-09-02 12:00:00', 'opening-adj-1');
    INSERT INTO ledger_budget_lines (id, school_year_id, category_id, planned_cents, note, supersedes_id, created_by, created_at, idempotency_key) VALUES
      ('bl-1', 'y-2026', 'cat-out', 100000, NULL, NULL, 'u-treasurer', '2026-09-01 12:00:00', 'budget-key-1'),
      ('bl-2', 'y-2026', 'cat-out', 120000, 'Zmiana po zebraniu', 'bl-1', 'u-treasurer', '2026-09-10 12:00:00', 'budget-key-2'),
      ('bl-3', 'y-2026', 'cat-out', 110000, NULL, 'bl-2', 'u-treasurer', '2026-09-12 12:00:00', 'budget-key-3');
    INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, occurred_at, metadata_json) VALUES
      ('ae-1', 'u-treasurer', 'payment.created', 'payment_entry', 'p-1', '2026-09-20 10:00:00', '{}'),
      ('ae-2', 'u-treasurer', 'payment.assigned', 'payment_entry', 'p-5', '2026-09-24 10:00:00', '{"assignmentId":"pa-5"}'),
      ('ae-3', NULL, 'system.note', 'system', 'import', '2026-09-01 00:00:00', '{}');
  `);
  return db;
}

function snapshotFromD1() {
  const db = legacyD1();
  try { return createSnapshot(db, '2026-09-27T00:00:00Z'); } finally { db.close(); }
}

// Fixture ma godziny wydarzeń bez strefy (#183): reguła jest podawana jawnie.
const restore = (db, snapshot, options = { eventTimeZone: 'Europe/Brussels' }) => restoreSnapshot(db, snapshot, options);

function resign(snapshot) {
  snapshot.checksum = snapshotChecksum(snapshot.tables);
  return snapshot;
}

test('restore from a D1-built snapshot works with every current PostgreSQL migration', async () => {
  assert.ok(pgMigrations.includes('0004_auth_access.sql') && pgMigrations.includes('0008_events.sql') && pgMigrations.includes('0009_meetings.sql'));
  const snapshot = snapshotFromD1();
  for (const table of SNAPSHOT_TABLES) assert.ok(snapshot.tables[table].length > 0, `fixture covers ${table}`);
  const expected = sourceReconciliation(structuredClone(snapshot.tables));
  const db = await createTestDb();
  try {
    const report = await restore(db, snapshot);
    // Uzgodnienie liczności i sum (restoreSnapshot porównuje je też sam i wycofuje przy różnicy).
    assert.deepEqual(report.counts, expected.counts);
    assert.deepEqual(report.payments, { count: 6, net_cents: '16500' });
    assert.deepEqual(report.ledger, { income_cents: '7000', expense_cents: '351000' });
    const { fingerprints, ...reconciliation } = report;
    // Zdarzenie migration.d1_import (#191) jest dopisywane po uzgodnieniu: w bazie jest o jedno więcej.
    const afterImport = await reconciliationReport(db);
    assert.equal(afterImport.counts.audit_events, reconciliation.counts.audit_events + 1);
    assert.deepEqual({ ...afterImport, counts: { ...afterImport.counts, audit_events: reconciliation.counts.audit_events } }, reconciliation);
    assert.deepEqual(Object.keys(fingerprints), SNAPSHOT_TABLES);

    // Wpłaty: przypisanie odtworzone chronionym przejściem, suma per rodzina bez statusu „dłużnik”.
    const assigned = (await db.query("SELECT household_id, status FROM payment_entries WHERE id = 'p-5'")).rows[0];
    assert.deepEqual(assigned, { household_id: 'h-3', status: 'recorded' });
    const unmatched = (await db.query("SELECT household_id, status FROM payment_entries WHERE id = 'p-4'")).rows[0];
    assert.deepEqual(unmatched, { household_id: null, status: 'unmatched' });

    // 0008: wydarzenia opublikowane w D1 stają się opublikowaną rewizją 1 ze źródłem legacy_d1;
    // pozostałe są szkicami. Publiczny widok pokazuje tylko opublikowane.
    const events = (await db.query('SELECT id, status, audience, visibility, revision_no, published_revision_no, updated_by FROM events ORDER BY id')).rows;
    assert.deepEqual(events, [
      { id: 'ev-draft', status: 'draft', audience: 'public', visibility: 'draft_public', revision_no: 1, published_revision_no: null, updated_by: 'u-admin' },
      { id: 'ev-internal', status: 'draft', audience: 'internal', visibility: 'internal', revision_no: 1, published_revision_no: null, updated_by: 'u-admin' },
      { id: 'ev-published', status: 'published', audience: 'public', visibility: 'published', revision_no: 1, published_revision_no: 1, updated_by: 'u-admin' },
      { id: 'ev-published-no-date', status: 'published', audience: 'public', visibility: 'published', revision_no: 1, published_revision_no: 1, updated_by: 'u-admin' },
    ]);
    const revisions = (await db.query('SELECT event_id, source FROM event_revisions ORDER BY event_id')).rows;
    assert.deepEqual(revisions.map((r) => `${r.event_id}:${r.source}`), [
      'ev-draft:app', 'ev-internal:app', 'ev-published:legacy_d1', 'ev-published-no-date:legacy_d1',
    ]);
    const published = (await db.query("SELECT published_at, first_published_at FROM events WHERE id = 'ev-published'")).rows[0];
    assert.equal(published.published_at.toISOString(), '2026-09-20T10:00:00.000Z');
    assert.equal(published.first_published_at.toISOString(), '2026-09-20T10:00:00.000Z');
    const publicIds = (await db.query('SELECT id FROM public_events ORDER BY id')).rows.map((r) => r.id);
    assert.deepEqual(publicIds, ['ev-published', 'ev-published-no-date']);

    // 0004: przydziały ról aktywne, bez wycofania; nowe kolumny mają wartości domyślne.
    const grants = (await db.query('SELECT count(*)::int AS n FROM role_grants WHERE revoked_at IS NULL AND granted_by IS NULL AND source_invitation_id IS NULL')).rows[0];
    assert.equal(grants.n, 5);
    // Nowa sesja dla odtworzonego użytkownika widzi wyłącznie niewygasłe przydziały (sesje z D1 nie są przenoszone).
    const repCookie = await seedUserSession(db, { userId: 'u-rep' });
    const access = await handlePgRequest(request('/api/access', { cookie: repCookie }), { db });
    assert.equal(access.status, 200);
    assert.deepEqual((await access.json()).grants, [
      { role: 'representative', classId: 'c-1a', schoolYearId: 'y-2026', expiresAt: '2099-08-31T00:00:00.000Z' },
    ]);
    const offCookie = await seedUserSession(db, { userId: 'u-off' });
    assert.equal((await handlePgRequest(request('/api/session', { cookie: offCookie }), { db })).status, 401, 'disabled user stays disabled');

    // 0009: tabele zebrań puste, ale używalne z odtworzonymi latami i użytkownikami.
    assert.equal((await db.query('SELECT count(*)::int AS n FROM meetings')).rows[0].n, 0);
  } finally { await db.close(); }
});

test('naive D1 timestamps are read as UTC even when the server session zone is Europe/Brussels', async () => {
  const db = await createTestDb();
  try {
    await db.query("SET TIME ZONE 'Europe/Brussels'");
    await restore(db, snapshotFromD1());
    const rows = (await db.query("SELECT to_char(published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS published, to_char(begins_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS begins FROM events WHERE id = 'ev-published'")).rows[0];
    // published_at to znacznik techniczny (UTC); begins_at to czas kalendarza, tu odczytany jako brukselski (#183).
    assert.deepEqual(rows, { published: '2026-09-20 10:00', begins: '2026-10-12 16:00' });
    const zone = (await db.query('SHOW TimeZone')).rows[0];
    assert.equal(Object.values(zone)[0], 'Europe/Brussels', 'SET LOCAL does not leak past the restore transaction');
  } finally { await db.close(); }
});

test('restored rows stay protected by the new guards (append-only audit, role grants, events)', async () => {
  const db = await createTestDb();
  try {
    await restore(db, snapshotFromD1());
    await assert.rejects(db.query("UPDATE audit_events SET action = 'changed' WHERE id = 'ae-1'"), /audit_events_are_append_only/);
    await assert.rejects(db.query("DELETE FROM audit_events WHERE id = 'ae-3'"), /audit_events_are_append_only/);
    await assert.rejects(db.query("DELETE FROM role_grants WHERE id = 'rg-rep'"), /role_grants_cannot_be_deleted/);
    await assert.rejects(db.query("UPDATE role_grants SET class_id = 'c-2a' WHERE id = 'rg-rep'"), /role_grant_scope_immutable/);
    await assert.rejects(db.query("DELETE FROM events WHERE id = 'ev-published'"), /events_cannot_be_deleted/);
    await assert.rejects(db.query("UPDATE payment_entries SET amount_cents = 1 WHERE id = 'p-1'"), /immutable|financial/);

    // Cofnięcie odtworzonej roli działa przez funkcję aplikacji i dopisuje zdarzenie audytu.
    assert.equal(await revokeRoleGrant({ db }, { grantId: 'rg-rep', actorId: 'u-admin' }), true);
    const revokedEvents = (await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'role_grant.revoked' AND entity_id = 'rg-rep'")).rows[0];
    assert.equal(revokedEvents.n, 1);

    // Edycja odtworzonego opublikowanego wydarzenia tworzy rewizję 2; publicznie nadal widać rewizję 1.
    await db.query("UPDATE events SET title = 'Zebranie ogólne Rady (zmiana sali)', updated_by = 'u-admin' WHERE id = 'ev-published'");
    const edited = (await db.query("SELECT status, revision_no, published_revision_no FROM events WHERE id = 'ev-published'")).rows[0];
    assert.deepEqual(edited, { status: 'draft', revision_no: 2, published_revision_no: 1 });
    const publicTitle = (await db.query("SELECT title FROM public_events WHERE id = 'ev-published'")).rows[0].title;
    assert.equal(publicTitle, 'Zebranie ogólne Rady');
  } finally { await db.close(); }
});

test('an unpublished D1 event with a leftover published_at is rejected with a clear error and nothing is written', async () => {
  const snapshot = snapshotFromD1();
  snapshot.tables.events.find((row) => row.id === 'ev-internal').published_at = '2026-09-01 10:00:00';
  resign(snapshot);
  const db = await createTestDb();
  try {
    await assert.rejects(restore(db, snapshot), /Unpublished event has published_at: ev-internal/);
    for (const table of ['school_years', 'users', 'role_grants', 'audit_events', 'events', 'event_revisions', 'payment_entries']) {
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, `rolled back: ${table}`);
    }
    // Błąd w połowie transakcji (po rolach, wydarzeniach i rewizjach z triggera 0008) też wycofuje wszystko.
    const broken = snapshotFromD1();
    broken.tables.payment_entries.find((row) => row.id === 'p-1').household_id = 'h-missing';
    await assert.rejects(restore(db, resign(broken)), /foreign key/);
    for (const table of ['role_grants', 'events', 'event_revisions', 'audit_events', 'payment_entries']) {
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, `rolled back mid-transaction: ${table}`);
    }
    // Po odrzuceniu ta sama baza przyjmuje poprawny snapshot (brak częściowego stanu).
    const report = await restore(db, snapshotFromD1());
    assert.equal(report.counts.events, 4);
  } finally { await db.close(); }
});

test('D1 snapshot with a role grant whose class is from another school year is rejected with the row id and nothing is written (#198)', async () => {
  const snapshot = snapshotFromD1();
  snapshot.tables.role_grants.find((row) => row.id === 'rg-rep').school_year_id = 'y-2025';
  resign(snapshot);
  const db = await createTestDb();
  try {
    await assert.rejects(restore(db, snapshot), /Role grant class does not belong to its school year: rg-rep/);
    for (const table of ['school_years', 'users', 'role_grants']) {
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, `nothing written: ${table}`);
    }
    const noYear = snapshotFromD1();
    noYear.tables.role_grants.find((row) => row.id === 'rg-rep').school_year_id = null;
    await assert.rejects(restore(db, resign(noYear)), /Role grant has a class but no school year: rg-rep/);
  } finally { await db.close(); }
});

test('D1 snapshot with user e-mails differing only by case is rejected with both row ids and no e-mail in the error (#198)', async () => {
  const snapshot = snapshotFromD1();
  snapshot.tables.users.push({
    id: 'u-dup', email: 'REP@example.invalid'.toLowerCase(), display_name: 'Test Duplikat', disabled_at: null, created_at: '2026-09-02 08:00:00',
  });
  resign(snapshot);
  const db = await createTestDb();
  try {
    await assert.rejects(restore(db, snapshot), (error) => {
      assert.match(error.message, /Duplicate user email \(case-insensitive\): u-dup, u-rep/);
      assert.doesNotMatch(error.message, /example\.invalid/);
      return true;
    });
    const upper = snapshotFromD1();
    upper.tables.users.find((row) => row.id === 'u-rep').email = 'Rep@example.invalid';
    await assert.rejects(restore(db, resign(upper)), /User email is not in lower\(btrim\(\)\) form: u-rep/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 0);
  } finally { await db.close(); }
});

test('restore refuses a non-empty target that already holds new-schema rows (meetings)', async () => {
  const db = await createTestDb();
  try {
    await db.query("INSERT INTO school_years (id, label, starts_on, ends_on) VALUES ('y-x', 'x', '2026-09-01', '2027-08-31')");
    await db.query("INSERT INTO users (id, email, display_name) VALUES ('u-x', 'x@example.invalid', 'X')");
    await db.query(`INSERT INTO meetings (id, school_year_id, kind, title, scheduled_at, created_by)
                    VALUES ('m-x', 'y-x', 'board', 'Zebranie próbne', '2026-10-01T17:00:00Z', 'u-x')`);
    await assert.rejects(restore(db, snapshotFromD1()), /Target table is not empty/);
  } finally { await db.close(); }
});

// #183: godziny wydarzeń (czas wpisany przez człowieka) wymagają jawnej reguły strefy.
async function publicEventTimes(db) {
  const res = await handlePgRequest(request('/api/public/events?schoolYearId=y-2026'), { db });
  assert.equal(res.status, 200);
  return Object.fromEntries((await res.json()).events.map((e) => [e.id, [e.startsAt, e.startsAtUtc]]));
}

test('restore without an event time zone rejects naive begins_at before the transaction and writes nothing (#183)', async () => {
  const db = await createTestDb();
  try {
    await assert.rejects(restoreSnapshot(db, snapshotFromD1()), /begins_at without a time zone \(3, e\.g\. ev-internal\).*eventTimeZone/);
    await assert.rejects(restoreSnapshot(db, snapshotFromD1(), { eventTimeZone: 'Europe/Warsaw' }), /begins_at without a time zone/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM events')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM school_years')).rows[0].n, 0);
  } finally { await db.close(); }
});

test('Europe/Brussels rule shows the typed hour in the public view and the panel, in summer and winter time (#183)', async () => {
  const db = await createTestDb();
  try {
    await restore(db, snapshotFromD1());
    assert.deepEqual(await publicEventTimes(db), {
      'ev-published': ['2026-10-12T18:00:00+02:00', '2026-10-12T16:00:00.000Z'],
      'ev-published-no-date': ['2026-12-01T10:00:00+01:00', '2026-12-01T09:00:00.000Z'],
    }, 'tylko opublikowane; internal i draft_public niewidoczne publicznie');
    const admin = await seedUserSession(db, { userId: 'u-admin', mfa: true });
    const panel = await handlePgRequest(request('/api/events?schoolYearId=y-2026', { cookie: admin }), { db });
    assert.equal(panel.status, 200);
    const starts = Object.fromEntries((await panel.json()).events.map((e) => [e.id, e.startsAt]));
    assert.equal(starts['ev-internal'], '2026-10-05T17:00:00+02:00', 'ta sama reguła dla internal');
    assert.equal(starts['ev-published'], '2026-10-12T18:00:00+02:00');
    assert.equal(starts['ev-published-no-date'], '2026-12-01T10:00:00+01:00');
    assert.equal(starts['ev-draft'], '2026-11-20T10:00:00+01:00', 'wartość z jawnym Z bez zmian (09:00Z = 10:00 w Brukseli)');
  } finally { await db.close(); }
});

test('UTC rule keeps the stored instant; restoring on a fresh database gives identical startsAtUtc (#183)', async () => {
  const first = await createTestDb();
  const second = await createTestDb();
  try {
    await restoreSnapshot(first, snapshotFromD1(), { eventTimeZone: 'UTC' });
    await restoreSnapshot(second, snapshotFromD1(), { eventTimeZone: 'UTC' });
    const times = await publicEventTimes(first);
    assert.equal(times['ev-published'][1], '2026-10-12T18:00:00.000Z');
    assert.equal(times['ev-published'][0], '2026-10-12T20:00:00+02:00');
    assert.deepEqual(await publicEventTimes(second), times);
  } finally { await first.close(); await second.close(); }
});

test('explicit-zone begins_at passes without conversion and without any zone rule (#183)', async () => {
  const snapshot = snapshotFromD1();
  const byId = (id) => snapshot.tables.events.find((row) => row.id === id);
  byId('ev-published').begins_at = '2026-10-12T18:00:00+01:00';
  byId('ev-published-no-date').begins_at = '2026-12-01T10:00:00Z';
  byId('ev-internal').begins_at = '2026-10-05T17:00:00Z';
  resign(snapshot);
  const db = await createTestDb();
  try {
    await restoreSnapshot(db, snapshot);
    const times = await publicEventTimes(db);
    assert.equal(times['ev-published'][1], '2026-10-12T17:00:00.000Z');
    assert.equal(times['ev-published-no-date'][1], '2026-12-01T10:00:00.000Z');
  } finally { await db.close(); }
});

test('ambiguous or nonexistent Brussels local time is rejected with the event id and nothing is written (#183)', async () => {
  const db = await createTestDb();
  try {
    for (const [value, reason] of [['2026-10-25 02:30:00', 'ambiguous_local_time'], ['2026-03-29 02:30:00', 'nonexistent_local_time']]) {
      const snapshot = snapshotFromD1();
      snapshot.tables.events.find((row) => row.id === 'ev-internal').begins_at = value;
      resign(snapshot);
      await assert.rejects(restore(db, snapshot), new RegExp(`${reason}\\): ev-internal`));
      assert.equal((await db.query('SELECT count(*)::int AS n FROM events')).rows[0].n, 0);
    }
    // Pod regułą UTC ta sama godzina jest jednoznaczna.
    const snapshot = snapshotFromD1();
    snapshot.tables.events.find((row) => row.id === 'ev-internal').begins_at = '2026-10-25 02:30:00';
    await restoreSnapshot(db, resign(snapshot), { eventTimeZone: 'UTC' });
  } finally { await db.close(); }
});

// #182: uzgodnienie porównuje źródło z bazą docelową, a kolumny spoza mapowania nie giną po cichu.
test('D1 ledger row with approval_id is rejected naming table and column, without the value, and nothing is written (#182)', async () => {
  const snapshot = snapshotFromD1();
  assert.ok('approval_id' in snapshot.tables.ledger_entries[0], 'snapshot keeps every D1 column');
  snapshot.tables.ledger_entries[0].approval_id = 'appr-synthetic-1';
  resign(snapshot);
  const target = await createTestDb();
  try {
    await assert.rejects(restore(target, snapshot), (error) => {
      assert.match(error.message, /ledger_entries\.approval_id \(1 rows with data, e\.g\. le-/);
      assert.doesNotMatch(error.message, /appr-synthetic-1/);
      return true;
    });
    assert.equal((await target.query('SELECT count(*)::int AS n FROM school_years')).rows[0].n, 0);
  } finally { await target.close(); }
});

test('empty columns outside the mapping do not block restore (#182)', async () => {
  const snapshot = snapshotFromD1();
  snapshot.tables.ledger_entries.forEach((row) => { row.approval_id = null; });
  snapshot.tables.students[0].extra_note = '';
  resign(snapshot);
  const db = await createTestDb();
  try { await restore(db, snapshot); } finally { await db.close(); }
});

// Klient, który po wstawieniu danych (przy pierwszym odczycie schematu do odcisków) psuje jeden wiersz.
function corruptingClient(db, sql) {
  let done = false;
  return {
    async query(text, params) {
      if (!done && /information_schema\.columns/.test(text)) { done = true; await db.query(sql); }
      return db.query(text, params);
    },
  };
}

for (const [name, sql, table, id] of [
  ['one shifted timestamp (1 h)', "UPDATE events SET begins_at = begins_at + interval '1 hour' WHERE id = 'ev-published'", 'events', 'ev-published'],
  ['one swapped household_id', "UPDATE students SET household_id = 'h-2' WHERE id = 'st-2'", 'students', 'st-2'],
  ['one changed date', "UPDATE student_guardians SET starts_on = '2026-09-02' WHERE student_id = 'st-1' AND guardian_id = 'g-2'", 'student_guardians', 'st-1\\|g-2'],
  ['one changed flag', "UPDATE guardians SET contact_allowed = false WHERE id = 'g-1'", 'guardians', 'g-1'],
]) {
  test(`restore is rolled back when the target differs from the source: ${name} (#182)`, async () => {
    const db = await createTestDb();
    try {
      let error;
      try { await restore(corruptingClient(db, sql), snapshotFromD1()); } catch (caught) { error = caught; }
      assert.ok(error, 'restore must fail');
      assert.match(error.message, new RegExp(`Row fingerprint mismatch.*${table}: 1 rows \\(${id}\\)`));
      assert.equal((await db.query('SELECT count(*)::int AS n FROM school_years')).rows[0].n, 0);
    } finally { await db.close(); }
  });
}

test('two restores of the same snapshot give identical fingerprints (#182)', async () => {
  const snapshot = snapshotFromD1();
  const first = await createTestDb();
  const second = await createTestDb();
  try {
    const a = await restore(first, structuredClone(snapshot));
    const b = await restore(second, structuredClone(snapshot));
    assert.deepEqual(a.fingerprints, b.fingerprints);
  } finally { await first.close(); await second.close(); }
});

// #191: ślad importu w dzienniku. Dane wyłącznie syntetyczne.
async function importEvents(db) {
  return (await db.query("SELECT actor_id, action, entity_type, entity_id, metadata_json FROM audit_events WHERE action = 'migration.d1_import'")).rows;
}

const IMPORT_OPTIONS = { eventTimeZone: 'Europe/Brussels', actorId: 'u-admin' };

test('restore appends exactly one migration.d1_import event with checksum, counts and the named admin (#191)', async () => {
  const snapshot = snapshotFromD1();
  const db = await createTestDb();
  try {
    const report = await restore(db, snapshot, IMPORT_OPTIONS);
    const events = await importEvents(db);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.actor_id, 'u-admin');
    assert.equal(event.entity_type, 'd1_snapshot');
    assert.equal(event.entity_id, snapshot.checksum);
    assert.equal(event.metadata_json.snapshotChecksum, snapshot.checksum);
    assert.equal(event.metadata_json.format, snapshot.format);
    assert.deepEqual(event.metadata_json.counts, report.counts, 'counts are those reconciled before the event was appended');
    assert.equal(event.metadata_json.counts.audit_events, snapshot.tables.audit_events.length);
    assert.match(event.metadata_json.fingerprintsSha256, /^[0-9a-f]{64}$/);
    assert.equal(event.metadata_json.sessionsAndInvitationsImported, false);
    assert.doesNotMatch(JSON.stringify(event.metadata_json), /example\.invalid|Testow/, 'no personal data in the audit metadata');
    const total = (await db.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n;
    assert.equal(total, snapshot.tables.audit_events.length + 1);
    await assert.rejects(() => db.query("UPDATE audit_events SET actor_id = NULL WHERE action = 'migration.d1_import'"), /append_only/);
  } finally { await db.close(); }
});

test('a second restore into the same database is refused and leaves exactly one import event (#191)', async () => {
  const snapshot = snapshotFromD1();
  const db = await createTestDb();
  try {
    await restore(db, snapshot, IMPORT_OPTIONS);
    await assert.rejects(() => restore(db, structuredClone(snapshot), IMPORT_OPTIONS), /Target table is not empty/);
    assert.equal((await importEvents(db)).length, 1);
  } finally { await db.close(); }
});

test('a failed restore leaves no import event and the retry yields exactly one (#191)', async () => {
  const snapshot = snapshotFromD1();
  const db = await createTestDb();
  try {
    const failing = new Proxy(db, {
      get(target, property) {
        if (property !== 'query') return Reflect.get(target, property);
        return (sql, params) => (/INSERT INTO "ledger_budget_lines"/.test(String(sql))
          ? Promise.reject(new Error('synthetic failure mid-import')) : target.query(sql, params));
      },
    });
    await assert.rejects(() => restore(failing, structuredClone(snapshot), IMPORT_OPTIONS), /synthetic failure/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n, 0, 'rolled back, nothing left');
    await restore(db, structuredClone(snapshot), IMPORT_OPTIONS);
    assert.equal((await importEvents(db)).length, 1);
  } finally { await db.close(); }
});

test('import actor must be a restored, enabled admin: representative, treasurer, disabled, unknown and expired are refused before any write (#191)', async () => {
  const db = await createTestDb();
  try {
    const cases = [
      ['u-rep', /no active admin role grant/, () => {}],
      ['u-treasurer', /no active admin role grant/, () => {}],
      ['u-off', /account is disabled/, () => {}],
      ['u-missing', /not a user in the snapshot/, () => {}],
      ['u-admin', /no active admin role grant/, (s) => { s.tables.role_grants.find((g) => g.id === 'rg-admin').expires_at = '2020-01-01 00:00:00'; }],
    ];
    assert.ok(cases.length > 0);
    for (const [actorId, pattern, mutate] of cases) {
      const snapshot = snapshotFromD1();
      mutate(snapshot);
      resign(snapshot);
      await assert.rejects(() => restore(db, snapshot, { eventTimeZone: 'Europe/Brussels', actorId }), pattern, actorId);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM school_years')).rows[0].n, 0, `${actorId}: nothing written`);
    }
  } finally { await db.close(); }
});

test('without an actor the event is still written with a NULL actor (library callers) (#191)', async () => {
  const db = await createTestDb();
  try {
    await restore(db, snapshotFromD1());
    const events = await importEvents(db);
    assert.equal(events.length, 1);
    assert.equal(events[0].actor_id, null);
  } finally { await db.close(); }
});
