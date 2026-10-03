// #208: testy z barierą na PRAWDZIWYM PostgreSQL dla kolejnych blokad wierszy
// `FOR UPDATE`, których jedynym punktem serializacji jest zapytanie w kodzie trasy:
// rodziny (tożsamość ucznia i opiekuna, zgoda na kontakt w relacji, zmiana klasy,
// zakończenie przypisania, relacji i członkostw, dodanie członkostwa), opis dokumentu,
// zdjęcia aktualności (cofnięcie kontra weryfikacja) oraz zebrania (edycja zebrania,
// edycja uchwały, obecność) oraz przyjęcie zaproszenia (#111: podwójne kliknięcie na prawdziwym
// PostgreSQL, powtarzane w nocnym przebiegu). Uzupełnia `pg-real-domain-locks.test.js`.
//
// Schemat jak w tamtym pliku: pierwsze żądanie zatrzymuje się W TRANSAKCJI po zapisie,
// drugie startuje osobnym połączeniem puli, test sprawdza w `pg_stat_activity`, że
// drugie czeka na zapytanie z blokadą z KODU TRASY (zwykły SELECT nigdy nie czeka na
// blokadę wiersza, więc czekający UPDATE/INSERT oznaczałby brak blokady), i dopiero
// potem wznawia pierwsze. Podwójne kliknięcie kończy się wtedy powtórką
// (`changed: false`), a nie drugim zapisem.
//
// Plik działa wyłącznie z RD_TEST_PG_URL (npm run test:pg-real); bez niej jest pomijany.
// Wyłącznie dane syntetyczne (@example.invalid). Żaden test nie wysyła wiadomości.
// Kontrola mutacyjna: scripts/check-lock-mutations.js (mutanty families-*, documents-description,
// news-photo-lock, meetings-update, meetings-resolution-update, meetings-attendance, invitation-accept).
import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptInvitation, createInvitation } from '../src/pg/auth.js';
import { seedClass, seedDocument, seedRoleGrant, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';
import { callApi, countRows } from './helpers/pg-barrier.js';
import { assertWaitsOn, auditCount, race, raceKey as key, withReal } from './helpers/pg-race.js';

const skip = process.env.RD_TEST_PG_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';
const YEAR = 'y-2026';
const DAY = 24 * 3600 * 1000;
const REASON = 'Zmiana opieki (syntetyczne)';

const boardSession = (db, userId) => seedUserSession(db, { userId, mfa: true, roles: [{ role: 'board' }] });
const post = (env, path, cookie, body) => callApi(env, 'POST', path, cookie, body);
const patch = (env, path, cookie, body) => callApi(env, 'PATCH', path, cookie, body);

// h-1: Ola (s-1, 1A) z opiekunem g-1; h-2: opiekun g-2; h-3: puste gospodarstwo do dołączenia.
// Członkostwa w gospodarstwach powstają z wierszy bazowych (wyzwalacze 0014/0163).
async function seedFamilies(db) {
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR, name: '1A' });
  await seedClass(db, { id: 'c-1b', schoolYearId: YEAR, name: '1B' });
  await db.exec(`
    INSERT INTO households (id) VALUES ('h-1'), ('h-2'), ('h-3');
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
      ('g-1', 'h-1', 'Anna', 'Testowa', 'g-1@example.invalid', true),
      ('g-2', 'h-2', 'Ewa', 'Testowa', 'g-2@example.invalid', true);
    INSERT INTO students (id, household_id, first_name, last_name) VALUES ('s-1', 'h-1', 'Ola', 'Testowa');
    INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ('s-1', 'g-1', true, true);
    INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('e-1', 's-1', 'c-1a', '${YEAR}');
  `);
  return { a: await boardSession(db, 'u-board-1'), b: await boardSession(db, 'u-board-2') };
}

// Dwa identyczne żądania: A zapisuje i czeka przed COMMIT, B czeka na blokadę wiersza
// (zapytanie zgodne z `waitsOn`), po zatwierdzeniu A jest powtórką z `changed: false`.
async function doubleClick(db, { method, path, body, pauseAfter, waitsOn, message, cookies }) {
  const call = method === 'PATCH' ? patch : post;
  const r = await race(db, {
    pauseAfter,
    first: (env) => call(env, path, cookies.a, body),
    second: (env) => call(env, path, cookies.b, body),
  });
  assertWaitsOn(r, waitsOn, message);
  assert.equal(r.a.status, 200, JSON.stringify(r.a.body));
  assert.equal(r.b.status, 200, JSON.stringify(r.b.body));
  assert.deepEqual([r.a.body.changed, r.b.body.changed], [true, false], `${message}: druga transakcja po blokadzie widzi zapis pierwszej`);
  return r;
}

// ---------------------------------------------------------------- rodziny

test('#208 (bariera, rodziny): dwie identyczne zmiany imienia ucznia — druga czeka na blokadę wiersza ucznia i jest powtórką', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await seedFamilies(db);
    const r = await doubleClick(db, {
      method: 'PATCH', path: '/api/students/s-1/identity', cookies, body: { firstName: 'Zofia', reason: REASON },
      pauseAfter: /UPDATE students SET first_name/, waitsOn: /^SELECT s\.id, s\.first_name, s\.last_name FROM students s/,
      message: 'druga zmiana tożsamości ucznia czeka na blokadę wiersza',
    });
    assert.equal(r.b.body.student.firstName, 'Zofia');
    assert.equal(await auditCount(db, 'student.identity.updated'), 1);
    assert.equal(await countRows(db, "SELECT count(*)::int AS n FROM identity_changes WHERE student_id = 's-1'"), 1);
  });
});

test('#208 (bariera, rodziny): dwie identyczne zmiany nazwiska opiekuna — druga czeka na blokadę wiersza opiekuna i jest powtórką', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await seedFamilies(db);
    await doubleClick(db, {
      method: 'PATCH', path: '/api/guardians/g-1/identity', cookies, body: { lastName: 'Nowakowska', reason: REASON },
      pauseAfter: /UPDATE guardians SET first_name/, waitsOn: /^SELECT g\.id, g\.first_name, g\.last_name/,
      message: 'druga zmiana tożsamości opiekuna czeka na blokadę wiersza',
    });
    assert.equal(await auditCount(db, 'guardian.identity.updated'), 1);
    assert.equal(await countRows(db, "SELECT count(*)::int AS n FROM identity_changes WHERE guardian_id = 'g-1'"), 1);
  });
});

test('#208 (bariera, rodziny): dwie identyczne zmiany zgody na kontakt w relacji — druga czeka na blokadę relacji i jest powtórką', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await seedFamilies(db);
    await doubleClick(db, {
      method: 'PATCH', path: '/api/guardians/g-1/students/s-1', cookies, body: { contactAllowed: false, reason: REASON },
      pauseAfter: /UPDATE student_guardians SET contact_allowed/, waitsOn: /^SELECT sg\.contact_allowed/,
      message: 'druga zmiana zgody czeka na blokadę wiersza relacji',
    });
    assert.equal(await auditCount(db, 'student_guardian.contact.updated'), 1);
    assert.equal(await countRows(db, "SELECT count(*)::int AS n FROM student_guardian_changes WHERE student_id = 's-1' AND guardian_id = 'g-1' AND new_contact_allowed = false"), 1);
  });
});

test('#208 (bariera, rodziny): dwie identyczne zmiany klasy — druga czeka na blokadę ucznia i jest powtórką', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await seedFamilies(db);
    const body = { schoolYearId: YEAR, classId: 'c-1b', effectiveOn: '2026-10-05', reason: REASON };
    await doubleClick(db, {
      method: 'POST', path: '/api/students/s-1/enrollments', cookies, body,
      pauseAfter: /UPDATE enrollments SET class_id/, waitsOn: /^SELECT s\.id FROM students s WHERE s\.id = \$5/,
      message: 'druga zmiana klasy czeka na blokadę wiersza ucznia',
    });
    assert.equal(await auditCount(db, 'enrollment.class_changed'), 1);
    assert.equal((await db.query("SELECT class_id FROM enrollments WHERE id = 'e-1'")).rows[0].class_id, 'c-1b');
  });
});

test('#208 (bariera, rodziny): dwa zakończenia przypisania ucznia — drugie czeka na blokadę przypisania i jest powtórką', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await seedFamilies(db);
    const r = await doubleClick(db, {
      method: 'POST', path: '/api/students/s-1/enrollments/e-1/end', cookies, body: { endedOn: '2026-10-15', reason: REASON },
      pauseAfter: /UPDATE enrollments SET ended_on/, waitsOn: /^SELECT e\.id, to_char\(e\.ended_on/,
      message: 'drugie zakończenie przypisania czeka na blokadę wiersza',
    });
    assert.equal(r.b.body.enrollment.endedOn, '2026-10-15');
    assert.equal(await auditCount(db, 'enrollment.withdrawn'), 1);
  });
});

test('#208 (bariera, rodziny): dwa zakończenia relacji opiekun–dziecko — drugie czeka na blokadę relacji i jest powtórką', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await seedFamilies(db);
    const r = await doubleClick(db, {
      method: 'POST', path: '/api/guardians/g-1/students/s-1/end', cookies, body: { endsOn: '2020-01-01', reason: REASON },
      pauseAfter: /UPDATE student_guardians SET ends_on/, waitsOn: /^SELECT to_char\(rel\.ends_on/,
      message: 'drugie zakończenie relacji czeka na blokadę wiersza',
    });
    assert.equal(r.b.body.relation.endsOn, '2020-01-01');
    assert.equal(await auditCount(db, 'student_guardian.ended'), 1);
  });
});

test('#208 (bariera, rodziny): dwa zakończenia członkostwa ucznia w gospodarstwie — drugie czeka na blokadę członkostwa i jest powtórką', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await seedFamilies(db);
    const membership = (await db.query("SELECT id FROM student_households WHERE student_id = 's-1' AND ends_on IS NULL")).rows[0].id;
    const r = await doubleClick(db, {
      method: 'POST', path: `/api/students/s-1/households/${membership}/end`, cookies, body: { endsOn: '2020-01-01', reason: REASON },
      pauseAfter: /UPDATE student_households SET ends_on/, waitsOn: /^SELECT sh\.household_id, sh\.is_primary/,
      message: 'drugie zakończenie członkostwa ucznia czeka na blokadę wiersza',
    });
    assert.equal(r.b.body.membership.endsOn, '2020-01-01');
    assert.equal(await auditCount(db, 'student_household.ended'), 1);
  });
});

test('#208 (bariera, rodziny): dwa zakończenia członkostwa opiekuna w gospodarstwie — drugie czeka na blokadę członkostwa i jest powtórką', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await seedFamilies(db);
    const membership = (await db.query("SELECT id FROM guardian_households WHERE guardian_id = 'g-1' AND household_id = 'h-1'")).rows[0].id;
    const r = await doubleClick(db, {
      method: 'POST', path: `/api/guardians/g-1/households/${membership}/end`, cookies, body: { endsOn: '2020-01-01', reason: REASON },
      pauseAfter: /UPDATE guardian_households SET ends_on/, waitsOn: /^SELECT gh\.household_id, to_char\(gh\.starts_on/,
      message: 'drugie zakończenie członkostwa opiekuna czeka na blokadę wiersza',
    });
    assert.equal(r.b.body.membership.endsOn, '2020-01-01');
    assert.equal(await auditCount(db, 'guardian_household.ended'), 1);
  });
});

test('#208 (bariera, rodziny): dwa identyczne dodania członkostwa ucznia — drugie czeka na blokadę ucznia i jest powtórką (jedno członkostwo)', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await seedFamilies(db);
    const body = { householdId: 'h-3', startsOn: '2020-01-01', reason: REASON };
    const r = await race(db, {
      pauseAfter: /INSERT INTO student_households/,
      first: (env) => post(env, '/api/students/s-1/households', cookies.a, body),
      second: (env) => post(env, '/api/students/s-1/households', cookies.b, body),
    });
    assertWaitsOn(r, /^SELECT s\.id FROM students s WHERE s\.id = \$5/, 'drugie dodanie członkostwa czeka na blokadę wiersza ucznia');
    assert.deepEqual([r.a.status, r.a.body.changed], [201, true], JSON.stringify(r.a.body));
    assert.deepEqual([r.b.status, r.b.body.changed], [200, false], JSON.stringify(r.b.body));
    assert.equal(r.a.body.membership.id, r.b.body.membership.id);
    assert.equal(await countRows(db, "SELECT count(*)::int AS n FROM student_households WHERE student_id = 's-1' AND household_id = 'h-3'"), 1);
    assert.equal(await auditCount(db, 'student_household.added'), 1);
  });
});

// ---------------------------------------------------------------- dokumenty

test('#208 (bariera, dokumenty): dwa opisy tego samego dokumentu pod różnymi kluczami — drugi czeka na blokadę dokumentu i dostaje następną wersję', { skip }, async () => {
  await withReal(async (db) => {
    await seedSchoolYear(db, YEAR);
    const treasurer = await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by, school_year_id, sha256, idempotency_key)
       VALUES ($1, $2, 'application/pdf', 10, 'financial', 'u-tr', $3, $4, 'doc-key-0-0000')`,
      [id, `docs/${id}`, YEAR, '0'.repeat(64)],
    );
    const path = `/api/documents/${id}/description`;
    const r = await race(db, {
      pauseAfter: /INSERT INTO document_descriptions/,
      first: (env) => callApi(env, 'POST', path, treasurer, { title: 'Opis A syntetyczny', category: 'inne' }, key('desc')),
      second: (env) => callApi(env, 'POST', path, treasurer, { title: 'Opis B syntetyczny', category: 'inne' }, key('desc')),
    });
    assertWaitsOn(r, /^SELECT id, kind, school_year_id, class_id FROM documents WHERE id = \$1/, 'drugi opis czeka na blokadę dokumentu');
    assert.deepEqual([r.a.status, r.a.body.description.revisionNo], [201, 1], JSON.stringify(r.a.body));
    assert.deepEqual([r.b.status, r.b.body.description.revisionNo], [201, 2], JSON.stringify(r.b.body));
    assert.equal(await countRows(db, 'SELECT count(*)::int AS n FROM document_descriptions WHERE document_id = $1', [id]), 2);
    assert.equal(await auditCount(db, 'document.described'), 2);
  });
});

// ---------------------------------------------------------------- aktualności

test('#208 (bariera, aktualności): cofnięcie praw do zdjęcia równolegle z weryfikacją — weryfikacja czeka na blokadę zdjęcia i dostaje 409 photo_revoked', { skip }, async () => {
  await withReal(async (db) => {
    await seedSchoolYear(db, YEAR);
    const admin = await seedUserSession(db, { userId: 'u-admin', mfa: true, roles: [{ role: 'admin' }] });
    const boardA = await boardSession(db, 'u-board-1');
    const boardB = await boardSession(db, 'u-board-2');
    const documentId = await seedDocument(db, { id: crypto.randomUUID(), createdBy: 'u-admin' });
    const registered = await callApi({ db }, 'POST', '/api/news-photos', admin, {
      documentId, author: 'Fotograf testowy', source: 'own_work', takenOn: '2026-10-10',
      licenseText: 'Zdjęcie własne autora, udostępnione Radzie do publikacji.',
      altText: 'Stół kiermaszowy z ciastami', depictsChildren: false,
    }, key('photo'));
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const photoId = registered.body.photo.id;
    const r = await race(db, {
      pauseAfter: /UPDATE news_photos SET rights_status = 'revoked'/,
      first: (env) => post(env, `/api/news-photos/${photoId}/revoke`, boardA, { reason: 'Cofnięcie syntetyczne' }),
      second: (env) => post(env, `/api/news-photos/${photoId}/verify`, boardB, {}),
    });
    assertWaitsOn(r, /FROM news_photos WHERE id = \$1/, 'weryfikacja czeka na blokadę wiersza zdjęcia');
    assert.equal(r.a.status, 200, JSON.stringify(r.a.body));
    assert.deepEqual([r.b.status, r.b.body.error], [409, 'photo_revoked']);
    assert.equal((await db.query('SELECT rights_status FROM news_photos WHERE id = $1', [photoId])).rows[0].rights_status, 'revoked');
    assert.equal(await auditCount(db, 'news_photo.rights_verified'), 0);
    assert.equal(await auditCount(db, 'news_photo.revoked'), 1);
  });
});

// ---------------------------------------------------------------- zebrania

const inDays = (days) => new Date(Date.now() + days * DAY).toISOString();

async function meetingSetup(db) {
  await seedSchoolYear(db, YEAR);
  const board = await seedUserSession(db, { userId: 'u-board-1', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] });
  const created = await callApi({ db }, 'POST', '/api/meetings', board, {
    schoolYearId: YEAR, kind: 'plenary', title: 'Zebranie plenarne', scheduledAt: inDays(20), location: 'Sala 1', status: 'scheduled',
  }, key('mt'));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { board, meeting: created.body.meeting };
}

test('#208 (bariera, zebrania): dwie edycje tytułu zebrania z tej samej rewizji — druga czeka na blokadę zebrania i dostaje 409 revision_conflict', { skip }, async () => {
  await withReal(async (db) => {
    const { board, meeting } = await meetingSetup(db);
    const path = `/api/meetings/${meeting.id}`;
    const r = await race(db, {
      pauseAfter: /UPDATE meetings SET title/,
      first: (env) => patch(env, path, board, { title: 'Tytuł A syntetyczny', revision: meeting.revisionNo }),
      second: (env) => patch(env, path, board, { title: 'Tytuł B syntetyczny', revision: meeting.revisionNo }),
    });
    assertWaitsOn(r, /^SELECT \* FROM meetings WHERE id = \$1/, 'druga edycja czeka na blokadę wiersza zebrania');
    assert.equal(r.a.status, 200, JSON.stringify(r.a.body));
    assert.deepEqual([r.b.status, r.b.body.error], [409, 'revision_conflict']);
    assert.equal((await db.query('SELECT title FROM meetings WHERE id = $1', [meeting.id])).rows[0].title, 'Tytuł A syntetyczny');
    assert.equal(await auditCount(db, 'meeting.updated'), 1);
  });
});

test('#208 (bariera, zebrania): dwie edycje projektu uchwały z tej samej rewizji — druga czeka na blokadę uchwały i dostaje 409 revision_conflict', { skip }, async () => {
  await withReal(async (db) => {
    const { board, meeting } = await meetingSetup(db);
    const created = await callApi({ db }, 'POST', `/api/meetings/${meeting.id}/resolutions`, board, {
      title: 'Projekt uchwały syntetycznej', body: 'Treść projektu uchwały.',
    }, key('res'));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const resolution = created.body.resolution;
    const path = `/api/meetings/${meeting.id}/resolutions/${resolution.id}`;
    const r = await race(db, {
      pauseAfter: /UPDATE resolutions SET number/,
      first: (env) => patch(env, path, board, { title: 'Tytuł A syntetyczny', revision: resolution.revisionNo }),
      second: (env) => patch(env, path, board, { title: 'Tytuł B syntetyczny', revision: resolution.revisionNo }),
    });
    assertWaitsOn(r, /^SELECT \* FROM resolutions WHERE id = \$1/, 'druga edycja czeka na blokadę wiersza uchwały');
    assert.equal(r.a.status, 200, JSON.stringify(r.a.body));
    assert.deepEqual([r.b.status, r.b.body.error], [409, 'revision_conflict']);
    assert.equal((await db.query('SELECT title FROM resolutions WHERE id = $1', [resolution.id])).rows[0].title, 'Tytuł A syntetyczny');
    assert.equal(await auditCount(db, 'resolution.updated'), 1);
  });
});

test('#208 (bariera, zebrania): dwie korekty obecności tej samej osoby — druga czeka na blokadę wiersza obecności i obie są zapisane po kolei', { skip }, async () => {
  await withReal(async (db) => {
    const { board, meeting } = await meetingSetup(db);
    await seedRoleGrant(db, { userId: 'u-att', role: 'board' });
    const path = `/api/meetings/${meeting.id}/attendance`;
    const base = { userId: 'u-att', capacity: 'board_member', votingEligible: true };
    const first = await post({ db }, path, board, { ...base, present: true });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const r = await race(db, {
      pauseAfter: /UPDATE meeting_attendees SET capacity/,
      first: (env) => post(env, path, board, { ...base, present: false }),
      second: (env) => post(env, path, board, { ...base, present: true }),
    });
    assertWaitsOn(r, /^SELECT id FROM meeting_attendees WHERE meeting_id = \$1/, 'druga korekta czeka na blokadę wiersza obecności');
    assert.deepEqual([r.a.status, r.b.status], [200, 200], JSON.stringify([r.a.body, r.b.body]));
    assert.equal((await db.query('SELECT present FROM meeting_attendees WHERE meeting_id = $1', [meeting.id])).rows[0].present, true, 'druga korekta jest ostatnia');
    assert.equal(await auditCount(db, 'meeting.attendance.recorded'), 1);
    assert.equal(await auditCount(db, 'meeting.attendance.corrected'), 2);
  });
});

// ---------------------------------------------------------------- zaproszenia

test('#111 (bariera, zaproszenia): podwójne przyjęcie tego samego zaproszenia — drugie czeka na blokadę wiersza zaproszenia i dostaje already_used, jeden przydział', { skip }, async () => {
  await withReal(async (db) => {
    await seedSchoolYear(db, YEAR);
    await seedClass(db, { id: 'c-1a', schoolYearId: YEAR, name: '1A' });
    await seedUser(db, { userId: 'u-admin' });
    await seedUser(db, { userId: 'u-rep', email: 'rep.synthetic@example.invalid' });
    const invite = await createInvitation({ db }, {
      actorId: 'u-admin', email: 'rep.synthetic@example.invalid', role: 'representative', classId: 'c-1a', schoolYearId: YEAR,
    });
    const accept = (env) => acceptInvitation(env, { token: invite.secret, userId: 'u-rep' });
    const r = await race(db, { pauseAfter: /UPDATE invitations SET accepted_at/, first: accept, second: accept });
    assertWaitsOn(r, /^SELECT id, email, role, class_id, school_year_id, created_by/, 'drugie przyjęcie czeka na blokadę wiersza zaproszenia');
    assert.equal(r.a.ok, true, JSON.stringify(r.a));
    assert.deepEqual([r.b.ok, r.b.error, r.b.reason], [false, 'invalid_invitation', 'already_used']);
    assert.equal(await countRows(db, "SELECT count(*)::int AS n FROM role_grants WHERE user_id = 'u-rep' AND source_invitation_id = $1", [invite.invitationId]), 1);
    assert.equal(await auditCount(db, 'invitation.accepted'), 1);
  });
});
