import { clearSessionCookie, isSameOrigin, loadSession, revokeSession } from './auth.js';

const JSON_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ status: 'ok' });
    }
    if (url.pathname === '/api/session' && request.method === 'GET') {
      try {
        const session = await loadSession(request, env);
        if (!session) return json({ error: 'unauthenticated' }, 401);
        return json(session);
      } catch {
        return json({ error: 'service_unavailable' }, 503);
      }
    }
    if (url.pathname === '/api/logout' && request.method === 'POST') {
      if (!isSameOrigin(request)) return json({ error: 'invalid_origin' }, 403);
      try {
        const session = await loadSession(request, env);
        if (session) await revokeSession(env, session);
        return new Response(null, {
          status: 204,
          headers: { 'Cache-Control': 'no-store', 'Set-Cookie': clearSessionCookie() },
        });
      } catch {
        return json({ error: 'service_unavailable' }, 503);
      }
    }
    return json({ error: 'not_found' }, 404);
  },
};
