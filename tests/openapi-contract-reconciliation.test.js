// Kontrakt API (#160, etap 5): prawdziwe odpowiedzi modułu `reconciliation` (uzgodnienia wyciągów
// bankowych i raport Komisji Rewizyjnej) walidowane schematami z docs/openapi.json
// (src/pg/schemas/reconciliation.js) przez tests/helpers/contract-client.js. Rejestr pokrycia i katalog
// kodów sprawdza tests/openapi-contract.test.js (wspólnie dla wszystkich pokrytych modułów).
//
// PGlite, wyłącznie dane syntetyczne: rachunki to przykładowe IBAN z dokumentacji standardów
// (tests/helpers/bank-statements.js), tytuły „syntetyczne”, adresy tylko w domenie example.invalid.
// Zakres: utworzenie uzgodnienia z ponowieniem, import listy JSON, CSV, CODA i CAMT.053 (z ponowieniem,
// duplikatami ruchów i plikiem w całości już zaimportowanym), widok z kursorem pozycji i obciętą listą
// wpisów księgi, propozycje (z kandydatem „gospodarstwo” z komunikacji strukturalnej), dopasowanie,
// cofnięcie i ponowne dopasowanie, dopasowanie wsadowe i zbiorcze, wpłata z pozycji, zwrot dopasowany
// do ujemnej pozycji, zatwierdzenie (cztery oczy) i porzucenie, raport KR w trzech formatach, granice
// ról (401, 403 dla przedstawiciela klasy, Komisji Rewizyjnej i braku MFA), błędy 400/404/409/413/415/
// 422/503 oraz zamknięty rok osiągnięty trasami year-close (bez obchodzenia triggerów).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handlePgRequest } from '../src/pg/app.js';
import { appendNote } from '../src/pg/audit-reviews.js';
import { CHECKLIST_ITEMS } from '../src/pg/routes/year-close.js';
import { OPENAPI_PATH } from '../scripts/build-openapi.js';
import { ROUTE_SCHEMAS } from '../src/pg/schemas/index.js';
import { createContractClient } from './helpers/contract-client.js';
import { OTHER_IBAN, RADA_IBAN, camtFile, codaFile } from './helpers/bank-statements.js';
import { createTestDb, request, seedEnrolledHousehold, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const spec = JSON.parse(await readFile(OPENAPI_PATH, 'utf8'));
const components = spec.components.schemas;

const MODULE = 'reconciliation';
const YEAR = 'y-2026';
const NEXT = 'y-2027';
const MISSING_YEAR = 'y-2099';
const BANK_CONFIG = { BANK_TRANSACTION_HASH_KEY: 'test-only-hmac-key-synthetic-0123456789', RECONCILIATION_BANK_ACCOUNT_IBAN: RADA_IBAN };

let counter = 0;
const key = (prefix) => `${prefix}-${String(++counter).padStart(6, '0')}-synthetic`;

function newClient(env) {
  return createContractClient({ spec, fetch: (req) => handlePgRequest(req, env) });
}

// Każda odpowiedź sukcesu opisana w schematach modułu (i każdy format raportu) została zwalidowana
// na prawdziwej odpowiedzi.
function assertSuccessCoverage(client) {
  const expected = [];
  for (const [routeId, entry] of ROUTE_SCHEMAS) {
    if (entry.module !== MODULE) continue;
    for (const [status, response] of Object.entries(entry.responses)) {
      expected.push(`${routeId} ${status}`);
      for (const type of Object.keys(response.content ?? {})) expected.push(`${routeId} ${status} ${type}`);
    }
  }
  assert.ok(expected.length >= 23, `oczekiwane odpowiedzi: ${expected.length}`);
  assert.deepEqual(expected.filter((item) => !client.validated.has(item)), [], 'odpowiedzi sukcesu opisane w schematach bez walidacji na prawdziwej odpowiedzi');
}

// Pominięcie każdego wymaganego pola ciała daje błąd i w schemacie, i na serwerze (400).
async function assertRequiredFieldsEnforced(client, cookie, path, validBody, requiredFields, { keyed = true } = {}) {
  assert.ok(requiredFields.length > 0, 'schemat ma wymagane pola');
  for (const field of requiredFields) {
    const { [field]: omitted, ...body } = validBody;
    assert.notEqual(omitted, undefined, `${field}: ciało testowe ma to pole`);
    const response = await client.call('POST', path, { cookie, body, key: keyed ? key('req') : undefined, expect: 400, invalidRequest: true });
    assert.equal(typeof response.body.error, 'string', `${field}: kod błędu`);
  }
}

async function world() {
  const db = await createTestDb();
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, NEXT, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  for (const householdId of ['h-1', 'h-2']) await seedEnrolledHousehold(db, householdId, [YEAR]);
  const both = (role) => [{ role, schoolYearId: YEAR }, { role, schoolYearId: NEXT }];
  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', mfa: true, roles: both('treasurer') }),
    boardA: await seedUserSession(db, { userId: 'u-board-a', mfa: true, roles: both('board') }),
    boardB: await seedUserSession(db, { userId: 'u-board-b', mfa: true, roles: both('board') }),
    // Przydział bez roku: rok spoza przydziałów (404 nieistniejącego roku) i zapisy w zamkniętym roku.
    boardGlobal: await seedUserSession(db, { userId: 'u-board-global', mfa: true, roles: [{ role: 'board' }] }),
    boardNoMfa: await seedUserSession(db, { userId: 'u-board-nomfa', mfa: false, roles: [{ role: 'board', schoolYearId: YEAR }] }),
    audit: await seedUserSession(db, { userId: 'u-audit', mfa: true, roles: [{ role: 'audit', schoolYearId: YEAR }] }),
    auditNoMfa: await seedUserSession(db, { userId: 'u-audit-nomfa', mfa: false, roles: [{ role: 'audit', schoolYearId: YEAR }] }),
    rep: await seedUserSession(db, { userId: 'u-rep', mfa: true, roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }] }),
  };
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES
    ('cat-dues', $1, 'income', 'Składki dobrowolne', 'u-treasurer'),
    ('cat-trips', $1, 'expense', 'Wycieczki', 'u-treasurer'),
    ('cat-equip', $1, 'expense', 'Wyposażenie', 'u-treasurer')`, [YEAR]);
  const entry = (id, direction, cents, category, date, method = 'bank', resolutionReference = null) => db.query(
    `INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on,
       method, resolution_reference, created_by, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'u-treasurer', $10)`,
    [id, YEAR, direction, cents, category, `Wpis syntetyczny ${id}`, date, method, resolutionReference, `seed-entry-${id}`]);
  await entry('le-in', 'income', 45000, 'cat-dues', '2026-09-11');
  await entry('le-cash', 'income', 3000, 'cat-dues', '2026-09-12', 'cash');
  // Wydatek ponad próg 3000 EUR z numerem uchwały, której nie ma w systemie (raport: `flagged`).
  await entry('le-big', 'expense', 350000, 'cat-equip', '2026-09-15', 'bank', 'U-1/2026');
  await entry('le-fix', 'expense', 10000, 'cat-equip', '2026-09-16');
  await entry('le-swap', 'expense', 8000, 'cat-trips', '2026-09-17');
  await entry('le-out', 'expense', 20000, 'cat-trips', '2026-09-21');
  await db.query(`INSERT INTO events (id, school_year_id, title, begins_at, visibility, created_by)
    VALUES ('ev-fair', $1, 'Kiermasz syntetyczny', '2026-10-10T10:00:00Z', 'internal', 'u-board-a')`, [YEAR]);
  const env = { db, ...BANK_CONFIG };
  return { db, env, cookies, client: newClient(env) };
}

// Zamknięcie roku przez trasy zamknięcia (lista kontrolna, druga osoba zarządu) — bez obchodzenia triggerów.
async function closeYear(env, cookies) {
  const call = async (path, cookie, body) => {
    const response = await handlePgRequest(request(path, { method: 'POST', cookie, body }), env);
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await call(`/api/year-close/${YEAR}/start`, cookies.boardA, { nextSchoolYearId: NEXT })).status, 201);
  for (const item of CHECKLIST_ITEMS) {
    assert.equal((await call(`/api/year-close/${YEAR}/checklist/${item}`, cookies.boardA, { note: `Potwierdzenie ${item}` })).status, 201);
  }
  const closed = await call(`/api/year-close/${YEAR}/close`, cookies.boardB, {});
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
}

test('specyfikacja: zapis bez klucza idempotencji opisuje oba nagłówki Idempotency-Replayed, zapis z kluczem — jeden na status', () => {
  const header = (path, status) => spec.paths[path].post.responses[status].headers['Idempotency-Replayed'].schema.enum;
  for (const path of [
    '/api/reconciliations/{reconciliationId}/confirm', '/api/reconciliations/{reconciliationId}/abandon',
    '/api/reconciliations/{reconciliationId}/matches/{matchId}/revocation',
    '/api/reconciliations/{reconciliationId}/group-matches/{groupMatchId}/revocation',
  ]) {
    assert.deepEqual(header(path, '200'), ['false', 'true'], path);
    assert.equal(spec.paths[path].post.parameters.some((p) => p.name === 'Idempotency-Key'), false, path);
  }
  assert.deepEqual(header('/api/reconciliations/{reconciliationId}/matches', '201'), ['false']);
  assert.deepEqual(header('/api/reconciliations/{reconciliationId}/matches', '200'), ['true']);
  // Plik w całości już zaimportowany: 200 bez nowej paczki i bez odtworzenia (`false`).
  assert.deepEqual(header('/api/reconciliations/{reconciliationId}/lines', '200'), ['false', 'true']);
  assert.deepEqual(Object.keys(spec.paths['/api/reports/audit'].get.responses['200'].content).sort(), [
    'application/json', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/html; charset=utf-8',
  ]);
});

test('klient kontraktu: nagłówek Idempotency-Replayed spoza specyfikacji jest błędem (kontrola pozytywna)', async () => {
  const fake = createContractClient({
    spec,
    fetch: async () => new Response(JSON.stringify({ match: {} }), {
      status: 200, headers: { 'Content-Type': 'application/json', 'Idempotency-Replayed': 'maybe' },
    }),
  });
  await assert.rejects(
    fake.call('POST', '/api/reconciliations/r-1/matches/m-1/revocation', { body: { reason: 'Pomyłka syntetyczna' }, expect: 200 }),
    /Idempotency-Replayed „maybe” niezgodny/,
  );
});

test('kontrakt uzgodnień wyciągów i raportu KR: prawdziwe odpowiedzi zgodne ze schematami', async () => {
  const { db, env, cookies, client } = await world();
  const T = cookies.treasurer;
  const A = cookies.boardA;
  const B = cookies.boardB;
  const G = cookies.boardGlobal;
  try {
    // ---------- Dane księgi i wpłat (moduły ledger, ledger-cash, payments — też przez schematy) ----------
    await client.call('POST', '/api/ledger/opening-balance', {
      cookie: A, key: key('ob'), expect: 201, body: { schoolYearId: YEAR, bankCents: 100000, cashCents: 5000, note: 'Bilans otwarcia syntetyczny' },
    });
    await client.call('POST', '/api/ledger/opening-balance/adjustments', {
      cookie: A, key: key('oba'), expect: 201, body: { schoolYearId: YEAR, amountCents: 1000, reason: 'Korekta bilansu syntetyczna' },
    });
    await client.call('POST', '/api/ledger/le-fix/corrections', { cookie: T, key: key('lc'), expect: 201, body: { amountCents: 2000, reason: 'Korekta syntetyczna kwoty' } });
    await client.call('POST', '/api/ledger/le-swap/replacement', {
      cookie: T, key: key('rpl'), expect: 201,
      body: {
        schoolYearId: YEAR, direction: 'expense', amountCents: 8000, categoryId: 'cat-equip', description: 'Wpis zastępczy syntetyczny',
        occurredOn: '2026-09-17', method: 'bank', reason: 'Błędna kategoria',
      },
    });
    await client.call('POST', '/api/ledger/le-in/allocations', { cookie: T, key: key('alloc'), expect: 201, body: { items: [{ eventId: 'ev-fair', amountCents: 45000 }] } });
    const pay = async (householdId, amountCents, receivedOn, reference, method = 'bank') => (await client.call('POST', '/api/payments', {
      cookie: T, key: key('pay'), expect: 201, body: { schoolYearId: YEAR, householdId, amountCents, receivedOn, method, reference },
    })).body.payment.id;
    const p1 = await pay('h-1', 5000, '2026-09-24', 'Wpłata syntetyczna 1');
    const p2 = await pay('h-1', 3000, '2026-09-25', 'Wpłata syntetyczna 2');
    const p3 = await pay('h-2', 4000, '2026-09-25', 'Wpłata syntetyczna 3');
    const p4 = await pay('h-2', 1200, '2026-09-20', 'Wpłata syntetyczna 4');
    const p5 = await pay('h-1', 6000, '2026-09-23', 'Wpłata syntetyczna 5');
    const pCash = await pay('h-2', 6000, '2026-09-23', 'Gotówka syntetyczna', 'cash');
    const refundId = (await client.call(`POST`, `/api/payments/${p4}/refunds`, {
      cookie: T, key: key('ref'), expect: 201, body: { amountCents: 1200, refundedOn: '2026-09-27', method: 'bank', reason: 'Zwrot syntetyczny' },
    })).body.refund.id;
    const reference = (await client.call('POST', '/api/payment-references', {
      cookie: T, key: key('ogm'), expect: 201, body: { schoolYearId: YEAR, householdId: 'h-1' },
    })).body.paymentReference.structuredReference;
    const ogm = `+++${reference.slice(0, 3)}/${reference.slice(3, 7)}/${reference.slice(7)}+++`;

    // ---------- Utworzenie uzgodnienia: zapis, ponowienie, konflikt klucza, błędy ----------
    const createBody = { schoolYearId: YEAR, statementDate: '2026-09-30', statementBalanceCents: 50000, notes: 'Wyciąg wrześniowy (syntetyczny)' };
    const createKey = key('rec');
    const created = await client.call('POST', '/api/reconciliations', { cookie: T, body: createBody, key: createKey, expect: 201 });
    assert.equal(created.headers.get('Idempotency-Replayed'), 'false');
    const R1 = created.body.reconciliation.id;
    assert.deepEqual([created.body.reconciliation.status, created.body.reconciliation.confirmedBy, created.body.reconciliation.createdBy], ['draft', null, 'u-treasurer']);
    const createdReplay = await client.call('POST', '/api/reconciliations', { cookie: T, body: createBody, key: createKey, expect: 200 });
    assert.equal(createdReplay.headers.get('Idempotency-Replayed'), 'true');
    assert.equal(createdReplay.body.reconciliation.id, R1);
    assert.equal((await client.call('POST', '/api/reconciliations', { cookie: T, body: { ...createBody, statementBalanceCents: 1 }, key: createKey, expect: 409 })).body.error, 'idempotency_conflict');
    assert.equal((await client.call('POST', '/api/reconciliations', { cookie: T, body: { ...createBody, statementDate: '2027-09-01' }, key: key('rec'), expect: 400 })).body.error, 'statement_date_outside_school_year');
    assert.equal((await client.call('POST', '/api/reconciliations', { cookie: T, body: { ...createBody, notes: 'ab' }, key: key('rec'), expect: 400, invalidRequest: true })).body.error, 'invalid_notes');
    assert.equal((await client.call('POST', '/api/reconciliations', { cookie: T, body: { ...createBody, statementDate: '2026-02-30' }, key: key('rec'), expect: 400, invalidRequest: true })).body.error, 'invalid_request');
    assert.equal((await client.call('POST', '/api/reconciliations', { cookie: T, body: { ...createBody, notes: 'Kontakt: rodzic@example.invalid' }, key: key('rec'), expect: 422 })).body.error, 'personal_data_forbidden');
    assert.equal((await client.call('POST', '/api/reconciliations', { cookie: T, body: { ...createBody, notes: 'x'.repeat(17000) }, key: key('rec'), expect: 413, invalidRequest: true })).body.error, 'request_too_large');
    assert.equal((await client.call('POST', '/api/reconciliations', { cookie: T, body: 'schoolYearId=y', key: key('rec'), expect: 415, invalidRequest: true })).body.error, 'invalid_content_type');
    assert.equal((await client.call('POST', '/api/reconciliations', { cookie: T, body: createBody, key: 'krotki', expect: 400, invalidRequest: true })).body.error, 'invalid_idempotency_key');
    await assertRequiredFieldsEnforced(client, T, '/api/reconciliations', createBody, components.ReconciliationCreateRequest.required);

    // ---------- Import pozycji: lista JSON z ponowieniem, CSV z możliwym duplikatem ----------
    const linesBody = {
      lines: [
        { bookedOn: '2026-09-11', amountCents: 45000, reference: 'Składka syntetyczna wrzesień' },
        { bookedOn: '2026-09-21', amountCents: -20000, reference: 'Autokar syntetyczny' },
        { bookedOn: '2026-09-24', amountCents: 5000, reference: 'Wpłata syntetyczna 1' },
        { bookedOn: '2026-09-25', amountCents: 7000, reference: 'Przelew zbiorczy syntetyczny' },
        { bookedOn: '2026-09-26', amountCents: 2500, reference: ogm },
        { bookedOn: '2026-09-27', amountCents: -1200, reference: 'Zwrot syntetyczny' },
        { bookedOn: '2026-09-23', amountCents: 6000, reference: 'Wpłata syntetyczna 5' },
      ],
    };
    const linesKey = key('imp');
    const imported = await client.call('POST', `/api/reconciliations/${R1}/lines`, { cookie: T, body: linesBody, key: linesKey, expect: 201 });
    assert.deepEqual([imported.body.import.source, imported.body.import.lineCount, imported.body.possibleDuplicateCount], ['manual', 7, 0]);
    const importedReplay = await client.call('POST', `/api/reconciliations/${R1}/lines`, { cookie: T, body: linesBody, key: linesKey, expect: 200 });
    assert.equal(importedReplay.headers.get('Idempotency-Replayed'), 'true');
    assert.deepEqual(importedReplay.body, { import: imported.body.import });
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/lines`, { cookie: T, body: { lines: linesBody.lines.slice(1) }, key: linesKey, expect: 409 })).body.error, 'idempotency_conflict');
    const csv = await client.call('POST', `/api/reconciliations/${R1}/lines`, {
      cookie: T, key: key('imp'), expect: 201,
      body: { csv: 'data;kwota;tytuł\n11.09.2026;450,00;Składka syntetyczna wrzesień\n31.08.2026;1,00;Opłata syntetyczna\n' },
    });
    assert.deepEqual([csv.body.import.source, csv.body.import.lineCount, csv.body.possibleDuplicateCount], ['csv', 2, 1]);

    // ---------- Widok: kursor pozycji (strony po 3), bez treści tytułów ----------
    const pages = [];
    let path = `/api/reconciliations/${R1}?limit=3`;
    for (let page = 0; page < 5 && path; page += 1) {
      const view = await client.call('GET', path, { cookie: T, expect: 200 });
      pages.push(view.body);
      path = view.body.nextCursor ? `/api/reconciliations/${R1}?limit=3&cursor=${view.body.nextCursor}` : null;
    }
    assert.deepEqual(pages.map((page) => page.lines.length), [3, 3, 3]);
    assert.equal(pages.at(-1).nextCursor, null);
    const allLines = pages.flatMap((page) => page.lines);
    assert.equal(new Set(allLines.map((line) => line.id)).size, 9);
    assert.deepEqual(pages[0].summary, {
      lineCount: 9, matchedLineCount: 0, unmatchedLineCount: 9, unmatchedLineTotalCents: 89400,
      inconsistentMatchCount: 0, groupMatchedLineCount: 0, inconsistentGroupMatchCount: 0,
    });
    assert.equal(pages[0].unmatchedLedgerEntriesTruncated, false);
    for (const title of [...linesBody.lines.map((item) => item.reference), reference]) {
      assert.equal(JSON.stringify(pages).includes(title), false, `odpowiedź nie zawiera tytułu przelewu: ${title}`);
    }
    const line = (amountCents, source = 'manual') => allLines.find((item) => item.amountCents === amountCents && item.source === source).id;
    const [L1, L2, L3, L4, L5, L6, L7] = [45000, -20000, 5000, 7000, 2500, -1200, 6000].map((amount) => line(amount));
    const [L8, L9] = [line(45000, 'csv'), line(100, 'csv')];
    assert.equal((await client.call('GET', `/api/reconciliations/${R1}?cursor=@@@`, { cookie: T, expect: 400, invalidRequest: true })).body.error, 'invalid_cursor');
    assert.equal((await client.call('GET', `/api/reconciliations/${R1}?limit=0`, { cookie: T, expect: 400, invalidRequest: true })).body.error, 'invalid_limit');
    assert.equal((await client.call('GET', `/api/reconciliations/${R1}?limit=501`, { cookie: T, expect: 400, invalidRequest: true })).body.error, 'invalid_limit');

    // ---------- Propozycje: wpłata z tym samym tytułem, wpis księgi, gospodarstwo z komunikacji strukturalnej ----------
    const suggestions = await client.call('GET', `/api/reconciliations/${R1}/suggestions?windowDays=7`, { cookie: T, expect: 200 });
    const forLine = (lineId) => suggestions.body.suggestions.find((item) => item.statementLineId === lineId).candidates;
    assert.deepEqual(forLine(L1).map((candidate) => [candidate.type, candidate.id]), [['ledger_entry', 'le-in']]);
    assert.deepEqual(forLine(L7).map((candidate) => [candidate.type, candidate.id, candidate.referenceMatch]), [['payment_entry', p5, true]]);
    assert.deepEqual(forLine(L5).map((candidate) => [candidate.type, candidate.householdId, candidate.date]), [['household', 'h-1', null]]);
    assert.equal((await client.call('GET', `/api/reconciliations/${R1}/suggestions`, { cookie: T, expect: 200 })).body.windowDays, 7);
    assert.equal((await client.call('GET', `/api/reconciliations/${R1}/suggestions?windowDays=40`, { cookie: T, expect: 400, invalidRequest: true })).body.error, 'invalid_window');

    // ---------- Dopasowanie 1:1: zapis, ponowienie, konflikt, cofnięcie i ponowne dopasowanie ----------
    const matchBody = { statementLineId: L1, ledgerEntryId: 'le-in' };
    const matchKey = key('m');
    const matched = await client.call('POST', `/api/reconciliations/${R1}/matches`, { cookie: T, body: matchBody, key: matchKey, expect: 201 });
    assert.deepEqual([matched.body.match.ledgerEntryId, matched.body.match.paymentEntryId, matched.body.match.revokedAt], ['le-in', null, null]);
    assert.equal('paymentRefundId' in matched.body.match, false);
    const matchedReplay = await client.call('POST', `/api/reconciliations/${R1}/matches`, { cookie: T, body: matchBody, key: matchKey, expect: 200 });
    assert.equal(matchedReplay.body.match.id, matched.body.match.id);
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/matches`, { cookie: T, body: { ...matchBody, statementLineId: L8 }, key: matchKey, expect: 409 })).body.error, 'idempotency_conflict');
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/matches`, { cookie: T, body: { statementLineId: L1, paymentEntryId: p5 }, key: key('m'), expect: 409 })).body.error, 'already_matched');
    const revokeBody = { reason: 'Pomyłka syntetyczna' };
    const revoked = await client.call('POST', `/api/reconciliations/${R1}/matches/${matched.body.match.id}/revocation`, { cookie: T, body: revokeBody, expect: 200 });
    assert.equal(revoked.headers.get('Idempotency-Replayed'), 'false');
    assert.deepEqual([revoked.body.match.revokedBy, revoked.body.match.revokeReason], ['u-treasurer', revokeBody.reason]);
    const revokedAgain = await client.call('POST', `/api/reconciliations/${R1}/matches/${matched.body.match.id}/revocation`, { cookie: T, body: revokeBody, expect: 200 });
    assert.equal(revokedAgain.headers.get('Idempotency-Replayed'), 'true');
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/matches/${matched.body.match.id}/revocation`, { cookie: A, body: revokeBody, expect: 409 })).body.error, 'match_already_revoked');
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/matches/nie-ma/revocation`, { cookie: T, body: revokeBody, expect: 404 })).body.error, 'match_not_found');
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/matches/${matched.body.match.id}/revocation`, { cookie: T, body: { reason: 'ab' }, expect: 400, invalidRequest: true })).body.error, 'invalid_reason');
    await assertRequiredFieldsEnforced(client, T, `/api/reconciliations/${R1}/matches/nie-ma/revocation`, revokeBody, components.ReconciliationRevocationRequest.required, { keyed: false });
    await client.call('POST', `/api/reconciliations/${R1}/matches`, { cookie: T, body: matchBody, key: key('m'), expect: 201 });
    await client.call('POST', `/api/reconciliations/${R1}/matches`, { cookie: T, body: { statementLineId: L2, ledgerEntryId: 'le-out' }, key: key('m'), expect: 201 });
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/matches`, { cookie: T, body: { statementLineId: L7, paymentEntryId: p1 }, key: key('m'), expect: 409 })).body.error, 'match_amount_mismatch');
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/matches`, { cookie: T, body: { statementLineId: L7, paymentEntryId: pCash }, key: key('m'), expect: 409 })).body.error, 'match_method_mismatch');
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/matches`, { cookie: T, body: { statementLineId: L7, paymentEntryId: p5, ledgerEntryId: 'le-in' }, key: key('m'), expect: 400 })).body.error, 'invalid_request');
    await assertRequiredFieldsEnforced(client, T, `/api/reconciliations/${R1}/matches`, { statementLineId: L7, paymentEntryId: p5 }, components.ReconciliationMatchRequest.required);

    // ---------- Zwrot dopasowany do ujemnej pozycji (#138) ----------
    const refundMatch = await client.call('POST', `/api/reconciliations/${R1}/matches`, { cookie: T, body: { statementLineId: L6, paymentRefundId: refundId }, key: key('m'), expect: 201 });
    assert.deepEqual([refundMatch.body.match.paymentRefundId, refundMatch.body.match.paymentEntryId, refundMatch.body.match.ledgerEntryId], [refundId, null, null]);

    // ---------- Dopasowanie wsadowe: wszystko albo nic ----------
    const batchBody = { matches: [{ statementLineId: L3, paymentEntryId: p1 }] };
    const batchKey = key('bm');
    const batch = await client.call('POST', `/api/reconciliations/${R1}/matches/batch`, { cookie: T, body: batchBody, key: batchKey, expect: 201 });
    assert.deepEqual(batch.body.matches.map((item) => [item.statementLineId, item.paymentEntryId]), [[L3, p1]]);
    const batchReplay = await client.call('POST', `/api/reconciliations/${R1}/matches/batch`, { cookie: T, body: batchBody, key: batchKey, expect: 200 });
    assert.deepEqual(batchReplay.body, batch.body);
    const rejected = await client.call('POST', `/api/reconciliations/${R1}/matches/batch`, {
      cookie: T, key: key('bm'), expect: 409, body: { matches: [{ statementLineId: 'nie-ma-pozycji', paymentEntryId: p5 }, { statementLineId: L1, paymentEntryId: p2 }] },
    });
    assert.equal(rejected.body.error, 'match_batch_rejected');
    assert.deepEqual(rejected.body.failures.map((item) => item.error).sort(), ['already_matched', 'statement_line_not_found']);
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/matches/batch`, { cookie: T, body: { matches: [] }, key: key('bm'), expect: 400, invalidRequest: true })).body.error, 'match_batch_empty');
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/matches/batch`, { cookie: T, body: { matches: [batchBody.matches[0], batchBody.matches[0]] }, key: key('bm'), expect: 400 })).body.error, 'match_batch_duplicate');
    const tooMany = Array.from({ length: 51 }, (_, index) => ({ statementLineId: `pozycja-${index}`, paymentEntryId: `wplata-${index}` }));
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/matches/batch`, { cookie: T, body: { matches: tooMany }, key: key('bm'), expect: 400, invalidRequest: true })).body.error, 'match_batch_too_large');
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/matches/batch`, { cookie: T, body: { matches: [{ ...batchBody.matches[0], extra: 1 }] }, key: key('bm'), expect: 400, invalidRequest: true })).body.error, 'invalid_request');
    await assertRequiredFieldsEnforced(client, T, `/api/reconciliations/${R1}/matches/batch`, batchBody, components.ReconciliationMatchBatchRequest.required);

    // ---------- Dopasowanie zbiorcze: zapis, ponowienie, cofnięcie z ponowieniem, ponowne dopasowanie ----------
    const groupBody = { statementLineId: L4, items: [{ paymentEntryId: p2 }, { paymentEntryId: p3 }] };
    const groupKey = key('gm');
    const group = await client.call('POST', `/api/reconciliations/${R1}/group-matches`, { cookie: T, body: groupBody, key: groupKey, expect: 201 });
    assert.deepEqual(group.body.groupMatch.items.map((item) => item.amountCents).sort(), [3000, 4000]);
    const groupReplay = await client.call('POST', `/api/reconciliations/${R1}/group-matches`, { cookie: T, body: groupBody, key: groupKey, expect: 200 });
    assert.equal(groupReplay.body.groupMatch.id, group.body.groupMatch.id);
    const groupRevocation = `/api/reconciliations/${R1}/group-matches/${group.body.groupMatch.id}/revocation`;
    const groupRevoked = await client.call('POST', groupRevocation, { cookie: T, body: revokeBody, expect: 200 });
    assert.deepEqual([groupRevoked.headers.get('Idempotency-Replayed'), groupRevoked.body.groupMatch.revokeReason], ['false', revokeBody.reason]);
    assert.equal((await client.call('POST', groupRevocation, { cookie: T, body: revokeBody, expect: 200 })).headers.get('Idempotency-Replayed'), 'true');
    assert.equal((await client.call('POST', groupRevocation, { cookie: A, body: revokeBody, expect: 409 })).body.error, 'match_already_revoked');
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/group-matches/nie-ma/revocation`, { cookie: T, body: revokeBody, expect: 404 })).body.error, 'match_not_found');
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/group-matches`, { cookie: T, body: { ...groupBody, statementLineId: L7 }, key: key('gm'), expect: 409 })).body.error, 'group_match_sum_mismatch');
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/group-matches`, { cookie: T, body: { ...groupBody, statementLineId: L2 }, key: key('gm'), expect: 409 })).body.error, 'already_matched');
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/group-matches`, { cookie: T, body: { ...groupBody, items: [{ paymentEntryId: p2 }, { paymentEntryId: 'nie-ma-wplaty' }] }, key: key('gm'), expect: 400 })).body.error, 'invalid_match_target');
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/group-matches`, { cookie: T, body: { ...groupBody, statementLineId: 'nie-ma-pozycji' }, key: key('gm'), expect: 400 })).body.error, 'invalid_statement_line');
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/group-matches`, { cookie: T, body: { ...groupBody, items: [{ paymentEntryId: p2 }] }, key: key('gm'), expect: 400, invalidRequest: true })).body.error, 'invalid_request');
    await assertRequiredFieldsEnforced(client, T, `/api/reconciliations/${R1}/group-matches`, groupBody, components.ReconciliationGroupMatchRequest.required);
    await client.call('POST', `/api/reconciliations/${R1}/group-matches`, { cookie: T, body: groupBody, key: key('gm'), expect: 201 });

    // ---------- Wpłata z pozycji wyciągu (gospodarstwo z propozycji i wpłata nieprzypisana) ----------
    const linePaymentKey = key('lp');
    const linePayment = await client.call('POST', `/api/reconciliations/${R1}/lines/${L5}/payment`, { cookie: T, body: { householdId: 'h-1' }, key: linePaymentKey, expect: 201 });
    assert.deepEqual([linePayment.body.payment.amountCents, linePayment.body.payment.receivedOn, linePayment.body.payment.status], [2500, '2026-09-26', 'recorded']);
    const linePaymentReplay = await client.call('POST', `/api/reconciliations/${R1}/lines/${L5}/payment`, { cookie: T, body: { householdId: 'h-1' }, key: linePaymentKey, expect: 200 });
    assert.deepEqual(linePaymentReplay.body, linePayment.body);
    const unassigned = await client.call('POST', `/api/reconciliations/${R1}/lines/${L8}/payment`, { cookie: T, body: {}, key: key('lp'), expect: 201 });
    assert.deepEqual([unassigned.body.payment.householdId, unassigned.body.payment.status], [null, 'unmatched']);
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/lines/${L2}/payment`, { cookie: T, body: {}, key: key('lp'), expect: 400 })).body.error, 'statement_line_not_income');
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/lines/${L1}/payment`, { cookie: T, body: {}, key: key('lp'), expect: 409 })).body.error, 'already_matched');
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/lines/nie-ma/payment`, { cookie: T, body: {}, key: key('lp'), expect: 404 })).body.error, 'statement_line_not_found');
    // Pozycja sprzed początku roku (31.08) jest dozwolona w wyciągu, wpłata z tą datą — nie (#169).
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/lines/${L9}/payment`, { cookie: T, body: {}, key: key('lp'), expect: 422 })).body.error, 'date_outside_school_year');

    const detail = await client.call('GET', `/api/reconciliations/${R1}`, { cookie: T, expect: 200 });
    assert.deepEqual(detail.body.summary, {
      lineCount: 9, matchedLineCount: 7, unmatchedLineCount: 2, unmatchedLineTotalCents: 6100,
      inconsistentMatchCount: 0, groupMatchedLineCount: 1, inconsistentGroupMatchCount: 0,
    });
    assert.equal(detail.body.lines.find((item) => item.id === L6).match.paymentRefundId, refundId);
    assert.deepEqual(detail.body.lines.find((item) => item.id === L4).groupMatch.itemCount, 2);
    assert.deepEqual(detail.body.groupMatches.map((item) => item.revokedAt === null), [false, true]);

    // ---------- Zatwierdzenie: cztery oczy, różnica z wyjaśnieniem, ponowienie; zapis po zatwierdzeniu ----------
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/confirm`, { cookie: T, body: {}, expect: 403 })).body.error, 'four_eyes_required');
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/confirm`, { cookie: A, body: {}, expect: 400 })).body.error, 'difference_requires_note');
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/confirm`, { cookie: A, body: { confirmationNote: 'ab' }, expect: 400, invalidRequest: true })).body.error, 'invalid_confirmation_note');
    const confirmBody = { confirmationNote: 'Różnica wyjaśniona (syntetyczne)' };
    const confirmed = await client.call('POST', `/api/reconciliations/${R1}/confirm`, { cookie: A, body: confirmBody, expect: 200 });
    assert.deepEqual([confirmed.headers.get('Idempotency-Replayed'), confirmed.body.reconciliation.status, confirmed.body.reconciliation.confirmedBy], ['false', 'confirmed', 'u-board-a']);
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/confirm`, { cookie: A, body: confirmBody, expect: 200 })).headers.get('Idempotency-Replayed'), 'true');
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/confirm`, { cookie: B, body: confirmBody, expect: 409 })).body.error, 'reconciliation_confirmed');
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/lines`, { cookie: T, body: { lines: linesBody.lines.slice(0, 1) }, key: key('imp'), expect: 409 })).body.error, 'reconciliation_confirmed');
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/matches`, { cookie: T, body: { statementLineId: L7, paymentEntryId: p5 }, key: key('m'), expect: 409 })).body.error, 'reconciliation_confirmed');
    assert.equal((await client.call('POST', `/api/reconciliations/${R1}/abandon`, { cookie: T, body: revokeBody, expect: 409 })).body.error, 'reconciliation_confirmed');

    // ---------- Porzucenie szkicu z ponowieniem; zapis do porzuconego ----------
    const R2 = (await client.call('POST', '/api/reconciliations', {
      cookie: A, key: key('rec'), expect: 201, body: { schoolYearId: YEAR, statementDate: '2026-10-31', statementBalanceCents: 0, notes: null },
    })).body.reconciliation.id;
    assert.equal((await client.call('POST', `/api/reconciliations/${R2}/lines`, { cookie: A, body: { lines: [{ bookedOn: '2026-11-05', amountCents: 100 }] }, key: key('imp'), expect: 400 })).body.error, 'statement_line_after_statement_date');
    const abandonBody = { reason: 'Saldo pliku niezgodne (syntetyczne)' };
    const abandoned = await client.call('POST', `/api/reconciliations/${R2}/abandon`, { cookie: A, body: abandonBody, expect: 200 });
    assert.deepEqual([abandoned.headers.get('Idempotency-Replayed'), abandoned.body.reconciliation.status, abandoned.body.reconciliation.abandonedBy], ['false', 'abandoned', 'u-board-a']);
    assert.equal((await client.call('POST', `/api/reconciliations/${R2}/abandon`, { cookie: A, body: abandonBody, expect: 200 })).headers.get('Idempotency-Replayed'), 'true');
    assert.equal((await client.call('POST', `/api/reconciliations/${R2}/abandon`, { cookie: A, body: { reason: 'Inny powód syntetyczny' }, expect: 409 })).body.error, 'reconciliation_abandoned');
    assert.equal((await client.call('POST', `/api/reconciliations/${R2}/lines`, { cookie: A, body: linesBody, key: key('imp'), expect: 409 })).body.error, 'reconciliation_abandoned');
    assert.equal((await client.call('POST', `/api/reconciliations/${R2}/abandon`, { cookie: A, body: { reason: 'Kontakt rodzic@example.invalid' }, expect: 409 })).body.error, 'reconciliation_abandoned');
    await assertRequiredFieldsEnforced(client, A, `/api/reconciliations/${R2}/abandon`, abandonBody, components.ReconciliationAbandonRequest.required, { keyed: false });

    // ---------- Import plików CODA i CAMT.053: ponowienie, duplikaty ruchów, plik już zaimportowany ----------
    const R3 = (await client.call('POST', '/api/reconciliations', {
      cookie: T, key: key('rec'), expect: 201, body: { schoolYearId: YEAR, statementDate: '2026-10-31', statementBalanceCents: 0 },
    })).body.reconciliation.id;
    const october = (movements, extra = {}) => codaFile({
      statementNumber: '010', openingCents: 100000, openingDate: '2026-10-01', closingDate: '2026-10-31', movements, ...extra,
    });
    const m1 = { seq: 1, bankRef: 'SYNTREF00000000000001', cents: 2500, bookedOn: '2026-10-05', communication: 'Składka syntetyczna październik' };
    const m2 = { seq: 2, bankRef: 'SYNTREF00000000000002', cents: -1250, bookedOn: '2026-10-20', communication: 'Opłata syntetyczna' };
    const m3 = { seq: 3, bankRef: 'SYNTREF00000000000003', cents: 4000, bookedOn: '2026-10-22', communication: 'Wpłata syntetyczna październik' };
    const codaBody = { coda: october([m1, m2]) };
    const codaKey = key('coda');
    const coda = await client.call('POST', `/api/reconciliations/${R3}/lines`, { cookie: T, body: codaBody, key: codaKey, expect: 201 });
    assert.deepEqual([coda.body.import.source, coda.body.import.lineCount, coda.body.skippedDuplicateCount], ['coda', 2, 0]);
    assert.deepEqual(coda.body.fileBalances, { statementNumber: '010', openingBalanceCents: 100000, openingDate: '2026-10-01', closingBalanceCents: 101250, closingDate: '2026-10-31' });
    assert.deepEqual(coda.body.warnings, ['statement_balance_differs']);
    const codaReplay = await client.call('POST', `/api/reconciliations/${R3}/lines`, { cookie: T, body: codaBody, key: codaKey, expect: 200 });
    assert.deepEqual(codaReplay.body, { import: coda.body.import, skippedDuplicateCount: 0 });
    const extended = await client.call('POST', `/api/reconciliations/${R3}/lines`, { cookie: T, body: { coda: october([m1, m2, m3]) }, key: key('coda'), expect: 201 });
    assert.deepEqual([extended.body.import.lineCount, extended.body.skippedDuplicateCount], [1, 2]);
    assert.deepEqual(extended.body.skippedDuplicates.map((item) => [item.amountCents, item.reconciliationId]), [[2500, R3], [-1250, R3]]);
    const nothingNew = await client.call('POST', `/api/reconciliations/${R3}/lines`, { cookie: T, body: { coda: october([m1, m3], { closingCents: 106500 }) }, key: key('coda'), expect: 200 });
    assert.deepEqual([nothingNew.headers.get('Idempotency-Replayed'), nothingNew.body.import, nothingNew.body.lineCount, nothingNew.body.skippedDuplicateCount], ['false', null, 0, 2]);
    const R4 = (await client.call('POST', '/api/reconciliations', {
      cookie: T, key: key('rec'), expect: 201, body: { schoolYearId: YEAR, statementDate: '2026-10-31', statementBalanceCents: 103000 },
    })).body.reconciliation.id;
    const again = await client.call('POST', `/api/reconciliations/${R4}/lines`, { cookie: T, body: codaBody, key: key('coda'), expect: 409 });
    assert.deepEqual([again.body.error, again.body.reconciliationId], ['statement_already_imported', R3]);
    const camt = await client.call('POST', `/api/reconciliations/${R4}/lines`, {
      cookie: T, key: key('camt'), expect: 201,
      body: { camt053: camtFile({ sequence: '12', openingCents: 100000, openingDate: '2026-10-01', closingDate: '2026-10-31', movements: [{ ref: 'SYNTCAMT0001', cents: 3000, bookedOn: '2026-10-10', ustrd: 'Składka syntetyczna CAMT' }] }) },
    });
    assert.deepEqual([camt.body.import.source, camt.body.fileBalances.statementNumber, camt.body.warnings], ['camt053', '12', ['opening_balance_discontinuity']]);
    assert.equal((await client.call('POST', `/api/reconciliations/${R4}/lines`, { cookie: T, body: { coda: codaFile({ iban: OTHER_IBAN, movements: [m1] }) }, key: key('coda'), expect: 400 })).body.error, 'statement_account_mismatch');
    assert.equal((await client.call('POST', `/api/reconciliations/${R4}/lines`, { cookie: T, body: { coda: 'to nie jest plik CODA' }, key: key('coda'), expect: 400 })).body.error, 'invalid_statement_file');
    assert.equal((await client.call('POST', `/api/reconciliations/${R4}/lines`, { cookie: T, body: { lines: [], csv: 'a' }, key: key('imp'), expect: 400, invalidRequest: true })).body.error, 'invalid_request');
    assert.equal((await client.call('POST', `/api/reconciliations/${R4}/lines`, { cookie: T, body: { lines: [] }, key: key('imp'), expect: 400, invalidRequest: true })).body.error, 'invalid_line_count');
    assert.equal((await client.call('POST', `/api/reconciliations/${R4}/lines`, { cookie: T, body: { lines: [{ bookedOn: '2026-10-02', amountCents: 0 }] }, key: key('imp'), expect: 400, invalidRequest: true })).body.error, 'invalid_statement_line');
    assert.equal((await client.call('POST', `/api/reconciliations/${R4}/lines`, { cookie: T, body: { csv: 'kolumna;inna\n1;2\n' }, key: key('imp'), expect: 400 })).body.error, 'invalid_csv_header');
    assert.equal((await client.call('POST', `/api/reconciliations/${R4}/lines`, { cookie: T, body: { csv: 'data;kwota,tytul\n02.10.2026;1,00\n' }, key: key('imp'), expect: 400 })).body.error, 'ambiguous_csv_delimiter');
    assert.equal((await client.call('POST', `/api/reconciliations/${R4}/lines`, { cookie: T, body: { csv: 'x'.repeat(270 * 1024) }, key: key('imp'), expect: 413 })).body.error, 'request_too_large');
    assert.equal((await client.call('POST', `/api/reconciliations/${R4}/lines`, { cookie: T, body: 'lines=1', key: key('imp'), expect: 415, invalidRequest: true })).body.error, 'invalid_content_type');
    assert.equal((await client.call('POST', '/api/reconciliations/nie-ma/lines', { cookie: T, body: linesBody, key: key('imp'), expect: 404 })).body.error, 'reconciliation_not_found');
    const unconfigured = newClient({ db });
    assert.equal((await unconfigured.call('POST', `/api/reconciliations/${R4}/lines`, { cookie: T, body: codaBody, key: key('coda'), expect: 503 })).body.error, 'bank_import_not_configured');
    // Aktywne powiązanie blokuje porzucenie szkicu.
    const codaLine = (await client.call('GET', `/api/reconciliations/${R3}`, { cookie: T, expect: 200 })).body.lines.find((item) => item.amountCents === 2500);
    const p6 = await pay('h-2', 2500, '2026-10-05', 'Wpłata syntetyczna 6');
    const codaMatch = await client.call('POST', `/api/reconciliations/${R3}/matches`, { cookie: T, body: { statementLineId: codaLine.id, paymentEntryId: p6 }, key: key('m'), expect: 201 });
    const busy = await client.call('POST', `/api/reconciliations/${R3}/abandon`, { cookie: T, body: abandonBody, expect: 409 });
    assert.deepEqual([busy.body.error, busy.body.activeMatchCount], ['reconciliation_has_active_matches', 1]);

    // Lista wpisów księgi bez powiązania jest obcięta do 1000 (więcej wpisów bankowych do dnia wyciągu).
    await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on,
        method, created_by, idempotency_key)
      SELECT 'le-many-' || n, $1, 'income', 1, 'cat-dues', 'Wpis syntetyczny masowy', '2026-10-02', 'bank', 'u-treasurer', 'seed-many-' || n
        FROM generate_series(1, 1001) AS n`, [YEAR]);
    const truncated = await client.call('GET', `/api/reconciliations/${R4}`, { cookie: T, expect: 200 });
    assert.deepEqual([truncated.body.unmatchedLedgerEntries.length, truncated.body.unmatchedLedgerEntriesTruncated], [1000, true]);
    // Kursor jednego uzgodnienia nie działa dla innego.
    assert.equal((await client.call('GET', `/api/reconciliations/${R4}?cursor=${pages[0].nextCursor}`, { cookie: T, expect: 400 })).body.error, 'invalid_cursor');

    // ---------- Lista uzgodnień i 404 ----------
    const list = await client.call('GET', `/api/reconciliations?schoolYearId=${YEAR}`, { cookie: T, expect: 200 });
    assert.deepEqual(list.body.reconciliations.map((item) => item.status).sort(), ['abandoned', 'confirmed', 'draft', 'draft']);
    assert.equal((await client.call('GET', '/api/reconciliations', { cookie: T, expect: 400, invalidRequest: true })).body.error, 'invalid_request');
    assert.equal((await client.call('GET', '/api/reconciliations/nie-ma', { cookie: T, expect: 404 })).body.error, 'reconciliation_not_found');
    assert.equal((await client.call('GET', '/api/reconciliations/nie-ma/suggestions', { cookie: T, expect: 404 })).body.error, 'reconciliation_not_found');
    assert.equal((await client.call('GET', '/api/reconciliations/zle%20id', { cookie: T, expect: 400 })).body.error, 'invalid_id');

    // ---------- Raport Komisji Rewizyjnej: JSON, XLSX, HTML; ścieżka kontroli ----------
    const question = await appendNote(db, {
      actorId: 'u-audit', schoolYearId: YEAR, kind: 'question', targetType: 'reconciliation', targetId: R1,
      body: 'Pytanie syntetyczne o różnicę', idempotencyKey: key('arn'),
    });
    await appendNote(db, {
      actorId: 'u-treasurer', schoolYearId: YEAR, kind: 'answer', targetType: 'reconciliation', targetId: R1,
      parentId: question.note.id, body: 'Odpowiedź syntetyczna', idempotencyKey: key('arn'),
    });
    await appendNote(db, {
      actorId: 'u-audit', schoolYearId: YEAR, kind: 'conclusion', targetType: 'year', targetId: YEAR,
      body: 'Wniosek syntetyczny', idempotencyKey: key('arn'),
    });
    const report = await client.call('GET', `/api/reports/audit?schoolYearId=${YEAR}`, { cookie: cookies.audit, expect: 200 });
    const body = report.body.report;
    assert.deepEqual([body.reconciliations.confirmedCount, body.reconciliations.draftCount, body.reconciliations.abandonedCount], [1, 2, 1]);
    assert.equal(body.reconciliations.latestConfirmed.id, R1);
    assert.deepEqual(body.checks.items.map((item) => item.id), ['year_end_balance', 'dates_within_school_year', 'payments_in_ledger', 'reconciliation_matches', 'latest_confirmed_reconciliation']);
    assert.deepEqual(body.largeExpenses.map((item) => [item.id, item.flagged]), [['le-big', true]]);
    assert.deepEqual([body.corrections.length, body.reclassifications.length, body.openingAdjustments.length], [2, 1, 1]);
    assert.deepEqual(body.eventResults.events.map((item) => [item.id, item.incomeCents]), [['ev-fair', 45000]]);
    assert.deepEqual([body.reviewNotes.counts, body.reviewNotes.currentConclusion.body], [{ open: 0, answered: 1, closed: 0 }, 'Wniosek syntetyczny']);
    assert.ok(body.evidence.expensesWithoutEvidence.count > 0);
    await client.call('GET', `/api/reports/audit?schoolYearId=${YEAR}&format=xlsx`, { cookie: A, expect: 200 });
    await client.call('GET', `/api/reports/audit?schoolYearId=${YEAR}&format=html`, { cookie: T, expect: 200 });
    await client.call('GET', `/api/reports/audit?schoolYearId=${YEAR}&format=json`, { cookie: T, expect: 200 });
    assert.equal((await client.call('GET', `/api/reports/audit?schoolYearId=${YEAR}&format=pdf`, { cookie: cookies.audit, expect: 400, invalidRequest: true })).body.error, 'invalid_request');
    assert.equal((await client.call('GET', `/api/reports/audit?schoolYearId=${MISSING_YEAR}`, { cookie: G, expect: 404 })).body.error, 'school_year_not_found');
    await client.call('GET', `/api/reports/audit?schoolYearId=${YEAR}`, { expect: 401 });
    assert.equal((await client.call('GET', `/api/reports/audit?schoolYearId=${YEAR}`, { cookie: cookies.rep, expect: 403 })).body.error, 'forbidden');
    assert.equal((await client.call('GET', `/api/reports/audit?schoolYearId=${YEAR}`, { cookie: cookies.boardNoMfa, expect: 403 })).body.error, 'mfa_enrollment_required');
    assert.equal((await client.call('GET', `/api/reports/audit?schoolYearId=${YEAR}`, { cookie: cookies.auditNoMfa, expect: 403 })).body.error, 'mfa_enrollment_required');

    // ---------- Granice ról: brak sesji, przedstawiciel klasy, Komisja Rewizyjna, brak MFA, obcy Origin ----------
    const reads = [`/api/reconciliations?schoolYearId=${YEAR}`, `/api/reconciliations/${R3}`, `/api/reconciliations/${R3}/suggestions`];
    for (const readPath of reads) {
      await client.call('GET', readPath, { expect: 401 });
      assert.equal((await client.call('GET', readPath, { cookie: cookies.rep, expect: 403 })).body.error, 'forbidden', readPath);
      assert.equal((await client.call('GET', readPath, { cookie: cookies.audit, expect: 403 })).body.error, 'forbidden', readPath);
      assert.equal((await client.call('GET', readPath, { cookie: cookies.boardNoMfa, expect: 403 })).body.error, 'mfa_enrollment_required', readPath);
    }
    const codaLineId = codaLine.id;
    const writes = [
      ['/api/reconciliations', { schoolYearId: YEAR, statementDate: '2026-10-31', statementBalanceCents: 0 }, true],
      [`/api/reconciliations/${R3}/lines`, { lines: [{ bookedOn: '2026-10-02', amountCents: 100 }] }, true],
      [`/api/reconciliations/${R3}/lines/${codaLineId}/payment`, {}, true],
      [`/api/reconciliations/${R3}/matches`, { statementLineId: codaLineId, paymentEntryId: p6 }, true],
      [`/api/reconciliations/${R3}/matches/batch`, { matches: [{ statementLineId: codaLineId, paymentEntryId: p6 }] }, true],
      [`/api/reconciliations/${R3}/matches/${codaMatch.body.match.id}/revocation`, revokeBody, false],
      [`/api/reconciliations/${R3}/group-matches`, { statementLineId: codaLineId, items: [{ paymentEntryId: p2 }, { paymentEntryId: p3 }] }, true],
      [`/api/reconciliations/${R3}/group-matches/nie-ma/revocation`, revokeBody, false],
      [`/api/reconciliations/${R3}/confirm`, confirmBody, false],
      [`/api/reconciliations/${R3}/abandon`, abandonBody, false],
    ];
    for (const [writePath, writeBody, keyed] of writes) {
      const withKey = () => (keyed ? key('auth') : undefined);
      await client.call('POST', writePath, { body: writeBody, key: withKey(), expect: 401 });
      assert.equal((await client.call('POST', writePath, { cookie: cookies.rep, body: writeBody, key: withKey(), expect: 403 })).body.error, 'forbidden', writePath);
      assert.equal((await client.call('POST', writePath, { cookie: cookies.audit, body: writeBody, key: withKey(), expect: 403 })).body.error, 'forbidden', writePath);
      assert.equal((await client.call('POST', writePath, { cookie: cookies.boardNoMfa, body: writeBody, key: withKey(), expect: 403 })).body.error, 'mfa_enrollment_required', writePath);
      assert.equal((await client.call('POST', writePath, { cookie: T, body: writeBody, key: withKey(), origin: 'https://obca.example.invalid', expect: 403 })).body.error, 'invalid_origin', writePath);
    }

    // ---------- Zamknięty rok: zamknięcie przez trasy year-close, potem 409 ----------
    // Wolne wpłaty o kwocie pozycji CAMT (3000): bez nich trasy odmówiłyby przed zapisem innym kodem.
    const pA = await pay('h-2', 1000, '2026-10-10', 'Wpłata syntetyczna A');
    const pB = await pay('h-2', 2000, '2026-10-10', 'Wpłata syntetyczna B');
    const pC = await pay('h-1', 3000, '2026-10-10', 'Wpłata syntetyczna C');
    await closeYear(env, cookies);
    const camtLine = (await client.call('GET', `/api/reconciliations/${R4}`, { cookie: G, expect: 200 })).body.lines[0].id;
    const closedWrites = [
      ['/api/reconciliations', { schoolYearId: YEAR, statementDate: '2027-08-31', statementBalanceCents: 0 }, true],
      [`/api/reconciliations/${R4}/lines`, { lines: [{ bookedOn: '2026-10-02', amountCents: 100 }] }, true],
      [`/api/reconciliations/${R4}/lines/${camtLine}/payment`, { householdId: 'h-2' }, true],
      [`/api/reconciliations/${R4}/matches`, { statementLineId: camtLine, paymentEntryId: pC }, true],
      [`/api/reconciliations/${R4}/matches/batch`, { matches: [{ statementLineId: camtLine, paymentEntryId: pC }] }, true],
      [`/api/reconciliations/${R4}/group-matches`, { statementLineId: camtLine, items: [{ paymentEntryId: pA }, { paymentEntryId: pB }] }, true],
      [`/api/reconciliations/${R3}/matches/${codaMatch.body.match.id}/revocation`, revokeBody, false],
      [`/api/reconciliations/${R4}/confirm`, confirmBody, false],
      [`/api/reconciliations/${R4}/abandon`, abandonBody, false],
    ];
    for (const [writePath, writeBody, keyed] of closedWrites) {
      const response = await client.call('POST', writePath, { cookie: G, body: writeBody, key: keyed ? key('closed') : undefined, expect: 409 });
      assert.equal(response.body.error, 'school_year_closed', writePath);
    }
    const closedReport = await client.call('GET', `/api/reports/audit?schoolYearId=${YEAR}`, { cookie: G, expect: 200 });
    assert.equal(closedReport.body.report.reconciliations.items.length, 4);

    assertSuccessCoverage(client);
  } finally {
    await db.close();
  }
});
