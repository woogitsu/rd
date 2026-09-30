// Raport dla Komisji Rewizyjnej jako skoroszyt XLSX (#141): arkusz na sekcję
// raportu HTML (src/pg/audit-report.js), z tego samego obiektu raportu
// (buildAuditReport, jedna migawka), więc sumy arkuszy są równe wartościom
// z `format=json`. Plik składa wspólny moduł src/pg/xlsx.js: kwoty to liczby
// EUR z centów, tekst jako inlineStr, żadnych formuł (także żadnych wierszy
// „Razem” liczonych formułą — Komisja sumuje sama).
//
// Daty: sama data (wpis, wyciąg) to prawdziwa data arkusza w formacie
// dd.mm.yyyy — ten sam polski zapis co w HTML (#563), ale z sortowaniem
// i filtrem; znacznik czasu (zapis korekty, zatwierdzenie) to data i godzina
// lokalna Europe/Brussels z dokładnością do minuty. Arkusz „Informacje” podaje
// „Stan na” tekstem dd.mm.rrrr gg:mm oraz dokładną chwilę UTC (ISO) z JSON.
//
// Identyfikatory są pełne (jak w JSON), nie skrócone jak w HTML — arkusz służy
// do porównania z wersją JSON i panelami.

import { formatSchoolYear } from '../../shared/school-year.js';
import { toXlsxWorkbook } from './xlsx.js';
import {
  ACCOUNT_OPERATION_ROWS, CHECK_LABEL, checkDetails, DIRECTION, EVENT_STATUS, formatDate, PLAIN_DETAILS, REPORT_TIME_ZONE, RESOLUTION_STATUS, STATUS,
} from './audit-report.js';
import { BUDGET_CSV_COLUMNS, budgetCsvValues } from './routes/ledger-budget.js';

// Kolejność i nazwy kart w pliku (nazwy ≤ 31 znaków, bez []:*?/\).
export const AUDIT_REPORT_SHEETS = Object.freeze([
  'Informacje', 'Bilans', 'Kontrole', 'Kategorie', 'Preliminarz', 'Wydatki > 3000 EUR', 'Uchwały', 'Weryfikacja wydatków',
  'Możliwe podziały', 'Wydarzenia', 'Korekty', 'Przeksięgowania', 'Uzgodnienia', 'Dowody', 'Możliwe duplikaty dowodu',
  'Operacje na kontach',
]);

const cols = (list) => list.map(([header, type]) => ({ header, type }));
const yesNo = (value) => (value ? 'tak' : 'nie');
const direction = (value) => DIRECTION[value] ?? value;

// Skrót SHA-256 treści raportu (#141): JSON obiektu raportu BEZ pól asOf
// i generatedAt (chwila migawki zmienia się przy każdym pobraniu), w kolejności
// kluczy z buildAuditReport. Te same dane → ten sam skrót w JSON, HTML i XLSX,
// więc Komisja może potwierdzić, że plik odpowiada wersji HTML. Obliczenie
// z odpowiedzi JSON opisuje docs/RECONCILIATION.md.
export async function auditReportContentSha256(report) {
  const { asOf: _asOf, generatedAt: _generatedAt, ...content } = report;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(content)));
  return Buffer.from(digest).toString('hex');
}

function infoSheet(report, contentSha256) {
  const { schoolYear } = report;
  const asOf = report.asOf ?? report.generatedAt;
  return {
    name: 'Informacje',
    columns: cols([['Pole', 'text'], ['Wartość', 'text']]),
    rows: [
      ['Raport', 'Raport dla Komisji Rewizyjnej'],
      ['Rok szkolny', formatSchoolYear(schoolYear.label)],
      ['Identyfikator roku', schoolYear.id],
      ['Okres roku', `${formatDate(schoolYear.startsOn)}–${formatDate(schoolYear.endsOn)}`],
      ['Stan na', `${formatDate(asOf)} (czas ${REPORT_TIME_ZONE})`],
      ['Stan na (UTC, jak w JSON)', asOf],
      ['Skrót treści (SHA-256)', contentSha256],
      ['Jak sprawdzić skrót', 'SHA-256 z JSON.stringify obiektu report z GET /api/reports/audit?format=json bez pól asOf i generatedAt; ten sam skrót jest w nagłówku wersji HTML'],
      ['Kwoty', 'EUR, komórki liczbowe (bez formuł); daty w zapisie dd.mm.rrrr'],
      ['Uwaga', 'Zestawienie z księgi w systemie. Nie jest zatwierdzonym sprawozdaniem finansowym; wymaga sprawdzenia z dokumentami źródłowymi.'],
    ],
  };
}

function balanceSheet({ balance }) {
  return {
    name: 'Bilans',
    columns: cols([['Pozycja', 'text'], ['Kwota', 'amount']]),
    rows: [
      ['Bilans otwarcia (z korektami)', balance.openingBalanceCents],
      ['Bilans otwarcia — rachunek', balance.openingBankCents ?? 0],
      ['Bilans otwarcia — kasa', balance.openingCashCents ?? 0],
      ['Przychody netto', balance.incomeCents],
      ['Wydatki netto', balance.expenseCents],
      ['Bilans zamknięcia', balance.closingBalanceCents],
      ['Bilans zamknięcia — rachunek', balance.closingBankCents ?? 0],
      ['Bilans zamknięcia — kasa', balance.closingCashCents ?? 0],
    ],
  };
}

function checksSheet(report) {
  return {
    name: 'Kontrole',
    columns: cols([['Kontrola', 'text'], ['Wynik', 'text'], ['Wartości', 'text']]),
    rows: (report.checks?.items ?? []).map((check) => [
      CHECK_LABEL[check.id] ?? check.id,
      check.ok === null ? 'nie liczono' : check.ok ? 'zgodne' : 'niezgodne',
      checkDetails(check, PLAIN_DETAILS),
    ]),
    trailer: ['', 'Kontrole porównują niezależnie liczone źródła; wynik jest wskaźnikiem do sprawdzenia, nie oceną.'],
  };
}

function categoriesSheet({ categories }) {
  return {
    name: 'Kategorie',
    columns: cols([['Rodzaj', 'text'], ['Kategoria', 'text'], ['Wpisy', 'integer'], ['Kwota pierwotna', 'amount'],
      ['Korekty', 'amount'], ['Netto', 'amount']]),
    rows: categories.map((item) => [direction(item.direction), item.name, item.entryCount, item.grossCents,
      item.correctedCents, item.netCents]),
  };
}

function budgetSheet({ budgetExecution }) {
  const adoption = budgetExecution?.adoption ?? null;
  const adoptionLine = adoption
    ? `Plan przyjęty: ${formatDate(adoption.adoptedOn)}${adoption.resolutionNumber ? `, uchwała ${adoption.resolutionNumber}` : ', bez uchwały w systemie'}.`
    : 'Preliminarz nie został jeszcze zapisany jako przyjęty przez zebranie.';
  return {
    name: 'Preliminarz',
    columns: BUDGET_CSV_COLUMNS,
    rows: (budgetExecution?.items ?? []).map(budgetCsvValues),
    preamble: [adoptionLine],
    trailer: ['', 'Wykonanie to suma netto wpisów (po korektach); „poza planem” — kategoria z wpisami bez linii preliminarza.'],
  };
}

function largeExpensesSheet({ largeExpenses }) {
  return {
    name: 'Wydatki > 3000 EUR',
    columns: cols([['Data', 'date'], ['Kategoria', 'text'], ['Opis', 'text'], ['Kwota', 'amount'], ['Netto', 'amount'],
      ['Uchwała', 'text'], ['Powiązanie', 'text'], ['Zgodność z przyjętą uchwałą', 'text'], ['Wpis księgi', 'text']]),
    rows: largeExpenses.map((item) => [
      item.occurredOn, item.category, item.description, item.amountCents, item.netAmountCents,
      item.resolutionReference ?? '', item.resolutionLink === 'explicit' ? 'wskazana przy zapisie' : 'powiązanie tekstowe',
      item.matchesAdoptedResolution === true ? 'tak'
        : item.matchesAdoptedResolution === false ? 'brak zgodnej przyjętej uchwały' : 'nie sprawdzono',
      item.id,
    ]),
    trailer: ['', 'Lista obejmuje wydatki o kwocie pierwotnej powyżej 3000,00 EUR (wydatek dokładnie 3000,00 EUR nie jest na liście).'],
  };
}

function resolutionsSheet(report) {
  return {
    name: 'Uchwały',
    columns: cols([['Uchwała', 'text'], ['Tytuł', 'text'], ['Stan', 'text'], ['Kwota upoważnienia', 'amount_or_blank'],
      ['Wydatki netto', 'amount'], ['Pozostało', 'amount_or_blank'], ['Wpisy', 'integer']]),
    rows: (report.resolutionExecution ?? []).map((item) => [
      item.number, item.title, RESOLUTION_STATUS[item.status] ?? item.status, item.authorizedAmountCents,
      item.spentNetCents, item.remainingCents, item.entryCount,
    ]),
    trailer: ['', 'Wydatki powiązane wyłącznie numerem w tekście nie są tu liczone (arkusz „Wydatki > 3000 EUR”: „powiązanie tekstowe”).'],
  };
}

function reviewsSheet(report) {
  const reviews = report.expenseReviews ?? null;
  const tally = (label, key) => [label, reviews?.[key]?.count ?? 0, reviews?.[key]?.netCents ?? 0];
  return {
    name: 'Weryfikacja wydatków',
    columns: cols([['Stan weryfikacji', 'text'], ['Wpisy', 'integer'], ['Netto', 'amount']]),
    rows: reviews ? [tally('Niezweryfikowane', 'unverified'), tally('Zakwestionowane', 'questioned'), tally('Zweryfikowane', 'verified')] : [],
  };
}

function splitsSheet(report) {
  const reviews = report.expenseReviews ?? null;
  return {
    name: 'Możliwe podziały',
    columns: cols([['Kategoria', 'text'], ['Od', 'date'], ['Do', 'date'], ['Wpisy', 'integer'], ['Razem netto', 'amount'],
      ['Wpisy księgi', 'text']]),
    rows: (reviews?.possibleSplits ?? []).map((item) => [item.category, item.fromDate, item.toDate, item.entryCount,
      item.netCents, item.ledgerEntryIds.join(', ')]),
    preamble: [`Kilka wydatków do 3000 EUR w tej samej kategorii w ciągu ${reviews?.splitWindowDays ?? '—'} dni, razem powyżej 3000 EUR (informacja do sprawdzenia, nie zarzut).`],
  };
}

function eventsSheet(report) {
  const results = report.eventResults ?? null;
  const rows = results ? [
    ...results.events.map((item) => ['wydarzenie', item.title, EVENT_STATUS[item.status] ?? item.status ?? '', item.entryCount,
      item.incomeCents, item.expenseCents, item.resultCents]),
    ['bez przypisania', 'Bez przypisania do wydarzenia', '', null, results.unallocated.incomeCents,
      results.unallocated.expenseCents, results.unallocated.resultCents],
    ['razem rok', 'Razem rok', '', null, results.totals.incomeCents, results.totals.expenseCents, results.totals.resultCents],
  ] : [];
  return {
    name: 'Wydarzenia',
    columns: cols([['Rodzaj wiersza', 'text'], ['Wydarzenie', 'text'], ['Stan', 'text'], ['Wpisy', 'integer'],
      ['Przychody', 'amount'], ['Wydatki', 'amount'], ['Wynik', 'amount']]),
    rows,
    trailer: ['', 'Wiersz „razem rok” = wydarzenia + bez przypisania (przy sumowaniu kolumny odfiltruj go). Wynik ujemny to informacja do sprawdzenia, nie ocena.'],
  };
}

function correctionsSheet({ corrections, openingAdjustments }) {
  return {
    name: 'Korekty',
    columns: cols([['Zapisano', 'datetime'], ['Rodzaj korekty', 'text'], ['Wpis księgi', 'text'], ['Data wpisu', 'date'],
      ['Rodzaj wpisu', 'text'], ['Kwota korekty', 'amount'], ['Powód', 'text'], ['Autor (id)', 'text'], ['Identyfikator korekty', 'text']]),
    rows: [
      ...corrections.map((item) => [item.createdAt, 'korekta wpisu księgi', item.ledgerEntryId, item.entryOccurredOn,
        direction(item.direction), item.amountCents, item.reason, item.createdBy ?? '', item.id]),
      ...(openingAdjustments ?? []).map((item) => [item.createdAt, 'korekta bilansu otwarcia', '', null, '', item.amountCents,
        item.reason, item.createdBy ?? '', item.id]),
    ],
  };
}

function reclassificationsSheet(report) {
  return {
    name: 'Przeksięgowania',
    columns: cols([['Zapisano', 'datetime'], ['Wpis stary', 'text'], ['Wpis nowy', 'text'], ['Kategoria stara', 'text'],
      ['Kategoria nowa', 'text'], ['Data stara', 'date'], ['Data nowa', 'date'], ['Storno', 'amount'], ['Nowy wpis', 'amount'],
      ['Powód', 'text'], ['Powiązany z wpłatą', 'text'], ['Dotyczy zatwierdzonego uzgodnienia', 'text']]),
    rows: (report.reclassifications ?? []).map((item) => [item.createdAt, item.replacesEntryId, item.id, item.oldCategory,
      item.newCategory, item.oldOccurredOn, item.occurredOn, item.stornoCents, item.amountCents, item.reason,
      yesNo(item.paymentLinked), yesNo(item.inConfirmedReconciliation)]),
    trailer: ['', 'Storno starego wpisu i wpis zastępczy — bilans zmienia tylko różnica kwot.'],
  };
}

function reconciliationsSheet({ reconciliations }) {
  return {
    name: 'Uzgodnienia',
    columns: cols([['Data wyciągu', 'date'], ['Status', 'text'], ['Saldo wyciągu', 'amount'], ['Saldo księgi', 'amount'],
      ['Różnica', 'amount'], ['Niedopasowane pozycje', 'integer'], ['Zatwierdził (id)', 'text'], ['Zatwierdzono', 'datetime'],
      ['Wyjaśnienie', 'text'], ['Identyfikator uzgodnienia', 'text']]),
    rows: reconciliations.items.map((item) => [item.statementDate, STATUS[item.status] ?? item.status, item.statementBalanceCents,
      item.ledgerBalanceCents, item.differenceCents, item.unmatchedLineCount, item.confirmedBy ?? '', item.confirmedAt,
      item.confirmationNote ?? '', item.id]),
    trailer: ['', `Zatwierdzone uzgodnienia: ${reconciliations.confirmedCount}; szkice: ${reconciliations.draftCount}; porzucone szkice: ${reconciliations.abandonedCount ?? 0}. Saldo księgi w szkicu jest wyliczane na bieżąco.`],
  };
}

function evidenceSheets(report) {
  const evidence = report.evidence ?? { expensesWithoutEvidence: { count: 0, netCents: 0, items: [] }, possibleDuplicateEvidence: [] };
  return [
    {
      name: 'Dowody',
      columns: cols([['Data', 'date'], ['Kategoria', 'text'], ['Opis', 'text'], ['Netto', 'amount'], ['Wpis księgi', 'text']]),
      rows: evidence.expensesWithoutEvidence.items.map((item) => [item.occurredOn, item.category, item.description,
        item.netAmountCents, item.id]),
      preamble: [`Wydatki bez dowodu: ${evidence.expensesWithoutEvidence.count}.`],
      trailer: ['', 'Liczone są wydatki z kwotą netto powyżej zera. Numer i wystawca faktury nie są jeszcze zapisywane, więc duplikat tej samej faktury w innym pliku nie zostanie wykryty.'],
    },
    {
      name: 'Możliwe duplikaty dowodu',
      columns: cols([['Dokumenty', 'text'], ['Wpisy księgi', 'text']]),
      rows: evidence.possibleDuplicateEvidence.map((item) => [item.documentIds.join(', '), item.ledgerEntryIds.join(', ')]),
      preamble: ['Ten sam plik przy więcej niż jednym wydatku — do sprawdzenia.'],
    },
  ];
}

// #146: operacje administracyjne na kontach — same liczby, jak sekcja 7 HTML.
// Raporty sprzed tej zmiany (archiwum) nie mają arkusza.
function accountOperationsSheets(report) {
  const ops = report.accountOperations;
  if (!ops) return [];
  return [{
    name: 'Operacje na kontach',
    columns: cols([['Operacja', 'text'], ['Liczba', 'integer']]),
    rows: ACCOUNT_OPERATION_ROWS.map(([key, label]) => [label, ops[key] ?? 0]),
    trailer: ['', 'Liczby zdarzeń z dziennika w granicach roku szkolnego (czas Europe/Brussels). Bez identyfikatorów kont — zakres wglądu Komisji Rewizyjnej wymaga decyzji zarządu (D-08/D-09).'],
  }];
}

export function buildAuditReportXlsx(report, { contentSha256 }) {
  const sheets = [
    infoSheet(report, contentSha256), balanceSheet(report), checksSheet(report), categoriesSheet(report), budgetSheet(report),
    largeExpensesSheet(report), resolutionsSheet(report), reviewsSheet(report), splitsSheet(report), eventsSheet(report),
    correctionsSheet(report), reclassificationsSheet(report), reconciliationsSheet(report), ...evidenceSheets(report),
    ...accountOperationsSheets(report),
  ];
  return toXlsxWorkbook(sheets);
}
