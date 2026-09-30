// Testy czystych funkcji ekranu Komisji Rewizyjnej (issue #147): audit/core.js.
// Ekran jest tylko do odczytu; dostęp egzekwuje serwer (GET /api/reports/audit).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  REPORT_ROLES,
  buildSections,
  checkDetails,
  describeApiError,
  formatDate,
  hasReportAccess,
  idCell,
  isValidId,
  reportUrl,
} from '../audit/core.js';
import { formatDate as formatReportDate, renderAuditReportHtml } from '../src/pg/audit-report.js';

const NBSP = ' ';

test('role panelu odpowiadają REPORT_ROLES na serwerze', () => {
  const source = readFileSync(new URL('../src/pg/routes/reconciliation.js', import.meta.url), 'utf8');
  const match = source.match(/const REPORT_ROLES = \[([^\]]*)\]/)[1];
  const parse = (text) => [...text.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...REPORT_ROLES], parse(match));
});

test('hasReportAccess: audit bez klasy tak; przedstawiciel, admin i przydział klasowy nie; rok musi pasować', () => {
  assert.equal(hasReportAccess([{ role: 'audit', schoolYearId: 'y1' }], 'y1'), true);
  assert.equal(hasReportAccess([{ role: 'audit', schoolYearId: 'y1' }], 'y2'), false);
  assert.equal(hasReportAccess([{ role: 'audit' }], 'y2'), true);
  assert.equal(hasReportAccess([{ role: 'audit', classId: '1A' }]), false);
  assert.equal(hasReportAccess([{ role: 'representative', classId: '1A', schoolYearId: 'y1' }]), false);
  assert.equal(hasReportAccess([{ role: 'admin' }]), false);
  assert.equal(hasReportAccess(undefined), false);
});

test('reportUrl: tylko poprawny rok i format json/html', () => {
  assert.equal(reportUrl('2026-2027'), '/api/reports/audit?schoolYearId=2026-2027&format=json');
  assert.equal(reportUrl(' 2026-2027 ', 'html'), '/api/reports/audit?schoolYearId=2026-2027&format=html');
  assert.throws(() => reportUrl('../x'));
  assert.throws(() => reportUrl('y1', 'csv'));
  assert.equal(isValidId('a b'), false);
});

test('describeApiError: MFA, brak uprawnień, brak roku', () => {
  assert.match(describeApiError(403, 'mfa_required'), /MFA/);
  assert.match(describeApiError(403, 'forbidden'), /uprawnie/);
  assert.match(describeApiError(404, 'school_year_not_found'), /Nie znaleziono/);
  assert.match(describeApiError(401, ''), /Sesja/);
  assert.equal(describeApiError(500, 'internal_error'), null);
});

// Przegląd demo 4: data jak w kolumnach paneli (RRRR-MM-DD), czas w strefie
// Europe/Brussels (jak Zebrania/Wydarzenia/Konta), nigdy „UTC”; panel i HTML serwera
// używają tej samej funkcji (shared/zoned-time.js#formatDateOrTimestamp).
test('formatDate: data jak w panelach, znacznik czasu w strefie Europe/Brussels', () => {
  assert.equal(formatDate('2026-10-20'), '2026-10-20');
  assert.equal(formatDate('2026-10-20T14:05:00.000Z'), '2026-10-20 16:05', 'czas letni: UTC+2');
  assert.equal(formatDate('2026-11-03T10:00:00.000Z'), '2026-11-03 11:00', 'czas zimowy: UTC+1');
  assert.equal(formatDate('2026-10-25T00:30:00.000Z'), '2026-10-25 02:30', 'noc zmiany czasu');
  assert.equal(formatDate('2026-08-31T22:30:00.000Z'), '2026-09-01 00:30', 'data lokalna, nie UTC');
  assert.equal(formatDate(null), '—');
  assert.equal(formatDate('bez daty'), 'bez daty');
  for (const value of ['2026-10-20', '2026-10-20T14:05:00.000Z', new Date('2026-10-20T14:05:00.000Z')]) {
    assert.equal(formatReportDate(value), formatDate(value), 'HTML serwera i panel formatują tak samo');
  }
  assert.equal(formatReportDate(null), '');
  assert.doesNotMatch(formatDate('2026-10-20T14:05:00.000Z'), /UTC/);
});

const REPORT = {
  schoolYear: { id: 'y1', label: '2026-2027' },
  generatedAt: '2026-10-20T14:05:00.000Z',
  balance: { openingBalanceCents: 10000, incomeCents: 250000, expenseCents: 120000, closingBalanceCents: 140000, closingBankCents: 130000, closingCashCents: 10000 },
  checks: { items: [
    { id: 'year_end_balance', ok: true, closingBalanceCents: 140000, balanceAtYearEndCents: 140000, differenceCents: 0 },
    { id: 'latest_confirmed_reconciliation', ok: null, statementDate: null },
  ] },
  categories: [{ direction: 'income', name: 'Składki', entryCount: 3, grossCents: 250000, correctedCents: 0, netCents: 250000 }],
  largeExpenses: [{ occurredOn: '2026-11-02', category: 'Wycieczka', description: 'Autokar', amountCents: 400000, netAmountCents: 400000, resolutionReference: 'U/1', matchesAdoptedResolution: false }],
  corrections: [{ createdAt: '2026-11-03T10:00:00.000Z', ledgerEntryId: 'e1', entryOccurredOn: '2026-11-02', direction: 'expense', amountCents: -500, reason: 'Pomyłka kwoty', createdBy: 'user-secret-id' }],
  reconciliations: { items: [{ statementDate: '2026-11-30', status: 'confirmed', statementBalanceCents: 1, ledgerBalanceCents: 1, differenceCents: 0, unmatchedLineCount: 0, confirmedBy: 'user-secret-id', confirmationNote: null }], confirmedCount: 1, draftCount: 0 },
};

test('buildSections: sekcje z raportu, kwoty w EUR, bez identyfikatorów autorów', () => {
  const sections = buildSections(REPORT);
  const ids = sections.map((s) => s.id);
  assert.deepEqual(ids, ['balance', 'checks', 'categories', 'large-expenses', 'corrections', 'reconciliations']);
  const balance = sections.find((s) => s.id === 'balance');
  assert.equal(balance.rows[3][1], `1${NBSP}400,00${NBSP}€`);
  const large = sections.find((s) => s.id === 'large-expenses');
  assert.equal(large.rows[0][6], 'brak zgodnej przyjętej uchwały');
  assert.equal(sections.find((s) => s.id === 'checks').rows[1][1], 'nie liczono');
  assert.doesNotMatch(JSON.stringify(sections), /user-secret-id/);
});

test('buildSections: raport z archiwum bez sekcji opcjonalnych, pusty raport bez wyjątku', () => {
  const minimal = buildSections({ balance: {}, checks: {}, categories: [] });
  assert.ok(minimal.every((s) => Array.isArray(s.rows)));
  assert.ok(!minimal.some((s) => s.id === 'evidence' || s.id === 'reviews' || s.id === 'resolution-execution'));
  assert.deepEqual(buildSections(null), []);
  const withOptional = buildSections({ ...REPORT, evidence: { expensesWithoutEvidence: { count: 1, netCents: 500, items: [{ occurredOn: '2026-11-02', category: 'X', description: 'Y', netAmountCents: 500, id: 'e2' }] }, possibleDuplicateEvidence: [] }, expenseReviews: { unverified: { count: 1, netCents: 5 }, questioned: { count: 0, netCents: 0 }, verified: { count: 2, netCents: 9 }, splitWindowDays: 30, possibleSplits: [] }, resolutionExecution: [{ number: 'U/1', title: 'T', status: 'adopted', authorizedAmountCents: null, spentNetCents: 1, remainingCents: null, entryCount: 1 }] });
  assert.ok(withOptional.some((s) => s.id === 'evidence'));
  assert.equal(withOptional.find((s) => s.id === 'resolution-execution').rows[0][3], 'bez kwoty');
});

test('checkDetails: nieznana kontrola daje pusty opis', () => {
  assert.equal(checkDetails({ id: 'nieznana' }), '');
});

test('ekran nie ma akcji zmieniających stan: tylko GET, brak POST/PATCH/DELETE w audit/main.js', () => {
  const main = readFileSync(new URL('../audit/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /method:\s*["'](POST|PUT|PATCH|DELETE)["']/);
  assert.doesNotMatch(main, /<button[^>]*type=["']submit["'][^>]*>\s*(Zatwierdź|Usuń|Zapisz)/);
});

test('idCell: skrót identyfikatora w treści, pełna wartość w podpowiedzi', () => {
  const id = 'd2721f76-1111-4222-8333-444455556666';
  assert.deepEqual(idCell(id), { text: 'd2721f76…', title: id });
  assert.equal(idCell(null), '—');
  const sections = buildSections({
    ...REPORT,
    corrections: [{ ...REPORT.corrections[0], ledgerEntryId: id }],
    evidence: { expensesWithoutEvidence: { count: 1, netCents: 500, items: [{ occurredOn: '2026-11-02', category: 'X', description: 'Y', netAmountCents: 500, id }] }, possibleDuplicateEvidence: [] },
  });
  assert.deepEqual(sections.find((s) => s.id === 'corrections').rows[0][1], { text: 'd2721f76…', title: id });
  assert.equal(sections.find((s) => s.id === 'corrections').rows[0][0], '2026-11-03 11:00');
  assert.deepEqual(sections.find((s) => s.id === 'evidence').rows[0][4], { text: 'd2721f76…', title: id });
  const main = readFileSync(new URL('../audit/main.js', import.meta.url), 'utf8');
  assert.match(main, /td\.title = value\.title/, 'main.js wstawia pełny identyfikator jako podpowiedź');
});

test('raport HTML KR: „Stan na” w czasie brukselskim, bez „UTC”, skrócone UUID w kolumnie „Wpis księgi”', () => {
  const entry = 'aaaaaaaa-1111-4222-8333-444455556666';
  const doc = 'bbbbbbbb-1111-4222-8333-444455556666';
  const user = 'cccccccc-1111-4222-8333-444455556666';
  const html = renderAuditReportHtml({
    ...REPORT,
    asOf: '2026-10-20T14:05:00.000Z',
    schoolYear: { id: '2026-2027', label: '2026-2027', startsOn: '2026-09-01', endsOn: '2027-08-31' },
    openingAdjustments: [{ createdAt: '2026-09-02T08:00:00.000Z', amountCents: 100, reason: 'Korekta', createdBy: user }],
    corrections: [{ ...REPORT.corrections[0], ledgerEntryId: entry, createdBy: user }],
    reconciliations: { ...REPORT.reconciliations, items: [{ ...REPORT.reconciliations.items[0], confirmedBy: user }] },
    evidence: {
      expensesWithoutEvidence: { count: 1, netCents: 500, items: [{ occurredOn: '2026-11-02', category: 'X', description: 'Y', netAmountCents: 500, id: entry }] },
      possibleDuplicateEvidence: [{ documentIds: [doc], ledgerEntryIds: [entry] }],
    },
  });
  assert.match(html, /Stan na: 2026-10-20 16:05 \(czas Europe\/Brussels;/);
  assert.doesNotMatch(html, /UTC/);
  assert.match(html, /\(2026-09-01–2027-08-31\)/);
  assert.match(html, /<td>2026-11-03 11:00<\/td>/, 'kolumna „Zapisano” w czasie brukselskim');
  // Pełne UUID wyłącznie w atrybucie title, w treści komórki skrót.
  const visible = html.replace(/ title="[^"]*"/g, '');
  for (const id of [entry, doc, user]) {
    assert.doesNotMatch(visible, new RegExp(id), `pełny identyfikator ${id.slice(0, 8)} nie jest widoczny w treści`);
    assert.match(html, new RegExp(`<span title="${id}">${id.slice(0, 8)}…</span>`));
  }
});
