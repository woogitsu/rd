// Czyste funkcje ekranu „Nowy rok: promocja uczniów” (#78). Dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAP_FINAL, MAP_SKIP, attentionStudents, canApplyPromotion, missingRepresentativeNote, newPromotionKey, parseExclusions,
  promotionBody, promotionConfirmation, promotionResultMessage, promotionRows, promotionSummary,
} from '../admin/promotion.js';
import { ERROR_MESSAGES, errorMessage } from '../admin/core.js';

const PLAN = {
  counts: { promote: 3, graduating: 1, unmapped: 0, excluded: 1, conflict: 1, withdrawn: 0 },
  planDigest: 'a'.repeat(64),
  classes: [
    { fromClassId: 'c-1a', fromName: '1A', toClassId: 'c-2a', toName: '2A', mapped: true, total: 3, promote: 2, graduating: 0, unmapped: 0, excluded: 1, conflict: 0, withdrawn: 0 },
    { fromClassId: 'c-8a', fromName: '8A', toClassId: null, toName: null, mapped: true, total: 1, promote: 0, graduating: 1, unmapped: 0, excluded: 0, conflict: 0, withdrawn: 0 },
    { fromClassId: 'c-3a', fromName: '3A', toClassId: null, toName: null, mapped: false, total: 2, promote: 1, graduating: 0, unmapped: 0, excluded: 0, conflict: 1, withdrawn: 0 },
  ],
  students: [
    { studentId: 's-1', fromClassId: 'c-1a', status: 'promote' },
    { studentId: 's-2', fromClassId: 'c-3a', status: 'conflict' },
  ],
  missingRepresentative: [{ classId: 'c-2a', name: '2A' }],
};

test('promotionBody: mapa bez „nie przenoś”, klasa końcowa jako null, wykluczenia bez powtórzeń', () => {
  const body = promotionBody({
    fromSchoolYearId: 'y-1', toSchoolYearId: 'y-2',
    mapping: { 'c-1a': 'c-2a', 'c-8a': MAP_FINAL, 'c-3a': MAP_SKIP },
    exclusionsText: 's-1\ns-1, s-2',
  });
  assert.deepEqual(body, { fromSchoolYearId: 'y-1', toSchoolYearId: 'y-2', classMap: { 'c-1a': 'c-2a', 'c-8a': null }, exclusions: ['s-1', 's-2'] });
});

test('promotionBody: te same lata, pusta mapa i zły identyfikator ucznia to błędy', () => {
  const base = { fromSchoolYearId: 'y-1', toSchoolYearId: 'y-2', mapping: { 'c-1a': 'c-2a' } };
  assert.throws(() => promotionBody({ ...base, toSchoolYearId: 'y-1' }), /różne/);
  assert.throws(() => promotionBody({ ...base, fromSchoolYearId: '' }), /Wybierz rok/);
  assert.throws(() => promotionBody({ ...base, mapping: { 'c-1a': MAP_SKIP } }), /przynajmniej jednej/);
  assert.throws(() => promotionBody({ ...base, exclusionsText: 'zły id!' }), /Niepoprawny identyfikator/);
  assert.deepEqual(parseExclusions(''), []);
});

test('canApplyPromotion wymaga skrótu planu i choć jednego ucznia do przeniesienia', () => {
  assert.equal(canApplyPromotion(PLAN), true);
  assert.equal(canApplyPromotion({ ...PLAN, counts: { ...PLAN.counts, promote: 0 } }), false);
  assert.equal(canApplyPromotion({ counts: PLAN.counts }), false);
  assert.equal(canApplyPromotion(null), false);
});

test('podsumowanie, wiersze i uczniowie wymagający uwagi (bez imion)', () => {
  assert.match(promotionSummary(PLAN), /^Do przeniesienia: 3; .*konflikt\)?: 1/);
  assert.match(promotionSummary({ ...PLAN, counts: { promote: 0, graduating: 0, unmapped: 0, excluded: 0, conflict: 0, withdrawn: 0 } }), /żadnych przypisań/);
  assert.deepEqual(promotionRows(PLAN).map((row) => row.toName), ['2A', 'Klasa końcowa', '— (poza mapą)']);
  const names = new Map(PLAN.classes.map((row) => [row.fromClassId, row.fromName]));
  assert.deepEqual(attentionStudents(PLAN, names), [{ studentId: 's-2', status: 'Już przypisani w roku docelowym (konflikt)', fromName: '3A' }]);
});

test('klasy bez przedstawiciela: tekst nie obiecuje przedłużenia przydziałów', () => {
  assert.match(missingRepresentativeNote(PLAN), /2A.*nie przedłuża przydziałów/);
  assert.match(missingRepresentativeNote({ missingRepresentative: [] }), /ma aktywnego przedstawiciela/);
});

test('klucz zatwierdzenia i komunikaty wyniku', () => {
  assert.equal(newPromotionKey(() => 'x'), 'promo-x');
  assert.notEqual(newPromotionKey(), newPromotionKey());
  assert.match(promotionResultMessage({ replayed: true, counts: PLAN.counts }), /już zapisana/);
  assert.match(promotionResultMessage({ replayed: false, counts: PLAN.counts }), /3/);
  const dialog = promotionConfirmation(PLAN, { from: '2026/2027', to: '2027/2028' });
  assert.equal(dialog.confirmLabel, 'Zastosuj promocję');
  assert.ok(dialog.effects.some((text) => text.includes('2026/2027') && text.includes('3')));
});

test('kody błędów promocji mają polskie komunikaty', () => {
  for (const code of ['plan_stale', 'class_map_required', 'nothing_to_promote', 'unknown_student', 'school_year_closed', 'idempotency_key_reused', 'invalid_year_order']) {
    assert.ok(Object.hasOwn(ERROR_MESSAGES, code) || !/kod techniczny/.test(errorMessage(code, 409)), code);
    assert.doesNotMatch(errorMessage(code, 409), /kod techniczny/, code);
  }
});
