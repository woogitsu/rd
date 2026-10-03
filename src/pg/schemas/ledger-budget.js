// Schematy OpenAPI dla modułu `ledger-budget` (src/pg/routes/ledger-budget.js, #107), #160 etap 4:
// wyłączenie kategorii z historią, wersje linii preliminarza, przyjęcie preliminarza przez
// zebranie, historia i zestawienie plan vs wykonanie (JSON, CSV, XLSX, HTML).
// Pisane ręcznie na podstawie parserów (`createLine`, `reviseLine`, `createAdoption`), mapperów
// (`lineFromRow`, `buildBudgetExecution`) i tests/pg-ledger-budget.test.js; trasy się nie zmieniają.
// Bieżący preliminarz (`GET /api/ledger/budget`) i tworzenie kategorii należą do modułu `ledger`.
import {
  CSV_CONTENT_TYPE, HTML_CONTENT_TYPE, OCTET_XLSX, PII_ERRORS, formatsResponse, mergeErrors, nullable, ref, replayed,
  requestObject, strictObject,
} from './common.js';

export const name = 'ledger-budget';

const CONFIRM = {
  type: 'boolean',
  description: 'true potwierdza ostrzeżenie bramki danych osobowych (#152), np. 422 `possible_personal_data`.',
};
const TEXT_3_500 = (description) => ({ type: 'string', minLength: 3, maxLength: 500, description });
const PLANNED = {
  type: 'integer', minimum: 0, maximum: 100000000,
  description: 'Kwota planu w eurocentach (EUR), 0-1 000 000,00 EUR; plan zerowy jest dozwolony.',
};

const LINE_PROPERTIES = {
  id: ref('EntityId'),
  schoolYearId: ref('EntityId'),
  categoryId: ref('EntityId'),
  plannedCents: ref('NonNegativeCents'),
  note: nullable({ type: 'string', description: 'Uwaga pierwszej wersji albo powód rewizji.' }),
  supersedesId: nullable({ ...ref('EntityId'), description: 'Wersja, którą ta zastępuje (null dla pierwszej wersji).' }),
  createdBy: ref('EntityId'),
  createdAt: ref('IsoDateTime'),
};

const EXECUTION_TOTALS = strictObject({
  adoptedPlanCents: nullable({ ...ref('NonNegativeCents'), description: 'null, gdy preliminarz nie był przyjęty (na dzień `asOf`).' }),
  currentPlanCents: ref('NonNegativeCents'),
  executedNetCents: ref('NonNegativeCents'),
  outsidePlanNetCents: ref('NonNegativeCents'),
});

export const components = {
  LedgerCategoryDeactivation: strictObject({
    id: ref('EntityId'), categoryId: ref('EntityId'), reason: { type: 'string' },
  }, [], { description: 'Wpis historii wyłączenia kategorii (niezmienny).' }),
  LedgerBudgetLineVersion: strictObject(LINE_PROPERTIES, [], {
    description: 'Wersja linii preliminarza po zapisie albo odtworzeniu po kluczu idempotencji.',
  }),
  LedgerBudgetLineHistoryItem: strictObject({
    ...LINE_PROPERTIES,
    categoryName: { type: 'string' },
    direction: ref('LedgerDirection'),
    supersededById: nullable(ref('EntityId')),
    current: { type: 'boolean', description: 'true = bieżąca wersja (żadna nowsza jej nie zastępuje).' },
  }, [], { description: 'Każda wersja linii preliminarza roku (także zastąpione).' }),
  LedgerBudgetAdoption: strictObject({
    id: ref('EntityId'),
    schoolYearId: ref('EntityId'),
    adoptedOn: ref('IsoDate'),
    note: { type: 'string' },
    resolutionId: nullable(ref('EntityId')),
    lineIds: { type: 'array', items: ref('EntityId'), minItems: 1, description: 'Bieżące wersje linii zamrożone przy przyjęciu.' },
  }, [], { description: 'Przyjęcie preliminarza przez zebranie (D-21: uchwała opcjonalna).' }),
  LedgerBudgetAdoptionHistoryItem: strictObject({
    id: ref('EntityId'),
    adoptedOn: ref('IsoDate'),
    note: { type: 'string' },
    resolutionId: nullable(ref('EntityId')),
    resolutionNumber: nullable({ type: 'string' }),
    adoptedBy: ref('EntityId'),
    adoptedAt: ref('IsoDateTime'),
    lineIds: { type: 'array', items: ref('EntityId'), minItems: 1 },
  }),
  LedgerBudgetExecutionItem: strictObject({
    categoryId: ref('EntityId'),
    direction: ref('LedgerDirection'),
    categoryName: { type: 'string' },
    active: { type: 'boolean' },
    lineId: nullable({ ...ref('EntityId'), description: 'Bieżąca wersja linii; null = kategoria poza planem.' }),
    adoptedPlanCents: nullable(ref('NonNegativeCents')),
    currentPlanCents: nullable(ref('NonNegativeCents')),
    executedNetCents: ref('NonNegativeCents'),
    entryCount: ref('Count'),
    differenceCents: nullable({ ...ref('SignedCents'), description: 'Plan bieżący minus wykonanie; null bez planu.' }),
    executionPercent: nullable({ type: 'number', minimum: 0, description: 'Wykonanie w procentach planu (jedno miejsce po przecinku); null bez planu lub przy planie 0.' }),
    outsidePlan: { type: 'boolean' },
    overBudget: { type: 'boolean', description: 'Tylko wydatek: wykonanie ponad plan bieżący.' },
  }),
  LedgerBudgetExecution: strictObject({
    schoolYearId: ref('EntityId'),
    asOf: nullable(ref('IsoDate')),
    adoption: nullable(strictObject({
      id: ref('EntityId'), adoptedOn: ref('IsoDate'), resolutionId: nullable(ref('EntityId')), resolutionNumber: nullable({ type: 'string' }),
    })),
    items: { type: 'array', items: ref('LedgerBudgetExecutionItem') },
    totals: strictObject({ income: EXECUTION_TOTALS, expense: EXECUTION_TOTALS }),
    check: nullable(strictObject({
      ok: { type: 'boolean', description: 'Suma wykonania = przychody/wydatki z podsumowania księgi.' },
      summaryIncomeCents: ref('NonNegativeCents'),
      summaryExpenseCents: ref('NonNegativeCents'),
    }, [], { description: 'Kontrola zgodności z podsumowaniem roku; null przy `asOf`.' })),
  }, [], { description: 'Plan (przyjęty i bieżący) vs wykonanie netto per kategoria, w eurocentach.' }),

  LedgerCategoryDeactivationRequest: requestObject({
    reason: TEXT_3_500('Powód wyłączenia (3-500 znaków po przycięciu spacji); bramka danych osobowych (#152).'),
    confirmPersonalData: CONFIRM,
  }, ['reason']),
  LedgerBudgetLineCreateRequest: requestObject({
    schoolYearId: ref('Id'),
    categoryId: { ...ref('Id'), description: 'Aktywna kategoria tego roku; jedna pierwsza wersja linii na kategorię.' },
    plannedCents: PLANNED,
    note: { anyOf: [TEXT_3_500('Uwaga (3-500 znaków); pusty tekst = brak uwagi.'), { type: 'null' }] },
    confirmPersonalData: CONFIRM,
  }, ['schoolYearId', 'categoryId', 'plannedCents']),
  LedgerBudgetLineRevisionRequest: requestObject({
    plannedCents: PLANNED,
    reason: TEXT_3_500('Powód rewizji (3-500 znaków); zapisany jako `note` nowej wersji.'),
    confirmPersonalData: CONFIRM,
  }, ['plannedCents', 'reason']),
  LedgerBudgetAdoptionRequest: requestObject({
    schoolYearId: ref('Id'),
    adoptedOn: ref('IsoDate'),
    note: TEXT_3_500('Opis przyjęcia (3-500 znaków); bramka danych osobowych (#152).'),
    resolutionId: { anyOf: [ref('Id'), { type: 'null' }], description: 'Przyjęta, bieżąca uchwała zebrania ogólnego tego roku (opcjonalna).' },
    confirmPersonalData: CONFIRM,
  }, ['schoolYearId', 'adoptedOn', 'note']),
};

const YEAR_QUERY = { schoolYearId: { required: true, schema: ref('Id') } };
const MFA_DENY = { 403: ['forbidden', 'mfa_enrollment_required', 'mfa_required'] };
const READ_ERROR_SET = mergeErrors({ 400: ['invalid_request'] }, MFA_DENY);
// Zapis z kluczem idempotencji: wspólne błędy czytnika ciała i klucza (src/pg/input.js) i routera.
const WRITE_ERROR_SET = mergeErrors(PII_ERRORS, MFA_DENY, {
  400: ['invalid_idempotency_key', 'invalid_json'],
  403: ['invalid_origin'],
  409: ['idempotency_conflict', 'school_year_closed'],
  413: ['request_too_large'],
  415: ['invalid_content_type'],
});

const written = (description, schema) => ({
  201: replayed('false', description, schema),
  200: replayed('true', 'Odtworzenie po tym samym kluczu idempotencji (bez nowego zapisu).', schema),
});

/** Klucz: `METODA /ścieżka-openapi` (jak w docs/openapi.json). */
export const routes = {
  'POST /api/ledger/categories/{categoryId}/deactivation': {
    idempotencyKey: true,
    body: ref('LedgerCategoryDeactivationRequest'),
    responses: written('Wyłączenie kategorii z wpisem historii (nowy zapis).', strictObject({ deactivation: ref('LedgerCategoryDeactivation') })),
    errors: mergeErrors(WRITE_ERROR_SET, {
      400: ['invalid_reason', 'invalid_request'],
      404: ['category_not_found'],
      409: ['category_inactive'],
    }),
  },
  'POST /api/ledger/budget': {
    idempotencyKey: true,
    body: ref('LedgerBudgetLineCreateRequest'),
    responses: written('Pierwsza wersja linii preliminarza (nowy zapis).', strictObject({ line: ref('LedgerBudgetLineVersion') })),
    errors: mergeErrors(WRITE_ERROR_SET, {
      400: ['invalid_amount', 'invalid_category', 'invalid_request'],
      409: ['budget_line_exists'],
    }),
  },
  'POST /api/ledger/budget/{lineId}/revisions': {
    idempotencyKey: true,
    body: ref('LedgerBudgetLineRevisionRequest'),
    responses: written('Nowa wersja linii wskazująca poprzednią (`supersedesId`); poprzednia zostaje w historii.',
      strictObject({ line: ref('LedgerBudgetLineVersion') })),
    errors: mergeErrors(WRITE_ERROR_SET, {
      400: ['invalid_amount', 'invalid_reason', 'invalid_request'],
      404: ['budget_line_not_found'],
      409: ['budget_line_superseded'],
    }),
  },
  'POST /api/ledger/budget/adoptions': {
    idempotencyKey: true,
    body: ref('LedgerBudgetAdoptionRequest'),
    responses: written('Przyjęcie preliminarza z zestawem bieżących wersji linii (nowy zapis).', strictObject({ adoption: ref('LedgerBudgetAdoption') })),
    errors: mergeErrors(WRITE_ERROR_SET, {
      400: ['invalid_reason', 'invalid_request'],
      404: ['resolution_not_found', 'school_year_not_found'],
      409: ['budget_empty'],
    }),
  },
  'GET /api/ledger/budget/history': {
    query: YEAR_QUERY,
    responses: {
      200: {
        description: 'Wszystkie wersje linii preliminarza roku i wszystkie przyjęcia (bez kursora: pełna historia).',
        schema: strictObject({
          lines: { type: 'array', items: ref('LedgerBudgetLineHistoryItem') },
          adoptions: { type: 'array', items: ref('LedgerBudgetAdoptionHistoryItem') },
        }),
      },
    },
    errors: READ_ERROR_SET,
  },
  'GET /api/ledger/budget/execution': {
    query: {
      ...YEAR_QUERY,
      asOf: { schema: ref('IsoDate'), description: 'Wykonanie na dzień: wpisy do tej daty i ostatnie przyjęcie do tej daty.' },
      format: { schema: { type: 'string', enum: ['json', 'csv', 'xlsx', 'html'], default: 'json' }, description: 'csv, xlsx i html zapisują zdarzenie eksportu w dzienniku.' },
    },
    responses: {
      200: formatsResponse('Zestawienie plan vs wykonanie: JSON (domyślnie), CSV UTF-8, arkusz XLSX albo raport HTML do wydruku.', {
        'application/json': strictObject({ execution: ref('LedgerBudgetExecution') }),
        [CSV_CONTENT_TYPE]: { type: 'string' },
        [OCTET_XLSX]: { type: 'string', format: 'binary' },
        [HTML_CONTENT_TYPE]: { type: 'string' },
      }),
    },
    errors: mergeErrors(READ_ERROR_SET, { 404: ['school_year_not_found'] }),
  },
};
