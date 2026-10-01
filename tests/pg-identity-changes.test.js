// #100 (art. 16 RODO): sprostowanie imienia i nazwiska ucznia i opiekuna z historią
// (migracja 0182, tabela identity_changes). Role i zakres klasowy, opiekun z dziećmi
// w dwóch klasach (403 guardian_shared_outside_scope), dwoje opiekunów jednego dziecka,
// rodzeństwo, podwójne kliknięcie, niezmienność historii, audyt bez imion, bramka danych
// osobowych w powodzie, powiązanie z żądaniem z rejestru, eksport danych rodziny i anonimizacja.
// Wyłącznie dane syntetyczne (.invalid); znaczniki MRK-* służą do wykrywania wycieku imion.
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { assertNoPii } from '../src/pg/audit.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const Y1 = 'y-ident-1';
const REASON = 'Błąd pisowni w ewidencji (syntetyczne)';
const MARKERS = [
  'MRK-OPIEKUN-1', 'MRK-OPIEKUN-2', 'MRK-UCZEN-A', 'MRK-UCZEN-B', 'MRK-OBCY', 'MRK-OBCE-DZIECKO',
  'MRK-NOWE-',
];

async function seed(db) {
  await seedSchoolYear(db, Y1, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedClass(db, { id: 'c-id-1a', schoolYearId: Y1, name: '1A' });
  await seedClass(db, { id: 'c-id-1b', schoolYearId: Y1, name: '1B' });
  await db.exec(`
    INSERT INTO households (id) VALUES ('h-1'), ('h-2'), ('h-x');
    -- h-1: rodzeństwo s-a (1A) i s-b (1B); opiekun g-1 ma relację z oboma (dwie klasy).
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
      ('g-1', 'h-1', 'Anna', 'MRK-OPIEKUN-1', 'opiekun-1@example.invalid', true),
      ('g-2', 'h-2', 'Piotr', 'MRK-OPIEKUN-2', 'opiekun-2@example.invalid', true),
      ('g-x', 'h-x', 'Olga', 'MRK-OBCY', 'obcy@example.invalid', true);
    INSERT INTO students (id, household_id, first_name, last_name) VALUES
      ('s-a', 'h-1', 'Ola', 'MRK-UCZEN-A'), ('s-b', 'h-1', 'Jan', 'MRK-UCZEN-B'), ('s-x', 'h-x', 'Kuba', 'MRK-OBCE-DZIECKO');
    -- g-2 jest drugim opiekunem s-a (inne gospodarstwo), tylko z dzieckiem z 1A.
    INSERT INTO student_households (id, student_id, household_id, is_primary, source) VALUES ('sh-a-h2', 's-a', 'h-2', false, 'api');
    INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES
      ('s-a', 'g-1', true, true), ('s-b', 'g-1', true, true), ('s-a', 'g-2', true, false), ('s-x', 'g-x', true, true);
    INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
      ('e-a', 's-a', 'c-id-1a', '${Y1}'), ('e-b', 's-b', 'c-id-1b', '${Y1}'), ('e-x', 's-x', 'c-id-1b', '${Y1}');
  `);
}

describe('sprostowanie imienia i nazwiska z historią (#100)', () => {
  let db;
  const env = {};
  const cookies = {};
  before(async () => {
    db = await createTestDb();
    env.db = db;
    await seed(db);
    cookies.admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
    cookies.board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board' }], mfa: true });
    cookies.boardA = await seedUserSession(db, { userId: 'u-board-1a', roles: [{ role: 'board', classId: 'c-id-1a', schoolYearId: Y1 }], mfa: true });
    cookies.repA = await seedUserSession(db, { userId: 'u-rep-1a', roles: [{ role: 'representative', classId: 'c-id-1a', schoolYearId: Y1 }], mfa: true });
    cookies.treasurer = await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: Y1 }], mfa: true });
    cookies.audit = await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit', schoolYearId: Y1 }], mfa: true });
    cookies.principal = await seedUserSession(db, { userId: 'u-principal', roles: [{ role: 'principal', schoolYearId: Y1 }], mfa: true });
  });
  after(async () => { await db?.close(); });

  const call = async (path, { cookie = cookies.admin, method = 'PATCH', body } = {}) => {
    const response = await handlePgRequest(request(path, { cookie, method, body }), env);
    const text = await response.text();
    return { status: response.status, text, json: text ? JSON.parse(text) : null, headers: response.headers };
  };
  const patchStudent = (id, body, cookie) => call(`/api/students/${id}/identity`, { body, cookie });
  const patchGuardian = (id, body, cookie) => call(`/api/guardians/${id}/identity`, { body, cookie });
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const historyCount = async (where = 'true') => (await one(`SELECT count(*)::int AS n FROM identity_changes WHERE ${where}`)).n;
  const auditEvents = async (action) => (await db.query(
    'SELECT actor_id, entity_type, entity_id, metadata_json FROM audit_events WHERE action = $1 ORDER BY occurred_at, id', [action],
  )).rows;
  const names = async (table, id) => one(`SELECT first_name, last_name FROM ${table} WHERE id = $1`, [id]);
  const snapshot = async () => ({
    students: (await db.query('SELECT id, first_name, last_name FROM students ORDER BY id')).rows,
    guardians: (await db.query('SELECT id, first_name, last_name, email FROM guardians ORDER BY id')).rows,
    history: await historyCount(),
    audit: (await one("SELECT count(*)::int AS n FROM audit_events WHERE action LIKE '%.identity.updated'")).n,
  });

  describe('granice ról i zakresu (przed jakąkolwiek zmianą)', () => {
    test('rola bez prawa edycji i brak sesji: 403/401, nic nie zapisano; ślad odmowy tylko dla zalogowanego', async () => {
      const before = await snapshot();
      const body = { firstName: 'MRK-NOWE-ROLA', reason: REASON };
      for (const key of ['repA', 'treasurer', 'audit', 'principal']) {
        assert.deepEqual((await patchStudent('s-a', body, cookies[key])).json, { error: 'forbidden' }, key);
        assert.equal((await patchStudent('s-a', body, cookies[key])).status, 403, key);
        assert.equal((await patchGuardian('g-2', body, cookies[key])).status, 403, key);
      }
      assert.equal((await patchStudent('s-a', body, null)).status, 401);
      assert.equal((await patchGuardian('g-2', body, null)).status, 401);
      assert.deepEqual(await snapshot(), before);
      const denied = await db.query(
        "SELECT count(*)::int AS n FROM audit_events WHERE action = 'access.denied' AND entity_id IN ('/api/students/s-a/identity', '/api/guardians/g-2/identity')",
      );
      assert.ok(denied.rows[0].n >= 2, 'odmowa 403 zostawia ślad access.denied');
    });

    test('zarząd z przydziałem klasy: tylko uczeń własnej klasy; rodzeństwo z innej klasy, obcy uczeń i nieistniejący — 404', async () => {
      const before = await snapshot();
      const body = { firstName: 'MRK-NOWE-ZAKRES', reason: REASON };
      const missing = { status: 404, json: { error: 'not_found' } };
      for (const id of ['s-b', 's-x', 's-nope']) {
        const res = await patchStudent(id, body, cookies.boardA);
        assert.deepEqual({ status: res.status, json: res.json }, missing, id);
      }
      assert.deepEqual(await snapshot(), before);
    });

    test('metoda i identyfikator: tylko PATCH, niepoprawny identyfikator to 404', async () => {
      assert.equal((await call('/api/students/s-a/identity', { method: 'POST', body: { firstName: 'X', reason: REASON } })).status, 404);
      assert.equal((await patchStudent('..%2Fx', { firstName: 'Xx', reason: REASON })).status, 404);
    });
  });

  describe('uczeń: zmiana, historia, audyt, podwójne kliknięcie', () => {
    test('zarząd klasy zmienia imię ucznia własnej klasy: historia z aktorem, powodem i czasem z bazy; rodzeństwo bez zmian', async () => {
      const res = await patchStudent('s-a', { firstName: 'MRK-NOWE-OLA', reason: REASON }, cookies.boardA);
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json, { student: { id: 's-a', firstName: 'MRK-NOWE-OLA', lastName: 'MRK-UCZEN-A' }, changed: true });
      assert.deepEqual(await names('students', 's-a'), { first_name: 'MRK-NOWE-OLA', last_name: 'MRK-UCZEN-A' });
      assert.deepEqual(await names('students', 's-b'), { first_name: 'Jan', last_name: 'MRK-UCZEN-B' }, 'rodzeństwo bez zmian');
      const history = (await db.query('SELECT * FROM identity_changes WHERE student_id = $1', ['s-a'])).rows;
      assert.equal(history.length, 1);
      const [row] = history;
      assert.equal(row.subject_type, 'student');
      assert.equal(row.guardian_id, null);
      assert.deepEqual(
        [row.previous_first_name, row.previous_last_name, row.new_first_name, row.new_last_name],
        ['Ola', 'MRK-UCZEN-A', 'MRK-NOWE-OLA', 'MRK-UCZEN-A'],
      );
      assert.equal(row.reason, REASON);
      assert.equal(row.source, 'api');
      assert.equal(row.changed_by, 'u-board-1a');
      assert.equal(row.data_request_id, null);
      assert.ok(row.changed_at instanceof Date && Math.abs(Date.now() - row.changed_at.getTime()) < 60_000, 'czas z zegara bazy');
    });

    test('podwójne kliknięcie i ponowienie: 200 changed:false, bez drugiego wpisu historii i audytu', async () => {
      const before = await snapshot();
      for (let i = 0; i < 2; i += 1) {
        const res = await patchStudent('s-a', { firstName: 'MRK-NOWE-OLA', reason: REASON }, cookies.boardA);
        assert.deepEqual(res.json, { student: { id: 's-a', firstName: 'MRK-NOWE-OLA', lastName: 'MRK-UCZEN-A' }, changed: false });
        assert.equal(res.status, 200);
      }
      // Same białe znaki i inna forma Unicode nie są zmianą.
      const spaced = await patchStudent('s-a', { firstName: '  MRK-NOWE-OLA ', lastName: 'MRK-UCZEN-A', reason: REASON }, cookies.boardA);
      assert.equal(spaced.json.changed, false);
      assert.deepEqual(await snapshot(), before);
    });

    test('dwa żądania tej samej zmiany (PGlite wykonuje po kolei, nie wyścig) dają jeden wpis historii', async () => {
      const body = { lastName: 'MRK-NOWE-RÓWNOLEGLE', reason: REASON };
      const [a, b] = await Promise.all([patchStudent('s-b', body), patchStudent('s-b', body)]);
      assert.deepEqual([a.status, b.status], [200, 200]);
      assert.deepEqual([a.json.changed, b.json.changed].sort(), [false, true]);
      assert.equal(await historyCount("student_id = 's-b'"), 1);
    });

    test('audyt niesie tylko identyfikatory i nazwy pól — bez imion, nazwisk i powodu', async () => {
      const events = await auditEvents('student.identity.updated');
      assert.equal(events.length, 2);
      const [first] = events;
      assert.deepEqual([first.actor_id, first.entity_type, first.entity_id], ['u-board-1a', 'student', 's-a']);
      assert.deepEqual(first.metadata_json, { fields: ['firstName'] });
      assert.deepEqual(events[1].metadata_json, { fields: ['lastName'] });
      for (const event of events) {
        assertNoPii(event.metadata_json);
        const text = JSON.stringify(event);
        for (const marker of [...MARKERS, 'Ola', 'Jan', REASON]) assert.ok(!text.includes(marker), `audyt zawiera ${marker}`);
      }
    });

    test('zmiana imienia i nazwiska w jednym żądaniu: fields i jeden wpis historii z oboma parami wartości', async () => {
      const res = await patchStudent('s-x', { firstName: 'Jakub', lastName: 'MRK-NOWE-OBCE', reason: REASON }, cookies.admin);
      assert.equal(res.status, 200, res.text);
      const event = (await auditEvents('student.identity.updated')).find((row) => row.entity_id === 's-x');
      assert.deepEqual(event.metadata_json, { fields: ['firstName', 'lastName'] });
      const row = await one("SELECT previous_first_name, new_first_name, previous_last_name, new_last_name FROM identity_changes WHERE student_id = 's-x'");
      assert.deepEqual(row, { previous_first_name: 'Kuba', new_first_name: 'Jakub', previous_last_name: 'MRK-OBCE-DZIECKO', new_last_name: 'MRK-NOWE-OBCE' });
      // Korekta błędnego sprostowania to nowy zapis, stary zostaje.
      assert.equal((await patchStudent('s-x', { firstName: 'Kuba', lastName: 'MRK-OBCE-DZIECKO', reason: REASON })).json.changed, true);
      const rows = (await db.query("SELECT previous_first_name, new_first_name FROM identity_changes WHERE student_id = 's-x' ORDER BY changed_at, id")).rows;
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((r) => [r.previous_first_name, r.new_first_name]).sort(), [['Jakub', 'Kuba'], ['Kuba', 'Jakub']]);
    });
  });

  describe('opiekun: zakres, opiekun z dziećmi w dwóch klasach, dwoje opiekunów jednego dziecka', () => {
    test('zarząd klasy zmienia drugiego opiekuna dziecka z własnej klasy; pierwszy opiekun i dziecko bez zmian', async () => {
      const res = await patchGuardian('g-2', { lastName: 'MRK-NOWE-OPIEKUN-2', reason: REASON }, cookies.boardA);
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json, { guardian: { id: 'g-2', firstName: 'Piotr', lastName: 'MRK-NOWE-OPIEKUN-2' }, changed: true });
      assert.deepEqual(await names('guardians', 'g-1'), { first_name: 'Anna', last_name: 'MRK-OPIEKUN-1' });
      assert.deepEqual((await names('students', 's-a')).last_name, 'MRK-UCZEN-A');
      const row = await one("SELECT subject_type, student_id, previous_last_name, new_last_name, changed_by, source FROM identity_changes WHERE guardian_id = 'g-2'");
      assert.deepEqual(row, { subject_type: 'guardian', student_id: null, previous_last_name: 'MRK-OPIEKUN-2', new_last_name: 'MRK-NOWE-OPIEKUN-2', changed_by: 'u-board-1a', source: 'api' });
      const [event] = await auditEvents('guardian.identity.updated');
      assert.deepEqual([event.entity_type, event.entity_id, event.metadata_json], ['guardian', 'g-2', { fields: ['lastName'] }]);
      assert.equal((await patchGuardian('g-2', { lastName: 'MRK-NOWE-OPIEKUN-2', reason: REASON }, cookies.boardA)).json.changed, false);
      assert.equal(await historyCount("guardian_id = 'g-2'"), 1);
    });

    test('opiekun z dziećmi w dwóch klasach: 403 guardian_shared_outside_scope, bez zapisu i wyroczni; zarząd bez przydziału klasy zmienia', async () => {
      const before = await snapshot();
      for (const body of [
        { firstName: 'MRK-NOWE-G1', reason: REASON },
        { firstName: 'Anna', reason: REASON }, // bez efektu — nadal ta sama reguła
      ]) {
        const res = await patchGuardian('g-1', body, cookies.boardA);
        assert.deepEqual({ status: res.status, json: res.json }, { status: 403, json: { error: 'guardian_shared_outside_scope' } });
      }
      assert.deepEqual(await snapshot(), before);
      const denied = await one("SELECT count(*)::int AS n FROM audit_events WHERE action = 'access.denied' AND entity_id = '/api/guardians/g-1/identity'");
      assert.equal(denied.n, 1, 'odmowa zakresu zostawia jeden ślad access.denied w oknie 5 minut');
      // Opiekun spoza zakresu klasy (tylko dziecko z 1B) i obcy: 404.
      assert.equal((await patchGuardian('g-x', { firstName: 'Zmiana', reason: REASON }, cookies.boardA)).status, 404);
      const full = await patchGuardian('g-1', { firstName: 'Anna Maria', reason: REASON }, cookies.board);
      assert.equal(full.status, 200, full.text);
      assert.equal(full.json.changed, true);
      assert.equal((await one("SELECT changed_by FROM identity_changes WHERE guardian_id = 'g-1'")).changed_by, 'u-board');
    });
  });

  describe('walidacja i bramka danych osobowych', () => {
    test('niepoprawna treść: 400 bez zapisu', async () => {
      const before = await snapshot();
      const cases = [
        [{ reason: REASON }, 'invalid_request'],
        [{ firstName: 'Ola' }, 'invalid_reason'],
        [{ firstName: 'Ola', reason: 'ab' }, 'invalid_reason'],
        [{ firstName: 'Ola', reason: 'x'.repeat(501) }, 'invalid_reason'],
        [{ firstName: '', reason: REASON }, 'invalid_person_name'],
        [{ firstName: '   ', reason: REASON }, 'invalid_person_name'],
        [{ firstName: null, reason: REASON }, 'invalid_person_name'],
        [{ lastName: 42, reason: REASON }, 'invalid_person_name'],
        [{ lastName: 'a@example.invalid', reason: REASON }, 'invalid_person_name'],
        [{ lastName: 'x'.repeat(101), reason: REASON }, 'invalid_person_name'],
        [{ firstName: 'Ola\u0000', reason: REASON }, 'invalid_person_name'],
        [{ firstName: 'Ola', reason: REASON, dataRequestId: 'nie-uuid' }, 'invalid_data_request_id'],
      ];
      for (const [body, code] of cases) {
        for (const res of [await patchStudent('s-a', body, cookies.board), await patchGuardian('g-2', body, cookies.board)]) {
          assert.equal(res.status, 400, JSON.stringify(body));
          assert.deepEqual(res.json, { error: code }, JSON.stringify(body));
        }
      }
      assert.deepEqual(await snapshot(), before);
    });

    test('powód z e-mailem lub IBAN-em: 422 personal_data_forbidden bez zapisu i bez flagi obejścia', async () => {
      const before = await snapshot();
      const iban = 'BE68539007547034';
      for (const reason of ['Zgłosił rodzic opiekun-1@example.invalid', `Przelew z rachunku ${iban}`]) {
        const res = await patchStudent('s-a', { firstName: 'MRK-NOWE-PII', reason, confirmPersonalData: true }, cookies.board);
        assert.equal(res.status, 422);
        assert.equal(res.json.error, 'personal_data_forbidden');
        assert.ok(!res.text.includes('example.invalid') && !res.text.includes(iban), 'odpowiedź bez fragmentu tekstu');
        assert.equal((await patchGuardian('g-2', { lastName: 'MRK-NOWE-PII', reason }, cookies.board)).status, 422);
      }
      assert.deepEqual(await snapshot(), before);
    });

    test('powód z numerem telefonu wymaga potwierdzenia (possible_personal_data), po potwierdzeniu zapis bez numeru w audycie', async () => {
      const reason = 'Rodzic dzwonił z numeru +32 470 12 34 56';
      const first = await patchStudent('s-b', { firstName: 'Janusz', reason }, cookies.board);
      assert.equal(first.status, 422);
      assert.equal(first.json.error, 'possible_personal_data');
      assert.equal((await names('students', 's-b')).first_name, 'Jan');
      const confirmed = await patchStudent('s-b', { firstName: 'Janusz', reason, confirmPersonalData: true }, cookies.board);
      assert.equal(confirmed.status, 200, confirmed.text);
      const event = (await auditEvents('student.identity.updated')).filter((row) => row.entity_id === 's-b').pop();
      assert.equal(event.metadata_json.piiConfirmed, true);
      assert.deepEqual(Object.keys(event.metadata_json).sort(), ['fields', 'piiCategories', 'piiConfirmed'], 'audyt: tylko kategorie, bez treści powodu');
    });
  });

  describe('niezmienność historii', () => {
    test('UPDATE, DELETE i TRUNCATE tabeli identity_changes są odrzucane; wpis nie zmienia się po błędzie', async () => {
      const row = await one('SELECT id, previous_first_name FROM identity_changes ORDER BY changed_at, id LIMIT 1');
      await assert.rejects(db.query("UPDATE identity_changes SET new_first_name = 'X' WHERE id = $1", [row.id]), /identity_changes_is_append_only/);
      await assert.rejects(db.query('UPDATE identity_changes SET reason = NULL WHERE id = $1', [row.id]), /identity_changes_is_append_only/);
      await assert.rejects(db.query('UPDATE identity_changes SET changed_at = now() WHERE id = $1', [row.id]), /identity_changes_is_append_only/);
      await assert.rejects(db.query('DELETE FROM identity_changes WHERE id = $1', [row.id]), /identity_changes_is_append_only/);
      await assert.rejects(db.query('TRUNCATE identity_changes'), /truncate_not_allowed/);
      assert.equal((await one('SELECT previous_first_name FROM identity_changes WHERE id = $1', [row.id])).previous_first_name, row.previous_first_name);
      // Antydatowany INSERT jest nadpisany zegarem bazy.
      await db.query(
        `INSERT INTO identity_changes (id, subject_type, student_id, previous_first_name, previous_last_name, new_first_name, new_last_name, source, changed_at)
         VALUES ('ic-backdated', 'student', 's-x', 'A', 'B', 'C', 'D', 'direct', '2001-01-01')`,
      );
      assert.ok((await one("SELECT changed_at FROM identity_changes WHERE id = 'ic-backdated'")).changed_at.getUTCFullYear() >= 2026);
    });

    test('baza odrzuca wpis bez dokładnie jednego podmiotu', async () => {
      const insert = (subject, student, guardian) => db.query(
        `INSERT INTO identity_changes (id, subject_type, student_id, guardian_id, previous_first_name, previous_last_name, new_first_name, new_last_name, source)
         VALUES (gen_random_uuid()::text, $1, $2, $3, 'A', 'B', 'C', 'D', 'direct')`, [subject, student, guardian]);
      await assert.rejects(insert('student', null, null), /identity_changes_subject_shape/);
      await assert.rejects(insert('student', 's-a', 'g-1'), /identity_changes_subject_shape/);
      await assert.rejects(insert('guardian', 's-a', null), /identity_changes_subject_shape/);
    });

    test('bezpośredni UPDATE imienia (np. import) zostawia wpis source=direct bez aktora; zmiana innej kolumny — nie', async () => {
      const before = await historyCount("student_id = 's-a'");
      await db.query("UPDATE students SET household_id = household_id WHERE id = 's-a'");
      await db.query("UPDATE students SET first_name = first_name WHERE id = 's-a'");
      assert.equal(await historyCount("student_id = 's-a'"), before, 'brak zmiany wartości — brak wpisu');
      await db.query("UPDATE students SET first_name = 'MRK-NOWE-DIRECT' WHERE id = 's-a'");
      const row = await one("SELECT source, changed_by, reason, new_first_name FROM identity_changes WHERE student_id = 's-a' ORDER BY changed_at DESC, id DESC LIMIT 1");
      assert.deepEqual(row, { source: 'direct', changed_by: null, reason: null, new_first_name: 'MRK-NOWE-DIRECT' });
      await db.query("UPDATE students SET first_name = 'MRK-NOWE-OLA' WHERE id = 's-a'");
    });
  });

  describe('powiązanie z żądaniem z rejestru (art. 16: sprostowanie)', () => {
    let rectification;
    const createRequest = async (body, status) => {
      const created = await call('/api/admin/data-requests', { method: 'POST', body: { receivedOn: '2026-10-15', ...body } });
      assert.equal(created.status, 201, created.text);
      const id = created.json.request.id;
      const order = ['identity_verified', 'in_progress', 'answered'];
      if (status) {
        for (const next of order.slice(0, order.indexOf(status) + 1)) {
          const moved = await call(`/api/admin/data-requests/${id}/status`, { method: 'POST', body: { status: next } });
          assert.equal(moved.status, 200, moved.text);
        }
      }
      return id;
    };

    test('admin z żądaniem rectification po weryfikacji: wpis z data_request_id, audyt z identyfikatorem żądania; żądanie nie jest zamykane', async () => {
      rectification = await createRequest({ kind: 'rectification', guardianId: 'g-2' }, 'identity_verified');
      const res = await patchStudent('s-a', { lastName: 'MRK-NOWE-ZADANIE', reason: REASON, dataRequestId: rectification }, cookies.admin);
      assert.equal(res.status, 200, res.text);
      const row = await one("SELECT data_request_id FROM identity_changes WHERE student_id = 's-a' ORDER BY changed_at DESC, id DESC LIMIT 1");
      assert.equal(row.data_request_id, rectification, 'żądanie opiekuna dotyczy jego dziecka');
      const event = (await auditEvents('student.identity.updated')).pop();
      assert.deepEqual(event.metadata_json, { fields: ['lastName'], dataSubjectRequestId: rectification });
      assert.equal((await one('SELECT status FROM data_subject_requests WHERE id = $1', [rectification])).status, 'identity_verified');
      // Kolejna zmiana bez identyfikatora żądania nie dziedziczy go z poprzedniej.
      assert.equal((await patchStudent('s-a', { lastName: 'MRK-UCZEN-A', reason: REASON }, cookies.admin)).status, 200);
      assert.equal((await one("SELECT data_request_id FROM identity_changes WHERE student_id = 's-a' ORDER BY changed_at DESC, id DESC LIMIT 1")).data_request_id, null);
    });

    test('inne role nie powiązują z rejestrem (widzi go tylko admin): 403 bez zapisu', async () => {
      const before = await snapshot();
      for (const key of ['board', 'boardA']) {
        const res = await patchGuardian('g-2', { firstName: 'Zmiana', reason: REASON, dataRequestId: rectification }, cookies[key]);
        assert.deepEqual({ status: res.status, json: res.json }, { status: 403, json: { error: 'forbidden' } }, key);
      }
      assert.deepEqual(await snapshot(), before);
    });

    test('żądanie innego rodzaju, niezweryfikowane, zamknięte, innej rodziny lub nieistniejące: odmowa bez zapisu', async () => {
      const access = await createRequest({ kind: 'access', guardianId: 'g-2' }, 'identity_verified');
      const received = await createRequest({ kind: 'rectification', guardianId: 'g-2' });
      const closed = await createRequest({ kind: 'rectification', guardianId: 'g-2' }, 'answered');
      const foreign = await createRequest({ kind: 'rectification', householdId: 'h-x' }, 'identity_verified');
      const before = await snapshot();
      const cases = [
        [access, 409, 'data_request_kind_not_rectification'],
        [received, 409, 'data_request_identity_not_verified'],
        [closed, 409, 'data_request_closed'],
        [foreign, 409, 'data_request_subject_mismatch'],
        ['00000000-0000-4000-8000-000000000000', 404, 'data_request_not_found'],
      ];
      for (const [dataRequestId, status, code] of cases) {
        const res = await patchGuardian('g-2', { firstName: 'MRK-NOWE-ODMOWA', reason: REASON, dataRequestId }, cookies.admin);
        assert.deepEqual({ status: res.status, json: res.json }, { status, json: { error: code } }, code);
      }
      assert.deepEqual(await snapshot(), before);
    });
  });

  describe('eksport danych rodziny i anonimizacja', () => {
    const adminCall = (path, body, method = 'POST') => call(path, { method, body });
    const verified = async (kind, subject) => {
      const created = await adminCall('/api/admin/data-requests', { kind, ...subject, receivedOn: '2026-10-16' });
      assert.equal(created.status, 201, created.text);
      const id = created.json.request.id;
      assert.equal((await adminCall(`/api/admin/data-requests/${id}/status`, { status: 'identity_verified' })).status, 200);
      return id;
    };

    test('eksport rodziny zawiera historię osób z zakresu (imiona przed i po, bez powodu) i nie zawiera cudzej', async () => {
      const id = await verified('access', { householdId: 'h-1' });
      const res = await adminCall(`/api/admin/data-requests/${id}/export`);
      assert.equal(res.status, 200, res.text);
      const rows = res.json.tables.identity_changes;
      assert.ok(Array.isArray(rows) && rows.length >= 3, 'historia ucznia s-a, s-b i opiekuna g-1');
      const subjects = new Set(rows.map((row) => row.student_id ?? row.guardian_id));
      assert.deepEqual([...subjects].sort(), ['g-1', 's-a', 's-b']);
      const first = rows.find((row) => row.student_id === 's-a' && row.previous_first_name === 'Ola');
      assert.deepEqual(
        [first.subject_type, first.previous_last_name, first.new_first_name, first.source],
        ['student', 'MRK-UCZEN-A', 'MRK-NOWE-OLA', 'api'],
      );
      assert.ok(!('reason' in first) && !('changed_by' in first) && !res.text.includes(REASON), 'bez powodu i aktora');
      // Drugi opiekun dziecka (inne gospodarstwo) i obca rodzina są pominięci (osoby trzecie).
      for (const marker of ['MRK-OPIEKUN-2', 'MRK-NOWE-OPIEKUN-2', 'MRK-OBCY', 'MRK-OBCE-DZIECKO', 'MRK-NOWE-OBCE']) {
        assert.ok(!res.text.includes(marker), `paczka zawiera ${marker}`);
      }
      assert.ok(!rows.some((row) => row.guardian_id === 'g-2' || row.student_id === 's-x'));
      // Eksport żądania opiekuna g-2 zawiera jego własną historię.
      const own = await adminCall(`/api/admin/data-requests/${await verified('access', { guardianId: 'g-2' })}/export`);
      assert.deepEqual(own.json.tables.identity_changes.filter((row) => row.guardian_id === 'g-2').map((row) => row.new_last_name), ['MRK-NOWE-OPIEKUN-2']);
    });

    test('eksport roczny nie zawiera historii imion (tabela świadomie wyłączona)', async () => {
      const { EXPORT_EXCLUDED_TABLES, EXPORT_TABLES } = await import('../src/pg/export.js');
      assert.ok(Object.hasOwn(EXPORT_EXCLUDED_TABLES, 'identity_changes'));
      assert.ok(!EXPORT_TABLES.some((spec) => spec.table === 'identity_changes'));
    });

    test('anonimizacja gospodarstwa czyści historię jego osób, zostawia wiersze i historię osób z innych gospodarstw; nie tworzy nowych wpisów', async () => {
      const erasure = await verified('erasure', { householdId: 'h-1' });
      const totalBefore = await historyCount();
      // s-a ma też gospodarstwo h-2 (opieka dzielona), więc zostaje do czasu anonimizacji h-2 — jak imię w `students`.
      const foreignSql = "SELECT id, new_last_name, reason FROM identity_changes WHERE guardian_id = 'g-2' OR student_id IN ('s-x', 's-a') ORDER BY id";
      const foreignBefore = (await db.query(foreignSql)).rows;
      assert.ok(foreignBefore.length >= 3);
      const preview = await adminCall('/api/admin/anonymizations', { householdId: 'h-1', reasonCode: 'data_subject_request', dataRequestId: erasure, dryRun: true });
      assert.equal(preview.status, 200, preview.text);
      assert.ok(preview.json.counts.identity_changes_guardians >= 1);
      assert.ok(preview.json.counts.identity_changes_students >= 1);
      assert.equal(preview.json.retained.students, 1, 's-a pozostaje (drugie gospodarstwo)');
      const applied = await adminCall('/api/admin/anonymizations', {
        householdId: 'h-1', reasonCode: 'data_subject_request', dataRequestId: erasure, dryRun: false,
        confirm: 'h-1', expectedPlanSha256: preview.json.planSha256,
      });
      assert.equal(applied.status, 201, applied.text);
      assert.equal(applied.json.status, 'applied');
      assert.equal(await historyCount(), totalBefore, 'przebieg nie dopisuje wierszy historii (nie kopiuje starych imion)');
      const cleaned = (await db.query("SELECT * FROM identity_changes WHERE guardian_id = 'g-1' OR student_id = 's-b' ORDER BY id")).rows;
      assert.ok(cleaned.length >= 2);
      for (const row of cleaned) {
        assert.deepEqual(
          [row.previous_first_name, row.previous_last_name, row.new_first_name, row.new_last_name, row.reason],
          ['[zanonimizowano]', '[zanonimizowano]', '[zanonimizowano]', '[zanonimizowano]', null], row.id,
        );
        assert.ok('changed_by' in row && row.changed_at && row.source === 'api', 'aktor, czas i źródło zostają');
      }
      const dump = JSON.stringify((await db.query('SELECT * FROM identity_changes WHERE guardian_id = $1 OR student_id = $2', ['g-1', 's-b'])).rows);
      for (const marker of ['MRK-UCZEN-B', 'MRK-NOWE-RÓWNOLEGLE', 'Janusz', 'MRK-OPIEKUN-1', 'Anna Maria', REASON]) assert.ok(!dump.includes(marker), `historia zawiera ${marker}`);
      // Osoby z innych gospodarstw (g-2 w h-2, s-x w h-x) i s-a (też w h-2) zostają nietknięte.
      const foreignAfter = (await db.query(foreignSql)).rows;
      assert.deepEqual(foreignAfter, foreignBefore);
      // Ponowienie: nic do zrobienia (podwójne kliknięcie).
      const again = await adminCall('/api/admin/anonymizations', {
        householdId: 'h-1', reasonCode: 'data_subject_request', dataRequestId: erasure, dryRun: false,
        confirm: 'h-1', expectedPlanSha256: preview.json.planSha256,
      });
      assert.equal(again.json.status, 'replayed');
      // Po przebiegu strażnik znów odrzuca zwykły UPDATE.
      await assert.rejects(db.query("UPDATE identity_changes SET reason = NULL WHERE guardian_id = 'g-2'"), /identity_changes_is_append_only/);
    });
  });
});
