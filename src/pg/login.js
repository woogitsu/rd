// Logowanie e-mailem i hasłem, przyjęcie zaproszenia, zmiana i reset hasła
// (issue #3). Prototyp — nie jest wdrożony i nie jest gotowy do pracy na danych rodzin.
//
// Metoda: wskazanie użytkownika 2026-09-27 (D-10) — e-mail + hasło, potem
// TOTP z aplikacji uwierzytelniającej (src/pg/mfa.js). Do formalnego
// potwierdzenia przez zarząd/IOD. Parametry niżej to założenia.
//
// Zasady:
// - hasło: src/pg/password.js (scrypt, polityka NIST); nigdy w logach i audycie,
// - nieznany e-mail, złe hasło i konto wyłączone dają ten sam błąd
//   `invalid_credentials` i ten sam koszt (fikcyjny hash),
// - limity: 5 błędów / 15 min na skrót e-maila, 20 / 15 min na skrót IP
//   → blokada 15 min (429 + Retry-After); w bazie tylko SHA-256, nigdy e-mail ani IP,
// - sesja po haśle ma mfa_verified_at = NULL; MFA potwierdza /api/mfa/verify,
// - reset hasła wyłącznie tokenem wydanym przez administratora (brak resetu
//   e-mailem: szablon i nadawca to decyzje D-16/D-17),
// - audyt: identyfikatory i kody powodów, bez e-maili, haseł i tokenów.

import { createHash } from 'node:crypto';
import { createSessionSecret, hashSecret } from '../auth.js';
import { insertAuditEvent } from './audit.js';
import {
  createSession, grantInvitation, INVITATION_TOKEN_PATTERN, isoTimestamp, lockInvitation, revokeUserSessionsWith, rotateSession,
} from './auth.js';
import { mfaStatus } from './mfa-policy.js';
import { checkPasswordPolicy, hashPassword, needsRehash, verifyPasswordOrDummy } from './password.js';

// Założenia do potwierdzenia (D-10).
export const LOGIN_POLICY = Object.freeze({
  emailMaxFailures: 5,
  ipMaxFailures: 20,
  windowSeconds: 15 * 60,
  lockSeconds: 15 * 60,
  retentionSeconds: 24 * 60 * 60,
});
export const PASSWORD_RESET_DEFAULT_TTL_SECONDS = 2 * 60 * 60;
export const PASSWORD_RESET_MAX_TTL_SECONDS = 24 * 60 * 60;
const TOKEN_PATTERN = INVITATION_TOKEN_PATTERN;

export class LoginError extends Error {
  constructor(code, status, extra = {}) { super(code); this.code = code; this.status = status; this.extra = extra; }
}

function database(env) {
  if (!env?.db || typeof env.db.query !== 'function') throw new Error('database_unavailable');
  return env.db;
}

// Wykonawca transakcji udający env.db (rotateSession w tej samej transakcji).
const inTransaction = (tx) => ({ db: { query: (...args) => tx.query(...args), transaction: (fn) => fn(tx) } });

// --- Skróty zakresów limitów -------------------------------------------------

export function normalizeLoginEmail(email) {
  return String(email ?? '').normalize('NFKC').trim().toLowerCase().slice(0, 320);
}

export function normalizeIp(ip) {
  const value = String(ip ?? '').trim().toLowerCase();
  if (!value) return 'unknown';
  return value.startsWith('::ffff:') ? value.slice(7) : value;
}

// SHA-256 z separacją dziedziny. To pseudonimizacja (adres da się sprawdzić
// słownikowo), dlatego wiersze są usuwane po dobie.
export function scopeHash(type, value) {
  return createHash('sha256').update(`rd-login:${type}:${value}`).digest('hex');
}

function loginScopes({ email, ip }) {
  const scopes = [];
  if (email !== undefined && email !== null) scopes.push({ type: 'email', hash: scopeHash('email', normalizeLoginEmail(email)), max: LOGIN_POLICY.emailMaxFailures });
  if (ip !== undefined) scopes.push({ type: 'ip', hash: scopeHash('ip', normalizeIp(ip)), max: LOGIN_POLICY.ipMaxFailures });
  return scopes;
}

async function activeLoginLock(executor, scopes) {
  if (!scopes.length) return null;
  const { rows } = await executor.query(
    `SELECT CEIL(EXTRACT(EPOCH FROM (max(locked_until) - now())))::int AS retry_after
       FROM login_rate_limits
      WHERE (scope_type, scope_hash) IN (SELECT * FROM unnest($1::text[], $2::text[]))
        AND locked_until > now()`,
    [scopes.map((scope) => scope.type), scopes.map((scope) => scope.hash)],
  );
  const retry = rows[0]?.retry_after;
  return retry ? Math.max(1, Number(retry)) : null;
}

// Zapisuje błąd we wszystkich zakresach; zwraca true, jeśli któryś właśnie się zablokował.
async function recordLoginFailure(tx, scopes) {
  await tx.query('DELETE FROM login_rate_limits WHERE updated_at < now() - make_interval(secs => $1)', [LOGIN_POLICY.retentionSeconds]);
  let locked = false;
  for (const scope of scopes) {
    const { rows } = await tx.query(
      `INSERT INTO login_rate_limits (scope_type, scope_hash, failure_count, window_started_at, updated_at)
       VALUES ($1, $2, 1, now(), now())
       ON CONFLICT (scope_type, scope_hash) DO UPDATE SET
         failure_count = CASE WHEN login_rate_limits.locked_until IS NOT NULL
                                OR login_rate_limits.window_started_at <= now() - make_interval(secs => $3)
                              THEN 1 ELSE login_rate_limits.failure_count + 1 END,
         window_started_at = CASE WHEN login_rate_limits.locked_until IS NOT NULL
                                    OR login_rate_limits.window_started_at <= now() - make_interval(secs => $3)
                                  THEN now() ELSE login_rate_limits.window_started_at END,
         locked_until = NULL,
         updated_at = now()
       RETURNING failure_count`,
      [scope.type, scope.hash, LOGIN_POLICY.windowSeconds],
    );
    if (rows[0].failure_count >= scope.max) {
      await tx.query(
        `UPDATE login_rate_limits SET locked_until = now() + make_interval(secs => $3), updated_at = now()
          WHERE scope_type = $1 AND scope_hash = $2`,
        [scope.type, scope.hash, LOGIN_POLICY.lockSeconds],
      );
      locked = true;
    }
  }
  return locked;
}

async function clearLoginFailures(tx, scope) {
  await tx.query('DELETE FROM login_rate_limits WHERE scope_type = $1 AND scope_hash = $2', [scope.type, scope.hash]);
}

async function ensureNotLocked(executor, scopes) {
  const retryAfter = await activeLoginLock(executor, scopes);
  if (retryAfter) throw new LoginError('too_many_attempts', 429, { retryAfter });
}

// Zapis błędu + audyt w jednej transakcji. Zwraca błąd do rzucenia.
async function failAttempt(env, { scopes, action, userId = null, reason, code = 'invalid_credentials', status = 401 }) {
  const locked = await database(env).transaction(async (tx) => {
    const isLocked = await recordLoginFailure(tx, scopes);
    await insertAuditEvent(tx, {
      actorId: null, action,
      entityType: userId ? 'user' : 'login_attempt', entityId: userId ?? crypto.randomUUID(),
      metadata: { reason, locked: isLocked },
    });
    return isLocked;
  });
  return locked
    ? new LoginError('too_many_attempts', 429, { retryAfter: LOGIN_POLICY.lockSeconds })
    : new LoginError(code, status);
}

async function findAccountByEmail(executor, normalizedEmail) {
  const { rows } = await executor.query(
    `SELECT u.id, u.disabled_at, p.hash, p.must_change
       FROM users u LEFT JOIN user_passwords p ON p.user_id = u.id
      WHERE lower(u.email) = $1
      ORDER BY u.created_at, u.id
      LIMIT 1`,
    [normalizedEmail],
  );
  return rows[0] ?? null;
}

// Przeliczenie hasha z bieżącymi parametrami po udanym logowaniu (najlepsza próba).
async function rehashIfNeeded(env, userId, oldHash, password) {
  if (!needsRehash(oldHash, env)) return;
  try {
    const hash = await hashPassword(password, { env });
    await database(env).query(
      `UPDATE user_passwords SET hash = $3, set_reason = 'rehash' WHERE user_id = $1 AND hash = $2`,
      [userId, oldHash, hash],
    );
  } catch {
    // Brak przeliczenia nie blokuje logowania; stary hash nadal działa.
  }
}

function sessionPayload(session, status, extra = {}) {
  return {
    session,
    mfaRequired: status.mfaRequired,
    mfaEnrolled: status.enrolled,
    mfaRequiredByRole: status.requiredByRole,
    ...extra,
  };
}

// --- Logowanie ----------------------------------------------------------------

export async function passwordLogin(env, { email, password, clientIp }) {
  const normalized = normalizeLoginEmail(email);
  const scopes = loginScopes({ email: normalized, ip: clientIp });
  await ensureNotLocked(database(env), scopes);

  const wellFormed = normalized.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
  const account = wellFormed ? await findAccountByEmail(database(env), normalized) : null;
  const passwordOk = await verifyPasswordOrDummy(password, account?.hash ?? null, env);

  if (!account || !account.hash || !passwordOk || account.disabled_at) {
    let reason = 'unknown_account';
    if (account && !account.hash) reason = 'no_password';
    else if (account && !passwordOk) reason = 'invalid_password';
    else if (account?.disabled_at) reason = 'user_disabled';
    throw await failAttempt(env, { scopes, action: 'auth.login_failed', userId: account?.id ?? null, reason });
  }

  const result = await database(env).transaction(async (tx) => {
    await clearLoginFailures(tx, scopes[0]);
    const session = await createSession(tx, { userId: account.id, mfaVerified: false });
    const status = await mfaStatus(tx, account.id, env);
    await insertAuditEvent(tx, {
      actorId: account.id, action: 'auth.login_succeeded', entityType: 'session', entityId: session.sessionId,
      metadata: { method: 'password', mfaEnrolled: status.enrolled, mfaRequired: status.mfaRequired },
    });
    return sessionPayload(session, status, { mustChangePassword: Boolean(account.must_change) });
  });
  await rehashIfNeeded(env, account.id, account.hash, password);
  return result;
}

export async function authState(env, session) {
  const status = await mfaStatus(database(env), session.user.id, env);
  const { rows } = await database(env).query('SELECT must_change FROM user_passwords WHERE user_id = $1', [session.user.id]);
  return {
    authenticated: true,
    mfaVerified: session.mfaVerified,
    mfaEnrolled: status.enrolled,
    mfaRequired: status.mfaRequired,
    mfaRequiredByRole: status.requiredByRole,
    hasPassword: Boolean(rows[0]),
    mustChangePassword: Boolean(rows[0]?.must_change),
    expiresAt: session.expiresAt,
  };
}

// --- Przyjęcie zaproszenia ------------------------------------------------------

function cleanDisplayName(value, email) {
  if (value === undefined || value === null || value === '') return String(email).split('@')[0].slice(0, 100);
  if (typeof value !== 'string') throw new LoginError('invalid_display_name', 400);
  // eslint-disable-next-line no-control-regex
  const text = value.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!text || [...text].length > 100) throw new LoginError('invalid_display_name', 400);
  return text;
}

// Tworzy konto (jeśli nie istnieje) z adresem z zaproszenia, ustawia hasło,
// nadaje rolę i tworzy sesję. Gdy konto z tym adresem ma już hasło, pole
// `password` musi być jego obecnym hasłem (zaproszenie nie może przejąć konta).
export async function acceptInvitationWithPassword(env, { token, password, displayName, clientIp }) {
  const ipScopes = loginScopes({ ip: clientIp });
  await ensureNotLocked(database(env), ipScopes);
  const invalid = (reason) => failAttempt(env, {
    scopes: ipScopes, action: 'auth.invitation_accept_failed', reason, code: 'invalid_invitation', status: 400,
  });
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw await invalid('malformed');
  if (typeof password !== 'string') throw new LoginError('password_required', 400);
  const tokenHash = await hashSecret(token);

  const { rows: preview } = await database(env).query(
    `SELECT lower(email) AS email FROM invitations
      WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
    [tokenHash],
  );
  if (!preview[0]) throw await invalid('not_available');
  const email = preview[0].email;
  const existing = await findAccountByEmail(database(env), email);
  if (existing?.disabled_at) throw await invalid('user_unavailable');

  let newHash = null;
  if (existing?.hash) {
    // Sprawdzenie hasła istniejącego konta podlega temu samemu limitowi co logowanie.
    await ensureNotLocked(database(env), loginScopes({ email, ip: clientIp }));
    const ok = await verifyPasswordOrDummy(password, existing.hash, env);
    if (!ok) {
      throw await failAttempt(env, {
        scopes: loginScopes({ email, ip: clientIp }), action: 'auth.invitation_accept_failed', userId: existing.id, reason: 'invalid_password',
      });
    }
  } else {
    const policyError = checkPasswordPolicy(password, { email });
    if (policyError) throw new LoginError(policyError, 400);
    newHash = await hashPassword(password, { env });
  }
  const name = cleanDisplayName(displayName, email);

  return database(env).transaction(async (tx) => {
    const locked = await lockInvitation(tx, tokenHash);
    if (locked.deny) throw new LoginError('invalid_invitation', 400);
    const { invitation } = locked;
    if (String(invitation.email).toLowerCase() !== email) throw new LoginError('invalid_invitation', 400);

    let user = (await tx.query(
      `SELECT u.id, u.disabled_at, p.hash FROM users u LEFT JOIN user_passwords p ON p.user_id = u.id
        WHERE lower(u.email) = $1 ORDER BY u.created_at, u.id LIMIT 1 FOR UPDATE OF u`,
      [email],
    )).rows[0];
    let created = false;
    if (!user) {
      const userId = crypto.randomUUID();
      const inserted = await tx.query(
        `INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)
         ON CONFLICT (email) DO NOTHING RETURNING id`,
        [userId, email, name],
      );
      if (!inserted.rows[0]) throw new LoginError('conflict', 409);
      user = { id: userId, disabled_at: null, hash: null };
      created = true;
      await insertAuditEvent(tx, {
        actorId: userId, action: 'user.created', entityType: 'user', entityId: userId,
        metadata: { source: 'invitation', invitationId: invitation.id },
      });
    }
    if (user.disabled_at) throw new LoginError('invalid_invitation', 400);
    // Stan konta zmienił się między sprawdzeniem hasła a blokadą — klient powinien ponowić.
    if ((existing?.hash ?? null) !== (user.hash ?? null)) throw new LoginError('conflict', 409);

    if (newHash) {
      await tx.query(
        `INSERT INTO user_passwords (user_id, hash, set_at, set_reason, must_change)
         VALUES ($1, $2, now(), 'invitation', false)`,
        [user.id, newHash],
      );
      await insertAuditEvent(tx, {
        actorId: user.id, action: 'auth.password_set', entityType: 'user', entityId: user.id,
        metadata: { reason: 'invitation', invitationId: invitation.id },
      });
    }
    const grantId = await grantInvitation(tx, invitation, user.id);
    const session = await createSession(tx, { userId: user.id, mfaVerified: false });
    const status = await mfaStatus(tx, user.id, env);
    await insertAuditEvent(tx, {
      actorId: user.id, action: 'auth.login_succeeded', entityType: 'session', entityId: session.sessionId,
      metadata: { method: 'invitation', invitationId: invitation.id, mfaEnrolled: status.enrolled, mfaRequired: status.mfaRequired },
    });
    return sessionPayload(session, status, { created, grantId, userId: user.id });
  });
}

// --- Zmiana hasła -------------------------------------------------------------

export async function changePassword(env, session, { currentPassword, newPassword, clientIp }) {
  const scopes = loginScopes({ email: session.user.email ?? session.user.id, ip: clientIp });
  await ensureNotLocked(database(env), scopes);
  const { rows } = await database(env).query('SELECT hash FROM user_passwords WHERE user_id = $1', [session.user.id]);
  const oldHash = rows[0]?.hash ?? null;
  const ok = await verifyPasswordOrDummy(currentPassword, oldHash, env);
  if (!ok || !oldHash) {
    throw await failAttempt(env, {
      scopes, action: 'auth.password_change_failed', userId: session.user.id,
      reason: oldHash ? 'invalid_password' : 'no_password', code: 'invalid_current_password', status: 400,
    });
  }
  const policyError = checkPasswordPolicy(newPassword, { email: session.user.email });
  if (policyError) throw new LoginError(policyError, 400);
  if (currentPassword.normalize('NFKC') === newPassword.normalize('NFKC')) throw new LoginError('password_unchanged', 400);
  const newHash = await hashPassword(newPassword, { env });

  return database(env).transaction(async (tx) => {
    const updated = await tx.query(
      `UPDATE user_passwords SET hash = $3, set_at = now(), set_reason = 'change', must_change = false
        WHERE user_id = $1 AND hash = $2 RETURNING user_id`,
      [session.user.id, oldHash, newHash],
    );
    if (!updated.rows[0]) throw new LoginError('conflict', 409);
    const revokedSessions = await revokeUserSessionsWith(tx, {
      userId: session.user.id, actorId: session.user.id, reason: 'password_changed', exceptSessionId: session.sessionId,
    });
    await clearLoginFailures(tx, scopes[0]);
    await insertAuditEvent(tx, {
      actorId: session.user.id, action: 'auth.password_changed', entityType: 'user', entityId: session.user.id,
      metadata: { revokedSessions },
    });
    // Bieżąca sesja dostaje nowy sekret (stan MFA bez zmian).
    const rotated = await rotateSession(inTransaction(tx), session, { mfaVerified: session.mfaVerified });
    return { revokedSessions, rotated };
  });
}

// --- Reset hasła tokenem administratora ------------------------------------------

export async function resetPasswordWithToken(env, { token, newPassword, clientIp }) {
  const ipScopes = loginScopes({ ip: clientIp });
  await ensureNotLocked(database(env), ipScopes);
  const invalid = (reason) => failAttempt(env, {
    scopes: ipScopes, action: 'auth.password_reset_failed', reason, code: 'invalid_token', status: 400,
  });
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw await invalid('malformed');
  const tokenHash = await hashSecret(token);
  const lookup = `SELECT t.id, t.user_id, lower(u.email) AS email
                    FROM password_reset_tokens t JOIN users u ON u.id = t.user_id
                   WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.revoked_at IS NULL
                     AND t.expires_at > now() AND u.disabled_at IS NULL`;
  const { rows } = await database(env).query(lookup, [tokenHash]);
  if (!rows[0]) throw await invalid('not_available');
  const policyError = checkPasswordPolicy(newPassword, { email: rows[0].email });
  if (policyError) throw new LoginError(policyError, 400);
  const newHash = await hashPassword(newPassword, { env });

  return database(env).transaction(async (tx) => {
    const locked = (await tx.query(`${lookup} FOR UPDATE OF t`, [tokenHash])).rows[0];
    if (!locked) throw new LoginError('invalid_token', 400);
    await tx.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [locked.id]);
    await tx.query(
      `INSERT INTO user_passwords (user_id, hash, set_at, set_reason, must_change)
       VALUES ($1, $2, now(), 'reset', false)
       ON CONFLICT (user_id) DO UPDATE SET hash = EXCLUDED.hash, set_at = now(), set_reason = 'reset', must_change = false`,
      [locked.user_id, newHash],
    );
    const revokedSessions = await revokeUserSessionsWith(tx, { userId: locked.user_id, actorId: locked.user_id, reason: 'password_reset' });
    await clearLoginFailures(tx, loginScopes({ email: locked.email })[0]);
    await insertAuditEvent(tx, {
      actorId: locked.user_id, action: 'auth.password_reset_completed', entityType: 'password_reset', entityId: locked.id,
      metadata: { userId: locked.user_id, revokedSessions },
    });
    return { ok: true };
  });
}

// --- Operacje administratora (uprawnienia sprawdza trasa: admin + MFA) ------------

export async function issuePasswordReset(env, { actorId, userId, ttlSeconds = PASSWORD_RESET_DEFAULT_TTL_SECONDS }) {
  if (!actorId) throw new Error('actor_required');
  const ttl = Math.max(60, Math.min(Number(ttlSeconds) || PASSWORD_RESET_DEFAULT_TTL_SECONDS, PASSWORD_RESET_MAX_TTL_SECONDS));
  const { secret, tokenHash } = await createSessionSecret();
  const resetId = crypto.randomUUID();
  return database(env).transaction(async (tx) => {
    const user = (await tx.query('SELECT id, disabled_at FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
    if (!user) throw new LoginError('user_not_found', 404);
    if (user.disabled_at) throw new LoginError('user_disabled', 409);
    // Nowy token unieważnia poprzednie niewykorzystane (podwójne kliknięcie = jeden ważny token).
    const superseded = await tx.query(
      `UPDATE password_reset_tokens SET revoked_at = now()
        WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL RETURNING id`,
      [userId],
    );
    for (const row of superseded.rows) {
      await insertAuditEvent(tx, {
        actorId, action: 'auth.password_reset_revoked', entityType: 'password_reset', entityId: row.id,
        metadata: { userId, reason: 'superseded' },
      });
    }
    const { rows } = await tx.query(
      `INSERT INTO password_reset_tokens (id, user_id, token_hash, created_by, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5)) RETURNING expires_at`,
      [resetId, userId, tokenHash, actorId, ttl],
    );
    const expiresAt = isoTimestamp(rows[0].expires_at);
    await insertAuditEvent(tx, {
      actorId, action: 'auth.password_reset_issued', entityType: 'password_reset', entityId: resetId,
      metadata: { userId, expiresAt, superseded: superseded.rows.length },
    });
    return { resetId, secret, expiresAt };
  });
}

// Utrata telefonu i wszystkich kodów odzyskiwania: wyłącza czynniki, unieważnia
// kody, zeruje limity MFA i wylogowuje konto. Po zalogowaniu hasłem osoba
// zapisuje nowy czynnik (dla ról z MFA_REQUIRED_ROLES — obowiązkowo).
export async function adminResetMfa(env, { actorId, userId }) {
  if (!actorId) throw new Error('actor_required');
  if (actorId === userId) throw new LoginError('cannot_reset_own_mfa', 409);
  return database(env).transaction(async (tx) => {
    const user = (await tx.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
    if (!user) throw new LoginError('user_not_found', 404);
    const factors = await tx.query(
      'UPDATE user_mfa_factors SET disabled_at = now() WHERE user_id = $1 AND disabled_at IS NULL RETURNING id',
      [userId],
    );
    const codes = await tx.query(
      `UPDATE mfa_recovery_codes SET invalidated_at = now()
        WHERE user_id = $1 AND used_at IS NULL AND invalidated_at IS NULL RETURNING id`,
      [userId],
    );
    if (!factors.rows.length && !codes.rows.length) {
      return { userId, changed: false, disabledFactors: 0, invalidatedRecoveryCodes: 0, revokedSessions: 0 };
    }
    await tx.query("DELETE FROM mfa_rate_limits WHERE scope_type = 'user' AND scope_id = $1", [userId]);
    const revokedSessions = await revokeUserSessionsWith(tx, { userId, actorId, reason: 'mfa_reset' });
    await insertAuditEvent(tx, {
      actorId, action: 'mfa.reset', entityType: 'user', entityId: userId,
      metadata: {
        userId, factorIds: factors.rows.map((row) => row.id), invalidatedRecoveryCodes: codes.rows.length, revokedSessions,
      },
    });
    return {
      userId, changed: true, disabledFactors: factors.rows.length, invalidatedRecoveryCodes: codes.rows.length, revokedSessions,
    };
  });
}
