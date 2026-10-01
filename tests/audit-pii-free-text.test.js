// #184 pkt 3: metadane audytu nie mogą nieść pól wolnego tekstu (powód korekty,
// notatka, tytuł, treść, opis, autor, komentarz) — taki tekst należy do tabeli
// biznesowej, nie do dziennika. Odrzucenie jest po nazwie klucza, więc
// zadziała także dla wartości, która nie wygląda jak e-mail ani imię.
// Dane wyłącznie syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoPii, insertAuditEvent } from '../src/pg/audit.js';
import { createTestDb } from './helpers/pg.js';

const FREE_TEXT_KEYS = ['note', 'notes', 'title', 'body', 'description', 'subject', 'author', 'comment', 'message', 'content', 'text'];

test('assertNoPii rejects every free-text key, also nested and in other letter case', () => {
  assert.ok(FREE_TEXT_KEYS.length > 0);
  for (const key of FREE_TEXT_KEYS) {
    assert.throws(() => assertNoPii({ [key]: 'ok' }), /audit_metadata_pii/, key);
    assert.throws(() => assertNoPii({ nested: { items: [{ [key.toUpperCase()]: 'ok' }] } }), /audit_metadata_pii/, key);
  }
  assert.throws(() => assertNoPii({ correction_note: 'x' }), /audit_metadata_pii/);
  assert.throws(() => assertNoPii({ correctionComment: 'x' }), /audit_metadata_pii/);
});

test('assertNoPii accepts a counter under a table name that ends in a free-text word', () => {
  assert.doesNotThrow(() => assertNoPii({ rowCounts: { audit_review_notes: 3, document_descriptions: 0 } }));
  assert.throws(() => assertNoPii({ rowCounts: { audit_review_notes: 'trzy' } }), /audit_metadata_pii/);
});

test('assertNoPii still accepts identifiers, counters and code fields', () => {
  assert.doesNotThrow(() => assertNoPii({
    schoolYearId: 'y-test', count: 3, contentHash: 'abc123', category: 'event', subjectType: 'guardian', reason: 'user_disabled',
  }));
});

test('insertAuditEvent refuses a free-text key and writes nothing', async () => {
  const db = await createTestDb();
  try {
    await assert.rejects(
      insertAuditEvent(db, { actorId: null, action: 'user.disabled', entityType: 'user', entityId: 'u-1', metadata: { note: 'bez znaczenia' } }),
      /audit_metadata_pii/,
    );
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM audit_events WHERE entity_id = 'u-1'`);
    assert.equal(rows[0].n, 0);
  } finally { await db.close(); }
});
