// Eksport roczny, weryfikacja manifestu i test odtworzenia (issue #9).
// Wyłącznie dane syntetyczne; domeny .invalid.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handlePgRequest } from '../src/pg/app.js';
import { insertAuditEvent } from '../src/pg/audit.js';
import {
  assertRestoreAllowed, buildYearlyExport, canonicalJson, restoreBundle, sha256Hex, verifyBundle,
} from '../src/pg/export.js';
import { createMeeting, createMinutesVersion, createResolution, determineQuorum, recordAttendance } from '../src/pg/meetings.js';
import { updateMeeting } from './helpers/with-revision.js';
import { createTestDb, request, seedClass, seedRoleGrant, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';

const YEAR = 'y-2026';
const OLD_YEAR = 'y-2025';
const scriptPath = fileURLToPath(new URL('../scripts/verify-export.js', import.meta.url));

async function seedData(db) {
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, OLD_YEAR, { startsOn: '2025-09-01', endsOn: '2026-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR, name: '1A' });
  await seedClass(db, { id: 'c-2b', schoolYearId: YEAR, name: '2B' });
  await seedClass(db, { id: 'c-old', schoolYearId: OLD_YEAR, name: '1A' });
  await seedUser(db, { userId: 'u-seed' });

  // h-1: rodzeństwo s-1 (1A) i s-2 (2B); s-3 (1A) ma dwoje opiekunów z różnych gospodarstw.
  await db.query(`INSERT INTO households (id, created_at) VALUES
    ('h-1', '2026-09-02T08:00:00Z'), ('h-2', '2026-09-02T08:00:00Z'), ('h-3', '2026-09-02T08:00:00Z'),
    ('h-old', '2025-09-02T08:00:00Z')`);
  await db.query(`INSERT INTO students (id, household_id, first_name, last_name) VALUES
    ('s-1', 'h-1', 'Uczeń', 'Pierwszy'), ('s-2', 'h-1', 'Uczennica', 'Pierwsza'),
    ('s-3', 'h-2', 'Uczeń', 'Trzeci'), ('s-old', 'h-old', 'Absolwent', 'Dawny')`);
  await db.query(`INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
    ('g-1', 'h-1', 'Opiekun', 'Jeden', 'g1@example.invalid', true),
    ('g-2', 'h-2', 'Opiekunka', 'Dwa', 'g2@example.invalid', true),
    ('g-3', 'h-3', 'Opiekun', 'Trzy', 'g3@example.invalid', true),
    ('g-old', 'h-old', 'Opiekun', 'Dawny', 'gold@example.invalid', true)`);
  await db.query(`INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact, created_at) VALUES
    ('s-1', 'g-1', true, true, '2026-09-02T08:00:00Z'), ('s-2', 'g-1', true, true, '2026-09-02T08:00:00Z'),
    ('s-3', 'g-2', true, true, '2026-09-02T08:00:00Z'), ('s-3', 'g-3', false, false, '2026-09-02T08:00:00Z'),
    ('s-old', 'g-old', true, true, '2025-09-02T08:00:00Z')`);
  await db.query(`INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
    ('e-1', 's-1', 'c-1a', '${YEAR}'), ('e-2', 's-2', 'c-2b', '${YEAR}'), ('e-3', 's-3', 'c-1a', '${YEAR}'),
    ('e-old', 's-old', 'c-old', '${OLD_YEAR}')`);

  // Wpłata częściowa z korektą, wpłata nieprzypisana potem przypisana, wpłata z innego roku.
  await db.query(`INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, created_at, idempotency_key) VALUES
    ('p-1', 'h-1', '${YEAR}', 5000, '2026-09-15', 'bank', 'recorded', 'u-seed', '2026-09-15T10:00:00Z', 'payment-key-0001'),
    ('p-2', NULL, '${YEAR}', 2500, '2026-09-16', 'cash', 'unmatched', 'u-seed', '2026-09-16T10:00:00Z', 'payment-key-0002'),
    ('p-old', 'h-old', '${OLD_YEAR}', 9900, '2025-10-01', 'bank', 'recorded', 'u-seed', '2025-10-01T10:00:00Z', 'payment-key-0003')`);
  await db.query(`INSERT INTO payment_corrections (id, payment_entry_id, amount_cents, reason, created_by, created_at, idempotency_key)
    VALUES ('pc-1', 'p-1', 1000, 'Korekta testowa', 'u-seed', '2026-09-17T10:00:00Z', 'correction-key-0001')`);
  await db.query(`INSERT INTO payment_assignments (id, payment_entry_id, household_id, created_by, created_at, idempotency_key)
    VALUES ('pa-1', 'p-2', 'h-2', 'u-seed', '2026-09-18T10:00:00Z', 'assignment-key-0001')`);
  const assigned = await db.query("SELECT status, household_id FROM payment_entries WHERE id = 'p-2'");
  if (assigned.rows[0].status !== 'recorded') {
    await db.query("UPDATE payment_entries SET household_id = 'h-2', status = 'recorded' WHERE id = 'p-2'");
  }

  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by, created_at) VALUES
    ('cat-in', '${YEAR}', 'income', 'Dobrowolne wpłaty', 'u-seed', '2026-09-01T10:00:00Z'),
    ('cat-out', '${YEAR}', 'expense', 'Wydarzenia', 'u-seed', '2026-09-01T10:00:00Z')`);
  await db.query(`INSERT INTO ledger_opening_balances (id, school_year_id, amount_cents, note, created_by, created_at, idempotency_key)
    VALUES ('ob-1', '${YEAR}', 10000, 'Bilans testowy', 'u-seed', '2026-09-01T10:00:00Z', 'opening-key-0001')`);
  await db.query(`INSERT INTO ledger_opening_balance_adjustments (id, opening_balance_id, amount_cents, reason, created_by, created_at, idempotency_key)
    VALUES ('oba-1', 'ob-1', 500, 'Korekta bilansu', 'u-seed', '2026-09-02T10:00:00Z', 'opening-adjust-0001')`);
  await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on, method, created_by, created_at, idempotency_key) VALUES
    ('le-1', '${YEAR}', 'income', 20000, 'cat-in', 'Wpływ testowy', '2026-09-20', 'bank', 'u-seed', '2026-09-20T10:00:00Z', 'ledger-key-0001'),
    ('le-2', '${YEAR}', 'expense', 3000, 'cat-out', 'Wydatek testowy', '2026-09-21', 'cash', 'u-seed', '2026-09-21T10:00:00Z', 'ledger-key-0002')`);
  await db.query(`INSERT INTO ledger_corrections (id, ledger_entry_id, amount_cents, reason, created_by, created_at, idempotency_key)
    VALUES ('lc-1', 'le-2', 500, 'Korekta wydatku', 'u-seed', '2026-09-22T10:00:00Z', 'ledger-correction-1')`);
  await db.query(`INSERT INTO ledger_budget_lines (id, school_year_id, category_id, planned_cents, created_by, created_at, idempotency_key)
    VALUES ('bl-1', '${YEAR}', 'cat-out', 50000, 'u-seed', '2026-09-01T10:00:00Z', 'budget-key-0001')`);

  // #101 (SR-06): bezpośredni INSERT ... visibility='published' jest zamknięty poza
  // trybem odtworzenia (SET LOCAL rd.restore='on', ten sam mechanizm co 0027 dla dat
  // spoza roku szkolnego) — dane seedowe tego testu nie przechodzą przez pełny
  // przepływ szkic→publikacja, więc odtwarzamy tu ten tryb jak legacy_d1.
  await db.query(`BEGIN`);
  await db.query(`SET LOCAL rd.restore = 'on'`);
  await db.query(`INSERT INTO events (id, school_year_id, title, begins_at, description, visibility, published_at, created_by)
    VALUES ('ev-1', '${YEAR}', 'Piknik testowy', '2026-10-10T10:00:00Z', NULL, 'published', '2026-09-20T00:00:00Z', 'u-seed')`);
  await db.query(`COMMIT`);

  // Zebranie z obecnością (także opiekuna), kworum, uchwałą i protokołem — przez moduł zebrań.
  await seedRoleGrant(db, { userId: 'u-voter', schoolYearId: YEAR });
  const board = { userId: 'u-seed', grants: [{ role: 'board', classId: null, schoolYearId: YEAR, expiresAt: null }], mfaVerified: true };
  const { meeting } = await createMeeting(db, board, {
    idempotencyKey: 'meeting-key-0001', schoolYearId: YEAR, kind: 'plenary', title: 'Zebranie testowe',
    scheduledAt: '2026-10-01T17:00:00Z', status: 'scheduled', quorumMode: 'minimum_count', quorumMinCount: 1, quorumRuleSource: 'Założenie testowe',
  });
  await updateMeeting(db, board, { meetingId: meeting.id, status: 'held' });
  await recordAttendance(db, board, { meetingId: meeting.id, userId: 'u-voter', capacity: 'representative', votingEligible: true, present: true });
  await recordAttendance(db, board, { meetingId: meeting.id, guardianId: 'g-2', capacity: 'guest', votingEligible: false, present: true });
  await determineQuorum(db, board, { idempotencyKey: 'quorum-key-0001', meetingId: meeting.id });
  await determineQuorum(db, board, { idempotencyKey: 'quorum-key-0002', meetingId: meeting.id });
  await createResolution(db, board, { idempotencyKey: 'resolution-key-1', meetingId: meeting.id, title: 'Projekt uchwały', body: 'Treść testowa.' });
  await createMinutesVersion(db, board, { idempotencyKey: 'minutes-key-0001', meetingId: meeting.id, body: 'Protokół testowy zebrania.' });

  await insertAuditEvent(db, { actorId: 'u-seed', action: 'payment.created', entityType: 'payment_entry', entityId: 'p-1', metadata: { schoolYearId: YEAR } });
  await insertAuditEvent(db, { actorId: 'u-seed', action: 'payment.created', entityType: 'payment_entry', entityId: 'p-old', metadata: { schoolYearId: OLD_YEAR } });
  // Zdarzenie z czasem poza rokiem 2026/27 i bez oznaczenia roku (nie trafia do eksportu 2026/27).
  await db.query(`INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, occurred_at, metadata_json)
    VALUES ('ae-old', 'u-seed', 'test.old', 'test', 'x', '2025-10-01T10:00:00Z', '{}'::jsonb)`);
  return { meetingId: meeting.id };
}

// Jedna wspólna baza źródłowa dla wszystkich testów (PGlite zajmuje dużo pamięci).
let db;
before(async () => {
  db = await createTestDb();
  await seedData(db);
});
after(async () => {
  await db?.close();
});

async function exportRequest(db, cookie, schoolYearId = YEAR, options = {}) {
  return handlePgRequest(request('/api/exports', { method: 'POST', cookie, body: { schoolYearId }, ...options }), { db });
}

// #161: symuluje konto z zapisanym (potwierdzonym) czynnikiem MFA bez przechodzenia
// przez /api/mfa/enroll+confirm — wartości syntetyczne, spełniają tylko ograniczenia
// kolumn (0013_mfa.sql); test nie odczytuje sekretu.
async function markMfaEnrolled(db, userId) {
  await db.query(
    `INSERT INTO user_mfa_factors (id, user_id, method, secret_ciphertext, secret_iv, secret_tag, confirmed_at)
     VALUES ($1, $2, 'totp', 'AAAA', $3, $4, now())`,
    [crypto.randomUUID(), userId, 'A'.repeat(16), 'A'.repeat(22)],
  );
}

async function adminCookie(db, userId = 'u-admin') {
  return seedUserSession(db, { userId, roles: [{ role: 'admin' }], mfa: true });
}

function linesOf(bundle, table) {
  const content = bundle.files[`${table}.jsonl`];
  return content ? content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}

test('yearly export is deterministic, scoped to the year and recorded without content', async () => {
  const cookie = await adminCookie(db);
  const first = await exportRequest(db, cookie);
  assert.equal(first.status, 200);
  assert.match(first.headers.get('Content-Type'), /^application\/json/);
  assert.equal(first.headers.get('Content-Disposition'), `attachment; filename="rd-eksport-${YEAR}-v2.json"`);
  assert.equal(first.headers.get('Cache-Control'), 'no-store');
  const firstBody = await first.text();

  const second = await exportRequest(db, cookie);
  assert.equal(second.status, 200);
  const secondBody = await second.text();
  assert.equal(sha256Hex(firstBody), sha256Hex(secondBody), 'two runs give byte-identical bundles');
  assert.equal(first.headers.get('X-Export-Manifest-Sha256'), second.headers.get('X-Export-Manifest-Sha256'));
  assert.notEqual(first.headers.get('X-Export-Run-Id'), second.headers.get('X-Export-Run-Id'));

  const bundle = JSON.parse(firstBody);
  assert.equal(bundle.manifestSha256, first.headers.get('X-Export-Manifest-Sha256'));
  const report = verifyBundle(bundle);
  assert.equal(report.schoolYearId, YEAR);

  assert.deepEqual(linesOf(bundle, 'students').map((row) => row.id), ['s-1', 's-2', 's-3']);
  assert.deepEqual(linesOf(bundle, 'households').map((row) => row.id), ['h-1', 'h-2', 'h-3']);
  assert.deepEqual(linesOf(bundle, 'guardians').map((row) => row.id), ['g-1', 'g-2', 'g-3']);
  assert.deepEqual(Object.keys(linesOf(bundle, 'guardians')[0]).sort(),
    ['contact_allowed', 'email', 'first_name', 'household_id', 'id', 'last_name']);
  assert.deepEqual(linesOf(bundle, 'payment_entries').map((row) => row.id), ['p-1', 'p-2']);
  const payments = bundle.manifest.files.find((file) => file.table === 'payment_entries');
  assert.deepEqual(payments.sums, { amount_cents: 7500 });
  assert.deepEqual(bundle.manifest.totals.payments, { recordedNetCents: 6500, recordedCount: 2 });
  assert.deepEqual(bundle.manifest.totals.ledger,
    { openingBalanceCents: 10500, incomeCents: 20000, expenseCents: 2500, closingBalanceCents: 28000 });
  assert.equal(linesOf(bundle, 'meeting_quorum_checks').length, 2);
  assert.equal(linesOf(bundle, 'meeting_attendees').length, 2);
  assert.equal(linesOf(bundle, 'event_revisions').length, 1);
  assert.equal(linesOf(bundle, 'resolutions').length, 1);
  assert.equal(linesOf(bundle, 'meeting_minutes').length, 1);
  assert.equal(bundle.files['users.jsonl'], undefined, 'user accounts are not exported');
  assert.equal(bundle.files['sessions.jsonl'], undefined);
  const audit = linesOf(bundle, 'audit_events');
  assert.ok(audit.some((row) => row.entity_id === 'p-1'));
  assert.ok(!audit.some((row) => row.entity_id === 'p-old' || row.id === 'ae-old'));
  assert.ok(!audit.some((row) => row.action.startsWith('export.')));
  assert.match(linesOf(bundle, 'payment_entries')[0].created_at, /^2026-09-15T10:00:00\.000000Z$/);

  const runs = await db.query("SELECT kind, school_year_id, format_version, requested_by, manifest_sha256, row_counts FROM export_runs WHERE requested_by = 'u-admin' ORDER BY created_at");
  assert.equal(runs.rows.length, 2);
  assert.equal(runs.rows[0].kind, 'yearly');
  assert.equal(runs.rows[0].requested_by, 'u-admin');
  assert.equal(runs.rows[0].manifest_sha256, bundle.manifestSha256);
  assert.equal(runs.rows[0].row_counts.students, 3);
  await assert.rejects(db.query('DELETE FROM export_runs'), /export_runs_cannot_be_changed/);

  const events = await db.query("SELECT actor_id, entity_type, metadata_json FROM audit_events WHERE action = 'export.created' AND actor_id = 'u-admin'");
  assert.equal(events.rows.length, 2);
  assert.equal(events.rows[0].actor_id, 'u-admin');
  assert.equal(events.rows[0].metadata_json.rowCounts.guardians, 3);
  assert.doesNotMatch(JSON.stringify(events.rows), /@|Opiekun|Uczeń/);
});

// #154: readJson w exports.js nie sprawdzał deklarowanego Content-Length przed
// odczytem ciała (inne moduły, np. families.js/email.js, robią to najpierw).
// Skutek: zawyżony nagłówek Content-Length dla małego, poprawnego ciała nie był
// odrzucany — trasa wykonywała żądanie tak, jakby nagłówek był zgodny z rzeczywistością.
test('POST /api/exports odrzuca zawyżony deklarowany Content-Length, nawet gdy ciało mieści się w limicie', async () => {
  const cookie = await adminCookie(db, 'u-admin-cl');
  const res = await handlePgRequest(request('/api/exports', {
    method: 'POST',
    cookie,
    body: { schoolYearId: YEAR },
    headers: { 'Content-Length': '999999' },
  }), { db });
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: 'request_too_large' });
});

test('manifest verification detects tampering', async () => {
  const { bundle } = await db.transaction((tx) => buildYearlyExport(tx, YEAR));
  verifyBundle(bundle);
  const clone = () => JSON.parse(JSON.stringify(bundle));

  const content = clone();
  content.files['payment_entries.jsonl'] = content.files['payment_entries.jsonl'].replace('"amount_cents":5000', '"amount_cents":500');
  assert.throws(() => verifyBundle(content), { code: 'file_hash_mismatch:payment_entries.jsonl' });

  const rehashed = clone();
  rehashed.files['payment_entries.jsonl'] = content.files['payment_entries.jsonl'];
  rehashed.manifest.files.find((file) => file.table === 'payment_entries').sha256 = sha256Hex(content.files['payment_entries.jsonl']);
  assert.throws(() => verifyBundle(rehashed), { code: 'manifest_hash_mismatch' });

  // Nawet przy spójnie przeliczonym manifeście niezgodna suma zostaje wykryta.
  rehashed.manifestSha256 = sha256Hex(canonicalJson(rehashed.manifest));
  assert.throws(() => verifyBundle(rehashed), { code: 'sum_mismatch:payment_entries.jsonl' });

  const removedLine = clone();
  removedLine.files['students.jsonl'] = removedLine.files['students.jsonl'].split('\n').slice(1).join('\n');
  assert.throws(() => verifyBundle(removedLine), { code: 'file_hash_mismatch:students.jsonl' });

  const extra = clone();
  extra.files['users.jsonl'] = '';
  assert.throws(() => verifyBundle(extra), { code: 'unlisted_file:users.jsonl' });

  const unknown = clone();
  unknown.manifest.files.push({ path: 'users.jsonl', table: 'users', columns: ['id'], rows: 0, sha256: sha256Hex(''), sums: {} });
  unknown.files['users.jsonl'] = '';
  unknown.manifestSha256 = sha256Hex(canonicalJson(unknown.manifest));
  assert.throws(() => verifyBundle(unknown), { code: 'unknown_table:users.jsonl' });

  const version = clone();
  version.formatVersion = 99;
  assert.throws(() => verifyBundle(version), { code: 'unsupported_format_version' });
});

test('restore into an empty PGlite reproduces counts and sums; non-empty target and production are refused', async () => {
  const sums = async (db) => ({
    payments: (await db.query('SELECT sum(net_amount_cents)::int AS n FROM household_payment_totals WHERE school_year_id = $1', [YEAR])).rows[0].n,
    ledger: (await db.query('SELECT closing_balance_cents::int AS n FROM ledger_year_summary WHERE school_year_id = $1', [YEAR])).rows[0].n,
  });
  const { bundle, rowCounts } = await db.transaction((tx) => buildYearlyExport(tx, YEAR));
  const sourceSums = await sums(db);
  assert.deepEqual(sourceSums, { payments: 6500, ledger: 28000 });

  const target = await createTestDb();
  try {
    const tampered = JSON.parse(JSON.stringify(bundle));
    tampered.files['students.jsonl'] += '{"first_name":"X","household_id":"h-1","id":"s-x","last_name":"Y"}\n';
    await assert.rejects(restoreBundle(target, tampered), { code: 'file_hash_mismatch:students.jsonl' });
    assert.equal((await target.query('SELECT count(*)::int AS n FROM students')).rows[0].n, 0);

    const report = await restoreBundle(target, bundle);
    assert.equal(report.restored, true);
    assert.equal(report.reexportFilesMatch, true);
    assert.equal(report.reexportTotalsMatch, true);

    for (const [table, count] of Object.entries(rowCounts)) {
      const { rows } = await target.query(`SELECT count(*)::int AS n FROM ${table}`);
      assert.equal(rows[0].n, count, table);
    }
    assert.deepEqual(await sums(target), sourceSums);

    // Identyfikatory IDENTITY są kontynuowane po odtworzeniu.
    const seq = await target.query('SELECT max(seq)::int AS n FROM meeting_quorum_checks');
    assert.equal(seq.rows[0].n, 2);

    // Triggery działają ponownie po odtworzeniu (historia finansowa niezmienna).
    await assert.rejects(target.query("DELETE FROM payment_corrections WHERE id = 'pc-1'"), /cannot_be/);

    const again = await target.transaction((tx) => buildYearlyExport(tx, YEAR));
    assert.equal(again.manifestSha256, bundle.manifestSha256);

    await assert.rejects(restoreBundle(target, bundle), (error) => error.code.startsWith('target_not_empty:'));
    const counts = await target.query('SELECT count(*)::int AS n FROM students');
    assert.equal(counts.rows[0].n, 3, 'refused restore changed nothing');

    assert.throws(() => assertRestoreAllowed({ appEnv: 'production' }), { code: 'production_restore_requires_allow_production' });
    assert.doesNotThrow(() => assertRestoreAllowed({ appEnv: 'production', allowProduction: true }));
    assert.doesNotThrow(() => assertRestoreAllowed({ appEnv: 'staging' }));
  } finally {
    await target.close();
  }
});

test('verify-export script checks a bundle and refuses production restore without the flag', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rd-export-test-'));
  try {
    const { body } = await db.transaction((tx) => buildYearlyExport(tx, YEAR));
    const file = join(directory, 'bundle.json');
    await writeFile(file, body, { mode: 0o600 });
    const env = { ...process.env, APP_ENV: 'staging', DATABASE_URL: '' };

    const verify = spawnSync(process.execPath, [scriptPath, file], { env, encoding: 'utf8' });
    assert.equal(verify.status, 0, verify.stderr);
    assert.equal(JSON.parse(verify.stdout).verified, true);
    assert.doesNotMatch(verify.stdout, /@|Opiekun|Uczeń/);

    const production = spawnSync(process.execPath, [scriptPath, file, '--restore-database'],
      { env: { ...env, APP_ENV: 'production', DATABASE_URL: 'postgres://invalid.invalid/rd' }, encoding: 'utf8' });
    assert.equal(production.status, 1);
    assert.match(production.stderr, /production_restore_requires_allow_production/);

    const tamperedBody = body.replace('\\"amount_cents\\":5000', '\\"amount_cents\\":5001');
    assert.notEqual(tamperedBody, body);
    await writeFile(file, tamperedBody);
    const tampered = spawnSync(process.execPath, [scriptPath, file], { env, encoding: 'utf8' });
    assert.equal(tampered.status, 1);
    assert.match(tampered.stderr, /file_hash_mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('yearly export requires admin or board with MFA in the year scope', async () => {
  const countRuns = async () => (await db.query('SELECT count(*)::int AS n FROM export_runs')).rows[0].n;
  const runsBefore = await countRuns();
  assert.equal((await exportRequest(db, undefined)).status, 401);

  const noMfa = await seedUserSession(db, { userId: 'u-admin-nomfa', roles: [{ role: 'admin' }], mfa: false });
  const noMfaResponse = await exportRequest(db, noMfa);
  assert.equal(noMfaResponse.status, 403);
  // Bramka MFA routera: admin bez czynnika i bez sesji z MFA musi najpierw zapisać MFA.
  assert.deepEqual(await noMfaResponse.json(), { error: 'mfa_enrollment_required' });

  for (const [userId, grant] of [
    ['u-treasurer', { role: 'treasurer', schoolYearId: YEAR }],
    ['u-audit', { role: 'audit', schoolYearId: YEAR }],
    ['u-principal', { role: 'principal' }],
    ['u-rep', { role: 'representative', classId: 'c-1a', schoolYearId: YEAR }],
    ['u-board-old', { role: 'board', schoolYearId: OLD_YEAR }],
    ['u-admin-revoked', { role: 'admin', revoked: true }],
  ]) {
    const cookie = await seedUserSession(db, { userId, roles: [grant], mfa: true });
    assert.equal((await exportRequest(db, cookie)).status, 403, userId);
  }

  assert.equal(await countRuns(), runsBefore, 'refused requests create no export run');

  const board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: true });
  assert.equal((await exportRequest(db, board)).status, 200);
  assert.equal(await countRuns(), runsBefore + 1);

  const admin = await adminCookie(db);
  assert.equal((await exportRequest(db, admin, 'y-missing')).status, 404);
  assert.equal((await exportRequest(db, admin, '../etc')).status, 400);
  assert.equal((await exportRequest(db, admin, YEAR, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await handlePgRequest(request('/api/exports', { cookie: admin }), { db })).status, 405);
  assert.equal(await countRuns(), runsBefore + 1, 'refused requests create no export run');
});

// #150 (SR-10, krok w górę): eksport roczny wymaga MFA potwierdzonego od
// niedawna (15 min), nie tylko kiedyś w bieżącej sesji.
test('yearly export requires FRESH MFA (step-up): stale confirmation is 403 mfa_stale, a new one is 200', async () => {
  const countRuns = async () => (await db.query('SELECT count(*)::int AS n FROM export_runs')).rows[0].n;

  const fresh10min = await seedUserSession(db, { userId: 'u-board-fresh', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: true });
  await db.query("UPDATE sessions SET mfa_verified_at = now() - interval '10 minutes' WHERE user_id = 'u-board-fresh'");
  const runsBefore = await countRuns();
  assert.equal((await exportRequest(db, fresh10min)).status, 200, 'MFA 10 min temu jest wciąż świeże (próg 15 min)');
  assert.equal(await countRuns(), runsBefore + 1);

  const stale20min = await seedUserSession(db, { userId: 'u-board-stale', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: true });
  await db.query("UPDATE sessions SET mfa_verified_at = now() - interval '20 minutes' WHERE user_id = 'u-board-stale'");
  const stale = await exportRequest(db, stale20min);
  assert.equal(stale.status, 403);
  assert.deepEqual(await stale.json(), { error: 'mfa_stale' });
  assert.equal(await countRuns(), runsBefore + 1, 'odmowa mfa_stale nic nie zapisuje');

  // Po ponownym potwierdzeniu kodu (symulowane: mfa_verified_at znów świeże,
  // ta sama sesja) żądanie przechodzi.
  await db.query("UPDATE sessions SET mfa_verified_at = now() WHERE user_id = 'u-board-stale'");
  assert.equal((await exportRequest(db, stale20min)).status, 200);
  assert.equal(await countRuns(), runsBefore + 2);
});

test('representative exports only the roster of their own class, without financial data', async () => {
  const rep = await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }], mfa: true });
  const roster = (classId, cookie = rep) => handlePgRequest(request(`/api/exports/class-roster?classId=${classId}`, { cookie }), { db });

  const own = await roster('c-1a');
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('Content-Disposition'), 'attachment; filename="rd-lista-klasy-c-1a-v1.json"');
  assert.equal(own.headers.get('Cache-Control'), 'no-store');
  const text = await own.text();
  const data = JSON.parse(text);
  assert.deepEqual(data.class, { id: 'c-1a', name: '1A', schoolYearId: YEAR });
  assert.deepEqual(data.students.map((student) => student.id), ['s-1', 's-3']);
  const s3 = data.students.find((student) => student.id === 's-3');
  assert.deepEqual(s3.guardians.map((guardian) => [guardian.id, guardian.email]),
    [['g-2', 'g2@example.invalid'], ['g-3', null]], 'e-mail only with contact consent');
  assert.doesNotMatch(text, /amount|cents|payment|household|h-1|s-2/);
  const { sha256, ...content } = data;
  assert.equal(sha256, sha256Hex(canonicalJson(content)));

  assert.equal((await roster('c-2b')).status, 403, 'other class');
  assert.equal((await roster('c-missing')).status, 403, 'unknown class is indistinguishable for a representative');
  assert.equal((await roster('')).status, 400);
  const repNoMfa = await seedUserSession(db, { userId: 'u-rep-nomfa', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }], mfa: false });
  const noMfaResponse = await roster('c-1a', repNoMfa);
  assert.equal(noMfaResponse.status, 403);
  // #161: sam brak MFA (rola i klasa pasują) prowadzi do właściwego widoku
  // logowania — konto bez czynnika dostaje mfa_enrollment_required, nie forbidden.
  assert.deepEqual(await noMfaResponse.json(), { error: 'mfa_enrollment_required' });

  await markMfaEnrolled(db, 'u-rep-nomfa');
  const repFactorNoVerify = await seedUserSession(db, { userId: 'u-rep-nomfa', mfa: false });
  const factorResponse = await roster('c-1a', repFactorNoVerify);
  assert.equal(factorResponse.status, 403);
  // Czynnik jest zapisany, ale ta sesja nie potwierdziła jeszcze kodu; bramka
  // routera (mfa-policy.js, reguła 1) blokuje każdą chronioną trasę tej sesji
  // wcześniej niż zakres klasy, więc kod jest ten sam niezależnie od classId.
  assert.deepEqual(await factorResponse.json(), { error: 'mfa_required' });

  // Od 0022 przydział klasy z rokiem innym niż rok klasy jest odrzucany (#201);
  // taki wiersz mógł powstać wcześniej poza API — autoryzacja i tak go nie uznaje.
  await assert.rejects(
    seedUserSession(db, { userId: 'u-rep-old', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: OLD_YEAR }], mfa: true }),
    /class_not_in_school_year/,
  );
  // Od #198/0081 ten wiersz jest odrzucany nawet z wyłączonym triggerem —
  // złożony FK role_grants_class_in_year (niezależna gwarancja obok
  // a0_year_freeze) blokuje go też na poziomie bazy. session_replication_role
  // = replica wyłącza triggery I sprawdzanie FK na czas jednej transakcji,
  // żeby odtworzyć wiersz jak sprzed obu zabezpieczeń (np. z importu D1) i
  // sprawdzić, że autoryzacja i tak go nie uznaje.
  await db.query("SET session_replication_role = replica");
  let repOldYear;
  try {
    repOldYear = await seedUserSession(db, { userId: 'u-rep-old', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: OLD_YEAR }], mfa: true });
  } finally {
    await db.query("SET session_replication_role = origin");
  }
  assert.equal((await roster('c-1a', repOldYear)).status, 403, 'grant for another year');
  const treasurer = await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer' }], mfa: true });
  assert.equal((await roster('c-1a', treasurer)).status, 403);
  assert.equal((await roster('c-1a', null)).status, 401);

  const admin = await adminCookie(db);
  assert.equal((await roster('c-missing', admin)).status, 404);

  const runs = await db.query("SELECT kind, class_id, requested_by, row_counts FROM export_runs WHERE kind = 'class_roster'");
  assert.deepEqual(runs.rows, [{ kind: 'class_roster', class_id: 'c-1a', requested_by: 'u-rep', row_counts: { students: 2, guardians: 3 } }]);
  const audit = await db.query("SELECT metadata_json FROM audit_events WHERE action = 'export.created' AND metadata_json->>'kind' = 'class_roster'");
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0].metadata_json.kind, 'class_roster');
  assert.doesNotMatch(JSON.stringify(audit.rows), /@/);
});

// --- #132: liste klasy jako CSV (obok kanonicznego JSON) ---------------------

test('class roster as CSV: same access rules, Polish-readable format, no financial or household data', async () => {
  const rep = await seedUserSession(db, { userId: 'u-rep-csv', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }], mfa: true });
  const rosterCsv = (classId, format = 'csv', cookie = rep) =>
    handlePgRequest(request(`/api/exports/class-roster?classId=${classId}&format=${format}`, { cookie }), { db });

  const own = await rosterCsv('c-1a');
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('Content-Type'), 'text/csv; charset=utf-8');
  assert.match(own.headers.get('Content-Disposition'), /^attachment; filename="lista-klasy-1A-\d{8}\.csv"$/);
  assert.equal(own.headers.get('Cache-Control'), 'no-store');
  const rawBytes = new Uint8Array(await own.clone().arrayBuffer());
  assert.deepEqual([...rawBytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'BOM UTF-8 jak w pozostałych eksportach CSV (#121)');
  const csv = await own.text();
  assert.doesNotMatch(csv, /amount|cents|payment|household|h-1|h-2|s-1|s-3/);
  const lines = csv.trim().split('\r\n');
  assert.match(lines[0], /Lista klasy 1A/);
  assert.equal(lines[1], '');
  assert.equal(lines[2], 'Lp.;Nazwisko ucznia;Imię ucznia;Opiekun 1;E-mail opiekuna 1 (tylko przy zgodzie na kontakt);Opiekun 2;E-mail opiekuna 2 (tylko przy zgodzie na kontakt);Kontakt główny;Uwagi');
  // Nazwisko "Pierwszy" przed "Trzeci" alfabetycznie.
  assert.match(lines[3], /^1;Pierwszy;Uczeń;Opiekun Jeden;g1@example\.invalid;;;Opiekun Jeden;$/);
  assert.match(lines[4], /^2;Trzeci;Uczeń;Opiekunka Dwa;g2@example\.invalid;Opiekun Trzy;;Opiekunka Dwa;$/, 'opiekun bez zgody na kontakt (g-3) nie ma e-maila w pliku');
  assert.match(lines.at(-1), /Zawiera dane osobowe/);

  assert.equal((await rosterCsv('c-2b')).status, 403, 'other class, same as JSON');
  assert.equal((await rosterCsv('c-1a', 'xlsx')).status, 400, 'unsupported format is rejected, not silently ignored');

  const runs = await db.query("SELECT class_id FROM export_runs WHERE kind = 'class_roster' AND requested_by = 'u-rep-csv'");
  assert.equal(runs.rows.length, 1, 'CSV download is recorded in export_runs like JSON');
  const audit = await db.query("SELECT metadata_json FROM audit_events WHERE action = 'export.created' AND metadata_json->>'kind' = 'class_roster' AND actor_id = 'u-rep-csv'");
  assert.equal(audit.rows[0].metadata_json.format, 'csv');
});
