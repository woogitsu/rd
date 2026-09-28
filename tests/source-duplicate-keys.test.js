// Zduplikowany klucz w literale obiektu JS nie jest błędem składniowym —
// wygrywa ostatni wpis i po cichu podmienia komunikat używany przez inne
// moduły (zdarzyło się przy scalaniu PR #329: git łączy takie dopiski bez
// konfliktu). Ten test PARSUJE ŹRÓDŁO (nie importuje modułów), żeby wykryć
// takie duplikaty zanim silnik JS je po cichu scali:
//   - shared/messages.js: obiekty MESSAGES i STATUS_MESSAGES (literał JS),
//   - privacy/data-inventory.json: duplikaty kluczy na KAŻDYM poziomie
//     (JSON.parse też bierze ostatni klucz — ten sam problem, inny parser),
//   - docs/API_ERRORS.md: zduplikowany kod w tabeli "## Kody".
//
// Meta-test dla tests/helpers/route-matrix.js (zduplikowane `id` albo pary
// metoda+ścieżka w ROUTE_MATRIX) już istnieje w
// tests/pg-authz-matrix.test.js ("meta: wpisy macierzy są spójne") —
// nie duplikujemy go tutaj.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- Parser 1: klucze na najwyższym poziomie literału obiektu JS -----------
//
// Działa na tekście źródłowym (nie eval/import): pomija komentarze // i /* */
// oraz zawartość łańcuchów znaków, śledzi głębokość nawiasów { [ ( i zbiera
// kandydatów na klucz (identyfikator, liczbę albo łańcuch znaków przed `:`)
// wyłącznie na głębokości 0 względem przekazanego fragmentu.
function topLevelObjectKeys(objectBody) {
  const keys = [];
  const n = objectBody.length;
  let i = 0;
  let depth = 0;
  const isIdentStart = (c) => /[A-Za-z_$]/.test(c);
  const isIdentPart = (c) => /[A-Za-z0-9_$]/.test(c);

  while (i < n) {
    const c = objectBody[i];

    if (/\s/.test(c)) { i++; continue; }

    if (c === '/' && objectBody[i + 1] === '/') {
      while (i < n && objectBody[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && objectBody[i + 1] === '*') {
      i += 2;
      while (i < n && !(objectBody[i] === '*' && objectBody[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    if (c === '"' || c === "'") {
      const quote = c;
      const start = i;
      i++;
      while (i < n && objectBody[i] !== quote) {
        if (objectBody[i] === '\\') i++;
        i++;
      }
      i++; // zamykający cudzysłów
      const raw = objectBody.slice(start, i);
      if (depth === 0) {
        let j = i;
        while (j < n && /\s/.test(objectBody[j])) j++;
        if (objectBody[j] === ':') {
          keys.push(JSON.parse(quote === "'" ? `"${raw.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"` : raw));
        }
      }
      continue;
    }

    if (c === '{' || c === '[' || c === '(') { depth++; i++; continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; i++; continue; }

    if (depth === 0 && (isIdentStart(c) || /[0-9]/.test(c))) {
      const start = i;
      while (i < n && isIdentPart(objectBody[i])) i++;
      const ident = objectBody.slice(start, i);
      let j = i;
      while (j < n && /\s/.test(objectBody[j])) j++;
      if (objectBody[j] === ':') keys.push(ident);
      continue;
    }

    i++;
  }
  return keys;
}

// Wycina zawartość `export const <name> = Object.freeze({ ... });`
// (albo zwykłego `export const <name> = { ... };`) licząc nawiasy klamrowe,
// żeby poprawnie trafić na zamykającą klamrę niezależnie od zagnieżdżenia.
function extractExportedObjectBody(source, exportName) {
  const marker = `export const ${exportName}`;
  const markerIdx = source.indexOf(marker);
  assert.ok(markerIdx !== -1, `nie znaleziono "${marker}" w źródle`);
  const braceStart = source.indexOf('{', markerIdx);
  assert.ok(braceStart !== -1, `nie znaleziono otwierającej klamry dla ${exportName}`);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  assert.ok(depth === 0, `nie znaleziono zamykającej klamry dla ${exportName}`);
  return source.slice(braceStart + 1, i);
}

function findDuplicates(keys) {
  const counts = new Map();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key);
}

// --- Parser 2: duplikaty kluczy na KAŻDYM poziomie tekstu JSON -------------
//
// Ręczny parser JSON (bez JSON.parse, który po cichu bierze ostatni klucz)
// śledzący, dla każdego obiektu, ile razy pojawia się każdy klucz na jego
// własnym poziomie. Zwraca listę { path, key, count } dla duplikatów.
function findJsonDuplicateKeys(text) {
  const n = text.length;
  let i = 0;
  const duplicates = [];

  const skipWs = () => { while (i < n && /\s/.test(text[i])) i++; };

  const parseStringRaw = () => {
    const start = i;
    assert.equal(text[i], '"', `oczekiwano cudzysłowu na pozycji ${i}`);
    i++;
    while (i < n && text[i] !== '"') {
      if (text[i] === '\\') i++;
      i++;
    }
    i++;
    return text.slice(start, i);
  };

  const parseValue = (path) => {
    skipWs();
    const c = text[i];
    if (c === '{') return parseObject(path);
    if (c === '[') return parseArray(path);
    if (c === '"') { parseStringRaw(); return; }
    // liczba / true / false / null
    while (i < n && !/[,\]}\s]/.test(text[i])) i++;
  };

  const parseArray = (path) => {
    i++; // [
    skipWs();
    if (text[i] === ']') { i++; return; }
    let idx = 0;
    while (true) {
      parseValue(`${path}[${idx}]`);
      idx++;
      skipWs();
      if (text[i] === ',') { i++; skipWs(); continue; }
      break;
    }
    skipWs();
    assert.equal(text[i], ']', `oczekiwano "]" na pozycji ${i}`);
    i++;
  };

  const parseObject = (path) => {
    i++; // {
    skipWs();
    const seen = new Map();
    if (text[i] === '}') { i++; return; }
    while (true) {
      skipWs();
      const key = JSON.parse(parseStringRaw());
      seen.set(key, (seen.get(key) ?? 0) + 1);
      skipWs();
      assert.equal(text[i], ':', `oczekiwano ":" po kluczu "${key}" na pozycji ${i}`);
      i++;
      parseValue(`${path}.${key}`);
      skipWs();
      if (text[i] === ',') { i++; skipWs(); continue; }
      break;
    }
    skipWs();
    assert.equal(text[i], '}', `oczekiwano "}" na pozycji ${i}`);
    i++;
    for (const [key, count] of seen) {
      if (count > 1) duplicates.push({ path: path || '$', key, count });
    }
  };

  parseValue('$');
  return duplicates;
}

// --- Parser 3: zduplikowane kody w tabeli Markdown -------------------------
function markdownTableCodes(text) {
  const codes = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*`([a-z][a-z0-9_]*)`\s*\|/);
    if (m) codes.push(m[1]);
  }
  return codes;
}

// ============================================================================
// Testy właściwe (main)
// ============================================================================

test('shared/messages.js: MESSAGES nie ma zduplikowanych kluczy', () => {
  const source = readFileSync(join(ROOT, 'shared/messages.js'), 'utf8');
  const body = extractExportedObjectBody(source, 'MESSAGES');
  const keys = topLevelObjectKeys(body);
  assert.ok(keys.length > 50, 'oczekiwano wielu wpisów w MESSAGES — parser prawdopodobnie nic nie wykrył');
  const dups = findDuplicates(keys);
  assert.deepEqual(dups, [], `zduplikowane klucze w MESSAGES (ostatni wpis po cichu wygrywa): ${dups.join(', ')}`);
});

test('shared/messages.js: STATUS_MESSAGES nie ma zduplikowanych kluczy', () => {
  const source = readFileSync(join(ROOT, 'shared/messages.js'), 'utf8');
  const body = extractExportedObjectBody(source, 'STATUS_MESSAGES');
  const keys = topLevelObjectKeys(body);
  assert.ok(keys.length >= 5, 'oczekiwano kilku wpisów w STATUS_MESSAGES — parser prawdopodobnie nic nie wykrył');
  const dups = findDuplicates(keys);
  assert.deepEqual(dups, [], `zduplikowane klucze w STATUS_MESSAGES (ostatni wpis po cichu wygrywa): ${dups.join(', ')}`);
});

test('privacy/data-inventory.json: brak zduplikowanych kluczy na żadnym poziomie', () => {
  const text = readFileSync(join(ROOT, 'privacy/data-inventory.json'), 'utf8');
  // Kontrola, że plik jest poprawnym JSON-em (test zakłada to milcząco dalej).
  JSON.parse(text);
  const dups = findJsonDuplicateKeys(text);
  assert.deepEqual(
    dups,
    [],
    `zduplikowane klucze w privacy/data-inventory.json (JSON.parse też bierze ostatni wpis): `
      + dups.map((d) => `${d.path} -> "${d.key}" (${d.count}x)`).join('; '),
  );
});

test('docs/API_ERRORS.md: brak zduplikowanych kodów w tabeli "## Kody"', () => {
  const text = readFileSync(join(ROOT, 'docs/API_ERRORS.md'), 'utf8');
  const codes = markdownTableCodes(text);
  assert.ok(codes.length > 50, 'oczekiwano wielu wierszy w tabeli kodów — parser prawdopodobnie nic nie wykrył');
  const dups = findDuplicates(codes);
  assert.deepEqual(dups, [], `zduplikowany wiersz kodu w docs/API_ERRORS.md: ${dups.join(', ')}`);
});

// ============================================================================
// Testy-kanarki: wstrzyknięty duplikat w próbce tekstu MUSI zostać wykryty.
// Bez nich test powyżej mógłby "przechodzić" tylko dlatego, że parser
// milcząco nic nie znajduje (fałszywe poczucie bezpieczeństwa).
// ============================================================================

test('kanarek: topLevelObjectKeys wykrywa wstrzyknięty duplikat klucza JS', () => {
  const sample = `
    export const MESSAGES = Object.freeze({
      // komentarz z dwukropkiem: to nie jest klucz
      not_found: "Nie znaleziono.",
      forbidden: "Brak uprawnień.",
      /* blokowy komentarz z: dwukropkiem */
      not_found: "Zduplikowany wpis wstrzyknięty przez test.",
      nested: { not_found: "To jest zagnieżdżone, nie powinno liczyć się jako duplikat na tym poziomie" },
    });
  `;
  const body = extractExportedObjectBody(sample, 'MESSAGES');
  const keys = topLevelObjectKeys(body);
  assert.deepEqual(keys.filter((k) => k === 'nested').length, 1);
  const dups = findDuplicates(keys);
  assert.deepEqual(dups, ['not_found'], 'kanarek nie wykrył wstrzykniętego duplikatu "not_found"');
});

test('kanarek: topLevelObjectKeys wykrywa duplikat klucza liczbowego (STATUS_MESSAGES)', () => {
  const sample = `
    export const STATUS_MESSAGES = Object.freeze({
      404: "Nie znaleziono.",
      409: "Konflikt.",
      404: "Zduplikowany status wstrzyknięty przez test.",
    });
  `;
  const body = extractExportedObjectBody(sample, 'STATUS_MESSAGES');
  const keys = topLevelObjectKeys(body);
  const dups = findDuplicates(keys);
  assert.deepEqual(dups, ['404'], 'kanarek nie wykrył wstrzykniętego duplikatu klucza liczbowego "404"');
});

test('kanarek: findJsonDuplicateKeys wykrywa wstrzyknięty duplikat na zagnieżdżonym poziomie', () => {
  const sample = JSON.stringify({ tables: { students: { columns: { first_name: 1 } } } })
    // Wstrzykujemy zduplikowany klucz "columns" ręcznie w tekście (JSON.stringify
    // nigdy sam go nie wyprodukuje — dokładnie dlatego problem jest niewidoczny
    // dla JSON.parse i trzeba go łapać na poziomie tekstu źródłowego).
    .replace(
      '"columns":{"first_name":1}',
      '"columns":{"first_name":1},"columns":{"first_name":2,"first_name":3}',
    );
  // Kontrola założenia: JSON.parse po cichu bierze ostatni wpis i nie widzi problemu.
  const parsed = JSON.parse(sample);
  assert.deepEqual(parsed.tables.students.columns, { first_name: 3 });

  const dups = findJsonDuplicateKeys(sample);
  const keys = dups.map((d) => d.key).sort();
  assert.deepEqual(keys, ['columns', 'first_name'], `kanarek nie wykrył wstrzykniętych duplikatów JSON: ${JSON.stringify(dups)}`);
});

test('kanarek: markdownTableCodes wykrywa zduplikowany wiersz kodu', () => {
  const sample = [
    '| Kod | Znaczenie | Czy ponawiać |',
    '| --- | --- | --- |',
    '| `not_found` | Nie znaleziono. | Nie. |',
    '| `forbidden` | Brak uprawnień. | Nie. |',
    '| `not_found` | Zduplikowany wiersz wstrzyknięty przez test. | Nie. |',
  ].join('\n');
  const codes = markdownTableCodes(sample);
  const dups = findDuplicates(codes);
  assert.deepEqual(dups, ['not_found'], 'kanarek nie wykrył wstrzykniętego duplikatu wiersza "not_found"');
});
