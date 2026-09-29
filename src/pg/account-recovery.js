// #146 (wariant zachowawczy, bez rozstrzygania D-08/D-10): reset hasła i reset
// MFA konta z rolą chronioną (zarząd, skarbnik, administrator) wymaga drugiej
// osoby — zasada czterech oczu. Pierwszy administrator tylko zapisuje wniosek;
// token resetu (albo wyłączenie MFA) powstaje przy zatwierdzeniu przez INNEGO
// administratora, który nie jest właścicielem konta. Token dostaje zatwierdzający
// (nie wnioskodawca) i przekazuje go właścicielowi osobnym, zaufanym kanałem.
//
// Moduł nie wysyła żadnych wiadomości: powiadomienie właściciela konta zależy
// od D-16/D-17 (szablon i nadawca) i jest zapisane jako zakres otwarty.
// Konto bez roli chronionej oraz reset hasła WŁASNEGO konta zostają bez zmian
// (bezpośrednio) — nie dają nikomu cudzej tożsamości.
import crypto from 'node:crypto';
import { insertAuditEvent } from './audit.js';
import { isoTimestamp } from './auth.js';
import {
  adminResetMfaInTx, issuePasswordResetInTx, LoginError, PASSWORD_RESET_DEFAULT_TTL_SECONDS,
} from './login.js';

export const PROTECTED_ACCOUNT_ROLES = Object.freeze(['admin', 'board', 'treasurer']);
export const RECOVERY_KINDS = Object.freeze(['password_reset', 'mfa_reset']);
export const RECOVERY_REQUEST_TTL_HOURS = 24;
const STATUSES = new Set(['pending', 'approved', 'rejected', 'expired', 'all']);
const MAX_LIST = 200;

function database(env) {
  return env.db;
}

export async function hasProtectedRole(executor, userId) {
  const { rows } = await executor.query(
    `SELECT 1 FROM role_grants
      WHERE user_id = $1 AND role = ANY($2::text[]) AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1`,
    [userId, PROTECTED_ACCOUNT_ROLES],
  );
  return Boolean(rows[0]);
}

// Czy operacja na koncie userId wymaga wniosku i drugiej osoby.
export async function requiresRecoveryApproval(env, { actorId, userId, kind }) {
  if (kind === 'password_reset' && actorId === userId) return false;
  return hasProtectedRole(database(env), userId);
}

function present(row) {
  return {
    id: row.id, kind: row.kind, userId: row.target_user_id, requestedBy: row.requested_by, status: row.status,
    createdAt: isoTimestamp(row.created_at), expiresAt: isoTimestamp(row.expires_at),
    decidedBy: row.decided_by ?? null, decidedAt: row.decided_at ? isoTimestamp(row.decided_at) : null,
    ...(row.kind === 'password_reset' && row.ttl_seconds ? { ttlHours: Math.round(row.ttl_seconds / 3600) } : {}),
  };
}

const COLUMNS = `id, kind, target_user_id, requested_by, ttl_seconds, status, created_at, expires_at, decided_by, decided_at`;

// Wniosek jest idempotentny: ponowienie (podwójne kliknięcie, drugi administrator)
// zwraca ten sam otwarty wniosek zamiast tworzyć drugi.
export async function createRecoveryRequest(env, { actorId, userId, kind, ttlSeconds = null }) {
  if (!actorId) throw new Error('actor_required');
  if (!RECOVERY_KINDS.includes(kind)) throw new LoginError('invalid_kind', 400);
  if (kind === 'mfa_reset' && actorId === userId) throw new LoginError('cannot_reset_own_mfa', 409);
  return database(env).transaction(async (tx) => {
    const user = (await tx.query('SELECT id, disabled_at FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
    if (!user) throw new LoginError('user_not_found', 404);
    if (user.disabled_at) throw new LoginError('user_disabled', 409);
    const closed = await tx.query(
      `UPDATE account_recovery_requests SET status = 'expired', decided_at = now()
        WHERE target_user_id = $1 AND kind = $2 AND status = 'pending' AND expires_at <= now() RETURNING id`,
      [userId, kind],
    );
    for (const row of closed.rows) {
      await insertAuditEvent(tx, {
        actorId, action: 'account_recovery.expired', entityType: 'account_recovery_request', entityId: row.id,
        metadata: { userId, kind },
      });
    }
    const existing = (await tx.query(
      `SELECT ${COLUMNS} FROM account_recovery_requests WHERE target_user_id = $1 AND kind = $2 AND status = 'pending'`,
      [userId, kind],
    )).rows[0];
    if (existing) return { request: present(existing), created: false };
    const id = crypto.randomUUID();
    const { rows } = await tx.query(
      `INSERT INTO account_recovery_requests (id, kind, target_user_id, requested_by, ttl_seconds, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6)) RETURNING ${COLUMNS}`,
      [id, kind, userId, actorId, kind === 'password_reset' ? (ttlSeconds ?? PASSWORD_RESET_DEFAULT_TTL_SECONDS) : null, RECOVERY_REQUEST_TTL_HOURS],
    );
    await insertAuditEvent(tx, {
      actorId, action: 'account_recovery.requested', entityType: 'account_recovery_request', entityId: id,
      metadata: { userId, kind },
    });
    return { request: present(rows[0]), created: true };
  });
}

export async function listRecoveryRequests(env, { status = 'pending' } = {}) {
  if (!STATUSES.has(status)) throw new LoginError('invalid_status', 400);
  const { rows } = await database(env).query(
    `SELECT ${COLUMNS} FROM account_recovery_requests
      WHERE ($1 = 'all' OR status = $1) ORDER BY created_at DESC, id LIMIT ${MAX_LIST}`,
    [status],
  );
  return rows.map(present);
}

async function lockRequest(tx, requestId) {
  const row = (await tx.query(
    `SELECT ${COLUMNS} FROM account_recovery_requests WHERE id = $1 FOR UPDATE`, [requestId],
  )).rows[0];
  if (!row) throw new LoginError('recovery_request_not_found', 404);
  return row;
}

// Zatwierdzenie wykonuje operację w tej samej transakcji, co zamknięcie wniosku
// (podwójne kliknięcie = jeden token / jedno zdarzenie: drugi widzi wniosek zamknięty).
export async function approveRecoveryRequest(env, { actorId, requestId }) {
  if (!actorId) throw new Error('actor_required');
  let expired = false;
  const result = await database(env).transaction(async (tx) => {
    const row = await lockRequest(tx, requestId);
    if (row.status !== 'pending') throw new LoginError('recovery_request_closed', 409);
    if (actorId === row.requested_by || actorId === row.target_user_id) {
      throw new LoginError('recovery_four_eyes_required', 403);
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await tx.query(`UPDATE account_recovery_requests SET status = 'expired', decided_at = now() WHERE id = $1`, [row.id]);
      await insertAuditEvent(tx, {
        actorId, action: 'account_recovery.expired', entityType: 'account_recovery_request', entityId: row.id,
        metadata: { userId: row.target_user_id, kind: row.kind },
      });
      expired = true;
      return null;
    }
    let outcome;
    if (row.kind === 'password_reset') {
      const reset = await issuePasswordResetInTx(tx, {
        actorId, userId: row.target_user_id, ttlSeconds: row.ttl_seconds ?? undefined,
        requestId: row.id, requestedBy: row.requested_by,
      });
      outcome = { reset: { id: reset.resetId, userId: row.target_user_id, expiresAt: reset.expiresAt }, token: reset.secret };
    } else {
      outcome = { mfa: await adminResetMfaInTx(tx, {
        actorId, userId: row.target_user_id, requestId: row.id, requestedBy: row.requested_by,
      }) };
    }
    const { rows } = await tx.query(
      `UPDATE account_recovery_requests SET status = 'approved', decided_by = $2, decided_at = now()
        WHERE id = $1 RETURNING ${COLUMNS}`,
      [row.id, actorId],
    );
    await insertAuditEvent(tx, {
      actorId, action: 'account_recovery.approved', entityType: 'account_recovery_request', entityId: row.id,
      metadata: { userId: row.target_user_id, kind: row.kind, requestedBy: row.requested_by },
    });
    return { request: present(rows[0]), ...outcome };
  });
  if (expired) throw new LoginError('recovery_request_expired', 409);
  return result;
}

// Odrzucić (lub wycofać jako wnioskodawca) może każdy administrator.
export async function rejectRecoveryRequest(env, { actorId, requestId }) {
  if (!actorId) throw new Error('actor_required');
  return database(env).transaction(async (tx) => {
    const row = await lockRequest(tx, requestId);
    if (row.status !== 'pending') throw new LoginError('recovery_request_closed', 409);
    const { rows } = await tx.query(
      `UPDATE account_recovery_requests SET status = 'rejected', decided_by = $2, decided_at = now()
        WHERE id = $1 RETURNING ${COLUMNS}`,
      [row.id, actorId],
    );
    await insertAuditEvent(tx, {
      actorId, action: 'account_recovery.rejected', entityType: 'account_recovery_request', entityId: row.id,
      metadata: { userId: row.target_user_id, kind: row.kind, requestedBy: row.requested_by },
    });
    return { request: present(rows[0]) };
  });
}
