// #226: element .sr-only (position:absolute) w nagłówku tabeli ucieka z kontenera
// z overflow, jeśli kontener nie tworzy bloku zawierającego (position:relative).
// Wtedy 1-pikselowy span na końcu szerokiej tabeli rozpycha całą stronę na telefonie.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const sheets = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(new URL(`${entry.name}/styles.css`, root)))
  .map((entry) => `${entry.name}/styles.css`);

// Płaska lista reguł { selectors, body } (także z wnętrza @media).
function rules(css) {
  const out = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of clean.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    out.push({ selectors: match[1].split(',').map((s) => s.trim()), body: match[2] });
  }
  return out;
}
const declares = (body, property, pattern) =>
  new RegExp(`(^|;)\\s*${property}\\s*:\\s*${pattern}`).test(body);

test('arkusze wszystkich aplikacji są wykrywane', () => {
  for (const app of ['admin', 'families', 'panel', 'ledger', 'documents', 'events', 'meetings', 'print']) {
    assert.ok(sheets.includes(`${app}/styles.css`), app);
  }
});

for (const sheet of sheets) {
  test(`${sheet}: przewijany kontener tabeli zawiera elementy absolutne`, () => {
    const list = rules(readFileSync(new URL(sheet, root), 'utf8'));
    const wraps = list.filter((rule) => rule.selectors.some((s) => /^\.(table-wrap|tablewrap)$/.test(s))
      && declares(rule.body, 'overflow(-x)?', '(auto|scroll)'));
    for (const rule of wraps) {
      assert.ok(declares(rule.body, 'position', '(relative|absolute|fixed|sticky)'), `${sheet}: ${rule.selectors.join(', ')} bez position`);
    }
  });

  test(`${sheet}: .sr-only nie wpływa na układ`, () => {
    const list = rules(readFileSync(new URL(sheet, root), 'utf8'));
    for (const rule of list.filter((r) => r.selectors.includes('.sr-only'))) {
      assert.ok(declares(rule.body, 'position', 'absolute'));
      assert.ok(declares(rule.body, 'width', '1px') && declares(rule.body, 'height', '1px'), `${sheet}: 1px`);
      assert.ok(declares(rule.body, 'clip', 'rect\\('), `${sheet}: clip`);
      assert.ok(declares(rule.body, 'white-space', 'nowrap'), `${sheet}: white-space:nowrap`);
      assert.ok(declares(rule.body, 'overflow', 'hidden'));
    }
  });
}
