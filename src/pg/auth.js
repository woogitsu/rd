// Sesje i zaproszenia na PostgreSQL (issue #35).
// Czyste funkcje cookie/tokenów są współdzielone ze starym modułem src/auth.js.
// Wszystkie funkcje przyjmują env.db o kontrakcie z src/db.js (lub PGlite).

import { createSessionSecret, hashSecret, readSessionToken, sessionCookie } from '../auth.js';
import { insertAuditEvent } from './audit.js';

export const SESSION_TTL_SECONDS = 60 * 60 * 24;
// #150 (SR-10, założenie do D-10): brak limitu bezczynności pozwalał sesji
// zapomnianej na wspólnym komputerze (pokój nauczycielski, laptop Rady) działać
// do pełnych 24 h. Wariant zachowawczy: JEDEN próg dla wszystkich ról (issue
// proponuje różne progi wg roli finansowej — to wymagałoby ładowania ról przy
// KAŻDYM żądaniu w loadSession, kosztowne i osobna decyzja D-10 o zakresie ról;
// tu wybieramy krótszy, bezpieczniejszy próg dla wszystkich). Konfigurowalne
// przez SESSION_IDLE_TIMEOUT_SECONDS (0 wyłącza — tylko do testów/lokalnie).
export const DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS = 30 * 60;
// `last_seen_at` jest zapisywany najwyżej raz na tyle sekund — bez tego każde
// żądanie pisałoby do bazy (issue: „aktualizacja najwyżej raz na N minut”).
const LAST_SEEN_THROTTLE_SECONDS = 5 * 60;
// Założenie do potwierdzenia przez zarząd/szkołę: zaproszenie ważne 72 h, najwyżej 14 dni.
export const INVITATION_DEFAULT_TTL_SECONDS = 60 * 60 * 72;
export const INVITATION_MAX_TTL_SECONDS = 60 * 60 * 24 * 14;
export const ROLES = Object.freeze(['admin', 'board', 'treasurer', 'representative', 'audit', 'principal']);
const REVOKE_REASONS = new Set(['logout', 'rotated', 'admin', 'user_disabled', 'password_changed', 'password_reset', 'mfa_reset', 'idle']);

export function sessionIdleTimeoutSeconds(env) {
  const raw = env && Object.hasOwn(env, 'SESSION_IDLE_TIMEOUT_SECONDS') ? env.SESSION_IDLE_TIMEOUT_SECONDS : process.env.SESSION_IDLE_TIMEOUT_SECONDS;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS;
}

export function isoTimestamp(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function database(env) {
  if (!env?.db || typeof env.db.query !== 'function') throw new Error('database_unavailable');
  return env.db;
}

export async function loadSession(request, env) {
  const token = readSessionToken(request);
  if (!token) return null;
  const tokenHash = await hashSecret(token);
  const db = database(env);
  const { rows } = await db.query(
    `SELECT s.id AS session_id, s.created_at, s.expires_at, s.last_seen_at, s.mfa_verified_at,
            u.id AS user_id, u.email, u.display_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.disabled_at IS NULL
      LIMIT 1`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row) return null;

  // #150: bezczynność dłuższa niż limit wycofuje sesję (zdarzenie w audycie,
  // jak przy każdym innym powodzie — bez zacierania historii), niezależnie od
  // `expires_at`. Ostatnia aktywność to `last_seen_at`, a przed pierwszym
  // zapisem (tuż po utworzeniu) — `created_at`, żeby świeża sesja nie wygasała
  // natychmiast z powodu opóźnionego pierwszego zapisu (throttling niżej).
  const idleTimeout = sessionIdleTimeoutSeconds(env);
  if (idleTimeout > 0) {
    const lastActivity = new Date(row.last_seen_at ?? row.created_at).getTime();
    if (Number.isFinite(lastActivity) && (Date.now() - lastActivity) / 1000 > idleTimeout) {
      await db.transaction((tx) => revokeSessionWith(tx, row.session_id, { reason: 'idle', actorId: row.user_id }));
      return null;
    }
  }
  // Throttling: zapis najwyżej raz na LAST_SEEN_THROTTLE_SECONDS, nie przy
  // każdym żądaniu (issue: ochrona przed nadmiarem zapisów w bazie).
  await db.query(
    `UPDATE sessions SET last_seen_at = now()
      WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - make_interval(secs => $2))`,
    [row.session_id, LAST_SEEN_THROTTLE_SECONDS],
  );

  return {
    sessionId: row.session_id,
    expiresAt: isoTimestamp(row.expires_at),
    mfaVerified: Boolean(row.mfa_verified_at),
    user: { id: row.user_id, email: row.email, displayName: row.display_name },
  };
}

// Tworzy sesję w przekazanym wykonawcy (db lub tx). Zwraca surowy sekret
// wyłącznie po to, by ustawić cookie; w bazie zostaje tylko SHA-256.
// Wywoływana po poprawnym haśle (POST /api/login) lub przyjęciu zaproszenia
// (POST /api/invitations/accept) — src/pg/routes/login.js.
export async function createSession(executor, { userId, mfaVerified = false, ttlSeconds = SESSION_TTL_SECONDS, rotatedFrom = null }) {
  if (!userId) throw new Error('user_required');
  const ttl = Math.max(60, Math.min(Number(ttlSeconds) || SESSION_TTL_SECONDS, SESSION_TTL_SECONDS));
  const { secret, tokenHash } = await createSessionSecret();
  const sessionId = crypto.randomUUID();
  const { rows } = await executor.query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, mfa_verified_at, rotated_from)
     SELECT $1, u.id, $3, now() + make_interval(secs => $4), CASE WHEN $5::boolean THEN now() END, $6
       FROM users u
      WHERE u.id = $2 AND u.disabled_at IS NULL
     RETURNING id, expires_at`,
    [sessionId, userId, tokenHash, ttl, Boolean(mfaVerified), rotatedFrom],
  );
  if (!rows[0]) throw new Error('user_unavailable');
  await insertAuditEvent(executor, {
    actorId: userId, action: 'session.created', entityType: 'session', entityId: sessionId,
    metadata: { mfaVerified: Boolean(mfaVerified), rotatedFrom },
  });
  return { sessionId, secret, expiresAt: isoTimestamp(rows[0].expires_at), cookie: sessionCookie(secret, ttl) };
}

// Wycofanie sesji i wpis audytu w jednej transakcji. Ponowne wycofanie
// (np. podwójne kliknięcie „Wyloguj”) nie tworzy drugiego zdarzenia.
export async function revokeSession(env, session, { reason = 'logout', actorId = session?.user?.id } = {}) {
  if (!REVOKE_REASONS.has(reason)) throw new Error('invalid_revoke_reason');
  return database(env).transaction(async (tx) => revokeSessionWith(tx, session.sessionId, { reason, actorId }));
}

async function revokeSessionWith(tx, sessionId, { reason, actorId }) {
  const { rows } = await tx.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING id`,
    [sessionId, reason],
  );
  if (!rows[0]) return false;
  await insertAuditEvent(tx, {
    actorId, action: reason === 'logout' ? 'session.logout' : 'session.revoked',
    entityType: 'session', entityId: sessionId, metadata: { reason },
  });
  return true;
}

// Rotacja po zmianie uprawnień lub potwierdzeniu MFA: stara sesja zostaje
// wycofana, nowa wskazuje ją w rotated_from. Wszystko w jednej transakcji.
// Znajduje created_at PIERWSZEJ sesji łańcucha rotacji (idąc wstecz po
// rotated_from). Używane, żeby rotacja (MFA, zmiana hasła) nie przedłużała
// absolutnego limitu 24 h ponad moment pierwszego logowania (#150) — bez tego
// kod TOTP podany wieczorem pozwalał następnego dnia zapisywać wpłaty z pełnym
// nowym oknem 24 h od potwierdzenia MFA.
async function rootSessionCreatedAt(tx, sessionId) {
  const { rows } = await tx.query(
    `WITH RECURSIVE chain(id, created_at, rotated_from) AS (
       SELECT id, created_at, rotated_from FROM sessions WHERE id = $1
       UNION ALL
       SELECT s.id, s.created_at, s.rotated_from FROM sessions s JOIN chain c ON s.id = c.rotated_from
     )
     SELECT created_at FROM chain ORDER BY created_at ASC LIMIT 1`,
    [sessionId],
  );
  return rows[0]?.created_at ?? null;
}

export async function rotateSession(env, session, { mfaVerified = session.mfaVerified } = {}) {
  return database(env).transaction(async (tx) => {
    const rootCreatedAt = await rootSessionCreatedAt(tx, session.sessionId);
    const revoked = await revokeSessionWith(tx, session.sessionId, { reason: 'rotated', actorId: session.user.id });
    if (!revoked) throw new Error('session_not_active');
    // Nigdy 0 (patrz createSession: `Number(ttlSeconds) || SESSION_TTL_SECONDS`
    // traktuje 0 jako "brak wartości" i wróciłby do pełnych 24 h) — najwyżej
    // sekunda, po której `expires_at` i tak jest w przeszłości.
    const remainingSeconds = rootCreatedAt
      ? Math.max(1, Math.floor((new Date(rootCreatedAt).getTime() + SESSION_TTL_SECONDS * 1000 - Date.now()) / 1000))
      : SESSION_TTL_SECONDS;
    return createSession(tx, { userId: session.user.id, mfaVerified, rotatedFrom: session.sessionId, ttlSeconds: remainingSeconds });
  });
}

// Wycofanie wszystkich aktywnych sesji użytkownika (np. po wyłączeniu konta).
export async function revokeUserSessions(env, { userId, actorId, reason = 'admin' }) {
  return database(env).transaction(async (tx) => revokeUserSessionsWith(tx, { userId, actorId, reason }));
}

// Wersja w transakcji wywołującego; exceptSessionId pozostawia jedną sesję
// (np. bieżącą przy zmianie hasła). Zdarzenie audytu dla każdej sesji.
export async function revokeUserSessionsWith(tx, { userId, actorId, reason = 'admin', exceptSessionId = null }) {
  if (!REVOKE_REASONS.has(reason)) throw new Error('invalid_revoke_reason');
  const { rows } = await tx.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL AND ($3::text IS NULL OR id <> $3)
      RETURNING id`,
    [userId, reason, exceptSessionId],
  );
  for (const row of rows) {
    await insertAuditEvent(tx, { actorId, action: 'session.revoked', entityType: 'session', entityId: row.id, metadata: { reason } });
  }
  return rows.length;
}

// #150: osoba widzi WYŁĄCZNIE własne sesje — bez adresu IP ani User-Agent
// (nie są dziś zapisywane; minimalizacja danych). Tylko aktywne (nie
// wygasłe/wycofane) — historia sesji nie jest tu ujawniana.
export async function listOwnSessions(env, session) {
  const { rows } = await database(env).query(
    `SELECT id, created_at, last_seen_at, mfa_verified_at
       FROM sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC`,
    [session.user.id],
  );
  return rows.map((row) => ({
    id: row.id,
    createdAt: isoTimestamp(row.created_at),
    lastSeenAt: isoTimestamp(row.last_seen_at),
    mfaVerified: Boolean(row.mfa_verified_at),
    current: row.id === session.sessionId,
  }));
}

// Cofnięcie JEDNEJ WŁASNEJ sesji (inne urządzenie albo bieżąca — jak „Wyloguj”).
// Cudza sesja (inne konto) daje `false` -> trasa odpowiada 404, tak jak brak
// obiektu (SR-07): nie ujawnia, czy taki identyfikator w ogóle istnieje.
// Powód 'logout' dla bieżącej sesji (spójne z POST /api/logout), 'user_revoke_all'
// dla innego urządzenia (to nadal działanie samej osoby, nie administratora).
export async function revokeOwnSession(env, session, targetSessionId) {
  if (typeof targetSessionId !== 'string' || !targetSessionId) return false;
  const reason = targetSessionId === session.sessionId ? 'logout' : 'user_revoke_all';
  return database(env).transaction(async (tx) => {
    const { rows } = await tx.query(
      'SELECT id FROM sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL FOR UPDATE',
      [targetSessionId, session.user.id],
    );
    if (!rows[0]) return false;
    return revokeSessionWith(tx, targetSessionId, { reason, actorId: session.user.id });
  });
}

// --- Zaproszenia -----------------------------------------------------------
// Kto może zapraszać (i do jakich ról),
// sprawdza wywołujący przez requireAccess — zakres uprawnień zarządu,
// dyrekcji i Komisji Rewizyjnej wymaga decyzji szkoły.

export function normalizeEmail(email) {
  const value = String(email ?? '').trim().toLowerCase();
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('invalid_email');
  return value;
}

export async function createInvitation(env, { actorId, email, role, classId = null, schoolYearId = null, ttlSeconds = INVITATION_DEFAULT_TTL_SECONDS, replacesInvitationId = null }) {
  if (!actorId) throw new Error('actor_required');
  if (!ROLES.includes(role)) throw new Error('invalid_role');
  if (role === 'representative' && !classId) throw new Error('class_required');
  const normalized = normalizeEmail(email);
  const ttl = Math.max(60, Math.min(Number(ttlSeconds) || INVITATION_DEFAULT_TTL_SECONDS, INVITATION_MAX_TTL_SECONDS));
  const { secret, tokenHash } = await createSessionSecret();
  const invitationId = crypto.randomUUID();
  return database(env).transaction(async (tx) => {
    if (classId && schoolYearId) {
      const { rows } = await tx.query('SELECT 1 FROM classes WHERE id = $1 AND school_year_id = $2', [classId, schoolYearId]);
      if (!rows[0]) throw new Error('class_not_in_school_year');
    }
    const { rows } = await tx.query(
      `INSERT INTO invitations (id, email, token_hash, role, class_id, school_year_id, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))
       RETURNING expires_at`,
      [invitationId, normalized, tokenHash, role, classId, schoolYearId, actorId, ttl],
    );
    await insertAuditEvent(tx, {
      actorId, action: 'invitation.created', entityType: 'invitation', entityId: invitationId,
      metadata: { role, classId, schoolYearId },
    });
    // „Wyślij ponownie” (#108): zdarzenie w tej samej transakcji co nowe zaproszenie.
    if (replacesInvitationId) {
      await insertAuditEvent(tx, {
        actorId, action: 'invitation.reissued', entityType: 'invitation', entityId: invitationId,
        metadata: { replacesInvitationId },
      });
    }
    return { invitationId, secret, expiresAt: isoTimestamp(rows[0].expires_at) };
  });
}

// Blokuje wiersz zaproszenia (FOR UPDATE) i sprawdza jego stan. Zwraca
// { invitation } albo { deny } z `reason` wyłącznie do użytku wewnętrznego.
export async function lockInvitation(tx, tokenHash) {
  const { rows } = await tx.query(
    `SELECT id, email, role, class_id, school_year_id, created_by, expires_at <= now() AS expired,
            accepted_at, revoked_at
       FROM invitations WHERE token_hash = $1
       FOR UPDATE`,
    [tokenHash],
  );
  const invitation = rows[0];
  const deny = (reason) => ({ deny: { ok: false, error: 'invalid_invitation', reason } });
  if (!invitation) return deny('not_found');
  if (invitation.revoked_at) return deny('revoked');
  if (invitation.accepted_at) return deny('already_used');
  if (invitation.expired) return deny('expired');
  return { invitation };
}

// Nadaje rolę z zaproszenia i zamyka je (w transakcji wywołującego).
// Wywołujący musi wcześniej zablokować zaproszenie (lockInvitation)
// i sprawdzić, że adres konta odpowiada adresowi zaproszenia.
export async function grantInvitation(tx, invitation, userId) {
  const grantId = crypto.randomUUID();
  await tx.query(
    `INSERT INTO role_grants (id, user_id, role, class_id, school_year_id, granted_by, source_invitation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [grantId, userId, invitation.role, invitation.class_id, invitation.school_year_id, invitation.created_by, invitation.id],
  );
  await tx.query(
    'UPDATE invitations SET accepted_at = now(), accepted_by = $2 WHERE id = $1',
    [invitation.id, userId],
  );
  await insertAuditEvent(tx, {
    actorId: userId, action: 'invitation.accepted', entityType: 'invitation', entityId: invitation.id,
    metadata: { grantId },
  });
  await insertAuditEvent(tx, {
    actorId: userId, action: 'role_grant.created', entityType: 'role_grant', entityId: grantId,
    metadata: { role: invitation.role, classId: invitation.class_id, schoolYearId: invitation.school_year_id, invitationId: invitation.id },
  });
  return grantId;
}

export const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Akceptacja przez już uwierzytelnionego użytkownika. Adres konta musi
// odpowiadać zaproszeniu. Zaproszenie jest jednorazowe; odmowa zwraca
// `reason` tylko do użytku wewnętrznego — odpowiedź HTTP podaje wyłącznie
// `invalid_invitation`. Trasa HTTP z tworzeniem konta i hasłem:
// POST /api/invitations/accept (src/pg/routes/login.js).
export async function acceptInvitation(env, { token, userId }) {
  if (typeof token !== 'string' || !INVITATION_TOKEN_PATTERN.test(token) || !userId) {
    return { ok: false, error: 'invalid_invitation', reason: 'malformed' };
  }
  const tokenHash = await hashSecret(token);
  return database(env).transaction(async (tx) => {
    const locked = await lockInvitation(tx, tokenHash);
    if (locked.deny) return locked.deny;
    const { invitation } = locked;
    const deny = (reason) => ({ ok: false, error: 'invalid_invitation', reason });
    const user = (await tx.query(
      'SELECT id, lower(email) AS email, disabled_at FROM users WHERE id = $1',
      [userId],
    )).rows[0];
    if (!user || user.disabled_at) return deny('user_unavailable');
    if (user.email !== String(invitation.email).toLowerCase()) return deny('email_mismatch');
    const grantId = await grantInvitation(tx, invitation, userId);
    return { ok: true, grantId };
  });
}

export async function revokeInvitation(env, { invitationId, actorId }) {
  if (!actorId) throw new Error('actor_required');
  return database(env).transaction(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE invitations SET revoked_at = now(), revoked_by = $2
        WHERE id = $1 AND revoked_at IS NULL AND accepted_at IS NULL
        RETURNING id`,
      [invitationId, actorId],
    );
    if (!rows[0]) return false;
    await insertAuditEvent(tx, { actorId, action: 'invitation.revoked', entityType: 'invitation', entityId: invitationId });
    return true;
  });
}
