// Pulpit przedstawiciela klasy (#118): jedna trasa zbiorcza. Wyłącznie dane
// syntetyczne (domeny .invalid).
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { emailHash } from '../src/email/content.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUserSession, seedPublishedPrivacyNotice } from './helpers/pg.js';

const Y = 'y-2026';
const Y_OLD = 'y-2025';

async function call(env, path, { cookie } = {}) {
  const response = await handlePgRequest(request(path, { cookie }), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

describe('pulpit przedstawiciela (#118)', () => {
  test('granice ról: brak przydziału representative → 403; brak sesji → 401', async () => {
    const db = await createTestDb();
    await seedPublishedPrivacyNotice(db); // #145: kampanie i kartki wymagają opublikowanej informacji
    await seedSchoolYear(db, Y);
    const env = { db };
    const board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board' }], mfa: true });
    const audit = await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit' }], mfa: true });
    const principal = await seedUserSession(db, { userId: 'u-principal', roles: [{ role: 'principal' }] });
    for (const cookie of [board, audit, principal]) {
      assert.equal((await call(env, `/api/representative/overview?schoolYearId=${Y}`, { cookie })).status, 403);
    }
    assert.equal((await call(env, `/api/representative/overview?schoolYearId=${Y}`)).status, 401);
    await db.close();
  });

  test('przedstawiciel z przydziałem zeszłego roku nie widzi klas bieżącego roku (bez 403)', async () => {
    const db = await createTestDb();
    await seedPublishedPrivacyNotice(db); // #145: kampanie i kartki wymagają opublikowanej informacji
    await seedSchoolYear(db, Y);
    await seedClass(db, { id: 'c-old', schoolYearId: Y_OLD, name: '1A (stary rok)' });
    const env = { db };
    const rep = await seedUserSession(db, { userId: 'u-rep-old', roles: [{ role: 'representative', classId: 'c-old', schoolYearId: Y_OLD }] });
    const result = await call(env, `/api/representative/overview?schoolYearId=${Y}`, { cookie: rep });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { schoolYearId: Y, classes: [] });
  });

  test('przedstawiciel dwóch klas widzi obie; rodzeństwo liczone w obu bez ujawnienia drugiego dziecka; kontakt i wydarzenia', async () => {
    const db = await createTestDb();
    await seedPublishedPrivacyNotice(db); // #145: kampanie i kartki wymagają opublikowanej informacji
    await seedClass(db, { id: 'c-1a', schoolYearId: Y, name: '1A' });
    await seedClass(db, { id: 'c-1b', schoolYearId: Y, name: '1B' });
    const env = { db };
    const rep = await seedUserSession(db, {
      userId: 'u-rep', roles: [
        { role: 'representative', classId: 'c-1a', schoolYearId: Y },
        { role: 'representative', classId: 'c-1b', schoolYearId: Y },
      ],
    });
    await db.exec(`
      INSERT INTO households (id) VALUES ('h-1'), ('h-2'), ('h-3');
      INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
        ('g-1', 'h-1', 'Anna', 'Testowa', 'g1@example.invalid', true),
        ('g-2', 'h-2', 'Piotr', 'Testowy', NULL, true),
        ('g-3', 'h-3', 'Ewa', 'Inna', 'g3@example.invalid', false);
      -- s-1 i s-2: rodzeństwo w dwóch różnych klasach, jedno gospodarstwo (h-1), z pełną zgodą.
      INSERT INTO students (id, household_id, first_name, last_name) VALUES
        ('s-1', 'h-1', 'Ola', 'Testowa'),
        ('s-2', 'h-1', 'Jan', 'Testowy'),
        -- s-3: opiekun bez e-maila -> do kartki.
        ('s-3', 'h-2', 'Kuba', 'Inny'),
        -- s-4: opiekun z e-mailem, ale bez zgody -> do kartki.
        ('s-4', 'h-3', 'Zosia', 'Nowak');
      INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES
        ('s-1', 'g-1', true, true), ('s-2', 'g-1', true, true),
        ('s-3', 'g-2', true, true), ('s-4', 'g-3', true, true);
      INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
        ('e-1', 's-1', 'c-1a', '${Y}'), ('e-2', 's-2', 'c-1b', '${Y}'),
        ('e-3', 's-3', 'c-1a', '${Y}'), ('e-4', 's-4', 'c-1b', '${Y}');
      INSERT INTO events (id, school_year_id, title, begins_at, created_by, class_id, audience, status, revision_no, updated_by) VALUES
        ('ev-1', '${Y}', 'Robocze 1A', '2026-11-01T10:00:00Z', 'u-rep', 'c-1a', 'internal', 'draft', 1, 'u-rep'),
        ('ev-2', '${Y}', 'Zgłoszone 1A', '2026-11-05T10:00:00Z', 'u-rep', 'c-1a', 'internal', 'draft', 1, 'u-rep');
      UPDATE events SET status = 'submitted', submitted_revision_no = 1, submitted_by = 'u-rep', submitted_at = now()
        WHERE id = 'ev-2';
    `);
    const result = await call(env, `/api/representative/overview?schoolYearId=${Y}`, { cookie: rep });
    assert.equal(result.status, 200);
    const byId = Object.fromEntries(result.data.classes.map((c) => [c.id, c]));
    assert.deepEqual(Object.keys(byId).sort(), ['c-1a', 'c-1b']);

    assert.equal(byId['c-1a'].studentCount, 2, 's-1 i s-3');
    assert.equal(byId['c-1a'].householdCount, 2, 'h-1 i h-2 — rodzeństwo w h-1 liczone raz');
    assert.equal(byId['c-1a'].needsPaperCardCount, 1, 's-3 (opiekun bez e-maila)');
    assert.deepEqual(byId['c-1a'].events, { draftCount: 1, submittedCount: 1 });

    assert.equal(byId['c-1b'].studentCount, 2, 's-2 i s-4');
    assert.equal(byId['c-1b'].needsPaperCardCount, 1, 's-4 (opiekun bez zgody)');
    assert.deepEqual(byId['c-1b'].events, { draftCount: 0, submittedCount: 0 });

    // Bez decyzji D-08: pole payments w ogóle nie istnieje w odpowiedzi.
    assert.equal(Object.hasOwn(result.data, 'payments'), false);
    for (const klass of result.data.classes) assert.equal(Object.hasOwn(klass, 'payments'), false);
    // Zakaz słów z AGENTS.md/D-08 w całej odpowiedzi.
    assert.doesNotMatch(JSON.stringify(result.data), /dłużnik|zaległoś|brak wpłaty|example\.invalid/i);

    await db.close();
  });

  test('uczeń, który odszedł (enrollments_current, #86/#285), nie jest liczony', async () => {
    const db = await createTestDb();
    await seedPublishedPrivacyNotice(db); // #145: kampanie i kartki wymagają opublikowanej informacji
    await seedClass(db, { id: 'c-1a', schoolYearId: Y, name: '1A' });
    const env = { db };
    const rep = await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: Y }] });
    await db.exec(`
      INSERT INTO households (id) VALUES ('h-1'), ('h-2');
      INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
        ('g-1', 'h-1', 'Anna', 'Testowa', 'g1@example.invalid', true),
        ('g-2', 'h-2', 'Piotr', 'Testowy', NULL, true);
      -- s-1: zostaje w klasie. s-2: odszedł (ended_on w przeszłości) -> nie liczy się nigdzie.
      INSERT INTO students (id, household_id, first_name, last_name) VALUES
        ('s-1', 'h-1', 'Ola', 'Testowa'),
        ('s-2', 'h-2', 'Kuba', 'Inny');
      INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES
        ('s-1', 'g-1', true, true), ('s-2', 'g-2', true, true);
      INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
        ('e-1', 's-1', 'c-1a', '${Y}'), ('e-2', 's-2', 'c-1a', '${Y}');
      UPDATE enrollments SET ended_on = '2020-01-01', ended_reason = 'zmiana szkoły', ended_at = now()
        WHERE id = 'e-2';
    `);
    const result = await call(env, `/api/representative/overview?schoolYearId=${Y}`, { cookie: rep });
    assert.equal(result.status, 200);
    const [klass] = result.data.classes;
    // Tylko s-1 (w klasie): s-2 (opiekun bez e-maila) wpadłby do needsPaperCardCount,
    // gdyby liczyło po `enrollments` wprost zamiast po `enrollments_current`.
    assert.equal(klass.studentCount, 1, 's-2 odszedł — nie liczony');
    assert.equal(klass.householdCount, 1, 'tylko h-1 (s-1)');
    assert.equal(klass.needsPaperCardCount, 0, 's-2 (bez e-maila) odszedł — nie trafia do kartki');
    await db.close();
  });

  test('kartki: dwoje opiekunów (jeden ze zgodą) → nie „do kartki”; blokada adresu (bounce) → „do kartki”', async () => {
    const db = await createTestDb();
    await seedPublishedPrivacyNotice(db); // #145: kampanie i kartki wymagają opublikowanej informacji
    await seedClass(db, { id: 'c-1a', schoolYearId: Y, name: '1A' });
    const env = { db };
    const rep = await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: Y }] });
    await db.exec(`
      INSERT INTO households (id) VALUES ('h-1'), ('h-2'), ('h-3');
      INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
        ('g-1a', 'h-1', 'Anna', 'Testowa', 'a@example.invalid', false),
        ('g-1b', 'h-1', 'Jan', 'Testowy', 'b@example.invalid', true),
        ('g-2', 'h-2', 'Piotr', 'Testowy', 'bounce@example.invalid', true),
        ('g-3', 'h-3', 'Ewa', 'Inna', 'zly-adres', true);
      INSERT INTO students (id, household_id, first_name, last_name) VALUES
        ('s-1', 'h-1', 'Ola', 'Testowa'), ('s-2', 'h-2', 'Kuba', 'Inny'), ('s-3', 'h-3', 'Zosia', 'Nowak');
      INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES
        ('s-1', 'g-1a', true, true), ('s-1', 'g-1b', true, false), ('s-2', 'g-2', true, true), ('s-3', 'g-3', true, true);
      INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
        ('e-1', 's-1', 'c-1a', '${Y}'), ('e-2', 's-2', 'c-1a', '${Y}'), ('e-3', 's-3', 'c-1a', '${Y}');
    `);
    const url = `/api/representative/overview?schoolYearId=${Y}`;
    let [klass] = (await call(env, url, { cookie: rep })).data.classes;
    // s-3 ma nieprawidłowy adres → do kartki; s-1 ma opiekuna ze zgodą; s-2 jeszcze osiągalny.
    assert.equal(klass.needsPaperCardCount, 1);
    await db.query("INSERT INTO email_suppressions (id, email_hash, reason) VALUES ($1, $2, 'hard_bounce')",
      [crypto.randomUUID(), emailHash('bounce@example.invalid')]);
    [klass] = (await call(env, url, { cookie: rep })).data.classes;
    assert.equal(klass.needsPaperCardCount, 2, 's-2 po bounce trafia do kartki');
    assert.doesNotMatch(JSON.stringify(klass), /example\.invalid|bounce|hash/);
    await db.close();
  });

  test('kartki, zebrania, dokumenty: data wydruku, najbliższe zebranie klasy, aktywne dokumenty; bez cudzych klas', async () => {
    const db = await createTestDb();
    await seedPublishedPrivacyNotice(db); // #145: kampanie i kartki wymagają opublikowanej informacji
    await seedClass(db, { id: 'c-1a', schoolYearId: Y, name: '1A' });
    await seedClass(db, { id: 'c-2b', schoolYearId: Y, name: '2B' });
    const env = { db };
    const rep = await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: Y }] });
    const future = new Date(Date.now() + 3 * 86400000).toISOString();
    const later = new Date(Date.now() + 9 * 86400000).toISOString();
    const past = new Date(Date.now() - 3 * 86400000).toISOString();
    await db.query(`INSERT INTO meetings (id, school_year_id, kind, class_id, title, scheduled_at, status, created_by) VALUES
      ('m-1', $1, 'class', 'c-1a', 'Zebranie 1A jesienne', $2, 'scheduled', 'u-rep'),
      ('m-2', $1, 'class', 'c-1a', 'Zebranie 1A późniejsze', $3, 'scheduled', 'u-rep'),
      ('m-3', $1, 'class', 'c-1a', 'Zebranie 1A robocze', $2, 'draft', 'u-rep'),
      ('m-4', $1, 'class', 'c-1a', 'Zebranie 1A minione', $4, 'scheduled', 'u-rep'),
      ('m-5', $1, 'class', 'c-2b', 'Zebranie 2B cudze', $2, 'scheduled', 'u-rep'),
      ('m-6', $1, 'board', NULL, 'Zebranie zarządu', $2, 'scheduled', 'u-rep')`, [Y, future, later, past]);
    const doc = (id, klass) => db.query(
      `INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by, school_year_id, class_id, sha256, idempotency_key)
       VALUES ($1, $2, 'application/pdf', 10, 'class', 'u-rep', $3, $4, repeat('0', 64), $5)`,
      [id, `docs/${id}`, Y, klass, `idem-${id}`]);
    await doc('00000000-0000-4000-8000-000000000001', 'c-1a');
    await doc('00000000-0000-4000-8000-000000000002', 'c-1a');
    await doc('00000000-0000-4000-8000-000000000003', 'c-2b');
    await db.query(`INSERT INTO document_status_events (id, document_id, action, reason, created_by)
      VALUES ('00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-000000000002', 'voided', 'pomyłkowy plik', 'u-rep')`);
    await db.query(`INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, metadata_json) VALUES
      ('a-1', 'u-rep', 'print.cards_requested', 'school_year', $1, '{"classId":"c-1a"}'::jsonb),
      ('a-2', 'u-rep', 'print.cards_requested', 'school_year', $1, '{"classId":"c-2b"}'::jsonb)`, [Y]);
    const before = (await db.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n;

    const { status, data } = await call(env, `/api/representative/overview?schoolYearId=${Y}`, { cookie: rep });
    assert.equal(status, 200);
    assert.deepEqual(data.classes.map((c) => c.id), ['c-1a'], 'tylko klasa z przydziału');
    const [klass] = data.classes;
    assert.equal(klass.nextMeeting.id, 'm-1', 'najbliższe zaplanowane zebranie tej klasy');
    assert.equal(klass.nextMeeting.title, 'Zebranie 1A jesienne');
    assert.equal(klass.documents.activeCount, 1, 'unieważniony i cudzej klasy nie liczone');
    assert.ok(klass.documents.latestAt);
    assert.ok(klass.cards.lastPrintedAt);
    assert.doesNotMatch(JSON.stringify(data), /2B|cudze|zarządu/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n, before, 'odczyt pulpitu nie dopisuje audytu');
    await db.close();
  });

  test('liczby pulpitu zgadzają się z listą klasy, kartkami i eksportem listy (te same dane)', async () => {
    const db = await createTestDb();
    await seedPublishedPrivacyNotice(db); // #145: kampanie i kartki wymagają opublikowanej informacji
    await seedClass(db, { id: 'c-1a', schoolYearId: Y, name: '1A' });
    await seedClass(db, { id: 'c-1b', schoolYearId: Y, name: '1B' });
    const env = { db };
    const rep = await seedUserSession(db, {
      userId: 'u-rep', mfa: true, roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: Y }],
    });
    await db.exec(`
      INSERT INTO households (id) VALUES ('h-1'), ('h-2');
      INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
        ('g-1', 'h-1', 'Anna', 'Testowa', 'g1@example.invalid', true),
        ('g-2', 'h-2', 'Piotr', 'Testowy', NULL, true);
      INSERT INTO students (id, household_id, first_name, last_name) VALUES
        ('s-1', 'h-1', 'Ola', 'Testowa'), ('s-2', 'h-1', 'Jan', 'Testowy'), ('s-3', 'h-2', 'Kuba', 'Inny');
      INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES
        ('s-1', 'g-1', true, true), ('s-2', 'g-1', true, true), ('s-3', 'g-2', true, true);
      INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
        ('e-1', 's-1', 'c-1a', '${Y}'), ('e-2', 's-2', 'c-1b', '${Y}'), ('e-3', 's-3', 'c-1a', '${Y}');
    `);
    const overview = (await call(env, `/api/representative/overview?schoolYearId=${Y}`, { cookie: rep })).data;
    assert.deepEqual(overview.classes.map((c) => c.id), ['c-1a']);
    const [klass] = overview.classes;
    const list = (await call(env, '/api/classes/c-1a/students', { cookie: rep })).data;
    const cards = await call(env, `/api/print/cards?schoolYearId=${Y}&classId=c-1a`, { cookie: rep });
    const roster = await call(env, '/api/exports/class-roster?classId=c-1a', { cookie: rep });
    assert.equal(list.students.length, klass.studentCount);
    assert.equal(cards.status, 200);
    assert.equal(cards.data.rows.length, klass.studentCount);
    assert.equal(roster.data.students.length, klass.studentCount);
    assert.equal(new Set(list.students.flatMap((s) => s.households.map((h) => h.householdId))).size, klass.householdCount);
    // Rodzeństwo w drugiej klasie: pulpit nie ujawnia drugiego dziecka ani drugiej klasy.
    assert.doesNotMatch(JSON.stringify(overview), /Jan|1B|c-1b|s-2/);
    assert.equal(klass.needsPaperCardCount, 1, 's-3 bez adresu e-mail');
    await db.close();
  });

  test('nieprawidłowy schoolYearId — 400', async () => {
    const db = await createTestDb();
    await seedPublishedPrivacyNotice(db); // #145: kampanie i kartki wymagają opublikowanej informacji
    const env = { db };
    const rep = await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-x', schoolYearId: Y }] });
    assert.equal((await call(env, '/api/representative/overview', { cookie: rep })).status, 400);
    assert.equal((await call(env, '/api/representative/overview?schoolYearId=', { cookie: rep })).status, 400);
    await db.close();
  });
});
