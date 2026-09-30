// Testy czystych funkcji wspólnego okna potwierdzenia (issue #136).
// confirmAction (DOM, <dialog>) testuje tests/e2e/confirm-dialog.spec.js (Playwright).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEffectsHtml, netAfterCorrection, outcomeText } from '../shared/confirm-dialog.js';

test('buildEffectsHtml: pusta lub brakująca lista nie renderuje <ul>', () => {
  assert.equal(buildEffectsHtml([]), '');
  assert.equal(buildEffectsHtml(undefined), '');
});

test('buildEffectsHtml: pomija wpisy puste/undefined/false, zachowuje kolejność', () => {
  const html = buildEffectsHtml(['Pierwszy skutek', '', undefined, false, 'Drugi skutek']);
  assert.equal(html, '<ul><li>Pierwszy skutek</li><li>Drugi skutek</li></ul>');
});

test('buildEffectsHtml: koduje bezpiecznie HTML (bez wstrzyknięcia)', () => {
  const html = buildEffectsHtml(['<script>alert(1)</script>']);
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
});

test('outcomeText: powtórka zapisu mówi „operacja była już wykonana”, nowy zapis — sam komunikat', () => {
  assert.equal(outcomeText('Zapisano wpłatę.', false), 'Zapisano wpłatę.');
  assert.match(outcomeText('Zapisano wpłatę.', true), /^Zapisano wpłatę\. \(operacja była już wykonana/);
  assert.match(outcomeText('Dodano korektę.', true), /nie utworzono drugiego zapisu/);
});

test('netAfterCorrection: wpłata częściowo skorygowana — netto przed i po kolejnej korekcie', () => {
  // Wpłata 50,00 EUR z wcześniejszą korektą 10,00 EUR (netto 40,00), nowa korekta 15,00.
  assert.deepEqual(netAfterCorrection(4000, 1500), { beforeCents: 4000, afterCents: 2500, exceeds: false });
  assert.deepEqual(netAfterCorrection(4000, 4000), { beforeCents: 4000, afterCents: 0, exceeds: false });
  assert.equal(netAfterCorrection(4000, 5000).exceeds, true);
});

test('netAfterCorrection: brak wyniku przy niepoliczalnych wartościach', () => {
  assert.equal(netAfterCorrection(undefined, 100), null);
  assert.equal(netAfterCorrection(4000, Number.NaN), null);
  assert.equal(netAfterCorrection(4000, 0), null);
  assert.equal(netAfterCorrection(4000, 12.5), null);
});
