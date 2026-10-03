// Schematy OpenAPI dla modułu `board` (src/pg/routes/board.js, #131), #160 etap 13: pulpit zarządu — statystyki klas
// roku i eksport tej samej tabeli (CSV, XLSX). Pisane ręcznie na podstawie `buildOverview` i `buildOverviewExport`;
// trasy się nie zmieniają.
//
// Cechy modułu, które schemat odwzorowuje (opis stanu, nie zmiana tras):
//   * admin i zarząd; przydział bez klasy — wszystkie klasy roku przydziału (`scope: school`), przydział zarządu
//     ograniczony do klas — tylko te klasy (`scope: classes`, wiersze i sumy wyłącznie z nich). Skarbnik, Komisja
//     Rewizyjna, dyrekcja, przedstawiciel → 403 (rola sprawdzana przed parametrem roku); rok poza przydziałem → 404
//     `school_year_not_found` jak nieistniejący;
//   * wyłącznie liczności — bez identyfikatorów gospodarstw, imion i e-maili, bez rankingu (kolejność wg nazwy klasy)
//     i bez słowa „dłużnik”. `paymentEntryRatePercent` (odsetek gospodarstw z odnotowanym wpisem wpłaty, informacyjnie)
//     oraz `unmatchedPaymentsCount` występują WYŁĄCZNIE przy roli finansowej z MFA i przydziale szerokim dla roku —
//     brak pola (nie null) oznacza brak dostępu; klasa z mniej niż 5 gospodarstwami ma null zamiast odsetka;
//   * eksport ma te same uprawnienia i liczby co widok i zapisuje `board.overview.exported` w tej samej transakcji.
import { CSV_CONTENT_TYPE, OCTET_XLSX, fileResponse, ref, strictObject } from './common.js';

export const name = 'board';

const COUNT = ref('Count');
const RATE = {
  anyOf: [{ type: 'integer', minimum: 0, maximum: 100 }, { type: 'null' }],
  description: 'Odsetek gospodarstw z odnotowanym wpisem wpłaty (informacyjnie, nie zobowiązanie); null przy mniej niż 5 gospodarstwach. '
    + 'Tylko rola finansowa z MFA i przydziałem szerokim dla roku — inaczej pola nie ma.',
};
const COUNTS = {
  studentCount: { ...COUNT, description: 'Uczniowie z bieżącym przypisaniem (bez odeszłych).' },
  householdCount: { ...COUNT, description: 'Gospodarstwa główne uczniów (rodzeństwo liczone raz).' },
  representative: strictObject({
    active: { ...COUNT, description: 'Aktywne przydziały przedstawiciela.' },
    pendingInvites: { ...COUNT, description: 'Oczekujące zaproszenia przedstawiciela.' },
  }),
  contactEmailCount: { ...COUNT, description: 'Uczniowie z opiekunem ze zgodą na kontakt (opiekuna i relacji) i adresem e-mail.' },
  noContactCount: { ...COUNT, description: 'Uczniowie „do kartki”: bez takiego opiekuna.' },
};
const QUERY = { schoolYearId: { required: true, schema: ref('Id') } };
const ERRORS = {
  400: ['invalid_request'],
  403: ['forbidden', 'mfa_enrollment_required', 'mfa_required'],
  404: ['school_year_not_found'],
};

export const components = {
  BoardOverviewClass: strictObject({
    id: ref('EntityId'),
    name: { type: 'string' },
    ...COUNTS,
    paymentEntryRatePercent: RATE,
  }, ['paymentEntryRatePercent']),
  BoardOverview: strictObject({
    schoolYearId: ref('EntityId'),
    schoolYearLabel: { type: 'string' },
    note: { type: 'string', description: 'Stała nota o dobrowolności składki i znaczeniu odsetka.' },
    scope: { type: 'string', enum: ['school', 'classes'], description: '`school` — wszystkie klasy roku; `classes` — przydział zarządu ograniczony do klas.' },
    classes: { type: 'array', items: ref('BoardOverviewClass'), description: 'Klasy w zakresie, wg nazwy (bez sortowania po odsetku).' },
    totals: strictObject({
      ...COUNTS,
      studentCount: { ...COUNT, description: 'Uczniowie klas w zakresie.' },
      householdCount: { ...COUNT, description: 'Gospodarstwa w zakresie liczone raz (rodzeństwo w kilku klasach — jedno gospodarstwo).' },
      paymentEntryRatePercent: RATE,
      unmatchedPaymentsCount: { ...COUNT, description: 'Wpłaty roku bez przypisania do rodziny (nieujęte w odsetkach); tylko z kolumną wpłat.' },
    }, ['paymentEntryRatePercent', 'unmatchedPaymentsCount']),
  }, [], { description: 'Statystyki klas (#131) — informacja pomocnicza, nie ocena klas ani rodzin.' }),
};

/** Klucz: `METODA /ścieżka-openapi` (jak w docs/openapi.json). */
export const routes = {
  'GET /api/board/overview': {
    query: QUERY,
    responses: { 200: { description: 'Statystyki klas roku w zakresie wywołującego (jedna migawka odczytu).', schema: ref('BoardOverview') } },
    errors: ERRORS,
  },
  'GET /api/board/overview/export.csv': {
    query: QUERY,
    responses: {
      200: fileResponse('Ta sama tabela co widok: CSV UTF-8 z BOM, separator `;`, nagłówek z rokiem i notą, wiersze klas i „Razem”, '
        + 'kolumna wpisów wpłat tylko z dostępem finansowym (`—` przy progu 5 gospodarstw).', CSV_CONTENT_TYPE),
    },
    errors: ERRORS,
  },
  'GET /api/board/overview/export.xlsx': {
    query: QUERY,
    responses: { 200: fileResponse('Ta sama tabela co widok jako arkusz XLSX „Statystyki klas” (te same kolumny i reguły co CSV).', OCTET_XLSX) },
    errors: ERRORS,
  },
};
