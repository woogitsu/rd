// #170: instrukcje uruchomienia paneli w README i docs/NODE_SERVER.md muszą
// odpowiadać kodowi (Worker/D1 ma tylko 5 tras; reszta modułów istnieje
// wyłącznie na PostgreSQL; brak proxy Vite dla /api).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
const nodeServer = await readFile(new URL('../docs/NODE_SERVER.md', import.meta.url), 'utf8');
const nodeApp = await readFile(new URL('../src/node-app.js', import.meta.url), 'utf8');
const documentsReadme = await readFile(new URL('../documents/README.md', import.meta.url), 'utf8');

function staticPrefixes() {
  const match = nodeApp.match(/STATIC_PREFIXES\s*=\s*new Set\(\[([^\]]+)\]\)/);
  assert.ok(match, 'STATIC_PREFIXES not found in src/node-app.js');
  return match[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

test('docs/NODE_SERVER.md lists every prefix from STATIC_PREFIXES', () => {
  for (const prefix of staticPrefixes()) {
    assert.match(nodeServer, new RegExp(`\`/${prefix}/\`|\`/${prefix}\``), `NODE_SERVER.md should mention /${prefix}/`);
  }
});

test('docs/NODE_SERVER.md does not claim a Node-side Worker/D1 adapter exists', () => {
  assert.doesNotMatch(nodeServer, /korzysta z adaptera Worker\/D1/);
});

test('README.md links the previously-missing docs (NODE_SERVER, EQUIVALENCE, D1_POSTGRES_MIGRATION, SECURITY_REVIEW, DESIGN, ACCESSIBILITY)', () => {
  for (const doc of ['NODE_SERVER.md', 'EQUIVALENCE.md', 'D1_POSTGRES_MIGRATION.md', 'SECURITY_REVIEW.md', 'DESIGN.md', 'ACCESSIBILITY.md']) {
    assert.match(readme, new RegExp(`docs/${doc}`), `README.md should link docs/${doc}`);
  }
});

test('README.md documents the families panel', () => {
  assert.match(readme, /## Panel rodzin/);
  assert.match(readme, /families\/README\.md/);
});

test('README.md no longer claims a bare `npm run dev` serves the documents/admin/families API', () => {
  // Worker (src/index.js) only routes /health, /api/session, /api/access,
  // /api/payments*, /api/ledger*, /api/logout — never documents/admin/families.
  assert.doesNotMatch(readme, /`npm run dev:documents`\s*\(API przez `npm run dev`/);
});

test('documents/README.md does not label `npm run dev` as the API for documents', () => {
  assert.doesNotMatch(documentsReadme, /npm run dev\s+#\s*API/);
  assert.match(documentsReadme, /nie ma.*tras.*\/api\/documents|nie mają tras.*\/api\/documents/i);
});

test('README "Uruchomienie lokalne" section describes the one working path (build, PostgreSQL, single-origin start)', () => {
  assert.match(readme, /## Uruchomienie lokalne/);
  const section = readme.slice(readme.indexOf('## Uruchomienie lokalne'));
  assert.match(section, /npm run db:migrate:postgres/);
  assert.match(section, /PORT=3000 npm start/);
  assert.match(section, /nie łączą się dziś z żadnym API|nie są dziś połączone/);
});
