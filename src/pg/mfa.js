// MFA na PostgreSQL (issue #3). Prototyp — nie jest wdrożony.
//
// Metoda MFA to otwarta decyzja D-10. TOTP (RFC 6238: HMAC-SHA-1, 6 cyfr,
// krok 30 s, tolerancja ±1 krok) jest tu PROPONOWANĄ metodą domyślną za
// interfejsem MFA_METHODS; inną metodę dodaje się jako kolejny wpis
// o tym samym kształcie (generateSecret, provisioningUri, matchStep).
//
// Zasady:
// - sekret czynnika trafia do bazy wyłącznie jako szyfrogram AES-256-GCM
//   (klucz MFA_ENCRYPTION_KEY spoza bazy, AAD wiąże szyfrogram z czynnikiem
//   i kontem), nigdy jako tekst jawny,
// - kody porównywane w czasie stałym (timingSafeEqual) dla każdego kroku okna,
// - ten sam krok TOTP nie może być użyty ponownie (last_used_step),
// - limity: MFA_POLICY.maxFailures błędów w oknie → blokada; osobno dla
//   konta i dla sesji; licznik i blokada zapisywane w tej samej transakcji,
// - kody odzyskiwania: 80 bitów losowości, w bazie tylko SHA-256, jednorazowe,
// - audyt bez sekretów, kodów i danych osobowych (tylko identyfikatory).
// Wszystkie funkcje przyjmują env.db o kontrakcie z src/db.js (lub PGlite).

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { insertAuditEvent } from './audit.js';
import { rotateSession } from './auth.js';

// Założenia do potwierdzenia (D-10): 5 błędów w 15 min → blokada 15 min, 10 kodów odzyskiwania.
export const MFA_POLICY = Object.freeze({ maxFailures: 5, windowSeconds: 15 * 60, lockSeconds: 15 * 60, recoveryCodeCount: 10 });
export const MFA_ISSUER = 'RD';
const KEY_VERSION = 1;

// --- Base32 (RFC 4648, bez dopełnienia) -----------------------------------

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes) {
  let bits = 0; let value = 0; let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { output += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/=+$/, '');
  let bits = 0; let value = 0; const output = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('invalid_base32');
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { output.push((value >>> (bits - 8)) & 255); bits -= 8; }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(output);
}

// --- HOTP / TOTP (RFC 4226 / RFC 6238) --------------------------------------

export function hotp(key, counter, { digits = 6, algorithm = 'sha1' } = {}) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(algorithm, key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpStep(timeMs, period = 30) {
  return Math.floor(timeMs / 1000 / period);
}

export function totp(key, timeMs, { period = 30, digits = 6, algorithm = 'sha1' } = {}) {
  return hotp(key, totpStep(timeMs, period), { digits, algorithm });
}

function constantTimeEqualText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export const totpMethod = Object.freeze({
  id: 'totp',
  period: 30,
  digits: 6,
  window: 1,
  algorithm: 'sha1',
  generateSecret() { return randomBytes(20); },
  provisioningUri({ secret, account, issuer = MFA_ISSUER }) {
    const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
    const params = new URLSearchParams({ secret: base32Encode(secret), issuer, algorithm: 'SHA1', digits: '6', period: '30' });
    return `otpauth://totp/${label}?${params}`;
  },
  // Zwraca { step } dla trafionego kroku nowszego niż lastUsedStep,
  // { replay: true } dla kodu już użytego kroku, albo {}.
  // Porównuje wszystkie kroki okna bez wczesnego wyjścia.
  matchStep(secret, code, { nowMs = Date.now(), lastUsedStep = null } = {}) {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return {};
    const current = totpStep(nowMs, this.period);
    let matched = null;
    for (let delta = -this.window; delta <= this.window; delta += 1) {
      const step = current + delta;
      const candidate = hotp(secret, step, { digits: this.digits, algorithm: this.algorithm });
      if (constantTimeEqualText(candidate, code) && (matched === null || step > matched)) matched = step;
    }
    if (matched === null) return {};
    if (lastUsedStep !== null && matched <= Number(lastUsedStep)) return { replay: true };
    return { step: matched };
  },
});

export const MFA_METHODS = Object.freeze({ totp: totpMethod });
export const DEFAULT_MFA_METHOD = 'totp';

// --- Szyfrowanie sekretu (AES-256-GCM) --------------------------------------

// Klucz: 32 bajty jako 64 znaki hex albo base64/base64url. Brak lub zły format → null.
export function loadEncryptionKey(env) {
  const raw = env && Object.hasOwn(env, 'MFA_ENCRYPTION_KEY') ? env.MFA_ENCRYPTION_KEY : process.env.MFA_ENCRYPTION_KEY;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const text = raw.trim();
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(text)) key = Buffer.from(text, 'hex');
  else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(text)) key = Buffer.from(text, 'base64');
  else return null;
  return key.length === 32 ? key : null;
}

const toB64u = (buffer) => Buffer.from(buffer).toString('base64url');
const aadFor = (factorId, userId) => Buffer.from(`rd-mfa:v${KEY_VERSION}:${factorId}:${userId}`);

export function encryptSecret(key, secret, { factorId, userId }) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aadFor(factorId, userId));
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return { ciphertext: toB64u(ciphertext), iv: toB64u(iv), tag: toB64u(cipher.getAuthTag()) };
}

export function decryptSecret(key, { ciphertext, iv, tag }, { factorId, userId }) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(aadFor(factorId, userId));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]);
}

// --- Kody odzyskiwania -------------------------------------------------------

export function normalizeRecoveryCode(code) {
  return String(code ?? '').toUpperCase().replace(/[\s-]/g, '');
}

export function hashRecoveryCode(code) {
  return createHash('sha256').update(`rd-mfa-recovery:${normalizeRecoveryCode(code)}`).digest('hex');
}

export function generateRecoveryCodes(count = MFA_POLICY.recoveryCodeCount) {
  return Array.from({ length: count }, () => base32Encode(randomBytes(10)).match(/.{4}/g).join('-'));
}

// --- Dostęp do bazy ----------------------------------------------------------

function database(env) {
  if (!env?.db || typeof env.db.query !== 'function') throw new Error('database_unavailable');
  return env.db;
}

export class MfaError extends Error {
  constructor(code, status, extra = {}) { super(code); this.code = code; this.status = status; this.extra = extra; }
}

// Wykonawca transakcji udający env.db, by rotateSession działało w tej samej transakcji.
const inTransaction = (tx) => ({ db: { query: (...args) => tx.query(...args), transaction: (fn) => fn(tx) } });

async function lockUser(tx, userId) {
  const { rows } = await tx.query('SELECT id FROM users WHERE id = $1 AND disabled_at IS NULL FOR UPDATE', [userId]);
  if (!rows[0]) throw new MfaError('unauthenticated', 401);
}

async function activeFactors(tx, userId) {
  const { rows } = await tx.query(
    `SELECT id, method, secret_ciphertext, secret_iv, secret_tag, confirmed_at, last_used_step
       FROM user_mfa_factors
      WHERE user_id = $1 AND disabled_at IS NULL
      FOR UPDATE`,
    [userId],
  );
  return {
    confirmed: rows.find((row) => row.confirmed_at) ?? null,
    pending: rows.find((row) => !row.confirmed_at) ?? null,
  };
}

function scopesFor(session) {
  return [['user', session.user.id], ['session', session.sessionId]];
}

async function activeLock(tx, session) {
  const { rows } = await tx.query(
    `SELECT CEIL(EXTRACT(EPOCH FROM (max(locked_until) - now())))::int AS retry_after
       FROM mfa_rate_limits
      WHERE ((scope_type = 'user' AND scope_id = $1) OR (scope_type = 'session' AND scope_id = $2))
        AND locked_until > now()`,
    [session.user.id, session.sessionId],
  );
  const retry = rows[0]?.retry_after;
  return retry ? Math.max(1, Number(retry)) : null;
}

// Zapisuje błąd dla konta i sesji. Zwraca true, jeśli ten błąd założył blokadę.
async function recordFailure(tx, session, metadata) {
  const actorId = session.user.id;
  await insertAuditEvent(tx, { actorId, action: 'mfa.failed', entityType: 'session', entityId: session.sessionId, metadata });
  let locked = false;
  for (const [scopeType, scopeId] of scopesFor(session)) {
    const { rows } = await tx.query(
      `INSERT INTO mfa_rate_limits (scope_type, scope_id, failure_count, window_started_at, updated_at)
       VALUES ($1, $2, 1, now(), now())
       ON CONFLICT (scope_type, scope_id) DO UPDATE SET
         failure_count = CASE WHEN mfa_rate_limits.locked_until IS NOT NULL
                                OR mfa_rate_limits.window_started_at <= now() - make_interval(secs => $3)
                              THEN 1 ELSE mfa_rate_limits.failure_count + 1 END,
         window_started_at = CASE WHEN mfa_rate_limits.locked_until IS NOT NULL
                                    OR mfa_rate_limits.window_started_at <= now() - make_interval(secs => $3)
                                  THEN now() ELSE mfa_rate_limits.window_started_at END,
         locked_until = NULL,
         updated_at = now()
       RETURNING failure_count`,
      [scopeType, scopeId, MFA_POLICY.windowSeconds],
    );
    if (rows[0].failure_count >= MFA_POLICY.maxFailures) {
      await tx.query(
        `UPDATE mfa_rate_limits SET locked_until = now() + make_interval(secs => $3), updated_at = now()
          WHERE scope_type = $1 AND scope_id = $2`,
        [scopeType, scopeId, MFA_POLICY.lockSeconds],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'mfa.locked', entityType: scopeType, entityId: scopeId,
        metadata: { scope: scopeType, failures: rows[0].failure_count, lockSeconds: MFA_POLICY.lockSeconds },
      });
      locked = true;
    }
  }
  return locked;
}

async function clearFailures(tx, session) {
  await tx.query(
    `DELETE FROM mfa_rate_limits
      WHERE (scope_type = 'user' AND scope_id = $1) OR (scope_type = 'session' AND scope_id = $2)`,
    [session.user.id, session.sessionId],
  );
}

// Oznacza bieżącą sesję jako potwierdzoną MFA i od razu ją rotuje (ochrona przed
// utrwaleniem sesji). Nowy sekret trafia tylko do cookie.
async function markVerifiedAndRotate(tx, session) {
  const { rows } = await tx.query(
    `UPDATE sessions SET mfa_verified_at = now()
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()
      RETURNING id`,
    [session.sessionId, session.user.id],
  );
  if (!rows[0]) throw new MfaError('unauthenticated', 401);
  return rotateSession(inTransaction(tx), session, { mfaVerified: true });
}

// --- Operacje ---------------------------------------------------------------

// Rozpoczyna zapis czynnika. Gdy konto ma już potwierdzony czynnik, wymiana
// wymaga sesji z potwierdzonym MFA — inaczej skradziona sesja obeszłaby MFA.
export async function enrollFactor(env, session, { method = DEFAULT_MFA_METHOD } = {}) {
  const implementation = MFA_METHODS[method];
  if (!implementation) throw new MfaError('invalid_method', 400);
  const key = loadEncryptionKey(env);
  if (!key) throw new MfaError('mfa_unavailable', 503);
  return database(env).transaction(async (tx) => {
    await lockUser(tx, session.user.id);
    const factors = await activeFactors(tx, session.user.id);
    if (factors.confirmed && !session.mfaVerified) throw new MfaError('mfa_required', 403);
    if (factors.pending) {
      await tx.query('UPDATE user_mfa_factors SET disabled_at = now() WHERE id = $1', [factors.pending.id]);
    }
    const factorId = crypto.randomUUID();
    const secret = implementation.generateSecret();
    const sealed = encryptSecret(key, secret, { factorId, userId: session.user.id });
    await tx.query(
      `INSERT INTO user_mfa_factors (id, user_id, method, secret_ciphertext, secret_iv, secret_tag, key_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [factorId, session.user.id, implementation.id, sealed.ciphertext, sealed.iv, sealed.tag, KEY_VERSION],
    );
    await insertAuditEvent(tx, {
      actorId: session.user.id, action: 'mfa.enrollment_started', entityType: 'mfa_factor', entityId: factorId,
      metadata: { method: implementation.id, replacedPendingId: factors.pending?.id ?? null },
    });
    return {
      factorId,
      method: implementation.id,
      secret: base32Encode(secret),
      otpauthUri: implementation.provisioningUri({ secret, account: session.user.email ?? session.user.id }),
      digits: implementation.digits,
      period: implementation.period,
    };
  });
}

// kind: 'confirm' (czynnik oczekujący), 'verify' (potwierdzony, kod TOTP),
// 'recovery' (potwierdzony, kod odzyskiwania). Błąd liczy się do limitu
// i jest zatwierdzany razem z licznikiem; sukces rotuje sesję.
export async function attemptFactor(env, session, { kind, code, nowMs = Date.now() }) {
  const key = kind === 'recovery' ? null : loadEncryptionKey(env);
  if (kind !== 'recovery' && !key) throw new MfaError('mfa_unavailable', 503);
  const outcome = await database(env).transaction(async (tx) => {
    await lockUser(tx, session.user.id);
    const factors = await activeFactors(tx, session.user.id);
    const factor = kind === 'confirm' ? factors.pending : factors.confirmed;
    if (!factor) return { error: kind === 'confirm' ? 'mfa_enrollment_not_found' : 'mfa_not_enrolled', status: 409 };
    if (kind === 'confirm' && factors.confirmed && !session.mfaVerified) return { error: 'mfa_required', status: 403 };

    const retryAfter = await activeLock(tx, session);
    if (retryAfter) return { error: 'mfa_locked', status: 429, retryAfter };

    const implementation = MFA_METHODS[factor.method];
    let step = null;
    let recoveryCodeId = null;
    let failureReason = null;
    if (kind === 'recovery') {
      const hash = Buffer.from(hashRecoveryCode(code), 'hex');
      const { rows } = await tx.query(
        `SELECT id, code_hash FROM mfa_recovery_codes
          WHERE user_id = $1 AND factor_id = $2 AND used_at IS NULL AND invalidated_at IS NULL`,
        [session.user.id, factor.id],
      );
      for (const row of rows) {
        if (timingSafeEqual(Buffer.from(row.code_hash, 'hex'), hash)) recoveryCodeId = row.id;
      }
      if (typeof code !== 'string' || !recoveryCodeId) failureReason = 'invalid_code';
    } else {
      const secret = decryptSecret(key, { ciphertext: factor.secret_ciphertext, iv: factor.secret_iv, tag: factor.secret_tag }, { factorId: factor.id, userId: session.user.id });
      const lastUsedStep = factor.last_used_step === null || factor.last_used_step === undefined ? null : Number(factor.last_used_step);
      const match = implementation.matchStep(secret, code, { nowMs, lastUsedStep });
      secret.fill(0);
      if (match.replay) failureReason = 'replay';
      else if (match.step === undefined) failureReason = 'invalid_code';
      else step = match.step;
    }

    if (failureReason) {
      const locked = await recordFailure(tx, session, { kind, method: kind === 'recovery' ? 'recovery_code' : factor.method, reason: failureReason });
      return locked
        ? { error: 'mfa_locked', status: 429, retryAfter: MFA_POLICY.lockSeconds }
        : { error: 'invalid_code', status: 400 };
    }

    await clearFailures(tx, session);
    const actorId = session.user.id;
    let recoveryCodes;
    if (kind === 'recovery') {
      const { rows } = await tx.query(
        `UPDATE mfa_recovery_codes SET used_at = now(), used_session_id = $2
          WHERE id = $1 AND used_at IS NULL AND invalidated_at IS NULL RETURNING id`,
        [recoveryCodeId, session.sessionId],
      );
      if (!rows[0]) throw new Error('recovery_code_race');
      const remaining = (await tx.query(
        `SELECT count(*)::int AS n FROM mfa_recovery_codes
          WHERE user_id = $1 AND factor_id = $2 AND used_at IS NULL AND invalidated_at IS NULL`,
        [actorId, factor.id],
      )).rows[0].n;
      await insertAuditEvent(tx, { actorId, action: 'mfa.recovery_used', entityType: 'mfa_recovery_code', entityId: recoveryCodeId, metadata: { factorId: factor.id, remaining } });
    } else {
      await tx.query('UPDATE user_mfa_factors SET last_used_step = $2 WHERE id = $1', [factor.id, step]);
    }

    if (kind === 'confirm') {
      if (factors.confirmed) {
        await tx.query('UPDATE user_mfa_factors SET disabled_at = now() WHERE id = $1', [factors.confirmed.id]);
        await tx.query(
          'UPDATE mfa_recovery_codes SET invalidated_at = now() WHERE factor_id = $1 AND used_at IS NULL AND invalidated_at IS NULL',
          [factors.confirmed.id],
        );
      }
      await tx.query('UPDATE user_mfa_factors SET confirmed_at = now() WHERE id = $1', [factor.id]);
      recoveryCodes = generateRecoveryCodes();
      for (const recoveryCode of recoveryCodes) {
        await tx.query(
          'INSERT INTO mfa_recovery_codes (id, user_id, factor_id, code_hash) VALUES ($1, $2, $3, $4)',
          [crypto.randomUUID(), actorId, factor.id, hashRecoveryCode(recoveryCode)],
        );
      }
      await insertAuditEvent(tx, {
        actorId, action: 'mfa.enrolled', entityType: 'mfa_factor', entityId: factor.id,
        metadata: { method: factor.method, replacedFactorId: factors.confirmed?.id ?? null, recoveryCodes: recoveryCodes.length },
      });
    }

    await insertAuditEvent(tx, {
      actorId, action: 'mfa.verified', entityType: 'session', entityId: session.sessionId,
      metadata: { kind, method: kind === 'recovery' ? 'recovery_code' : factor.method, factorId: factor.id },
    });
    const rotated = await markVerifiedAndRotate(tx, session);
    return { ok: true, rotated, recoveryCodes };
  });
  return outcome;
}

// Wycofuje wszystkie aktywne sesje konta (także bieżącą) z wpisem audytu dla każdej.
export async function revokeAllOwnSessions(env, session) {
  return database(env).transaction(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = 'user_revoke_all'
        WHERE user_id = $1 AND revoked_at IS NULL
        RETURNING id`,
      [session.user.id],
    );
    for (const row of rows) {
      await insertAuditEvent(tx, {
        actorId: session.user.id, action: 'session.revoked', entityType: 'session', entityId: row.id,
        metadata: { reason: 'user_revoke_all', initiatedBySession: session.sessionId },
      });
    }
    return rows.length;
  });
}
