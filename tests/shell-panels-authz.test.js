// #226: shared/shell.js (PANELS) jest teraz JEDYNYM źródłem listy modułów i ich
// widoczności wg roli dla wszystkich paneli (wcześniej każdy panel miał osobny,
// ręcznie wpisany pasek nawigacji — patrz scratchpad przeglądu UI, pkt 4). Ten test
// pilnuje, żeby lista ról każdego wpisu PANELS odpowiadała temu, co faktycznie
// wdrożono po stronie serwera (docs/AUTHORIZATION.md, src/pg/routes/**,
// src/pg/events.js, src/pg/meetings.js) — zgodnie z zasadą z AGENTS.md, że UI
// wyłącznie ukrywa linki, a nie rozstrzyga uprawnień. Metoda (wyciąganie stałych
// regexem z plików źródłowych) jest taka sama jak w tests/role-policy-parity.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PANELS, visiblePanels } from '../shared/shell.js';
import { STATIC_PREFIXES } from '../src/node-app.js';

const src = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const packageJson = () => JSON.parse(src('package.json'));

// Wyciąga role z `const NAME = ['a', 'b'];` — nie obsługuje spreadu (np. PRINT_ROLES),
// te są liczone ręcznie niżej z komentarzem.
function rolesConst(path, name) {
  const match = src(path).match(new RegExp(`(?:export )?const ${name} = (?:Object\\.freeze\\()?\\[([^\\]]*)\\]`));
  assert.ok(match, `${path}: brak stałej ${name}`);
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

const panelById = Object.fromEntries(PANELS.map((p) => [p.id, p]));

test('PANELS: unikalne id, href zaczyna/kończy się na "/", niepusta polska etykieta', () => {
  const ids = new Set();
  for (const panel of PANELS) {
    assert.ok(!ids.has(panel.id), `zduplikowane id: ${panel.id}`);
    ids.add(panel.id);
    assert.match(panel.href, /^\/[a-z-]+\/$/, panel.id);
    assert.ok(panel.label && panel.label.length > 0, panel.id);
    assert.ok(Array.isArray(panel.roles) && panel.roles.length > 0, `${panel.id}: pusta lista ról`);
  }
});

// Pilnuje, żeby PANELS i STATIC_PREFIXES (src/node-app.js) nigdy się nie rozjechały:
// dodanie nowego panelu bez wpisu w PANELS (lub odwrotnie) ma wywalić test, zanim
// trafi do produkcji. `login` i `site` celowo nie mają wpisu w PANELS — `login` to
// ekran logowania (bez nawigacji powłoki), `site` to jedyny publiczny prefiks
// (PUBLIC_STATIC_PREFIX w src/node-app.js), obydwa poza zakresem tej nawigacji.
const NAV_EXEMPT_PREFIXES = new Set(['login', 'site']);

test('każdy prefiks z STATIC_PREFIXES poza login/site ma wpis w PANELS', () => {
  for (const prefix of STATIC_PREFIXES) {
    if (NAV_EXEMPT_PREFIXES.has(prefix)) continue;
    assert.ok(panelById[prefix], `STATIC_PREFIXES zawiera "${prefix}", ale brak go w PANELS (shared/shell.js)`);
  }
});

test('każdy wpis PANELS ma prefiks w STATIC_PREFIXES', () => {
  for (const panel of PANELS) {
    assert.ok(STATIC_PREFIXES.has(panel.id), `PANELS zawiera "${panel.id}", ale brak go w STATIC_PREFIXES (src/node-app.js)`);
  }
});

test('każdy wpis PANELS ma skrypt build:<panel> w łańcuchu "build" package.json', () => {
  const pkg = packageJson();
  const buildChain = pkg.scripts && pkg.scripts.build;
  assert.ok(buildChain, 'brak skryptu "build" w package.json');
  for (const panel of PANELS) {
    const scriptName = `build:${panel.id}`;
    assert.ok(pkg.scripts[scriptName], `brak skryptu "${scriptName}" w package.json`);
    assert.ok(
      buildChain.includes(`npm run ${scriptName}`),
      `skrypt "build" w package.json nie wywołuje "npm run ${scriptName}" dla panelu "${panel.id}"`,
    );
  }
});

test('families: role jak READ_ROLES w src/pg/routes/families.js', () => {
  assert.deepEqual([...panelById.families.roles].sort(), rolesConst('src/pg/routes/families.js', 'READ_ROLES').sort());
});

test('panel (Wpłaty): role jak FINANCIAL_ROLES w src/pg/routes/payments.js', () => {
  assert.deepEqual([...panelById.panel.roles].sort(), rolesConst('src/pg/routes/payments.js', 'FINANCIAL_ROLES').sort());
});

test('ledger (Księga): role jak FINANCIAL_ROLES w src/pg/routes/ledger.js', () => {
  assert.deepEqual([...panelById.ledger.roles].sort(), rolesConst('src/pg/routes/ledger.js', 'FINANCIAL_ROLES').sort());
});

test('reconciliation (Uzgodnienia wyciągu): role jak WRITE_ROLES w src/pg/routes/reconciliation.js', () => {
  // REPORT_ROLES (+audit) daje wyłącznie dostęp do raportu dla Komisji Rewizyjnej,
  // który dziś nie ma osobnego, dostępnego dla audytu ekranu w tym panelu
  // (reconciliation/main.js#applyAccess ukrywa cały formularz filtrów bez WRITE_ROLES)
  // — audit celowo NIE widzi tego linku w nawigacji.
  assert.deepEqual([...panelById.reconciliation.roles].sort(), rolesConst('src/pg/routes/reconciliation.js', 'WRITE_ROLES').sort());
});

test('print (Kartki): role jak PRINT_ROLES (FINANCIAL_ROLES + representative) w src/pg/routes/print.js', () => {
  const source = src('src/pg/routes/print.js');
  assert.match(source, /const PRINT_ROLES = \[\.\.\.FINANCIAL_ROLES, 'representative'\]/, 'PRINT_ROLES nie jest już FINANCIAL_ROLES + representative — zaktualizuj ten test');
  const financial = rolesConst('src/pg/routes/print.js', 'FINANCIAL_ROLES');
  assert.deepEqual([...panelById.print.roles].sort(), [...financial, 'representative'].sort());
});

test('events (Wydarzenia): role jak suma EVENT_POLICY w src/pg/events.js', () => {
  const source = src('src/pg/events.js');
  const roles = new Set();
  for (const match of source.matchAll(/Object\.freeze\(\[([^\]]*)\]\)/g)) {
    for (const m of match[1].matchAll(/'([a-z_]+)'/g)) roles.add(m[1]);
  }
  assert.deepEqual([...panelById.events.roles].sort(), [...roles].sort());
});

test('documents (Dokumenty): role jak suma DOCUMENT_POLICIES w src/pg/routes/documents.js', () => {
  const source = src('src/pg/routes/documents.js');
  const roles = new Set();
  for (const match of source.matchAll(/roles: \[([^\]]*)\]/g)) {
    for (const m of match[1].matchAll(/'([a-z_]+)'/g)) roles.add(m[1]);
  }
  assert.deepEqual([...panelById.documents.roles].sort(), [...roles].sort());
});

test('email (Kampanie e-mail): role jak EDITOR_ROLES w src/pg/routes/email.js (admin BEZ dostępu)', () => {
  assert.deepEqual([...panelById.email.roles].sort(), rolesConst('src/pg/routes/email.js', 'EDITOR_ROLES').sort());
  assert.ok(!panelById.email.roles.includes('admin'), 'admin nie ma dostępu do /api/email/* (EDITOR_ROLES)');
});

test('import (Import uczniów): role jak IMPORT_ROLES w src/pg/routes/import.js', () => {
  assert.deepEqual([...panelById.import.roles].sort(), rolesConst('src/pg/routes/import.js', 'IMPORT_ROLES').sort());
});

test('year-close (Zamknięcie roku): role jak READ_ROLES w src/pg/routes/year-close.js (admin i audit BEZ dostępu)', () => {
  assert.deepEqual([...panelById['year-close'].roles].sort(), rolesConst('src/pg/routes/year-close.js', 'READ_ROLES').sort());
  assert.ok(!panelById['year-close'].roles.includes('admin'), 'admin: 403 na trasach /api/year-close/* (docs/AUTHORIZATION.md)');
  assert.ok(!panelById['year-close'].roles.includes('audit'), 'Komisja Rewizyjna: 403 na trasach /api/year-close/* (docs/AUTHORIZATION.md)');
});

test('exports (Eksport): suma ról YEARLY_EXPORT_ROLES i ROSTER_ROLES w src/pg/routes/exports.js (skarbnik i audit BEZ dostępu)', () => {
  const yearly = rolesConst('src/pg/routes/exports.js', 'YEARLY_EXPORT_ROLES');
  const roster = rolesConst('src/pg/routes/exports.js', 'ROSTER_ROLES');
  assert.deepEqual([...panelById['data-export'].roles].sort(), [...new Set([...yearly, ...roster])].sort());
  assert.ok(!panelById['data-export'].roles.includes('treasurer'));
  assert.ok(!panelById['data-export'].roles.includes('audit'));
});

test('news (Aktualności): suma ról draftSchoolWide, draftClass i review z NEWS_POLICY w src/pg/news.js (skarbnik i audit BEZ dostępu)', () => {
  const policy = src('src/pg/news.js').match(/export const NEWS_POLICY = Object\.freeze\(\{([\s\S]*?)\}\);/)[1];
  const roles = new Set();
  for (const key of ['draftSchoolWide', 'draftClass', 'review']) {
    for (const m of policy.match(new RegExp(`${key}: Object\\.freeze\\(\\[([^\\]]*)\\]`))[1].matchAll(/'([a-z_]+)'/g)) roles.add(m[1]);
  }
  assert.deepEqual([...panelById.news.roles].sort(), [...roles].sort());
  assert.ok(!panelById.news.roles.includes('treasurer'));
  assert.ok(!panelById.news.roles.includes('audit'));
});

test('admin (Konta i role): wyłącznie admin', () => {
  assert.deepEqual([...panelById.admin.roles], ['admin']);
});

test('meetings (Zebrania): admin/board/audit widzą pełne zebrania (MANAGE_ROLES/READ_ROLES), representative — wyłącznie udostępnione protokoły', () => {
  // src/pg/meetings.js: MANAGE_ROLES=[admin,board], READ_ROLES=[admin,board,audit].
  // listSharedMinutes degraduje przedstawiciela do jego własnych klas zamiast
  // odrzucać żądanie (patrz komentarz przy funkcji) — to jedyny wpis PANELS, gdzie
  // suma ról z pojedynczej stałej serwera nie wystarcza, dlatego role są wpisane
  // ręcznie tu i w shared/shell.js, a nie wyciągane regexem z jednej stałej.
  assert.deepEqual(rolesConst('src/pg/meetings.js', 'MANAGE_ROLES'), ['admin', 'board']);
  assert.deepEqual(rolesConst('src/pg/meetings.js', 'READ_ROLES'), ['admin', 'board', 'audit']);
  assert.deepEqual([...panelById.meetings.roles].sort(), ['admin', 'audit', 'board', 'representative']);
});

test('audit (Komisja Rewizyjna): tylko rola audit, a ta rola jest w REPORT_ROLES trasy raportu', () => {
  assert.deepEqual([...panelById.audit.roles], ['audit']);
  assert.ok(rolesConst('src/pg/routes/reconciliation.js', 'REPORT_ROLES').includes('audit'));
});

test('Komisja Rewizyjna (audit) widzi wyłącznie Zebrania i swój raport — nie widzi Uzgodnień, Kampanii e-mail ani Zamknięcia roku', () => {
  const ids = visiblePanels([{ role: 'audit' }]).map((p) => p.id);
  assert.deepEqual(ids, ['meetings', 'audit']);
});

test('ekran Komisji Rewizyjnej nie jest widoczny dla zarządu, skarbnika, przedstawiciela ani admina', () => {
  for (const role of ['board', 'treasurer', 'admin', 'representative']) {
    assert.ok(!visiblePanels([{ role, classId: role === 'representative' ? '1A' : undefined }]).some((p) => p.id === 'audit'), role);
  }
});

test('przedstawiciel klasy widzi wyłącznie moduły klasowe — nigdy finansów ogólnoszkolnych ani administracji', () => {
  const ids = visiblePanels([{ role: 'representative', classId: '1A', schoolYearId: 'y1' }]);
  const idSet = new Set(ids.map((p) => p.id));
  for (const forbidden of ['ledger', 'reconciliation', 'email', 'year-close', 'import', 'admin']) {
    assert.ok(!idSet.has(forbidden), `przedstawiciel nie powinien widzieć: ${forbidden}`);
  }
});
