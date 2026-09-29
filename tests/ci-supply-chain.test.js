// #153: łańcuch dostaw — CI i higiena zależności.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('every `uses:` action in ci.yml is pinned to a full commit SHA', () => {
  const usesLines = workflow.split('\n').filter((line) => /^\s*-?\s*uses:\s*/.test(line));
  assert.ok(usesLines.length > 0, 'expected at least one `uses:` step');
  for (const line of usesLines) {
    const match = line.match(/uses:\s*([^\s]+)/);
    assert.ok(match, `could not parse action reference: ${line}`);
    const ref = match[1];
    const at = ref.lastIndexOf('@');
    assert.ok(at > 0, `action reference has no @ref: ${ref}`);
    const pinned = ref.slice(at + 1);
    assert.match(pinned, /^[0-9a-f]{40}$/, `action not pinned to a full SHA: ${ref}`);
  }
});

test('every `npm ci` in ci.yml uses --ignore-scripts (no dependency install scripts on the runner)', () => {
  const lines = workflow.split('\n').filter((l) => /\bnpm ci\b/.test(l) && !l.trim().startsWith('#'));
  assert.ok(lines.length > 0, 'expected at least one `npm ci` step');
  for (const line of lines) assert.match(line, /npm ci --ignore-scripts/, `npm ci without --ignore-scripts: ${line.trim()}`);
});

test('ci.yml declares read-only top-level permissions and no job widens them', () => {
  assert.match(workflow, /^permissions:\s*\n\s+contents: read\s*$/m);
  assert.doesNotMatch(workflow, /(contents|actions|packages|id-token|pull-requests|issues|checks|statuses|deployments):\s*write/);
  assert.doesNotMatch(workflow, /pull_request_target|secrets\./);
});

test('production dependencies are pinned exactly (no ^ or ~ ranges)', () => {
  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
    assert.doesNotMatch(range, /^[\^~]/, `${name} uses a range (${range}); production deps must be pinned exactly`);
  }
});

test('CI runs npm audit (production high/critical, full tree critical) and npm audit signatures, and ci-ok requires the audit job', () => {
  assert.match(workflow, /npm audit --omit=dev --audit-level=high/);
  assert.match(workflow, /npm audit --audit-level=critical/);
  assert.match(workflow, /npm audit signatures/);
  const ciOkMatch = workflow.match(/ci-ok:\s*\n\s*needs:\s*\[([^\]]+)\]/);
  assert.ok(ciOkMatch, 'ci-ok job with needs: [...] not found');
  const needs = ciOkMatch[1].split(',').map((s) => s.trim());
  assert.ok(needs.includes('audit'), 'ci-ok must depend on the audit job');
});

test('dependabot.yml watches npm and github-actions without auto-merge', async () => {
  const dependabot = await readFile(new URL('../.github/dependabot.yml', import.meta.url), 'utf8');
  assert.match(dependabot, /package-ecosystem:\s*"npm"/);
  assert.match(dependabot, /package-ecosystem:\s*"github-actions"/);
  assert.doesNotMatch(dependabot, /automerge|auto-merge/i);
});
