import { isLocalAppEnv } from './app-env.js';

// Nazwa historyczna. Lokalny dev na http://localhost (APP_ENV nieustawione,
// development lub test) używa jej nadal: `__Host-` wymaga atrybutu Secure, a
// nie każda przeglądarka przyjmuje Secure na http://localhost (#114).
export const LEGACY_SESSION_COOKIE = 'rd_session';
export const HOST_SESSION_COOKIE = '__Host-rd_session';
// Wartości APP_ENV uznawane za lokalne (brak, development, test) rozpoznaje
// wspólna funkcja z src/app-env.js (#166). Każda inna (także literówka) jest
// traktowana zachowawczo jak środowisko wystawione do sieci (#114).
export { isLocalAppEnv };

function processAppEnv() {
  return typeof process !== 'undefined' ? process.env?.APP_ENV : undefined;
}

// Nazwa cookie do ZAPISU zależna od środowiska. `appEnv` jawnie (testy) albo
// z process.env.APP_ENV (serwer Node; w Workerze bez `process` → lokalna nazwa).
export function sessionCookieName(appEnv = processAppEnv()) {
  return isLocalAppEnv(appEnv) ? LEGACY_SESSION_COOKIE : HOST_SESSION_COOKIE;
}
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function parseCookies(header = '') {
  const cookies = {};
  for (const part of String(header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && cookies[name] === undefined) cookies[name] = value;
  }
  return cookies;
}

export function readSessionToken(request) {
  // Odczyt przyjmuje obie nazwy. Nazwa `__Host-` ma pierwszeństwo; stara
  // `rd_session` działa w okresie przejściowym — sesja żyje najwyżej 24 h
  // (SESSION_TTL_SECONDS), więc po tym czasie od wdrożenia nie ma już ważnych
  // tokenów pod starą nazwą i odczyt można usunąć (#114).
  const cookies = parseCookies(request.headers.get('Cookie'));
  for (const name of [HOST_SESSION_COOKIE, LEGACY_SESSION_COOKIE]) {
    const token = cookies[name];
    if (token && TOKEN_PATTERN.test(token)) return token;
  }
  return null;
}

export async function hashSecret(secret) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function createSessionSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  return { secret, tokenHash: await hashSecret(secret) };
}

export function sessionCookie(secret, maxAgeSeconds, appEnv = processAppEnv()) {
  if (!TOKEN_PATTERN.test(secret)) throw new Error('Nieprawidłowy sekret sesji.');
  const maxAge = Math.max(1, Math.min(Number(maxAgeSeconds) || 0, 60 * 60 * 24));
  return `${sessionCookieName(appEnv)}=${secret}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookie(appEnv = processAppEnv()) {
  return `${sessionCookieName(appEnv)}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// Wylogowanie czyści OBIE nazwy (okres przejściowy, #114): w środowisku
// wystawionym do sieci nagłówki dla `__Host-rd_session` i `rd_session`; lokalnie
// tylko `rd_session`. Wynik to tablica wartości nagłówków Set-Cookie.
export function clearSessionCookies(appEnv = processAppEnv()) {
  const cleared = [clearSessionCookie(appEnv)];
  if (!isLocalAppEnv(appEnv)) cleared.push(`${LEGACY_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  return cleared;
}

export function isSameOrigin(request) {
  const origin = request.headers.get('Origin');
  return Boolean(origin && origin === new URL(request.url).origin);
}

export async function loadSession(request, env) {
  const token = readSessionToken(request);
  if (!token) return null;
  const tokenHash = await hashSecret(token);
  const row = await env.DB.prepare(
    `SELECT s.id AS session_id, s.expires_at, s.mfa_verified_at,
            u.id AS user_id, u.email, u.display_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
        AND s.revoked_at IS NULL
        AND datetime(s.expires_at) > CURRENT_TIMESTAMP
        AND u.disabled_at IS NULL
      LIMIT 1`,
  ).bind(tokenHash).first();
  if (!row) return null;
  return {
    sessionId: row.session_id,
    expiresAt: row.expires_at,
    mfaVerified: Boolean(row.mfa_verified_at),
    user: { id: row.user_id, email: row.email, displayName: row.display_name },
  };
}

export async function revokeSession(env, session) {
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL',
    ).bind(session.sessionId),
    env.DB.prepare(
      `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, metadata_json)
       VALUES (?, ?, 'session.logout', 'session', ?, '{}')`,
    ).bind(crypto.randomUUID(), session.user.id, session.sessionId),
  ]);
}
