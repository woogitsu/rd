// Schematy OpenAPI dla modułu `ledger` (src/pg/routes/ledger.js), #160 etap 2: księga,
// korekty, przeksięgowanie, kategorie, podsumowanie, preliminarz, weryfikacja wydatków
// przez drugą osobę (#97) i uchwały jako upoważnienie do wydatku (#93).
// Pisane ręcznie na podstawie parserów (`parseEntryInput` …), mapperów (`entryFromRow` …)
// i testów API; trasy się nie zmieniają. Pozostałe moduły księgi (ledger-budget, ledger-cash,
// ledger-cost-centers) mają własne pliki w kolejnych etapach.
import {
  CSV_CONTENT_TYPE, OCTET_XLSX, PII_ERRORS, READ_ERRORS, WRITE_ERRORS,
  fileResponse, mergeErrors, nullable, ref, replayed, requestObject, strictObject,
} from './common.js';

export const name = 'ledger';

const REASON = {
  type: 'string', minLength: 3, maxLength: 500,
  description: 'Powód (3-500 znaków po przycięciu spacji). Niezmienny zapis; bez danych osobowych (bramka #152).',
};
const CONFIRM = {
  type: 'boolean',
  description: 'true potwierdza ostrzeżenie bramki danych osobowych (#152), np. 422 `possible_personal_data`.',
};

const ENTRY_PROPERTIES = {
  id: ref('EntityId'),
  schoolYearId: ref('EntityId'),
  direction: ref('LedgerDirection'),
  amountCents: ref('AmountCents'),
  categoryId: ref('EntityId'),
  description: { type: 'string' },
  occurredOn: ref('IsoDate'),
  paymentEntryId: nullable(ref('EntityId')),
  sourceDocumentId: nullable(ref('EntityId')),
  method: ref('LedgerMethod'),
  source: nullable({ type: 'string' }),
  resolutionReference: nullable({ type: 'string' }),
  // Pola dodawane tylko dla wpisów, których to dotyczy (kształt zwykłego wpisu bez zmian).
  resolutionId: ref('EntityId'),
  replacesEntryId: ref('EntityId'),
};
const ENTRY_OPTIONAL = ['resolutionId', 'replacesEntryId'];

const CATEGORY_ITEM = { direction: ref('LedgerDirection'), name: { type: 'string' } };

export const components = {
  LedgerDirection: { type: 'string', enum: ['income', 'expense'], description: 'income = przychód, expense = wydatek.' },
  LedgerMethod: { type: 'string', enum: ['bank', 'cash', 'card', 'other'], description: 'bank = przelew, cash = gotówka, card = karta, other = inna.' },
  LedgerEntry: strictObject({
    ...ENTRY_PROPERTIES,
    reason: { type: 'string', description: 'Tylko w odpowiedzi 201 przeksięgowania: powód przeksięgowania (nie ma go w odtworzeniu po kluczu).' },
  }, [...ENTRY_OPTIONAL, 'reason'], {
    description: 'Wpis księgi po zapisie albo odtworzeniu po kluczu idempotencji (bez pól wyliczanych listy).',
  }),
  LedgerEntryAttachment: strictObject({
    documentId: ref('EntityId'),
    status: { type: 'string', enum: ['active', 'superseded', 'voided'] },
    currentDocumentId: nullable(ref('EntityId')),
  }, [], { description: 'Stan dowodu wpisu i jego aktualna wersja (łańcuch zastąpień dokumentów).' }),
  LedgerEntryListItem: strictObject({
    ...ENTRY_PROPERTIES,
    categoryName: { type: 'string' },
    correctedCents: ref('NonNegativeCents'),
    netAmountCents: ref('NonNegativeCents'),
    attachmentIds: { type: 'array', items: ref('EntityId') },
    attachments: { type: 'array', items: ref('LedgerEntryAttachment') },
    replacedByEntryId: ref('EntityId'),
    paymentLinked: { type: 'boolean', const: true, description: 'Widok Komisji Rewizyjnej (D-09): wpis powiązany z wpłatą bez opisu, źródła i identyfikatora wpłaty.' },
  }, [...ENTRY_OPTIONAL, 'replacedByEntryId', 'paymentLinked'], { description: 'Wpis księgi na liście: z kategorią, sumą korekt, kwotą netto i dowodami.' }),
  LedgerCorrection: strictObject({
    id: ref('EntityId'), ledgerEntryId: ref('EntityId'), amountCents: ref('AmountCents'), reason: { type: 'string' },
  }),
  LedgerReplacementResult: strictObject({
    entry: ref('LedgerEntry'),
    warnings: {
      type: 'array',
      items: strictObject({
        type: { type: 'string', const: 'confirmed_reconciliation_affected' },
        reconciliationIds: { type: 'array', items: ref('EntityId'), minItems: 1 },
      }),
      description: 'Tylko, gdy przeksięgowanie dotyka potwierdzonego uzgodnienia bankowego.',
    },
  }, ['warnings']),
  LedgerCategory: strictObject({
    id: ref('EntityId'), schoolYearId: ref('EntityId'), direction: ref('LedgerDirection'), name: { type: 'string' }, active: { type: 'boolean' },
  }),
  LedgerCategoryListItem: strictObject({ id: ref('EntityId'), direction: ref('LedgerDirection'), name: { type: 'string' } }),
  LedgerCategoryCopyResult: strictObject({
    dryRun: { type: 'boolean' },
    copied: { type: 'array', items: strictObject({ id: ref('EntityId'), ...CATEGORY_ITEM }, ['id']), description: 'Skopiowane kategorie (`id` tylko przy zapisie, nie przy `dryRun`).' },
    skipped: { type: 'array', items: strictObject(CATEGORY_ITEM), description: 'Kategorie już istniejące w roku docelowym (podgląd `dryRun`).' },
    skippedCount: { type: 'integer', minimum: 0, description: 'Liczba pominiętych kategorii przy zapisie.' },
  }, ['skipped', 'skippedCount']),
  LedgerSummary: strictObject({
    schoolYearId: ref('EntityId'),
    openingBalanceCents: ref('SignedCents'),
    incomeCents: ref('SignedCents'),
    expenseCents: ref('SignedCents'),
    closingBalanceCents: ref('SignedCents'),
  }, [], { description: 'Bilans otwarcia, przychody, wydatki i bilans zamknięcia roku (EUR, eurocenty).' }),
  LedgerBudgetLine: strictObject({
    id: ref('EntityId'), categoryId: ref('EntityId'), categoryName: { type: 'string' }, direction: ref('LedgerDirection'),
    plannedCents: ref('NonNegativeCents'), note: nullable({ type: 'string' }), supersedesId: nullable(ref('EntityId')),
  }, [], { description: 'Bieżąca wersja pozycji preliminarza (poprzednie wersje zostają w historii).' }),
  LedgerReview: strictObject({
    id: ref('EntityId'),
    ledgerEntryId: ref('EntityId'),
    decision: { type: 'string', enum: ['verified', 'questioned'] },
    note: nullable({ type: 'string' }),
    reviewedBy: ref('EntityId'),
    reviewedAt: ref('IsoDateTime'),
  }),
  LedgerReviewListItem: strictObject({
    ledgerEntryId: ref('EntityId'),
    reviewStatus: { type: 'string', enum: ['unverified', 'verified', 'questioned'] },
    reviewCount: ref('Count'),
    lastReviewedBy: nullable(ref('EntityId')),
    lastReviewedAt: nullable(ref('IsoDateTime')),
    occurredOn: ref('IsoDate'),
    description: { type: 'string' },
    categoryName: { type: 'string' },
    netAmountCents: ref('NonNegativeCents'),
    createdBy: ref('EntityId'),
  }),
  LedgerResolutionSpending: strictObject({
    id: ref('EntityId'),
    schoolYearId: ref('EntityId'),
    number: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'string', const: 'adopted' },
    decidedAt: nullable(ref('IsoDateTime')),
    authorizationId: nullable(ref('EntityId')),
    authorizedAmountCents: nullable(ref('NonNegativeCents')),
    validUntil: nullable(ref('IsoDate')),
    spentNetCents: ref('NonNegativeCents'),
    remainingCents: nullable(ref('SignedCents')),
    entryCount: ref('Count'),
  }, [], { description: 'Przyjęta, bieżąca uchwała zebrania ogólnego z upoważnieniem do wydatku i dotychczasowymi wydatkami (netto).' }),
  LedgerResolutionAuthorization: strictObject({
    id: ref('EntityId'),
    resolutionId: ref('EntityId'),
    authorizedAmountCents: ref('AmountCents'),
    validUntil: nullable(ref('IsoDate')),
    note: { type: 'string' },
    supersedesId: nullable(ref('EntityId')),
  }),

  LedgerEntryCreateRequest: requestObject({
    schoolYearId: ref('Id'),
    direction: ref('LedgerDirection'),
    amountCents: ref('AmountCents'),
    categoryId: { ...ref('Id'), description: 'Aktywna kategoria tego roku i kierunku.' },
    description: { type: 'string', minLength: 3, maxLength: 500, description: 'Opis (3-500 znaków po przycięciu spacji); bramka danych osobowych (#152).' },
    occurredOn: ref('IsoDate'),
    method: ref('LedgerMethod'),
    paymentEntryId: { anyOf: [ref('Id'), { type: 'null' }], description: 'Wpłata ujęta w księdze (tylko przychód; kwota = netto wpłaty).' },
    sourceDocumentId: { anyOf: [ref('Id'), { type: 'null' }], description: 'Dokument finansowy tego roku jako dowód.' },
    source: { anyOf: [{ type: 'string', maxLength: 200 }, { type: 'null' }] },
    resolutionReference: { anyOf: [{ type: 'string', maxLength: 200 }, { type: 'null' }], description: 'Numer uchwały; wymagany (albo `resolutionId`) dla wydatku powyżej 3000,00 EUR.' },
    resolutionId: { anyOf: [ref('Id'), { type: 'null' }], description: 'Jawne wskazanie uchwały (#93), tylko dla wydatku.' },
    confirmPersonalData: CONFIRM,
  }, ['schoolYearId', 'direction', 'amountCents', 'categoryId', 'description', 'occurredOn', 'method']),
  LedgerCorrectionRequest: requestObject({
    amountCents: { ...ref('AmountCents'), description: 'Kwota korekty (zmniejszenie wpisu); suma korekt nie może przekroczyć kwoty wpisu.' },
    reason: REASON,
    confirmPersonalData: CONFIRM,
  }, ['amountCents', 'reason']),
  LedgerReplacementRequest: requestObject({
    schoolYearId: ref('Id'),
    direction: ref('LedgerDirection'),
    amountCents: ref('AmountCents'),
    categoryId: ref('Id'),
    description: { type: 'string', minLength: 3, maxLength: 500 },
    occurredOn: ref('IsoDate'),
    method: ref('LedgerMethod'),
    paymentEntryId: { anyOf: [ref('Id'), { type: 'null' }], description: 'Tylko potwierdzenie powiązania wpisu zastępowanego (nowe powiązanie nie powstaje).' },
    sourceDocumentId: { anyOf: [ref('Id'), { type: 'null' }] },
    source: { anyOf: [{ type: 'string', maxLength: 200 }, { type: 'null' }] },
    resolutionReference: { anyOf: [{ type: 'string', maxLength: 200 }, { type: 'null' }] },
    resolutionId: { anyOf: [ref('Id'), { type: 'null' }] },
    reason: { type: 'string', minLength: 3, maxLength: 480, description: 'Powód przeksięgowania (3-480 znaków); trafia do storna jako „Przeksięgowanie: …”.' },
    confirmPersonalData: CONFIRM,
  }, ['schoolYearId', 'direction', 'amountCents', 'categoryId', 'description', 'occurredOn', 'method', 'reason']),
  LedgerCategoryCreateRequest: requestObject({
    schoolYearId: ref('Id'), direction: ref('LedgerDirection'), name: { type: 'string', minLength: 2, maxLength: 100 },
  }, ['schoolYearId', 'direction', 'name']),
  LedgerCategoryCopyRequest: requestObject({
    fromSchoolYearId: ref('Id'),
    toSchoolYearId: { ...ref('Id'), description: 'Rok docelowy (wymaga dostępu finansowego do tego roku); inny niż źródłowy.' },
    dryRun: { type: 'boolean', description: 'true = tylko podgląd, bez zapisu.' },
  }, ['fromSchoolYearId', 'toSchoolYearId']),
  LedgerReviewRequest: requestObject({
    decision: { type: 'string', enum: ['verified', 'questioned'] },
    note: { anyOf: [{ type: 'string', minLength: 3, maxLength: 500 }, { type: 'null' }], description: 'Wymagana przy `questioned`.' },
    confirmPersonalData: CONFIRM,
  }, ['decision']),
  LedgerResolutionAuthorizationRequest: requestObject({
    authorizedAmountCents: ref('AmountCents'),
    validUntil: { anyOf: [ref('IsoDate'), { type: 'null' }], description: 'Termin ważności upoważnienia (opcjonalny).' },
    note: { type: 'string', minLength: 3, maxLength: 500 },
    supersedesId: { anyOf: [ref('Id'), { type: 'null' }], description: 'Bieżące upoważnienie uchwały, które ta kwota zastępuje (null dla pierwszego).' },
    confirmPersonalData: CONFIRM,
  }, ['authorizedAmountCents', 'note']),
};

const YEAR_QUERY = { schoolYearId: { required: true, schema: ref('Id') } };
const READ_ERROR_SET = mergeErrors(READ_ERRORS, { 403: ['mfa_enrollment_required', 'mfa_required'] });
// Uwaga: kody `resolution_amount_exceeded`, `resolution_expired` i `resolution_repealed` (409, trigger
// c0_ledger_resolution_guard) trasa zwraca, ale tabela w mapDatabaseError zapisuje je w postaci
// `marker: [kod, status]`, której test katalogu (tests/pg-api-errors-catalog.test.js) nie wykrywa,
// więc nie ma ich w docs/API_ERRORS.md. Dopisanie ich do schematu wymaga najpierw rozszerzenia
// wykrywania kodów w tym teście (osobny, mały PR).
const ENTRY_WRITE_ERRORS = mergeErrors(WRITE_ERRORS, PII_ERRORS, {
  400: ['invalid_amount', 'invalid_category', 'invalid_payment_link', 'invalid_reference', 'invalid_source_document', 'resolution_expense_only', 'resolution_reference_mismatch', 'resolution_required'],
  404: ['resolution_not_found'],
  409: ['payment_already_linked', 'resolution_not_adopted', 'resolution_not_current'],
  422: ['date_outside_school_year', 'payment_amount_mismatch'],
});

/** Klucz: `METODA /ścieżka-openapi` (jak w docs/openapi.json). */
export const routes = {
  'GET /api/ledger': {
    query: {
      ...YEAR_QUERY,
      direction: { schema: ref('LedgerDirection') },
      category: { schema: ref('Id') },
      dateFrom: { schema: ref('IsoDate') },
      dateTo: { schema: ref('IsoDate') },
      limit: { schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
      cursor: { schema: { type: 'string' }, description: '`nextCursor` z poprzedniej odpowiedzi tej samej trasy i filtrów (docs/API.md).' },
    },
    responses: {
      200: {
        description: 'Strona wpisów roku (od najnowszych); `nextCursor` = null na ostatniej stronie.',
        schema: strictObject({ entries: { type: 'array', items: ref('LedgerEntryListItem') }, nextCursor: nullable({ type: 'string' }) }),
      },
    },
    errors: mergeErrors(READ_ERROR_SET, { 400: ['invalid_cursor', 'invalid_date', 'invalid_date_range', 'invalid_limit'] }),
  },
  'GET /api/ledger/categories': {
    query: { ...YEAR_QUERY, direction: { schema: ref('LedgerDirection') } },
    responses: {
      200: {
        description: 'Aktywne kategorie roku (według kierunku i nazwy).',
        schema: strictObject({ categories: { type: 'array', items: ref('LedgerCategoryListItem') } }),
      },
    },
    errors: READ_ERROR_SET,
  },
  'GET /api/ledger/summary': {
    query: YEAR_QUERY,
    responses: { 200: { description: 'Podsumowanie księgi roku.', schema: strictObject({ summary: ref('LedgerSummary') }) } },
    errors: mergeErrors(READ_ERROR_SET, { 404: ['school_year_not_found'] }),
  },
  'GET /api/ledger/budget': {
    query: YEAR_QUERY,
    responses: {
      200: { description: 'Bieżący preliminarz roku.', schema: strictObject({ budget: { type: 'array', items: ref('LedgerBudgetLine') } }) },
    },
    errors: READ_ERRORS,
  },
  'GET /api/ledger/export.csv': {
    query: YEAR_QUERY,
    responses: { 200: fileResponse('Eksport księgi roku (CSV UTF-8).', CSV_CONTENT_TYPE) },
    errors: mergeErrors(READ_ERROR_SET, { 404: ['school_year_not_found'], 413: ['export_too_large'] }),
  },
  'GET /api/ledger/export.xlsx': {
    query: YEAR_QUERY,
    responses: { 200: fileResponse('Eksport księgi roku (arkusz XLSX).', OCTET_XLSX) },
    errors: mergeErrors(READ_ERROR_SET, { 404: ['school_year_not_found'], 413: ['export_too_large'] }),
  },
  'POST /api/ledger': {
    idempotencyKey: true,
    body: ref('LedgerEntryCreateRequest'),
    responses: {
      201: replayed('false', 'Wpis księgi (nowy zapis).', strictObject({ entry: ref('LedgerEntry') })),
      200: replayed('true', 'Odtworzenie po tym samym kluczu idempotencji (bez nowego zapisu).', strictObject({ entry: ref('LedgerEntry') })),
    },
    errors: ENTRY_WRITE_ERRORS,
  },
  'POST /api/ledger/{ledgerEntryId}/corrections': {
    idempotencyKey: true,
    body: ref('LedgerCorrectionRequest'),
    responses: {
      201: replayed('false', 'Korekta wpisu księgi (nowy zapis).', strictObject({ correction: ref('LedgerCorrection') })),
      200: replayed('true', 'Odtworzenie po tym samym kluczu idempotencji.', strictObject({ correction: ref('LedgerCorrection') })),
    },
    errors: mergeErrors(WRITE_ERRORS, PII_ERRORS, {
      400: ['invalid_amount', 'invalid_ledger_entry_id', 'invalid_reason'],
      404: ['ledger_entry_not_found'],
      409: ['active_bank_match', 'allocation_exceeds_net', 'correction_exceeds_remaining_amount'],
    }),
  },
  'POST /api/ledger/{ledgerEntryId}/replacement': {
    idempotencyKey: true,
    body: ref('LedgerReplacementRequest'),
    responses: {
      201: replayed('false', 'Storno pozostałej kwoty i wpis zastępczy w jednej operacji (z `warnings`, gdy dotyka potwierdzonego uzgodnienia).', ref('LedgerReplacementResult')),
      200: replayed('true', 'Odtworzenie po tym samym kluczu idempotencji.', ref('LedgerReplacementResult')),
    },
    errors: mergeErrors(ENTRY_WRITE_ERRORS, {
      400: ['invalid_ledger_entry_id', 'invalid_reason'],
      404: ['ledger_entry_not_found'],
      409: ['active_bank_match', 'allocation_exceeds_net', 'ledger_entry_already_corrected_to_zero', 'ledger_entry_already_replaced', 'replacement_target_mismatch'],
    }),
  },
  'POST /api/ledger/categories': {
    idempotencyKey: 'optional',
    body: ref('LedgerCategoryCreateRequest'),
    responses: {
      201: { description: 'Utworzona kategoria.', schema: strictObject({ category: ref('LedgerCategory') }) },
      200: { description: 'Kategoria już istnieje (ta sama nazwa, kierunek i rok) albo odtworzenie po tym samym kluczu — bez nowego zapisu.', schema: strictObject({ category: ref('LedgerCategory') }) },
    },
    errors: mergeErrors(WRITE_ERRORS, { 409: ['category_exists'] }),
  },
  'POST /api/ledger/categories/{categoryId}/deactivate': {
    responses: {
      200: { description: 'Kategoria nieaktywna (idempotentnie: ponowne wywołanie zwraca ten sam wynik).', schema: strictObject({ category: ref('LedgerCategory') }) },
    },
    errors: mergeErrors({ 400: ['invalid_request'], 403: ['forbidden', 'invalid_origin'], 409: ['school_year_closed'] }, { 404: ['category_not_found'] }),
  },
  'POST /api/ledger/categories/copy': {
    body: ref('LedgerCategoryCopyRequest'),
    responses: {
      200: { description: 'Podgląd (`dryRun: true`) albo wynik kopiowania nazw i kierunków kategorii do roku docelowego.', schema: ref('LedgerCategoryCopyResult') },
    },
    errors: mergeErrors({ ...WRITE_ERRORS, 400: ['invalid_json', 'invalid_request'], 409: ['school_year_closed'] }),
  },
  'GET /api/ledger/reviews': {
    query: {
      ...YEAR_QUERY,
      reviewStatus: { schema: { type: 'string', enum: ['unverified', 'verified', 'questioned'] } },
      limit: { schema: { type: 'integer', minimum: 1, maximum: 500, default: 500 } },
      cursor: { schema: { type: 'string' }, description: '`nextCursor` z poprzedniej odpowiedzi tej samej trasy i filtru (docs/API.md).' },
    },
    responses: {
      200: {
        description: 'Stan weryfikacji wydatków roku; `truncated` = true wtedy i tylko wtedy, gdy `nextCursor` nie jest null.',
        schema: strictObject({
          reviews: { type: 'array', items: ref('LedgerReviewListItem') },
          nextCursor: nullable({ type: 'string' }),
          truncated: { type: 'boolean' },
          limit: { type: 'integer', minimum: 1 },
        }),
      },
    },
    errors: mergeErrors(READ_ERRORS, { 400: ['invalid_cursor', 'invalid_limit'] }),
  },
  'GET /api/ledger/resolutions': {
    query: YEAR_QUERY,
    responses: {
      200: {
        description: 'Przyjęte uchwały zebrań ogólnych roku i roku poprzedniego z upoważnieniami do wydatku (bez treści projektu i protokołu).',
        schema: strictObject({ resolutions: { type: 'array', items: ref('LedgerResolutionSpending') } }),
      },
    },
    errors: READ_ERRORS,
  },
  'POST /api/ledger/{ledgerEntryId}/reviews': {
    idempotencyKey: true,
    body: ref('LedgerReviewRequest'),
    responses: {
      201: replayed('false', 'Decyzja weryfikacji wydatku (nowy zapis).', strictObject({ review: ref('LedgerReview') })),
      200: replayed('true', 'Odtworzenie po tym samym kluczu idempotencji.', strictObject({ review: ref('LedgerReview') })),
    },
    errors: mergeErrors(WRITE_ERRORS, PII_ERRORS, {
      400: ['invalid_ledger_entry_id', 'invalid_reason'],
      403: ['four_eyes_required'],
      404: ['ledger_entry_not_found'],
      409: ['review_expense_only'],
    }),
  },
  'POST /api/ledger/resolutions/{resolutionId}/authorizations': {
    idempotencyKey: true,
    body: ref('LedgerResolutionAuthorizationRequest'),
    responses: {
      201: replayed('false', 'Upoważnienie do wydatku z uchwały (nowa wersja kwoty).', strictObject({ authorization: ref('LedgerResolutionAuthorization') })),
      200: replayed('true', 'Odtworzenie po tym samym kluczu idempotencji.', strictObject({ authorization: ref('LedgerResolutionAuthorization') })),
    },
    errors: mergeErrors(WRITE_ERRORS, PII_ERRORS, {
      400: ['invalid_amount', 'invalid_reason'],
      404: ['resolution_not_found'],
      409: ['authorization_superseded', 'resolution_not_adopted', 'resolution_not_current'],
    }),
  },
};
