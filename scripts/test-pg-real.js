// Testy na PRAWDZIWYM PostgreSQL (#208): initdb w katalogu tymczasowym →
// serwer na losowym porcie (tylko 127.0.0.1) → testy z RD_TEST_PG_URL → stop →
// usunięcie katalogu. Nie dotyka żadnej istniejącej bazy ani sieci zewnętrznej.
//
//   npm run test:pg-real                      pliki, które czytają RD_TEST_PG_URL (wyścigi)
//   npm run test:pg-real -- tests/a.test.js   wskazane pliki
//   npm run test:pg-real -- --all             CAŁY zestaw tests/*.test.js z bazą
//                                             PostgreSQL zamiast PGlite (RD_TEST_PG_BACKEND=real)
//
// Gdy RD_TEST_PG_URL jest już ustawione (CI: usługa `services: postgres` w
// .github/workflows/ci.yml), skrypt NIE tworzy własnego serwera, tylko uruchamia
// testy na wskazanej bazie (uprawnienia CREATE DATABASE wymagane; testy tworzą
// i usuwają własne bazy, nie dotykają istniejących). Wtedy nie trzeba PG_BIN.
//
// Zmienne: PG_BIN (katalog z initdb/pg_ctl; domyślnie pg_config --bindir, potem
// /usr/lib/postgresql/*/bin, potem PATH). Uruchomione jako root skrypt uruchamia
// serwer jako użytkownik `postgres` (PostgreSQL odmawia startu jako root).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { chmod, chown, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const runAll = args.includes('--all');
const externalUrl = process.env.RD_TEST_PG_URL || '';
const explicitFiles = args.filter((a) => !a.startsWith('--'));

function findBin() {
  const candidates = [];
  if (process.env.PG_BIN) candidates.push(process.env.PG_BIN);
  const cfg = spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' });
  if (cfg.status === 0) candidates.push(cfg.stdout.trim());
  if (existsSync('/usr/lib/postgresql')) {
    for (const v of readdirSync('/usr/lib/postgresql').sort((a, b) => Number(b) - Number(a))) candidates.push(`/usr/lib/postgresql/${v}/bin`);
  }
  for (const dir of candidates) if (existsSync(join(dir, 'initdb')) && existsSync(join(dir, 'pg_ctl'))) return dir;
  const probe = spawnSync('initdb', ['--version'], { encoding: 'utf8' });
  if (probe.status === 0) return '';
  return null;
}

function freePort() {
  return new Promise((ok, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => ok(port)); });
  });
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
function run(command, commandArgs) {
  if (isRoot) return spawnSync('runuser', ['-u', 'postgres', '--', command, ...commandArgs], { encoding: 'utf8' });
  return spawnSync(command, commandArgs, { encoding: 'utf8' });
}
const idOf = (flag) => Number(spawnSync('id', [flag, 'postgres'], { encoding: 'utf8' }).stdout);

function testFiles() {
  if (explicitFiles.length) return explicitFiles;
  const dir = join(root, 'tests');
  const all = readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();
  if (runAll) return all.map((f) => `tests/${f}`);
  return all.filter((f) => /process\.env\.RD_TEST_PG_URL/.test(readFileSync(join(dir, f), 'utf8'))).map((f) => `tests/${f}`);
}

// Testy w tym samym trybie co `npm test` (tests/setup.js: APP_ENV=test, pułapka na sieć).
const nodeTestArgs = ['--test', '--test-concurrency=1', '--import', './tests/setup.js'];

async function runExternal() {
  const files = testFiles();
  if (!files.length) { console.error('Brak plików testowych do uruchomienia.'); return 2; }
  const env = { ...process.env };
  if (runAll) env.RD_TEST_PG_BACKEND = 'real';
  console.error(`# PostgreSQL z RD_TEST_PG_URL (istniejący serwer); plików testowych: ${files.length}`);
  const child = spawn(process.execPath, [...nodeTestArgs, ...files], { cwd: root, env, stdio: 'inherit' });
  return await new Promise((ok) => { child.on('close', (code) => ok(code ?? 1)); child.on('error', () => ok(2)); });
}

async function main() {
  if (externalUrl) return runExternal();
  const bin = findBin();
  if (bin === null) {
    console.error('Brak PostgreSQL (initdb/pg_ctl). Zainstaluj PostgreSQL 16 albo ustaw PG_BIN.');
    return 2;
  }
  const withBin = (name) => (bin ? join(bin, name) : name);
  const files = testFiles();
  if (!files.length) { console.error('Brak plików testowych do uruchomienia.'); return 2; }

  const dir = await mkdtemp(join(tmpdir(), 'rd-pg-real-'));
  const data = join(dir, 'data');
  let started = false;
  let cleaned = false;
  let child = null;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (started) {
      const stop = run(withBin('pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop']);
      if (stop.status !== 0) console.error('Ostrzeżenie: pg_ctl stop nie powiódł się:', String(stop.stderr).slice(0, 300));
    }
    await rm(dir, { recursive: true, force: true });
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      // Najpierw zatrzymaj testy (inaczej zostałyby bez serwera), potem serwer i katalog.
      if (child) child.kill('SIGTERM');
      cleanup().finally(() => process.exit(130));
    });
  }

  try {
    await chmod(dir, 0o755);
    if (isRoot) await chown(dir, idOf('-u'), idOf('-g'));
    const init = run(withBin('initdb'), ['-D', data, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-sync']);
    if (init.status !== 0) { console.error('initdb nie powiódł się:', String(init.stderr).slice(0, 500)); return 2; }
    const port = await freePort();
    const options = `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=200`;
    const start = run(withBin('pg_ctl'), ['-D', data, '-w', '-t', '60', '-l', join(dir, 'server.log'), '-o', options, 'start']);
    if (start.status !== 0) { console.error('pg_ctl start nie powiódł się:', String(start.stderr).slice(0, 500)); return 2; }
    started = true;
    const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
    console.error(`# PostgreSQL ${bin || '(PATH)'} na 127.0.0.1:${port}, katalog ${dir}; plików testowych: ${files.length}`);

    const env = { ...process.env, RD_TEST_PG_URL: url };
    if (runAll) env.RD_TEST_PG_BACKEND = 'real';
    child = spawn(process.execPath, [...nodeTestArgs, ...files], { cwd: root, env, stdio: 'inherit' });
    return await new Promise((ok) => { child.on('close', (code) => ok(code ?? 1)); child.on('error', () => ok(2)); });
  } finally {
    await cleanup();
  }
}

process.exitCode = await main();
