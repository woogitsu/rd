import { log } from '../log.js';

// Wspólne odpowiedzi HTTP dla API na PostgreSQL.

export const JSON_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
});

// Wartość tablicowa (np. dwa nagłówki Set-Cookie przy wylogowaniu, #114) daje
// osobne nagłówki — jeden łączony przecinkiem byłby niepoprawnym Set-Cookie.
export function buildHeaders(headers = {}) {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) { result.delete(name); for (const item of value) result.append(name, item); }
    else result.set(name, value);
  }
  return result;
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: buildHeaders({ ...JSON_HEADERS, ...headers }) });
}

// Metody bezpieczne (po #748): wyłącznie GET i HEAD. Każda inna metoda — także
// OPTIONS i metoda nieznana — jest traktowana jak zapis: router wymaga dla niej
// zgodnego Origin i blokuje ją w trybie tylko do odczytu, zanim trafi do modułu.
// API nie obsługuje CORS (aplikacja jednego originu), więc OPTIONS nie ma
// legalnego użycia. HEAD nie zmienia danych i nie jest obsługiwany przez żadną
// trasę /api/: moduł odpowiada na niego 404 albo 405 z Allow, jak na każdą
// nieobsługiwaną metodę (docs/API.md, „Metody HTTP a zapis”).
export function isSafeMethod(method) {
  return method === 'GET' || method === 'HEAD';
}

// Log techniczny bez danych osobowych: tylko nazwa modułu i kod błędu.
// Nie logujemy error.message ani error.detail — PostgreSQL potrafi w nich
// umieścić wartości kolumn (np. adres e-mail przy naruszeniu UNIQUE).
// errorClass (#156, src/pg/db-errors.js): 'business' | 'transient' | 'outcome_unknown' | 'bug' —
// pozwala alertom (#149) nie liczyć odmów stanu i błędów przejściowych jako
// awarii. Domyślnie 'bug', jak dotychczasowe zachowanie tego loga.
export function logRouteError(routeName, error, errorClass = 'bug') {
  const code = typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(error.code) ? error.code : null;
  const kind = typeof error?.name === 'string' && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'Error';
  const cls = ['business', 'transient', 'outcome_unknown', 'bug'].includes(errorClass) ? errorClass : 'bug';
  log.error('api_route_error', { module: String(routeName), code: code ?? kind, class: cls });
}
