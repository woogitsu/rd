// Schematy OpenAPI dla modułu `year-close` (src/pg/routes/year-close.js; #15, #80, #97, #125, #133, #138, #150, #152,
// #169, #195, #199, #205, #212, #213), #160 etap 14: stan zamknięcia roku z listą kontrolną i bilansem, rozpoczęcie,
// potwierdzenie punktu listy kontrolnej, zamknięcie (cztery oczy, krok w górę MFA) i zestawienie przekazania. Pisane
// ręcznie na podstawie `statusView`, `checklistView`, `balanceView`, `yearEndCheck`, `closeWarnings`, `accessLogReview`,
// `expenseReviewSummary` i `handover` oraz testów tests/pg-year-close*.test.js; trasy się nie zmieniają.
//
// Cechy modułu, które schemat odwzorowuje (opis stanu, nie zmiana tras):
//   * odczyt i lista kontrolna: zarząd i skarbnik; rozpoczęcie i zamknięcie: wyłącznie zarząd — zawsze z MFA i przydziałem
//     BEZ klasy w zakresie zamykanego roku (albo bez zakresu roku). Admin techniczny, Komisja Rewizyjna, dyrekcja,
//     przedstawiciel i zarząd zawężony do klasy → 403 `forbidden`. Wyjątek (#195): zestawienie przekazania zamkniętego
//     roku czyta też zarząd/skarbnik roku następnego i admin (tylko odczyt, ślad w dzienniku);
//   * zamknięcie: inna osoba niż rozpoczynająca (409 `four_eyes_required`), wszystkie punkty listy kontrolnej (409
//     `checklist_incomplete` z `missingChecklistItems`), MFA potwierdzone w ciągu 15 min (403 `mfa_stale`, #150),
//     bilans zgodny z saldem księgi na koniec roku albo jawne potwierdzenie rozbieżności (409 `year_end_balance_mismatch` /
//     `year_end_confirmation_mismatch` z `yearEndCheck`, #169). Zamknięcie wygasza przydziały roku: osoba, której przydział
//     wygasł tym zamknięciem, dostaje przy ponowieniu 409 `school_year_closed`, a osoba z przydziałem bez roku — 200
//     z `replayed: true`;
//   * moduł nie ma `Idempotency-Key` ani nagłówka `Idempotency-Replayed`: rozpoczęcie i potwierdzenie punktu dają 201
//     przy zapisie i 200 przy ponowieniu (pole `replayed` w treści); zamknięcie zawsze 200 (`replayed: false|true`);
//   * odpowiedzi to wyłącznie liczby, kody, daty i identyfikatory kont/obiektów — bez nazw rodzin, adresów i opisów
//     wpisów; uwaga do punktu listy kontrolnej przechodzi bramkę danych osobowych (#152).
import { PII_ERRORS, mergeErrors, nullable, ref, requestObject, strictObject } from './common.js';

export const name = 'year-close';

const STRING = { type: 'string' };
const BOOLEAN = { type: 'boolean' };
const COUNT = ref('Count');
const CENTS = ref('SignedCents');
const arrayOf = (items, description) => ({ type: 'array', items, ...(description ? { description } : {}) });
const nullableId = (description) => nullable(description ? { ...ref('EntityId'), description } : ref('EntityId'));
const nullableTime = (description) => nullable(description ? { ...ref('IsoDateTime'), description } : ref('IsoDateTime'));
const CHECKLIST_ITEMS = [
  'financial_report', 'audit_commission_report', 'minutes_approved', 'resolutions_archived', 'reconciliation_confirmed',
  'documents_handed_over',
];
const WARNING_CODES = [
  'unallocated_payments', 'payments_not_in_ledger', 'payment_ledger_amount_mismatch', 'expenses_without_evidence',
  'large_expenses_without_resolution', 'reconciliation_missing', 'reconciliation_before_year_end', 'reconciliation_difference',
  'reconciliation_drafts', 'unmatched_statement_lines', 'open_email_campaigns',
];
const DISCREPANCY_REASONS = ['entry_dated_after_year_end', 'explained_by_resolution', 'explained_outside_system'];
const countsByKey = (description) => ({ type: 'object', additionalProperties: COUNT, description });
const readTotals = strictObject({ entries: COUNT, hits: COUNT, actors: COUNT });

const BALANCE_FIELDS = {
  openingBalanceCents: CENTS,
  incomeCents: CENTS,
  expenseCents: CENTS,
  closingBalanceCents: CENTS,
  openingCashCents: nullable({ ...CENTS, description: 'Część poza rachunkiem (#199); null — zamknięcie sprzed migracji 0028.' }),
  closingCashCents: nullable(CENTS),
  closingBankCents: nullable({ ...CENTS, description: 'Rachunek = całość − kasa (D-13).' }),
};

const STATUS_PROPERTIES = {
  schoolYearId: ref('EntityId'),
  status: { type: 'string', enum: ['open', 'closing', 'closed'], description: '`open` — zamknięcia nie rozpoczęto.' },
  closureId: nullableId(),
  nextSchoolYearId: nullableId('Rok, do którego przechodzi bilans zamknięcia.'),
  initiatedBy: nullableId('Konto rozpoczynające (nie może zamknąć — cztery oczy).'),
  initiatedAt: nullableTime(),
  closedBy: nullableId(),
  closedAt: nullableTime(),
  carriedOpeningBalanceId: nullableId('Bilans otwarcia roku następnego utworzony przy zamknięciu.'),
  expiredGrantCount: nullable({ ...COUNT, description: 'Przydziały wygaszone zamknięciem.' }),
  checklist: { ...arrayOf(ref('YearCloseChecklistItem')), minItems: 6, maxItems: 6, description: 'Wszystkie punkty w stałej kolejności.' },
  missingChecklistItems: arrayOf({ type: 'string', enum: CHECKLIST_ITEMS }),
  balance: ref('YearCloseBalance'),
  yearEndCheck: ref('YearCloseYearEndCheck'),
  expenseReviews: strictObject({
    unverified: strictObject({ count: COUNT, netCents: CENTS }),
    questioned: strictObject({ count: COUNT, netCents: CENTS }),
  }, [], { description: 'Wydatki bez weryfikacji drugiej osoby i zakwestionowane (#97) — nie blokują zamknięcia.' }),
  warnings: arrayOf(ref('YearCloseWarning'), 'Ostrzeżenia informacyjne (#80, #138) w stałej kolejności; nie blokują zamknięcia.'),
  accessReview: strictObject({
    informational: { const: true },
    reads: arrayOf(strictObject({ accessKind: STRING, entries: COUNT, hits: COUNT, actors: COUNT })),
    readsWithoutValidGrant: readTotals,
    activeGrantsInScope: COUNT,
  }, [], { description: 'Przegląd dziennika odczytu danych rodzin roku (#133): tylko liczby, bez identyfikatorów kont i gospodarstw.' }),
};

export const components = {
  YearCloseChecklistItem: strictObject({
    item: { type: 'string', enum: CHECKLIST_ITEMS },
    confirmed: BOOLEAN,
    confirmedBy: nullableId(),
    confirmedAt: nullableTime(),
    note: nullable(STRING),
    documentId: nullableId('Dokument zarządu albo finansowy zamykanego roku.'),
    reportSnapshotId: nullableId('Zatwierdzona, bieżąca migawka sprawozdania rocznego (tylko `financial_report`, #125).'),
  }),
  YearCloseBalance: strictObject({
    source: { type: 'string', enum: ['live', 'closed'], description: '`closed` — wartości utrwalone przy zamknięciu.' },
    ...BALANCE_FIELDS,
  }, [], { description: 'Bilans roku w eurocentach (EUR).' }),
  YearCloseYearEndCheck: strictObject({
    ok: { type: 'boolean', description: 'Bilans zamknięcia = saldo księgi na koniec roku (całość i kasa).' },
    closingBalanceCents: CENTS,
    balanceAtYearEndCents: CENTS,
    balanceDifferenceCents: CENTS,
    closingCashCents: CENTS,
    cashAtYearEndCents: CENTS,
    cashDifferenceCents: CENTS,
    closingBankCents: CENTS,
    bankAtYearEndCents: CENTS,
    bankDifferenceCents: CENTS,
  }, [], { description: 'Kontrola salda końca roku (#169).' }),
  YearCloseWarning: strictObject({
    code: { type: 'string', enum: WARNING_CODES },
    count: { type: 'integer', minimum: 1 },
    amountCents: nullable(CENTS),
  }, [], { description: 'Liczba i kwota — bez opisów wpisów i identyfikatorów osób; „brak wpisu wpłaty” nie jest statusem dłużnika.' }),
  YearCloseStatus: strictObject(STATUS_PROPERTIES, [], { description: 'Stan zamknięcia roku (jedna migawka bazy, #213).' }),
  YearCloseStatusWrite: strictObject({
    ...STATUS_PROPERTIES,
    replayed: { type: 'boolean', description: 'true: ponowienie zakończonej operacji — stan bez nowego zapisu i zdarzenia.' },
  }, [], { description: 'Stan po zapisie (rozpoczęcie, punkt listy kontrolnej, zamknięcie).' }),
  YearCloseHandover: strictObject({
    asOf: { ...ref('IsoDateTime'), description: 'Czas migawki bazy (#213).' },
    final: { type: 'boolean', description: 'true: rok zamknięty (zestawienie ostateczne).' },
    schoolYear: strictObject({ id: ref('EntityId'), label: STRING, startsOn: ref('IsoDate'), endsOn: ref('IsoDate') }),
    status: { type: 'string', enum: ['open', 'closing', 'closed'] },
    closureId: nullableId(),
    nextSchoolYearId: nullableId(),
    initiatedBy: nullableId(),
    closedBy: nullableId(),
    closedAt: nullableTime(),
    finance: strictObject({
      source: { type: 'string', enum: ['live', 'closed'] },
      ...BALANCE_FIELDS,
      ledgerEntryCount: COUNT,
      ledgerCorrectionCount: COUNT,
      nextYearOpeningBalance: nullable(strictObject({
        id: ref('EntityId'),
        amountCents: CENTS,
        adjustmentsCents: CENTS,
        cashCents: CENTS,
        cashAdjustmentsCents: CENTS,
        carriedFromClosure: { type: 'boolean', description: 'true: bilans otwarcia przeniesiony tym zamknięciem.' },
      })),
    }),
    payments: strictObject({
      recordedCount: COUNT,
      recordedNetCents: CENTS,
      unmatchedCount: COUNT,
      unmatchedNetCents: CENTS,
      unmatchedAllocatedCents: CENTS,
      correctionCount: COUNT,
    }, [], { description: 'Liczby i kwoty wpłat roku — bez gospodarstw.' }),
    meetings: strictObject({ byStatus: countsByKey('Liczba zebrań wg statusu.'), heldWithoutApprovedMinutes: COUNT }),
    resolutions: strictObject({ byStatus: countsByKey('Liczba uchwał wg statusu (bez zastąpionych korektą).') }),
    events: strictObject({ byStatus: countsByKey('Liczba wydarzeń wg statusu.') }),
    checklist: { ...arrayOf(ref('YearCloseChecklistItem')), minItems: 6, maxItems: 6 },
    roles: strictObject({
      expiredGrantCount: nullable(COUNT),
      activeGrantsNextYearByRole: countsByKey('Aktywne przydziały roku następnego wg roli (nowa Rada).'),
    }),
  }, [], { description: 'Zestawienie przekazania dokumentacji nowej Radzie (JSON, bez danych osobowych).' }),

  YearCloseStartRequest: requestObject({
    nextSchoolYearId: {
      ...ref('Id'),
      description: 'Rok następny (400 `invalid_next_school_year`; nieznany → 404 `next_school_year_not_found`; nie następuje po '
        + 'zamykanym → 409 `invalid_next_school_year`).',
    },
  }, ['nextSchoolYearId']),
  YearCloseChecklistRequest: requestObject({
    note: nullable({ type: 'string', minLength: 3, maxLength: 500, description: 'Po przycięciu 3-500 znaków (400 `invalid_note`); bramka danych osobowych (#152).' }),
    documentId: nullable({ ...ref('Id'), description: 'Dokument zarządu/finansowy tego roku; inny, nieistniejący i spoza roku → 400 `invalid_document_id`.' }),
    reportSnapshotId: nullable({
      ...ref('Id'),
      description: 'Tylko punkt `financial_report`: zatwierdzona, bieżąca migawka roku (inaczej 400 `invalid_report_snapshot`).',
    }),
    confirmPersonalData: { type: 'boolean', description: 'Potwierdza ostrzeżenie 422 `possible_personal_data`.' },
  }, [], { description: 'Ciało opcjonalne: żądanie bez treści (także bez `Content-Type`) potwierdza punkt bez uwagi.' }),
  YearCloseCloseRequest: requestObject({
    confirmYearEndDiscrepancy: requestObject({
      reason: { type: 'string', enum: DISCREPANCY_REASONS },
      balanceDifferenceCents: { type: 'integer', description: 'Różnica widziana w `yearEndCheck` (inna → 409 `year_end_confirmation_mismatch`).' },
      cashDifferenceCents: { type: 'integer' },
    }, ['reason', 'balanceDifferenceCents', 'cashDifferenceCents'], {
      description: 'Jawne potwierdzenie rozbieżności salda końca roku (#169); zły kształt → 400 `invalid_year_end_confirmation`.',
    }),
  }, [], { description: 'Ciało opcjonalne: bez rozbieżności salda zamknięcie nie wymaga treści.' }),
};

// ---------- kody błędów ----------

// Bramka trasy (rola z MFA, przydział bez klasy w zakresie roku) i bramka MFA routera; identyfikator roku w ścieżce.
const GATE = { 400: ['invalid_school_year_id'], 403: ['forbidden', 'mfa_enrollment_required', 'mfa_required'] };
// Czytnik JSON modułu (8 KiB; puste ciało = `{}`, typ sprawdzany dopiero przy niepustym ciele).
const BODY = { 400: ['invalid_json'], 403: ['invalid_origin'], 413: ['request_too_large'], 415: ['invalid_content_type'] };
const YEAR = { 404: ['school_year_not_found'] };

/** Klucz: `METODA /ścieżka-openapi` (jak w docs/openapi.json). */
export const routes = {
  'GET /api/year-close/{schoolYearId}': {
    responses: { 200: { description: 'Stan zamknięcia, lista kontrolna, bilans, kontrola końca roku i ostrzeżenia.', schema: ref('YearCloseStatus') } },
    errors: mergeErrors(GATE, YEAR),
  },
  'POST /api/year-close/{schoolYearId}/start': {
    body: ref('YearCloseStartRequest'),
    responses: {
      201: { description: 'Rozpoczęcie zamknięcia (`closing`); zdarzenie `year_close.started`; `replayed: false`.', schema: ref('YearCloseStatusWrite') },
      200: { description: 'Ponowienie z tym samym rokiem następnym: stan bez zapisu, `replayed: true`.', schema: ref('YearCloseStatusWrite') },
    },
    errors: mergeErrors(GATE, BODY, YEAR, {
      400: ['invalid_next_school_year'],
      404: ['next_school_year_not_found'],
      409: ['invalid_next_school_year', 'next_school_year_not_open', 'school_year_closed', 'year_close_already_started'],
    }),
  },
  'POST /api/year-close/{schoolYearId}/checklist/{item}': {
    body: ref('YearCloseChecklistRequest'),
    bodyOptional: true,
    responses: {
      201: { description: 'Potwierdzenie punktu (`year_close.checklist_confirmed`); `replayed: false`.', schema: ref('YearCloseStatusWrite') },
      200: { description: 'Punkt już potwierdzony: stan bez zapisu (pierwsza uwaga zostaje), `replayed: true`.', schema: ref('YearCloseStatusWrite') },
    },
    errors: mergeErrors(GATE, BODY, YEAR, PII_ERRORS, {
      400: ['invalid_document_id', 'invalid_note', 'invalid_report_snapshot'],
      404: ['invalid_checklist_item'],
      409: ['school_year_closed', 'year_close_not_started'],
    }),
  },
  'GET /api/year-close/{schoolYearId}/handover': {
    responses: {
      200: {
        description: 'Zestawienie przekazania (jedna migawka bazy); po zamknięciu czyta je też Rada roku następnego i admin (#195).',
        schema: ref('YearCloseHandover'),
      },
    },
    errors: mergeErrors(GATE, YEAR),
  },
  'POST /api/year-close/{schoolYearId}/close': {
    body: ref('YearCloseCloseRequest'),
    bodyOptional: true,
    responses: {
      200: {
        description: 'Zamknięcie przez drugą osobę z zarządu (świeże MFA): bilans utrwalony, bilans otwarcia roku następnego, '
          + 'wygaszenie przydziałów roku, zamrożenie zapisów roku; `replayed: false`. Ponowienie po zamknięciu (przydział bez '
          + 'roku): ten sam stan, `replayed: true`.',
        schema: ref('YearCloseStatusWrite'),
      },
    },
    errors: mergeErrors(GATE, BODY, YEAR, {
      400: ['invalid_year_end_confirmation'],
      403: ['mfa_stale'],
      409: [
        'checklist_incomplete', 'closing_balance_out_of_range', 'four_eyes_required', 'next_year_opening_balance_exists',
        'school_year_closed', 'year_close_not_started', 'year_end_balance_mismatch', 'year_end_confirmation_mismatch',
      ],
    }),
  },
};
