import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { passwordLogin, resetPasswordWithToken } from '../src/pg/login.js';
import { buildAccountOperations } from '../src/pg/routes/reconciliation.js';
import { accountOperationsSection } from '../src/pg/audit-report.js';
import { createTestDb, request, seedClass, seedUser, seedUserSession, assertOwnerGuard } from './helpers/pg.js';
import { SYNTHETIC_PHONE_IN_TEXT } from './helpers/assertions.js';

// #146: nadanie roli chronionej (admin, zarząd, skarbnik) — przydział,
// zaproszenie i ponowne wydanie zaproszenia — wymaga drugiej osoby, gdy
// istnieje inny administrator. Wyłącznie dane syntetyczne (domeny .invalid).

async function setup({ admins = ['u-admin-a', 'u-admin-b', 'u-admin-c'] } = {}) {
  const db = await createTestDb();
  const cookies = {};
  for (const id of admins) cookies[id] = await seedUserSession(db, { userId: id, roles: [{ role: 'admin' }], mfa: true });
  await seedUser(db, { userId: 'u-target' });
  await seedUser(db, { userId: 'u-other' });
  return { db, env: { db }, cookies };
}

async function call(env, path, { cookie, method = 'GET', body } = {}) {
  const response = await handlePgRequest(request(path, { method, cookie, body }), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}
const post = (env, path, cookie, body = {}) => call(env, path, { method: 'POST', cookie, body });
const count = async (db, sql, params = []) => (await db.query(sql, params)).rows[0].n;
const grantsOf = (db, userId, role) => count(
  db, 'SELECT count(*)::int AS n FROM role_grants WHERE user_id = $1 AND role = $2 AND revoked_at IS NULL', [userId, role],
);
const events = async (db, action) => (await db.query(
  'SELECT actor_id, entity_id, metadata_json AS metadata FROM audit_events WHERE action = $1 ORDER BY occurred_at, id', [action],
)).rows;

test('nadanie skarbnika przy drugim administratorze: 202 i wniosek, bez przydziału; podwójne kliknięcie = jeden wniosek', async () => {
  const { db, env, cookies } = await setup();
  try {
    const first = await post(env, '/api/admin/grants', cookies['u-admin-a'], { userId: 'u-target', role: 'treasurer' });
    assert.equal(first.status, 202);
    assert.equal(first.data.request.status, 'pending');
    assert.equal(first.data.request.kind, 'grant');
    assert.equal(first.data.request.userId, 'u-target');
    assert.equal(first.data.request.requestedBy, 'u-admin-a');
    assert.equal(first.data.created, true);
    assert.equal(await grantsOf(db, 'u-target', 'treasurer'), 0);
    assert.equal((await events(db, 'role_grant.created')).length, 0);

    const again = await post(env, '/api/admin/grants', cookies['u-admin-a'], { userId: 'u-target', role: 'treasurer' });
    assert.equal(again.status, 202);
    assert.equal(again.data.request.id, first.data.request.id);
    assert.equal(again.data.created, false);
    // Drugi administrator składający to samo — ten sam otwarty wniosek.
    const other = await post(env, '/api/admin/grants', cookies['u-admin-b'], { userId: 'u-target', role: 'treasurer' });
    assert.equal(other.data.request.id, first.data.request.id);
    assert.equal((await events(db, 'role_grant_request.requested')).length, 1);
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM role_grant_requests'), 1);

    // Rola niechroniona działa jak dotąd (bez wniosku).
    const audit = await post(env, '/api/admin/grants', cookies['u-admin-a'], { userId: 'u-target', role: 'audit' });
    assert.equal(audit.status, 201);
    assert.equal((await events(db, 'role_grant.four_eyes_waived')).length, 0);
  } finally {
    await db.close();
  }
});

test('zatwierdzenie: wnioskodawca i adresat nie mogą; drugi administrator nadaje raz; ponowienie → 409', async () => {
  const { db, env, cookies } = await setup();
  try {
    // Adresat jest administratorem B — dostaje rolę zarządu.
    const requested = await post(env, '/api/admin/grants', cookies['u-admin-a'], { userId: 'u-admin-b', role: 'board' });
    assert.equal(requested.status, 202);
    const approve = `/api/admin/grant-requests/${requested.data.request.id}/approve`;

    const self = await post(env, approve, cookies['u-admin-a']);
    assert.equal(self.status, 403);
    assert.equal(self.data.error, 'grant_four_eyes_required');
    const target = await post(env, approve, cookies['u-admin-b']);
    assert.equal(target.status, 403);
    assert.equal(target.data.error, 'grant_four_eyes_required');
    assert.equal(await grantsOf(db, 'u-admin-b', 'board'), 0);

    const done = await post(env, approve, cookies['u-admin-c']);
    assert.equal(done.status, 200);
    assert.equal(done.data.request.status, 'approved');
    assert.equal(done.data.request.decidedBy, 'u-admin-c');
    assert.equal(done.data.grant.role, 'board');
    assert.equal(done.data.grant.grantedBy, 'u-admin-c');
    assert.equal(done.data.request.resultId, done.data.grant.id);
    assert.equal(await grantsOf(db, 'u-admin-b', 'board'), 1);

    const twice = await post(env, approve, cookies['u-admin-c']);
    assert.equal(twice.status, 409);
    assert.equal(twice.data.error, 'grant_request_closed');
    assert.equal(await grantsOf(db, 'u-admin-b', 'board'), 1);
    assert.equal((await events(db, 'role_grant_request.approved')).length, 1);

    const [created] = await events(db, 'role_grant.created');
    assert.equal(created.actor_id, 'u-admin-c');
    assert.equal(created.metadata.requestId, requested.data.request.id);
    assert.equal(created.metadata.requestedBy, 'u-admin-a');
    assert.equal(created.metadata.approvedBy, 'u-admin-c');

    // Zamknięty wniosek nie da się odrzucić; baza pilnuje niezmienności.
    assert.equal((await post(env, `/api/admin/grant-requests/${requested.data.request.id}/reject`, cookies['u-admin-a'])).status, 409);
    await assert.rejects(db.query("UPDATE role_grant_requests SET status = 'rejected'"), /role_grant_request_immutable/);
    await assertOwnerGuard(db, 'DELETE FROM role_grant_requests', /role_grant_request_immutable/);
    // Zasada czterech oczu także jako CHECK w bazie.
    await assert.rejects(db.query(
      `INSERT INTO role_grant_requests (id, kind, role, target_user_id, requested_by, status, expires_at, decided_by, decided_at, result_id)
       VALUES ('r-x', 'grant', 'admin', 'u-target', 'u-admin-a', 'approved', now() + interval '1 hour', 'u-admin-a', now(), 'g-x')`,
    ), /role_grant_requests_four_eyes/);
  } finally {
    await db.close();
  }
});

test('równoległe podwójne kliknięcie „Zatwierdź”: jeden przydział i jedno zdarzenie (PGlite: po kolei, nie wyścig)', async () => {
  const { db, env, cookies } = await setup();
  try {
    const requested = await post(env, '/api/admin/grants', cookies['u-admin-a'], { userId: 'u-target', role: 'admin' });
    const approve = `/api/admin/grant-requests/${requested.data.request.id}/approve`;
    const results = await Promise.all([post(env, approve, cookies['u-admin-b']), post(env, approve, cookies['u-admin-b'])]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(await grantsOf(db, 'u-target', 'admin'), 1);
    assert.equal((await events(db, 'role_grant.created')).length, 1);
    assert.equal((await events(db, 'role_grant_request.approved')).length, 1);
  } finally {
    await db.close();
  }
});

test('odrzucenie i wycofanie: bez przydziału; nowy wniosek po odrzuceniu możliwy', async () => {
  const { db, env, cookies } = await setup();
  try {
    const requested = await post(env, '/api/admin/grants', cookies['u-admin-a'], { userId: 'u-target', role: 'treasurer' });
    const withdrawn = await post(env, `/api/admin/grant-requests/${requested.data.request.id}/reject`, cookies['u-admin-a']);
    assert.equal(withdrawn.status, 200);
    assert.equal(withdrawn.data.request.status, 'rejected');
    assert.equal(await grantsOf(db, 'u-target', 'treasurer'), 0);
    assert.equal((await post(env, `/api/admin/grant-requests/${requested.data.request.id}/approve`, cookies['u-admin-b'])).status, 409);

    const list = await call(env, '/api/admin/grant-requests?status=all', { cookie: cookies['u-admin-b'] });
    assert.equal(list.status, 200);
    assert.equal(list.data.requests.length, 1);
    assert.equal((await call(env, '/api/admin/grant-requests?status=bogus', { cookie: cookies['u-admin-b'] })).status, 400);

    const next = await post(env, '/api/admin/grants', cookies['u-admin-a'], { userId: 'u-target', role: 'treasurer' });
    assert.equal(next.status, 202);
    assert.notEqual(next.data.request.id, requested.data.request.id);
  } finally {
    await db.close();
  }
});

// ---- 0159: opcjonalny powód odrzucenia (dane syntetyczne) ------------------------

const rejectPath = (id) => `/api/admin/grant-requests/${id}/reject`;
const statusOf = async (db, id) => (await db.query('SELECT status, reject_reason FROM role_grant_requests WHERE id = $1', [id])).rows[0];
const metadataOf = (event) => (typeof event.metadata === 'string' ? JSON.parse(event.metadata) : event.metadata);

async function pendingRequest(env, cookies, userId = 'u-target', role = 'treasurer') {
  const requested = await post(env, '/api/admin/grants', cookies['u-admin-a'], { userId, role });
  assert.equal(requested.status, 202);
  return requested.data.request.id;
}

test('0159: odrzucenie z powodem — powód w wierszu i na liście, w dzienniku tylko flaga; podwójne kliknięcie → 409, powód bez zmian', async () => {
  const { db, env, cookies } = await setup();
  try {
    const id = await pendingRequest(env, cookies);
    const reason = 'Brak uchwały zarządu w tej sprawie';
    const rejected = await post(env, rejectPath(id), cookies['u-admin-b'], { reason: `  ${reason}  ` });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.data.request.status, 'rejected');
    assert.equal(rejected.data.request.rejectReason, reason, 'spacje na brzegach obcięte');
    assert.deepEqual(await statusOf(db, id), { status: 'rejected', reject_reason: reason });

    // Drugie kliknięcie (inna treść) — 409, zapisany powód zostaje pierwszy, jedno zdarzenie.
    const again = await post(env, rejectPath(id), cookies['u-admin-c'], { reason: 'Inny powód odrzucenia' });
    assert.deepEqual([again.status, again.data.error], [409, 'grant_request_closed']);
    assert.equal((await statusOf(db, id)).reject_reason, reason);
    const logged = await events(db, 'role_grant_request.rejected');
    assert.equal(logged.length, 1);
    const metadata = metadataOf(logged[0]);
    assert.equal(metadata.reasonGiven, true);
    assert.doesNotMatch(JSON.stringify(logged[0]), /uchwały/, 'treść powodu nie trafia do dziennika zdarzeń');

    const list = await call(env, '/api/admin/grant-requests?status=rejected', { cookie: cookies['u-admin-c'] });
    assert.equal(list.status, 200);
    assert.equal(list.data.requests.find((item) => item.id === id).rejectReason, reason);
    const pendingList = await call(env, '/api/admin/grant-requests?status=pending', { cookie: cookies['u-admin-c'] });
    assert.equal(pendingList.data.requests.length, 0);
  } finally {
    await db.close();
  }
});

test('0159: pusty powód, same spacje, null i brak ciała żądania — odrzucenie bez powodu (reasonGiven: false)', async () => {
  const { db, env, cookies } = await setup({ admins: ['u-admin-a', 'u-admin-b'] });
  try {
    const bodies = [{ reason: '' }, { reason: '   ' }, { reason: null }, {}];
    for (const [index, body] of bodies.entries()) {
      await seedUser(db, { userId: `u-bez-powodu-${index}` });
      const id = await pendingRequest(env, cookies, `u-bez-powodu-${index}`);
      const rejected = await post(env, rejectPath(id), cookies['u-admin-b'], body);
      assert.equal(rejected.status, 200, JSON.stringify(body));
      assert.equal(rejected.data.request.rejectReason, null, JSON.stringify(body));
      assert.deepEqual(await statusOf(db, id), { status: 'rejected', reject_reason: null });
    }
    // Klient sprzed 0159: POST bez Content-Type i bez ciała.
    await seedUser(db, { userId: 'u-bez-ciala' });
    const id = await pendingRequest(env, cookies, 'u-bez-ciala');
    const response = await handlePgRequest(request(rejectPath(id), { method: 'POST', cookie: cookies['u-admin-b'] }), env);
    assert.equal(response.status, 200);
    assert.equal((await statusOf(db, id)).status, 'rejected');
    const logged = await events(db, 'role_grant_request.rejected');
    assert.equal(logged.length, bodies.length + 1);
    for (const event of logged) assert.equal(metadataOf(event).reasonGiven, false);
  } finally {
    await db.close();
  }
});

test('0159: powód z e-mailem, IBAN lub numerem rejestru → 422 bez zapisu; telefon wymaga potwierdzenia', async () => {
  const { db, env, cookies } = await setup();
  try {
    const id = await pendingRequest(env, cookies);
    for (const reason of [
      'Kontakt: adresat@example.invalid, proszę poczekać',
      'Zwrot na konto BE68 5390 0754 7034 po decyzji',
    ]) {
      const blocked = await post(env, rejectPath(id), cookies['u-admin-b'], { reason, confirmPersonalData: true });
      assert.equal(blocked.status, 422, reason);
      assert.equal(blocked.data.error, 'personal_data_forbidden');
      assert.ok(Array.isArray(blocked.data.categories) && blocked.data.categories.length > 0);
      assert.doesNotMatch(JSON.stringify(blocked.data), /example\.invalid|BE68/, 'odpowiedź bez fragmentu tekstu');
    }
    assert.deepEqual(await statusOf(db, id), { status: 'pending', reject_reason: null });
    assert.equal((await events(db, 'role_grant_request.rejected')).length, 0);

    const phone = 'Proszę o kontakt pod +32 470 12 34 56 przed ponownym wnioskiem';
    const unconfirmed = await post(env, rejectPath(id), cookies['u-admin-b'], { reason: phone });
    assert.equal(unconfirmed.status, 422);
    assert.equal(unconfirmed.data.error, 'possible_personal_data');
    assert.deepEqual(unconfirmed.data.categories, ['phone']);
    assert.equal((await statusOf(db, id)).status, 'pending');

    const confirmed = await post(env, rejectPath(id), cookies['u-admin-b'], { reason: phone, confirmPersonalData: true });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.data.request.rejectReason, phone);
    const [event] = await events(db, 'role_grant_request.rejected');
    const metadata = metadataOf(event);
    assert.equal(metadata.reasonGiven, true);
    assert.equal(metadata.piiConfirmed, true);
    assert.deepEqual(metadata.piiCategories, ['phone']);
    assert.doesNotMatch(JSON.stringify(event), SYNTHETIC_PHONE_IN_TEXT, 'numer nie trafia do dziennika');
  } finally {
    await db.close();
  }
});

test('0159: powód za krótki, za długi albo nie-tekst → 400 invalid_reason bez zapisu', async () => {
  const { db, env, cookies } = await setup();
  try {
    const id = await pendingRequest(env, cookies);
    // '😀a' ma 3 jednostki UTF-16, ale 2 znaki — jak char_length w CHECK bazy.
    for (const reason of ['ab', '😀a', 'x'.repeat(501), 42, ['lista'], { tekst: 'obiekt' }]) {
      const response = await post(env, rejectPath(id), cookies['u-admin-b'], { reason });
      assert.deepEqual([response.status, response.data.error], [400, 'invalid_reason'], JSON.stringify(reason));
    }
    assert.deepEqual(await statusOf(db, id), { status: 'pending', reject_reason: null });
    const edge = await post(env, rejectPath(id), cookies['u-admin-b'], { reason: 'x'.repeat(500) });
    assert.equal(edge.status, 200);
  } finally {
    await db.close();
  }
});

test('0159: granice ról — odrzucić z powodem może tylko administrator (zarząd, skarbnik, anonim nie)', async () => {
  const { db, env, cookies } = await setup();
  try {
    const id = await pendingRequest(env, cookies);
    const board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board' }], mfa: true });
    const treasurer = await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer' }], mfa: true });
    for (const cookie of [board, treasurer]) {
      assert.equal((await post(env, rejectPath(id), cookie, { reason: 'Próba spoza roli administratora' })).status, 403);
    }
    assert.equal((await post(env, rejectPath(id), undefined, { reason: 'Próba bez sesji' })).status, 401);
    // Bramka i walidacja działają dopiero po autoryzacji: bez roli nie ma 422 ani 400.
    assert.equal((await post(env, rejectPath(id), board, { reason: 'adresat@example.invalid' })).status, 403);
    assert.deepEqual(await statusOf(db, id), { status: 'pending', reject_reason: null });
    // Wnioskodawca może wycofać własny wniosek z powodem.
    const withdrawn = await post(env, rejectPath(id), cookies['u-admin-a'], { reason: 'Pomyłka w wyborze roli' });
    assert.equal(withdrawn.status, 200);
    assert.equal(withdrawn.data.request.decidedBy, 'u-admin-a');
  } finally {
    await db.close();
  }
});

test('0159: baza — powód tylko przy odrzuceniu i tylko w operacji zamknięcia; po zamknięciu niezmienny', async () => {
  const { db, env, cookies } = await setup();
  try {
    const id = await pendingRequest(env, cookies);
    // Powód bez odrzucenia (wniosek oczekujący) — strażnik albo CHECK.
    await assert.rejects(db.query("UPDATE role_grant_requests SET reject_reason = 'Powód bez zamknięcia' WHERE id = $1", [id]),
      /role_grant_request_immutable|role_grant_requests_reject_reason_check/);
    // Wygaśnięcie z powodem — CHECK.
    await assert.rejects(db.query(
      "UPDATE role_grant_requests SET status = 'expired', decided_at = now(), reject_reason = 'Powód wygaśnięcia' WHERE id = $1", [id],
    ), /role_grant_request_immutable|role_grant_requests_reject_reason_check/);
    // Powód z białymi znakami na brzegach albo za krótki — CHECK.
    for (const bad of [' Powód ze spacją', 'ab']) {
      await assert.rejects(db.query(
        "UPDATE role_grant_requests SET status = 'rejected', decided_by = 'u-admin-b', decided_at = now(), reject_reason = $2 WHERE id = $1", [id, bad],
      ), /role_grant_requests_reject_reason_check/);
    }
    assert.deepEqual(await statusOf(db, id), { status: 'pending', reject_reason: null });

    // Zamknięcie bez powodu, potem próba dopisania powodu — niezmienny.
    assert.equal((await post(env, rejectPath(id), cookies['u-admin-b'])).status, 200);
    await assert.rejects(db.query("UPDATE role_grant_requests SET reject_reason = 'Dopisany po czasie' WHERE id = $1", [id]),
      /role_grant_request_immutable/);
    await assert.rejects(db.query('UPDATE role_grant_requests SET reject_reason = NULL WHERE id = $1', [id]), /role_grant_request_immutable/);
    assert.equal((await statusOf(db, id)).reject_reason, null);

    // Zatwierdzony wniosek nie może mieć powodu odrzucenia.
    await seedUser(db, { userId: 'u-zatwierdzany' });
    const approvedId = await pendingRequest(env, cookies, 'u-zatwierdzany');
    assert.equal((await post(env, `/api/admin/grant-requests/${approvedId}/approve`, cookies['u-admin-b'])).status, 200);
    await assert.rejects(db.query("UPDATE role_grant_requests SET reject_reason = 'Po zatwierdzeniu' WHERE id = $1", [approvedId]),
      /role_grant_request_immutable/);
  } finally {
    await db.close();
  }
});

test('wygasły wniosek: zatwierdzenie → 409 grant_request_expired, stan expired, bez przydziału', async () => {
  const { db, env, cookies } = await setup();
  try {
    await db.query(
      `INSERT INTO role_grant_requests (id, kind, role, target_user_id, requested_by, created_at, expires_at)
       VALUES ('r-old', 'grant', 'treasurer', 'u-target', 'u-admin-a', now() - interval '4 days', now() - interval '1 day')`,
    );
    const result = await post(env, '/api/admin/grant-requests/r-old/approve', cookies['u-admin-b']);
    assert.equal(result.status, 409);
    assert.equal(result.data.error, 'grant_request_expired');
    assert.equal((await db.query("SELECT status FROM role_grant_requests WHERE id = 'r-old'")).rows[0].status, 'expired');
    assert.equal(await grantsOf(db, 'u-target', 'treasurer'), 0);
    assert.equal((await post(env, '/api/admin/grant-requests/r-missing/approve', cookies['u-admin-b'])).status, 404);
  } finally {
    await db.close();
  }
});

test('jedyny administrator (pierwsze uruchomienie): nadanie działa bezpośrednio, z jawnym wyjątkiem w dzienniku', async () => {
  const { db, env, cookies } = await setup({ admins: ['u-admin-a'] });
  try {
    const granted = await post(env, '/api/admin/grants', cookies['u-admin-a'], { userId: 'u-target', role: 'admin' });
    assert.equal(granted.status, 201);
    const [waiver] = await events(db, 'role_grant.four_eyes_waived');
    assert.equal(waiver.entity_id, granted.data.grant.id);
    assert.equal(waiver.metadata.reason, 'no_other_admin');
    assert.equal(waiver.metadata.role, 'admin');

    // Teraz jest drugi administrator — kolejne nadanie roli chronionej to wniosek.
    const next = await post(env, '/api/admin/grants', cookies['u-admin-a'], { userId: 'u-other', role: 'treasurer' });
    assert.equal(next.status, 202);
    // Adresat się nie liczy: A nadaje B (jedynemu innemu adminowi) rolę zarządu → wyjątek, nie wniosek.
    const toB = await post(env, '/api/admin/grants', cookies['u-admin-a'], { userId: 'u-target', role: 'board' });
    assert.equal(toB.status, 201);
    assert.equal((await events(db, 'role_grant.four_eyes_waived')).length, 2);
    // Samonadanie nadal 409, bez wiersza i zdarzenia.
    const self = await post(env, '/api/admin/grants', cookies['u-admin-a'], { userId: 'u-admin-a', role: 'treasurer' });
    assert.equal(self.status, 409);
    assert.equal(self.data.error, 'cannot_grant_self');
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM role_grant_requests'), 1);
  } finally {
    await db.close();
  }
});

test('wyłączony lub wygasły drugi administrator nie jest zatwierdzającym (wyjątek zamiast wniosku bez szans)', async () => {
  const { db, env, cookies } = await setup({ admins: ['u-admin-a'] });
  try {
    await seedUserSession(db, { userId: 'u-admin-off', roles: [{ role: 'admin' }], disabled: true });
    await seedUserSession(db, { userId: 'u-admin-old', roles: [{ role: 'admin', expiresAt: '2020-01-01T00:00:00Z' }] });
    const granted = await post(env, '/api/admin/grants', cookies['u-admin-a'], { userId: 'u-target', role: 'treasurer' });
    assert.equal(granted.status, 201);
    assert.equal((await events(db, 'role_grant.four_eyes_waived')).length, 1);
  } finally {
    await db.close();
  }
});

test('zaproszenie do roli chronionej: wniosek bez tokenu; zatwierdzający dostaje token; własny adres zatwierdzającego → 403', async () => {
  const { db, env, cookies } = await setup();
  try {
    const invite = await post(env, '/api/admin/invitations', cookies['u-admin-a'], { email: 'Nowy.Skarbnik@Example.invalid', role: 'treasurer' });
    assert.equal(invite.status, 202);
    assert.equal(invite.data.token, undefined);
    assert.equal(invite.data.request.kind, 'invitation');
    assert.equal(invite.data.request.email, 'nowy.skarbnik@example.invalid');
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM invitations'), 0);
    // Podwójne kliknięcie.
    const again = await post(env, '/api/admin/invitations', cookies['u-admin-a'], { email: 'nowy.skarbnik@example.invalid', role: 'treasurer' });
    assert.equal(again.data.request.id, invite.data.request.id);

    const done = await post(env, `/api/admin/grant-requests/${invite.data.request.id}/approve`, cookies['u-admin-b']);
    assert.equal(done.status, 200);
    assert.match(done.data.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(done.data.invitation.role, 'treasurer');
    const rows = (await db.query('SELECT id, created_by, role FROM invitations')).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].created_by, 'u-admin-b');
    assert.equal(done.data.request.resultId, rows[0].id);

    // Zaproszenie na adres zatwierdzającego: zatwierdzić musi ktoś inny.
    const toC = await post(env, '/api/admin/invitations', cookies['u-admin-a'], { email: 'u-admin-c@example.invalid', role: 'board' });
    assert.equal(toC.status, 202);
    const own = await post(env, `/api/admin/grant-requests/${toC.data.request.id}/approve`, cookies['u-admin-c']);
    assert.equal(own.status, 403);
    assert.equal(own.data.error, 'grant_four_eyes_required');

    // Zaproszenie na własny adres wnioskodawcy — jak dotąd 409, bez wniosku.
    const self = await post(env, '/api/admin/invitations', cookies['u-admin-a'], { email: 'u-admin-a@example.invalid', role: 'treasurer' });
    assert.equal(self.status, 409);
    assert.equal(self.data.error, 'cannot_grant_self');

    // Przedstawiciel klasy — bez zmian (bezpośrednio, token od razu).
    await seedClass(db, { id: 'c-1a', schoolYearId: 'y-test' });
    const rep = await post(env, '/api/admin/invitations', cookies['u-admin-a'], { email: 'rep@example.invalid', role: 'representative', classId: 'c-1a' });
    assert.equal(rep.status, 201);
    assert.match(rep.data.token, /^[A-Za-z0-9_-]{43}$/);
  } finally {
    await db.close();
  }
});

test('ponowne wydanie zaproszenia roli chronionej: wniosek; po zatwierdzeniu stary link wycofany, nowy token raz', async () => {
  const { db, env, cookies } = await setup();
  try {
    const invite = await post(env, '/api/admin/invitations', cookies['u-admin-a'], { email: 'zarzad@example.invalid', role: 'board' });
    const first = await post(env, `/api/admin/grant-requests/${invite.data.request.id}/approve`, cookies['u-admin-b']);
    const oldId = first.data.invitation.id;

    const reissue = await post(env, `/api/admin/invitations/${oldId}/reissue`, cookies['u-admin-a']);
    assert.equal(reissue.status, 202);
    assert.equal(reissue.data.token, undefined);
    assert.equal(reissue.data.request.replacesInvitationId, oldId);
    // Stare zaproszenie nadal oczekuje (do zatwierdzenia).
    assert.equal((await db.query('SELECT revoked_at FROM invitations WHERE id = $1', [oldId])).rows[0].revoked_at, null);

    const done = await post(env, `/api/admin/grant-requests/${reissue.data.request.id}/approve`, cookies['u-admin-c']);
    assert.equal(done.status, 200);
    assert.equal(done.data.invitation.replacesInvitationId, oldId);
    assert.ok((await db.query('SELECT revoked_at FROM invitations WHERE id = $1', [oldId])).rows[0].revoked_at);
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM invitations WHERE revoked_at IS NULL'), 1);
    assert.equal((await events(db, 'invitation.reissued')).length, 1);
  } finally {
    await db.close();
  }
});

test('logowanie po resecie administracyjnym jest oznaczone w dzienniku do zmiany hasła przez właściciela', async () => {
  const { db, env, cookies } = await setup();
  try {
    const issued = await post(env, '/api/admin/users/u-target/password-reset', cookies['u-admin-a']);
    assert.equal(issued.status, 201);
    await resetPasswordWithToken(env, { token: issued.data.token, newPassword: 'Nowe-Haslo-Syntetyczne-7390' });
    await passwordLogin(env, { email: 'u-target@example.invalid', password: 'Nowe-Haslo-Syntetyczne-7390', clientIp: '192.0.2.10' });
    const [login] = await events(db, 'auth.login_succeeded');
    assert.equal(login.metadata.afterAdminReset, true);
    assert.equal(login.metadata.resetIssuedBy, 'u-admin-a');
    assert.equal(login.metadata.resetId, issued.data.reset.id);

    // Po zmianie hasła przez właściciela oznaczenie znika.
    await db.query("UPDATE user_passwords SET set_reason = 'change' WHERE user_id = 'u-target'");
    await passwordLogin(env, { email: 'u-target@example.invalid', password: 'Nowe-Haslo-Syntetyczne-7390', clientIp: '192.0.2.10' });
    const logins = await events(db, 'auth.login_succeeded');
    assert.equal(logins.length, 2);
    assert.equal(logins[1].metadata.afterAdminReset, undefined);

    // Raport KR: same liczby, bez identyfikatorów kont.
    const year = { starts_on: '2000-01-01', ends_on: '2999-12-31' };
    const ops = await buildAccountOperations(db, year);
    assert.equal(ops.adminPasswordResets, 1);
    assert.equal(ops.loginsAfterAdminReset, 1);
    const html = accountOperationsSection(ops);
    assert.match(html, /Operacje administracyjne na kontach/);
    assert.doesNotMatch(html, /u-admin-a|u-target/);
    assert.equal(accountOperationsSection(undefined), '');
  } finally {
    await db.close();
  }
});
