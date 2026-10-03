// #91: odtworzenie eksportu sprzed anonimizacji i ponowne zastosowanie przebiegów
// z dziennika poza bazą (migracja 0185, scripts/reapply-anonymization.js,
// scripts/export-anonymization-log.js). Scenariusz: baza źródłowa -> paczka roczna
// PRZED anonimizacją -> dwa przebiegi (opieka dzielona) -> eksport dziennika do pliku
// -> odtworzenie paczki do pustej bazy (dane osobowe wracają) -> ponowne zastosowanie.
// Wyłącznie dane syntetyczne (.invalid); znaczniki MRK-* mają zniknąć z danych
// zanonimizowanych gospodarstw i zostać w pozostałych. Każdy test buduje własny stan
// z niezmiennego wzorca (paczka, dziennik), więc nie zależy od innych testów.
import test, { after, afterEach, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handlePgRequest } from '../src/pg/app.js';
import { assertNoPii } from '../src/pg/audit.js';
import { buildYearlyExport, canonicalJson, restoreBundle, sha256Hex } from '../src/pg/export.js';
import {
  buildAnonymizationLog, mergeLogRuns, parseAnonymizationLog, readAnonymizationLog, serializeAnonymizationLog,
} from '../src/pg/anonymization-log.js';
import { reapplyAnonymizationRuns } from '../src/pg/anonymization-reapply.js';
import { runExportLogCli } from '../scripts/export-anonymization-log.js';
import { runReapplyCli } from '../scripts/reapply-anonymization.js';
import { assertCaptured, assertEvery } from './helpers/assertions.js';
import { createTestDb, request, seedClass, seedRoleGrant, seedSchoolYear, seedUser, seedUserSession, assertOwnerGuard, ownerDb } from './helpers/pg.js';

const Y1 = 'y-reapply-1';
const TEST_ENV = { APP_ENV: 'test' };

async function seedSource(db) {
  await seedSchoolYear(db, Y1, { startsOn: '2020-09-01', endsOn: '2021-08-31' });
  await seedClass(db, { id: 'c-ra-1', schoolYearId: Y1, name: '1A' });
  await seedUser(db, { userId: 'u-skarbnik-seed' });
  await db.exec(`
    INSERT INTO households (id) VALUES ('h-1'), ('h-2'), ('h-x');
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
      ('g-a', 'h-1', 'Anna', 'MRK-OPIEKUN-A', 'opiekun-a@example.invalid', true),
      ('g-b', 'h-2', 'Bartek', 'MRK-OPIEKUN-B', 'opiekun-b@example.invalid', true),
      ('g-x', 'h-x', 'Olga', 'MRK-OBCY', 'obcy@example.invalid', true);
    INSERT INTO students (id, household_id, first_name, last_name) VALUES
      ('s-1', 'h-1', 'Ola', 'MRK-UCZEN-1'), ('s-2', 'h-1', 'Jan', 'MRK-UCZEN-2'),
      ('s-3', 'h-2', 'Iga', 'MRK-UCZEN-3'), ('s-x', 'h-x', 'Kuba', 'MRK-OBCE-DZIECKO');
    INSERT INTO student_households (id, student_id, household_id, is_primary, source)
      VALUES ('sh-1-h2', 's-1', 'h-2', false, 'api');
    INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES
      ('s-1', 'g-a', true, true), ('s-2', 'g-a', true, true), ('s-1', 'g-b', true, false),
      ('s-3', 'g-b', true, true), ('s-x', 'g-x', true, true);
    INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
      ('e-1', 's-1', 'c-ra-1', '${Y1}'), ('e-2', 's-2', 'c-ra-1', '${Y1}'),
      ('e-3', 's-3', 'c-ra-1', '${Y1}'), ('e-x', 's-x', 'c-ra-1', '${Y1}');
    INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, reference, status, created_by, idempotency_key) VALUES
      ('p-1a', 'h-1', '${Y1}', 2000, '2020-10-01', 'bank', 'Składka MRK-TYTUL-1A', 'recorded', 'u-skarbnik-seed', 'p-1a-key-0001'),
      ('p-1b', 'h-1', '${Y1}', 1500, '2021-01-10', 'cash', 'MRK-TYTUL-1B', 'recorded', 'u-skarbnik-seed', 'p-1b-key-0001'),
      ('p-2', 'h-2', '${Y1}', 1234, '2020-10-06', 'bank', 'MRK-TYTUL-H2', 'recorded', 'u-skarbnik-seed', 'p-2-key-00001'),
      ('p-x', 'h-x', '${Y1}', 777, '2020-10-08', 'bank', 'MRK-TYTUL-HX', 'recorded', 'u-skarbnik-seed', 'p-x-key-00001');
    INSERT INTO payment_corrections (id, payment_entry_id, amount_cents, reason, created_by, idempotency_key) VALUES
      ('pc-1a', 'p-1a', 500, 'MRK-POWOD-KOREKTY', 'u-skarbnik-seed', 'pc-1a-key-0001'),
      ('pc-2', 'p-2', 34, 'MRK-POWOD-H2', 'u-skarbnik-seed', 'pc-2-key-00001');
    INSERT INTO payment_refunds (id, payment_entry_id, amount_cents, refunded_on, method, reason, created_by, idempotency_key)
      VALUES ('pr-1b', 'p-1b', 300, '2021-02-01', 'bank', 'MRK-POWOD-ZWROTU', 'u-skarbnik-seed', 'pr-1b-key-0001');
    INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by)
      VALUES ('cat-ra', '${Y1}', 'expense', 'Kategoria syntetyczna', 'u-skarbnik-seed');
    INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on, method, created_by, idempotency_key)
      VALUES ('le-1', '${Y1}', 'expense', 1111, 'cat-ra', 'MRK-OPIS-KSIEGI', '2020-11-01', 'bank', 'u-skarbnik-seed', 'le-1-key-00001');
  `);
}

const MARKERS_H1 = ['MRK-OPIEKUN-A', 'opiekun-a@example.invalid', 'MRK-UCZEN-2', 'MRK-TYTUL-1A', 'MRK-TYTUL-1B', 'MRK-POWOD-KOREKTY', 'MRK-POWOD-ZWROTU'];
const MARKERS_H2 = ['MRK-OPIEKUN-B', 'opiekun-b@example.invalid', 'MRK-UCZEN-3', 'MRK-TYTUL-H2', 'MRK-POWOD-H2'];
const MARKERS_SHARED_CHILD = ['MRK-UCZEN-1'];
const MARKERS_UNTOUCHED = ['MRK-OBCY', 'obcy@example.invalid', 'MRK-OBCE-DZIECKO', 'MRK-TYTUL-HX'];

// Pola osobowe i tekstowe dotknięte przebiegiem, które obejmuje paczka roczna.
async function personalState(db) {
  const q = async (sql) => (await db.query(sql)).rows;
  return {
    guardians: await q('SELECT id, first_name, last_name, email, contact_allowed FROM guardians ORDER BY id'),
    students: await q('SELECT id, first_name, last_name FROM students ORDER BY id'),
    references: await q('SELECT id, reference FROM payment_entries ORDER BY id'),
    corrections: await q('SELECT id, reason FROM payment_corrections ORDER BY id'),
    refunds: await q('SELECT id, reason FROM payment_refunds ORDER BY id'),
  };
}

async function financialSnapshot(db) {
  const q = async (sql) => (await db.query(sql)).rows;
  return {
    totals: await q('SELECT household_id, school_year_id, net_amount_cents::int AS net, payment_count::int AS n FROM household_payment_totals ORDER BY 1, 2'),
    entries: await q('SELECT id, household_id, school_year_id, amount_cents, received_on::text AS received_on, method, status, idempotency_key FROM payment_entries ORDER BY id'),
    corrections: await q('SELECT id, payment_entry_id, amount_cents FROM payment_corrections ORDER BY id'),
    refunds: await q('SELECT id, payment_entry_id, amount_cents, refunded_on::text AS refunded_on FROM payment_refunds ORDER BY id'),
    ledger: await q('SELECT id, amount_cents, description, school_year_id FROM ledger_entries ORDER BY id'),
    relations: await q('SELECT student_id, guardian_id FROM student_guardians ORDER BY 1, 2'),
    memberships: await q('SELECT id, student_id, household_id FROM student_households ORDER BY id'),
  };
}

const exportSums = (bundle) => Object.fromEntries(bundle.manifest.files.map((file) => [file.table, file.sums]));
const exportOf = async (db) => (await db.transaction((tx) => buildYearlyExport(tx, Y1))).bundle;
const count = async (db, sql, params) => (await db.query(sql, params)).rows[0].n;
const textOf = (value) => JSON.stringify(value);

function captureStream() {
  return { text: '', write(chunk) { this.text += chunk; return true; } };
}

async function runCli(runner, argv, { db, env = TEST_ENV, ...rest } = {}) {
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runner({ argv, env, db, stdout, stderr, ...rest });
  return { code, stdout: stdout.text, stderr: stderr.text, json: stdout.text.trim().startsWith('{') ? JSON.parse(stdout.text) : null };
}

describe('ponowne zastosowanie przebiegów anonimizacji po odtworzeniu (#91)', () => {
  const fixture = {};
  let dir;
  let logPath;
  const targets = [];

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rd-anon-reapply-'));
    const source = await createTestDb();
    fixture.source = source;
    await seedSource(source);
    const cookie = await seedUserSession(source, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
    const call = async (path, { method = 'POST', body } = {}) => {
      const response = await handlePgRequest(request(path, { cookie, method, body }), { db: source });
      const text = await response.text();
      return { status: response.status, json: text ? JSON.parse(text) : null, text };
    };
    const erasureRequest = async (householdId) => {
      const created = await call('/api/admin/data-requests', { body: { kind: 'erasure', householdId, receivedOn: '2026-10-15' } });
      assert.equal(created.status, 201, created.text);
      const moved = await call(`/api/admin/data-requests/${created.json.request.id}/status`, { body: { status: 'identity_verified' } });
      assert.equal(moved.status, 200, moved.text);
      return created.json.request.id;
    };
    const anonymize = async (householdId) => {
      const dataRequestId = await erasureRequest(householdId);
      const body = { householdId, reasonCode: 'data_subject_request', dataRequestId };
      const preview = await call('/api/admin/anonymizations', { body: { ...body, dryRun: true } });
      assert.equal(preview.status, 200, preview.text);
      const applied = await call('/api/admin/anonymizations', { body: { ...body, dryRun: false, confirm: householdId, expectedPlanSha256: preview.json.planSha256 } });
      assert.equal(applied.status, 201, applied.text);
      return applied.json;
    };

    fixture.bundleBefore = await exportOf(source);
    fixture.financialBefore = await financialSnapshot(source);
    fixture.personalBefore = await personalState(source);
    fixture.runA = await anonymize('h-1');
    fixture.runB = await anonymize('h-2');
    fixture.personalAfter = await personalState(source);
    fixture.log = await readAnonymizationLog(source);
    logPath = join(dir, 'anonymization-log.json');
    await writeFile(logPath, serializeAnonymizationLog(fixture.log));
  });

  // #111: baza docelowa żyje tylko w swoim teście — zamykamy ją zaraz po nim, a nie w after()
  // (15 baz docelowych naraz dawało ok. 4 GB RSS procesu). Baza źródłowa zostaje do końca pliku.
  afterEach(async () => {
    for (const target of targets.splice(0)) await target.close();
  });

  after(async () => {
    for (const target of targets) await target.close().catch(() => {});
    await fixture.source?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  // Pusta baza z aktualnym schematem + paczka sprzed anonimizacji + konto administratora
  // (konta nie wchodzą do paczki rocznej; po odtworzeniu zakłada się je jak w #187).
  async function restoredTarget({ admin = 'u-restored-admin' } = {}) {
    const target = await createTestDb();
    targets.push(target);
    // Odtworzenie paczki: operator na DATABASE_MIGRATION_URL (właściciel; SR-05). Samo ponowienie
    // anonimizacji biegnie dalej połączeniem aplikacji (`target`), jak skrypt z DATABASE_URL.
    await restoreBundle(ownerDb(target), fixture.bundleBefore);
    if (admin) await seedRoleGrant(target, { userId: admin, role: 'admin' });
    return target;
  }

  const reapplyArgv = (extra = []) => [`--log=${logPath}`, '--actor=u-restored-admin', ...extra];

  describe('dziennik poza bazą', () => {
    test('eksport zawiera wyłącznie identyfikatory, kody i skróty, w kolejności wykonania, i przechodzi weryfikację', async () => {
      const text = await readFile(logPath, 'utf8');
      const parsed = parseAnonymizationLog(text);
      assert.equal(parsed.runs.length, 2);
      assert.deepEqual(parsed.runs.map((run) => run.householdId), ['h-1', 'h-2']);
      assert.deepEqual(parsed.runs.map((run) => run.runId), [fixture.runA.runId, fixture.runB.runId]);
      assertEvery(parsed.runs, (run) => run.reasonCode === 'data_subject_request' && /^[0-9a-f]{64}$/.test(run.planSha256) && run.executedBy === 'u-admin');
      assert.deepEqual(parsed.runs.map((run) => run.planSha256), [fixture.runA.planSha256, fixture.runB.planSha256]);
      for (const marker of [...MARKERS_H1, ...MARKERS_H2, ...MARKERS_SHARED_CHILD, 'Anna', 'Ola', '@']) {
        assert.ok(!text.includes(marker), `plik dziennika zawiera dane osobowe: ${marker}`);
      }
      assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['exportedAt', 'format', 'formatVersion', 'runs', 'runsSha256']);
    });

    test('skrypt eksportu zapisuje plik 0600, nie nadpisuje istniejącego i nie wypisuje nic poza liczbą i sumą', async () => {
      const out = join(dir, 'export-cli.json');
      const first = await runCli(runExportLogCli, [`--out=${out}`], { db: fixture.source });
      assert.equal(first.code, 0, first.stderr);
      assert.equal(first.json.runs, 2);
      assert.deepEqual(Object.keys(first.json).sort(), ['exportedAt', 'runs', 'runsSha256']);
      assert.equal(parseAnonymizationLog(await readFile(out, 'utf8')).runs.length, 2);
      assert.equal((await stat(out)).mode & 0o777, 0o600);
      const again = await runCli(runExportLogCli, [`--out=${out}`], { db: fixture.source });
      assert.equal(again.code, 1);
      assert.match(again.stderr, /output_file_exists/);
      assert.equal((await runCli(runExportLogCli, [], { db: fixture.source })).code, 1);
      assert.equal((await runCli(runExportLogCli, ['--out=x', '--zly'], { db: fixture.source })).code, 1);
    });

    test('odrzuca uszkodzony, edytowany lub zawierający dane osobowe plik', async () => {
      const text = await readFile(logPath, 'utf8');
      const log = JSON.parse(text);
      const withSum = (runs, extra = {}) => JSON.stringify({ ...log, runs, runsSha256: sha256Hex(canonicalJson(runs)), ...extra });
      const [first, second] = log.runs;
      const codeOf = (input) => { try { parseAnonymizationLog(input); return null; } catch (error) { return error.code; } };

      assert.equal(codeOf('to nie jest json'), 'log_not_json');
      assert.equal(codeOf(JSON.stringify({ ...log, format: 'inny' })), 'log_wrong_format');
      assert.equal(codeOf(JSON.stringify({ ...log, formatVersion: 2 })), 'log_unsupported_version');
      assert.equal(codeOf(JSON.stringify({ ...log, extra: 1 })), 'log_unexpected_fields');
      assert.equal(codeOf(JSON.stringify({ ...log, runs: [{ ...first, planSha256: 'a'.repeat(64) }, second] })), 'log_checksum_mismatch');
      // Suma przeliczona (ktoś edytował świadomie), ale wpis łamie wzorce — nadal odrzucony.
      assert.equal(codeOf(withSum([{ ...first, email: 'anna@example.invalid' }, second])), 'unexpected_fields:runs[0]');
      assert.equal(codeOf(withSum([{ ...first, householdId: 'anna@example.invalid' }, second])), 'invalid_field:runs[0].householdId');
      assert.equal(codeOf(withSum([{ ...first, householdId: 'Anna Kowalska' }, second])), 'invalid_field:runs[0].householdId');
      assert.equal(codeOf(withSum([{ ...first, reasonCode: 'restore_reapply' }, second])), 'invalid_field:runs[0].reasonCode');
      assert.equal(codeOf(withSum([{ ...first, dataSubjectRequestId: null }, second])), 'invalid_field:runs[0].dataSubjectRequestId');
      assert.equal(codeOf(withSum([{ ...first, retentionPolicyIds: ['p-1'] }, second])), 'invalid_field:runs[0].retentionPolicyIds');
      assert.equal(codeOf(withSum([{ ...first, runId: 'nie-uuid' }, second])), 'invalid_field:runs[0].runId');
      assert.equal(codeOf(withSum([first, { ...second, runId: first.runId }])), 'duplicate_run_id');
      assert.equal(codeOf(withSum([first, second])), null, 'kontrola pozytywna: poprawny plik przechodzi');
    });

    test('łączenie kilku plików: suma po runId, sprzeczny wpis o tym samym runId to błąd', async () => {
      const { runs } = parseAnonymizationLog(await readFile(logPath, 'utf8'));
      const merged = mergeLogRuns([[runs[1]], [runs[0], runs[1]]]);
      assert.deepEqual(merged.map((run) => run.runId), runs.map((run) => run.runId));
      assert.throws(() => mergeLogRuns([[runs[0]], [{ ...runs[0], planSha256: 'b'.repeat(64) }]]), { code: 'log_conflict' });
    });
  });

  describe('odtworzenie paczki sprzed anonimizacji', () => {
    test('paczka przywraca dane osobowe, a w bazie nie ma żadnego przebiegu — stąd dziennik poza bazą', async () => {
      const target = await restoredTarget();
      const dump = textOf(await personalState(target));
      for (const marker of [...MARKERS_H1, ...MARKERS_H2, ...MARKERS_SHARED_CHILD, ...MARKERS_UNTOUCHED]) {
        assert.ok(dump.includes(marker), `odtworzona baza nie ma: ${marker}`);
      }
      assert.equal(await count(target, 'SELECT count(*)::int AS n FROM anonymization_runs'), 0);
      assert.deepEqual(await personalState(target), fixture.personalBefore);
    });

    test('podgląd (--dry-run) niczego nie zmienia, wskazuje oba przebiegi i zostawia tylko ślad podglądu', async () => {
      const target = await restoredTarget();
      const stateBefore = await personalState(target);
      const financialBefore = await financialSnapshot(target);
      const result = await runCli(runReapplyCli, reapplyArgv(['--dry-run']), { db: target });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.json.mode, 'dry_run');
      assert.deepEqual(result.json.summary, { would_apply: 2 });
      assert.deepEqual(result.json.runs.map((run) => run.outcome), ['would_apply', 'would_apply']);
      assert.deepEqual(result.json.runs.map((run) => run.householdId), ['h-1', 'h-2']);
      assertEvery(result.json.runs, (run) => run.planMatchesSource === true, 'ten sam stan danych daje ten sam skrót planu co przebieg źródłowy');
      assert.equal(result.json.runs[0].retained.students, 1, 'dziecko wspólne zostaje do przebiegu drugiego gospodarstwa');
      assert.equal(result.json.runs[1].retained.students, 0, 'podgląd drugiego widzi skutek pierwszego');
      for (const marker of [...MARKERS_H1, ...MARKERS_H2, ...MARKERS_SHARED_CHILD, 'Anna']) {
        assert.ok(!result.stdout.includes(marker), `wynik podglądu zawiera dane osobowe: ${marker}`);
      }
      assert.deepEqual(await personalState(target), stateBefore);
      assert.deepEqual(await financialSnapshot(target), financialBefore);
      assert.equal(await count(target, 'SELECT count(*)::int AS n FROM anonymization_runs'), 0);
      assert.equal(await count(target, "SELECT count(*)::int AS n FROM audit_events WHERE action = 'household.anonymized'"), 0);
      const { rows: previews } = await target.query("SELECT actor_id, entity_id, metadata_json FROM audit_events WHERE action = 'household.anonymization_previewed' ORDER BY entity_id");
      assert.deepEqual(previews.map((row) => [row.actor_id, row.entity_id]), [['u-restored-admin', 'h-1'], ['u-restored-admin', 'h-2']]);
      for (const row of previews) assertNoPii(row.metadata_json);
    });

    test('ponowne zastosowanie: dane osobowe zastąpione, sumy wpłat, księga i eksport roczny bez zmian', async () => {
      const target = await restoredTarget();
      const financialBefore = await financialSnapshot(target);
      const exportBefore = await exportOf(target);
      const result = await runCli(runReapplyCli, reapplyArgv(), { db: target });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.json.mode, 'apply');
      assert.deepEqual(result.json.summary, { applied: 2 });

      const stateAfter = await personalState(target);
      const dump = textOf(stateAfter);
      for (const marker of [...MARKERS_H1, ...MARKERS_H2, ...MARKERS_SHARED_CHILD]) {
        assert.ok(!dump.includes(marker), `po ponowieniu zostało: ${marker}`);
      }
      for (const marker of MARKERS_UNTOUCHED) assert.ok(dump.includes(marker), `nietknięte gospodarstwo straciło: ${marker}`);
      // Stan identyczny ze źródłem po przebiegach (te same tabele, te same wartości zastępcze).
      assert.deepEqual(stateAfter, fixture.personalAfter);

      // Kwoty, daty, statusy, relacje i księga — bez zmian; to samo co przed anonimizacją w źródle.
      const financialAfter = await financialSnapshot(target);
      assert.deepEqual(financialAfter, financialBefore);
      assert.deepEqual(financialAfter, fixture.financialBefore);
      assert.deepEqual(financialAfter.totals.find((row) => row.household_id === 'h-1'), {
        household_id: 'h-1', school_year_id: Y1, net: 2000 + 1500 - 500 - 300, n: 2,
      });
      const exportAfter = await exportOf(target);
      assert.deepEqual(exportAfter.manifest.totals, exportBefore.manifest.totals);
      assert.deepEqual(exportSums(exportAfter), exportSums(exportBefore));
      assert.deepEqual(exportSums(exportAfter), exportSums(fixture.bundleBefore));
      const exportText = JSON.stringify(exportAfter.files);
      for (const marker of [...MARKERS_H1, ...MARKERS_H2, ...MARKERS_SHARED_CHILD]) assert.ok(!exportText.includes(marker), `eksport zawiera: ${marker}`);
      assert.ok(exportText.includes('MRK-OBCY'));
    });

    test('dziennik i audyt: kod restore_reapply, identyfikatory pierwotnych przebiegów, aktor ponowienia, bez danych osobowych', async () => {
      const target = await restoredTarget();
      assert.equal((await runCli(runReapplyCli, reapplyArgv(), { db: target })).code, 0);
      const { rows: runs } = await target.query('SELECT * FROM anonymization_runs ORDER BY executed_at, id');
      assert.equal(runs.length, 2);
      assert.deepEqual(runs.map((run) => run.id).sort(), [fixture.runA.runId, fixture.runB.runId].sort());
      assertEvery(runs, (run) => run.reason_code === 'restore_reapply' && run.executed_by === 'u-restored-admin'
        && run.data_subject_request_id === null && run.retention_policy_ids.length === 0);
      const original = fixture.log.runs.find((run) => run.runId === fixture.runA.runId);
      const reapplied = runs.find((run) => run.id === fixture.runA.runId);
      assert.deepEqual(reapplied.source_run, {
        reasonCode: 'data_subject_request', dataSubjectRequestId: original.dataSubjectRequestId, retentionPolicyIds: [],
        planSha256: original.planSha256, executedAt: original.executedAt, executedBy: 'u-admin',
      });
      assert.equal(reapplied.plan_sha256, original.planSha256);

      const { rows: events } = await target.query("SELECT actor_id, entity_type, entity_id, metadata_json FROM audit_events WHERE action = 'household.anonymized'");
      assert.equal(events.length, 2);
      assertEvery(events, (event) => event.actor_id === 'u-restored-admin' && event.entity_type === 'anonymization_run'
        && event.metadata_json.reasonCode === 'restore_reapply' && event.metadata_json.sourceReasonCode === 'data_subject_request');
      assert.deepEqual(events.map((event) => event.entity_id).sort(), runs.map((run) => run.id).sort());
      for (const event of events) assertNoPii(event.metadata_json);
      const serialized = JSON.stringify([runs, events]);
      for (const marker of [...MARKERS_H1, ...MARKERS_H2, 'Anna', 'Ola']) assert.ok(!serialized.includes(marker), marker);

      // Eksport dziennika po ponowieniu jest równoważny pierwotnemu (przebiegi w terminach źródłowych).
      const exportedAgain = await readAnonymizationLog(target);
      assert.deepEqual(exportedAgain.runs, fixture.log.runs);
      assert.equal(exportedAgain.runsSha256, fixture.log.runsSha256);
    });

    test('ponowienie i podwójne uruchomienie: przebiegi już w bazie są pomijane, bez drugiego wpisu i zdarzenia', async () => {
      const target = await restoredTarget();
      const { runs } = parseAnonymizationLog(await readFile(logPath, 'utf8'));
      const options = { actorId: 'u-restored-admin', runs, dryRun: false };
      const [first, second] = await Promise.all([reapplyAnonymizationRuns(target, options), reapplyAnonymizationRuns(target, options)]);
      const outcomes = [...first.runs, ...second.runs].map((run) => run.outcome).sort();
      assert.deepEqual(outcomes, ['already_recorded', 'already_recorded', 'applied', 'applied']);
      assert.equal(await count(target, 'SELECT count(*)::int AS n FROM anonymization_runs'), 2);
      assert.equal(await count(target, "SELECT count(*)::int AS n FROM audit_events WHERE action = 'household.anonymized'"), 2);
      const stateAfter = await personalState(target);

      const again = await runCli(runReapplyCli, reapplyArgv(), { db: target });
      assert.equal(again.code, 0, again.stderr);
      assert.deepEqual(again.json.summary, { already_recorded: 2 });
      assert.equal(await count(target, 'SELECT count(*)::int AS n FROM anonymization_runs'), 2);
      assert.equal(await count(target, "SELECT count(*)::int AS n FROM audit_events WHERE action = 'household.anonymized'"), 2);
      assert.deepEqual(await personalState(target), stateAfter);
    });

    test('kopia zawierająca już pierwszy przebieg: pierwszy pominięty, drugi dokańcza dziecko wspólne (opieka dzielona)', async () => {
      const target = await restoredTarget();
      const { runs } = parseAnonymizationLog(await readFile(logPath, 'utf8'));
      const onlyA = join(dir, 'only-a.json');
      await writeFile(onlyA, serializeAnonymizationLog(buildAnonymizationLog([runs[0]])));
      const partial = await runCli(runReapplyCli, [`--log=${onlyA}`, '--actor=u-restored-admin'], { db: target });
      assert.deepEqual(partial.json.summary, { applied: 1 });
      const afterA = textOf(await personalState(target));
      for (const marker of MARKERS_H1) assert.ok(!afterA.includes(marker), marker);
      assert.ok(afterA.includes('MRK-UCZEN-1'), 'dziecko wspólne zostaje, dopóki h-2 nie jest zanonimizowane');
      assert.ok(afterA.includes('MRK-OPIEKUN-B'));

      const full = await runCli(runReapplyCli, reapplyArgv(), { db: target });
      assert.deepEqual(full.json.summary, { already_recorded: 1, applied: 1 });
      const afterBoth = textOf(await personalState(target));
      for (const marker of [...MARKERS_H1, ...MARKERS_H2, ...MARKERS_SHARED_CHILD]) assert.ok(!afterBoth.includes(marker), marker);
    });

    test('wiele plików dziennika (kolejne eksporty) daje ten sam wynik co jeden plik', async () => {
      const target = await restoredTarget();
      const { runs } = parseAnonymizationLog(await readFile(logPath, 'utf8'));
      const oldFile = join(dir, 'older.json');
      await writeFile(oldFile, serializeAnonymizationLog(buildAnonymizationLog([runs[0]])));
      const result = await runCli(runReapplyCli, [`--log=${oldFile}`, `--log=${logPath}`, '--actor=u-restored-admin'], { db: target });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(result.json.summary, { applied: 2 });
      assert.deepEqual(await personalState(target), fixture.personalAfter);
    });

    test('gospodarstwa nie ma w odtworzonej bazie albo jest już zanonimizowane: pominięte bez błędu i bez wpisu', async () => {
      const target = await restoredTarget();
      const { runs } = parseAnonymizationLog(await readFile(logPath, 'utf8'));
      const extra = { ...runs[0], runId: '00000000-0000-4000-8000-0000000000aa', householdId: 'h-zalozone-po-kopii', executedAt: '2099-01-01T00:00:00.000000Z' };
      const withMissing = join(dir, 'with-missing.json');
      await writeFile(withMissing, serializeAnonymizationLog(buildAnonymizationLog([...runs, extra])));
      const result = await runCli(runReapplyCli, [`--log=${withMissing}`, '--actor=u-restored-admin'], { db: target });
      assert.deepEqual(result.json.summary, { applied: 2, household_missing: 1 });
      assert.equal(await count(target, 'SELECT count(*)::int AS n FROM anonymization_runs'), 2);

      // h-x: pierwszy wpis zmienia dane, ponowne uruchomienie jest idempotentne po runId, a to samo gospodarstwo pod nowym runId ma pusty plan (nothing_to_change).
      const hx = { ...runs[0], runId: '00000000-0000-4000-8000-0000000000bb', householdId: 'h-x', executedAt: '2099-01-02T00:00:00.000000Z' };
      const hxFile = join(dir, 'hx.json');
      await writeFile(hxFile, serializeAnonymizationLog(buildAnonymizationLog([hx])));
      assert.deepEqual((await runCli(runReapplyCli, [`--log=${hxFile}`, '--actor=u-restored-admin'], { db: target })).json.summary, { applied: 1 });
      const again = await runCli(runReapplyCli, [`--log=${hxFile}`, '--actor=u-restored-admin'], { db: target });
      assert.deepEqual(again.json.summary, { already_recorded: 1 });
      const hxAgain = { ...hx, runId: '00000000-0000-4000-8000-0000000000cc', executedAt: '2099-01-03T00:00:00.000000Z' };
      const hxAgainFile = join(dir, 'hx-again.json');
      await writeFile(hxAgainFile, serializeAnonymizationLog(buildAnonymizationLog([hxAgain])));
      const nothing = await runCli(runReapplyCli, [`--log=${hxAgainFile}`, '--actor=u-restored-admin'], { db: target });
      assert.deepEqual(nothing.json.summary, { nothing_to_change: 1 });
      assert.equal(await count(target, 'SELECT count(*)::int AS n FROM anonymization_runs WHERE household_id = $1', ['h-x']), 1);
    });
  });

  describe('odmowy i granice', () => {
    test('bez --actor, bez --log albo z nieznaną opcją: błąd użycia, nic się nie zmienia', async () => {
      const target = await restoredTarget();
      const before = await personalState(target);
      for (const argv of [[`--log=${logPath}`], ['--actor=u-restored-admin'], [`--log=${logPath}`, '--actor='], [`--log=${logPath}`, '--actor=a', '--actor=b'],
        [`--log=${logPath}`, '--actor=u-restored-admin', '--force'], [`--log=${logPath}`, '--actor=u-restored-admin', 'extra']]) {
        const result = await runCli(runReapplyCli, argv, { db: target });
        assert.equal(result.code, 1, argv.join(' '));
        assert.match(result.stderr, /Usage:/);
      }
      assert.deepEqual(await personalState(target), before);
      assert.equal(await count(target, 'SELECT count(*)::int AS n FROM anonymization_runs'), 0);
    });

    test('aktor musi być aktywnym administratorem odtworzonej bazy: brak konta, inna rola, zablokowany, cofnięty przydział', async () => {
      const target = await restoredTarget();
      await seedRoleGrant(target, { userId: 'u-board-only', role: 'board' });
      await seedUser(target, { userId: 'u-disabled-admin', disabled: true });
      await target.query("INSERT INTO role_grants (id, user_id, role) VALUES ('rg-disabled-admin', 'u-disabled-admin', 'admin')");
      await seedRoleGrant(target, { userId: 'u-revoked-admin', role: 'admin' });
      await target.query("UPDATE role_grants SET revoked_at = now(), revoked_by = 'u-restored-admin' WHERE user_id = 'u-revoked-admin'");
      const before = await personalState(target);
      for (const actor of ['u-nie-ma', 'u-board-only', 'u-disabled-admin', 'u-revoked-admin']) {
        const result = await runCli(runReapplyCli, [`--log=${logPath}`, `--actor=${actor}`], { db: target });
        assert.equal(result.code, 2, actor);
        assert.match(result.stderr, /reapply_actor_not_admin/);
        const dry = await runCli(runReapplyCli, [`--log=${logPath}`, `--actor=${actor}`, '--dry-run'], { db: target });
        assert.equal(dry.code, 2, `${actor} (podgląd)`);
      }
      assert.deepEqual(await personalState(target), before);
      assert.equal(await count(target, 'SELECT count(*)::int AS n FROM anonymization_runs'), 0);
      assert.equal(await count(target, "SELECT count(*)::int AS n FROM audit_events WHERE action IN ('household.anonymized', 'household.anonymization_previewed')"), 0);
    });

    test('środowisko produkcyjne albo nierozpoznane wymaga --allow-production (podgląd nie wymaga)', async () => {
      const target = await restoredTarget();
      const before = await personalState(target);
      for (const env of [{ APP_ENV: 'production' }, { APP_ENV: 'prod' }, {}, { APP_ENV: 'prodd' }]) {
        const refused = await runCli(runReapplyCli, reapplyArgv(), { db: target, env });
        assert.equal(refused.code, 2, JSON.stringify(env));
        assert.match(refused.stderr, /--allow-production/);
      }
      assert.deepEqual(await personalState(target), before);
      const preview = await runCli(runReapplyCli, reapplyArgv(['--dry-run']), { db: target, env: { APP_ENV: 'production' } });
      assert.equal(preview.code, 0, preview.stderr);
      const allowed = await runCli(runReapplyCli, reapplyArgv(['--allow-production']), { db: target, env: { APP_ENV: 'production' } });
      assert.equal(allowed.code, 0, allowed.stderr);
      assert.deepEqual(allowed.json.summary, { applied: 2 });
    });

    test('plik uszkodzony, nieistniejący albo z danymi osobowymi jest odrzucony przed dotknięciem bazy', async () => {
      const target = await restoredTarget();
      const before = await personalState(target);
      const bad = join(dir, 'bad.json');
      const tampered = JSON.parse(await readFile(logPath, 'utf8'));
      tampered.runs[0].planSha256 = 'c'.repeat(64);
      await writeFile(bad, JSON.stringify(tampered));
      for (const [path, code] of [[bad, 'log_checksum_mismatch'], [join(dir, 'nie-ma.json'), 'log_file_not_found']]) {
        const result = await runCli(runReapplyCli, [`--log=${path}`, '--actor=u-restored-admin'], { db: target });
        assert.equal(result.code, 1, code);
        assert.match(result.stderr, new RegExp(code));
        assert.ok(!result.stderr.includes(dir), 'komunikat nie ujawnia ścieżek');
      }
      const conflicting = join(dir, 'conflict.json');
      const { runs } = parseAnonymizationLog(await readFile(logPath, 'utf8'));
      await writeFile(conflicting, serializeAnonymizationLog(buildAnonymizationLog([{ ...runs[0], planSha256: 'd'.repeat(64) }])));
      const conflict = await runCli(runReapplyCli, [`--log=${logPath}`, `--log=${conflicting}`, '--actor=u-restored-admin'], { db: target });
      assert.equal(conflict.code, 1);
      assert.match(conflict.stderr, /log_conflict/);
      assert.deepEqual(await personalState(target), before);
      assert.equal(await count(target, 'SELECT count(*)::int AS n FROM anonymization_runs'), 0);
    });

    test('błąd w trakcie wycofuje całość (jedna transakcja), a trasa nie przyjmuje kodu restore_reapply', async () => {
      const target = await restoredTarget();
      const before = await personalState(target);
      const { runs } = parseAnonymizationLog(await readFile(logPath, 'utf8'));
      // Wstrzyknięty błąd przy zapisie drugiego wiersza dziennika: pierwszy przebieg (już wykonany w transakcji) musi się wycofać.
      let inserts = 0;
      const flaky = {
        query: (...args) => target.query(...args),
        transaction: (fn, options) => target.transaction((tx) => fn({
          query: (sql, params) => {
            if (/INSERT INTO anonymization_runs/.test(sql)) {
              inserts += 1;
              if (inserts === 2) throw Object.assign(new Error('injected'), { code: 'injected_failure' });
            }
            return tx.query(sql, params);
          },
        }), options),
      };
      await assert.rejects(reapplyAnonymizationRuns(flaky, { actorId: 'u-restored-admin', runs, dryRun: false }), { code: 'injected_failure' });
      assert.equal(inserts, 2, 'pierwszy wiersz został zapisany w transakcji, drugi się nie udał');
      assert.deepEqual(await personalState(target), before);
      assert.equal(await count(target, 'SELECT count(*)::int AS n FROM anonymization_runs'), 0);
      assert.equal(await count(target, "SELECT count(*)::int AS n FROM audit_events WHERE action = 'household.anonymized'"), 0);

      const cookie = await seedUserSession(target, { userId: 'u-admin-route', roles: [{ role: 'admin' }], mfa: true });
      const response = await handlePgRequest(request('/api/admin/anonymizations', {
        method: 'POST', cookie, body: { householdId: 'h-1', reasonCode: 'restore_reapply' },
      }), { db: target });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, 'invalid_reason_code');
    });

    test('strażniki niezmienności działają po ponowieniu: bezpośredni UPDATE/DELETE odrzucany, dziennik tylko do dopisywania', async () => {
      const target = await restoredTarget();
      assert.equal((await runCli(runReapplyCli, reapplyArgv(), { db: target })).code, 0);
      await assert.rejects(target.query("UPDATE payment_entries SET reference = NULL WHERE id = 'p-x'"), /payment_financial_facts_immutable/);
      await assert.rejects(target.query("UPDATE payment_entries SET amount_cents = 1 WHERE id = 'p-1a'"), /payment_financial_facts_immutable/);
      await assertOwnerGuard(target, "DELETE FROM payment_entries WHERE id = 'p-1a'", /payment_entries_cannot_be_deleted/);
      await assert.rejects(target.query("UPDATE anonymization_runs SET source_run = '{}'::jsonb"), /anonymization_runs_is_append_only/);
      await assertOwnerGuard(target, 'DELETE FROM anonymization_runs', /anonymization_runs_is_append_only/);
      // Schemat nie przyjmuje wiersza restore_reapply bez kompletnych danych źródłowych.
      await assert.rejects(target.query(
        `INSERT INTO anonymization_runs (id, household_id, reason_code, plan_sha256, counts, executed_by)
         VALUES ('00000000-0000-4000-8000-000000000111', 'h-x', 'restore_reapply', $1, '{}'::jsonb, 'u-restored-admin')`, ['f'.repeat(64)]),
      /anonymization_runs_reason_shape/);
      await assert.rejects(target.query(
        `INSERT INTO anonymization_runs (id, household_id, reason_code, plan_sha256, counts, executed_by, source_run)
         VALUES ('00000000-0000-4000-8000-000000000112', 'h-x', 'retention_policy', $1, '{}'::jsonb, 'u-restored-admin', '{}'::jsonb)`, ['f'.repeat(64)]),
      /anonymization_runs_reason_shape/);
      assertCaptured(await target.query("SELECT 1 FROM anonymization_runs WHERE reason_code = 'restore_reapply'").then((result) => result.rows), { exact: 2 });
    });
  });
});
