// Lint jakości testów (#214). Zielone CI ma coś znaczyć, więc pilnujemy wzorców,
// które pozwalają przejść regresji: asercje bez treści, pętle asercji na pustych
// danych, `todo`/`skip` bez uzasadnienia, mocki bazy ignorujące SQL i zdania
// o zależności testów od kolejności. Każda reguła ma kontrolę pozytywną (kod,
// który reguła MUSI wykryć), więc sam lint nie przechodzi „na pusto”.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYNTHETIC_PHONE_IN_TEXT, assertCaptured, assertEvery } from './helpers/assertions.js';

const TESTS_DIR = new URL('./', import.meta.url);

// `assert.ok(x.every(...))` jest zakazane we WSZYSTKICH plikach testów (#214):
// przechodzi na pustej kolekcji. Użyj assertEvery (wymaga niepustej kolekcji)
// albo jawnej kontroli długości w tej samej asercji (`x.length > 0 && x.every(...)`).
const EVERY_LENGTH_GUARD = /\.length\s*(?:>=?|===?)\s*\d+\s*&&/;

// Obejście triggerów w teście (`ALTER TABLE … DISABLE TRIGGER`, `SET
// session_replication_role = replica`) pozwala przemycić stan, którego
// produkcja nie dopuszcza (#214). Dozwolone tylko w plikach z tej listy, każdy
// z uzasadnieniem; do cofania czasu służy wstrzykiwany zegar (`now`), nie
// wyłączony strażnik. Wpis bez obejścia w pliku oblewa meta-test (lista nie
// może rosnąć po cichu ani zostawać nieaktualna).
// Najczęstszy przypadek: zamknięty rok bez procedury /close (lista kontrolna,
// bilans, dwie osoby) — test sprawdza wyłącznie reakcję PRAWDZIWEGO triggera
// zamrożenia roku (a0_year_freeze) na zapis przez API.
const CLOSED_YEAR_SHORTCUT = 'zamknięcie roku na skróty (INSERT do school_year_closures bez procedury /close); test sprawdza reakcję prawdziwego triggera zamrożenia roku';
// Upływ czasu przez przestawienie niezmiennego terminu z wyłączonym strażnikiem.
// Docelowo: wstrzykiwany zegar (`now`) w funkcji produkcyjnej, jak
// acceptInvitation w tests/pg-auth.test.js — wymaga zmiany kodu aplikacji (follow-up #214).
const CLOCK_FOLLOW_UP = 'upływ ważności przez zmianę niezmiennego terminu z wyłączonym strażnikiem — funkcja produkcyjna liczy czas przez now() w SQL i nie przyjmuje zegara; follow-up #214: wstrzykiwany `now`';
export const TRIGGER_BYPASS_ALLOWED = Object.freeze({
  // SR-05 (#101): test dowodzi, że rola aplikacji NIE może wyłączyć triggerów (42501); właściciel w kontroli pozytywnej.
  'pg-real-app-role.test.js': 'próby DISABLE TRIGGER rolą rd_app muszą kończyć się błędem uprawnień (42501); kontrola pozytywna na roli właściciela',
  // Wykrywanie naruszeń danych zapisanych z pominięciem API i triggerów.
  'pg-report-snapshots.test.js': 'naruszenie migawki raportu poza API (superużytkownik) musi być wykryte przy odczycie; wpis po zamknięciu roku zmienia treść bez triggera zamrożenia',
  'pg-email.test.js': 'approval_mismatch: treść kampanii zmieniona w bazie z pominięciem strażnika po zatwierdzeniu — test wykrycia naruszenia',
  'restore-drill-local.test.js': 'utrata wiersza w bazie docelowej po odtworzeniu — próba odtworzenia musi zgłosić niezgodność raportu',
  // Wiersze sprzed zabezpieczeń (legacy/D1, migracje) — testy migracji i autoryzacji.
  'pg-year-close-class-grants.test.js': 'odtworzenie procedury z nagłówka migracji 0143 (ręczna korekta roku przydziału z wyłączonym role_grants_guard)',
  'pg-schema-consistency-0143.test.js': 'wiersz role_grants sprzed 0081 (klasa spoza roku) — migracja 0143 musi go wykryć i zatrzymać się bez zmian',
  'pg-export.test.js': 'przydział sprzed 0081/a0_year_freeze (np. z importu D1) — autoryzacja i tak nie może go uznać',
  'pg-email-payment-instructions.test.js': 'kampania z {rachunek} zatwierdzona/zakolejkowana przed migracją 0162 (approved_payment_instructions_id = NULL) — kolejka, wznowienie i worker muszą ją zatrzymać',
  'pg-year-close-year-end-check.test.js': 'wpisy księgi datowane po końcu roku istnieją tylko sprzed walidacji 0027 — kontrola końca roku musi je wykazać',
  'pg-reconciliation.test.js': 'korekty wpłat/księgi w stanie, który dziś blokuje active_bank_match (dane sprzed blokady) — widok uzgodnienia musi go pokazać',
  'pg-primary-household.test.js': 'stan po dniu D zaplanowanej zmiany gospodarstwa bez przepisania kolumny zgodności — zegara SQL (current_date) nie da się wstrzyknąć',
  'pg-list-cursor-email-requests.test.js': 'fixture 225 wiadomości failed w kolejce bez zatwierdzania kampanii — test stronicowania listy „do sprawdzenia”',
  'pg-audit-reviews.test.js': `${CLOSED_YEAR_SHORTCUT}; sprawdza odrzucenie nowych uwag KR w zamkniętym roku (0176)`,
  'pg-ledger-cost-centers.test.js': `${CLOSED_YEAR_SHORTCUT}; odwołanie wydarzenia bez procedury, by sprawdzić sekcję „Wynik wydarzeń” raportu KR`,
  // Upływ czasu (follow-up: wstrzykiwany zegar).
  'pg-bootstrap-admin.test.js': CLOCK_FOLLOW_UP,
  // Zamknięty rok na skróty.
  ...Object.fromEntries([
    'security-scope-api.test.js', 'pg-ledger-budget.test.js', 'pg-ledger-categories-api.test.js', 'pg-events-ics.test.js',
    'pg-db-errors.test.js', 'pg-documents.test.js', 'pg-event-tasks.test.js', 'pg-family-changes.test.js',
    'pg-ledger-replacement-links.test.js', 'pg-ledger-replacement.test.js', 'pg-ledger-review-resolution.test.js',
    'pg-meetings-cancel-notice.test.js', 'pg-payment-allocations.test.js', 'pg-promotions.test.js',
    'pg-reconciliation-abandon.test.js', 'pg-reconciliation-batch.test.js', 'pg-reconciliation-group-matches.test.js',
    'pg-reconciliation-refund-match.test.js', 'pg-school-year-dates.test.js', 'pg-year-close-finance-freeze.test.js',
  ].map((name) => [name, CLOSED_YEAR_SHORTCUT])),
});
// Limity (#214): lista jest sufitem, który może tylko maleć. Nowy plik albo
// kolejne użycie obejścia ponad limit oblewa meta-test; przy usunięciu obejścia
// obniż limit do stanu faktycznego (meta-test wymaga równości, nie nierówności).
export const TRIGGER_BYPASS_LIMITS = Object.freeze({ files: 35, lines: 50 });
const TRIGGER_BYPASS = /DISABLE\s+TRIGGER|session_replication_role\s*=\s*replica/i;

// Negatywna asercja na KRÓTKIM podciągu cyfr (`!meta.includes('470')`) jest
// niestabilna: taki podciąg trafia losowo w UUID, skrót albo znacznik czasu
// w metadanych (#548). Szukaj całej wartości (np. SYNTHETIC_PHONE_IN_TEXT)
// albo liczby jako osobnego tokenu (`/(?<![\w-])2500(?![\w-])/`).
const SHORT_DIGITS_NEGATIVE = [
  /!\s*[^\s!&|]*\.includes\((['"`])\d{1,5}\1\)/,
  /\.includes\((['"`])\d{1,5}\1\)\s*,\s*false\b/,
];

// Pliki, w których wolno używać opcji `todo` testu (pilnowane osobnym meta-testem
// ALLOWED_TODO w pg-authz-matrix.test.js). Bezwarunkowy `skip` jest zakazany
// wszędzie; dozwolony jest tylko skip warunkowy ze zmiennej (np. brak
// RD_TEST_PG_URL), bo wtedy test nie znika po cichu przy pełnej konfiguracji.
const TODO_ALLOWED = new Set(['pg-authz-matrix.test.js']);

const PARALLEL_WORDING = /\b(?:parallel|simultaneous|concurrent)\b|równoległ|jednocześnie|jednoczesn|\bnaraz\b|równocz/i;
const SEQUENTIAL_LABEL = /PGlite|sequential|po kolei|sekwencyjn|w procesie Node/i;

// Zwraca listę naruszeń { rule, line } dla treści pliku.
export function lintSource(name, text) {
  const violations = [];
  const lines = text.split('\n');
  const flag = (rule, index) => violations.push({ rule, line: index + 1, text: lines[index].trim() });
  const realPg = /process\.env\.RD_TEST_(?:PG_URL|DATABASE_URL)/.test(text);
  const pglite = /helpers\/pg\.js/.test(text);
  lines.forEach((line, index) => {
    if (/^\s*\/\//.test(line)) return;
    if (/\bassert(?:\.ok|\.equal|\.strictEqual)?\(\s*true\s*(?:,\s*true\s*)?[,)]/.test(line)) flag('assert-true-literal', index);
    if (/\bassert\.(?:equal|strictEqual|deepEqual)\(\s*(true|false|null|0|1)\s*,\s*\1\s*[,)]/.test(line)) flag('assert-literal-equals-itself', index);
    if (/\.forEach\(\s*\(?[\w\s,]*\)?\s*=>\s*\{\s*\}\s*\)/.test(line)) flag('empty-foreach', index);
    if (/for\s*\([^)]*\)\s*\{\s*\}/.test(line)) flag('empty-for-loop', index);
    if (/\bassert(?:\.\w+)?\(.*\.every\(/.test(line) && !EVERY_LENGTH_GUARD.test(line)) flag('every-without-nonempty', index);
    if (TRIGGER_BYPASS.test(line) && !Object.hasOwn(TRIGGER_BYPASS_ALLOWED, name)) flag('trigger-bypass-not-allowed', index);
    if (SHORT_DIGITS_NEGATIVE.some((pattern) => pattern.test(line))) flag('short-digit-negative-substring', index);
    if (/\{\s*todo\b|\.todo\(/.test(line) && !TODO_ALLOWED.has(name)) flag('todo-not-allowed', index);
    if (/\{\s*skip:\s*(?:true|['"`])|\.skip\(/.test(line)) flag('unconditional-skip', index);
    if (/first:\s*async\s*\(\)\s*=>\s*(?:session|row|result|user)\b/.test(line)) flag('db-mock-ignores-sql', index);
    if (/kolejność ma znaczenie/i.test(line)) flag('order-dependent-tests', index);
    // #208: PGlite wykonuje transakcje po kolei — nazwa testu bez prawdziwego
    // PostgreSQL nie może obiecywać wyścigu, serializacji ani braku zakleszczenia.
    if (!realPg && /^\s*(?:test|it)\(\s*['"`].*(?:truly parallel|are serialized|bez zakleszczenia)/i.test(line)) flag('pglite-race-claim', index);
    // Nazwa obiecująca równoległość/jednoczesność na PGlite musi mówić, że to
    // odtworzenie po kolei (idempotencja), nie wyścig; wyścig sprawdza tests/pg-real-*.
    if (pglite && !realPg && /^\s*(?:test|it)\(\s*['"`]/.test(line) && PARALLEL_WORDING.test(line) && !SEQUENTIAL_LABEL.test(line)) flag('pglite-parallel-unlabeled', index);
  });
  return violations;
}

test('lint testów: reguły wykrywają wzorce zakazane (kontrola pozytywna)', () => {
  const cases = [
    ['x.test.js', 'assert.ok(true);', 'assert-true-literal'],
    ['x.test.js', 'assert.equal(true, true);', 'assert-literal-equals-itself'],
    ['x.test.js', 'items.forEach(() => {});', 'empty-foreach'],
    ['x.test.js', 'for (const row of rows) {}', 'empty-for-loop'],
    ['pg-email.test.js', 'assert.ok(rows.every((row) => row.ok));', 'every-without-nonempty'],
    ['x.test.js', "test('a', { todo: 'później' }, () => {});", 'todo-not-allowed'],
    ['x.test.js', "test.skip('a', () => {});", 'unconditional-skip'],
    ['x.test.js', "test('a', { skip: true }, () => {});", 'unconditional-skip'],
    ['x.test.js', 'const statement = { first: async () => session };', 'db-mock-ignores-sql'],
    ['x.test.js', '// Testy wykonują się po kolei; kolejność ma znaczenie.\nconst x = "kolejność ma znaczenie";', 'order-dependent-tests'],
    // Reguła „every” obejmuje każdy plik, nie tylko listę z #214.
    ['admin-ops-status.test.js', 'assert.ok(rows.every((row) => row.ok), "opis");', 'every-without-nonempty'],
    ['x.test.js', "await db.exec('ALTER TABLE invitations DISABLE TRIGGER invitations_guard');", 'trigger-bypass-not-allowed'],
    ['x.test.js', '  SET session_replication_role = replica;', 'trigger-bypass-not-allowed'],
    ['x.test.js', "assert.ok(!meta.includes('470'));", 'short-digit-negative-substring'],
    ['x.test.js', "assert.ok(!JSON.stringify(metadata).includes('2500'), text);", 'short-digit-negative-substring'],
    ['x.test.js', "assert.ok(audit.includes('piiConfirmed') && !audit.includes('470'));", 'short-digit-negative-substring'],
    ['x.test.js', "assert.equal(text.includes(`5390`), false);", 'short-digit-negative-substring'],
    ['x.test.js', 'assert.equal(rows.every((row) => row.ok), true);', 'every-without-nonempty'],
    ['x.test.js', "import { createTestDb } from './helpers/pg.js';\ntest('two parallel drafts: second gets 409', async () => {});", 'pglite-parallel-unlabeled'],
    ['x.test.js', "test('two truly parallel edits: one 409', async () => {});", 'pglite-race-claim'],
  ];
  for (const [name, source, rule] of cases) {
    assert.ok(lintSource(name, source).some((violation) => violation.rule === rule), `reguła ${rule} musi wykryć: ${source}`);
  }
  // Poprawne wzorce przechodzą: every z kontrolą długości w tej samej asercji,
  // obejście triggera w pliku z listy (z uzasadnieniem), pełna wartość zamiast
  // krótkiego podciągu i pozytywne `includes` krótkiej liczby.
  assert.deepEqual(lintSource('x.test.js', 'assert.ok(rows.length > 0 && rows.every((row) => row.ok));'), []);
  assert.deepEqual(lintSource('pg-email.test.js', "await t.db.exec('ALTER TABLE email_campaigns DISABLE TRIGGER email_campaigns_guard');"), []);
  assert.deepEqual(lintSource('x.test.js', '// komentarz: ALTER TABLE ... DISABLE TRIGGER jest tu zakazane'), []);
  assert.deepEqual(lintSource('x.test.js', "assert.ok(!meta.includes('470 12 34 56') && !SYNTHETIC_PHONE_IN_TEXT.test(meta));"), []);
  assert.deepEqual(lintSource('x.test.js', "assert.ok(text.includes('2500'));"), []);
  assert.deepEqual(lintSource('x.test.js', "test('a', { skip }, () => {});"), [], 'skip warunkowy ze zmiennej jest dozwolony');
  assert.deepEqual(lintSource('pg-authz-matrix.test.js', "test('a', { todo: 'x' }, () => {});"), []);
  assert.deepEqual(lintSource('x.test.js', "const skip = !process.env.RD_TEST_PG_URL;\ntest('two truly parallel edits', { skip }, async () => {});"), [],
    'na prawdziwym PostgreSQL nazwa może mówić o wyścigu');
  assert.deepEqual(lintSource('x.test.js', "import { createTestDb } from './helpers/pg.js';\ntest('two parallel drafts (sequential on PGlite): second gets 409', async () => {});"), []);
  assert.deepEqual(lintSource('pg-email.test.js', 'assertEvery(rows, (row) => row.ok);\nassert.equal(rows.length, 3);'), []);
});

test('lint testów: pliki testów nie łamią reguł jakości', async () => {
  const names = (await readdir(TESTS_DIR)).filter((name) => name.endsWith('.test.js') && name !== 'test-quality-lint.test.js');
  assertCaptured(names, { min: 50, message: 'lint musi objąć pliki testów (katalog tests/)' });
  const problems = [];
  for (const name of names) {
    const text = await readFile(new URL(name, TESTS_DIR), 'utf8');
    for (const violation of lintSource(name, text)) problems.push(`${name}:${violation.line} [${violation.rule}] ${violation.text}`);
  }
  assert.deepEqual(problems, []);
});

// Lista obejść triggerów nie może zawierać wpisów martwych ani bez uzasadnienia.
export function triggerBypassProblems(allowed, textOf) {
  const problems = [];
  for (const [name, reason] of Object.entries(allowed)) {
    if (String(reason ?? '').length < 40) problems.push(`${name}: za krótkie uzasadnienie`);
    const text = textOf(name);
    if (text === null) { problems.push(`${name}: brak pliku`); continue; }
    const code = text.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
    if (!TRIGGER_BYPASS.test(code)) problems.push(`${name}: wpis bez obejścia triggera — usuń go z listy`);
  }
  return problems;
}

test('lint testów: każdy wpis TRIGGER_BYPASS_ALLOWED ma uzasadnienie i odpowiada obejściu w pliku', async () => {
  const names = Object.keys(TRIGGER_BYPASS_ALLOWED);
  assertCaptured(names, { message: 'lista obejść jest pusta — usuń regułę albo meta-test' });
  const texts = new Map();
  for (const name of names) {
    try { texts.set(name, await readFile(new URL(name, TESTS_DIR), 'utf8')); } catch { texts.set(name, null); }
  }
  assert.deepEqual(triggerBypassProblems(TRIGGER_BYPASS_ALLOWED, (name) => texts.get(name)), []);
  // Kontrola pozytywna: martwy wpis, brak pliku i puste uzasadnienie są wykrywane.
  const fake = { 'a.test.js': 'x'.repeat(50), 'b.test.js': 'x'.repeat(50), 'c.test.js': 'krótko' };
  const fakeText = { 'a.test.js': "// ALTER TABLE t DISABLE TRIGGER g\nawait db.query('SELECT 1');", 'b.test.js': null, 'c.test.js': "await db.exec('SET session_replication_role = replica');" };
  assert.deepEqual(triggerBypassProblems(fake, (name) => fakeText[name]), [
    'a.test.js: wpis bez obejścia triggera — usuń go z listy', 'b.test.js: brak pliku', 'c.test.js: za krótkie uzasadnienie',
  ]);
});

export function triggerBypassBudgetProblems(counts, limits) {
  const files = counts.length;
  const lines = counts.reduce((sum, count) => sum + count, 0);
  const problems = [];
  if (files !== limits.files) problems.push(`plików z obejściem triggera: ${files}, limit ${limits.files} — ${files > limits.files ? 'nie dodawaj obejść, użyj wstrzykiwanego zegara lub procedury produkcyjnej' : 'obniż limit'}`);
  if (lines !== limits.lines) problems.push(`linii z obejściem triggera: ${lines}, limit ${limits.lines} — ${lines > limits.lines ? 'nie dodawaj obejść' : 'obniż limit'}`);
  return problems;
}

test('lint testów: liczba obejść triggerów jest równa limitowi (lista może tylko maleć)', async () => {
  const names = (await readdir(TESTS_DIR)).filter((name) => name.endsWith('.test.js') && name !== 'test-quality-lint.test.js');
  const counts = [];
  for (const name of names) {
    const text = await readFile(new URL(name, TESTS_DIR), 'utf8');
    const count = text.split('\n').filter((line) => !/^\s*\/\//.test(line) && TRIGGER_BYPASS.test(line)).length;
    if (count > 0) counts.push(count);
  }
  assertCaptured(counts, { min: 1, message: 'licznik obejść nic nie znalazł — regex lub katalog są błędne' });
  assert.deepEqual(triggerBypassBudgetProblems(counts, TRIGGER_BYPASS_LIMITS), []);
  // Kontrola pozytywna: przekroczenie i niewykorzystany limit są wykrywane.
  assert.equal(triggerBypassBudgetProblems([1, 2, 3], { files: 2, lines: 6 }).length, 1);
  assert.equal(triggerBypassBudgetProblems([1, 2], { files: 2, lines: 5 }).length, 1);
  assert.deepEqual(triggerBypassBudgetProblems([1, 2], { files: 2, lines: 3 }), []);
});

// Asercje „metadane nie zawierają telefonu” szukają całego numeru, w każdym zapisie.
test('SYNTHETIC_PHONE_IN_TEXT wykrywa numer w różnych zapisach i nie trafia w losowe identyfikatory', () => {
  for (const text of ['+32 470 12 34 56', '32470123456', '0470/12.34.56', '{"reason":"Kontakt +32 470 12 34 56"}']) {
    assert.ok(SYNTHETIC_PHONE_IN_TEXT.test(text), text);
  }
  for (const text of ['{"id":"4f70a470-1234-4abc-8470-0000000470ab"}', '470', 'sha256:ab47012c']) {
    assert.ok(!SYNTHETIC_PHONE_IN_TEXT.test(text), text);
  }
});

// Ręczna permutacja kolejności (Node 22 nie ma --test-shuffle): nakładka
// tests/helpers/reverse-order.js odwraca kolejność testów i zestawów, więc
// test korzystający ze stanu poprzednika oblewa (kontrola pozytywna), a
// niezależne testy przechodzą w obu kolejnościach.
test('tests/helpers/reverse-order.js: odwrócona kolejność wykrywa test zależny od poprzednika', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rd-reverse-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'order.test.mjs');
  await writeFile(file, [
    "import test, { describe, after } from 'node:test';",
    "import assert from 'node:assert/strict';",
    'const seen = [];',
    'let state = 0;',
    "test('pierwszy', () => { seen.push('pierwszy'); state = 1; });",
    "describe('zestaw', () => {",
    "  after(() => seen.push('after'));",
    "  test('a', () => { seen.push('a'); });",
    "  test('b', () => { seen.push('b'); });",
    '});',
    "test('drugi', () => { seen.push('drugi'); assert.equal(state, 1, 'zależy od testu pierwszy'); });",
    "process.on('exit', () => console.log('ORDER=' + seen.join(',')));",
  ].join('\n'));
  const setup = fileURLToPath(new URL('setup.js', TESTS_DIR));
  const reverse = fileURLToPath(new URL('helpers/reverse-order.js', TESTS_DIR));
  // Bez NODE_TEST_CONTEXT dziedziczonego z bieżącego przebiegu — inaczej potomny
  // runner raportuje w formacie wewnętrznym zamiast TAP.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = (extra) => spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--import', setup, ...extra, file], { encoding: 'utf8', env });

  const forward = run([]);
  assert.equal(forward.status, 0, forward.stdout + forward.stderr);
  assert.match(forward.stdout, /ORDER=pierwszy,a,b,after,drugi/);

  const reversed = run(['--import', reverse]);
  assert.equal(reversed.status, 1, 'test zależny od poprzednika musi oblać przebieg odwrócony');
  assert.match(reversed.stdout, /ORDER=drugi,b,a,after,pierwszy/);
  assert.match(reversed.stdout, /zależy od testu pierwszy/);
});

test('pomocniki assertEvery/assertCaptured nie przechodzą na pustych danych (kontrola pozytywna)', () => {
  assert.throws(() => assertEvery([], () => true, 'pusta'), /pusta kolekcja/);
  assert.throws(() => assertEvery([1, 2, 3], (n) => n < 3, 'za duże'), /nie spełnia warunku/);
  assert.throws(() => assertCaptured([]), /co najmniej 1/);
  assert.throws(() => assertCaptured([1], { exact: 2 }), /dokładnie 2/);
  assert.doesNotThrow(() => assertEvery([1, 2], (n) => n > 0));
  assert.deepEqual(assertCaptured(['a'], { exact: 1 }), ['a']);
});

// Detektor „bez danych osobowych w logach”: logger piszący adres e-mail MUSI go oblać.
test('detektor danych osobowych w logach oblewa, gdy logger zapisuje adres e-mail (kontrola pozytywna)', () => {
  const noEmails = (lines) => assertEvery(lines, (line) => !line.includes('@'), 'logi bez adresów e-mail');
  assert.doesNotThrow(() => noEmails(['awaria zapisu audytu']));
  assert.throws(() => noEmails(['awaria dla rodzic@example.invalid']), /nie spełnia warunku/);
  assert.throws(() => noEmails([]), /pusta kolekcja/, 'brak przechwyconych logów nie może uchodzić za dowód');
});

// Pułapka na sieć działa globalnie (tests/setup.js): próba użycia sieci oblewa
// proces nawet wtedy, gdy test połknął wyjątek pułapki; pętla zwrotna jest wolna.
test('tests/setup.js: próba fetch poza pętlą zwrotną oblewa przebieg, nawet po połknięciu wyjątku', () => {
  const setup = fileURLToPath(new URL('setup.js', TESTS_DIR));
  const run = (code) => spawnSync(process.execPath, ['--import', setup, '--input-type=module', '-e', code], { encoding: 'utf8' });

  const swallowed = run("try { await fetch('https://example.invalid/x'); } catch {}");
  assert.equal(swallowed.status, 1, swallowed.stderr);
  assert.match(swallowed.stderr, /network_forbidden_in_tests/);

  const thrown = run("await fetch('https://example.invalid/x').then(() => process.exit(3), (e) => { console.log(e.message); });");
  assert.match(thrown.stdout, /network_forbidden_in_tests/);

  const loopback = run("const { createServer } = await import('node:http'); const s = createServer((q, r) => r.end('ok')).listen(0, '127.0.0.1', async () => { const res = await fetch(`http://127.0.0.1:${s.address().port}/`); console.log(await res.text()); s.close(); });");
  assert.equal(loopback.status, 0, loopback.stderr);
  assert.equal(loopback.stdout.trim(), 'ok');

  // Pętla zwrotna na porcie, którego nie otworzył ten proces, jest blokowana.
  const foreign = run("await fetch('http://127.0.0.1:9/').then(() => process.exit(3), (e) => { console.log(e.message); });");
  assert.match(foreign.stdout, /network_forbidden_in_tests/);
  assert.equal(foreign.status, 1, 'próba połączenia z cudzym portem pętli zwrotnej oblewa przebieg');

  const env = run("console.log(process.env.APP_ENV)");
  assert.equal(env.stdout.trim(), process.env.APP_ENV || 'test');
});
