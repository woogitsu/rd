// #184 pkt 6: kontrola pozytywna detektora pokrycia wierszy audytem
// (tests/helpers/audit-row-coverage.js, używany w tests/pg-authz-matrix.test.js).
// Detektor jest czystą funkcją wierszy i zdarzeń; migawkę sprawdza mały PGlite bez
// migracji (dwie tabele). Dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import {
  AUDIT_ROW_PARENTS, AUDIT_ROW_ROUTE_EXEMPT, AUDIT_ROW_TECHNICAL, AUDIT_ROW_UPDATE_SOURCES, AUDIT_ROW_VOLATILE_COLUMNS,
  changedRows, newRows, rowCoverageProblems, rowIdSnapshot,
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

test('zmieniony i usunięty wiersz bez zdarzenia jest wykrywany; źródło zmiany działa tylko dla zmiany', () => {
  const updated = [{ table: 'payment_entries', row: { id: 'pay-syn-9' }, kind: 'updated' }];
  const problems = rowCoverageProblems('payments.nowa', updated, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /zmieniony wiersz payment_entries \(id pay-syn-9\)/);
  // Trigger przypisania: zdarzenie o przypisaniu niesie metadata.paymentEntryId.
  const assigned = { ...event('payment.assigned', 'payment_assignment', 'pa-syn-1'), metadata_json: { paymentEntryId: 'pay-syn-9' } };
  assert.deepEqual(rowCoverageProblems('payments.assignment', updated, [assigned]), []);
  assert.equal(rowCoverageProblems('payments.assignment', updated, [{ ...assigned, metadata_json: { paymentEntryId: 'pay-syn-8' } }]).length, 1);
  // Źródło zmiany nie zwalnia TWORZENIA wiersza: nowa wpłata potrzebuje własnego zdarzenia.
  const created = [{ table: 'payment_entries', row: { id: 'pay-syn-9' }, kind: 'created' }];
  assert.equal(rowCoverageProblems('payments.nowa', created, [assigned]).length, 1);
  // Usunięcie: zdarzenie musi wskazywać usunięty wiersz.
  const deleted = [{ table: 'news_posts', row: { id: 'np-syn-1' }, kind: 'deleted' }];
  assert.match(rowCoverageProblems('news.nowa', deleted, [])[0], /usunięty wiersz news_posts/);
  assert.deepEqual(rowCoverageProblems('news.nowa', deleted, [event('news_post.deleted', 'news_post', 'np-syn-1')]), []);
  // Klucz obiektu nadrzędnego dla zmiany (kolejność punktów → zebranie).
  const agenda = [{ table: 'meeting_agenda_items', row: { id: 'mai-1', meeting_id: 'mt-1' }, kind: 'updated' }];
  assert.deepEqual(rowCoverageProblems('meetings.agendaOrder', agenda, [event('meeting.agenda.reordered', 'meeting', 'mt-1')]), []);
  assert.equal(rowCoverageProblems('meetings.agendaOrder', agenda, [event('meeting.agenda.reordered', 'meeting', 'mt-2')]).length, 1);
});

test('migawka wierszy wykrywa zmianę treści i usunięcie, a pomija kolumny techniczne (PGlite bez migracji)', async () => {
  const db = new PGlite();
  try {
    // Tabela o nazwie z AUDIT_ROW_VOLATILE_COLUMNS (sessions.last_seen_at) i zwykła tabela.
    await db.exec(`CREATE TABLE sessions (id text PRIMARY KEY, revoked_at text, last_seen_at text);
      CREATE TABLE notes_syn (id text PRIMARY KEY, body text);
      INSERT INTO sessions VALUES ('s-1', NULL, 'a'), ('s-2', NULL, 'a');
      INSERT INTO notes_syn VALUES ('n-1', 'x'), ('n-2', 'y');`);
    const tables = ['sessions', 'notes_syn'];
    const before = await rowIdSnapshot(db, tables);
    await db.exec(`UPDATE sessions SET last_seen_at = 'b';
      UPDATE sessions SET revoked_at = 'now' WHERE id = 's-2';
      UPDATE notes_syn SET body = 'z' WHERE id = 'n-1';
      DELETE FROM notes_syn WHERE id = 'n-2';
      INSERT INTO notes_syn VALUES ('n-3', 'w');`);
    const after = await rowIdSnapshot(db, tables);
    const created = await newRows(db, before, after);
    assert.deepEqual(created.map(({ table, row, kind }) => [table, row.id, kind]), [['notes_syn', 'n-3', 'created']]);
    const changed = await changedRows(db, before, after);
    assert.deepEqual(
      changed.map(({ table, row, kind }) => `${kind}:${table}:${row.id}`).sort(),
      ['deleted:notes_syn:n-2', 'updated:notes_syn:n-1', 'updated:sessions:s-2'],
      'sam last_seen_at (s-1) nie jest zmianą biznesową',
    );
    assert.ok(AUDIT_ROW_VOLATILE_COLUMNS.get('sessions').columns.includes('last_seen_at'));
  } finally {
    await db.close();
  }
});

test('źródła zmian i kolumny pomijane są opisane i nie dublują listy technicznej', () => {
  for (const [table, entry] of AUDIT_ROW_UPDATE_SOURCES) {
    assert.ok(!AUDIT_ROW_TECHNICAL.has(table), table);
    assert.ok(entry.why.length >= 30, table);
  }
  for (const [table, entry] of AUDIT_ROW_VOLATILE_COLUMNS) {
    assert.ok(entry.columns.length > 0 && !entry.columns.includes('id'), table);
    assert.ok(entry.why.length >= 30, table);
  }
});
