// Testy czystych funkcji ekranu aktualności (issue #147): news/core.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CLASS_EDITOR_ROLES, PHOTO_READ_ROLES, REVIEW_ROLES, SCHOOL_WIDE_EDITOR_ROLES,
  availableActions, canReadPhotoRegister, consentSummary, describeApiError, hasNewsAccess, isLikelyOwnPost,
  isSchoolWideEditor, listUrl, makeIdempotencyKey, newsYears, peopleSummary, photoSummary, photoUrl, postUrl,
  representedClassIds, selectablePhotos, validateDraft, validateReason,
} from '../news/core.js';

const source = readFileSync(new URL('../src/pg/news.js', import.meta.url), 'utf8');
const policy = source.match(/export const NEWS_POLICY = Object\.freeze\(\{([\s\S]*?)\}\);/)[1];
const roles = (key) => [...policy.match(new RegExp(`${key}: Object\\.freeze\\(\\[([^\\]]*)\\]`))[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);

test('role panelu odpowiadają NEWS_POLICY w src/pg/news.js', () => {
  assert.deepEqual([...SCHOOL_WIDE_EDITOR_ROLES], roles('draftSchoolWide'));
  assert.deepEqual([...CLASS_EDITOR_ROLES], roles('draftClass'));
  assert.deepEqual([...REVIEW_ROLES], roles('review'));
  assert.deepEqual([...PHOTO_READ_ROLES], roles('photoRegister'));
});

const BOARD = [{ role: 'board', schoolYearId: 'y1' }];
const ADMIN = [{ role: 'admin', schoolYearId: 'y1' }];
const REP = [{ role: 'representative', classId: '1A', schoolYearId: 'y1' }];
const TREASURER = [{ role: 'treasurer', schoolYearId: 'y1' }];
const AUDIT = [{ role: 'audit', schoolYearId: 'y1' }];

test('granice ról: dostęp do ekranu i rejestru zdjęć', () => {
  for (const grants of [BOARD, ADMIN, REP]) assert.equal(hasNewsAccess(grants), true);
  for (const grants of [TREASURER, AUDIT, []]) assert.equal(hasNewsAccess(grants), false);
  assert.equal(canReadPhotoRegister(BOARD, 'y1'), true);
  assert.equal(canReadPhotoRegister(ADMIN, 'y1'), true);
  assert.equal(canReadPhotoRegister(REP, 'y1'), false);
  assert.equal(canReadPhotoRegister(BOARD, 'y2'), false);
  assert.equal(isSchoolWideEditor([{ role: 'board', classId: '1A' }]), false);
  assert.deepEqual(representedClassIds([...REP, { role: 'representative', classId: '2B', schoolYearId: 'y1' }], 'y1'), ['1A', '2B']);
  assert.deepEqual(newsYears([...BOARD, { role: 'admin', schoolYearId: 'y0' }, ...TREASURER]), ['y1', 'y0']);
});

const post = (over = {}) => ({ id: 'p1', schoolYearId: 'y1', classId: null, status: 'draft', revision: 1, createdBy: 'u-author', updatedBy: 'u-author', publishedRevision: null, ...over });

test('availableActions: szkic — autor-zarząd może zgłosić, edytować i wycofać; nie zatwierdza', () => {
  const a = availableActions(post(), { grants: BOARD, actorId: 'u-author' });
  assert.deepEqual({ edit: a.edit, submit: a.submit, approve: a.approve, publish: a.publish, withdraw: a.withdraw }, { edit: true, submit: true, approve: false, publish: false, withdraw: true });
});

test('availableActions: cztery oczy — autor widzi „czeka na drugą osobę”, inny zarząd zatwierdza', () => {
  const submitted = post({ status: 'submitted' });
  const own = availableActions(submitted, { grants: BOARD, actorId: 'u-author' });
  assert.equal(own.approve, false);
  assert.equal(own.waitingForSecondPerson, true);
  const other = availableActions(submitted, { grants: BOARD, actorId: 'u-other' });
  assert.equal(other.approve, true);
  assert.equal(other.waitingForSecondPerson, false);
  // autor bieżącej wersji (nie tylko wpisu) też nie zatwierdza
  assert.equal(availableActions(post({ status: 'submitted', createdBy: 'u-x', updatedBy: 'u-y' }), { grants: BOARD, actorId: 'u-y' }).approve, false);
  assert.equal(isLikelyOwnPost(submitted, null), false);
});

test('availableActions: admin nie zatwierdza ani nie publikuje; publikuje tylko zarząd zatwierdzony wpis', () => {
  const adminSubmitted = availableActions(post({ status: 'submitted' }), { grants: ADMIN, actorId: 'u-other' });
  assert.equal(adminSubmitted.approve, false);
  assert.equal(adminSubmitted.edit, true);
  assert.equal(availableActions(post({ status: 'approved' }), { grants: ADMIN, actorId: 'u-other' }).publish, false);
  assert.equal(availableActions(post({ status: 'approved' }), { grants: BOARD, actorId: 'u-other' }).publish, true);
  assert.equal(availableActions(post({ status: 'draft' }), { grants: BOARD, actorId: 'u-other' }).publish, false);
});

test('availableActions: przedstawiciel — tylko własna klasa; wpis opublikowany może wycofać wyłącznie zarząd', () => {
  const own = post({ classId: '1A' });
  const a = availableActions(own, { grants: REP, actorId: 'u-rep' });
  assert.deepEqual({ edit: a.edit, submit: a.submit, approve: a.approve, withdraw: a.withdraw }, { edit: true, submit: true, approve: false, withdraw: true });
  assert.equal(availableActions(post({ classId: '2B' }), { grants: REP, actorId: 'u-rep' }).edit, false);
  assert.equal(availableActions(post({ classId: '2B' }), { grants: REP, actorId: 'u-rep' }).withdraw, false);
  assert.equal(availableActions(post(), { grants: REP, actorId: 'u-rep' }).edit, false, 'wpis całej szkoły nie jest edytowalny przez przedstawiciela');
  const published = post({ classId: '1A', status: 'published', publishedRevision: 1 });
  assert.equal(availableActions(published, { grants: REP, actorId: 'u-rep' }).withdraw, false);
  assert.equal(availableActions(published, { grants: BOARD, actorId: 'u-b' }).withdraw, true);
});

test('availableActions: wycofany i brak wpisu — żadnych akcji', () => {
  const none = availableActions(post({ status: 'withdrawn' }), { grants: BOARD, actorId: 'u' });
  assert.ok(Object.values(none).every((v) => v === false));
  assert.ok(Object.values(availableActions(null, { grants: BOARD })).every((v) => v === false));
});

test('selectablePhotos: tylko zweryfikowane prawa; podsumowania nie zawierają danych osobowych', () => {
  const photos = [
    { id: 'a', rightsStatus: 'verified', author: 'Autor', takenOn: '2026-05-01', altText: 'Dzieci na wycieczce', depictsChildren: true, identifiableChildren: 2, identifiableAdults: 0 },
    { id: 'b', rightsStatus: 'pending' }, { id: 'c', rightsStatus: 'revoked' },
  ];
  assert.deepEqual(selectablePhotos(photos).map((p) => p.id), ['a']);
  assert.match(photoSummary(photos[0]), /Autor · 2026-05-01 · opis: Dzieci na wycieczce/);
  assert.match(peopleSummary(photos[0]), /z dziećmi \(rozpoznawalnych: 2\)/);
  assert.match(photoSummary({ author: 'X', takenOn: '2026-01-01', decorative: true }), /dekoracyjne/);
  assert.match(consentSummary({ subjectKind: 'child', subjectNo: 1, scope: ['rada_website', 'print'], validUntil: '2027-08-31' }), /dziecko nr 1 · zakres: strona Rady, druk · ważna do 2027-08-31/);
  assert.match(consentSummary({ subjectKind: 'adult', subjectNo: 2, scope: [], validUntil: null }), /bez terminu ważności/);
});

test('walidacja szkicu i powodu jak na serwerze', () => {
  assert.deepEqual(validateDraft({ title: 'Wycieczka', body: 'Treść' }), []);
  assert.equal(validateDraft({ title: 'ab', body: 'x' }).length, 1);
  assert.equal(validateDraft({ title: 'Tytuł', body: '   ' }).length, 1);
  assert.equal(validateDraft({ title: 'Tytuł\ndruga', body: 'x' }).length, 1);
  assert.equal(validateDraft({ title: 'Tytuł', body: 'x', photoIds: ['a', 'a'] }).length, 1);
  assert.equal(validateDraft({ title: 'Tytuł', body: 'x', photoIds: Array.from({ length: 21 }, (_, i) => `p${i}`) }).length, 1);
  assert.equal(validateDraft({ title: 'Tytuł', body: 'x' }, { classId: null, requireClass: true }).length, 1);
  assert.equal(validateReason('ab').length, 1);
  assert.equal(validateReason('Błąd merytoryczny').length, 0);
  assert.equal(validateReason('x'.repeat(501)).length, 1);
});

test('adresy, klucz idempotencji, komunikaty błędów', () => {
  assert.equal(listUrl('2026-2027'), '/api/news?schoolYearId=2026-2027');
  assert.equal(postUrl('p1', 'publish'), '/api/news/p1/publish');
  assert.equal(photoUrl('ph1'), '/api/news-photos/ph1');
  assert.throws(() => postUrl('../x'));
  assert.throws(() => postUrl('p1', 'delete'));
  assert.throws(() => listUrl(''));
  const key = makeIdempotencyKey(() => 'abc-123');
  assert.match(key, /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/);
  assert.match(makeIdempotencyKey(), /^news-[0-9a-f-]{36}$/);
  assert.match(describeApiError(409, 'revision_conflict'), /odświeżony/);
  assert.match(describeApiError(403, 'mfa_required'), /MFA/);
  assert.equal(describeApiError(500, 'x'), null);
});

test('ekran: tekst przez textContent (bez innerHTML z treści), confirmAction dla publikacji/wycofania/zatwierdzenia, jedna operacja naraz', () => {
  const main = readFileSync(new URL('../news/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /localStorage|sessionStorage|window\.confirm|\bfetch\s*\(/);
  assert.doesNotMatch(main.replace(/yearSelect\.innerHTML = yearOptionsHtml/, ''), /\.innerHTML\s*=/);
  assert.equal((main.match(/confirmAction\(/g) ?? []).length, 3);
  assert.match(main, /if \(state\.busy\) return;/);
  assert.match(main, /idempotencyKey: state\.createKey/);
  assert.match(main, /byId\("detail-body"\)\.textContent = post\.body/);
  // tylko odczyt zdjęć: żadnych żądań zmieniających rejestr zdjęć
  assert.doesNotMatch(main, /news-photos[^\n]*method:\s*["'](POST|PATCH|PUT|DELETE)["']/);
  assert.doesNotMatch(main, /\/verify|\/revoke|\/consents|\/file/);
});
