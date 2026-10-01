// #166 (kryterium 4): zmienne środowiskowe czytane przez kod muszą mieć wiersz
// w katalogu `docs/RAILWAY_OPERATIONS.md` („Katalog zmiennych środowiskowych”),
// a wiersz katalogu musi odpowiadać zmiennej faktycznie czytanej przez kod.
// Nowa zmienna bez wpisu albo wpis po usuniętej zmiennej wywraca test. Wyjątki
// mają jawną listę z uzasadnieniem i same są sprawdzane (nieaktualny wyjątek
// też jest błędem). Skaner ma kontrole pozytywne na kodzie syntetycznym.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertEvery } from './helpers/assertions.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const CATALOG_DOC = 'docs/RAILWAY_OPERATIONS.md';
const CATALOG_HEADING = '### Katalog zmiennych środowiskowych';
const SKIP_DIRS = new Set(['node_modules', 'tests', 'dist', 'docs', 'migrations', 'test-results', 'playwright-report']);
const REQUIRED_KINDS = /^(tak|poza lokalnie|nie|skrypt)\b/;

// Zmienne czytane w kodzie, które celowo nie mają wiersza w katalogu.
// Klucz: nazwa, wartość: uzasadnienie.
const CODE_WITHOUT_CATALOG = Object.freeze({
  DB: 'env.DB to powiązanie D1 obiektu env starego Workera Cloudflare (nie zmienna procesu); ścieżka D1 jest wygaszana wg RAILWAY_MIGRATION.md',
});

// Wiersze katalogu bez bezpośredniego odczytu `env.NAZWA` w kodzie.
const CATALOG_WITHOUT_CODE = Object.freeze({});

// Zmienne w `.env.example`, których nie ma w katalogu. Pusta lista: plik
// przykładowy nie może wprowadzać zmiennych, o których nie mówi dokumentacja.
const ENV_EXAMPLE_WITHOUT_CATALOG = Object.freeze({});

function sourceFiles(dir = root, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(c|m)?js$/.test(name)) out.push(relative(root, path).split('\\').join('/'));
  }
  return out;
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const NAME = '[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*';
// Odczyt przez obiekt środowiska (process.env.X, env.X, processEnv.X, source.X, env?.X).
const MEMBER = new RegExp(`\\b(?:process\\.env|[\\w$]*[eE]nv\\w*|source)\\??\\.(${NAME})\\b`, 'g');
// Odczyt przez nawiasy: env['X'].
const BRACKET = new RegExp(`\\b(?:process\\.env|[\\w$]*[eE]nv\\w*)\\[\\s*['"](${NAME})['"]\\s*\\]`, 'g');
// Destrukturyzacja: const { X, Y: z } = process.env / env.
const DESTRUCTURE = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:process\.env|[\w$]*[eE]nv\w*)\b/g;
// Listy nazw (REQUIRED_ENV = ['A', 'B'], RAILWAY_MARKERS = [...]) czytane pętlą po env[name].
const NAME_LIST = /\b\w*(?:ENV|MARKERS|[eE]nv)\w*\s*=\s*(?:Object\.freeze\(\s*)?\[([^\]]*)\]/g;
// Sprawdzenie obecności: Object.hasOwn(env, 'X') (strategia „env albo process.env”).
const HAS_OWN = new RegExp(`Object\\.hasOwn\\(\\s*\\w+\\s*,\\s*['"](${NAME})['"]`, 'g');

export function envNamesRead(source) {
  const text = stripComments(source);
  const names = new Set();
  for (const re of [MEMBER, BRACKET, HAS_OWN]) for (const m of text.matchAll(re)) names.add(m[1]);
  for (const m of text.matchAll(DESTRUCTURE)) {
    for (const part of m[1].split(',')) {
      const key = part.trim().split(/[:=\s]/)[0];
      if (new RegExp(`^${NAME}$`).test(key)) names.add(key);
    }
  }
  for (const m of text.matchAll(NAME_LIST)) {
    for (const lit of m[1].matchAll(new RegExp(`['"](${NAME})['"]`, 'g'))) names.add(lit[1]);
  }
  return names;
}

export function catalogNames(markdown) {
  const start = markdown.indexOf(CATALOG_HEADING);
  assert.notEqual(start, -1, `brak sekcji „${CATALOG_HEADING}” w ${CATALOG_DOC}`);
  const rest = markdown.slice(start + CATALOG_HEADING.length);
  const next = rest.search(/^#{1,3} /m);
  const section = next === -1 ? rest : rest.slice(0, next);
  const rows = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    rows.push({ line, cells, names: [...cells[0].matchAll(new RegExp(`\`(${NAME})\``, 'g'))].map((m) => m[1]) });
  }
  return rows;
}

function readCodeNames() {
  const byName = new Map();
  for (const file of sourceFiles()) {
    for (const name of envNamesRead(readFileSync(join(root, file), 'utf8'))) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(file);
    }
  }
  return byName;
}

test('skaner zmiennych środowiskowych wykrywa typowe formy odczytu', () => {
  const sample = `
    const a = process.env.ALPHA_ONE;
    const b = env?.BETA_TWO ?? 'x';
    const c = processEnv.GAMMA_THREE;
    const d = env['DELTA_FOUR'];
    const { EPSILON_FIVE, ZETA_SIX: z } = process.env;
    const REQUIRED_ENV = ['ETA_SEVEN', 'THETA_EIGHT'];
    Object.hasOwn(env, 'IOTA_NINE');
    // process.env.IGNORED_COMMENT
    const noise = Number.MAX_SAFE_INTEGER + zlib.Z_SYNC_FLUSH + crypto.constants.RSA_PKCS1_OAEP_PADDING;
  `;
  assert.deepEqual([...envNamesRead(sample)].sort(), [
    'ALPHA_ONE', 'BETA_TWO', 'DELTA_FOUR', 'EPSILON_FIVE', 'ETA_SEVEN', 'GAMMA_THREE', 'IOTA_NINE', 'THETA_EIGHT', 'ZETA_SIX',
  ]);
});

test('parser katalogu czyta nazwy z pierwszej kolumny wierszy sekcji', () => {
  const md = `${CATALOG_HEADING} (x)\n\n| Zmienna | A |\n|---|---|\n| \`ONE_TWO\`, \`THREE_FOUR\` | a | b | c | d |\n| tekst | x |\n\n### Inna sekcja\n| \`OUT_SIDE\` | a | b | c | d |\n`;
  const rows = catalogNames(md);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].names, ['ONE_TWO', 'THREE_FOUR']);
});

test('zmienne czytane przez kod mają wiersz w katalogu RAILWAY_OPERATIONS.md i odwrotnie', () => {
  const code = readCodeNames();
  assert.ok(code.size > 50, `za mało zmiennych w kodzie (${code.size}) — sprawdź skaner`);
  assert.ok(code.has('APP_ENV') && code.has('DATABASE_URL') && code.has('BUCKET_NAME'), 'skaner nie widzi znanych zmiennych');
  const documented = new Set(catalogNames(readFileSync(join(root, CATALOG_DOC), 'utf8')).flatMap((row) => row.names));
  assert.ok(documented.size > 50, `za mało wierszy katalogu (${documented.size})`);

  const missing = [...code.keys()].filter((name) => !documented.has(name) && !Object.hasOwn(CODE_WITHOUT_CATALOG, name)).sort();
  assert.deepEqual(missing.map((name) => `${name} (${code.get(name).slice(0, 2).join(', ')})`), [],
    `zmienna czytana w kodzie bez wiersza w katalogu ${CATALOG_DOC}: dopisz opis, wymagalność i domyślną wartość`);

  const unused = [...documented].filter((name) => !code.has(name) && !Object.hasOwn(CATALOG_WITHOUT_CODE, name)).sort();
  assert.deepEqual(unused, [], `wiersz katalogu bez użycia w kodzie: usuń go albo dodaj wyjątek z uzasadnieniem w ${import.meta.url.split('/').pop()}`);
});

test('wyjątki są aktualne i mają uzasadnienie', () => {
  const code = readCodeNames();
  const documented = new Set(catalogNames(readFileSync(join(root, CATALOG_DOC), 'utf8')).flatMap((row) => row.names));
  for (const [name, reason] of Object.entries(CODE_WITHOUT_CATALOG)) {
    assert.ok(code.has(name) && !documented.has(name), `nieaktualny wyjątek CODE_WITHOUT_CATALOG: ${name}`);
    assert.ok(reason.length >= 20, `wyjątek ${name} bez uzasadnienia`);
  }
  for (const [name, reason] of Object.entries(CATALOG_WITHOUT_CODE)) {
    assert.ok(documented.has(name) && !code.has(name), `nieaktualny wyjątek CATALOG_WITHOUT_CODE: ${name}`);
    assert.ok(reason.length >= 20, `wyjątek ${name} bez uzasadnienia`);
  }
});

test('wiersze katalogu mają komplet kolumn, bez duplikatów i bez sekretów', () => {
  const rows = catalogNames(readFileSync(join(root, CATALOG_DOC), 'utf8'));
  assertEvery(rows, (row) => row.cells.length === 5 && row.cells.every((cell) => cell.length > 0),
    'każdy wiersz ma 5 niepustych kolumn (zmienna, usługa, wymagana, domyślna, opis)');
  assertEvery(rows, (row) => REQUIRED_KINDS.test(row.cells[2]), 'kolumna „Wymagana” zaczyna się od tak/poza lokalnie/nie/skrypt');
  const names = rows.flatMap((row) => row.names);
  assert.deepEqual(names.filter((name, index) => names.indexOf(name) !== index), [], 'zduplikowany wiersz katalogu');
  // Domyślna wartość nie jest sekretem: bez adresów z danymi dostępowymi i bez długich ciągów hex/base64.
  assertEvery(rows, (row) => !/:\/\/[^\s/]*:[^\s/]*@/.test(row.cells[3]) && !/[A-Za-z0-9+/=]{32,}/.test(row.cells[3]),
    'kolumna „Domyślna” nie zawiera sekretów');
});

test('.env.example używa wyłącznie zmiennych z katalogu', () => {
  const documented = new Set(catalogNames(readFileSync(join(root, CATALOG_DOC), 'utf8')).flatMap((row) => row.names));
  const example = readFileSync(join(root, '.env.example'), 'utf8')
    .split('\n').map((line) => /^([A-Z][A-Z0-9_]+)=/.exec(line)?.[1]).filter(Boolean);
  assert.ok(example.length > 10, 'za mało zmiennych w .env.example');
  const unknown = example.filter((name) => !documented.has(name) && !Object.hasOwn(ENV_EXAMPLE_WITHOUT_CATALOG, name));
  assert.deepEqual(unknown, [], '.env.example zawiera zmienną bez wiersza w katalogu');
});
