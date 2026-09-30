// Testy czystych funkcji wspólnej powłoki paneli (issue #85): tests/shell-core.test.js.
// mountShell (DOM + fetch) nie jest tu testowany — jak main.js pozostałych paneli, jest
// wiązany ręcznie; kontrolę dostępu i tak wykonuje wyłącznie serwer (docs/AUTHORIZATION.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { READ_ONLY_BANNER_TEXT, isReadOnlySession, PANELS, activeYearLabel, isActivePanel, mountShell, navItemsHtml, roleLabel, scopeSummary, visiblePanels } from '../shared/shell.js';

const PANEL_IDS = PANELS.map((p) => p.id);

test('visiblePanels: brak przydziału → brak paneli', () => {
  assert.deepEqual(visiblePanels([]), []);
  assert.deepEqual(visiblePanels(undefined), []);
});

test('visiblePanels: admin widzi wszystkie panele poza Kampaniami e-mail i Zamknięciem roku (EDITOR_ROLES/READ_ROLES bez admina), w stałej kolejności', () => {
  // src/pg/routes/email.js EDITOR_ROLES i src/pg/routes/year-close.js READ_ROLES
  // celowo nie wpuszczają admina; panel Komisji Rewizyjnej (audit) jest tylko dla roli audit — to nie luka w PANELS, tylko odzwierciedlenie
  // docs/AUTHORIZATION.md ("admin techniczny: 403").
  const ids = visiblePanels([{ role: 'admin' }]).map((p) => p.id);
  assert.deepEqual(ids, PANEL_IDS.filter((id) => id !== 'email' && id !== 'year-close' && id !== 'audit'));
});

test('visiblePanels: skarbnik widzi rodziny, wpłaty, księgę, kampanie e-mail, uzgodnienia, kartki, dokumenty i zamknięcie roku', () => {
  const ids = visiblePanels([{ role: 'treasurer', schoolYearId: 'y1' }]).map((p) => p.id);
  assert.deepEqual(ids, ['families', 'panel', 'ledger', 'email', 'reconciliation', 'print', 'documents', 'year-close']);
});

test('visiblePanels: przedstawiciel 1A nie widzi wpłat, księgi, uzgodnień, importu, e-maili, zamknięcia roku ani kont', () => {
  const ids = visiblePanels([{ role: 'representative', classId: '1A', schoolYearId: 'y1' }]).map((p) => p.id);
  assert.deepEqual(ids, ['families', 'print', 'events', 'meetings', 'documents', 'data-export', 'news']);
  assert.ok(!ids.includes('panel'));
  assert.ok(!ids.includes('ledger'));
  assert.ok(!ids.includes('reconciliation'));
  assert.ok(!ids.includes('import'));
  assert.ok(!ids.includes('admin'));
  assert.ok(!ids.includes('email'));
  assert.ok(!ids.includes('year-close'));
});

test('visiblePanels: dwa przydziały (przedstawiciel 1A i 2B) — suma linków, bez duplikatów', () => {
  const grants = [
    { role: 'representative', classId: '1A', schoolYearId: 'y1' },
    { role: 'representative', classId: '2B', schoolYearId: 'y1' },
  ];
  const ids = visiblePanels(grants).map((p) => p.id);
  assert.deepEqual(ids, ['families', 'print', 'events', 'meetings', 'documents', 'data-export', 'news']);
});

test('visiblePanels: skarbnik + przedstawiciel — suma uprawnień, stała kolejność', () => {
  const grants = [
    { role: 'treasurer', schoolYearId: 'y1' },
    { role: 'representative', classId: '1A', schoolYearId: 'y1' },
  ];
  const ids = visiblePanels(grants).map((p) => p.id);
  assert.deepEqual(ids, ['families', 'panel', 'ledger', 'email', 'reconciliation', 'print', 'events', 'meetings', 'documents', 'year-close', 'data-export', 'news']);
});

test('visiblePanels: eksport widoczny dla admina, zarządu i przedstawiciela; nie dla skarbnika ani KR', () => {
  for (const role of ['admin', 'board', 'representative']) assert.ok(visiblePanels([{ role, classId: role === 'representative' ? '1A' : undefined }]).some((p) => p.id === 'data-export'), role);
  for (const role of ['treasurer', 'audit']) assert.ok(!visiblePanels([{ role }]).some((p) => p.id === 'data-export'), role);
});

test('visiblePanels: aktualności widoczne dla admina, zarządu i przedstawiciela; nie dla skarbnika ani KR', () => {
  for (const role of ['admin', 'board', 'representative']) assert.ok(visiblePanels([{ role, classId: role === 'representative' ? '1A' : undefined }]).some((p) => p.id === 'news'), role);
  for (const role of ['treasurer', 'audit']) assert.ok(!visiblePanels([{ role }]).some((p) => p.id === 'news'), role);
});

test('visiblePanels: kampanie e-mail widoczne dla zarządu i skarbnika, nie dla administratora bez tych ról', () => {
  assert.ok(visiblePanels([{ role: 'board' }]).some((p) => p.id === 'email'));
  assert.ok(visiblePanels([{ role: 'treasurer' }]).some((p) => p.id === 'email'));
  assert.ok(!visiblePanels([{ role: 'representative', classId: '1A' }]).some((p) => p.id === 'email'));
});

test('visiblePanels: uzgodnienia wyciągu widoczne dla admina, zarządu i skarbnika', () => {
  assert.ok(visiblePanels([{ role: 'admin' }]).some((p) => p.id === 'reconciliation'));
  assert.ok(visiblePanels([{ role: 'board' }]).some((p) => p.id === 'reconciliation'));
  assert.ok(visiblePanels([{ role: 'treasurer' }]).some((p) => p.id === 'reconciliation'));
  assert.ok(!visiblePanels([{ role: 'audit' }]).some((p) => p.id === 'reconciliation'));
});

test('visiblePanels: Komisja Rewizyjna (audit) widzi wyłącznie zebrania i swój raport', () => {
  assert.deepEqual(visiblePanels([{ role: 'audit' }]).map((p) => p.id), ['meetings', 'audit']);
});

test('visiblePanels: dyrekcja (principal) bez domyślnych uprawnień — brak paneli', () => {
  assert.deepEqual(visiblePanels([{ role: 'principal' }]), []);
});

test('visiblePanels: przydział wygasły/cofnięty nie dociera tu wcale (filtrowane przez /api/access)', () => {
  // /api/access (src/pg/routes/session.js) zwraca tylko aktywne przydziały — shell ufa
  // przekazanej liście grantów bez dodatkowej logiki wygaśnięcia.
  assert.deepEqual(visiblePanels([]), []);
});

test('roleLabel: znane role po polsku, nieznana rola zwrócona bez zmian', () => {
  assert.equal(roleLabel('treasurer'), 'Skarbnik');
  assert.equal(roleLabel('representative'), 'Przedstawiciel klasy');
  assert.equal(roleLabel('unknown-role'), 'unknown-role');
});

test('scopeSummary: brak przydziału', () => {
  assert.equal(scopeSummary([]), 'Brak przydzielonej roli');
});

test('scopeSummary: role bez duplikatów (rok pokazuje activeYearLabel)', () => {
  const grants = [
    { role: 'representative', classId: '1A', schoolYearId: '2026-2027' },
    { role: 'representative', classId: '2B', schoolYearId: '2026-2027' },
    { role: 'treasurer', schoolYearId: '2025-2026' },
  ];
  assert.equal(scopeSummary(grants), 'Przedstawiciel klasy, Skarbnik');
});

test('isActivePanel: dopasowanie po ścieżce (prefiks)', () => {
  const families = PANELS.find((p) => p.id === 'families');
  assert.ok(isActivePanel(families, '/families/'));
  assert.ok(isActivePanel(families, '/families/1a'));
  assert.ok(!isActivePanel(families, '/panel/'));
});

test('navItemsHtml: aktywny panel ma aria-current i klasę active, dokładnie jeden na liście', () => {
  const html = navItemsHtml(visiblePanels([{ role: 'admin' }]), '/ledger/');
  const currentCount = (html.match(/aria-current="page"/g) || []).length;
  assert.equal(currentCount, 1);
  assert.match(html, /<a href="\/ledger\/" class="active" aria-current="page">Księga<\/a>/);
});

test('navItemsHtml: etykiety są bezpiecznie zakodowane w HTML (bez wstrzyknięcia)', () => {
  const evil = [{ id: 'x', href: '/x/"><script>alert(1)</script>', label: '<script>alert(1)</script>' }];
  const html = navItemsHtml(evil, '/other/');
  assert.ok(!html.includes('<script>'));
});

test('activeYearLabel: najnowszy rok z przydziałów; bez roku pusty napis', () => {
  const grants = [
    { role: 'treasurer', schoolYearId: '2025-2026' },
    { role: 'representative', classId: '1A', schoolYearId: '2026-2027' },
  ];
  assert.equal(activeYearLabel(grants), 'Rok szkolny 2026/2027');
  assert.equal(activeYearLabel([{ role: 'admin' }]), '');
  assert.equal(activeYearLabel(undefined), '');
});

// mountShell z atrapą DOM i fetch: nawigacja i konto z GET /api/access + /api/session
// (kontrola dostępu i tak po stronie serwera — tu tylko prezentacja).
function fakeDoc() {
  const els = { 'shell-nav': { innerHTML: '' }, 'shell-account': { innerHTML: '' } };
  return { els, getElementById: (id) => els[id] || null };
}
async function withFetch(routes, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const r = routes[url];
    if (!r) throw new Error('no route ' + url);
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  try { return await fn(); } finally { globalThis.fetch = original; }
}
const loc = { pathname: '/families/', search: '', hash: '' };

test('mountShell: przedstawiciel 1A — Rodziny/Kartki/Dokumenty/Wydarzenia, konto z rokiem', async () => {
  const doc = fakeDoc();
  await withFetch({
    '/api/access': { status: 200, body: { grants: [{ role: 'representative', classId: '1A', schoolYearId: '2026-2027' }] } },
    '/api/session': { status: 200, body: { displayName: 'Jan <b>Test</b>' } },
  }, () => mountShell({ document: doc, location: loc }));
  const nav = doc.els['shell-nav'].innerHTML;
  for (const label of ['Rodziny', 'Kartki', 'Dokumenty', 'Wydarzenia']) assert.ok(nav.includes(`>${label}</a>`), label);
  for (const label of ['Wpłaty', 'Księga', 'Import uczniów', 'Konta i role']) assert.ok(!nav.includes(`>${label}</a>`), label);
  const acc = doc.els['shell-account'].innerHTML;
  assert.match(acc, /Rok szkolny 2026\/2027/);
  assert.match(acc, /Przedstawiciel klasy/);
  assert.ok(acc.includes('Jan &lt;b&gt;Test&lt;/b&gt;'));
  assert.match(acc, /id="shell-logout"/);
});

test('mountShell: wygasła sesja/przydział — brak starej nazwy i linków', async () => {
  const doc = fakeDoc();
  doc.els['shell-account'].innerHTML = '<span>Stara Nazwa</span>';
  await withFetch({
    '/api/access': { status: 200, body: { grants: [] } },
    '/api/session': { status: 500, body: {} },
  }, () => mountShell({ document: doc, location: loc }));
  assert.equal(doc.els['shell-nav'].innerHTML, '');
  assert.equal(doc.els['shell-account'].innerHTML, '');
});

// Tryb tylko do odczytu (#143): baner z writeMode z /api/session; bez DOM (atrapa) nic nie wybucha.
function bannerDoc() {
  const doc = fakeDoc();
  const inserted = [];
  doc.body = { firstChild: null, insertBefore: (el) => inserted.push(el) };
  doc.createElement = () => ({ attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
  return { doc, inserted };
}

test('isReadOnlySession: tylko jawne read_only', () => {
  assert.equal(isReadOnlySession({ writeMode: 'read_only' }), true);
  assert.equal(isReadOnlySession({ writeMode: 'normal' }), false);
  assert.equal(isReadOnlySession({}), false);
  assert.equal(isReadOnlySession(null), false);
});

test('mountShell: baner serwisowy przy writeMode=read_only', async () => {
  const { doc, inserted } = bannerDoc();
  await withFetch({
    '/api/access': { status: 200, body: { grants: [{ role: 'treasurer', schoolYearId: '2026-2027' }] } },
    '/api/session': { status: 200, body: { displayName: 'Skarbnik', writeMode: 'read_only' } },
  }, () => mountShell({ document: doc, location: loc }));
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].id, 'shell-write-mode');
  assert.equal(inserted[0].attrs.role, 'status');
  assert.equal(inserted[0].textContent, READ_ONLY_BANNER_TEXT);
  assert.match(READ_ONLY_BANNER_TEXT, /Trwają prace serwisowe — zapisy wstrzymane/);
});

test('mountShell: brak banera w trybie normalnym i bez sesji', async () => {
  for (const body of [{ displayName: 'X', writeMode: 'normal' }, { displayName: 'X' }]) {
    const { doc, inserted } = bannerDoc();
    await withFetch({
      '/api/access': { status: 200, body: { grants: [] } },
      '/api/session': { status: 200, body },
    }, () => mountShell({ document: doc, location: loc }));
    assert.equal(inserted.length, 0);
  }
  const { doc, inserted } = bannerDoc();
  await withFetch({
    '/api/access': { status: 200, body: { grants: [] } },
    '/api/session': { status: 500, body: {} },
  }, () => mountShell({ document: doc, location: loc }));
  assert.equal(inserted.length, 0);
});
