// #83 (follow-up #580, migracja 0158): import wyciągu zapisuje osobny solony
// skrót komunikacji strukturalnej OGM-VCS wyodrębnionej z tytułu, więc
// propozycje rozpoznają referencję rodziny także otoczoną innym tekstem
// („Składka +++…+++ Jan”). Nic nie jest zatwierdzane automatycznie.
// Wyłącznie dane syntetyczne; kwoty w centach. PGlite i (RD_TEST_PG_BACKEND=real)
// prawdziwy PostgreSQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { handlePgRequest } from '../src/pg/app.js';
import { formatStructuredReference, generateStructuredReference, isValidStructuredReference } from '../src/pg/ogm.js';
import { hashStructuredReference } from '../src/pg/routes/reconciliation.js';
import { createTestDb, request, seedEnrolledHousehold, seedSchoolYear, seedUserSession } from './helpers/pg.js';
import { camtFile, codaFile } from './helpers/bank-statements.js';
import { assertEvery } from './helpers/assertions.js';

const YEAR = 'y-83h';
const NEXT = 'y-83h-next';
const CONFIG = { BANK_TRANSACTION_HASH_KEY: 'test-only-hmac-key-0123456789abcdef', RECONCILIATION_BANK_ACCOUNT_IBAN: 'BE68 5390 0754 7034' };
let keySeq = 0;
const key = (prefix = 'k') => `${prefix}-83h-${String(++keySeq).padStart(6, '0')}`;

async function setup() {
  const db = await createTestDb();
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, NEXT, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: YEAR }], mfa: true }),
    rep: await seedUserSession(db, {
      userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }], mfa: true,
    }),
  };
  const call = async (path, { cookie, body, idempotencyKey } = {}) => {
    const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
    const response = await handlePgRequest(request(path, {
      cookie, headers, method: body === undefined ? 'GET' : 'POST', body,
    }), { db, ...CONFIG });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { db, cookies, call };
}

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

async function createDraft(call, cookie, statementDate = '2026-10-31') {
  const res = await call('/api/reconciliations', {
    cookie, idempotencyKey: key('rec'),
    body: { schoolYearId: YEAR, statementDate, statementBalanceCents: 0 },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.reconciliation.id;
}

async function lineIds(db, importId) {
  const { rows } = await db.query('SELECT id FROM bank_statement_lines WHERE import_id = $1 ORDER BY line_no', [importId]);
  return rows.map((row) => row.id);
}

async function importLines(call, db, cookie, reconciliationId, lines, idempotencyKey = key('imp')) {
  const res = await call(`/api/reconciliations/${reconciliationId}/lines`, {
    cookie, idempotencyKey,
    body: { lines: lines.map((line) => ({ bookedOn: '2026-10-06', ...line })) },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return lineIds(db, res.body.import.id);
}

async function suggestionsFor(call, cookie, reconciliationId) {
  const res = await call(`/api/reconciliations/${reconciliationId}/suggestions?windowDays=7`, { cookie });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return new Map(res.body.suggestions.map((s) => [s.statementLineId, s]));
}

const households = (suggestion) => (suggestion?.candidates ?? []).filter((c) => c.type === 'household').map((c) => c.householdId);

// Jedna cyfra zmieniona tak, żeby suma kontrolna mod 97 przestała się zgadzać.
function typo(reference) {
  for (let digit = 1; digit < 10; digit += 1) {
    const changed = reference.slice(0, 4) + String((Number(reference[4]) + digit) % 10) + reference.slice(5);
    if (!isValidStructuredReference(changed)) return changed;
  }
  throw new Error('brak wariantu z literówką');
}

const linePayment = (call, cookie, reconciliationId, lineId, householdId, idempotencyKey = key('lp')) =>
  call(`/api/reconciliations/${reconciliationId}/lines/${lineId}/payment`, { cookie, idempotencyKey, body: { householdId } });

test('a reference surrounded by other text proposes the household; typo, two references and no reference do not', async () => {
  const { db, cookies, call } = await setup();
  try {
    await seedEnrolledHousehold(db, 'h-1', [YEAR]);
    await seedEnrolledHousehold(db, 'h-2', [YEAR]);
    const r1 = await seedReference(db, 'h-1');
    const r2 = await seedReference(db, 'h-2');
    const reconciliationId = await createDraft(call, cookies.treasurer);
    const [plusText, starsText, bareText, repeated, withTypo, twoRefs, plusAndBare, none] = await importLines(
      call, db, cookies.treasurer, reconciliationId, [
        { amountCents: 2500, reference: `Składka ${r1.formatted} Jan` },
        { amountCents: 2500, reference: `RR 2026/2027 ${r2.formatted.replaceAll('+++', '***')} dziękujemy` },
        { amountCents: 2500, reference: `przelew ${r1.reference} rada` },
        { amountCents: 2500, reference: `${r2.formatted} (${r2.formatted})` },
        { amountCents: 2500, reference: `Składka ${formatStructuredReference(typo(r1.reference))}` },
        { amountCents: 2500, reference: `Składka ${r1.formatted} i ${r2.formatted}` },
        // Zapis z plusami ma pierwszeństwo przed samymi cyframi (np. numerem w dalszej części tytułu).
        { amountCents: 2500, reference: `${r1.formatted} nr ${r2.reference}` },
        { amountCents: 2500, reference: 'Składka syntetyczna bez komunikacji' },
      ]);
    const byLine = await suggestionsFor(call, cookies.treasurer, reconciliationId);
    assert.deepEqual(households(byLine.get(plusText)), ['h-1']);
    assert.deepEqual(households(byLine.get(starsText)), ['h-2']);
    assert.deepEqual(households(byLine.get(bareText)), ['h-1']);
    assert.deepEqual(households(byLine.get(repeated)), ['h-2']);
    assert.deepEqual(households(byLine.get(withTypo)), [], 'literówka (mod 97) nie wskazuje rodziny');
    assert.deepEqual(households(byLine.get(twoRefs)), [], 'dwie różne referencje: nie zgadujemy');
    assert.deepEqual(households(byLine.get(plusAndBare)), ['h-1']);
    assert.deepEqual(households(byLine.get(none)), []);
    // Propozycja zawsze wymaga kliknięcia — nic nie powstało.
    const { rows } = await db.query('SELECT count(*) AS n FROM payment_entries');
    assert.equal(Number(rows[0].n), 0);
    const matches = await db.query('SELECT count(*) AS n FROM bank_reconciliation_matches');
    assert.equal(Number(matches.rows[0].n), 0);
  } finally {
    await db.close();
  }
});

test('the database stores only a salted hash of the extracted reference, never the reference or title', async () => {
  const { db, cookies, call } = await setup();
  try {
    await seedEnrolledHousehold(db, 'h-1', [YEAR]);
    const r1 = await seedReference(db, 'h-1');
    const reconciliationId = await createDraft(call, cookies.treasurer);
    const title = `Składka ${r1.formatted} Jan`;
    const [withRef, withTypo, noTitle] = await importLines(call, db, cookies.treasurer, reconciliationId, [
      { amountCents: 2500, reference: title },
      { amountCents: 2500, reference: `Składka ${formatStructuredReference(typo(r1.reference))}` },
      { amountCents: 2500 },
    ]);
    const { rows: [salt] } = await db.query('SELECT reference_salt FROM bank_reconciliations WHERE id = $1', [reconciliationId]);
    const { rows } = await db.query(
      'SELECT id, reference_hash, structured_ref_hash FROM bank_statement_lines WHERE reconciliation_id = $1', [reconciliationId],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const expected = createHash('sha256').update(`${salt.reference_salt}:ogm:${r1.reference}`).digest('hex');
    assert.equal(byId.get(withRef).structured_ref_hash, expected);
    assert.equal(await hashStructuredReference(salt.reference_salt, title.toLowerCase()), expected);
    assert.notEqual(byId.get(withRef).structured_ref_hash, byId.get(withRef).reference_hash);
    assert.equal(byId.get(withTypo).structured_ref_hash, null);
    assert.equal(byId.get(withTypo).reference_hash.length, 64);
    assert.equal(byId.get(noTitle).structured_ref_hash, null);
    assert.equal(byId.get(noTitle).reference_hash, null);
    const dump = JSON.stringify(rows);
    assert.ok(!dump.includes(r1.reference), 'referencja nie jest zapisana jawnie');
    // CHECK 0158: skrót referencji tylko przy pozycji ze skrótem tytułu.
    await assert.rejects(db.query(
      `INSERT INTO bank_statement_lines (id, reconciliation_id, import_id, line_no, booked_on, amount_cents, structured_ref_hash, created_by)
       SELECT 'bsl-83h-check', reconciliation_id, import_id, 99, booked_on, amount_cents, $2, created_by
         FROM bank_statement_lines WHERE id = $1`, [withRef, expected],
    ), /bank_statement_line_structured_ref_requires_title/);
  } finally {
    await db.close();
  }
});

test('CSV, CODA and CAMT.053 imports extract the reference from a free-text title', async () => {
  const { db, cookies, call } = await setup();
  try {
    await seedEnrolledHousehold(db, 'h-csv', [YEAR]);
    await seedEnrolledHousehold(db, 'h-coda', [YEAR]);
    await seedEnrolledHousehold(db, 'h-camt', [YEAR]);
    const csvRef = await seedReference(db, 'h-csv');
    const codaRef = await seedReference(db, 'h-coda');
    const camtRef = await seedReference(db, 'h-camt');

    const csvDraft = await createDraft(call, cookies.treasurer);
    const csv = await call(`/api/reconciliations/${csvDraft}/lines`, {
      cookie: cookies.treasurer, idempotencyKey: key('csv'),
      body: { csv: `data;kwota;tytuł\n2026-10-06;25,00;"Składka RR ${csvRef.formatted} dla rodziny"\n` },
    });
    assert.equal(csv.status, 201, JSON.stringify(csv.body));
    const [csvLine] = await lineIds(db, csv.body.import.id);
    assert.deepEqual(households((await suggestionsFor(call, cookies.treasurer, csvDraft)).get(csvLine)), ['h-csv']);

    const fileDraft = await createDraft(call, cookies.treasurer, '2026-09-30');
    const coda = await call(`/api/reconciliations/${fileDraft}/lines`, {
      cookie: cookies.treasurer, idempotencyKey: key('coda'),
      body: { coda: codaFile({ movements: [
        { seq: 1, bankRef: 'SYNTH83CODA0001', cents: 2500, bookedOn: '2026-09-14', communication: `Skladka ${codaRef.formatted} Jan` },
      ] }) },
    });
    assert.equal(coda.status, 201, JSON.stringify(coda.body));
    const camt = await call(`/api/reconciliations/${fileDraft}/lines`, {
      cookie: cookies.treasurer, idempotencyKey: key('camt'),
      body: { camt053: camtFile({ sequence: '2', openingCents: 102500, movements: [
        { ref: 'SYNTH83CAMT0001', cents: 1500, bookedOn: '2026-09-20', ustrd: `RR ${camtRef.reference} wplata` },
      ] }) },
    });
    assert.equal(camt.status, 201, JSON.stringify(camt.body));
    const [codaLine] = await lineIds(db, coda.body.import.id);
    const [camtLine] = await lineIds(db, camt.body.import.id);
    const byLine = await suggestionsFor(call, cookies.treasurer, fileDraft);
    assert.deepEqual(households(byLine.get(codaLine)), ['h-coda']);
    assert.deepEqual(households(byLine.get(camtLine)), ['h-camt']);
  } finally {
    await db.close();
  }
});

test('revoked and other-year references in a longer title give no proposal; old lines without the hash keep whole-title matching', async () => {
  const { db, cookies, call } = await setup();
  try {
    await seedEnrolledHousehold(db, 'h-rev', [YEAR]);
    await seedEnrolledHousehold(db, 'h-next', [YEAR, NEXT]);
    await seedEnrolledHousehold(db, 'h-old', [YEAR]);
    const revoked = await seedReference(db, 'h-rev');
    await db.query(
      `INSERT INTO payment_reference_revocations (id, payment_reference_id, reason, created_by, idempotency_key)
       VALUES ('prr-83h', $1, 'Referencja syntetyczna unieważniona', 'u-treasurer', $2)`, [revoked.id, key('prr')],
    );
    const nextYear = await seedReference(db, 'h-next', NEXT);
    const old = await seedReference(db, 'h-old');
    const reconciliationId = await createDraft(call, cookies.treasurer);
    const [revokedLine, nextYearLine] = await importLines(call, db, cookies.treasurer, reconciliationId, [
      { amountCents: 2500, reference: `Składka ${revoked.formatted}` },
      { amountCents: 2500, reference: `Składka ${nextYear.formatted}` },
    ]);
    // Pozycje sprzed 0158: skrót tytułu jest, skrótu referencji nie ma (przeliczenie
    // wstecz niemożliwe). Wstawione wprost, jak zapisał je import przed migracją.
    const { rows: [salt] } = await db.query('SELECT reference_salt FROM bank_reconciliations WHERE id = $1', [reconciliationId]);
    const titleHash = (title) => createHash('sha256').update(`${salt.reference_salt}:${title}`).digest('hex');
    await db.query(
      `INSERT INTO bank_statement_imports (id, reconciliation_id, source, line_count, request_hash, created_by, idempotency_key)
       VALUES ('bsi-83h-old', $1, 'manual', 2, $2, 'u-treasurer', $3)`,
      [reconciliationId, 'a'.repeat(64), key('old')],
    );
    await db.query(
      `INSERT INTO bank_statement_lines (id, reconciliation_id, import_id, line_no, booked_on, amount_cents, reference_hash, created_by)
       VALUES ('bsl-83h-old-long', $1, 'bsi-83h-old', 1, '2026-10-06', 2500, $2, 'u-treasurer'),
              ('bsl-83h-old-exact', $1, 'bsi-83h-old', 2, '2026-10-06', 2500, $3, 'u-treasurer')`,
      [reconciliationId, titleHash(`składka ${old.formatted}`), titleHash(old.formatted)],
    );
    const byLine = await suggestionsFor(call, cookies.treasurer, reconciliationId);
    assert.deepEqual(households(byLine.get(revokedLine)), []);
    assert.deepEqual(households(byLine.get(nextYearLine)), []);
    assert.deepEqual(households(byLine.get('bsl-83h-old-long')), [], 'stara pozycja z dłuższym tytułem: bez propozycji');
    assert.deepEqual(households(byLine.get('bsl-83h-old-exact')), ['h-old'], 'stara pozycja z samą referencją: jak dotąd');
  } finally {
    await db.close();
  }
});

test('two guardians pay separately with the reference inside their titles (partial amounts), double click gives one payment', async () => {
  const { db, cookies, call } = await setup();
  try {
    await seedEnrolledHousehold(db, 'h-1', [YEAR]);
    await db.query(`INSERT INTO guardians (id, household_id, first_name, last_name, email)
      VALUES ('g-83h-1', 'h-1', 'Opiekun', 'Pierwszy', 'g1-83h@example.invalid'),
             ('g-83h-2', 'h-1', 'Opiekun', 'Drugi', 'g2-83h@example.invalid')`);
    await db.query(`INSERT INTO student_guardians (student_id, guardian_id) VALUES ('st-h-1', 'g-83h-1'), ('st-h-1', 'g-83h-2')`);
    const ref = await seedReference(db, 'h-1');
    const reconciliationId = await createDraft(call, cookies.treasurer);
    const [first, second] = await importLines(call, db, cookies.treasurer, reconciliationId, [
      { amountCents: 1000, reference: `Składka część 1 ${ref.formatted}`, bookedOn: '2026-10-06' },
      { amountCents: 1500, reference: `${ref.reference} druga część`, bookedOn: '2026-10-20' },
    ]);
    const byLine = await suggestionsFor(call, cookies.treasurer, reconciliationId);
    assert.deepEqual(households(byLine.get(first)), ['h-1']);
    assert.deepEqual(households(byLine.get(second)), ['h-1']);

    const idempotencyKey = key('lp');
    const created = await linePayment(call, cookies.treasurer, reconciliationId, first, 'h-1', idempotencyKey);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const replay = await linePayment(call, cookies.treasurer, reconciliationId, first, 'h-1', idempotencyKey);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.payment.id, created.body.payment.id);
    // Po wpłacie z pierwszej pozycji druga nadal proponuje tę samą rodzinę (osobny przelew).
    const middle = await suggestionsFor(call, cookies.treasurer, reconciliationId);
    assert.equal(middle.has(first), false);
    assert.deepEqual(households(middle.get(second)), ['h-1']);
    const secondPayment = await linePayment(call, cookies.treasurer, reconciliationId, second, 'h-1');
    assert.equal(secondPayment.status, 201, JSON.stringify(secondPayment.body));

    const payments = await db.query("SELECT amount_cents FROM payment_entries WHERE household_id = 'h-1' ORDER BY amount_cents");
    assert.deepEqual(payments.rows.map((r) => Number(r.amount_cents)), [1000, 1500]);
    const totals = await db.query(
      'SELECT net_amount_cents FROM household_payment_totals WHERE household_id = $1 AND school_year_id = $2', ['h-1', YEAR],
    );
    assert.equal(Number(totals.rows[0].net_amount_cents), 2500);
    assertEvery([created.body, secondPayment.body], (body) => !/remaining|outstanding|due|debt|dłużn/i.test(JSON.stringify(body)));
  } finally {
    await db.close();
  }
});

test('siblings share one reference: one line in a longer title gives one proposal and one payment', async () => {
  const { db, cookies, call } = await setup();
  try {
    await seedEnrolledHousehold(db, 'h-sib', [YEAR]);
    await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ('st-83h-sib-2', 'h-sib', 'Syntetyczne', 'Rodzeństwo')");
    await db.query(`INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('enr-83h-sib-2', 'st-83h-sib-2', $1, $2)`,
      [`cls-enr-${YEAR}`, YEAR]);
    const ref = await seedReference(db, 'h-sib');
    const reconciliationId = await createDraft(call, cookies.treasurer);
    const [lineId] = await importLines(call, db, cookies.treasurer, reconciliationId, [
      { amountCents: 5000, reference: `Składka za dwoje dzieci ${ref.formatted}` },
    ]);
    const byLine = await suggestionsFor(call, cookies.treasurer, reconciliationId);
    assert.deepEqual(households(byLine.get(lineId)), ['h-sib']);
    const created = await linePayment(call, cookies.treasurer, reconciliationId, lineId, 'h-sib');
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const { rows } = await db.query("SELECT count(*) AS n, sum(amount_cents) AS total FROM payment_entries WHERE household_id = 'h-sib'");
    assert.deepEqual([Number(rows[0].n), Number(rows[0].total)], [1, 5000]);
    const rep = await call(`/api/reconciliations/${reconciliationId}/suggestions`, { cookie: cookies.rep });
    assert.equal(rep.status, 403);
  } finally {
    await db.close();
  }
});
