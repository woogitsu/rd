// #146 (wariant zachowawczy do D-08): nadanie roli chronionej — administrator,
// zarząd, skarbnik (PROTECTED_ACCOUNT_ROLES, jak przy resecie hasła/MFA) —
// wymaga drugiej osoby. Dotyczy wszystkich dróg do takiej roli:
//   * POST /api/admin/grants                   → wniosek kind = 'grant'
//   * POST /api/admin/invitations              → wniosek kind = 'invitation'
//   * POST /api/admin/invitations/{id}/reissue → wniosek kind = 'invitation'
//     z replaces_invitation_id (nowy token dla tego samego adresu też daje rolę)
// Pierwszy administrator zapisuje tylko wniosek (202). Przydział albo
// zaproszenie z tokenem powstaje przy zatwierdzeniu przez INNEGO aktywnego
// administratora — nie wnioskodawcę i nie adresata (także nie konto o adresie
// z zaproszenia). Token zaproszenia dostaje zatwierdzający, jeden raz.
//
// Wyjątek jawny: gdy nie ma nikogo, kto mógłby zatwierdzić (jedyny aktywny
// administrator; adresat się nie liczy) — pierwsze uruchomienie po
// scripts/bootstrap-admin.js — nadanie działa jak dotąd, a w tej samej
// transakcji powstaje zdarzenie `role_grant.four_eyes_waived`. Rozstrzygnięcie,
// czy taki wyjątek ma istnieć i czy zatwierdzać może też zarząd, należy do D-08.
//
// Moduł zapisuje i zamyka wnioski; samo wykonanie (INSERT przydziału albo
// zaproszenia) dostarcza wywołujący (src/pg/routes/admin.js) jako `execute`,
// w tej samej transakcji co zamknięcie wniosku — podwójne kliknięcie
// „Zatwierdź” daje jeden przydział i jedno zdarzenie (drugi widzi wniosek
// zamknięty). Moduł nie wysyła wiadomości (D-16/D-17).
import crypto from 'node:crypto';
import { insertAuditEvent } from './audit.js';
import { isoTimestamp } from './auth.js';
import { PROTECTED_ACCOUNT_ROLES } from './account-recovery.js';
import { gateFreeText, piiAuditMetadata } from './pii-gate.js';

export const GRANT_REQUEST_KINDS = Object.freeze(['grant', 'invitation']);
export const GRANT_REQUEST_TTL_HOURS = 72;
const STATUSES = new Set(['pending', 'approved', 'rejected', 'expired', 'all']);
const MAX_LIST = 200;
// Powód odrzucenia (0159): opcjonalny, 3–500 znaków po obcięciu spacji.
export const REJECT_REASON_MIN = 3;
export const REJECT_REASON_MAX = 500;

export class GrantRequestError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function isProtectedRole(role) {
  return PROTECTED_ACCOUNT_ROLES.includes(role);
}

// Czy istnieje ktoś, kto może zatwierdzić: aktywny (niewyłączony) administrator
// inny niż wnioskodawca i inny niż adresat (konto albo adres zaproszenia).
export async function otherApproverExists(executor, { actorId, targetUserId = null, targetEmail = null }) {
  const { rows } = await executor.query(
    `SELECT 1 FROM role_grants g JOIN users u ON u.id = g.user_id
      WHERE g.role = 'admin' AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())
        AND u.disabled_at IS NULL AND u.id <> $1
        AND ($2::text IS NULL OR u.id <> $2)
        AND ($3::text IS NULL OR lower(u.email) <> $3)
      LIMIT 1`,
    [actorId, targetUserId, targetEmail],
  );
  return Boolean(rows[0]);
}

// 'direct' — rola niechroniona, jak dotąd; 'request' — tylko wniosek;
// 'waived' — rola chroniona, ale brak drugiej osoby (wyjątek z dziennikiem).
// Wywoływane w transakcji pod blokadą zmian przydziałów (lockGrantChanges),
// więc równoległe nadanie drugiego administratora nie zmienia wyniku w trakcie.
export async function grantApprovalMode(tx, { actorId, role, targetUserId = null, targetEmail = null }) {
  if (!isProtectedRole(role)) return 'direct';
  return (await otherApproverExists(tx, { actorId, targetUserId, targetEmail })) ? 'request' : 'waived';
}

export async function recordFourEyesWaiver(tx, { actorId, entityType, entityId, role, userId = null, schoolYearId = null }) {
  await insertAuditEvent(tx, {
    actorId, action: 'role_grant.four_eyes_waived', entityType, entityId,
    metadata: { role, userId, schoolYearId, reason: 'no_other_admin' },
  });
}

const COLUMNS = `id, kind, role, target_user_id, target_email, school_year_id, grant_expires_at,
  invitation_ttl_seconds, replaces_invitation_id, requested_by, status, created_at, expires_at,
  decided_by, decided_at, result_id, reject_reason`;

export function presentGrantRequest(row) {
  return {
    id: row.id, kind: row.kind, role: row.role,
    userId: row.target_user_id ?? null, email: row.target_email ?? null,
    schoolYearId: row.school_year_id ?? null,
    grantExpiresAt: row.grant_expires_at ? isoTimestamp(row.grant_expires_at) : null,
    ...(row.invitation_ttl_seconds ? { ttlHours: Math.round(row.invitation_ttl_seconds / 3600) } : {}),
    replacesInvitationId: row.replaces_invitation_id ?? null,
    requestedBy: row.requested_by, status: row.status,
    createdAt: isoTimestamp(row.created_at), expiresAt: isoTimestamp(row.expires_at),
    decidedBy: row.decided_by ?? null, decidedAt: row.decided_at ? isoTimestamp(row.decided_at) : null,
    resultId: row.result_id ?? null,
    rejectReason: row.reject_reason ?? null,
  };
}

// Metadane zdarzeń: identyfikatory, bez adresu e-mail (adres jest w wierszu wniosku).
function requestMetadata(row, extra = {}) {
  return {
    kind: row.kind, role: row.role, userId: row.target_user_id ?? null, schoolYearId: row.school_year_id ?? null,
    ...(row.replaces_invitation_id ? { replacesInvitationId: row.replaces_invitation_id } : {}),
    ...extra,
  };
}

// Zapis wniosku w transakcji wywołującego (pod lockGrantChanges). Idempotentny:
// ponowienie o ten sam zakres (podwójne kliknięcie, drugi administrator)
// zwraca otwarty wniosek zamiast tworzyć drugi. Wygasłe wnioski są zamykane.
export async function insertGrantRequest(tx, {
  actorId, kind, role, targetUserId = null, targetEmail = null, schoolYearId = null,
  grantExpiresAt = null, invitationTtlSeconds = null, replacesInvitationId = null,
}) {
  if (!actorId) throw new Error('actor_required');
  if (!GRANT_REQUEST_KINDS.includes(kind)) throw new GrantRequestError('invalid_kind');
  if (!isProtectedRole(role)) throw new GrantRequestError('invalid_role');
  const key = targetUserId ?? targetEmail;
  const closed = await tx.query(
    `UPDATE role_grant_requests SET status = 'expired', decided_at = now()
      WHERE status = 'pending' AND expires_at <= now() AND kind = $1
        AND COALESCE(target_user_id, target_email) = $2 AND role = $3
        AND COALESCE(school_year_id, '') = COALESCE($4::text, '')
      RETURNING ${COLUMNS}`,
    [kind, key, role, schoolYearId],
  );
  for (const row of closed.rows) {
    await insertAuditEvent(tx, {
      actorId, action: 'role_grant_request.expired', entityType: 'role_grant_request', entityId: row.id,
      metadata: requestMetadata(row),
    });
  }
  const existing = (await tx.query(
    `SELECT ${COLUMNS} FROM role_grant_requests
      WHERE status = 'pending' AND kind = $1 AND COALESCE(target_user_id, target_email) = $2 AND role = $3
        AND COALESCE(school_year_id, '') = COALESCE($4::text, '')`,
    [kind, key, role, schoolYearId],
  )).rows[0];
  if (existing) return { request: presentGrantRequest(existing), created: false };
  const id = crypto.randomUUID();
  let rows;
  try {
    ({ rows } = await tx.query(
      `INSERT INTO role_grant_requests (id, kind, role, target_user_id, target_email, school_year_id,
         grant_expires_at, invitation_ttl_seconds, replaces_invitation_id, requested_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(hours => $11))
       RETURNING ${COLUMNS}`,
      [id, kind, role, targetUserId, targetEmail, schoolYearId, grantExpiresAt, invitationTtlSeconds,
        replacesInvitationId, actorId, GRANT_REQUEST_TTL_HOURS],
    ));
  } catch (error) {
    if (error?.message === 'school_year_closed') throw new GrantRequestError('school_year_closed', 409);
    throw error;
  }
  await insertAuditEvent(tx, {
    actorId, action: 'role_grant_request.requested', entityType: 'role_grant_request', entityId: id,
    metadata: requestMetadata(rows[0]),
  });
  return { request: presentGrantRequest(rows[0]), created: true };
}

export async function listGrantRequests(env, { status = 'pending' } = {}) {
  if (!STATUSES.has(status)) throw new GrantRequestError('invalid_status');
  const { rows } = await env.db.query(
    `SELECT ${COLUMNS} FROM role_grant_requests
      WHERE ($1 = 'all' OR status = $1) ORDER BY created_at DESC, id LIMIT ${MAX_LIST}`,
    [status],
  );
  return rows.map(presentGrantRequest);
}

// Blokada wiersza wniosku: podwójne kliknięcie „Zatwierdź” albo „Zatwierdź”
// i „Odrzuć” naraz — drugie żądanie czeka tu i widzi wniosek zamknięty.
async function lockGrantRequest(tx, requestId) {
  const row = (await tx.query(`SELECT ${COLUMNS} FROM role_grant_requests WHERE id = $1 FOR UPDATE`, [requestId])).rows[0];
  if (!row) throw new GrantRequestError('grant_request_not_found', 404);
  return row;
}

// `execute(tx, row)` wykonuje nadanie i zwraca { resultId, outcome }.
// `lockFirst(tx)` — blokada zmian przydziałów (lockGrantChanges) PRZED blokadą
// wiersza: ta sama kolejność co w insertGrantRequest (blokada doradcza, potem
// wiersze wniosków), więc równoległe wniosek + zatwierdzenie nie zakleszczą się.
export async function approveGrantRequest(env, { actorId, requestId, execute, lockFirst }) {
  if (!actorId) throw new Error('actor_required');
  let expired = false;
  const result = await env.db.transaction(async (tx) => {
    await lockFirst(tx);
    const row = await lockGrantRequest(tx, requestId);
    if (row.status !== 'pending') throw new GrantRequestError('grant_request_closed', 409);
    if (actorId === row.requested_by || actorId === row.target_user_id) {
      throw new GrantRequestError('grant_four_eyes_required', 403);
    }
    if (row.target_email) {
      const own = (await tx.query('SELECT 1 FROM users WHERE id = $1 AND lower(email) = $2', [actorId, row.target_email])).rows[0];
      if (own) throw new GrantRequestError('grant_four_eyes_required', 403);
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await tx.query(`UPDATE role_grant_requests SET status = 'expired', decided_at = now() WHERE id = $1`, [row.id]);
      await insertAuditEvent(tx, {
        actorId, action: 'role_grant_request.expired', entityType: 'role_grant_request', entityId: row.id,
        metadata: requestMetadata(row),
      });
      expired = true;
      return null;
    }
    const { resultId, outcome } = await execute(tx, row);
    const { rows } = await tx.query(
      `UPDATE role_grant_requests SET status = 'approved', decided_by = $2, decided_at = now(), result_id = $3
        WHERE id = $1 RETURNING ${COLUMNS}`,
      [row.id, actorId, resultId],
    );
    await insertAuditEvent(tx, {
      actorId, action: 'role_grant_request.approved', entityType: 'role_grant_request', entityId: row.id,
      metadata: requestMetadata(row, { requestedBy: row.requested_by, resultId }),
    });
    return { request: presentGrantRequest(rows[0]), ...outcome };
  });
  if (expired) throw new GrantRequestError('grant_request_expired', 409);
  return result;
}

// Powód odrzucenia z żądania: brak, null albo sam biały znak → brak powodu
// (odrzucenie bez powodu działa jak przed 0159). Inny typ albo długość spoza
// 3–500 → 400 invalid_reason.
export function normalizeRejectReason(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new GrantRequestError('invalid_reason');
  const reason = value.trim();
  if (!reason) return null;
  // Znaki liczone jak char_length w CHECK bazy (punkty kodowe, nie jednostki UTF-16).
  const length = [...reason].length;
  if (length < REJECT_REASON_MIN || length > REJECT_REASON_MAX) throw new GrantRequestError('invalid_reason');
  return reason;
}

// Odrzucić (albo wycofać jako wnioskodawca) może każdy administrator.
// Opcjonalny powód (0159) przechodzi bramkę danych osobowych #152 PRZED
// transakcją: e-mail/IBAN/numer rejestru → 422 personal_data_forbidden,
// telefon bez `confirmPersonalData` → 422 possible_personal_data; w obu
// przypadkach wniosek zostaje oczekujący. Dziennik zdarzeń dostaje tylko flagę
// `reasonGiven` (i kategorie potwierdzonych danych), nigdy treść powodu.
export async function rejectGrantRequest(env, { actorId, requestId, reason = null, confirmPersonalData = false }) {
  if (!actorId) throw new Error('actor_required');
  const rejectReason = normalizeRejectReason(reason);
  const gate = gateFreeText([['role_grant_requests.reject_reason', rejectReason]], {
    confirm: confirmPersonalData === true,
    fail: (code, categories) => Object.assign(new GrantRequestError(code, 422), { categories }),
  });
  return env.db.transaction(async (tx) => {
    const row = await lockGrantRequest(tx, requestId);
    if (row.status !== 'pending') throw new GrantRequestError('grant_request_closed', 409);
    const { rows } = await tx.query(
      `UPDATE role_grant_requests SET status = 'rejected', decided_by = $2, decided_at = now(), reject_reason = $3
        WHERE id = $1 RETURNING ${COLUMNS}`,
      [row.id, actorId, rejectReason],
    );
    await insertAuditEvent(tx, {
      actorId, action: 'role_grant_request.rejected', entityType: 'role_grant_request', entityId: row.id,
      metadata: requestMetadata(row, { requestedBy: row.requested_by, reasonGiven: rejectReason !== null, ...piiAuditMetadata(gate) }),
    });
    return { request: presentGrantRequest(rows[0]) };
  });
}
