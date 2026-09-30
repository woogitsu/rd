// Drukowalny raport roczny dla Komisji Rewizyjnej (HTML, A4). PDF powstaje
// przez drukowanie z przeglądarki — serwer nie generuje plików PDF.
//
// Każda wartość pochodząca z bazy przechodzi przez escapeHtml. Strona nie
// zawiera skryptów; CSP dopuszcza wyłącznie wbudowany arkusz stylów o znanym
// skrócie SHA-256.

import { formatSchoolYear } from '../../shared/school-year.js';
import { formatEur as formatEurShared } from '../../panel/money.js';
import { shortId } from '../../shared/short-id.js';
import { formatDateOrTimestamp } from '../../shared/zoned-time.js';

// Strefa czasu raportu — ta sama co w panelach (Zebrania, Wydarzenia, Konta).
export const REPORT_TIME_ZONE = 'Europe/Brussels';

const CHECK_LABEL = {
  year_end_balance: 'Saldo księgi na ostatni dzień roku (wpisy do tej daty) a bilans zamknięcia',
  dates_within_school_year: 'Daty wpisów i wpłat w granicach roku szkolnego',
  payments_in_ledger: 'Wpłaty (netto) a wpłaty ujęte w księdze (netto)',
  reconciliation_matches: 'Powiązania pozycji wyciągu: zgodność kwot i brak podwójnego ujęcia',
  latest_confirmed_reconciliation: 'Ostatnie zatwierdzone uzgodnienie rachunku',
};

function checkDetails(check) {
  const m = (cents) => escapeHtml(formatEur(cents));
  switch (check.id) {
    case 'year_end_balance':
      return `bilans zamknięcia ${m(check.closingBalanceCents)}; saldo na koniec roku ${m(check.balanceAtYearEndCents)}; różnica ${m(check.differenceCents)}`;
    case 'dates_within_school_year': {
      const listed = (check.items ?? []).map((item) => `${escapeHtml(item.kind === 'payment_entry' ? 'wpłata' : 'wpis')} ${idHtml(item.id)} (${escapeHtml(formatDate(item.date))})`);
      return `wpisy księgi poza rokiem: ${escapeHtml(check.ledgerEntryCount)}; wpłaty poza rokiem: ${escapeHtml(check.paymentCount)}${listed.length ? `<br>${listed.join('<br>')}` : ''}`;
    }
    case 'payments_in_ledger':
      return `wpłaty ${m(check.paymentsNetCents)}; ujęte w księdze ${m(check.ledgerLinkedNetCents)}; różnica ${m(check.differenceCents)}; wpłaty bez wpisu księgi: ${escapeHtml(check.paymentsWithoutLedgerEntry)}`;
    case 'reconciliation_matches':
      return `niezgodne kwotowo: ${escapeHtml(check.amountMismatchCount)}; podwójne ujęcie: ${escapeHtml(check.doubleCountedCount)}; w tym w zatwierdzonych uzgodnieniach (do wyjaśnienia, bez ścieżki poprawy): ${escapeHtml(check.amountMismatchConfirmedCount)}; dopasowania zbiorcze niezgodne: ${escapeHtml(check.groupAmountMismatchCount ?? 0)} (w zatwierdzonych: ${escapeHtml(check.groupAmountMismatchConfirmedCount ?? 0)})`;
    case 'latest_confirmed_reconciliation':
      return check.statementDate
        ? `wyciąg z ${escapeHtml(formatDate(check.statementDate))}; różnica ${m(check.differenceCents)}; przelewy w księdze po dacie wyciągu: ${escapeHtml(check.bankEntriesAfterStatement)}`
        : 'brak zatwierdzonego uzgodnienia w tym roku';
    default:
      return '';
  }
}

export const REPORT_CSS = `
@page { size: A4; margin: 15mm 14mm; }
* { box-sizing: border-box; }
html { background: #fff; }
body { margin: 0 auto; max-width: 190mm; padding: 16px; background: #fff; color: #1a1a1a;
  font: 10.5pt/1.45 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
header { border-bottom: 2px solid #b3121b; padding-bottom: 8px; margin-bottom: 16px; }
h1 { font-size: 16pt; margin: 0 0 4px; }
h2 { font-size: 12pt; margin: 20px 0 6px; break-after: avoid; }
p { margin: 4px 0; }
.meta { color: #555; font-size: 9.5pt; }
.notice { border-left: 3px solid #b3121b; padding: 4px 8px; margin: 8px 0; font-size: 9.5pt; }
table { width: 100%; border-collapse: collapse; margin: 4px 0 8px; font-size: 9.5pt; }
th, td { border: 1px solid #c8c8c8; padding: 3px 6px; text-align: left; vertical-align: top; }
th { background: #f3f3f3; font-weight: 600; }
td.num, th.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
tr { break-inside: avoid; }
.flag { color: #b3121b; font-weight: 600; }
.empty { color: #555; font-style: italic; }
.signatures { margin-top: 28px; display: flex; gap: 24px; }
.signatures div { flex: 1; border-top: 1px solid #888; padding-top: 4px; font-size: 9pt; color: #555; }
@media print { body { padding: 0; max-width: none; } }
`;

let styleHashPromise = null;

export function reportStyleHash() {
  styleHashPromise ??= crypto.subtle.digest('SHA-256', new TextEncoder().encode(REPORT_CSS))
    .then((digest) => `sha256-${Buffer.from(digest).toString('base64')}`);
  return styleHashPromise;
}

export async function reportContentSecurityPolicy() {
  return `default-src 'none'; style-src '${await reportStyleHash()}'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// #173: jeden moduł kwot EUR (panel/money.js) — 123456 -> "1 234,56 EUR"
// (spacja nierozdzielająca), brak wartości -> „—” (nigdy „0,00 EUR”).
export function formatEur(cents) {
  return formatEurShared(cents, { style: 'print' });
}

// Przegląd demo 4: data jak w kolumnach paneli („2026-10-20”, Księga/Wpłaty/Uzgodnienia),
// znacznik czasu w strefie Europe/Brussels („2026-10-20 16:05”), nie w UTC. Wspólne
// dla raportu KR, sprawozdania rocznego i wydruku preliminarza. JSON raportu (asOf,
// createdAt) zostaje w ISO UTC — zmienia się wyłącznie prezentacja HTML.
export function formatDate(value) {
  return formatDateOrTimestamp(value, REPORT_TIME_ZONE) ?? '';
}

// Identyfikator (UUID wpisu, dokumentu, konta) w tabeli: skrót jak w panelach
// (shared/short-id.js, np. „Wpis księgi d2721f76…” w Dokumentach), pełna wartość
// w podpowiedzi (title) — na wydruku zostaje sam skrót.
export function idHtml(value) {
  if (value === null || value === undefined || value === '') return '—';
  return `<span title="${escapeHtml(value)}">${escapeHtml(shortId(value))}</span>`;
}

const e = escapeHtml;
const money = (cents) => e(formatEur(cents));

const DIRECTION = { income: 'przychód', expense: 'wydatek' };
const STATUS = { draft: 'szkic', confirmed: 'zatwierdzone', abandoned: 'porzucone' };
const EVENT_STATUS = { draft: 'szkic', submitted: 'zgłoszone', approved: 'zatwierdzone', published: 'opublikowane', cancelled: 'odwołane' };
const RESOLUTION_STATUS = { adopted: 'przyjęta', rejected: 'odrzucona', draft: 'projekt', withdrawn: 'wycofana' };

function table(headers, rows, emptyText) {
  if (!rows.length) return `<p class="empty">${e(emptyText)}</p>`;
  const head = headers.map(([label, cls]) => `<th${cls ? ` class="${cls}"` : ''}>${e(label)}</th>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function row(cells) {
  return `<tr>${cells.map(([html, cls]) => `<td${cls ? ` class="${cls}"` : ''}>${html}</td>`).join('')}</tr>`;
}

export function renderAuditReportHtml(report) {
  const { schoolYear, balance, categories, largeExpenses, corrections, openingAdjustments, reconciliations } = report;

  const categoryRows = categories.map((item) => row([
    [e(DIRECTION[item.direction] ?? item.direction)], [e(item.name)], [e(item.entryCount), 'num'],
    [money(item.grossCents), 'num'], [money(item.correctedCents), 'num'], [money(item.netCents), 'num'],
  ]));

  const largeRows = largeExpenses.map((item) => row([
    [e(formatDate(item.occurredOn))], [e(item.category)], [e(item.description)],
    [money(item.amountCents), 'num'], [money(item.netAmountCents), 'num'],
    [`${e(item.resolutionReference ?? '—')}${item.resolutionLink === 'text' && item.resolutionReference ? ' <span class="meta">(powiązanie tekstowe)</span>' : ''}`],
    [item.matchesAdoptedResolution === true ? 'tak'
      : item.matchesAdoptedResolution === false ? '<span class="flag">brak zgodnej przyjętej uchwały</span>'
        : 'nie sprawdzono'],
  ]));

  // #93/#97: raporty sprzed migracji 0072 (np. z archiwum) nie mają tych sekcji.
  const resolutionExecution = report.resolutionExecution ?? [];
  const reviews = report.expenseReviews ?? null;
  const executionRows = resolutionExecution.map((item) => row([
    [e(item.number)], [e(item.title)],
    [item.status === 'adopted' ? 'przyjęta' : `<span class="flag">${e(RESOLUTION_STATUS[item.status] ?? item.status)}</span>`],
    [item.authorizedAmountCents === null ? 'bez kwoty' : money(item.authorizedAmountCents), 'num'],
    [money(item.spentNetCents), 'num'],
    [item.remainingCents === null ? '—' : item.remainingCents < 0 ? `<span class="flag">${money(item.remainingCents)}</span>` : money(item.remainingCents), 'num'],
    [e(item.entryCount), 'num'],
  ]));
  // #117: raporty sprzed tej zmiany (np. z archiwum) nie mają sekcji wyniku wydarzeń.
  const eventResults = report.eventResults ?? null;
  const resultCell = (cents) => (cents < 0 ? `<span class="flag">${money(cents)}</span>` : money(cents));
  const eventRows = eventResults ? [
    ...eventResults.events.map((item) => row([
      [e(item.title)], [e(EVENT_STATUS[item.status] ?? item.status ?? '—')], [e(item.entryCount), 'num'],
      [money(item.incomeCents), 'num'], [money(item.expenseCents), 'num'], [resultCell(item.resultCents), 'num'],
    ])),
    row([['<em>Bez przypisania do wydarzenia</em>'], [''], [''], [money(eventResults.unallocated.incomeCents), 'num'],
      [money(eventResults.unallocated.expenseCents), 'num'], [resultCell(eventResults.unallocated.resultCents), 'num']]),
    row([['<strong>Razem rok</strong>'], [''], [''], [money(eventResults.totals.incomeCents), 'num'],
      [money(eventResults.totals.expenseCents), 'num'], [resultCell(eventResults.totals.resultCents), 'num']]),
  ] : [];
  const splitRows = (reviews?.possibleSplits ?? []).map((item) => row([
    [e(item.category)], [`${e(formatDate(item.fromDate))}–${e(formatDate(item.toDate))}`], [e(item.entryCount), 'num'],
    [money(item.netCents), 'num'], [item.ledgerEntryIds.map(idHtml).join('<br>')],
  ]));

  const correctionRows = corrections.map((item) => row([
    [e(formatDate(item.createdAt))], [idHtml(item.ledgerEntryId)], [e(formatDate(item.entryOccurredOn))],
    [e(DIRECTION[item.direction] ?? item.direction)], [money(item.amountCents), 'num'], [e(item.reason)],
    [idHtml(item.createdBy)],
  ]));

  // #144: raporty sprzed tej zmiany (np. z archiwum) nie mają sekcji przeksięgowań.
  const reclassificationRows = (report.reclassifications ?? []).map((item) => row([
    [e(formatDate(item.createdAt))], [`${idHtml(item.replacesEntryId)}<br>&rarr; ${idHtml(item.id)}`],
    [`${e(item.oldCategory)} &rarr; ${e(item.newCategory)}`],
    [`${e(formatDate(item.oldOccurredOn))} &rarr; ${e(formatDate(item.occurredOn))}`],
    [money(item.stornoCents), 'num'], [money(item.amountCents), 'num'], [e(item.reason)],
    [[item.paymentLinked ? 'powiązany z wpłatą' : '',
      item.inConfirmedReconciliation ? '<span class="flag">dotyczy zatwierdzonego uzgodnienia</span>' : '']
      .filter(Boolean).join('<br>') || '—'],
  ]));

  const adjustmentRows = openingAdjustments.map((item) => row([
    [e(formatDate(item.createdAt))], [money(item.amountCents), 'num'], [e(item.reason)], [idHtml(item.createdBy)],
  ]));

  const reconciliationRows = reconciliations.items.map((item) => row([
    [e(formatDate(item.statementDate))], [e(STATUS[item.status] ?? item.status)],
    [money(item.statementBalanceCents), 'num'], [money(item.ledgerBalanceCents), 'num'],
    [item.differenceCents === 0 ? money(0) : `<span class="flag">${money(item.differenceCents)}</span>`, 'num'],
    [e(item.unmatchedLineCount), 'num'],
    [idHtml(item.confirmedBy)], [e(item.confirmationNote ?? '')],
  ]));

  // #87: raporty zbudowane przed tą zmianą (np. z archiwum) nie mają sekcji dowodów.
  const evidence = report.evidence ?? { expensesWithoutEvidence: { count: 0, netCents: 0, items: [] }, possibleDuplicateEvidence: [] };
  const missingEvidenceRows = evidence.expensesWithoutEvidence.items.map((item) => row([
    [e(formatDate(item.occurredOn))], [e(item.category)], [e(item.description)], [money(item.netAmountCents), 'num'], [idHtml(item.id)],
  ]));
  const duplicateEvidenceRows = evidence.possibleDuplicateEvidence.map((item) => row([
    [item.documentIds.map(idHtml).join('<br>')], [item.ledgerEntryIds.map(idHtml).join('<br>')],
  ]));

  const checkRows = (report.checks.items ?? []).map((check) => row([
    [e(CHECK_LABEL[check.id] ?? check.id)],
    [check.ok === null ? 'nie liczono' : check.ok ? 'zgodne' : '<span class="flag">niezgodne</span>'],
    [checkDetails(check)],
  ]));

  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Raport dla Komisji Rewizyjnej — ${e(formatSchoolYear(schoolYear.label))}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<header>
<h1>Raport dla Komisji Rewizyjnej</h1>
<p>Rada Rodziców — rok szkolny ${e(formatSchoolYear(schoolYear.label))} (${e(formatDate(schoolYear.startsOn))}–${e(formatDate(schoolYear.endsOn))})</p>
<p class="meta">Stan na: ${e(formatDate(report.asOf ?? report.generatedAt))} (czas Europe/Brussels; jedna migawka bazy danych — wszystkie liczby z tej samej chwili). Kwoty w EUR. Identyfikatory wpisów, dokumentów i kont są skrócone do 8 znaków (jak w panelach); pełne są w wersji JSON raportu. Aby zapisać PDF, użyj drukowania w przeglądarce.</p>
<p class="notice">Zestawienie z księgi w systemie. Nie jest zatwierdzonym sprawozdaniem finansowym; wymaga sprawdzenia z dokumentami źródłowymi.</p>
</header>

<h2>1. Bilans roku</h2>
<table><tbody>
<tr><th>Bilans otwarcia (z korektami)</th><td class="num">${money(balance.openingBalanceCents)}</td></tr>
<tr><th>Przychody netto</th><td class="num">${money(balance.incomeCents)}</td></tr>
<tr><th>Wydatki netto</th><td class="num">${money(balance.expenseCents)}</td></tr>
<tr><th>Bilans otwarcia — rachunek / kasa</th><td class="num">${money(balance.openingBankCents ?? 0)} / ${money(balance.openingCashCents ?? 0)}</td></tr>
<tr><th>Bilans zamknięcia</th><td class="num">${money(balance.closingBalanceCents)}</td></tr>
<tr><th>Bilans zamknięcia — rachunek / kasa</th><td class="num">${money(balance.closingBankCents ?? 0)} / ${money(balance.closingCashCents ?? 0)}</td></tr>
</tbody></table>
<p class="meta">Kontrole krzyżowe poniżej porównują niezależnie liczone źródła; wynik jest wskaźnikiem do sprawdzenia, nie oceną.</p>
${table([['Kontrola'], ['Wynik'], ['Wartości']], checkRows, 'Brak kontroli.')}

<h2>2. Przychody i wydatki według kategorii</h2>
${table([['Rodzaj'], ['Kategoria'], ['Wpisy', 'num'], ['Kwota pierwotna', 'num'], ['Korekty', 'num'], ['Netto', 'num']],
    categoryRows, 'Brak kategorii w tym roku.')}
${report.budgetExecution ? `
<h2>2a. Preliminarz a wykonanie</h2>
<p>${adoptionText(report.budgetExecution.adoption)}</p>
${budgetExecutionTable(report.budgetExecution)}
<p class="meta">Wykonanie to suma netto wpisów (po korektach); „poza planem” — kategoria z wpisami bez linii preliminarza.</p>
` : ''}

<h2>3. Wydatki powyżej 3000 EUR</h2>
${table([['Data'], ['Kategoria'], ['Opis'], ['Kwota', 'num'], ['Netto', 'num'], ['Uchwała'], ['Zgodność z przyjętą uchwałą']],
    largeRows, 'Brak wydatków powyżej 3000 EUR.')}

<h2>3a. Wykonanie uchwał finansowych</h2>
${table([['Uchwała'], ['Tytuł'], ['Stan'], ['Kwota upoważnienia', 'num'], ['Wydatki netto', 'num'], ['Pozostało', 'num'], ['Wpisy', 'num']],
    executionRows, 'Brak wydatków powiązanych z uchwałą przez jej wskazanie.')}
<p class="meta">Wydatki powiązane wyłącznie numerem w tekście nie są tu liczone (sekcja 3: „powiązanie tekstowe”).</p>
${reviews ? `
<h2>3b. Weryfikacja wydatków przez drugą osobę</h2>
<table><tbody>
<tr><th>Niezweryfikowane</th><td class="num">${e(reviews.unverified.count)}</td><td class="num">${money(reviews.unverified.netCents)}</td></tr>
<tr><th>Zakwestionowane</th><td class="num">${e(reviews.questioned.count)}</td><td class="num">${money(reviews.questioned.netCents)}</td></tr>
<tr><th>Zweryfikowane</th><td class="num">${e(reviews.verified.count)}</td><td class="num">${money(reviews.verified.netCents)}</td></tr>
</tbody></table>
<p>Kilka wydatków do 3000 EUR w tej samej kategorii w ciągu ${e(reviews.splitWindowDays)} dni, razem powyżej 3000 EUR (informacja do sprawdzenia, nie zarzut):</p>
${table([['Kategoria'], ['Okres'], ['Wpisy', 'num'], ['Razem netto', 'num'], ['Wpisy księgi']], splitRows, 'Brak takich zestawień.')}
` : ''}

${eventResults ? `
<h2>3c. Wynik wydarzeń</h2>
${table([['Wydarzenie'], ['Stan'], ['Wpisy', 'num'], ['Przychody', 'num'], ['Wydatki', 'num'], ['Wynik', 'num']],
    eventRows, '')}
<p class="meta">Kwoty z przypisań wpisów księgi do wydarzeń (bieżące wersje przypisań). Przychody i wydatki „bez przypisania” to reszta netto roku, więc wiersz „Razem rok” zgadza się z bilansem roku. Wynik ujemny oznacza, że wydatki przypisane do wydarzenia przekraczają przypisane przychody; to informacja do sprawdzenia, nie ocena.</p>
` : ''}

<h2>4. Korekty</h2>
${table([['Zapisano'], ['Wpis księgi'], ['Data wpisu'], ['Rodzaj'], ['Kwota korekty', 'num'], ['Powód'], ['Autor (id)']],
    correctionRows, 'Brak korekt wpisów księgi.')}
${reclassificationRows.length ? `<p>Przeksięgowania (storno starego wpisu i wpis zastępczy — bilans zmienia tylko różnica kwot):</p>${table([['Zapisano'], ['Wpis stary → nowy'], ['Kategoria'], ['Data'], ['Storno', 'num'], ['Nowy wpis', 'num'], ['Powód'], ['Uwagi']], reclassificationRows, '')}` : ''}
${adjustmentRows.length ? `<p>Korekty bilansu otwarcia:</p>${table([['Zapisano'], ['Kwota', 'num'], ['Powód'], ['Autor (id)']], adjustmentRows, '')}` : ''}

<h2>5. Uzgodnienia rachunku bankowego</h2>
${table([['Data wyciągu'], ['Status'], ['Saldo wyciągu', 'num'], ['Saldo księgi', 'num'], ['Różnica', 'num'], ['Niedopasowane pozycje', 'num'], ['Zatwierdził (id)'], ['Wyjaśnienie']],
    reconciliationRows, 'Brak uzgodnień rachunku w tym roku.')}
<p class="meta">Zatwierdzone uzgodnienia: ${e(reconciliations.confirmedCount)}; szkice: ${e(reconciliations.draftCount)}; porzucone szkice: ${e(reconciliations.abandonedCount ?? 0)}. Saldo księgi w szkicu jest wyliczane na bieżąco.</p>

<h2>6. Dowody wydatków</h2>
<p>Wydatki bez dowodu: ${e(evidence.expensesWithoutEvidence.count)}; suma netto ${money(evidence.expensesWithoutEvidence.netCents)}.</p>
${table([['Data'], ['Kategoria'], ['Opis'], ['Netto', 'num'], ['Wpis księgi']], missingEvidenceRows, 'Każdy wydatek ma co najmniej jeden dokument.')}
<p>Możliwe duplikaty dowodu (ten sam plik przy więcej niż jednym wydatku — do sprawdzenia):</p>
${table([['Dokument'], ['Wpisy księgi']], duplicateEvidenceRows, 'Brak powtórzonych dokumentów.')}
<p class="meta">Liczone są wydatki z kwotą netto powyżej zera. Numer i wystawca faktury nie są jeszcze zapisywane, więc duplikat tej samej faktury w innym pliku nie zostanie wykryty.</p>

<h2>Uwagi Komisji Rewizyjnej</h2>
<p class="empty">&nbsp;</p>
<div class="signatures"><div>Data i podpis</div><div>Data i podpis</div><div>Data i podpis</div></div>
</body>
</html>
`;
}

// --- Preliminarz a wykonanie (#107): wspólne dla raportu KR (sekcja 2a) i wydruku
// src/pg/budget-report.js. Brak planu to „—”, nie „0,00 EUR”.

const optionalMoney = (cents) => (cents === null || cents === undefined ? '—' : e(formatEur(cents)));

function percentText(value) {
  return value === null || value === undefined ? '—' : `${e(String(value).replace('.', ','))}%`;
}

// Wiersze tabeli: kategoria, plan przyjęty, plan bieżący, wykonanie, różnica, %.
export function budgetExecutionRows(items) {
  return items.map((item) => {
    const flag = item.overBudget ? ' class="flag"' : '';
    const name = `${e(item.categoryName)}${item.active ? '' : ' <span class="meta">(wyłączona)</span>'}${item.outsidePlan ? ' <span class="flag">poza planem</span>' : ''}`;
    return `<tr><td>${e(DIRECTION[item.direction] ?? item.direction)}</td><td>${name}</td>`
      + `<td class="num">${optionalMoney(item.adoptedPlanCents)}</td><td class="num">${optionalMoney(item.currentPlanCents)}</td>`
      + `<td class="num"><span${flag}>${optionalMoney(item.executedNetCents)}</span></td>`
      + `<td class="num">${optionalMoney(item.differenceCents)}</td><td class="num">${percentText(item.executionPercent)}</td></tr>`;
  });
}

export function budgetExecutionTable(execution) {
  const rows = budgetExecutionRows(execution.items);
  if (!rows.length) return '<p class="empty">Brak preliminarza i wpisów w tym roku.</p>';
  return `<table><thead><tr><th>Rodzaj</th><th>Kategoria</th><th class="num">Plan przyjęty</th><th class="num">Plan bieżący</th>`
    + `<th class="num">Wykonanie netto</th><th class="num">Różnica</th><th class="num">%</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

export function adoptionText(adoption) {
  if (!adoption) return 'Preliminarz nie został jeszcze zapisany jako przyjęty przez zebranie.';
  const resolution = adoption.resolutionNumber ? `, uchwała ${e(adoption.resolutionNumber)}` : ', bez uchwały w systemie';
  return `Plan przyjęty: ${e(formatDate(adoption.adoptedOn))}${resolution}.`;
}
