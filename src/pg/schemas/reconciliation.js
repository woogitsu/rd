// Schematy OpenAPI dla modułu `reconciliation` (src/pg/routes/reconciliation.js, #7, #15, #105, #115,
// #127, #138), #160 etap 5: uzgodnienia rachunku bankowego z księgą — utworzenie i lista, import
// pozycji wyciągu (JSON, ogólny CSV, CODA, CAMT.053), widok z kursorem pozycji, propozycje dopasowań,
// dopasowania 1:1, wsadowe i zbiorcze z cofnięciem, wpłata z pozycji wyciągu, dopasowanie zwrotu do
// ujemnej pozycji, zatwierdzenie (zasada czterech oczu) i porzucenie szkicu — oraz raport dla Komisji
// Rewizyjnej (`GET /api/reports/audit`, JSON, XLSX, HTML), który w macierzy tras należy do tego modułu.
//
// Pisane ręcznie na podstawie parserów (`parseStatementLines`, `parseStatementFile`, `parseBatchPairs`,
// `parseGroupItems`), mapperów (`reconciliationFromRow`, `matchFromRow`, `loadGroupMatches`,
// `getReconciliation`, `suggestMatches`, `buildAuditReport`) i testów tests/pg-reconciliation*.test.js,
// tests/pg-bank-statement-import.test.js; trasy się nie zmieniają. Treść tytułu przelewu nie występuje
// w żadnej odpowiedzi (serwer trzyma tylko solony skrót, `hasReference`).
import {
  HTML_CONTENT_TYPE, OCTET_XLSX, PII_ERRORS, formatsResponse, mergeErrors, nullable, ref, replayed,
  requestObject, strictObject,
} from './common.js';

export const name = 'reconciliation';

const CONFIRM = {
  type: 'boolean',
  description: 'true potwierdza ostrzeżenie bramki danych osobowych (#152), np. 422 `possible_personal_data`.',
};
const REASON = {
  type: 'string', minLength: 3, maxLength: 500,
  description: 'Powód (3-500 znaków po przycięciu spacji); bramka danych osobowych (#152). Ponowienie tej samej osoby z tym samym powodem odtwarza wynik.',
};
const LINE_CENTS = {
  anyOf: [{ type: 'integer', minimum: 1, maximum: 100000000 }, { type: 'integer', minimum: -100000000, maximum: -1 }],
  description: 'Kwota pozycji w eurocentach ze znakiem (wpływ > 0, wypływ < 0, nigdy 0); |kwota| ≤ 1 000 000,00 EUR.',
};
const nullableId = (description) => ({ anyOf: [ref('Id'), { type: 'null' }], ...(description ? { description } : {}) });

// Zapis zwracający 200 przy pierwszym wykonaniu (`Idempotency-Replayed: false`) i przy ponowieniu (`true`):
// zatwierdzenie, porzucenie i cofnięcia nie mają klucza idempotencji, ponowienie rozpoznają po osobie i treści.
const FRESH_OR_REPLAY = ['false', 'true'];

const RECONCILIATION_STATUS = {
  type: 'string', enum: ['draft', 'confirmed', 'abandoned'],
  description: 'draft = szkic, confirmed = zatwierdzone (niezmienne), abandoned = porzucony szkic (0107; historia zostaje).',
};

const GROUP_MATCH_PROPERTIES = {
  id: ref('EntityId'),
  reconciliationId: ref('EntityId'),
  statementLineId: ref('EntityId'),
  items: {
    type: 'array', minItems: 2, maxItems: 50,
    items: strictObject({
      id: ref('EntityId'),
      ledgerEntryId: nullable(ref('EntityId')),
      paymentEntryId: nullable(ref('EntityId')),
      amountCents: { ...LINE_CENTS, description: 'Netto celu w chwili dopasowania, ze znakiem pozycji wyciągu (wydatek < 0), w eurocentach.' },
    }, [], { description: 'Cel dopasowania zbiorczego: dokładnie jedno z `ledgerEntryId`, `paymentEntryId`.' }),
  },
  createdBy: ref('EntityId'),
  createdAt: ref('IsoDateTime'),
  revokedAt: nullable(ref('IsoDateTime')),
  revokedBy: nullable(ref('EntityId')),
  revokeReason: nullable({ type: 'string' }),
};

// --- raport dla Komisji Rewizyjnej -------------------------------------------------

const MONEY_TRIPLE = strictObject({
  incomeCents: ref('NonNegativeCents'), expenseCents: ref('NonNegativeCents'), resultCents: ref('SignedCents'),
});
const TALLY = strictObject({ count: ref('Count'), netCents: ref('NonNegativeCents') });
const REVIEW_NOTE = ref('AuditReportReviewNote');
const REVIEW_NOTE_PROPERTIES = {
  id: ref('EntityId'),
  kind: { type: 'string', enum: ['question', 'finding', 'answer', 'closed', 'conclusion'] },
  targetType: { type: 'string', enum: ['ledger_entry', 'reconciliation', 'year'] },
  targetId: ref('EntityId'),
  parentId: nullable(ref('EntityId')),
  body: nullable({ type: 'string' }),
  createdBy: ref('EntityId'),
  createdAt: ref('IsoDateTime'),
};

const CHECK_ITEMS = [
  strictObject({
    id: { const: 'year_end_balance' },
    ok: { type: 'boolean' },
    closingBalanceCents: ref('SignedCents'),
    balanceAtYearEndCents: ref('SignedCents'),
    differenceCents: ref('SignedCents'),
  }, [], { description: 'Saldo z wpisów do końca roku vs bilans zamknięcia.' }),
  strictObject({
    id: { const: 'dates_within_school_year' },
    ok: { type: 'boolean' },
    ledgerEntryCount: ref('Count'),
    paymentCount: ref('Count'),
    items: {
      type: 'array', maxItems: 50,
      items: strictObject({ kind: { type: 'string', enum: ['ledger_entry', 'payment_entry'] }, id: ref('EntityId'), date: ref('IsoDate') }),
      description: 'Pierwsze 50 wpisów z datą spoza roku szkolnego.',
    },
  }),
  strictObject({
    id: { const: 'payments_in_ledger' },
    ok: { type: 'boolean' },
    paymentsNetCents: ref('SignedCents'),
    ledgerLinkedNetCents: ref('SignedCents'),
    differenceCents: ref('SignedCents'),
    paymentsWithoutLedgerEntry: ref('Count'),
  }, [], { description: 'Wpłaty (moduł wpłat) vs ujęcie wpłat w księdze; brak wpisu księgi to nie status dłużnika.' }),
  strictObject({
    id: { const: 'reconciliation_matches' },
    ok: { type: 'boolean' },
    amountMismatchCount: ref('Count'),
    doubleCountedCount: ref('Count'),
    amountMismatchConfirmedCount: ref('Count'),
    groupAmountMismatchCount: ref('Count'),
    groupAmountMismatchConfirmedCount: ref('Count'),
  }),
  strictObject({
    id: { const: 'latest_confirmed_reconciliation' },
    ok: nullable({ type: 'boolean' }),
    statementDate: nullable(ref('IsoDate')),
    differenceCents: nullable(ref('SignedCents')),
    bankEntriesAfterStatement: nullable(ref('Count')),
  }, [], { description: 'Ostatnie zatwierdzone uzgodnienie; bez niego wszystkie pola poza `id` = null.' }),
];

export const components = {
  ReconciliationStatus: RECONCILIATION_STATUS,
  BankStatementSource: {
    type: 'string', enum: ['manual', 'csv', 'coda', 'camt053'],
    description: 'Źródło paczki pozycji: manual = lista JSON, csv = ogólny CSV, coda / camt053 = plik banku (#105).',
  },
  Reconciliation: strictObject({
    id: ref('EntityId'),
    schoolYearId: ref('EntityId'),
    statementDate: ref('IsoDate'),
    statementBalanceCents: { ...ref('SignedCents'), description: 'Saldo z wyciągu podane przez osobę uzgadniającą.' },
    ledgerBalanceCents: { ...ref('SignedCents'), description: 'Saldo rachunku z księgi na dzień wyciągu, liczone przez bazę (szkic: bieżące; zatwierdzone: utrwalone).' },
    ledgerNonBankCents: { ...ref('SignedCents'), description: 'Netto wpisów niebankowych (kasa) do dnia wyciągu — informacyjnie.' },
    differenceCents: { ...ref('SignedCents'), description: 'Saldo wyciągu minus saldo księgi.' },
    status: ref('ReconciliationStatus'),
    notes: nullable({ type: 'string' }),
    createdBy: ref('EntityId'),
    createdAt: ref('IsoDateTime'),
    confirmedBy: nullable(ref('EntityId')),
    confirmedAt: nullable(ref('IsoDateTime')),
    confirmationNote: nullable({ type: 'string' }),
    abandonedBy: nullable(ref('EntityId')),
    abandonedAt: nullable(ref('IsoDateTime')),
    abandonReason: nullable({ type: 'string' }),
  }, [], { description: 'Uzgodnienie wyciągu z księgą (bez soli skrótów tytułów i klucza idempotencji).' }),
  ReconciliationMatch: strictObject({
    id: ref('EntityId'),
    reconciliationId: ref('EntityId'),
    statementLineId: ref('EntityId'),
    ledgerEntryId: nullable(ref('EntityId')),
    paymentEntryId: nullable(ref('EntityId')),
    paymentRefundId: { ...ref('EntityId'), description: 'Tylko powiązanie ze zwrotem wpłaty (0152, #138); przy pozostałych pole nie występuje.' },
    createdBy: ref('EntityId'),
    createdAt: ref('IsoDateTime'),
    revokedAt: nullable(ref('IsoDateTime')),
    revokedBy: nullable(ref('EntityId')),
    revokeReason: nullable({ type: 'string' }),
  }, ['paymentRefundId'], { description: 'Powiązanie 1:1 pozycji wyciągu z wpisem księgi, wpłatą albo zwrotem; cofnięcie to znacznik, nie usunięcie.' }),
  ReconciliationGroupMatch: strictObject(GROUP_MATCH_PROPERTIES, [], {
    description: 'Dopasowanie zbiorcze (#127): jedna pozycja ↔ 2-50 wpłat lub wpisów księgi o łącznej kwocie pozycji.',
  }),
  BankStatementImport: strictObject({
    id: ref('EntityId'),
    reconciliationId: ref('EntityId'),
    source: ref('BankStatementSource'),
    lineCount: { type: 'integer', minimum: 1, maximum: 500 },
  }, [], { description: 'Paczka pozycji wyciągu (import); pozycje są niezmienne.' }),
  BankStatementSkippedDuplicate: strictObject({
    record: { type: 'integer', minimum: 1, description: 'Numer rekordu w pliku (nigdy fragment treści).' },
    bookedOn: ref('IsoDate'),
    amountCents: LINE_CENTS,
    reconciliationId: nullable({ ...ref('EntityId'), description: 'Uzgodnienie z wcześniejszym importem ruchu — tylko dla osoby z dostępem do jego roku.' }),
  }, [], { description: 'Ruch pominięty, bo ten sam identyfikator transakcji banku był już zaimportowany (albo powtarza się w pliku).' }),
  BankStatementFileBalances: strictObject({
    statementNumber: nullable({ type: 'string' }),
    openingBalanceCents: ref('SignedCents'),
    openingDate: ref('IsoDate'),
    closingBalanceCents: ref('SignedCents'),
    closingDate: ref('IsoDate'),
  }, [], { description: 'Salda i numer wyciągu odczytane z pliku CODA/CAMT.053.' }),
  BankStatementImportWarning: {
    type: 'string', enum: ['closing_balance_mismatch', 'opening_balance_discontinuity', 'statement_date_differs', 'statement_balance_differs'],
    description: 'Ostrzeżenie kontroli ciągłości pliku — nic nie blokuje importu.',
  },
  ReconciliationLine: strictObject({
    id: ref('EntityId'),
    importId: ref('EntityId'),
    source: ref('BankStatementSource'),
    lineNo: { type: 'integer', minimum: 1, description: 'Numer pozycji w paczce importu.' },
    bookedOn: ref('IsoDate'),
    amountCents: LINE_CENTS,
    hasReference: { type: 'boolean', description: 'true = pozycja miała tytuł (zapisany wyłącznie jako solony skrót).' },
    match: nullable(strictObject({
      id: ref('EntityId'),
      ledgerEntryId: nullable(ref('EntityId')),
      paymentEntryId: nullable(ref('EntityId')),
      paymentRefundId: ref('EntityId'),
    }, ['paymentRefundId'], { description: 'Aktywne powiązanie 1:1; `paymentRefundId` tylko przy zwrocie.' })),
    groupMatch: nullable(strictObject({ id: ref('EntityId'), itemCount: { type: 'integer', minimum: 2 } }, [], {
      description: 'Aktywne dopasowanie zbiorcze (wtedy `match` = null).',
    })),
  }),
  ReconciliationInconsistentMatch: strictObject({
    matchId: ref('EntityId'),
    statementLineId: ref('EntityId'),
    ledgerEntryId: nullable(ref('EntityId')),
    paymentEntryId: nullable(ref('EntityId')),
    paymentRefundId: ref('EntityId'),
    lineAmountCents: LINE_CENTS,
    targetNetCents: nullable(ref('SignedCents')),
    reasons: { type: 'array', minItems: 1, items: { type: 'string', enum: ['amount_mismatch', 'double_counted'] } },
  }, ['paymentRefundId'], { description: 'Aktywne powiązanie niezgodne kwotowo z dzisiejszym netto celu albo liczące tę samą wpłatę dwa razy (#162, #165).' }),
  ReconciliationInconsistentGroupMatch: strictObject({
    groupMatchId: ref('EntityId'),
    statementLineId: ref('EntityId'),
    lineAmountCents: LINE_CENTS,
    matchedTotalCents: ref('SignedCents'),
    targetNetCents: ref('SignedCents'),
    reasons: { type: 'array', minItems: 1, items: { type: 'string', enum: ['amount_mismatch', 'target_changed'] } },
  }),
  ReconciliationView: strictObject({
    reconciliation: ref('Reconciliation'),
    lines: { type: 'array', maxItems: 500, items: ref('ReconciliationLine'), description: 'Strona pozycji (data księgowania, id); `limit` 1-500, domyślnie 500.' },
    nextCursor: nullable({ type: 'string', description: 'Kursor następnej strony pozycji (ważny tylko dla tego uzgodnienia); null = ostatnia strona.' }),
    matches: { type: 'array', items: ref('ReconciliationMatch'), description: 'Wszystkie powiązania 1:1, także cofnięte.' },
    groupMatches: { type: 'array', items: ref('ReconciliationGroupMatch'), description: 'Wszystkie dopasowania zbiorcze, także cofnięte.' },
    summary: strictObject({
      lineCount: ref('Count'),
      matchedLineCount: { ...ref('Count'), description: 'Pozycje poprawnie dopasowane (bez niespójnych).' },
      unmatchedLineCount: ref('Count'),
      unmatchedLineTotalCents: ref('SignedCents'),
      inconsistentMatchCount: ref('Count'),
      groupMatchedLineCount: ref('Count'),
      inconsistentGroupMatchCount: ref('Count'),
    }, [], { description: 'Liczone ze wszystkich pozycji, niezależnie od strony `lines`.' }),
    inconsistentMatches: { type: 'array', items: ref('ReconciliationInconsistentMatch') },
    inconsistentGroupMatches: { type: 'array', items: ref('ReconciliationInconsistentGroupMatch') },
    unmatchedLedgerEntries: {
      type: 'array', maxItems: 1000,
      items: strictObject({
        id: ref('EntityId'),
        direction: ref('LedgerDirection'),
        occurredOn: ref('IsoDate'),
        netAmountCents: ref('AmountCents'),
        categoryId: ref('EntityId'),
        description: { type: 'string' },
      }),
      description: 'Bankowe wpisy księgi do dnia wyciągu bez powiązania w tym uzgodnieniu (najwyżej 1000).',
    },
    unmatchedLedgerEntriesTruncated: { type: 'boolean', description: 'true = wpisów jest więcej niż 1000 (lista obcięta).' },
  }, [], { description: 'Uzgodnienie z jedną stroną pozycji wyciągu, powiązaniami i podsumowaniem z jednej migawki.' }),
  ReconciliationCandidate: {
    oneOf: [
      strictObject({
        type: { type: 'string', enum: ['ledger_entry', 'payment_entry'] },
        id: ref('EntityId'),
        date: ref('IsoDate'),
        method: { type: 'string', enum: ['bank'], description: 'Kandydaci to wyłącznie operacje bankowe.' },
        amountCents: { ...ref('AmountCents'), description: 'Netto wpisu księgi albo wpłaty po korektach.' },
        dayDistance: ref('Count'),
        referenceMatch: { type: 'boolean', description: 'Skrót tytułu wpłaty = skrót tytułu pozycji.' },
        structuredReferenceMatch: { type: 'boolean', description: 'Gospodarstwo celu wskazane komunikacją strukturalną pozycji (#83).' },
      }),
      strictObject({
        type: { const: 'household' },
        id: ref('EntityId'),
        householdId: ref('EntityId'),
        date: { type: 'null' },
        method: { const: 'bank' },
        amountCents: ref('AmountCents'),
        dayDistance: { type: 'null' },
        referenceMatch: { const: false },
        structuredReferenceMatch: { const: true },
      }, [], { description: 'Propozycja nowej wpłaty z pozycji (POST …/lines/{lineId}/payment) dla gospodarstwa z rejestru referencji.' }),
    ],
    description: 'Kandydat dopasowania — wyłącznie propozycja, nigdy zatwierdzenie.',
  },
  ReconciliationSuggestions: strictObject({
    reconciliationId: ref('EntityId'),
    windowDays: { type: 'integer', minimum: 0, maximum: 31 },
    suggestions: {
      type: 'array',
      items: strictObject({
        statementLineId: ref('EntityId'),
        bookedOn: ref('IsoDate'),
        amountCents: LINE_CENTS,
        candidates: { type: 'array', maxItems: 5, items: ref('ReconciliationCandidate') },
      }),
      description: 'Jedna pozycja na każdą otwartą pozycję wyciągu (także bez kandydatów).',
    },
  }),
  ReconciliationLinePayment: strictObject({
    payment: strictObject({
      id: ref('EntityId'),
      householdId: nullable(ref('EntityId')),
      schoolYearId: ref('EntityId'),
      amountCents: ref('AmountCents'),
      receivedOn: { ...ref('IsoDate'), description: 'Data księgowania pozycji wyciągu.' },
      method: { const: 'bank' },
      status: ref('PaymentStatus'),
    }),
    match: strictObject({
      id: ref('EntityId'), reconciliationId: ref('EntityId'), statementLineId: ref('EntityId'), paymentEntryId: ref('EntityId'),
    }),
  }, [], { description: 'Wpłata utworzona z dodatniej pozycji wyciągu i jej powiązanie (jedna transakcja, jeden klucz).' }),

  AuditReportReviewNote: strictObject(REVIEW_NOTE_PROPERTIES, [], { description: 'Zapis ścieżki kontroli Komisji Rewizyjnej (#137; niezmienny).' }),
  AuditReportReconciliationItem: strictObject({
    id: ref('EntityId'),
    statementDate: ref('IsoDate'),
    status: ref('ReconciliationStatus'),
    statementBalanceCents: ref('SignedCents'),
    ledgerBalanceCents: ref('SignedCents'),
    ledgerNonBankCents: ref('SignedCents'),
    differenceCents: ref('SignedCents'),
    unmatchedLineCount: ref('Count'),
    createdBy: ref('EntityId'),
    confirmedBy: nullable(ref('EntityId')),
    confirmedAt: nullable(ref('IsoDateTime')),
    confirmationNote: nullable({ type: 'string' }),
    abandonedAt: nullable(ref('IsoDateTime')),
    abandonReason: nullable({ type: 'string' }),
  }),
  AuditReportCheck: { oneOf: CHECK_ITEMS, description: 'Kontrola krzyżowa raportu (#169): wskaźnik z liczbami, nic nie blokuje zapisu.' },
  AuditReport: strictObject({
    schoolYear: strictObject({ id: ref('EntityId'), label: { type: 'string' }, startsOn: ref('IsoDate'), endsOn: ref('IsoDate') }),
    asOf: { ...ref('IsoDateTime'), description: 'Chwila migawki, z której pochodzą wszystkie liczby raportu.' },
    generatedAt: { ...ref('IsoDateTime'), description: 'Zgodność wsteczna; ta sama wartość co `asOf`.' },
    balance: strictObject({
      openingBalanceCents: ref('SignedCents'),
      incomeCents: ref('NonNegativeCents'),
      expenseCents: ref('NonNegativeCents'),
      closingBalanceCents: ref('SignedCents'),
      openingCashCents: ref('SignedCents'),
      closingCashCents: ref('SignedCents'),
      openingBankCents: ref('SignedCents'),
      closingBankCents: ref('SignedCents'),
    }, [], { description: 'Bilans roku z podziałem rachunek/kasa (#199).' }),
    categories: {
      type: 'array',
      items: strictObject({
        id: ref('EntityId'), direction: ref('LedgerDirection'), name: { type: 'string' }, entryCount: ref('Count'),
        grossCents: ref('NonNegativeCents'), correctedCents: ref('NonNegativeCents'), netCents: ref('NonNegativeCents'),
      }),
    },
    budgetExecution: ref('LedgerBudgetExecution'),
    largeExpenseThresholdCents: ref('AmountCents'),
    largeExpenses: {
      type: 'array',
      items: strictObject({
        id: ref('EntityId'),
        occurredOn: ref('IsoDate'),
        amountCents: ref('AmountCents'),
        netAmountCents: ref('NonNegativeCents'),
        description: { type: 'string' },
        category: { type: 'string' },
        resolutionReference: nullable({ type: 'string' }),
        resolutionId: nullable(ref('EntityId')),
        resolutionLink: { type: 'string', enum: ['explicit', 'text'], description: 'explicit = uchwała wskazana przy zapisie, text = dopasowanie po numerze.' },
        matchesAdoptedResolution: nullable({ type: 'boolean' }),
        flagged: { type: 'boolean' },
      }),
      description: 'Wydatki powyżej progu z powiązaniem z uchwałą (#93).',
    },
    eventResults: strictObject({
      events: {
        type: 'array',
        items: strictObject({
          id: ref('EntityId'), title: { type: 'string' }, status: ref('EventStatus'), entryCount: ref('Count'),
          incomeCents: ref('NonNegativeCents'), expenseCents: ref('NonNegativeCents'), resultCents: ref('SignedCents'),
        }),
      },
      unallocated: MONEY_TRIPLE,
      totals: MONEY_TRIPLE,
    }, [], { description: 'Wynik wydarzeń z centrów kosztów (#117); bez danych osobowych.' }),
    resolutionExecution: {
      type: 'array',
      items: strictObject({
        resolutionId: ref('EntityId'),
        schoolYearId: ref('EntityId'),
        number: nullable({ type: 'string' }),
        title: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'adopted', 'rejected', 'withdrawn'] },
        authorizedAmountCents: nullable(ref('NonNegativeCents')),
        validUntil: nullable(ref('IsoDate')),
        spentNetCents: ref('NonNegativeCents'),
        remainingCents: nullable(ref('SignedCents')),
        entryCount: ref('Count'),
        flagged: { type: 'boolean' },
      }),
    },
    expenseReviews: strictObject({
      unverified: TALLY,
      verified: TALLY,
      questioned: TALLY,
      questionedEntryIds: { type: 'array', items: ref('EntityId') },
      splitWindowDays: { type: 'integer', minimum: 1 },
      possibleSplits: {
        type: 'array',
        items: strictObject({
          category: { type: 'string' }, fromDate: ref('IsoDate'), toDate: ref('IsoDate'), entryCount: { type: 'integer', minimum: 2 },
          netCents: ref('NonNegativeCents'), ledgerEntryIds: { type: 'array', minItems: 2, items: ref('EntityId') },
        }),
        description: 'Możliwy podział wydatku — informacja do sprawdzenia, nie zarzut (#97).',
      },
    }),
    corrections: {
      type: 'array',
      items: strictObject({
        id: ref('EntityId'), ledgerEntryId: ref('EntityId'), entryOccurredOn: ref('IsoDate'), direction: ref('LedgerDirection'),
        amountCents: ref('AmountCents'), reason: { type: 'string' }, createdBy: ref('EntityId'), createdAt: ref('IsoDateTime'),
      }),
    },
    reclassifications: {
      type: 'array',
      items: strictObject({
        id: ref('EntityId'), replacesEntryId: ref('EntityId'), createdAt: ref('IsoDateTime'), createdBy: ref('EntityId'),
        oldOccurredOn: ref('IsoDate'), occurredOn: ref('IsoDate'), oldDirection: ref('LedgerDirection'), direction: ref('LedgerDirection'),
        oldMethod: ref('LedgerMethod'), method: ref('LedgerMethod'), oldCategory: { type: 'string' }, newCategory: { type: 'string' },
        stornoCents: ref('NonNegativeCents'), amountCents: ref('AmountCents'), reason: { type: 'string' },
        paymentLinked: { type: 'boolean' }, inConfirmedReconciliation: { type: 'boolean' },
      }),
      description: 'Przeksięgowania (storno + wpis zastępczy, #144).',
    },
    openingAdjustments: {
      type: 'array',
      items: strictObject({
        id: ref('EntityId'), amountCents: ref('SignedCents'), reason: { type: 'string' }, createdBy: ref('EntityId'), createdAt: ref('IsoDateTime'),
      }),
    },
    reconciliations: strictObject({
      items: { type: 'array', items: ref('AuditReportReconciliationItem') },
      confirmedCount: ref('Count'),
      draftCount: ref('Count'),
      abandonedCount: ref('Count'),
      latestConfirmed: nullable(ref('AuditReportReconciliationItem')),
    }),
    checks: strictObject({
      items: { type: 'array', minItems: 5, maxItems: 5, items: ref('AuditReportCheck') },
      largeExpensesWithoutAdoptedResolution: ref('Count'),
    }),
    evidence: strictObject({
      expensesWithoutEvidence: strictObject({
        count: ref('Count'),
        netCents: ref('NonNegativeCents'),
        items: {
          type: 'array',
          items: strictObject({
            id: ref('EntityId'), occurredOn: ref('IsoDate'), category: { type: 'string' }, description: { type: 'string' },
            netAmountCents: ref('AmountCents'),
            evidenceStatus: { const: 'voided', description: 'Tylko gdy wszystkie dokumenty wydatku są unieważnione (#594).' },
            voidedDocumentIds: { type: 'array', minItems: 1, items: ref('EntityId') },
          }, ['evidenceStatus', 'voidedDocumentIds']),
        },
      }),
      possibleDuplicateEvidence: {
        type: 'array',
        items: strictObject({
          documentIds: { type: 'array', minItems: 1, items: ref('EntityId') },
          ledgerEntryIds: { type: 'array', minItems: 2, items: ref('EntityId') },
        }),
      },
    }, [], { description: 'Dowody wydatków (#87): wydatki bez dowodu z aktualną wersją i możliwe duplikaty plików.' }),
    accountOperations: strictObject(Object.fromEntries([
      'protectedGrants', 'protectedGrantsApproved', 'fourEyesWaived', 'grantsRevoked', 'grantRequests', 'grantRequestsClosed',
      'adminPasswordResets', 'mfaResets', 'recoveryRequests', 'recoveryRequestsClosed', 'loginsAfterAdminReset',
    ].map((key) => [key, ref('Count')])), [], { description: 'Operacje administracyjne na kontach w roku (#146) — wyłącznie liczby.' }),
    reviewNotes: strictObject({
      threads: {
        type: 'array',
        items: strictObject({
          ...REVIEW_NOTE_PROPERTIES,
          kind: { type: 'string', enum: ['question', 'finding'] },
          status: { type: 'string', enum: ['open', 'answered', 'closed'] },
          answers: { type: 'array', items: REVIEW_NOTE },
          closed: nullable(REVIEW_NOTE),
        }, [], { description: 'Wątek: pytanie albo ustalenie z odpowiedziami i zamknięciem.' }),
      },
      conclusions: { type: 'array', items: REVIEW_NOTE },
      currentConclusion: nullable(REVIEW_NOTE),
      counts: strictObject({ open: ref('Count'), answered: ref('Count'), closed: ref('Count') }),
    }, [], { description: 'Ścieżka kontroli Komisji Rewizyjnej (#137) z tej samej migawki co reszta raportu.' }),
  }, [], { description: 'Raport roku dla Komisji Rewizyjnej (#15, #169); bez danych osobowych rodzin.' }),

  ReconciliationCreateRequest: requestObject({
    schoolYearId: ref('Id'),
    statementDate: { ...ref('IsoDate'), description: 'Dzień wyciągu w granicach roku szkolnego (inaczej 400 `statement_date_outside_school_year`).' },
    statementBalanceCents: {
      type: 'integer', minimum: -10000000000, maximum: 10000000000,
      description: 'Saldo z wyciągu w eurocentach ze znakiem; saldo księgi liczy serwer (pole klienta jest ignorowane).',
    },
    notes: {
      anyOf: [{ type: 'string', maxLength: 1000 }, { type: 'null' }],
      description: 'Uwagi (3-1000 znaków po przycięciu spacji; pusty tekst = brak); bramka danych osobowych (#152).',
    },
    confirmPersonalData: CONFIRM,
  }, ['schoolYearId', 'statementDate', 'statementBalanceCents']),
  BankStatementLinesRequest: requestObject({
    lines: {
      type: 'array', minItems: 1, maxItems: 500,
      items: requestObject({
        bookedOn: ref('IsoDate'),
        amountCents: LINE_CENTS,
        reference: {
          anyOf: [{ type: 'string' }, { type: 'null' }],
          description: 'Tytuł przelewu (do 300 znaków po normalizacji); zapisywany wyłącznie jako solony skrót SHA-256.',
        },
      }, ['bookedOn', 'amountCents']),
      description: 'Pozycje podane wprost (źródło `manual`).',
    },
    csv: {
      type: 'string', minLength: 1,
      description: 'Ogólny CSV z nagłówkiem (data, kwota, opcjonalnie tytuł); 1-500 pozycji; separator wykrywany, przy remisie 400 `ambiguous_csv_delimiter`.',
    },
    delimiter: { type: 'string', enum: [';', ',', '\t'], description: 'Ręcznie wybrany separator; tylko razem z `csv`.' },
    coda: { type: 'string', minLength: 1, description: 'Plik CODA (tekst); wymaga konfiguracji klucza skrótów i rachunku Rady (inaczej 503).' },
    camt053: { type: 'string', minLength: 1, description: 'Plik CAMT.053 (XML); wymagania jak przy `coda`.' },
  }, [], {
    oneOf: [{ required: ['lines'] }, { required: ['csv'] }, { required: ['coda'] }, { required: ['camt053'] }],
    description: 'Dokładnie jedno z `lines`, `csv`, `coda`, `camt053`; całe ciało do 256 KiB.',
  }),
  ReconciliationLinePaymentRequest: requestObject({
    householdId: nullableId('Gospodarstwo wpłaty; null albo brak = wpłata nieprzypisana (`unmatched`), do przypisania później.'),
  }, [], { description: 'Kwota, data i metoda pochodzą z pozycji wyciągu, nie z klienta.' }),
  ReconciliationMatchRequest: requestObject({
    statementLineId: ref('Id'),
    ledgerEntryId: nullableId('Wpis księgi (metoda bankowa) o netto równym kwocie pozycji.'),
    paymentEntryId: nullableId('Wpłata bankowa o netto równym kwocie pozycji.'),
    paymentRefundId: nullableId('Zwrot wpłaty (bankowy) dopasowany do ujemnej pozycji o tej samej kwocie (#138).'),
  }, ['statementLineId'], {
    anyOf: [{ required: ['ledgerEntryId'] }, { required: ['paymentEntryId'] }, { required: ['paymentRefundId'] }],
    description: 'Dokładnie jeden niepusty cel: `ledgerEntryId`, `paymentEntryId` albo `paymentRefundId`.',
  }),
  ReconciliationMatchBatchRequest: requestObject({
    matches: {
      type: 'array', minItems: 1, maxItems: 50,
      items: requestObject({ statementLineId: ref('Id'), paymentEntryId: ref('Id') }, ['statementLineId', 'paymentEntryId'], {
        additionalProperties: false,
        description: 'Para pozycja-wpłata; trasa odrzuca inne pola (400 `invalid_request`).',
      }),
      description: 'Jawna lista par (1-50, bez powtórzeń pozycji i wpłat); wszystko albo nic.',
    },
  }, ['matches']),
  ReconciliationGroupMatchRequest: requestObject({
    statementLineId: ref('Id'),
    items: {
      type: 'array', minItems: 2, maxItems: 50,
      items: {
        oneOf: [
          requestObject({ paymentEntryId: ref('Id') }, ['paymentEntryId'], { additionalProperties: false }),
          requestObject({ ledgerEntryId: ref('Id') }, ['ledgerEntryId'], { additionalProperties: false }),
        ],
        description: 'Jeden cel na pozycję listy (bez powtórzeń); kwotą jest dzisiejsze netto celu.',
      },
      description: 'Cele dopasowania zbiorczego (2-50); suma netto musi równać się kwocie pozycji.',
    },
  }, ['statementLineId', 'items']),
  ReconciliationRevocationRequest: requestObject({ reason: REASON, confirmPersonalData: CONFIRM }, ['reason']),
  ReconciliationConfirmRequest: requestObject({
    confirmationNote: {
      anyOf: [{ type: 'string', maxLength: 1000 }, { type: 'null' }],
      description: 'Wyjaśnienie (3-1000 znaków); wymagane, gdy różnica ≠ 0 (inaczej 400 `difference_requires_note`).',
    },
    confirmPersonalData: CONFIRM,
  }, [], { description: 'Zatwierdza inna osoba niż autor uzgodnienia (zasada czterech oczu).' }),
  ReconciliationAbandonRequest: requestObject({ reason: REASON, confirmPersonalData: CONFIRM }, ['reason']),
};

const MFA_DENY = { 403: ['forbidden', 'mfa_enrollment_required', 'mfa_required'] };
const READ_ERROR_SET = mergeErrors(MFA_DENY, { 400: ['invalid_id'], 404: ['reconciliation_not_found'] });
// Wspólne błędy zapisu: czytnik ciała (src/pg/input.js), router (`invalid_origin`), stan uzgodnienia.
const BODY_ERRORS = {
  400: ['invalid_id', 'invalid_json'],
  403: ['invalid_origin'],
  404: ['reconciliation_not_found'],
  413: ['request_too_large'],
  415: ['invalid_content_type'],
};
const KEYED_ERRORS = mergeErrors(BODY_ERRORS, { 400: ['invalid_idempotency_key'], 409: ['idempotency_conflict'] });
const DRAFT_ONLY = { 409: ['reconciliation_abandoned', 'reconciliation_confirmed', 'school_year_closed'] };
const MATCH_TARGET_ERRORS = {
  400: ['invalid_match_target', 'invalid_request'],
  409: ['already_matched', 'already_matched_via_ledger', 'already_matched_via_payment', 'match_method_mismatch', 'matched_in_other_reconciliation'],
};

const written = (description, schema) => ({
  201: replayed('false', description, schema),
  200: replayed('true', 'Odtworzenie po tym samym kluczu idempotencji (bez nowego zapisu).', schema),
});
const reconciliationResult = strictObject({ reconciliation: ref('Reconciliation') });
const matchResult = strictObject({ match: ref('ReconciliationMatch') });
const groupMatchResult = strictObject({ groupMatch: ref('ReconciliationGroupMatch') });

const importBase = { import: ref('BankStatementImport') };
const fileImportDetails = {
  skippedDuplicateCount: ref('Count'),
  skippedDuplicates: { type: 'array', items: ref('BankStatementSkippedDuplicate') },
  warnings: { type: 'array', items: ref('BankStatementImportWarning') },
  fileBalances: ref('BankStatementFileBalances'),
};

/** Klucz: `METODA /ścieżka-openapi` (jak w docs/openapi.json). */
export const routes = {
  'GET /api/reconciliations': {
    query: { schoolYearId: { required: true, schema: ref('Id') } },
    responses: {
      200: {
        description: 'Uzgodnienia roku od najnowszego dnia wyciągu (bez kursora: pełna lista).',
        schema: strictObject({ reconciliations: { type: 'array', items: ref('Reconciliation') } }),
      },
    },
    errors: mergeErrors(MFA_DENY, { 400: ['invalid_request'] }),
  },
  'POST /api/reconciliations': {
    idempotencyKey: true,
    body: ref('ReconciliationCreateRequest'),
    responses: written('Szkic uzgodnienia z saldem księgi policzonym przez bazę.', reconciliationResult),
    errors: mergeErrors(PII_ERRORS, MFA_DENY, KEYED_ERRORS, {
      400: ['invalid_notes', 'invalid_reference', 'invalid_request', 'statement_date_outside_school_year'],
      409: ['school_year_closed'],
    }),
  },
  'GET /api/reconciliations/{reconciliationId}': {
    query: {
      limit: { schema: { type: 'integer', minimum: 1, maximum: 500, default: 500 }, description: 'Liczba pozycji wyciągu na stronie.' },
      cursor: { schema: { type: 'string', maxLength: 512, pattern: '^[A-Za-z0-9_-]+$' }, description: '`nextCursor` z poprzedniej strony tego samego uzgodnienia.' },
    },
    responses: { 200: { description: 'Uzgodnienie z jedną stroną pozycji wyciągu.', schema: ref('ReconciliationView') } },
    errors: mergeErrors(READ_ERROR_SET, { 400: ['invalid_cursor', 'invalid_limit'] }),
  },
  'POST /api/reconciliations/{reconciliationId}/lines': {
    idempotencyKey: true,
    body: ref('BankStatementLinesRequest'),
    responses: {
      201: replayed('false', 'Nowa paczka pozycji: lista/CSV z liczbą możliwych duplikatów albo plik banku z pominiętymi ruchami, ostrzeżeniami i saldami.', {
        anyOf: [
          strictObject({ ...importBase, possibleDuplicateCount: { ...ref('Count'), description: 'Pozycje o tej samej dacie, kwocie i skrócie tytułu co w innym imporcie (tylko informacja).' } }),
          strictObject({ ...importBase, ...fileImportDetails }),
        ],
      }),
      200: replayed(FRESH_OR_REPLAY, 'Odtworzenie po tym samym kluczu (`true`: `import`, przy pliku też `skippedDuplicateCount`) '
        + 'albo plik, którego wszystkie ruchy były już zaimportowane (`false`: `import: null`, `lineCount: 0`, bez nowej paczki).', {
        anyOf: [
          strictObject(importBase),
          strictObject({ ...importBase, skippedDuplicateCount: ref('Count') }),
          strictObject({ import: { type: 'null' }, lineCount: { const: 0 }, ...fileImportDetails }),
        ],
      }),
    },
    errors: mergeErrors(MFA_DENY, KEYED_ERRORS, DRAFT_ONLY, {
      400: [
        'ambiguous_csv_delimiter', 'invalid_csv', 'invalid_csv_encoding', 'invalid_csv_header', 'invalid_line_count', 'invalid_request',
        'invalid_statement_file', 'invalid_statement_line', 'statement_account_mismatch', 'statement_account_unsupported',
        'statement_amount_out_of_range', 'statement_currency_unsupported', 'statement_line_after_statement_date',
        'statement_multiple_not_supported', 'statement_transaction_id_missing',
      ],
      409: ['statement_already_imported'],
      503: ['bank_import_not_configured'],
    }),
  },
  'POST /api/reconciliations/{reconciliationId}/lines/{lineId}/payment': {
    idempotencyKey: true,
    body: ref('ReconciliationLinePaymentRequest'),
    responses: written('Wpłata z pozycji wyciągu i jej powiązanie (nowy zapis).', ref('ReconciliationLinePayment')),
    errors: mergeErrors(MFA_DENY, KEYED_ERRORS, DRAFT_ONLY, {
      400: ['invalid_reference', 'invalid_request', 'statement_line_not_income'],
      404: ['statement_line_not_found'],
      409: ['already_matched'],
      422: ['date_outside_school_year'],
    }),
  },
  'GET /api/reconciliations/{reconciliationId}/suggestions': {
    query: { windowDays: { schema: { type: 'integer', minimum: 0, maximum: 31, default: 7 }, description: 'Okno dni wokół daty pozycji.' } },
    responses: { 200: { description: 'Propozycje dopasowań otwartych pozycji (do 5 kandydatów na pozycję).', schema: ref('ReconciliationSuggestions') } },
    // `invalid_reference_text`: tytuł wpłaty-kandydata dłuższy niż 300 znaków po normalizacji NFKC (API wpłat
    // przyjmuje do 200 znaków, więc tylko przy rozszerzających się znakach albo danych spoza API).
    errors: mergeErrors(READ_ERROR_SET, { 400: ['invalid_reference_text', 'invalid_window'] }),
  },
  'POST /api/reconciliations/{reconciliationId}/matches': {
    idempotencyKey: true,
    body: ref('ReconciliationMatchRequest'),
    responses: written('Powiązanie pozycji z wpisem księgi, wpłatą albo zwrotem (nowy zapis).', matchResult),
    errors: mergeErrors(MFA_DENY, KEYED_ERRORS, DRAFT_ONLY, MATCH_TARGET_ERRORS, {
      400: ['invalid_reference', 'invalid_statement_line'],
      409: ['match_amount_mismatch'],
    }),
  },
  'POST /api/reconciliations/{reconciliationId}/matches/batch': {
    idempotencyKey: true,
    body: ref('ReconciliationMatchBatchRequest'),
    responses: written('Wszystkie pary zapisane naraz (kolejność jak posortowane pozycje).', strictObject({
      matches: { type: 'array', minItems: 1, maxItems: 50, items: ref('ReconciliationMatch') },
    })),
    errors: mergeErrors(MFA_DENY, KEYED_ERRORS, DRAFT_ONLY, {
      400: ['invalid_request', 'match_batch_duplicate', 'match_batch_empty', 'match_batch_too_large'],
      409: ['already_matched', 'match_batch_rejected'],
    }),
  },
  'POST /api/reconciliations/{reconciliationId}/matches/{matchId}/revocation': {
    body: ref('ReconciliationRevocationRequest'),
    responses: { 200: replayed(FRESH_OR_REPLAY, 'Cofnięte powiązanie (`false`) albo ponowienie tej samej osoby z tym samym powodem (`true`).', matchResult) },
    errors: mergeErrors(PII_ERRORS, MFA_DENY, BODY_ERRORS, DRAFT_ONLY, {
      400: ['invalid_reason'],
      404: ['match_not_found'],
      409: ['match_already_revoked'],
    }),
  },
  'POST /api/reconciliations/{reconciliationId}/group-matches': {
    idempotencyKey: true,
    body: ref('ReconciliationGroupMatchRequest'),
    responses: written('Dopasowanie zbiorcze (nowy zapis).', groupMatchResult),
    errors: mergeErrors(MFA_DENY, KEYED_ERRORS, DRAFT_ONLY, MATCH_TARGET_ERRORS, {
      400: ['invalid_statement_line'],
      409: ['group_match_direction_mismatch', 'group_match_sum_mismatch'],
    }),
  },
  'POST /api/reconciliations/{reconciliationId}/group-matches/{groupMatchId}/revocation': {
    body: ref('ReconciliationRevocationRequest'),
    responses: { 200: replayed(FRESH_OR_REPLAY, 'Cofnięte dopasowanie zbiorcze (nowy zapis cofnięcia) albo ponowienie (`true`).', groupMatchResult) },
    errors: mergeErrors(PII_ERRORS, MFA_DENY, BODY_ERRORS, DRAFT_ONLY, {
      400: ['invalid_reason'],
      404: ['match_not_found'],
      409: ['match_already_revoked'],
    }),
  },
  'POST /api/reconciliations/{reconciliationId}/confirm': {
    body: ref('ReconciliationConfirmRequest'),
    responses: { 200: replayed(FRESH_OR_REPLAY, 'Zatwierdzone uzgodnienie z utrwalonym saldem księgi (`false`) albo ponowienie przez tę samą osobę (`true`).', reconciliationResult) },
    errors: mergeErrors(PII_ERRORS, MFA_DENY, BODY_ERRORS, DRAFT_ONLY, {
      400: ['difference_requires_note', 'invalid_confirmation_note'],
      403: ['four_eyes_required'],
      409: ['inconsistent_matches'],
    }),
  },
  'POST /api/reconciliations/{reconciliationId}/abandon': {
    body: ref('ReconciliationAbandonRequest'),
    responses: { 200: replayed(FRESH_OR_REPLAY, 'Porzucony szkic (`false`) albo ponowienie tej samej osoby z tym samym powodem (`true`).', reconciliationResult) },
    errors: mergeErrors(PII_ERRORS, MFA_DENY, BODY_ERRORS, DRAFT_ONLY, {
      400: ['invalid_reason'],
      409: ['reconciliation_has_active_matches'],
    }),
  },
  'GET /api/reports/audit': {
    query: {
      schoolYearId: { required: true, schema: ref('Id') },
      format: { schema: { type: 'string', enum: ['json', 'html', 'xlsx'], default: 'json' }, description: 'Każdy format zapisuje zdarzenie `report.audit.generated` ze skrótem treści.' },
    },
    responses: {
      200: formatsResponse('Raport Komisji Rewizyjnej: JSON (domyślnie), arkusz XLSX (arkusz na sekcję, #141) albo HTML do wydruku.', {
        'application/json': strictObject({ report: ref('AuditReport') }),
        [OCTET_XLSX]: { type: 'string', format: 'binary' },
        [HTML_CONTENT_TYPE]: { type: 'string' },
      }),
    },
    errors: mergeErrors(MFA_DENY, { 400: ['invalid_request'], 404: ['school_year_not_found'] }),
  },
};
