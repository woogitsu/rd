// Issue #136, kryterium akceptacji: rg "window.confirm" w katalogach aplikacji nie
// zwraca wyników — zastąpione przez shared/confirm-dialog.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Wszystkie katalogi paneli i strony publicznej oraz wspólne moduły (shared/).
const APP_DIRS = ['admin', 'audit', 'data-export', 'documents', 'email', 'events', 'families', 'import', 'ledger', 'login', 'meetings', 'news', 'panel', 'print', 'reconciliation', 'shared', 'site', 'year-close'];
// Natywne okna przeglądarki: window.confirm/globalThis.confirm oraz goły confirm(…).
const NATIVE_CONFIRM = /(?:\b(?:window|globalThis|self)\.confirm\b|(?<![\w$.])confirm\s*\()/;

// Komentarze mogą wspominać window.confirm (np. „bez window.confirm”) — sprawdzamy kod.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'public') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...jsFiles(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

test('żaden panel nie używa window.confirm', () => {
  const offenders = [];
  for (const app of APP_DIRS) {
    for (const file of jsFiles(join(root, app))) {
      if (NATIVE_CONFIRM.test(stripComments(readFileSync(file, 'utf8')))) offenders.push(file);
    }
  }
  assert.deepEqual(offenders, []);
});

test('wzorzec wykrywa natywne okno i pomija komentarze oraz confirmAction', () => {
  assert.ok(NATIVE_CONFIRM.test('if (window.confirm("x")) go();'));
  assert.ok(NATIVE_CONFIRM.test('if (confirm("x")) go();'));
  assert.ok(!NATIVE_CONFIRM.test(stripComments('// bez window.confirm\nawait confirmAction({});')));
  assert.ok(!NATIVE_CONFIRM.test('await confirmPersonalData({}); api.confirm; x.confirm();'));
});
