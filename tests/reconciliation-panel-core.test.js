// Testy czystych funkcji ekranu uzgodnienia wyciągu bankowego (issue #147, część 2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  WRITE_ROLES,
  MAX_STATEMENT_FILE_BYTES,
  auditReportUrl,
  buildStatementFileBody,
  decodeStatementBytes,
  describeImportWarnings,
  describeStatementImportError,
  detectStatementFormat,
  statementFileProblem,
  summarizeStatementImport,
  buildReconciliationsUrl,
  candidateLabel,
  canOfferConfirm,
  describeApiError,
  formatCents,
  formatDifference,
  hasWriteAccess,
  isLikelyOwnReconciliation,
  isValidId,
  lineDirectionLabel,
  lineSourceLabel,
  makeIdempotencyKey,
  parseStatementBalance,
  reconciliationActionUrl,
  reconciliationUrl,
  requiresConfirmationNote,
  summarizeInconsistencies,
} from '../reconciliation/core.js';

test('role panelu odpowiadają WRITE_ROLES na serwerze', () => {
  const source = readFileSync(new URL('../src/pg/routes/reconciliation.js', import.meta.url), 'utf8');
  const match = source.match(/const WRITE_ROLES = \[([^\]]*)\]/)[1];
  const parse = (text) => [...text.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...WRITE_ROLES], parse(match));
});

test('isValidId: identyfikatory jak na serwerze', () => {
  assert.equal(isValidId('rec-1'), true);
  assert.equal(isValidId(''), false);
  assert.equal(isValidId(undefined), false);
});

test('buildReconciliationsUrl / reconciliationUrl / reconciliationActionUrl', () => {
  assert.equal(buildReconciliationsUrl('y2026'), '/api/reconciliations?schoolYearId=y2026');
  assert.throws(() => buildReconciliationsUrl(''), /szkolnego/);
  assert.equal(reconciliationUrl('rec-1'), '/api/reconciliations/rec-1');
  assert.equal(reconciliationActionUrl('rec-1', 'confirm'), '/api/reconciliations/rec-1/confirm');
  assert.throws(() => reconciliationUrl(''), /identyfikator/);
});

test('auditReportUrl: domyślnie html, przyjmuje json', () => {
  assert.equal(auditReportUrl('y2026'), '/api/reports/audit?schoolYearId=y2026&format=html');
  assert.equal(auditReportUrl('y2026', 'json'), '/api/reports/audit?schoolYearId=y2026&format=json');
  assert.throws(() => auditReportUrl(''), /szkolnego/);
});

test('parseStatementBalance: kwota ze znakiem, jak wyciąg bankowy (debet/nadpłata)', () => {
  assert.equal(parseStatementBalance('1234,56'), 123456);
  assert.equal(parseStatementBalance('-50,00'), -5000);
  assert.equal(parseStatementBalance('+10'), 1000);
  assert.throws(() => parseStatementBalance('abc'), /maksymalnie dwoma miejscami/);
  assert.throws(() => parseStatementBalance('99999999999'), /poza dopuszczalnym zakresem/);
});

test('formatCents: reeksport formatEur (panel/money.js), brak wartości -> „—”', () => {
  assert.match(formatCents(123456), /1.234,56.€/u);
  assert.equal(formatCents(null), '—');
});

test('makeIdempotencyKey: prefiks + losowy UUID', () => {
  assert.equal(
    makeIdempotencyKey('reconciliation-create', () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    'reconciliation-create-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  );
  assert.throws(() => makeIdempotencyKey('x', null), /bezpiecznych identyfikatorów/);
});

// Serwer sprawdza bank_reconciliation_four_eyes (created_by aktora); to tylko
// przybliżenie widoczności przycisku, nigdy kontrola dostępu (AGENTS.md).
test('isLikelyOwnReconciliation / canOfferConfirm: autor nie widzi przycisku potwierdzenia', () => {
  const draft = { status: 'draft', createdBy: 'u1' };
  assert.equal(isLikelyOwnReconciliation(draft, 'u1'), true);
  assert.equal(canOfferConfirm(draft, 'u1'), false);
  assert.equal(canOfferConfirm(draft, 'u2'), true);
  assert.equal(canOfferConfirm({ ...draft, status: 'confirmed' }, 'u2'), false);
  assert.equal(canOfferConfirm(null, 'u2'), false);
});

test('requiresConfirmationNote: tylko gdy różnica ≠ 0', () => {
  assert.equal(requiresConfirmationNote({ differenceCents: 0 }), false);
  assert.equal(requiresConfirmationNote({ differenceCents: 150 }), true);
  assert.equal(requiresConfirmationNote({ differenceCents: -150 }), true);
});

test('formatDifference: zero vs różnica ze znakiem', () => {
  assert.match(formatDifference(0), /zgadza się/);
  assert.match(formatDifference(150), /1,50/);
});

test('lineDirectionLabel: dodatnia kwota to wpływ, ujemna to obciążenie', () => {
  assert.equal(lineDirectionLabel(1000), 'Wpływ');
  assert.equal(lineDirectionLabel(-1000), 'Obciążenie');
  assert.equal(lineDirectionLabel(0), 'Wpływ');
});

test('candidateLabel: typ, data, kwota i wskazówki dopasowania w jednym tekście', () => {
  const label = candidateLabel({
    type: 'payment_entry', id: 'p1', date: '2026-01-15', amountCents: 15000, dayDistance: 0, referenceMatch: true,
  });
  assert.match(label, /Wpłata/);
  assert.match(label, /2026-01-15/);
  assert.match(label, /150,00/);
  assert.match(label, /tytuł zgodny/);
  assert.match(label, /ta sama data/);
  const ledgerLabel = candidateLabel({ type: 'ledger_entry', id: 'l1', date: '2026-01-14', amountCents: 5000, dayDistance: 2, referenceMatch: false });
  assert.match(ledgerLabel, /Wpis księgi/);
  assert.match(ledgerLabel, /2 dni różnicy/);
});

test('summarizeInconsistencies: dołącza tekst powodów po polsku', () => {
  const [item] = summarizeInconsistencies([{ matchId: 'm1', reasons: ['amount_mismatch', 'double_counted'] }]);
  assert.match(item.reasonsText, /nie zgadza się/);
  assert.match(item.reasonsText, /policzona dwukrotnie/);
  assert.deepEqual(summarizeInconsistencies(undefined), []);
});

test('hasWriteAccess: tylko przydział bez klasy w odpowiednim roku', () => {
  assert.equal(hasWriteAccess([{ role: 'treasurer', schoolYearId: 'y1' }], 'y1'), true);
  assert.equal(hasWriteAccess([{ role: 'treasurer', classId: 'c1', schoolYearId: 'y1' }], 'y1'), false);
  assert.equal(hasWriteAccess([{ role: 'audit', schoolYearId: 'y1' }], 'y1'), false, 'KR tylko raport, nie zapis');
  assert.equal(hasWriteAccess(undefined), false);
});

test('describeApiError: komunikaty po polsku', () => {
  assert.match(describeApiError(401, 'unauthenticated'), /Zaloguj/);
  assert.match(describeApiError(403, 'mfa_required'), /MFA/);
  assert.match(describeApiError(403, 'four_eyes_required'), /inna osoba/);
  assert.match(describeApiError(403, 'forbidden'), /Nie masz uprawnień/);
  assert.equal(describeApiError(500, null), null);
});

// --- #105: import pliku CODA / CAMT.053 (dane wyłącznie syntetyczne) ---

const SYNTHETIC_CODA_HEAD = `0000030126005${' '.repeat(115)}`.slice(0, 128);

test('detectStatementFormat rozpoznaje CAMT.053 i CODA po treści, nie po nazwie', () => {
  assert.equal(detectStatementFormat('<?xml version="1.0"?><Document></Document>'), 'camt053');
  assert.equal(detectStatementFormat('\uFEFF  <Document/>'), 'camt053');
  assert.equal(detectStatementFormat(`${SYNTHETIC_CODA_HEAD}\n1${' '.repeat(127)}`), 'coda');
  assert.equal(detectStatementFormat('data;kwota;tytul\n2026-01-15;10,00;x'), null);
  assert.equal(detectStatementFormat(''), null);
  assert.equal(detectStatementFormat(null), null);
});

test('decodeStatementBytes: UTF-8 (także z BOM), a przy błędnym UTF-8 Windows-1252', () => {
  const utf8 = new TextEncoder().encode('\uFEFF<Ustrd>Zażółć</Ustrd>');
  assert.deepEqual(decodeStatementBytes(utf8), { text: '<Ustrd>Zażółć</Ustrd>', encoding: 'utf-8' });
  const latin1 = Uint8Array.from([0x4d, 0xe9, 0x72, 0x69, 0x65]); // „Mérie” w Windows-1252
  assert.deepEqual(decodeStatementBytes(latin1.buffer), { text: 'Mérie', encoding: 'windows-1252' });
});

test('statementFileProblem odrzuca brak pliku, pusty i za duży', () => {
  assert.match(statementFileProblem(null), /Wybierz plik/);
  assert.match(statementFileProblem({ size: 0 }), /pusty/);
  assert.match(statementFileProblem({ size: MAX_STATEMENT_FILE_BYTES + 1 }), /200 KB/);
  assert.equal(statementFileProblem({ size: 1024 }), '');
  assert.ok(MAX_STATEMENT_FILE_BYTES < 256 * 1024, 'zapas pod limit MAX_IMPORT_BYTES serwera');
});

test('buildStatementFileBody wysyła treść pod kluczem formatu, jak API', () => {
  assert.deepEqual(buildStatementFileBody('<Document/>', 'camt053'), { camt053: '<Document/>' });
  assert.deepEqual(buildStatementFileBody('0000', 'coda'), { coda: '0000' });
  assert.throws(() => buildStatementFileBody('x', 'csv'), /format pliku/);
  assert.throws(() => buildStatementFileBody('x', 'auto'), /format pliku/);
  assert.throws(() => buildStatementFileBody('  \n', 'coda'), /pusty/);
  assert.throws(() => buildStatementFileBody('a\u0000b', 'coda'), /binarne/);
  const source = readFileSync(new URL('../src/pg/routes/reconciliation.js', import.meta.url), 'utf8');
  assert.match(source, /\['lines', 'csv', 'coda', 'camt053'\]/);
});

test('summarizeStatementImport: liczby, pominięte duplikaty, salda w centach i ostrzeżenia', () => {
  const summary = summarizeStatementImport({
    import: { lineCount: 3 },
    skippedDuplicateCount: 2,
    fileBalances: { openingBalanceCents: 100_00, closingBalanceCents: 125_50 },
    warnings: ['closing_balance_mismatch', 'inne'],
  });
  assert.match(summary.text, /Wgrano 3 pozycji\./);
  assert.match(summary.text, /Pominięto 2 ruchów/);
  assert.match(summary.text, /początkowe 100,00/);
  assert.match(summary.text, /końcowe 125,50/);
  assert.equal(summary.warnings.length, 2);
  assert.match(summary.warnings[0], /Saldo początkowe plus ruchy/);
  const none = summarizeStatementImport({ import: null, lineCount: 0, skippedDuplicateCount: 4 });
  assert.match(none.text, /Nie wgrano nowych pozycji/);
  assert.deepEqual(describeImportWarnings(undefined), []);
});

test('describeStatementImportError podaje numer rekordu, nigdy treści', () => {
  const error = Object.assign(new Error('Nie udało się odczytać pliku wyciągu. Sprawdź format pliku.'), { data: { error: 'invalid_statement_file', record: 7 } });
  assert.match(describeStatementImportError(error), /rekord 7\)$/);
  assert.equal(describeStatementImportError(new Error('Błąd.')), 'Błąd.');
});

// Przegląd demo 4: kolumna „Źródło” pokazywała surowy kod „csv”.
test('lineSourceLabel: etykiety źródeł pozycji wyciągu zamiast surowych kodów', () => {
  assert.equal(lineSourceLabel('csv'), 'CSV');
  assert.equal(lineSourceLabel('manual'), 'Ręcznie');
  assert.equal(lineSourceLabel('coda'), 'CODA');
  assert.equal(lineSourceLabel('camt053'), 'CAMT.053');
  assert.equal(lineSourceLabel(null), '—');
  assert.equal(lineSourceLabel('inne'), 'inne');
  // każdy kod z CHECK bank_statement_imports.source (migracja 0089) ma etykietę
  const sql = readFileSync(new URL('../postgres/migrations/0089_bank_statement_formats.sql', import.meta.url), 'utf8');
  const codes = sql.match(/CHECK \(source IN \(([^)]*)\)\)/)[1].match(/'([a-z0-9]+)'/g).map((code) => code.slice(1, -1));
  assert.deepEqual(codes.filter((code) => lineSourceLabel(code) === code), []);
});

// --- #115: wpłata z pozycji, komunikacja strukturalna, zatwierdzanie wsadowe ---
import {
  MAX_BATCH_MATCHES,
  batchCandidates,
  buildBatchBody,
  buildLinePaymentBody,
  canCreatePaymentFromLine,
  describeBatchFailures,
  linePaymentUrl,
  lineStatusLabel,
  structuredHouseholdFor,
  summarizeBatchSelection,
} from '../reconciliation/core.js';
import { findForbiddenWording } from '../print/core.js';

test('#115 candidateLabel: propozycja nowej wpłaty dla rodziny i oznaczenie komunikacji strukturalnej', () => {
  const household = candidateLabel({
    type: 'household', id: 'h-1', householdId: 'h-1', amountCents: 2500, dayDistance: null, structuredReferenceMatch: true,
  });
  assert.match(household, /Nowa wpłata z tej pozycji/);
  assert.match(household, /rodzina h-1/);
  assert.match(household, /25,00/);
  assert.match(household, /komunikacja strukturalna zgodna/);
  const payment = candidateLabel({
    type: 'payment_entry', id: 'p1', date: '2026-09-14', amountCents: 2500, dayDistance: 0, structuredReferenceMatch: true,
  });
  assert.match(payment, /komunikacja strukturalna tej rodziny/);
  const plain = candidateLabel({ type: 'payment_entry', id: 'p2', date: '2026-09-14', amountCents: 2500, dayDistance: 0 });
  assert.doesNotMatch(plain, /komunikacja/);
});

test('#115 lineStatusLabel: pozycja bez powiązania jest „do wyjaśnienia”, nie „brak wpłaty”', () => {
  assert.equal(lineStatusLabel({ match: null, groupMatch: null }), 'Do wyjaśnienia');
  assert.equal(lineStatusLabel({ match: { id: 'm1' } }), 'Dopasowana');
  assert.equal(lineStatusLabel({ groupMatch: { id: 'g1', itemCount: 3 } }), 'Dopasowana zbiorczo (3 poz.)');
});

test('#115 canCreatePaymentFromLine: tylko wpływ bez powiązania, w szkicu, z prawem zapisu', () => {
  const open = { id: 'l1', amountCents: 2500, match: null, groupMatch: null };
  assert.equal(canCreatePaymentFromLine(open, { draft: true, canWrite: true }), true);
  assert.equal(canCreatePaymentFromLine(open, { draft: false, canWrite: true }), false);
  assert.equal(canCreatePaymentFromLine(open, { draft: true, canWrite: false }), false);
  assert.equal(canCreatePaymentFromLine({ ...open, amountCents: -2500 }, { draft: true, canWrite: true }), false);
  assert.equal(canCreatePaymentFromLine({ ...open, amountCents: 0 }, { draft: true, canWrite: true }), false);
  assert.equal(canCreatePaymentFromLine({ ...open, match: { id: 'm' } }, { draft: true, canWrite: true }), false);
  assert.equal(canCreatePaymentFromLine({ ...open, groupMatch: { id: 'g' } }, { draft: true, canWrite: true }), false);
});

test('#115 buildLinePaymentBody i linePaymentUrl: tylko rodzina, kwota i data nie są wysyłane', () => {
  assert.deepEqual(buildLinePaymentBody(''), { householdId: null });
  assert.deepEqual(buildLinePaymentBody('   '), { householdId: null });
  assert.deepEqual(buildLinePaymentBody(' h-1 '), { householdId: 'h-1' });
  assert.throws(() => buildLinePaymentBody('zła wartość'), /identyfikator rodziny/);
  assert.equal(linePaymentUrl('rec-1', 'line-1'), '/api/reconciliations/rec-1/lines/line-1/payment');
  assert.throws(() => linePaymentUrl('rec-1', '../x'), /pozycji/);
});

test('#115 structuredHouseholdFor: rodzina tylko z kandydata „household” danej pozycji', () => {
  const suggestions = [
    { statementLineId: 'l1', candidates: [{ type: 'payment_entry', id: 'p1', structuredReferenceMatch: true },
      { type: 'household', id: 'h-1', householdId: 'h-1', structuredReferenceMatch: true }] },
    { statementLineId: 'l2', candidates: [{ type: 'payment_entry', id: 'p2', structuredReferenceMatch: false }] },
  ];
  assert.equal(structuredHouseholdFor(suggestions, 'l1'), 'h-1');
  assert.equal(structuredHouseholdFor(suggestions, 'l2'), null);
  assert.equal(structuredHouseholdFor(suggestions, 'l3'), null);
  assert.equal(structuredHouseholdFor(undefined, 'l1'), null);
});

test('#115 batchCandidates: tylko pierwsza propozycja-wpłata z komunikacją lub tytułem, niejednoznaczne pominięte', () => {
  const suggestions = [
    { statementLineId: 'l1', bookedOn: '2026-09-14', amountCents: 2500,
      candidates: [{ type: 'payment_entry', id: 'p1', date: '2026-09-13', structuredReferenceMatch: true }] },
    { statementLineId: 'l2', bookedOn: '2026-09-15', amountCents: 1000,
      candidates: [{ type: 'payment_entry', id: 'p2', date: '2026-09-15', referenceMatch: true }] },
    // Bez żadnej zgodności — tylko kwota i data: nie trafia do wsadu.
    { statementLineId: 'l3', bookedOn: '2026-09-15', amountCents: 2000,
      candidates: [{ type: 'payment_entry', id: 'p3', date: '2026-09-15' }] },
    // Wpis księgi i propozycja nowej wpłaty zatwierdza się pojedynczo.
    { statementLineId: 'l4', bookedOn: '2026-09-16', amountCents: 2000,
      candidates: [{ type: 'ledger_entry', id: 'le1', date: '2026-09-16', referenceMatch: true }] },
    { statementLineId: 'l5', bookedOn: '2026-09-16', amountCents: 2000,
      candidates: [{ type: 'household', id: 'h-1', householdId: 'h-1', structuredReferenceMatch: true }] },
    // Ta sama wpłata jako pierwsza propozycja dwóch pozycji — obie pominięte.
    { statementLineId: 'l6', bookedOn: '2026-09-17', amountCents: 1500,
      candidates: [{ type: 'payment_entry', id: 'p6', date: '2026-09-17', referenceMatch: true }] },
    { statementLineId: 'l7', bookedOn: '2026-09-17', amountCents: 1500,
      candidates: [{ type: 'payment_entry', id: 'p6', date: '2026-09-17', referenceMatch: true }] },
    { statementLineId: 'l8', bookedOn: '2026-09-18', amountCents: 1500, candidates: [] },
  ];
  const rows = batchCandidates(suggestions);
  assert.deepEqual(rows.map((row) => [row.statementLineId, row.paymentEntryId, row.reason]), [
    ['l1', 'p1', 'komunikacja strukturalna tej rodziny'],
    ['l2', 'p2', 'tytuł zgodny'],
  ]);
  assert.deepEqual(batchCandidates(null), []);
});

test('#115 buildBatchBody: wyłącznie jawnie zaznaczone pary, 1…MAX_BATCH_MATCHES', () => {
  assert.deepEqual(buildBatchBody([{ statementLineId: 'l1', paymentEntryId: 'p1', amountCents: 2500, reason: 'x' }]),
    { matches: [{ statementLineId: 'l1', paymentEntryId: 'p1' }] });
  assert.throws(() => buildBatchBody([]), /co najmniej jedną/);
  const many = Array.from({ length: MAX_BATCH_MATCHES + 1 }, (_, i) => ({ statementLineId: `l${i}`, paymentEntryId: `p${i}` }));
  assert.throws(() => buildBatchBody(many), /najwyżej 50/);
  const source = readFileSync(new URL('../src/pg/routes/reconciliation.js', import.meta.url), 'utf8');
  assert.equal(Number(source.match(/const MAX_BATCH_MATCHES = (\d+);/)[1]), MAX_BATCH_MATCHES);
});

test('#115 summarizeBatchSelection i describeBatchFailures: suma w EUR i opis per pozycja', () => {
  const rows = [
    { statementLineId: 'l1', paymentEntryId: 'p1', bookedOn: '2026-09-14', amountCents: 2500 },
    { statementLineId: 'l2', paymentEntryId: 'p2', bookedOn: '2026-09-15', amountCents: 1001 },
  ];
  const summary = summarizeBatchSelection(rows);
  assert.match(summary, /2 par/);
  assert.match(summary, /35,01/);
  assert.match(summarizeBatchSelection(rows.slice(0, 1)), /1 parę/);
  const [failure, unknown] = describeBatchFailures(
    [{ statementLineId: 'l2', paymentEntryId: 'p2', error: 'match_amount_mismatch' },
      { statementLineId: 'lx', paymentEntryId: 'px', error: 'already_matched' }],
    rows, { match_amount_mismatch: 'Kwoty się różnią.' },
  );
  assert.equal(failure, `Pozycja 2026-09-15, ${formatCents(1001)}: Kwoty się różnią.`);
  assert.match(unknown, /^Pozycja lx: already_matched$/);
  assert.deepEqual(describeBatchFailures(undefined), []);
});

test('#115 panel uzgodnień nie używa sformułowań o zadłużeniu i nie mówi o „braku wpłaty”', () => {
  for (const file of ['../reconciliation/index.html', '../reconciliation/main.js', '../reconciliation/core.js']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.equal(findForbiddenWording(text), null, file);
    assert.doesNotMatch(text, /brak wpłaty|nie zapłacił|niezapłacon/i, file);
  }
});
