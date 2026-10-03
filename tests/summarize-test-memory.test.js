// #111: podsumowanie pamięci procesów testowych shardu CI (scripts/summarize-test-memory.js).
// Czysta funkcja nad tekstem logu, bez bazy i bez sieci.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRssLog, summarize } from '../scripts/summarize-test-memory.js';

test('parseRssLog czyta linie „KiB<TAB>plik” i pomija śmieci', () => {
  const rows = parseRssLog('204800\ttests/a.test.js\nnie linia\n\n512000\ttests/b.test.js\n12x\ttests/c.test.js\n');
  assert.deepEqual(rows, [{ kib: 204800, file: 'tests/a.test.js' }, { kib: 512000, file: 'tests/b.test.js' }]);
  assert.deepEqual(parseRssLog(undefined), []);
});

test('summarize: największy proces, górne oszacowanie dla dwóch naraz i pięć największych plików', () => {
  const rows = [100, 700, 300, 900, 200, 400, 50].map((mib, i) => ({ kib: mib * 1024, file: `tests/f${i}.test.js` }));
  const text = summarize(rows, 'Pamięć testów, shard 1/6');
  assert.match(text, /^### Pamięć testów, shard 1\/6/);
  assert.match(text, /Procesy testowe: 7\. Największy: 900 MiB\. Górne oszacowanie dla dwóch największych naraz: 1600 MiB\./);
  const tableRows = text.split('\n').filter((line) => /^\| tests\//.test(line));
  assert.deepEqual(tableRows, [
    '| tests/f3.test.js | 900 |', '| tests/f1.test.js | 700 |', '| tests/f5.test.js | 400 |', '| tests/f2.test.js | 300 |', '| tests/f4.test.js | 200 |',
  ]);
});

test('summarize: pusty log daje czytelną informację zamiast pustej tabeli', () => {
  assert.match(summarize([], 'Tytuł'), /Brak danych o pamięci/);
});
