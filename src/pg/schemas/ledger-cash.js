// Schematy OpenAPI dla modułu `ledger-cash` (src/pg/routes/ledger-cash.js, #199), #160 etap 4:
// przeniesienia kasa ↔ rachunek (ze stornem), bilans otwarcia pierwszego roku z podziałem
// rachunek/kasa i jego poprawki. Pisane ręcznie na podstawie parserów (`parseTransfer`,
// `createOpening`, `createAdjustment`), mapperów (`transferFromRow`, `openingView`) i
// tests/pg-ledger-cash.test.js; trasy się nie zmieniają.
import { PII_ERRORS, mergeErrors, nullable, ref, replayed, requestObject, strictObject } from './common.js';

export const name = 'ledger-cash';

const CONFIRM = {
  type: 'boolean',
  description: 'true potwierdza ostrzeżenie bramki danych osobowych (#152), np. 422 `possible_personal_data`.',
};
const OPENING_LIMIT = 2000000000;
const signedOpening = (description) => ({ type: 'integer', minimum: -OPENING_LIMIT, maximum: OPENING_LIMIT, description });

const CURRENT = strictObject({
  amountCents: ref('SignedCents'), cashCents: ref('SignedCents'), bankCents: ref('SignedCents'),
}, [], { description: 'Bilans otwarcia po poprawkach: całość, kasa i rachunek (= całość − kasa).' });

const OPENING_VIEW_PROPERTIES = {
  schoolYearId: ref('EntityId'),
  openingBalance: nullable(ref('LedgerOpeningBalance')),
  adjustments: { type: 'array', items: ref('LedgerOpeningBalanceAdjustment'), description: 'Poprawki od najstarszej; pusta lista bez bilansu.' },
  current: nullable(CURRENT),
};

export const components = {
  LedgerTransferDirection: {
    type: 'string', enum: ['cash_to_bank', 'bank_to_cash'],
    description: 'cash_to_bank = wpłata gotówki z kasy na rachunek, bank_to_cash = wypłata z rachunku do kasy.',
  },
  LedgerTransfer: strictObject({
    id: ref('EntityId'),
    schoolYearId: ref('EntityId'),
    direction: ref('LedgerTransferDirection'),
    amountCents: ref('AmountCents'),
    transferredOn: ref('IsoDate'),
    description: { type: 'string' },
    sourceDocumentId: nullable(ref('EntityId')),
    reversesId: nullable({ ...ref('EntityId'), description: 'Storno: przeniesienie odwracane (przeciwny kierunek, ta sama kwota i data).' }),
  }, [], { description: 'Przeniesienie wewnętrzne — nie jest przychodem ani wydatkiem.' }),
  LedgerOpeningBalance: strictObject({
    id: ref('EntityId'),
    amountCents: { ...ref('SignedCents'), description: 'Całość bilansu otwarcia bez poprawek.' },
    cashCents: { ...ref('SignedCents'), description: 'Część w kasie (ręczny bilans: ≥ 0; przeniesiony z zamknięcia roku: stan kasy).' },
    bankCents: ref('SignedCents'),
    note: nullable({ type: 'string' }),
    sourceDocumentId: nullable(ref('EntityId')),
    carriedFromSchoolYearId: nullable({ ...ref('EntityId'), description: 'Rok, którego zamknięcie przeniosło bilans; null dla bilansu wpisanego ręcznie.' }),
    createdBy: ref('EntityId'),
  }),
  LedgerOpeningBalanceAdjustment: strictObject({
    id: ref('EntityId'),
    amountCents: ref('SignedCents'),
    cashCents: ref('SignedCents'),
    reason: { type: 'string' },
    createdBy: ref('EntityId'),
    createdAt: ref('IsoDateTime'),
  }, [], { description: 'Poprawka bilansu otwarcia (nowy zapis; pierwotny bilans zostaje w historii).' }),
  LedgerOpeningBalanceView: strictObject(OPENING_VIEW_PROPERTIES, [], {
    description: 'Bilans otwarcia roku z poprawkami; bez bilansu: `openingBalance` i `current` = null.',
  }),
  LedgerOpeningBalanceAdjustmentResult: strictObject({
    adjustmentId: ref('EntityId'),
    ...OPENING_VIEW_PROPERTIES,
  }, [], { description: 'Identyfikator zapisanej poprawki i widok bilansu po niej.' }),

  LedgerTransferRequest: requestObject({
    schoolYearId: ref('Id'),
    direction: ref('LedgerTransferDirection'),
    amountCents: ref('AmountCents'),
    transferredOn: { ...ref('IsoDate'), description: 'Data w granicach roku szkolnego (inaczej 422 `date_outside_school_year`).' },
    description: { type: 'string', minLength: 3, maxLength: 500, description: 'Opis (3-500 znaków po przycięciu spacji); bramka danych osobowych (#152).' },
    sourceDocumentId: { anyOf: [ref('Id'), { type: 'null' }], description: 'Dokument finansowy tego samego roku jako dowód.' },
    reversesId: {
      anyOf: [ref('Id'), { type: 'null' }],
      description: 'Storno: przeniesienie do odwrócenia; wtedy `direction`, `amountCents` i `transferredOn` są pomijane.',
    },
    confirmPersonalData: CONFIRM,
  }, ['schoolYearId', 'description'], {
    anyOf: [{ required: ['direction', 'amountCents', 'transferredOn'] }, { required: ['reversesId'] }],
    description: 'Nowe przeniesienie (`direction`, `amountCents`, `transferredOn`) albo storno (`reversesId`).',
  }),
  LedgerOpeningBalanceRequest: requestObject({
    schoolYearId: { ...ref('Id'), description: 'Wyłącznie pierwszy rok w systemie; kolejne lata dostają bilans z zamknięcia roku.' },
    bankCents: signedOpening('Stan rachunku w eurocentach (może być ujemny).'),
    cashCents: { type: 'integer', minimum: 0, maximum: OPENING_LIMIT, description: 'Gotówka w kasie (nie mniej niż zero).' },
    note: { type: 'string', minLength: 3, maxLength: 500, description: 'Źródło bilansu (3-500 znaków); bramka danych osobowych (#152).' },
    sourceDocumentId: { anyOf: [ref('Id'), { type: 'null' }] },
    confirmPersonalData: CONFIRM,
  }, ['schoolYearId', 'bankCents', 'cashCents', 'note']),
  LedgerOpeningBalanceAdjustmentRequest: requestObject({
    schoolYearId: ref('Id'),
    amountCents: { ...signedOpening('Zmiana całości bilansu (domyślnie 0).'), default: 0 },
    cashCents: { ...signedOpening('Zmiana części w kasie (domyślnie 0); kasa po poprawce nie może być ujemna.'), default: 0 },
    reason: { type: 'string', minLength: 3, maxLength: 500, description: 'Powód poprawki (3-500 znaków); bramka danych osobowych (#152).' },
    confirmPersonalData: CONFIRM,
  }, ['schoolYearId', 'reason'], { description: 'Co najmniej jedna z kwot `amountCents`, `cashCents` różna od zera.' }),
};

const YEAR_QUERY = { schoolYearId: { required: true, schema: ref('Id') } };
const MFA_DENY = { 403: ['forbidden', 'mfa_enrollment_required', 'mfa_required'] };
const READ_ERROR_SET = mergeErrors({ 400: ['invalid_request'], 404: ['school_year_not_found'] }, MFA_DENY);
const WRITE_ERROR_SET = mergeErrors(PII_ERRORS, MFA_DENY, {
  400: ['invalid_idempotency_key', 'invalid_json', 'invalid_request'],
  403: ['invalid_origin'],
  404: ['school_year_not_found'],
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
  'GET /api/ledger/transfers': {
    query: YEAR_QUERY,
    responses: {
      200: {
        description: 'Przeniesienia roku (z stornami) według daty; bez kursora.',
        schema: strictObject({ transfers: { type: 'array', items: ref('LedgerTransfer') } }),
      },
    },
    errors: READ_ERROR_SET,
  },
  'POST /api/ledger/transfers': {
    idempotencyKey: true,
    body: ref('LedgerTransferRequest'),
    responses: written('Przeniesienie albo storno (nowy zapis).', strictObject({ transfer: ref('LedgerTransfer') })),
    errors: mergeErrors(WRITE_ERROR_SET, {
      400: ['invalid_amount', 'invalid_description', 'invalid_source_document'],
      404: ['transfer_not_found'],
      409: ['invalid_reversal', 'transfer_already_reversed'],
      422: ['date_outside_school_year'],
    }),
  },
  'GET /api/ledger/opening-balance': {
    query: YEAR_QUERY,
    responses: { 200: { description: 'Bilans otwarcia roku z podziałem i poprawkami.', schema: ref('LedgerOpeningBalanceView') } },
    errors: READ_ERROR_SET,
  },
  'POST /api/ledger/opening-balance': {
    idempotencyKey: true,
    body: ref('LedgerOpeningBalanceRequest'),
    responses: written('Bilans otwarcia pierwszego roku (nowy zapis) — widok bilansu.', ref('LedgerOpeningBalanceView')),
    errors: mergeErrors(WRITE_ERROR_SET, {
      400: ['invalid_amount', 'invalid_note', 'invalid_source_document'],
      409: ['not_first_school_year', 'opening_balance_exists'],
    }),
  },
  'POST /api/ledger/opening-balance/adjustments': {
    idempotencyKey: true,
    body: ref('LedgerOpeningBalanceAdjustmentRequest'),
    responses: written('Poprawka bilansu otwarcia (nowy zapis) i widok bilansu po niej.', ref('LedgerOpeningBalanceAdjustmentResult')),
    errors: mergeErrors(WRITE_ERROR_SET, {
      400: ['invalid_amount', 'invalid_reason'],
      404: ['opening_balance_not_found'],
      409: ['cash_below_zero'],
    }),
  },
};
