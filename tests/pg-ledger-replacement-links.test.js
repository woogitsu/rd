// Przeksięgowanie wpisu księgi a wpłata, centra kosztów i uzgodnienia (#144, 0142).
// Wyłącznie dane syntetyczne. PGlite w pamięci.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, seedClass, seedEnrolledHousehold, seedSchoolYear, seedUserSession, TEST_ORIGIN } from './helpers/pg.js';
import { assertEvery } from './helpers/assertions.js';

const YEAR = 'y-144l';

function req(path, { cookie, method, body, key } = {}) {
  const headers = new Headers();
  if (cookie) headers.set('Cookie', cookie);
  const upper = method ?? (body !== undefined ? 'POST' : 'GET');
  if (upper !== 'GET') headers.set('Origin', TEST_ORIGIN);
  if (key) headers.set('Idempotency-Key', key);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return new Request(`${TEST_ORIGIN}${path}`, {
    method: upper, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function readJson(response) {
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function setup() {
  const db = await createTestDb();
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR, name: '1A' });
  // #205: wpłata przyjmuje gospodarstwo z uczniem zapisanym w roku wpłaty.
  await seedEnrolledHousehold(db, 'h1', [YEAR], { classIds: { [YEAR]: 'c-1a' } });
  await seedEnrolledHousehold(db, 'h2', [YEAR], { classIds: { [YEAR]: 'c-1a' } });
  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-t', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] }),
    board: await seedUserSession(db, { userId: 'u-b', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] }),
    noMfa: await seedUserSession(db, { userId: 'u-t', mfa: false }),
    audit: await seedUserSession(db, { userId: 'u-a', mfa: true, roles: [{ role: 'audit', schoolYearId: YEAR }] }),
    principal: await seedUserSession(db, { userId: 'u-p', mfa: true, roles: [{ role: 'principal', schoolYearId: YEAR }] }),
    rep: await seedUserSession(db, {
      userId: 'u-r', mfa: true, roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }],
    }),
  };
  await db.query(
    `INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES
       ('cat-in-a', $1, 'income', 'Składki A', 'u-t'),
       ('cat-in-b', $1, 'income', 'Składki B', 'u-t'),
       ('cat-out-a', $1, 'expense', 'Materiały', 'u-t'),
       ('cat-out-b', $1, 'expense', 'Nagrody', 'u-t')`,
    [YEAR],
  );
  await db.query(
    `INSERT INTO events (id, school_year_id, title, begins_at, visibility, created_by)
     VALUES ('ev-1', $1, 'Kiermasz testowy', '2026-10-10T10:00:00Z', 'internal', 'u-b')`,
    [YEAR],
  );
  const fetch = (request) => handlePgRequest(request, { db });
  let seq = 0;
  const key = (prefix) => `${prefix}-144l-${++seq}`;
  return { db, cookies, fetch, key };
}

const entryBody = (over = {}) => ({
  schoolYearId: YEAR, direction: 'income', amountCents: 10000, categoryId: 'cat-in-a',
  description: 'Wpis syntetyczny', occurredOn: '2026-10-01', method: 'bank', ...over,
});
const replBody = (over = {}) => ({ ...entryBody(), description: 'Zastępczy', reason: 'Poprawka kategorii', ...over });

async function post(ctx, path, body, cookie = ctx.cookies.treasurer, key = ctx.key('k')) {
  return readJson(await ctx.fetch(req(path, { cookie, key, body })));
}

async function createEntry(ctx, over = {}) {
  const res = await post(ctx, '/api/ledger', entryBody(over));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.entry.id;
}

async function createLinkedEntry(ctx, { amountCents = 5000, household = 'h1' } = {}) {
  const payment = await post(ctx, '/api/payments', {
    schoolYearId: YEAR, householdId: household, amountCents, receivedOn: '2026-10-01', method: 'bank', reference: 'Wpłata syntetyczna',
  });
  assert.equal(payment.status, 201, JSON.stringify(payment.body));
  const paymentId = payment.body.payment.id;
  const entryId = await createEntry(ctx, { amountCents, description: 'Ujęcie wpłaty', paymentEntryId: paymentId });
  return { paymentId, entryId };
}

const balance = async (db) => Number((await db.query(
  'SELECT closing_balance_cents FROM ledger_year_summary WHERE school_year_id = $1', [YEAR],
)).rows[0].closing_balance_cents);

const countLinkedNet = async (db, paymentId) => Number((await db.query(
  'SELECT count(*) AS n FROM ledger_entry_net WHERE payment_entry_id = $1 AND net_amount_cents > 0', [paymentId],
)).rows[0].n);

test('wpis powiązany z wpłatą: przeksięgowanie kategorii/daty/metody przenosi powiązanie, wpłata ujęta raz, bilans bez zmian', async () => {
  const ctx = await setup();
  const { db } = ctx;
  try {
    const { paymentId, entryId } = await createLinkedEntry(ctx);
    const before = await balance(db);
    const res = await post(ctx, `/api/ledger/${entryId}/replacement`, replBody({
      amountCents: 5000, categoryId: 'cat-in-b', occurredOn: '2026-10-03', method: 'other', description: 'Ujęcie wpłaty po korekcie',
    }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.entry.replacesEntryId, entryId);
    assert.equal(res.body.entry.paymentEntryId, paymentId, 'powiązanie przejęte z wpisu zastępowanego');
    assert.equal(res.body.warnings, undefined);
    assert.equal(await balance(db), before);
    assert.equal(await countLinkedNet(db, paymentId), 1);
    const rows = (await db.query('SELECT id, net_amount_cents FROM ledger_entry_net WHERE payment_entry_id = $1 ORDER BY created_at', [paymentId])).rows;
    assert.equal(rows.length, 2);
    assert.equal(Number(rows[0].net_amount_cents), 0);
    assert.equal(Number(rows[1].net_amount_cents), 5000);

    // Historia nietknięta: wpis pierwotny bez zmian, storno jako osobny wiersz.
    const original = (await db.query('SELECT category_id, amount_cents FROM ledger_entries WHERE id = $1', [entryId])).rows[0];
    assert.equal(original.category_id, 'cat-in-a');
    assert.equal(Number(original.amount_cents), 5000);

    // Zdarzenie audytu: rok, wpłata, bez kwoty i opisu.
    const audit = (await db.query("SELECT metadata_json FROM audit_events WHERE action = 'ledger.entry.replaced'")).rows;
    assert.equal(audit.length, 1);
    const meta = typeof audit[0].metadata_json === 'string' ? JSON.parse(audit[0].metadata_json) : audit[0].metadata_json;
    assert.equal(meta.schoolYearId, YEAR);
    assert.equal(meta.paymentEntryId, paymentId);
    assert.doesNotMatch(JSON.stringify(meta), /amount|description|5000|Ujęcie/);

    // Łańcuch: wpis zastępczy sam można przeksięgować (nadal jedno ujęcie wpłaty).
    const again = await post(ctx, `/api/ledger/${res.body.entry.id}/replacement`, replBody({ amountCents: 5000, categoryId: 'cat-in-a' }));
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(await countLinkedNet(db, paymentId), 1);
  } finally { await db.close(); }
});

test('wpis powiązany z wpłatą: kwota tylko przez korektę wpłaty; kierunek i inna wpłata odrzucone', async () => {
  const ctx = await setup();
  const { db } = ctx;
  try {
    const { paymentId, entryId } = await createLinkedEntry(ctx);
    const other = await post(ctx, '/api/payments', {
      schoolYearId: YEAR, householdId: 'h2', amountCents: 5000, receivedOn: '2026-10-01', method: 'bank', reference: 'Inna wpłata',
    });
    const otherId = other.body.payment.id;

    const higher = await post(ctx, `/api/ledger/${entryId}/replacement`, replBody({ amountCents: 6000 }));
    assert.deepEqual([higher.status, higher.body.error], [422, 'payment_amount_mismatch']);
    const lower = await post(ctx, `/api/ledger/${entryId}/replacement`, replBody({ amountCents: 4000 }));
    assert.deepEqual([lower.status, lower.body.error], [422, 'payment_amount_mismatch']);
    const expense = await post(ctx, `/api/ledger/${entryId}/replacement`,
      replBody({ amountCents: 5000, direction: 'expense', categoryId: 'cat-out-a' }));
    assert.deepEqual([expense.status, expense.body.error], [400, 'invalid_payment_link']);
    const foreign = await post(ctx, `/api/ledger/${entryId}/replacement`, replBody({ amountCents: 5000, paymentEntryId: otherId }));
    assert.deepEqual([foreign.status, foreign.body.error], [400, 'invalid_payment_link']);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ledger_entries WHERE replaces_entry_id IS NOT NULL')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ledger_corrections')).rows[0].n, 0, 'odrzucone żądanie nie zostawia storna');

    // Nowe powiązanie z wpłatą nie powstaje przez przeksięgowanie wpisu niepowiązanego.
    const plain = await createEntry(ctx, { amountCents: 5000 });
    const link = await post(ctx, `/api/ledger/${plain}/replacement`, replBody({ amountCents: 5000, paymentEntryId: otherId }));
    assert.deepEqual([link.status, link.body.error], [400, 'invalid_payment_link']);

    // Zmiana kwoty: korekta wpisu, potem korekta wpłaty (#138); przeksięgowanie działa na nowym netto.
    const ledgerCorr = await post(ctx, `/api/ledger/${entryId}/corrections`, { amountCents: 1000, reason: 'Zmniejszenie wpłaty' });
    assert.equal(ledgerCorr.status, 201, JSON.stringify(ledgerCorr.body));
    const payCorr = await post(ctx, `/api/payments/${paymentId}/corrections`, { amountCents: 1000, reason: 'Zmniejszenie wpłaty' });
    assert.equal(payCorr.status, 201, JSON.stringify(payCorr.body));
    const ok = await post(ctx, `/api/ledger/${entryId}/replacement`, replBody({ amountCents: 4000, categoryId: 'cat-in-b' }));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(await countLinkedNet(db, paymentId), 1);

    // Dalsza korekta wpłaty wymaga korekty wpisu zastępczego (spójność sumy łańcucha, 0142).
    const blocked = await post(ctx, `/api/payments/${paymentId}/corrections`, { amountCents: 500, reason: 'Kolejna korekta' });
    assert.deepEqual([blocked.status, blocked.body.error], [409, 'ledger_correction_required']);
    const replCorr = await post(ctx, `/api/ledger/${ok.body.entry.id}/corrections`, { amountCents: 500, reason: 'Kolejna korekta' });
    assert.equal(replCorr.status, 201, JSON.stringify(replCorr.body));
    const done = await post(ctx, `/api/payments/${paymentId}/corrections`, { amountCents: 500, reason: 'Kolejna korekta' });
    assert.equal(done.status, 201, JSON.stringify(done.body));
  } finally { await db.close(); }
});

test('wpłata ujęta dokładnie raz: ponowne powiązanie i bezpośredni INSERT są odrzucane, równoległe przeksięgowania — jedno wygrywa', async () => {
  const ctx = await setup();
  const { db } = ctx;
  try {
    const { paymentId, entryId } = await createLinkedEntry(ctx);
    const repl = await post(ctx, `/api/ledger/${entryId}/replacement`, replBody({ amountCents: 5000, categoryId: 'cat-in-b' }));
    assert.equal(repl.status, 201, JSON.stringify(repl.body));

    // Nowy wpis dla tej samej wpłaty (API) — 409.
    const relink = await post(ctx, '/api/ledger', entryBody({ amountCents: 5000, paymentEntryId: paymentId }));
    assert.deepEqual([relink.status, relink.body.error], [409, 'payment_already_linked']);

    // Bezpośredni INSERT: bez replaces_entry_id, z replaces wpisu z netto > 0 i z innym powiązaniem.
    const insert = (id, replaces, payment = paymentId) => db.query(
      `INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on,
         method, created_by, idempotency_key, payment_entry_id, replaces_entry_id)
       VALUES ($1, $2, 'income', 5000, 'cat-in-a', 'Bezpośredni', '2026-10-01', 'bank', 'u-t', $3, $4, $5)`,
      [id, YEAR, `direct-key-${id}`, payment, replaces]);
    await assert.rejects(insert('le-direct-1', null), /ledger_payment_already_linked/);
    await assert.rejects(insert('le-direct-2', repl.body.entry.id), /ledger_payment_already_linked/);
    await assert.rejects(insert('le-direct-3', entryId), /ledger_payment_already_linked|ledger_entries_replaces_idx|duplicate key/);
    const plain = await createEntry(ctx, { amountCents: 5000 });
    const fresh = await post(ctx, '/api/payments', {
      schoolYearId: YEAR, householdId: 'h2', amountCents: 5000, receivedOn: '2026-10-01', method: 'bank', reference: 'Nowa wpłata',
    });
    // Nowa wpłata przez zastąpienie wpisu niepowiązanego — zabronione (przeksięgowanie nie tworzy powiązania).
    await assert.rejects(insert('le-direct-4', plain, fresh.body.payment.id), /ledger_replacement_payment_link_mismatch/);
    assert.equal(await countLinkedNet(db, paymentId), 1);

    // Równoległe przeksięgowanie tego samego wpisu z różnymi kluczami — jedna operacja wygrywa.
    const second = await setup();
    try {
      const linked = await createLinkedEntry(second);
      const results = await Promise.all([1, 2].map((n) => post(second, `/api/ledger/${linked.entryId}/replacement`,
        replBody({ amountCents: 5000, categoryId: 'cat-in-b', description: `Równoległe ${n}` }))));
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 409], JSON.stringify(results.map((r) => r.body)));
      assert.equal(results.find((r) => r.status === 409).body.error, 'ledger_entry_already_replaced');
      assert.equal(await countLinkedNet(second.db, linked.paymentId), 1);
      // Równolegle korekta i przeksięgowanie tego samego wpisu: suma korekt <= kwota wpisu.
      const plainEntry = await createEntry(second, { amountCents: 8000 });
      const race = await Promise.all([
        post(second, `/api/ledger/${plainEntry}/corrections`, { amountCents: 3000, reason: 'Korekta równoległa' }),
        post(second, `/api/ledger/${plainEntry}/replacement`, replBody({ amountCents: 8000, categoryId: 'cat-in-b' })),
      ]);
      assertEvery(race, (r) => [201, 409].includes(r.status), JSON.stringify(race.map((r) => r.body)));
      const sum = Number((await second.db.query(
        'SELECT COALESCE(sum(amount_cents), 0) AS s FROM ledger_corrections WHERE ledger_entry_id = $1', [plainEntry])).rows[0].s);
      assert.ok(sum <= 8000, `suma korekt ${sum} przekracza kwotę wpisu`);
    } finally { await second.db.close(); }
  } finally { await db.close(); }
});

test('zwiększenie kwoty i zmiana kierunku dla wpisu niepowiązanego: storno + nowy wpis, historia pełna', async () => {
  const ctx = await setup();
  const { db } = ctx;
  try {
    const entryId = await createEntry(ctx, { direction: 'expense', amountCents: 2000, categoryId: 'cat-out-a', description: 'Wydatek za niski' });
    const before = await balance(db);
    const res = await post(ctx, `/api/ledger/${entryId}/replacement`, replBody({
      direction: 'expense', amountCents: 2500, categoryId: 'cat-out-b', description: 'Wydatek poprawiony', reason: 'Dopisek do kwoty',
    }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(await balance(db), before - 500);
    const flip = await post(ctx, `/api/ledger/${res.body.entry.id}/replacement`, replBody({
      direction: 'income', amountCents: 2500, categoryId: 'cat-in-a', reason: 'Zły kierunek',
    }));
    assert.equal(flip.status, 201, JSON.stringify(flip.body));
    assert.equal(await balance(db), before + 4500);
    // Nic nie zostało zaktualizowane ani usunięte.
    const originalRow = (await db.query('SELECT direction, amount_cents, category_id FROM ledger_entries WHERE id = $1', [entryId])).rows[0];
    assert.deepEqual([originalRow.direction, Number(originalRow.amount_cents), originalRow.category_id], ['expense', 2000, 'cat-out-a']);
    await assert.rejects(db.query("UPDATE ledger_entries SET category_id = 'cat-out-b' WHERE id = $1", [entryId]), /immutable|cannot/);
  } finally { await db.close(); }
});

// --- centra kosztów (0090) ---------------------------------------------------------

async function allocate(ctx, entryId, items, supersedesId = null) {
  return post(ctx, `/api/ledger/${entryId}/allocations`, { items, supersedesId, reason: supersedesId ? 'Zmiana przypisania' : undefined });
}

test('przeksięgowanie wpisu przypisanego do wydarzenia przenosi przypisanie; wynik centrum bez zmian', async () => {
  const ctx = await setup();
  const { db } = ctx;
  try {
    const entryId = await createEntry(ctx, { direction: 'expense', amountCents: 9000, categoryId: 'cat-out-a' });
    const alloc = await allocate(ctx, entryId, [{ eventId: 'ev-1', amountCents: 6000 }, { classId: 'c-1a', amountCents: 2000 }]);
    assert.equal(alloc.status, 201, JSON.stringify(alloc.body));
    const centerReport = async () => (await readJson(await ctx.fetch(req(
      `/api/ledger/cost-centers?schoolYearId=${YEAR}&type=event`, { cookie: ctx.cookies.treasurer })))).body.report;
    const before = await centerReport();

    // Zwykła korekta poniżej przypisania nadal jest odrzucana (0090).
    const tooLow = await post(ctx, `/api/ledger/${entryId}/corrections`, { amountCents: 4000, reason: 'Za dużo' });
    assert.deepEqual([tooLow.status, tooLow.body.error], [409, 'allocation_exceeds_net']);

    // Przeksięgowanie na mniejszą kwotę niż przypisanie — odmowa, bez zapisu.
    const tooSmall = await post(ctx, `/api/ledger/${entryId}/replacement`, replBody({
      direction: 'expense', amountCents: 7000, categoryId: 'cat-out-b', reason: 'Mniejsza kwota',
    }));
    assert.deepEqual([tooSmall.status, tooSmall.body.error], [409, 'allocation_exceeds_net']);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ledger_corrections')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ledger_allocation_versions')).rows[0].n, 1);

    const ok = await post(ctx, `/api/ledger/${entryId}/replacement`, replBody({
      direction: 'expense', amountCents: 9000, categoryId: 'cat-out-b', reason: 'Zła kategoria',
    }));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const newId = ok.body.entry.id;
    const current = (await db.query(
      'SELECT ledger_entry_id, event_id, class_id, amount_cents FROM ledger_current_allocations ORDER BY ledger_entry_id, amount_cents')).rows;
    assert.deepEqual(current.map((r) => [r.ledger_entry_id, r.event_id, r.class_id, Number(r.amount_cents)]),
      [[newId, null, 'c-1a', 2000], [newId, 'ev-1', null, 6000]], 'przypisanie tylko przy wpisie zastępczym');
    const versions = (await db.query(
      'SELECT ledger_entry_id, version_no FROM ledger_allocation_versions ORDER BY created_at, version_no')).rows;
    assert.equal(versions.length, 3, 'wersja pierwotna, zwalniająca i przeniesiona — historia nietknięta');
    const after = await centerReport();
    assert.deepEqual(after.centers.map((c) => [c.id, c.expenseCents, c.incomeCents]),
      before.centers.map((c) => [c.id, c.expenseCents, c.incomeCents]));
    assert.deepEqual(after.general, before.general);
    const history = await readJson(await ctx.fetch(req(`/api/ledger/${entryId}/allocations`, { cookie: ctx.cookies.treasurer })));
    assert.equal(history.status, 200);
    const audit = (await db.query("SELECT action, metadata_json FROM audit_events WHERE action LIKE 'ledger.%' ORDER BY occurred_at")).rows;
    for (const row of audit) {
      const meta = typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json;
      assert.equal(meta.schoolYearId, YEAR, `${row.action} bez schoolYearId`);
    }
  } finally { await db.close(); }
});

test('przeksięgowanie ze zmianą kierunku zwalnia przypisanie do „ogólne” (audyt: allocationReleased)', async () => {
  const ctx = await setup();
  const { db } = ctx;
  try {
    const entryId = await createEntry(ctx, { direction: 'expense', amountCents: 3000, categoryId: 'cat-out-a' });
    assert.equal((await allocate(ctx, entryId, [{ eventId: 'ev-1', amountCents: 3000 }])).status, 201);
    const res = await post(ctx, `/api/ledger/${entryId}/replacement`, replBody({
      direction: 'income', amountCents: 3000, categoryId: 'cat-in-a', reason: 'Zły kierunek',
    }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ledger_current_allocations')).rows[0].n, 0);
    const audit = (await db.query("SELECT metadata_json FROM audit_events WHERE action = 'ledger.entry.replaced'")).rows[0];
    const meta = typeof audit.metadata_json === 'string' ? JSON.parse(audit.metadata_json) : audit.metadata_json;
    assert.deepEqual([meta.allocationCarried, meta.allocationReleased], [false, true]);
  } finally { await db.close(); }
});

// --- uzgodnienia (#165) --------------------------------------------------------------

async function matchEntry(ctx, { entryId, amountCents, statementDate = '2026-10-31', bookedOn = '2026-10-01' }) {
  const rec = await post(ctx, '/api/reconciliations', {
    schoolYearId: YEAR, statementDate, statementBalanceCents: amountCents, notes: 'Test',
  });
  assert.equal(rec.status, 201, JSON.stringify(rec.body));
  const reconciliationId = rec.body.reconciliation.id;
  const lines = await post(ctx, `/api/reconciliations/${reconciliationId}/lines`, {
    lines: [{ bookedOn, amountCents, reference: 'Tytuł syntetyczny' }],
  });
  assert.equal(lines.status, 201, JSON.stringify(lines.body));
  const detail = await readJson(await ctx.fetch(req(`/api/reconciliations/${reconciliationId}`, { cookie: ctx.cookies.treasurer })));
  const match = await post(ctx, `/api/reconciliations/${reconciliationId}/matches`, {
    statementLineId: detail.body.lines[0].id, ledgerEntryId: entryId,
  });
  assert.equal(match.status, 201, JSON.stringify(match.body));
  return { reconciliationId, matchId: match.body.match.id };
}

test('przeksięgowanie wpisu z powiązaniem w szkicu uzgodnienia: 409 active_bank_match, po cofnięciu przechodzi', async () => {
  const ctx = await setup();
  const { db } = ctx;
  try {
    const entryId = await createEntry(ctx, { amountCents: 4000 });
    const { reconciliationId, matchId } = await matchEntry(ctx, { entryId, amountCents: 4000 });
    const blocked = await post(ctx, `/api/ledger/${entryId}/replacement`, replBody({ amountCents: 4000, categoryId: 'cat-in-b' }));
    assert.deepEqual([blocked.status, blocked.body.error, blocked.body.reconciliationId], [409, 'active_bank_match', reconciliationId]);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ledger_corrections')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ledger_entries WHERE replaces_entry_id IS NOT NULL')).rows[0].n, 0);

    const revoke = await post(ctx, `/api/reconciliations/${reconciliationId}/matches/${matchId}/revocation`, { reason: 'Przed przeksięgowaniem' });
    assert.equal(revoke.status, 200, JSON.stringify(revoke.body));
    const ok = await post(ctx, `/api/ledger/${entryId}/replacement`, replBody({ amountCents: 4000, categoryId: 'cat-in-b' }));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  } finally { await db.close(); }
});

test('przeksięgowanie po zatwierdzonym uzgodnieniu: przechodzi, ostrzega, raport KR pokazuje przeksięgowanie', async () => {
  const ctx = await setup();
  const { db } = ctx;
  try {
    const entryId = await createEntry(ctx, { amountCents: 4000 });
    const { reconciliationId } = await matchEntry(ctx, { entryId, amountCents: 4000 });
    const confirm = await post(ctx, `/api/reconciliations/${reconciliationId}/confirm`, { confirmationNote: 'Zatwierdzone w teście' }, ctx.cookies.board);
    assert.equal(confirm.status, 200, JSON.stringify(confirm.body));

    const res = await post(ctx, `/api/ledger/${entryId}/replacement`, replBody({
      amountCents: 4000, categoryId: 'cat-in-b', reason: 'Zła kategoria po uzgodnieniu',
    }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.warnings, [{ type: 'confirmed_reconciliation_affected', reconciliationIds: [reconciliationId] }]);
    const audit = (await db.query("SELECT metadata_json FROM audit_events WHERE action = 'ledger.entry.replaced'")).rows[0];
    const meta = typeof audit.metadata_json === 'string' ? JSON.parse(audit.metadata_json) : audit.metadata_json;
    assert.deepEqual(meta.confirmedReconciliationIds, [reconciliationId]);

    // Zatwierdzone uzgodnienie i jego powiązanie pozostają bez zmian.
    const rec = (await db.query('SELECT status FROM bank_reconciliations WHERE id = $1', [reconciliationId])).rows[0];
    assert.equal(rec.status, 'confirmed');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM bank_reconciliation_matches WHERE ledger_entry_id = $1 AND revoked_at IS NULL', [entryId])).rows[0].n, 1);
    // #144: lista księgi pokazuje łańcuch w obu kierunkach także po zatwierdzonym uzgodnieniu.
    const list = await readJson(await ctx.fetch(req(`/api/ledger?schoolYearId=${YEAR}`, { cookie: ctx.cookies.treasurer })));
    assert.equal(list.status, 200);
    assert.equal(list.body.entries.find((e) => e.id === entryId).replacedByEntryId, res.body.entry.id);
    assert.equal(list.body.entries.find((e) => e.id === res.body.entry.id).replacesEntryId, entryId);

    const report = await readJson(await ctx.fetch(req(`/api/reports/audit?schoolYearId=${YEAR}&format=json`, { cookie: ctx.cookies.audit })));
    assert.equal(report.status, 200, JSON.stringify(report.body));
    const [item] = report.body.report.reclassifications;
    assert.equal(report.body.report.reclassifications.length, 1);
    assert.deepEqual(
      [item.replacesEntryId, item.id, item.oldCategory, item.newCategory, item.stornoCents, item.amountCents, item.reason, item.paymentLinked, item.inConfirmedReconciliation],
      [entryId, res.body.entry.id, 'Składki A', 'Składki B', 4000, 4000, 'Zła kategoria po uzgodnieniu', false, true]);
    assert.doesNotMatch(JSON.stringify(item), /example\.invalid|Wpis syntetyczny/);
    const html = await ctx.fetch(req(`/api/reports/audit?schoolYearId=${YEAR}&format=html`, { cookie: ctx.cookies.audit }));
    assert.match(await html.text(), /Przeksięgowania \(storno/);
  } finally { await db.close(); }
});

test('zmiana daty przez granicę zatwierdzonego uzgodnienia zgłasza wpływ na jego saldo', async () => {
  const ctx = await setup();
  const { db } = ctx;
  try {
    const entryId = await createEntry(ctx, { amountCents: 4000, occurredOn: '2026-10-05' });
    const otherId = await createEntry(ctx, { amountCents: 1000, occurredOn: '2026-10-06' });
    const { reconciliationId } = await matchEntry(ctx, { entryId: otherId, amountCents: 1000, statementDate: '2026-10-31', bookedOn: '2026-10-06' });
    await post(ctx, `/api/reconciliations/${reconciliationId}/confirm`, { confirmationNote: 'Zatwierdzone; różnica: wpis bez pozycji' }, ctx.cookies.board);
    // Wpis niepowiązany z uzgodnieniem, ale jego data przechodzi za dzień wyciągu.
    const res = await post(ctx, `/api/ledger/${entryId}/replacement`, replBody({
      amountCents: 4000, occurredOn: '2026-11-05', reason: 'Zła data',
    }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.warnings?.[0]?.reconciliationIds, [reconciliationId]);
    // Zmiana kategorii bez wpływu na saldo — bez ostrzeżenia.
    const quiet = await post(ctx, `/api/ledger/${res.body.entry.id}/replacement`, replBody({
      amountCents: 4000, occurredOn: '2026-11-05', categoryId: 'cat-in-b', reason: 'Kategoria',
    }));
    assert.equal(quiet.status, 201, JSON.stringify(quiet.body));
    assert.equal(quiet.body.warnings, undefined);
  } finally { await db.close(); }
});

// --- atomowość, idempotencja, role ---------------------------------------------------

test('błąd audytu wycofuje storno, wpis zastępczy i wersje przypisania (linked + centra kosztów)', async () => {
  const ctx = await setup();
  const { db } = ctx;
  try {
    const { paymentId, entryId } = await createLinkedEntry(ctx);
    assert.equal((await allocate(ctx, entryId, [{ eventId: 'ev-1', amountCents: 5000 }])).status, 201);
    await db.exec(`
      CREATE FUNCTION test_fail_replaced_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'ledger.entry.replaced' THEN RAISE EXCEPTION 'test_audit_failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER test_fail_replaced_audit BEFORE INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION test_fail_replaced_audit();`);
    const res = await ctx.fetch(req(`/api/ledger/${entryId}/replacement`, {
      cookie: ctx.cookies.treasurer, key: ctx.key('k'), body: replBody({ amountCents: 5000, categoryId: 'cat-in-b' }),
    }));
    assert.ok(res.status >= 500, `status ${res.status}`);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ledger_corrections')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ledger_entries WHERE replaces_entry_id IS NOT NULL')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ledger_allocation_versions')).rows[0].n, 1);
    assert.equal(await countLinkedNet(db, paymentId), 1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ledger_current_allocations WHERE ledger_entry_id = $1', [entryId])).rows[0].n, 1);
  } finally { await db.close(); }
});

test('podwójne kliknięcie wpisu powiązanego z wpłatą i przypisanego: jedno storno, jeden wpis, jedno przypisanie; inna treść 409', async () => {
  const ctx = await setup();
  const { db } = ctx;
  try {
    const { entryId } = await createLinkedEntry(ctx);
    assert.equal((await allocate(ctx, entryId, [{ eventId: 'ev-1', amountCents: 5000 }])).status, 201);
    const body = replBody({ amountCents: 5000, categoryId: 'cat-in-b' });
    const key = ctx.key('k-dbl');
    const both = await Promise.all([post(ctx, `/api/ledger/${entryId}/replacement`, body, ctx.cookies.treasurer, key),
      post(ctx, `/api/ledger/${entryId}/replacement`, body, ctx.cookies.treasurer, key)]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 201], JSON.stringify(both.map((r) => r.body)));
    assert.equal(both[0].body.entry.id, both[1].body.entry.id);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ledger_corrections')).rows[0].n, 1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ledger_entries WHERE replaces_entry_id IS NOT NULL')).rows[0].n, 1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ledger_allocation_versions')).rows[0].n, 3);
    const other = await post(ctx, `/api/ledger/${entryId}/replacement`, replBody({ amountCents: 5000, categoryId: 'cat-in-a' }),
      ctx.cookies.treasurer, key);
    assert.deepEqual([other.status, other.body.error], [409, 'idempotency_conflict']);
  } finally { await db.close(); }
});

test('granice ról: tylko skarbnik/zarząd z MFA; przedstawiciel, audit, dyrekcja, brak MFA i brak sesji odrzucone', async () => {
  const ctx = await setup();
  const { db } = ctx;
  try {
    const { entryId } = await createLinkedEntry(ctx);
    const body = replBody({ amountCents: 5000, categoryId: 'cat-in-b' });
    for (const who of ['rep', 'audit', 'principal', 'noMfa']) {
      const res = await post(ctx, `/api/ledger/${entryId}/replacement`, body, ctx.cookies[who]);
      assert.equal(res.status, 403, `${who}: ${JSON.stringify(res.body)}`);
    }
    const anonymous = await readJson(await ctx.fetch(req(`/api/ledger/${entryId}/replacement`, { key: ctx.key('k'), body })));
    assert.equal(anonymous.status, 401);
    // Zły Origin (CSRF) — odrzucone bez zapisu.
    const noOrigin = await ctx.fetch(new Request(`${TEST_ORIGIN}/api/ledger/${entryId}/replacement`, {
      method: 'POST', headers: { Cookie: ctx.cookies.treasurer, 'Content-Type': 'application/json', 'Idempotency-Key': ctx.key('k'), Origin: 'https://evil.example.invalid' },
      body: JSON.stringify(body),
    }));
    assert.equal(noOrigin.status, 403);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ledger_corrections')).rows[0].n, 0);
    const board = await post(ctx, `/api/ledger/${entryId}/replacement`, body, ctx.cookies.board);
    assert.equal(board.status, 201, JSON.stringify(board.body));
  } finally { await db.close(); }
});

test('rok zamknięty: przeksięgowanie wpisu powiązanego z wpłatą i przypisanego — 409 school_year_closed, bez zapisu', async () => {
  const ctx = await setup();
  const { db } = ctx;
  try {
    const { entryId } = await createLinkedEntry(ctx);
    assert.equal((await allocate(ctx, entryId, [{ eventId: 'ev-1', amountCents: 5000 }])).status, 201);
    await seedSchoolYear(db, 'y-144l-next', { startsOn: '2027-09-01', endsOn: '2028-08-31' });
    // Stan „zamknięty” wprost (bez przebiegu zamknięcia), jak w tests/pg-ledger-replacement.test.js.
    await db.exec(`
      SET session_replication_role = replica;
      INSERT INTO school_year_closures (id, school_year_id, next_school_year_id, status, initiated_by,
        closed_by, closed_at, income_cents, expense_cents, opening_balance_cents, closing_balance_cents,
        carried_opening_balance_id, expired_grant_count)
      VALUES ('cl-144l', '${YEAR}', 'y-144l-next', 'closed', 'u-t', 'u-closer-x', now(), 0, 0, 0, 0, 'ob-x', 0);
      SET session_replication_role = origin;
    `);
    const res = await post(ctx, `/api/ledger/${entryId}/replacement`, replBody({ amountCents: 5000, categoryId: 'cat-in-b' }));
    assert.deepEqual([res.status, res.body.error], [409, 'school_year_closed']);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ledger_corrections')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ledger_allocation_versions')).rows[0].n, 1);
  } finally { await db.close(); }
});
