// Niezmienne, zatwierdzane migawki sprawozdania rocznego (#125, migracja 0138).
// Wyłącznie dane syntetyczne, z „pułapką”: e-mail w opisie wpisu nie może trafić do migawki.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../src/postgres-migrations.js';
import { handlePgRequest } from '../src/pg/app.js';
import { canonicalJson, payloadSha256 } from '../src/pg/annual-report.js';
import { buildAuditReport } from '../src/pg/routes/reconciliation.js';
import { request, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const YEAR = 'y-test';
const NEXT = 'y-next';
const TRAP = 'pulapka.rodzic@example.invalid';
const BASE = '/api/reports/annual/snapshots';

const migrationsDirectory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));
let shared = null;
let schemaSeq = 0;
after(async () => { await shared?.close(); });

async function freshDb() {
  shared ??= new PGlite();
  const schema = `report_snapshot_test_${++schemaSeq}`;
  await shared.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};`);
  for (const migration of await loadMigrations(migrationsDirectory)) await shared.exec(migration.sql);
  return { query: (...args) => shared.query(...args), exec: (...args) => shared.exec(...args),
    transaction: (fn) => shared.transaction(fn), close: async () => {} };
}

async function setup({ seed = true } = {}) {
  const db = await freshDb();
  await seedSchoolYear(db, YEAR);
  const grant = (role) => [{ role, schoolYearId: YEAR }];
  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', displayName: 'Skarbnik Testowy', roles: grant('treasurer'), mfa: true }),
    board: await seedUserSession(db, { userId: 'u-board', roles: grant('board'), mfa: true }),
    board2: await seedUserSession(db, { userId: 'u-board2', roles: grant('board'), mfa: true }),
    boardStale: await seedUserSession(db, {
      userId: 'u-board-stale', roles: grant('board'), mfa: true, createdAt: new Date(Date.now() - 20 * 60 * 1000),
    }),
    boardNoMfa: await seedUserSession(db, { userId: 'u-board-nomfa', roles: grant('board'), mfa: false }),
    admin: await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true }),
    audit: await seedUserSession(db, { userId: 'u-audit', roles: grant('audit'), mfa: true }),
    principal: await seedUserSession(db, { userId: 'u-principal', roles: grant('principal'), mfa: true }),
    rep: await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }], mfa: true }),
    otherYearBoard: await seedUserSession(db, { userId: 'u-board-other', roles: [{ role: 'board', schoolYearId: 'y-elsewhere' }], mfa: true }),
  };
  if (seed) await seedLedger(db);
  const call = (path, options = {}) => handlePgRequest(request(path, options), { db });
  const create = (cookie, body = { schoolYearId: YEAR }) => call(BASE, { method: 'POST', cookie, body });
  const approve = (cookie, id) => call(`${BASE}/${id}/approve`, { method: 'POST', cookie, body: {} });
  return { db, cookies, call, create, approve };
}

async function seedLedger(db, { extra = false } = {}) {
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES
    ('cat-dues', $1, 'income', 'Składki dobrowolne', 'u-treasurer'),
    ('cat-trips', $1, 'expense', 'Dofinansowanie wycieczek', 'u-treasurer')`, [YEAR]);
  await db.query(`INSERT INTO ledger_opening_balances (id, school_year_id, amount_cents, cash_cents, created_by, idempotency_key)
    VALUES ('ob-1', $1, 100000, 5000, 'u-treasurer', 'ob-key-0001')`, [YEAR]);
  await addEntry(db, 'le-bank', 'income', 50000, 'cat-dues', '2026-09-10', 'bank');
  await addEntry(db, 'le-cash', 'income', 3000, 'cat-dues', '2026-09-10', 'cash');
  await addEntry(db, 'le-trip', 'expense', 20000, 'cat-trips', '2026-10-20', 'bank');
  if (extra) await addEntry(db, 'le-extra', 'expense', 700, 'cat-trips', '2026-11-02', 'cash');
}

const addEntry = (db, id, direction, cents, category, date, method) => db.query(
  `INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on,
     method, created_by, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'u-treasurer', $9)`,
  [id, YEAR, direction, cents, category, `Wpłata Jan Pułapka ${TRAP} ${id}`, date, method, `le-key-${id}`]);

const count = async (db, table) => Number((await db.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);

test('migawka: JSON bez danych osób, SHA-256 zgodny z treścią, audyt bez treści raportu', async () => {
  const { db, cookies, call, create } = await setup();
  const response = await create(cookies.treasurer);
  assert.equal(response.status, 201);
  const { snapshot, replayed } = await response.json();
  assert.equal(replayed, false);
  assert.match(snapshot.id, /^frs-/);
  assert.equal(snapshot.approvedAt, null);
  assert.equal(snapshot.createdBy, 'u-treasurer');

  const stored = (await db.query('SELECT payload, content_sha256 FROM financial_report_snapshots WHERE id = $1', [snapshot.id])).rows[0];
  assert.equal(stored.content_sha256, snapshot.sha256);
  assert.equal(payloadSha256(stored.payload), stored.content_sha256, 'skrót przeliczony z zapisanej treści (jsonb zmienia kolejność kluczy)');
  assert.equal(payloadSha256(JSON.parse(canonicalJson(stored.payload))), stored.content_sha256);
  assert.equal(stored.payload.generatedAt, undefined);
  const text = JSON.stringify(stored.payload);
  for (const secret of [TRAP, 'Pułapka', 'u-treasurer', 'Skarbnik Testowy', 'le-bank']) assert.ok(!text.includes(secret), secret);

  const events = (await db.query("SELECT actor_id, entity_type, entity_id, metadata_json FROM audit_events WHERE action = 'report.snapshot.created'")).rows;
  assert.equal(events.length, 1);
  assert.equal(events[0].actor_id, 'u-treasurer');
  assert.equal(events[0].entity_id, snapshot.id);
  assert.deepEqual(events[0].metadata_json, { schoolYearId: YEAR, kind: 'annual', sha256: snapshot.sha256, supersedesId: null });

  const read = await call(`${BASE}/${snapshot.id}?format=json`, { cookie: cookies.board });
  assert.equal(read.status, 200);
  assert.deepEqual((await read.json()).report, JSON.parse(JSON.stringify(stored.payload)));
});

test('sumy migawki zgadzają się z ledger_year_summary i z raportem dla KR', async () => {
  const { db, cookies, create } = await setup();
  const { snapshot } = await (await create(cookies.board)).json();
  const { report } = (await db.query('SELECT payload AS report FROM financial_report_snapshots WHERE id = $1', [snapshot.id])).rows[0];
  const summary = (await db.query('SELECT * FROM ledger_year_summary WHERE school_year_id = $1', [YEAR])).rows[0];
  assert.equal(report.balance.closingBalanceCents, Number(summary.closing_balance_cents));
  assert.equal(report.balance.incomeCents, Number(summary.income_cents));
  const audit = await buildAuditReport(db, YEAR);
  for (const key of Object.keys(audit.balance)) assert.equal(report.balance[key], audit.balance[key], `balance.${key}`);
  const kr = (direction) => audit.categories.filter((c) => c.direction === direction).reduce((sum, c) => sum + c.netCents, 0);
  assert.equal(report.income.totalCents, kr('income'));
  assert.equal(report.expense.totalCents, kr('expense'));
  for (const section of ['income', 'expense']) {
    for (const item of report[section].categories) {
      assert.equal(item.netCents, audit.categories.find((c) => c.id === item.categoryId).netCents, item.categoryId);
    }
  }
});

test('podwójne kliknięcie i równoległe tworzenie: jedna migawka, drugie żądanie to replayed', async () => {
  const { db, cookies, create } = await setup();
  const results = await Promise.all([create(cookies.board), create(cookies.board), create(cookies.treasurer), create(cookies.board2)]);
  const bodies = await Promise.all(results.map((response) => response.json()));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 200, 201]);
  assert.equal(new Set(bodies.map((b) => b.snapshot.id)).size, 1);
  assert.equal(bodies.filter((b) => b.replayed).length, 3);
  assert.equal(await count(db, 'financial_report_snapshots'), 1);
  assert.equal((await db.query("SELECT 1 FROM audit_events WHERE action = 'report.snapshot.created'")).rows.length, 1);
});

test('równoległe różne treści bez supersedesId: dokładnie jedna migawka bez poprzednika (indeks w bazie)', async () => {
  const { db } = await setup();
  const insert = (id, sha) => db.query(
    `INSERT INTO financial_report_snapshots (id, school_year_id, payload, content_sha256, created_by)
     VALUES ($1, $2, '{}'::jsonb, $3, 'u-treasurer')`, [id, YEAR, sha.repeat(64)]);
  const outcomes = await Promise.allSettled([insert('frs-a', 'a'), insert('frs-b', 'b')]);
  assert.deepEqual(outcomes.map((o) => o.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(outcomes.find((o) => o.status === 'rejected').reason.code, '23505');
});

test('korekta: nowa migawka wskazuje poprzednią z powodem; brak/zła referencja i cofnięcie do starej treści to 409', async () => {
  const { db, cookies, create } = await setup();
  const first = (await (await create(cookies.treasurer)).json()).snapshot;

  // Ta sama księga, ale rok ma już migawkę: inna treść wymaga supersedesId.
  await addEntry(db, 'le-extra', 'expense', 700, 'cat-trips', '2026-11-02', 'cash');
  const missing = await create(cookies.treasurer);
  assert.equal(missing.status, 409);
  assert.equal((await missing.json()).error, 'report_snapshot_supersedes_required');
  const noReason = await create(cookies.treasurer, { schoolYearId: YEAR, supersedesId: first.id });
  assert.equal(noReason.status, 400);
  assert.equal((await noReason.json()).error, 'invalid_reason');
  const wrong = await create(cookies.treasurer, { schoolYearId: YEAR, supersedesId: 'frs-nie-ma', reason: 'Korekta syntetyczna' });
  assert.equal(wrong.status, 409);
  assert.equal((await wrong.json()).error, 'report_snapshot_superseded');

  // #152: powód zastąpienia to zapis niezmienny — e-mail odrzucony bez obejścia, telefon wymaga potwierdzenia.
  const forbidden = await create(cookies.treasurer, { schoolYearId: YEAR, supersedesId: first.id, reason: `Dodano wydatek ${TRAP}`, confirmPersonalData: true });
  assert.equal(forbidden.status, 422);
  const forbiddenBody = await forbidden.json();
  assert.equal(forbiddenBody.error, 'personal_data_forbidden');
  assert.ok(!JSON.stringify(forbiddenBody).includes('pulapka'));
  const phone = { schoolYearId: YEAR, supersedesId: first.id, reason: 'Dodano wydatek, kontakt +32 470 12 34 56' };
  const needsConfirm = await create(cookies.treasurer, phone);
  assert.equal(needsConfirm.status, 422);
  assert.equal((await needsConfirm.json()).error, 'possible_personal_data');
  assert.equal(await count(db, 'financial_report_snapshots'), 1);

  const second = await create(cookies.treasurer, { ...phone, confirmPersonalData: true });
  assert.equal(second.status, 201);
  const secondBody = (await second.json()).snapshot;
  assert.equal(secondBody.supersedesId, first.id);
  assert.notEqual(secondBody.sha256, first.sha256);
  assert.equal(await count(db, 'financial_report_snapshots'), 2);
  // Powód korekty (wolny tekst) nie trafia do audytu.
  const meta = JSON.stringify((await db.query("SELECT metadata_json FROM audit_events WHERE action = 'report.snapshot.created'")).rows);
  assert.ok(!meta.includes('Dodano wydatek') && !meta.includes(TRAP) && !meta.includes('470 12 34 56'));
  assert.ok(meta.includes('piiConfirmed'), 'audyt zapisuje samo potwierdzenie i kategorie');

  // Pierwsza migawka jest zastąpiona: lista pokazuje następcę, drugi następca tej samej migawki jest odrzucony.
  const list = (await (await handle(db, cookies.board, `${BASE}?schoolYearId=${YEAR}`)).json()).snapshots;
  assert.equal(list.find((s) => s.id === first.id).supersededById, secondBody.id);
  await assert.rejects(db.query(
    `INSERT INTO financial_report_snapshots (id, school_year_id, payload, content_sha256, supersedes_id, supersede_reason, created_by)
     VALUES ('frs-fork', $1, '{}'::jsonb, $2, $3, 'Rozgałęzienie', 'u-treasurer')`, [YEAR, 'c'.repeat(64), first.id]), { code: '23505' });

  // Księga wraca do treści zastąpionej migawki (wpis usunięty poza API, z wyłączonymi triggerami):
  // nowa migawka miałaby skrót już użyty w roku — bez nowego zapisu.
  await db.exec("SET session_replication_role = replica; DELETE FROM ledger_entries WHERE id = 'le-extra'; SET session_replication_role = origin;");
  const revert = await create(cookies.treasurer, { schoolYearId: YEAR, supersedesId: secondBody.id, reason: 'Cofnięcie wydatku' });
  assert.equal(revert.status, 409);
  assert.equal((await revert.json()).error, 'report_snapshot_content_exists');
  assert.equal(await count(db, 'financial_report_snapshots'), 2);
});

const handle = (db, cookie, path) => handlePgRequest(request(path, { cookie }), { db });

test('zatwierdzenie: ta sama osoba 403, inna osoba z zarządu 201, podwójne kliknięcie to jedno zatwierdzenie', async () => {
  const { db, cookies, create, approve } = await setup();
  const { snapshot } = await (await create(cookies.board)).json();

  const self = await approve(cookies.board, snapshot.id);
  assert.equal(self.status, 403);
  assert.equal((await self.json()).error, 'four_eyes_required');
  assert.equal(await count(db, 'financial_report_snapshot_approvals'), 0);

  const results = await Promise.all([approve(cookies.board2, snapshot.id), approve(cookies.board2, snapshot.id)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
  const approved = (await results.find((r) => r.status === 201).json()).snapshot;
  assert.equal(approved.approvedBy, 'u-board2');
  assert.ok(approved.approvedAt);
  assert.equal(await count(db, 'financial_report_snapshot_approvals'), 1);
  const events = (await db.query("SELECT actor_id, metadata_json FROM audit_events WHERE action = 'report.snapshot.approved'")).rows;
  assert.equal(events.length, 1);
  assert.equal(events[0].actor_id, 'u-board2');
  assert.equal(events[0].metadata_json.sha256, snapshot.sha256);
});

test('zatwierdzenie: skarbnik, admin, audit, principal, przedstawiciel, brak MFA, nieświeże MFA, inny rok i anonim', async () => {
  const { db, cookies, create, approve } = await setup();
  const { snapshot } = await (await create(cookies.treasurer)).json();
  for (const key of ['treasurer', 'admin', 'audit', 'principal', 'rep', 'boardNoMfa', 'otherYearBoard']) {
    const response = await approve(cookies[key], snapshot.id);
    assert.equal(response.status, 403, `${key} ${await response.clone().text()}`);
  }
  const stale = await approve(cookies.boardStale, snapshot.id);
  assert.equal(stale.status, 403);
  assert.equal((await stale.json()).error, 'mfa_stale');
  assert.equal((await approve(undefined, snapshot.id)).status, 401);
  assert.equal(await count(db, 'financial_report_snapshot_approvals'), 0);
  // Aktor z rolą, ale bez roku migawki: 403; nieistniejąca migawka dla zarządu: 404 (dla admina 403, bez wyroczni).
  assert.equal((await approve(cookies.board2, 'frs-nie-ma')).status, 404);
  assert.equal((await approve(cookies.admin, 'frs-nie-ma')).status, 403);
  assert.equal((await approve(cookies.board2, 'nie ma/x')).status, 404);
});

test('odczyt i tworzenie: granice ról, zakres roku, MFA; odmowa nic nie zapisuje', async () => {
  const { db, cookies, call, create } = await setup();
  const { snapshot } = await (await create(cookies.board)).json();
  const before = { snapshots: await count(db, 'financial_report_snapshots'), audit: await count(db, 'audit_events') };
  for (const key of ['admin', 'audit', 'principal', 'rep', 'boardNoMfa', 'otherYearBoard']) {
    assert.equal((await create(cookies[key])).status, 403, `create ${key}`);
    assert.equal((await call(`${BASE}?schoolYearId=${YEAR}`, { cookie: cookies[key] })).status, 403, `list ${key}`);
    assert.equal((await call(`${BASE}/${snapshot.id}`, { cookie: cookies[key] })).status, 403, `read ${key}`);
  }
  assert.equal((await create(undefined)).status, 401);
  assert.equal((await call(`${BASE}/${snapshot.id}`)).status, 401);
  assert.equal((await call(`${BASE}/${snapshot.id}?format=pdf`, { cookie: cookies.board })).status, 400);
  assert.equal((await create(cookies.board, { schoolYearId: 'y-brak' })).status, 403);
  assert.equal((await create(cookies.board, { schoolYearId: 'zły id!' })).status, 400);
  assert.equal(await count(db, 'financial_report_snapshots'), before.snapshots);
  assert.equal(await count(db, 'audit_events'), before.audit);
  for (const cookie of [cookies.board, cookies.treasurer]) {
    assert.equal((await call(`${BASE}/${snapshot.id}`, { cookie })).status, 200);
  }
  assert.equal((await call(`${BASE}/frs-nie-ma`, { cookie: cookies.board })).status, 404);
  const put = await call(BASE, { method: 'PUT', cookie: cookies.board, body: {} });
  assert.equal(put.status, 405);
});

test('druk HTML migawki: zatwierdzona, niezatwierdzona i zastąpiona; ucieczka znaków, CSP, bez skryptów i danych osób', async () => {
  const { db, cookies, call, create, approve } = await setup();
  const first = (await (await create(cookies.treasurer)).json()).snapshot;
  const html = async (id) => call(`${BASE}/${id}?format=html`, { cookie: cookies.board });
  let response = await html(first.id);
  assert.equal(response.status, 200);
  let text = await response.text();
  assert.match(response.headers.get('Content-Security-Policy'), /default-src 'none'/);
  assert.doesNotMatch(text, /<script/i);
  assert.match(text, /Migawka niezatwierdzona/);
  assert.ok(text.includes(first.sha256));
  for (const secret of [TRAP, 'Pułapka', 'u-treasurer']) assert.ok(!text.includes(secret));

  assert.equal((await approve(cookies.board2, first.id)).status, 201);
  text = await (await html(first.id)).text();
  assert.match(text, /Wersja zatwierdzona przez zarząd/);

  await addEntry(db, 'le-extra', 'expense', 700, 'cat-trips', '2026-11-02', 'cash');
  const second = (await (await create(cookies.treasurer, { schoolYearId: YEAR, supersedesId: first.id, reason: 'Dodano wydatek' })).json()).snapshot;
  text = await (await html(first.id)).text();
  assert.match(text, /Wersja zastąpiona/);
  assert.match(await (await html(second.id)).text(), /Migawka niezatwierdzona/);
  // Zatwierdzenie zastąpionej migawki jest odrzucone (API i baza).
  const late = await approve(cookies.board2, first.id);
  assert.equal(late.status, 200, 'już zatwierdzona: powtórka bez zapisu');
  const stale = await approve(cookies.board2, second.id);
  assert.equal(stale.status, 201);
});

test('niezmienność: korekta księgi po zatwierdzeniu nie zmienia migawki; UPDATE, DELETE i TRUNCATE odrzucone', async () => {
  const { db, cookies, call, create, approve } = await setup();
  const { snapshot } = await (await create(cookies.treasurer)).json();
  assert.equal((await approve(cookies.board, snapshot.id)).status, 201);
  const before = await (await call(`${BASE}/${snapshot.id}`, { cookie: cookies.board })).text();

  // Korekta księgi po zatwierdzeniu (rok jeszcze otwarty): raport bieżący się zmienia, migawka nie.
  await db.query("INSERT INTO ledger_corrections (id, ledger_entry_id, amount_cents, reason, created_by, idempotency_key) VALUES ('lc-1', 'le-bank', 5000, 'Korekta syntetyczna', 'u-treasurer', 'lc-key-1')");
  const live = (await (await call(`/api/reports/annual?schoolYearId=${YEAR}`, { cookie: cookies.board })).json()).report;
  const stored = JSON.parse(before).report;
  assert.notEqual(live.balance.closingBalanceCents, stored.balance.closingBalanceCents);
  assert.equal(await (await call(`${BASE}/${snapshot.id}`, { cookie: cookies.board })).text(), before);

  for (const sql of [
    "UPDATE financial_report_snapshots SET payload = '{}'::jsonb WHERE id = $1",
    'DELETE FROM financial_report_snapshots WHERE id = $1',
    "UPDATE financial_report_snapshot_approvals SET approved_by = 'u-board' WHERE snapshot_id = $1",
    'DELETE FROM financial_report_snapshot_approvals WHERE snapshot_id = $1',
  ]) await assert.rejects(db.query(sql, [snapshot.id]), /cannot_be_changed/, sql);
  for (const table of ['financial_report_snapshots', 'financial_report_snapshot_approvals']) {
    await assert.rejects(db.query(`TRUNCATE ${table} CASCADE`), /truncate_not_allowed/, table);
  }
  assert.equal(await count(db, 'financial_report_snapshots'), 1);

  // Naruszona treść (obejście triggera przez superużytkownika) jest wykrywana przy odczytach.
  await db.exec('ALTER TABLE financial_report_snapshots DISABLE TRIGGER financial_report_snapshots_no_change');
  await db.query("UPDATE financial_report_snapshots SET payload = jsonb_set(payload, '{balance,closingBalanceCents}', '1') WHERE id = $1", [snapshot.id]);
  await db.exec('ALTER TABLE financial_report_snapshots ENABLE TRIGGER financial_report_snapshots_no_change');
  const tampered = await call(`${BASE}/${snapshot.id}`, { cookie: cookies.board });
  assert.equal(tampered.status, 500);
  assert.equal((await tampered.json()).error, 'report_snapshot_integrity_failed');
});

test('baza pilnuje zasady dwóch osób i łańcucha, także przy zapisie poza API', async () => {
  const { db, cookies, create } = await setup();
  const { snapshot } = await (await create(cookies.treasurer)).json();
  const approval = (by) => db.query(
    'INSERT INTO financial_report_snapshot_approvals (snapshot_id, school_year_id, approved_by) VALUES ($1, $2, $3)', [snapshot.id, YEAR, by]);
  await assert.rejects(approval('u-treasurer'), /report_snapshot_four_eyes/);
  await assert.rejects(db.query(
    'INSERT INTO financial_report_snapshot_approvals (snapshot_id, school_year_id, approved_by) VALUES ($1, $2, $3)', [snapshot.id, 'inny-rok', 'u-board']),
  /report_snapshot_not_found/);
  await addEntry(db, 'le-extra', 'expense', 700, 'cat-trips', '2026-11-02', 'cash');
  assert.equal((await create(cookies.treasurer, { schoolYearId: YEAR, supersedesId: snapshot.id, reason: 'Korekta syntetyczna' })).status, 201);
  await assert.rejects(approval('u-board'), /report_snapshot_superseded/);
  await seedSchoolYear(db, 'y-other');
  await assert.rejects(db.query(
    `INSERT INTO financial_report_snapshots (id, school_year_id, payload, content_sha256, supersedes_id, supersede_reason, created_by)
     VALUES ('frs-x', 'y-other', '{}'::jsonb, $1, $2, 'Inny rok', 'u-treasurer')`, ['d'.repeat(64), snapshot.id]), /report_snapshot_supersedes_mismatch/);
  await assert.rejects(db.query(
    `INSERT INTO financial_report_snapshots (id, school_year_id, payload, content_sha256, created_by)
     VALUES ('frs-y', $1, '{}'::jsonb, 'nie-skrot', 'u-treasurer')`, [YEAR]), { code: '23514' });
});

test('zamknięty rok: nowa migawka i zatwierdzenie odrzucone (409), odczyt istniejącej działa', async () => {
  const { db, cookies, call, create, approve } = await setup();
  const { snapshot } = await (await create(cookies.treasurer)).json();
  await seedSchoolYear(db, NEXT, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  await db.exec(`
    SET session_replication_role = replica;
    INSERT INTO school_year_closures (id, school_year_id, next_school_year_id, status, initiated_by,
      closed_by, closed_at, income_cents, expense_cents, opening_balance_cents, closing_balance_cents,
      carried_opening_balance_id, expired_grant_count)
    VALUES ('clo-1', '${YEAR}', '${NEXT}', 'closed', 'u-a', 'u-b', now(), 0, 0, 0, 0, 'ob-next', 0);
    SET session_replication_role = origin;
  `);
  const created = await create(cookies.board);
  assert.equal(created.status, 200, 'ta sama treść: powtórka bez zapisu');
  await addEntryClosed(db);
  const rejected = await create(cookies.board, { schoolYearId: YEAR, supersedesId: snapshot.id, reason: 'Po zamknięciu' });
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).error, 'school_year_closed');
  const blocked = await approve(cookies.board2, snapshot.id);
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error, 'school_year_closed');
  assert.equal(await count(db, 'financial_report_snapshots'), 1);
  assert.equal(await count(db, 'financial_report_snapshot_approvals'), 0);
  assert.equal((await call(`${BASE}/${snapshot.id}`, { cookie: cookies.board })).status, 200);
});

// Wpis po zamknięciu roku wprost w bazie (poza API), by zmienić treść raportu bez triggera zamrożenia.
async function addEntryClosed(db) {
  await db.exec('SET session_replication_role = replica;');
  await addEntry(db, 'le-late', 'expense', 100, 'cat-trips', '2026-11-03', 'bank');
  await db.exec('SET session_replication_role = origin;');
}

test('rok bez wpisów i bez preliminarza: migawka z pustymi sekcjami', async () => {
  const { cookies, call, create } = await setup({ seed: false });
  const { snapshot } = await (await create(cookies.board)).json();
  const { report } = await (await call(`${BASE}/${snapshot.id}`, { cookie: cookies.board })).json();
  assert.deepEqual(report.income, { categories: [], totalCents: 0, plannedCents: null });
  assert.equal(report.balance.closingBalanceCents, 0);
});

test('lista kontrolna zamknięcia: punkt financial_report wskazuje tylko zatwierdzoną, bieżącą migawkę tego roku', async () => {
  const { db, cookies, call, create, approve } = await setup();
  await seedSchoolYear(db, NEXT, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  const start = await call(`/api/year-close/${YEAR}/start`, { method: 'POST', cookie: cookies.board, body: { nextSchoolYearId: NEXT } });
  assert.equal(start.status, 201, await start.clone().text());
  const confirm = (body, cookie = cookies.treasurer) => call(`/api/year-close/${YEAR}/checklist/financial_report`, { method: 'POST', cookie, body });
  const { snapshot } = await (await create(cookies.treasurer)).json();

  for (const body of [{ reportSnapshotId: snapshot.id }, { reportSnapshotId: 'frs-nie-ma' }]) {
    const rejected = await confirm(body);
    assert.equal(rejected.status, 400, JSON.stringify(body));
    assert.equal((await rejected.json()).error, 'invalid_report_snapshot');
  }
  const other = await call(`/api/year-close/${YEAR}/checklist/minutes_approved`, {
    method: 'POST', cookie: cookies.treasurer, body: { reportSnapshotId: snapshot.id },
  });
  assert.equal(other.status, 400, 'migawka tylko przy punkcie financial_report');
  assert.equal((await approve(cookies.board2, snapshot.id)).status, 201);
  const ok = await confirm({ reportSnapshotId: snapshot.id, note: 'Sprawozdanie zatwierdzone' });
  assert.equal(ok.status, 201, await ok.clone().text());
  const item = (await ok.json()).checklist.find((entry) => entry.item === 'financial_report');
  assert.equal(item.reportSnapshotId, snapshot.id);
  const audit = (await db.query("SELECT metadata_json FROM audit_events WHERE action = 'year_close.checklist_confirmed'")).rows[0];
  assert.equal(audit.metadata_json.reportSnapshotId, snapshot.id);
});
