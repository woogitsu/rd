// Router API na PostgreSQL (Railway). Prototyp — nie jest wdrożony.
//
// Rejestr tras: każdy moduł eksportuje
//   export const name = 'payments';                       // do logów technicznych
//   export async function handle(request, env, url, json) // Response | null
//   export function allowsCrossOrigin(request, url) {…}  // opcjonalnie, np. podpisany webhook
// i jest dopisywany JEDNĄ linią do ROUTES poniżej. Moduły są sprawdzane po
// kolei; pierwszy, który zwróci Response, kończy obsługę. null = „nie moja trasa”.
//
// Przed modułami handlePgRequest odrzuca każde żądanie POST/PUT/PATCH/DELETE
// pod /api/ bez zgodnego nagłówka Origin (403 invalid_origin). Moduł sam
// sprawdza sesję i uprawnienia (requireAccess z ./authorization.js).
// env.db ma kontrakt z src/db.js (w testach: PGlite).

import { isSameOrigin } from '../auth.js';
import { json, logRouteError, UNSAFE_METHODS } from './http.js';
import * as sessionRoutes from './routes/session.js';
import * as paymentsRoutes from './routes/payments.js';
import * as eventsRoutes from './routes/events.js';
import * as meetingsRoutes from './routes/meetings.js';

export const ROUTES = [
  sessionRoutes,
  paymentsRoutes,
  eventsRoutes,
  meetingsRoutes,
  // Kolejne moduły (#36+) dopisują tu po jednej linii, np.:
  // ledgerRoutes,
];

export function createPgHandler(routes = ROUTES) {
  return async function handle(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return json({ status: 'ok' });

    if (url.pathname.startsWith('/api/') && UNSAFE_METHODS.has(request.method) && !isSameOrigin(request)) {
      const exempt = routes.some((route) => typeof route.allowsCrossOrigin === 'function' && route.allowsCrossOrigin(request, url));
      if (!exempt) return json({ error: 'invalid_origin' }, 403);
    }

    for (const route of routes) {
      try {
        const response = await route.handle(request, env, url, json);
        if (response) return response;
      } catch (error) {
        logRouteError(route.name ?? 'unknown', error);
        return json({ error: 'service_unavailable' }, 503);
      }
    }
    return json({ error: 'not_found' }, 404);
  };
}

export const handlePgRequest = createPgHandler(ROUTES);
