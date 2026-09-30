import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGrantsUrl, confirmationDialog, confirmationText, dateToExpiresAt, describeAuditEvent, errorMessage, grantPayload,
  indexClasses, invitationLink, invitationPayload, isOwnLastAdminGrant, mfaResetConfirmation, passwordResetLink,
  ACTION_LABELS, PENDING_DECISION_ROLES, ROLE_LABELS, roleNeedsPendingDecisionWarning, scopeLabel,
} from '../admin/core.js';
import { ROLE_STATUS } from '../src/pg/auth.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ENTITY_TYPE_LABELS, REASON_LABELS, accountName, entityTypeLabel, reasonLabel } from '../admin/core.js';
import { shortId } from '../shared/short-id.js';
import { AUDIT_ACTIONS } from '../src/pg/routes/admin.js';
import {
  GRANT_REQUEST_STATUS_LABELS, grantRequestDialog, grantRequestRow, grantRequestsPath, requestAge,
} from '../admin/core.js';

const NOW = new Date('2026-09-27T10:00:00Z');

test('#176: PENDING_DECISION_ROLES zgadza się z ROLE_STATUS (src/pg/auth.js), jedynym źródłem prawdy', () => {
  const pendingOnServer = Object.entries(ROLE_STATUS)
    .filter(([, status]) => status === 'pending_decision')
    .map(([role]) => role)
    .sort();
  assert.deepEqual([...PENDING_DECISION_ROLES].sort(), pendingOnServer);
  for (const role of Object.keys(ROLE_LABELS)) {
    assert.equal(roleNeedsPendingDecisionWarning(role), pendingOnServer.includes(role), role);
  }
  assert.equal(roleNeedsPendingDecisionWarning('nieznana'), false);
});

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
  // przegląd demo 4: nazwa klasy z serwera zaczyna się od „Klasa” — bez „klasa Klasa”
  const named = indexClasses([{ id: 'y-2026', label: '2026/27', classes: [{ id: 'c-0a', name: 'Klasa 0-A (dane przykładowe)' }] }]);
  assert.equal(scopeLabel({ classId: 'c-0a', schoolYearId: 'y-2026' }, named, yearMap), 'Klasa 0-A (dane przykładowe), rok 2026/27');
  assert.equal(errorMessage('last_admin_grant'), 'Nie można odebrać sobie ostatniego aktywnego przydziału administratora.');
  assert.match(errorMessage('cannot_grant_self'), /Nie można nadać roli własnemu kontu/);
  assert.match(errorMessage(undefined, 503), /niedostępna/);
  assert.match(errorMessage('weird', 400), /weird/);
  assert.match(confirmationText('disable', 'u-1'), /sesje zostaną wycofane/);
  const described = describeAuditEvent({ action: 'role_grant.expired', metadata: { role: 'board', userId: 'u-1', schoolYearId: 'y-2026', reason: 'term_closed' } });
  assert.equal(described.label, 'Wygaszenie roli');
  assert.equal(described.details, 'Zarząd, konto u-1, rok y-2026, powód: zakończenie kadencji');
});

// #224: pole potwierdzenia resetu MFA musi dokładnie odpowiadać identyfikatorowi
// konta (kontrakt POST /api/admin/users/{id}/mfa-reset) i rozróżniać anulowanie
// okna (Escape/Anuluj -> null) od wpisania złego tekstu.
test('mfaResetConfirmation requires an exact account id and distinguishes cancel from a wrong answer', () => {
  assert.deepEqual(mfaResetConfirmation(null, 'u-target'), { cancelled: true, ok: false });
  assert.deepEqual(mfaResetConfirmation('', 'u-target'), { cancelled: false, ok: false });
  assert.deepEqual(mfaResetConfirmation('u-inny', 'u-target'), { cancelled: false, ok: false });
  assert.deepEqual(mfaResetConfirmation(' u-target ', 'u-target'), { cancelled: false, ok: true });
  assert.deepEqual(mfaResetConfirmation('u-target', 'u-target'), { cancelled: false, ok: true });
});

test('passwordResetLink builds a /login/#reset= link carrying the token only in the fragment', () => {
  assert.equal(
    passwordResetLink('abc123', 'https://rd.example.invalid'),
    'https://rd.example.invalid/login/#reset=abc123',
  );
});

// Przegląd demo: dziennik kont i ról pokazywał „user.created” i „auth.password_set”
// surowym kodem. Każda akcja, którą GET /api/admin/audit może zwrócić, ma polską etykietę.
test('dziennik kont: każda akcja z AUDIT_ACTIONS ma polską etykietę (bez surowego kodu)', () => {
  assert.ok(AUDIT_ACTIONS.length > 0);
  for (const action of AUDIT_ACTIONS) {
    const label = ACTION_LABELS[action];
    assert.ok(label, `brak etykiety dla ${action}`);
    assert.doesNotMatch(label, /[a-z]+[._][a-z]+/, `etykieta dla ${action} wygląda jak kod: ${label}`);
    assert.equal(describeAuditEvent({ action, metadata: {} }).label, label);
  }
  assert.equal(ACTION_LABELS['user.created'], 'Utworzenie konta');
  assert.equal(ACTION_LABELS['auth.password_set'], 'Ustawienie hasła');
});

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : (path.endsWith('.js') ? [path] : []);
  });
}

// Przegląd demo: dziennik pokazywał `role_grant` i `rotated`. Każdy typ obiektu i powód
// użyty w src/pg/** ma polską etykietę (bez znaków kodu).
test('dziennik kont: słowniki typów obiektów i powodów pokrywają wartości z src/pg', () => {
  const code = sourceFiles(new URL('../src/pg', import.meta.url).pathname).map((file) => readFileSync(file, 'utf8')).join('\n');
  const types = new Set([...code.matchAll(/entityType: '([a-z_]+)'/g)].map((m) => m[1]));
  const reasons = new Set([...code.matchAll(/reason(?::| =) '([a-z_]+)'/g)].map((m) => m[1]));
  assert.ok(types.size > 30 && reasons.size > 10, 'skan powinien coś znaleźć');
  for (const type of types) assert.ok(ENTITY_TYPE_LABELS[type], `brak etykiety typu ${type}`);
  for (const reason of reasons) assert.ok(REASON_LABELS[reason], `brak etykiety powodu ${reason}`);
  for (const label of [...Object.values(ENTITY_TYPE_LABELS), ...Object.values(REASON_LABELS)]) {
    assert.doesNotMatch(label, /[a-z]+_[a-z]+/, `etykieta wygląda jak kod: ${label}`);
  }
  assert.equal(entityTypeLabel('role_grant'), 'Przydział roli');
  assert.equal(reasonLabel('rotated'), 'odnowienie sesji');
  assert.equal(reasonLabel('nieznany_kod'), 'nieznany_kod');
});

test('dziennik kont: autor jako nazwa konta z listy kont albo skrócony identyfikator', () => {
  const uuid = '3f2b8c1e-aaaa-bbbb-cccc-123456789012';
  assert.equal(accountName(uuid, [{ id: uuid, displayName: 'Anna Demo', email: 'a@example.invalid' }]), 'Anna Demo');
  assert.equal(accountName(uuid, [{ id: uuid, displayName: '', email: 'a@example.invalid' }]), 'a@example.invalid');
  assert.equal(accountName(uuid, []), '3f2b8c1e…');
  assert.equal(accountName(null, []), 'system');
  assert.equal(shortId('abc'), 'abc');
  assert.equal(shortId(undefined), '—');
});

test('#207: formularze nowego roku i klas — walidacja jak po stronie serwera', async () => {
  const { schoolYearPayload, classNamesPayload } = await import('../admin/core.js');
  assert.deepEqual(
    schoolYearPayload({ id: ' 2027-2028 ', label: ' Rok 2027/2028 ', startsOn: '2027-09-01', endsOn: '2028-08-31' }),
    { id: '2027-2028', label: 'Rok 2027/2028', startsOn: '2027-09-01', endsOn: '2028-08-31' },
  );
  assert.throws(() => schoolYearPayload({ id: '2027 2028', label: 'x', startsOn: '2027-09-01', endsOn: '2028-08-31' }), /identyfikator/);
  assert.throws(() => schoolYearPayload({ id: 'y', label: '', startsOn: '2027-09-01', endsOn: '2028-08-31' }), /nazwę/);
  assert.throws(() => schoolYearPayload({ id: 'y', label: 'x', startsOn: '2028-09-01', endsOn: '2028-08-31' }), /wcześniejsza/);
  assert.deepEqual(classNamesPayload('1A, 1B;\n2A'), { names: ['1A', '1B', '2A'] });
  assert.throws(() => classNamesPayload('1A, 1a'), /powtarza/);
  assert.throws(() => classNamesPayload(' , '), /Podaj nazwy/);
  assert.throws(() => classNamesPayload('x'.repeat(61)), /60 znaków/);
});

test('confirmationDialog (#136): tytuł-czasownik, nazwa akcji na przycisku i skutki z liczbami', () => {
  const disable = confirmationDialog('disable', { account: 'osoba@example.invalid', activeSessions: 3, activeGrants: 2 });
  assert.equal(disable.title, 'Wyłączyć konto?');
  assert.equal(disable.confirmLabel, 'Wyłącz konto');
  assert.equal(disable.destructive, true);
  assert.ok(disable.effects.includes('Konto: osoba@example.invalid'));
  assert.ok(disable.effects.includes('Aktywne sesje do zakończenia: 3'));
  assert.ok(disable.effects.some((line) => /Aktywne przydziały ról: 2/.test(line)));

  const sessions = confirmationDialog('revoke-sessions', { account: 'a@example.invalid', activeSessions: 0 });
  assert.equal(sessions.confirmLabel, 'Wyloguj wszędzie');
  assert.ok(sessions.effects.includes('Aktywne sesje do zakończenia: 0'));

  const grant = confirmationDialog('revoke-grant', { account: 'rep@example.invalid', role: 'Przedstawiciel klasy', scope: 'klasa 1A, rok 2026/27' });
  assert.equal(grant.title, 'Wycofać przydział?');
  assert.equal(grant.confirmLabel, 'Wycofaj przydział');
  assert.ok(grant.effects.includes('Rola: Przedstawiciel klasy'));
  assert.ok(grant.effects.includes('Zakres: klasa 1A, rok 2026/27'));

  const invitation = confirmationDialog('revoke-invitation', { account: 'nowa@example.invalid', role: 'Skarbnik', scope: 'cała Rada' });
  assert.equal(invitation.confirmLabel, 'Wycofaj zaproszenie');
  assert.ok(invitation.effects.includes('Zakres: cała Rada'));
  assert.equal(confirmationDialog('reissue-invitation', { account: 'nowa@example.invalid' }).confirmLabel, 'Wydaj nowy link');
  assert.equal(confirmationDialog('password-reset', { account: 'x@example.invalid' }).confirmLabel, 'Wydaj kod resetu');
  assert.equal(confirmationDialog('enable', { account: 'x@example.invalid', activeGrants: 1 }).confirmLabel, 'Włącz konto');
  // Każda akcja zmienia dostęp: fokus na „Anuluj”, żaden przycisk nie brzmi „OK”.
  for (const action of ['disable', 'enable', 'revoke-sessions', 'password-reset', 'revoke-grant', 'revoke-invitation', 'reissue-invitation']) {
    const options = confirmationDialog(action, { account: 'x@example.invalid' });
    assert.equal(options.destructive, true, action);
    assert.match(options.title, /\?$/, action);
    assert.notEqual(options.confirmLabel, 'OK', action);
  }
});

test('confirmationDialog: brak liczby sesji nie wstawia pustej linii ani „NaN”', () => {
  const options = confirmationDialog('disable', { account: 'x@example.invalid' });
  const lines = options.effects.filter(Boolean);
  assert.ok(lines.length >= 3);
  assert.deepEqual(lines.filter((line) => /NaN|undefined/.test(line)), []);
  assert.ok(!lines.some((line) => /sesje do zakończenia/.test(line)));
});

// --- #146: wnioski o nadanie roli w panelu ---------------------------------------

const REQUEST_NOW = new Date('2026-09-30T12:00:00Z');
const baseRequest = Object.freeze({
  id: 'req-1', kind: 'grant', role: 'treasurer', userId: 'u-target', email: null, schoolYearId: 'y-2026',
  grantExpiresAt: null, replacesInvitationId: null, requestedBy: 'u-requester', status: 'pending',
  createdAt: '2026-09-30T09:30:00Z', expiresAt: '2026-10-03T09:30:00Z',
});
const requestUsers = [
  { id: 'u-requester', email: 'wnioskodawca@example.invalid', displayName: 'Wnioskodawca' },
  { id: 'u-target', email: 'adresat@example.invalid', displayName: '' },
];
const yearsMap = new Map([['y-2026', { label: '2026-2027' }]]);

test('#146: grantRequestsPath przyjmuje tylko znane statusy (domyślnie pending)', () => {
  assert.equal(grantRequestsPath(), '/api/admin/grant-requests?status=pending');
  assert.equal(grantRequestsPath('all'), '/api/admin/grant-requests?status=all');
  for (const status of Object.keys(GRANT_REQUEST_STATUS_LABELS)) {
    assert.equal(grantRequestsPath(status), `/api/admin/grant-requests?status=${status}`);
  }
  assert.equal(grantRequestsPath('x&status=all'), '/api/admin/grant-requests?status=pending');
});

test('#146: requestAge — minuty, godziny, dni; data błędna i z przyszłości', () => {
  assert.equal(requestAge('2026-09-30T11:59:40Z', REQUEST_NOW), 'przed chwilą');
  assert.equal(requestAge('2026-09-30T11:15:00Z', REQUEST_NOW), '45 min temu');
  assert.equal(requestAge('2026-09-30T09:30:00Z', REQUEST_NOW), '2 godz. temu');
  assert.equal(requestAge('2026-09-29T11:00:00Z', REQUEST_NOW), '1 dzień temu');
  assert.equal(requestAge('2026-09-27T11:00:00Z', REQUEST_NOW), '3 dni temu');
  assert.equal(requestAge('2026-10-01T00:00:00Z', REQUEST_NOW), 'przed chwilą');
  assert.equal(requestAge('nie-data', REQUEST_NOW), '—');
});

test('#146: wiersz wniosku — inny administrator widzi „Zatwierdź” i „Odrzuć”, z nazwami kont', () => {
  const row = grantRequestRow(baseRequest, { me: { id: 'u-approver', email: 'zatwierdzajacy@example.invalid' }, users: requestUsers, years: yearsMap, now: REQUEST_NOW });
  assert.equal(row.requester, 'Wnioskodawca');
  assert.equal(row.target, 'adresat@example.invalid');
  assert.equal(row.role, 'Skarbnik');
  assert.equal(row.scope, 'rok 2026/2027');
  assert.equal(row.age, '2 godz. temu');
  assert.equal(row.status, 'pending');
  assert.equal(row.canApprove, true);
  assert.equal(row.canReject, true);
  assert.equal(row.rejectLabel, 'Odrzuć');
  assert.equal(row.note, null);
});

test('#146: własny wniosek — bez „Zatwierdź”, odrzucenie jako „Wycofaj wniosek”', () => {
  const row = grantRequestRow(baseRequest, { me: { id: 'u-requester' }, users: requestUsers, now: REQUEST_NOW });
  assert.equal(row.canApprove, false);
  assert.equal(row.canReject, true);
  assert.equal(row.rejectLabel, 'Wycofaj wniosek');
  assert.match(row.note, /inny administrator/);
});

test('#146: adresat (konto albo adres zaproszenia, bez względu na wielkość liter) nie widzi „Zatwierdź”', () => {
  const asTarget = grantRequestRow(baseRequest, { me: { id: 'u-target' }, users: requestUsers, now: REQUEST_NOW });
  assert.equal(asTarget.canApprove, false);
  const invitation = { ...baseRequest, kind: 'invitation', userId: null, email: 'nowy.zarzad@example.invalid', role: 'board' };
  const asInvitee = grantRequestRow(invitation, { me: { id: 'u-other', email: 'Nowy.Zarzad@example.invalid' }, users: requestUsers, now: REQUEST_NOW });
  assert.equal(asInvitee.canApprove, false);
  assert.equal(asInvitee.target, 'nowy.zarzad@example.invalid');
  const asOther = grantRequestRow(invitation, { me: { id: 'u-other', email: 'ktos@example.invalid' }, users: requestUsers, now: REQUEST_NOW });
  assert.equal(asOther.canApprove, true);
  assert.equal(asOther.scope, 'rok y-2026', 'rok bez etykiety w słowniku — identyfikator');
});

test('#146: brak zalogowanego konta w stanie — nikt nie jest traktowany jako wnioskodawca', () => {
  const row = grantRequestRow({ ...baseRequest, requestedBy: null }, { me: {}, now: REQUEST_NOW });
  assert.equal(row.rejectLabel, 'Odrzuć');
  assert.equal(row.requester, 'system');
});

test('#146: wniosek po terminie jest „Wygasły” bez „Zatwierdź”; zamknięty bez żadnych akcji', () => {
  const overdue = grantRequestRow({ ...baseRequest, expiresAt: '2026-09-30T11:00:00Z' }, { me: { id: 'u-approver' }, now: REQUEST_NOW });
  assert.equal(overdue.status, 'expired');
  assert.equal(overdue.statusLabel, 'Wygasły');
  assert.equal(overdue.canApprove, false);
  assert.equal(overdue.canReject, true);
  for (const status of ['approved', 'rejected', 'expired']) {
    const row = grantRequestRow({ ...baseRequest, status }, { me: { id: 'u-approver' }, now: REQUEST_NOW });
    assert.equal(row.canApprove, false, status);
    assert.equal(row.canReject, false, status);
    assert.equal(row.note, null, status);
    assert.equal(row.statusLabel, GRANT_REQUEST_STATUS_LABELS[status]);
  }
});

test('#146: okno zatwierdzenia nazywa akcję i skutki (przydział albo jednorazowy link)', () => {
  const me = { id: 'u-approver' };
  const grantRow = grantRequestRow(baseRequest, { me, users: requestUsers, years: yearsMap, now: REQUEST_NOW });
  const grantDialog = grantRequestDialog('approve', baseRequest, grantRow);
  assert.equal(grantDialog.title, 'Zatwierdzić nadanie roli?');
  assert.equal(grantDialog.confirmLabel, 'Zatwierdź i nadaj rolę');
  assert.equal(grantDialog.destructive, true);
  assert.ok(grantDialog.effects.includes('Wnioskuje: Wnioskodawca'));
  assert.ok(grantDialog.effects.includes('Konto: adresat@example.invalid'));
  assert.ok(grantDialog.effects.includes('Rola: Skarbnik'));
  assert.ok(grantDialog.effects.some((line) => line.startsWith('Przydział bezterminowy')));
  const limited = grantRequestDialog('approve', { ...baseRequest, grantExpiresAt: '2027-09-01T00:00:00Z' }, grantRow);
  assert.ok(limited.effects.some((line) => line.startsWith('Przydział będzie ważny do')));

  const invitation = { ...baseRequest, kind: 'invitation', userId: null, email: 'nowy@example.invalid', replacesInvitationId: 'inv-old' };
  const invRow = grantRequestRow(invitation, { me, now: REQUEST_NOW });
  const invDialog = grantRequestDialog('approve', invitation, invRow);
  assert.equal(invDialog.confirmLabel, 'Zatwierdź i wydaj link');
  assert.ok(invDialog.effects.includes('Adres zaproszenia: nowy@example.invalid'));
  assert.ok(invDialog.effects.some((line) => line.includes('Poprzedni link')));
  assert.ok(invDialog.effects.some((line) => line.includes('tylko raz')));
});

test('#146: okno odrzucenia — „Odrzuć wniosek” albo „Wycofaj wniosek” dla własnego', () => {
  const other = grantRequestRow(baseRequest, { me: { id: 'u-approver' }, now: REQUEST_NOW });
  const reject = grantRequestDialog('reject', baseRequest, other);
  assert.equal(reject.title, 'Odrzucić wniosek?');
  assert.equal(reject.confirmLabel, 'Odrzuć wniosek');
  assert.ok(reject.effects.some((line) => line.includes('nie zostanie nadana')));
  const own = grantRequestRow(baseRequest, { me: { id: 'u-requester' }, now: REQUEST_NOW });
  const withdraw = grantRequestDialog('reject', baseRequest, own);
  assert.equal(withdraw.title, 'Wycofać wniosek?');
  assert.equal(withdraw.confirmLabel, 'Wycofaj wniosek');
});

// Przegląd demo 5: daty w zapisie aplikacji (dd.mm.rrrr gg:mm, Europe/Brussels, #563)
// i skrót konta zamiast pełnego UUID w listach wyboru.
test('admin formatDateTime: dd.mm.rrrr gg:mm w Europe/Brussels, sama data dd.mm.rrrr', async () => {
  const { formatDateTime } = await import('../admin/core.js');
  assert.equal(formatDateTime('2026-10-03T15:48:00.000Z'), '03.10.2026 17:48');
  assert.equal(formatDateTime('2026-01-15T12:22:00Z'), '15.01.2026 13:22');
  assert.equal(formatDateTime('2026-09-01'), '01.09.2026');
  assert.equal(formatDateTime(null), '—');
  assert.equal(formatDateTime('nie-data'), '—');
  assert.doesNotMatch(formatDateTime('2026-10-03T15:48:00Z'), /,/);
});

test('admin userOptionLabel: e-mail i skrót identyfikatora, bez pełnego UUID', async () => {
  const { userOptionLabel } = await import('../admin/core.js');
  const id = '7a937d66-1111-4222-8333-444455556666';
  const label = userOptionLabel({ id, email: 'admin@example.invalid' });
  assert.equal(label, 'admin@example.invalid (7a937d66…)');
  assert.equal(label.includes(id), false);
});
