// #100 pkt 2–3: eksport danych jednej rodziny dla żądania osoby (RODO).
// Test znacznikowy: paczka zawiera dane rodziny z żądania i ŻADNEGO znacznika
// innej rodziny (rodzeństwo w jednym gospodarstwie, dwoje opiekunów z różnych
// gospodarstw, opiekun w dwóch gospodarstwach, rodzeństwo przyrodnie). Granice
// ról, stan żądania, podwójne kliknięcie, dziennik odczytu i audyt bez danych
// osobowych. Wyłącznie dane syntetyczne (.invalid).
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { assertNoPii } from '../src/pg/audit.js';
import { canonicalJson, sha256Hex } from '../src/pg/export.js';
import { FAMILY_EXPORT_TABLE_KEYS } from '../src/pg/family-export.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const Y1 = 'y-dsr-1';
const Y2 = 'y-dsr-2';

// Znaczniki osób (imiona/nazwiska/e-maile są unikalne w całej bazie).
const M = {
  gA: ['MRK-OPIEKUN-A', 'opiekun-a@example.invalid'],
  gB: ['MRK-OPIEKUN-B', 'opiekun-b@example.invalid'],
  s1: ['MRK-UCZEN-1'],
  s2: ['MRK-UCZEN-2'],
  s3: ['MRK-UCZEN-3-PRZYRODNI'],
  gM: ['MRK-OPIEKUN-M', 'opiekun-m@example.invalid'],
  gN: ['MRK-OPIEKUN-N', 'opiekun-n@example.invalid'],
  s4: ['MRK-UCZEN-4'],
  s5: ['MRK-UCZEN-5'],
  gX: ['MRK-OBCY', 'obcy@example.invalid'],
  sX: ['MRK-OBCE-DZIECKO'],
};
const markers = (...keys) => keys.flatMap((key) => M[key]);

async function seed(db) {
  await seedSchoolYear(db, Y1, { startsOn: '2025-09-01', endsOn: '2026-08-31' });
  await seedSchoolYear(db, Y2, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedClass(db, { id: 'c-dsr-1a', schoolYearId: Y1, name: '1A' });
  await seedClass(db, { id: 'c-dsr-2a', schoolYearId: Y2, name: '2A' });
  await seedClass(db, { id: 'c-dsr-2b', schoolYearId: Y2, name: '2B' });
  await db.exec(`
    INSERT INTO households (id) VALUES ('h-1'), ('h-2'), ('h-4'), ('h-5'), ('h-x');
    -- h-1: opiekun A, rodzeństwo s-1 (2A) i s-2 (2B).
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
      VALUES ('g-a', 'h-1', 'Anna', 'MRK-OPIEKUN-A', 'opiekun-a@example.invalid', true);
    INSERT INTO students (id, household_id, first_name, last_name) VALUES
      ('s-1', 'h-1', 'Ola', 'MRK-UCZEN-1'), ('s-2', 'h-1', 'Jan', 'MRK-UCZEN-2');
    -- h-2: opiekun B (drugi opiekun s-1, inne gospodarstwo) i s-3 (rodzeństwo przyrodnie, tylko B).
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
      VALUES ('g-b', 'h-2', 'Bartek', 'MRK-OPIEKUN-B', 'opiekun-b@example.invalid', true);
    INSERT INTO students (id, household_id, first_name, last_name) VALUES ('s-3', 'h-2', 'Iga', 'MRK-UCZEN-3-PRZYRODNI');
    INSERT INTO student_households (id, student_id, household_id, is_primary, source)
      VALUES ('sh-1-h2', 's-1', 'h-2', false, 'api');
    INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES
      ('s-1', 'g-a', true, true), ('s-2', 'g-a', true, true), ('s-1', 'g-b', true, false), ('s-3', 'g-b', true, true);
    -- h-4 / h-5: opiekun M należy do obu gospodarstw; h-5 ma też opiekuna N i ucznia s-5.
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
      ('g-m', 'h-4', 'Maria', 'MRK-OPIEKUN-M', 'opiekun-m@example.invalid', true),
      ('g-n', 'h-5', 'Nina', 'MRK-OPIEKUN-N', 'opiekun-n@example.invalid', true);
    INSERT INTO guardian_households (id, guardian_id, household_id, source) VALUES ('gh-m-h5', 'g-m', 'h-5', 'api');
    INSERT INTO students (id, household_id, first_name, last_name) VALUES
      ('s-4', 'h-4', 'Ewa', 'MRK-UCZEN-4'), ('s-5', 'h-5', 'Tomek', 'MRK-UCZEN-5');
    INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES
      ('s-4', 'g-m', true, true), ('s-5', 'g-n', true, true);
    -- h-x: zupełnie inna rodzina.
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
      VALUES ('g-x', 'h-x', 'Olga', 'MRK-OBCY', 'obcy@example.invalid', true);
    INSERT INTO students (id, household_id, first_name, last_name) VALUES ('s-x', 'h-x', 'Kuba', 'MRK-OBCE-DZIECKO');
    INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ('s-x', 'g-x', true, true);
    INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
      ('e-1-y1', 's-1', 'c-dsr-1a', '${Y1}'), ('e-1-y2', 's-1', 'c-dsr-2a', '${Y2}'),
      ('e-2-y2', 's-2', 'c-dsr-2b', '${Y2}'), ('e-3-y2', 's-3', 'c-dsr-2a', '${Y2}'),
      ('e-x-y2', 's-x', 'c-dsr-2a', '${Y2}');
  `);
  await seedUserSession(db, { userId: 'u-treasurer-seed', roles: [] });
  // Wpłaty częściowe i korekty w dwóch latach (h-1), wpłaty innych rodzin (h-2, h-5, h-x).
  await db.exec(`
    INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key) VALUES
      ('p-1a', 'h-1', '${Y1}', 2000, '2025-10-01', 'bank', 'recorded', 'u-treasurer-seed', 'p-1a-key-0001'),
      ('p-1b', 'h-1', '${Y1}', 1500, '2026-01-10', 'cash', 'recorded', 'u-treasurer-seed', 'p-1b-key-0001'),
      ('p-1c', 'h-1', '${Y2}', 3000, '2026-10-05', 'bank', 'recorded', 'u-treasurer-seed', 'p-1c-key-0001'),
      ('p-2', 'h-2', '${Y2}', 1234, '2026-10-06', 'bank', 'recorded', 'u-treasurer-seed', 'p-2-key-00001'),
      ('p-5', 'h-5', '${Y2}', 999, '2026-10-07', 'bank', 'recorded', 'u-treasurer-seed', 'p-5-key-00001'),
      ('p-x', 'h-x', '${Y2}', 777, '2026-10-08', 'bank', 'recorded', 'u-treasurer-seed', 'p-x-key-00001');
    INSERT INTO payment_corrections (id, payment_entry_id, amount_cents, reason, created_by, idempotency_key)
      VALUES ('pc-1a', 'p-1a', 500, 'MRK-POWOD-KOREKTY', 'u-treasurer-seed', 'pc-1a-key-0001');
  `);
  // Kampania e-mail: adresaci z h-1 (A), h-2 (B) i h-x.
  await db.query(
    `INSERT INTO email_campaigns (id, school_year_id, title, audience, subject, body_text, content_hash, created_by, updated_by, idempotency_key)
     VALUES ('cmp-1', $1, 'Kampania syntetyczna', 'all_households', 'Temat syntetyczny', repeat('x', 30), repeat('a', 64),
             'u-treasurer-seed', 'u-treasurer-seed', 'idem-cmp-dsr-1')`, [Y2]);
  await db.exec(`
    INSERT INTO email_campaign_recipients (id, campaign_id, household_id, guardian_id, email, email_hash) VALUES
      ('r-a', 'cmp-1', 'h-1', 'g-a', 'opiekun-a@example.invalid', repeat('1', 64)),
      ('r-b', 'cmp-1', 'h-2', 'g-b', 'opiekun-b@example.invalid', repeat('2', 64)),
      ('r-x', 'cmp-1', 'h-x', 'g-x', 'obcy@example.invalid', repeat('3', 64));
  `);
  await db.query(`INSERT INTO meetings (id, school_year_id, kind, title, scheduled_at, created_by)
    VALUES ('m-1', $1, 'plenary', 'Zebranie syntetyczne', '2026-11-01T17:00:00Z', 'u-treasurer-seed')`, [Y2]);
  await db.exec(`
    INSERT INTO meeting_attendees (id, meeting_id, guardian_id, capacity, voting_eligible, present, recorded_by) VALUES
      ('ma-a', 'm-1', 'g-a', 'guardian', true, true, 'u-treasurer-seed'),
      ('ma-b', 'm-1', 'g-b', 'guardian', true, true, 'u-treasurer-seed');
  `);
}

describe('eksport danych jednej rodziny (#100)', () => {
  let db;
  const env = {};
  const cookies = {};
  before(async () => {
    db = await createTestDb();
    env.db = db;
    await seed(db);
    cookies.admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
    cookies.adminNoMfa = await seedUserSession(db, { userId: 'u-admin-nomfa', roles: [{ role: 'admin' }], mfa: false });
    // MFA potwierdzone 20 minut temu — krok w górę (#150) wymaga świeższego.
    cookies.adminStale = await seedUserSession(db, { userId: 'u-admin-stale', roles: [{ role: 'admin' }], mfa: true });
    await db.query("UPDATE sessions SET mfa_verified_at = now() - interval '20 minutes' WHERE user_id = 'u-admin-stale'");
    cookies.board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: Y2 }], mfa: true });
    cookies.treasurer = await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: Y2 }], mfa: true });
    cookies.audit = await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit', schoolYearId: Y2 }], mfa: true });
    cookies.principal = await seedUserSession(db, { userId: 'u-principal', roles: [{ role: 'principal', schoolYearId: Y2 }], mfa: true });
    cookies.rep = await seedUserSession(db, {
      userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-dsr-2a', schoolYearId: Y2 }], mfa: true,
    });
  });
  after(async () => { await db?.close(); });

  const call = async (path, { cookie = cookies.admin, method = 'POST', body } = {}) => {
    const response = await handlePgRequest(request(path, { cookie, method, body }), env);
    const text = await response.text();
    const isJson = response.headers.get('content-type')?.includes('json');
    return { status: response.status, headers: response.headers, text, json: isJson && text ? JSON.parse(text) : null };
  };

  async function verifiedRequest(subject, { kind = 'access', status = 'identity_verified' } = {}) {
    const created = await call('/api/admin/data-requests', { body: { kind, ...subject, receivedOn: '2026-10-15' } });
    assert.equal(created.status, 201, created.text);
    const id = created.json.request.id;
    if (status !== 'received') {
      for (const next of ['identity_verified', 'in_progress', 'answered'].slice(0, ['identity_verified', 'in_progress', 'answered'].indexOf(status) + 1)) {
        const changed = await call(`/api/admin/data-requests/${id}/status`, { body: { status: next } });
        assert.equal(changed.status, 200, changed.text);
      }
    }
    return id;
  }
  const exportOf = (id, format) => call(`/api/admin/data-requests/${id}/export${format ? `?format=${format}` : ''}`);
  const ids = (bundle, table) => bundle.tables[table].map((row) => row.id);
  const assertNone = (text, keys, label) => {
    for (const value of markers(...keys)) assert.ok(!text.includes(value), `${label}: paczka zawiera ${value}`);
  };
  const assertAll = (text, keys, label) => {
    for (const value of markers(...keys)) assert.ok(text.includes(value), `${label}: paczka nie zawiera ${value}`);
  };

  test('gospodarstwo z rodzeństwem w dwóch klasach: oba dzieci i opiekun A; opiekun B (inne gospodarstwo) pominięty', async () => {
    const id = await verifiedRequest({ householdId: 'h-1' });
    const res = await exportOf(id);
    assert.equal(res.status, 200, res.text);
    assert.match(res.headers.get('content-disposition'), /attachment/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const bundle = res.json;
    assert.equal(bundle.format, 'rd-family-export');
    assert.deepEqual(Object.keys(bundle.tables).sort(), [...FAMILY_EXPORT_TABLE_KEYS].sort());
    assert.deepEqual(ids(bundle, 'students'), ['s-1', 's-2']);
    assert.deepEqual(ids(bundle, 'guardians'), ['g-a']);
    assertAll(res.text, ['gA', 's1', 's2'], 'h-1');
    // Brak e-maila i nazwiska drugiego opiekuna, rodzeństwa przyrodniego i innych rodzin.
    assertNone(res.text, ['gB', 's3', 'gM', 'gN', 's4', 's5', 'gX', 'sX'], 'h-1');
    for (const value of ['"h-2"', '"h-x"', '"h-5"', 'MRK-POWOD-KOREKTY']) assert.ok(!res.text.includes(value), `h-1: ${value}`);
    // Powiązania: tylko pary z zakresu; członkostwo s-1 w h-2 pominięte.
    assert.deepEqual(bundle.tables.student_guardians.map((r) => `${r.student_id}:${r.guardian_id}`), ['s-1:g-a', 's-2:g-a']);
    assert.deepEqual(bundle.tables.student_households.map((r) => `${r.student_id}:${r.household_id}`).sort(), ['s-1:h-1', 's-2:h-1']);
    assert.equal(res.headers.get('x-data-export-omitted-guardians'), '1');
    assert.equal(res.headers.get('x-data-export-omitted-households'), '1');
    // Wszystkie lata: przypisania z obu lat, wpłaty z obu lat, korekta.
    assert.deepEqual(ids(bundle, 'enrollments').sort(), ['e-1-y1', 'e-1-y2', 'e-2-y2']);
    assert.deepEqual(ids(bundle, 'payment_entries'), ['p-1a', 'p-1b', 'p-1c']);
    assert.deepEqual(ids(bundle, 'payment_corrections'), ['pc-1a']);
    assert.deepEqual(Object.keys(bundle.tables.payment_entries[0]).sort(),
      ['amount_cents', 'household_id', 'id', 'method', 'received_on', 'school_year_id', 'status'], 'bez tytułu przelewu');
    assert.deepEqual(ids(bundle, 'campaign_recipients'), ['r-a']);
    assert.deepEqual(ids(bundle, 'meeting_attendees'), ['ma-a']);
    assert.deepEqual(bundle.lookups.classes.map((r) => r.id).sort(), ['c-dsr-1a', 'c-dsr-2a', 'c-dsr-2b']);
    // Sumy w paczce = household_payment_totals (wpłaty częściowe i korekta w dwóch latach).
    const { rows } = await db.query(
      `SELECT household_id, school_year_id, net_amount_cents::int AS net, payment_count::int AS n
         FROM household_payment_totals WHERE household_id = 'h-1' ORDER BY school_year_id`,
    );
    assert.deepEqual(bundle.paymentTotals.map((r) => [r.household_id, r.school_year_id, r.net_amount_cents, r.payment_count]),
      rows.map((r) => [r.household_id, r.school_year_id, r.net, r.n]));
    assert.deepEqual(rows.map((r) => r.net), [3000, 3000]);
    // SHA-256 treści (bez pola sha256) zgadza się z nagłówkiem.
    const { sha256, ...content } = bundle;
    assert.equal(sha256Hex(canonicalJson(content)), sha256);
    assert.equal(res.headers.get('x-export-manifest-sha256'), sha256);
  });

  test('żądanie opiekuna B: B, jego dziecko wspólne i przyrodnie; bez e-maila i nazwiska opiekuna A', async () => {
    const id = await verifiedRequest({ guardianId: 'g-b' });
    const res = await exportOf(id);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(ids(res.json, 'guardians'), ['g-b']);
    assert.deepEqual(ids(res.json, 'students'), ['s-1', 's-3']);
    assertAll(res.text, ['gB', 's1', 's3'], 'g-b');
    assertNone(res.text, ['gA', 's2', 'gM', 'gN', 's4', 's5', 'gX', 'sX'], 'g-b');
    // Gospodarstwo główne s-1 (h-1) nie jest gospodarstwem B — w wierszu ucznia null.
    assert.equal(res.json.tables.students.find((r) => r.id === 's-1').household_id, null);
    assert.ok(!res.text.includes('"h-1"'), 'identyfikator gospodarstwa A nie trafia do paczki B');
    assert.deepEqual(ids(res.json, 'payment_entries'), ['p-2']);
    assert.deepEqual(ids(res.json, 'campaign_recipients'), ['r-b']);
    assert.equal(res.headers.get('x-data-export-omitted-guardians'), '1');
  });

  test('opiekun w dwóch gospodarstwach: żądanie M obejmuje oba jego gospodarstwa, bez opiekuna N i dziecka N', async () => {
    const id = await verifiedRequest({ guardianId: 'g-m' });
    const res = await exportOf(id);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(ids(res.json, 'households'), ['h-4', 'h-5']);
    assert.deepEqual(ids(res.json, 'students'), ['s-4']);
    assertAll(res.text, ['gM', 's4'], 'g-m');
    assertNone(res.text, ['gN', 's5', 'gA', 'gB', 'gX', 'sX'], 'g-m');
    // Założenie do D-07: wpłaty gospodarstw, do których opiekun należy.
    assert.deepEqual(ids(res.json, 'payment_entries'), ['p-5']);

    // Żądanie dla gospodarstwa h-5: M (członek) i N z dzieckiem s-5, bez dziecka M z h-4.
    const hid = await verifiedRequest({ householdId: 'h-5' });
    const household = await exportOf(hid);
    assert.equal(household.status, 200, household.text);
    assert.deepEqual(ids(household.json, 'guardians'), ['g-m', 'g-n']);
    assert.deepEqual(ids(household.json, 'students'), ['s-5']);
    assertNone(household.text, ['s4', 'gA', 'gB', 'gX', 'sX'], 'h-5');
    assert.equal(household.json.tables.guardians.find((r) => r.id === 'g-m').household_id, null, 'h-4 nie trafia do paczki h-5');
    assert.deepEqual(household.json.tables.guardian_households.map((r) => r.household_id), ['h-5', 'h-5']);
  });

  test('żądanie dla ucznia: tylko uczeń i jego klasy — bez opiekunów i bez wpłat', async () => {
    const id = await verifiedRequest({ studentId: 's-1' });
    const res = await exportOf(id);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(ids(res.json, 'students'), ['s-1']);
    assert.deepEqual(res.json.tables.guardians, []);
    assert.deepEqual(res.json.tables.payment_entries, []);
    assert.deepEqual(ids(res.json, 'households'), ['h-1', 'h-2']);
    assertNone(res.text, ['gA', 'gB', 's2', 's3', 'gX', 'sX'], 's-1');
    assert.equal(res.headers.get('x-data-export-omitted-guardians'), '2');
  });

  test('opiekun spoza gospodarstwa z żądania: 409 zamiast sumy dwóch rodzin', async () => {
    const created = await call('/api/admin/data-requests', { body: { kind: 'access', householdId: 'h-1', guardianId: 'g-b', receivedOn: '2026-10-15' } });
    const id = created.json.request.id;
    await call(`/api/admin/data-requests/${id}/status`, { body: { status: 'identity_verified' } });
    const res = await exportOf(id);
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'data_request_subject_mismatch');
  });

  test('podwójne kliknięcie: dwa przebiegi, ten sam SHA-256 i bajt w bajt ta sama paczka; każdy z wpisem w dzienniku i audycie', async () => {
    const id = await verifiedRequest({ householdId: 'h-1' });
    const logBefore = (await db.query(
      "SELECT count(*)::int AS n FROM data_access_log WHERE actor_id = 'u-admin' AND access_kind = 'household_card' AND household_id = 'h-1'",
    )).rows[0].n;
    const first = await exportOf(id);
    const second = await exportOf(id);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.text, second.text);
    assert.equal(first.headers.get('x-export-manifest-sha256'), second.headers.get('x-export-manifest-sha256'));
    const logAfter = (await db.query(
      "SELECT count(*)::int AS n FROM data_access_log WHERE actor_id = 'u-admin' AND access_kind = 'household_card' AND household_id = 'h-1' AND outcome = 'ok'",
    )).rows[0].n;
    assert.equal(logAfter, logBefore + 2, 'każdy przebieg to osobny wpis (bez scalania w oknie 5 minut)');
    const { rows } = await db.query(
      "SELECT actor_id, entity_type, entity_id, metadata_json FROM audit_events WHERE action = 'data_subject_request.exported' AND entity_id = $1",
      [id],
    );
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.actor_id, 'u-admin');
      assert.equal(row.entity_type, 'data_subject_request');
      assert.equal(row.metadata_json.manifestSha256, first.headers.get('x-export-manifest-sha256'));
      assert.equal(row.metadata_json.omittedGuardians, 1);
      assertNoPii(row.metadata_json);
      const text = JSON.stringify(row.metadata_json);
      for (const value of markers('gA', 'gB', 's1', 's2')) assert.ok(!text.includes(value), `audyt zawiera ${value}`);
    }
  });

  test('CSV do wydruku: polskie etykiety, kwoty EUR, te same dane co JSON i bez danych opiekuna B', async () => {
    const id = await verifiedRequest({ householdId: 'h-1' });
    const res = await exportOf(id, 'csv');
    assert.equal(res.status, 200, res.text);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /rd-dane-rodziny-.*\.csv/);
    assert.match(res.text, /Uczniowie \(2\)/);
    assert.match(res.text, /Kwota \(EUR\)/);
    assert.match(res.text, /20,00/);
    assertAll(res.text, ['gA', 's1', 's2'], 'csv');
    assertNone(res.text, ['gB', 's3', 'gX', 'sX'], 'csv');
    const json = await exportOf(id);
    assert.ok(res.text.includes(json.headers.get('x-export-manifest-sha256')), 'CSV podaje SHA-256 paczki JSON');
    const { rows } = await db.query(
      "SELECT metadata_json->>'format' AS format FROM audit_events WHERE action = 'data_subject_request.exported' AND entity_id = $1 ORDER BY occurred_at",
      [id],
    );
    assert.deepEqual(rows.map((r) => r.format), ['csv', 'json']);
    assert.equal((await exportOf(id, 'xml')).status, 400);
  });

  test('bez zweryfikowanej tożsamości, zły rodzaj, zamknięte lub nieistniejące żądanie: odmowa bez wpisu w dzienniku i audycie', async () => {
    const counts = async () => (await db.query(
      `SELECT (SELECT count(*)::int FROM data_access_log) AS log,
              (SELECT count(*)::int FROM audit_events WHERE action = 'data_subject_request.exported') AS audit`,
    )).rows[0];
    const before = await counts();
    const received = await verifiedRequest({ householdId: 'h-1' }, { status: 'received' });
    assert.equal((await exportOf(received)).json.error, 'data_request_identity_not_verified');
    const erasure = await verifiedRequest({ householdId: 'h-1' }, { kind: 'erasure' });
    assert.equal((await exportOf(erasure)).json.error, 'data_request_kind_not_exportable');
    const answered = await verifiedRequest({ householdId: 'h-1' }, { status: 'answered' });
    const closed = await exportOf(answered);
    assert.equal(closed.status, 409);
    assert.equal(closed.json.error, 'data_request_closed');
    const inProgress = await verifiedRequest({ householdId: 'h-1' }, { status: 'in_progress' });
    assert.equal((await exportOf(inProgress)).status, 200, 'w toku (po weryfikacji) — dozwolone');
    const missing = await exportOf('00000000-0000-4000-8000-000000000000');
    assert.equal(missing.status, 404);
    const after = await counts();
    assert.equal(after.audit, before.audit + 1, 'tylko udany eksport ma zdarzenie');
    assert.equal(after.log, before.log + 1, 'tylko udany eksport ma wpis w dzienniku odczytu');
  });

  test('granice ról: zarząd, skarbnik, Komisja Rewizyjna, dyrekcja, przedstawiciel — 403; admin bez MFA lub ze starym MFA — 403; anonim — 401', async () => {
    const id = await verifiedRequest({ householdId: 'h-1' });
    const before = (await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'data_subject_request.exported'")).rows[0].n;
    for (const key of ['board', 'treasurer', 'audit', 'principal', 'rep', 'adminNoMfa', 'adminStale']) {
      const res = await call(`/api/admin/data-requests/${id}/export`, { cookie: cookies[key] });
      assert.equal(res.status, 403, `${key}: ${res.status}`);
      for (const value of markers('gA', 's1')) assert.ok(!res.text.includes(value), `${key}: odmowa zawiera ${value}`);
    }
    const anonymous = await call(`/api/admin/data-requests/${id}/export`, { cookie: null });
    assert.equal(anonymous.status, 401);
    const stale = await call(`/api/admin/data-requests/${id}/export`, { cookie: cookies.adminStale });
    assert.match(stale.json.error, /mfa/);
    // GET na trasę eksportu: 405 z Allow.
    const get = await call(`/api/admin/data-requests/${id}/export`, { method: 'GET' });
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST');
    const after = (await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'data_subject_request.exported'")).rows[0].n;
    assert.equal(after, before, 'odmowa nie zapisuje zdarzenia eksportu');
  });
});
