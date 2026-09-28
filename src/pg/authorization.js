// Autoryzacja na PostgreSQL. Reguła decyzji (isAuthorized) jest wspólna
// ze starym modułem src/authorization.js; tu zmienia się tylko źródło danych.

import { isAuthorized } from '../authorization.js';
import { isoTimestamp, loadSession } from './auth.js';
import { insertAuditEvent } from './audit.js';
import { mfaStatus } from './mfa-policy.js';

export { isAuthorized };

export async function loadActiveGrants(env, userId) {
  const { rows } = await env.db.query(
    `SELECT role, class_id, school_year_id, expires_at
       FROM role_grants
      WHERE user_id = $1
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY role, class_id NULLS FIRST, school_year_id NULLS FIRST`,
    [userId],
  );
  return rows.map((row) => ({
    role: row.role,
    classId: row.class_id ?? null,
    schoolYearId: row.school_year_id ?? null,
    expiresAt: isoTimestamp(row.expires_at),
  }));
}

export async function loadAuthorizationContext(request, env) {
  const session = await loadSession(request, env);
  if (!session) return null;
  const grants = await loadActiveGrants(env, session.user.id);
  return { session, grants };
}

// Wspólna bramka dla modułów tras:
//   const access = await requireAccess(request, env, { roles: ['treasurer'], requireMfa: true, classId, schoolYearId }, json);
//   if (access.response) return access.response;
//   access.context.session.user.id …
// Zwraca 401 `unauthenticated` bez ważnej sesji i 403 `forbidden` przy braku
// roli, zakresu klasy/roku lub MFA (taki sam kontrakt jak stare trasy Workera).
//
// Bezpieczny domyślny zakres: gdy trasa nie podaje classId, przydział
// ograniczony do klasy NIE jest brany pod uwagę (isAuthorized sam w sobie
// traktowałby go wtedy jak przydział szkolny). Trasa klasowa musi podać classId.
export function schoolWideContext(context) {
  if (!context || !Array.isArray(context.grants)) return context;
  return { ...context, grants: context.grants.filter((grant) => !grant.classId) };
}

export function isAuthorizedScoped(context, requirement) {
  const scoped = requirement?.classId ? context : schoolWideContext(context);
  return isAuthorized(scoped, requirement);
}

// #184 pkt 1: ślad odmowy 403 dla zalogowanego aktora (anonim/401 — bez
// zdarzenia, patrz uzasadnienie w issue). Zapis poza transakcją żądania
// (env.db, autocommit — wyjątek w tests/audit-transaction-boundary.test.js),
// nigdy nie blokuje ani nie zmienia odpowiedzi 403.
// Wyłącznie GET: odmowa żądania zmieniającego stan (POST/PUT/PATCH/DELETE) ma
// pozostać bez żadnego zapisu — to sprawdza już macierz uprawnień
// (tests/pg-authz-matrix.test.js, WRITE_TABLES obejmuje audit_events). Ślad
// odmowy przy odczycie jest najprostszym sygnałem powtarzającego się
// nieuprawnionego przeglądania (patrz #133).
// Deduplikacja: ten sam aktor + ta sama ścieżka w oknie 5 minut → bez nowego
// wiersza (audit_events jest tylko do dopisywania — nie ma tu licznika w
// jednym wierszu; kolejne odmowy w oknie po prostu nie dopisują drugiego
// zdarzenia, więc widoczne jest zawsze tylko jedno na okno).
const ACCESS_DENIED_WINDOW_MS = 5 * 60 * 1000;

export async function logAccessDenied(env, context, requirement, request) {
  try {
    if (request?.method && request.method !== 'GET') return;
    const actorId = context?.session?.user?.id;
    if (!actorId || !env?.db?.query) return;
    const url = new URL(request.url);
    const route = url.pathname;
    const sessionId = context.session.sessionId ?? null;
    const requiredRole = Array.isArray(requirement?.roles) ? requirement.roles.join(',') : null;
    const since = new Date(Date.now() - ACCESS_DENIED_WINDOW_MS).toISOString();
    const { rows } = await env.db.query(
      `SELECT 1 FROM audit_events
        WHERE actor_id = $1 AND action = 'access.denied' AND entity_type = 'route' AND entity_id = $2
          AND occurred_at > $3
        LIMIT 1`,
      [actorId, route, since],
    );
    if (rows[0]) return;
    await insertAuditEvent(env.db, {
      actorId, action: 'access.denied', entityType: 'route', entityId: route,
      metadata: { requiredRole, sessionId },
    });
  } catch {
    // Ślad audytu nigdy nie może zablokować ani zmienić odpowiedzi 403.
  }
}

export async function requireAccess(request, env, requirement, json) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) return { response: json({ error: 'unauthenticated' }, 401) };
  if (!isAuthorizedScoped(context, requirement)) {
    await logAccessDenied(env, context, requirement, request);
    return { response: json({ error: 'forbidden' }, 403) };
  }
  // #150 (SR-10, krok w górę/step-up): `requireMfa: { maxAgeSeconds }` zamiast
  // `true` — SPRAWDZANE PO roli/zakresie (SR-07), więc osoba bez dostępu
  // dostaje ten sam ogólny `forbidden`, niezależnie od wieku MFA.
  if (requirement?.requireMfa && typeof requirement.requireMfa === 'object') {
    const code = freshMfaForbiddenCode(context, requirement.requireMfa.maxAgeSeconds);
    if (code) return { response: json({ error: code }, 403) };
  }
  return { context };
}

// Wiek ostatniego potwierdzenia MFA bieżącej sesji w sekundach, albo null,
// gdy sesja nie ma potwierdzonego MFA (loadSession ustawia mfaVerifiedAt).
export function mfaAgeSeconds(session) {
  const verifiedAt = session?.mfaVerifiedAt ? new Date(session.mfaVerifiedAt).getTime() : NaN;
  return Number.isFinite(verifiedAt) ? Math.max(0, (Date.now() - verifiedAt) / 1000) : null;
}

// Domyślny próg świeżości MFA dla operacji nieodwracalnych/masowych (założenie
// do D-10, zob. issue #150): eksport roczny, zamknięcie roku, zatwierdzenie
// kampanii e-mail, nadanie roli, reset hasła/MFA, przyjęcie uchwały > 3000 EUR.
export const MFA_STEP_UP_MAX_AGE_SECONDS = 15 * 60;

// Krok w górę (step-up, #150 SR-10): zwraca null, gdy MFA jest wystarczająco
// świeże, albo kod błędu 403 do zwrócenia wywołującemu — `mfa_required`, gdy
// sesja w ogóle nie ma potwierdzonego MFA (spójne z bramką routera), albo
// `mfa_stale`, gdy jest, ale starsze niż `maxAgeSeconds`. Klient prosi o kod
// i ponawia to samo żądanie (spójnie z #99) — nic nie jest tu zapisywane.
export function freshMfaForbiddenCode(context, maxAgeSeconds = MFA_STEP_UP_MAX_AGE_SECONDS) {
  const session = context?.session;
  if (!session?.mfaVerified) return 'mfa_required';
  const age = mfaAgeSeconds(session);
  return age === null || age > maxAgeSeconds ? 'mfa_stale' : null;
}

// Rozróżnia powód odmowy 403 dla wymogu z `requireMfa` (#161). Sam brak roli
// lub zakresu (klasa/rok) zostaje ogólnym `forbidden` — nie ujawnia stanu MFA
// konta ani istnienia zasobu (SR-07: zakres sprawdzany najpierw). Gdy jedyną
// przeszkodą jest MFA bieżącej sesji, zwraca kod, który prowadzi do właściwego
// widoku logowania: `mfa_required` (czynnik zapisany, sesja bez potwierdzonego
// kodu) albo `mfa_enrollment_required` (konto bez czynnika).
// Wywołujący sam decyduje, kiedy użyć tego rozróżnienia zamiast requireAccess —
// dziś tylko lista klasy (exports) i raport Komisji Rewizyjnej (reconciliation).
export async function mfaAwareForbiddenCode(context, requirement, env) {
  const { requireMfa, ...scopeRequirement } = requirement ?? {};
  if (!isAuthorizedScoped(context, scopeRequirement)) return 'forbidden';
  if (requireMfa && !context.session.mfaVerified) {
    const status = await mfaStatus(env.db, context.session.user.id, env);
    return status.enrolled ? 'mfa_required' : 'mfa_enrollment_required';
  }
  return 'forbidden';
}

// Cofnięcie przydziału roli: wiersz zostaje (revoked_at/revoked_by), zdarzenie
// audytu w tej samej transakcji. Uprawnienie do cofania sprawdza wywołujący.
export async function revokeRoleGrant(env, { grantId, actorId }) {
  if (!actorId) throw new Error('actor_required');
  return env.db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE role_grants SET revoked_at = now(), revoked_by = $2
        WHERE id = $1 AND revoked_at IS NULL
        RETURNING id, role, class_id, school_year_id`,
      [grantId, actorId],
    );
    const grant = rows[0];
    if (!grant) return false;
    await insertAuditEvent(tx, {
      actorId, action: 'role_grant.revoked', entityType: 'role_grant', entityId: grant.id,
      metadata: { role: grant.role, classId: grant.class_id ?? null, schoolYearId: grant.school_year_id ?? null },
    });
    return true;
  });
}
