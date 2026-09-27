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
export function logRouteError(routeName, error) {
  const code = typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(error.code) ? error.code : null;
  const kind = typeof error?.name === 'string' && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'Error';
  console.error(`[api] route=${routeName} error=${code ?? kind}`);
}
