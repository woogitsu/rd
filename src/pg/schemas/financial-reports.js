// Schematy OpenAPI dla modułu `financial-reports` (src/pg/routes/financial-reports.js, src/pg/annual-report.js,
// src/pg/report-snapshots.js; #125, migracja 0138), #160 etap 13: sprawozdanie roczne, przepływy środków i niezmienne
// migawki sprawozdania z zatwierdzeniem. Pisane ręcznie na podstawie `buildAnnualReport`, `buildCashFlow` i `summary`;
// trasy się nie zmieniają.
//
// Cechy modułu, które schemat odwzorowuje (opis stanu, nie zmiana tras):
//   * sprawozdanie i przepływy to wyłącznie sumy (kategorie, miesiące, metody) — bez opisów wpisów, osób, rodzin
//     i wpłat per klasa. Czytają je zarząd, skarbnik i dyrekcja (`principal`, tylko te dwie trasy) z MFA i przydziałem
//     bez klasy w roku; admin, Komisja Rewizyjna i przedstawiciel → 403 (D-08/D-09, wariant zachowawczy). Brak MFA przy
//     pasującej roli → 403 `mfa_required`/`mfa_enrollment_required` (#161);
//   * migawki (lista, zapis, odczyt): zarząd i skarbnik; zatwierdzenie — wyłącznie zarząd, inna osoba niż autor
//     (403 `four_eyes_required`) i świeże MFA (403 `mfa_stale` po 15 min, #150). Zapis i zatwierdzenie NIE mają
//     Idempotency-Key: ta sama treść księgi = ta sama migawka (200, `replayed: true`), powtórne zatwierdzenie = 200;
//     odpowiedzi mają pole `replayed`, bez nagłówka `Idempotency-Replayed`;
//   * `format=html` (sprawozdanie i migawka) zwraca dokument HTML do druku z własnym CSP — opis typem treści;
//   * treść migawki to sprawozdanie bez `generatedAt` (czas zapisu to `createdAt` migawki); odczyt przelicza SHA-256
//     i przy niezgodności zwraca 500 `report_snapshot_integrity_failed` zamiast treści;
//   * walidacja parametrów i ciała zapisu poprzedza sprawdzenie sesji (400 przed 401 — rozbieżność w docs/API.md).
import { HTML_CONTENT_TYPE, PII_ERRORS, formatsResponse, mergeErrors, nullable, ref, requestObject, strictObject } from './common.js';

export const name = 'financial-reports';

const CENTS = ref('SignedCents');
const NULLABLE_CENTS = nullable(ref('SignedCents'));
const SCHOOL_YEAR = strictObject({
  id: ref('EntityId'), label: { type: 'string' }, startsOn: ref('IsoDate'), endsOn: ref('IsoDate'),
});
const CATEGORY_LINE = strictObject({
  categoryId: ref('EntityId'),
  name: { type: 'string' },
  netCents: { ...CENTS, description: 'Wykonanie: suma wpisów netto (po korektach) w kategorii.' },
  plannedCents: { ...NULLABLE_CENTS, description: 'Preliminarz bieżącej wersji; null — kategoria bez preliminarza.' },
  varianceCents: { ...NULLABLE_CENTS, description: 'Wykonanie minus preliminarz; null bez preliminarza.' },
});
const SECTION = strictObject({
  categories: { type: 'array', items: CATEGORY_LINE, description: 'Kategorie z wpisami albo z preliminarzem.' },
  totalCents: CENTS,
  plannedCents: { ...NULLABLE_CENTS, description: 'Suma preliminarza; null, gdy żadna kategoria go nie ma.' },
});
const ANNUAL_PROPERTIES = {
  kind: { const: 'annual' },
  schoolYear: SCHOOL_YEAR,
  generatedAt: ref('IsoDateTime'),
  balance: strictObject(Object.fromEntries([
    'openingBalanceCents', 'openingBankCents', 'openingCashCents', 'incomeCents', 'expenseCents', 'resultCents',
    'closingBalanceCents', 'closingBankCents', 'closingCashCents',
  ].map((key) => [key, CENTS]))),
  income: SECTION,
  expense: SECTION,
  counts: strictObject({ entryCount: ref('Count'), correctionCount: ref('Count') }),
  reconciliation: strictObject({
    lastConfirmedStatementDate: nullable({ ...ref('IsoDate'), description: 'Data wyciągu ostatniego potwierdzonego uzgodnienia; null — brak.' }),
  }),
};
const SNAPSHOT_PAYLOAD_PROPERTIES = Object.fromEntries(Object.entries(ANNUAL_PROPERTIES).filter(([key]) => key !== 'generatedAt'));
const INCOME_EXPENSE = strictObject({ incomeCents: CENTS, expenseCents: CENTS });

export const components = {
  FinancialAnnualReport: strictObject(ANNUAL_PROPERTIES, [], {
    description: 'Sprawozdanie roczne (projekt z bieżącej księgi): bilans, przychody i wydatki według kategorii z preliminarzem, '
      + 'liczby wpisów i korekt. Wyłącznie sumy — bez opisów wpisów, osób i danych rodzin. Nie jest zatwierdzonym sprawozdaniem.',
  }),
  FinancialAnnualReportPayload: strictObject(SNAPSHOT_PAYLOAD_PROPERTIES, [], {
    description: 'Zapisana treść migawki: sprawozdanie bez `generatedAt` (ten sam stan księgi = ten sam skrót SHA-256).',
  }),
  FinancialCashFlow: strictObject({
    kind: { const: 'cash_flow' },
    granularity: { const: 'month' },
    schoolYear: SCHOOL_YEAR,
    generatedAt: ref('IsoDateTime'),
    openingBalanceCents: CENTS,
    openingCashCents: CENTS,
    months: {
      type: 'array',
      description: 'Każdy miesiąc roku szkolnego (i miesiące wpisów spoza jego zakresu), rosnąco.',
      items: strictObject({
        month: { type: 'string', pattern: '^\\d{4}-\\d{2}$', description: 'RRRR-MM.' },
        byMethod: strictObject({ bank: INCOME_EXPENSE, cash: INCOME_EXPENSE, card: INCOME_EXPENSE, other: INCOME_EXPENSE }),
        incomeCents: CENTS,
        expenseCents: CENTS,
        netCents: CENTS,
        transfers: strictObject({ cashToBankCents: CENTS, bankToCashCents: CENTS }),
        runningBalanceCents: { ...CENTS, description: 'Saldo narastające na koniec miesiąca.' },
        runningCashCents: { ...CENTS, description: 'Saldo kasy (metody inne niż bank i przeniesienia).' },
        runningBankCents: CENTS,
      }),
    },
    totals: strictObject({ incomeCents: CENTS, expenseCents: CENTS, closingBalanceCents: CENTS, closingCashCents: CENTS }),
  }, [], { description: 'Przepływy środków per miesiąc i metoda z saldem narastającym i saldem kasy (#125).' }),
  FinancialReportSnapshot: strictObject({
    id: ref('EntityId'),
    schoolYearId: ref('EntityId'),
    kind: { const: 'annual' },
    sha256: { ...ref('Sha256Hex'), description: 'Skrót kanonicznego JSON treści migawki.' },
    supersedesId: nullable({ ...ref('EntityId'), description: 'Migawka zastąpiona tą korektą.' }),
    supersededById: nullable({ ...ref('EntityId'), description: 'Korekta, która zastąpiła tę migawkę; null — migawka bieżąca.' }),
    createdBy: ref('EntityId'),
    createdAt: ref('IsoDateTime'),
    approvedBy: nullable({ ...ref('EntityId'), description: 'Zatwierdzający (inna osoba niż autor); null — niezatwierdzona.' }),
    approvedAt: nullable(ref('IsoDateTime')),
  }, [], { description: 'Stan migawki sprawozdania (bez treści i bez powodu korekty).' }),
  FinancialReportSnapshotRequest: requestObject({
    schoolYearId: ref('Id'),
    supersedesId: {
      anyOf: [ref('Id'), { type: 'null' }],
      description: 'Bieżąca migawka roku, którą zastępuje korekta; wymagane, gdy rok ma już migawkę (409 `report_snapshot_supersedes_required`).',
    },
    reason: {
      anyOf: [{ type: 'string', minLength: 3, maxLength: 500 }, { type: 'null' }],
      description: 'Powód korekty (3-500 znaków po przycięciu), wymagany razem z `supersedesId`; bramka danych osobowych (#152).',
    },
    confirmPersonalData: { type: 'boolean', description: 'true potwierdza ostrzeżenie bramki danych osobowych (#152).' },
  }, ['schoolYearId']),
  FinancialReportSnapshotApproveRequest: requestObject({}, [], {
    description: 'Zatwierdzenie nie ma pól; trasa przyjmuje `{}` albo żądanie bez treści.',
  }),
};

const SNAPSHOT_RESULT = (replayed) => strictObject({ snapshot: ref('FinancialReportSnapshot'), replayed: { const: replayed } });
const YEAR_QUERY = { schoolYearId: { required: true, schema: ref('Id') } };
const REPORT_FORMAT = { schema: { type: 'string', enum: ['json', 'html'], default: 'json' }, description: '`html` — dokument A4 do druku (CSP bez skryptów).' };

const GATE = { 403: ['forbidden', 'mfa_enrollment_required', 'mfa_required'] };
const READ = mergeErrors(GATE, { 400: ['invalid_request'] });
const BODY = mergeErrors(GATE, {
  400: ['invalid_json', 'invalid_request'],
  403: ['invalid_origin'],
  409: ['conflict', 'school_year_closed'],
  413: ['request_too_large'],
  415: ['invalid_content_type'],
});

/** Klucz: `METODA /ścieżka-openapi` (jak w docs/openapi.json). */
export const routes = {
  'GET /api/reports/annual': {
    query: { ...YEAR_QUERY, format: REPORT_FORMAT },
    responses: {
      200: formatsResponse('Sprawozdanie roczne: JSON (domyślnie) albo HTML do druku; każde wygenerowanie zapisuje `report.annual.generated` bez treści.', {
        'application/json': strictObject({ report: ref('FinancialAnnualReport') }),
        [HTML_CONTENT_TYPE]: { type: 'string' },
      }),
    },
    errors: mergeErrors(READ, { 404: ['school_year_not_found'] }),
  },
  'GET /api/reports/cash-flow': {
    query: { ...YEAR_QUERY, granularity: { schema: { const: 'month', default: 'month' }, description: 'Jedyna obsługiwana szczegółowość: miesiąc.' } },
    responses: { 200: { description: 'Przepływy środków roku; zapisuje `report.cash_flow.generated` bez treści.', schema: strictObject({ report: ref('FinancialCashFlow') }) } },
    errors: mergeErrors(READ, { 404: ['school_year_not_found'] }),
  },
  'GET /api/reports/annual/snapshots': {
    query: YEAR_QUERY,
    responses: { 200: { description: 'Migawki roku od najstarszej (bez treści).', schema: strictObject({ snapshots: { type: 'array', items: ref('FinancialReportSnapshot') } }) } },
    errors: READ,
  },
  'POST /api/reports/annual/snapshots': {
    body: ref('FinancialReportSnapshotRequest'),
    responses: {
      201: { description: 'Nowa niezmienna migawka z bieżącej księgi (`replayed: false`).', schema: SNAPSHOT_RESULT(false) },
      200: { description: 'Ta sama treść co bieżąca migawka (podwójne kliknięcie): istniejąca migawka, `replayed: true`.', schema: SNAPSHOT_RESULT(true) },
    },
    errors: mergeErrors(BODY, PII_ERRORS, {
      400: ['invalid_reason'],
      404: ['school_year_not_found'],
      409: ['report_snapshot_content_exists', 'report_snapshot_superseded', 'report_snapshot_supersedes_required'],
    }),
  },
  'GET /api/reports/annual/snapshots/{id}': {
    query: { format: REPORT_FORMAT },
    responses: {
      200: formatsResponse('Zapisana treść migawki ze stanem (SHA-256 sprawdzony przy odczycie): JSON (domyślnie) albo HTML do druku.', {
        'application/json': strictObject({ snapshot: ref('FinancialReportSnapshot'), report: ref('FinancialAnnualReportPayload') }),
        [HTML_CONTENT_TYPE]: { type: 'string' },
      }),
    },
    errors: mergeErrors(READ, { 404: ['report_snapshot_not_found'], 500: ['report_snapshot_integrity_failed'] }),
    errorDescriptions: { 500: 'Zapisana treść nie zgadza się ze skrótem SHA-256 (naruszenie poza API) — treść nie jest wydawana.' },
  },
  'POST /api/reports/annual/snapshots/{id}/approve': {
    body: ref('FinancialReportSnapshotApproveRequest'),
    bodyOptional: true,
    responses: {
      201: { description: 'Migawka zatwierdzona teraz (`replayed: false`).', schema: SNAPSHOT_RESULT(false) },
      200: { description: 'Migawka była już zatwierdzona: bez nowego zapisu (`replayed: true`).', schema: SNAPSHOT_RESULT(true) },
    },
    errors: mergeErrors(BODY, {
      403: ['four_eyes_required', 'mfa_stale'],
      404: ['report_snapshot_not_found'],
      409: ['report_snapshot_superseded'],
    }),
  },
};
