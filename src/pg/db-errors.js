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
//   bug       — coś nieprzewidzianego (w tym brak łączności z bazą): 503
//               service_unavailable bez szczegółów, jak dotychczas (kontrakt
//               testów i paneli); treść błędu SQL trafia tylko do kodu w logu.

import { BUSINESS_STATE_CODES, IMMUTABILITY_PATTERN } from './business-state-codes.js';

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

// Ograniczenia deklaratywne (klasa 23) — jedna tabela dla wszystkich tras.
// Moduły z własnym mapowaniem (np. konkretna nazwa ograniczenia) rzucają
// RequestError wcześniej; tu trafia to, czego nie przetłumaczyły.
const CONSTRAINT_CODES = new Map([
  ['23505', { error: 'conflict', status: 409 }], // unique_violation
  ['23P01', { error: 'conflict', status: 409 }], // exclusion_violation
  ['23503', { error: 'invalid_reference', status: 400 }], // foreign_key_violation
  ['23514', { error: 'invalid_request', status: 400 }], // check_violation
  ['23502', { error: 'invalid_request', status: 400 }], // not_null_violation
]);

// RAISE EXCEPTION 'nazwa_stanu' w triggerze ma SQLSTATE P0001. Za stan
// biznesowy uznajemy tylko kody z jawnej listy (business-state-codes.js) albo
// wzorca niezmienności; reszta to 503 bez szczegółów, a treść błędu trafia
// wyłącznie do logu.
const RAISE_EXCEPTION = 'P0001';

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
  const constraint = code ? CONSTRAINT_CODES.get(code) : undefined;
  if (constraint) return { ...constraint, class: 'business' };
  if (code === RAISE_EXCEPTION && message === 'invalid_reference') return { error: 'invalid_reference', status: 400, class: 'business' };
  if (code === RAISE_EXCEPTION && (BUSINESS_STATE_CODES.has(message) || IMMUTABILITY_PATTERN.test(message))) {
    return { error: 'business_rule_violation', status: 409, class: 'business' };
  }
  return { error: 'service_unavailable', status: 503, class: 'bug' };
}
