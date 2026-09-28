// Read-only smoke test for a deployed environment (issue #119) — run by hand
// after a Railway staging deploy, since docs/RAILWAY_OPERATIONS.md previously
// asked for a manual check of /health/ready.
//
//   LOAD_TEST_ALLOWED_HOSTS=rd-staging.up.railway.app APP_ENV=staging \
//   npm run smoke:remote -- --target https://rd-staging.up.railway.app --i-confirm-staging
//
// Uses the SAME safeguards as scripts/load-test.js (validateRemoteTarget):
// refuses without --i-confirm-staging, refuses http://, refuses APP_ENV=production,
// refuses a host outside LOAD_TEST_ALLOWED_HOSTS. This script never sends
// anything but GET — it has no --allow-writes flag at all, unlike load-test.
//
// Checks: /health, /health/ready (200, includes write_mode), every built
// panel (STATIC_PREFIXES — single source of truth in src/node-app.js),
// security headers, 404 for private/traversal paths and *.map requests.
// Result: JSON on stdout for the deploy record. Exit code 1 on any failed
// check, 2 on a usage/safety refusal (mirrors load-test.js).
import { fileURLToPath } from 'node:url';
import { validateRemoteTarget, UsageError } from './load-test.js';
import { STATIC_PREFIXES } from '../src/node-app.js';

const PANELS = Array.from(STATIC_PREFIXES).sort();
const PRIVATE_PATHS = [
  '/postgres/migrations/0001_core.sql',
  '/src/server.js',
  '/scripts/smoke-remote.js',
  '/.env',
  '/package.json',
  '/panel/../src/server.js',
  '/panel/%2e%2e/src/server.js',
];

export function parseArgs(argv) {
  const options = { target: null, confirmStaging: false, timeoutMs: 10_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--i-confirm-staging') options.confirmStaging = true;
    else if (arg === '--target') { options.target = argv[i + 1]; i += 1; }
    else if (arg.startsWith('--target=')) options.target = arg.slice('--target='.length);
    else if (arg === '--timeout-ms') { options.timeoutMs = Number(argv[i + 1]); i += 1; }
    else throw new UsageError(`unknown argument: ${arg}`);
  }
  if (!options.target) throw new UsageError('--target is required (an https URL from LOAD_TEST_ALLOWED_HOSTS)');
  return options;
}

async function get(baseUrl, path, timeoutMs) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text };
}

export async function smokeRemote(options, { env = process.env } = {}) {
  // Odmowa PRZED pierwszym żądaniem (kryterium akceptacji #119).
  const baseUrl = validateRemoteTarget(options.target, { confirmStaging: options.confirmStaging, env });
  const checks = [];
  const record = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail }); };

  const health = await get(baseUrl, '/health', options.timeoutMs);
  record('health_200', health.status === 200, `status=${health.status}`);

  const ready = await get(baseUrl, '/health/ready', options.timeoutMs);
  record('ready_200', ready.status === 200, `status=${ready.status}`);
  let readyBody = null;
  try { readyBody = JSON.parse(ready.text); } catch { /* niepoprawny JSON zgłosi się jako brak pól */ }
  record('ready_migrations_ok', readyBody?.checks?.migrations === 'ok', JSON.stringify(readyBody?.migrations));

  for (const panel of PANELS) {
    const page = await get(baseUrl, `/${panel}/`, options.timeoutMs);
    record(`panel_${panel}_200`, page.status === 200 && /<html/i.test(page.text), `status=${page.status}`);
    record(`panel_${panel}_security_headers`, page.headers.get('x-frame-options') === 'DENY', `x-frame-options=${page.headers.get('x-frame-options')}`);
    record(`panel_${panel}_no_source_map`, (await get(baseUrl, `/${panel}/assets/index.js.map`, options.timeoutMs)).status === 404, 'index.js.map');
  }

  for (const path of PRIVATE_PATHS) {
    const response = await get(baseUrl, path, options.timeoutMs);
    record(`private_404_${path}`, response.status === 404, `status=${response.status}`);
  }

  const failed = checks.filter((c) => !c.ok);
  return { target: baseUrl, startedAt: new Date().toISOString(), checks, passed: failed.length === 0, failed };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const log = (message) => console.error(`[smoke-remote] ${message}`);
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = await smokeRemote(options);
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) {
      log(`failed checks: ${report.failed.map((c) => c.name).join(', ')}`);
      process.exitCode = 1;
    }
  } catch (error) {
    log(error instanceof UsageError ? `refused: ${error.message}` : `failed: ${error.stack ?? error.message}`);
    process.exitCode = 2;
  }
}
