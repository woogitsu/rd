// Schematy OpenAPI dla modułu `payment-references` (src/pg/routes/payment-references.js,
// #83): komunikacja strukturalna OGM-VCS na gospodarstwo i rok szkolny. #160 etap 2.
import {
  PII_ERRORS, READ_ERRORS, WRITE_ERRORS, mergeErrors, nullable, ref, replayed, requestObject, strictObject,
} from './common.js';

export const name = 'payment-references';

export const components = {
  PaymentReference: strictObject({
    id: ref('EntityId'),
    schoolYearId: ref('EntityId'),
    householdId: ref('EntityId'),
    structuredReference: {
      type: 'string', pattern: '^[0-9]{12}$',
      description: 'Dwanaście cyfr komunikatu strukturalnego (10 cyfr bazy + 2 cyfry kontrolne mod 97), bez znaków +++ i /.',
    },
    active: { type: 'boolean', description: 'false po unieważnieniu (zapis niezmienny, powstaje osobne zdarzenie).' },
    revokedAt: nullable(ref('IsoDateTime')),
    revokeReason: nullable({ type: 'string' }),
  }),
  PaymentReferenceCreateRequest: requestObject({ schoolYearId: ref('Id'), householdId: ref('Id') }, ['schoolYearId', 'householdId']),
  PaymentReferenceRevokeRequest: requestObject({
    reason: {
      type: 'string', minLength: 3, maxLength: 500,
      description: 'Powód unieważnienia (3-500 znaków po przycięciu spacji); bramka danych osobowych (#152).',
    },
    confirmPersonalData: { type: 'boolean', description: 'true potwierdza ostrzeżenie bramki danych osobowych.' },
  }, ['reason']),
};

const single = strictObject({ paymentReference: ref('PaymentReference') });

/** Klucz: `METODA /ścieżka-openapi` (jak w docs/openapi.json). */
export const routes = {
  'GET /api/payment-references': {
    query: { schoolYearId: { required: true, schema: ref('Id') }, householdId: { required: true, schema: ref('Id') } },
    responses: {
      200: {
        description: 'Komunikaty strukturalne gospodarstwa w roku (od najnowszego), także unieważnione.',
        schema: strictObject({ paymentReferences: { type: 'array', items: ref('PaymentReference') } }),
      },
    },
    errors: READ_ERRORS,
  },
  'POST /api/payment-references': {
    idempotencyKey: true,
    body: ref('PaymentReferenceCreateRequest'),
    responses: {
      201: replayed('false', 'Wygenerowany komunikat strukturalny (nowy zapis).', single),
      200: replayed('true', 'Odtworzenie po tym samym kluczu idempotencji.', single),
    },
    errors: mergeErrors(WRITE_ERRORS, { 400: ['invalid_reference'], 409: ['payment_reference_already_active'], 503: ['service_unavailable'] }),
  },
  'POST /api/payment-references/{id}/revoke': {
    idempotencyKey: true,
    body: ref('PaymentReferenceRevokeRequest'),
    responses: {
      201: replayed('false', 'Unieważniony komunikat (nowe zdarzenie unieważnienia).', single),
      200: replayed('true', 'Odtworzenie po tym samym kluczu idempotencji.', single),
    },
    errors: mergeErrors(WRITE_ERRORS, PII_ERRORS, {
      400: ['invalid_id', 'invalid_reason'],
      404: ['payment_reference_not_found'],
      409: ['payment_reference_already_revoked'],
    }),
  },
};
