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

test('przycisk „Pokaż” w widoku przedstawiciela używa minutesId z odpowiedzi shared-minutes (regresja #167)', () => {
  const render = mainJs.slice(mainJs.indexOf('function renderSharedList()'), mainJs.indexOf('async function loadSharedList()'));
  assert.match(render, /dataset: \{ shared: item\.minutesId \}/);
  assert.ok(!/dataset: \{ shared: item\.id \}/.test(render));
  assert.match(mainJs, /findSharedMinutes\(state\.sharedMinutes, button\.dataset\.shared\)/);
});

test('„Drukuj / zapisz jako PDF” działa w widoku przedstawiciela bez state.detail, bez obecności i quorum (#167 pkt 2)', () => {
  const handler = mainJs.slice(mainJs.indexOf('byId("print-minutes-button").addEventListener'));
  assert.match(handler.slice(0, 600), /if \(state\.viewMode === "shared"\) fillSharedPrintMinutes\(item\);/);
  const fn = mainJs.match(/function fillSharedPrintMinutes\(item\) \{[\s\S]*?\n\}\n/)[0];
  assert.ok(!/api\(|fetch\(/.test(fn), 'wydruk nie woła sieci');
  assert.ok(!/state\.detail|attendee|quorumChecks|location/.test(fn), 'tylko pola z odpowiedzi shared-minutes');
  for (const forbidden of ['email', 'displayName', 'userId', 'guardian', 'phone', 'address']) {
    assert.ok(!fn.includes(forbidden), `wydruk protokołu udostępnionego nie może używać pola ${forbidden}`);
  }
  assert.match(fn, /byId\("print-attendance-block"\)\.hidden = true;/);
  assert.match(fn, /byId\("print-signatures"\)\.hidden = true;/);
  // Pełny widok (zarząd) przywraca listę obecności i podpisy po wydruku z widoku przedstawiciela.
  const full = mainJs.match(/function fillPrintMinutes\(item\) \{[\s\S]*?\n\}\n/)[0];
  assert.match(full, /byId\("print-attendance-block"\)\.hidden = false;/);
  assert.match(full, /byId\("print-signatures"\)\.hidden = false;/);
  const section = html.match(/<section id="print-minutes"[\s\S]*?<\/section>/)[0];
  const block = section.match(/<div id="print-attendance-block">[\s\S]*?<\/div>/)[0];
  assert.match(block, /print-attendance-body/);
  assert.match(block, /print-quorum-result/);
});
