// Sprawozdanie roczne dla zebrania ogólnego i przepływy środków (#125, część).
// Prototyp — nie jest wdrożony i nie jest zatwierdzonym sprawozdaniem.
//
// Sprawozdanie (buildAnnualReport) to zestawienie ZAGREGOWANE: bilans, przychody
// i wydatki według kategorii, preliminarz vs wykonanie, liczba wpisów i korekt,
// data ostatniego zatwierdzonego uzgodnienia. Bez opisów pojedynczych wpisów,
// bez identyfikatorów osób, bez danych rodzin, bez wpłat per klasa i bez sald
// pośrednich uzgodnień. Przepływy (buildCashFlow): per miesiąc i metoda —
// wpływy, wydatki, saldo narastające; osobno saldo gotówki (kasy).
//
// Korekta liczy się z datą korygowanego wpisu — jak w ledger_balance_at (0015),
// więc saldo narastające na koniec roku = bilans zamknięcia z ledger_year_summary.

import { REPORT_CSS, escapeHtml, formatDate, formatEur } from './audit-report.js';
import { toSafeInteger } from './routes/payments.js';

const METHODS = ['bank', 'cash', 'card', 'other'];
const n = (value) => (value === null || value === undefined ? 0 : toSafeInteger(value));

async function loadYear(db, schoolYearId) {
  const { rows } = await db.query(
    `SELECT y.id, y.label, to_char(y.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(y.ends_on, 'YYYY-MM-DD') AS ends_on,
            s.opening_balance_cents, s.income_cents, s.expense_cents, s.closing_balance_cents,
            c.opening_cash_cents, c.closing_cash_cents
       FROM school_years y
       JOIN ledger_year_summary s ON s.school_year_id = y.id
       JOIN ledger_year_cash_summary c ON c.school_year_id = y.id
      WHERE y.id = $1`,
    [schoolYearId],
  );
  return rows[0] ?? null;
}

export async function buildAnnualReport(db, schoolYearId, { now = new Date() } = {}) {
  const year = await loadYear(db, schoolYearId);
  if (!year) return null;
  const [categories, counts, reconciliation] = await Promise.all([
    db.query(
      `SELECT c.id, c.direction, c.name,
              COALESCE(sum(e.net_amount_cents), 0) AS net_cents,
              count(e.id) AS entry_count,
              (SELECT b.planned_cents FROM ledger_current_budget b
                WHERE b.category_id = c.id AND b.school_year_id = c.school_year_id
                ORDER BY b.created_at DESC, b.id LIMIT 1) AS planned_cents
         FROM ledger_categories c
         LEFT JOIN ledger_entry_net e ON e.category_id = c.id AND e.school_year_id = c.school_year_id
        WHERE c.school_year_id = $1
        GROUP BY c.id, c.direction, c.name, c.school_year_id
        ORDER BY c.direction DESC, c.name COLLATE "C", c.id COLLATE "C"`,
      [schoolYearId],
    ),
    db.query(
      `SELECT (SELECT count(*) FROM ledger_entries WHERE school_year_id = $1) AS entry_count,
              (SELECT count(*) FROM ledger_corrections c JOIN ledger_entries e ON e.id = c.ledger_entry_id
                WHERE e.school_year_id = $1) AS correction_count`,
      [schoolYearId],
    ),
    db.query(
      `SELECT to_char(max(statement_date), 'YYYY-MM-DD') AS statement_date
         FROM bank_reconciliations WHERE school_year_id = $1 AND status = 'confirmed'`,
      [schoolYearId],
    ),
  ]);

  const byDirection = (direction) => categories.rows
    .filter((row) => row.direction === direction)
    // Kategoria bez wpisów i bez preliminarza nie wnosi nic do sprawozdania.
    .filter((row) => n(row.entry_count) > 0 || row.planned_cents !== null)
    .map((row) => ({
      categoryId: row.id,
      name: row.name,
      netCents: n(row.net_cents),
      plannedCents: row.planned_cents === null ? null : n(row.planned_cents),
      varianceCents: row.planned_cents === null ? null : n(row.net_cents) - n(row.planned_cents),
    }));
  const income = byDirection('income');
  const expense = byDirection('expense');
  const planned = (rows) => (rows.some((row) => row.plannedCents !== null)
    ? rows.reduce((sum, row) => sum + (row.plannedCents ?? 0), 0) : null);
  const openingBalanceCents = n(year.opening_balance_cents);
  const closingBalanceCents = n(year.closing_balance_cents);
  const openingCashCents = n(year.opening_cash_cents);
  const closingCashCents = n(year.closing_cash_cents);
  return {
    kind: 'annual',
    schoolYear: { id: year.id, label: year.label, startsOn: year.starts_on, endsOn: year.ends_on },
    generatedAt: now.toISOString(),
    balance: {
      openingBalanceCents,
      openingBankCents: openingBalanceCents - openingCashCents,
      openingCashCents,
      incomeCents: n(year.income_cents),
      expenseCents: n(year.expense_cents),
      resultCents: n(year.income_cents) - n(year.expense_cents),
      closingBalanceCents,
      closingBankCents: closingBalanceCents - closingCashCents,
      closingCashCents,
    },
    income: { categories: income, totalCents: n(year.income_cents), plannedCents: planned(income) },
    expense: { categories: expense, totalCents: n(year.expense_cents), plannedCents: planned(expense) },
    counts: { entryCount: n(counts.rows[0].entry_count), correctionCount: n(counts.rows[0].correction_count) },
    reconciliation: { lastConfirmedStatementDate: reconciliation.rows[0]?.statement_date ?? null },
  };
}

function monthsBetween(startsOn, endsOn) {
  const months = [];
  let [y, m] = startsOn.slice(0, 7).split('-').map(Number);
  const [endY, endM] = endsOn.slice(0, 7).split('-').map(Number);
  while (y < endY || (y === endY && m <= endM)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return months;
}

export async function buildCashFlow(db, schoolYearId, { now = new Date() } = {}) {
  const year = await loadYear(db, schoolYearId);
  if (!year) return null;
  const [entries, transfers] = await Promise.all([
    db.query(
      `SELECT to_char(occurred_on, 'YYYY-MM') AS month, method, direction, sum(net_amount_cents) AS cents
         FROM ledger_entry_net WHERE school_year_id = $1
        GROUP BY 1, 2, 3`,
      [schoolYearId],
    ),
    db.query(
      `SELECT to_char(transferred_on, 'YYYY-MM') AS month, direction, sum(amount_cents) AS cents
         FROM ledger_transfers WHERE school_year_id = $1
        GROUP BY 1, 2`,
      [schoolYearId],
    ),
  ]);
  const monthSet = new Set(monthsBetween(year.starts_on, year.ends_on));
  for (const row of [...entries.rows, ...transfers.rows]) monthSet.add(row.month);
  const months = [...monthSet].sort();

  let balance = n(year.opening_balance_cents);
  let cash = n(year.opening_cash_cents);
  const rows = months.map((month) => {
    const byMethod = Object.fromEntries(METHODS.map((method) => {
      const pick = (direction) => n(entries.rows.find((r) => r.month === month && r.method === method && r.direction === direction)?.cents);
      return [method, { incomeCents: pick('income'), expenseCents: pick('expense') }];
    }));
    const pickTransfer = (direction) => n(transfers.rows.find((r) => r.month === month && r.direction === direction)?.cents);
    const cashToBankCents = pickTransfer('cash_to_bank');
    const bankToCashCents = pickTransfer('bank_to_cash');
    const incomeCents = METHODS.reduce((sum, method) => sum + byMethod[method].incomeCents, 0);
    const expenseCents = METHODS.reduce((sum, method) => sum + byMethod[method].expenseCents, 0);
    balance += incomeCents - expenseCents;
    // Kasa = wszystko poza rachunkiem (jak ledger_non_bank_net_at): metody inne niż 'bank' i przeniesienia.
    const nonBankNet = METHODS.filter((method) => method !== 'bank')
      .reduce((sum, method) => sum + byMethod[method].incomeCents - byMethod[method].expenseCents, 0);
    cash += nonBankNet + bankToCashCents - cashToBankCents;
    return {
      month, byMethod, incomeCents, expenseCents, netCents: incomeCents - expenseCents,
      transfers: { cashToBankCents, bankToCashCents },
      runningBalanceCents: balance, runningCashCents: cash, runningBankCents: balance - cash,
    };
  });
  return {
    kind: 'cash_flow',
    granularity: 'month',
    schoolYear: { id: year.id, label: year.label, startsOn: year.starts_on, endsOn: year.ends_on },
    generatedAt: now.toISOString(),
    openingBalanceCents: n(year.opening_balance_cents),
    openingCashCents: n(year.opening_cash_cents),
    months: rows,
    totals: {
      incomeCents: rows.reduce((sum, row) => sum + row.incomeCents, 0),
      expenseCents: rows.reduce((sum, row) => sum + row.expenseCents, 0),
      closingBalanceCents: balance,
      closingCashCents: cash,
    },
  };
}

// --- HTML (A4, bez skryptów, CSP jak raport KR) ---------------------------------

const e = escapeHtml;
const money = (cents) => (cents === null || cents === undefined ? '—' : e(formatEur(cents)));

function table(headers, rows, emptyText) {
  if (!rows.length) return `<p class="empty">${e(emptyText)}</p>`;
  const head = headers.map(([label, cls]) => `<th${cls ? ` class="${cls}"` : ''}>${e(label)}</th>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

const cell = (html, cls) => `<td${cls ? ` class="${cls}"` : ''}>${html}</td>`;

function categoryTable(section, emptyText) {
  const rows = section.categories.map((item) => `<tr>${cell(e(item.name))}${cell(money(item.plannedCents), 'num')}${cell(money(item.netCents), 'num')}${cell(money(item.varianceCents), 'num')}</tr>`);
  if (rows.length) {
    rows.push(`<tr><th>Razem</th>${cell(money(section.plannedCents), 'num')}${cell(money(section.totalCents), 'num')}${cell(section.plannedCents === null ? '—' : money(section.totalCents - section.plannedCents), 'num')}</tr>`);
  }
  return table([['Kategoria'], ['Preliminarz', 'num'], ['Wykonanie', 'num'], ['Różnica', 'num']], rows, emptyText);
}

export function renderAnnualReportHtml(report) {
  const { schoolYear, balance } = report;
  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sprawozdanie finansowe — ${e(schoolYear.label)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<header>
<h1>Sprawozdanie finansowe Rady Rodziców</h1>
<p>Rok szkolny ${e(schoolYear.label)} (${e(formatDate(schoolYear.startsOn))}–${e(formatDate(schoolYear.endsOn))})</p>
<p class="meta">Wygenerowano: ${e(formatDate(report.generatedAt))}. Kwoty w EUR. Aby zapisać PDF, użyj drukowania w przeglądarce.</p>
<p class="notice">Projekt sprawozdania z bieżących danych księgi. Nie jest wersją zatwierdzoną ani przedstawioną zebraniu; po korekcie wydruk może się różnić.</p>
</header>

<h2>1. Bilans</h2>
<table><tbody>
<tr><th>Bilans otwarcia</th><td class="num">${money(balance.openingBalanceCents)}</td></tr>
<tr><th>w tym rachunek / kasa</th><td class="num">${money(balance.openingBankCents)} / ${money(balance.openingCashCents)}</td></tr>
<tr><th>Przychody</th><td class="num">${money(balance.incomeCents)}</td></tr>
<tr><th>Wydatki</th><td class="num">${money(balance.expenseCents)}</td></tr>
<tr><th>Wynik roku</th><td class="num">${money(balance.resultCents)}</td></tr>
<tr><th>Bilans zamknięcia</th><td class="num">${money(balance.closingBalanceCents)}</td></tr>
<tr><th>w tym rachunek / kasa</th><td class="num">${money(balance.closingBankCents)} / ${money(balance.closingCashCents)}</td></tr>
</tbody></table>

<h2>2. Przychody według kategorii</h2>
${categoryTable(report.income, 'Brak przychodów w tym roku.')}

<h2>3. Wydatki według kategorii</h2>
${categoryTable(report.expense, 'Brak wydatków w tym roku.')}

<h2>4. Informacje uzupełniające</h2>
<table><tbody>
<tr><th>Liczba wpisów księgi</th><td class="num">${e(report.counts.entryCount)}</td></tr>
<tr><th>Liczba korekt wpisów</th><td class="num">${e(report.counts.correctionCount)}</td></tr>
<tr><th>Ostatnie zatwierdzone uzgodnienie rachunku</th><td>${report.reconciliation.lastConfirmedStatementDate ? e(formatDate(report.reconciliation.lastConfirmedStatementDate)) : 'brak'}</td></tr>
</tbody></table>
<p>Opinia Komisji Rewizyjnej: dołączana osobno.</p>

<div class="signatures"><div>Skarbnik</div><div>Przewodniczący Rady</div><div>Komisja Rewizyjna</div></div>
</body>
</html>
`;
}
