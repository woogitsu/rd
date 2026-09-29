// Drukowalne zestawienie „preliminarz a wykonanie” (#107), HTML A4 jak raport
// Komisji Rewizyjnej: bez skryptów, wbudowany arkusz stylów o znanym skrócie
// (ta sama polityka CSP), każda wartość z bazy przez escapeHtml.

import {
  adoptionText, budgetExecutionTable, escapeHtml, formatDate, formatEur, REPORT_CSS,
} from './audit-report.js';
import { formatSchoolYear } from '../../shared/school-year.js';

const e = escapeHtml;
const money = (cents) => (cents === null || cents === undefined ? '—' : e(formatEur(cents)));

export function renderBudgetExecutionHtml(report) {
  const { schoolYear } = report;
  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Preliminarz a wykonanie — ${e(formatSchoolYear(schoolYear.label))}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<header>
<h1>Preliminarz a wykonanie</h1>
<p>Rada Rodziców — rok szkolny ${e(formatSchoolYear(schoolYear.label))} (${e(formatDate(schoolYear.startsOn))}–${e(formatDate(schoolYear.endsOn))})</p>
<p class="meta">Wygenerowano: ${e(formatDate(report.generatedAt))}.${report.asOf ? ` Wykonanie na dzień ${e(formatDate(report.asOf))}.` : ''} Kwoty w EUR. Aby zapisać PDF, użyj drukowania w przeglądarce.</p>
<p class="notice">Zestawienie z księgi w systemie. Nie jest zatwierdzonym sprawozdaniem finansowym.</p>
</header>
<p>${adoptionText(report.adoption)}</p>
${budgetExecutionTable(report)}
<table><tbody>
<tr><th>Przychody — plan bieżący / wykonanie</th><td class="num">${money(report.totals.income.currentPlanCents)} / ${money(report.totals.income.executedNetCents)}</td></tr>
<tr><th>Wydatki — plan bieżący / wykonanie</th><td class="num">${money(report.totals.expense.currentPlanCents)} / ${money(report.totals.expense.executedNetCents)}</td></tr>
</tbody></table>
<p class="meta">Wykonanie to suma netto wpisów księgi (po korektach). „Poza planem” oznacza kategorię z wpisami bez linii preliminarza.</p>
</body>
</html>
`;
}
