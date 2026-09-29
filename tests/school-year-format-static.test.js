// Statyczne pilnowanie „jednej nazwy szkoły i jednego formatu roku” w widokach dla ludzi.
// Nie zastępuje przeglądu ekranów; łapie najczęstszy powrót do starego stanu: nazwę
// wpisaną ręcznie w HTML/JS oraz surowy identyfikator roku („2026-2027”) w tekście.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { formatSchoolYear } from '../shared/school-year.js';
import { COUNCIL_FULL_NAME, SCHOOL_NAME, applySchoolName } from '../shared/school.js';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'tests', 'docs', 'migrations', 'postgres', 'privacy', '.demo-data']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}
const rel = (path) => path.slice(ROOT.length);
const files = walk(ROOT).filter((p) => /\.(js|html)$/.test(p));

test('formatSchoolYear: identyfikator → „RRRR/RRRR”, inne wartości bez zmian', () => {
  assert.equal(formatSchoolYear('2026-2027'), '2026/2027');
  assert.equal(formatSchoolYear('2026/2027'), '2026/2027');
  assert.equal(formatSchoolYear(''), '');
  assert.equal(formatSchoolYear(null), '');
  assert.equal(formatSchoolYear('rok-testowy'), 'rok-testowy');
});

test('nazwa szkoły jest tylko w shared/school.js (bez wariantów w HTML/JS)', () => {
  const offenders = [];
  for (const path of files) {
    if (rel(path) === 'shared/school.js') continue;
    const text = readFileSync(path, 'utf8');
    if (/Szkoł[ay] Polsk\w* (?:im\.|w Brukseli)|Lelewel/.test(text)) offenders.push(rel(path));
  }
  assert.deepEqual(offenders, [], 'nazwę szkoły bierz z shared/school.js (data-school-name / SCHOOL_NAME)');
});

test('strony z nagłówkiem marki mają znacznik data-school-name i skrypt, który go wypełnia', () => {
  const pages = files.filter((p) => /index\.html$/.test(p) && /class="brand"|site-name/.test(readFileSync(p, 'utf8')));
  assert.ok(pages.length >= 16, `oczekiwano wszystkich paneli, jest ${pages.length}`);
  for (const page of pages) {
    assert.match(readFileSync(page, 'utf8'), /data-school-name/, rel(page));
    const dir = page.replace(/index\.html$/, '');
    const main = readFileSync(join(dir, 'main.js'), 'utf8');
    assert.match(main, /mountShell\(|applySchoolName\(/, `${rel(dir)}main.js musi wywołać mountShell() lub applySchoolName()`);
  }
});

test('applySchoolName wypełnia warianty i toleruje brak DOM', () => {
  const make = (variant) => ({ textContent: '', getAttribute: () => variant });
  const nodes = [make(''), make('school'), make('council')];
  applySchoolName({ querySelectorAll: () => nodes });
  assert.deepEqual(nodes.map((n) => n.textContent), [SCHOOL_NAME, SCHOOL_NAME, COUNCIL_FULL_NAME]);
  assert.doesNotThrow(() => applySchoolName(null));
  assert.doesNotThrow(() => applySchoolName({}));
});

// Tekst widoczny dla człowieka z surowym identyfikatorem roku: „Rok … ${…schoolYearId}”
// lub przypisanie do textContent / new Option bez formatSchoolYear(). Adresy API
// (`?schoolYearId=`, URLSearchParams, value=) są dozwolone — to identyfikator techniczny.
test('panele nie pokazują surowego identyfikatora roku ludziom', () => {
  const offenders = [];
  // Wiersz z formatSchoolYear() jest w porządku; szukamy wierszy z surowym identyfikatorem.
  const shown = [
    /\b[Rr]ok(?: szkolny)?:? \$\{[^}]*\bschoolYear(?:Id|Label)\b[^}]*\}/,
    /\btextContent\s*=[^;\n]*\bschoolYear(?:Id|Label)\b/,
    /new Option\([^,)]*[sS]choolYear(?:Id|Label)\b/,
  ];
  for (const path of files.filter((p) => p.endsWith('.js') && !/\/(?:src|scripts)\//.test(p))) {
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*\/\//.test(line) || /schoolYearId=|URLSearchParams|encodeURIComponent|formatSchoolYear\(/.test(line)) return;
      if (shown.some((re) => re.test(line))) offenders.push(`${rel(path)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], 'użyj formatSchoolYear() z shared/school-year.js');
});

test('raporty HTML serwera formatują rok przez formatSchoolYear', () => {
  for (const name of ['audit-report', 'annual-report', 'budget-report']) {
    const text = readFileSync(join(ROOT, `src/pg/${name}.js`), 'utf8');
    assert.doesNotMatch(text, /e\(schoolYear\.label\)/, name);
    assert.match(text, /formatSchoolYear\(schoolYear\.label\)/, name);
  }
});

test('raport preliminarza (HTML) pokazuje rok jako „RRRR/RRRR”, a nie identyfikator', async () => {
  const { renderBudgetExecutionHtml } = await import('../src/pg/budget-report.js');
  const html = renderBudgetExecutionHtml({
    schoolYear: { label: '2026-2027', startsOn: '2026-09-01', endsOn: '2027-08-31' },
    generatedAt: '2026-10-01T10:00:00Z',
    asOf: null,
    items: [],
    totals: { income: {}, expense: {} },
    adoption: null,
  });
  assert.match(html, /rok szkolny 2026\/2027/);
  assert.doesNotMatch(html, /2026-2027/);
});
