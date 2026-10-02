// GET /api/print/cards na PostgreSQL (PGlite). Wyłącznie dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { buildHouseholds, parseInputRows, renderCardsHtml } from '../print/core.js';
import { formatStructuredReference, generateStructuredReference } from '../src/pg/ogm.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUser, seedUserSession, seedPublishedPrivacyNotice } from './helpers/pg.js';
import { assertEvery } from './helpers/assertions.js';

const YEAR = 'y-test';
const CONFIG = { councilName: 'Rada Rodziców', schoolYear: '2026/2027', contact: 'kontakt w sekretariacie' };

async function seedFamilies(db) {
  await seedSchoolYear(db, YEAR);
  await seedSchoolYear(db, 'y-old', { startsOn: '2025-09-01', endsOn: '2026-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR, name: '1A' });
  await seedClass(db, { id: 'c-2b', schoolYearId: YEAR, name: '2B' });
  await seedClass(db, { id: 'c-old', schoolYearId: 'y-old', name: '0A' });
  await seedUser(db, { userId: 'u-seed' });
  const households = ['H-1', 'H-2', 'H-3', 'H-arch'];
  for (const id of households) await db.query('INSERT INTO households (id) VALUES ($1)', [id]);
  await db.query("UPDATE households SET archived_at = now() WHERE id = 'H-arch'");
  const students = [
    ['s-ala', 'H-1', 'Ala', 'Testowa', 'c-1a'],
    ['s-olek', 'H-1', 'Olek', 'Testowy', 'c-2b'],
    ['s-ewa', 'H-2', 'Ewa', 'Przykładowa', 'c-1a'],
    ['s-jan', 'H-3', 'Jan', 'Fikcyjny', 'c-2b'],
    ['s-arch', 'H-arch', 'Zenon', 'Archiwalny', 'c-1a'],
  ];
  for (const [id, household, first, last, classId] of students) {
    await db.query('INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1,$2,$3,$4)', [id, household, first, last]);
    await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1,$2,$3,$4)', [`e-${id}`, id, classId, YEAR]);
  }
  // Uczeń zapisany tylko w starszym roku nie trafia do bieżącego wydruku.
  await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ('s-old','H-3','Stary','Rocznik')");
  await db.query("INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('e-s-old','s-old','c-old','y-old')");
  // Dwoje opiekunów jednego dziecka (H-1) i opiekun H-2 — ich e-maile nie mogą wyjść w odpowiedzi.
  for (const [id, household, email] of [['g-1', 'H-1', 'opiekun1@example.invalid'], ['g-2', 'H-1', 'opiekun2@example.invalid'], ['g-3', 'H-2', 'opiekun3@example.invalid']]) {
    await db.query('INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES ($1,$2,$3,$4,$5,true)', [id, household, 'Opiekun', `Syntetyczny ${id}`, email]);
  }
  for (const [student, guardian] of [['s-ala', 'g-1'], ['s-ala', 'g-2'], ['s-olek', 'g-1'], ['s-ewa', 'g-3']]) {
    await db.query('INSERT INTO student_guardians (student_id, guardian_id, contact_allowed) VALUES ($1,$2,true)', [student, guardian]);
  }
  // Wpłata częściowo skorygowana (H-2: 50,00 − 10,00 = 40,00 EUR netto).
  await db.query(`INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key)
                  VALUES ('p-1','H-2',$1,5000,'2026-10-01','bank','recorded','u-seed','print-test-p1')`, [YEAR]);
  await db.query(`INSERT INTO payment_corrections (id, payment_entry_id, amount_cents, reason, created_by, idempotency_key)
                  VALUES ('pc-1','p-1',1000,'korekta testowa','u-seed','print-test-c1')`);
}

async function setup() {
  const db = await createTestDb();
  await seedPublishedPrivacyNotice(db);
  await seedFamilies(db);
  const sessions = {
    rep1a: await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }], mfa: true }),
    treasurerMfa: await seedUserSession(db, { userId: 'u-tr', roles: [{ role: 'treasurer', schoolYearId: YEAR }], mfa: true }),
    treasurerNoMfa: await seedUserSession(db, { userId: 'u-tr2', roles: [{ role: 'treasurer', schoolYearId: YEAR }], mfa: false }),
    board: await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board' }], mfa: true }),
    audit: await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit' }], mfa: true }),
  };
  const get = async (query, cookie) => {
    const response = await handlePgRequest(request(`/api/print/cards?${query}`, { cookie }), { db });
    const text = await response.text();
    return { response, status: response.status, text, body: JSON.parse(text) };
  };
  return { db, sessions, get };
}

test('dostęp: sesja, rola i klasa przedstawiciela sprawdzane po stronie serwera', async () => {
  const { db, sessions, get } = await setup();
  try {
    assert.equal((await get(`schoolYearId=${YEAR}&classId=c-1a`)).status, 401);
    const other = await get(`schoolYearId=${YEAR}&classId=c-2b`, sessions.rep1a);
    assert.equal(other.status, 403);
    assert.equal(other.body.error, 'forbidden');
    const noClass = await get(`schoolYearId=${YEAR}`, sessions.rep1a);
    assert.equal(noClass.status, 400);
    assert.equal(noClass.body.error, 'class_required');
    assert.equal((await get(`schoolYearId=y-old&classId=c-1a`, sessions.rep1a)).status, 403);
    assert.equal((await get(`schoolYearId=${YEAR}&classId=c-1a`, sessions.audit)).status, 403);
    assert.equal((await get('schoolYearId=bad%20id', sessions.board)).status, 400);
    assert.equal((await get('schoolYearId=y-none', sessions.board)).status, 404);
    assert.equal((await get(`schoolYearId=${YEAR}&classId=c-old`, sessions.board)).status, 404);
    const post = await handlePgRequest(request(`/api/print/cards?schoolYearId=${YEAR}`, { method: 'POST', cookie: sessions.board, body: {} }), { db });
    assert.equal(post.status, 405);
    // Odmowy nie zapisują zdarzenia wydruku.
    const { rows } = await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'print.cards_requested'");
    assert.equal(rows[0].n, 0);
  } finally {
    await db.close();
  }
});

test('przedstawiciel widzi tylko swoją klasę i bez informacji o wpłatach (także z MFA)', async () => {
  const { db, sessions, get } = await setup();
  try {
    const result = await get(`schoolYearId=${YEAR}&classId=c-1a`, sessions.rep1a);
    assert.equal(result.status, 200);
    assert.equal(result.response.headers.get('Cache-Control'), 'no-store');
    assert.equal(result.body.paymentInfoIncluded, false);
    assert.equal(result.body.paymentInstructions, null);
    assert.deepEqual(result.body.rows, [
      { householdId: 'H-1', firstName: 'Ala', lastName: 'Testowa', className: '1A', structuredReference: null },
      { householdId: 'H-2', firstName: 'Ewa', lastName: 'Przykładowa', className: '1A', structuredReference: null },
    ]);
    assertEvery(result.body.rows, (row) => !Object.hasOwn(row, 'recordedNetCents'));
    assert.doesNotMatch(result.text, /Olek|2B|Archiwalny|recordedNet/);
  } finally {
    await db.close();
  }
});

test('kwoty netto tylko dla roli finansowej z MFA; bez MFA pole jest pominięte', async () => {
  const { db, sessions, get } = await setup();
  try {
    // Skarbnik bez sesji z MFA zatrzymuje się na bramce MFA routera (przed trasą).
    const noMfa = await get(`schoolYearId=${YEAR}`, sessions.treasurerNoMfa);
    assert.equal(noMfa.status, 403);
    assert.equal(noMfa.body.error, 'mfa_enrollment_required');
    assert.doesNotMatch(noMfa.text, /recordedNetCents/);

    const mfa = await get(`schoolYearId=${YEAR}`, sessions.treasurerMfa);
    assert.equal(mfa.body.paymentInfoIncluded, true);
    const byHousehold = Object.fromEntries(mfa.body.rows.map((row) => [row.householdId, row.recordedNetCents]));
    assert.deepEqual(byHousehold, { 'H-1': 0, 'H-2': 4000, 'H-3': 0 });
  } finally {
    await db.close();
  }
});

test('rodzeństwo: jedna rodzina z uczniami z różnych klas, bez archiwalnych i innych lat', async () => {
  const { db, sessions, get } = await setup();
  try {
    const all = await get(`schoolYearId=${YEAR}`, sessions.board);
    assert.equal(all.status, 200);
    assert.equal(all.body.rows.length, 4);
    assert.doesNotMatch(all.text, /Archiwalny|Rocznik/);
    const h1 = all.body.rows.filter((row) => row.householdId === 'H-1');
    assert.deepEqual(h1.map((row) => `${row.firstName} ${row.className}`).sort(), ['Ala 1A', 'Olek 2B']);

    // Zarząd z filtrem klasy: rodziny z uczniem w 1A wraz z rodzeństwem z innych klas.
    const class1a = await get(`schoolYearId=${YEAR}&classId=c-1a`, sessions.board);
    assert.deepEqual(class1a.body.rows.map((row) => `${row.householdId}:${row.firstName}`),
      ['H-1:Ala', 'H-2:Ewa', 'H-1:Olek']);
  } finally {
    await db.close();
  }
});

test('odpowiedź nie zawiera danych opiekunów ani adresów e-mail', async () => {
  const { db, sessions, get } = await setup();
  try {
    for (const cookie of [sessions.board, sessions.treasurerMfa, sessions.rep1a]) {
      const query = cookie === sessions.rep1a ? `schoolYearId=${YEAR}&classId=c-1a` : `schoolYearId=${YEAR}`;
      const result = await get(query, cookie);
      assert.equal(result.status, 200);
      assert.doesNotMatch(result.text, /@|Opiekun|Syntetyczny|guardian|email/i);
      for (const row of result.body.rows) {
        assert.deepEqual(Object.keys(row).filter((key) => !['householdId', 'firstName', 'lastName', 'className', 'structuredReference', 'recordedNetCents'].includes(key)), []);
      }
    }
  } finally {
    await db.close();
  }
});

test('audyt print.cards_requested zawiera tylko liczby, zakres i identyfikator wersji informacji (D-06), bez danych osobowych', async () => {
  const { db, sessions, get } = await setup();
  try {
    await get(`schoolYearId=${YEAR}&classId=c-1a`, sessions.rep1a);
    await get(`schoolYearId=${YEAR}`, sessions.treasurerMfa);
    const { rows } = await db.query(
      "SELECT actor_id, entity_type, entity_id, metadata_json FROM audit_events WHERE action = 'print.cards_requested' ORDER BY occurred_at, id",
    );
    assert.equal(rows.length, 2);
    const byActor = Object.fromEntries(rows.map((row) => [row.actor_id, row]));
    assert.equal(byActor['u-rep'].entity_type, 'school_year');
    assert.equal(byActor['u-rep'].entity_id, YEAR);
    assert.deepEqual(byActor['u-rep'].metadata_json, { classId: 'c-1a', householdCount: 2, studentCount: 2, paymentInfoIncluded: false, paymentInstructionsApproved: false, privacyNoticeId: 'pn-test', privacyNoticeVersion: 1, structuredReferenceCount: 0 });
    assert.deepEqual(byActor['u-tr'].metadata_json, { classId: null, householdCount: 3, studentCount: 4, paymentInfoIncluded: true, paymentInstructionsApproved: false, privacyNoticeId: 'pn-test', privacyNoticeVersion: 1, structuredReferenceCount: 0 });
    const text = JSON.stringify(rows);
    assert.doesNotMatch(text, /Ala|Ewa|Olek|Testow|Przykład|H-1|H-2|@|(?<![\w-])4000(?![\w-])/);
  } finally {
    await db.close();
  }
});

test('odpowiedź jest zgodna z wejściem print/core.js (parseInputRows → buildHouseholds → kartki)', async () => {
  const { db, sessions, get } = await setup();
  try {
    const result = await get(`schoolYearId=${YEAR}`, sessions.treasurerMfa);
    const parsed = parseInputRows(result.body);
    assert.deepEqual(parsed.errors, []);
    const grouped = buildHouseholds(parsed.rows);
    assert.deepEqual(grouped.errors, []);
    const h1 = grouped.households.find((h) => h.householdId === 'H-1');
    assert.deepEqual(h1.students, [{ name: 'Ala Testowa', className: '1A' }, { name: 'Olek Testowy', className: '2B' }]);
    const h2 = grouped.households.find((h) => h.householdId === 'H-2');
    assert.equal(h2.recordedNetCents, 4000);
    assert.equal(h2.paymentEntry, 'recorded');
    assert.equal(grouped.households.find((h) => h.householdId === 'H-3').paymentEntry, 'none');
    const cards = renderCardsHtml(grouped.households, new Set(['H-1']), CONFIG);
    assert.equal(cards.count, 1);
    assert.match(cards.html, /Olek Testowy/);
    assert.doesNotMatch(cards.html, /Ewa|40,00|(?<![\w-])4000(?![\w-])/);

    // Bez informacji o wpłatach status jest „nie podano”, a nie „brak wpisu”.
    const rep = await get(`schoolYearId=${YEAR}&classId=c-1a`, sessions.rep1a);
    const repHouseholds = buildHouseholds(parseInputRows(rep.body).rows).households;
    assertEvery(repHouseholds, (h) => h.paymentEntry === 'unknown');
  } finally {
    await db.close();
  }
});

// #92: zatwierdzone dane do wpłaty (payment_instructions) na kartce i kodzie QR.
test('zatwierdzone dane do wpłaty trafiają do kartek każdej roli uprawnionej do druku, edycja poza tą trasą', async () => {
  const { db, sessions, get } = await setup();
  try {
    await db.query(
      `INSERT INTO payment_instructions (id, school_year_id, iban, bic, payee_name, approved_by, idempotency_key)
       VALUES ('pi-1', $1, 'BE68539007547034', 'GKCCBEBB', 'Rada Rodziców — Szkoła Testowa', 'u-board', 'print-test-pi-1')`,
      [YEAR],
    );
    for (const [cookie, query] of [
      [sessions.board, `schoolYearId=${YEAR}`],
      [sessions.treasurerMfa, `schoolYearId=${YEAR}`],
      [sessions.rep1a, `schoolYearId=${YEAR}&classId=c-1a`],
    ]) {
      const result = await get(query, cookie);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.paymentInstructions, {
        id: 'pi-1', iban: 'BE68539007547034', bic: 'GKCCBEBB', payeeName: 'Rada Rodziców — Szkoła Testowa',
        approvedAt: result.body.paymentInstructions.approvedAt,
      });
    }
    // Rok bez zatwierdzonej konfiguracji: nadal null (osobny rok, brak wiersza).
    const oldYear = await get('schoolYearId=y-old&classId=c-old', sessions.board);
    assert.equal(oldYear.body.paymentInstructions, null);

    // Ta trasa jest tylko do odczytu — nie da się nią zapisać nowej konfiguracji.
    const post = await handlePgRequest(request(`/api/print/cards?schoolYearId=${YEAR}`, { method: 'POST', cookie: sessions.board, body: {} }), { db });
    assert.equal(post.status, 405);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM payment_instructions');
    assert.equal(rows[0].n, 1);
  } finally {
    await db.close();
  }
});

// #92: korekta rachunku w trakcie roku — nowa wersja zastępuje starą na kartkach
// (także przedstawiciela klasy), a stopka kartki pokazuje wersję, więc kartki
// wydrukowane wcześniej da się rozpoznać.
test('korekta rachunku w trakcie roku: kartki z nową wersją, wersja w stopce, QR z nowym IBAN', async () => {
  const { db, sessions, get } = await setup();
  try {
    await db.query(
      `INSERT INTO payment_instructions (id, school_year_id, iban, bic, payee_name, approved_by, approved_at, idempotency_key)
       VALUES ('pi-old00001', $1, 'BE68539007547034', NULL, 'Rada Rodziców — Szkoła Testowa', 'u-board', '2026-09-01T08:00:00Z', 'print-test-pi-old'),
              ('pi-new00002', $1, 'BE71096123456769', NULL, 'Rada Rodziców — Szkoła Testowa', 'u-board', '2026-11-15T09:30:00Z', 'print-test-pi-new')`,
      [YEAR],
    );
    const board = await get(`schoolYearId=${YEAR}`, sessions.board);
    const rep = await get(`schoolYearId=${YEAR}&classId=c-1a`, sessions.rep1a);
    for (const result of [board, rep]) {
      assert.equal(result.status, 200);
      assert.equal(result.body.paymentInstructions.id, 'pi-new00002');
      assert.equal(result.body.paymentInstructions.iban, 'BE71096123456769');
      assert.doesNotMatch(result.text, /BE68539007547034|pi-old00001/);
    }
    const repGrouped = buildHouseholds(parseInputRows(rep.body).rows);
    const cards = renderCardsHtml(repGrouped.households, new Set(['H-1']), CONFIG, rep.body.paymentInstructions);
    assert.equal(cards.count, 1);
    assert.match(cards.html, /class="card-qr"/);
    assert.match(cards.html, /Dane do wpłaty: wersja zatwierdzona 15\.11\.2026 10:30, nr pi-new00/);
    assert.match(cards.html, /BE71096123456769/);
    assert.doesNotMatch(cards.html, /BE68539007547034/);
    // Stara wersja dałaby inną stopkę — wydruk sprzed korekty jest rozpoznawalny.
    const oldCards = renderCardsHtml(repGrouped.households, new Set(['H-1']), CONFIG,
      { id: 'pi-old00001', iban: 'BE68539007547034', bic: null, payeeName: 'Rada Rodziców — Szkoła Testowa', approvedAt: '2026-09-01T08:00:00.000Z' });
    assert.match(oldCards.html, /wersja zatwierdzona 01\.09\.2026 10:00, nr pi-old00/);
  } finally {
    await db.close();
  }
});

// #83: aktywna komunikacja strukturalna rodziny na kartce zamiast identyfikatora.
async function seedReference(db, id, householdId, schoolYearId = YEAR) {
  const reference = generateStructuredReference();
  await db.query(
    `INSERT INTO payment_references (id, school_year_id, household_id, structured_reference, created_by, idempotency_key)
     VALUES ($1, $2, $3, $4, 'u-seed', $5)`,
    [id, schoolYearId, householdId, reference, `print-test-${id}`],
  );
  return reference;
}

test('komunikacja strukturalna: aktywna referencja roku na kartce rodzeństwa, bez unieważnionej i innego roku', async () => {
  const { db, sessions, get } = await setup();
  try {
    const h1 = await seedReference(db, 'pr-h1', 'H-1');
    const revoked = await seedReference(db, 'pr-h2', 'H-2');
    await db.query(
      `INSERT INTO payment_reference_revocations (id, payment_reference_id, reason, created_by, idempotency_key)
       VALUES ('prr-h2', 'pr-h2', 'Unieważnienie syntetyczne', 'u-seed', 'print-test-prr-h2')`,
    );
    const otherYear = await seedReference(db, 'pr-h3-old', 'H-3', 'y-old');
    await db.query(
      `INSERT INTO payment_instructions (id, school_year_id, iban, bic, payee_name, approved_by, idempotency_key)
       VALUES ('pi-83', $1, 'BE68539007547034', 'GKCCBEBB', 'Rada Rodziców — Szkoła Testowa', 'u-board', 'print-test-pi-83')`,
      [YEAR],
    );
    const all = await get(`schoolYearId=${YEAR}`, sessions.board);
    assert.equal(all.status, 200);
    const refs = Object.fromEntries(all.body.rows.map((row) => [`${row.householdId}:${row.firstName}`, row.structuredReference]));
    // Rodzeństwo (Ala i Olek, dwie klasy) ma tę samą, jedną referencję rodziny.
    assert.deepEqual(refs, { 'H-1:Ala': h1, 'H-1:Olek': h1, 'H-2:Ewa': null, 'H-3:Jan': null });
    assert.doesNotMatch(all.text, new RegExp(`${revoked}|${otherYear}`));

    const grouped = buildHouseholds(parseInputRows(all.body).rows);
    assert.deepEqual(grouped.errors, []);
    const config = { ...CONFIG, bankAccount: 'BE68 5390 0754 7034', referenceTemplate: 'Składka {rok} {rodzina}' };
    const cards = renderCardsHtml(grouped.households, new Set(['H-1', 'H-2']), config, all.body.paymentInstructions);
    assert.equal(cards.count, 2, 'jedna kartka na rodzinę, także dla rodzeństwa');
    assert.match(cards.html, new RegExp(formatStructuredReference(h1).replaceAll('+', '\\+')));
    // H-1 ma komunikację zamiast tytułu z identyfikatorem; H-2 (unieważniona) — tytuł z szablonu.
    assert.doesNotMatch(cards.html, /Składka 2026\/2027 H-1/);
    assert.match(cards.html, /Składka 2026\/2027 H-2/);

    const { rows } = await db.query(
      "SELECT metadata_json FROM audit_events WHERE action = 'print.cards_requested' ORDER BY occurred_at DESC, id DESC LIMIT 1",
    );
    assert.equal(rows[0].metadata_json.structuredReferenceCount, 1);
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(h1));
  } finally {
    await db.close();
  }
});

test('komunikacja strukturalna: przedstawiciel widzi referencję tylko rodzin swojej klasy; inna klasa 403', async () => {
  const { db, sessions, get } = await setup();
  try {
    const h1 = await seedReference(db, 'pr-h1', 'H-1');
    const h3 = await seedReference(db, 'pr-h3', 'H-3');
    const own = await get(`schoolYearId=${YEAR}&classId=c-1a`, sessions.rep1a);
    assert.equal(own.status, 200);
    assert.deepEqual(own.body.rows.map((row) => [row.householdId, row.structuredReference]), [['H-1', h1], ['H-2', null]]);
    assert.doesNotMatch(own.text, new RegExp(h3), 'referencja rodziny spoza klasy nie wychodzi');
    const other = await get(`schoolYearId=${YEAR}&classId=c-2b`, sessions.rep1a);
    assert.equal(other.status, 403);
    assert.doesNotMatch(other.text, new RegExp(`${h1}|${h3}`));
    // Trasy rejestru referencji pozostają zamknięte dla przedstawiciela.
    const registry = await handlePgRequest(request(`/api/payment-references?schoolYearId=${YEAR}&householdId=H-1`, { cookie: sessions.rep1a }), { db });
    assert.equal(registry.status, 403);
  } finally {
    await db.close();
  }
});
