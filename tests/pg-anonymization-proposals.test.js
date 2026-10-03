// #91: „propozycja do zatwierdzenia” — raport kandydatów do anonimizacji z polityki
// retencji (src/pg/anonymization-proposals.js, scripts/anonymization-proposals.js).
// Raport jest wyłącznie odczytem: niczego nie wykonuje, nie ma harmonogramu, a
// wykonanie zostaje ręczne (istniejąca trasa POST /api/admin/anonymizations).
// Wskazanie użytkownika 2026-10-02 (D-04): bez automatycznego usuwania.
// Wyłącznie dane syntetyczne (.invalid); znaczniki MRK-* nie mogą trafić do raportu.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { handlePgRequest } from '../src/pg/app.js';
import { proposeRetentionAnonymizations } from '../src/pg/anonymization-proposals.js';
import { renderProposalsText, runProposalsCli } from '../scripts/anonymization-proposals.js';
import { assertCaptured, assertEvery } from './helpers/assertions.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';

const OLD_YEAR = 'y-prop-old';
const NEW_YEAR = 'y-prop-new';
const CATEGORIES = ['guardian_contact', 'student_identity', 'email_snapshot', 'payment_reference'];
const MARKERS = ['MRK-OPIEKUN-A', 'MRK-OPIEKUN-B', 'MRK-UCZEN-1', 'MRK-UCZEN-2', 'MRK-TYTUL-1A', 'MRK-NOWY', 'opiekun-a@example.invalid', 'Anna', 'Ola'];

async function seed(db) {
  await seedSchoolYear(db, OLD_YEAR, { startsOn: '2020-09-01', endsOn: '2021-08-31' });
  await seedSchoolYear(db, NEW_YEAR, { startsOn: '2090-09-01', endsOn: '2091-08-31' });
  await seedClass(db, { id: 'c-prop-old', schoolYearId: OLD_YEAR, name: '1A' });
  await seedClass(db, { id: 'c-prop-new', schoolYearId: NEW_YEAR, name: '1A' });
  await seedUser(db, { userId: 'u-skarbnik-seed' });
  await db.exec(`
    INSERT INTO households (id) VALUES ('h-1'), ('h-2'), ('h-x'), ('h-new'), ('h-done');
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
      ('g-a', 'h-1', 'Anna', 'MRK-OPIEKUN-A', 'opiekun-a@example.invalid', true),
      ('g-b', 'h-2', 'Bartek', 'MRK-OPIEKUN-B', 'opiekun-b@example.invalid', true),
      ('g-x', 'h-x', 'Olga', 'MRK-OBCY', 'obcy@example.invalid', true),
      ('g-new', 'h-new', 'Nowa', 'MRK-NOWY', 'nowy@example.invalid', true),
      ('g-done', 'h-done', '[zanonimizowano]', '[zanonimizowano]', NULL, false);
    INSERT INTO students (id, household_id, first_name, last_name) VALUES
      ('s-1', 'h-1', 'Ola', 'MRK-UCZEN-1'), ('s-2', 'h-1', 'Jan', 'MRK-UCZEN-2'), ('s-3', 'h-2', 'Iga', 'MRK-UCZEN-3'),
      ('s-x', 'h-x', 'Kuba', 'MRK-OBCE-DZIECKO'), ('s-new', 'h-new', 'Zofia', 'MRK-NOWY-UCZEN'),
      ('s-done', 'h-done', '[zanonimizowano]', '[zanonimizowano]');
    INSERT INTO student_households (id, student_id, household_id, is_primary, source) VALUES ('sh-1-h2', 's-1', 'h-2', false, 'api');
    INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES
      ('s-1', 'g-a', true, true), ('s-2', 'g-a', true, true), ('s-1', 'g-b', true, false), ('s-3', 'g-b', true, true),
      ('s-x', 'g-x', true, true), ('s-new', 'g-new', true, true), ('s-done', 'g-done', false, true);
    INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
      ('e-1', 's-1', 'c-prop-old', '${OLD_YEAR}'), ('e-2', 's-2', 'c-prop-old', '${OLD_YEAR}'), ('e-3', 's-3', 'c-prop-old', '${OLD_YEAR}'),
      ('e-x', 's-x', 'c-prop-old', '${OLD_YEAR}'), ('e-done', 's-done', 'c-prop-old', '${OLD_YEAR}'),
      ('e-new', 's-new', 'c-prop-new', '${NEW_YEAR}');
    INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, reference, status, created_by, idempotency_key) VALUES
      ('p-1a', 'h-1', '${OLD_YEAR}', 2000, '2020-10-01', 'bank', 'Składka MRK-TYTUL-1A', 'recorded', 'u-skarbnik-seed', 'p-1a-key-0001'),
      ('p-2', 'h-2', '${OLD_YEAR}', 1234, '2020-10-06', 'bank', 'MRK-TYTUL-H2', 'recorded', 'u-skarbnik-seed', 'p-2-key-00001'),
      ('p-x', 'h-x', '${OLD_YEAR}', 777, '2020-10-08', 'bank', 'MRK-TYTUL-HX', 'recorded', 'u-skarbnik-seed', 'p-x-key-00001'),
      ('p-new', 'h-new', '${NEW_YEAR}', 900, '2090-10-08', 'bank', 'MRK-NOWY-TYTUL', 'recorded', 'u-skarbnik-seed', 'p-new-key-0001'),
      ('p-done', 'h-done', '${OLD_YEAR}', 100, '2020-10-09', 'bank', NULL, 'recorded', 'u-skarbnik-seed', 'p-done-key-001');
  `);
}

async function addPolicies(db, { retainFor = '1 year', approvedBy = 'u-approver', rule = null, categories = CATEGORIES } = {}) {
  await seedUser(db, { userId: 'u-author' });
  await seedUser(db, { userId: 'u-approver' });
  for (const [index, category] of categories.entries()) {
    await db.query(
      `INSERT INTO retention_policies (id, data_category, retain_for, retain_until_rule, decision_ref, created_by, approved_by, effective_from)
       VALUES ($1, $2, $3::interval, $4, 'D-04/uchwała-testowa', 'u-author', $5, now() - interval '1 day')`,
      [`rp-${index}`, category, rule ? null : retainFor, rule, approvedBy],
    );
  }
}

async function freshDb() {
  const db = await createTestDb();
  await seed(db);
  return db;
}

async function stateOf(db) {
  const q = async (sql) => (await db.query(sql)).rows;
  return {
    guardians: await q('SELECT id, first_name, last_name, email, contact_allowed FROM guardians ORDER BY id'),
    students: await q('SELECT id, first_name, last_name FROM students ORDER BY id'),
    references: await q('SELECT id, reference FROM payment_entries ORDER BY id'),
    audit: (await q('SELECT count(*)::int AS n FROM audit_events'))[0].n,
    runs: (await q('SELECT count(*)::int AS n FROM anonymization_runs'))[0].n,
    totals: await q('SELECT household_id, net_amount_cents::int AS net FROM household_payment_totals ORDER BY 1'),
  };
}

function captureStream() {
  return { text: '', write(chunk) { this.text += chunk; return true; } };
}

const withDb = (fn) => async () => {
  const db = await freshDb();
  try { await fn(db); } finally { await db.close(); }
};

test('bez polityk raport mówi „brak polityk”, nikogo nie wskazuje i niczego nie zmienia (D-04 nieustalone)', withDb(async (db) => {
  const before = await stateOf(db);
  const report = await proposeRetentionAnonymizations(db);
  assert.equal(report.status, 'no_policies');
  assert.equal(report.summary, 'brak polityk');
  assert.equal(report.reasonCode, 'retention_policy_missing');
  assert.equal(report.execution, 'none');
  assert.deepEqual(report.candidates, []);
  assert.deepEqual(await stateOf(db), before);

  const out = captureStream();
  const code = await runProposalsCli({ argv: [], env: {}, db, stdout: out, stderr: captureStream() });
  assert.equal(code, 0);
  assert.match(out.text, /brak polityk/);
  assert.match(out.text, /tylko raport, nic nie wykonano/);
  // Polityki niepełne (brak jednej kategorii) to nadal „brak polityk”.
  await addPolicies(db, { categories: CATEGORIES.slice(0, 3) });
  assert.equal((await proposeRetentionAnonymizations(db)).summary, 'brak polityk');
}));

test('polityki niezatwierdzone albo tylko opisowe (bez retain_for) nie dają kandydatów', withDb(async (db) => {
  await addPolicies(db, { approvedBy: null });
  const unapproved = await proposeRetentionAnonymizations(db);
  assert.deepEqual([unapproved.status, unapproved.reasonCode, unapproved.candidates.length], ['policies_unusable', 'retention_policy_not_approved', 0]);
  const db2 = await freshDb();
  try {
    await addPolicies(db2, { rule: 'N lat po ostatnim roku szkolnym ucznia' });
    const rule = await proposeRetentionAnonymizations(db2);
    assert.deepEqual([rule.status, rule.reasonCode, rule.candidates.length], ['policies_unusable', 'retention_rule_not_evaluable', 0]);
  } finally {
    await db2.close();
  }
}));

test('komplet zatwierdzonych polityk: kandydaci to gospodarstwa z upłyniętym okresem i czymś do zmiany', withDb(async (db) => {
  await addPolicies(db);
  const report = await proposeRetentionAnonymizations(db);
  assert.equal(report.status, 'ok');
  assert.equal(report.execution, 'none');
  assert.equal(report.policyIds.length, 4);
  assert.deepEqual(report.candidates.map((candidate) => candidate.householdId), ['h-1', 'h-2', 'h-x']);
  assert.equal(report.evaluated, 5);
  assert.equal(report.periodNotElapsed, 1, 'h-new: rok szkolny jeszcze trwa');
  assert.equal(report.nothingToChange, 1, 'h-done: już zanonimizowane');
  assert.equal(report.summary, 'kandydatów: 3');
  assertEvery(report.candidates, (candidate) => /^[0-9a-f]{64}$/.test(candidate.planSha256)
    && Object.values(candidate.counts).reduce((sum, n) => sum + n, 0) > 0);
  const byId = Object.fromEntries(report.candidates.map((candidate) => [candidate.householdId, candidate]));
  assert.equal(byId['h-1'].retained.students, 1, 'dziecko wspólne z h-2 zostaje do przebiegu drugiego gospodarstwa');
  assert.equal(byId['h-2'].retained.students, 1);
  assert.equal(byId['h-x'].retained.students, 0);
  // Raport: identyfikatory, skróty i liczniki — bez danych osobowych.
  const serialized = JSON.stringify(report);
  for (const marker of [...MARKERS, 'MRK-OBCY', 'MRK-TYTUL-HX', '@']) assert.ok(!serialized.includes(marker), `raport zawiera: ${marker}`);
}));

test('zbyt długi okres nie daje kandydatów: wszystkie gospodarstwa „okres nie upłynął”', withDb(async (db) => {
  await addPolicies(db, { retainFor: '200 years' });
  const report = await proposeRetentionAnonymizations(db);
  assert.equal(report.status, 'ok');
  assert.deepEqual(report.candidates, []);
  assert.equal(report.periodNotElapsed, 5);
  assert.equal(report.summary, 'brak kandydatów');
}));

test('raport jest wyłącznie odczytem: transakcja READ ONLY, żadnego zapisu, powtórzenie daje ten sam wynik', withDb(async (db) => {
  await addPolicies(db);
  const before = await stateOf(db);
  const statements = [];
  const spy = {
    query: (...args) => db.query(...args),
    transaction: (fn, options) => db.transaction((tx) => fn({
      query: (sql, params) => { statements.push(String(sql)); return tx.query(sql, params); },
    }), options),
  };
  const first = await proposeRetentionAnonymizations(spy);
  assert.equal(statements[0], 'SET TRANSACTION READ ONLY');
  assertCaptured(statements, { min: 20 });
  assertEvery(statements, (sql) => !/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|LOCK)\b/i.test(sql) && !/set_config|anonymization_run'/i.test(sql),
    'żadne polecenie raportu nie zapisuje danych ani nie ustawia kontekstu przebiegu');
  assert.deepEqual(await stateOf(db), before, 'żadnej zmiany w danych, audycie ani dzienniku przebiegów');
  assert.deepEqual(await proposeRetentionAnonymizations(db), first);
}));

test('wykonanie zostaje ręczne: skrót planu z raportu zgadza się z podglądem trasy, a wykonany przebieg znika z listy', withDb(async (db) => {
  await addPolicies(db);
  const report = await proposeRetentionAnonymizations(db);
  const candidate = report.candidates.find((item) => item.householdId === 'h-x');
  const cookie = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
  const call = async (body) => {
    const response = await handlePgRequest(request('/api/admin/anonymizations', { method: 'POST', cookie, body }), { db });
    return { status: response.status, json: await response.json() };
  };
  const preview = await call({ householdId: 'h-x', reasonCode: 'retention_policy' });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.equal(preview.json.planSha256, candidate.planSha256);
  assert.deepEqual(preview.json.counts, candidate.counts);
  assert.equal(preview.json.retained.students, candidate.retained.students);
  assert.equal(await db.query('SELECT count(*)::int AS n FROM anonymization_runs').then((r) => r.rows[0].n), 0, 'podgląd i raport nie wykonują przebiegu');

  const executed = await call({ householdId: 'h-x', reasonCode: 'retention_policy', dryRun: false, confirm: 'h-x', expectedPlanSha256: candidate.planSha256 });
  assert.equal(executed.status, 201, JSON.stringify(executed.json));
  const after = await proposeRetentionAnonymizations(db);
  assert.deepEqual(after.candidates.map((item) => item.householdId), ['h-1', 'h-2']);
  assert.equal(after.nothingToChange, 2);
}));

test('skrypt: tekst i JSON bez danych osobowych, błędne opcje to błąd użycia, nic nie jest wykonywane', withDb(async (db) => {
  await addPolicies(db);
  const before = await stateOf(db);
  const text = captureStream();
  assert.equal(await runProposalsCli({ argv: [], env: {}, db, stdout: text, stderr: captureStream() }), 0);
  assert.match(text.text, /Propozycja do zatwierdzenia/);
  assert.match(text.text, /gospodarstwo h-1:/);
  assert.match(text.text, /wyłącznie ręcznie, POST \/api\/admin\/anonymizations/);
  const json = captureStream();
  assert.equal(await runProposalsCli({ argv: ['--json'], env: {}, db, stdout: json, stderr: captureStream() }), 0);
  assert.equal(JSON.parse(json.text).execution, 'none');
  for (const output of [text.text, json.text]) {
    for (const marker of [...MARKERS, 'MRK-OBCY', '@']) assert.ok(!output.includes(marker), `wynik zawiera: ${marker}`);
  }
  for (const argv of [['--run'], ['--execute'], ['h-1'], ['--json=1']]) {
    const err = captureStream();
    assert.equal(await runProposalsCli({ argv, env: {}, db, stdout: captureStream(), stderr: err }), 1, argv.join(' '));
    assert.match(err.text, /Usage:/);
  }
  assert.equal(await runProposalsCli({ argv: [], env: {}, stdout: captureStream(), stderr: captureStream() }), 1, 'bez DATABASE_URL');
  assert.deepEqual(await stateOf(db), before);
  assert.match(renderProposalsText({ status: 'no_policies', summary: 'brak polityk' }), /brak polityk/);
}));

test('brak automatycznego wykonania: żaden plik usługi Railway nie uruchamia skryptów anonimizacji, a skrypt nie importuje trasy ani zapisu', async () => {
  const root = new URL('../', import.meta.url);
  const configs = (await readdir(root)).filter((name) => /^railway.*\.json$/.test(name));
  assertCaptured(configs, { min: 3 });
  for (const name of configs) {
    const text = await readFile(new URL(name, root), 'utf8');
    assert.ok(!/anonymiz/i.test(text), `${name} uruchamia anonimizację`);
  }
  const scriptSource = await readFile(fileURLToPath(new URL('../scripts/anonymization-proposals.js', import.meta.url)), 'utf8');
  const moduleSource = await readFile(fileURLToPath(new URL('../src/pg/anonymization-proposals.js', import.meta.url)), 'utf8');
  assert.ok(!/anonymizeHousehold|applyAnonymizationPlan|reapplyAnonymizationRuns|insertAuditEvent/.test(scriptSource + moduleSource.replace(/\/\/.*$/gm, '')),
    'raport nie ma ścieżki wykonania');
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(pkg.scripts['anonymization:proposals'], 'node scripts/anonymization-proposals.js');
});
