// #175: spójność dokumentacji — statusy i odwołania do migracji nie mogą
// mylić czytelnika (zarząd, IOD, recenzent PR) co do tego, co jest gotowe
// do testów, a co dopiero planowane.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function listMarkdown(dir) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => join(dir, e.name));
}

const DOC_FILES = [...listMarkdown('docs'), 'postgres/README.md', 'README.md'];
const MIGRATION_FILES = new Set([
  ...readdirSync(join(ROOT, 'postgres/migrations')).filter((f) => f.endsWith('.sql')),
  ...readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')),
]);
const MIGRATION_NUMBERS = new Set([...MIGRATION_FILES].map((f) => f.slice(0, 4)));

// Only flag numbers referenced like a filename (0017_year_close.sql, `0017`,
// migracja 0017) — plain prose mentioning a number (e.g. "oba dostępne numery
// migracji (0060, 0061)", a reserved-but-unused number) is not a claim that
// the file exists. "0000" is below the lowest real migration (0001) and can
// never be a migration filename — it shows up as a bank-format detail code
// (CODA record 21, "szczegółem `0000`" in docs/RECONCILIATION.md) that would
// otherwise look like a backtick-quoted file reference.
function looksLikeMigrationFileRef(num, context) {
  if (num === '0000') return false;
  return new RegExp(`${num}_[a-z]`).test(context)
    || new RegExp('`0\\d{3}`').test(context)
    || new RegExp(`migracj\\w*\\s+${num}\\b`, 'i').test(context);
}

test('every 00NN migration number referenced in docs/*.md, README.md and postgres/README.md exists in postgres/migrations/ or migrations/', () => {
  const missing = [];
  for (const doc of DOC_FILES) {
    const text = readFileSync(join(ROOT, doc), 'utf8');
    for (const match of text.matchAll(/\b(00\d{2})\b/g)) {
      const num = match[1];
      // Numbers below the lowest real migration (0001) or plainly not a
      // migration reference (e.g. amounts, years) are out of scope — only
      // check numbers that appear in a migration-like context: preceded by
      // "migracj" nearby or directly followed by "_" (file name) or a backtick.
      const context = text.slice(Math.max(0, match.index - 30), match.index + 40);
      if (!looksLikeMigrationFileRef(num, context)) continue;
      if (!MIGRATION_NUMBERS.has(num)) missing.push(`${doc}: ${num} (${context.trim()})`);
    }
  }
  assert.deepEqual(missing, [], 'docs reference migration numbers that do not exist');
});

test('kanarek: looksLikeMigrationFileRef ignoruje kod banku `0000`, ale wciąż wykrywa prawdziwe odwołania do pliku migracji', () => {
  // Fałszywy alarm z #175: kod szczegółu rekordu CODA, nie numer migracji.
  assert.equal(looksLikeMigrationFileRef('0000', 'liczy się tylko rekord 21 ze szczegółem `0000`. CAMT'), false);
  // Prawdziwe odwołania (nazwa pliku, backtick, słowo "migracja") nadal wykryte.
  assert.equal(looksLikeMigrationFileRef('0999', '`0999_fake_migration.sql` (#1) dodaje'), true);
  assert.equal(looksLikeMigrationFileRef('0999', 'zobacz `0999` dla szczegółów'), true);
  assert.equal(looksLikeMigrationFileRef('0999', 'patrz migracja 0999 dla szczegółów'), true);
  // Zwykła proza z liczbą bez kontekstu pliku — nie jest odwołaniem.
  assert.equal(looksLikeMigrationFileRef('0999', 'dostępne numery migracji (0060, 0999) do wyboru'), false);
});

test('every file in postgres/migrations/ is mentioned (by filename) in postgres/README.md', () => {
  const readme = readFileSync(join(ROOT, 'postgres/README.md'), 'utf8');
  const missing = [...MIGRATION_FILES]
    .filter((f) => readdirSync(join(ROOT, 'postgres/migrations')).includes(f))
    .filter((f) => !readme.includes(f));
  assert.deepEqual(missing, [], 'postgres/migrations files without a paragraph in postgres/README.md');
});

test('ARCHITECTURE.md entity list only names tables that exist in the schema', () => {
  const architecture = readFileSync(join(ROOT, 'docs/ARCHITECTURE.md'), 'utf8');
  const section = architecture.slice(architecture.indexOf('## Główne encje'), architecture.indexOf('Kwoty przechowywać'));
  // Only the bullet lines are the entity list; prose sentences within them
  // (e.g. "`household_id` ucznia pozostaje...") mention columns, not tables.
  const bulletLines = section.split('\n').filter((line) => line.trim().startsWith('-'));
  const tableNames = [...bulletLines.join('\n').matchAll(/`([a-z][a-z_]+)`/g)]
    .map((m) => m[1])
    .filter((name) => name !== 'household_id');
  assert.ok(tableNames.length > 10, 'expected the entity list to name multiple tables');
  const migrationsText = readdirSync(join(ROOT, 'postgres/migrations'))
    .map((f) => readFileSync(join(ROOT, 'postgres/migrations', f), 'utf8'))
    .join('\n');
  const missing = tableNames.filter((name) => !new RegExp(`CREATE TABLE ${name}\\b`).test(migrationsText));
  assert.deepEqual(missing, [], 'ARCHITECTURE.md names tables that do not exist in postgres/migrations');
});

test('no literal double backslash-n (accidental \\n\\n instead of a real paragraph break) in docs/*.md, README.md or postgres/README.md', () => {
  // A single \n inside a code sample or describing line-ending normalization
  // (docs/EXPORT.md JSONL sample, docs/NEWS.md) is legitimate. \n\n outside
  // a fenced code block is the #175 bug: someone meant a blank line.
  const offenders = [];
  for (const doc of DOC_FILES) {
    const text = readFileSync(join(ROOT, doc), 'utf8');
    const withoutCodeBlocks = text.replace(/```[\s\S]*?```/g, '');
    if (withoutCodeBlocks.includes('\\n\\n')) offenders.push(doc);
  }
  assert.deepEqual(offenders, [], 'literal \\n\\n found outside a code block (should be a real paragraph break)');
});

// ---------------------------------------------------------------------------
// #175 (część 2): opisy migracji w kolejności numerów, słownik „Status:”
// dokumentów modułów, liczby paneli/modułów zgodne z kodem i powrót typowych
// nieaktualnych fraz. Te testy czytają wyłącznie pliki repozytorium.

function paragraphs(text) {
  return text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

const PG_MIGRATION_FILES = readdirSync(join(ROOT, 'postgres/migrations')).filter((f) => f.endsWith('.sql')).sort();
// 0002 i 0003 są opisane w jednym akapicie z 0001_core.sql (pierwszy schemat).
const DESCRIBED_WITH_0001 = new Set(['0002_payments.sql', '0003_ledger.sql']);

function migrationSection() {
  const readme = readFileSync(join(ROOT, 'postgres/README.md'), 'utf8');
  const start = readme.indexOf('## Opisy migracji');
  assert.ok(start >= 0, 'postgres/README.md must have a "## Opisy migracji" section');
  const rest = readme.slice(start + 3);
  const next = rest.search(/\n## /);
  return next >= 0 ? rest.slice(0, next) : rest;
}

function leadingMigration(paragraph) {
  const m = paragraph.match(/^`(\d{4}_[a-z0-9_]+\.sql)`/);
  return m ? m[1] : null;
}

test('postgres/README.md: każdy plik migracji ma własny akapit w sekcji „Opisy migracji”, a akapity idą w kolejności numerów', () => {
  const leads = paragraphs(migrationSection()).map(leadingMigration).filter(Boolean);
  const outOfOrder = [];
  for (let i = 1; i < leads.length; i += 1) {
    if (leads[i] < leads[i - 1]) outOfOrder.push(`${leads[i - 1]} → ${leads[i]}`);
  }
  assert.deepEqual(outOfOrder, [], 'migration paragraphs must be sorted by file number');
  const missing = PG_MIGRATION_FILES.filter((f) => !DESCRIBED_WITH_0001.has(f) && !leads.includes(f));
  assert.deepEqual(missing, [], 'every migration needs its own paragraph starting with its file name (effects on data, rollback)');
  const unknown = leads.filter((f) => !PG_MIGRATION_FILES.includes(f));
  assert.deepEqual(unknown, [], 'paragraph names a migration file that does not exist');
});

test('kanarek: kontrola kolejności wykrywa akapit nie na swoim miejscu', () => {
  const section = '`0002_b.sql` x\n\n`0001_a.sql` y\n\ntekst';
  const leads = paragraphs(section).map(leadingMigration).filter(Boolean);
  assert.deepEqual(leads, ['0002_b.sql', '0001_a.sql']);
  assert.ok(leads[1] < leads[0]);
});

// Dokumenty modułów: akapit „Status” na początku (słownik z #175: model w
// bazie / API na PostgreSQL / panel / staging / produkcja). Nie może sugerować
// wdrożenia ani gotowości do danych rodzin.
const MODULE_DOCS = [
  'docs/ACCOUNTS.md', 'docs/DATA_MODEL.md', 'docs/DOCUMENTS.md', 'docs/EMAIL.md', 'docs/EVENTS.md',
  'docs/EXPORT.md', 'docs/LEDGER.md', 'docs/MEETINGS.md', 'docs/NEWS.md', 'docs/PAYMENTS.md',
  'docs/RECONCILIATION.md', 'docs/YEAR_CLOSE.md',
];

test('dokumenty modułów zaczynają się od akapitu „Status” z informacją o prototypie, danych syntetycznych i braku wdrożenia', () => {
  const problems = [];
  for (const doc of MODULE_DOCS) {
    const head = paragraphs(readFileSync(join(ROOT, doc), 'utf8')).slice(0, 4);
    const status = head.find((p) => /^\**Status\b/.test(p));
    if (!status) { problems.push(`${doc}: brak akapitu „Status” wśród pierwszych akapitów`); continue; }
    if (!/prototyp/i.test(status)) problems.push(`${doc}: Status bez słowa „prototyp”`);
    if (!/syntetycz/i.test(status)) problems.push(`${doc}: Status bez informacji o danych syntetycznych`);
    if (!/niewdroż|nie (?:jest |są |został\w* )?wdroż|nie wykonano|staging: nie/i.test(status)) {
      problems.push(`${doc}: Status nie mówi, że moduł nie jest wdrożony`);
    }
  }
  assert.deepEqual(problems, []);
});

function negatedReadiness(text) {
  const offenders = [];
  for (const match of text.matchAll(/gotow\w* do pracy na danych rodzin/gi)) {
    const before = text.slice(Math.max(0, match.index - 60), match.index).replace(/\*/g, '').toLowerCase();
    if (!/\bnie\b|niegotow|zanim|przed\b|dopiero/.test(before)) offenders.push(before.slice(-40) + match[0]);
  }
  return offenders;
}

test('„gotowy do pracy na danych rodzin” występuje w dokumentacji wyłącznie z zaprzeczeniem (AGENTS.md)', () => {
  const offenders = [];
  for (const doc of DOC_FILES) {
    for (const hit of negatedReadiness(readFileSync(join(ROOT, doc), 'utf8'))) offenders.push(`${doc}: …${hit}`);
  }
  assert.deepEqual(offenders, []);
});

test('kanarek: kontrola gotowości wykrywa zdanie twierdzące i przepuszcza przeczenie', () => {
  assert.equal(negatedReadiness('Moduł jest gotowy do pracy na danych rodzin.').length, 1);
  assert.equal(negatedReadiness('Moduł **nie** jest gotowy do pracy na danych rodzin.').length, 0);
  assert.equal(negatedReadiness('To prototyp, nie funkcja gotowa do pracy na danych rodzin.').length, 0);
});

// Frazy, które #175 usunął jako nieaktualne. Powrót którejś oznacza, że ktoś
// skopiował stary opis — sprawdź kod, zanim zmienisz tę listę.
const STALE_PHRASES = [
  [/nie udostępnia jeszcze API/i, 'moduły mają API na PostgreSQL (src/pg/routes/)'],
  [/API i interfejs powstaną/i, 'API i panele istnieją'],
  [/trzy osobne buildy/i, 'liczba buildów = łańcuch "build" w package.json'],
  [/Przeniesienie zapisu\s+audytu do transakcji nowego API jest osobnym zakresem/i, 'audyt jest w transakcji (tests/audit-transaction-boundary.test.js)'],
  [/Eksport PDF\/CSV \(0016\) powstaje osobno/i, '0016_exports.sql i POST /api/exports istnieją'],
  [/nie mają jeszcze kursora/i, 'listy e-mail i rejestr żądań mają kursor od #543 (docs/API.md)'],
  [/trasy nie istnieją jeszcze/i, 'zakończenie relacji i członkostwa ma trasy od #86 (docs/DATA_MODEL.md)'],
  [/PostgreSQL \(Railway\)/, 'nie sugerować wdrożenia na Railway — „docelowy stos Railway, niewdrożony”'],
];

test('dokumentacja nie zawiera nieaktualnych fraz usuniętych w #175', () => {
  const hits = [];
  for (const doc of DOC_FILES) {
    const text = readFileSync(join(ROOT, doc), 'utf8');
    for (const [pattern, why] of STALE_PHRASES) {
      if (pattern.test(text)) hits.push(`${doc}: ${pattern} — ${why}`);
    }
  }
  assert.deepEqual(hits, []);
});

// Liczby paneli i modułów tras podawane w dokumentacji muszą zgadzać się z kodem.
function staticPanels() {
  const src = readFileSync(join(ROOT, 'src/node-app.js'), 'utf8');
  const m = src.match(/STATIC_PREFIXES = new Set\(\[([^\]]+)\]\)/);
  assert.ok(m, 'STATIC_PREFIXES not found in src/node-app.js');
  return [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]);
}

function routeModuleCount() {
  const src = readFileSync(join(ROOT, 'src/pg/app.js'), 'utf8');
  const m = src.match(/export const ROUTES = \[([\s\S]*?)\];/);
  assert.ok(m, 'ROUTES not found in src/pg/app.js');
  return m[1].split('\n').map((l) => l.replace(/\/\/.*$/, '').trim()).filter((l) => /^[A-Za-z]\w*,?$/.test(l)).length;
}

test('liczby paneli (buildy Vite, STATIC_PREFIXES) i modułów tras w dokumentacji zgadzają się z kodem', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const builds = (pkg.scripts.build.match(/npm run build:[a-z-]+/g) || []).length;
  const panels = staticPanels().length;
  assert.equal(builds, panels, 'package.json build chain and STATIC_PREFIXES differ');
  const modules = routeModuleCount();
  const wrong = [];
  for (const doc of DOC_FILES) {
    const text = readFileSync(join(ROOT, doc), 'utf8');
    for (const m of text.matchAll(/(\d+) (?:osobnych buildów Vite|paneli Vite|paneli \(`STATIC_PREFIXES`\))/g)) {
      if (Number(m[1]) !== panels) wrong.push(`${doc}: „${m[0]}” (w kodzie: ${panels})`);
    }
    for (const m of text.matchAll(/(\d+) modułów tras/g)) {
      if (Number(m[1]) !== modules) wrong.push(`${doc}: „${m[0]}” (w kodzie: ${modules})`);
    }
  }
  assert.deepEqual(wrong, []);
});

// Odwołania „`src/pg/routes/x.js` (`STAŁA`, …)” (np. tabela ról w DECISIONS.md)
// zamiast numerów linii, które rozjeżdżają się po każdej zmianie pliku.
test('stałe wskazane w dokumentacji jako `src/pg/routes/x.js` (`STAŁA`) istnieją w tym pliku', () => {
  const missing = [];
  for (const doc of DOC_FILES) {
    const text = readFileSync(join(ROOT, doc), 'utf8');
    for (const m of text.matchAll(/`(src\/pg\/routes\/[a-z-]+\.js)` \(((?:`[A-Z_]+`(?:, )?)+)\)/g)) {
      const source = readFileSync(join(ROOT, m[1]), 'utf8');
      for (const [, name] of m[2].matchAll(/`([A-Z_]+)`/g)) {
        if (!new RegExp(`\\b(?:const|let|function)\\s+${name}\\b`).test(source)) missing.push(`${doc}: ${m[1]} ${name}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

// docs/DEMO.md wymienia panele widoczne dla konta zarządu i przedstawiciela —
// to ma być dokładnie lista z shared/shell.js (visiblePanels), w tej kolejności.
test('docs/DEMO.md: listy paneli zarządu i przedstawiciela zgadzają się z shared/shell.js', async () => {
  const { visiblePanels } = await import('../shared/shell.js');
  const demo = readFileSync(join(ROOT, 'docs/DEMO.md'), 'utf8');
  const labels = (role) => visiblePanels([{ role }]).map((p) => p.label);
  const board = labels('board');
  const boardList = `${board.slice(0, -1).join(', ')} i ${board.at(-1)}`;
  assert.ok(demo.includes(`są to ${boardList} (bez „Konta i role”`), `DEMO.md krok 1 powinien wymieniać: ${boardList}`);
  const rep = labels('representative').join(', ');
  assert.ok(demo.includes(`(${rep} i „Strona publiczna”)`), `DEMO.md krok 5 powinien wymieniać: ${rep}`);
});

// Pozostałości nierozwiązanego konfliktu scalania w dokumentacji (README
// migracji trafił tak na main). Linia „=======” bez znaczników też się liczy.
test('dokumentacja nie zawiera znaczników konfliktu scalania', () => {
  const files = ['README.md', 'AGENTS.md', 'postgres/README.md',
    ...readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];
  assert.ok(files.length > 3, 'lista plików nie może być pusta');
  const hits = [];
  for (const f of files) {
    readFileSync(join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
      if (/^(<{7}|>{7})( |$)/.test(line) || line === '=======') hits.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});
