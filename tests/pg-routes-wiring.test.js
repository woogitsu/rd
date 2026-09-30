import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedUserSession } from './helpers/pg.js';

test('events and meetings are served by the PostgreSQL router with server-side sessions', async () => {
  const db = await createTestDb();
  try {
    const env = { db };
    const publicEvents = await handlePgRequest(request('/api/public/events'), env);
    assert.equal(publicEvents.status, 200);

    for (const path of ['/api/events?schoolYearId=y-test', '/api/meetings?schoolYearId=y-test']) {
      const anonymous = await handlePgRequest(request(path), env);
      assert.equal(anonymous.status, 401, path);
    }

    const board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: 'y-test' }], mfa: true });
    for (const path of ['/api/events?schoolYearId=y-test', '/api/meetings?schoolYearId=y-test']) {
      const allowed = await handlePgRequest(request(path, { cookie: board }), env);
      assert.equal(allowed.status, 200, path);
    }

    const crossOrigin = await handlePgRequest(request('/api/events', {
      method: 'POST', cookie: board, origin: 'https://evil.example', body: {},
      headers: { 'Idempotency-Key': 'event-cross-origin-1' },
    }), env);
    assert.equal(crossOrigin.status, 403);
  } finally {
    await db.close();
  }
});

// #157: student_guardians_current (postgres/migrations/0035) jest jedynym
// dozwolonym miejscem sprawdzania, czy relacja opiekun-uczeń jest "aktualna".
// Ponowne wpisanie warunku starts_on/ends_on gdziekolwiek w src/pg psuje ten test.
test('src/pg/** i src/email/** nie powtarzają warunku aktualności student_guardians poza widokiem', () => {
  const srcDir = fileURLToPath(new URL('../src/pg', import.meta.url));
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.js')) {
        const text = readFileSync(path, 'utf8');
        for (const match of text.matchAll(/(\w+)\.(starts_on|ends_on)\b/g)) {
          const alias = match[1];
          // student_guardians_current(_on) i inne widoki/tabele z legalną
          // datą (school_years, students_households itd.) mają własną,
          // dozwoloną semantykę — dotyczy tylko aliasu student_guardians (sg/csg).
          if (!/^(sg|csg)$/.test(alias)) continue;
          offenders.push(`${path}: ${match[0]}`);
        }
      }
    }
  };
  walk(srcDir);
  // Worker e-mail (src/email) sprawdza relację przed wysyłką — ta sama definicja.
  walk(fileURLToPath(new URL('../src/email', import.meta.url)));
  assert.deepEqual(offenders, []);
});

// #155: jeden resolver zakresu przydziałów (src/pg/scope.js). Żaden moduł
// src/pg/** poza scope.js nie filtruje `context.grants`/`actor.grants` sam
// i nie woła surowego `isAuthorized` (które traktuje przydział klasowy jak
// szkolny, gdy wymóg nie podaje classId — SR-01). Nowy moduł ma korzystać z
// resolveScope / isAuthorizedScoped / authorizedClassIds / requireAccess.
const SCOPE_RULES = [
  { name: 'metoda tablicy na przydziałach', pattern: /\bgrants\s*\??\.\s*(filter|some|every|find|findIndex|map|flatMap|forEach|reduce)\s*\(/g },
  { name: 'pętla po przydziałach', pattern: /\bof\s+[\w.?]*\bgrants\b/g },
  { name: 'pole zakresu przydziału', pattern: /\b(grant|g)\s*\??\.\s*(classId|schoolYearId)\b/g },
  { name: 'surowe isAuthorized', pattern: /\bisAuthorized\s*\(/g },
  { name: 'import surowego isAuthorized', pattern: /import\s*\{[^}]*\bisAuthorized\b[^}]*\}\s*from\s*['"][^'"]*authorization\.js['"]/g },
];
// Jedyny wyjątek: hasActiveRole sprawdza status roli (ROLE_STATUS), nie zakres.
const SCOPE_ALLOWED = new Set([
  "src/pg/authorization.js: grants.some(",
]);

function scopeOffenders(relativePath, text) {
  const found = [];
  for (const rule of SCOPE_RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const entry = `${relativePath}: ${match[0].replace(/\s+/g, '')}`;
      if (!SCOPE_ALLOWED.has(entry)) found.push(`${entry} (${rule.name})`);
    }
  }
  return found;
}

test('#155: src/pg/** nie liczy zakresu przydziałów lokalnie — tylko src/pg/scope.js', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.js')) {
        const relativePath = path.slice(root.length).replace(/^\/+/, '');
        if (relativePath === 'src/pg/scope.js') continue;
        offenders.push(...scopeOffenders(relativePath, readFileSync(path, 'utf8')));
      }
    }
  };
  walk(fileURLToPath(new URL('../src/pg', import.meta.url)));
  assert.deepEqual(offenders, []);
});

test('#155: detektor lokalnego zakresu łapie typowe wzorce (samokontrola testu)', () => {
  const samples = [
    'const x = context.grants.filter((grant) => !grant.classId);',
    'actor.grants\n    .some((g) => g.role === "board")',
    'for (const grant of context.grants) count += grant ? 1 : 0;',
    'if (grant.schoolYearId === id) {}',
    "import { isAuthorized } from '../authorization.js';",
    'return isAuthorized(context, requirement);',
  ];
  for (const sample of samples) {
    assert.notDeepEqual(scopeOffenders('src/pg/example.js', sample), [], sample);
  }
  assert.deepEqual(scopeOffenders('src/pg/example.js',
    "import { isAuthorizedScoped } from './scope.js';\nisAuthorizedScoped(context, { roles });"), []);
});
