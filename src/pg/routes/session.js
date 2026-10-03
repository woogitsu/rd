// /api/session, /api/access, /api/logout — ten sam kontrakt HTTP co stary Worker.

import { clearSessionCookies } from '../../auth.js';
import { loadSession, revokeSession } from '../auth.js';
import { hasActiveRole, isAuthorizedScoped, loadActiveGrants, loadAuthorizationContext } from '../authorization.js';
import { AUDIT_LEDGER_READ_ROLES, auditLedgerReadEnabled } from '../audit-ledger-read.js';
import { mfaGate } from '../mfa-policy.js';
import { buildHeaders } from '../http.js';
import { isReadOnly } from '../../write-mode.js';

export const name = 'session';

// D-09 (#137): panele księgi i dokumentów muszą wiedzieć, czy pokazać Komisji Rewizyjnej widok tylko do
// odczytu. Pole `capabilities.auditLedgerRead: true` dostaje WYŁĄCZNIE konto z rolą `audit` (przydział bez
// klasy, potwierdzone MFA — jak trasy odczytu), gdy flaga AUDIT_LEDGER_READ jest włączona. Dla wszystkich
// pozostałych (także `audit` przy wyłączonej fladze) pola `capabilities` nie ma w ogóle, więc odpowiedź nie
// zdradza konfiguracji serwera. To wskazówka dla interfejsu — trasy odczytu i tak autoryzuje serwer.
async function sessionCapabilities(env, session) {
  if (!auditLedgerReadEnabled(env)) return null;
  const grants = await loadActiveGrants(env, session.user.id);
  if (!isAuthorizedScoped({ session, grants }, { roles: AUDIT_LEDGER_READ_ROLES, requireMfa: true })) return null;
  return { auditLedgerRead: true };
}

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
    const capabilities = await sessionCapabilities(env, session);
    return json({ ...publicSession, writeMode: isReadOnly(env) ? 'read_only' : 'normal', ...(capabilities ? { capabilities } : {}) });
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
