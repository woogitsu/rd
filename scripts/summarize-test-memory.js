// #111: podsumowanie szczytowej pamięci procesów testowych jednego shardu CI.
// `tests/setup.js` (ładowany w KAŻDYM procesie testowym) dopisuje na wyjściu linię
// `<maxRSS w KiB>\t<plik testowy>` do pliku z RD_TEST_RSS_LOG. Ten skrypt czyta ten plik
// i wypisuje tabelę Markdown (dla $GITHUB_STEP_SUMMARY): liczbę procesów, największy proces,
// pięć największych plików i górne oszacowanie pamięci przy `--test-concurrency=2`
// (dwa największe procesy naraz). Wyłącznie odczyt pliku z logiem; bez sieci.
//
//   node scripts/summarize-test-memory.js "$RD_TEST_RSS_LOG" "Shard 3/6" >> "$GITHUB_STEP_SUMMARY"
import { readFileSync } from 'node:fs';

const MIB = 1024;

export function parseRssLog(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    const match = /^(\d+)\t(.+)$/.exec(line.trim());
    if (match) rows.push({ kib: Number(match[1]), file: match[2] });
  }
  return rows;
}

export function summarize(rows, title = 'Pamięć testów') {
  if (!rows.length) return `### ${title}\n\nBrak danych o pamięci (log pusty).\n`;
  const sorted = [...rows].sort((a, b) => b.kib - a.kib);
  const mib = (kib) => Math.round(kib / MIB);
  const concurrent = sorted[0].kib + (sorted[1]?.kib ?? 0);
  const lines = [
    `### ${title}`,
    '',
    `Procesy testowe: ${rows.length}. Największy: ${mib(sorted[0].kib)} MiB. Górne oszacowanie dla dwóch największych naraz: ${mib(concurrent)} MiB.`,
    '',
    '| Plik testowy | Szczyt RSS (MiB) |',
    '|---|---|',
    ...sorted.slice(0, 5).map((row) => `| ${row.file} | ${mib(row.kib)} |`),
    '',
  ];
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [path, title] = process.argv.slice(2);
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { /* brak logu: raport „brak danych” */ }
  process.stdout.write(summarize(parseRssLog(text), title));
}
