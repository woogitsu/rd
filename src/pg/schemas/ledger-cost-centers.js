// Schematy OpenAPI dla modułu `ledger-cost-centers` (src/pg/routes/ledger-cost-centers.js, #117),
// #160 etap 4: wersje przypisania wpisu księgi do wydarzeń i klas, wynik per centrum kosztów
// (JSON, CSV, XLSX) i rozliczenie jednego wydarzenia. Pisane ręcznie na podstawie parsera
// (`parseAllocationInput`), mapperów (`allocationView`, `costCenterReport`, `readEventFinance`)
// i tests/pg-ledger-cost-centers.test.js; trasy się nie zmieniają.
import {
  CSV_CONTENT_TYPE, OCTET_XLSX, PII_ERRORS, formatsResponse, mergeErrors, nullable, ref, replayed, requestObject, strictObject,
} from './common.js';

export const name = 'ledger-cost-centers';

const MONEY_TRIPLE = strictObject({
  incomeCents: ref('NonNegativeCents'), expenseCents: ref('NonNegativeCents'), resultCents: ref('SignedCents'),
});

export const components = {
  LedgerCostCenterType: { type: 'string', enum: ['event', 'class'], description: 'event = wydarzenie, class = klasa.' },
  EventStatus: {
    type: 'string', enum: ['draft', 'submitted', 'approved', 'published', 'cancelled'],
    description: 'Status wydarzenia (postgres/migrations/0008_events.sql).',
  },
  LedgerAllocationItem: strictObject({
    eventId: nullable(ref('EntityId')),
    classId: nullable(ref('EntityId')),
    amountCents: ref('AmountCents'),
  }, [], { description: 'Pozycja przypisania: dokładnie jedno z `eventId`, `classId`.' }),
  LedgerAllocationVersion: strictObject({
    id: ref('EntityId'),
    versionNo: { type: 'integer', minimum: 1 },
    supersedesId: nullable(ref('EntityId')),
    reason: nullable({ type: 'string' }),
    createdBy: ref('EntityId'),
    createdAt: ref('IsoDateTime'),
    items: { type: 'array', items: ref('LedgerAllocationItem'), description: 'Pusta lista = cały wpis w „ogólne”.' },
  }),
  LedgerAllocation: strictObject({
    ledgerEntryId: ref('EntityId'),
    schoolYearId: ref('EntityId'),
    direction: ref('LedgerDirection'),
    netAmountCents: ref('NonNegativeCents'),
    currentVersionId: nullable({ ...ref('EntityId'), description: 'null, gdy wpis nie ma jeszcze przypisania.' }),
    allocatedCents: ref('NonNegativeCents'),
    generalCents: { ...ref('NonNegativeCents'), description: 'Netto wpisu minus suma bieżącej wersji (część „ogólne”).' },
    versions: { type: 'array', items: ref('LedgerAllocationVersion'), description: 'Wszystkie wersje od pierwszej (historia zostaje).' },
  }, [], { description: 'Przypisanie wpisu księgi do centrów kosztów z historią wersji.' }),
  LedgerCostCenterRow: strictObject({
    type: ref('LedgerCostCenterType'),
    id: ref('EntityId'),
    name: { type: 'string' },
    status: nullable({ ...ref('EventStatus'), description: 'Status wydarzenia; null dla klasy.' }),
    entryCount: ref('Count'),
    incomeCents: ref('NonNegativeCents'),
    expenseCents: ref('NonNegativeCents'),
    resultCents: ref('SignedCents'),
  }),
  LedgerCostCenterReport: strictObject({
    schoolYearId: ref('EntityId'),
    type: ref('LedgerCostCenterType'),
    centers: { type: 'array', items: ref('LedgerCostCenterRow'), description: 'Tylko centra z co najmniej jednym przypisaniem.' },
    general: { ...MONEY_TRIPLE, description: 'Część netto wpisów roku bez przypisania („ogólne”).' },
    totals: { ...MONEY_TRIPLE, description: 'Razem rok (= podsumowanie księgi): suma centrów + ogólne.' },
  }, [], { description: 'Wynik per centrum kosztów z bieżących wersji przypisania; bez wpłat rodzin.' }),
  LedgerEventFinance: strictObject({
    id: ref('EntityId'),
    schoolYearId: ref('EntityId'),
    title: { type: 'string' },
    status: ref('EventStatus'),
    incomeCents: ref('NonNegativeCents'),
    expenseCents: ref('NonNegativeCents'),
    resultCents: ref('SignedCents'),
    entries: {
      type: 'array',
      items: strictObject({
        ledgerEntryId: ref('EntityId'),
        versionId: ref('EntityId'),
        direction: ref('LedgerDirection'),
        occurredOn: ref('IsoDate'),
        categoryId: ref('EntityId'),
        categoryName: { type: 'string' },
        description: { type: 'string' },
        entryNetCents: ref('NonNegativeCents'),
        allocatedCents: ref('AmountCents'),
      }),
    },
  }, [], { description: 'Rozliczenie wydarzenia: wpisy przypisane w bieżących wersjach.' }),

  LedgerAllocationRequest: requestObject({
    items: {
      type: 'array', maxItems: 50,
      items: requestObject({
        eventId: { anyOf: [ref('Id'), { type: 'null' }], description: 'Wydarzenie tego samego roku co wpis.' },
        classId: { anyOf: [ref('Id'), { type: 'null' }], description: 'Klasa tego samego roku co wpis.' },
        amountCents: ref('AmountCents'),
      }, ['amountCents'], {
        anyOf: [{ required: ['eventId'] }, { required: ['classId'] }],
        description: 'Dokładnie jedno z `eventId`, `classId` (drugie pominięte albo null); centrum nie może się powtórzyć.',
      }),
      description: 'Pozycje nowej wersji (do 50); suma ≤ netto wpisu, pusta lista = cały wpis w „ogólne”.',
    },
    supersedesId: { anyOf: [ref('Id'), { type: 'null' }], description: 'Bieżąca wersja, którą ta zastępuje (null dla pierwszej).' },
    reason: {
      anyOf: [{ type: 'string', minLength: 3, maxLength: 500 }, { type: 'null' }],
      description: 'Powód zmiany (3-500 znaków); wymagany przy `supersedesId`; bramka danych osobowych (#152).',
    },
    confirmPersonalData: { type: 'boolean', description: 'true potwierdza ostrzeżenie bramki danych osobowych (#152).' },
  }, ['items']),
};

const MFA_DENY = { 403: ['forbidden', 'mfa_enrollment_required', 'mfa_required'] };
const allocation = strictObject({ allocation: ref('LedgerAllocation'), versionId: ref('EntityId') });

/** Klucz: `METODA /ścieżka-openapi` (jak w docs/openapi.json). */
export const routes = {
  'GET /api/ledger/{ledgerEntryId}/allocations': {
    responses: { 200: { description: 'Przypisanie wpisu z historią wersji.', schema: strictObject({ allocation: ref('LedgerAllocation') }) } },
    errors: mergeErrors(MFA_DENY, { 400: ['invalid_id'], 404: ['ledger_entry_not_found'] }),
  },
  'POST /api/ledger/{ledgerEntryId}/allocations': {
    idempotencyKey: true,
    body: ref('LedgerAllocationRequest'),
    responses: {
      201: replayed('false', 'Nowa wersja przypisania (`versionId`) i stan po zapisie.', allocation),
      200: replayed('true', 'Odtworzenie po tym samym kluczu idempotencji (bez nowej wersji).', allocation),
    },
    errors: mergeErrors(PII_ERRORS, MFA_DENY, {
      400: ['allocation_reason_required', 'invalid_allocation', 'invalid_cost_center', 'invalid_id', 'invalid_idempotency_key', 'invalid_json', 'invalid_reason'],
      403: ['invalid_origin'],
      404: ['ledger_entry_not_found'],
      409: ['allocation_exceeds_net', 'allocation_version_conflict', 'idempotency_conflict', 'school_year_closed'],
      413: ['request_too_large'],
      415: ['invalid_content_type'],
    }),
  },
  'GET /api/ledger/cost-centers': {
    query: {
      schoolYearId: { required: true, schema: ref('Id') },
      type: { schema: { ...ref('LedgerCostCenterType'), default: 'event' } },
      format: { schema: { type: 'string', enum: ['json', 'csv', 'xlsx'], default: 'json' } },
    },
    responses: {
      200: formatsResponse('Wynik per centrum kosztów: JSON (domyślnie), CSV UTF-8 albo arkusz XLSX (wiersze centrów, „ogólne” i „razem”).', {
        'application/json': strictObject({ report: ref('LedgerCostCenterReport') }),
        [CSV_CONTENT_TYPE]: { type: 'string' },
        [OCTET_XLSX]: { type: 'string', format: 'binary' },
      }),
    },
    errors: mergeErrors(MFA_DENY, { 400: ['invalid_request'], 404: ['school_year_not_found'] }),
  },
  'GET /api/ledger/cost-centers/events/{eventId}': {
    responses: { 200: { description: 'Rozliczenie jednego wydarzenia.', schema: strictObject({ event: ref('LedgerEventFinance') }) } },
    errors: mergeErrors(MFA_DENY, { 400: ['invalid_id'], 404: ['event_not_found'] }),
  },
};
