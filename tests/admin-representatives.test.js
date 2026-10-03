// Czyste funkcje kroku „Przedłużenie przydziałów przedstawicieli” (#78). Dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REPRESENTATIVE_ERROR_MESSAGES, applyFailureAction, canApplyRepresentatives, representativesApplyBody, representativesBody,
  representativesConfirmation, representativesErrorMessage, representativesResultMessage, representativesRows,
  representativesSummary, withoutRepresentativeNote,
} from '../admin/representatives-core.js';
import { MAP_FINAL, MAP_SKIP } from '../admin/promotion.js';

const PLAN = {
  fromSchoolYearId: 'y-1', toSchoolYearId: 'y-2',
  counts: { propose: 2, already_granted: 1, user_disabled: 1 },
  proposals: [
    { userId: 'u-1', fromClassId: 'c-1a', toClassId: 'c-2a', status: 'propose' },
    { userId: 'u-2', fromClassId: 'c-1a', toClassId: 'c-2a', status: 'propose' },
    { userId: 'u-3', fromClassId: 'c-1b', toClassId: 'c-2b', status: 'already_granted' },
    { userId: 'u-4', fromClassId: 'c-1b', toClassId: 'c-2b', status: 'user_disabled' },
  ],
  withoutRepresentative: [{ classId: 'c-2c', name: '2C' }],
  planDigest: 'b'.repeat(64),
};
const BODY = { fromSchoolYearId: 'y-1', toSchoolYearId: 'y-2', classMap: { 'c-1a': 'c-2a', 'c-1b': 'c-2b', 'c-1c': 'c-2c' } };
const NAMES = new Map([['c-1a', '1A'], ['c-1b', '1B'], ['c-1c', '1C'], ['c-2a', '2A'], ['c-2b', '2B'], ['c-2c', '2C']]);

test('representativesBody: pomija „nie przenoś” i klasę końcową, wymaga różnych lat i choć jednej klasy', () => {
  const body = representativesBody({
    fromSchoolYearId: 'y-1', toSchoolYearId: 'y-2',
    mapping: { 'c-1a': 'c-2a', 'c-8a': MAP_FINAL, 'c-3a': MAP_SKIP },
  });
  assert.deepEqual(body, { fromSchoolYearId: 'y-1', toSchoolYearId: 'y-2', classMap: { 'c-1a': 'c-2a' } });
  const base = { fromSchoolYearId: 'y-1', toSchoolYearId: 'y-2', mapping: { 'c-1a': 'c-2a' } };
  assert.throws(() => representativesBody({ ...base, toSchoolYearId: 'y-1' }), /różne/);
  assert.throws(() => representativesBody({ ...base, fromSchoolYearId: '' }), /Wybierz rok/);
  assert.throws(() => representativesBody({ ...base, mapping: { 'c-8a': MAP_FINAL } }), /przynajmniej jednej/);
});

test('representativesApplyBody: skrót planu i confirm = id roku docelowego', () => {
  assert.deepEqual(representativesApplyBody(BODY, PLAN), { ...BODY, planDigest: 'b'.repeat(64), confirm: 'y-2' });
});

test('canApplyRepresentatives wymaga skrótu planu i nowych przydziałów', () => {
  assert.equal(canApplyRepresentatives(PLAN), true);
  assert.equal(canApplyRepresentatives({ ...PLAN, counts: { propose: 0, already_granted: 3, user_disabled: 0 } }), false);
  assert.equal(canApplyRepresentatives({ counts: PLAN.counts }), false);
  assert.equal(canApplyRepresentatives(null), false);
});

test('podsumowanie: nowe, już przydzieleni, konta wyłączone', () => {
  assert.match(representativesSummary(PLAN), /^Nowe przydziały do utworzenia: 2; już przydzieleni w roku docelowym: 1; konta wyłączone \(pominięte\): 1\.$/);
  assert.match(representativesSummary({ counts: { propose: 0, already_granted: 0, user_disabled: 0 } }), /nie mają aktywnych przedstawicieli/);
  assert.match(representativesSummary({ counts: { propose: 0, already_granted: 2, user_disabled: 0 } }), /Nic nie zostanie zapisane/);
  assert.equal(representativesSummary(null), '');
});

test('wiersze per klasa docelowa: liczby i znacznik braku przedstawiciela, bez identyfikatorów kont', () => {
  const rows = representativesRows(PLAN, BODY, NAMES);
  assert.deepEqual(rows, [
    { toName: '2A', fromNames: '1A', propose: 2, alreadyGranted: 0, disabled: 0, withoutRepresentative: false },
    { toName: '2B', fromNames: '1B', propose: 0, alreadyGranted: 1, disabled: 1, withoutRepresentative: false },
    { toName: '2C', fromNames: '1C', propose: 0, alreadyGranted: 0, disabled: 0, withoutRepresentative: true },
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /u-\d/);
  assert.deepEqual(representativesRows(null, null), []);
});

test('klasy bez przedstawiciela: notatka z nazwami albo potwierdzenie pokrycia', () => {
  assert.match(withoutRepresentativeNote(PLAN), /2C.*partia zaproszeń/);
  assert.match(withoutRepresentativeNote({ withoutRepresentative: [] }), /będzie miała aktywnego przedstawiciela/);
});

test('okno potwierdzenia opisuje skutek: nowe przydziały, stare bez zmian, MFA', () => {
  const dialog = representativesConfirmation(PLAN, { from: '2026/2027', to: '2027/2028' });
  assert.equal(dialog.confirmLabel, 'Przedłuż przydziały');
  const text = dialog.effects.join('\n');
  assert.match(text, /2026\/2027 → 2027\/2028.*: 2\./);
  assert.match(text, /roku źródłowego zostają bez zmian/);
  assert.match(text, /\(1\)/);
  assert.match(text, /MFA/);
});

test('komunikaty wyniku: nowe, powtórzenie i pominięte konta', () => {
  assert.match(representativesResultMessage({ created: 2, alreadyGranted: 1, skipped: 1, replayed: false }), /nowe: 2, już istniały: 1; pominięto konta wyłączone: 1/);
  assert.doesNotMatch(representativesResultMessage({ created: 2, alreadyGranted: 0, skipped: 0 }), /pominięto/);
  assert.match(representativesResultMessage({ created: 0, alreadyGranted: 3, skipped: 0, replayed: true }), /już zapisane/);
});

test('własne konto admina (#745): podsumowanie, okno potwierdzenia i wynik mówią, że jest pominięte', () => {
  const plan = { ...PLAN, counts: { propose: 1, already_granted: 0, user_disabled: 1, cannot_grant_self: 1 } };
  assert.match(representativesSummary(plan), /konta wyłączone \(pominięte\): 1; Twoje konto \(pominięte — przydział nadaje inny administrator\): 1\.$/);
  assert.match(representativesSummary({ counts: { propose: 0, already_granted: 0, user_disabled: 0, cannot_grant_self: 1 } }), /Nic nie zostanie zapisane/);
  assert.match(representativesConfirmation(plan, { from: 'a', to: 'b' }).effects.join('\n'), /Twoje konto jest pomijane: rolę przedstawiciela nadaje Ci inny administrator/);
  assert.doesNotMatch(representativesConfirmation(PLAN, { from: 'a', to: 'b' }).effects.join('\n'), /Twoje konto/);
  const message = representativesResultMessage({ created: 1, alreadyGranted: 0, skipped: 2, skippedSelf: 1, replayed: false });
  assert.match(message, /pominięto konta wyłączone: 1; pominięto Twoje konto \(przydział nadaje inny administrator\): 1\.$/);
  assert.doesNotMatch(representativesResultMessage({ created: 1, alreadyGranted: 0, skipped: 1, skippedSelf: 1 }), /konta wyłączone/);
});

test('obsługa błędów zatwierdzenia: 409 plan_stale odświeża, 422 nothing_to_extend czyści, sieć pozwala ponowić', () => {
  assert.equal(applyFailureAction({ status: 409, code: 'plan_stale' }), 'refresh');
  assert.equal(applyFailureAction({ status: 422, code: 'nothing_to_extend' }), 'reset');
  assert.equal(applyFailureAction({ status: 409, code: 'school_year_closed' }), 'reset');
  assert.equal(applyFailureAction({ network: true, status: 0 }), 'retry');
  for (const code of ['plan_stale', 'nothing_to_extend']) {
    assert.equal(representativesErrorMessage({ code, message: 'techniczny' }), REPRESENTATIVE_ERROR_MESSAGES[code]);
  }
  assert.equal(representativesErrorMessage({ code: 'inny', message: 'Komunikat serwera' }), 'Komunikat serwera');
  assert.match(REPRESENTATIVE_ERROR_MESSAGES.plan_stale, /odświeżony/);
});
