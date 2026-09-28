import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { handlePgRequest } from '../src/pg/app.js';
import {
  base32Decode, base32Encode, decryptSecret, encryptSecret, hashRecoveryCode, hotp, loadEncryptionKey,
  MFA_POLICY, totp, totpMethod,
} from '../src/pg/mfa.js';
import { createTestDb, request, seedUserSession } from './helpers/pg.js';

const KEY = randomBytes(32).toString('base64');

// Jedna baza PGlite dla całego pliku (oszczędność pamięci); każdy test używa własnych kont.
let sharedDb;
before(async () => { sharedDb = await createTestDb(); });
after(async () => { await sharedDb?.close(); });
async function withDb(fn) {
  return fn(sharedDb, { db: sharedDb, MFA_ENCRYPTION_KEY: KEY });
}

function cookieFrom(response) {
  const header = response.headers.get('Set-Cookie');
  assert.ok(header, 'Set-Cookie expected');
  return header.split(';', 1)[0];
}

const post = (path, cookie, body, extra = {}) => request(path, { method: 'POST', cookie, body, ...extra });
const codeAt = (secretB32, offsetSteps = 0) => totp(base32Decode(secretB32), Date.now() + offsetSteps * 30_000);

// Kod na pewno spoza okna ±2 kroki.
function wrongCode(secretB32) {
  const valid = new Set([-2, -1, 0, 1, 2].map((offset) => codeAt(secretB32, offset)));
  for (let n = 0; ; n += 1) {
    const candidate = String(n).padStart(6, '0');
    if (!valid.has(candidate)) return candidate;
  }
}

async function enroll(env, cookie) {
  const response = await handlePgRequest(post('/api/mfa/enroll', cookie), env);
  assert.equal(response.status, 201);
  return response.json();
}

async function enrollAndConfirm(db, env, userId) {
  const cookie = await seedUserSession(db, { userId });
  const enrolled = await enroll(env, cookie);
  const confirm = await handlePgRequest(post('/api/mfa/confirm', cookie, { code: codeAt(enrolled.secret) }), env);
  assert.equal(confirm.status, 200);
  const data = await confirm.json();
  return { cookie: cookieFrom(confirm), secret: enrolled.secret, factorId: enrolled.factorId, recoveryCodes: data.recoveryCodes };
}

async function sessionState(env, cookie) {
  const response = await handlePgRequest(request('/api/session', { cookie }), env);
  return response.status === 200 ? response.json() : { status: response.status };
}

async function auditActions(db, action, actorId) {
  const { rows } = await db.query('SELECT * FROM audit_events WHERE action = $1 AND actor_id = $2 ORDER BY occurred_at', [action, actorId]);
  return rows;
}

test('RFC 6238 test vectors (SHA-1, SHA-256, SHA-512, 8 digits)', () => {
  const sha1 = Buffer.from('12345678901234567890');
  const sha256 = Buffer.from('12345678901234567890123456789012');
  const sha512 = Buffer.from('1234567890123456789012345678901234567890123456789012345678901234');
  const vectors = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  for (const [seconds, s1, s256, s512] of vectors) {
    assert.equal(totp(sha1, seconds * 1000, { digits: 8 }), s1, `sha1 @${seconds}`);
    assert.equal(totp(sha256, seconds * 1000, { digits: 8, algorithm: 'sha256' }), s256, `sha256 @${seconds}`);
    assert.equal(totp(sha512, seconds * 1000, { digits: 8, algorithm: 'sha512' }), s512, `sha512 @${seconds}`);
  }
  // RFC 4226, załącznik D (HOTP, 6 cyfr).
  assert.deepEqual([0, 1, 2, 9].map((c) => hotp(sha1, c)), ['755224', '287082', '359152', '520489']);
  // Proponowana metoda: 6 cyfr, ±1 krok, najnowszy trafiony krok.
  const now = 59_000;
  assert.deepEqual(totpMethod.matchStep(sha1, hotp(sha1, 1), { nowMs: now }), { step: 1 });
  assert.deepEqual(totpMethod.matchStep(sha1, hotp(sha1, 0), { nowMs: now }), { step: 0 });
  assert.deepEqual(totpMethod.matchStep(sha1, hotp(sha1, 3), { nowMs: now }), {});
  assert.deepEqual(totpMethod.matchStep(sha1, hotp(sha1, 1), { nowMs: now, lastUsedStep: 1 }), { replay: true });
  assert.deepEqual(totpMethod.matchStep(sha1, '12345', { nowMs: now }), {});
});

test('base32, encryption key parsing and AES-256-GCM binding', () => {
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.equal(base32Decode('MZXW6YTBOI').toString(), 'foobar');
  const bytes = randomBytes(20);
  assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);

  assert.equal(loadEncryptionKey({ MFA_ENCRYPTION_KEY: '' }), null);
  assert.equal(loadEncryptionKey({ MFA_ENCRYPTION_KEY: 'too-short' }), null);
  assert.equal(loadEncryptionKey({ MFA_ENCRYPTION_KEY: 'ab'.repeat(32) }).length, 32);
  const key = loadEncryptionKey({ MFA_ENCRYPTION_KEY: KEY });
  const sealed = encryptSecret(key, bytes, { factorId: 'f1', userId: 'u1' });
  assert.deepEqual(decryptSecret(key, sealed, { factorId: 'f1', userId: 'u1' }), bytes);
  assert.throws(() => decryptSecret(key, sealed, { factorId: 'f2', userId: 'u1' }));
  assert.throws(() => decryptSecret(randomBytes(32), sealed, { factorId: 'f1', userId: 'u1' }));
});

test('unauthenticated requests get 401 and cross-origin requests get 403', async () => withDb(async (db, env) => {
  const cookie = await seedUserSession(db, { userId: 'u-anon' });
  for (const path of ['/api/mfa/enroll', '/api/mfa/confirm', '/api/mfa/verify', '/api/mfa/recovery', '/api/sessions/revoke-all']) {
    const anonymous = await handlePgRequest(post(path, undefined, { code: '123456' }), env);
    assert.equal(anonymous.status, 401, path);
    const cross = await handlePgRequest(post(path, cookie, { code: '123456' }, { origin: 'https://evil.example' }), env);
    assert.equal(cross.status, 403, path);
    assert.deepEqual(await cross.json(), { error: 'invalid_origin' });
    const noOrigin = await handlePgRequest(post(path, cookie, { code: '123456' }, { origin: false }), env);
    assert.equal(noOrigin.status, 403, path);
    const get = await handlePgRequest(request(path, { cookie }), env);
    assert.equal(get.status, 405, path);
  }
  const { rows } = await db.query("SELECT count(*)::int AS n FROM user_mfa_factors WHERE user_id = 'u-anon'");
  assert.equal(rows[0].n, 0);
  assert.equal((await sessionState(env, cookie)).mfaVerified, false);
}));

test('missing encryption key disables enrollment', async () => withDb(async (db) => {
  const cookie = await seedUserSession(db, { userId: 'u-nokey' });
  const response = await handlePgRequest(post('/api/mfa/enroll', cookie), { db, MFA_ENCRYPTION_KEY: '' });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'mfa_unavailable' });
}));

test('enrollment stores the secret encrypted only and confirmation rotates the session', async () => withDb(async (db, env) => {
  const cookie = await seedUserSession(db, { userId: 'u-enroll' });
  const enrolled = await enroll(env, cookie);
  assert.match(enrolled.secret, /^[A-Z2-7]{32}$/);
  assert.equal(enrolled.digits, 6);
  assert.equal(enrolled.period, 30);
  assert.ok(enrolled.otpauthUri.startsWith('otpauth://totp/RD:'));
  assert.ok(enrolled.otpauthUri.includes(`secret=${enrolled.secret}`));

  const secretBytes = base32Decode(enrolled.secret);
  const { rows: [row] } = await db.query('SELECT * FROM user_mfa_factors WHERE id = $1', [enrolled.factorId]);
  const stored = JSON.stringify(row);
  for (const form of [enrolled.secret, enrolled.secret.toLowerCase(), secretBytes.toString('hex'), secretBytes.toString('base64'), secretBytes.toString('base64url')]) {
    assert.ok(!stored.includes(form), 'secret must not be stored in plaintext');
  }
  assert.equal(row.confirmed_at, null);

  // Wymagane potwierdzenie kodem; do tego czasu sesja bez MFA.
  const verifyBefore = await handlePgRequest(post('/api/mfa/verify', cookie, { code: codeAt(enrolled.secret) }), env);
  assert.equal(verifyBefore.status, 409);

  const confirm = await handlePgRequest(post('/api/mfa/confirm', cookie, { code: codeAt(enrolled.secret) }), env);
  assert.equal(confirm.status, 200);
  const data = await confirm.json();
  assert.equal(data.mfaVerified, true);
  assert.equal(data.recoveryCodes.length, MFA_POLICY.recoveryCodeCount);
  assert.equal(new Set(data.recoveryCodes).size, data.recoveryCodes.length);
  const setCookie = confirm.headers.get('Set-Cookie');
  assert.match(setCookie, /HttpOnly; Secure; SameSite=Lax/);
  const newCookie = cookieFrom(confirm);
  assert.notEqual(newCookie, cookie);
  assert.equal((await sessionState(env, cookie)).status, 401, 'old session revoked (fixation)');
  assert.equal((await sessionState(env, newCookie)).mfaVerified, true);

  const { rows: codes } = await db.query('SELECT code_hash FROM mfa_recovery_codes WHERE factor_id = $1', [enrolled.factorId]);
  assert.equal(codes.length, MFA_POLICY.recoveryCodeCount);
  const storedCodes = JSON.stringify(codes);
  for (const code of data.recoveryCodes) {
    assert.ok(!storedCodes.includes(code) && !storedCodes.includes(code.replaceAll('-', '')));
    assert.ok(codes.some((c) => c.code_hash === hashRecoveryCode(code)));
  }

  // Audyt bez sekretu, kodów i danych osobowych.
  const { rows: audit } = await db.query("SELECT action, metadata_json::text AS meta FROM audit_events WHERE action LIKE 'mfa.%' AND actor_id = 'u-enroll'");
  assert.deepEqual(audit.map((a) => a.action).sort(), ['mfa.enrolled', 'mfa.enrollment_started', 'mfa.verified']);
  const auditText = JSON.stringify(audit);
  assert.ok(!auditText.includes(enrolled.secret));
  assert.ok(!auditText.includes('@'));
  for (const code of data.recoveryCodes) assert.ok(!auditText.includes(code));

  // Wymiana czynnika wymaga sesji z MFA.
  const plain = await seedUserSession(db, { userId: 'u-enroll' });
  const replace = await handlePgRequest(post('/api/mfa/enroll', plain), env);
  assert.equal(replace.status, 403);
  assert.deepEqual(await replace.json(), { error: 'mfa_required' });
  const allowed = await handlePgRequest(post('/api/mfa/enroll', newCookie), env);
  assert.equal(allowed.status, 201);

  // #150 (krok w górę): wymiana czynnika na sesji z MFA potwierdzonym dawno
  // (przejęta sesja) — 403 mfa_stale, bez nowego czynnika; świeży kod odblokowuje.
  await db.query("UPDATE sessions SET mfa_verified_at = now() - interval '20 minutes' WHERE user_id = 'u-enroll' AND revoked_at IS NULL");
  const pendingBefore = (await db.query("SELECT count(*)::int AS n FROM user_mfa_factors WHERE user_id = 'u-enroll'")).rows[0].n;
  const stale = await handlePgRequest(post('/api/mfa/enroll', newCookie), env);
  assert.equal(stale.status, 403);
  assert.deepEqual(await stale.json(), { error: 'mfa_stale' });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM user_mfa_factors WHERE user_id = 'u-enroll'")).rows[0].n, pendingBefore);
  await db.query("UPDATE sessions SET mfa_verified_at = now() WHERE user_id = 'u-enroll' AND revoked_at IS NULL");
  assert.equal((await handlePgRequest(post('/api/mfa/enroll', newCookie), env)).status, 201);
}));

test('verify sets MFA only on the calling session and refuses a replayed step', async () => withDb(async (db, env) => {
  const { secret } = await enrollAndConfirm(db, env, 'u-verify');
  const sessionA = await seedUserSession(db, { userId: 'u-verify' });
  const sessionB = await seedUserSession(db, { userId: 'u-verify' });
  const other = await seedUserSession(db, { userId: 'u-other' });

  // Kod bieżącego kroku został zużyty przy potwierdzeniu — ponowne użycie odrzucone.
  const replay = await handlePgRequest(post('/api/mfa/verify', sessionA, { code: codeAt(secret) }), env);
  assert.equal(replay.status, 400);
  assert.deepEqual(await replay.json(), { error: 'invalid_code' });
  const [failed] = await auditActions(db, 'mfa.failed', 'u-verify');
  assert.equal(failed.metadata_json.reason, 'replay');

  const next = codeAt(secret, 1);
  const ok = await handlePgRequest(post('/api/mfa/verify', sessionA, { code: next }), env);
  assert.equal(ok.status, 200);
  const rotated = cookieFrom(ok);
  assert.equal((await sessionState(env, rotated)).mfaVerified, true);
  assert.equal((await sessionState(env, sessionA)).status, 401);
  assert.equal((await sessionState(env, sessionB)).mfaVerified, false, 'other session of the same user unchanged');
  assert.equal((await sessionState(env, other)).mfaVerified, false);

  // Ten sam kod w innej sesji tego konta — krok już użyty.
  const again = await handlePgRequest(post('/api/mfa/verify', sessionB, { code: next }), env);
  assert.equal(again.status, 400);
  assert.equal((await sessionState(env, sessionB)).mfaVerified, false);

  // Konto bez czynnika nie może potwierdzić MFA.
  const noFactor = await handlePgRequest(post('/api/mfa/verify', other, { code: next }), env);
  assert.equal(noFactor.status, 409);

  // Podwójne kliknięcie starą sesją po rotacji → 401.
  const doubleClick = await handlePgRequest(post('/api/mfa/verify', sessionA, { code: next }), env);
  assert.equal(doubleClick.status, 401);
}));

test('wrong codes are counted per user and session and lock after the limit', async () => withDb(async (db, env) => {
  const { secret, factorId } = await enrollAndConfirm(db, env, 'u-lock');
  const session = await seedUserSession(db, { userId: 'u-lock' });
  const bad = wrongCode(secret);

  const first = await handlePgRequest(post('/api/mfa/verify', session, { code: bad }), env);
  assert.equal(first.status, 400);
  const { rows: counters } = await db.query("SELECT scope_type, failure_count FROM mfa_rate_limits WHERE (scope_type = 'user' AND scope_id = 'u-lock') OR scope_id IN (SELECT id FROM sessions WHERE user_id = 'u-lock') ORDER BY scope_type");
  assert.deepEqual(counters.map((r) => [r.scope_type, r.failure_count]), [['session', 1], ['user', 1]]);
  const malformed = await handlePgRequest(post('/api/mfa/verify', session, { code: 'abc' }), env);
  assert.equal(malformed.status, 400);

  for (let i = 3; i < MFA_POLICY.maxFailures; i += 1) {
    assert.equal((await handlePgRequest(post('/api/mfa/verify', session, { code: bad }), env)).status, 400);
  }
  const locking = await handlePgRequest(post('/api/mfa/verify', session, { code: bad }), env);
  assert.equal(locking.status, 429);
  assert.equal(locking.headers.get('Retry-After'), String(MFA_POLICY.lockSeconds));
  assert.equal((await auditActions(db, 'mfa.failed', 'u-lock')).length, MFA_POLICY.maxFailures);
  // #189: blokada po 5 błędach dotyczy sesji; konto ma wyższy sufit (userMaxFailures).
  const locks = await auditActions(db, 'mfa.locked', 'u-lock');
  assert.deepEqual(locks.map((l) => l.entity_type).sort(), ['session']);

  // Poprawny kod w czasie blokady nie jest sprawdzany ani zużywany.
  const good = codeAt(secret, 1);
  const blocked = await handlePgRequest(post('/api/mfa/verify', session, { code: good }), env);
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('Retry-After')) > 0);
  assert.equal((await handlePgRequest(post('/api/mfa/recovery', session, { code: 'AAAA-AAAA-AAAA-AAAA' }), env)).status, 429);
  const { rows: [factor] } = await db.query('SELECT last_used_step FROM user_mfa_factors WHERE id = $1', [factorId]);
  const stepBefore = Number(factor.last_used_step);
  assert.equal((await auditActions(db, 'mfa.failed', 'u-lock')).length, MFA_POLICY.maxFailures, 'locked attempts are not evaluated');

  // Po upływie blokady poprawny kod działa i zeruje liczniki.
  await db.query("UPDATE mfa_rate_limits SET locked_until = now() - interval '1 second'");
  const unlocked = await handlePgRequest(post('/api/mfa/verify', session, { code: good }), env);
  assert.equal(unlocked.status, 200);
  const { rows: [after] } = await db.query('SELECT last_used_step FROM user_mfa_factors WHERE id = $1', [factorId]);
  assert.ok(Number(after.last_used_step) > stepBefore);
  const { rows: remaining } = await db.query("SELECT * FROM mfa_rate_limits WHERE scope_type = 'user' AND scope_id = 'u-lock'");
  assert.equal(remaining.length, 0);
}));

test('user-scope counter locks across many sessions at the higher account ceiling (#189)', async () => withDb(async (db, env) => {
  const { secret } = await enrollAndConfirm(db, env, 'u-spread');
  const bad = wrongCode(secret);
  for (let i = 1; i < MFA_POLICY.userMaxFailures; i += 1) {
    const session = await seedUserSession(db, { userId: 'u-spread' });
    assert.equal((await handlePgRequest(post('/api/mfa/verify', session, { code: bad }), env)).status, 400);
  }
  const last = await seedUserSession(db, { userId: 'u-spread' });
  assert.equal((await handlePgRequest(post('/api/mfa/verify', last, { code: bad }), env)).status, 429);
  const fresh = await seedUserSession(db, { userId: 'u-spread' });
  assert.equal((await handlePgRequest(post('/api/mfa/verify', fresh, { code: codeAt(secret, 1) }), env)).status, 429, 'sufit konta obejmuje każdą sesję');
}));

test('#189: 5 wrong codes in session A do not block a correct code in new session B', async () => withDb(async (db, env) => {
  const { secret } = await enrollAndConfirm(db, env, 'u-split');
  const bad = wrongCode(secret);
  const a = await seedUserSession(db, { userId: 'u-split' });
  for (let i = 0; i < MFA_POLICY.maxFailures; i += 1) await handlePgRequest(post('/api/mfa/verify', a, { code: bad }), env);
  assert.equal((await handlePgRequest(post('/api/mfa/verify', a, { code: codeAt(secret, 1) }), env)).status, 429);
  const b = await seedUserSession(db, { userId: 'u-split' });
  assert.equal((await handlePgRequest(post('/api/mfa/verify', b, { code: codeAt(secret, 1) }), env)).status, 200);
}));

test('recovery codes are single use and verify only the calling session', async () => withDb(async (db, env) => {
  const { recoveryCodes } = await enrollAndConfirm(db, env, 'u-rec');
  const sessionA = await seedUserSession(db, { userId: 'u-rec' });
  const sessionB = await seedUserSession(db, { userId: 'u-rec' });
  const code = recoveryCodes[0];

  const used = await handlePgRequest(post('/api/mfa/recovery', sessionA, { code: code.toLowerCase().replaceAll('-', ' ') }), env);
  assert.equal(used.status, 200);
  assert.equal((await sessionState(env, cookieFrom(used))).mfaVerified, true);
  assert.equal((await sessionState(env, sessionB)).mfaVerified, false);

  const reused = await handlePgRequest(post('/api/mfa/recovery', sessionB, { code }), env);
  assert.equal(reused.status, 400);
  const { rows } = await db.query("SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE used_at IS NOT NULL AND user_id = 'u-rec'");
  assert.equal(rows[0].n, 1);
  const [event] = await auditActions(db, 'mfa.recovery_used', 'u-rec');
  assert.equal(event.metadata_json.remaining, MFA_POLICY.recoveryCodeCount - 1);
  assert.ok(!JSON.stringify(event).includes(code));

  // Kod innego konta nie działa.
  const { recoveryCodes: foreign } = await enrollAndConfirm(db, env, 'u-rec-2');
  assert.equal((await handlePgRequest(post('/api/mfa/recovery', sessionB, { code: foreign[0] }), env)).status, 400);
  assert.equal((await handlePgRequest(post('/api/mfa/recovery', sessionB, { code: recoveryCodes[1] }), env)).status, 200);
}));

test('factor rows and recovery codes cannot be deleted or rewritten', async () => withDb(async (db, env) => {
  const { factorId } = await enrollAndConfirm(db, env, 'u-guard');
  await assert.rejects(db.query('DELETE FROM user_mfa_factors WHERE id = $1', [factorId]), /mfa_factor_immutable/);
  await assert.rejects(db.query("UPDATE user_mfa_factors SET secret_ciphertext = 'AAAA' WHERE id = $1", [factorId]), /mfa_factor_immutable/);
  await assert.rejects(db.query('UPDATE user_mfa_factors SET last_used_step = last_used_step - 1 WHERE id = $1', [factorId]), /mfa_factor_immutable/);
  await db.query("UPDATE mfa_recovery_codes SET used_at = now() WHERE id = (SELECT id FROM mfa_recovery_codes WHERE user_id = 'u-guard' LIMIT 1)");
  await assert.rejects(db.query("UPDATE mfa_recovery_codes SET used_at = NULL WHERE used_at IS NOT NULL AND user_id = 'u-guard'"), /mfa_recovery_code_immutable/);
  await assert.rejects(db.query('DELETE FROM mfa_recovery_codes'), /mfa_recovery_code_immutable/);
}));

test('revoke-all revokes only the caller\'s sessions, with audit', async () => withDb(async (db, env) => {
  const a1 = await seedUserSession(db, { userId: 'u-ra' });
  const a2 = await seedUserSession(db, { userId: 'u-ra', mfa: true });
  const a3 = await seedUserSession(db, { userId: 'u-ra' });
  const b1 = await seedUserSession(db, { userId: 'u-rb' });

  const response = await handlePgRequest(post('/api/sessions/revoke-all', a1), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revoked: 3, scope: 'all' });
  assert.match(response.headers.get('Set-Cookie'), /Max-Age=0/);
  for (const cookie of [a1, a2, a3]) assert.equal((await sessionState(env, cookie)).status, 401);
  assert.equal((await sessionState(env, b1)).mfaVerified, false);
  const { rows } = await db.query("SELECT revoked_reason FROM sessions WHERE user_id = 'u-ra'");
  assert.ok(rows.every((r) => r.revoked_reason === 'user_revoke_all'));
  const events = await auditActions(db, 'session.revoked', 'u-ra');
  assert.equal(events.length, 3);
  assert.ok(events.every((e) => e.metadata_json.reason === 'user_revoke_all'));

  // Ponowienie starą sesją: 401, bez nowych zdarzeń.
  assert.equal((await handlePgRequest(post('/api/sessions/revoke-all', a1), env)).status, 401);
  assert.equal((await auditActions(db, 'session.revoked', 'u-ra')).length, 3);
}));
