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
//
// Następnie bramka MFA (./mfa-policy.js): sesja bez potwierdzonego MFA konta
// z czynnikiem MFA dostaje 403 mfa_required, a konta z rolą z MFA_REQUIRED_ROLES
// bez czynnika — 403 mfa_enrollment_required, na każdej trasie poza
// zwolnionymi (sesja, logowanie, MFA, wylogowanie, trasy publiczne).
// env.db ma kontrakt z src/db.js (w testach: PGlite).

import { isSameOrigin } from '../auth.js';
import { json, logRouteError, UNSAFE_METHODS } from './http.js';
import { classifyDbError } from './db-errors.js';
import * as sessionRoutes from './routes/session.js';
import * as paymentsRoutes from './routes/payments.js';
import * as eventsRoutes from './routes/events.js';
import * as meetingsRoutes from './routes/meetings.js';
import * as importRoutes from './routes/import.js';
import * as documentRoutes from './routes/documents.js';
import * as ledgerRoutes from './routes/ledger.js';
import * as ledgerCashRoutes from './routes/ledger-cash.js';
import * as ledgerCostCenterRoutes from './routes/ledger-cost-centers.js';
import * as emailRoutes from './routes/email.js';
import * as newsRoutes from './routes/news.js';
import * as adminRoutes from './routes/admin.js';
import * as reconciliationRoutes from './routes/reconciliation.js';
import * as exportsRoutes from './routes/exports.js';
import * as familiesRoutes from './routes/families.js';
import * as printRoutes from './routes/print.js';
import * as yearCloseRoutes from './routes/year-close.js';
import * as mfaRoutes from './routes/mfa.js';
import * as loginRoutes from './routes/login.js';
import * as representativeRoutes from './routes/representative.js';
import { isMfaGateExempt, mfaGate } from './mfa-policy.js';

export const ROUTES = [
  sessionRoutes,
  paymentsRoutes,
  eventsRoutes,
  meetingsRoutes,
  importRoutes,
  documentRoutes,
  ledgerRoutes,
  ledgerCashRoutes, // #199: przeniesienia kasa ↔ rachunek, bilans otwarcia
  emailRoutes, // #40: allowsCrossOrigin wyłącznie dla POST /api/email/webhooks/brevo
  newsRoutes,
  adminRoutes,
  reconciliationRoutes,
  exportsRoutes,
  familiesRoutes,
  printRoutes,
  yearCloseRoutes,
  mfaRoutes,
  loginRoutes, // #3: logowanie hasłem, zaproszenia, zmiana i reset hasła
  representativeRoutes, // #118: pulpit przedstawiciela
  ledgerCostCenterRoutes, // #117: centra kosztów (przypisanie wpisu do wydarzenia/klasy)
  // Kolejne moduły dopisują tu po jednej linii.
];

export function createPgHandler(routes = ROUTES) {
  return async function handle(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return json({ status: 'ok' });

    if (url.pathname.startsWith('/api/') && UNSAFE_METHODS.has(request.method) && !isSameOrigin(request)) {
      const exempt = routes.some((route) => typeof route.allowsCrossOrigin === 'function' && route.allowsCrossOrigin(request, url));
      if (!exempt) return json({ error: 'invalid_origin' }, 403);
    }

    if (url.pathname.startsWith('/api/') && !isMfaGateExempt(url.pathname)) {
      let gate;
      try {
        gate = await mfaGate(request, env);
      } catch (error) {
        logRouteError('mfa-gate', error);
        return json({ error: 'service_unavailable' }, 503);
      }
      if (gate) return json({ error: gate }, 403);
    }

    for (const route of routes) {
      try {
        const response = await route.handle(request, env, url, json);
        if (response) return response;
      } catch (error) {
        // Siec bezpieczeństwa (#156): jeśli moduł nie przetłumaczył wyjątku sam
        // (RequestError -> własna odpowiedź), rozróżniamy tu stan biznesowy
        // (409/422), błąd przejściowy (503 + Retry-After) i resztę (503 jak
        // dotychczas). src/pg/db-errors.js.
        const { error: code, status, retryAfter, class: errorClass } = classifyDbError(error);
        logRouteError(route.name ?? 'unknown', error, errorClass);
        const headers = retryAfter ? { 'Retry-After': String(retryAfter) } : {};
        return json({ error: code }, status, headers);
      }
    }
    return json({ error: 'not_found' }, 404);
  };
}

export const handlePgRequest = createPgHandler(ROUTES);
