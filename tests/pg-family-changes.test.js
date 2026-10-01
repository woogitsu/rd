// Zmiana opieki i odejście w trakcie roku (#86): zakończenie relacji opiekun–dziecko
// i członkostwa ucznia w gospodarstwie, dodanie członkostwa, ostrzeżenie w kampanii
// zatwierdzonej przed zmianą. Wyłącznie dane syntetyczne (@example.invalid); bez sieci.
// Daty zakończenia są w przeszłości (2020), żeby wynik nie zależał od zegara testu.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { computeSnapshot } from '../src/pg/routes/email.js';
import { runEmailBatch } from '../src/email/worker.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';
import { SYNTHETIC_PHONE_IN_TEXT } from './helpers/assertions.js';

const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('network_forbidden_in_tests'); };
test.after(() => { globalThis.fetch = realFetch; });

const YEAR = 'y-2026';
const OLD_YEAR = 'y-2025';
const BEFORE = new Date('2026-10-09T10:00:00Z');
const ON_D = new Date('2026-10-10T10:00:00Z');
const BODY = 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}. Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.';
const REASON = 'Zmiana opieki (syntetyczne)';

// h-1: Ola (s-1, 1A), opiekunowie g-1a (kontakt główny) i g-1b — dwie osoby przy jednym dziecku.
// h-2: Jan (s-2, 1B), opiekun g-2; g-1b opiekuje się także Janem (rodzeństwo w dwóch gospodarstwach).
async function setup() {
  const db = await createTestDb();
  await seedUser(db, { userId: 'u-seed' });
  await seedSchoolYear(db, OLD_YEAR, { startsOn: '2025-09-01', endsOn: '2026-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR, name: '1A' });
  await seedClass(db, { id: 'c-1b', schoolYearId: YEAR, name: '1B' });
  await seedClass(db, { id: 'c-old', schoolYearId: OLD_YEAR, name: '3A' });
  await db.exec(`
    INSERT INTO households (id) VALUES ('h-1'), ('h-2'), ('h-3');
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
      ('g-1a', 'h-1', 'Anna', 'Testowa', 'g-1a@example.invalid', true),
      ('g-1b', 'h-2', 'Piotr', 'Testowy', 'g-1b@example.invalid', true),
      ('g-2', 'h-2', 'Ewa', 'Testowa', 'g-2@example.invalid', true);
    INSERT INTO students (id, household_id, first_name, last_name) VALUES
      ('s-1', 'h-1', 'Ola', 'Testowa'), ('s-2', 'h-2', 'Jan', 'Testowy'), ('s-old', 'h-3', 'Stary', 'Testowy');
    INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES
      ('s-1', 'g-1a', true, true), ('s-1', 'g-1b', true, false),
      ('s-2', 'g-1b', true, false), ('s-2', 'g-2', true, true);
    INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
      ('e-1', 's-1', 'c-1a', '${YEAR}'), ('e-2', 's-2', 'c-1b', '${YEAR}'), ('e-old', 's-old', 'c-old', '${OLD_YEAR}');
  `);
  const cookies = {
    board: await seedUserSession(db, { userId: 'u-board', mfa: true, roles: [{ role: 'board' }] }),
    treasurer: await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] }),
    boardA: await seedUserSession(db, { userId: 'u-board-a', mfa: true, roles: [{ role: 'board', classId: 'c-1a', schoolYearId: YEAR }] }),
    repA: await seedUserSession(db, { userId: 'u-rep-a', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }] }),
  };
  const baseEnv = {
    db, APP_ENV: 'development', EMAIL_SENDING_ENABLED: 'true', EMAIL_TEST_ALLOWLIST: '*@example.invalid',
    BREVO_FROM_EMAIL: 'rada@example.invalid', BREVO_WEBHOOK_SECRET: 'w'.repeat(48),
  };
  const call = async (path, { now = BEFORE, ...options } = {}) => {
    const response = await handlePgRequest(request(path, options), { ...baseEnv, now: () => now });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { db, baseEnv, cookies, call };
}

async function closeYear(db, yearId) {
  await seedSchoolYear(db, 'y-next-closed', { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  await db.exec(`
    SET session_replication_role = replica;
    INSERT INTO school_year_closures (id, school_year_id, next_school_year_id, status, initiated_by,
      closed_by, closed_at, income_cents, expense_cents, opening_balance_cents, closing_balance_cents,
      carried_opening_balance_id, expired_grant_count)
    VALUES ('clo-${yearId}', '${yearId}', 'y-next-closed', 'closed', 'u-a', 'u-b', now(), 0, 0, 0, 0, 'ob-next', 0);
    SET session_replication_role = origin;
  `);
}

const endRelation = (t, cookie, studentId, guardianId, body = { endsOn: '2020-01-01', reason: REASON }) =>
  t.call(`/api/guardians/${guardianId}/students/${studentId}/end`, { method: 'POST', cookie, body });

test('zakończenie relacji: granice ról (przedstawiciel, zarząd klasowy, zarząd), walidacja i 404', async () => {
  const t = await setup();
  try {
    assert.equal((await endRelation(t, t.cookies.repA, 's-1', 'g-1a')).status, 403);
    assert.equal((await endRelation(t, t.cookies.treasurer, 's-1', 'g-1a')).status, 403);
    // Zarząd z przydziałem klasy 1A: dziecko z 1B jest poza zakresem — 404, nic nie zapisane.
    assert.equal((await endRelation(t, t.cookies.boardA, 's-2', 'g-2')).status, 404);
    assert.equal((await endRelation(t, t.cookies.board, 's-1', 'g-nope')).status, 404);
    assert.equal((await endRelation(t, t.cookies.board, 's-1', 'g-2')).status, 404, 'brak relacji');
    assert.equal((await endRelation(t, t.cookies.board, 's-1', 'g-1a', { endsOn: '2020-01-01', reason: 'x' })).status, 400);
    assert.equal((await endRelation(t, t.cookies.board, 's-1', 'g-1a', { endsOn: '2020-13-01', reason: REASON })).status, 400);
    const none = await t.db.query('SELECT count(*)::int AS n FROM student_guardians WHERE ends_on IS NOT NULL');
    assert.equal(none.rows[0].n, 0);
    // Zarząd klasowy kończy relację z dzieckiem własnej klasy.
    const ok = await endRelation(t, t.cookies.boardA, 's-1', 'g-1a');
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  } finally { await t.db.close(); }
});

test('dwoje opiekunów jednego dziecka: jeden traci opiekę, drugi i relacje z rodzeństwem zostają; podwójne kliknięcie', async () => {
  const t = await setup();
  try {
    const first = await endRelation(t, t.cookies.board, 's-1', 'g-1a');
    assert.deepEqual(first.body, { relation: { guardianId: 'g-1a', studentId: 's-1', endsOn: '2020-01-01' }, changed: true, campaignsToReview: [] });
    const again = await endRelation(t, t.cookies.board, 's-1', 'g-1a', { endsOn: '2021-05-05', reason: 'Inny powód' });
    assert.deepEqual(again.body, { relation: { guardianId: 'g-1a', studentId: 's-1', endsOn: '2020-01-01' }, changed: false, campaignsToReview: [] });

    const changes = await t.db.query(
      `SELECT student_id, guardian_id, to_char(new_ends_on, 'YYYY-MM-DD') AS ends_on, reason, source, changed_by
         FROM student_guardian_changes WHERE new_ends_on IS NOT NULL`,
    );
    assert.deepEqual(changes.rows, [{ student_id: 's-1', guardian_id: 'g-1a', ends_on: '2020-01-01', reason: REASON, source: 'api', changed_by: 'u-board' }]);
    const audit = await t.db.query(`SELECT action, entity_id, metadata_json FROM audit_events WHERE action = 'student_guardian.ended'`);
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].entity_id, 's-1:g-1a');
    assert.doesNotMatch(JSON.stringify(audit.rows), /Anna|Testowa|@|Zmiana opieki/);

    const current = await t.db.query('SELECT student_id, guardian_id FROM student_guardians_current ORDER BY student_id, guardian_id');
    assert.deepEqual(current.rows, [
      { student_id: 's-1', guardian_id: 'g-1b' }, { student_id: 's-2', guardian_id: 'g-1b' }, { student_id: 's-2', guardian_id: 'g-2' },
    ]);
    // Nowa migawka: rodzinę h-1 reprezentuje drugi opiekun; h-2 bez zmian.
    const snapshot = await computeSnapshot(t.db, { school_year_id: YEAR, audience: 'all_households' });
    assert.deepEqual(snapshot.recipients.map((r) => `${r.householdId}:${r.guardianId}`).sort(), ['h-1:g-1b', 'h-2:g-2']);
    // Wiersz relacji zostaje (bez usuwania historii).
    assert.equal((await t.db.query(`SELECT count(*)::int AS n FROM student_guardians WHERE student_id = 's-1'`)).rows[0].n, 2);
  } finally { await t.db.close(); }
});

test('zamknięty rok: zmiana z datą w zamkniętym roku daje 409 school_year_closed i nic nie zapisuje', async () => {
  const t = await setup();
  try {
    await closeYear(t.db, OLD_YEAR);
    const rel = await endRelation(t, t.cookies.board, 's-1', 'g-1a', { endsOn: '2026-03-01', reason: REASON });
    assert.equal(rel.status, 409);
    assert.equal(rel.body.error, 'school_year_closed');
    const mem = await t.db.query(`SELECT id FROM student_households WHERE student_id = 's-1' AND is_primary`);
    const endMem = await t.call(`/api/students/s-1/households/${mem.rows[0].id}/end`, {
      method: 'POST', cookie: t.cookies.board, body: { endsOn: '2026-03-01', reason: REASON },
    });
    assert.equal(endMem.status, 409);
    assert.equal(endMem.body.error, 'school_year_closed');
    const add = await t.call('/api/students/s-1/households', {
      method: 'POST', cookie: t.cookies.board, body: { householdId: 'h-3', startsOn: '2026-03-01', reason: REASON },
    });
    assert.equal(add.status, 409);
    const endEnr = await t.call('/api/students/s-old/enrollments/e-old/end', {
      method: 'POST', cookie: t.cookies.board, body: { endedOn: '2026-03-01', reason: REASON },
    });
    assert.equal(endEnr.status, 409);
    assert.equal(endEnr.body.error, 'school_year_closed');
    const state = await t.db.query(`SELECT
      (SELECT count(*)::int FROM student_guardians WHERE ends_on IS NOT NULL) AS rel,
      (SELECT count(*)::int FROM student_households WHERE ends_on IS NOT NULL) AS mem,
      (SELECT count(*)::int FROM student_households WHERE student_id = 's-1') AS all_mem,
      (SELECT count(*)::int FROM enrollments WHERE ended_on IS NOT NULL) AS enr`);
    assert.deepEqual(state.rows[0], { rel: 0, mem: 0, all_mem: 1, enr: 0 });
    // Data w otwartym roku nadal przechodzi.
    assert.equal((await endRelation(t, t.cookies.board, 's-1', 'g-1a', { endsOn: '2026-10-01', reason: REASON })).status, 200);
  } finally { await t.db.close(); }
});

test('członkostwo w gospodarstwie: dodanie (tylko zakres szeroki), powtórka, nakładanie 409, zakończenie z powodem i audytem', async () => {
  const t = await setup();
  try {
    const path = '/api/students/s-1/households';
    const body = { householdId: 'h-2', isPrimary: false, startsOn: '2026-09-01', reason: REASON };
    assert.equal((await t.call(path, { method: 'POST', cookie: t.cookies.repA, body })).status, 403);
    assert.equal((await t.call(path, { method: 'POST', cookie: t.cookies.boardA, body })).status, 403, 'zarząd klasowy nie dołącza gospodarstw');
    assert.equal((await t.call(path, { method: 'POST', cookie: t.cookies.board, body: { ...body, householdId: 'h-nope' } })).status, 404);
    assert.equal((await t.call('/api/students/s-nope/households', { method: 'POST', cookie: t.cookies.board, body })).status, 404);
    assert.equal((await t.call(path, { method: 'POST', cookie: t.cookies.board, body: { ...body, reason: 'x' } })).status, 400);
    assert.equal((await t.call(path, { method: 'POST', cookie: t.cookies.board, body: { ...body, startsOn: 'jutro' } })).status, 400);
    // Drugie główne gospodarstwo w tym samym czasie: 409, nic nie dopisane.
    const overlap = await t.call(path, { method: 'POST', cookie: t.cookies.board, body: { ...body, isPrimary: true } });
    assert.equal(overlap.status, 409);
    assert.equal(overlap.body.error, 'student_household_overlap');

    const added = await t.call(path, { method: 'POST', cookie: t.cookies.board, body });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const repeat = await t.call(path, { method: 'POST', cookie: t.cookies.board, body });
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.changed, false);
    assert.equal(repeat.body.membership.id, added.body.membership.id);
    assert.equal((await t.db.query(`SELECT count(*)::int AS n FROM student_households WHERE student_id = 's-1' AND household_id = 'h-2'`)).rows[0].n, 1);

    const endPath = `${path}/${added.body.membership.id}/end`;
    assert.equal((await t.call(endPath, { method: 'POST', cookie: t.cookies.repA, body: { endsOn: '2026-10-01', reason: REASON } })).status, 403);
    const ended = await t.call(endPath, { method: 'POST', cookie: t.cookies.board, body: { endsOn: '2026-10-01', reason: REASON } });
    assert.deepEqual(ended.body, {
      membership: { id: added.body.membership.id, studentId: 's-1', householdId: 'h-2', endsOn: '2026-10-01' },
      changed: true, withoutPrimaryHousehold: false,
    });
    const doubleClick = await t.call(endPath, { method: 'POST', cookie: t.cookies.board, body: { endsOn: '2026-11-01', reason: 'Inny' } });
    assert.equal(doubleClick.body.changed, false);
    assert.equal(doubleClick.body.membership.endsOn, '2026-10-01');

    const row = await t.db.query(
      `SELECT created_reason, ended_reason, created_by, ended_by, source, ended_at IS NOT NULL AS has_end_time
         FROM student_households WHERE id = $1`, [added.body.membership.id]);
    assert.deepEqual(row.rows[0], { created_reason: REASON, ended_reason: REASON, created_by: 'u-board', ended_by: 'u-board', source: 'api', has_end_time: true });
    const audit = await t.db.query(`SELECT action FROM audit_events WHERE action LIKE 'student_household.%' ORDER BY action`);
    assert.deepEqual(audit.rows.map((r) => r.action), ['student_household.added', 'student_household.ended']);
    assert.doesNotMatch(JSON.stringify((await t.db.query(`SELECT metadata_json FROM audit_events WHERE action LIKE 'student_household.%'`)).rows), /Zmiana opieki|@/);
    // Zakończone członkostwo jest niezmienne, korekta to nowy wiersz.
    await assert.rejects(t.db.query(`UPDATE student_households SET ended_reason = 'poprawka' WHERE id = $1`, [added.body.membership.id]), /student_household_already_ended/);
    await assert.rejects(t.db.query(`DELETE FROM student_households WHERE id = $1`, [added.body.membership.id]), /cannot_be_deleted/);
  } finally { await t.db.close(); }
});

test('zmiana głównego gospodarstwa: koniec starego + nowe od tej samej daty; zakończenie głównego bez następcy zgłoszone', async () => {
  const t = await setup();
  try {
    const primary = (await t.db.query(`SELECT id FROM student_households WHERE student_id = 's-1' AND is_primary`)).rows[0].id;
    // Zarząd klasowy może zakończyć członkostwo dziecka ze swojej klasy, nie cudzego.
    const s2primary = (await t.db.query(`SELECT id FROM student_households WHERE student_id = 's-2' AND is_primary`)).rows[0].id;
    assert.equal((await t.call(`/api/students/s-2/households/${s2primary}/end`, {
      method: 'POST', cookie: t.cookies.boardA, body: { endsOn: '2020-01-01', reason: REASON } })).status, 404);

    const ended = await t.call(`/api/students/s-1/households/${primary}/end`, {
      method: 'POST', cookie: t.cookies.boardA, body: { endsOn: '2020-01-01', reason: REASON },
    });
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
    assert.equal(ended.body.withoutPrimaryHousehold, true);
    // Bez głównego gospodarstwa uczeń nie trafia do kampanii (wariant zachowawczy do D-11).
    const snapshot = await computeSnapshot(t.db, { school_year_id: YEAR, audience: 'all_households' });
    assert.deepEqual(snapshot.recipients.map((r) => r.householdId), ['h-2']);

    const switched = await t.call('/api/students/s-1/households', {
      method: 'POST', cookie: t.cookies.board, body: { householdId: 'h-3', isPrimary: true, startsOn: '2020-01-01', reason: 'Nowe gospodarstwo główne (syntetyczne)' },
    });
    assert.equal(switched.status, 201, JSON.stringify(switched.body));
    const main = await t.db.query('SELECT household_id FROM student_primary_household_current WHERE student_id = $1', ['s-1']);
    assert.deepEqual(main.rows, [{ household_id: 'h-3' }]);
    // Historia: stary wiersz zostaje z datą końca, nowy jest osobnym zapisem.
    const rows = await t.db.query(`SELECT household_id, is_primary, ends_on IS NOT NULL AS ended FROM student_households WHERE student_id = 's-1' ORDER BY household_id`);
    assert.deepEqual(rows.rows, [{ household_id: 'h-1', is_primary: true, ended: true }, { household_id: 'h-3', is_primary: true, ended: false }]);
  } finally { await t.db.close(); }
});

test('#152 członkostwo w gospodarstwie: powód z e-mailem odrzucony, z telefonem wymaga potwierdzenia, bez zapisu przy odmowie', async () => {
  const t = await setup();
  try {
    const before = (await t.db.query('SELECT count(*)::int AS n FROM student_households')).rows[0].n;
    const addBody = { householdId: 'h-3', startsOn: '2020-01-01' };
    const addCall = (body) => t.call('/api/students/s-1/households', { method: 'POST', cookie: t.cookies.board, body });
    const email = await addCall({ ...addBody, reason: 'Kontakt rodzic@example.invalid', confirmPersonalData: true });
    assert.equal(email.status, 422);
    assert.equal(email.body.error, 'personal_data_forbidden');
    const phone = await addCall({ ...addBody, reason: 'Kontakt +32 470 12 34 56' });
    assert.equal(phone.status, 422);
    assert.equal(phone.body.error, 'possible_personal_data');
    assert.equal((await t.db.query('SELECT count(*)::int AS n FROM student_households')).rows[0].n, before);
    const ok = await addCall({ ...addBody, reason: 'Kontakt +32 470 12 34 56', confirmPersonalData: true });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));

    const primary = (await t.db.query(`SELECT id FROM student_households WHERE student_id = 's-1' AND is_primary`)).rows[0].id;
    const endCall = (body) => t.call(`/api/students/s-1/households/${primary}/end`, { method: 'POST', cookie: t.cookies.board, body });
    const endEmail = await endCall({ endsOn: '2020-01-01', reason: 'Zmiana, pisać na rodzic@example.invalid' });
    assert.equal(endEmail.status, 422);
    assert.equal(endEmail.body.error, 'personal_data_forbidden');
    assert.equal((await t.db.query('SELECT ends_on FROM student_households WHERE id = $1', [primary])).rows[0].ends_on, null);
    assert.equal((await endCall({ endsOn: '2020-01-01', reason: 'Zmiana gospodarstwa (syntetyczna)' })).status, 200);
    const audit = JSON.stringify((await t.db.query(`SELECT metadata_json FROM audit_events WHERE action IN ('student_household.added','student_household.ended')`)).rows);
    assert.ok(audit.includes('piiConfirmed') && !SYNTHETIC_PHONE_IN_TEXT.test(audit) && !audit.includes('example.invalid'));
  } finally { await t.db.close(); }
});

test('#152 zakończenie relacji opiekun–dziecko: powód z e-mailem/IBAN odrzucony, telefon wymaga potwierdzenia, bez zapisu przy odmowie', async () => {
  const t = await setup();
  try {
    const call = (body) => endRelation(t, t.cookies.board, 's-1', 'g-1a', { endsOn: '2020-01-01', ...body });
    const email = await call({ reason: 'Nowy adres: rodzic@example.invalid', confirmPersonalData: true });
    assert.equal(email.status, 422);
    assert.equal(email.body.error, 'personal_data_forbidden');
    const iban = await call({ reason: 'Zwrot na BE71096123456769', confirmPersonalData: true });
    assert.equal(iban.status, 422);
    assert.equal(iban.body.error, 'personal_data_forbidden');
    const phone = await call({ reason: 'Kontakt +32 470 12 34 56' });
    assert.equal(phone.status, 422);
    assert.equal(phone.body.error, 'possible_personal_data');
    const history = async () => (await t.db.query(`SELECT reason FROM student_guardian_changes WHERE student_id = 's-1' AND guardian_id = 'g-1a'`)).rows;
    assert.ok(!JSON.stringify(await history()).includes('example.invalid'), 'odmowa nie zapisuje historii');
    const relation = await t.db.query(`SELECT ends_on FROM student_guardians WHERE student_id = 's-1' AND guardian_id = 'g-1a'`);
    assert.equal(relation.rows[0].ends_on, null);
    const ok = await call({ reason: 'Kontakt +32 470 12 34 56', confirmPersonalData: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const audit = JSON.stringify((await t.db.query(`SELECT metadata_json FROM audit_events WHERE action = 'student_guardian.ended'`)).rows);
    assert.ok(audit.includes('piiConfirmed') && !SYNTHETIC_PHONE_IN_TEXT.test(audit));
  } finally { await t.db.close(); }
});

// Kampania zatwierdzona i zakolejkowana PRZED zmianą — worker i podgląd.
async function approvedCampaign(t) {
  const created = await t.call('/api/email/campaigns', {
    cookie: t.cookies.treasurer, method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: { schoolYearId: YEAR, title: 'Przypomnienie', audience: 'all_households', subject: 'Składka {rok}', bodyText: BODY },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.campaign.id;
  assert.equal((await t.call(`/api/email/campaigns/${id}/snapshot`, { cookie: t.cookies.treasurer, method: 'POST' })).status, 200);
  const preview = await t.call(`/api/email/campaigns/${id}/preview`, { cookie: t.cookies.board });
  assert.deepEqual(preview.body.staleRecipients, {});
  const approved = await t.call(`/api/email/campaigns/${id}/approve`, {
    cookie: t.cookies.board, method: 'POST', body: { contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash },
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal((await t.call(`/api/email/campaigns/${id}/queue`, { cookie: t.cookies.treasurer, method: 'POST' })).status, 200);
  return id;
}

async function runWorker(t) {
  const sent = [];
  const transport = { name: 'fake', async send(message) { sent.push(message); return { messageId: `fake-${sent.length}` }; } };
  const run = await runEmailBatch(t.baseEnv, { transport, dryRun: false, now: ON_D });
  return { sent, run };
}

test('kampania zatwierdzona przed utratą relacji: ostrzeżenie w podglądzie, worker nie wysyła do opiekuna, przebudowa migawki wymaga nowego zatwierdzenia', async () => {
  const t = await setup();
  try {
    const id = await approvedCampaign(t);
    const stored = await t.db.query('SELECT household_id, guardian_id FROM email_campaign_recipients WHERE campaign_id = $1 ORDER BY household_id', [id]);
    assert.deepEqual(stored.rows, [{ household_id: 'h-1', guardian_id: 'g-1a' }, { household_id: 'h-2', guardian_id: 'g-2' }]);

    const ended = await endRelation(t, t.cookies.board, 's-1', 'g-1a');
    assert.deepEqual(ended.body.campaignsToReview, [id]);
    const preview = await t.call(`/api/email/campaigns/${id}/preview`, { cookie: t.cookies.board });
    assert.deepEqual(preview.body.staleRecipients, { guardian_relation_ended: 1 });
    // Zatwierdzona migawka sama się nie zmienia — decyzja należy do zarządu.
    assert.equal(preview.body.recipientsCount, 2);

    const { sent } = await runWorker(t);
    assert.deepEqual(sent.map((m) => (m.to?.[0]?.email ?? m.to ?? m.email)).flat().sort(), ['g-2@example.invalid']);
    const outbox = await t.db.query('SELECT household_id, state, last_error FROM email_outbox WHERE campaign_id = $1 ORDER BY household_id', [id]);
    assert.deepEqual(outbox.rows, [
      { household_id: 'h-1', state: 'suppressed', last_error: 'consent_or_address_changed' },
      { household_id: 'h-2', state: 'sent', last_error: null },
    ]);
  } finally { await t.db.close(); }
});

test('kampania zatwierdzona przed odejściem dziecka: ostrzeżenie, worker nie wysyła, rodzeństwo w drugim gospodarstwie i wpłata bez zmian', async () => {
  const t = await setup();
  try {
    await t.db.query(
      `INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key)
       VALUES ('p-1', 'h-1', $1, 2500, '2026-09-20', 'bank', 'recorded', 'u-seed', 'fam-changes-p1')`, [YEAR]);
    const totals = async () => (await t.db.query(`SELECT household_id, net_amount_cents::int AS net FROM household_payment_totals WHERE school_year_id = $1 ORDER BY household_id`, [YEAR])).rows;
    const before = await totals();
    const id = await approvedCampaign(t);

    const ended = await t.call('/api/students/s-1/enrollments/e-1/end', {
      method: 'POST', cookie: t.cookies.board, body: { endedOn: '2020-01-01', reason: REASON },
    });
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
    const preview = await t.call(`/api/email/campaigns/${id}/preview`, { cookie: t.cookies.board });
    assert.deepEqual(preview.body.staleRecipients, { student_withdrawn: 1 });

    const { sent, run } = await runWorker(t);
    assert.equal(sent.length, 1);
    assert.equal(run.suppressed, 1);
    const outbox = await t.db.query('SELECT household_id, state, last_error FROM email_outbox WHERE campaign_id = $1 ORDER BY household_id', [id]);
    assert.deepEqual(outbox.rows, [
      { household_id: 'h-1', state: 'suppressed', last_error: 'student_withdrawn' },
      { household_id: 'h-2', state: 'sent', last_error: null },
    ]);
    assert.deepEqual(await totals(), before, 'wpłata zapisana przed odejściem nie jest zmieniana');
    assert.equal((await t.db.query(`SELECT count(*)::int AS n FROM payment_entries WHERE household_id = 'h-1'`)).rows[0].n, 1);
  } finally { await t.db.close(); }
});

// #86/#535: zakończenie członkostwa opiekuna w gospodarstwie (guardian_households, migracja 0163).
// h-2 ma dwoje opiekunów (g-1b, g-2); g-1b opiekuje się też Olą z h-1 (rodzeństwo w dwóch gospodarstwach).
const guardianMembership = async (t, guardianId, householdId) => (await t.db.query(
  'SELECT id FROM guardian_households WHERE guardian_id = $1 AND household_id = $2', [guardianId, householdId])).rows[0].id;
const endGuardianHousehold = (t, cookie, guardianId, membershipId, body = { endsOn: '2020-01-01', reason: REASON }) =>
  t.call(`/api/guardians/${guardianId}/households/${membershipId}/end`, { method: 'POST', cookie, body });

test('członkostwo opiekuna w gospodarstwie: granice ról (tylko zakres szeroki), walidacja i 404 bez zapisu', async () => {
  const t = await setup();
  try {
    const mid = await guardianMembership(t, 'g-2', 'h-2');
    assert.equal((await endGuardianHousehold(t, t.cookies.repA, 'g-2', mid)).status, 403);
    assert.equal((await endGuardianHousehold(t, t.cookies.treasurer, 'g-2', mid)).status, 403);
    // Zarząd klasowy nie zmienia gospodarstwa (może obejmować dzieci innych klas) — także dla opiekuna dziecka z 1A.
    const g1aMid = await guardianMembership(t, 'g-1a', 'h-1');
    const classBoard = await endGuardianHousehold(t, t.cookies.boardA, 'g-1a', g1aMid);
    assert.equal(classBoard.status, 403);
    assert.equal(classBoard.body.error, 'forbidden');
    const denied = await t.db.query(`SELECT actor_id, entity_id FROM audit_events WHERE action = 'access.denied'`);
    assert.deepEqual(denied.rows.map((r) => r.actor_id).sort(), ['u-board-a', 'u-rep-a', 'u-tr']);
    assert.ok(denied.rows.every((r) => !r.entity_id.includes('?')));

    assert.equal((await endGuardianHousehold(t, t.cookies.board, 'g-2', 'gh-nope')).status, 404);
    // Identyfikator członkostwa innego opiekuna: 404, nie zakończenie cudzego wiersza.
    assert.equal((await endGuardianHousehold(t, t.cookies.board, 'g-1b', mid)).status, 404);
    assert.equal((await endGuardianHousehold(t, t.cookies.board, 'g-2', mid, { endsOn: '2020-01-01', reason: 'x' })).status, 400);
    assert.equal((await endGuardianHousehold(t, t.cookies.board, 'g-2', mid, { endsOn: '2020-02-30', reason: REASON })).status, 400);
    // Data zakończenia przed początkiem członkostwa: 400.
    await t.db.query(`INSERT INTO guardian_households (id, guardian_id, household_id, starts_on, source) VALUES ('gh-late', 'g-2', 'h-1', '2026-09-15', 'api')`);
    const early = await endGuardianHousehold(t, t.cookies.board, 'g-2', 'gh-late', { endsOn: '2026-09-01', reason: REASON });
    assert.equal(early.status, 400);
    assert.equal(early.body.error, 'invalid_ended_on');
    const state = await t.db.query(`SELECT
      (SELECT count(*)::int FROM guardian_households WHERE ends_on IS NOT NULL) AS ended,
      (SELECT count(*)::int FROM audit_events WHERE action = 'guardian_household.ended') AS audit`);
    assert.deepEqual(state.rows[0], { ended: 0, audit: 0 });
  } finally { await t.db.close(); }
});

test('dwoje opiekunów w gospodarstwie: jeden odchodzi z powodem i audytem, drugi i relacje z dziećmi zostają; podwójne kliknięcie', async () => {
  const t = await setup();
  try {
    const mid = await guardianMembership(t, 'g-1b', 'h-2');
    const first = await endGuardianHousehold(t, t.cookies.board, 'g-1b', mid);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    // g-1b nie należy do żadnego innego gospodarstwa — odpowiedź to zgłasza.
    assert.deepEqual(first.body, {
      membership: { id: mid, guardianId: 'g-1b', householdId: 'h-2', endsOn: '2020-01-01' },
      changed: true, withoutHousehold: true,
    });
    const again = await endGuardianHousehold(t, t.cookies.board, 'g-1b', mid, { endsOn: '2021-05-05', reason: 'Inny powód' });
    assert.equal(again.status, 200);
    assert.equal(again.body.changed, false);
    assert.equal(again.body.membership.endsOn, '2020-01-01');

    const row = await t.db.query(
      `SELECT to_char(ends_on, 'YYYY-MM-DD') AS ends_on, ended_reason, ended_by, ended_at IS NOT NULL AS has_end_time
         FROM guardian_households WHERE id = $1`, [mid]);
    assert.deepEqual(row.rows[0], { ends_on: '2020-01-01', ended_reason: REASON, ended_by: 'u-board', has_end_time: true });
    const audit = await t.db.query(`SELECT actor_id, entity_type, entity_id, metadata_json FROM audit_events WHERE action = 'guardian_household.ended'`);
    assert.equal(audit.rows.length, 1);
    assert.deepEqual([audit.rows[0].actor_id, audit.rows[0].entity_type, audit.rows[0].entity_id], ['u-board', 'guardian_household', mid]);
    assert.doesNotMatch(JSON.stringify(audit.rows), /Piotr|Testowy|@|Zmiana opieki/);

    // Karta h-2: został drugi opiekun; relacje g-1b z dziećmi (s-1, s-2) bez zmian — to osobna trasa.
    const card = await t.call('/api/households/h-2', { cookie: t.cookies.board });
    assert.equal(card.status, 200);
    assert.deepEqual(card.body.guardians.map((g) => g.id), ['g-2']);
    const relations = await t.db.query(`SELECT student_id FROM student_guardians_current WHERE guardian_id = 'g-1b' ORDER BY student_id`);
    assert.deepEqual(relations.rows.map((r) => r.student_id), ['s-1', 's-2']);
    // Kolumna zgodności guardians.household_id i drugi opiekun bez zmian.
    assert.equal((await t.db.query(`SELECT household_id FROM guardians WHERE id = 'g-1b'`)).rows[0].household_id, 'h-2');
    assert.equal((await t.db.query(`SELECT count(*)::int AS n FROM guardian_households_current WHERE household_id = 'h-2'`)).rows[0].n, 1);

    // Zakończone członkostwo jest niezmienne i nieusuwalne; korekta to nowy wiersz.
    await assert.rejects(t.db.query(`UPDATE guardian_households SET ended_reason = 'poprawka' WHERE id = $1`, [mid]), /guardian_household_already_ended/);
    await assert.rejects(t.db.query(`DELETE FROM guardian_households WHERE id = $1`, [mid]), /cannot_be_deleted/);
    // Powód bez daty zakończenia odrzuca baza (0163).
    const open = await guardianMembership(t, 'g-2', 'h-2');
    await assert.rejects(t.db.query(`UPDATE guardian_households SET ended_reason = 'bez daty' WHERE id = $1`, [open]), /guardian_household_end_reason_with_end/);

    // Opiekun z drugim bieżącym gospodarstwem: withoutHousehold = false.
    await t.db.query(`INSERT INTO guardian_households (id, guardian_id, household_id, source) VALUES ('gh-g2-h1', 'g-2', 'h-1', 'api')`);
    const second = await endGuardianHousehold(t, t.cookies.board, 'g-2', open);
    assert.equal(second.body.withoutHousehold, false);
  } finally { await t.db.close(); }
});

test('członkostwo opiekuna: data w zamkniętym roku daje 409, powód z e-mailem 422 — bez zapisu', async () => {
  const t = await setup();
  try {
    const mid = await guardianMembership(t, 'g-2', 'h-2');
    await closeYear(t.db, OLD_YEAR);
    const closed = await endGuardianHousehold(t, t.cookies.board, 'g-2', mid, { endsOn: '2026-03-01', reason: REASON });
    assert.equal(closed.status, 409);
    assert.equal(closed.body.error, 'school_year_closed');
    const email = await endGuardianHousehold(t, t.cookies.board, 'g-2', mid,
      { endsOn: '2026-10-01', reason: 'Kontakt rodzic@example.invalid', confirmPersonalData: true });
    assert.equal(email.status, 422);
    assert.equal(email.body.error, 'personal_data_forbidden');
    const phone = await endGuardianHousehold(t, t.cookies.board, 'g-2', mid, { endsOn: '2026-10-01', reason: 'Kontakt +32 470 12 34 56' });
    assert.equal(phone.status, 422);
    assert.equal(phone.body.error, 'possible_personal_data');
    assert.equal((await t.db.query('SELECT ends_on FROM guardian_households WHERE id = $1', [mid])).rows[0].ends_on, null);
    assert.equal((await t.db.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'guardian_household.ended'`)).rows[0].n, 0);
    // Data w otwartym roku i potwierdzony telefon: zapis z flagą w audycie, bez numeru.
    const ok = await endGuardianHousehold(t, t.cookies.board, 'g-2', mid,
      { endsOn: '2026-10-01', reason: 'Kontakt +32 470 12 34 56', confirmPersonalData: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const audit = JSON.stringify((await t.db.query(`SELECT metadata_json FROM audit_events WHERE action = 'guardian_household.ended'`)).rows);
    assert.ok(audit.includes('piiConfirmed') && !SYNTHETIC_PHONE_IN_TEXT.test(audit));
  } finally { await t.db.close(); }
});
