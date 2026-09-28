// Issue #136, kryterium akceptacji: rg "window.confirm" w katalogach aplikacji nie
// zwraca wyników — zastąpione przez shared/confirm-dialog.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const APP_DIRS = ['admin', 'documents', 'events', 'families', 'import', 'ledger', 'meetings', 'panel', 'print', 'site'];

function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'public') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...jsFiles(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

test('żaden panel nie używa window.confirm', () => {
  const offenders = [];
  for (const app of APP_DIRS) {
    for (const file of jsFiles(join(root, app))) {
      if (readFileSync(file, 'utf8').includes('window.confirm')) offenders.push(file);
    }
  }
  assert.deepEqual(offenders, []);
});
