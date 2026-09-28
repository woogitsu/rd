// Testy czystych funkcji wspólnego okna potwierdzenia (issue #136).
// confirmAction (DOM, <dialog>) nie jest testowany tu jednostkowo — jak main.js
// pozostałych paneli w tym repozytorium; patrz komentarz w shared/confirm-dialog.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEffectsHtml } from '../shared/confirm-dialog.js';

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
