import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_ENTITY_TYPES, entityHistoryPath, historyRoute, historyActorText, historyOutcome, historyRows, historyTimeText,
} from '../shared/entity-history-core.js';
import { auditActionLabel } from '../shared/audit-actions.js';

const ID = '3f1c9a52-aaaa-bbbb-cccc-0123456789ab';

test('#181: ścieżka historii dla trzech typów obiektów, z kodowaniem id', () => {
  assert.deepEqual([...HISTORY_ENTITY_TYPES], ['payment_entry', 'ledger_entry', 'email_campaign']);
  assert.equal(entityHistoryPath('payment_entry', ID), `/api/admin/audit/entity/payment_entry/${ID}`);
  assert.equal(entityHistoryPath('email_campaign', ` ${ID} `), `/api/admin/audit/entity/email_campaign/${ID}`);
  assert.throws(() => entityHistoryPath('reconciliation', ID), /typ obiektu/);
  assert.throws(() => entityHistoryPath('ledger_entry', '../x'), /identyfikator/);
  assert.throws(() => entityHistoryPath('ledger_entry', ''), /identyfikator/);
  assert.throws(() => entityHistoryPath('ledger_entry', undefined), /identyfikator/);
});

test('#181: autor — actorId skrócony, actorKind/source opcjonalne (PR #622)', () => {
  assert.equal(historyActorText({ actorId: ID }), '3f1c9a52…');
  assert.equal(historyActorText({ actorId: null }), 'System');
  assert.equal(historyActorText({}), 'System');
  assert.equal(historyActorText({ actorId: null, actorKind: 'system', source: 'email_worker' }), 'Zadanie wysyłki e-mail');
  assert.equal(historyActorText({ actorId: null, actorKind: 'system', source: 'brevo_webhook' }), 'Webhook dostawcy e-mail');
  assert.equal(historyActorText({ actorId: null, actorKind: 'system', source: 'nieznane' }), 'System');
  assert.equal(historyActorText({ actorId: null, actorKind: 'anonymous', source: 'login' }), 'Logowanie');
  assert.equal(historyActorText({ actorId: null, actorKind: 'anonymous' }), 'Osoba niezalogowana');
  assert.equal(historyActorText({ actorId: ID, actorKind: 'user' }), '3f1c9a52…');
  assert.equal(historyActorText(null), 'System');
});

test('#181: czas w strefie Europe/Warsaw, błędna data to myślnik', () => {
  assert.equal(historyTimeText('2026-09-27T10:05:00Z'), '27.09.2026 12:05');
  assert.equal(historyTimeText('2026-01-05T10:05:00Z'), '05.01.2026 11:05');
  assert.equal(historyTimeText('nie data'), '—');
  assert.equal(historyTimeText(undefined), '—');
});

test('#181: wiersze od najstarszego, etykieta z katalogu, nieznana akcja pod nazwą, stabilna kolejność', () => {
  const events = [
    { id: 'e3', action: 'payment.assigned', occurredAt: '2026-09-27T10:00:00Z', actorId: ID },
    { id: 'e1', action: 'payment.created', occurredAt: '2026-09-26T10:00:00Z', actorId: ID },
    { id: 'e2', action: 'payment.correction.created', occurredAt: '2026-09-27T10:00:00Z', actorId: null },
    { id: 'e4', action: 'cos.nowego', occurredAt: '2026-09-28T10:00:00Z' },
  ];
  const rows = historyRows(events);
  assert.deepEqual(rows.map((row) => row.id), ['e1', 'e3', 'e2', 'e4']);
  assert.equal(rows[0].label, auditActionLabel('payment.created'));
  assert.ok(rows[0].label && rows[0].label !== 'payment.created');
  assert.equal(rows[3].label, 'cos.nowego');
  assert.equal(rows[0].actorTitle, ID);
  assert.equal(rows[2].actor, 'System');
  assert.equal(rows[2].actorTitle, '');
  assert.deepEqual(historyRows(undefined), []);
  assert.deepEqual(historyRows([]), []);
});

test('#181: trasa wg roli — admin, zarząd/skarbnik, reszta bez trasy', () => {
  const g = (...roles) => roles.map((role) => ({ role }));
  assert.equal(historyRoute(g('admin')), 'admin');
  assert.equal(historyRoute(g('board', 'admin')), 'admin');
  assert.equal(historyRoute(g('board')), 'board');
  assert.equal(historyRoute(g('treasurer')), 'board');
  assert.equal(historyRoute(g('representative', 'treasurer')), 'board');
  for (const role of ['audit', 'principal', 'representative']) assert.equal(historyRoute(g(role)), null);
  assert.equal(historyRoute([]), null);
  assert.equal(historyRoute(undefined), null);
  assert.equal(historyRoute([null, {}]), null);
  assert.equal(entityHistoryPath('payment_entry', ID, 'board'), `/api/audit/entity/payment_entry/${ID}`);
  assert.equal(entityHistoryPath('ledger_entry', ID, 'admin'), `/api/admin/audit/entity/ledger_entry/${ID}`);
  assert.throws(() => entityHistoryPath('ledger_entry', ID, null), /trasy/);
  assert.throws(() => entityHistoryPath('ledger_entry', ID, 'constructor'), /trasy/);
});

test('#181: 404 ukrywa sekcję, 403 daje komunikat, inne błędy neutralny napis', () => {
  assert.equal(historyOutcome(null), 'shown');
  assert.equal(historyOutcome({ status: 403 }), 'forbidden');
  assert.equal(historyOutcome({ status: 404 }), 'hidden');
  assert.equal(historyOutcome({ status: 500 }), 'unavailable');
  assert.equal(historyOutcome({ status: 0, network: true }), 'unavailable');
});
