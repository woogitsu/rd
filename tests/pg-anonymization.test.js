// #91: anonimizacja gospodarstwa z zachowaniem księgi i sum wpłat (migracja 0174).
// Testy: rodzeństwo w dwóch gospodarstwach, opieka dzielona (opiekun i dziecko w
// dwóch gospodarstwach), sumy netto i paczka eksportu bez zmian liczb, ponowienie
// i podwójne kliknięcie, odmowa bez polityki retencji, tryb żądania osoby,
// granice ról, historia zmian kontaktu i furtka w strażnikach niezmienności.
// Wyłącznie dane syntetyczne (.invalid); znaczniki MRK-* mają zniknąć z danych
// zanonimizowanego gospodarstwa i zostać w pozostałych.
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { assertNoPii } from '../src/pg/audit.js';
import { buildYearlyExport } from '../src/pg/export.js';
import { planAnonymization } from '../src/pg/anonymization.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';

// Lata dawno zakończone, by okres retencji (retain_for) mógł upłynąć w teście.
const Y1 = 'y-anon-1';
const Y2 = 'y-anon-2';

async function seed(db) {
  await seedSchoolYear(db, Y1, { startsOn: '2020-09-01', endsOn: '2021-08-31' });
  await seedSchoolYear(db, Y2, { startsOn: '2021-09-01', endsOn: '2022-08-31' });
  await seedClass(db, { id: 'c-an-1', schoolYearId: Y1, name: '1A' });
  await seedClass(db, { id: 'c-an-2', schoolYearId: Y2, name: '2A' });
  await seedUser(db, { userId: 'u-skarbnik-seed' });
  await db.exec(`
    INSERT INTO households (id) VALUES ('h-1'), ('h-2'), ('h-4'), ('h-5'), ('h-x');
    -- h-1: opiekun A, rodzeństwo s-1 (także w h-2: opieka dzielona) i s-2 (tylko h-1).
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
      VALUES ('g-a', 'h-1', 'Anna', 'MRK-OPIEKUN-A', 'opiekun-a@example.invalid', true);
    INSERT INTO students (id, household_id, first_name, last_name) VALUES
      ('s-1', 'h-1', 'Ola', 'MRK-UCZEN-1'), ('s-2', 'h-1', 'Jan', 'MRK-UCZEN-2');
    -- h-2: opiekun B (drugi opiekun s-1) i s-3 (tylko h-2).
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
      VALUES ('g-b', 'h-2', 'Bartek', 'MRK-OPIEKUN-B', 'opiekun-b@example.invalid', true);
    INSERT INTO students (id, household_id, first_name, last_name) VALUES ('s-3', 'h-2', 'Iga', 'MRK-UCZEN-3');
    INSERT INTO student_households (id, student_id, household_id, is_primary, source)
      VALUES ('sh-1-h2', 's-1', 'h-2', false, 'api');
    INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES
      ('s-1', 'g-a', true, true), ('s-2', 'g-a', true, true), ('s-1', 'g-b', true, false), ('s-3', 'g-b', true, true);
    -- h-4 / h-5: opiekun M należy do obu gospodarstw (guardian_households).
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
      VALUES ('g-m', 'h-4', 'Maria', 'MRK-OPIEKUN-M', 'opiekun-m@example.invalid', true);
    INSERT INTO guardian_households (id, guardian_id, household_id, source) VALUES ('gh-m-h5', 'g-m', 'h-5', 'api');
    INSERT INTO students (id, household_id, first_name, last_name) VALUES
      ('s-4', 'h-4', 'Ewa', 'MRK-UCZEN-4'), ('s-5', 'h-5', 'Tomek', 'MRK-UCZEN-5');
    INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES
      ('s-4', 'g-m', true, true), ('s-5', 'g-m', true, true);
    -- h-x: zupełnie inna rodzina.
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
      VALUES ('g-x', 'h-x', 'Olga', 'MRK-OBCY', 'obcy@example.invalid', true);
    INSERT INTO students (id, household_id, first_name, last_name) VALUES ('s-x', 'h-x', 'Kuba', 'MRK-OBCE-DZIECKO');
    INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ('s-x', 'g-x', true, true);
    INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
      ('e-1-y1', 's-1', 'c-an-1', '${Y1}'), ('e-2-y1', 's-2', 'c-an-1', '${Y1}'),
      ('e-3-y1', 's-3', 'c-an-1', '${Y1}'), ('e-x-y1', 's-x', 'c-an-1', '${Y1}');
  `);
  // Wpłaty częściowe, korekta i zwrot (h-1), wpłaty innych rodzin.
  await db.exec(`
    INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, reference, status, created_by, idempotency_key) VALUES
      ('p-1a', 'h-1', '${Y1}', 2000, '2020-10-01', 'bank', 'Składka MRK-TYTUL-1A', 'recorded', 'u-skarbnik-seed', 'p-1a-key-0001'),
      ('p-1b', 'h-1', '${Y1}', 1500, '2021-01-10', 'cash', 'MRK-TYTUL-1B', 'recorded', 'u-skarbnik-seed', 'p-1b-key-0001'),
      ('p-1c', 'h-1', '${Y2}', 3000, '2021-10-05', 'bank', NULL, 'recorded', 'u-skarbnik-seed', 'p-1c-key-0001'),
      ('p-2', 'h-2', '${Y1}', 1234, '2020-10-06', 'bank', 'MRK-TYTUL-H2', 'recorded', 'u-skarbnik-seed', 'p-2-key-00001'),
      ('p-4', 'h-4', '${Y1}', 500, '2020-10-07', 'bank', 'MRK-TYTUL-H4', 'recorded', 'u-skarbnik-seed', 'p-4-key-00001'),
      ('p-x', 'h-x', '${Y1}', 777, '2020-10-08', 'bank', 'MRK-TYTUL-HX', 'recorded', 'u-skarbnik-seed', 'p-x-key-00001');
    INSERT INTO payment_corrections (id, payment_entry_id, amount_cents, reason, created_by, idempotency_key)
      VALUES ('pc-1a', 'p-1a', 500, 'MRK-POWOD-KOREKTY', 'u-skarbnik-seed', 'pc-1a-key-0001'),
             ('pc-2', 'p-2', 34, 'MRK-POWOD-H2', 'u-skarbnik-seed', 'pc-2-key-00001');
    INSERT INTO payment_refunds (id, payment_entry_id, amount_cents, refunded_on, method, reason, created_by, idempotency_key)
      VALUES ('pr-1b', 'p-1b', 300, '2021-02-01', 'bank', 'MRK-POWOD-ZWROTU', 'u-skarbnik-seed', 'pr-1b-key-0001');
  `);
  // Kampania e-mail (migawka adresatów) i wpisy księgi, które mają zostać nietknięte.
  await db.query(
    `INSERT INTO email_campaigns (id, school_year_id, title, audience, subject, body_text, content_hash, created_by, updated_by, idempotency_key)
     VALUES ('cmp-1', $1, 'Kampania syntetyczna', 'all_households', 'Temat syntetyczny', repeat('x', 30), repeat('a', 64),
             'u-skarbnik-seed', 'u-skarbnik-seed', 'idem-cmp-anon-1')`, [Y1]);
  await db.exec(`
    INSERT INTO email_campaign_recipients (id, campaign_id, household_id, guardian_id, email, email_hash) VALUES
      ('r-a', 'cmp-1', 'h-1', 'g-a', 'opiekun-a@example.invalid', repeat('1', 64)),
      ('r-b', 'cmp-1', 'h-2', 'g-b', 'opiekun-b@example.invalid', repeat('2', 64)),
      ('r-m', 'cmp-1', 'h-4', 'g-m', 'opiekun-m@example.invalid', repeat('4', 64)),
      ('r-x', 'cmp-1', 'h-x', 'g-x', 'obcy@example.invalid', repeat('3', 64));
  `);
  // Historia zmian kontaktu (trigger zapisuje poprzedni i nowy e-mail do guardian_contact_changes).
  await db.exec(`
    UPDATE guardians SET email = 'opiekun-a-nowy@example.invalid' WHERE id = 'g-a';
    UPDATE guardians SET email = 'opiekun-b-nowy@example.invalid' WHERE id = 'g-b';
  `);
  await db.exec(`
    INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by)
      VALUES ('cat-an', '${Y1}', 'expense', 'Kategoria syntetyczna', 'u-skarbnik-seed');
    INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on, method, created_by, idempotency_key)
      VALUES ('le-1', '${Y1}', 'expense', 1111, 'cat-an', 'MRK-OPIS-KSIEGI', '2020-11-01', 'bank', 'u-skarbnik-seed', 'le-1-key-00001');
  `);
}

const MARKERS_H1 = ['MRK-OPIEKUN-A', 'opiekun-a@example.invalid', 'opiekun-a-nowy@example.invalid', 'MRK-UCZEN-2',
  'MRK-TYTUL-1A', 'MRK-TYTUL-1B', 'MRK-POWOD-KOREKTY', 'MRK-POWOD-ZWROTU'];

// Zawartość wszystkich tabel dotkniętych przebiegiem w jednym tekście (do szukania znaczników).
async function personalDump(db) {
  const queries = [
    'SELECT * FROM guardians', 'SELECT * FROM students', 'SELECT * FROM guardian_contact_changes',
    'SELECT * FROM email_campaign_recipients', 'SELECT id, reference FROM payment_entries',
    'SELECT * FROM payment_corrections', 'SELECT * FROM payment_refunds',
  ];
  const parts = [];
  for (const sql of queries) parts.push(JSON.stringify((await db.query(sql)).rows));
  return parts.join('\n');
}

async function financialSnapshot(db) {
  const q = async (sql) => (await db.query(sql)).rows;
  return {
    totals: await q('SELECT household_id, school_year_id, net_amount_cents::int AS net, payment_count::int AS n FROM household_payment_totals ORDER BY 1, 2'),
    entries: await q('SELECT id, household_id, school_year_id, amount_cents, received_on::text AS received_on, method, status, created_at::text AS created_at, idempotency_key FROM payment_entries ORDER BY id'),
    corrections: await q('SELECT id, payment_entry_id, amount_cents, created_at::text AS created_at FROM payment_corrections ORDER BY id'),
    refunds: await q('SELECT id, payment_entry_id, amount_cents, refunded_on::text AS refunded_on FROM payment_refunds ORDER BY id'),
    ledger: await q('SELECT id, amount_cents, description, school_year_id FROM ledger_entries ORDER BY id'),
    relations: await q('SELECT student_id, guardian_id FROM student_guardians ORDER BY 1, 2'),
    memberships: await q('SELECT id, guardian_id, household_id FROM guardian_households ORDER BY id'),
  };
}

describe('anonimizacja gospodarstwa (#91)', () => {
  let db;
  const env = {};
  const cookies = {};
  before(async () => {
    db = await createTestDb();
    env.db = db;
    await seed(db);
    cookies.admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
    cookies.adminNoMfa = await seedUserSession(db, { userId: 'u-admin-nomfa', roles: [{ role: 'admin' }], mfa: false });
    cookies.adminStale = await seedUserSession(db, { userId: 'u-admin-stale', roles: [{ role: 'admin' }], mfa: true });
    await db.query("UPDATE sessions SET mfa_verified_at = now() - interval '20 minutes' WHERE user_id = 'u-admin-stale'");
    cookies.board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: Y2 }], mfa: true });
    cookies.treasurer = await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: Y2 }], mfa: true });
    cookies.audit = await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit', schoolYearId: Y2 }], mfa: true });
    cookies.principal = await seedUserSession(db, { userId: 'u-principal', roles: [{ role: 'principal', schoolYearId: Y2 }], mfa: true });
    cookies.rep = await seedUserSession(db, {
      userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-an-1', schoolYearId: Y1 }], mfa: true,
    });
  });
  after(async () => { await db?.close(); });

  const call = async (path, { cookie = cookies.admin, method = 'POST', body } = {}) => {
    const response = await handlePgRequest(request(path, { cookie, method, body }), env);
    const text = await response.text();
    return { status: response.status, text, json: text ? JSON.parse(text) : null };
  };
  const anonymize = (body, options) => call('/api/admin/anonymizations', { body, ...options });
  const count = async (sql, params) => (await db.query(sql, params)).rows[0].n;
  const runCount = () => count('SELECT count(*)::int AS n FROM anonymization_runs');
  const auditCount = () => count("SELECT count(*)::int AS n FROM audit_events WHERE action = 'household.anonymized'");

  async function erasureRequest(subject, { kind = 'erasure', status = 'identity_verified' } = {}) {
    const created = await call('/api/admin/data-requests', { body: { kind, ...subject, receivedOn: '2026-10-15' } });
    assert.equal(created.status, 201, created.text);
    const id = created.json.request.id;
    if (status !== 'received') {
      const moved = await call(`/api/admin/data-requests/${id}/status`, { body: { status } });
      assert.equal(moved.status, 200, moved.text);
    }
    return id;
  }

  async function execute(householdId, dataRequestId) {
    const preview = await anonymize({ householdId, reasonCode: 'data_subject_request', dataRequestId, dryRun: true });
    assert.equal(preview.status, 200, preview.text);
    return anonymize({
      householdId, reasonCode: 'data_subject_request', dataRequestId, dryRun: false,
      confirm: householdId, expectedPlanSha256: preview.json.planSha256,
    });
  }

  describe('kolejność scenariuszy (jedna baza, stan narasta)', () => {
    let beforeAll;
    let requestH1;
    let exportBefore;

    test('podgląd (dryRun) niczego nie zmienia, zostawia tylko ślad podglądu i nie zwraca danych osobowych', async () => {
      requestH1 = await erasureRequest({ householdId: 'h-1' });
      beforeAll = { fin: await financialSnapshot(db), dump: await personalDump(db) };
      exportBefore = (await db.transaction((tx) => buildYearlyExport(tx, Y1))).bundle;
      const auditBefore = await count("SELECT count(*)::int AS n FROM audit_events WHERE action <> 'household.anonymization_previewed'");

      const preview = await anonymize({ householdId: 'h-1', reasonCode: 'data_subject_request', dataRequestId: requestH1 });
      assert.equal(preview.status, 200, preview.text);
      assert.equal(preview.json.status, 'dry_run');
      assert.equal(preview.json.runId, null);
      assert.match(preview.json.planSha256, /^[0-9a-f]{64}$/);
      assert.equal(preview.json.counts.guardians, 1);
      assert.equal(preview.json.counts.students, 1, 'tylko s-2; s-1 należy też do h-2');
      assert.equal(preview.json.retained.students, 1);
      assert.equal(preview.json.counts.payment_entries, 2);
      for (const marker of [...MARKERS_H1, 'Anna', 'Ola', 'MRK-UCZEN-1']) {
        assert.ok(!preview.text.includes(marker), `podgląd zawiera dane osobowe: ${marker}`);
      }
      assert.deepEqual(await personalDump(db), beforeAll.dump);
      assert.equal(await count("SELECT count(*)::int AS n FROM audit_events WHERE action <> 'household.anonymization_previewed'"), auditBefore);
      const { rows: previews } = await db.query("SELECT actor_id, entity_type, entity_id, metadata_json FROM audit_events WHERE action = 'household.anonymization_previewed'");
      assert.equal(previews.length, 1, 'podgląd zostawia ślad: aktor, gospodarstwo, liczniki');
      assert.deepEqual([previews[0].actor_id, previews[0].entity_type, previews[0].entity_id], ['u-admin', 'household', 'h-1']);
      assertNoPii(previews[0].metadata_json);
      assert.equal(await runCount(), 0);
    });

    test('bez polityki retencji tryb retention_policy odmawia (retention_policy_missing), nic się nie zmienia', async () => {
      const refused = await anonymize({ householdId: 'h-1', reasonCode: 'retention_policy' });
      assert.equal(refused.status, 409);
      assert.deepEqual(refused.json, { error: 'retention_policy_missing' });
      const executeRefused = await anonymize({
        householdId: 'h-1', reasonCode: 'retention_policy', dryRun: false, confirm: 'h-1', expectedPlanSha256: 'a'.repeat(64),
      });
      assert.equal(executeRefused.status, 409);
      assert.equal(executeRefused.json.error, 'retention_policy_missing');
      assert.deepEqual(await personalDump(db), beforeAll.dump);
      assert.equal(await runCount(), 0);
      assert.equal(await auditCount(), 0);
    });

    test('walidacja wejścia i stan żądania osoby', async () => {
      const bad = (body) => anonymize(body);
      assert.equal((await bad({ reasonCode: 'data_subject_request', dataRequestId: requestH1 })).json.error, 'invalid_household_id');
      assert.equal((await bad({ householdId: 'h-1', reasonCode: 'whatever' })).json.error, 'invalid_reason_code');
      assert.equal((await bad({ householdId: 'h-1', reasonCode: 'data_subject_request' })).json.error, 'invalid_data_request_id');
      assert.equal((await bad({ householdId: 'h-1', reasonCode: 'retention_policy', dataRequestId: requestH1 })).json.error, 'invalid_data_request_id');
      assert.equal((await bad({ householdId: 'h-1', reasonCode: 'data_subject_request', dataRequestId: requestH1, dryRun: 'nie' })).json.error, 'invalid_dry_run');
      const noConfirm = await bad({ householdId: 'h-1', reasonCode: 'data_subject_request', dataRequestId: requestH1, dryRun: false, expectedPlanSha256: 'a'.repeat(64) });
      assert.equal(noConfirm.status, 400);
      assert.equal(noConfirm.json.error, 'confirmation_required');
      const wrongConfirm = await bad({ householdId: 'h-1', reasonCode: 'data_subject_request', dataRequestId: requestH1, dryRun: false, confirm: 'h-2', expectedPlanSha256: 'a'.repeat(64) });
      assert.equal(wrongConfirm.json.error, 'confirmation_required');
      const noSha = await bad({ householdId: 'h-1', reasonCode: 'data_subject_request', dataRequestId: requestH1, dryRun: false, confirm: 'h-1' });
      assert.equal(noSha.json.error, 'invalid_plan_sha256');
      assert.equal((await bad({ householdId: 'h-nie-ma', reasonCode: 'data_subject_request', dataRequestId: requestH1 })).status, 404);
      assert.equal((await bad({ householdId: 'h-1', reasonCode: 'data_subject_request', dataRequestId: '00000000-0000-4000-8000-000000000000' })).json.error, 'data_request_not_found');

      const access = await erasureRequest({ householdId: 'h-1' }, { kind: 'access' });
      const wrongKind = await bad({ householdId: 'h-1', reasonCode: 'data_subject_request', dataRequestId: access });
      assert.deepEqual([wrongKind.status, wrongKind.json.error], [409, 'data_request_kind_not_erasable']);
      const unverified = await erasureRequest({ householdId: 'h-1' }, { status: 'received' });
      assert.equal((await bad({ householdId: 'h-1', reasonCode: 'data_subject_request', dataRequestId: unverified })).json.error, 'data_request_identity_not_verified');
      const closed = await erasureRequest({ householdId: 'h-1' }, { status: 'identity_verified' });
      await call(`/api/admin/data-requests/${closed}/status`, { body: { status: 'rejected' } });
      assert.equal((await bad({ householdId: 'h-1', reasonCode: 'data_subject_request', dataRequestId: closed })).json.error, 'data_request_closed');
      const other = await erasureRequest({ householdId: 'h-x' });
      assert.equal((await bad({ householdId: 'h-1', reasonCode: 'data_subject_request', dataRequestId: other })).json.error, 'data_request_subject_mismatch');
      assert.deepEqual(await personalDump(db), beforeAll.dump);
      assert.equal(await runCount(), 0);
    });

    test('zmiana danych między podglądem a wykonaniem: 409 anonymization_plan_changed, bez zmian', async () => {
      const preview = await anonymize({ householdId: 'h-1', reasonCode: 'data_subject_request', dataRequestId: requestH1 });
      await db.query(`INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, reference, status, created_by, idempotency_key)
        VALUES ('p-1d', 'h-1', '${Y2}', 100, '2021-11-01', 'cash', 'MRK-TYTUL-PO-PODGLADZIE', 'recorded', 'u-skarbnik-seed', 'p-1d-key-0001')`);
      const stale = await anonymize({
        householdId: 'h-1', reasonCode: 'data_subject_request', dataRequestId: requestH1, dryRun: false,
        confirm: 'h-1', expectedPlanSha256: preview.json.planSha256,
      });
      assert.deepEqual([stale.status, stale.json.error], [409, 'anonymization_plan_changed']);
      assert.ok((await personalDump(db)).includes('MRK-TYTUL-PO-PODGLADZIE'));
      assert.equal(await runCount(), 0);
      beforeAll = { fin: await financialSnapshot(db), dump: await personalDump(db) };
      exportBefore = (await db.transaction((tx) => buildYearlyExport(tx, Y1))).bundle;
    });

    test('wykonanie dla h-1: dane osobowe znikają, kwoty, księga i sumy netto bez zmian, inne gospodarstwa nietknięte', async () => {
      const executed = await execute('h-1', requestH1);
      assert.equal(executed.status, 201, executed.text);
      assert.equal(executed.json.status, 'applied');
      assert.match(executed.json.runId, /^[0-9a-f-]{36}$/);
      const afterDump = await personalDump(db);
      for (const marker of [...MARKERS_H1, 'MRK-TYTUL-PO-PODGLADZIE']) {
        assert.ok(!afterDump.includes(marker), `po anonimizacji zostało: ${marker}`);
      }
      // Rodzeństwo w dwóch gospodarstwach: h-2, h-4, h-5, h-x i dziecko wspólne s-1 (także w h-2) nietknięte.
      for (const marker of ['MRK-OPIEKUN-B', 'opiekun-b@example.invalid', 'opiekun-b-nowy@example.invalid', 'MRK-UCZEN-1',
        'MRK-UCZEN-3', 'MRK-TYTUL-H2', 'MRK-POWOD-H2', 'MRK-OPIEKUN-M', 'MRK-TYTUL-H4', 'MRK-OBCY', 'obcy@example.invalid',
        'MRK-OBCE-DZIECKO', 'MRK-TYTUL-HX']) {
        assert.ok(afterDump.includes(marker), `nietknięte dane zniknęły: ${marker}`);
      }
      assert.equal(await count("SELECT count(*)::int AS n FROM students WHERE id = 's-2' AND last_name = '[zanonimizowano]'"), 1);
      assert.equal(await count("SELECT count(*)::int AS n FROM students WHERE id = 's-1' AND last_name = 'MRK-UCZEN-1'"), 1,
        'dziecko wspólne z h-2 zostaje, dopóki h-2 nie jest zanonimizowane');
      assert.equal(await count("SELECT count(*)::int AS n FROM guardians WHERE id = 'g-a' AND email IS NULL AND contact_allowed = false"), 1);

      // Sumy netto, wpisy księgi, wpłaty (kwoty, daty, statusy, identyfikatory) i relacje — bez zmian.
      const afterFin = await financialSnapshot(db);
      assert.deepEqual(afterFin, beforeAll.fin);
      assert.deepEqual(afterFin.totals.find((row) => row.household_id === 'h-1' && row.school_year_id === Y1), {
        household_id: 'h-1', school_year_id: Y1, net: 2000 + 1500 - 500 - 300, n: 2,
      });

      // Eksport roczny po anonimizacji: te same liczby (sumy *_cents, totals), bez starych danych.
      const exportAfter = (await db.transaction((tx) => buildYearlyExport(tx, Y1))).bundle;
      assert.deepEqual(exportAfter.manifest.totals, exportBefore.manifest.totals);
      const sums = (bundle) => Object.fromEntries(bundle.manifest.files.map((file) => [file.table, file.sums]));
      assert.deepEqual(sums(exportAfter), sums(exportBefore));
      const exportText = JSON.stringify(exportAfter.files);
      for (const marker of MARKERS_H1) assert.ok(!exportText.includes(marker), `eksport zawiera stare dane: ${marker}`);
      assert.ok(exportText.includes('MRK-OPIEKUN-B'), 'eksport zachowuje dane gospodarstw niezanonimizowanych');
    });

    test('historia zmian kontaktu (guardian_contact_changes) jest zanonimizowana, wiersze zostają', async () => {
      const rows = (await db.query("SELECT previous_email, new_email, reason FROM guardian_contact_changes WHERE guardian_id = 'g-a'")).rows;
      assert.ok(rows.length >= 1, 'wiersze historii nie są usuwane');
      for (const row of rows) assert.deepEqual(row, { previous_email: null, new_email: null, reason: null });
      assert.equal(await count("SELECT count(*)::int AS n FROM guardian_contact_changes WHERE guardian_id = 'g-b' AND previous_email IS NOT NULL"), 1,
        'historia opiekuna z innego gospodarstwa nietknięta');
      // Przebieg nie dopisał wiersza historii z poprzednim e-mailem (trigger pomija kontekst przebiegu).
      assert.equal(await count("SELECT count(*)::int AS n FROM guardian_contact_changes WHERE guardian_id = 'g-a'"), rows.length);
    });

    test('dziennik przebiegu i zdarzenie audytu: tylko identyfikatory i liczniki', async () => {
      const { rows } = await db.query('SELECT * FROM anonymization_runs');
      assert.equal(rows.length, 1);
      const run = rows[0];
      assert.equal(run.household_id, 'h-1');
      assert.equal(run.reason_code, 'data_subject_request');
      assert.equal(run.data_subject_request_id, requestH1);
      assert.equal(run.executed_by, 'u-admin');
      assert.deepEqual(run.retention_policy_ids, []);
      assert.ok(run.counts.guardians === 1 && run.counts.payment_entries === 3);
      const { rows: events } = await db.query("SELECT actor_id, entity_type, entity_id, metadata_json FROM audit_events WHERE action = 'household.anonymized'");
      assert.equal(events.length, 1);
      assert.equal(events[0].actor_id, 'u-admin');
      assert.equal(events[0].entity_type, 'anonymization_run');
      assert.equal(events[0].entity_id, run.id);
      assertNoPii(events[0].metadata_json);
      const serialized = JSON.stringify([run, events]);
      for (const marker of [...MARKERS_H1, 'Anna', 'MRK-UCZEN-1']) assert.ok(!serialized.includes(marker), marker);
      assert.deepEqual(events[0].metadata_json.counts, run.counts);
      assert.equal(events[0].metadata_json.retainedStudents, 1);
    });

    test('ponowienie i podwójne kliknięcie: replayed, bez drugiego wpisu i zdarzenia', async () => {
      const again = await execute('h-1', requestH1);
      assert.equal(again.status, 200, again.text);
      assert.equal(again.json.status, 'replayed');
      assert.equal(again.json.runId, null);
      const [first, second] = await Promise.all([execute('h-1', requestH1), execute('h-1', requestH1)]);
      assert.deepEqual([first.json.status, second.json.status], ['replayed', 'replayed']);
      assert.equal(await runCount(), 1);
      assert.equal(await auditCount(), 1);
    });

    test('opieka dzielona: h-2 po h-1 anonimizuje dziecko wspólne i drugiego opiekuna; relacje opiekun-dziecko zostają', async () => {
      const requestH2 = await erasureRequest({ householdId: 'h-2' });
      const relationsBefore = (await financialSnapshot(db)).relations;
      const executed = await execute('h-2', requestH2);
      assert.equal(executed.status, 201, executed.text);
      assert.equal(executed.json.counts.students, 2, 's-1 (wspólne) i s-3');
      assert.equal(executed.json.retained.students, 0);
      const dump = await personalDump(db);
      for (const marker of ['MRK-OPIEKUN-B', 'opiekun-b@example.invalid', 'opiekun-b-nowy@example.invalid', 'MRK-UCZEN-1', 'MRK-UCZEN-3', 'MRK-TYTUL-H2', 'MRK-POWOD-H2']) {
        assert.ok(!dump.includes(marker), `po anonimizacji h-2 zostało: ${marker}`);
      }
      assert.deepEqual((await financialSnapshot(db)).relations, relationsBefore, 'powiązania uczeń-opiekun nie są usuwane');
      assert.ok(dump.includes('MRK-OBCY') && dump.includes('MRK-UCZEN-5') && dump.includes('MRK-OPIEKUN-M'), 'h-x, h-4, h-5 nietknięte');
    });

    test('opiekun w dwóch gospodarstwach (guardian_households): zostaje do anonimizacji drugiego, wtedy znikają też jego adresaci', async () => {
      const requestH4 = await erasureRequest({ householdId: 'h-4' });
      const first = await execute('h-4', requestH4);
      assert.equal(first.status, 201, first.text);
      assert.equal(first.json.retained.guardians, 1, 'g-m należy też do h-5');
      assert.equal(await count("SELECT count(*)::int AS n FROM guardians WHERE id = 'g-m' AND last_name = 'MRK-OPIEKUN-M' AND email IS NOT NULL"), 1);
      assert.equal(await count("SELECT count(*)::int AS n FROM students WHERE id = 's-4' AND last_name = '[zanonimizowano]'"), 1);
      assert.equal(await count("SELECT count(*)::int AS n FROM students WHERE id = 's-5' AND last_name = 'MRK-UCZEN-5'"), 1);
      assert.equal(await count("SELECT count(*)::int AS n FROM email_campaign_recipients WHERE id = 'r-m' AND email = 'opiekun-m@example.invalid'"), 1);

      const requestH5 = await erasureRequest({ householdId: 'h-5' });
      const second = await execute('h-5', requestH5);
      assert.equal(second.status, 201, second.text);
      assert.equal(second.json.retained.guardians, 0);
      assert.equal(await count("SELECT count(*)::int AS n FROM guardians WHERE id = 'g-m' AND last_name = '[zanonimizowano]' AND email IS NULL"), 1);
      assert.equal(await count("SELECT count(*)::int AS n FROM email_campaign_recipients WHERE id = 'r-m' AND email = 'zanonimizowano@anonim.invalid'"), 1);
      assert.equal(await count("SELECT count(*)::int AS n FROM email_campaign_recipients WHERE email_hash = repeat('4', 64)"), 1, 'email_hash zostaje (do decyzji IOD)');
      assert.equal(await count("SELECT count(*)::int AS n FROM guardians WHERE id = 'g-x' AND last_name = 'MRK-OBCY'"), 1);
    });
  });

  describe('tryb polityki retencji (D-04)', () => {
    const categories = ['guardian_contact', 'student_identity', 'email_snapshot', 'payment_reference'];

    test('polityka niepełna, niezatwierdzona, opisowa lub nieupłynięta odmawia; komplet z upłyniętym okresem wykonuje', async () => {
      const db2 = await createTestDb();
      try {
        await seed(db2);
        await seedUser(db2, { userId: 'u-admin-2' });
        const admin = await seedUserSession(db2, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
        const run = async (body) => {
          const response = await handlePgRequest(request('/api/admin/anonymizations', { method: 'POST', cookie: admin, body }), { db: db2 });
          return { status: response.status, json: await response.json() };
        };
        const addPolicy = (id, category, options = {}) => db2.query(
          `INSERT INTO retention_policies (id, data_category, retain_for, retain_until_rule, decision_ref, created_by, approved_by, effective_from)
           VALUES ($1, $2, $3::interval, $4, 'D-04/uchwała-testowa', 'u-admin', $5, now() - interval '1 day')`,
          [id, category, options.rule ? null : (options.retainFor ?? '1 year'), options.rule ?? null, options.approvedBy === undefined ? 'u-admin-2' : options.approvedBy],
        );
        const body = { householdId: 'h-1', reasonCode: 'retention_policy' };

        for (const [i, category] of categories.slice(0, 3).entries()) await addPolicy(`rp-${i}`, category);
        assert.equal((await run(body)).json.error, 'retention_policy_missing', 'brakuje payment_reference');

        await addPolicy('rp-3', 'payment_reference', { approvedBy: null });
        assert.equal((await run(body)).json.error, 'retention_policy_not_approved');
        await addPolicy('rp-3b', 'payment_reference', { rule: 'N lat po ostatnim roku szkolnym ucznia' });
        assert.equal((await run(body)).json.error, 'retention_rule_not_evaluable');
        await addPolicy('rp-3c', 'payment_reference', { retainFor: '200 years' });
        assert.equal((await run(body)).json.error, 'retention_period_not_elapsed');
        await addPolicy('rp-3d', 'payment_reference', { retainFor: '1 year' });
        // Najnowsza obowiązująca wersja kategorii wygrywa (korekta = nowy wiersz).

        const preview = await run(body);
        assert.equal(preview.status, 200, JSON.stringify(preview.json));
        assert.equal(preview.json.status, 'dry_run');
        const executed = await run({
          ...body, dryRun: false, confirm: 'h-1', expectedPlanSha256: preview.json.planSha256,
        });
        assert.equal(executed.status, 201, JSON.stringify(executed.json));
        const { rows } = await db2.query('SELECT reason_code, retention_policy_ids, data_subject_request_id FROM anonymization_runs');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].reason_code, 'retention_policy');
        assert.equal(rows[0].retention_policy_ids.length, 4);
        assert.equal(rows[0].data_subject_request_id, null);
      } finally {
        await db2.close();
      }
    });
  });

  describe('granice ról i furtka w strażnikach', () => {
    test('tylko admin z MFA (i świeżym): reszta 401/403, access.denied, bez zmian i bez wpisu przebiegu', async () => {
      const runsBefore = await runCount();
      const auditBefore = await auditCount();
      const dumpBefore = await personalDump(db);
      const body = { householdId: 'h-x', reasonCode: 'retention_policy' };
      assert.equal((await anonymize(body, { cookie: null })).status, 401);
      for (const role of ['board', 'treasurer', 'audit', 'principal', 'rep']) {
        const denied = await anonymize(body, { cookie: cookies[role] });
        assert.equal(denied.status, 403, role);
      }
      assert.equal((await anonymize(body, { cookie: cookies.adminNoMfa })).status, 403);
      const stale = await anonymize(body, { cookie: cookies.adminStale });
      assert.deepEqual([stale.status, stale.json.error], [403, 'mfa_stale']);
      assert.ok(await count("SELECT count(*)::int AS n FROM audit_events WHERE action = 'access.denied'") >= 1);
      assert.equal(await runCount(), runsBefore);
      assert.equal(await auditCount(), auditBefore);
      assert.equal(await personalDump(db), dumpBefore);
      // Inna metoda trasy: 405 z nagłówkiem Allow.
      const get = await handlePgRequest(request('/api/admin/anonymizations', { cookie: cookies.admin }), env);
      assert.equal(get.status, 200);
      const put = await handlePgRequest(request('/api/admin/anonymizations', { cookie: cookies.admin, method: 'PUT' }), env);
      assert.equal(put.status, 405);
      assert.equal(put.headers.get('Allow'), 'GET, POST');
    });

    test('GET lista przebiegów: tylko admin z MFA; reszta 401/403 bez danych, access.denied; bez zdarzenia audytu odczytu', async () => {
      const list = (cookie) => call('/api/admin/anonymizations', { method: 'GET', cookie });
      assert.equal((await list(null)).status, 401);
      const auditBefore = await count('SELECT count(*)::int AS n FROM audit_events');
      for (const role of ['board', 'treasurer', 'audit', 'principal', 'rep', 'adminNoMfa']) {
        const denied = await list(cookies[role]);
        assert.equal(denied.status, 403, role);
        assert.ok(!denied.text.includes('planSha256'), role);
      }
      assert.equal(await count("SELECT count(*)::int AS n FROM audit_events WHERE action = 'access.denied'") >= 1, true);
      // Odmowy zapisują wyłącznie access.denied (odczyt admina nic nie dopisuje).
      const denials = await count('SELECT count(*)::int AS n FROM audit_events') - auditBefore;
      const ok = await list(cookies.admin);
      assert.equal(ok.status, 200, ok.text);
      assert.equal(await count('SELECT count(*)::int AS n FROM audit_events') - auditBefore, denials);
      // Świeże MFA nie jest wymagane (lista niczego nie zmienia), zwykłe MFA tak.
      assert.equal((await list(cookies.adminStale)).status, 200);
    });

    test('GET lista przebiegów: pola, kolejność od najnowszego, kursor, bez danych osobowych', async () => {
      const { rows: stored } = await db.query('SELECT id, household_id, reason_code, executed_by FROM anonymization_runs');
      assert.ok(stored.length >= 3, 'wcześniejsze scenariusze zostawiły przebiegi');
      const all = await call('/api/admin/anonymizations?limit=100', { method: 'GET' });
      assert.equal(all.status, 200, all.text);
      assert.equal(all.json.runs.length, stored.length);
      assert.equal(all.json.nextCursor, null);
      assert.equal(all.json.truncated, false);
      const times = all.json.runs.map((run) => Date.parse(run.executedAt));
      assert.ok(times.length >= 3 && times.every((time, index) => index === 0 || times[index - 1] >= time), 'niepusta, od najnowszego');
      for (const run of all.json.runs) {
        const row = stored.find((item) => item.id === run.id);
        assert.ok(row, 'id istnieje w dzienniku');
        assert.deepEqual([run.householdId, run.reasonCode, run.executedBy], [row.household_id, row.reason_code, row.executed_by]);
        assert.match(run.planSha256, /^[0-9a-f]{64}$/);
        assert.equal(run.totalChanged, Object.values(run.counts).reduce((sum, n) => sum + n, 0));
        assert.ok(run.totalChanged > 0);
        assert.deepEqual(Object.keys(run).sort(), ['counts', 'dataSubjectRequestId', 'executedAt', 'executedBy', 'householdId', 'id',
          'planSha256', 'reasonCode', 'retentionPolicyIds', 'totalChanged']);
      }
      for (const marker of ['MRK-', 'Anna', 'Ola', '@example.invalid', '@anonim.invalid']) {
        assert.ok(!all.text.includes(marker), `lista zawiera dane osobowe: ${marker}`);
      }
      // Strony po jednym wierszu dają te same id w tej samej kolejności.
      const seen = [];
      let cursor = null;
      for (let guard = 0; guard < 20; guard += 1) {
        const page = await call(`/api/admin/anonymizations?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { method: 'GET' });
        assert.equal(page.status, 200, page.text);
        assert.equal(page.json.runs.length, 1);
        seen.push(page.json.runs[0].id);
        cursor = page.json.nextCursor;
        if (!cursor) break;
      }
      assert.deepEqual(seen, all.json.runs.map((run) => run.id));
      assert.equal((await call('/api/admin/anonymizations?cursor=zly', { method: 'GET' })).status, 400);
      assert.equal((await call('/api/admin/anonymizations?limit=0', { method: 'GET' })).status, 400);
    });

    test('bezpośredni UPDATE/DELETE poza przebiegiem nadal odrzucany; w kontekście przebiegu tylko pola tekstowe na NULL/wartość zastępczą', async () => {
      await assert.rejects(db.query("UPDATE payment_entries SET reference = NULL WHERE id = 'p-x'"), /payment_financial_facts_immutable/);
      await assert.rejects(db.query("UPDATE payment_corrections SET reason = '[zanonimizowano]' WHERE id = 'pc-2'"), /payment_corrections_cannot_be_changed/);
      await assert.rejects(db.query("UPDATE guardian_contact_changes SET previous_email = NULL WHERE guardian_id = 'g-b'"), /family_history_is_append_only|guardian_contact_changes/);
      await assert.rejects(db.query("UPDATE email_campaign_recipients SET email = 'zanonimizowano@anonim.invalid' WHERE id = 'r-x'"), /email_snapshot_rows_immutable/);
      await assert.rejects(db.query("DELETE FROM payment_entries WHERE id = 'p-x'"), /payment_entries_cannot_be_deleted/);
      await assert.rejects(db.query('TRUNCATE anonymization_runs'), /truncate_not_allowed/);
      await assert.rejects(db.query("UPDATE anonymization_runs SET counts = '{}'::jsonb"), /anonymization_runs_is_append_only/);
      await assert.rejects(db.query("DELETE FROM anonymization_runs"), /anonymization_runs_is_append_only/);

      const inRun = (statement) => db.transaction(async (tx) => {
        await tx.query("SELECT set_config('rd.anonymization_run', '11111111-1111-4111-8111-111111111111', true)");
        await tx.query(statement);
      });
      // Kwoty, daty, status, gospodarstwo, rok i klucz idempotencji — nigdy, nawet w kontekście przebiegu.
      await assert.rejects(inRun("UPDATE payment_entries SET amount_cents = 1 WHERE id = 'p-x'"), /payment_financial_facts_immutable/);
      await assert.rejects(inRun("UPDATE payment_entries SET received_on = '2020-10-09' WHERE id = 'p-x'"), /payment_financial_facts_immutable/);
      await assert.rejects(inRun("UPDATE payment_entries SET reference = 'dowolny tekst' WHERE id = 'p-x'"), /payment_financial_facts_immutable/);
      await assert.rejects(inRun("UPDATE payment_entries SET household_id = 'h-1' WHERE id = 'p-x'"), /payment_assignment_event_required/);
      await assert.rejects(inRun("UPDATE payment_corrections SET amount_cents = 1 WHERE id = 'pc-2'"), /payment_corrections_cannot_be_changed/);
      await assert.rejects(inRun("UPDATE payment_corrections SET reason = 'inny tekst' WHERE id = 'pc-2'"), /payment_corrections_cannot_be_changed/);
      await assert.rejects(inRun("UPDATE ledger_entries SET description = '[zanonimizowano]' WHERE id = 'le-1'"), /ledger_entries_cannot_be_changed/);
      await assert.rejects(inRun("UPDATE guardian_contact_changes SET new_contact_allowed = NOT new_contact_allowed WHERE guardian_id = 'g-b'"), /family_history_is_append_only|guardian_contact_changes/);
      await assert.rejects(inRun("UPDATE email_campaign_recipients SET email_hash = repeat('9', 64) WHERE id = 'r-x'"), /email_snapshot_rows_immutable/);
      await assert.rejects(inRun("DELETE FROM payment_entries WHERE id = 'p-x'"), /payment_entries_cannot_be_deleted/);
      // Kontekst z niepoprawnym identyfikatorem przebiegu nie otwiera furtki.
      await assert.rejects(db.transaction(async (tx) => {
        await tx.query("SELECT set_config('rd.anonymization_run', 'tak', true)");
        await tx.query("UPDATE payment_entries SET reference = NULL WHERE id = 'p-x'");
      }), /payment_financial_facts_immutable/);
      // Kontekst nie wycieka poza transakcję.
      assert.equal(await count("SELECT count(*)::int AS n FROM payment_entries WHERE id = 'p-x' AND reference = 'MRK-TYTUL-HX'"), 1);
      await assert.rejects(db.query("UPDATE payment_entries SET reference = NULL WHERE id = 'p-x'"), /payment_financial_facts_immutable/);
    });

    test('plan jest tylko odczytem i zgodny z podglądem (planAnonymization)', async () => {
      const plan = await db.transaction((tx) => planAnonymization(tx, 'h-x'));
      assert.deepEqual(plan.tables.guardians, ['g-x']);
      assert.deepEqual(plan.tables.students, ['s-x']);
      assert.deepEqual(plan.tables.payment_entries, ['p-x']);
      assert.deepEqual(plan.anonymizedHouseholds.sort(), ['h-1', 'h-2', 'h-4', 'h-5', 'h-x']);
    });
  });
});
