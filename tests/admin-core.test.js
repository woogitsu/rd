import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGrantsUrl, confirmationText, dateToExpiresAt, describeAuditEvent, errorMessage, grantPayload,
  indexClasses, invitationLink, invitationPayload, isOwnLastAdminGrant, scopeLabel,
} from '../admin/core.js';

const NOW = new Date('2026-09-27T10:00:00Z');

test('buildGrantsUrl encodes filters and rejects unknown values', () => {
  assert.equal(buildGrantsUrl(), '/api/admin/grants?status=active');
  assert.equal(
    buildGrantsUrl({ userId: 'u-1', role: 'representative', schoolYearId: 'y-2026', classId: 'c-1a', status: 'all' }),
    '/api/admin/grants?userId=u-1&role=representative&schoolYearId=y-2026&classId=c-1a&status=all',
  );
  assert.throws(() => buildGrantsUrl({ role: 'root' }), /Nieznana rola/);
  assert.throws(() => buildGrantsUrl({ status: 'deleted' }), /Nieznany status/);
  assert.throws(() => buildGrantsUrl({ classId: 'bad id' }), /klasy/);
});

test('grantPayload requires class for representative and a future expiry', () => {
  assert.throws(() => grantPayload({ userId: 'u-1', role: 'representative' }, NOW), /klasy/);
  assert.throws(() => grantPayload({ userId: '', role: 'board' }, NOW), /konto/);
  assert.throws(() => grantPayload({ userId: 'u-1', role: 'owner' }, NOW), /rolę/);
  assert.throws(() => grantPayload({ userId: 'u-1', role: 'board', expiresOn: '2026-09-01' }, NOW), /przyszłości/);
  assert.deepEqual(grantPayload({ userId: ' u-1 ', role: 'representative', classId: 'c-1a', schoolYearId: '', expiresOn: '2027-08-31' }, NOW), {
    userId: 'u-1', role: 'representative', classId: 'c-1a', expiresAt: '2027-09-01T00:00:00.000Z',
  });
  assert.equal(dateToExpiresAt('', NOW), null);
  assert.throws(() => dateToExpiresAt('2027-02-30', NOW), /Niepoprawna/);
});

test('invitationPayload normalises e-mail and validates ttl', () => {
  assert.deepEqual(invitationPayload({ email: ' Rep@Example.INVALID ', role: 'board', ttlHours: '48' }), {
    email: 'rep@example.invalid', role: 'board', ttlHours: 48,
  });
  assert.throws(() => invitationPayload({ email: 'nope', role: 'board' }), /e-mail/);
  assert.throws(() => invitationPayload({ email: 'a@example.invalid', role: 'representative' }), /klasy/);
  assert.throws(() => invitationPayload({ email: 'a@example.invalid', role: 'board', ttlHours: '1000' }), /336/);
});

test('invitationLink (#164): gotowy link do widoku przyjęcia, token wyłącznie w części „#”', () => {
  const link = invitationLink('A'.repeat(43), 'https://rd.example.invalid');
  assert.equal(link, `https://rd.example.invalid/login/#invite=${'A'.repeat(43)}`);
  assert.doesNotMatch(link, /\?/, 'token nie trafia do części zapytania (nie idzie do logów serwera)');
});

test('isOwnLastAdminGrant mirrors the server lockout rule', () => {
  const grants = [
    { id: 'g1', userId: 'me', role: 'admin', status: 'active' },
    { id: 'g2', userId: 'me', role: 'admin', status: 'revoked' },
    { id: 'g3', userId: 'other', role: 'admin', status: 'active' },
  ];
  assert.equal(isOwnLastAdminGrant(grants, 'me', 'g1'), true);
  assert.equal(isOwnLastAdminGrant(grants, 'me', 'g3'), false);
  assert.equal(isOwnLastAdminGrant([...grants, { id: 'g4', userId: 'me', role: 'admin', status: 'active' }], 'me', 'g1'), false);
});

test('labels, scope and audit descriptions are Polish and contain identifiers only', () => {
  const years = [{ id: 'y-2026', label: '2026/27', classes: [{ id: 'c-1a', name: '1A' }] }];
  const classes = indexClasses(years);
  const yearMap = new Map(years.map((year) => [year.id, year]));
  assert.equal(scopeLabel({ classId: 'c-1a', schoolYearId: 'y-2026' }, classes, yearMap), 'klasa 1A, rok 2026/27');
  assert.equal(scopeLabel({}, classes, yearMap), 'cała Rada');
  assert.equal(errorMessage('last_admin_grant'), 'Nie można odebrać sobie ostatniego aktywnego przydziału administratora.');
  assert.match(errorMessage('cannot_grant_self'), /Nie można nadać roli własnemu kontu/);
  assert.match(errorMessage(undefined, 503), /niedostępna/);
  assert.match(errorMessage('weird', 400), /weird/);
  assert.match(confirmationText('disable', 'u-1'), /sesje zostaną wycofane/);
  const described = describeAuditEvent({ action: 'role_grant.expired', metadata: { role: 'board', userId: 'u-1', schoolYearId: 'y-2026', reason: 'term_closed' } });
  assert.equal(described.label, 'Wygaszenie roli');
  assert.equal(described.details, 'Zarząd, konto u-1, rok y-2026, powód: term_closed');
});
