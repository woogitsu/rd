// #174 (część 3): test przekrojowy dla PRZYSZŁYCH tras. insertAuditEvent odrzuca
// w czasie wykonania zdarzenie roczne bez metadata.schoolYearId, ale to działa
// tylko dla ścieżek, które jakiś test faktycznie wykona. Ten test czyta kod
// src/pg i sprawdza każde wywołanie insertAuditEvent z akcją z rodzin
// wymagających roku (payment*/ledger*/reconciliation*, year_close., report.,
// email., …): metadane w tym wywołaniu muszą zawierać schoolYearId. Dodatkowo
// każda nazwa akcji z rodzin finansowych w src/pg musi podlegać wymogowi
// (requiresSchoolYearId) — nowa rodzina 'payment_split.' czy 'ledger_xyz.'
// nie ominie go nową nazwą. Bez bazy danych.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { FINANCIAL_FAMILY, requiresSchoolYearId } from '../src/pg/audit.js';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src/pg');

function jsFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return jsFiles(path);
    return path.endsWith('.js') ? [path] : [];
  });
}

// Tekst argumentów wywołania od otwierającego nawiasu do pasującego zamknięcia
// (pomija nawiasy w literałach napisów).
function callText(source, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') { depth -= 1; if (depth === 0) return source.slice(openIndex, i + 1); }
  }
  throw new Error('niezamknięte wywołanie');
}

const ACTION_LITERAL = /'([a-z][a-z0-9_]*\.[a-z0-9_.]+)'/g;

function auditCalls() {
  const calls = [];
  for (const file of jsFiles(SRC)) {
    if (file.endsWith('/src/pg/audit.js')) continue;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/insertAuditEvent\(/g)) {
      const text = callText(source, match.index + 'insertAuditEvent'.length);
      const actionExpr = /action:\s*([^\n]*)/.exec(text)?.[1] ?? '';
      const actions = [...actionExpr.matchAll(ACTION_LITERAL)].map((m) => m[1]);
      const line = source.slice(0, match.index).split('\n').length;
      calls.push({ where: `${relative(ROOT, file)}:${line}`, text, actions });
    }
  }
  return calls;
}

test('każde wywołanie insertAuditEvent z akcją roczną przekazuje schoolYearId w metadanych', () => {
  const calls = auditCalls();
  const yearly = calls.filter((call) => call.actions.some(requiresSchoolYearId));
  // Zabezpieczenie przed pustym przebiegiem (np. zmiana nazwy funkcji).
  assert.ok(yearly.length >= 60, `za mało wywołań rocznych: ${yearly.length}`);
  // Liczy się tylko tekst OD klucza metadata (np. `entityId: schoolYearId` nie wystarcza).
  const metadataText = (text) => { const at = text.search(/\bmetadata\b/); return at < 0 ? '' : text.slice(at); };
  const missing = yearly.filter((call) => !/\bschoolYearId\b/.test(metadataText(call.text)))
    .map((call) => `${call.where} (${call.actions.join(', ')})`);
  assert.deepEqual(missing, [], 'dopisz metadata.schoolYearId z wiersza obiektu (#174)');
});

test('każda akcja rodzin finansowych w src/pg podlega wymogowi roku i jest zapisywana przez insertAuditEvent', () => {
  const inCalls = new Set(auditCalls().flatMap((call) => call.actions));
  const found = new Map();
  for (const file of jsFiles(SRC)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/action:\s*([^\n]*)/g)) {
      for (const [, action] of match[1].matchAll(ACTION_LITERAL)) {
        if (FINANCIAL_FAMILY.test(action)) found.set(action, relative(ROOT, file));
      }
    }
  }
  // Zdarzenia z ostatnich zmian: zwroty (#538), podział wpłat (#127), bilans otwarcia (#532).
  for (const action of ['payment.refund.created', 'payment.allocation.created', 'payment.allocation.reversed',
    'ledger_opening_balance.created', 'ledger_opening_balance.adjusted', 'ledger_opening_balance.carried_forward']) {
    assert.ok(found.has(action), `oczekiwana akcja ${action}`);
  }
  const notRequired = [...found.keys()].filter((action) => !requiresSchoolYearId(action));
  assert.deepEqual(notRequired, [], 'akcja finansowa bez wymogu schoolYearId w insertAuditEvent');
  // Akcja finansowa zapisywana inną drogą (np. własny INSERT lub opakowanie) ominęłaby test wyżej.
  const outside = [...found.entries()].filter(([action]) => !inCalls.has(action)).map(([a, f]) => `${f}: ${a}`);
  assert.deepEqual(outside, [], 'akcja finansowa poza bezpośrednim wywołaniem insertAuditEvent');
});

test('nazwy rodzin: wymóg obejmuje przyszłe rodziny finansowe, a nie zdarzenia bez roku', () => {
  for (const action of ['payment.created', 'payment_split.created', 'ledger_opening_balance.created',
    'reconciliation_rule.created', 'ledger.transfer.reversed', 'year_close.archive_read', 'report.audit.generated']) {
    assert.equal(requiresSchoolYearId(action), true, action);
  }
  for (const action of ['session.created', 'mfa.reset', 'role_grant.created', 'news_photo.uploaded',
    'email.address_suppressed', 'paymentless.x', 'audit.viewed']) {
    assert.equal(requiresSchoolYearId(action), false, action);
  }
});
