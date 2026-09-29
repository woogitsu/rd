// Klasyfikacja błędów bazy w routerze (issue #156).
//
// src/pg/app.js zamieniał KAŻDY nieprzechwycony wyjątek modułu na
// 503 service_unavailable, niezależnie od tego, czy to awaria bazy, czy
// odmowa stanu biznesowego (np. trigger a0_year_freeze z 0017_year_close.sql).
// Moduły z własnym mapDatabaseError (payments.js, ledger.js, reconciliation.js,
// year-close.js, email.js, events.js, news.js, meetings.js) rzucają RequestError
// PRZED dotarciem tutaj — ta funkcja jest siecią bezpieczeństwa w app.js dla
// wyjątków, których dany moduł jeszcze nie przetłumaczył sam (nowy trigger,
// literówka w komunikacie, moduł napisany bez własnego mapowania).
//
// Trzy kategorie (użyte też przez logRouteError jako `class`, żeby alerty
// #149 nie liczyły odmów biznesowych i błędów przejściowych jako awarii):
//   business  — stan aplikacji, nie awaria: 409/422, bez Retry-After.
//   transient — błąd bazy, który zwykle znika przy ponowieniu tej samej
//               operacji (rywalizacja o blokadę, timeout instrukcji):
//               503 + Retry-After.
//   outcome_unknown — błąd w trakcie COMMIT (src/db.js): nie wiadomo, czy zapis
//               się utrwalił. 503 `commit_outcome_unknown` BEZ Retry-After;
//               klient sprawdza stan, dopiero potem ponawia.
//   bug       — coś nieprzewidzianego: 503 bez Retry-After, jak dotychczas.

// Wyjątki triggerów (RAISE EXCEPTION 'komunikat') zgłaszane samym tekstem
// komunikatu, bez osobnego SQLSTATE — rozpoznajemy je po treści.
const BUSINESS_MESSAGES = new Map([
  ['school_year_closed', { error: 'school_year_closed', status: 409 }],
  ['school_year_closure_is_final', { error: 'school_year_closed', status: 409 }],
]);

// SQLSTATE błędów przejściowych: 40001 serialization_failure, 40P01
// deadlock_detected, 55P03 lock_not_available (np. SELECT … NOWAIT),
// 57014 query_canceled (najczęściej statement_timeout, src/db.js).
const TRANSIENT_CODES = new Map([
  ['40001', { error: 'retry_later', status: 503, retryAfter: 1 }],
  ['40P01', { error: 'retry_later', status: 503, retryAfter: 1 }],
  ['55P03', { error: 'retry_later', status: 503, retryAfter: 1 }],
  ['57014', { error: 'timeout', status: 503, retryAfter: 5 }],
]);

// error: wyjątek złapany w app.js (błąd pg/PGlite albo Error z RAISE
// EXCEPTION triggera). Zwraca { error, status, retryAfter?, class }.
export function classifyDbError(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const business = BUSINESS_MESSAGES.get(message);
  if (business) return { ...business, class: 'business' };
  const code = typeof error?.code === 'string' ? error.code : null;
  if (code === 'commit_outcome_unknown') return { error: 'commit_outcome_unknown', status: 503, class: 'outcome_unknown' };
  const transient = code ? TRANSIENT_CODES.get(code) : undefined;
  if (transient) return { ...transient, class: 'transient' };
  return { error: 'service_unavailable', status: 503, class: 'bug' };
}
