// Drukowalny raport roczny dla Komisji Rewizyjnej (HTML, A4). PDF powstaje
// przez drukowanie z przeglądarki — serwer nie generuje plików PDF.
//
// Każda wartość pochodząca z bazy przechodzi przez escapeHtml. Strona nie
// zawiera skryptów; CSP dopuszcza wyłącznie wbudowany arkusz stylów o znanym
// skrócie SHA-256.

import { formatEur as formatEurShared } from '../../panel/money.js';

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
      const listed = (check.items ?? []).map((item) => `${escapeHtml(item.kind === 'payment_entry' ? 'wpłata' : 'wpis')} ${escapeHtml(item.id)} (${escapeHtml(item.date)})`);
      return `wpisy księgi poza rokiem: ${escapeHtml(check.ledgerEntryCount)}; wpłaty poza rokiem: ${escapeHtml(check.paymentCount)}${listed.length ? `<br>${listed.join('<br>')}` : ''}`;
    }
    case 'payments_in_ledger':
      return `wpłaty ${m(check.paymentsNetCents)}; ujęte w księdze ${m(check.ledgerLinkedNetCents)}; różnica ${m(check.differenceCents)}; wpłaty bez wpisu księgi: ${escapeHtml(check.paymentsWithoutLedgerEntry)}`;
    case 'reconciliation_matches':
      return `niezgodne kwotowo: ${escapeHtml(check.amountMismatchCount)}; podwójne ujęcie: ${escapeHtml(check.doubleCountedCount)}; w tym w zatwierdzonych uzgodnieniach (do wyjaśnienia, bez ścieżki poprawy): ${escapeHtml(check.amountMismatchConfirmedCount)}`;
    case 'latest_confirmed_reconciliation':
      return check.statementDate
        ? `wyciąg z ${escapeHtml(check.statementDate)}; różnica ${m(check.differenceCents)}; przelewy w księdze po dacie wyciągu: ${escapeHtml(check.bankEntriesAfterStatement)}`
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

// "2026-10-20" -> "20.10.2026"; znacznik czasu -> "20.10.2026 14:05 UTC".
export function formatDate(value) {
  if (!value) return '';
  const text = String(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!match) return text;
  const date = `${match[3]}.${match[2]}.${match[1]}`;
  return match[4] ? `${date} ${match[4]}:${match[5]} UTC` : date;
}

const e = escapeHtml;
const money = (cents) => e(formatEur(cents));

const DIRECTION = { income: 'przychód', expense: 'wydatek' };
const STATUS = { draft: 'szkic', confirmed: 'zatwierdzone', abandoned: 'porzucone' };

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
    [e(item.resolutionReference ?? '—')],
    [item.matchesAdoptedResolution === true ? 'tak'
      : item.matchesAdoptedResolution === false ? '<span class="flag">brak zgodnej przyjętej uchwały</span>'
        : 'nie sprawdzono'],
  ]));

  const correctionRows = corrections.map((item) => row([
    [e(formatDate(item.createdAt))], [e(item.ledgerEntryId)], [e(formatDate(item.entryOccurredOn))],
    [e(DIRECTION[item.direction] ?? item.direction)], [money(item.amountCents), 'num'], [e(item.reason)],
    [e(item.createdBy)],
  ]));

  const adjustmentRows = openingAdjustments.map((item) => row([
    [e(formatDate(item.createdAt))], [money(item.amountCents), 'num'], [e(item.reason)], [e(item.createdBy)],
  ]));

  const reconciliationRows = reconciliations.items.map((item) => row([
    [e(formatDate(item.statementDate))], [e(STATUS[item.status] ?? item.status)],
    [money(item.statementBalanceCents), 'num'], [money(item.ledgerBalanceCents), 'num'],
    [item.differenceCents === 0 ? money(0) : `<span class="flag">${money(item.differenceCents)}</span>`, 'num'],
    [e(item.unmatchedLineCount), 'num'],
    [e(item.confirmedBy ?? '—')], [e(item.confirmationNote ?? '')],
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
<title>Raport dla Komisji Rewizyjnej — ${e(schoolYear.label)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<header>
<h1>Raport dla Komisji Rewizyjnej</h1>
<p>Rada Rodziców — rok szkolny ${e(schoolYear.label)} (${e(formatDate(schoolYear.startsOn))}–${e(formatDate(schoolYear.endsOn))})</p>
<p class="meta">Wygenerowano: ${e(formatDate(report.generatedAt))}. Kwoty w EUR. Aby zapisać PDF, użyj drukowania w przeglądarce.</p>
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

<h2>3. Wydatki powyżej 3000 EUR</h2>
${table([['Data'], ['Kategoria'], ['Opis'], ['Kwota', 'num'], ['Netto', 'num'], ['Uchwała'], ['Zgodność z przyjętą uchwałą']],
    largeRows, 'Brak wydatków powyżej 3000 EUR.')}

<h2>4. Korekty</h2>
${table([['Zapisano'], ['Wpis księgi'], ['Data wpisu'], ['Rodzaj'], ['Kwota korekty', 'num'], ['Powód'], ['Autor (id)']],
    correctionRows, 'Brak korekt wpisów księgi.')}
${adjustmentRows.length ? `<p>Korekty bilansu otwarcia:</p>${table([['Zapisano'], ['Kwota', 'num'], ['Powód'], ['Autor (id)']], adjustmentRows, '')}` : ''}

<h2>5. Uzgodnienia rachunku bankowego</h2>
${table([['Data wyciągu'], ['Status'], ['Saldo wyciągu', 'num'], ['Saldo księgi', 'num'], ['Różnica', 'num'], ['Niedopasowane pozycje', 'num'], ['Zatwierdził (id)'], ['Wyjaśnienie']],
    reconciliationRows, 'Brak uzgodnień rachunku w tym roku.')}
<p class="meta">Zatwierdzone uzgodnienia: ${e(reconciliations.confirmedCount)}; szkice: ${e(reconciliations.draftCount)}; porzucone szkice: ${e(reconciliations.abandonedCount ?? 0)}. Saldo księgi w szkicu jest wyliczane na bieżąco.</p>

<h2>Uwagi Komisji Rewizyjnej</h2>
<p class="empty">&nbsp;</p>
<div class="signatures"><div>Data i podpis</div><div>Data i podpis</div><div>Data i podpis</div></div>
</body>
</html>
`;
}
