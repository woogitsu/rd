// Dowody księgowe przy wpisach księgi (#87). Wyłącznie dane i pliki syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { renderAuditReportHtml } from '../src/pg/audit-report.js';
import { auditReportContentSha256 } from '../src/pg/audit-report-xlsx.js';
import { CHECKLIST_ITEMS } from '../src/pg/routes/year-close.js';
import { createMemoryStorage } from '../src/storage.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const YEAR = 'y-2026';
const OTHER_YEAR = 'y-2025';
const NEXT_YEAR = 'y-2027';
const PDF = new TextEncoder().encode('%PDF-1.4\n% syntetyczny dowod\n1 0 obj <<>> endobj\n%%EOF\n');
const PDF_2 = new TextEncoder().encode('%PDF-1.4\n% drugi syntetyczny dowod\n%%EOF\n');

async function withEnv(fn) {
  const db = await createTestDb();
  await seedSchoolYear(db, OTHER_YEAR, { startsOn: '2025-09-01', endsOn: '2026-08-31' });
  await seedSchoolYear(db, YEAR);
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR });
  const treasurer = await seedUserSession(db, {
    userId: 'u-treasurer', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }, { role: 'treasurer', schoolYearId: OTHER_YEAR }],
  });
  const board = await seedUserSession(db, { userId: 'u-board', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] });
  const audit = await seedUserSession(db, { userId: 'u-audit', mfa: true, roles: [{ role: 'audit', schoolYearId: YEAR }] });
  const rep = await seedUserSession(db, { userId: 'u-rep', mfa: true, roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }] });
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES
    ('cat-exp', $1, 'expense', 'Wydarzenia', 'u-treasurer'),
    ('cat-inc', $1, 'income', 'Składki dobrowolne', 'u-treasurer')`, [YEAR]);
  const storage = createMemoryStorage();
  const env = { db, storage };
  try {
    return await fn({ db, env, cookies: { treasurer, board, audit, rep } });
  } finally {
    await db.close();
  }
}

let counter = 0;
const key = (prefix) => `${prefix}-${++counter}-synthetic`;

async function call(env, path, { cookie, method, body, idempotencyKey, headers = {} } = {}) {
  const extra = { ...headers };
  if (idempotencyKey) extra['Idempotency-Key'] = idempotencyKey;
  const response = await handlePgRequest(request(path, { method: method ?? (body === undefined ? 'GET' : 'POST'), cookie, body, headers: extra }), env);
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, body: data };
}

async function uploadDocument(env, cookie, { kind = 'financial', schoolYearId = YEAR, classId, link, bytes = PDF, idempotencyKey = key('doc') } = {}) {
  const query = new URLSearchParams({ kind, schoolYearId });
  if (classId) query.set('classId', classId);
  if (link) { query.set('linkedEntityType', 'ledger_entry'); query.set('linkedEntityId', link); }
  return call(env, `/api/documents?${query}`, {
    cookie, method: 'POST', body: bytes, idempotencyKey, headers: { 'Content-Type': 'application/pdf' },
  });
}

const expense = (patch = {}) => ({
  schoolYearId: YEAR, direction: 'expense', amountCents: 4250, categoryId: 'cat-exp',
  description: 'Syntetyczny zakup na wydarzenie', occurredOn: '2026-10-05', method: 'bank', ...patch,
});

async function createEntry(env, cookie, patch, idempotencyKey = key('entry')) {
  return call(env, '/api/ledger', { cookie, body: expense(patch), idempotencyKey });
}

async function listEntries(env, cookie) {
  return (await call(env, `/api/ledger?schoolYearId=${YEAR}`, { cookie })).body.entries;
}

test('source document must be a financial API document of the same year; every other case gives one code', async () => withEnv(async ({ db, env, cookies }) => {
  const financial = (await uploadDocument(env, cookies.treasurer)).body.document;
  const otherYear = (await uploadDocument(env, cookies.treasurer, { schoolYearId: OTHER_YEAR, bytes: PDF_2 })).body.document;
  const boardDoc = (await uploadDocument(env, cookies.board, { kind: 'board' })).body.document;
  const classDoc = (await uploadDocument(env, cookies.board, { kind: 'class', classId: 'c-1a' })).body.document;
  // Wiersz odtworzony z D1: bez roku szkolnego (0006_documents.sql).
  await db.query(`INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by)
    VALUES ('legacy-doc', 'synthetic/legacy.pdf', 'application/pdf', 10, 'financial', 'u-treasurer')`);

  for (const sourceDocumentId of [otherYear.id, boardDoc.id, classDoc.id, 'legacy-doc', 'doc-missing']) {
    const refused = await createEntry(env, cookies.treasurer, { sourceDocumentId });
    assert.deepEqual([refused.status, refused.body], [400, { error: 'invalid_source_document' }], sourceDocumentId);
  }
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM ledger_entries')).rows[0].n), 0);

  const created = await createEntry(env, cookies.treasurer, { sourceDocumentId: financial.id });
  assert.equal(created.status, 201);
  assert.equal(created.body.entry.sourceDocumentId, financial.id);
}));

test('unauthorized roles get 403 before the document is looked up (no existence oracle)', async () => withEnv(async ({ env, cookies }) => {
  const financial = (await uploadDocument(env, cookies.treasurer)).body.document;
  for (const cookie of [cookies.rep, cookies.audit]) {
    for (const sourceDocumentId of [financial.id, 'doc-missing']) {
      const refused = await createEntry(env, cookie, { sourceDocumentId });
      assert.deepEqual([refused.status, refused.body], [403, { error: 'forbidden' }]);
    }
    assert.equal((await call(env, `/api/ledger?schoolYearId=${YEAR}`, { cookie })).status, 403);
  }
}));

test('entry lists all evidence: primary document and documents attached later; attaching changes nothing in the entry', async () => withEnv(async ({ db, env, cookies }) => {
  const primary = (await uploadDocument(env, cookies.treasurer)).body.document;
  const entry = (await createEntry(env, cookies.treasurer, { sourceDocumentId: primary.id })).body.entry;
  const before = (await db.query('SELECT * FROM ledger_entries WHERE id = $1', [entry.id])).rows[0];

  const attachKey = key('attach');
  const attached = await uploadDocument(env, cookies.board, { link: entry.id, bytes: PDF_2, idempotencyKey: attachKey });
  assert.equal(attached.status, 201);
  // Podwójne kliknięcie przy przesłaniu: ten sam klucz -> ten sam dokument.
  const again = await uploadDocument(env, cookies.board, { link: entry.id, bytes: PDF_2, idempotencyKey: attachKey });
  assert.equal(again.status, 200);
  assert.equal(again.body.document.id, attached.body.document.id);
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM documents WHERE linked_entity_id = $1", [entry.id])).rows[0].n), 1);

  const after = (await db.query('SELECT * FROM ledger_entries WHERE id = $1', [entry.id])).rows[0];
  assert.deepEqual(after, before, 'załącznik nie zmienia wpisu');
  const [event] = (await db.query(
    "SELECT actor_id, entity_id, metadata_json FROM audit_events WHERE action = 'document.uploaded' AND entity_id = $1",
    [attached.body.document.id],
  )).rows;
  assert.equal(event.actor_id, 'u-board');
  assert.equal(event.metadata_json.linkedEntityType, 'ledger_entry');
  assert.equal(event.metadata_json.linkedEntityId, entry.id);
  assert.doesNotMatch(JSON.stringify(event.metadata_json), /filename|Syntetyczny|syntetyczny|(?<![\w-])4250(?![\w-])/);

  const [listed] = await listEntries(env, cookies.treasurer);
  assert.deepEqual(listed.attachmentIds, [primary.id, attached.body.document.id]);

  // Korekta wpisu nie usuwa powiązań dowodów.
  const correction = await call(env, `/api/ledger/${entry.id}/corrections`, {
    cookie: cookies.treasurer, body: { amountCents: 250, reason: 'Syntetyczny częściowy zwrot' }, idempotencyKey: key('corr'),
  });
  assert.equal(correction.status, 201);
  const [corrected] = await listEntries(env, cookies.treasurer);
  assert.deepEqual(corrected.attachmentIds, [primary.id, attached.body.document.id]);
  assert.equal(corrected.netAmountCents, 4000);

  const csv = await handlePgRequest(request(`/api/ledger/export.csv?schoolYearId=${YEAR}`, { cookie: cookies.treasurer }), env);
  const lines = (await csv.text()).split('\r\n');
  assert.ok(lines[0].endsWith(';liczba_dowodow;id_dowodow;zastapiony_przez'), 'kolumny dowodów przed kolumną łańcucha #144 (ostatnia)');
  assert.ok(lines[1].endsWith(`;2;${primary.id} ${attached.body.document.id};`), "zwykły wpis: pusta kolumna zastapiony_przez na końcu");

  // Plik z błędnym typem przy dołączaniu do wpisu -> odmowa, brak powiązania.
  const wrongType = await call(env, `/api/documents?kind=financial&schoolYearId=${YEAR}&linkedEntityType=ledger_entry&linkedEntityId=${entry.id}`, {
    cookie: cookies.treasurer, method: 'POST', body: new TextEncoder().encode('<html></html>'),
    idempotencyKey: key('bad'), headers: { 'Content-Type': 'text/html' },
  });
  assert.equal(wrongType.status, 415);
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM documents WHERE linked_entity_id = $1", [entry.id])).rows[0].n), 1);
}));

// #82: powiązanie z wpisem zostaje przy pierwotnym dokumencie (historia), a lista
// wskazuje stan każdego dowodu i jego aktualną wersję po łańcuchu zastąpień.
const pdfVariant = (label) => new TextEncoder().encode(`%PDF-1.4\n% syntetyczny dowod ${label}\n%%EOF\n`);
async function changeDocumentStatus(env, cookie, id, action, body = {}) {
  return call(env, `/api/documents/${id}/${action}`, {
    cookie, body: { reason: 'Syntetyczny powod zmiany', ...body }, idempotencyKey: key(`status-${action}`),
  });
}

test('#82: entry evidence shows status and the current version; old links stay in attachmentIds', async () => withEnv(async ({ env, cookies }) => {
  const primary = (await uploadDocument(env, cookies.treasurer, { bytes: pdfVariant('A') })).body.document;
  const entry = (await createEntry(env, cookies.treasurer, { sourceDocumentId: primary.id })).body.entry;
  const linked = (await uploadDocument(env, cookies.treasurer, { link: entry.id, bytes: pdfVariant('L') })).body.document;

  let [listed] = await listEntries(env, cookies.treasurer);
  assert.deepEqual(listed.attachments, [
    { documentId: primary.id, status: 'active', currentDocumentId: primary.id },
    { documentId: linked.id, status: 'active', currentDocumentId: linked.id },
  ]);

  // Faktura korygująca B zastępuje A, potem C zastępuje B — aktualna wersja dowodu A to C.
  const b = (await uploadDocument(env, cookies.treasurer, { bytes: pdfVariant('B') })).body.document;
  const c = (await uploadDocument(env, cookies.treasurer, { bytes: pdfVariant('C') })).body.document;
  assert.equal((await changeDocumentStatus(env, cookies.treasurer, primary.id, 'supersede', { replacementDocumentId: b.id })).status, 201);
  assert.equal((await changeDocumentStatus(env, cookies.treasurer, b.id, 'supersede', { replacementDocumentId: c.id })).status, 201);
  assert.equal((await changeDocumentStatus(env, cookies.treasurer, linked.id, 'void')).status, 201);

  [listed] = await listEntries(env, cookies.treasurer);
  assert.deepEqual(listed.attachmentIds, [primary.id, linked.id], 'powiązania pierwotne zostają (historia)');
  assert.equal(listed.sourceDocumentId, primary.id);
  assert.deepEqual(listed.attachments, [
    { documentId: primary.id, status: 'superseded', currentDocumentId: c.id },
    { documentId: linked.id, status: 'voided', currentDocumentId: null },
  ]);

  // Ostatnia wersja unieważniona: zastąpiony dowód nie ma już aktualnej wersji.
  assert.equal((await changeDocumentStatus(env, cookies.treasurer, c.id, 'void')).status, 201);
  [listed] = await listEntries(env, cookies.treasurer);
  assert.deepEqual(listed.attachments[0], { documentId: primary.id, status: 'superseded', currentDocumentId: null });

  // Wpis bez dowodów: pusta lista, bez dodatkowego zapytania o stan.
  await createEntry(env, cookies.treasurer, { occurredOn: '2026-10-01' });
  const entries = await listEntries(env, cookies.treasurer);
  assert.deepEqual(entries.find((item) => item.id !== entry.id).attachments, []);
}));

test('storage failure while attaching leaves no orphaned link; retry with the same key attaches once', async () => withEnv(async ({ db, env, cookies }) => {
  const entry = (await createEntry(env, cookies.treasurer, {})).body.entry;
  const originalPut = env.storage.putObject;
  env.storage.putObject = async () => { throw Object.assign(new Error('storage_unreachable'), { code: 'storage_unreachable' }); };
  const attachKey = key('attach-retry');
  const originalError = console.error;
  console.error = () => {};
  try {
    const failed = await uploadDocument(env, cookies.treasurer, { link: entry.id, idempotencyKey: attachKey });
    assert.ok(failed.status >= 500);
  } finally {
    console.error = originalError;
    env.storage.putObject = originalPut;
  }
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM documents WHERE linked_entity_id = $1', [entry.id])).rows[0].n), 0);
  const [listed] = await listEntries(env, cookies.treasurer);
  assert.deepEqual(listed.attachmentIds, []);
  const retried = await uploadDocument(env, cookies.treasurer, { link: entry.id, idempotencyKey: attachKey });
  assert.equal(retried.status, 201);
  const [after] = await listEntries(env, cookies.treasurer);
  assert.deepEqual(after.attachmentIds, [retried.body.document.id]);
}));

test('audit report lists expenses without evidence and possible duplicate evidence', async () => withEnv(async ({ env, cookies }) => {
  const shared = (await uploadDocument(env, cookies.treasurer)).body.document;
  const withPrimary = (await createEntry(env, cookies.treasurer, { sourceDocumentId: shared.id, description: 'Syntetyczny wydatek A' })).body.entry;
  // Ten sam plik dołączony później do drugiego wydatku -> możliwy duplikat.
  const second = (await createEntry(env, cookies.treasurer, { description: 'Syntetyczny wydatek B', amountCents: 1200 })).body.entry;
  const duplicate = (await uploadDocument(env, cookies.treasurer, { link: second.id })).body.document;
  const missing = (await createEntry(env, cookies.treasurer, { description: 'Syntetyczny wydatek bez dowodu', amountCents: 999 })).body.entry;
  // Wydatek skorygowany do zera nie wymaga już dowodu.
  const zeroed = (await createEntry(env, cookies.treasurer, { description: 'Syntetyczny wydatek anulowany', amountCents: 500 })).body.entry;
  await call(env, `/api/ledger/${zeroed.id}/corrections`, {
    cookie: cookies.treasurer, body: { amountCents: 500, reason: 'Syntetyczne anulowanie' }, idempotencyKey: key('zero'),
  });
  // Przychód bez dokumentu nie jest wydatkiem bez dowodu.
  await createEntry(env, cookies.treasurer, { direction: 'income', categoryId: 'cat-inc', description: 'Syntetyczny przychód' });

  const response = await call(env, `/api/reports/audit?schoolYearId=${YEAR}`, { cookie: cookies.audit });
  assert.equal(response.status, 200);
  const { evidence } = response.body.report;
  assert.deepEqual(evidence.expensesWithoutEvidence, {
    count: 1, netCents: 999,
    items: [{ id: missing.id, occurredOn: '2026-10-05', category: 'Wydarzenia', description: 'Syntetyczny wydatek bez dowodu', netAmountCents: 999 }],
  });
  assert.deepEqual(evidence.possibleDuplicateEvidence, [{
    documentIds: [shared.id, duplicate.id].sort(), ledgerEntryIds: [withPrimary.id, second.id].sort(),
  }]);

  const html = renderAuditReportHtml(response.body.report);
  assert.match(html, /6\. Dowody wydatków/);
  assert.match(html, /Wydatki bez dowodu: 1; suma netto 9,99/);
  assert.match(html, /Możliwe duplikaty dowodu/);
  assert.ok(html.includes(missing.id));
  // Raport sprzed #87 (bez sekcji) nadal się renderuje.
  const legacy = { ...response.body.report };
  delete legacy.evidence;
  assert.match(renderAuditReportHtml(legacy), /Każdy wydatek ma co najmniej jeden dokument/);
}));

// #82/#594: raport KR i ostrzeżenie zamknięcia roku liczą dowód wg tej samej
// reguły łańcucha zastąpień co GET /api/ledger (src/pg/document-chain.js).
async function auditReport(env, cookie, format = 'json') {
  const response = await call(env, `/api/reports/audit?schoolYearId=${YEAR}${format === 'json' ? '' : `&format=${format}`}`, { cookie });
  assert.equal(response.status, 200);
  return format === 'json' ? response.body.report : response.body;
}

test('#82/#594: raport KR — dowód unieważniony, zastąpiony, łańcuch A→B→C; skrót zmienia się tylko przy unieważnieniu', async () => withEnv(async ({ env, cookies }) => {
  const t = cookies.treasurer;
  // e1: jedyny dowód (dokument główny) unieważniony.
  const v = (await uploadDocument(env, t, { bytes: pdfVariant('V') })).body.document;
  const e1 = (await createEntry(env, t, { sourceDocumentId: v.id, description: 'Syntetyczny wydatek 1', amountCents: 1100, occurredOn: '2026-10-01' })).body.entry;
  // e2: dowód dołączony później, zastąpiony aktywną wersją.
  const e2 = (await createEntry(env, t, { description: 'Syntetyczny wydatek 2', amountCents: 1200, occurredOn: '2026-10-02' })).body.entry;
  const s1 = (await uploadDocument(env, t, { link: e2.id, bytes: pdfVariant('S1') })).body.document;
  const s2 = (await uploadDocument(env, t, { bytes: pdfVariant('S2') })).body.document;
  // e3: łańcuch A→B→C (dokument główny A).
  const a = (await uploadDocument(env, t, { bytes: pdfVariant('A') })).body.document;
  const e3 = (await createEntry(env, t, { sourceDocumentId: a.id, description: 'Syntetyczny wydatek 3', amountCents: 1300, occurredOn: '2026-10-03' })).body.entry;
  const b = (await uploadDocument(env, t, { bytes: pdfVariant('B') })).body.document;
  const c = (await uploadDocument(env, t, { bytes: pdfVariant('C') })).body.document;
  // e4: jeden dowód unieważniony, drugi aktywny — wydatek ma dowód.
  const e4 = (await createEntry(env, t, { description: 'Syntetyczny wydatek 4', amountCents: 1400, occurredOn: '2026-10-04' })).body.entry;
  const w1 = (await uploadDocument(env, t, { link: e4.id, bytes: pdfVariant('W1') })).body.document;
  await uploadDocument(env, t, { link: e4.id, bytes: pdfVariant('W2') });
  // e5: bez żadnego dokumentu.
  const e5 = (await createEntry(env, t, { description: 'Syntetyczny wydatek 5', amountCents: 1500, occurredOn: '2026-10-05' })).body.entry;
  // e6/e7: ten sam plik przy dwóch wydatkach (możliwy duplikat).
  const e6 = (await createEntry(env, t, { description: 'Syntetyczny wydatek 6', amountCents: 1600, occurredOn: '2026-10-06' })).body.entry;
  const e7 = (await createEntry(env, t, { description: 'Syntetyczny wydatek 7', amountCents: 1700, occurredOn: '2026-10-07' })).body.entry;
  const d6 = (await uploadDocument(env, t, { link: e6.id, bytes: PDF_2 })).body.document;
  const d7 = (await uploadDocument(env, t, { link: e7.id, bytes: PDF_2 })).body.document;

  const plain = (entry, net) => ({ id: entry.id, occurredOn: entry.occurredOn, category: 'Wydarzenia', description: entry.description, netAmountCents: net });

  // Tylko zastąpienia (bez unieważnień): treść sekcji jak przed zmianą — bez
  // nowych pól, e2 i e3 mają dowód.
  assert.equal((await changeDocumentStatus(env, t, s1.id, 'supersede', { replacementDocumentId: s2.id })).status, 201);
  assert.equal((await changeDocumentStatus(env, t, a.id, 'supersede', { replacementDocumentId: b.id })).status, 201);
  assert.equal((await changeDocumentStatus(env, t, b.id, 'supersede', { replacementDocumentId: c.id })).status, 201);
  let report = await auditReport(env, cookies.audit);
  assert.deepEqual(report.evidence.expensesWithoutEvidence, { count: 1, netCents: 1500, items: [plain(e5, 1500)] });
  assert.deepEqual(report.evidence.possibleDuplicateEvidence, [{ documentIds: [d6.id, d7.id].sort(), ledgerEntryIds: [e6.id, e7.id].sort() }]);
  const hashWithoutVoids = await auditReportContentSha256(report);
  assert.equal(await auditReportContentSha256(await auditReport(env, cookies.audit)), hashWithoutVoids, 'te same dane → ten sam skrót');

  // Unieważnienia: V (e1), W1 (e4, ma drugi aktywny dowód), D7 (e7 — znika duplikat).
  for (const id of [v.id, w1.id, d7.id]) assert.equal((await changeDocumentStatus(env, t, id, 'void')).status, 201);
  report = await auditReport(env, cookies.audit);
  assert.deepEqual(report.evidence.expensesWithoutEvidence, {
    count: 3, netCents: 1100 + 1500 + 1700,
    items: [
      { ...plain(e1, 1100), evidenceStatus: 'voided', voidedDocumentIds: [v.id] },
      plain(e5, 1500),
      { ...plain(e7, 1700), evidenceStatus: 'voided', voidedDocumentIds: [d7.id] },
    ],
  });
  assert.deepEqual(report.evidence.possibleDuplicateEvidence, [], 'unieważniony plik nie jest duplikatem dowodu');
  assert.notEqual(await auditReportContentSha256(report), hashWithoutVoids);

  // Koniec łańcucha A→B→C unieważniony: e3 bez dowodu, adnotacja z pierwotnym A.
  assert.equal((await changeDocumentStatus(env, t, c.id, 'void')).status, 201);
  report = await auditReport(env, cookies.audit);
  const e3Item = report.evidence.expensesWithoutEvidence.items.find((item) => item.id === e3.id);
  assert.deepEqual(e3Item, { ...plain(e3, 1300), evidenceStatus: 'voided', voidedDocumentIds: [a.id] });
  assert.ok(!report.evidence.expensesWithoutEvidence.items.some((item) => [e2.id, e4.id, e6.id].includes(item.id)));
  // Ta sama reguła co GET /api/ledger: attachments e3 bez aktualnej wersji.
  const listed = (await listEntries(env, t)).find((item) => item.id === e3.id);
  assert.deepEqual(listed.attachments, [{ documentId: a.id, status: 'superseded', currentDocumentId: null }]);

  // HTML: kolumna „Uwagi” z adnotacją; wydatek bez dokumentu bez adnotacji.
  const html = await auditReport(env, cookies.audit, 'html');
  assert.match(html, /<th[^>]*>Uwagi<\/th>/);
  assert.equal(html.split('dowód unieważniony</td>').length - 1, 3);
  assert.match(renderAuditReportHtml(report), /Wydatki bez dowodu: 4; suma netto 56,00/);
}));

test('#82/#594: zamknięcie roku — ostrzeżenie expenses_without_evidence przed, raport KR zamkniętego roku po unieważnieniu', async () => withEnv(async ({ db, env, cookies }) => {
  const t = cookies.treasurer;
  const doc1 = (await uploadDocument(env, t, { bytes: pdfVariant('Z1') })).body.document;
  const e1 = (await createEntry(env, t, { sourceDocumentId: doc1.id, description: 'Syntetyczny wydatek przed zamknięciem', amountCents: 2500 })).body.entry;
  const doc2 = (await uploadDocument(env, t, { bytes: pdfVariant('Z2') })).body.document;
  const e2 = (await createEntry(env, t, { sourceDocumentId: doc2.id, description: 'Syntetyczny wydatek po zamknięciu', amountCents: 700, occurredOn: '2026-10-06' })).body.entry;
  const replacement = (await uploadDocument(env, t, { bytes: pdfVariant('Z3') })).body.document;
  const warnings = async () => {
    const response = await handlePgRequest(request(`/api/year-close/${YEAR}`, { cookie: cookies.board }), env);
    assert.equal(response.status, 200);
    return Object.fromEntries((await response.json()).warnings.map((w) => [w.code, w]));
  };
  assert.equal((await warnings()).expenses_without_evidence, undefined, 'aktywne dowody — bez ostrzeżenia');
  assert.equal((await changeDocumentStatus(env, t, doc1.id, 'void')).status, 201);
  assert.deepEqual((await warnings()).expenses_without_evidence, { code: 'expenses_without_evidence', count: 1, amountCents: 2500 });

  // Zamknięcie roku pełną ścieżką API (start, lista kontrolna, cztery oczy);
  // ostrzeżenie nie blokuje.
  await seedSchoolYear(db, NEXT_YEAR, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  const boardB = await seedUserSession(db, { userId: 'u-board-b', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] });
  const post = async (path, cookie, body = {}) => handlePgRequest(request(path, { method: 'POST', cookie, body }), env);
  assert.equal((await post(`/api/year-close/${YEAR}/start`, cookies.board, { nextSchoolYearId: NEXT_YEAR })).status, 201);
  for (const [index, item] of CHECKLIST_ITEMS.entries()) {
    const response = await post(`/api/year-close/${YEAR}/checklist/${item}`, index % 2 ? t : cookies.board, { note: `Potwierdzenie ${item}` });
    assert.equal(response.status, 201, item);
  }
  const closed = await post(`/api/year-close/${YEAR}/close`, boardB);
  assert.equal(closed.status, 200, JSON.stringify(await closed.clone().json()));
  assert.equal((await db.query('SELECT status FROM school_year_closures WHERE school_year_id = $1', [YEAR])).rows[0].status, 'closed');

  // Zamknięcie wygasza przydziały roku. Unieważnia administrator (przydział
  // globalny); raport zamkniętego roku czyta nowa Rada (przydział w roku
  // następnym, dostęp archiwalny src/pg/archive-access.js).
  const admin = await seedUserSession(db, { userId: 'u-admin', mfa: true, roles: [{ role: 'admin' }] });
  const newBoard = await seedUserSession(db, { userId: 'u-board-next', mfa: true, roles: [{ role: 'board', schoolYearId: NEXT_YEAR }] });
  // Zastąpienie w zamkniętym roku jest zablokowane (korekta roku), unieważnienie nie.
  const blocked = await changeDocumentStatus(env, admin, doc2.id, 'supersede', { replacementDocumentId: replacement.id });
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.equal((await changeDocumentStatus(env, admin, doc2.id, 'void')).status, 201);

  const report = await auditReport(env, newBoard);
  assert.deepEqual(report.evidence.expensesWithoutEvidence, {
    count: 2, netCents: 3200,
    items: [
      { id: e1.id, occurredOn: '2026-10-05', category: 'Wydarzenia', description: 'Syntetyczny wydatek przed zamknięciem',
        netAmountCents: 2500, evidenceStatus: 'voided', voidedDocumentIds: [doc1.id] },
      { id: e2.id, occurredOn: '2026-10-06', category: 'Wydarzenia', description: 'Syntetyczny wydatek po zamknięciu',
        netAmountCents: 700, evidenceStatus: 'voided', voidedDocumentIds: [doc2.id] },
    ],
  });
}));
