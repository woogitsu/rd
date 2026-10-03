// Zaproszenia zbiorcze przedstawicieli klas (#108): podgląd z numerami wierszy,
// jedno zatwierdzenie, klucz idempotencji partii, granice ról. Wyłącznie dane
// syntetyczne (domeny .invalid); moduł niczego nie wysyła.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { invitationBatchDigest, parseInvitationBatchText } from '../src/pg/invitation-batch.js';
import { perTestDb, request, seedClass, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';

// #111: każdy test zakłada własną bazę w setup(); perTestDb() zamyka ją zaraz po teście.
const createDb = perTestDb();

const Y = 'y-2026';
const Y2 = 'y-2027';
const FAST = { SCRYPT_COST_LOG2: '15', LOGIN_EMAIL_DELAY_MS: '0' };

async function setup() {
  const db = await createDb();
  await seedSchoolYear(db, Y, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, Y2, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: Y, name: '1A' });
  await seedClass(db, { id: 'c-1b', schoolYearId: Y, name: '1B' });
  await seedClass(db, { id: 'c-2027-1a', schoolYearId: Y2, name: '1A' });
  const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
  return { db, env: { db, ...FAST }, admin };
}

async function call(env, path, { cookie, method = 'POST', body, headers = {} } = {}) {
  const response = await handlePgRequest(request(path, { method, cookie, body, headers: { 'x-rd-client-ip': '203.0.113.9', ...headers } }), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null, headers: response.headers };
}
const preview = (env, cookie, body) => call(env, '/api/admin/invitation-batches/preview', { cookie, body });
const apply = (env, cookie, body, key) => call(env, '/api/admin/invitation-batches/apply', { cookie, body, headers: { 'Idempotency-Key': key } });

const auditCount = async (db, action) => Number((await db.query('SELECT count(*)::int AS n FROM audit_events WHERE action = $1', [action])).rows[0].n);

describe('parser wklejonego tekstu (#108)', () => {
  test('numer wiersza to numer linii; nagłówek, puste linie i komentarze pomijane', () => {
    const rows = parseInvitationBatchText('klasa;e-mail\n\n1A; rep.a@example.invalid\n# uwaga\n1B,rep.b@example.invalid\n1A\trep.c@example.invalid\nsamo-cos');
    assert.deepEqual(rows.map((row) => [row.row, row.classRef, row.email, row.error ?? null]), [
      [3, '1A', 'rep.a@example.invalid', null],
      [5, '1B', 'rep.b@example.invalid', null],
      [6, '1A', 'rep.c@example.invalid', null],
      [7, null, null, 'invalid_row_format'],
    ]);
  });

  test('pusty tekst i za dużo wierszy są odrzucane', () => {
    assert.throws(() => parseInvitationBatchText('\n \n'), /invitation_batch_empty/);
    assert.throws(() => parseInvitationBatchText(Array.from({ length: 101 }, (_, i) => `1A;r${i}@example.invalid`).join('\n')), /too_many_rows/);
    assert.throws(() => parseInvitationBatchText(42), /invalid_invitation_batch_text/);
  });
});

describe('zaproszenia zbiorcze: podgląd (#108)', () => {
  test('błędne wiersze z numerem wiersza i kodem; podgląd nic nie zapisuje', async () => {
    const { db, env, admin } = await setup();
    await seedUser(db, { userId: 'u-rep-old', email: 'juz.jest@example.invalid' });
    await db.query(`INSERT INTO role_grants (id, user_id, role, class_id, school_year_id, granted_by)
      VALUES ('g-old', 'u-rep-old', 'representative', 'c-1b', $1, 'u-admin')`, [Y]);
    await call(env, '/api/admin/invitations', { cookie: admin, body: { email: 'oczekuje@example.invalid', role: 'representative', classId: 'c-1a' } });
    const createdBefore = await auditCount(db, 'invitation.created');

    const text = [
      '1A; nowy.rep@example.invalid', // 1 ok
      '1A; to-nie-adres', // 2 invalid_email
      '9Z; ktos@example.invalid', // 3 class_not_found
      '1a; NOWY.rep@example.invalid', // 4 duplikat wiersza 1 (nazwa i adres bez rozróżniania wielkości liter)
      '1A; oczekuje@example.invalid', // 5 oczekujące zaproszenie
      '1B; juz.jest@example.invalid', // 6 już przedstawiciel tej klasy
      '1A; juz.jest@example.invalid', // 7 ok — istniejące konto, inna klasa
      '1A; u-admin@example.invalid', // 8 własny adres
      '1A; a; b', // 9 zły format
    ].join('\n');
    const result = await preview(env, admin, { schoolYearId: Y, text });
    assert.equal(result.status, 200);
    const byRow = Object.fromEntries(result.data.rows.map((row) => [row.row, row]));
    assert.equal(byRow[1].error, null);
    assert.equal(byRow[1].classId, 'c-1a');
    assert.equal(byRow[1].existingAccount, false);
    assert.equal(byRow[2].error, 'invalid_email');
    assert.equal(byRow[3].error, 'class_not_found');
    assert.equal(byRow[4].error, 'duplicate_row');
    assert.equal(byRow[5].error, 'invitation_pending');
    assert.equal(byRow[6].error, 'representative_already_assigned');
    assert.equal(byRow[7].error, null);
    assert.equal(byRow[7].existingAccount, true);
    assert.equal(byRow[8].error, 'cannot_grant_self');
    assert.equal(byRow[9].error, 'invalid_row_format');
    assert.deepEqual(result.data.counts, { total: 9, valid: 2, invalid: 7 });
    assert.match(result.data.planDigest, /^[0-9a-f]{64}$/);
    assert.equal(await auditCount(db, 'invitation.created'), createdBefore, 'podgląd nie tworzy zaproszeń');

    // Partia z błędnymi wierszami nie przechodzi zatwierdzenia (cała albo nic).
    const rejected = await apply(env, admin, { schoolYearId: Y, text, planDigest: result.data.planDigest }, 'partia-bledna-0001');
    assert.equal(rejected.status, 422);
    assert.equal(rejected.data.error, 'invitation_batch_invalid');
    assert.equal(await auditCount(db, 'invitation.created'), createdBefore);
  });

  test('klasa spoza wskazanego roku jest „nie znaleziona”; nieznany rok: 404', async () => {
    const { env, admin } = await setup();
    const other = await preview(env, admin, { schoolYearId: Y, text: 'c-2027-1a; rep@example.invalid' });
    assert.equal(other.data.rows[0].error, 'class_not_found');
    const sameName = await preview(env, admin, { schoolYearId: Y2, text: '1A; rep@example.invalid' });
    assert.equal(sameName.data.rows[0].classId, 'c-2027-1a', 'nazwa klasy rozpoznawana w obrębie roku');
    assert.equal((await preview(env, admin, { schoolYearId: 'y-brak', text: '1A; rep@example.invalid' })).status, 404);
    assert.equal((await preview(env, admin, { schoolYearId: Y, text: '' })).data.error, 'invitation_batch_empty');
  });
});

describe('zaproszenia zbiorcze: zatwierdzenie (#108)', () => {
  test('osobne zaproszenia i zdarzenia, tokeny raz; audyt bez adresów e-mail', async () => {
    const { db, env, admin } = await setup();
    // Współprzedstawiciele 1A i jedna osoba przedstawicielem dwóch klas (rodzeństwo).
    const text = '1A; wspol.a@example.invalid\n1A; wspol.b@example.invalid\n1A; rodzic.dwoje@example.invalid\n1B; rodzic.dwoje@example.invalid';
    const plan = await preview(env, admin, { schoolYearId: Y, text, ttlHours: 72 });
    assert.equal(plan.data.counts.invalid, 0);
    const result = await apply(env, admin, { schoolYearId: Y, text, ttlHours: 72, planDigest: plan.data.planDigest }, 'partia-0001-abcdef');
    assert.equal(result.status, 201);
    assert.equal(result.data.replayed, false);
    assert.equal(result.data.invitations.length, 4);
    assert.equal(new Set(result.data.invitations.map((item) => item.token)).size, 4, 'każde zaproszenie ma własny token');
    assert.deepEqual(result.data.invitations.map((item) => item.row), [1, 2, 3, 4]);
    assert.equal(result.headers.get('Cache-Control'), 'no-store');

    const events = (await db.query("SELECT action, entity_id, metadata_json FROM audit_events WHERE action LIKE 'invitation.%' ORDER BY id")).rows;
    const created = events.filter((event) => event.action === 'invitation.created');
    assert.equal(created.length, 4);
    for (const event of created) {
      const metadata = typeof event.metadata_json === 'string' ? JSON.parse(event.metadata_json) : event.metadata_json;
      assert.equal(metadata.batchId, 'partia-0001-abcdef');
      assert.equal(metadata.role, 'representative');
    }
    const batch = events.filter((event) => event.action === 'invitation.batch_created');
    assert.equal(batch.length, 1);
    assert.equal(batch[0].entity_id, 'partia-0001-abcdef');
    assert.doesNotMatch(JSON.stringify(events), /example\.invalid/, 'dziennik bez adresów e-mail');

    const coverage = await call(env, `/api/admin/class-coverage?schoolYearId=${Y}`, { cookie: admin, method: 'GET' });
    const byId = Object.fromEntries(coverage.data.classes.map((item) => [item.id, item]));
    assert.equal(byId['c-1a'].pendingInvitationCount, 3);
    assert.equal(byId['c-1b'].pendingInvitationCount, 1);

    // Jedna osoba, dwie klasy: jedno konto, dwa przydziały (drugie przyjęcie obecnym hasłem).
    const [, , first, second] = result.data.invitations;
    const password = 'Syntetyczne haslo partii 108';
    const acceptNew = await call(env, '/api/invitations/accept', { body: { token: first.token, password, passwordRepeat: password } });
    assert.equal(acceptNew.status, 201, JSON.stringify(acceptNew.data));
    const acceptExisting = await call(env, '/api/invitations/accept', { body: { token: second.token, password } });
    assert.equal(acceptExisting.status, 201, JSON.stringify(acceptExisting.data));
    assert.equal(acceptExisting.data.created, false, 'drugie zaproszenie dołącza do istniejącego konta');
    const grants = (await db.query(
      `SELECT g.class_id FROM role_grants g JOIN users u ON u.id = g.user_id
        WHERE u.email = 'rodzic.dwoje@example.invalid' AND g.role = 'representative' ORDER BY g.class_id`,
    )).rows.map((row) => row.class_id);
    assert.deepEqual(grants, ['c-1a', 'c-1b']);
    assert.equal(Number((await db.query("SELECT count(*)::int AS n FROM users WHERE email = 'rodzic.dwoje@example.invalid'")).rows[0].n), 1);
  });

  test('podwójne kliknięcie i ponowienie po zerwaniu: ten sam klucz nie tworzy drugiej partii ani tokenów', async () => {
    const { db, env, admin } = await setup();
    const text = '1A; raz@example.invalid\n1B; dwa@example.invalid';
    const plan = await preview(env, admin, { schoolYearId: Y, text });
    const body = { schoolYearId: Y, text, planDigest: plan.data.planDigest };
    const [a, b] = await Promise.all([apply(env, admin, body, 'klik-podwojny-01'), apply(env, admin, body, 'klik-podwojny-01')]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 201]);
    const replayed = a.status === 200 ? a : b;
    const original = a.status === 201 ? a : b;
    assert.equal(replayed.data.replayed, true);
    assert.doesNotMatch(JSON.stringify(replayed.data), /"token"/, 'ponowienie nie zwraca tokenów');
    assert.deepEqual(replayed.data.invitations.map((item) => item.id), original.data.invitations.map((item) => item.id));
    assert.equal(await auditCount(db, 'invitation.created'), 2);
    assert.equal(await auditCount(db, 'invitation.batch_created'), 1);

    // Ponowienie później (np. po zerwanym połączeniu) — dalej ta sama partia.
    const later = await apply(env, admin, body, 'klik-podwojny-01');
    assert.equal(later.status, 200);
    assert.equal(later.data.replayed, true);
    // Ten sam klucz dla innego planu: 409; nowy klucz dla tych samych adresów: wiersze oczekujące → 409 stale.
    const other = '1A; trzy@example.invalid';
    const otherPlan = await preview(env, admin, { schoolYearId: Y, text: other });
    assert.equal((await apply(env, admin, { schoolYearId: Y, text: other, planDigest: otherPlan.data.planDigest }, 'klik-podwojny-01')).data.error, 'idempotency_key_reused');
    const again = await apply(env, admin, body, 'klik-nowy-klucz-02');
    assert.equal(again.status, 409);
    assert.equal(again.data.error, 'invitation_batch_stale');
    assert.equal(await auditCount(db, 'invitation.created'), 2);
  });

  test('zmiana stanu między podglądem a zatwierdzeniem: 409 i żadne zaproszenie partii nie powstaje', async () => {
    const { db, env, admin } = await setup();
    const text = '1A; pierwszy@example.invalid\n1B; drugi@example.invalid';
    const plan = await preview(env, admin, { schoolYearId: Y, text });
    // W międzyczasie ktoś zaprosił pojedynczo drugi adres.
    assert.equal((await call(env, '/api/admin/invitations', { cookie: admin, body: { email: 'drugi@example.invalid', role: 'representative', classId: 'c-1b' } })).status, 201);
    const result = await apply(env, admin, { schoolYearId: Y, text, planDigest: plan.data.planDigest }, 'partia-stale-0001');
    assert.equal(result.status, 409);
    assert.equal(result.data.error, 'invitation_batch_stale');
    const pending = (await db.query("SELECT email FROM invitations WHERE email = 'pierwszy@example.invalid'")).rows;
    assert.equal(pending.length, 0, 'cała partia albo nic');
    // Zmieniony tekst po podglądzie (inny skrót): też 409.
    const tampered = await apply(env, admin, { schoolYearId: Y, text: '1A; pierwszy@example.invalid', planDigest: plan.data.planDigest }, 'partia-stale-0002');
    assert.equal(tampered.data.error, 'invitation_batch_stale');
  });

  test('wymagane Idempotency-Key i planDigest; skrót liczony z rozpoznanych wierszy', async () => {
    const { env, admin } = await setup();
    const text = '1A; rep@example.invalid';
    const plan = await preview(env, admin, { schoolYearId: Y, text });
    const expected = invitationBatchDigest({
      schoolYearId: Y, ttlHours: null,
      rows: [{ row: 1, classId: 'c-1a', email: 'rep@example.invalid', error: null }],
    });
    assert.equal(plan.data.planDigest, expected);
    const noKey = await call(env, '/api/admin/invitation-batches/apply', { cookie: admin, body: { schoolYearId: Y, text, planDigest: expected } });
    assert.equal(noKey.data.error, 'invalid_idempotency_key');
    assert.equal((await apply(env, admin, { schoolYearId: Y, text }, 'partia-bez-skrotu')).data.error, 'invalid_plan_digest');
    assert.equal((await apply(env, admin, { schoolYearId: Y, text, planDigest: expected, ttlHours: 999 }, 'partia-zly-ttl')).data.error, 'invalid_ttl');
    const get = await call(env, '/api/admin/invitation-batches/preview', { cookie: admin, method: 'GET' });
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('Allow'), 'POST');
  });
});

describe('zaproszenia zbiorcze: granice ról (#108)', () => {
  test('zarząd, przedstawiciel i anonim nie mają dostępu; admin ze starym MFA: krok w górę', async () => {
    const { db, env } = await setup();
    const board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board' }], mfa: true });
    const rep = await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: Y }], mfa: true });
    const body = { schoolYearId: Y, text: '1A; rep.nowy@example.invalid' };
    for (const cookie of [board, rep]) {
      assert.equal((await preview(env, cookie, body)).status, 403);
      assert.equal((await apply(env, cookie, { ...body, planDigest: '0'.repeat(64) }, 'partia-obca-0001')).status, 403);
    }
    assert.equal((await preview(env, undefined, body)).status, 401);

    const stale = await seedUserSession(db, { userId: 'u-admin-stale', roles: [{ role: 'admin' }], mfa: true });
    await db.query("UPDATE sessions SET mfa_verified_at = now() - interval '20 minutes' WHERE user_id = 'u-admin-stale'");
    const result = await preview(env, stale, body);
    assert.equal(result.status, 403);
    assert.equal(result.data.error, 'mfa_stale');
    assert.equal(Number((await db.query("SELECT count(*)::int AS n FROM invitations WHERE email = 'rep.nowy@example.invalid'")).rows[0].n), 0);
  });
});
