// Testy czystych funkcji ekranu uzgodnienia wyciągu bankowego (issue #147, część 2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  WRITE_ROLES,
  auditReportUrl,
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
