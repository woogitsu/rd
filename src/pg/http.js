import { log } from '../log.js';

// Wspólne odpowiedzi HTTP dla API na PostgreSQL.

export const JSON_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
});

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}

export const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Log techniczny bez danych osobowych: tylko nazwa modułu i kod błędu.
// Nie logujemy error.message ani error.detail — PostgreSQL potrafi w nich
// umieścić wartości kolumn (np. adres e-mail przy naruszeniu UNIQUE).
// errorClass (#156, src/pg/db-errors.js): 'business' | 'transient' | 'bug' —
// pozwala alertom (#149) nie liczyć odmów stanu i błędów przejściowych jako
// awarii. Domyślnie 'bug', jak dotychczasowe zachowanie tego loga.
export function logRouteError(routeName, error, errorClass = 'bug') {
  const code = typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(error.code) ? error.code : null;
  const kind = typeof error?.name === 'string' && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'Error';
  const cls = ['business', 'transient', 'bug'].includes(errorClass) ? errorClass : 'bug';
  log.error('api_route_error', { module: String(routeName), code: code ?? kind, class: cls });
}
