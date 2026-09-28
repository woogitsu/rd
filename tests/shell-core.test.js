// Testy czystych funkcji wspólnej powłoki paneli (issue #85): tests/shell-core.test.js.
// mountShell (DOM + fetch) nie jest tu testowany — jak main.js pozostałych paneli, jest
// wiązany ręcznie; kontrolę dostępu i tak wykonuje wyłącznie serwer (docs/AUTHORIZATION.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PANELS, isActivePanel, navItemsHtml, roleLabel, scopeSummary, visiblePanels } from '../shared/shell.js';

const PANEL_IDS = PANELS.map((p) => p.id);

test('visiblePanels: brak przydziału → brak paneli', () => {
  assert.deepEqual(visiblePanels([]), []);
  assert.deepEqual(visiblePanels(undefined), []);
});

test('visiblePanels: admin widzi wszystkie panele poza Kampaniami e-mail i Zamknięciem roku (EDITOR_ROLES/READ_ROLES bez admina), w stałej kolejności', () => {
  // src/pg/routes/email.js EDITOR_ROLES i src/pg/routes/year-close.js READ_ROLES
  // celowo nie wpuszczają admina — to nie luka w PANELS, tylko odzwierciedlenie
  // docs/AUTHORIZATION.md ("admin techniczny: 403").
  const ids = visiblePanels([{ role: 'admin' }]).map((p) => p.id);
  assert.deepEqual(ids, PANEL_IDS.filter((id) => id !== 'email' && id !== 'year-close'));
});

test('visiblePanels: skarbnik widzi rodziny, wpłaty, księgę, uzgodnienia, kartki, dokumenty, kampanie e-mail i zamknięcie roku', () => {
  const ids = visiblePanels([{ role: 'treasurer', schoolYearId: 'y1' }]).map((p) => p.id);
  assert.deepEqual(ids, ['families', 'panel', 'ledger', 'reconciliation', 'print', 'documents', 'email', 'year-close']);
});

test('visiblePanels: przedstawiciel 1A nie widzi wpłat, księgi, uzgodnień, importu, e-maili, zamknięcia roku ani kont', () => {
  const ids = visiblePanels([{ role: 'representative', classId: '1A', schoolYearId: 'y1' }]).map((p) => p.id);
  assert.deepEqual(ids, ['families', 'print', 'events', 'meetings', 'documents']);
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
  assert.deepEqual(ids, ['families', 'print', 'events', 'meetings', 'documents']);
});

test('visiblePanels: skarbnik + przedstawiciel — suma uprawnień, stała kolejność', () => {
  const grants = [
    { role: 'treasurer', schoolYearId: 'y1' },
    { role: 'representative', classId: '1A', schoolYearId: 'y1' },
  ];
  const ids = visiblePanels(grants).map((p) => p.id);
  assert.deepEqual(ids, ['families', 'panel', 'ledger', 'reconciliation', 'print', 'events', 'meetings', 'documents', 'email', 'year-close']);
});

test('visiblePanels: Komisja Rewizyjna (audit) widzi wyłącznie zebrania', () => {
  assert.deepEqual(visiblePanels([{ role: 'audit' }]).map((p) => p.id), ['meetings']);
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

test('scopeSummary: role i lata bez duplikatów, posortowane', () => {
  const grants = [
    { role: 'representative', classId: '1A', schoolYearId: '2026-2027' },
    { role: 'representative', classId: '2B', schoolYearId: '2026-2027' },
    { role: 'treasurer', schoolYearId: '2025-2026' },
  ];
  assert.equal(scopeSummary(grants), 'Przedstawiciel klasy, Skarbnik · 2025-2026, 2026-2027');
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
