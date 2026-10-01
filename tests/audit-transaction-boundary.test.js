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
  ['src/pg/routes/documents.js', ['document.access_denied', 'document.downloaded', 'document.viewed', 'document.content_missing', 'document.preview_blocked']],
  ['src/pg/routes/print.js', ['print.cards_requested']],
  ['src/pg/routes/email.js', ['email.recipients.viewed', 'email.suppressions.viewed', 'email.attention_list.viewed', 'email.webhook.previous_secret_used', 'email.report.exported']],
  ['src/pg/routes/reconciliation.js', ['report.audit.generated']],
  // #107: wydruk/eksport wykonania preliminarza (format != json) — dziennik odczytu, bez zmiany stanu.
  ['src/pg/routes/ledger-budget.js', ['ledger.budget_execution.exported']],
  // #181: odczyt dziennika audytu sam zapisuje zdarzenie (bez parametrów zapytania).
  ['src/pg/routes/admin.js', ['audit.viewed', 'access_log.viewed', 'access_review.viewed']],
  // #181: historia obiektu dla zarządu/skarbnika — ten sam ślad odczytu co w trasie admina.
  ['src/pg/routes/audit-history.js', ['audit.viewed']],
  // #133: odczyt listy próśb opiekunów i zgłoszeń opiekunów do zadań — ślad odczytu.
  ['src/pg/routes/guardian-updates.js', ['guardian_update_request.list_viewed']],
  ['src/pg/events.js', ['event.task_signups_viewed']],
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

// #184: lokalne pomocniki `audit(tx, …)` (src/pg/events.js, meetings.js, news.js)
// wołają insertAuditEvent z pierwszym argumentem — więc wywołanie pomocnika też
// musi dostać transakcję (`tx`), inaczej zdarzenie wypadłoby poza zmianę.
test('local audit() helpers are called only with the transaction (tx)', async () => {
  const offenders = [];
  let helpers = 0;
  for (const file of await sources('src/pg')) {
    const text = await readFile(join(root, file), 'utf8');
    if (!/async function audit\(tx\b/.test(text)) continue;
    helpers += 1;
    for (const match of text.matchAll(/(?<![\w.])audit\(\s*([\w.]+)/g)) {
      const before = text.slice(Math.max(0, match.index - 15), match.index);
      if (/function\s+$/.test(before)) continue;
      if (match[1] !== 'tx') offenders.push(`${file}: audit(${match[1]}, …)`);
    }
  }
  assert.ok(helpers >= 3, `oczekiwane pomocniki audit(tx, …) w events/meetings/news (jest ${helpers})`);
  assert.deepEqual(offenders, []);
});

// #184 etap 2: ślad odmowy (`access.denied`) zapisuje się WYŁĄCZNIE poza
// transakcją żądania — logAccessDenied dostaje `env` (własna krótka
// transakcja), nigdy `tx`. Odmowa wykryta wewnątrz transakcji niesie kontekst
// na błędzie (withDeferredAccessDenied), a moduł, który tak robi, musi go
// zapisać w zewnętrznym catch (logDeferredAccessDenied) — inaczej ślad ginie.
test('logAccessDenied only with env (outside the request transaction); deferred denials are drained', async () => {
  const offenders = [];
  for (const file of await sources('src/pg')) {
    const text = await readFile(join(root, file), 'utf8');
    for (const match of text.matchAll(/(?<![\w.])logAccessDenied\(\s*([\w.]+)/g)) {
      const before = text.slice(Math.max(0, match.index - 15), match.index);
      if (/function\s+$/.test(before)) continue;
      if (match[1] !== 'env') offenders.push(`${file}: logAccessDenied(${match[1]}, …)`);
    }
    const defers = /withDeferredAccessDenied\(\s*new /.test(text);
    const drains = /await logDeferredAccessDenied\(\s*env,/.test(text);
    if (defers && !drains) offenders.push(`${file}: withDeferredAccessDenied bez logDeferredAccessDenied`);
  }
  assert.deepEqual(offenders, []);
});
