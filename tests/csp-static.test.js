// #188/#223: strony statyczne muszą działać pod CSP serwera Node (src/node-app.js).
// Polityka jest czytana z kodu serwera: dopóki script-src/style-src nie dopuszczają
// 'unsafe-inline' (ani hasha/nonce), żaden HTML nie może mieć wbudowanych stylów i skryptów.
// Sprawdzane są źródła */index.html oraz zbudowane dist/**/*.html. Bez katalogu dist/
// część „dist” jest pomijana, chyba że ustawiono REQUIRE_DIST=1 (CI po npm run build).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const nodeApp = readFileSync(join(root, 'src/node-app.js'), 'utf8');
const policy = nodeApp.match(/'Content-Security-Policy':\s*"([^"]+)"/)?.[1];

function directive(name) {
  const entry = policy.split(';').map((part) => part.trim().split(/\s+/)).find(([key]) => key === name);
  return entry ? entry.slice(1) : null;
}
const allowsInline = (sources) => sources.some((s) => s === "'unsafe-inline'" || /^'(nonce|sha(256|384|512))-/.test(s));

export function cspViolations(html) {
  const problems = [];
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  if (/<style[\s>]/i.test(withoutComments)) problems.push('<style>');
  for (const match of withoutComments.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\ssrc\s*=/i.test(match[1]) || match[2].trim() !== '') problems.push('<script> bez src');
  }
  for (const match of withoutComments.matchAll(/<[a-z][a-z0-9-]*\b([^>]*)>/gi)) {
    const attrs = match[1];
    if (/\sstyle\s*=/i.test(attrs)) problems.push(`style= w ${match[0].slice(0, 60)}`);
    const handler = attrs.match(/\s(on[a-z]+)\s*=/i);
    if (handler) problems.push(`${handler[1]}= w ${match[0].slice(0, 60)}`);
    if (/=\s*["']?\s*javascript:/i.test(attrs)) problems.push(`javascript: w ${match[0].slice(0, 60)}`);
  }
  return problems;
}

function htmlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...htmlFiles(path));
    else if (entry.name.endsWith('.html')) out.push(path);
  }
  return out;
}

const sourcePages = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !['node_modules', 'dist'].includes(entry.name) && !entry.name.startsWith('.'))
  .map((entry) => join(root, entry.name, 'index.html'))
  .filter((path) => existsSync(path));
const distDir = join(root, 'dist');
const distPages = existsSync(distDir) ? htmlFiles(distDir) : [];

test('CSP serwera Node nie dopuszcza wbudowanych stylów ani skryptów', () => {
  assert.ok(policy, 'nagłówek CSP w src/node-app.js');
  assert.ok(directive('style-src') || directive('default-src'));
  assert.equal(allowsInline(directive('style-src') ?? directive('default-src')), false);
  assert.equal(allowsInline(directive('script-src') ?? directive('default-src')), false);
  // Brak worker-src: obowiązuje script-src, więc Worker z blob: jest zablokowany (#188).
  assert.equal((directive('worker-src') ?? directive('script-src')).includes('blob:'), false);
});

test('wykrywacz łapie celowo wstawione naruszenia (fixture)', () => {
  assert.deepEqual(cspViolations('<link rel="stylesheet" href="/styles.css"><script type="module" src="/main.js"></script>'), []);
  assert.ok(cspViolations('<style>a{}</style>').includes('<style>'));
  assert.equal(cspViolations('<div style="margin-top:16px"></div>').length, 1);
  assert.equal(cspViolations('<script>alert(1)</script>').length, 1);
  assert.equal(cspViolations('<button onclick="x()">A</button>').length, 1);
  assert.equal(cspViolations('<a href="javascript:void(0)">A</a>').length, 1);
  // content= w <meta> i data-on-… nie są atrybutami zdarzeń.
  assert.deepEqual(cspViolations('<meta name="viewport" content="width=device-width"><div data-online="1"></div>'), []);
});

test('źródła wszystkich aplikacji są wykrywane', () => {
  const apps = sourcePages.map((path) => relative(root, path).split(/[\\/]/)[0]);
  for (const app of ['import', 'panel', 'ledger', 'print', 'events', 'documents', 'site', 'meetings', 'admin', 'families', 'login']) {
    assert.ok(apps.includes(app), app);
  }
});

for (const path of sourcePages) {
  test(`źródło ${relative(root, path)}: zgodne z CSP`, () => {
    assert.deepEqual(cspViolations(readFileSync(path, 'utf8')), []);
  });
}

test('dist/: zbudowane strony istnieją, gdy są wymagane', () => {
  if (process.env.REQUIRE_DIST === '1') assert.ok(distPages.length >= sourcePages.length, 'uruchom npm run build');
});

for (const path of distPages) {
  test(`zbudowane ${relative(root, path)}: zgodne z CSP`, () => {
    assert.deepEqual(cspViolations(readFileSync(path, 'utf8')), []);
  });
}
