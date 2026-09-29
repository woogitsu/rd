// Polityka MFA po zalogowaniu hasłem (issue #3). Prototyp — nie jest wdrożony.
//
// Reguły (wartości domyślne do potwierdzenia przez zarząd/IOD, D-10):
// 1. Konto z potwierdzonym czynnikiem MFA musi potwierdzić kod w bieżącej
//    sesji (POST /api/mfa/verify lub /api/mfa/recovery), zanim użyje
//    jakiejkolwiek chronionej trasy — inaczej samo hasło omijałoby MFA.
//    Odpowiedź: 403 `mfa_required`.
// 2. Konto z aktywnym przydziałem roli z MFA_REQUIRED_ROLES (domyślnie
//    admin, board, treasurer) bez potwierdzonego czynnika musi go najpierw
//    zapisać (POST /api/mfa/enroll + /api/mfa/confirm). Odpowiedź: 403
//    `mfa_enrollment_required`.
// 3. Trasy potrzebne do zalogowania, zapisu MFA i wylogowania są zwolnione
//    (MFA_GATE_EXEMPT). Bramka działa w routerze (src/pg/app.js) przed
//    modułami tras, więc obejmuje każdy moduł, także przyszły.
// Wymóg MFA na poziomie trasy (requireAccess z requireMfa) działa niezależnie.

import { hashSecret, readSessionToken } from '../auth.js';
import { ROLES } from './auth.js';

export const DEFAULT_MFA_REQUIRED_ROLES = Object.freeze(['admin', 'board', 'treasurer']);

// MFA_REQUIRED_ROLES: lista ról oddzielonych przecinkami; pusty ciąg = żadna rola
// (wymóg zapisu MFA wyłączony, reguła 1 nadal działa). Nieznane nazwy są pomijane.
export function mfaRequiredRoles(env) {
  const raw = env && Object.hasOwn(env, 'MFA_REQUIRED_ROLES') ? env.MFA_REQUIRED_ROLES : process.env.MFA_REQUIRED_ROLES;
  if (raw === undefined || raw === null) return [...DEFAULT_MFA_REQUIRED_ROLES];
  return String(raw).split(',').map((role) => role.trim()).filter((role) => ROLES.includes(role));
}

export const MFA_GATE_EXEMPT_EXACT = Object.freeze([
  '/api/session', '/api/access', '/api/logout', '/api/sessions', '/api/sessions/revoke-all',
  '/api/login', '/api/auth/state', '/api/invitations/accept', '/api/invitations/preview', '/api/password/reset',
  // Trasy publiczne i webhook: działają bez sesji, więc cookie niczego tu nie zmienia.
  '/api/meetings/public-minutes', '/api/meetings/public-notices', '/api/email/webhooks/brevo',
  // Wypisanie jednym kliknięciem (#110): klika je klient poczty rodzica, nie
  // przeglądarka z sesją; token HMAC jest jedynym zabezpieczeniem.
  '/api/email/preferences',
]);
// #150: lista i cofnięcie WŁASNEJ sesji (GET /api/sessions, POST /api/sessions/{id}/revoke)
// muszą działać tak samo jak /api/sessions/revoke-all — sesja bez potwierdzonego MFA musi
// móc zobaczyć swoje sesje i się z nich wylogować, inaczej mfa_required blokowałby wyjście.
export const MFA_GATE_EXEMPT_PREFIXES = Object.freeze(['/api/mfa/', '/api/public/', '/api/sessions/']);
const EXEMPT_EXACT = new Set(MFA_GATE_EXEMPT_EXACT);

export function isMfaGateExempt(pathname) {
  return EXEMPT_EXACT.has(pathname) || MFA_GATE_EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// Stan MFA konta: czy ma potwierdzony czynnik i czy jego role wymagają MFA.
export async function mfaStatus(executor, userId, env) {
  const { rows } = await executor.query(
    `SELECT EXISTS (SELECT 1 FROM user_mfa_factors f
                     WHERE f.user_id = $1 AND f.confirmed_at IS NOT NULL AND f.disabled_at IS NULL) AS enrolled,
            EXISTS (SELECT 1 FROM role_grants g
                     WHERE g.user_id = $1 AND g.role = ANY($2::text[]) AND g.revoked_at IS NULL
                       AND (g.expires_at IS NULL OR g.expires_at > now())) AS required_by_role`,
    [userId, mfaRequiredRoles(env)],
  );
  const enrolled = Boolean(rows[0]?.enrolled);
  const requiredByRole = Boolean(rows[0]?.required_by_role);
  return { enrolled, requiredByRole, mfaRequired: enrolled || requiredByRole };
}

// Zwraca null (przepuść) albo kod błędu 403 dla bieżącej sesji. Jedno zapytanie;
// bez cookie albo z nieważną sesją zwraca null — trasa sama odpowie 401.
export async function mfaGate(request, env) {
  const token = readSessionToken(request);
  if (!token || !env?.db) return null;
  const tokenHash = await hashSecret(token);
  const { rows } = await env.db.query(
    `SELECT s.mfa_verified_at IS NOT NULL AS verified,
            EXISTS (SELECT 1 FROM user_mfa_factors f
                     WHERE f.user_id = s.user_id AND f.confirmed_at IS NOT NULL AND f.disabled_at IS NULL) AS enrolled,
            EXISTS (SELECT 1 FROM role_grants g
                     WHERE g.user_id = s.user_id AND g.role = ANY($2::text[]) AND g.revoked_at IS NULL
                       AND (g.expires_at IS NULL OR g.expires_at > now())) AS required_by_role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL
      LIMIT 1`,
    [tokenHash, mfaRequiredRoles(env)],
  );
  const row = rows[0];
  if (!row || row.verified) return null;
  if (row.enrolled) return 'mfa_required';
  if (row.required_by_role) return 'mfa_enrollment_required';
  return null;
}
