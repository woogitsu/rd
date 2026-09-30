// #184 pkt 6: kontrola pozytywna detektora pokrycia wierszy audytem
// (tests/helpers/audit-row-coverage.js, używany w tests/pg-authz-matrix.test.js).
// Bez bazy: detektor jest czystą funkcją nowych wierszy i zdarzeń. Dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIT_ROW_PARENTS, AUDIT_ROW_ROUTE_EXEMPT, AUDIT_ROW_TECHNICAL, rowCoverageProblems,
} from './helpers/audit-row-coverage.js';

const event = (action, entityType, entityId) => ({ action, entity_type: entityType, entity_id: entityId });

test('nowa trasa zapisu bez zdarzenia jest wykrywana (wpłata bez payment.created)', () => {
  const rows = [{ table: 'payment_entries', row: { id: 'pay-syn-1' } }];
  const problems = rowCoverageProblems('payments.nowa', rows, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /payment_entries \(id pay-syn-1\)/);
  // Zdarzenie o innym obiekcie nie wystarcza.
  assert.equal(rowCoverageProblems('payments.nowa', rows, [event('payment.created', 'payment_entry', 'pay-syn-2')]).length, 1);
  assert.deepEqual(rowCoverageProblems('payments.nowa', rows, [event('payment.created', 'payment_entry', 'pay-syn-1')]), []);
});

test('wiersz podrzędny przechodzi tylko ze zdarzeniem wskazującym obiekt nadrzędny', () => {
  const rows = [{ table: 'document_status_events', row: { id: 'dse-syn-1', document_id: 'doc-syn-1' } }];
  assert.deepEqual(rowCoverageProblems('documents.voidFinancial', rows, [event('document.voided', 'document', 'doc-syn-1')]), []);
  const wrong = rowCoverageProblems('documents.voidFinancial', rows, [event('document.voided', 'document', 'doc-syn-2')]);
  assert.equal(wrong.length, 1);
  assert.match(wrong[0], /ani obiekt nadrzędny/);
  // Klucz złożony (uczeń:opiekun).
  const relation = [{ table: 'student_guardian_changes', row: { id: 'sgc-1', student_id: 'st-1', guardian_id: 'g-1' } }];
  assert.deepEqual(rowCoverageProblems('families.relationEnd', relation, [event('student_guardian.ended', 'student_guardian', 'st-1:g-1')]), []);
  // Klucz metadanych: storno przy zastąpieniu wpisu księgi.
  const storno = [{ table: 'ledger_corrections', row: { id: 'lc-syn-1', ledger_entry_id: 'le-old' } }];
  const replaced = (correctionId) => ({ ...event('ledger.entry.replaced', 'ledger_entry', 'le-new'), metadata_json: { correctionId } });
  assert.deepEqual(rowCoverageProblems('ledger.replacement', storno, [replaced('lc-syn-1')]), []);
  assert.equal(rowCoverageProblems('ledger.replacement', storno, [replaced('lc-syn-2')]).length, 1);
  // Gospodarstwo spoza importu (import_batch_id = null) potrzebuje własnego zdarzenia.
  const household = [{ table: 'households', row: { id: 'hh-syn-1', import_batch_id: null } }];
  assert.equal(rowCoverageProblems('families.nowa', household, [event('x.y', 'import_batch', 'null')]).length, 1);
});

test('tabela techniczna i zwolnienie trasa+tabela nie zgłaszają problemu; zwolnienie nie działa dla innej trasy', () => {
  assert.deepEqual(rowCoverageProblems('email.webhook', [{ table: 'email_webhook_events', row: { id: 'wh-1' } }], []), []);
  const enrollment = [{ table: 'enrollments', row: { id: 'en-syn-1' } }];
  assert.deepEqual(rowCoverageProblems('import.commit', enrollment, [event('import.committed', 'import_batch', 'ib-1')]), []);
  assert.equal(rowCoverageProblems('families.nowa', enrollment, []).length, 1);
});

test('listy wyjątków są rozłączne i opisane', () => {
  for (const table of AUDIT_ROW_PARENTS.keys()) assert.ok(!AUDIT_ROW_TECHNICAL.has(table), table);
  for (const [, entry] of AUDIT_ROW_ROUTE_EXEMPT) {
    for (const table of entry.tables) {
      // Tabela z obiektem nadrzędnym może mieć zwolnienie dla jednej trasy (import bez klucza
      // nadrzędnego); tabela techniczna już jest pominięta wszędzie.
      assert.ok(!AUDIT_ROW_TECHNICAL.has(table), `${table}: zwolnienie trasy dubluje listę techniczną`);
    }
  }
});
