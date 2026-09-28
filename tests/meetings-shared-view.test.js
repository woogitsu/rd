// #167: przedstawiciel bez roli z READ_ROLES otwierający /meetings/ nie może
// dostać 403 z GET /api/meetings — musi zobaczyć widok "Protokoły udostępnione"
// (GET /api/meetings/shared-minutes) albo komunikat "Brak udostępnionych
// protokołów". Statyczny przegląd kodu — scenariusze ról sprawdza
// tests/meetings-core.test.js (meetingsViewMode) i backend w tests/pg-meetings.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mainJs = readFileSync(new URL('../meetings/main.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../meetings/index.html', import.meta.url), 'utf8');

test('meetings/main.js sprawdza tryb widoku PRZED pierwszym wywołaniem listy', () => {
  // GET /api/access jest wołane raz, a loadList()/loadSharedList() dopiero po
  // otrzymaniu odpowiedzi — nie ma "z góry skazanego na 403" zapytania.
  assert.match(mainJs, /api\("\/api\/access"\)\.then\(/);
  assert.match(mainJs, /meetingsViewMode\(grants\)/);
  const startBlock = mainJs.slice(mainJs.indexOf('// ---------- start ----------'));
  assert.match(startBlock, /if \(state\.viewMode === "shared"\) \{\s*\n\s*loadSharedList\(\);/);
});

test('widok "shared" i "full" są rozłączne w HTML (jeden z dwóch, nigdy oba naraz)', () => {
  assert.match(html, /<section class="block" id="list-section"/);
  assert.match(html, /<section class="block" id="shared-section"[^>]*hidden>/);
  assert.match(mainJs, /byId\("list-section"\)\.hidden = mode !== "full"/);
  assert.match(mainJs, /byId\("shared-section"\)\.hidden = mode !== "shared"/);
});

test('widok przedstawiciela nie pokazuje obecności, quorum ani projektów uchwał', () => {
  const sharedSection = html.slice(html.indexOf('id="shared-section"'), html.indexOf('id="shared-section"') + 1500);
  for (const forbidden of ['attendance', 'quorum', 'resolution']) {
    assert.ok(!sharedSection.toLowerCase().includes(forbidden), `sekcja shared-section nie powinna zawierać "${forbidden}"`);
  }
});

test('"Nowe zebranie" ukryte, dopóki tryb widoku nie jest znany i poza trybem "full"', () => {
  assert.match(mainJs, /byId\("open-meeting"\)\.hidden = true;\s*\n\s*byId\("list-section"\)\.hidden = true;/);
  assert.match(mainJs, /byId\("open-meeting"\)\.hidden = mode !== "full" \|\| !state\.canManage;/);
});
