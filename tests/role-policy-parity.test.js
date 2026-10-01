// #225: panele ukrywają akcje niedostępne dla roli. Reguła „kto może” w panelu musi
// odpowiadać serwerowi — te testy porównują listy ról panelu ze stałymi serwera
// i sprawdzają funkcje „dozwolone akcje” dla każdej roli. Serwer pozostaje jedyną
// kontrolą dostępu (AGENTS.md); dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EVENT_POLICY } from '../src/pg/events.js';
import { DOCUMENT_POLICIES } from '../src/pg/routes/documents.js';
import { MANAGE_ROLES } from '../src/pg/meetings.js';
import { EVENT_ROLES, canDraftEvents, permittedEventActions } from '../events/core.js';
import { FINANCIAL_ROLES as PANEL_FINANCIAL, describeApiError, hasFinancialAccess } from '../panel/core.js';
import { FINANCIAL_ROLES as LEDGER_FINANCIAL, hasFinancialAccess as ledgerAccess } from '../ledger/core.js';
import { DOCUMENT_ROLES, representativeClasses, uploadableKinds } from '../documents/core.js';
import { MEETING_MANAGE_ROLES, canManageMeetings } from '../meetings/core.js';

const serverList = (path) => {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const match = source.match(/const FINANCIAL_ROLES = \[([^\]]*)\]/);
  assert.ok(match, `${path}: FINANCIAL_ROLES`);
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
};

test('listy ról panelu są takie same jak na serwerze', () => {
  const plain = (policy) => Object.fromEntries(Object.entries(policy).map(([key, roles]) => [key, [...roles]]));
  assert.deepEqual(plain(EVENT_ROLES), plain(EVENT_POLICY));
  assert.deepEqual([...PANEL_FINANCIAL], serverList('src/pg/routes/payments.js'));
  assert.deepEqual([...LEDGER_FINANCIAL], serverList('src/pg/routes/ledger.js'));
  assert.deepEqual(Object.keys(DOCUMENT_ROLES).sort(), Object.keys(DOCUMENT_POLICIES).sort());
  for (const kind of Object.keys(DOCUMENT_POLICIES)) assert.deepEqual([...DOCUMENT_ROLES[kind]], [...DOCUMENT_POLICIES[kind].roles], kind);
  assert.deepEqual([...MEETING_MANAGE_ROLES], [...MANAGE_ROLES]);
});

const Y = 'y2026';
const G = {
  admin: [{ role: 'admin', classId: null, schoolYearId: null }],
  board: [{ role: 'board', classId: null, schoolYearId: null }],
  treasurer: [{ role: 'treasurer', classId: null, schoolYearId: Y }],
  rep1: [{ role: 'representative', classId: 'c0001', schoolYearId: Y }],
  rep2: [{ role: 'representative', classId: 'c0001', schoolYearId: Y }, { role: 'representative', classId: 'c0002', schoolYearId: Y }],
  audit: [{ role: 'audit', classId: null, schoolYearId: Y }],
  principal: [{ role: 'principal', classId: null, schoolYearId: Y }],
  none: [],
};

test('Wpłaty i Księga: dostęp mają tylko role finansowe z przydziałem bez klasy', () => {
  for (const check of [hasFinancialAccess, ledgerAccess]) {
    assert.equal(check(G.admin), true);
    assert.equal(check(G.board), true);
    assert.equal(check(G.treasurer, Y), true);
    assert.equal(check(G.treasurer, 'y2027'), false, 'przydział innego roku');
    for (const role of ['rep1', 'rep2', 'audit', 'principal', 'none']) assert.equal(check(G[role]), false, role);
    // Skarbnik z przydziałem klasowym nie ma dostępu ogólnoszkolnego (jak isAuthorizedScoped).
    assert.equal(check([{ role: 'treasurer', classId: 'c0001', schoolYearId: Y }]), false);
    assert.equal(check(undefined), false);
  }
});

test('403 to brak uprawnień, a nie „Błąd serwera”', () => {
  assert.match(describeApiError(403, 'forbidden'), /Nie masz uprawnień/);
  assert.match(describeApiError(403, 'mfa_required'), /MFA/);
  assert.match(describeApiError(401, 'unauthenticated'), /Zaloguj/);
  assert.equal(describeApiError(409, 'idempotency_conflict'), null);
  assert.equal(describeApiError(500, null), null);
});

test('Dokumenty: rodzaje w formularzu według roli', () => {
  assert.deepEqual(uploadableKinds(G.admin), ['financial', 'board', 'class', 'council_shared']);
  assert.deepEqual(uploadableKinds(G.board), ['financial', 'board', 'class', 'council_shared']);
  assert.deepEqual(uploadableKinds(G.treasurer), ['financial']);
  assert.deepEqual(uploadableKinds(G.rep1), ['class']);
  assert.deepEqual(uploadableKinds(G.rep2), ['class']);
  assert.deepEqual(uploadableKinds(G.audit), []);
  assert.deepEqual(uploadableKinds(G.principal), []);
  assert.deepEqual(uploadableKinds(G.none), [], 'sesja przed MFA: puste grants');
  assert.deepEqual(representativeClasses(G.rep2), ['c0001', 'c0002']);
  assert.deepEqual(representativeClasses(G.board), []);
});

test('Zebrania: „Nowe zebranie” tylko dla administratora i zarządu', () => {
  assert.equal(canManageMeetings(G.admin), true);
  assert.equal(canManageMeetings(G.board), true);
  for (const role of ['treasurer', 'rep1', 'audit', 'principal', 'none']) assert.equal(canManageMeetings(G[role]), false, role);
});

const submitted = {
  id: 'ev1', schoolYearId: Y, classId: null, status: 'submitted', audience: 'public', revision: 2,
  createdBy: 'u-author', publishedRevision: null,
};
const revisions = [{ revision: 1, createdBy: 'u-author' }, { revision: 2, createdBy: 'u-editor' }];

test('Wydarzenia: „Nowy szkic” według ról', () => {
  assert.equal(canDraftEvents(G.admin), true);
  assert.equal(canDraftEvents(G.board), true);
  assert.equal(canDraftEvents(G.rep1), true);
  for (const role of ['treasurer', 'audit', 'principal', 'none']) assert.equal(canDraftEvents(G[role]), false, role);
});

test('Wydarzenia: „Zatwierdź” tylko zarząd i nie autor (zasada czterech oczu)', () => {
  const reviewer = permittedEventActions(submitted, { grants: G.board, userId: 'u-reviewer', revisions });
  assert.deepEqual(reviewer.actions, ['approve', 'cancel']);
  assert.deepEqual(reviewer.notes, []);

  for (const userId of ['u-author', 'u-editor']) {
    const author = permittedEventActions(submitted, { grants: G.board, userId, revisions });
    assert.deepEqual(author.actions, ['cancel'], userId);
    assert.match(author.notes.join(' '), /czterech oczu/);
  }

  const admin = permittedEventActions(submitted, { grants: G.admin, userId: 'u-admin', revisions });
  assert.deepEqual(admin.actions, ['cancel'], 'admin nie zatwierdza (PRODUCT.md)');
  assert.equal(admin.edit, true);

  const rep = permittedEventActions({ ...submitted, classId: 'c0001' }, { grants: G.rep1, userId: 'u-rep', revisions });
  assert.deepEqual(rep.actions, ['cancel']);
  const otherClass = permittedEventActions({ ...submitted, classId: 'c0003' }, { grants: G.rep2, userId: 'u-rep', revisions });
  assert.deepEqual(otherClass, { edit: false, actions: [], notes: [] });

  for (const role of ['treasurer', 'audit', 'none']) {
    assert.deepEqual(permittedEventActions(submitted, { grants: G[role], userId: 'u-x', revisions }).actions, [], role);
  }
});

test('Wydarzenia: publikacja i odwołanie opublikowanego tylko przez zarząd', () => {
  const approved = { ...submitted, status: 'approved' };
  assert.deepEqual(permittedEventActions(approved, { grants: G.board, userId: 'u-author', revisions }).actions, ['publish', 'cancel']);
  assert.deepEqual(permittedEventActions(approved, { grants: G.admin, userId: 'u-admin', revisions }).actions, ['cancel']);
  const published = { ...submitted, status: 'published', publishedRevision: 2 };
  assert.deepEqual(permittedEventActions(published, { grants: G.admin, userId: 'u-admin', revisions }).actions, []);
  assert.deepEqual(permittedEventActions(published, { grants: G.board, userId: 'u-x', revisions }).actions, ['cancel']);
  const draft = { ...submitted, status: 'draft', classId: 'c0001' };
  assert.deepEqual(permittedEventActions(draft, { grants: G.rep1, userId: 'u-rep', revisions }).actions, ['submit', 'cancel']);
  // Przydział innego roku nie daje akcji.
  const otherYear = [{ role: 'board', classId: null, schoolYearId: 'y2027' }];
  assert.deepEqual(permittedEventActions(submitted, { grants: otherYear, userId: 'u-x', revisions }).actions, []);
});
