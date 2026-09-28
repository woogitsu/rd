// Logowanie hasłem i zarządzanie hasłem (issue #3). Prototyp — nie jest wdrożony.
//
//   POST /api/login                 { email, password } → sesja bez MFA + { mfaRequired, mfaEnrolled, … }
//   GET  /api/auth/state            stan bieżącej sesji dla ekranu logowania
//   POST /api/invitations/accept    { token, password, displayName? } → konto, rola, sesja
//   POST /api/password/change       { currentPassword, newPassword } (zalogowany; wylogowuje inne sesje)
//   POST /api/password/reset        { token, newPassword } — token wydaje wyłącznie administrator
//
// Zgodność nagłówka Origin sprawdza wcześniej router (src/pg/app.js) — także
// dla logowania bez sesji (ochrona przed CSRF logowania). Adres IP klienta
// ustawia serwer Node w nagłówku x-rd-client-ip (src/node-app.js); nagłówek
// z żądania klienta jest zawsze nadpisywany.

import { loadSession } from '../auth.js';
import {
  acceptInvitationWithPassword, authState, changePassword, LoginError, passwordLogin, resetPasswordWithToken,
} from '../login.js';
import { MAX_PASSWORD_INPUT_BYTES } from '../password.js';

export const name = 'login';

const MAX_BODY_BYTES = 4 * 1024;
const POST_ROUTES = new Set(['/api/login', '/api/invitations/accept', '/api/password/change', '/api/password/reset']);
export const CLIENT_IP_HEADER = 'x-rd-client-ip';

async function readJson(request) {
  const type = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw new LoginError('invalid_content_type', 415);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new LoginError('request_too_large', 413);
  let data;
  try { data = JSON.parse(text); } catch { throw new LoginError('invalid_json', 400); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new LoginError('invalid_json', 400);
  return data;
}

function passwordField(data, key) {
  const value = data[key];
  if (typeof value !== 'string' || value.length === 0) throw new LoginError('invalid_json', 400);
  if (new TextEncoder().encode(value).byteLength > MAX_PASSWORD_INPUT_BYTES) throw new LoginError('password_too_long', 400);
  return value;
}

function stringField(data, key, max = 512) {
  const value = data[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new LoginError('invalid_json', 400);
  return value;
}

function clientIp(request) {
  return request.headers.get(CLIENT_IP_HEADER) ?? '';
}

function loginResponse(json, payload, status = 200) {
  const { session, ...rest } = payload;
  return json({ ...rest, mfaVerified: false, expiresAt: session.expiresAt }, status, { 'Set-Cookie': session.cookie });
}

async function route(request, env, url, json) {
  const path = url.pathname;
  if (path === '/api/auth/state') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
    const session = await loadSession(request, env);
    if (!session) return json({ error: 'unauthenticated' }, 401);
    return json(await authState(env, session));
  }
  if (!POST_ROUTES.has(path)) return null;
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });

  if (path === '/api/login') {
    const data = await readJson(request);
    const email = stringField(data, 'email', 320);
    const password = passwordField(data, 'password');
    return loginResponse(json, await passwordLogin(env, { email, password, clientIp: clientIp(request) }));
  }
  if (path === '/api/invitations/accept') {
    const data = await readJson(request);
    const token = stringField(data, 'token', 64);
    const password = passwordField(data, 'password');
    // #164: powtórzenie jest opcjonalne w API (zgodność wsteczna), ale wymagane
    // przez acceptInvitationWithPassword przy tworzeniu nowego konta.
    const passwordRepeat = typeof data.passwordRepeat === 'string' ? data.passwordRepeat : undefined;
    const payload = await acceptInvitationWithPassword(env, {
      token, password, passwordRepeat, displayName: data.displayName, clientIp: clientIp(request),
    });
    return loginResponse(json, { session: payload.session, mfaRequired: payload.mfaRequired, mfaEnrolled: payload.mfaEnrolled, mfaRequiredByRole: payload.mfaRequiredByRole, created: payload.created }, 201);
  }
  if (path === '/api/password/reset') {
    const data = await readJson(request);
    const token = stringField(data, 'token', 64);
    const newPassword = passwordField(data, 'newPassword');
    await resetPasswordWithToken(env, { token, newPassword, clientIp: clientIp(request) });
    return json({ ok: true });
  }
  // /api/password/change — bramka MFA w routerze obowiązuje (trasa nie jest zwolniona).
  const session = await loadSession(request, env);
  if (!session) return json({ error: 'unauthenticated' }, 401);
  const data = await readJson(request);
  const currentPassword = passwordField(data, 'currentPassword');
  const newPassword = passwordField(data, 'newPassword');
  const result = await changePassword(env, session, { currentPassword, newPassword, clientIp: clientIp(request) });
  return json({ revokedSessions: result.revokedSessions, expiresAt: result.rotated.expiresAt }, 200, { 'Set-Cookie': result.rotated.cookie });
}

export async function handle(request, env, url, json) {
  try {
    return await route(request, env, url, json);
  } catch (error) {
    if (error instanceof LoginError) {
      const headers = error.extra?.retryAfter ? { 'Retry-After': String(error.extra.retryAfter) } : {};
      return json({ error: error.code }, error.status, headers);
    }
    throw error;
  }
}
