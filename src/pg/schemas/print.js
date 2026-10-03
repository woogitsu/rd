// Schematy OpenAPI dla modułu `print` (src/pg/routes/print.js; #11, #83, #92, #100, #145, #194), #160 etap 13: dane do
// kartek o dobrowolnej składce. Odpowiedź jest JSON-em (wejście panelu print/, który sam składa kartki do druku) —
// trasa nie zwraca HTML ani PDF. Pisane ręcznie na podstawie `rowOut`, `loadPaymentInstructions` i `noticeReference`;
// trasy się nie zmieniają.
//
// Cechy modułu, które schemat odwzorowuje (opis stanu, nie zmiana tras):
//   * zakres (założenie D-08): admin/zarząd/skarbnik z przydziałem bez klasy — cały rok, `classId` opcjonalny (przy
//     `classId` rodzina z pełną listą rodzeństwa z roku); przedstawiciel i zarząd z przydziałem klasy — `classId` wymagany
//     (400 `class_required`) i własny (403); Komisja Rewizyjna i dyrekcja → 403. Trasa nie wymaga MFA (bramka routera
//     nadal obowiązuje role z MFA_REQUIRED_ROLES);
//   * `recordedNetCents` (suma netto wpisów wpłat, nie należność) jest w wierszu WYŁĄCZNIE przy roli finansowej z MFA
//     obejmującej żądany zakres (`paymentInfoIncluded: true`); inaczej pola nie ma wcale;
//   * odpowiedź nie zawiera danych opiekunów (imion, e-maili, zgód); `structuredReference` — aktywna komunikacja
//     strukturalna OGM-VCS rodziny w tym roku albo null; rodziny z ograniczeniem przetwarzania (art. 18 RODO) są
//     pominięte, a `skippedRestricted` to sama ich liczba w tym samym zakresie;
//   * wydruk wymaga opublikowanej informacji o przetwarzaniu danych (409 `privacy_notice_missing`); powyżej 5000 wierszy
//     → 413 `too_many_rows`. Każde żądanie zapisuje `print.cards_requested` (liczby, bez identyfikatorów rodzin).
import { nullable, ref, strictObject } from './common.js';

export const name = 'print';

const STRING = { type: 'string' };

export const components = {
  PrintCardRow: strictObject({
    householdId: { ...ref('EntityId'), description: 'Gospodarstwo główne ucznia w dniu kartki (rodzeństwo ma ten sam identyfikator).' },
    firstName: STRING,
    lastName: STRING,
    className: STRING,
    structuredReference: nullable({ type: 'string', pattern: '^\\d{12}$', description: 'Komunikacja strukturalna OGM-VCS (12 cyfr) rodziny w tym roku.' }),
    recordedNetCents: {
      ...ref('NonNegativeCents'),
      description: 'Suma netto zapisanych wpłat rodziny w roku (informacyjnie, nie należność); tylko rola finansowa z MFA.',
    },
  }, ['recordedNetCents'], { description: 'Jeden wiersz na ucznia; bez danych opiekunów.' }),
};

/** Klucz: `METODA /ścieżka-openapi` (jak w docs/openapi.json). */
export const routes = {
  'GET /api/print/cards': {
    query: {
      schoolYearId: { required: true, schema: ref('Id') },
      classId: { schema: ref('Id'), description: 'Klasa roku; wymagana przy przydziale klasowym. Pusty parametr = brak.' },
    },
    responses: {
      200: {
        description: 'Dane kartek w zakresie wywołującego (kolejność: klasa, rodzina, nazwisko).',
        schema: strictObject({
          schoolYearId: ref('EntityId'),
          classId: nullable(ref('EntityId')),
          paymentInfoIncluded: { type: 'boolean', description: 'true — wiersze mają `recordedNetCents` (rola finansowa z MFA).' },
          paymentInstructions: nullable(strictObject({
            id: { ...ref('EntityId'), description: 'Wersja zatwierdzonej konfiguracji rachunku (drukowana w stopce kartki).' },
            iban: STRING,
            bic: nullable(STRING),
            payeeName: STRING,
            approvedAt: ref('IsoDateTime'),
          }, [], { description: 'Zatwierdzone dane do wpłaty Rady (#92) do kodu QR; null — kartka bez QR (szkic).' })),
          privacyNotice: strictObject({
            id: ref('EntityId'),
            version: { type: 'integer', minimum: 1 },
            url: nullable({ type: 'string', description: 'Publiczny adres informacji; null bez PUBLIC_BASE_URL.' }),
          }, [], { description: 'Opublikowana informacja o przetwarzaniu danych (D-06) drukowana na kartce.' }),
          skippedRestricted: { ...ref('Count'), description: 'Liczba rodzin pominiętych z powodu ograniczenia przetwarzania (D-07), w zakresie wydruku.' },
          rows: { type: 'array', maxItems: 5000, items: ref('PrintCardRow') },
        }),
      },
    },
    errors: {
      400: ['class_required', 'invalid_request'],
      403: ['forbidden', 'mfa_enrollment_required', 'mfa_required'],
      404: ['class_not_found', 'school_year_not_found'],
      409: ['privacy_notice_missing'],
      413: ['too_many_rows'],
    },
  },
};
