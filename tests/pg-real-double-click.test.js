// #208: podwójne kliknięcie i równoległe zapisy kluczowych ścieżek na PRAWDZIWYM
// PostgreSQL. PGlite wykonuje transakcje po kolei, więc testy „parallel/double
// click” na nim sprawdzają tylko wynik końcowy (sekwencyjne odtworzenie). Tu
// każde żądanie idzie osobnym połączeniem puli z src/db.js, a przeplot jest
// wymuszany barierą (tests/helpers/pg-barrier.js): pierwsze żądanie zatrzymuje
// się W TRANSAKCJI po zapisie, drugie startuje i test sprawdza w
// pg_stat_activity, że naprawdę czeka na blokadę; dopiero potem pierwsze
// zatwierdza. Transakcje biegną z `retries: 0`, a kody SQLSTATE są liczone,
// więc gałąź „23505 → odtworzenie zapisu” jest sprawdzana wprost.
//
// Kontrole pozytywne (mutacja w teście, `rewrite` bariery): te same przeploty
// bez danej blokady dają zły wynik — test wykrywa jej usunięcie. Tam, gdzie
// ochronę daje kilka warstw (blokada w API i ograniczenie/trigger w bazie),
// test opisuje, która warstwa zostaje.
//
// Plik działa wyłącznie z RD_TEST_PG_URL (npm run test:pg-real); bez niej jest
// pomijany. Wyłącznie dane syntetyczne (@example.invalid). Żaden test nie
// wysyła e-maili: zatwierdzenie kampanii nie woła transportu, kolejka nie jest
// przetwarzana, a środowisko nie ma klucza dostawcy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { guessMapping, parseCsv, toServerPayload, validateRows } from '../import/core.js';
import { createRealTestDb, seedClass, seedEnrolledHousehold, seedSchoolYear, seedUser, seedUserSession, seedPublishedPrivacyNotice } from './helpers/pg.js';
import {
  barrierEnv, callApi, countRows, dropAdvisoryLock, dropForUpdate, settledWithin, waitForLockWaitersWithQuery,
} from './helpers/pg-barrier.js';

const skip = process.env.RD_TEST_PG_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';
const YEAR = 'y-2026';
let seq = 0;
const key = (prefix) => `${prefix}-${String(++seq).padStart(6, '0')}-${crypto.randomUUID().slice(0, 8)}`;
const count = (db, sql, params) => countRows(db, sql, params);
const auditCount = (db, action) => count(db, 'SELECT count(*)::int AS n FROM audit_events WHERE action = $1', [action]);

// B czeka dokładnie w jednym miejscu i jest to blokada z kodu trasy (FOR UPDATE),
// a nie dopiero INSERT na indeksie unikalnym (to dałoby usunięcie blokady).
function assertWaitsOn({ waits, waitingSql }, pattern, message) {
  assert.equal(waits.length, 1, `${message}: ${JSON.stringify(waits)}`);
  assert.match(waitingSql, pattern, `${message} — czekające zapytanie: ${waitingSql}`);
}

async function withReal(fn) {
  const db = await createRealTestDb();
  try { return await fn(db); } finally { await db.close(); }
}

// Uruchamia A z barierą, potem B (i ewentualnie kolejne), sprawdza, że B czeka
// w bazie, wznawia A. Zwraca odpowiedzi, listę wait_event, na które czekano,
// i teksty czekających zapytań (`waitingSql`) — test sprawdza nimi, że B stoi
// na blokadzie z kodu (FOR UPDATE), a nie dopiero na indeksie unikalnym.
async function race(db, { pauseAfter, first, others, rewrite = null, extra = {}, expectWait = true }) {
  const errors = [];
  const gated = barrierEnv(db, { pauseAfter, rewrite, extra, errors });
  const a = first(gated.env);
  await gated.reached;
  const plainEnv = barrierEnv(db, { rewrite, extra, errors }).env;
  const pending = others.map((start) => start(plainEnv));
  let waiters = [];
  let early;
  try {
    if (expectWait) waiters = await waitForLockWaitersWithQuery(db, pending.length);
    else early = await Promise.all(pending.map((p) => settledWithin(p, 1500)));
  } finally { gated.release(); }
  const results = await Promise.all([a, ...pending]);
  return {
    results, early, errors,
    waits: expectWait ? waiters.map((w) => w.event) : undefined,
    waitingSql: waiters.map((w) => w.query).join('\n'),
  };
}

// ---------------------------------------------------------------- wpłaty

async function paymentsSetup(db) {
  await seedSchoolYear(db, YEAR);
  for (const household of ['h1', 'h2']) await seedEnrolledHousehold(db, household, [YEAR]);
  return seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
}
const paymentBody = (patch = {}) => ({
  schoolYearId: YEAR, householdId: 'h1', amountCents: 5000, receivedOn: '2026-10-05', method: 'bank', reference: 'Składka syntetyczna', ...patch,
});

test('#208 (bariera): podwójne kliknięcie zapisu wpłaty — druga transakcja czeka na klucz, dostaje 23505 i odtwarza zapis; ponowienie po utracie odpowiedzi też', { skip }, async () => {
  await withReal(async (db) => {
    const cookie = await paymentsSetup(db);
    const idem = key('pay');
    const { results: [a, b], waits, errors } = await race(db, {
      pauseAfter: /INSERT INTO payment_entries/,
      first: (env) => callApi(env, 'POST', '/api/payments', cookie, paymentBody(), idem),
      others: [(env) => callApi(env, 'POST', '/api/payments', cookie, paymentBody(), idem)],
    });
    assert.deepEqual(waits, ['transactionid'], 'drugie żądanie czeka na niezatwierdzony wiersz z tym samym kluczem');
    assert.deepEqual([a.status, a.replayed], [201, 'false'], JSON.stringify(a.body));
    assert.deepEqual([b.status, b.replayed], [200, 'true'], JSON.stringify(b.body));
    assert.equal(b.body.payment.id, a.body.payment.id);
    assert.deepEqual(errors, ['23505'], 'wykonana gałąź isUniqueError → odtworzenie (payments.js)');
    // Klient nie dostał odpowiedzi po COMMIT i ponawia z tym samym kluczem: odtworzenie, nie 409.
    const retry = await callApi({ db }, 'POST', '/api/payments', cookie, paymentBody(), idem);
    assert.deepEqual([retry.status, retry.replayed, retry.body.payment.id], [200, 'true', a.body.payment.id]);
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM payment_entries'), 1);
    assert.equal(await auditCount(db, 'payment.created'), 1);
  });
});

test('#208 (bariera): ten sam klucz, inna treść w trakcie zapisu — 409 idempotency_conflict przez gałąź 23505, bez drugiego zapisu', { skip }, async () => {
  await withReal(async (db) => {
    const cookie = await paymentsSetup(db);
    const idem = key('pay');
    const { results: [a, b], errors } = await race(db, {
      pauseAfter: /INSERT INTO payment_entries/,
      first: (env) => callApi(env, 'POST', '/api/payments', cookie, paymentBody(), idem),
      others: [(env) => callApi(env, 'POST', '/api/payments', cookie, paymentBody({ amountCents: 7000 }), idem)],
    });
    assert.equal(a.status, 201);
    assert.deepEqual([b.status, b.body.error], [409, 'idempotency_conflict']);
    assert.deepEqual(errors, ['23505']);
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM payment_entries'), 1);
  });
});

test('#208 (bariera): równoległe przypisanie wpłaty „bez rodziny” do dwóch rodzin — drugie czeka na blokadę wpłaty i dostaje 409 payment_already_assigned', { skip }, async () => {
  await withReal(async (db) => {
    const cookie = await paymentsSetup(db);
    const payment = (await callApi({ db }, 'POST', '/api/payments', cookie, paymentBody({ householdId: null }), key('pay'))).body.payment;
    const path = `/api/payments/${payment.id}/assignment`;
    const { results: [a, b], waits, waitingSql, errors } = await race(db, {
      pauseAfter: /INSERT INTO payment_assignments/,
      first: (env) => callApi(env, 'POST', path, cookie, { householdId: 'h1' }, key('asg')),
      others: [(env) => callApi(env, 'POST', path, cookie, { householdId: 'h2' }, key('asg'))],
    });
    assertWaitsOn({ waits, waitingSql }, /FROM payment_entries WHERE id = \$1 FOR UPDATE/, 'drugie przypisanie czeka na blokadę wiersza wpłaty');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.error], [409, 'payment_already_assigned']);
    assert.deepEqual(errors, []);
    const row = (await db.query('SELECT household_id, status FROM payment_entries WHERE id = $1', [payment.id])).rows[0];
    assert.deepEqual(row, { household_id: 'h1', status: 'recorded' });
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM payment_assignments'), 1);
    assert.equal(await auditCount(db, 'payment.assigned'), 1);
  });
});

// Korekty wpłaty mają dwie warstwy blokad: FOR UPDATE w API i trigger
// payment_correction_guard (0002/0039). Bez blokady w API druga korekta
// czekałaby dopiero na INSERT (trigger) — wynik ten sam, ale punkt
// serializacji inny; test sprawdza, że B stoi na blokadzie z API.
test('#208 (bariera): dwie korekty wpłaty 70 + 70 € przy 100 € — druga czeka na blokadę wpłaty w API i dostaje 409', { skip }, async () => {
  await withReal(async (db) => {
    const cookie = await paymentsSetup(db);
    const payment = (await callApi({ db }, 'POST', '/api/payments', cookie, paymentBody({ amountCents: 10000 }), key('pay'))).body.payment;
    const path = `/api/payments/${payment.id}/corrections`;
    const { results: [a, b], waits, waitingSql, errors } = await race(db, {
      pauseAfter: /INSERT INTO payment_corrections/,
      first: (env) => callApi(env, 'POST', path, cookie, { amountCents: 7000, reason: 'Pierwsza korekta syntetyczna' }, key('pc')),
      others: [(env) => callApi(env, 'POST', path, cookie, { amountCents: 7000, reason: 'Druga korekta syntetyczna' }, key('pc'))],
    });
    assertWaitsOn({ waits, waitingSql }, /FROM payment_entries WHERE id = \$1 FOR UPDATE/, 'druga korekta czeka na blokadę wpłaty');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.error], [409, 'correction_exceeds_remaining_amount']);
    assert.deepEqual(errors, []);
    assert.equal(Number((await db.query('SELECT net_amount_cents FROM payment_entry_net WHERE id = $1', [payment.id])).rows[0].net_amount_cents), 3000);
    assert.equal(await auditCount(db, 'payment.correction.created'), 1);
  });
});

// ---------------------------------------------------------------- księga

async function ledgerSetup(db) {
  await seedSchoolYear(db, YEAR);
  await seedEnrolledHousehold(db, 'h1', [YEAR]);
  const cookie = await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
  await db.query("INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES ('cat-in', $1, 'income', 'Składki dobrowolne', 'u-tr')", [YEAR]);
  await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on, method, created_by, idempotency_key)
    VALUES ('le-1', $1, 'income', 10000, 'cat-in', 'Wpis syntetyczny', '2026-10-01', 'bank', 'u-tr', 'le-1-key-0001')`, [YEAR]);
  return cookie;
}
const correctionPath = '/api/ledger/le-1/corrections';

test('#208 (bariera): dwie korekty wpisu księgi 70 + 70 € przy 100 € — druga czeka na blokadę wpisu i dostaje 409', { skip }, async () => {
  await withReal(async (db) => {
    const cookie = await ledgerSetup(db);
    const { results: [a, b], waits, waitingSql, errors } = await race(db, {
      pauseAfter: /INSERT INTO ledger_corrections/,
      first: (env) => callApi(env, 'POST', correctionPath, cookie, { amountCents: 7000, reason: 'Pierwsza korekta syntetyczna' }, key('lc')),
      others: [(env) => callApi(env, 'POST', correctionPath, cookie, { amountCents: 7000, reason: 'Druga korekta syntetyczna' }, key('lc'))],
    });
    assertWaitsOn({ waits, waitingSql }, /FROM ledger_entries WHERE id = \$1 FOR UPDATE/, 'druga korekta czeka na blokadę wpisu');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.error], [409, 'correction_exceeds_remaining_amount']);
    assert.deepEqual(errors, []);
    assert.equal(await count(db, "SELECT count(*)::int AS n FROM ledger_corrections WHERE ledger_entry_id = 'le-1'"), 1);
    assert.equal(await auditCount(db, 'ledger.correction.created'), 1);
  });
});

test('#208 (bariera): podwójne kliknięcie korekty wpisu księgi (ten sam klucz) — jedna korekta, drugie żądanie to odtworzenie', { skip }, async () => {
  await withReal(async (db) => {
    const cookie = await ledgerSetup(db);
    const idem = key('lc');
    const body = { amountCents: 2500, reason: 'Korekta syntetyczna' };
    const { results: [a, b], waits, waitingSql } = await race(db, {
      pauseAfter: /INSERT INTO ledger_corrections/,
      first: (env) => callApi(env, 'POST', correctionPath, cookie, body, idem),
      others: [(env) => callApi(env, 'POST', correctionPath, cookie, body, idem)],
    });
    assertWaitsOn({ waits, waitingSql }, /FROM ledger_entries WHERE id = \$1 FOR UPDATE/, 'drugie żądanie czeka na blokadę z kodu');
    assert.deepEqual([a.status, a.replayed, b.status, b.replayed], [201, 'false', 200, 'true']);
    assert.equal(b.body.correction.id, a.body.correction.id);
    assert.equal(await auditCount(db, 'ledger.correction.created'), 1);
  });
});

test('#208 (bariera): ta sama wpłata ujęta w księdze dwa razy naraz (różne klucze) — jeden wpis, drugi 409 payment_already_linked', { skip }, async () => {
  await withReal(async (db) => {
    const cookie = await ledgerSetup(db);
    const payment = (await callApi({ db }, 'POST', '/api/payments', cookie, paymentBody({ amountCents: 4000 }), key('pay'))).body.payment;
    const entry = {
      schoolYearId: YEAR, direction: 'income', amountCents: 4000, categoryId: 'cat-in', description: 'Wpłata syntetyczna w księdze',
      occurredOn: '2026-10-05', method: 'bank', paymentEntryId: payment.id,
    };
    const { results: [a, b], waits, waitingSql } = await race(db, {
      pauseAfter: /INSERT INTO ledger_entries/,
      first: (env) => callApi(env, 'POST', '/api/ledger', cookie, entry, key('le')),
      others: [(env) => callApi(env, 'POST', '/api/ledger', cookie, entry, key('le'))],
    });
    assertWaitsOn({ waits, waitingSql }, /SELECT id FROM payment_entries WHERE id = \$1 FOR UPDATE/, 'drugie ujęcie czeka na blokadę wpłaty');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(b.status, 409, JSON.stringify(b.body));
    assert.equal(b.body.error, 'payment_already_linked');
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM ledger_entries WHERE payment_entry_id = $1', [payment.id]), 1);
  });
});

// ---------------------------------------------------------------- uzgodnienie

async function reconciliationSetup(db) {
  const cookie = await ledgerSetup(db);
  await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on, method, created_by, idempotency_key)
    VALUES ('le-2', $1, 'income', 10000, 'cat-in', 'Drugi wpis syntetyczny', '2026-10-01', 'bank', 'u-tr', 'le-2-key-0001')`, [YEAR]);
  const created = await callApi({ db }, 'POST', '/api/reconciliations', cookie, { schoolYearId: YEAR, statementDate: '2026-10-31', statementBalanceCents: 0 }, key('rec'));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.reconciliation.id;
  const lines = await callApi({ db }, 'POST', `/api/reconciliations/${id}/lines`, cookie, { lines: [{ bookedOn: '2026-10-01', amountCents: 10000 }] }, key('imp'));
  assert.ok([200, 201].includes(lines.status), JSON.stringify(lines.body));
  const detail = await callApi({ db }, 'GET', `/api/reconciliations/${id}`, cookie);
  return { cookie, id, lineId: detail.body.lines[0].id };
}

test('#208 (bariera): podwójne kliknięcie „Dopasuj” w uzgodnieniu — druga transakcja czeka na blokadę uzgodnienia, odtworzenie i jedno zdarzenie', { skip }, async () => {
  await withReal(async (db) => {
    const { cookie, id, lineId } = await reconciliationSetup(db);
    const idem = key('m');
    const body = { statementLineId: lineId, ledgerEntryId: 'le-1' };
    const path = `/api/reconciliations/${id}/matches`;
    const { results: [a, b], waits, waitingSql } = await race(db, {
      pauseAfter: /INSERT INTO bank_reconciliation_matches/,
      first: (env) => callApi(env, 'POST', path, cookie, body, idem),
      others: [(env) => callApi(env, 'POST', path, cookie, body, idem)],
    });
    assertWaitsOn({ waits, waitingSql }, /FROM bank_reconciliations WHERE id = \$1 FOR UPDATE/, 'drugie dopasowanie czeka na blokadę wiersza uzgodnienia');
    assert.deepEqual([a.status, b.status, b.replayed], [201, 200, 'true'], JSON.stringify([a.body, b.body]));
    assert.equal(b.body.match.id, a.body.match.id);
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM bank_reconciliation_matches WHERE revoked_at IS NULL'), 1);
    assert.equal(await auditCount(db, 'reconciliation.match.confirmed'), 1);
  });
});

test('#208 (bariera): ta sama pozycja wyciągu dopasowywana naraz do dwóch wpisów — drugie 409 already_matched', { skip }, async () => {
  await withReal(async (db) => {
    const { cookie, id, lineId } = await reconciliationSetup(db);
    const path = `/api/reconciliations/${id}/matches`;
    const { results: [a, b], waits, waitingSql } = await race(db, {
      pauseAfter: /INSERT INTO bank_reconciliation_matches/,
      first: (env) => callApi(env, 'POST', path, cookie, { statementLineId: lineId, ledgerEntryId: 'le-1' }, key('m')),
      others: [(env) => callApi(env, 'POST', path, cookie, { statementLineId: lineId, ledgerEntryId: 'le-2' }, key('m'))],
    });
    assertWaitsOn({ waits, waitingSql }, /FROM bank_reconciliations WHERE id = \$1 FOR UPDATE/, 'drugie żądanie czeka na blokadę z kodu');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.error], [409, 'already_matched']);
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM bank_reconciliation_matches WHERE revoked_at IS NULL'), 1);
  });
});

// ---------------------------------------------------------------- zatwierdzenie kampanii e-mail

const BODY = 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}. Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.';

// Bez EMAIL_SENDING_ENABLED i bez klucza dostawcy: zatwierdzenie tylko zmienia
// stan kampanii; nic nie trafia do kolejki ani do transportu.
async function campaignSetup(db) {
  await seedPublishedPrivacyNotice(db);
  await seedClass(db, { id: 'c1', schoolYearId: YEAR });
  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] }),
    board: await seedUserSession(db, { userId: 'u-bd', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] }),
    board2: await seedUserSession(db, { userId: 'u-bd2', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] }),
  };
  for (const h of ['h1', 'h2']) {
    await db.query('INSERT INTO households (id) VALUES ($1)', [h]);
    await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, $2, 'Uczeń', 'Testowy')", [`${h}-s`, h]);
    await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)', [`e-${h}`, `${h}-s`, 'c1', YEAR]);
    await db.query("INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES ($1, $2, 'Opiekun', 'Testowy', $3, true)", [`${h}-g`, h, `${h}-g@example.invalid`]);
    await db.query('INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ($1, $2, true, false)', [`${h}-s`, `${h}-g`]);
  }
  const extra = { APP_ENV: 'test' };
  const env = { ...extra, db };
  const draft = await callApi(env, 'POST', '/api/email/campaigns', cookies.treasurer,
    { schoolYearId: YEAR, title: 'Przypomnienie jesienne', audience: 'all_households', subject: 'Dobrowolna składka {rok}', bodyText: BODY }, crypto.randomUUID());
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const id = draft.body.campaign.id;
  const snapshot = await callApi(env, 'POST', `/api/email/campaigns/${id}/snapshot`, cookies.treasurer);
  assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
  const preview = await callApi(env, 'GET', `/api/email/campaigns/${id}/preview`, cookies.board);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const hashes = { contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash };
  return { cookies, extra, id, hashes };
}
const approvePath = (id) => `/api/email/campaigns/${id}/approve`;
const APPROVE_UPDATE = /UPDATE email_campaigns SET status = 'approved'/;
const CAMPAIGN_LOCK = /FROM email_campaigns c JOIN school_years/;

async function assertNothingQueued(db) {
  assert.equal(await count(db, 'SELECT count(*)::int AS n FROM email_outbox'), 0, 'zatwierdzenie niczego nie kolejkuje');
  assert.equal(await auditCount(db, 'email.sent'), 0);
}

test('#208 (bariera): podwójne kliknięcie „Zatwierdź kampanię” — drugie czeka na blokadę kampanii i jest odtworzeniem; jedno zdarzenie, nic nie wysłane', { skip }, async () => {
  await withReal(async (db) => {
    const { cookies, extra, id, hashes } = await campaignSetup(db);
    const { results: [a, b], waits, waitingSql } = await race(db, {
      pauseAfter: APPROVE_UPDATE, extra,
      first: (env) => callApi(env, 'POST', approvePath(id), cookies.board, hashes),
      others: [(env) => callApi(env, 'POST', approvePath(id), cookies.board, hashes)],
    });
    assertWaitsOn({ waits, waitingSql }, /FOR UPDATE OF c/, 'drugie zatwierdzenie czeka na blokadę kampanii');
    assert.deepEqual([a.status, a.replayed], [200, null], JSON.stringify(a.body));
    assert.deepEqual([b.status, b.replayed], [200, 'true'], JSON.stringify(b.body));
    assert.equal(await auditCount(db, 'email.campaign.approved'), 1);
    await assertNothingQueued(db);
  });
});

test('#208 (bariera): dwie osoby z zarządu zatwierdzają naraz — jedna 200, druga 409 campaign_not_draft', { skip }, async () => {
  await withReal(async (db) => {
    const { cookies, extra, id, hashes } = await campaignSetup(db);
    const { results: [a, b], waits, waitingSql } = await race(db, {
      pauseAfter: APPROVE_UPDATE, extra,
      first: (env) => callApi(env, 'POST', approvePath(id), cookies.board, hashes),
      others: [(env) => callApi(env, 'POST', approvePath(id), cookies.board2, hashes)],
    });
    assertWaitsOn({ waits, waitingSql }, /FOR UPDATE OF c/, 'drugie żądanie czeka na blokadę z kodu');
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.error], [409, 'campaign_not_draft']);
    const row = (await db.query('SELECT status, approved_by FROM email_campaigns WHERE id = $1', [id])).rows[0];
    assert.deepEqual(row, { status: 'approved', approved_by: 'u-bd' });
    assert.equal(await auditCount(db, 'email.campaign.approved'), 1);
    await assertNothingQueued(db);
  });
});

// Druga warstwa to trigger 0082 (zmiana pól zatwierdzenia jest odrzucana, P0001):
// dane zostają poprawne, ale podwójne kliknięcie kończy się dla osoby z zarządu
// błędem 409 zamiast odtworzeniem — test bariery wyżej to wykrywa.
test('#208 kontrola pozytywna: bez FOR UPDATE kampanii drugie zatwierdzenie nie jest odtworzeniem, tylko 409 z triggera (test wykrywa usunięcie blokady)', { skip }, async () => {
  await withReal(async (db) => {
    const { cookies, extra, id, hashes } = await campaignSetup(db);
    const { results: [a, b], early } = await race(db, {
      pauseAfter: APPROVE_UPDATE, extra, rewrite: dropForUpdate(CAMPAIGN_LOCK), expectWait: false,
      first: (env) => callApi(env, 'POST', approvePath(id), cookies.board, hashes),
      others: [(env) => callApi(env, 'POST', approvePath(id), cookies.board, hashes)],
    });
    assert.deepEqual(early, ['pending'], 'bez blokady kampanii drugie żądanie dochodzi do UPDATE i czeka dopiero na wiersz');
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.replayed, b.body.error], [409, null, 'business_rule_violation'], 'bez blokady brak odtworzenia');
    assert.equal(await auditCount(db, 'email.campaign.approved'), 1);
    await assertNothingQueued(db);
  });
});

// ---------------------------------------------------------------- zaproszenia i ostatni administrator

async function adminSetup(db) {
  await seedSchoolYear(db, YEAR);
  const cookies = {
    adminA: await seedUserSession(db, { userId: 'u-admin-a', mfa: true, roles: [{ role: 'admin' }] }),
    adminB: await seedUserSession(db, { userId: 'u-admin-b', mfa: true, roles: [{ role: 'admin' }] }),
  };
  const grants = Object.fromEntries((await db.query("SELECT user_id, id FROM role_grants WHERE role = 'admin'")).rows.map((r) => [r.user_id, r.id]));
  return { cookies, grants };
}
// #146: rola niechroniona (Komisja Rewizyjna) — przy dwóch administratorach
// zaproszenie do roli zarządu byłoby tylko wnioskiem (202), bez tokenu.
const invitation = { email: 'nowa.osoba@example.invalid', role: 'audit', schoolYearId: YEAR };
const INVITATION_LOCK = (sql, params) => typeof params?.[0] === 'string' && params[0].startsWith('rd:invitation:');

test('#208 (bariera): podwójne kliknięcie „Zaproś” — drugie czeka na blokadę adresu i dostaje 409 invitation_pending; jeden token', { skip }, async () => {
  await withReal(async (db) => {
    const { cookies } = await adminSetup(db);
    const { results: [a, b], waits } = await race(db, {
      pauseAfter: /INSERT INTO invitations/,
      first: (env) => callApi(env, 'POST', '/api/admin/invitations', cookies.adminA, invitation),
      others: [(env) => callApi(env, 'POST', '/api/admin/invitations', cookies.adminB, invitation)],
    });
    assert.deepEqual(waits, ['advisory'], 'drugie zaproszenie czeka na blokadę doradczą adresu');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.error, 'token' in b.body], [409, 'invitation_pending', false]);
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM invitations'), 1);
    assert.equal(await auditCount(db, 'invitation.created'), 1);
  });
});

test('#208 kontrola pozytywna: bez blokady adresu dwa równoległe zaproszenia tworzą dwa ważne tokeny (stan sprzed poprawki)', { skip }, async () => {
  await withReal(async (db) => {
    const { cookies } = await adminSetup(db);
    const { results: [a, b], early } = await race(db, {
      pauseAfter: /INSERT INTO invitations/, rewrite: dropAdvisoryLock(INVITATION_LOCK), expectWait: false,
      first: (env) => callApi(env, 'POST', '/api/admin/invitations', cookies.adminA, invitation),
      others: [(env) => callApi(env, 'POST', '/api/admin/invitations', cookies.adminB, invitation)],
    });
    assert.deepEqual(early, ['settled'], 'bez blokady drugie zaproszenie nie czeka');
    assert.deepEqual([a.status, b.status], [201, 201]);
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM invitations'), 2);
  });
});

// „Wyślij ponownie” (#293, follow-up #576/#557): wycofanie i nowe zaproszenie
// w jednej transakcji pod blokadą adresu. Wcześniej były to dwie osobne
// transakcje bez blokady i równoległe „Zaproś” (albo drugie „Wyślij ponownie”)
// mogło zostawić dwa ważne tokeny.
const reissuePath = (id) => `/api/admin/invitations/${encodeURIComponent(id)}/reissue`;
const pendingInvitationIds = async (db) => (await db.query(
  'SELECT id FROM invitations WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY id',
)).rows.map((row) => row.id);

async function pendingInvitationSetup(db) {
  const { cookies } = await adminSetup(db);
  const created = await callApi({ db }, 'POST', '/api/admin/invitations', cookies.adminA, invitation);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { cookies, oldId: created.body.invitation.id };
}

test('#293 (bariera): dwa równoczesne „Wyślij ponownie” — drugie czeka na blokadę adresu i dostaje 409 invitation_not_pending; jeden ważny token', { skip }, async () => {
  await withReal(async (db) => {
    const { cookies, oldId } = await pendingInvitationSetup(db);
    const { results: [a, b], waits } = await race(db, {
      pauseAfter: /INSERT INTO invitations/,
      first: (env) => callApi(env, 'POST', reissuePath(oldId), cookies.adminA, {}),
      others: [(env) => callApi(env, 'POST', reissuePath(oldId), cookies.adminB, {})],
    });
    assert.deepEqual(waits, ['advisory'], 'drugie ponowienie czeka na blokadę doradczą adresu, nie dopiero na wiersz');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(a.body.invitation.replacesInvitationId, oldId);
    assert.deepEqual([b.status, b.body.error, 'token' in b.body], [409, 'invitation_not_pending', false]);
    assert.deepEqual(await pendingInvitationIds(db), [a.body.invitation.id], 'jeden ważny token — nowy');
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM invitations'), 2);
    assert.equal(await auditCount(db, 'invitation.reissued'), 1);
    assert.equal(await auditCount(db, 'invitation.revoked'), 1);
  });
});

test('#293 (bariera): „Wyślij ponownie” równolegle z „Zaproś” na ten sam adres — „Zaproś” czeka na blokadę i dostaje 409 invitation_pending; jeden ważny token', { skip }, async () => {
  await withReal(async (db) => {
    const { cookies, oldId } = await pendingInvitationSetup(db);
    const { results: [a, b], waits } = await race(db, {
      pauseAfter: /INSERT INTO invitations/,
      first: (env) => callApi(env, 'POST', reissuePath(oldId), cookies.adminA, {}),
      others: [(env) => callApi(env, 'POST', '/api/admin/invitations', cookies.adminB, invitation)],
    });
    assert.deepEqual(waits, ['advisory']);
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.error, 'token' in b.body], [409, 'invitation_pending', false]);
    assert.deepEqual(await pendingInvitationIds(db), [a.body.invitation.id]);
    assert.equal(await auditCount(db, 'invitation.created'), 2, 'pierwotne i ponowione — bez trzeciego');
  });
});

test('#293 kontrola pozytywna: bez blokady adresu drugie „Wyślij ponownie” czeka dopiero na wiersz (warunkowy UPDATE) — tę warstwę wykrywa mutant invitation-reissue', { skip }, async () => {
  await withReal(async (db) => {
    const { cookies, oldId } = await pendingInvitationSetup(db);
    const { results: [a, b], waits } = await race(db, {
      pauseAfter: /INSERT INTO invitations/, rewrite: dropAdvisoryLock(INVITATION_LOCK),
      first: (env) => callApi(env, 'POST', reissuePath(oldId), cookies.adminA, {}),
      others: [(env) => callApi(env, 'POST', reissuePath(oldId), cookies.adminB, {})],
    });
    assert.deepEqual(waits, ['transactionid'], 'bez blokady adresu zostaje tylko blokada wiersza w UPDATE');
    assert.deepEqual([a.status, b.status, b.body.error], [201, 409, 'invitation_not_pending']);
    assert.deepEqual(await pendingInvitationIds(db), [a.body.invitation.id]);
  });
});

const revokePath = (grantId) => `/api/admin/grants/${grantId}/revoke`;
// Pauza po sprawdzeniu „wykonujący nadal jest adminem” (assertActorStillAdmin),
// przed COMMIT — najgorszy przeplot: A już sprawdził, B sprawdza przed COMMIT A.
const ADMIN_CHECK = /SELECT 1 FROM role_grants\s+WHERE user_id = \$1 AND role = 'admin'/;

test('#208 (bariera): dwóch administratorów jednocześnie odbiera sobie rolę admin — drugi czeka na blokadę doradczą i dostaje 409 last_admin_grant', { skip }, async () => {
  await withReal(async (db) => {
    const { cookies, grants } = await adminSetup(db);
    const { results: [a, b], waits, errors } = await race(db, {
      pauseAfter: ADMIN_CHECK,
      first: (env) => callApi(env, 'POST', revokePath(grants['u-admin-b']), cookies.adminA),
      others: [(env) => callApi(env, 'POST', revokePath(grants['u-admin-a']), cookies.adminB)],
    });
    assert.deepEqual(waits, ['advisory'], 'drugie odebranie czeka na blokadę rd:role_grants');
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.error], [409, 'last_admin_grant']);
    assert.deepEqual(errors, []);
    assert.equal(await count(db, "SELECT count(*)::int AS n FROM role_grants WHERE role = 'admin' AND revoked_at IS NULL"), 1, 'zostaje jeden aktywny administrator');
    assert.equal(await auditCount(db, 'role_grant.revoked'), 1);
  });
});

test('#208 kontrola pozytywna: bez blokady doradczej dwaj administratorzy odbierają sobie rolę i nie zostaje żaden (test wykrywa usunięcie blokady)', { skip }, async () => {
  await withReal(async (db) => {
    const { cookies, grants } = await adminSetup(db);
    const { results: [a, b], early } = await race(db, {
      pauseAfter: ADMIN_CHECK, rewrite: dropAdvisoryLock(), expectWait: false,
      first: (env) => callApi(env, 'POST', revokePath(grants['u-admin-b']), cookies.adminA),
      others: [(env) => callApi(env, 'POST', revokePath(grants['u-admin-a']), cookies.adminB)],
    });
    assert.deepEqual(early, ['settled']);
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.equal(await count(db, "SELECT count(*)::int AS n FROM role_grants WHERE role = 'admin' AND revoked_at IS NULL"), 0);
  });
});

test('#146 (bariera): podwójne kliknięcie „Zatwierdź” wniosku o nadanie roli — drugie czeka na blokadę i dostaje 409; jeden przydział, jedno zdarzenie', { skip }, async () => {
  await withReal(async (db) => {
    const { cookies } = await adminSetup(db);
    const adminC = await seedUserSession(db, { userId: 'u-admin-c', mfa: true, roles: [{ role: 'admin' }] });
    await seedUser(db, { userId: 'u-nowy-skarbnik' });
    const plain = barrierEnv(db, {}).env;
    const requested = await callApi(plain, 'POST', '/api/admin/grants', cookies.adminA, { userId: 'u-nowy-skarbnik', role: 'treasurer' });
    assert.equal(requested.status, 202, JSON.stringify(requested.body));
    const approvePath = `/api/admin/grant-requests/${requested.body.request.id}/approve`;
    const { results: [a, b], waits, errors } = await race(db, {
      pauseAfter: /UPDATE role_grant_requests SET status = 'approved'/,
      first: (env) => callApi(env, 'POST', approvePath, cookies.adminB),
      others: [(env) => callApi(env, 'POST', approvePath, adminC)],
    });
    assert.deepEqual(waits, ['advisory'], 'drugie zatwierdzenie czeka na blokadę rd:role_grants (przed blokadą wiersza wniosku)');
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.error], [409, 'grant_request_closed']);
    assert.deepEqual(errors, []);
    assert.equal(await count(db, "SELECT count(*)::int AS n FROM role_grants WHERE user_id = 'u-nowy-skarbnik' AND role = 'treasurer'"), 1);
    assert.equal(await auditCount(db, 'role_grant_request.approved'), 1);
    assert.equal(await auditCount(db, 'role_grant.created'), 1);
  });
});

test('#146/0159 (bariera): podwójne kliknięcie „Odrzuć” z różnymi powodami — drugie czeka na blokadę wiersza i dostaje 409; zapisany pierwszy powód, jedno zdarzenie', { skip }, async () => {
  await withReal(async (db) => {
    const { cookies } = await adminSetup(db);
    const adminC = await seedUserSession(db, { userId: 'u-admin-c', mfa: true, roles: [{ role: 'admin' }] });
    await seedUser(db, { userId: 'u-odrzucany' });
    const plain = barrierEnv(db, {}).env;
    const requested = await callApi(plain, 'POST', '/api/admin/grants', cookies.adminA, { userId: 'u-odrzucany', role: 'board' });
    assert.equal(requested.status, 202, JSON.stringify(requested.body));
    const rejectPath = `/api/admin/grant-requests/${requested.body.request.id}/reject`;
    const race1 = await race(db, {
      pauseAfter: /UPDATE role_grant_requests SET status = 'rejected'/,
      first: (env) => callApi(env, 'POST', rejectPath, cookies.adminB, { reason: 'Pierwszy powód odrzucenia' }),
      others: [(env) => callApi(env, 'POST', rejectPath, adminC, { reason: 'Drugi powód odrzucenia' })],
    });
    const { results: [a, b], errors } = race1;
    assertWaitsOn(race1, /FOR UPDATE/, 'drugie odrzucenie czeka na blokadę wiersza wniosku (FOR UPDATE)');
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.error], [409, 'grant_request_closed']);
    assert.deepEqual(errors, []);
    const { rows } = await db.query('SELECT status, reject_reason, decided_by FROM role_grant_requests WHERE id = $1', [requested.body.request.id]);
    assert.deepEqual(rows[0], { status: 'rejected', reject_reason: 'Pierwszy powód odrzucenia', decided_by: 'u-admin-b' });
    assert.equal(await auditCount(db, 'role_grant_request.rejected'), 1);
  });
});

// ---------------------------------------------------------------- import

const HEADER = 'ID ucznia;Imię ucznia;Nazwisko ucznia;Klasa;ID rodziny;Opiekun 1;E-mail opiekuna 1;Opiekun 2;E-mail opiekuna 2';
const CSV = `${HEADER}
S1;Ala;Testowa;1A;R1;Anna Testowa;anna@example.invalid;Jan Testowy;jan@example.invalid
S2;Ola;Testowa;1A;R1;Anna Testowa;anna@example.invalid;Jan Testowy;jan@example.invalid
S3;Piotr;Próbny;1A;R2;Ewa Próbna;ewa@example.invalid;;
`;

async function importSetup(db) {
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR, name: '1A' });
  const admin = await seedUserSession(db, { userId: 'u-admin', mfa: true, roles: [{ role: 'admin' }] });
  await seedUser(db, { userId: 'u-privacy-author' });
  await db.query(
    `INSERT INTO privacy_notices (id, body_text, content_hash, decision_ref, status, created_by, approved_by, approved_at, published_by, published_at)
     VALUES ('pn-test', 'Testowa informacja o przetwarzaniu danych.', repeat('a', 64), 'D-06/test', 'published',
             'u-privacy-author', 'u-admin', now(), 'u-admin', now())`,
  );
  const matrix = parseCsv(CSV);
  const payload = toServerPayload(validateRows(matrix, guessMapping(matrix[0])), YEAR);
  const preview = await callApi({ db, APP_ENV: 'test' }, 'POST', '/api/import/preview', admin, payload);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  return { admin, body: { ...payload, fingerprint: preview.body.fingerprint, planDigest: preview.body.planDigest } };
}
const IMPORT_LOCK = (sql) => /rd_import_commit/.test(sql);

test('#208 (bariera): dwa równoległe commity tego samego pliku z różnymi kluczami — drugi czeka na blokadę doradczą i odtwarza jedną partię', { skip }, async () => {
  await withReal(async (db) => {
    const { admin, body } = await importSetup(db);
    const extra = { APP_ENV: 'test' };
    const { results: [a, b], waits } = await race(db, {
      pauseAfter: /INSERT INTO import_batches/, extra,
      first: (env) => callApi(env, 'POST', '/api/import/commit', admin, body, key('imp')),
      others: [(env) => callApi(env, 'POST', '/api/import/commit', admin, body, key('imp'))],
    });
    assert.deepEqual(waits, ['advisory'], 'drugi commit czeka na blokadę rd_import_commit');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.replayed, b.body.batchId], [200, true, a.body.batchId], JSON.stringify(b.body));
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM import_batches'), 1);
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM students'), 3);
  });
});

test('#208 kontrola pozytywna: bez blokady doradczej drugi commit nie jest czystym odtworzeniem (test wykrywa usunięcie blokady)', { skip }, async () => {
  await withReal(async (db) => {
    const { admin, body } = await importSetup(db);
    const extra = { APP_ENV: 'test' };
    const { results: [a, b], waits } = await race(db, {
      pauseAfter: /INSERT INTO import_batches/, extra, rewrite: dropAdvisoryLock(IMPORT_LOCK),
      first: (env) => callApi(env, 'POST', '/api/import/commit', admin, body, key('imp')),
      others: [(env) => callApi(env, 'POST', '/api/import/commit', admin, body, key('imp'))],
    });
    assert.equal(waits.includes('advisory'), false, 'bez blokady nikt nie czeka na rd_import_commit');
    // B zapisuje tych samych uczniów, zanim A (wstrzymany po INSERT partii) do
    // nich dojdzie; A dostaje potem 23505 → 409 conflict. Dane zostają spójne
    // dzięki ograniczeniom, ale użytkownik widzi błąd zamiast odtworzenia.
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409], `bez blokady brak czystego odtworzenia: ${JSON.stringify([a.body, b.body])}`);
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM import_batches'), 1);
  });
});
