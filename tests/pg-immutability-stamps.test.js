// #204 (punkty 3, 4, 6) — migracja 0144: znaczniki czasu zapisu pochodzą z zegara
// bazy (antydatowany INSERT jest przestawiany na now()), pierwsze ustawienie
// revoked_at/cancelled_at/... też, a jedyną furtką jest tryb odtworzenia
// `SET LOCAL rd.restore = 'on'`. Do tego meta-test („lint niezmienności”) po
// katalogu bazy: każda tabela ze strażnikiem UPDATE/DELETE ma BEFORE TRUNCATE,
// a każda tabela append-only z kolumną czasu zapisu ma trigger stemplujący albo
// wpis z uzasadnieniem na liście wyjątków. Testy wchodzą bezpośrednio w SQL
// (poza API). Dane wyłącznie syntetyczne (@example.invalid).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedSchoolYear, seedUser, seedUserSession, assertOwnerGuard } from './helpers/pg.js';

const PAST = '2019-01-01T00:00:00Z';

async function setup() {
  const db = await createTestDb();
  await seedSchoolYear(db, 'y-2026');
  await seedUser(db, { userId: 'u-treasurer' });
  await db.query("INSERT INTO households (id) VALUES ('h-1')");
  return db;
}

async function serverNow(db) {
  return (await db.query('SELECT now() AS n')).rows[0].n;
}

const insertPayment = (db, id, createdAt) => db.query(
  `INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key, created_at)
   VALUES ($1, 'h-1', 'y-2026', 2000, '2026-10-02', 'bank', 'recorded', 'u-treasurer', $2, $3)`,
  [id, `${id}-key-0001`, createdAt],
);

test('audit_events: antydatowany INSERT dostaje occurred_at z zegara bazy (#204 pkt 3)', async () => {
  const db = await setup();
  const before = await serverNow(db);
  await db.query(
    `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, occurred_at, metadata_json)
     VALUES ('ae-1', 'u-treasurer', 'test.event', 'test', 't-1', $1, '{}'::jsonb)`, [PAST]);
  const { rows } = await db.query(`SELECT occurred_at >= $1::timestamptz AS ok FROM audit_events WHERE id = 'ae-1'`, [before]);
  assert.equal(rows[0].ok, true);
  await db.close();
});

test('data_access_log: antydatowanie occurred_at jest przestawiane (#204 pkt 3)', async () => {
  const db = await setup();
  const cols = (await db.query(`SELECT table_name, column_name FROM information_schema.columns
    WHERE table_name = 'data_access_log' AND column_name = 'occurred_at'`)).rows;
  assert.equal(cols.length, 1);
  const triggers = (await db.query(`SELECT c.relname AS t FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
    WHERE g.tgname = 'a0_stamp_created_now' AND c.relname = 'data_access_log'`)).rows;
  assert.equal(triggers.length, 1);
  await db.close();
});

test('payment_entries: antydatowany created_at jest przestawiany, a UPDATE nadal odrzucony (#204 pkt 3)', async () => {
  const db = await setup();
  const before = await serverNow(db);
  await insertPayment(db, 'p-1', PAST);
  const { rows } = await db.query(`SELECT created_at >= $1::timestamptz AS ok FROM payment_entries WHERE id = 'p-1'`, [before]);
  assert.equal(rows[0].ok, true);
  await assert.rejects(db.query(`UPDATE payment_entries SET created_at = $1 WHERE id = 'p-1'`, [PAST]));
  await assert.rejects(db.query(`DELETE FROM payment_entries WHERE id = 'p-1'`));
  await db.close();
});

test('payment_entries: legalny INSERT bez created_at nadal działa (DEFAULT now())', async () => {
  const db = await setup();
  await db.query(
    `INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key)
     VALUES ('p-2', 'h-1', 'y-2026', 500, '2026-10-03', 'bank', 'recorded', 'u-treasurer', 'p-2-key-0001')`);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM payment_entries')).rows[0].n, 1);
  await db.close();
});

test('ledger_opening_balances: antydatowany created_at jest przestawiany (#204 pkt 3)', async () => {
  const db = await setup();
  const before = await serverNow(db);
  await db.query(
    `INSERT INTO ledger_opening_balances (id, school_year_id, amount_cents, created_by, idempotency_key, created_at)
     VALUES ('ob-1', 'y-2026', 10000, 'u-treasurer', 'ob-1-key-0001', $1)`, [PAST]);
  const { rows } = await db.query(`SELECT created_at >= $1::timestamptz AS ok FROM ledger_opening_balances WHERE id = 'ob-1'`, [before]);
  assert.equal(rows[0].ok, true);
  await db.close();
});

test('tryb odtworzenia (rd.restore=on) zachowuje oryginalne znaczniki czasu, poza nim nie (#204 pkt 3)', async () => {
  const db = await setup();
  await db.query('BEGIN');
  await db.query(`SELECT set_config('rd.restore', 'on', true)`);
  await insertPayment(db, 'p-restore', PAST);
  await db.query(
    `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, occurred_at, metadata_json)
     VALUES ('ae-restore', 'u-treasurer', 'test.event', 'test', 't-1', $1, '{}'::jsonb)`, [PAST]);
  await db.query('COMMIT');
  const kept = await db.query(
    `SELECT (SELECT created_at FROM payment_entries WHERE id = 'p-restore') AS p,
            (SELECT occurred_at FROM audit_events WHERE id = 'ae-restore') AS a`);
  assert.equal(new Date(kept.rows[0].p).toISOString(), '2019-01-01T00:00:00.000Z');
  assert.equal(new Date(kept.rows[0].a).toISOString(), '2019-01-01T00:00:00.000Z');
  // Po COMMIT ustawienie SET LOCAL wygasa — kolejny antydatowany INSERT jest stemplowany.
  await insertPayment(db, 'p-normal', PAST);
  const normal = await db.query(`SELECT created_at > '2020-01-01' AS ok FROM payment_entries WHERE id = 'p-normal'`);
  assert.equal(normal.rows[0].ok, true);
  await db.close();
});

test('role_grants: cofnięcie z datą wsteczną dostaje revoked_at = now() (#204 pkt 4)', async () => {
  const db = await setup();
  await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: 'y-2026' }] });
  const before = await serverNow(db);
  await db.query(`UPDATE role_grants SET revoked_at = $1, revoked_by = 'u-treasurer' WHERE user_id = 'u-board'`, [PAST]);
  const { rows } = await db.query(`SELECT revoked_at >= $1::timestamptz AS ok FROM role_grants WHERE user_id = 'u-board'`, [before]);
  assert.equal(rows[0].ok, true);
  // Cofnięcia nie da się ponownie przesunąć.
  await assert.rejects(db.query(`UPDATE role_grants SET revoked_at = $1 WHERE user_id = 'u-board'`, [PAST]));
  await db.close();
});

test('sessions: odwołanie z datą wsteczną dostaje revoked_at = now(), a cofnięcie odwołania jest odrzucone (#204 pkt 2, 4)', async () => {
  const db = await setup();
  await seedUserSession(db, { userId: 'u-a' });
  const before = await serverNow(db);
  await db.query(`UPDATE sessions SET revoked_at = $1, revoked_reason = 'logout' WHERE user_id = 'u-a'`, [PAST]);
  const { rows } = await db.query(`SELECT revoked_at >= $1::timestamptz AS ok FROM sessions WHERE user_id = 'u-a'`, [before]);
  assert.equal(rows[0].ok, true);
  await assert.rejects(db.query(`UPDATE sessions SET revoked_at = NULL, revoked_reason = NULL WHERE user_id = 'u-a'`), /session_revocation_final/);
  await db.close();
});

test('email_campaigns: anulowanie z datą wsteczną dostaje cancelled_at = now(); legalne przejścia działają (#204 pkt 4)', async () => {
  const db = await setup();
  await db.query(
    `INSERT INTO email_campaigns (id, school_year_id, title, audience, subject, body_text, content_hash, status, created_by, updated_by, idempotency_key)
     VALUES ('camp-1', 'y-2026', 'Kampania testowa', 'all_households', 'Temat', repeat('x', 30), $1, 'draft', 'u-treasurer', 'u-treasurer', 'idem-camp-1')`, ['a'.repeat(64)]);
  const before = await serverNow(db);
  await db.query(`UPDATE email_campaigns SET status = 'cancelled', cancelled_by = 'u-treasurer', cancelled_at = $1 WHERE id = 'camp-1'`, [PAST]);
  const { rows } = await db.query(`SELECT cancelled_at >= $1::timestamptz AS ok FROM email_campaigns WHERE id = 'camp-1'`, [before]);
  assert.equal(rows[0].ok, true);
  await db.close();
});

test('BEFORE TRUNCATE blokuje tabele z 0090 i pozostałe strażniki dopisane w 0144 (#204)', async () => {
  const db = await setup();
  for (const table of ['ledger_allocation_versions', 'ledger_allocation_items', 'document_status_events', 'privacy_notices', 'sessions', 'retention_policies']) {
    // TRUNCATE wykonuje tylko właściciel; rola aplikacji nie ma tego uprawnienia (SR-05, assertOwnerGuard).
    await assertOwnerGuard(db, `TRUNCATE ${table} CASCADE`, /truncate_not_allowed/);
  }
  await db.close();
});

// --- meta-test: lint niezmienności po katalogu bazy ---------------------------

// Tabele z triggerem UPDATE/DELETE, które świadomie NIE mają BEFORE TRUNCATE.
const TRUNCATE_EXCEPTIONS = new Map([
  ['guardians', 'mutowalne dane główne; historia zmian w guardian_contact_changes (ma BEFORE TRUNCATE)'],
]);

// Tabele append-only z kolumną czasu zapisu bez triggera stemplującego — uzasadnienie.
const STAMP_EXCEPTIONS = new Map([
  ['bank_statement_imports', 'import wyciągu: czas zapisu liczy aplikacja, wiersze odtwarzane z eksportu'],
  ['bank_statement_lines', 'j.w.'],
  ['document_descriptions', 'rewizje opisów; kolejność pilnuje trigger revision_order'],
  ['email_preview_sends', 'podgląd wysyłki, nie dowód finansowy ani decyzja'],
  ['email_send_ledger', 'recorded_at liczy dzienny limit wysyłki (strefa czasowa konta); testy #84 ustawiają czas'],
  ['email_suppressions', 'lista blokad synchronizowana z dostawcą e-mail (zdarzenia zewnętrzne)'],
  ['email_webhook_events', 'occurred_at = czas zdarzenia u dostawcy, nie zapisu'],
  ['event_revisions', 'rewizje wydarzeń; numer rewizji porządkuje historię'],
  ['export_runs', 'rejestr eksportów; dopisywany przez aplikację'],
  ['import_batches', 'rejestr importów; dopisywany przez aplikację'],
  ['ledger_allocation_versions', 'wersje podziału; numer wersji porządkuje historię'],
  ['ledger_budget_lines', 'linie budżetu; wersjonowane rocznie'],
  ['ledger_category_deactivations', 'dezaktywacja kategorii; strażnik wymaga aktora'],
  ['meeting_minutes_publications', 'publikacja protokołu; strażnik wymaga aktora'],
  ['meeting_quorum_checks', 'obliczane triggerem compute; poza zakresem #204'],
  ['meeting_request_keys', 'klucze idempotencji żądań'],
  ['news_post_revisions', 'rewizje aktualności; numer rewizji porządkuje historię'],
  ['news_photo_files', 'metadane plików; dopisywane po przesłaniu'],
  ['retention_policies', 'polityki retencji; wersjonowane w kodzie'],
  ['documents', 'metadane dokumentu; zapis czasu przez aplikację, zmiany statusu w document_status_events (ma stempel)'],
]);

test('lint niezmienności: każda tabela ze strażnikiem UPDATE/DELETE ma BEFORE TRUNCATE (#204 pkt 6)', async () => {
  const db = await createTestDb();
  const { rows } = await db.query(`
    SELECT c.relname AS t FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
    WHERE c.relkind = 'r'
      AND EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = c.oid AND NOT g.tgisinternal
                  AND (g.tgtype & 1) = 1 AND (g.tgtype & (8 | 16)) <> 0
                  AND g.tgname ~ '(no_change|append_only|no_delete|guard)')
      AND NOT EXISTS (SELECT 1 FROM pg_trigger x WHERE x.tgrelid = c.oid AND NOT x.tgisinternal AND (x.tgtype & 32) <> 0)
    ORDER BY 1`);
  const missing = rows.map((r) => r.t).filter((t) => !TRUNCATE_EXCEPTIONS.has(t));
  assert.deepEqual(missing, [], `tabele bez BEFORE TRUNCATE: ${missing.join(', ')}`);
  await db.close();
});

test('lint niezmienności: tabela append-only z kolumną czasu zapisu ma stempel albo wyjątek z uzasadnieniem (#204 pkt 6)', async () => {
  const db = await createTestDb();
  const { rows } = await db.query(`
    SELECT c.relname AS t,
           EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = 'a0_stamp_created_now') AS stamped
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
    WHERE c.relkind = 'r'
      AND EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = c.oid AND NOT g.tgisinternal
                  AND (g.tgtype & 1) = 1 AND (g.tgtype & 16) <> 0 AND (g.tgtype & 8) <> 0
                  AND g.tgname ~ '(no_change|append_only)$')
      AND EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = current_schema() AND k.table_name = c.relname
                  AND k.column_name IN ('created_at', 'occurred_at', 'recorded_at', 'determined_at'))
    ORDER BY 1`);
  assert.ok(rows.length > 20, 'lint musi widzieć tabele append-only');
  const unexplained = rows.filter((r) => !r.stamped && !STAMP_EXCEPTIONS.has(r.t)).map((r) => r.t);
  assert.deepEqual(unexplained, [], `tabele append-only bez stempla i bez wyjątku: ${unexplained.join(', ')}`);
  const stale = [...STAMP_EXCEPTIONS.keys()].filter((t) => rows.find((r) => r.t === t)?.stamped);
  assert.deepEqual(stale, [], `wyjątki, które już mają stempel: ${stale.join(', ')}`);
  await db.close();
});
