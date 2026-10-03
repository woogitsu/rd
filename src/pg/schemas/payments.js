// Schematy OpenAPI dla modułu `payments` (src/pg/routes/payments.js), #160 etap 2.
// Pisane ręcznie na podstawie parserów (`parsePaymentInput` …), mapperów wierszy
// (`paymentFromRow` …) i testów API; trasy się nie zmieniają. Składka jest dobrowolna:
// żadna odpowiedź nie zawiera należności, salda „do zapłaty” ani statusu dłużnika.
import {
  CSV_CONTENT_TYPE, OCTET_XLSX, PII_ERRORS, READ_ERRORS, WRITE_ERRORS,
  fileResponse, mergeErrors, nullable, ref, replayed, requestObject, strictObject,
} from './common.js';

export const name = 'payments';

const METHOD = { type: 'string', enum: ['bank', 'cash', 'other'], description: 'bank = przelew, cash = gotówka, other = inna.' };
const REASON = {
  type: 'string', minLength: 3, maxLength: 500,
  description: 'Powód (3-500 znaków po przycięciu spacji). Niezmienny zapis; bez danych osobowych (bramka #152).',
};
const CONFIRM = {
  type: 'boolean',
  description: 'true potwierdza ostrzeżenie bramki danych osobowych (#152), np. 422 `possible_personal_data`.',
};

const PAYMENT_PROPERTIES = {
  id: ref('EntityId'),
  householdId: nullable(ref('EntityId')),
  schoolYearId: ref('EntityId'),
  amountCents: ref('AmountCents'),
  receivedOn: ref('IsoDate'),
  method: ref('PaymentMethod'),
  reference: nullable({ type: 'string' }),
  status: ref('PaymentStatus'),
};

export const components = {
  PaymentMethod: METHOD,
  PaymentStatus: {
    type: 'string', enum: ['recorded', 'unmatched'],
    description: 'recorded = przypisana do gospodarstwa, unmatched = nieprzypisana do wyjaśnienia (nie „dłużnik”).',
  },
  Payment: strictObject(PAYMENT_PROPERTIES, [], { description: 'Wpis wpłaty (niezmienny); korekty i zwroty są osobnymi zapisami.' }),
  PaymentListItem: strictObject({
    ...PAYMENT_PROPERTIES,
    correctedCents: ref('NonNegativeCents'),
    netAmountCents: ref('NonNegativeCents'),
  }, [], { description: 'Wpłata z sumą korekt i kwotą netto (po korektach i zwrotach).' }),
  PaymentCorrection: strictObject({
    id: ref('EntityId'), paymentEntryId: ref('EntityId'), amountCents: ref('AmountCents'), reason: { type: 'string' },
  }),
  PaymentAssignment: strictObject({ id: ref('EntityId'), paymentEntryId: ref('EntityId'), householdId: ref('EntityId') }),
  PaymentRefund: strictObject({
    id: ref('EntityId'), paymentEntryId: ref('EntityId'), amountCents: ref('AmountCents'),
    refundedOn: ref('IsoDate'), method: ref('PaymentMethod'), reason: { type: 'string' },
  }),
  PaymentReassignment: strictObject({
    id: ref('EntityId'), paymentEntryId: ref('EntityId'),
    oldHouseholdId: ref('EntityId'), newHouseholdId: ref('EntityId'), reason: { type: 'string' },
  }),
  PaymentAllocation: strictObject({
    id: ref('EntityId'), paymentEntryId: ref('EntityId'), householdId: ref('EntityId'), amountCents: ref('AmountCents'),
  }),
  PaymentAllocationReversal: strictObject({
    id: ref('EntityId'), allocationId: ref('EntityId'), paymentEntryId: ref('EntityId'), reason: { type: 'string' },
  }),
  PaymentAllocationDetail: strictObject({
    id: ref('EntityId'), paymentEntryId: ref('EntityId'), householdId: ref('EntityId'), amountCents: ref('AmountCents'),
    createdAt: ref('IsoDateTime'),
    reversal: nullable(strictObject({ id: ref('EntityId'), reason: { type: 'string' }, createdAt: ref('IsoDateTime') })),
  }),
  PaymentAllocationsSummary: strictObject({
    paymentEntryId: ref('EntityId'),
    status: { type: 'string', enum: ['recorded', 'unmatched', 'reversed'] },
    householdId: nullable(ref('EntityId')),
    netAmountCents: ref('NonNegativeCents'),
    allocatedCents: ref('NonNegativeCents'),
    unallocatedCents: ref('NonNegativeCents'),
    allocations: { type: 'array', items: ref('PaymentAllocationDetail') },
  }, [], { description: 'Podział wpłaty nieprzypisanej na gospodarstwa (#127). `unallocatedCents` > 0 tylko dla wpłaty `unmatched`.' }),

  PaymentCreateRequest: requestObject({
    schoolYearId: ref('Id'),
    householdId: { anyOf: [ref('Id'), { type: 'null' }], description: 'Gospodarstwo w zakresie roku; brak = wpłata nieprzypisana (`unmatched`).' },
    amountCents: ref('AmountCents'),
    receivedOn: ref('IsoDate'),
    method: ref('PaymentMethod'),
    reference: { anyOf: [{ type: 'string', maxLength: 200 }, { type: 'null' }], description: 'Tytuł przelewu (do 200 znaków); bramka danych osobowych (#152).' },
    confirmPersonalData: CONFIRM,
  }, ['schoolYearId', 'amountCents', 'receivedOn', 'method']),
  PaymentCorrectionRequest: requestObject({
    amountCents: { ...ref('AmountCents'), description: 'Kwota korekty (zmniejszenie wpłaty); suma korekt nie może przekroczyć kwoty wpłaty.' },
    reason: REASON,
    confirmPersonalData: CONFIRM,
  }, ['amountCents', 'reason']),
  PaymentAssignmentRequest: requestObject({ householdId: ref('Id') }, ['householdId']),
  PaymentRefundRequest: requestObject({
    amountCents: ref('AmountCents'),
    refundedOn: { ...ref('IsoDate'), description: 'Data zwrotu pieniędzy rodzinie.' },
    method: ref('PaymentMethod'),
    reason: REASON,
    confirmPersonalData: CONFIRM,
  }, ['amountCents', 'refundedOn', 'method', 'reason']),
  PaymentReassignmentRequest: requestObject({
    householdId: { ...ref('Id'), description: 'Nowe gospodarstwo (inne niż obecne).' },
    reason: REASON,
    confirmPersonalData: CONFIRM,
  }, ['householdId', 'reason']),
  PaymentAllocationRequest: requestObject({ householdId: ref('Id'), amountCents: ref('AmountCents') }, ['householdId', 'amountCents']),
  PaymentAllocationReversalRequest: requestObject({ reason: REASON, confirmPersonalData: CONFIRM }, ['reason']),
};

const LIST_QUERY = {
  schoolYearId: { required: true, schema: ref('Id') },
  status: { schema: { type: 'string', enum: ['recorded', 'unmatched'] } },
  dateFrom: { schema: ref('IsoDate'), description: 'Początek zakresu daty wpływu (włącznie).' },
  dateTo: { schema: ref('IsoDate'), description: 'Koniec zakresu daty wpływu (włącznie).' },
  method: { schema: ref('PaymentMethod') },
  householdId: { schema: ref('Id') },
  q: { schema: { type: 'string', maxLength: 100 }, description: 'Fraza szukana wyłącznie w tytule przelewu.' },
  limit: { schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
  cursor: { schema: { type: 'string' }, description: '`nextCursor` z poprzedniej odpowiedzi tej samej trasy i filtrów (docs/API.md).' },
};

const EXPORT_QUERY = {
  schoolYearId: { required: true, schema: ref('Id') },
  from: { schema: ref('IsoDate') },
  to: { schema: ref('IsoDate') },
  method: { schema: ref('PaymentMethod') },
};

const wrap = (key, schemaName) => strictObject({ [key]: ref(schemaName) });
const created = (key, schemaName, description) => ({
  201: replayed('false', `${description} (nowy zapis).`, wrap(key, schemaName)),
  200: replayed('true', `${description}: odtworzenie po tym samym kluczu idempotencji (bez nowego zapisu).`, wrap(key, schemaName)),
});

const MONEY_WRITE = mergeErrors(WRITE_ERRORS, PII_ERRORS, { 400: ['invalid_amount'] });

/** Schematy tras modułu; klucz: `METODA /ścieżka-openapi` (zgodnie z docs/openapi.json). */
export const routes = {
  'GET /api/payments': {
    query: LIST_QUERY,
    responses: {
      200: {
        description: 'Strona wpłat roku (od najnowszych); `nextCursor` = null na ostatniej stronie.',
        schema: strictObject({ payments: { type: 'array', items: ref('PaymentListItem') }, nextCursor: nullable({ type: 'string' }) }),
      },
    },
    errors: mergeErrors(READ_ERRORS, { 400: ['invalid_cursor', 'invalid_date', 'invalid_date_range', 'invalid_limit', 'invalid_method'] }),
  },
  'POST /api/payments': {
    idempotencyKey: true,
    body: ref('PaymentCreateRequest'),
    responses: created('payment', 'Payment', 'Wpłata'),
    errors: mergeErrors(MONEY_WRITE, { 400: ['invalid_reference'], 422: ['date_outside_school_year'] }),
  },
  'POST /api/payments/{paymentId}/corrections': {
    idempotencyKey: true,
    body: ref('PaymentCorrectionRequest'),
    responses: created('correction', 'PaymentCorrection', 'Korekta wpłaty'),
    errors: mergeErrors(MONEY_WRITE, {
      400: ['invalid_payment_id', 'invalid_reason'],
      404: ['payment_not_found'],
      409: ['active_bank_match', 'correction_exceeds_remaining_amount', 'ledger_correction_required', 'payment_cannot_be_corrected', 'payment_has_allocations', 'payment_allocation_exceeds_net'],
    }),
  },
  'POST /api/payments/{paymentId}/assignment': {
    idempotencyKey: true,
    body: ref('PaymentAssignmentRequest'),
    responses: created('assignment', 'PaymentAssignment', 'Przypisanie wpłaty do gospodarstwa'),
    errors: mergeErrors(WRITE_ERRORS, {
      400: ['invalid_payment_id', 'invalid_reference'],
      404: ['payment_not_found'],
      409: ['payment_already_assigned', 'payment_has_allocations'],
    }),
  },
  'POST /api/payments/{paymentId}/refunds': {
    idempotencyKey: true,
    body: ref('PaymentRefundRequest'),
    responses: created('refund', 'PaymentRefund', 'Zwrot pieniędzy rodzinie'),
    errors: mergeErrors(MONEY_WRITE, {
      400: ['invalid_payment_id', 'invalid_reason'],
      404: ['payment_not_found'],
      409: ['ledger_correction_required', 'payment_allocation_exceeds_net', 'payment_cannot_be_refunded', 'refund_exceeds_remaining_amount'],
    }),
  },
  'POST /api/payments/{paymentId}/reassignment': {
    idempotencyKey: true,
    body: ref('PaymentReassignmentRequest'),
    responses: created('reassignment', 'PaymentReassignment', 'Ponowne przypisanie wpłaty'),
    errors: mergeErrors(WRITE_ERRORS, PII_ERRORS, {
      400: ['invalid_payment_id', 'invalid_reason', 'invalid_reference'],
      404: ['payment_not_found'],
      409: ['payment_not_assigned', 'payment_reassignment_household_mismatch', 'payment_reassignment_same_household'],
    }),
  },
  'GET /api/payments/{paymentId}/allocations': {
    responses: {
      200: { description: 'Podział wpłaty na gospodarstwa wraz z cofnięciami (odczyt spójny, `Cache-Control: no-store`).', schema: ref('PaymentAllocationsSummary') },
    },
    errors: mergeErrors(READ_ERRORS, { 400: ['invalid_payment_id'], 404: ['payment_not_found'] }),
  },
  'POST /api/payments/{paymentId}/allocations': {
    idempotencyKey: true,
    body: ref('PaymentAllocationRequest'),
    responses: created('allocation', 'PaymentAllocation', 'Część wpłaty przypisana do gospodarstwa'),
    errors: mergeErrors(WRITE_ERRORS, {
      400: ['invalid_amount', 'invalid_payment_id', 'invalid_reference'],
      404: ['payment_not_found'],
      409: ['payment_allocation_exceeds_net', 'payment_allocation_household_exists', 'payment_already_assigned'],
    }),
  },
  'POST /api/payments/{paymentId}/allocations/{allocationId}/reversal': {
    idempotencyKey: true,
    body: ref('PaymentAllocationReversalRequest'),
    responses: created('reversal', 'PaymentAllocationReversal', 'Cofnięcie części podziału wpłaty'),
    errors: mergeErrors(WRITE_ERRORS, PII_ERRORS, {
      400: ['invalid_payment_id', 'invalid_reason'],
      404: ['payment_allocation_not_found', 'payment_not_found'],
      409: ['payment_allocation_already_reversed'],
    }),
  },
  'GET /api/payments/export.csv': {
    query: EXPORT_QUERY,
    responses: { 200: fileResponse('Eksport wpisów i korekt (CSV UTF-8); pierwsza linia to zastrzeżenie o dobrowolności składek.', CSV_CONTENT_TYPE) },
    errors: mergeErrors(READ_ERRORS, { 400: ['invalid_date', 'invalid_method', 'invalid_window'], 404: ['school_year_not_found'], 413: ['export_too_large'] }),
  },
  'GET /api/payments/export.xlsx': {
    query: EXPORT_QUERY,
    responses: { 200: fileResponse('Eksport wpisów i korekt (arkusze „Wpisy” i „Korekty”).', OCTET_XLSX) },
    errors: mergeErrors(READ_ERRORS, { 400: ['invalid_date', 'invalid_method', 'invalid_window'], 404: ['school_year_not_found'], 413: ['export_too_large'] }),
  },
};
