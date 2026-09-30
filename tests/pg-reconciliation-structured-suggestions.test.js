// #115 pkt 2: propozycje dopasowania korzystają z rejestru komunikacji
// strukturalnej OGM-VCS (payment_references, #83) — pozycja, której tytuł to
// aktywna referencja rodziny, dostaje kandydata `household` i oznaczenie
// `structuredReferenceMatch` przy istniejących wpłatach tej rodziny. Nic nie
// jest zatwierdzane automatycznie. Wyłącznie dane syntetyczne; kwoty w centach.
// Działa na PGlite i (RD_TEST_PG_BACKEND=real) na PostgreSQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { formatStructuredReference, generateStructuredReference } from '../src/pg/ogm.js';
import { createTestDb, request, seedEnrolledHousehold, seedSchoolYear, seedUserSession } from './helpers/pg.js';
import { assertEvery } from './helpers/assertions.js';

const YEAR = 'y-115s';
const NEXT = 'y-115s-next';
let keySeq = 0;
const key = (prefix = 'k') => `${prefix}-115s-${String(++keySeq).padStart(6, '0')}`;

async function setup() {
  const db = await createTestDb();
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, NEXT, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: YEAR }], mfa: true }),
    rep: await seedUserSession(db, {
      userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }], mfa: true,
    }),
    audit: await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit', schoolYearId: YEAR }], mfa: true }),
  };
  const call = async (path, { cookie, body, idempotencyKey } = {}) => {
    const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
    const response = await handlePgRequest(request(path, {
      cookie, headers, method: body === undefined ? 'GET' : 'POST', body,
    }), { db });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { db, cookies, call };
}

// Referencja w rejestrze — wprost w bazie (trasa rejestru ma własne testy, #83).
async function seedReference(db, householdId, schoolYearId = YEAR) {
  const reference = generateStructuredReference();
  const id = `pr-${householdId}-${schoolYearId}`;
  await db.query(
    `INSERT INTO payment_references (id, school_year_id, household_id, structured_reference, created_by, idempotency_key)
     VALUES ($1, $2, $3, $4, 'u-treasurer', $5)`,
    [id, schoolYearId, householdId, reference, key('pref')],
  );
  return { id, reference, formatted: formatStructuredReference(reference) };
}

async function seedPayment(db, id, householdId, amountCents, receivedOn, method = 'bank') {
  await db.query(
    `INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, 'recorded', 'u-treasurer', $7)`,
    [id, householdId, YEAR, amountCents, receivedOn, method, key('pay')],
  );
}

async function createDraft(call, cookie) {
  const res = await call('/api/reconciliations', {
    cookie, idempotencyKey: key('rec'),
    body: { schoolYearId: YEAR, statementDate: '2026-10-31', statementBalanceCents: 0 },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.reconciliation.id;
}

// lines: [{ amountCents, reference?, bookedOn? }] → identyfikatory w tej kolejności.
async function importLines(call, db, cookie, reconciliationId, lines) {
  const res = await call(`/api/reconciliations/${reconciliationId}/lines`, {
    cookie, idempotencyKey: key('imp'),
    body: { lines: lines.map((line) => ({ bookedOn: '2026-10-06', ...line })) },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const { rows } = await db.query('SELECT id FROM bank_statement_lines WHERE import_id = $1 ORDER BY line_no', [res.body.import.id]);
  return rows.map((row) => row.id);
}

async function suggestionsFor(call, cookie, reconciliationId) {
  const res = await call(`/api/reconciliations/${reconciliationId}/suggestions?windowDays=7`, { cookie });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return new Map(res.body.suggestions.map((s) => [s.statementLineId, s]));
}

const householdCandidates = (suggestion) => (suggestion?.candidates ?? []).filter((c) => c.type === 'household');

async function counts(db) {
  const one = async (sql) => Number((await db.query(sql)).rows[0].n);
  return {
    payments: await one('SELECT count(*) AS n FROM payment_entries'),
    matches: await one('SELECT count(*) AS n FROM bank_reconciliation_matches'),
    audit: await one('SELECT count(*) AS n FROM audit_events'),
  };
}

const linePayment = (call, cookie, reconciliationId, lineId, householdId, idempotencyKey = key('lp')) =>
  call(`/api/reconciliations/${reconciliationId}/lines/${lineId}/payment`, {
    cookie, idempotencyKey, body: { householdId },
  });

test('a line titled with a family structured reference proposes that household, only as a suggestion', async () => {
  const { db, cookies, call } = await setup();
  try {
    await seedEnrolledHousehold(db, 'h-1', [YEAR]);
    await seedEnrolledHousehold(db, 'h-2', [YEAR]);
    const r1 = await seedReference(db, 'h-1');
    const r2 = await seedReference(db, 'h-2');
    const reconciliationId = await createDraft(call, cookies.treasurer);
    const [formatted, bare, spaced, surrounded, other] = await importLines(call, db, cookies.treasurer, reconciliationId, [
      { amountCents: 2500, reference: r1.formatted }, // CODA 101: +++ddd/dddd/ddddd+++
      { amountCents: 2500, reference: r2.reference }, // CAMT Strd/Ref: 12 cyfr
      { amountCents: 2500, reference: `  ${r1.formatted.replace('+++', '***').replace(/\+\+\+$/, '***')} ` },
      { amountCents: 2500, reference: `Składka ${r1.formatted}` },
      { amountCents: 2500, reference: 'Tytuł syntetyczny bez referencji' },
    ]);
    const before = await counts(db);
    const byLine = await suggestionsFor(call, cookies.treasurer, reconciliationId);

    assert.deepEqual(householdCandidates(byLine.get(formatted)).map((c) => [c.householdId, c.structuredReferenceMatch, c.amountCents]),
      [['h-1', true, 2500]]);
    assert.deepEqual(householdCandidates(byLine.get(bare)).map((c) => c.householdId), ['h-2']);
    assert.deepEqual(householdCandidates(byLine.get(spaced)).map((c) => c.householdId), ['h-1']);
    // Referencja w środku dłuższego tytułu: serwer zna tylko skrót całego tytułu — bez propozycji.
    assert.deepEqual(householdCandidates(byLine.get(surrounded)), []);
    assert.deepEqual(householdCandidates(byLine.get(other)), []);
    // Odczyt propozycji niczego nie zapisuje (ani wpłaty, ani powiązania, ani zdarzenia).
    assert.deepEqual(await counts(db), before);
    // Odpowiedź nie zawiera referencji ani tytułu.
    const raw = JSON.stringify([...byLine.values()]);
    assert.doesNotMatch(raw, new RegExp(r1.reference));
    assert.doesNotMatch(raw, new RegExp(r2.reference));
  } finally {
    await db.close();
  }
});

test('revoked, other-year and expense-line references give no household proposal; cash is never proposed', async () => {
  const { db, cookies, call } = await setup();
  try {
    await seedEnrolledHousehold(db, 'h-1', [YEAR]);
    await seedEnrolledHousehold(db, 'h-2', [YEAR, NEXT]);
    await seedEnrolledHousehold(db, 'h-3', [YEAR]);
    const revoked = await seedReference(db, 'h-1');
    await db.query(
      `INSERT INTO payment_reference_revocations (id, payment_reference_id, reason, created_by, idempotency_key)
       VALUES ('prr-1', $1, 'Referencja syntetyczna unieważniona', 'u-treasurer', $2)`, [revoked.id, key('prr')],
    );
    const otherYear = await seedReference(db, 'h-2', NEXT);
    const active = await seedReference(db, 'h-3');
    // Wpłata gotówkowa rodziny h-3 tej samej kwoty i daty: nie jest kandydatem do pozycji bankowej.
    await seedPayment(db, 'p-cash', 'h-3', 2500, '2026-10-06', 'cash');
    const reconciliationId = await createDraft(call, cookies.treasurer);
    const [revokedLine, otherYearLine, expenseLine, activeLine] = await importLines(call, db, cookies.treasurer, reconciliationId, [
      { amountCents: 2500, reference: revoked.formatted },
      { amountCents: 2500, reference: otherYear.formatted },
      { amountCents: -2500, reference: active.formatted },
      { amountCents: 2500, reference: active.formatted },
    ]);
    const byLine = await suggestionsFor(call, cookies.treasurer, reconciliationId);
    assert.deepEqual(householdCandidates(byLine.get(revokedLine)), []);
    assert.deepEqual(householdCandidates(byLine.get(otherYearLine)), []);
    assert.deepEqual(householdCandidates(byLine.get(expenseLine)), []);
    const activeCandidates = byLine.get(activeLine).candidates;
    assert.deepEqual(activeCandidates.map((c) => [c.type, c.id]), [['household', 'h-3']]);
    assert.ok(!JSON.stringify([...byLine.values()]).includes('p-cash'), 'gotówka nie jest proponowana');
  } finally {
    await db.close();
  }
});

test('the family payment is flagged and ranked first even behind many same-amount payments of other families', async () => {
  const { db, cookies, call } = await setup();
  try {
    await seedEnrolledHousehold(db, 'h-1', [YEAR]);
    await seedEnrolledHousehold(db, 'h-noise', [YEAR]);
    const ref = await seedReference(db, 'h-1');
    // 25 wpłat innej rodziny w dniu pozycji (więcej niż zapas MAX_CANDIDATES*4 = 20)
    // i jedna wpłata rodziny h-1 sześć dni wcześniej.
    for (let i = 0; i < 25; i += 1) await seedPayment(db, `p-noise-${String(i).padStart(2, '0')}`, 'h-noise', 2500, '2026-10-06');
    await seedPayment(db, 'p-family', 'h-1', 2500, '2026-09-30');
    const reconciliationId = await createDraft(call, cookies.treasurer);
    const [lineId, plainLine] = await importLines(call, db, cookies.treasurer, reconciliationId, [
      { amountCents: 2500, reference: ref.formatted },
      { amountCents: 2500, reference: 'Tytuł syntetyczny' },
    ]);
    const byLine = await suggestionsFor(call, cookies.treasurer, reconciliationId);
    const candidates = byLine.get(lineId).candidates;
    assert.equal(candidates.length, 5);
    assert.deepEqual([candidates[0].type, candidates[0].id, candidates[0].structuredReferenceMatch, candidates[0].dayDistance],
      ['payment_entry', 'p-family', true, 6]);
    // Druga: propozycja nowej wpłaty tej rodziny; dalej zwykłe kandydatury po dacie.
    assert.deepEqual([candidates[1].type, candidates[1].householdId], ['household', 'h-1']);
    assertEvery(candidates.slice(2), (c) => c.type === 'payment_entry' && !c.structuredReferenceMatch && c.dayDistance === 0);
    // Pozycja bez referencji: kolejność jak dotąd (najbliższe dniowo), bez oznaczeń.
    const plain = byLine.get(plainLine).candidates;
    assert.deepEqual(plain.map((c) => c.id), ['p-noise-00', 'p-noise-01', 'p-noise-02', 'p-noise-03', 'p-noise-04']);
    assertEvery(plain, (c) => c.structuredReferenceMatch === false);

    // Zatwierdzenie wymaga jawnego żądania (tu: wsad z jedną wskazaną parą).
    const batch = await call(`/api/reconciliations/${reconciliationId}/matches/batch`, {
      cookie: cookies.treasurer, idempotencyKey: key('batch'),
      body: { matches: [{ statementLineId: lineId, paymentEntryId: 'p-family' }] },
    });
    assert.equal(batch.status, 201, JSON.stringify(batch.body));
    const after = await suggestionsFor(call, cookies.treasurer, reconciliationId);
    assert.equal(after.has(lineId), false, 'dopasowana pozycja znika z propozycji');
    assert.ok(!after.get(plainLine).candidates.some((c) => c.id === 'p-family'), 'powiązana wpłata nie jest już kandydatem');
  } finally {
    await db.close();
  }
});

test('two guardians of one child pay 10 and 15 EUR with the family reference: two independent payments, one household', async () => {
  const { db, cookies, call } = await setup();
  try {
    await seedEnrolledHousehold(db, 'h-1', [YEAR]);
    await db.query(`INSERT INTO guardians (id, household_id, first_name, last_name, email)
      VALUES ('g-1', 'h-1', 'Opiekun', 'Pierwszy', 'g1@example.invalid'), ('g-2', 'h-1', 'Opiekun', 'Drugi', 'g2@example.invalid')`);
    await db.query(`INSERT INTO student_guardians (student_id, guardian_id) VALUES ('st-h-1', 'g-1'), ('st-h-1', 'g-2')`);
    const ref = await seedReference(db, 'h-1');
    const reconciliationId = await createDraft(call, cookies.treasurer);
    const [first, second] = await importLines(call, db, cookies.treasurer, reconciliationId, [
      { amountCents: 1000, reference: ref.formatted, bookedOn: '2026-10-06' },
      { amountCents: 1500, reference: ref.reference, bookedOn: '2026-10-20' },
    ]);
    const byLine = await suggestionsFor(call, cookies.treasurer, reconciliationId);
    for (const lineId of [first, second]) {
      assert.deepEqual(householdCandidates(byLine.get(lineId)).map((c) => c.householdId), ['h-1']);
    }
    // Skarbnik klika propozycję: wpłata z pozycji dla wskazanej rodziny. Podwójne kliknięcie = jedna wpłata.
    const idempotencyKey = key('lp');
    const created = await linePayment(call, cookies.treasurer, reconciliationId, first, 'h-1', idempotencyKey);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const replay = await linePayment(call, cookies.treasurer, reconciliationId, first, 'h-1', idempotencyKey);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.payment.id, created.body.payment.id);
    const secondPayment = await linePayment(call, cookies.treasurer, reconciliationId, second, 'h-1');
    assert.equal(secondPayment.status, 201, JSON.stringify(secondPayment.body));

    const payments = await db.query(
      "SELECT amount_cents, status FROM payment_entries WHERE household_id = 'h-1' ORDER BY amount_cents",
    );
    assert.deepEqual(payments.rows.map((r) => [Number(r.amount_cents), r.status]), [[1000, 'recorded'], [1500, 'recorded']]);
    const totals = await db.query(
      'SELECT net_amount_cents FROM household_payment_totals WHERE household_id = $1 AND school_year_id = $2', ['h-1', YEAR],
    );
    assert.equal(Number(totals.rows[0].net_amount_cents), 2500);
    // Składki dobrowolne: odpowiedź nie liczy „pozostało do zapłaty”.
    for (const body of [created.body, secondPayment.body]) {
      assert.doesNotMatch(JSON.stringify(body), /remaining|outstanding|due|debt/i);
    }
    const after = await suggestionsFor(call, cookies.treasurer, reconciliationId);
    assert.equal(after.size, 0, 'obie pozycje są dopasowane');
  } finally {
    await db.close();
  }
});

test('siblings in one household and one transfer: one household proposal and one payment', async () => {
  const { db, cookies, call } = await setup();
  try {
    await seedEnrolledHousehold(db, 'h-sib', [YEAR]);
    await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ('st-h-sib-2', 'h-sib', 'Syntetyczne', 'Rodzeństwo')");
    await db.query(`INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('enr-sib-2', 'st-h-sib-2', $1, $2)`,
      [`cls-enr-${YEAR}`, YEAR]);
    const ref = await seedReference(db, 'h-sib');
    const reconciliationId = await createDraft(call, cookies.treasurer);
    const [lineId] = await importLines(call, db, cookies.treasurer, reconciliationId, [{ amountCents: 5000, reference: ref.formatted }]);
    const byLine = await suggestionsFor(call, cookies.treasurer, reconciliationId);
    assert.deepEqual(householdCandidates(byLine.get(lineId)).map((c) => c.householdId), ['h-sib']);
    const created = await linePayment(call, cookies.treasurer, reconciliationId, lineId, 'h-sib');
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const payments = await db.query("SELECT count(*) AS n, sum(amount_cents) AS total FROM payment_entries WHERE household_id = 'h-sib'");
    assert.equal(Number(payments.rows[0].n), 1);
    assert.equal(Number(payments.rows[0].total), 5000);
  } finally {
    await db.close();
  }
});

test('a refund of a line payment (#538) matches a negative line; the refund line gets no household or payment proposal', async () => {
  const { db, cookies, call } = await setup();
  try {
    await seedEnrolledHousehold(db, 'h-1', [YEAR]);
    const ref = await seedReference(db, 'h-1');
    const reconciliationId = await createDraft(call, cookies.treasurer);
    const [incoming, outgoing] = await importLines(call, db, cookies.treasurer, reconciliationId, [
      { amountCents: 2500, reference: ref.formatted },
      { amountCents: -1000, reference: ref.formatted, bookedOn: '2026-10-08' },
    ]);
    const created = await linePayment(call, cookies.treasurer, reconciliationId, incoming, 'h-1');
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const refund = await call(`/api/payments/${created.body.payment.id}/refunds`, {
      cookie: cookies.treasurer, idempotencyKey: key('ref'),
      body: { amountCents: 1000, refundedOn: '2026-10-08', method: 'bank', reason: 'Zwrot syntetyczny na prośbę rodziny' },
    });
    assert.equal(refund.status, 201, JSON.stringify(refund.body));

    const byLine = await suggestionsFor(call, cookies.treasurer, reconciliationId);
    assert.deepEqual(byLine.get(outgoing).candidates, [], 'ujemna pozycja: bez propozycji wpłaty ani nowej wpłaty');
    const matched = await call(`/api/reconciliations/${reconciliationId}/matches`, {
      cookie: cookies.treasurer, idempotencyKey: key('m'),
      body: { statementLineId: outgoing, paymentRefundId: refund.body.refund.id },
    });
    assert.equal(matched.status, 201, JSON.stringify(matched.body));
    // Zwrot nie zmniejsza kwoty wpłaty w powiązaniu (dwa osobne zdarzenia bankowe) — brak niespójności.
    const detail = await call(`/api/reconciliations/${reconciliationId}`, { cookie: cookies.treasurer });
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.inconsistentMatches, []);
    assert.equal(detail.body.summary.matchedLineCount, 2);
  } finally {
    await db.close();
  }
});

test('structured suggestions stay forbidden for representatives and auditors', async () => {
  const { db, cookies, call } = await setup();
  try {
    await seedEnrolledHousehold(db, 'h-1', [YEAR]);
    const ref = await seedReference(db, 'h-1');
    const reconciliationId = await createDraft(call, cookies.treasurer);
    await importLines(call, db, cookies.treasurer, reconciliationId, [{ amountCents: 2500, reference: ref.formatted }]);
    for (const cookie of [cookies.rep, cookies.audit]) {
      const res = await call(`/api/reconciliations/${reconciliationId}/suggestions`, { cookie });
      assert.equal(res.status, 403);
      assert.doesNotMatch(JSON.stringify(res.body), /h-1/);
    }
  } finally {
    await db.close();
  }
});
