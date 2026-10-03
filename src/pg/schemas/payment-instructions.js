// Schematy OpenAPI dla modułu `payment-instructions` (src/pg/routes/payment-instructions.js,
// #92): zatwierdzone dane do wpłaty (IBAN, BIC, odbiorca) dla roku szkolnego. #160 etap 2.
// Dane w opisach i testach są syntetyczne (testowy IBAN z poprawną sumą kontrolną).
import { READ_ERRORS, WRITE_ERRORS, mergeErrors, nullable, ref, replayed, requestObject, strictObject } from './common.js';

export const name = 'payment-instructions';

export const components = {
  PaymentInstructions: strictObject({
    id: ref('EntityId'),
    schoolYearId: ref('EntityId'),
    iban: { type: 'string', description: 'IBAN bez spacji, wielkimi literami.' },
    bic: nullable({ type: 'string', pattern: '^[A-Z0-9]{8}([A-Z0-9]{3})?$' }),
    payeeName: { type: 'string', minLength: 1, maxLength: 70 },
    approvedAt: ref('IsoDateTime'),
  }),
  PaymentInstructionsApproveRequest: requestObject({
    schoolYearId: ref('Id'),
    iban: { type: 'string', description: 'IBAN (spacje i wielkość liter są normalizowane); walidowany sumą kontrolną.' },
    bic: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'BIC (8 albo 11 znaków), opcjonalny.' },
    payeeName: { type: 'string', minLength: 1, maxLength: 70, description: 'Nazwa odbiorcy (do 70 znaków po przycięciu spacji).' },
  }, ['schoolYearId', 'iban', 'payeeName']),
};

const single = strictObject({ paymentInstructions: ref('PaymentInstructions') });

// Zapis tej trasy nie przechodzi przez trigger zamrożenia roku z własnym kodem — tylko wspólne błędy zapisu.
const APPROVE_ERRORS = mergeErrors({ ...WRITE_ERRORS, 409: ['idempotency_conflict'] }, {
  400: ['invalid_bic', 'invalid_iban', 'invalid_payee_name', 'invalid_reference'],
});

/** Klucz: `METODA /ścieżka-openapi` (jak w docs/openapi.json). */
export const routes = {
  'GET /api/payment-instructions': {
    query: { schoolYearId: { required: true, schema: ref('Id') } },
    responses: {
      200: {
        description: 'Najnowsze zatwierdzone dane do wpłaty roku albo `null`, gdy nie zatwierdzono żadnych.',
        schema: strictObject({ paymentInstructions: nullable(ref('PaymentInstructions')) }),
      },
    },
    errors: READ_ERRORS,
  },
  'POST /api/payment-instructions': {
    idempotencyKey: true,
    body: ref('PaymentInstructionsApproveRequest'),
    responses: {
      201: replayed('false', 'Zatwierdzone dane do wpłaty (nowa wersja; poprzednie zostają w historii).', single),
      200: replayed('true', 'Odtworzenie po tym samym kluczu idempotencji.', single),
    },
    errors: APPROVE_ERRORS,
  },
};
