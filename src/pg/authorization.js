// Autoryzacja na PostgreSQL. Reguła decyzji (isAuthorized) jest wspólna
// ze starym modułem src/authorization.js; tu zmienia się tylko źródło danych.

import { isAuthorized } from '../authorization.js';
import { isoTimestamp, loadSession, ROLE_STATUS } from './auth.js';
import { insertAuditEvent } from './audit.js';
import { mfaStatus } from './mfa-policy.js';

export { isAuthorized };

// #176: konto może mieć rolę bez żadnej trasy chronionej dziś (np. `principal`,
// ROLE_STATUS 'pending_decision'). Serwer — nie front-end — rozstrzyga, czy
// przydziały dają cokolwiek: jedno źródło prawdy (ROLE_STATUS), żeby ekran
// startowy nie musiał duplikować tej wiedzy ani zgadywać.
export function hasActiveRole(grants) {
  return Array.isArray(grants) && grants.some((grant) => ROLE_STATUS[grant.role] !== 'pending_decision');
}

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

export async function requireAccess(request, env, requirement, json) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) return { response: json({ error: 'unauthenticated' }, 401) };
  if (!isAuthorizedScoped(context, requirement)) return { response: json({ error: 'forbidden' }, 403) };
  return { context };
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
