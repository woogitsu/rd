// /api/session, /api/access, /api/logout — ten sam kontrakt HTTP co stary Worker.

import { clearSessionCookies } from '../../auth.js';
import { loadSession, revokeSession } from '../auth.js';
import { hasActiveRole, loadAuthorizationContext } from '../authorization.js';
import { mfaGate } from '../mfa-policy.js';
import { buildHeaders } from '../http.js';
import { isReadOnly } from '../../write-mode.js';

export const name = 'session';

export async function handle(request, env, url, json) {
  if (url.pathname === '/api/session' && request.method === 'GET') {
    const session = await loadSession(request, env);
    if (!session) return json({ error: 'unauthenticated' }, 401);
    // #150: `mfaVerifiedAt` (dodane do loadSession na potrzeby kroku w górę,
    // src/pg/authorization.js) zostaje wewnętrzne — kontrakt GET /api/session
    // ma być identyczny jak w starym Workerze (patrz test).
    // Tryb tylko do odczytu (#143): panele czytają writeMode, żeby pokazać baner
    // okna serwisowego i wyłączyć przyciski zapisu (kontrola dostępu jest zawsze
    // na serwerze — patrz src/pg/app.js).
    const { mfaVerifiedAt, ...publicSession } = session;
    return json({ ...publicSession, writeMode: isReadOnly(env) ? 'read_only' : 'normal' });
  }
  if (url.pathname === '/api/access' && request.method === 'GET') {
    const context = await loadAuthorizationContext(request, env);
    if (!context) return json({ error: 'unauthenticated' }, 401);
    // Trasa jest zwolniona z bramki MFA, ale sesja, którą bramka by zatrzymała (samo
    // hasło), nie poznaje ról konta (#189). Ekran logowania korzysta z /api/auth/state.
    // hasActiveRole (#176) odzwierciedla wyłącznie `grants` zwrócone w tej samej
    // odpowiedzi — bramka MFA daje `grants: []`, więc `hasActiveRole` jest wtedy
    // `false` bez dodatkowego ujawnienia ról.
    if (await mfaGate(request, env)) return json({ grants: [], hasActiveRole: false, mfaRequired: true });
    return json({ grants: context.grants, hasActiveRole: hasActiveRole(context.grants) });
  }
  if (url.pathname === '/api/logout' && request.method === 'POST') {
    // Zgodność Origin sprawdza wcześniej handlePgRequest dla każdej metody zmieniającej stan.
    const session = await loadSession(request, env);
    if (session) await revokeSession(env, session, { reason: 'logout' });
    return new Response(null, {
      status: 204,
      headers: buildHeaders({ 'Cache-Control': 'no-store', 'Set-Cookie': clearSessionCookies() }),
    });
  }
  return null;
}
