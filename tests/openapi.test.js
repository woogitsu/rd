// docs/openapi.json (issue #160, etap 1) jest wygenerowany z macierzy tras i
// katalogu błędów; ręczna edycja albo trasa dopisana bez regeneracji psuje test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { OPENAPI_PATH, buildOpenApi, parseErrorCatalog, renderOpenApi } from '../scripts/build-openapi.js';
import { ROUTE_MATRIX } from './helpers/route-matrix.js';

const errorsMarkdown = await readFile(new URL('../docs/API_ERRORS.md', import.meta.url), 'utf8');

test('docs/openapi.json jest aktualny (npm run openapi:build)', async () => {
  const current = await readFile(OPENAPI_PATH, 'utf8');
  assert.equal(current, await renderOpenApi(), 'docs/openapi.json nieaktualny — uruchom: npm run openapi:build');
});

test('generator jest deterministyczny', () => {
  assert.equal(JSON.stringify(buildOpenApi(errorsMarkdown)), JSON.stringify(buildOpenApi(errorsMarkdown)));
});

test('każdy wpis macierzy tras ma operację z rolami, MFA i statusami', () => {
  const spec = buildOpenApi(errorsMarkdown);
  const covered = new Set();
  for (const item of Object.values(spec.paths)) {
    for (const op of Object.values(item)) {
      for (const id of op['x-rd-matrix-ids']) covered.add(id);
      assert.ok(Array.isArray(op['x-rd-roles']), op.operationId);
      assert.ok(Object.hasOwn(op, 'x-rd-mfa'), op.operationId);
      assert.ok(op['x-rd-ok-status'].length > 0, op.operationId);
      assert.match(op['x-rd-roles-status'], /D-08\/D-09/);
    }
  }
  assert.deepEqual(ROUTE_MATRIX.map((r) => r.id).filter((id) => !covered.has(id)), []);
  assert.match(spec.info.description, /D-08\/D-09/);
});

test('ścieżki i metody z macierzy są w specyfikacji, a klucze posortowane', () => {
  const spec = buildOpenApi(errorsMarkdown);
  for (const route of ROUTE_MATRIX) {
    const path = route.path.split('?')[0].replace(/:([A-Za-z]\w*)/g, '{$1}');
    assert.ok(spec.paths[path]?.[route.method.toLowerCase()], `${route.method} ${path}`);
  }
  const keys = Object.keys(spec.paths);
  assert.deepEqual(keys, [...keys].sort());
});

test('kody błędów w specyfikacji == tabela docs/API_ERRORS.md', () => {
  const spec = buildOpenApi(errorsMarkdown);
  const catalog = parseErrorCatalog(errorsMarkdown).map((row) => row.code);
  assert.ok(catalog.length > 150);
  assert.deepEqual(spec.components.schemas.ErrorCode.enum, catalog);
});
