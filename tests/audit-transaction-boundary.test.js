// Meta-test (#178): w src/email/** i src/pg/** zdarzenie audytu zapisuje się
// w tej samej transakcji co zmiana (insertAuditEvent(tx, …)). Wywołanie na
// połączeniu autocommit (db / env.db) jest dozwolone tylko dla zdarzeń
// dokumentujących odczyt — lista wyjątków poniżej.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const READ_ONLY_EXCEPTIONS = new Map([
  ['src/pg/routes/documents.js', ['document.access_denied', 'document.downloaded', 'document.content_missing']],
  ['src/pg/routes/print.js', ['print.cards_requested']],
  ['src/pg/routes/email.js', ['email.recipients.viewed', 'email.suppressions.viewed', 'email.attention_list.viewed', 'email.webhook.previous_secret_used']],
  ['src/pg/routes/reconciliation.js', ['report.audit.generated']],
  // #107: wydruk/eksport wykonania preliminarza (format != json) — dziennik odczytu, bez zmiany stanu.
  ['src/pg/routes/ledger-budget.js', ['ledger.budget_execution.exported']],
  // #181: odczyt dziennika audytu sam zapisuje zdarzenie (bez parametrów zapytania).
  ['src/pg/routes/admin.js', ['audit.viewed', 'access_log.viewed']],
  // #184: odmowa 403 nie jest częścią transakcji zmiany (nie ma zmiany) — zapis
  // nigdy nie blokuje ani nie zmienia odpowiedzi (patrz logAccessDenied).
  ['src/pg/authorization.js', ['access.denied']],
]);

async function sources(dir) {
  const out = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await sources(path));
    else if (entry.name.endsWith('.js')) out.push(path);
  }
  return out;
}

test('insertAuditEvent on an autocommit connection only for read-only events', async () => {
  const offenders = [];
  for (const file of [...await sources('src/email'), ...await sources('src/pg')]) {
    const text = await readFile(join(root, file), 'utf8');
    const pattern = /insertAuditEvent\(\s*(db|env\.db)\s*,\s*\{([\s\S]*?)\}\s*\)/g;
    for (const match of text.matchAll(pattern)) {
      const action = /action:\s*'([^']+)'/.exec(match[2])?.[1] ?? '(dynamic)';
      if (!(READ_ONLY_EXCEPTIONS.get(file) ?? []).includes(action)) offenders.push(`${file}: ${action}`);
    }
  }
  assert.deepEqual(offenders, []);
});
