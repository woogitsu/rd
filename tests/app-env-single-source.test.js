// #166: APP_ENV rozpoznaje wyłącznie src/app-env.js.
//
// Test przekrojowy: w kodzie wykonywanym (src/, scripts/, shared/ oraz
// katalogach paneli) żaden plik poza src/app-env.js nie porównuje wartości
// APP_ENV samodzielnie. Wcześniej każde miejsce robiło to po swojemu
// ('production' dosłownie, 'prod', toLowerCase w jednym miejscu, brak w innym),
// przez co 'Production', 'prod' albo literówka omijały blokady.
// Dozwolone są: przekazanie wartości dalej (`APP_ENV: processEnv.APP_ENV`)
// i wywołanie funkcji z src/app-env.js (`isProductionLikeEnv(env.APP_ENV)`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const MODULE = 'src/app-env.js';
const SKIP_DIRS = new Set(['node_modules', 'tests', 'dist', '.git', 'docs', 'postgres', 'migrations', 'privacy', 'test-results', 'playwright-report']);

function sourceFiles(dir = root, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(c|m)?js$/.test(name)) out.push(relative(root, path).split('\\').join('/'));
  }
  return out;
}

// Usuwa komentarze (// i /* */), by opis w komentarzu nie był błędem. Proste
// podejście wystarcza: w tych plikach nie ma '//' w literałach obok APP_ENV.
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

// Wzorce bezpośredniej interpretacji APP_ENV lub zmiennej appEnv.
const FORBIDDEN = [
  { name: 'porównanie APP_ENV', re: /APP_ENV\s*[!=]==?|[!=]==?\s*[\w$.?[\]'"]*APP_ENV\b/ },
  { name: 'normalizacja APP_ENV na miejscu', re: /\b(?:APP_ENV|appEnv)\s*\)?\s*\??\.\s*(?:toLowerCase|toUpperCase|trim|startsWith|endsWith|includes|match|localeCompare)\b/ },
  { name: 'String(APP_ENV)', re: /String\(\s*[\w$.?]*\b(?:APP_ENV|appEnv)\b/ },
  { name: 'domyślna wartość surowego APP_ENV', re: /APP_ENV\s*(?:\|\||\?\?)(?!=)/ },
  { name: 'zbiór/lista nazw środowisk sprawdzana na APP_ENV', re: /\.(?:has|includes)\(\s*[\w$.?]*APP_ENV\b/ },
  { name: 'switch po APP_ENV', re: /switch\s*\(\s*[\w$.?]*APP_ENV/ },
  { name: 'porównanie appEnv z nazwą środowiska', re: /\bappEnv\s*[!=]==?\s*['"`]|['"`]\s*[!=]==?\s*[\w$.]*appEnv\b/ },
];

test('APP_ENV porównuje tylko src/app-env.js', () => {
  const files = sourceFiles();
  assert.ok(files.includes(MODULE), 'brak src/app-env.js');
  assert.ok(files.length > 50, `za mało plików (${files.length}) — sprawdź skaner`);
  const violations = [];
  for (const file of files) {
    if (file === MODULE) continue;
    const lines = stripComments(readFileSync(join(root, file), 'utf8')).split('\n');
    lines.forEach((line, index) => {
      for (const { name, re } of FORBIDDEN) {
        if (re.test(line)) violations.push(`${file}:${index + 1} ${name}: ${line.trim().slice(0, 120)}`);
      }
    });
  }
  assert.deepEqual(violations, [], `Użyj funkcji z ${MODULE} (resolveAppEnv, isProductionEnv, isProductionLikeEnv, isLocalAppEnv, isTestEnv, appEnvLabel):\n${violations.join('\n')}`);
});

test('pliki czytające APP_ENV do decyzji importują src/app-env.js', () => {
  // Pliki, które przekazują APP_ENV do funkcji (nie tylko dalej w obiekcie env),
  // muszą ją importować ze wspólnego modułu, a nie definiować własnej.
  const files = sourceFiles().filter((file) => file !== MODULE);
  const offenders = [];
  for (const file of files) {
    const code = stripComments(readFileSync(join(root, file), 'utf8'));
    const calls = code.match(/\b(\w+)\(\s*[\w$.?]*APP_ENV\b/g) ?? [];
    for (const call of calls) {
      const fn = call.slice(0, call.indexOf('('));
      if (['guardDangerousOperation', 'appEnvWarning', 'appEnvLabel', 'resolveAppEnv', 'isProductionEnv', 'isProductionLikeEnv', 'isLocalAppEnv', 'isTestEnv', 'sessionCookieName'].includes(fn)) {
        const imported = new RegExp(`import\\s*\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*from\\s*['"][./]*(?:src/)?(?:\\.\\./)*app-env\\.js['"]`).test(code)
          || (fn === 'sessionCookieName' && /from\s*['"][./]*(?:src\/)?auth\.js['"]/.test(code));
        if (!imported) offenders.push(`${file}: ${fn}(…APP_ENV) bez importu z app-env.js`);
      } else {
        offenders.push(`${file}: własna funkcja ${fn}(…APP_ENV) — przenieś rozpoznanie do ${MODULE}`);
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('skaner wykrywa typowe obejścia (kontrola samego testu)', () => {
  const samples = [
    "if (process.env.APP_ENV === 'production') {}",
    "if ('production' !== env.APP_ENV) {}",
    'const x = env.APP_ENV?.toLowerCase();',
    "const x = String(process.env.APP_ENV ?? '');",
    "const x = env.APP_ENV || 'development';",
    'if (LOCAL.has(env.APP_ENV)) {}',
    "if (appEnv === 'test') {}",
    "return LOCAL.has(String(appEnv ?? '').trim().toLowerCase());",
    'const name = appEnv.trim();',
  ];
  for (const sample of samples) {
    assert.ok(FORBIDDEN.some(({ re }) => re.test(stripComments(sample))), sample);
  }
  for (const ok of ['APP_ENV: processEnv.APP_ENV,', 'if (isProductionLikeEnv(env.APP_ENV)) {}', '// APP_ENV === production w komentarzu']) {
    assert.ok(!FORBIDDEN.some(({ re }) => re.test(stripComments(ok))), ok);
  }
});
