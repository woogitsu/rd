const SESSION_COOKIE = 'rd_session';
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
  const token = parseCookies(request.headers.get('Cookie'))[SESSION_COOKIE];
  return token && TOKEN_PATTERN.test(token) ? token : null;
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

export function sessionCookie(secret, maxAgeSeconds) {
  if (!TOKEN_PATTERN.test(secret)) throw new Error('Nieprawidłowy sekret sesji.');
  const maxAge = Math.max(1, Math.min(Number(maxAgeSeconds) || 0, 60 * 60 * 24));
  return `${SESSION_COOKIE}=${secret}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
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
