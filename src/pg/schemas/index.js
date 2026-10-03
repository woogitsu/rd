// Rejestr schematów OpenAPI (#160, etapy 2-5) i jawny rejestr pokrycia.
//
// Każdy plik `src/pg/schemas/<moduł>.js` eksportuje:
//   name        nazwa modułu tras (jak `name` w src/pg/routes/*.js i `module` w macierzy tras),
//   components  schematy współdzielone w `components.schemas` (nazwy unikalne w całej specyfikacji),
//   routes      { 'METODA /ścieżka-openapi': wpis } — ścieżka z `{param}`, bez zapytania.
//
// Wpis trasy (wszystkie pola poza `responses` opcjonalne):
//   body            schemat ciała żądania JSON,
//   idempotencyKey  true (wymagany nagłówek Idempotency-Key) albo 'optional',
//   query           { nazwa: { schema, required?, description? } } — parametry zapytania ponad tymi z macierzy,
//   responses       { status: { description, schema?, contentType?, content?, replayed? } } — odpowiedzi
//                   sukcesu z kształtem; `replayed: 'true'|'false'` dodaje nagłówek Idempotency-Replayed
//                   (lista `['false', 'true']`, gdy ten sam status zwraca obie wartości, np. zatwierdzenie
//                   uzgodnienia bez klucza idempotencji);
//                   `content` = { typ treści: schemat } dla trasy z kilkoma formatami (parametr `format`,
//                   helper `formatsResponse`); bez `schema` i `content` = odpowiedź bez treści (np. 204),
//   errors          { status: [kody] } — kody błędów tej trasy; muszą istnieć w docs/API_ERRORS.md.
//                   Pusta lista = status z macierzy tras, którego trasa w praktyce nie zwraca.
//
// Generator (scripts/build-openapi.js) dołącza wpisy do operacji z macierzy tras
// (tests/helpers/route-matrix.js); tests/openapi-contract.test.js sprawdza pokrycie
// i waliduje rzeczywiste odpowiedzi tras względem tych schematów.
//
// KOLEJNE PR-y zmniejszają UNCOVERED_MODULES: dopisz plik schematów modułu, dodaj go do
// SCHEMA_MODULES, usuń nazwę z UNCOVERED_MODULES i uruchom `npm run openapi:build`.
// Test pilnuje, że lista pokrywa dokładnie moduły macierzy bez schematów i nie rośnie.
import * as paymentInstructions from './payment-instructions.js';
import * as paymentReferences from './payment-references.js';
import * as payments from './payments.js';
import * as ledger from './ledger.js';
import * as ledgerBudget from './ledger-budget.js';
import * as ledgerCash from './ledger-cash.js';
import * as ledgerCostCenters from './ledger-cost-centers.js';
import * as families from './families.js';
import * as reconciliation from './reconciliation.js';
import * as session from './session.js';
import { COMMON_COMPONENTS } from './common.js';

export const SCHEMA_MODULES = Object.freeze([
  families, ledger, ledgerBudget, ledgerCash, ledgerCostCenters, paymentInstructions, paymentReferences, payments,
  reconciliation, session,
]);

// Moduły z macierzy tras, które NIE mają jeszcze schematów (stan po etapie 5: wpłaty, księga
// z preliminarzem, kasą i centrami kosztów, rodziny, sesja i uzgodnienia wyciągów bankowych).
export const UNCOVERED_MODULES = Object.freeze([
  'admin', 'audit-history', 'audit-reviews', 'board', 'documents', 'email', 'events', 'exports',
  'financial-reports', 'guardian-updates', 'import', 'login', 'meetings', 'mfa', 'news', 'print',
  'privacy-notice', 'representative', 'year-close',
]);

export const COVERED_MODULES = Object.freeze(SCHEMA_MODULES.map((module) => module.name).sort());

/** Mapa `METODA /ścieżka` → wpis trasy z nazwą modułu. */
export const ROUTE_SCHEMAS = (() => {
  const map = new Map();
  for (const module of SCHEMA_MODULES) {
    for (const [key, entry] of Object.entries(module.routes)) {
      if (map.has(key)) throw new Error(`schemat trasy zdefiniowany dwa razy: ${key}`);
      map.set(key, { ...entry, module: module.name });
    }
  }
  return map;
})();

/** Wspólne i modułowe schematy dla `components.schemas` (nazwy muszą być unikalne). */
export function schemaComponents() {
  const merged = { ...COMMON_COMPONENTS };
  for (const module of SCHEMA_MODULES) {
    for (const [name, schema] of Object.entries(module.components)) {
      if (Object.hasOwn(merged, name)) throw new Error(`schemat komponentu zdefiniowany dwa razy: ${name} (${module.name})`);
      merged[name] = schema;
    }
  }
  return merged;
}
