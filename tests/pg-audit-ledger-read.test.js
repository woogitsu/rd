// D-09 (#137), wariant (b): odczyt i eksport księgi oraz dokumentów finansowych roku dla roli `audit`
// (Komisja Rewizyjna) za flagą AUDIT_LEDGER_READ. Testy zachowania trasy (macierz uprawnień sprawdza resztę
// aktorów i zakresów: tests/pg-authz-matrix.test.js, grupa `auditFlag`). Wyłącznie dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { assertNoPii } from '../src/pg/audit.js';
import {
  AUDIT_READABLE_DOCUMENT_CATEGORIES, REDACTED_PAYMENT_CELL, REDACTED_PAYMENT_DESCRIPTION, auditLedgerReadEnabled,
} from '../src/pg/audit-ledger-read.js';
import { createMemoryStorage } from '../src/storage.js';
import { createTestDb, request, seedSchoolYear, seedUserSession } from './helpers/pg.js';
import { assertEvery } from './helpers/assertions.js';

const Y1 = 'y-1';
const Y2 = 'y-2';
const PDF = new TextEncoder().encode('%PDF-1.4\n% syntetyczny dowod MRK-DOWOD\n1 0 obj <<>> endobj\n%%EOF\n');
const FAMILY_MARKERS = ['MRK-RODZINA-OPIS', 'MRK-RODZINA-ZRODLO', 'MRK-RODZINA-UCHWALA', 'pay-1', 'hh-1'];
let seq = 0;

async function withEnv(flag, fn) {
  const db = await createTestDb();
  const storage = createMemoryStorage();
  const env = { db, storage, APP_ENV: 'test', MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
  if (flag !== undefined) env.AUDIT_LEDGER_READ = flag;
  try {
    await seedSchoolYear(db, Y1, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
    await seedSchoolYear(db, Y2, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
    const sessions = {
      treasurer: await seedUserSession(db, { userId: 'u-treasurer', mfa: true, roles: [{ role: 'treasurer', schoolYearId: Y1 }] }),
      board: await seedUserSession(db, { userId: 'u-board', mfa: true, roles: [{ role: 'board', schoolYearId: Y1 }] }),
      audit: await seedUserSession(db, { userId: 'u-audit', mfa: true, roles: [{ role: 'audit', schoolYearId: Y1 }] }),
      auditNoMfa: await seedUserSession(db, { userId: 'u-audit-nomfa', mfa: false, roles: [{ role: 'audit', schoolYearId: Y1 }] }),
      auditY2: await seedUserSession(db, { userId: 'u-audit-y2', mfa: true, roles: [{ role: 'audit', schoolYearId: Y2 }] }),
      auditClass: await seedUserSession(db, {
        userId: 'u-audit-class', mfa: true, roles: [{ role: 'audit', classId: 'c-audit-1a', schoolYearId: Y1 }],
      }),
    };
    const fx = await seedFixtures(db, env, sessions);
    return await fn({ db, env, sessions, fx });
  } finally {
    await db.close();
  }
}

const call = async (env, path, { cookie, method = 'GET', body, headers } = {}) => {
  const response = await handlePgRequest(request(path, { cookie, method, body, headers }), env);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let json = null;
  if (response.headers.get('content-type')?.includes('json')) json = JSON.parse(text);
  return { status: response.status, text, json, bytes, headers: response.headers };
};

const rowCount = async (db, table) => (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
const events = async (db, action) => (await db.query(
  'SELECT actor_id, entity_type, entity_id, metadata_json FROM audit_events WHERE action = $1 ORDER BY occurred_at, id', [action],
)).rows;

async function uploadDocument(env, cookie, { kind = 'financial', query = '', category }) {
  const upload = await call(env, `/api/documents?kind=${kind}&schoolYearId=${Y1}${query}`, {
    cookie, method: 'POST', body: PDF, headers: { 'Content-Type': 'application/pdf', 'Idempotency-Key': `audit-read-doc-${++seq}-${Date.now()}` },
  });
  assert.equal(upload.status, 201, upload.text);
  const id = upload.json.document.id;
  if (category) {
    const described = await call(env, `/api/documents/${id}/description`, {
      cookie, method: 'POST', body: { title: `Dokument ${category} MRK-OPIS`, category, description: 'MRK-OPIS-WOLNY-TEKST' },
      headers: { 'Idempotency-Key': `audit-read-desc-${++seq}-${Date.now()}` },
    });
    assert.equal(described.status, 201, described.text);
  }
  return id;
}

async function seedFixtures(db, env, sessions) {
  await db.exec(`
    INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by, active) VALUES
      ('cat-in-1', '${Y1}', 'income', 'Składki dobrowolne', 'u-treasurer', true),
      ('cat-out-1', '${Y1}', 'expense', 'Wydarzenia', 'u-treasurer', true),
      ('cat-in-2', '${Y2}', 'income', 'Składki dobrowolne', 'u-treasurer', true);
    INSERT INTO households (id) VALUES ('hh-1');
    INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key)
      VALUES ('pay-1', 'hh-1', '${Y1}', 5000, '2026-09-20', 'bank', 'recorded', 'u-treasurer', 'seed-payment-audit-0001');
  `);
  const post = async (body) => {
    const response = await call(env, '/api/ledger', {
      cookie: sessions.treasurer, method: 'POST', body, headers: { 'Idempotency-Key': `audit-read-ledger-${++seq}-${Date.now()}` },
    });
    assert.equal(response.status, 201, response.text);
    return response.json.entry.id;
  };
  const expenseId = await post({
    schoolYearId: Y1, direction: 'expense', amountCents: 12000, categoryId: 'cat-out-1', description: 'Zakup materiałów MRK-WYDATEK',
    occurredOn: '2026-10-02', method: 'bank',
  });
  const paymentEntryId = await post({
    schoolYearId: Y1, direction: 'income', amountCents: 5000, categoryId: 'cat-in-1', description: 'Składka MRK-RODZINA-OPIS',
    occurredOn: '2026-09-21', method: 'bank', paymentEntryId: 'pay-1', source: 'MRK-RODZINA-ZRODLO', resolutionReference: 'MRK-RODZINA-UCHWALA',
  });
  const documents = {
    faktura: await uploadDocument(env, sessions.treasurer, { category: 'faktura' }),
    wyciag: await uploadDocument(env, sessions.treasurer, { category: 'wyciag' }),
    przelew: await uploadDocument(env, sessions.treasurer, { category: 'potwierdzenie_przelewu' }),
    inne: await uploadDocument(env, sessions.treasurer, { category: 'inne' }),
    bezKategorii: await uploadDocument(env, sessions.treasurer, {}),
    powiazanyZWplata: await uploadDocument(env, sessions.treasurer, {
      category: 'faktura', query: '&linkedEntityType=payment_entry&linkedEntityId=pay-1',
    }),
    board: await uploadDocument(env, sessions.board, { kind: 'board', category: 'protokol' }),
  };
  return { expenseId, paymentEntryId, documents };
}

test('flaga: tylko `1` i `true` włączają odczyt, domyślnie wyłączona (env obiektu ma pierwszeństwo przed procesem)', () => {
  for (const value of ['1', 'true']) assert.equal(auditLedgerReadEnabled({ AUDIT_LEDGER_READ: value }), true, value);
  for (const value of ['0', '', 'false', 'yes', 'TRUE', ' 1']) assert.equal(auditLedgerReadEnabled({ AUDIT_LEDGER_READ: value }), false, value);
  assert.equal(auditLedgerReadEnabled({}), process.env.AUDIT_LEDGER_READ === '1' || process.env.AUDIT_LEDGER_READ === 'true');
  assert.equal(auditLedgerReadEnabled(undefined), process.env.AUDIT_LEDGER_READ === '1' || process.env.AUDIT_LEDGER_READ === 'true');
});

test('flaga włączona: audit czyta księgę roku (lista, kategorie, podsumowanie) bez danych rodzin', () => withEnv('1', async ({ env, sessions, fx }) => {
  const list = await call(env, `/api/ledger?schoolYearId=${Y1}`, { cookie: sessions.audit });
  assert.equal(list.status, 200, list.text);
  assert.equal(list.json.entries.length, 2);
  const expense = list.json.entries.find((entry) => entry.id === fx.expenseId);
  const paid = list.json.entries.find((entry) => entry.id === fx.paymentEntryId);
  assert.equal(expense.amountCents, 12000);
  assert.match(expense.description, /MRK-WYDATEK/, 'opis wydatku niepowiązanego z wpłatą zostaje');
  // Wpis powiązany z wpłatą: kwota, data, kategoria zostają; opis, źródło i identyfikator wpłaty — nie.
  assert.equal(paid.amountCents, 5000);
  assert.equal(paid.occurredOn, '2026-09-21');
  assert.equal(paid.categoryId, 'cat-in-1');
  assert.equal(paid.description, REDACTED_PAYMENT_DESCRIPTION);
  assert.equal(paid.source, null);
  assert.equal(paid.resolutionReference, null, 'referencja uchwały (wolny tekst) wpisu powiązanego z wpłatą jest ukryta');
  assert.equal(paid.paymentEntryId, null);
  assert.equal(paid.paymentLinked, true);
  assert.equal(expense.paymentLinked, undefined);
  assertEvery(FAMILY_MARKERS, (marker) => !list.text.includes(marker));

  const categories = await call(env, `/api/ledger/categories?schoolYearId=${Y1}`, { cookie: sessions.audit });
  assert.equal(categories.status, 200);
  assert.equal(categories.json.categories.length, 2);
  const summary = await call(env, `/api/ledger/summary?schoolYearId=${Y1}`, { cookie: sessions.audit });
  assert.equal(summary.status, 200);
  assert.equal(summary.json.summary.incomeCents, 5000);
  assert.equal(summary.json.summary.expenseCents, 12000);
}));

test('flaga włączona: eksport CSV i XLSX dla audit — 200, znacznik zamiast identyfikatora wpłaty, ślad eksportu z rolą', () => withEnv('1', async ({ db, env, sessions, fx }) => {
  const csv = await call(env, `/api/ledger/export.csv?schoolYearId=${Y1}`, { cookie: sessions.audit });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.ok(csv.text.includes(fx.expenseId) && csv.text.includes('MRK-WYDATEK'));
  assert.ok(csv.text.includes(fx.paymentEntryId), 'identyfikator wpisu księgi zostaje');
  assert.ok(csv.text.includes(REDACTED_PAYMENT_CELL), 'kolumna id_wplaty niesie znacznik');
  assertEvery(FAMILY_MARKERS, (marker) => !csv.text.includes(marker));
  const xlsx = await call(env, `/api/ledger/export.xlsx?schoolYearId=${Y1}`, { cookie: sessions.audit });
  assert.equal(xlsx.status, 200);
  assert.match(xlsx.headers.get('content-type'), /spreadsheetml/);
  assert.ok(xlsx.bytes.length > 100);
  assert.ok(!Buffer.from(xlsx.bytes).includes(Buffer.from('MRK-RODZINA')), 'XLSX (także w postaci skompresowanej) nie zawiera markerów rodzin w jawnej postaci');
  const exported = await events(db, 'ledger.exported');
  assert.equal(exported.length, 2);
  assertEvery(exported, (row) => row.actor_id === 'u-audit' && row.entity_id === Y1 && row.metadata_json.role === 'audit');
  assert.deepEqual(exported.map((row) => row.metadata_json.format).sort(), ['csv', 'xlsx']);
  for (const row of exported) assertNoPii(row.metadata_json);
}));

test('flaga włączona: odczyt księgi przez audit zostawia ślad (aktor, rok, zasób), a przez skarbnika — nie', () => withEnv('1', async ({ db, env, sessions }) => {
  await call(env, `/api/ledger?schoolYearId=${Y1}`, { cookie: sessions.audit });
  await call(env, `/api/ledger/categories?schoolYearId=${Y1}`, { cookie: sessions.audit });
  await call(env, `/api/ledger/summary?schoolYearId=${Y1}`, { cookie: sessions.audit });
  const trail = await events(db, 'ledger.audit_read');
  assert.deepEqual(trail.map((row) => row.metadata_json.resource), ['list', 'categories', 'summary']);
  assertEvery(trail, (row) => row.actor_id === 'u-audit' && row.entity_type === 'school_year' && row.entity_id === Y1
    && row.metadata_json.schoolYearId === Y1 && row.metadata_json.role === 'audit');
  assert.equal(trail[0].metadata_json.rowCount, 2);
  for (const row of trail) assertNoPii(row.metadata_json);
  const treasurerList = await call(env, `/api/ledger?schoolYearId=${Y1}`, { cookie: sessions.treasurer });
  assert.equal(treasurerList.status, 200);
  assert.equal((await events(db, 'ledger.audit_read')).length, 3, 'odczyt przez skarbnika nie jest odczytem audit');
  // Skarbnik widzi pełny wpis (kształt bez zmian), w tym opis i identyfikator wpłaty.
  const paid = treasurerList.json.entries.find((entry) => entry.paymentEntryId === 'pay-1');
  assert.match(paid.description, /MRK-RODZINA-OPIS/);
  assert.equal(paid.paymentLinked, undefined);
}));

test('flaga włączona: inny rok 403, przydział klasowy 403, bez MFA — kod MFA, bez śladu odczytu', () => withEnv('1', async ({ db, env, sessions }) => {
  const paths = [
    `/api/ledger?schoolYearId=${Y1}`, `/api/ledger/categories?schoolYearId=${Y1}`, `/api/ledger/summary?schoolYearId=${Y1}`,
    `/api/ledger/export.csv?schoolYearId=${Y1}`, `/api/ledger/export.xlsx?schoolYearId=${Y1}`,
  ];
  for (const path of paths) {
    const otherYear = await call(env, path, { cookie: sessions.auditY2 });
    assert.equal(otherYear.status, 403, `${path}: przydział audit z roku 2`);
    assert.equal(otherYear.json.error, 'forbidden');
    assert.equal((await call(env, path.replace(Y1, Y2), { cookie: sessions.audit })).status, 403, `${path}: rok bez przydziału`);
    const classGrant = await call(env, path, { cookie: sessions.auditClass });
    assert.equal(classGrant.status, 403, `${path}: przydział klasowy nie jest szkolny`);
    const noMfa = await call(env, path, { cookie: sessions.auditNoMfa });
    assert.equal(noMfa.status, 403, path);
    assert.equal(noMfa.json.error, 'mfa_enrollment_required', `${path}: kod prowadzący do zapisu MFA (#161)`);
  }
  for (const action of ['ledger.audit_read', 'ledger.exported']) assert.equal((await events(db, action)).length, 0, action);
}));

test('flaga włączona: audit nie zapisuje niczego — księga, korekty, dokumenty, opisy (403/404, bez zmian w tabelach)', () => withEnv('1', async ({ db, env, sessions, fx }) => {
  const before = {
    entries: await rowCount(db, 'ledger_entries'), corrections: await rowCount(db, 'ledger_corrections'),
    documents: await rowCount(db, 'documents'), descriptions: await rowCount(db, 'document_descriptions'),
    statuses: await rowCount(db, 'document_status_events'), events: await rowCount(db, 'audit_events'),
  };
  const key = () => ({ 'Idempotency-Key': `audit-write-${++seq}-${Date.now()}` });
  const attempts = [
    ['POST', '/api/ledger', { schoolYearId: Y1, direction: 'expense', amountCents: 100, categoryId: 'cat-out-1', description: 'Próba zapisu', occurredOn: '2026-10-03', method: 'bank' }, 403],
    ['POST', `/api/ledger/${fx.expenseId}/corrections`, { amountCents: 1, reason: 'Próba korekty' }, 403],
    ['POST', `/api/ledger/${fx.expenseId}/replacement`, { reason: 'Próba przeksięgowania', schoolYearId: Y1, direction: 'expense', amountCents: 1, categoryId: 'cat-out-1', description: 'Próba', occurredOn: '2026-10-03', method: 'bank' }, 403],
    ['POST', `/api/ledger/${fx.expenseId}/reviews`, { decision: 'verified' }, 403],
    ['POST', '/api/ledger/categories', { schoolYearId: Y1, direction: 'expense', name: 'Próba' }, 403],
    ['POST', `/api/documents/${fx.documents.faktura}/description`, { title: 'Próba', category: 'faktura' }, 404],
    ['POST', `/api/documents/${fx.documents.faktura}/void`, { reason: 'Próba unieważnienia' }, 404],
    ['POST', `/api/documents/${fx.documents.faktura}/supersede`, { reason: 'Próba zastąpienia', replacementDocumentId: fx.documents.inne }, 404],
  ];
  for (const [method, path, body, expected] of attempts) {
    const response = await call(env, path, { cookie: sessions.audit, method, body, headers: key() });
    assert.equal(response.status, expected, `${method} ${path}: ${response.text.slice(0, 120)}`);
  }
  const upload = await call(env, `/api/documents?kind=financial&schoolYearId=${Y1}`, {
    cookie: sessions.audit, method: 'POST', body: PDF, headers: { 'Content-Type': 'application/pdf', ...key() },
  });
  assert.equal(upload.status, 403);
  const after = {
    entries: await rowCount(db, 'ledger_entries'), corrections: await rowCount(db, 'ledger_corrections'),
    documents: await rowCount(db, 'documents'), descriptions: await rowCount(db, 'document_descriptions'),
    statuses: await rowCount(db, 'document_status_events'), events: await rowCount(db, 'audit_events'),
  };
  // Odmowy zapisują wyłącznie ślady odmowy (access.denied / document.access_denied) — dane biznesowe bez zmian.
  assert.deepEqual({ ...after, events: 0 }, { ...before, events: 0 });
}));

test('flaga włączona: audit nie dostaje wpłat, kart gospodarstw, historii obiektu ani eksportu danych rodzin', () => withEnv('1', async ({ env, sessions, fx }) => {
  const paths = [
    `/api/payments?schoolYearId=${Y1}`, `/api/payments/export.csv?schoolYearId=${Y1}`, '/api/households/hh-1',
    `/api/audit/entity/ledger_entry/${fx.expenseId}`, `/api/audit/entity/payment_entry/pay-1`,
    `/api/ledger/budget?schoolYearId=${Y1}`, `/api/ledger/reviews?schoolYearId=${Y1}`, `/api/ledger/cost-centers?schoolYearId=${Y1}`,
    `/api/reports/annual?schoolYearId=${Y1}`, `/api/exports/class-roster?classId=c-audit-1a`,
  ];
  for (const path of paths) {
    const response = await call(env, path, { cookie: sessions.audit });
    assert.ok([403, 404].includes(response.status), `${path}: ${response.status}`);
    assertEvery(['hh-1', 'MRK-RODZINA'], (marker) => !response.text.includes(marker));
  }
}));

test('flaga włączona: audit czyta wyłącznie dowody finansowe z dozwolonych kategorii, niepowiązane z wpłatą', () => withEnv('1', async ({ env, sessions, fx }) => {
  assert.deepEqual([...AUDIT_READABLE_DOCUMENT_CATEGORIES].sort(), ['faktura', 'protokol', 'sprawozdanie_rewizyjne', 'uchwala', 'umowa']);
  const list = await call(env, `/api/documents?schoolYearId=${Y1}&status=all`, { cookie: sessions.audit });
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(list.json.documents.map((doc) => doc.id), [fx.documents.faktura]);
  assertEvery(list.json.documents, (doc) => doc.kind === 'financial' && doc.schoolYearId === Y1);
  const hidden = ['wyciag', 'przelew', 'inne', 'bezKategorii', 'powiazanyZWplata', 'board'];
  for (const name of hidden) {
    const id = fx.documents[name];
    assert.ok(!list.text.includes(id), `lista audit zawiera ${name}`);
    for (const suffix of ['', '/content', '/content?disposition=inline']) {
      const response = await call(env, `/api/documents/${id}${suffix}`, { cookie: sessions.audit });
      assert.equal(response.status, 404, `${name}${suffix}`);
      assert.equal(response.json.error, 'not_found');
    }
  }
  // Filtr rodzaju nie rozszerza zakresu.
  const boardKind = await call(env, `/api/documents?schoolYearId=${Y1}&kind=board`, { cookie: sessions.audit });
  assert.equal(boardKind.status, 200);
  assert.deepEqual(boardKind.json.documents, []);
  const classKind = await call(env, `/api/documents?schoolYearId=${Y1}&kind=class`, { cookie: sessions.audit });
  assert.deepEqual(classKind.json.documents, []);
  const byCategory = await call(env, `/api/documents?schoolYearId=${Y1}&category=wyciag`, { cookie: sessions.audit });
  assert.deepEqual(byCategory.json.documents, []);
}));

test('flaga włączona: metadane i treść dowodu dla audit — 200, bez wolnego tekstu opisu, ślad odczytu i pobrania', () => withEnv('1', async ({ db, env, sessions, fx }) => {
  const id = fx.documents.faktura;
  const meta = await call(env, `/api/documents/${id}`, { cookie: sessions.audit });
  assert.equal(meta.status, 200, meta.text);
  assert.equal(meta.json.document.category, 'faktura');
  assert.ok(meta.json.descriptionHistory.length > 0);
  assertEvery(meta.json.descriptionHistory, (row) => row.description === null);
  assert.ok(!meta.text.includes('MRK-OPIS-WOLNY-TEKST'));
  // Skarbnik nadal widzi pełny opis (zakres audit nie zmienia widoku ról finansowych).
  const full = await call(env, `/api/documents/${id}`, { cookie: sessions.treasurer });
  assert.ok(full.text.includes('MRK-OPIS-WOLNY-TEKST'));

  const content = await call(env, `/api/documents/${id}/content`, { cookie: sessions.audit });
  assert.equal(content.status, 200);
  assert.deepEqual([...content.bytes], [...PDF]);
  // PDF nie jest wydawany inline (PDF.js, #89): bajty do podglądu idą z purpose=preview.
  const inlinePdf = await call(env, `/api/documents/${id}/content?disposition=inline`, { cookie: sessions.audit });
  assert.equal(inlinePdf.status, 400);
  assert.equal(inlinePdf.json.error, 'pdf_inline_not_allowed');
  const preview = await call(env, `/api/documents/${id}/content?purpose=preview`, { cookie: sessions.audit });
  assert.equal(preview.status, 200);
  assert.deepEqual([...preview.bytes], [...PDF]);

  const trail = {
    list: await call(env, `/api/documents?schoolYearId=${Y1}`, { cookie: sessions.audit }),
    read: await events(db, 'document.audit_read'),
    downloaded: await events(db, 'document.downloaded'),
    viewed: await events(db, 'document.viewed'),
  };
  assert.equal(trail.list.status, 200);
  const audited = (await events(db, 'document.audit_read')).map((row) => row.metadata_json.resource).sort();
  assert.deepEqual(audited, ['list', 'metadata']);
  assertEvery(trail.read, (row) => row.actor_id === 'u-audit' && row.metadata_json.role === 'audit');
  assert.equal(trail.downloaded.length, 1);
  assert.equal(trail.viewed.length, 1);
  for (const row of [...trail.downloaded, ...trail.viewed]) {
    assert.equal(row.actor_id, 'u-audit');
    assert.equal(row.entity_id, id);
    assert.equal(row.metadata_json.role, 'audit');
    assertNoPii(row.metadata_json);
  }
  // Skarbnik czyta dokumenty jak dotąd: bez śladu roli audit.
  assert.equal((await events(db, 'document.audit_read')).length, 2);
}));

test('flaga włączona: dokumenty — inny rok i brak MFA (lista: kod MFA, szczegół i treść: 404 jak brak dokumentu)', () => withEnv('1', async ({ db, env, sessions, fx }) => {
  const id = fx.documents.faktura;
  assert.equal((await call(env, `/api/documents?schoolYearId=${Y1}`, { cookie: sessions.auditY2 })).status, 403);
  assert.equal((await call(env, `/api/documents?schoolYearId=${Y2}`, { cookie: sessions.audit })).status, 403);
  assert.equal((await call(env, `/api/documents?schoolYearId=${Y1}`, { cookie: sessions.auditClass })).status, 403);
  const noMfaList = await call(env, `/api/documents?schoolYearId=${Y1}`, { cookie: sessions.auditNoMfa });
  assert.equal(noMfaList.status, 403);
  assert.equal(noMfaList.json.error, 'mfa_enrollment_required');
  for (const cookie of [sessions.auditY2, sessions.auditNoMfa, sessions.auditClass]) {
    for (const suffix of ['', '/content']) {
      assert.equal((await call(env, `/api/documents/${id}${suffix}`, { cookie })).status, 404, suffix);
    }
  }
  assert.equal((await events(db, 'document.audit_read')).length, 0);
  assert.equal((await events(db, 'document.downloaded')).length, 0);
}));

test('flaga wyłączona (brak, `0`, pusta): stan dotychczasowy — księga i dokumenty 403/404, brak śladów odczytu audit', async () => {
  for (const flag of [undefined, '0', '']) {
    await withEnv(flag, async ({ db, env, sessions, fx }) => {
      for (const path of [
        `/api/ledger?schoolYearId=${Y1}`, `/api/ledger/categories?schoolYearId=${Y1}`, `/api/ledger/summary?schoolYearId=${Y1}`,
        `/api/ledger/export.csv?schoolYearId=${Y1}`, `/api/ledger/export.xlsx?schoolYearId=${Y1}`, `/api/documents?schoolYearId=${Y1}`,
      ]) {
        const response = await call(env, path, { cookie: sessions.audit });
        assert.equal(response.status, 403, `${String(flag)} ${path}`);
        assert.equal(response.json.error, 'forbidden');
        // Bez flagi także brak MFA nie odsłania żadnych informacji o zasobie: zwykłe forbidden.
        assert.equal((await call(env, path, { cookie: sessions.auditNoMfa })).json.error, 'forbidden', `${String(flag)} ${path} bez MFA`);
      }
      for (const suffix of ['', '/content']) {
        assert.equal((await call(env, `/api/documents/${fx.documents.faktura}${suffix}`, { cookie: sessions.audit })).status, 404);
      }
      for (const action of ['ledger.audit_read', 'ledger.exported', 'document.audit_read', 'document.downloaded', 'document.viewed']) {
        assert.equal((await events(db, action)).length, 0, `${String(flag)} ${action}`);
      }
      // Role finansowe działają jak dotąd, a ścieżka kontroli audit pozostaje dostępna.
      assert.equal((await call(env, `/api/ledger?schoolYearId=${Y1}`, { cookie: sessions.treasurer })).status, 200);
      assert.equal((await call(env, `/api/audit-reviews/${Y1}`, { cookie: sessions.audit })).status, 200);
    });
  }
});

// Panele księgi i dokumentów (ledger/, documents/) dowiadują się o fladze z GET /api/session. Pole
// `capabilities` dostaje wyłącznie konto z rolą audit (przydział bez klasy, MFA) przy fladze włączonej;
// dla pozostałych kont i przy fladze wyłączonej pola nie ma — odpowiedź nie zdradza konfiguracji.
test('GET /api/session, flaga włączona: capabilities.auditLedgerRead tylko dla audit z MFA i przydziałem bez klasy', () => withEnv('1', async ({ env, sessions }) => {
  const audit = await call(env, '/api/session', { cookie: sessions.audit });
  assert.equal(audit.status, 200, audit.text);
  assert.deepEqual(audit.json.capabilities, { auditLedgerRead: true });
  // Wskazówka zależy od roli konta, nie od roku — o roku decydują trasy (inny rok: 403, sprawdzone wyżej).
  assert.deepEqual((await call(env, '/api/session', { cookie: sessions.auditY2 })).json.capabilities, { auditLedgerRead: true });
  const others = ['treasurer', 'board', 'auditNoMfa', 'auditClass'];
  const responses = await Promise.all(others.map((name) => call(env, '/api/session', { cookie: sessions[name] })));
  assertEvery(responses, (response) => response.status === 200 && !('capabilities' in response.json) && !response.text.includes('auditLedgerRead'),
    'konta bez roli audit, bez MFA albo z przydziałem klasowym nie dostają capabilities', { exact: others.length });
}));

test('GET /api/session, flaga wyłączona (brak, `0`, pusta): żadne konto nie dostaje capabilities, także audit', async () => {
  for (const flag of [undefined, '0', '']) {
    await withEnv(flag, async ({ env, sessions }) => {
      const names = ['audit', 'auditY2', 'treasurer', 'board'];
      const responses = await Promise.all(names.map((name) => call(env, '/api/session', { cookie: sessions[name] })));
      assertEvery(responses, (response) => response.status === 200 && !('capabilities' in response.json) && !response.text.includes('auditLedgerRead'),
        `flaga ${String(flag)}: brak capabilities`, { exact: names.length });
    });
  }
});

test('GET /api/session, flaga włączona: pole nie zmienia reszty kontraktu sesji (bez zapisu w bazie i śladów odczytu księgi)', () => withEnv('1', async ({ db, env, sessions }) => {
  const before = await rowCount(db, 'audit_events');
  const audit = await call(env, '/api/session', { cookie: sessions.audit });
  assert.deepEqual(Object.keys(audit.json).sort(), ['capabilities', 'expiresAt', 'mfaVerified', 'sessionId', 'user', 'writeMode']);
  assert.equal(await rowCount(db, 'audit_events'), before, 'odczyt sesji nie tworzy zdarzeń');
  assert.equal((await events(db, 'ledger.audit_read')).length, 0);
}));
