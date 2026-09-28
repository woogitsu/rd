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
      // Only flag numbers referenced like a filename (0017_year_close.sql,
      // `0017`, migracja 0017) — plain prose mentioning a number (e.g. "oba
      // dostępne numery migracji (0060, 0061)", a reserved-but-unused
      // number) is not a claim that the file exists.
      const looksLikeFileRef = new RegExp(`${num}_[a-z]`).test(context)
        || new RegExp('`0\\d{3}`').test(context)
        || new RegExp(`migracj\\w*\\s+${num}\\b`, 'i').test(context);
      if (!looksLikeFileRef) continue;
      if (!MIGRATION_NUMBERS.has(num)) missing.push(`${doc}: ${num} (${context.trim()})`);
    }
  }
  assert.deepEqual(missing, [], 'docs reference migration numbers that do not exist');
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
