// /api/session, /api/access, /api/logout — ten sam kontrakt HTTP co stary Worker.

import { clearSessionCookie } from '../../auth.js';
import { loadSession, revokeSession } from '../auth.js';
import { loadAuthorizationContext } from '../authorization.js';

export const name = 'session';

export async function handle(request, env, url, json) {
  if (url.pathname === '/api/session' && request.method === 'GET') {
    const session = await loadSession(request, env);
    if (!session) return json({ error: 'unauthenticated' }, 401);
    return json(session);
  }
  if (url.pathname === '/api/access' && request.method === 'GET') {
    const context = await loadAuthorizationContext(request, env);
    if (!context) return json({ error: 'unauthenticated' }, 401);
    return json({ grants: context.grants });
  }
  if (url.pathname === '/api/logout' && request.method === 'POST') {
    // Zgodność Origin sprawdza wcześniej handlePgRequest dla każdej metody zmieniającej stan.
    const session = await loadSession(request, env);
    if (session) await revokeSession(env, session, { reason: 'logout' });
    return new Response(null, {
      status: 204,
      headers: { 'Cache-Control': 'no-store', 'Set-Cookie': clearSessionCookie() },
    });
  }
  return null;
}
