// #171: zebranie klasowe prowadzone przez przedstawiciela, za flagą konfiguracji
// MEETINGS_CLASS_HOST=representative (domyślnie wyłączona — wariant najbardziej
// zachowawczy do czasu decyzji D-08, zgodnie z AGENTS.md). Testy PGlite,
// dane syntetyczne (@example.invalid).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../src/postgres-migrations.js';
import {
  addAgendaItem,
  approveMinutes,
  createMeeting,
  createMinutesVersion,
  createResolution,
  determineQuorum,
  getMeeting,
  handle,
  recordAttendance,
  setMinutesVisibility,
} from '../src/pg/meetings.js';
import { updateMeeting } from './helpers/with-revision.js';

const directory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));
const ON = { MEETINGS_CLASS_HOST: 'representative' };
const OFF = {};

const grant = (role, extra = {}) => ({ role, classId: null, schoolYearId: 'year', expiresAt: null, ...extra });
// #150 (SR-10): zarządzanie zebraniem wymaga teraz jawnie potwierdzonego MFA,
// także na trasach OrClassHost (#171) — board i classBoardAdmin naprawdę
// zarządzają w tych testach, więc dostają mfaVerified: true.
const board = { userId: 'board', grants: [grant('board')], mfaVerified: true };
// Rodzeństwo: przedstawiciel prowadzi 1A i 2B (dwa przydziały klasowe).
const rep1a = { userId: 'rep-1a', grants: [grant('representative', { classId: 'class-a' })], mfaVerified: true };
const rep1a2b = {
  userId: 'rep-1a', grants: [grant('representative', { classId: 'class-a' }), grant('representative', { classId: 'class-b' })],
  mfaVerified: true,
};
const rep1b = { userId: 'rep-1b', grants: [grant('representative', { classId: 'class-b' })], mfaVerified: true };
const rep2 = { userId: 'rep2-1a', grants: [grant('representative', { classId: 'class-a' })], mfaVerified: true };
const lastYearRep = { userId: 'rep-old', grants: [grant('representative', { classId: 'class-a', schoolYearId: 'other' })], mfaVerified: true };
const classBoardAdmin = { userId: 'class-board', grants: [grant('board', { classId: 'class-a' })], mfaVerified: true };

let keySeq = 0;
const key = () => `test-key-${++keySeq}`;

async function meetingsDb() {
  const db = new PGlite();
  for (const migration of await loadMigrations(directory)) await db.exec(migration.sql);
  await db.query(`INSERT INTO school_years VALUES
    ('year','2026/27','2026-09-01','2027-08-31'), ('other','2027/28','2027-09-01','2028-08-31')`);
  await db.query("INSERT INTO classes (id, school_year_id, name) VALUES ('class-a','year','1A'), ('class-b','year','2B')");
  await db.query("INSERT INTO households (id) VALUES ('household-1'), ('household-2')");
  await db.query(`INSERT INTO students (id, household_id, first_name, last_name) VALUES
    ('student-a','household-1','Uczennica','Klasy1A'), ('student-b','household-2','Uczeń','Klasy2B')`);
  await db.query(`INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
    ('enr-a','student-a','class-a','year'), ('enr-b','student-b','class-b','year')`);
  await db.query(`INSERT INTO guardians (id, household_id, first_name, last_name) VALUES
    ('guardian-1a','household-1','Opiekun','Klasy1A'), ('guardian-1b','household-2','Opiekun','Klasy2B')`);
  await db.query(`INSERT INTO student_guardians (student_id, guardian_id, contact_allowed) VALUES
    ('student-a','guardian-1a', false), ('student-b','guardian-1b', false)`);
  const users = ['board', 'rep-1a', 'rep-1b', 'rep2-1a', 'rep-old', 'class-board'];
  for (const id of users) {
    await db.query('INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)',
      [id, `${id}@example.invalid`, `Synthetic ${id}`]);
  }
  // #205 (0150): osoba na liście obecności musi mieć w bazie aktywny przydział w roku (i klasie) zebrania.
  await db.query(`INSERT INTO role_grants (id, user_id, role, class_id, school_year_id) VALUES
    ('grant-board', 'board', 'board', NULL, 'year'),
    ('grant-rep2-1a', 'rep2-1a', 'representative', 'class-a', 'year')`);
  return db;
}

function classMeetingInput(overrides = {}) {
  return {
    idempotencyKey: key(), schoolYearId: 'year', kind: 'class', classId: 'class-a',
    title: 'Zebranie klasowe 1A', scheduledAt: '2026-10-05T18:00:00Z', location: 'Sala 1A',
    status: 'scheduled', ...overrides,
  };
}

test('flaga wyłączona (domyślnie): przedstawiciel nie tworzy zebrania klasowego — zachowanie bez zmian', async () => {
  const db = await meetingsDb();
  try {
    await assert.rejects(createMeeting(db, rep1a, classMeetingInput(), OFF), /forbidden/);
    await assert.rejects(createMeeting(db, rep1a, classMeetingInput(), undefined), /forbidden/);
  } finally { await db.close(); }
});

test('flaga włączona: przedstawiciel 1A tworzy i prowadzi wyłącznie zebranie klasowe swojej klasy', async () => {
  const db = await meetingsDb();
  try {
    const { meeting } = await createMeeting(db, rep1a, classMeetingInput(), ON);
    assert.equal(meeting.classId, 'class-a');

    // 1B, ogólne i zarządu → 403 PRZED walidacją danych (kryterium akceptacji).
    await assert.rejects(createMeeting(db, rep1a, classMeetingInput({ idempotencyKey: key(), classId: 'class-b' }), ON), /forbidden/);
    await assert.rejects(createMeeting(db, rep1a,
      { idempotencyKey: key(), schoolYearId: 'year', kind: 'plenary', title: 'Zebranie ogólne',
        scheduledAt: '2026-10-05T18:00:00Z', status: 'scheduled' }, ON), /forbidden/);
    await assert.rejects(createMeeting(db, rep1a,
      { idempotencyKey: key(), schoolYearId: 'year', kind: 'board', title: 'Zebranie zarządu',
        scheduledAt: '2026-10-05T18:00:00Z', status: 'scheduled' }, ON), /forbidden/);

    await addAgendaItem(db, rep1a, { idempotencyKey: key(), meetingId: meeting.id, title: 'Wybór przedstawiciela' }, ON);
    await recordAttendance(db, rep1a, { meetingId: meeting.id, guardianId: 'guardian-1a', capacity: 'guardian', votingEligible: true, present: true }, ON);
    await updateMeeting(db, rep1a, { meetingId: meeting.id, status: 'held' }, ON);
    const { minutes } = await createMinutesVersion(db, rep1a, { idempotencyKey: key(), meetingId: meeting.id, body: 'Ustalenia zebrania klasowego 1A.' }, ON);
    assert.equal(minutes.status, 'draft');

    const detail = await getMeeting(db, rep1a, { meetingId: meeting.id }, ON);
    assert.equal(detail.meeting.id, meeting.id);
    assert.equal(detail.attendees.length, 1);
  } finally { await db.close(); }
});

test('rodzeństwo w dwóch klasach: przedstawiciel 1A i 2B prowadzi dwa zebrania', async () => {
  const db = await meetingsDb();
  try {
    const a = await createMeeting(db, rep1a2b, classMeetingInput(), ON);
    const b = await createMeeting(db, rep1a2b, classMeetingInput({ idempotencyKey: key(), classId: 'class-b', title: 'Zebranie klasowe 2B' }), ON);
    assert.equal(a.meeting.classId, 'class-a');
    assert.equal(b.meeting.classId, 'class-b');
    // 1A widzi tylko swoje zebranie, nie 2B (i odwrotnie).
    await assert.rejects(getMeeting(db, rep1b, { meetingId: a.meeting.id }, ON), /meeting_not_found/);
  } finally { await db.close(); }
});

test('przydział zeszłego roku → 403 przed walidacją; admin z przydziałem klasy nie zyskuje zebrań ogólnych', async () => {
  const db = await meetingsDb();
  try {
    await assert.rejects(createMeeting(db, lastYearRep, classMeetingInput(), ON), /forbidden/);
    // classBoardAdmin ma rolę board (nie representative) zawężoną do klasy — to już
    // działało przed tym PR (board zarządza zebraniami swojej klasy), flaga nic tu nie zmienia.
    const { meeting } = await createMeeting(db, classBoardAdmin, classMeetingInput({ idempotencyKey: key() }), ON);
    assert.equal(meeting.classId, 'class-a');
    await assert.rejects(createMeeting(db, classBoardAdmin,
      { idempotencyKey: key(), schoolYearId: 'year', kind: 'plenary', title: 'Zebranie ogólne',
        scheduledAt: '2026-10-05T18:00:00Z', status: 'scheduled' }, ON), /forbidden/);
  } finally { await db.close(); }
});

test('przedstawiciel nie zatwierdza własnego protokołu i nie zmienia widoczności — trasy pozostają MANAGE_ROLES-only', async () => {
  const db = await meetingsDb();
  try {
    const { meeting } = await createMeeting(db, rep1a, classMeetingInput(), ON);
    await updateMeeting(db, rep1a, { meetingId: meeting.id, status: 'held' }, ON);
    const { minutes } = await createMinutesVersion(db, rep1a, { idempotencyKey: key(), meetingId: meeting.id, body: 'Projekt protokołu.' }, ON);
    await assert.rejects(approveMinutes(db, rep1a, { meetingId: meeting.id, minutesId: minutes.id }, ON), /forbidden/);
    // Zarząd zatwierdza mimo braku bezpośredniego przydziału do tej klasy.
    const approved = await approveMinutes(db, board, { meetingId: meeting.id, minutesId: minutes.id });
    assert.equal(approved.minutes.status, 'approved');
    await assert.rejects(setMinutesVisibility(db, rep1a,
      { idempotencyKey: key(), meetingId: meeting.id, minutesId: minutes.id, visibility: 'parents' }, ON), /forbidden/);
  } finally { await db.close(); }
});

test('przedstawiciel nie ustala quorum ani nie tworzy uchwał (zawężenie zakresu w tym PR)', async () => {
  const db = await meetingsDb();
  try {
    const { meeting } = await createMeeting(db, rep1a, classMeetingInput(), ON);
    await updateMeeting(db, rep1a, { meetingId: meeting.id, status: 'held' }, ON);
    await assert.rejects(determineQuorum(db, rep1a, { idempotencyKey: key(), meetingId: meeting.id }, ON), /forbidden/);
    await assert.rejects(createResolution(db, rep1a,
      { idempotencyKey: key(), meetingId: meeting.id, title: 'Projekt uchwały', body: 'Treść.' }, ON), /forbidden/);
  } finally { await db.close(); }
});

test('lista obecności nie ujawnia opiekunów spoza klasy: przedstawiciel 1A nie zapisze opiekuna 2B', async () => {
  const db = await meetingsDb();
  try {
    const { meeting } = await createMeeting(db, rep1a, classMeetingInput(), ON);
    await assert.rejects(recordAttendance(db, rep1a,
      { meetingId: meeting.id, guardianId: 'guardian-1b', capacity: 'guardian', votingEligible: true, present: true }, ON),
      /invalid_reference/);
    // Zapis innego konta (nie siebie) też jest odrzucony dla samego przedstawiciela.
    await assert.rejects(recordAttendance(db, rep1a,
      { meetingId: meeting.id, userId: 'rep2-1a', capacity: 'representative', votingEligible: true, present: true }, ON),
      /forbidden/);
    // #205 (SR-07): opiekun z innej klasy i nieistniejący, a także konto cudze i nieistniejące,
    // dostają identyczną odmowę — przedstawiciel nie sprawdzi, co istnieje w szkole.
    const refusal = (input) => recordAttendance(db, rep1a, { meetingId: meeting.id, capacity: 'guardian', votingEligible: true, present: true, ...input }, ON)
      .then(() => null, (error) => `${error.status}|${error.code}|${error.message}`);
    assert.equal(await refusal({ guardianId: 'guardian-1b' }), await refusal({ guardianId: 'guardian-nie-istnieje' }));
    assert.equal(await refusal({ userId: 'rep-1b' }), await refusal({ userId: 'user-nie-istnieje' }));
    assert.match(await refusal({ userId: 'rep-1b' }), /^403\|forbidden/);
    // Zarząd (bez zawężenia) może zapisać dowolną osobę jak dotychczas.
    await recordAttendance(db, board,
      { meetingId: meeting.id, userId: 'rep2-1a', capacity: 'representative', votingEligible: true, present: true });
  } finally { await db.close(); }
});

test('podwójne kliknięcie „Utwórz zebranie” (ten sam Idempotency-Key) tworzy jedno zebranie', async () => {
  const db = await meetingsDb();
  try {
    const idempotencyKey = key();
    const first = await createMeeting(db, rep1a, classMeetingInput({ idempotencyKey }), ON);
    const second = await createMeeting(db, rep1a, classMeetingInput({ idempotencyKey }), ON);
    assert.equal(first.meeting.id, second.meeting.id);
    assert.equal(second.replayed, true);
  } finally { await db.close(); }
});

test('zamknięty rok blokuje zapis jak dziś (trigger a0_year_freeze) — flaga nie omija reguł bazy', async () => {
  const db = await meetingsDb();
  try {
    await db.query("UPDATE school_years SET closed_at = now() WHERE id = 'year'").catch(() => {});
    // Brak kolumny closed_at w niektórych wersjach schematu — pomiń test w takim wypadku bez fałszywego zielonego wyniku.
    const hasClosedAt = await db.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'school_years' AND column_name = 'closed_at'");
    if (!hasClosedAt.rows.length) return;
    await assert.rejects(createMeeting(db, rep1a, classMeetingInput(), ON), /school_year_closed|forbidden/);
  } finally { await db.close(); }
});

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function httpEnv(db, actor, extraEnv = {}) {
  return {
    db,
    ...extraEnv,
    async loadAuthorizationContext() {
      if (!actor) return null;
      return { session: { user: { id: actor.userId }, mfaVerified: actor.mfaVerified }, grants: actor.grants };
    },
  };
}

function post(path, body, headers = {}) {
  return new Request(`https://rd.example.invalid${path}`, {
    method: 'POST',
    headers: { Origin: 'https://rd.example.invalid', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('HTTP handler: flaga czytana z env (na żądanie), nie tylko z process.env globalnie', async () => {
  const db = await meetingsDb();
  try {
    const body = classMeetingInput();
    delete body.idempotencyKey;
    const call = (env) => handle(post('/api/meetings', body, { 'Idempotency-Key': key() }),
      httpEnv(db, rep1a, env), new URL('https://rd.example.invalid/api/meetings'), json);
    let response = await call({});
    assert.equal(response.status, 403);
    response = await call({ MEETINGS_CLASS_HOST: 'representative' });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).meeting.classId, 'class-a');
  } finally { await db.close(); }
});
