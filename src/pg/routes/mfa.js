// /api/mfa/* i /api/sessions/revoke-all (issue #3). Prototyp — nie jest wdrożony.
// Metoda MFA (TOTP) jest proponowaną wartością domyślną do decyzji D-10.
// Zgodność Origin sprawdza wcześniej handlePgRequest; sesję sprawdza każda trasa.

import { clearSessionCookie } from '../../auth.js';
import { loadSession } from '../auth.js';
import { attemptFactor, enrollFactor, MfaError, revokeAllOwnSessions } from '../mfa.js';

export const name = 'mfa';

const MAX_BODY_BYTES = 1024;
const ATTEMPT_ROUTES = new Map([
  ['/api/mfa/confirm', 'confirm'],
  ['/api/mfa/verify', 'verify'],
  ['/api/mfa/recovery', 'recovery'],
]);

async function readCode(request) {
  const type = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw new MfaError('invalid_content_type', 415);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new MfaError('request_too_large', 413);
  let data;
  try { data = JSON.parse(text); } catch { throw new MfaError('invalid_json', 400); }
  if (!data || typeof data !== 'object' || typeof data.code !== 'string' || data.code.length > 64) {
    throw new MfaError('invalid_json', 400);
  }
  return data.code.trim();
}

function errorResponse(json, error) {
  const headers = error.extra?.retryAfter ? { 'Retry-After': String(error.extra.retryAfter) } : {};
  return json({ error: error.code }, error.status, headers);
}

export async function handle(request, env, url, json) {
  const isEnroll = url.pathname === '/api/mfa/enroll';
  const attemptKind = ATTEMPT_ROUTES.get(url.pathname);
  const isRevokeAll = url.pathname === '/api/sessions/revoke-all';
  if (!isEnroll && !attemptKind && !isRevokeAll) return null;
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });

  const session = await loadSession(request, env);
  if (!session) return json({ error: 'unauthenticated' }, 401);

  try {
    if (isRevokeAll) {
      const revoked = await revokeAllOwnSessions(env, session);
      return json({ revoked }, 200, { 'Set-Cookie': clearSessionCookie() });
    }
    if (isEnroll) {
      return json(await enrollFactor(env, session), 201);
    }
    const code = await readCode(request);
    const outcome = await attemptFactor(env, session, { kind: attemptKind, code });
    if (!outcome.ok) {
      const headers = outcome.retryAfter ? { 'Retry-After': String(outcome.retryAfter) } : {};
      return json({ error: outcome.error }, outcome.status, headers);
    }
    const payload = { mfaVerified: true, expiresAt: outcome.rotated.expiresAt };
    if (outcome.recoveryCodes) payload.recoveryCodes = outcome.recoveryCodes;
    return json(payload, 200, { 'Set-Cookie': outcome.rotated.cookie });
  } catch (error) {
    if (error instanceof MfaError) return errorResponse(json, error);
    throw error;
  }
}
