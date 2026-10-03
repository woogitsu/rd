// SR-05 (#101): rola aplikacji `rd_app` (migracja 0170) na PRAWDZIWYM PostgreSQL.
// PGlite nie nadaje się do tego dowodu — chodzi o uprawnienia roli, nie o
// logikę triggerów. Każde połączenie aplikacji startuje z `-c role=rd_app`
// (parametr startowy), a baza i migracje są tworzone rolą właściciela.
// Plik działa wyłącznie z RD_TEST_PG_URL (npm run test:pg-real); bez niej jest
// pomijany. Dane wyłącznie syntetyczne (@example.invalid); żadnej sieci i e-maili.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { handlePgRequest } from '../src/pg/app.js';
import { createPgDatabase } from '../src/db.js';
import { runEmailBatch } from '../src/email/worker.js';
import { checkReadiness } from '../src/health.js';
import { createLogger } from '../src/log.js';
import { loadMigrations } from '../src/postgres-migrations.js';
import { createRealTestDb, request, seedClass, seedEnrolledHousehold, seedPublishedPrivacyNotice, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const skip = process.env.RD_TEST_PG_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';
const YEAR = 'y-2026';
const APP_ROLE = 'rd_app';
// Jedyne tabele, na których aplikacja legalnie robi DELETE (zgodnie z 0170).
// Nowa pozycja wymaga zmiany migracji (GRANT DELETE) i świadomej decyzji w PR.
const DELETE_ALLOWED = ['email_campaign_exclusions', 'email_campaign_recipients', 'login_rate_limits', 'mfa_rate_limits'];
let seq = 0;
const key = (prefix) => `${prefix}-${String(++seq).padStart(6, '0')}-${crypto.randomUUID().slice(0, 8)}`;

const migrationSql = readFileSync(fileURLToPath(new URL('../postgres/migrations/0170_rd_app_role.sql', import.meta.url)), 'utf8');

// Szablon testowy nakłada pliki SQL bez migratora, więc nie ma tabeli
// schema_migrations. Tworzymy ją tak jak migrator (rolą właściciela) i
// ponawiamy 0170 — przy okazji dowód, że migracja jest idempotentna.
async function withApp(fn) {
  const db = await createRealTestDb();
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL CHECK (length(checksum) = 64),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), applied_seq INTEGER NOT NULL DEFAULT 0)`);
  await db.exec(migrationSql);
  const pool = new pg.Pool({ connectionString: db.url, max: 4, options: `-c role=${APP_ROLE}` });
  const appDb = createPgDatabase(pool);
  try { return await fn({ db, appDb, pool }); } finally {
    await appDb.close().catch(() => {});
    await db.close();
  }
}

async function failure(runner, sql) {
  try { await runner.query(sql); } catch (error) { return error; }
  return null;
}

async function tables(db) {
  return (await db.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).rows.map((r) => r.tablename);
}

test('SR-05: rola rd_app nie jest superużytkownikiem, nie tworzy ról ani baz i nie jest właścicielem żadnego obiektu', { skip }, async () => {
  await withApp(async ({ db, pool }) => {
    const { rows: [role] } = await db.query(
      'SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication, rolcanlogin FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
    assert.ok(role, 'migracja 0170 tworzy rolę rd_app');
    assert.deepEqual(role, { rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false, rolreplication: false, rolcanlogin: false });
    const { rows: owned } = await db.query(
      `SELECT c.relname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
        WHERE r.rolname = $1 AND c.relnamespace = 'public'::regnamespace`, [APP_ROLE]);
    assert.deepEqual(owned, [], 'rd_app nie jest właścicielem tabel/sekwencji');
    assert.equal((await pool.query('SELECT current_user AS u')).rows[0].u, APP_ROLE);
  });
});

test('SR-05: rd_app nie wykona TRUNCATE, DDL, DISABLE TRIGGER ani session_replication_role (błąd uprawnień 42501)', { skip }, async () => {
  await withApp(async ({ db, pool }) => {
    const statements = [
      'TRUNCATE audit_events', 'TRUNCATE payment_entries', 'TRUNCATE payment_corrections CASCADE',
      'CREATE TABLE rd_app_probe (id int)',
      'ALTER TABLE payment_entries ADD COLUMN rd_app_probe int',
      'ALTER TABLE payment_entries DISABLE TRIGGER ALL',
      'ALTER TABLE audit_events DISABLE TRIGGER USER',
      'ALTER TABLE audit_events DISABLE ROW LEVEL SECURITY',
      'DROP TABLE audit_events', 'DROP FUNCTION deny_truncate() CASCADE',
      'CREATE FUNCTION rd_app_probe() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$',
      "SET session_replication_role = 'replica'",
      'DELETE FROM audit_events', 'DELETE FROM payment_entries', 'DELETE FROM payment_corrections',
      'DELETE FROM role_grants', 'DELETE FROM meetings', 'DELETE FROM documents',
      'UPDATE schema_migrations SET checksum = checksum',
      "INSERT INTO schema_migrations (name, checksum) VALUES ('x', repeat('a', 64))",
    ];
    for (const sql of statements) {
      const error = await failure(pool, sql);
      assert.ok(error, `powinno się nie powieść: ${sql}`);
      assert.equal(error.code, '42501', `${sql} → ${error.code} ${error.message}`);
    }
    // Kontrola pozytywna: właściciel (rola migracyjna) nadal może wykonać DDL.
    assert.equal(await failure(db, 'ALTER TABLE payment_entries DISABLE TRIGGER USER'), null, 'właściciel nadal może wykonać DDL (migrator)');
    await db.query('ALTER TABLE payment_entries ENABLE TRIGGER USER');
  });
});

test('SR-05 (meta): uprawnienia rd_app na KAŻDEJ tabeli — brak TRUNCATE/TRIGGER/REFERENCES, DELETE tylko z listy, schema_migrations tylko do odczytu', { skip }, async () => {
  await withApp(async ({ db, pool }) => {
    const names = await tables(db);
    assert.ok(names.length > 50, `oczekiwano wielu tabel, jest ${names.length}`);
    const wrongTables = [];
    for (const name of names) {
      const { rows: [p] } = await db.query(
        `SELECT has_table_privilege($1, c.oid, 'SELECT') AS s, has_table_privilege($1, c.oid, 'INSERT') AS i,
                has_table_privilege($1, c.oid, 'UPDATE') AS u, has_table_privilege($1, c.oid, 'DELETE') AS d,
                has_table_privilege($1, c.oid, 'TRUNCATE') AS t, has_table_privilege($1, c.oid, 'TRIGGER') AS tr,
                has_table_privilege($1, c.oid, 'REFERENCES') AS r
           FROM pg_class c WHERE c.oid = ('public.' || quote_ident($2))::regclass`, [APP_ROLE, name]);
      const expected = name === 'schema_migrations'
        ? { s: true, i: false, u: false, d: false, t: false, tr: false, r: false }
        : { s: true, i: true, u: true, d: DELETE_ALLOWED.includes(name), t: false, tr: false, r: false };
      if (JSON.stringify(p) !== JSON.stringify(expected)) wrongTables.push(`${name}: ${JSON.stringify(p)}`);
      const truncateError = await failure(pool, `TRUNCATE public.${name}`);
      assert.equal(truncateError?.code, '42501', `TRUNCATE ${name}: ${truncateError?.message}`);
      const disableError = await failure(pool, `ALTER TABLE public.${name} DISABLE TRIGGER ALL`);
      assert.equal(disableError?.code, '42501', `DISABLE TRIGGER ${name}: ${disableError?.message}`);
      if (!DELETE_ALLOWED.includes(name) && name !== 'schema_migrations') {
        const deleteError = await failure(pool, `DELETE FROM public.${name}`);
        assert.equal(deleteError?.code, '42501', `DELETE ${name}: ${deleteError?.message}`);
      }
    }
    assert.deepEqual(wrongTables, [], 'tabele z uprawnieniami innymi niż w 0170');
    for (const name of DELETE_ALLOWED) assert.ok(names.includes(name), `lista DELETE zawiera nieistniejącą tabelę ${name}`);
  });
});

test('SR-05 (meta): nowa tabela właściciela dostaje przez ALTER DEFAULT PRIVILEGES SELECT/INSERT/UPDATE, bez DELETE i TRUNCATE', { skip }, async () => {
  await withApp(async ({ db, pool }) => {
    await db.query('CREATE TABLE rd_future_probe (id serial PRIMARY KEY, note text)');
    const insert = await failure(pool, "INSERT INTO rd_future_probe (note) VALUES ('x')");
    assert.equal(insert, null, `INSERT na nowej tabeli (sekwencja serial): ${insert?.message}`);
    assert.equal(await failure(pool, "UPDATE rd_future_probe SET note = 'y'"), null);
    assert.equal((await failure(pool, 'DELETE FROM rd_future_probe'))?.code, '42501');
    assert.equal((await failure(pool, 'TRUNCATE rd_future_probe'))?.code, '42501');
  });
});

test('SR-05: typowy zapis aplikacji na rd_app działa — wpłata i korekta przez handlePgRequest; nadpisanie wpłaty jest odrzucone triggerem', { skip }, async () => {
  await withApp(async ({ db, appDb, pool }) => {
    await seedSchoolYear(db, YEAR);
    await seedEnrolledHousehold(db, 'h1', [YEAR]);
    const cookie = await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
    const env = { db: appDb };
    const call = async (method, path, body, idem) => {
      const response = await handlePgRequest(request(path, { method, cookie, body, headers: idem ? { 'Idempotency-Key': idem } : {} }), env);
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    const created = await call('POST', '/api/payments', {
      schoolYearId: YEAR, householdId: 'h1', amountCents: 5000, receivedOn: '2026-10-05', method: 'bank', reference: 'Składka syntetyczna',
    }, key('pay'));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const paymentId = created.body.payment.id;
    const corrected = await call('POST', `/api/payments/${paymentId}/corrections`, { amountCents: 1000, reason: 'Korekta syntetyczna testu' }, key('cor'));
    assert.equal(corrected.status, 201, JSON.stringify(corrected.body));
    assert.equal((await db.query('SELECT count(*)::int AS n FROM payment_corrections WHERE payment_entry_id = $1', [paymentId])).rows[0].n, 1);
    assert.ok((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'payment.created'")).rows[0].n >= 1, 'zdarzenie audytu zapisane przez rd_app');
    // Nadpisanie wpłaty: uprawnienie UPDATE jest, więc broni trigger (nie 42501).
    const overwrite = await failure(pool, `UPDATE payment_entries SET amount_cents = 1 WHERE id = '${paymentId}'`);
    assert.ok(overwrite, 'nadpisanie wpłaty musi się nie powieść');
    assert.notEqual(overwrite.code, '42501', 'to ma być błąd triggera niezmienności, nie braku uprawnień');
    const stored = (await db.query('SELECT amount_cents FROM payment_entries WHERE id = $1', [paymentId])).rows[0];
    assert.equal(Number(stored.amount_cents), 5000);
    // Odczyt stanu migracji (health) działa na rd_app.
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 0);
  });
});

// #101 pkt 2: zadanie e-mail (worker) na roli bez własności tabel. Cała ścieżka — szkic,
// migawka odbiorców, zatwierdzenie, kolejka (API) i przebieg workera — idzie przez rd_app;
// właściciel tylko zakłada dane testowe. Transport to atrapa, żadna wiadomość nie wychodzi.
test('SR-05 (#101): email-worker na rd_app przetwarza kolejkę bez uprawnień właściciela, a ponowienie nic nie wysyła', { skip }, async () => {
  await withApp(async ({ db, appDb }) => {
    await seedPublishedPrivacyNotice(db);
    await seedClass(db, { id: 'c1', schoolYearId: YEAR });
    await seedEnrolledHousehold(db, 'h-mail', [YEAR], { classIds: { [YEAR]: 'c1' } });
    await db.query(
      "INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES ('g-mail', 'h-mail', 'Opiekun', 'Testowy', 'g-mail@example.invalid', true)");
    await db.query("INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ('st-h-mail', 'g-mail', true, true)");
    const treasurer = await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
    const board = await seedUserSession(db, { userId: 'u-bd', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] });
    const env = {
      db: appDb, APP_ENV: 'development', EMAIL_SENDING_ENABLED: 'true', EMAIL_TEST_ALLOWLIST: '*@example.invalid', BREVO_FROM_EMAIL: 'rada@example.invalid',
    };
    const call = async (cookie, path, options = {}) => {
      const response = await handlePgRequest(request(path, { cookie, ...options }), env);
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    const created = await call(treasurer, '/api/email/campaigns', {
      method: 'POST', headers: { 'Idempotency-Key': key('camp') },
      body: {
        schoolYearId: YEAR, title: 'Przypomnienie syntetyczne', audience: 'all_households', subject: 'Dobrowolna składka {rok}',
        bodyText: 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}. Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.',
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.campaign.id;
    assert.equal((await call(treasurer, `/api/email/campaigns/${id}/snapshot`, { method: 'POST' })).status, 200);
    const preview = await call(board, `/api/email/campaigns/${id}/preview`);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const approved = await call(board, `/api/email/campaigns/${id}/approve`, {
      method: 'POST', body: { contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash },
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const queued = await call(treasurer, `/api/email/campaigns/${id}/queue`, { method: 'POST' });
    assert.equal(queued.status, 200, JSON.stringify(queued.body));

    const calls = [];
    const transport = {
      name: 'fake',
      async send(message) { calls.push(message); return { messageId: `fake-${calls.length}` }; },
    };
    const now = new Date('2026-10-05T08:00:00Z');
    const first = await runEmailBatch(env, { transport, dryRun: false, now });
    assert.equal(first.sent, 1, JSON.stringify(first));
    assert.equal(calls.length, 1);
    const statuses = (await db.query('SELECT state, count(*)::int AS n FROM email_outbox GROUP BY state')).rows;
    assert.deepEqual(statuses, [{ state: 'sent', n: 1 }]);
    const again = await runEmailBatch(env, { transport, dryRun: false, now: new Date(now.getTime() + 60_000) });
    assert.equal(again.sent, 0, 'ponowienie zadania nie wysyła drugiej wiadomości');
    assert.equal(calls.length, 1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM email_outbox')).rows[0].n, 1);
  });
});

// #101 pkt 1: /health/ready ostrzega przy pracy produkcyjnej aplikacji jako właściciel tabel
// (albo superużytkownik) i milczy na rd_app. Prawdziwy katalog ról, nie atrapa.
test('SR-05 (#101): /health/ready w produkcji ostrzega przy właścicielu tabel, a na rd_app nie', { skip }, async () => {
  await withApp(async ({ db, appDb }) => {
    for (const migration of await loadMigrations(fileURLToPath(new URL('../postgres/migrations/', import.meta.url)))) {
      await db.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2) ON CONFLICT DO NOTHING', [migration.name, migration.checksum]);
    }
    const events = (lines) => lines.map((line) => JSON.parse(line)).filter((entry) => entry.event === 'readiness_database_role_privileged');
    const logged = () => { const lines = []; return { lines, logger: createLogger({ level: 'debug', sink: (line) => lines.push(line) }) }; };

    const asApp = logged();
    const appResult = await checkReadiness({ db: appDb, APP_ENV: 'production' }, { logger: asApp.logger });
    assert.equal(appResult.ready, true, JSON.stringify(appResult.body));
    assert.deepEqual(events(asApp.lines), [], 'rd_app nie jest właścicielem ani superużytkownikiem');

    const asOwner = logged();
    const ownerResult = await checkReadiness({ db, APP_ENV: 'production' }, { logger: asOwner.logger });
    assert.equal(ownerResult.ready, true, 'ostrzeżenie nie zmienia gotowości');
    const warnings = events(asOwner.lines);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].owner, true, 'wynik katalogu pg_class/pg_roles: rola połączenia jest właścicielem schema_migrations');

    const ownerStaging = logged();
    await checkReadiness({ db, APP_ENV: 'staging' }, { logger: ownerStaging.logger });
    assert.deepEqual(events(ownerStaging.lines), [], 'poza produkcją bez ostrzeżenia');
  });
});
