import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  KIND_LABELS, STATUS_LABELS, canExport, createBody, dataRequestsPath, dueState, exportBlocker, exportConfirmation,
  exportFileName, isClosed, listSummary, newRequestKey, nextStatuses, omittedNote, statusBody, statusConfirmation, subjectOf,
} from '../admin/data-requests.js';

test('słowniki rodzajów i stanów zgadzają się z trasami serwera', () => {
  const source = readFileSync(new URL('../src/pg/routes/admin.js', import.meta.url), 'utf8');
  const kinds = /DATA_REQUEST_KINDS = new Set\(\[([^\]]+)\]\)/.exec(source)[1].match(/'([a-z_]+)'/g).map((v) => v.slice(1, -1));
  const statuses = /DATA_REQUEST_STATUSES = \[([^\]]+)\]/.exec(source)[1].match(/'([a-z_]+)'/g).map((v) => v.slice(1, -1));
  assert.deepEqual(Object.keys(KIND_LABELS).sort(), [...kinds].sort());
  assert.deepEqual(Object.keys(STATUS_LABELS).sort(), [...statuses].sort());
});

test('dataRequestsPath: filtry i kursor, nieznane wartości odrzucone', () => {
  assert.equal(dataRequestsPath(), '/api/admin/data-requests');
  assert.equal(dataRequestsPath({ status: 'received', kind: 'access' }), '/api/admin/data-requests?status=received&kind=access');
  assert.equal(dataRequestsPath({ cursor: 'a b' }), '/api/admin/data-requests?cursor=a+b');
  assert.throws(() => dataRequestsPath({ status: 'x' }), /stan/);
  assert.throws(() => dataRequestsPath({ kind: 'x' }), /rodzaj/);
});

test('createBody: jeden podmiot, daty i walidacja', () => {
  const base = { kind: 'access', subjectType: 'household', subjectId: 'h-1', receivedOn: '2026-09-01' };
  assert.deepEqual(createBody(base), { kind: 'access', receivedOn: '2026-09-01', householdId: 'h-1' });
  assert.deepEqual(createBody({ ...base, subjectType: 'guardian', subjectId: ' g-2 ', dueOn: '2026-10-01' }),
    { kind: 'access', receivedOn: '2026-09-01', dueOn: '2026-10-01', guardianId: 'g-2' });
  assert.deepEqual(createBody({ ...base, subjectType: 'student' }).studentId, 'h-1');
  assert.throws(() => createBody({ ...base, kind: 'x' }), /rodzaj/);
  assert.throws(() => createBody({ ...base, subjectType: 'x' }), /czego dotyczy/);
  assert.throws(() => createBody({ ...base, subjectId: '' }), /identyfikator/);
  assert.throws(() => createBody({ ...base, subjectId: 'jan kowalski@example.invalid' }), /Niepoprawny identyfikator/);
  assert.throws(() => createBody({ ...base, receivedOn: '2026-02-30' }), /wpłynięcia/);
  assert.throws(() => createBody({ ...base, dueOn: 'jutro' }), /terminu/);
  assert.throws(() => createBody({ ...base, dueOn: '2026-08-31' }), /wcześniejszy/);
});

test('newRequestKey: unikalny klucz na wypełnienie formularza', () => {
  assert.equal(newRequestKey(() => 'abc'), 'dsr-abc');
  assert.notEqual(newRequestKey(), newRequestKey());
});

test('subjectOf: pierwszeństwo gospodarstwo, opiekun, uczeń', () => {
  assert.deepEqual(subjectOf({ householdId: 'h', guardianId: 'g' }), { type: 'household', id: 'h' });
  assert.deepEqual(subjectOf({ guardianId: 'g' }), { type: 'guardian', id: 'g' });
  assert.deepEqual(subjectOf({ studentId: 's' }), { type: 'student', id: 's' });
  assert.deepEqual(subjectOf({}), { type: null, id: null });
});

test('nextStatuses: tylko do przodu, zamknięte bez przejść', () => {
  assert.deepEqual(nextStatuses({ status: 'received' }), ['identity_verified', 'in_progress', 'answered', 'rejected']);
  assert.deepEqual(nextStatuses({ status: 'in_progress' }), ['answered', 'rejected']);
  assert.deepEqual(nextStatuses({ status: 'answered' }), []);
  assert.deepEqual(nextStatuses({ status: 'rejected' }), []);
  assert.deepEqual(nextStatuses({ status: 'nieznany' }), []);
  assert.equal(isClosed({ status: 'rejected' }), true);
  assert.equal(isClosed({ status: 'received' }), false);
});

test('statusBody: zamknięcie wymaga odwołania, długość ograniczona', () => {
  assert.deepEqual(statusBody('identity_verified'), { status: 'identity_verified' });
  assert.deepEqual(statusBody('identity_verified', ' nr 5 '), { status: 'identity_verified', decisionNoteRef: 'nr 5' });
  assert.deepEqual(statusBody('answered', 'teczka 12/2026'), { status: 'answered', decisionNoteRef: 'teczka 12/2026' });
  assert.throws(() => statusBody('answered'), /odwołania/);
  assert.throws(() => statusBody('rejected', '  '), /odwołania/);
  assert.throws(() => statusBody('x'), /Wybierz/);
  assert.throws(() => statusBody('received', 'a'.repeat(201)), /200/);
});

test('statusConfirmation: zamknięcie ostrzega o eksporcie', () => {
  const request = { id: 'r-1', status: 'in_progress' };
  const closing = statusConfirmation(request, 'answered');
  assert.equal(closing.destructive, true);
  assert.ok(closing.effects.some((line) => line && line.includes('eksport')));
  const open = statusConfirmation({ id: 'r-1', status: 'received' }, 'identity_verified');
  assert.equal(open.destructive, false);
  assert.equal(open.effects.filter(Boolean).length, 2);
});

test('eksport: dostępny tylko dla access/portability w stanie identity_verified lub in_progress', () => {
  const ok = (kind, status) => canExport({ kind, status });
  assert.equal(ok('access', 'identity_verified'), true);
  assert.equal(ok('portability', 'in_progress'), true);
  assert.equal(ok('access', 'received'), false);
  assert.equal(ok('access', 'answered'), false);
  assert.equal(ok('access', 'rejected'), false);
  for (const kind of ['rectification', 'erasure', 'restriction', 'objection']) assert.equal(ok(kind, 'identity_verified'), false, kind);
  assert.match(exportBlocker({ kind: 'erasure', status: 'in_progress' }), /dostępu albo przenoszenia/);
  assert.match(exportBlocker({ kind: 'access', status: 'received' }), /tożsamość/);
  assert.match(exportBlocker({ kind: 'access', status: 'answered' }), /zamknięte/);
  assert.equal(exportBlocker({ kind: 'access', status: 'in_progress' }), '');
});

test('exportConfirmation: ostrzega o danych osobowych i śladzie, bez danych osobowych w treści', () => {
  const dialog = exportConfirmation({ id: 'r-1' }, 'csv');
  assert.equal(dialog.confirmLabel, 'Pobierz CSV');
  assert.equal(dialog.destructive, true);
  const text = dialog.effects.join(' ');
  assert.match(text, /dane osobowe/);
  assert.match(text, /dzienniku/);
  assert.match(text, /MFA/);
});

test('exportFileName: bezpieczna nazwa z nagłówka albo zapasowa', () => {
  assert.equal(exportFileName('attachment; filename="rd-dane-rodziny-r_1-v1.json"', 'r-1', 'json'), 'rd-dane-rodziny-r_1-v1.json');
  assert.equal(exportFileName('attachment; filename="../../etc"', 'r-1', 'csv'), 'rd-dane-rodziny-r-1.csv');
  assert.equal(exportFileName(null, 'a/b', 'json'), 'rd-dane-rodziny-a_b.json');
});

test('omittedNote: tylko liczby pominiętych osób trzecich', () => {
  const headers = (g, h) => ({ get: (name) => ({ 'X-Data-Export-Omitted-Guardians': g, 'X-Data-Export-Omitted-Households': h })[name] ?? null });
  assert.equal(omittedNote(headers('0', '0')), '');
  assert.equal(omittedNote({ get: () => null }), '');
  assert.match(omittedNote(headers('2', '1')), /opiekunów 2, gospodarstw 1/);
  assert.equal(omittedNote(undefined), '');
});

test('dueState: po terminie tylko dla otwartych żądań', () => {
  assert.equal(dueState({ dueOn: '2026-09-01', status: 'received' }, '2026-09-02'), 'overdue');
  assert.equal(dueState({ dueOn: '2026-09-02', status: 'received' }, '2026-09-02'), 'open');
  assert.equal(dueState({ dueOn: '2026-09-01T00:00:00.000Z', status: 'in_progress' }, '2026-09-02'), 'overdue');
  assert.equal(dueState({ dueOn: '2026-09-01', status: 'answered' }, '2026-09-02'), 'none');
  assert.equal(dueState({ dueOn: null, status: 'received' }, '2026-09-02'), 'none');
});

test('listSummary: informuje o niepełnej liście', () => {
  assert.equal(listSummary(3, false), 'Żądań w widoku: 3.');
  assert.match(listSummary(3, true), /niepełna/);
});
