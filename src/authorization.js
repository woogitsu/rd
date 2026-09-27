import { loadSession } from './auth.js';

export async function loadActiveGrants(env, userId) {
  const result = await env.DB.prepare(
    `SELECT role, class_id, school_year_id, expires_at
       FROM role_grants
      WHERE user_id = ?
        AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)
      ORDER BY role, class_id, school_year_id`,
  ).bind(userId).all();
  return (result.results ?? []).map(row => ({
    role: row.role,
    classId: row.class_id ?? null,
    schoolYearId: row.school_year_id ?? null,
    expiresAt: row.expires_at ?? null,
  }));
}

export async function loadAuthorizationContext(request, env) {
  const session = await loadSession(request, env);
  if (!session) return null;
  const grants = await loadActiveGrants(env, session.user.id);
  return { session, grants };
}

export function isAuthorized(context, requirement) {
  if (!context?.session || !Array.isArray(context.grants)) return false;
  const roles = Array.isArray(requirement?.roles) ? requirement.roles : [];
  if (!roles.length) return false;
  if (requirement.requireMfa && !context.session.mfaVerified) return false;

  return context.grants.some(grant => {
    if (!roles.includes(grant.role)) return false;
    if (requirement.classId && grant.classId && grant.classId !== requirement.classId) return false;
    if (requirement.schoolYearId && grant.schoolYearId && grant.schoolYearId !== requirement.schoolYearId) return false;
    return true;
  });
}
