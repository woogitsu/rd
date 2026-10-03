// #208 (inwentaryzacja blokad, scripts/lock-inventory.js): testy z barierą na PRAWDZIWYM
// PostgreSQL dla blokad wierszy, które wcześniej nie miały mutanta, a których brak daje
// realny wyścig: wnioski rodziców o zmianę kontaktu (formularz publiczny i decyzja
// zarządu), rejestr żądań osób (zmiana statusu, ograniczenie przetwarzania, sprostowanie
// z powołaniem na żądanie).
//
// Schemat jak w pg-real-record-locks: pierwsze żądanie staje W TRANSAKCJI po zapisie,
// drugie startuje osobnym połączeniem, test sprawdza w `pg_stat_activity`, że drugie
// czeka na zapytanie z blokadą z KODU TRASY, i dopiero potem wznawia pierwsze. Każdy
// test sprawdza też skutek, który bez blokady jest inny (podwójny wpis audytu, błąd
// wyzwalacza zamiast powtórki, utracona zmiana adresu, zapis wbrew zamkniętemu żądaniu);
// sprawdzone z wyłączonymi asercjami miejsca czekania — mutant pada na samym skutku.
//
// Plik działa wyłącznie z RD_TEST_PG_URL (npm run test:pg-real); bez niej jest pomijany.
// Wyłącznie dane syntetyczne (@example.invalid). Żaden test nie wysyła wiadomości.
// Kontrola mutacyjna: scripts/check-lock-mutations.js (mutanty guardian-update-submit,
// guardian-update-decide, guardian-update-decide-guardian, data-request-status,
// processing-restriction-request, families-rectification-request).
import test from 'node:test';
import assert from 'node:assert/strict';
import { seedClass, seedSchoolYear, seedUserSession } from './helpers/pg.js';
import { callApi, countRows } from './helpers/pg-barrier.js';
import { assertWaitsOn, auditCount, race, withReal } from './helpers/pg-race.js';

const skip = process.env.RD_TEST_PG_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';
const YEAR = 'y-2026';
const REASON = 'Zmiana syntetyczna';
const post = (env, path, cookie, body) => callApi(env, 'POST', path, cookie, body);

// h-1: uczeń s-1 (1A) z opiekunem g-1. Sesje: dwóch adminów i dwie osoby z zarządu (MFA).
async function seedFamily(db) {
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR, name: '1A' });
  await db.exec(`
    INSERT INTO households (id) VALUES ('h-1');
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
      ('g-1', 'h-1', 'Anna', 'Testowa', 'stary@example.invalid', true);
    INSERT INTO students (id, household_id, first_name, last_name) VALUES ('s-1', 'h-1', 'Ola', 'Testowa');
    INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ('s-1', 'g-1', true, true);
    INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('e-1', 's-1', 'c-1a', '${YEAR}');
  `);
  return {
    adminA: await seedUserSession(db, { userId: 'u-admin-1', mfa: true, roles: [{ role: 'admin' }] }),
    adminB: await seedUserSession(db, { userId: 'u-admin-2', mfa: true, roles: [{ role: 'admin' }] }),
    boardA: await seedUserSession(db, { userId: 'u-board-1', mfa: true, roles: [{ role: 'board' }] }),
    boardB: await seedUserSession(db, { userId: 'u-board-2', mfa: true, roles: [{ role: 'board' }] }),
  };
}

// Link dla g-1 (wydaje admin przez API); zwraca token formularza.
async function issueLink(db, cookie) {
  const issued = await callApi({ db }, 'POST', '/api/admin/guardian-links', cookie, { guardianId: 'g-1' });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  return issued.body.token;
}

// ---------------------------------------------------------------- wnioski rodziców (#140)

test('#208 (bariera, rodziny): podwójne wysłanie formularza rodzica tym samym linkiem — drugie czeka na blokadę linku i dostaje 409 link_used; jeden wniosek', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await seedFamily(db);
    const token = await issueLink(db, cookies.adminA);
    const body = { token, contactAllowed: false };
    const r = await race(db, {
      pauseAfter: /INSERT INTO guardian_update_requests/,
      first: (env) => post(env, '/api/public/guardian-update', null, body),
      second: (env) => post(env, '/api/public/guardian-update', null, body),
    });
    assertWaitsOn(r, /^SELECT id, guardian_id, expires_at, used_at FROM guardian_update_links/, 'drugie wysłanie czeka na blokadę wiersza linku');
    assert.equal(r.a.status, 201, JSON.stringify(r.a.body));
    // Bez blokady drugie żądanie dochodzi do UPDATE linku, czeka na pierwsze i po jego
    // zatwierdzeniu wyzwalacz guardian_update_link_guard (0087) przerywa transakcję
    // (409 business_rule_violation zamiast link_used).
    assert.deepEqual([r.b.status, r.b.body.error], [409, 'link_used']);
    assert.equal(await countRows(db, "SELECT count(*)::int AS n FROM guardian_update_requests WHERE guardian_id = 'g-1'"), 1);
    assert.equal(await auditCount(db, 'guardian_update_request.created'), 1);
  });
});

test('#208 (bariera, rodziny): podwójne „Zatwierdź” wniosku rodzica przez dwie osoby — drugie czeka na blokadę wniosku i jest powtórką (changed: false, jedno zdarzenie)', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await seedFamily(db);
    const token = await issueLink(db, cookies.adminA);
    const submitted = await post({ db }, '/api/public/guardian-update', null, { token, contactAllowed: false });
    assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
    const path = `/api/admin/guardian-update-requests/${submitted.body.requestId}/approve`;
    const r = await race(db, {
      pauseAfter: /UPDATE guardian_update_requests SET status/,
      first: (env) => post(env, path, cookies.boardA, {}),
      second: (env) => post(env, path, cookies.boardB, {}),
    });
    assertWaitsOn(r, /^SELECT id, guardian_id, status, proposed_email/, 'drugie zatwierdzenie czeka na blokadę wiersza wniosku');
    assert.equal(r.a.status, 200, JSON.stringify(r.a.body));
    // Bez blokady drugie zatwierdzenie widzi „pending”, dochodzi do UPDATE wniosku i
    // wyzwalacz guardian_update_request_guard (0087) przerywa je (409 business_rule_violation
    // zamiast powtórki 200).
    assert.equal(r.b.status, 200, JSON.stringify(r.b.body));
    assert.deepEqual([r.a.body.changed, r.b.body.changed, r.b.body.status], [true, false, 'approved']);
    assert.equal(await auditCount(db, 'guardian_update_request.approved'), 1);
    assert.equal(await countRows(db, "SELECT count(*)::int AS n FROM guardians WHERE id = 'g-1' AND NOT contact_allowed"), 1);
  });
});

test('#208 (bariera, rodziny): zatwierdzenie wniosku (tylko zgoda) w trakcie zmiany adresu opiekuna przez zarząd — czeka na blokadę opiekuna i nie przywraca starego adresu', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await seedFamily(db);
    const token = await issueLink(db, cookies.adminA);
    const submitted = await post({ db }, '/api/public/guardian-update', null, { token, contactAllowed: false });
    assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
    const r = await race(db, {
      pauseAfter: /UPDATE guardians SET email/,
      first: (env) => callApi(env, 'PATCH', '/api/guardians/g-1/contact', cookies.boardA, { email: 'nowy@example.invalid', reason: REASON }),
      second: (env) => post(env, `/api/admin/guardian-update-requests/${submitted.body.requestId}/approve`, cookies.boardB, {}),
    });
    assertWaitsOn(r, /^SELECT email, contact_allowed FROM guardians WHERE id = \$1 FOR UPDATE/, 'zatwierdzenie czeka na blokadę wiersza opiekuna');
    assert.equal(r.a.status, 200, JSON.stringify(r.a.body));
    assert.equal(r.b.status, 200, JSON.stringify(r.b.body));
    // Bez blokady zatwierdzenie czyta stary adres, a jego UPDATE (adres + zgoda) po
    // zatwierdzeniu zmiany zarządu nadpisuje nowy adres starym — utracona aktualizacja.
    const { rows } = await db.query("SELECT email, contact_allowed FROM guardians WHERE id = 'g-1'");
    assert.deepEqual(rows, [{ email: 'nowy@example.invalid', contact_allowed: false }]);
  });
});

// ---------------------------------------------------------------- rejestr żądań osób (#100)

async function seedDataRequest(db, { kind, status = 'in_progress' }) {
  const id = crypto.randomUUID();
  const subject = kind === 'rectification' ? { column: 'student_id', value: 's-1' } : { column: 'guardian_id', value: 'g-1' };
  await db.query(
    `INSERT INTO data_subject_requests (id, kind, ${subject.column}, received_on, status, created_by)
     VALUES ($1, $2, $3, '2026-10-01', $4, 'u-admin-1')`,
    [id, kind, subject.value, status],
  );
  return id;
}

test('#208 (bariera, żądania osób): podwójna zmiana statusu żądania na „w toku” — druga czeka na blokadę żądania i nie dubluje zdarzenia', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await seedFamily(db);
    const requestId = await seedDataRequest(db, { kind: 'access', status: 'identity_verified' });
    const path = `/api/admin/data-requests/${requestId}/status`;
    const r = await race(db, {
      pauseAfter: /UPDATE data_subject_requests SET status/,
      first: (env) => post(env, path, cookies.adminA, { status: 'in_progress' }),
      second: (env) => post(env, path, cookies.adminB, { status: 'in_progress' }),
    });
    assertWaitsOn(r, /^SELECT id, kind, household_id, guardian_id, student_id,[\s\S]* FROM data_subject_requests WHERE id = \$1 FOR UPDATE/, 'druga zmiana statusu czeka na blokadę wiersza żądania');
    assert.equal(r.a.status, 200, JSON.stringify(r.a.body));
    assert.equal(r.b.status, 200, JSON.stringify(r.b.body));
    // Bez blokady drugi UPDATE czeka na pierwszy, wykonuje się ponownie i dopisuje drugie zdarzenie.
    assert.deepEqual([r.a.body.changed, r.b.body.changed], [true, false]);
    assert.equal(await auditCount(db, 'data_subject_request.status_changed'), 1);
  });
});

test('#208 (bariera, żądania osób): ograniczenie przetwarzania w trakcie zamykania żądania — czeka na blokadę żądania i dostaje 409 data_request_closed, bez wpisu ograniczenia', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await seedFamily(db);
    const requestId = await seedDataRequest(db, { kind: 'restriction' });
    const r = await race(db, {
      pauseAfter: /UPDATE data_subject_requests SET status/,
      first: (env) => post(env, `/api/admin/data-requests/${requestId}/status`, cookies.adminA, { status: 'answered' }),
      second: (env) => post(env, `/api/admin/data-requests/${requestId}/restrict`, cookies.adminB, {}),
    });
    assertWaitsOn(r, /^SELECT id, kind, status, household_id, guardian_id FROM data_subject_requests WHERE id = \$1 FOR UPDATE/, 'ograniczenie czeka na blokadę wiersza żądania');
    assert.equal(r.a.status, 200, JSON.stringify(r.a.body));
    // Bez blokady ograniczenie czyta „w toku” i zapisuje się na żądaniu, które w tej chwili
    // zostaje zamknięte (klucz obcy czeka na zamknięcie, ale go nie sprawdza).
    assert.deepEqual([r.b.status, r.b.body.error], [409, 'data_request_closed']);
    assert.equal(await countRows(db, 'SELECT count(*)::int AS n FROM processing_restrictions WHERE request_id = $1', [requestId]), 0);
    assert.equal(await auditCount(db, 'processing_restriction.applied'), 0);
  });
});

test('#208 (bariera, żądania osób): sprostowanie imienia z powołaniem na żądanie w trakcie jego zamykania — czeka na blokadę żądania (FOR SHARE) i dostaje 409 data_request_closed', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await seedFamily(db);
    const requestId = await seedDataRequest(db, { kind: 'rectification' });
    const r = await race(db, {
      pauseAfter: /UPDATE data_subject_requests SET status/,
      first: (env) => post(env, `/api/admin/data-requests/${requestId}/status`, cookies.adminA, { status: 'answered' }),
      second: (env) => callApi(env, 'PATCH', '/api/students/s-1/identity', cookies.adminB, { firstName: 'Zofia', reason: REASON, dataRequestId: requestId }),
    });
    assertWaitsOn(r, /^SELECT id, kind, status FROM data_subject_requests WHERE id = \$1 FOR SHARE/, 'sprostowanie czeka na blokadę wiersza żądania');
    assert.equal(r.a.status, 200, JSON.stringify(r.a.body));
    // Bez blokady sprostowanie przechodzi sprawdzenie stanu, a wpis historii czeka tylko
    // na klucz obcy i zapisuje się z powołaniem na żądanie zamknięte w tej chwili.
    assert.deepEqual([r.b.status, r.b.body.error], [409, 'data_request_closed']);
    assert.equal(await countRows(db, 'SELECT count(*)::int AS n FROM identity_changes WHERE data_request_id = $1', [requestId]), 0);
    const { rows } = await db.query("SELECT first_name FROM students WHERE id = 's-1'");
    assert.deepEqual(rows, [{ first_name: 'Ola' }]);
  });
});
