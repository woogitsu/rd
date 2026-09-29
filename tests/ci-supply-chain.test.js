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

test('every job runs on a GitHub-hosted runner (public repository: no self-hosted)', () => {
  const runsOn = workflow.split('\n').filter((l) => /^\s*runs-on:/.test(l));
  assert.ok(runsOn.length > 0, 'expected at least one runs-on');
  for (const line of runsOn) assert.match(line, /runs-on:\s*ubuntu-latest\s*$/, `job not on ubuntu-latest: ${line.trim()}`);
  assert.doesNotMatch(workflow.replace(/^\s*#.*$/gm, ''), /self-hosted/);
});

test('service and container images in ci.yml are pinned to a sha256 digest', () => {
  const images = workflow.split('\n').filter((l) => /^\s*image:\s*/.test(l));
  assert.ok(images.length > 0, 'expected at least one service image');
  for (const line of images) assert.match(line, /image:\s*[\w./-]+@sha256:[0-9a-f]{64}\s*$/, `image not pinned to a digest: ${line.trim()}`);
});

test('ci-ok requires test-pg-real (real PostgreSQL) and it uses the service via RD_TEST_PG_URL', () => {
  const ciOkMatch = workflow.match(/ci-ok:\s*\n\s*needs:\s*\[([^\]]+)\]/);
  assert.ok(ciOkMatch, 'ci-ok job with needs: [...] not found');
  assert.ok(ciOkMatch[1].split(',').map((s) => s.trim()).includes('test-pg-real'), 'ci-ok must depend on test-pg-real');
  assert.match(workflow, /RD_TEST_PG_URL:\s*postgres:\/\/[^\s@]+@127\.0\.0\.1:5432\//);
  assert.match(workflow, /npm run test:pg-real/);
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
