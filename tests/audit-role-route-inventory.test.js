// #137 / D-09: zestawienie zakresu roli `audit` (Komisja Rewizyjna) dla tras finansowych,
// wyprowadzone z macierzy autoryzacji (tests/helpers/route-matrix.js). Test statyczny (bez bazy):
// dokumentuje zakres. Wskazanie właściciela z 2026-10-02 (D-09, wariant b): odczyt księgi i dokumentów
// finansowych roku za flagą AUDIT_LEDGER_READ (domyślnie wyłączona) — dwa stany:
//   * flaga wyłączona = dotychczasowa lista (AUDIT_ALLOWED),
//   * flaga włączona  = lista rozszerzona o odczyty (AUDIT_ALLOWED_WITH_FLAG), nadal bez żadnego zapisu.
// Zmiana zakresu audit ma wymagać świadomej zmiany tego pliku i tabeli „Zakres roli audit”
// w docs/AUTHORIZATION.md, a nie tylko poszerzenia listy ról w trasie.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ROUTE_MATRIX, auditScopes, denyStatus } from './helpers/route-matrix.js';

const authorization = await readFile(new URL('../docs/AUTHORIZATION.md', import.meta.url), 'utf8');

// Moduły z danymi finansowymi, dowodami albo danymi rodzin — wszystko, co zarząd rozważa w D-09.
const FINANCIAL_MODULES = [
  'payments', 'payment-references', 'payment-instructions', 'ledger', 'ledger-budget', 'ledger-cost-centers',
  'ledger-cash', 'reconciliation', 'financial-reports', 'documents', 'exports', 'year-close', 'audit-history',
  'import', 'families', 'email', 'board', 'audit-reviews',
];

// Jedyne trasy tych modułów, które dziś dopuszczają rolę audit (jawna lista; stan na #137).
const AUDIT_ALLOWED = [
  'GET /api/reports/audit?schoolYearId=:year&format=json',
  'GET /api/reports/audit?schoolYearId=:year&format=xlsx',
  'GET /api/audit-reviews/:year',
  'POST /api/audit-reviews/:year/notes',
  'POST /api/audit-reviews/:year/notes/:id/closure',
  'POST /api/audit-reviews/:year/conclusion',
];
// Dodatkowe trasy (wyłącznie GET) dopuszczone dla audit po włączeniu AUDIT_LEDGER_READ (D-09, wariant b).
const AUDIT_FLAG_ADDED = [
  'GET /api/ledger?schoolYearId=:year',
  'GET /api/ledger/categories?schoolYearId=:year',
  'GET /api/ledger/summary?schoolYearId=:year',
  'GET /api/ledger/export.csv?schoolYearId=:year',
  'GET /api/ledger/export.xlsx?schoolYearId=:year',
  'GET /api/documents?schoolYearId=:year',
  'GET /api/documents/:financialDocumentId',
  'GET /api/documents/:financialDocumentId/content',
];
const AUDIT_ALLOWED_WITH_FLAG = [...AUDIT_ALLOWED, ...AUDIT_FLAG_ADDED];
// Trasy zapisu, które audit może wywołać: wyłącznie własna ścieżka kontroli (niezmienne uwagi).
const AUDIT_WRITES = AUDIT_ALLOWED.filter((entry) => entry.startsWith('POST '));

// Stan domyślny (flaga wyłączona): wprost z `allow`. Stan z flagą: `allow` + `auditFlag` (route-matrix.js).
const allowsAudit = (route) => typeof route.allow === 'object' && Boolean(route.allow.audit);
const allowsAuditWithFlag = (route) => typeof route.allow === 'object' && auditScopes(route, true).length > 0;
const label = (route) => `${route.method} ${route.path}`;
const financialRoutes = ROUTE_MATRIX.filter((route) => FINANCIAL_MODULES.includes(route.module));

test('#137 D-09: macierz obejmuje wszystkie moduły finansowe (zestawienie nie jest puste)', () => {
  for (const name of FINANCIAL_MODULES) {
    assert.ok(ROUTE_MATRIX.some((route) => route.module === name), `moduł ${name} bez tras w macierzy`);
  }
  assert.ok(financialRoutes.length > 100, 'za mało tras finansowych — lista modułów rozjechała się z macierzą');
});

test('#137 D-09: audit ma dostęp dokładnie do jawnej listy tras finansowych (reszta 403/404)', () => {
  const allowed = financialRoutes.filter(allowsAudit).map(label).sort();
  assert.deepEqual(allowed, [...AUDIT_ALLOWED].sort());
  const denied = financialRoutes.filter((route) => !allowsAudit(route));
  assert.ok(denied.length > 0);
  for (const route of denied) {
    // Trasy publiczne (np. podpisany webhook Brevo) i „authenticated” nie zależą od roli audit.
    if (route.allow === 'public' || route.allow === 'authenticated') continue;
    const status = denyStatus(route, { key: 'audit' }, 'W1', true);
    assert.ok([403, 404].includes(status), `${label(route)}: odmowa audit = ${status}`);
  }
});

test('#137 D-09: audit nigdy nie zapisuje księgi, wpłat, uzgodnień ani dokumentów — tylko uwagi i wniosek KR', () => {
  const writes = financialRoutes.filter((route) => route.method !== 'GET' && allowsAudit(route)).map(label).sort();
  assert.ok(writes.length > 0);
  assert.deepEqual(writes, [...AUDIT_WRITES].sort());
  const forbiddenModules = ['payments', 'payment-references', 'payment-instructions', 'ledger', 'ledger-budget',
    'ledger-cost-centers', 'ledger-cash', 'reconciliation', 'documents', 'year-close', 'import', 'email'];
  const writeRoutes = ROUTE_MATRIX.filter((route) => forbiddenModules.includes(route.module) && route.method !== 'GET');
  assert.ok(writeRoutes.length > 0);
  assert.equal(writeRoutes.filter(allowsAudit).length, 0);
});

test('#137 D-09: audit nigdy nie ma tras księgi, wpłat, dokumentów ani eksportu danych (GET) — raport KR to jedyny wyjątek odczytu', () => {
  const readModules = ['payments', 'ledger', 'ledger-budget', 'ledger-cost-centers', 'ledger-cash', 'documents',
    'exports', 'families', 'year-close', 'financial-reports', 'audit-history'];
  const reads = ROUTE_MATRIX.filter((route) => readModules.includes(route.module));
  assert.ok(reads.length > 0);
  assert.equal(reads.filter(allowsAudit).length, 0, 'audit czyta księgę/wpłaty/dokumenty — wymaga decyzji D-09');
  // Zakres roku: wszystkie dozwolone trasy audit dotyczą wyłącznie danych ogólnoszkolnych roku (W1), bez klas.
  const finance = financialRoutes.filter(allowsAudit);
  assert.ok(finance.length > 0);
  for (const route of finance) assert.deepEqual(route.allow.audit, ['W1'], label(route));
});

test('#137 D-09 (b): flaga włączona — audit dostaje dokładnie jawną, rozszerzoną listę, wyłącznie GET, rok bez klasy', () => {
  const allowed = financialRoutes.filter(allowsAuditWithFlag).map(label).sort();
  assert.deepEqual(allowed, [...AUDIT_ALLOWED_WITH_FLAG].sort());
  // Dodane trasy: tylko odczyt, tylko moduły księgi i dokumentów, tylko zakres roku (W1), wyłącznie przez `auditFlag`.
  const added = financialRoutes.filter((route) => allowsAuditWithFlag(route) && !allowsAudit(route));
  assert.equal(added.length, AUDIT_FLAG_ADDED.length);
  for (const route of added) {
    assert.equal(route.method, 'GET', label(route));
    assert.ok(['ledger', 'documents'].includes(route.module), label(route));
    assert.deepEqual(auditScopes(route, true), ['W1'], label(route));
    assert.deepEqual(route.auditFlag, ['W1'], label(route));
  }
  // Flaga niczego nie zapisuje: lista tras zapisu audit jest identyczna w obu stanach.
  const writes = financialRoutes.filter((route) => route.method !== 'GET' && allowsAuditWithFlag(route)).map(label).sort();
  assert.ok(writes.length > 0);
  assert.deepEqual(writes, [...AUDIT_WRITES].sort());
});

test('#137 D-09 (b): flaga nie otwiera wpłat, kart rodzin, eksportu danych, historii obiektu, uzgodnień ani innych dokumentów', () => {
  const stillClosed = ['payments', 'payment-references', 'payment-instructions', 'ledger-budget', 'ledger-cost-centers',
    'ledger-cash', 'financial-reports', 'exports', 'families', 'year-close', 'audit-history', 'import', 'email', 'board'];
  const closedRoutes = ROUTE_MATRIX.filter((route) => stillClosed.includes(route.module));
  assert.ok(closedRoutes.length > 50);
  assert.equal(closedRoutes.filter(allowsAuditWithFlag).length, 0, 'flaga otworzyła moduł spoza zakresu D-09 (b)');
  // W modułach ledger/documents flaga dotyczy tylko GET z listy; reszta (w tym dokumenty niefinansowe) zostaje zamknięta.
  const partly = ROUTE_MATRIX.filter((route) => ['ledger', 'documents'].includes(route.module));
  const open = partly.filter(allowsAuditWithFlag).map(label).sort();
  assert.deepEqual(open, [...AUDIT_FLAG_ADDED].sort());
  const closedDocs = partly.filter((route) => route.module === 'documents' && !allowsAuditWithFlag(route));
  assert.ok(closedDocs.some((route) => /board|class|council_shared/i.test(route.path)), 'dokumenty niefinansowe muszą zostać zamknięte');
  for (const route of closedDocs.filter((item) => item.method === 'GET')) {
    assert.ok([403, 404].includes(denyStatus(route, { key: 'audit' }, 'W1', true)), label(route));
  }
  // Tylko dowody finansowe: żadna trasa dokumentu rodzaju board/class/council_shared nie ma auditFlag.
  assert.equal(partly.filter((route) => route.auditFlag && /board|class|council_shared/i.test(route.path)).length, 0);
});

// Tabela w docs/AUTHORIZATION.md: | moduł | tras w macierzy | audit 200 | audit odmowa | audit 200 z flagą |
test('#137 D-09: tabela „Zakres roli audit” w docs/AUTHORIZATION.md zgadza się z macierzą', () => {
  const section = authorization.split('## Zakres roli audit')[1];
  assert.ok(section, 'brak sekcji „Zakres roli audit” w docs/AUTHORIZATION.md');
  const body = section.split(/\n## /)[0];
  const rows = new Map();
  for (const line of body.split('\n')) {
    const match = line.match(/^\|\s*`([a-z-]+)`\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/);
    const flagged = line.match(/^\|[^|]+\|[^|]+\|[^|]+\|[^|]+\|\s*(\d+)\s*\|/);
    if (match) rows.set(match[1], { total: Number(match[2]), allowed: Number(match[3]), denied: Number(match[4]), withFlag: Number(flagged?.[1]) });
  }
  assert.equal(rows.size, FINANCIAL_MODULES.length, 'tabela musi mieć wiersz dla każdego modułu finansowego');
  for (const name of FINANCIAL_MODULES) {
    const routes = ROUTE_MATRIX.filter((route) => route.module === name);
    const allowed = routes.filter(allowsAudit).length;
    const withFlag = routes.filter(allowsAuditWithFlag).length;
    assert.deepEqual(rows.get(name), { total: routes.length, allowed, denied: routes.length - allowed, withFlag }, `moduł ${name}`);
  }
  for (const entry of AUDIT_ALLOWED_WITH_FLAG) {
    assert.ok(body.includes(entry.split(' ')[1].split('?')[0]), `tabela nie wymienia trasy ${entry}`);
  }
  assert.ok(body.includes('AUDIT_LEDGER_READ'), 'sekcja nie opisuje flagi AUDIT_LEDGER_READ');
});
