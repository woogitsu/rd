// #208, kryterium „każda blokada wiersza ma dowód”: test-strażnik bez bazy. Skanuje
// src/pg (scripts/lock-inventory.js) w poszukiwaniu `FOR UPDATE`, `FOR NO KEY UPDATE`,
// `FOR SHARE` i `FOR KEY SHARE` w kodzie (bez komentarzy) i wymaga, żeby każde
// wystąpienie miało mutant w scripts/check-lock-mutations.js (usunięcie blokady czerwieni
// test z barierą na prawdziwym PostgreSQL) albo wpis w LOCK_EXCEPTIONS z uzasadnieniem.
// Nowa blokada bez mutanta i bez wyjątku oblewa ten test. Dopasowanie: plik + funkcja +
// tabela + rodzaj blokady (nie numer linii). Tabela pokrycia w docs/TESTING.md musi być
// równa wygenerowanej (`node scripts/lock-inventory.js --markdown`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { MUTANTS, functionRange } from '../scripts/check-lock-mutations.js';
import {
  LOCK_EXCEPTIONS, LOCK_KINDS, TABLE_END, TABLE_START, coverage, coverageTable, lockKey, maskComments, scanRepository, scanSource,
} from '../scripts/lock-inventory.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const migrationsDir = new URL('../postgres/migrations/', import.meta.url);
const migrationsText = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => readFileSync(new URL(f, migrationsDir), 'utf8')).join('\n');
const locks = scanRepository();
const rows = coverage(locks, MUTANTS);
const CATEGORIES = new Set(['zagnieżdżona', 'ograniczenie', 'luka']);
const rowLockMutants = MUTANTS.filter((m) => m.kind !== 'advisory');

// Funkcje najwyższego poziomu, które wołają `fn(…, { lock: true })` — albo, z `lockOption:
// false`, każde wywołanie `fn(…)` (bez definicji samej funkcji).
function scanCallers(source, fn, { lockOption = true } = {}) {
  const names = [];
  const call = lockOption ? `\\b${fn}\\([^)]*\\{ lock: true \\}\\)` : `(?<!function )\\b${fn}\\(`;
  for (const match of source.matchAll(new RegExp(call, 'g'))) {
    const before = source.slice(0, match.index);
    const header = [...before.matchAll(/^(?:export )?(?:async )?function (\w+)\(/gm)].pop();
    if (header && !names.includes(header[1])) names.push(header[1]);
  }
  return names;
}

// Wyjątek „zagnieżdżona”: funkcja z blokadą woła wcześniej funkcję mutanta zewnętrznego
// (`outer`), albo robi to każdy, kto ją woła. Zwraca listę naruszeń (pusta = w porządku).
function nestedProblems(source, e, outer) {
  const key = lockKey({ ...e, kind: e.kind ?? 'for-update' });
  const body = (fn) => { const range = functionRange(source, fn); return range ? source.slice(...range) : ''; };
  const callsOuter = (fn) => body(fn).includes(`${outer.fn}(`);
  if (callsOuter(e.fn)) return [];
  // Pomocnik z opcją `lock` (np. loadNotice): każde wywołanie z blokadą jest w funkcji,
  // która wcześniej bierze blokadę zewnętrzną.
  const lockCallers = scanCallers(source, e.fn);
  if (lockCallers.length) {
    return lockCallers.filter((caller) => !callsOuter(caller)).map((caller) => `${key}: ${caller} woła ${e.fn} z blokadą bez ${outer.fn}`);
  }
  // Pomocnik bez opcji `lock` (np. activeFactors w mfa.js): nieeksportowany, a każda funkcja
  // modułu, która go woła, woła wcześniej funkcję blokady zewnętrznej.
  if (new RegExp(`^export (?:async )?function ${e.fn}\\(|^export \\{[^}]*\\b${e.fn}\\b`, 'm').test(source)) {
    return [`${key}: ${e.fn} jest eksportowana — wywołania spoza modułu mogą pominąć ${outer.fn}`];
  }
  const callers = scanCallers(source, e.fn, { lockOption: false });
  if (!callers.length) return [`${key}: funkcja nie woła ${outer.fn} i nikt jej nie woła`];
  return callers.filter((caller) => {
    const text = body(caller);
    const outerAt = text.indexOf(`${outer.fn}(`);
    return outerAt < 0 || outerAt > text.search(new RegExp(`(?<!function )\\b${e.fn}\\(`));
  }).map((caller) => `${key}: ${caller} woła ${e.fn} bez wcześniejszego ${outer.fn}`);
}

test('skaner: komentarze nie są blokadą, `OF alias` wskazuje tabelę aliasu, rozpoznaje FOR SHARE i FOR NO KEY UPDATE', () => {
  const source = [
    '// SELECT … FOR UPDATE w komentarzu',
    "async function a(tx) { await tx.query('SELECT s.id FROM students s JOIN guardians g ON g.id = s.g WHERE s.id = $1 FOR UPDATE OF s'); }",
    '/* FOR SHARE w komentarzu blokowym */',
    'async function b(tx) {',
    '  const re = /[\'"]/; // FOR UPDATE po wyrażeniu regularnym w komentarzu',
    "  await tx.query(`SELECT id FROM users WHERE id = ${'$'}1 ${true ? 'FOR SHARE' : ''}`);",
    "  await tx.query('SELECT 1 FROM x WHERE (a, b) IN (SELECT * FROM unnest($1::text[], $2::text[])) FOR NO KEY UPDATE');",
    '}',
    "const c = () => 'FROM orphan FOR UPDATE';",
  ].join('\n');
  assert.equal(maskComments(source).length, source.length);
  const found = scanSource(source, 'x.js').map(({ fn, table, kind, line }) => ({ fn, table, kind, line }));
  assert.deepEqual(found, [
    { fn: 'a', table: 'students', kind: 'for-update', line: 2 },
    { fn: 'b', table: 'users', kind: 'for-share', line: 6 },
    { fn: 'b', table: 'x', kind: 'for-no-key-update', line: 7 },
    // Stała po funkcji (nie WIELKIMI literami) należy do niej — te same granice co
    // functionRange w check-lock-mutations.js, więc mutant funkcji `b` usunąłby i tę blokadę.
    { fn: 'b', table: 'orphan', kind: 'for-update', line: 9 },
  ]);
});

test('inwentaryzacja: każda blokada wiersza w src/pg ma mutant albo jawny wyjątek (i nigdy oba)', () => {
  assert.ok(locks.length >= 80, `skaner znalazł podejrzanie mało blokad: ${locks.length}`);
  for (const lock of locks) {
    assert.ok(lock.fn, `${lock.file}:${lock.line}: blokada poza funkcją najwyższego poziomu`);
    assert.ok(lock.table, `${lock.file}:${lock.line} (${lock.fn}): nie da się ustalić tabeli blokady`);
  }
  const keys = locks.map(lockKey);
  assert.equal(new Set(keys).size, keys.length, 'dwie blokady o tym samym kluczu plik#funkcja:tabela:rodzaj — rozdziel je albo doprecyzuj skaner');
  const missing = rows.filter((r) => !r.mutants.length && !r.exceptions.length).map((r) => `${lockKey(r.lock)} (linia ${r.lock.line})`);
  assert.deepEqual(missing, [], 'blokada bez mutanta i bez wyjątku: dodaj mutant w scripts/check-lock-mutations.js z testem z barierą albo wpis w LOCK_EXCEPTIONS z uzasadnieniem');
  const both = rows.filter((r) => r.mutants.length && r.exceptions.length).map((r) => lockKey(r.lock));
  assert.deepEqual(both, [], 'blokada z mutantem nie może być jednocześnie wyjątkiem');
});

test('wyjątki: każdy wskazuje istniejącą blokadę, ma kategorię, powód i sprawdzalny dowód', () => {
  const lockKeys = new Set(locks.map(lockKey));
  const exceptionKeys = LOCK_EXCEPTIONS.map((e) => lockKey({ ...e, kind: e.kind ?? 'for-update' }));
  assert.equal(new Set(exceptionKeys).size, exceptionKeys.length, 'zduplikowany wyjątek');
  for (const [i, e] of LOCK_EXCEPTIONS.entries()) {
    const key = exceptionKeys[i];
    assert.ok(lockKeys.has(key), `${key}: wyjątek bez blokady w kodzie (nieaktualny — usuń go)`);
    assert.ok(CATEGORIES.has(e.category), `${key}: nieznana kategoria ${e.category}`);
    assert.ok(typeof e.reason === 'string' && e.reason.length >= 80, `${key}: uzasadnienie za krótkie`);
    if (e.category === 'zagnieżdżona') {
      const outer = MUTANTS.find((m) => m.id === e.outer);
      assert.ok(outer, `${key}: blokada zewnętrzna musi mieć mutant (outer = id z MUTANTS), jest: ${e.outer}`);
      // Blokada zewnętrzna jest w tym samym module (lockEvent, lockMeeting, loadReconciliation, lockGrantChanges).
      assert.equal(outer.file, e.file, `${key}: mutant ${e.outer} dotyczy innego pliku`);
      assert.deepEqual(nestedProblems(read(e.file), e, outer), []);
    } else if (e.category === 'ograniczenie') {
      assert.ok(e.evidence && (e.evidence.migration || e.evidence.code), `${key}: brak evidence (migration albo code)`);
      if (e.evidence.migration) {
        assert.ok(migrationsText.includes(e.evidence.migration), `${key}: „${e.evidence.migration}” nie występuje w postgres/migrations`);
      } else {
        const fn = e.evidence.in ?? e.fn;
        const range = functionRange(read(e.file), fn);
        assert.ok(range, `${key}: brak funkcji ${fn} w ${e.file}`);
        assert.ok(read(e.file).slice(...range).includes(e.evidence.code), `${key}: fragment „${e.evidence.code}” nie występuje w ${fn}`);
      }
    } else {
      assert.equal(e.outer ?? e.evidence ?? null, null, `${key}: luka nie ma dowodu serializacji — bez outer/evidence`);
      assert.match(e.reason, /Brak testu z barierą/, `${key}: luka musi to nazwać wprost`);
    }
  }
});

test('mutanty blokad wierszy: rodzaj ze skanera, a funkcja z kilkoma blokadami ma mutant na konkretną tabelę', () => {
  for (const mutant of rowLockMutants) {
    assert.ok(LOCK_KINDS[mutant.kind], `${mutant.id}: nieznany rodzaj ${mutant.kind}`);
    const inFunction = locks.filter((l) => l.file === mutant.file && l.fn === mutant.fn && l.kind === mutant.kind);
    assert.ok(inFunction.length > 0, `${mutant.id}: brak blokady ${mutant.kind} w ${mutant.file}#${mutant.fn}`);
    const tables = new Set(inFunction.map((l) => l.table));
    if (tables.size > 1) {
      assert.ok(mutant.table, `${mutant.id}: ${mutant.fn} ma blokady kilku tabel (${[...tables].join(', ')}) — mutant musi wskazać \`table\`, żeby dowód dotyczył jednej blokady`);
    }
    if (mutant.table) assert.ok(tables.has(mutant.table), `${mutant.id}: brak blokady tabeli ${mutant.table} w ${mutant.fn}`);
  }
});

test('kontrola pozytywna: wyjątek „zagnieżdżona” dla pomocnika bez opcji `lock` wykrywa wywołanie bez blokady zewnętrznej', () => {
  const e = LOCK_EXCEPTIONS.find((x) => x.file === 'src/pg/mfa.js' && x.fn === 'activeFactors');
  assert.ok(e, 'brak wyjątku activeFactors w LOCK_EXCEPTIONS');
  const outer = MUTANTS.find((m) => m.id === e.outer);
  const source = read(e.file);
  assert.deepEqual(nestedProblems(source, e, outer), []);
  const unlocked = `${source}\nasync function bezBlokady(tx, userId) {\n  return activeFactors(tx, userId);\n}\n`;
  assert.deepEqual(nestedProblems(unlocked, e, outer), ['src/pg/mfa.js#activeFactors:user_mfa_factors:for-update: bezBlokady woła activeFactors bez wcześniejszego lockUser']);
  const late = `${source}\nasync function zaPozno(tx, userId) {\n  const f = await activeFactors(tx, userId);\n  await lockUser(tx, userId);\n  return f;\n}\n`;
  assert.equal(nestedProblems(late, e, outer).length, 1);
  const exported = source.replace('async function activeFactors(', 'export async function activeFactors(');
  assert.match(nestedProblems(exported, e, outer).join('\n'), /jest eksportowana/);
});

test('kontrola pozytywna: nowa blokada bez mutanta i bez wyjątku jest wykrywana, a wyjątek innej tabeli jej nie pokrywa', () => {
  const file = 'src/pg/routes/payments.js';
  const source = `${read(file)}\nasync function nowaFunkcja(tx) {\n  await tx.query('SELECT id FROM payment_entries WHERE id = $1 FOR UPDATE', ['p']);\n}\n`;
  const extra = scanSource(source, file).filter((l) => l.fn === 'nowaFunkcja');
  assert.equal(extra.length, 1);
  const [row] = coverage(extra, MUTANTS, [...LOCK_EXCEPTIONS, { file, fn: 'nowaFunkcja', table: 'ledger_entries', category: 'luka', reason: 'x' }]);
  assert.deepEqual([row.mutants.length, row.exceptions.length], [0, 0]);
  // Mutant ograniczony do innej tabeli też nie pokrywa blokady.
  const [scoped] = coverage(extra, [{ id: 't', file, fn: 'nowaFunkcja', kind: 'for-update', table: 'ledger_entries' }]);
  assert.equal(scoped.mutants.length, 0);
  // FOR SHARE nie jest pokrywany przez mutant `for-update` tej samej funkcji.
  const shared = scanSource("async function f(tx) { await tx.query('SELECT id FROM t WHERE id = $1 FOR SHARE'); }\n", 'x.js');
  assert.equal(coverage(shared, [{ id: 'u', file: 'x.js', fn: 'f', kind: 'for-update' }])[0].mutants.length, 0);
});

test('docs/TESTING.md: tabela pokrycia blokad jest równa wygenerowanej z kodu', () => {
  const docs = read('docs/TESTING.md');
  const start = docs.indexOf(TABLE_START);
  const end = docs.indexOf(TABLE_END);
  assert.ok(start >= 0 && end > start, 'brak znaczników tabeli pokrycia w docs/TESTING.md');
  assert.equal(docs.slice(start, end + TABLE_END.length), coverageTable(rows),
    'tabela pokrycia nieaktualna: wklej wynik `node scripts/lock-inventory.js --markdown` do docs/TESTING.md');
});
