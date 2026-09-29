// Kontrakt src/db.js (#208): db.query / tx.query zwracają wyłącznie { rows }.
// PGlite dodatkowo zwraca m.in. rowCount, więc kod zależny od rowCount przechodzi
// testy na PGlite, a na prawdziwym PostgreSQL (pula pg → wrapClient) dostaje
// undefined. O tym, czy INSERT … ON CONFLICT DO NOTHING coś wstawił, decyduje
// RETURNING i rows.length. Test statyczny (działa w CI bez PostgreSQL).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.js') ? [path] : [];
  });
}

test('src/ nie odczytuje rowCount/affectedRows z wyniku zapytania (kontrakt db.js: tylko rows)', () => {
  const offenders = [];
  for (const file of sources('src')) {
    const text = readFileSync(file, 'utf8');
    if (/\.(rowCount|affectedRows)\b/.test(text) || /\{[^}]*\b(rowCount|affectedRows)\b[^}]*\}\s*=\s*await\b/.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});
