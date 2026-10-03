// #174: zdarzenia audytu trafiają do eksportu ROKU OBIEKTU, nie roku daty zapisu.
// Późna wpłata za rok poprzedni (zapisana po jego końcu), korekta i uzgodnienie na przełomie roku,
// zdarzenia historyczne bez schoolYearId oraz zdarzenia bez roku (sesje). PGlite, dane syntetyczne.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { auditScope, buildYearlyExport, EXPORT_TABLES, restoreBundle, verifyBundle } from '../src/pg/export.js';
import { createTestDb, request, seedEnrolledHousehold, seedSchoolYear, seedUser, seedUserSession, ownerDb } from './helpers/pg.js';
import { assertEvery } from './helpers/assertions.js';

const OLD = 'y-old';
const NEW = 'y-new';
// Rok następny (zaczyna się za 336 dni): kampanię dla niego przygotowuje się w bieżącym roku.
const NEXT = 'y-next';
const DAY = 24 * 3600 * 1000;
const isoDate = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

let db;
let cookie;
let keySeq = 0;
const key = (prefix) => `${prefix}-${String(++keySeq).padStart(6, '0')}`;
const ids = {};

async function call(method, path, body, idempotencyKey) {
  const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
  const response = await handlePgRequest(request(path, { method, cookie, body, headers }), { db });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function auditOf(schoolYearId) {
  const { bundle } = await buildYearlyExport(db, schoolYearId);
  return (bundle.files['audit_events.jsonl'] ?? '').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const auditOfBundle = (bundle) => (bundle.files['audit_events.jsonl'] ?? '').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const actions = (rows) => rows.map((row) => row.action);

before(async () => {
  db = await createTestDb();
  // Rok poprzedni skończył się 30 dni temu; nowy trwa (dziś należy do nowego roku wg daty zapisu).
  await seedSchoolYear(db, OLD, { startsOn: isoDate(-400), endsOn: isoDate(-30) });
  await seedSchoolYear(db, NEW, { startsOn: isoDate(-29), endsOn: isoDate(335) });
  await seedSchoolYear(db, NEXT, { startsOn: isoDate(336), endsOn: isoDate(700) });
  await seedUser(db, { userId: 'u-seed' });
  await seedEnrolledHousehold(db, 'h-1', [OLD, NEW]);
  cookie = await seedUserSession(db, {
    userId: 'u-treasurer', mfa: true,
    roles: [{ role: 'treasurer', schoolYearId: OLD }, { role: 'treasurer', schoolYearId: NEW }, { role: 'treasurer', schoolYearId: NEXT }],
  });
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by)
    VALUES ('cat-old', '${OLD}', 'income', 'Dobrowolne wpłaty', 'u-seed')`);
  await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on, method, created_by, idempotency_key)
    VALUES ('le-old', '${OLD}', 'income', 20000, 'cat-old', 'Wpływ przelewem', '${isoDate(-60)}', 'bank', 'u-seed', 'ledger-key-old-0001')`);

  // Późna wpłata za rok poprzedni (otrzymana przed końcem roku, zapisana dziś), wpłata częściowa, korekta, przypisanie.
  const created = await call('POST', '/api/payments',
    { schoolYearId: OLD, receivedOn: isoDate(-31), amountCents: 5000, method: 'bank' }, key('pay'));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ids.payment = created.body.payment.id;
  assert.equal((await call('POST', `/api/payments/${ids.payment}/corrections`,
    { amountCents: 1000, reason: 'Korekta syntetyczna' }, key('corr'))).status, 201);
  assert.equal((await call('POST', `/api/payments/${ids.payment}/assignment`, { householdId: 'h-1' }, key('asg'))).status, 201);
  // Podwójne kliknięcie: to samo `Idempotency-Key` nie tworzy drugiego zdarzenia.
  const dupKey = key('pay');
  const first = await call('POST', '/api/payments', { schoolYearId: OLD, receivedOn: isoDate(-32), amountCents: 700, method: 'cash' }, dupKey);
  const second = await call('POST', '/api/payments', { schoolYearId: OLD, receivedOn: isoDate(-32), amountCents: 700, method: 'cash' }, dupKey);
  assert.deepEqual([first.status, second.status], [201, 200]);

  // Wpłata nowego roku zapisana dziś — w eksporcie nowego roku.
  const fresh = await call('POST', '/api/payments',
    { schoolYearId: NEW, receivedOn: isoDate(-1), amountCents: 2500, method: 'bank' }, key('pay'));
  assert.equal(fresh.status, 201);
  ids.freshPayment = fresh.body.payment.id;

  // Uzgodnienie wyciągu z końca starego roku, wykonane w nowym (na przełomie roku).
  const rec = await call('POST', '/api/reconciliations',
    { schoolYearId: OLD, statementDate: isoDate(-30), statementBalanceCents: 20000 }, key('rec'));
  assert.equal(rec.status, 201, JSON.stringify(rec.body));
  ids.reconciliation = rec.body.reconciliation.id;
  assert.equal((await call('POST', `/api/reconciliations/${ids.reconciliation}/lines`,
    { lines: [{ bookedOn: isoDate(-40), amountCents: 20000, reference: 'Tytuł syntetyczny' }] }, key('lines'))).status, 201);
  const detail = await call('GET', `/api/reconciliations/${ids.reconciliation}`);
  const match = await call('POST', `/api/reconciliations/${ids.reconciliation}/matches`,
    { statementLineId: detail.body.lines[0].id, ledgerEntryId: 'le-old' }, key('match'));
  assert.equal(match.status, 201, JSON.stringify(match.body));
});

after(async () => { await db?.close(); });

test('zapis dziś (nowy rok wg daty) — zdarzenia roku poprzedniego są w jego eksporcie, nie w nowym', async () => {
  const stamped = (await db.query("SELECT count(*)::int AS n FROM audit_events WHERE occurred_at > now() - interval '1 hour' AND action LIKE 'payment.%'")).rows[0].n;
  assert.ok(stamped >= 5, 'zdarzenia zapisane dziś');
  const old = await auditOf(OLD);
  const fresh = await auditOf(NEW);
  const oldFinancial = old.filter((row) => /^(payment|reconciliation)\./.test(row.action));
  assert.deepEqual(actions(oldFinancial).filter((a) => a.startsWith('payment.')).sort(),
    ['payment.assigned', 'payment.correction.created', 'payment.created', 'payment.created']);
  assert.ok(actions(oldFinancial).includes('reconciliation.created'));
  assert.ok(actions(oldFinancial).includes('reconciliation.lines.imported'));
  assert.ok(actions(oldFinancial).includes('reconciliation.match.confirmed'));
  assert.deepEqual(actions(fresh.filter((row) => /^(payment|reconciliation)\./.test(row.action))), ['payment.created']);
  assert.equal(fresh.find((row) => row.action === 'payment.created').entity_id, ids.freshPayment);
});

test('kampania przygotowana w bieżącym roku dla roku następnego: zdarzenie w eksporcie roku następnego', async () => {
  // Odpowiednik „kampania przygotowana w sierpniu dla nowego roku” (#174): data zapisu należy
  // do roku NEW, obiekt (kampania) do NEXT. Podwójne kliknięcie — jedno zdarzenie.
  const campaignKey = key('camp');
  const body = {
    schoolYearId: NEXT, title: 'Przypomnienie jesienne', audience: 'all_households', subject: 'Dobrowolna składka {rok}',
    bodyText: 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}. Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.',
  };
  const first = await call('POST', '/api/email/campaigns', body, campaignKey);
  const second = await call('POST', '/api/email/campaigns', body, campaignKey);
  assert.deepEqual([first.status, second.status], [201, 200], JSON.stringify(first.body));
  const id = first.body.campaign.id;
  const created = (rows) => rows.filter((row) => row.action === 'email.campaign.created' && row.entity_id === id);
  assert.equal(created(await auditOf(NEXT)).length, 1);
  assert.equal(created(await auditOf(NEW)).length, 0);
  assert.equal(created(await auditOf(OLD)).length, 0);
});

test('podwójne kliknięcie: jedno zdarzenie w roku obiektu', async () => {
  assert.equal(await db.query("SELECT count(*)::int AS n FROM payment_entries WHERE amount_cents = 700").then((r) => r.rows[0].n), 1);
  const old = await auditOf(OLD);
  assert.equal(old.filter((row) => row.action === 'payment.created').length, 2);
});

test('meta-test: każde zdarzenie payment./ledger./reconciliation. niesie schoolYearId zgodny z wierszem obiektu', async () => {
  const { rows } = await db.query(
    `SELECT action, entity_type, entity_id, metadata_json->>'schoolYearId' AS year FROM audit_events
      WHERE action ~ '^(payment|ledger|reconciliation)\\.'`);
  assert.ok(rows.length >= 8);
  for (const row of rows) assert.ok(row.year, `${row.action} bez schoolYearId`);
  const paymentYears = (await db.query('SELECT id, school_year_id FROM payment_entries')).rows;
  for (const p of paymentYears) {
    const ev = rows.find((row) => row.action === 'payment.created' && row.entity_id === p.id);
    assert.equal(ev.year, p.school_year_id);
  }
  const rec = rows.filter((row) => row.action.startsWith('reconciliation.'));
  assertEvery(rec, (row) => row.year === OLD);
});

test('zdarzenia historyczne bez schoolYearId: rok obiektu, nie data zapisu; brak roku — wg daty i bez utraty', async () => {
  // Stare zdarzenia (sprzed #387) zapisane dziś, bez roku w metadanych.
  const legacy = [
    ['lg-pay', 'payment.created', 'payment_entry', ids.payment],
    ['lg-corr', 'payment.correction.created', 'payment_correction', (await db.query('SELECT id FROM payment_corrections LIMIT 1')).rows[0].id],
    ['lg-match', 'reconciliation.match.confirmed', 'bank_reconciliation_match', (await db.query('SELECT id FROM bank_reconciliation_matches LIMIT 1')).rows[0].id],
    ['lg-fresh', 'payment.created', 'payment_entry', ids.freshPayment],
    // Obiekt bez roku (sesja): zostaje wg daty zdarzenia.
    ['lg-session-now', 'session.created', 'session', 'sess-synthetic-1'],
    ['lg-session-old', 'session.created', 'session', 'sess-synthetic-2'],
    // Obiekt nieznany (usunięty/nieosiągalny) typu rocznego: także wg daty (zachowawczo), nie ginie.
    ['lg-orphan', 'payment.created', 'payment_entry', 'p-nieistniejaca'],
  ];
  // #204 (0144): occurred_at jest stemplowany zegarem bazy; historyczna data zapisu
  // (odtworzenie starego dziennika) jest możliwa wyłącznie w trybie odtworzenia.
  await db.query('BEGIN');
  await db.query(`SET LOCAL rd.restore = 'on'`);
  for (const [id, action, entityType, entityId] of legacy) {
    const at = id === 'lg-session-old' ? `${isoDate(-100)}T10:00:00Z` : new Date().toISOString();
    await db.query(
      `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, metadata_json, occurred_at)
       VALUES ($1, 'u-treasurer', $2, $3, $4, '{}'::jsonb, $5)`, [id, action, entityType, entityId, at]);
  }
  await db.query('COMMIT');
  const old = new Set((await auditOf(OLD)).map((row) => row.id));
  const fresh = new Set((await auditOf(NEW)).map((row) => row.id));
  for (const id of ['lg-pay', 'lg-corr', 'lg-match', 'lg-session-old']) assert.ok(old.has(id), `${id} w roku starym`);
  for (const id of ['lg-pay', 'lg-corr', 'lg-match', 'lg-session-old']) assert.ok(!fresh.has(id), `${id} nie w nowym`);
  for (const id of ['lg-fresh', 'lg-session-now', 'lg-orphan']) assert.ok(fresh.has(id), `${id} w roku nowym`);
  for (const id of ['lg-fresh', 'lg-session-now', 'lg-orphan']) assert.ok(!old.has(id), `${id} nie w starym`);
  // Każde zdarzenie trafia dokładnie do jednego z dwóch rozłącznych lat (brak duplikatów i strat).
  for (const [id] of legacy) assert.equal(Number(old.has(id)) + Number(fresh.has(id)), 1, id);
});

test('zdarzenie z schoolYearId nie jest dołączane według daty do innego roku', async () => {
  await db.query(
    `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, metadata_json, occurred_at)
     VALUES ('ev-marked', 'u-treasurer', 'ledger.entry.created', 'ledger_entry', 'le-old', $1::jsonb, now())`,
    [JSON.stringify({ schoolYearId: OLD })]);
  assert.ok((await auditOf(OLD)).some((row) => row.id === 'ev-marked'));
  assert.ok(!(await auditOf(NEW)).some((row) => row.id === 'ev-marked'));
});

test('auditScope bez tabel modułów: typy bez tabeli spadają na datę, SQL pozostaje poprawny', async () => {
  const sql = auditScope(new Set(['school_years']));
  assert.ok(!sql.includes('payment_entries'));
  const spec = EXPORT_TABLES.find((t) => t.table === 'audit_events');
  assert.equal(typeof spec.where(new Set(['payment_entries'])), 'string');
  await db.query(`SELECT id FROM audit_events WHERE ${sql}`, [OLD]);
});

test('paczka roku poprzedniego przechodzi weryfikację, a ponowny eksport daje ten sam wynik', async () => {
  const first = await buildYearlyExport(db, OLD);
  verifyBundle(first.bundle);
  const again = await buildYearlyExport(db, OLD);
  assert.equal(again.manifestSha256, first.manifestSha256);
});

test('odtworzenie paczki roku poprzedniego: zdarzenia roku obiektu (także stare bez roku) wracają, a re-eksport jest identyczny', async () => {
  const { bundle } = await buildYearlyExport(db, OLD);
  const target = await createTestDb();
  try {
    // Odtworzenie paczki to operacja operatora na DATABASE_MIGRATION_URL (właściciel; SR-05).
    const report = await restoreBundle(ownerDb(target), bundle);
    assert.equal(report.restored, true);
    assert.equal(report.reexportFilesMatch, true);
    const restored = (await buildYearlyExport(target, OLD)).bundle;
    assert.equal(restored.files['audit_events.jsonl'], bundle.files['audit_events.jsonl']);
    const rows = auditOfBundle(restored);
    const paymentActions = actions(rows).filter((a) => a.startsWith('payment.'));
    assert.ok(paymentActions.includes('payment.created') && paymentActions.includes('payment.correction.created'));
    // Stare zdarzenia bez roku (lg-pay, lg-corr, lg-match) po odtworzeniu nadal przypisane do roku obiektu.
    const restoredIds = new Set(rows.map((row) => row.id));
    for (const id of ['lg-pay', 'lg-corr', 'lg-match']) assert.ok(restoredIds.has(id), `${id} po odtworzeniu`);
    // Zdarzenia nowego roku nie wracają do paczki starego roku.
    assert.ok(!restoredIds.has('lg-fresh'));
    assert.ok(!rows.some((row) => row.entity_id === ids.freshPayment));
  } finally {
    await target.close();
  }
});
