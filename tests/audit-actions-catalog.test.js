// #181: test przekrojowy słownika zdarzeń dziennika. Każda akcja zapisywana
// w audit_events przez src/pg/** i src/email/** (oraz przez migracje SQL) ma
// polską etykietę i dokładnie jedną domenę w shared/audit-actions.js — inaczej
// znika z filtra `domain` GET /api/admin/audit i pokazuje się w panelu surowym
// kodem. Słownik nie trzyma też akcji, których nikt nie zapisuje.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  AUDIT_ACTION_CATALOG, AUDIT_ACTION_LABELS, AUDIT_DOMAINS, auditDomainActions, auditDomainReadable,
} from '../shared/audit-actions.js';
import { AUDIT_ACTIONS } from '../src/pg/routes/admin.js';
import { ACTION_LABELS, AUDIT_DOMAIN_OPTIONS, auditListPath, describeAuditEvent } from '../admin/core.js';

const ROOT = new URL('..', import.meta.url).pathname;
const ACTION = /^[a-z_]+(\.[a-z_]+)+$/;

function jsFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? jsFiles(path) : (path.endsWith('.js') ? [path] : []);
  });
}

// Akcje budowane szablonem — rozwinięcia sprawdzane niżej ze źródłem.
const TEMPLATE_EXPANSIONS = {
  '`guardian_update_request.${status}`': ['guardian_update_request.approved', 'guardian_update_request.rejected'],
  '`ledger.entry.${input.decision}`': ['ledger.entry.verified', 'ledger.entry.questioned'],
  '`email.${verdict.state}`': ['email.skipped', 'email.suppressed', 'email.failed', 'email.cancelled'],
};

// Linia zapisu zdarzenia: `action: …`, `action = …` (warunek na nazwie akcji
// w tym samym module) albo lokalny pomocnik `audit(tx, …, 'akcja', …)`
// (events.js, meetings.js, news.js). Nazwy tabel/kolumn z kropką
// ('tabela.kolumna') na takich liniach nie występują.
function writtenActions() {
  const literals = new Set();
  const templates = new Set();
  for (const file of [...jsFiles(join(ROOT, 'src/pg')), ...jsFiles(join(ROOT, 'src/email'))]) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!/(\baction\b\s*(:|=)|\baudit\()/.test(line)) continue;
      for (const match of line.matchAll(/'([^'\n]+)'/g)) if (ACTION.test(match[1])) literals.add(match[1]);
      for (const match of line.matchAll(/`[a-z_.]+\$\{[^}]+\}`/g)) templates.add(match[0]);
    }
  }
  // Migracje zapisujące zdarzenia bezpośrednio w SQL (np. uzupełnienie roku w przydziałach).
  for (const name of readdirSync(join(ROOT, 'postgres/migrations')).filter((file) => file.endsWith('.sql'))) {
    const sql = readFileSync(join(ROOT, 'postgres/migrations', name), 'utf8');
    if (!sql.includes('INSERT INTO audit_events')) continue;
    for (const match of sql.matchAll(/'([a-z_]+(?:\.[a-z_]+)+)'/g)) literals.add(match[1]);
  }
  return { literals, templates };
}

test('skan źródeł: każda zapisywana akcja ma etykietę i domenę w słowniku', () => {
  const { literals, templates } = writtenActions();
  assert.ok(literals.size > 150, `skan powinien znaleźć akcje (jest ${literals.size})`);
  assert.deepEqual([...templates].sort(), Object.keys(TEMPLATE_EXPANSIONS).sort(),
    'nowa akcja budowana szablonem — dopisz jej rozwinięcia do TEMPLATE_EXPANSIONS i słownika');
  const all = new Set([...literals, ...Object.values(TEMPLATE_EXPANSIONS).flat()]);
  const missing = [...all].filter((action) => !AUDIT_ACTION_CATALOG[action]);
  assert.deepEqual(missing, [], 'akcje bez wpisu w shared/audit-actions.js');
  const stale = Object.keys(AUDIT_ACTION_CATALOG).filter((action) => !all.has(action));
  assert.deepEqual(stale, [], 'akcje w słowniku, których nic nie zapisuje');
});

test('rozwinięcia szablonów zgadzają się ze źródłem', () => {
  const ledger = readFileSync(join(ROOT, 'src/pg/routes/ledger.js'), 'utf8');
  const decisions = ledger.match(/REVIEW_DECISIONS = new Set\(\[([^\]]+)\]\)/)[1].match(/'([a-z_]+)'/g).map((v) => v.slice(1, -1));
  assert.deepEqual(TEMPLATE_EXPANSIONS['`ledger.entry.${input.decision}`'].sort(), decisions.map((d) => `ledger.entry.${d}`).sort());
  const worker = readFileSync(join(ROOT, 'src/email/worker.js'), 'utf8');
  // Stan 'queued' ma własną akcję (email.send_deferred) — patrz worker.js.
  const states = new Set([...worker.matchAll(/return \{ state: '([a-z_]+)'|verdict = \{ state: '([a-z_]+)'/g)]
    .map((m) => m[1] ?? m[2]).filter((state) => state !== 'queued'));
  assert.deepEqual(TEMPLATE_EXPANSIONS['`email.${verdict.state}`'].sort(), [...states].map((s) => `email.${s}`).sort());
  const guardian = readFileSync(join(ROOT, 'src/pg/routes/guardian-updates.js'), 'utf8');
  assert.match(guardian, /const status = decision === 'approve' \? 'approved' : 'rejected';/);
});

test('etykiety są po polsku (bez kodu), domeny należą do listy domen', () => {
  for (const [action, entry] of Object.entries(AUDIT_ACTION_CATALOG)) {
    assert.ok(Object.hasOwn(AUDIT_DOMAINS, entry.domain), `${action}: nieznana domena ${entry.domain}`);
    assert.ok(entry.label && entry.label.length >= 5, `${action}: brak etykiety`);
    assert.doesNotMatch(entry.label, /[a-z]+[._][a-z]+/, `${action}: etykieta wygląda jak kod`);
    assert.equal(ACTION_LABELS[action], entry.label, `${action}: panel ma inną etykietę`);
    assert.equal(describeAuditEvent({ action, metadata: {} }).label, entry.label);
  }
  // Każda domena ma przynajmniej jedną akcję.
  for (const domain of Object.keys(AUDIT_DOMAINS)) assert.ok(auditDomainActions(domain).length > 0, domain);
  assert.equal(AUDIT_ACTION_LABELS['payment.created'], 'Zapisanie wpłaty');
});

test('follow-up #551: domena finance obejmuje rodziny tytułów, danych do wpłat, kategorii i sprawozdań', () => {
  const finance = new Set(auditDomainActions('finance'));
  for (const action of [
    'payment_reference.generated', 'payment_reference.revoked', 'payment_instructions.approved',
    'ledger_category.copied', 'ledger_category.deactivated', 'report.snapshot.created', 'report.snapshot.approved',
    'report.annual.generated', 'report.cash_flow.generated', 'report.audit.generated',
  ]) assert.ok(finance.has(action), action);
  // Każda akcja rodzin finansowych (FINANCIAL_FAMILY z src/pg/audit.js) poza saldami
  // otwarcia (domena zamknięcia roku, jak w #181 cz. 1) jest w finance.
  for (const action of Object.keys(AUDIT_ACTION_CATALOG)) {
    if (/^(payment|ledger|reconciliation)(_[a-z_]+)?\./.test(action) && !action.startsWith('ledger_opening_balance.')) {
      assert.ok(finance.has(action), `${action} poza domeną finance`);
    }
  }
});

test('domyślny widok (AUDIT_ACTIONS) to konta, role i bezpieczeństwo', () => {
  for (const action of AUDIT_ACTIONS) {
    assert.ok(['access', 'security'].includes(AUDIT_ACTION_CATALOG[action]?.domain), action);
  }
});

test('kontrola ról: wariant zachowawczy do D-08/D-09 — każda domena wyłącznie admin', () => {
  for (const [domain, entry] of Object.entries(AUDIT_DOMAINS)) {
    assert.deepEqual([...entry.readRoles], ['admin'], `${domain}: zmiana ról odczytu wymaga decyzji D-08/D-09`);
    assert.equal(auditDomainReadable(domain, ['admin']), true);
    for (const role of ['board', 'treasurer', 'representative', 'audit', 'principal']) {
      assert.equal(auditDomainReadable(domain, [role]), false, `${domain} × ${role}`);
    }
  }
});

test('panel: opcje filtra i ścieżka zapytania', () => {
  assert.equal(AUDIT_DOMAIN_OPTIONS[0].value, '');
  assert.deepEqual(AUDIT_DOMAIN_OPTIONS.slice(1).map((o) => o.value), Object.keys(AUDIT_DOMAINS));
  assert.equal(auditListPath(''), '/api/admin/audit?limit=100');
  assert.equal(auditListPath('finance'), '/api/admin/audit?limit=100&domain=finance');
  assert.equal(auditListPath('nieznana'), '/api/admin/audit?limit=100');
  assert.match(describeAuditEvent({ action: 'payment.correction.created', metadata: {}, redactedFields: ['note'] }).details,
    /ukryte pola opisowe: 1/);
});
