// #192: atrybut hidden musi ukrywać element także wtedy, gdy reguła autora ustawia display
// (np. `.load-more { display: block }`, `label { display: grid }`). Każda aplikacja Vite
// z własnym arkuszem ma więc regułę `[hidden] { display: none !important; }`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const apps = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(new URL(`${entry.name}/index.html`, root)))
  .map((entry) => entry.name)
  .filter((app) => /<link[^>]+rel="stylesheet"[^>]+href="\/styles\.css"/.test(readFileSync(new URL(`${app}/index.html`, root), 'utf8')));

test('aplikacje z arkuszem styles.css są wykrywane', () => {
  for (const app of ['panel', 'ledger', 'documents', 'admin', 'families', 'print', 'events', 'meetings']) {
    assert.ok(apps.includes(app), app);
  }
});

for (const app of apps) {
  test(`${app}: [hidden] wygrywa z regułami display`, () => {
    const css = readFileSync(new URL(`${app}/styles.css`, root), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(css, /(^|[}\s])\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/, `${app}/styles.css`);
  });
}
