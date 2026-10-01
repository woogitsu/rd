// Bieżące główne gospodarstwo ucznia z student_households zamiast kolumny
// zgodności students.household_id (issue #194, migracja 0023).
// Wyłącznie dane syntetyczne (@example.invalid). Żaden test nie łączy się z siecią.
// „Dziś” jest przesuwane parametrem (env.now / { on }), nie zegarem systemowym.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { handlePgRequest } from '../src/pg/app.js';
import { computeSnapshot } from '../src/pg/routes/email.js';
import { runEmailBatch } from '../src/email/worker.js';
import { brusselsDay, effectiveDay } from '../src/pg/today.js';
import { MESSAGES } from '../src/pg/routes/import.js';
import { guessMapping, parseCsv, toServerPayload, validateRows } from '../import/core.js';
import { applyMigrations, loadMigrations } from '../src/postgres-migrations.js';
import { createTestDb, request, seedClass, seedUser, seedUserSession, seedPublishedPrivacyNotice as seedSharedPrivacyNotice } from './helpers/pg.js';

const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('network_forbidden_in_tests'); };
test.after(() => { globalThis.fetch = realFetch; });

const YEAR = 'y2026';
const D = '2026-10-10';
const BEFORE = new Date('2026-10-09T10:00:00Z'); // D−1 w Brukseli
const ON_D = new Date('2026-10-10T10:00:00Z');   // D w Brukseli
const LATE_UTC = new Date('2026-10-09T22:30:00Z'); // w UTC jeszcze D−1, w Brukseli już D
const BODY = 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}. Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.';

async function household(db, id, guardians = []) {
  await db.query('INSERT INTO households (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
  for (const guardianId of guardians) {
    await db.query(
      `INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
       VALUES ($1, $2, 'Opiekun', 'Syntetyczny', $3, true)`,
      [guardianId, id, `${guardianId}@example.invalid`],
    );
  }
}

async function student(db, id, householdId, classId, guardians = []) {
  await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, $2, 'Uczeń', $1)", [id, householdId]);
  await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)', [`e-${id}`, id, classId, YEAR]);
  for (const guardianId of guardians) await link(db, id, guardianId);
}

async function link(db, studentId, guardianId, { startsOn = null, endsOn = null } = {}) {
  await db.query(
    'INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, starts_on, ends_on) VALUES ($1, $2, true, $3, $4)',
    [studentId, guardianId, startsOn, endsOn],
  );
}

// #145 (D-06): commit importu wymaga opublikowanej informacji o przetwarzaniu
// danych; ten test dotyczy dopasowania gospodarstwa, nie tej bramki.
async function seedPublishedPrivacyNotice(db, { id = 'pn-test', createdBy = 'u-privacy-author' } = {}) {
  await db.query(
    `INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [createdBy, `${createdBy}@example.invalid`, 'Test Autor'],
  );
  await db.query(
    `INSERT INTO privacy_notices (id, body_text, content_hash, decision_ref, status, created_by, approved_by, approved_at, published_by, published_at)
     VALUES ($1, 'Testowa informacja o przetwarzaniu danych.', repeat('a', 64), 'D-06/test', 'published',
             $2, 'u-admin', now(), 'u-admin', now())`,
    [id, createdBy],
  );
  return id;
}

async function payment(db, id, householdId, cents) {
  await db.query(
    `INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key)
     VALUES ($1, $2, $3, $4, '2026-09-20', 'bank', 'recorded', 'u-seed', $5)`,
    [id, householdId, YEAR, cents, `primary-test-${id}`],
  );
}

// Zaplanowana zmiana głównego gospodarstwa od dnia `on` — jedyna legalna
// droga przy indeksie student_households_one_open_primary: zamknąć stare
// członkostwo i otworzyć nowe w jednej transakcji.
async function scheduleMove(db, studentId, fromHousehold, toHousehold, on) {
  await db.transaction(async (tx) => {
    const ended = await tx.query(
      `UPDATE student_households SET ends_on = $3, ended_at = now()
        WHERE student_id = $1 AND household_id = $2 AND is_primary AND ends_on IS NULL
        RETURNING id`,
      [studentId, fromHousehold, on],
    );
    if (ended.rows.length !== 1) throw new Error('membership_not_open');
    await tx.query(
      `INSERT INTO student_households (id, student_id, household_id, is_primary, starts_on, source)
       VALUES ($1, $2, $3, true, $4, 'direct')`,
      [`sh-${studentId}-${toHousehold}-${on}`, studentId, toHousehold, on],
    );
  });
}

async function setup() {
  const db = await createTestDb();
  await seedSharedPrivacyNotice(db);
  await seedUser(db, { userId: 'u-seed' });
  await seedClass(db, { id: 'c1', schoolYearId: YEAR, name: '1A' });
  await seedClass(db, { id: 'c2', schoolYearId: YEAR, name: '2B' });
  const treasurer = await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
  const board = await seedUserSession(db, { userId: 'u-bd', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] });
  const baseEnv = {
    db,
    APP_ENV: 'development',
    EMAIL_SENDING_ENABLED: 'true',
    EMAIL_TEST_ALLOWLIST: '*@example.invalid',
    BREVO_FROM_EMAIL: 'rada@example.invalid',
    BREVO_WEBHOOK_SECRET: 'w'.repeat(48),
  };
  const call = async (now, cookie, path, options = {}) => {
    const response = await handlePgRequest(request(path, { cookie, ...options }), { ...baseEnv, now: () => now });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const cards = async (now, query = '') => {
    const res = await call(now, treasurer, `/api/print/cards?schoolYearId=${YEAR}${query}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.rows.map((row) => `${row.lastName}@${row.householdId}:${row.recordedNetCents}`).sort();
  };
  const recipients = async (on, audience = 'all_households') => {
    const snapshot = await computeSnapshot(db, { school_year_id: YEAR, audience }, { on });
    return snapshot.recipients.map((r) => `${r.householdId}:${r.guardianId}`).sort();
  };
  return { db, baseEnv, treasurer, board, call, cards, recipients };
}

test('brusselsDay i rd_today(): jedna definicja „dziś” w strefie Europe/Brussels', async () => {
  assert.equal(brusselsDay(new Date('2026-10-09T21:59:00Z')), '2026-10-09');
  assert.equal(brusselsDay(new Date('2026-10-09T22:30:00Z')), '2026-10-10'); // CEST, UTC+2
  assert.equal(brusselsDay(new Date('2026-01-15T23:30:00Z')), '2026-01-16'); // CET, UTC+1
  assert.equal(effectiveDay({}), null);
  assert.equal(effectiveDay({ now: () => LATE_UTC }), '2026-10-10');
  const db = await createTestDb();
  try {
    const { rows } = await db.query(`SELECT rd_today()::text AS today,
      (timestamptz '2026-10-09 22:30:00+00' AT TIME ZONE 'Europe/Brussels')::date::text AS late`);
    assert.equal(rows[0].today, brusselsDay(new Date()));
    assert.equal(rows[0].late, '2026-10-10');
  } finally {
    await db.close();
  }
});

test('zmiana gospodarstwa z datą przyszłą: w dniu D−1 stare, od D nowe — kampania, kartki, widok; wpłata częściowa zostaje przy starym', async () => {
  const t = await setup();
  try {
    await household(t.db, 'h-old', ['g-old']);
    await household(t.db, 'h-new', ['g-new']);
    // Relacja z opiekunem starego gospodarstwa kończy się w D−1 (ends_on włącznie),
    // z opiekunem nowego zaczyna się w D.
    await student(t.db, 's-1', 'h-old', 'c1');
    await link(t.db, 's-1', 'g-old', { endsOn: '2026-10-09' });
    await link(t.db, 's-1', 'g-new', { startsOn: D });
    await payment(t.db, 'p-old', 'h-old', 1500); // wpłata częściowa przed zmianą
    await scheduleMove(t.db, 's-1', 'h-old', 'h-new', D);

    // Kolumna zgodności nie dogania zmiany (dlatego czytelnicy jej nie ufają).
    assert.equal((await t.db.query("SELECT household_id FROM students WHERE id = 's-1'")).rows[0].household_id, 'h-old');

    const primaryOn = async (day) => (await t.db.query(
      "SELECT household_id FROM student_primary_household_on($1::date) WHERE student_id = 's-1'", [day],
    )).rows.map((row) => row.household_id);
    assert.deepEqual(await primaryOn('2026-10-09'), ['h-old']);
    assert.deepEqual(await primaryOn(D), ['h-new']);

    assert.deepEqual(await t.recipients('2026-10-09'), ['h-old:g-old']);
    assert.deepEqual(await t.recipients(D), ['h-new:g-new']);
    assert.deepEqual(await t.cards(BEFORE), ['s-1@h-old:1500']);
    assert.deepEqual(await t.cards(ON_D), ['s-1@h-new:0']);
    // 22:30 UTC dnia D−1 to już D w Brukseli.
    assert.deepEqual(await t.cards(LATE_UTC), ['s-1@h-new:0']);

    // „Brak wpisu wpłaty”: przed D rodzina ma wpis (wykluczona), od D nowe gospodarstwo go nie ma.
    assert.deepEqual(await t.recipients('2026-10-09', 'no_payment_record'), []);
    assert.deepEqual(await t.recipients(D, 'no_payment_record'), ['h-new:g-new']);
    // Wpłata nie jest przepisywana.
    assert.equal((await t.db.query("SELECT household_id FROM payment_entries WHERE id = 'p-old'")).rows[0].household_id, 'h-old');
  } finally {
    await t.db.close();
  }
});

test('migawka przez API (env.now) i worker w dniu D: wiadomość do starej rodziny nie wychodzi', async () => {
  const t = await setup();
  try {
    await household(t.db, 'h-old', ['g-old']);
    await household(t.db, 'h-new', ['g-new']);
    // Relacja z opiekunem starego gospodarstwa trwa dalej (np. opieka dzielona) —
    // dawniej worker przepuszczał wiadomość, bo sprawdzał students.household_id.
    await student(t.db, 's-1', 'h-old', 'c1', ['g-old']);
    await scheduleMove(t.db, 's-1', 'h-old', 'h-new', D);

    const created = await t.call(BEFORE, t.treasurer, '/api/email/campaigns', {
      method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: { schoolYearId: YEAR, title: 'Przypomnienie', audience: 'all_households', subject: 'Składka {rok}', bodyText: BODY },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.campaign.id;
    const snap = await t.call(BEFORE, t.treasurer, `/api/email/campaigns/${id}/snapshot`, { method: 'POST' });
    assert.equal(snap.status, 200, JSON.stringify(snap.body));
    const stored = await t.db.query('SELECT household_id, guardian_id FROM email_campaign_recipients WHERE campaign_id = $1', [id]);
    assert.deepEqual(stored.rows, [{ household_id: 'h-old', guardian_id: 'g-old' }]);
    const preview = await t.call(BEFORE, t.board, `/api/email/campaigns/${id}/preview`);
    const approved = await t.call(BEFORE, t.board, `/api/email/campaigns/${id}/approve`, {
      method: 'POST', body: { contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash },
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const queued = await t.call(BEFORE, t.treasurer, `/api/email/campaigns/${id}/queue`, { method: 'POST' });
    assert.equal(queued.status, 200, JSON.stringify(queued.body));

    const sent = [];
    const transport = { name: 'fake', async send(message) { sent.push(message); return { messageId: `fake-${sent.length}` }; } };
    const run = await runEmailBatch(t.baseEnv, { transport, dryRun: false, now: ON_D });
    assert.equal(sent.length, 0);
    assert.equal(run.suppressed, 1);
    const outbox = await t.db.query('SELECT household_id, state, last_error FROM email_outbox WHERE campaign_id = $1', [id]);
    assert.deepEqual(outbox.rows, [{ household_id: 'h-old', state: 'suppressed', last_error: 'consent_or_address_changed' }]);

    // Przebudowana migawka w dniu D wskazuje nową rodzinę.
    const rebuilt = await t.call(ON_D, t.treasurer, `/api/email/campaigns/${id}/snapshot`, { method: 'POST' });
    assert.equal(rebuilt.status, 409); // kampania w wysyłce — migawka zablokowana
  } finally {
    await t.db.close();
  }
});

test('worker w dniu D−1 wysyła do bieżącej rodziny (bez regresji)', async () => {
  const t = await setup();
  try {
    await household(t.db, 'h-old', ['g-old']);
    await household(t.db, 'h-new', ['g-new']);
    await student(t.db, 's-1', 'h-old', 'c1', ['g-old']);
    await scheduleMove(t.db, 's-1', 'h-old', 'h-new', D);
    const created = await t.call(BEFORE, t.treasurer, '/api/email/campaigns', {
      method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: { schoolYearId: YEAR, title: 'Przypomnienie', audience: 'all_households', subject: 'Składka {rok}', bodyText: BODY },
    });
    const id = created.body.campaign.id;
    await t.call(BEFORE, t.treasurer, `/api/email/campaigns/${id}/snapshot`, { method: 'POST' });
    const preview = await t.call(BEFORE, t.board, `/api/email/campaigns/${id}/preview`);
    await t.call(BEFORE, t.board, `/api/email/campaigns/${id}/approve`, {
      method: 'POST', body: { contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash },
    });
    await t.call(BEFORE, t.treasurer, `/api/email/campaigns/${id}/queue`, { method: 'POST' });
    const sent = [];
    const transport = { name: 'fake', async send(message) { sent.push(message); return { messageId: `fake-${sent.length}` }; } };
    const run = await runEmailBatch(t.baseEnv, { transport, dryRun: false, now: BEFORE });
    assert.equal(run.sent, 1);
    assert.equal(sent.length, 1);
  } finally {
    await t.db.close();
  }
});

test('opieka naprzemienna: dwa obowiązujące gospodarstwa, kampania i kartka tylko dla głównego (założenie D-11/D-17)', async () => {
  const t = await setup();
  try {
    await household(t.db, 'h-a', ['g-a']);
    await household(t.db, 'h-b', ['g-b']);
    await student(t.db, 's-2', 'h-a', 'c1', ['g-a', 'g-b']);
    await t.db.query(
      `INSERT INTO student_households (id, student_id, household_id, is_primary, source)
       VALUES ('sh-s2-b', 's-2', 'h-b', false, 'direct')`,
    );
    const current = await t.db.query(
      "SELECT household_id, is_primary FROM student_households_current WHERE student_id = 's-2' ORDER BY household_id",
    );
    assert.deepEqual(current.rows, [{ household_id: 'h-a', is_primary: true }, { household_id: 'h-b', is_primary: false }]);
    assert.deepEqual(await t.recipients(brusselsDay(ON_D)), ['h-a:g-a']);
    assert.deepEqual(await t.cards(ON_D), ['s-2@h-a:0']);
    const primary = await t.db.query("SELECT household_id FROM student_primary_household_current WHERE student_id = 's-2'");
    assert.deepEqual(primary.rows, [{ household_id: 'h-a' }]);
  } finally {
    await t.db.close();
  }
});

// #211: wpłaty (issue: „Wpłaty… używają students.household_id”, #194 dotyczy
// tylko kartek/kampanii). payment_entries.household_id jest ustawiane wprost
// przez skarbnika przy zapisie wpłaty, nie wyprowadzane ze studenta — więc
// nie ma tu wyścigu „która kolumna”: wpłata drugiego gospodarstwa naprzemiennej
// opieki jest tylko wpłatą TEGO gospodarstwa, niezależną od tego, które z nich
// jest dziś główne. Test dokumentuje tę (zamierzoną) niespójność: suma wpłat
// drugiego gospodarstwa (h-b) jest poprawna i widoczna w /api/payments, ale
// karta rodzinna (kartka składki) pozostaje wyłącznie dla głównego
// gospodarstwa (D-11) — więc wpłata h-b nie trafia na kartkę s-2@h-a.
test('opieka naprzemienna: wpłata drugiego gospodarstwa liczy się poprawnie do jego salda, ale nie trafia na kartkę głównego (#211, D-11)', async () => {
  const t = await setup();
  try {
    await household(t.db, 'h-a', ['g-a']);
    await household(t.db, 'h-b', ['g-b']);
    await student(t.db, 's-2', 'h-a', 'c1', ['g-a', 'g-b']);
    await t.db.query(
      `INSERT INTO student_households (id, student_id, household_id, is_primary, source)
       VALUES ('sh-s2-b', 's-2', 'h-b', false, 'direct')`,
    );
    await payment(t.db, 'p-hb', 'h-b', 6000);

    const totals = await t.db.query(
      "SELECT household_id, net_amount_cents::int AS net_amount_cents FROM household_payment_totals WHERE school_year_id = $1 ORDER BY household_id",
      [YEAR],
    );
    assert.deepEqual(totals.rows, [{ household_id: 'h-b', net_amount_cents: 6000 }]);
    const list = await t.call(ON_D, t.treasurer, `/api/payments?schoolYearId=${YEAR}`);
    assert.deepEqual(list.body.payments.map((p) => [p.householdId, p.netAmountCents]), [['h-b', 6000]]);
    // Kartka drugiego gospodarstwa (D-11): h-b nie jest głównym gospodarstwem
    // żadnego ucznia w tej klasie, więc nie dostaje wiersza z tą kwotą.
    assert.deepEqual(await t.cards(ON_D), ['s-2@h-a:0']);
  } finally {
    await t.db.close();
  }
});

test('rodzeństwo: jedno dziecko przechodzi do innego gospodarstwa, drugie zostaje, sumy wpłat się nie mieszają', async () => {
  const t = await setup();
  try {
    await household(t.db, 'h-sib', ['g-sib']);
    await household(t.db, 'h-other', ['g-other']);
    await student(t.db, 's-3', 'h-sib', 'c1', ['g-sib']);
    await student(t.db, 's-4', 'h-sib', 'c2', ['g-sib']);
    await link(t.db, 's-4', 'g-other', { startsOn: D });
    await payment(t.db, 'p-sib', 'h-sib', 2000);
    await scheduleMove(t.db, 's-4', 'h-sib', 'h-other', D);

    assert.deepEqual(await t.cards(BEFORE), ['s-3@h-sib:2000', 's-4@h-sib:2000']);
    assert.deepEqual(await t.cards(ON_D), ['s-3@h-sib:2000', 's-4@h-other:0']);
    // Kartki klasy 1A z rodzeństwem z innych klas: od D s-4 nie należy już do rodziny z 1A.
    assert.deepEqual(await t.cards(BEFORE, '&classId=c1'), ['s-3@h-sib:2000', 's-4@h-sib:2000']);
    assert.deepEqual(await t.cards(ON_D, '&classId=c1'), ['s-3@h-sib:2000']);
    assert.deepEqual(await t.cards(ON_D, '&classId=c2'), ['s-4@h-other:0']);
    assert.deepEqual(await t.recipients('2026-10-09'), ['h-sib:g-sib']);
    assert.deepEqual(await t.recipients(D), ['h-other:g-other', 'h-sib:g-sib']);
  } finally {
    await t.db.close();
  }
});

test('zakończenie głównego członkostwa bez następcy: uczeń bez kartki i poza kampanią (kolumna nadal wskazuje stare)', async () => {
  const t = await setup();
  try {
    await household(t.db, 'h-end', ['g-end']);
    await student(t.db, 's-5', 'h-end', 'c1', ['g-end']);
    await t.db.query(`UPDATE student_households SET ends_on = $1, ended_at = now() WHERE student_id = 's-5'`, [D]);
    assert.equal((await t.db.query("SELECT household_id FROM students WHERE id = 's-5'")).rows[0].household_id, 'h-end');
    assert.deepEqual(await t.recipients('2026-10-09'), ['h-end:g-end']);
    assert.deepEqual(await t.recipients(D), []);
    assert.deepEqual(await t.cards(ON_D), []);
  } finally {
    await t.db.close();
  }
});

test('import: istniejący uczeń dopasowany do bieżącego głównego gospodarstwa, nie do nieaktualnej kolumny', async () => {
  const db = await createTestDb();
  try {
    await seedClass(db, { id: 'c-1a', schoolYearId: YEAR, name: '1A' });
    const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
    await seedPublishedPrivacyNotice(db);
    const HEADER = 'ID ucznia;Imię ucznia;Nazwisko ucznia;Klasa;ID rodziny;Opiekun 1;E-mail opiekuna 1;Opiekun 2;E-mail opiekuna 2';
    const payload = (...lines) => {
      const matrix = parseCsv(`${HEADER}\n${lines.join('\n')}\n`);
      return toServerPayload(validateRows(matrix, guessMapping(matrix[0])), YEAR, {});
    };
    const post = async (path, body, key) => {
      const response = await handlePgRequest(request(path, { method: 'POST', cookie: admin, body, headers: key ? { 'Idempotency-Key': key } : {} }), { db, APP_ENV: 'test' });
      return { status: response.status, body: await response.json() };
    };
    const base = payload('S1;Ala;Testowa;1A;R1;Anna Testowa;anna@example.invalid;;', 'S2;Ola;Testowa;1A;R1;Anna Testowa;anna@example.invalid;;');
    const p = await post('/api/import/preview', base);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const done = await post('/api/import/commit', { ...base, fingerprint: p.body.fingerprint, planDigest: p.body.planDigest }, 'key-194-0001');
    assert.equal(done.status, 201, JSON.stringify(done.body));
    await db.query("INSERT INTO households (id, source_ref) VALUES ('h-r9', 'R9')");
    const s1 = (await db.query("SELECT id, household_id FROM students WHERE source_ref = 'S1'")).rows[0];
    // Stan po dniu D zaplanowanej zmiany: członkostwo obowiązuje, kolumna nie została
    // zaktualizowana (symulacja przez wyłączenie synchronizacji na czas wstawienia).
    await db.query('ALTER TABLE student_households DISABLE TRIGGER student_households_sync');
    await scheduleMove(db, s1.id, s1.household_id, 'h-r9', brusselsDay(new Date(Date.now() - 86400000)));
    await db.query('ALTER TABLE student_households ENABLE TRIGGER student_households_sync');
    assert.equal((await db.query('SELECT household_id FROM students WHERE id = $1', [s1.id])).rows[0].household_id, s1.household_id);

    const again = await post('/api/import/preview', payload(
      'S1;Ala;Testowa;1A;R9;;;;',
      'S2;Ola;Testowa;1A;R1;;;;',
    ));
    assert.equal(again.status, 200, JSON.stringify(again.body));
    const byRow = Object.fromEntries(again.body.rows.map((row) => [row.row, row]));
    assert.notEqual(byRow[2].action, 'conflict', JSON.stringify(byRow[2]));
    assert.notEqual(byRow[3].action, 'conflict', JSON.stringify(byRow[3])); // rodzeństwo zostaje w R1
    const stale = await post('/api/import/preview', payload('S1;Ala;Testowa;1A;R1;;;;'));
    assert.equal(stale.body.rows[0].messages[0], MESSAGES.householdMismatch);

    // Uczeń bez bieżącego głównego gospodarstwa wymaga ręcznego powiązania.
    const s2 = (await db.query("SELECT id FROM students WHERE source_ref = 'S2'")).rows[0];
    await db.query('UPDATE student_households SET ends_on = $2, ended_at = now() WHERE student_id = $1 AND ends_on IS NULL',
      [s2.id, brusselsDay(new Date(Date.now() - 86400000))]);
    const orphan = await post('/api/import/preview', payload('S2;Ola;Testowa;1A;R1;;;;'));
    assert.equal(orphan.body.rows[0].action, 'conflict');
    assert.equal(orphan.body.rows[0].messages[0], MESSAGES.noCurrentHousehold);
  } finally {
    await db.close();
  }
});

test('podwójne kliknięcie zmiany: ponowienie nie tworzy drugiego członkostwa', async () => {
  const t = await setup();
  try {
    await household(t.db, 'h-old', ['g-old']);
    await household(t.db, 'h-new', ['g-new']);
    await student(t.db, 's-1', 'h-old', 'c1', ['g-old']);
    await scheduleMove(t.db, 's-1', 'h-old', 'h-new', D);
    await assert.rejects(scheduleMove(t.db, 's-1', 'h-old', 'h-new', D), /membership_not_open/);
    // Ponowienie z pominięciem zamknięcia starego (np. drugi INSERT) odrzuca indeks / sprawdzanie nakładania.
    await assert.rejects(t.db.query(
      `INSERT INTO student_households (id, student_id, household_id, is_primary, starts_on, source)
       VALUES ('sh-dup', 's-1', 'h-new', true, $1, 'direct')`, [D],
    ), /student_households_one_open_primary|student_household_overlap/);
    await assert.rejects(t.db.query(
      `INSERT INTO student_households (id, student_id, household_id, is_primary, starts_on, ends_on, source)
       VALUES ('sh-dup2', 's-1', 'h-new', false, $1, '2026-12-01', 'direct')`, [D],
    ), /student_household_overlap/);
    const { rows } = await t.db.query("SELECT household_id, starts_on::text, ends_on::text FROM student_households WHERE student_id = 's-1' ORDER BY starts_on NULLS FIRST");
    assert.deepEqual(rows, [
      { household_id: 'h-old', starts_on: null, ends_on: D },
      { household_id: 'h-new', starts_on: D, ends_on: null },
    ]);
  } finally {
    await t.db.close();
  }
});

test('sprawdzanie nakładania blokuje wiersz ucznia i opiekuna (migracja 0023)', async () => {
  const db = await createTestDb();
  try {
    const { rows } = await db.query(
      `SELECT proname, prosrc FROM pg_proc WHERE proname IN ('student_household_check', 'guardian_household_check') ORDER BY proname`,
    );
    assert.equal(rows.length, 2);
    assert.match(rows[0].prosrc, /FROM guardians WHERE id = NEW\.guardian_id FOR NO KEY UPDATE/);
    assert.match(rows[1].prosrc, /FROM students WHERE id = NEW\.student_id FOR NO KEY UPDATE/);
  } finally {
    await db.close();
  }
});

// Prawdziwa współbieżność wymaga dwóch połączeń — PGlite ma jedno. Test działa
// tylko z RD_TEST_DATABASE_URL (pusta, jednorazowa baza PostgreSQL; test tworzy
// i usuwa własną bazę). Bez zmiennej jest pomijany.
const ADMIN_URL = process.env.RD_TEST_DATABASE_URL;
test('równoległe wstawienie nakładających się członkostw: jedna transakcja kończy się błędem', { skip: !ADMIN_URL && 'brak RD_TEST_DATABASE_URL' }, async () => {
  const name = `rd_test_194_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const a = new pg.Client({ connectionString: url.toString() });
  const b = new pg.Client({ connectionString: url.toString() });
  try {
    await a.connect();
    await b.connect();
    await applyMigrations(a, await loadMigrations(new URL('../postgres/migrations/', import.meta.url).pathname));
    await a.query("INSERT INTO households (id) VALUES ('h-1'), ('h-2')");
    await a.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ('s-1', 'h-1', 'Uczeń', 'Testowy')");
    await a.query("INSERT INTO guardians (id, household_id, first_name, last_name) VALUES ('g-1', 'h-1', 'Opiekun', 'Testowy')");

    const insert = (client, id, starts, ends) => client.query(
      `INSERT INTO student_households (id, student_id, household_id, is_primary, starts_on, ends_on, ended_at, source)
       VALUES ($1, 's-1', 'h-2', false, $2, $3, now(), 'direct')`, [id, starts, ends],
    );
    await a.query('BEGIN');
    await b.query('BEGIN');
    await insert(a, 'sh-a', '2026-01-01', '2026-03-01');
    const pending = insert(b, 'sh-b', '2026-02-01', '2026-04-01').then(() => 'ok', (error) => error.message);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await a.query('COMMIT');
    assert.equal(await pending, 'student_household_overlap');
    await b.query('ROLLBACK');

    const guardianInsert = (client, id, starts, ends) => client.query(
      `INSERT INTO guardian_households (id, guardian_id, household_id, starts_on, ends_on, ended_at, source)
       VALUES ($1, 'g-1', 'h-2', $2, $3, now(), 'direct')`, [id, starts, ends],
    );
    await a.query('BEGIN');
    await b.query('BEGIN');
    await guardianInsert(a, 'gh-a', '2026-01-01', '2026-03-01');
    const pendingGuardian = guardianInsert(b, 'gh-b', '2026-02-01', '2026-04-01').then(() => 'ok', (error) => error.message);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await a.query('COMMIT');
    assert.equal(await pendingGuardian, 'guardian_household_overlap');
    await b.query('ROLLBACK');
    const { rows } = await a.query("SELECT count(*)::int AS n FROM student_households WHERE student_id = 's-1' AND household_id = 'h-2'");
    assert.equal(rows[0].n, 1);
  } finally {
    await a.end().catch(() => {});
    await b.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end();
  }
});

// #194: końcowe atomowe sprawdzenie w workerze (confirmSend) używa bieżącego
// głównego gospodarstwa, nie kolumny zgodności. Dawniej po dniu D kolumna
// wskazywała stare gospodarstwo, więc wiersz nowej rodziny wracał do kolejki
// (send_recheck_changed) i nigdy nie wychodził.
test('worker w dniu D: kampania zbudowana w D dla nowej rodziny wychodzi (atomowe sprawdzenie nie czyta kolumny zgodności)', async () => {
  const t = await setup();
  try {
    await household(t.db, 'h-old', ['g-old']);
    await household(t.db, 'h-new', ['g-new']);
    await student(t.db, 's-1', 'h-old', 'c1');
    await link(t.db, 's-1', 'g-old', { endsOn: '2026-10-09' });
    await link(t.db, 's-1', 'g-new', { startsOn: D });
    await scheduleMove(t.db, 's-1', 'h-old', 'h-new', D);
    assert.equal((await t.db.query("SELECT household_id FROM students WHERE id = 's-1'")).rows[0].household_id, 'h-old');

    const created = await t.call(ON_D, t.treasurer, '/api/email/campaigns', {
      method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: { schoolYearId: YEAR, title: 'Przypomnienie', audience: 'all_households', subject: 'Składka {rok}', bodyText: BODY },
    });
    const id = created.body.campaign.id;
    await t.call(ON_D, t.treasurer, `/api/email/campaigns/${id}/snapshot`, { method: 'POST' });
    const stored = await t.db.query('SELECT household_id, guardian_id FROM email_campaign_recipients WHERE campaign_id = $1', [id]);
    assert.deepEqual(stored.rows, [{ household_id: 'h-new', guardian_id: 'g-new' }]);
    const preview = await t.call(ON_D, t.board, `/api/email/campaigns/${id}/preview`);
    await t.call(ON_D, t.board, `/api/email/campaigns/${id}/approve`, {
      method: 'POST', body: { contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash },
    });
    await t.call(ON_D, t.treasurer, `/api/email/campaigns/${id}/queue`, { method: 'POST' });
    const sent = [];
    const transport = { name: 'fake', async send(message) { sent.push(message); return { messageId: `fake-${sent.length}` }; } };
    const run = await runEmailBatch(t.baseEnv, { transport, dryRun: false, now: ON_D });
    assert.equal(run.sent, 1);
    assert.equal(sent.length, 1);
    const outbox = await t.db.query('SELECT household_id, state FROM email_outbox WHERE campaign_id = $1', [id]);
    assert.deepEqual(outbox.rows, [{ household_id: 'h-new', state: 'sent' }]);
  } finally {
    await t.db.close();
  }
});

// #194: kartka starszego roku bierze gospodarstwo właściwe dla tamtego roku
// (koniec roku), nie dzisiejsze; wpłaty liczone dla roku kartki.
test('kartki starszego roku: gospodarstwo z końca tamtego roku, nie dzisiejsze; zmiana w trakcie roku', async () => {
  const t = await setup();
  try {
    const OLD_YEAR = 'y2025';
    await seedClass(t.db, { id: 'c-old', schoolYearId: OLD_YEAR, name: '1A' });
    await t.db.query("UPDATE school_years SET starts_on = '2025-09-01', ends_on = '2026-08-31' WHERE id = $1", [OLD_YEAR]);
    await household(t.db, 'h-a', ['g-a']);
    await household(t.db, 'h-b', ['g-b']);
    await household(t.db, 'h-c', ['g-c']);
    await student(t.db, 's-6', 'h-a', 'c1', ['g-a']);
    await t.db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)', ['e-old-s-6', 's-6', 'c-old', OLD_YEAR]);
    // Rodzeństwo zostaje w h-a przez cały czas.
    await student(t.db, 's-7', 'h-a', 'c1', ['g-a']);
    await t.db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)', ['e-old-s-7', 's-7', 'c-old', OLD_YEAR]);
    // Zmiana w trakcie roku 2025/26 (h-a → h-b), potem kolejna w roku bieżącym (h-b → h-c).
    await scheduleMove(t.db, 's-6', 'h-a', 'h-b', '2026-01-15');
    await scheduleMove(t.db, 's-6', 'h-b', 'h-c', D);
    await t.db.query(
      `INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key)
       VALUES ('p-old-year', 'h-b', $1, 700, '2026-02-01', 'bank', 'recorded', 'u-seed', 'primary-test-old-year')`, [OLD_YEAR],
    );
    const oldCards = async (now, query = '') => {
      const res = await t.call(now, t.treasurer, `/api/print/cards?schoolYearId=${OLD_YEAR}${query}`);
      return { status: res.status, rows: (res.body.rows ?? []).map((row) => `${row.lastName}@${row.householdId}:${row.recordedNetCents}`).sort() };
    };
    // Skarbnik z rolą przypisaną do y2026 nie ma dostępu do y2025 — nadaj rolę na rok 2025.
    await t.db.query(`INSERT INTO role_grants (id, user_id, role, school_year_id) VALUES ('rg-old', 'u-tr', 'treasurer', $1)`, [OLD_YEAR]);

    // Rok 2025/26: stan z 2026-08-31 (h-b), niezależnie od „dziś” (D i późniejsze).
    const expected = ['s-6@h-b:700', 's-7@h-a:0'];
    assert.deepEqual((await oldCards(ON_D)).rows, expected);
    assert.deepEqual((await oldCards(new Date('2027-03-01T10:00:00Z'))).rows, expected);
    // Bieżący rok 2026/27: dzisiejsze gospodarstwo (h-c), rodzeństwo w h-a.
    assert.deepEqual(await t.cards(ON_D), ['s-6@h-c:0', 's-7@h-a:0']);
    // Dzień D−1 w roku bieżącym: h-b.
    assert.deepEqual(await t.cards(BEFORE), ['s-6@h-b:0', 's-7@h-a:0']);
    // Rok 2025/26 obejrzany w trakcie tego roku (2026-03-01): h-b już od 2026-01-15.
    assert.deepEqual((await oldCards(new Date('2026-03-01T10:00:00Z'))).rows, expected);
    // Przed zmianą w trakcie roku (2025-12-01): jeszcze h-a.
    assert.deepEqual((await oldCards(new Date('2025-12-01T10:00:00Z'))).rows, ['s-6@h-a:0', 's-7@h-a:0']);
  } finally {
    await t.db.close();
  }
});
