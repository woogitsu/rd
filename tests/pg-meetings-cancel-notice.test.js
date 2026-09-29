// #113: odwołanie i zmiana terminu zebrania (przejścia stanu z powodem i audytem),
// wersjonowane zawiadomienie z porządkiem obrad, szkic kampanii e-mail wyłącznie
// po zatwierdzeniu i widok publiczny tylko zatwierdzonych danych. Testy PGlite przez
// handlePgRequest; dane syntetyczne (@example.invalid), nic nie wychodzi z procesu.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { computeSnapshot } from '../src/pg/routes/email.js';
import { createTestDb, networkGuardCalls, request, seedClass, seedUserSession } from './helpers/pg.js';

const YEAR = 'y2026';
const DAY = 86400000;
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString();

async function setup(extraEnv = {}) {
  const db = await createTestDb();
  await seedClass(db, { id: 'ca', schoolYearId: YEAR, name: '1A' });
  await seedClass(db, { id: 'cb', schoolYearId: YEAR, name: '2B' });
  const s = (userId, roles, mfa = true) => seedUserSession(db, { userId, roles, mfa });
  const cookies = {
    board: await s('u-bd', [{ role: 'board', schoolYearId: YEAR }]),
    board2: await s('u-bd2', [{ role: 'board', schoolYearId: YEAR }]),
    boardNoMfa: await s('u-bd3', [{ role: 'board', schoolYearId: YEAR }], false),
    boardA: await s('u-bda', [{ role: 'board', schoolYearId: YEAR, classId: 'ca' }]),
    repA: await s('u-repa', [{ role: 'representative', schoolYearId: YEAR, classId: 'ca' }]),
    audit: await s('u-au', [{ role: 'audit', schoolYearId: YEAR }]),
  };
  const env = { db, APP_ENV: 'development', ...extraEnv };
  const call = async (cookie, method, path, body, headers = {}) => {
    const response = await handlePgRequest(request(path, { method, cookie, body, headers }), env);
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  };
  const count = async (sql, params = []) => Number((await db.query(sql, params)).rows[0].n);
  let seq = 0;
  const create = async (overrides = {}, cookie = cookies.board) => {
    const res = await call(cookie, 'POST', '/api/meetings', {
      schoolYearId: YEAR, kind: 'plenary', title: 'Zebranie plenarne', scheduledAt: inDays(20),
      location: 'Sala 1', status: 'scheduled', ...overrides,
    }, { 'Idempotency-Key': `meeting-key-${++seq}-${Math.random().toString(36).slice(2)}` });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.meeting;
  };
  const addItem = async (meeting, title, cookie = cookies.board) => {
    const res = await call(cookie, 'POST', `/api/meetings/${meeting.id}/agenda-items`, { title },
      { 'Idempotency-Key': `item-key-${++seq}-${Math.random().toString(36).slice(2)}` });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.agendaItem;
  };
  const view = async (meeting, cookie = cookies.board) => {
    const res = await call(cookie, 'GET', `/api/meetings/${meeting.id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  };
  const revision = async (meeting) => (await view(meeting)).meeting.revisionNo;
  const audits = async (action) => (await db.query(
    'SELECT * FROM audit_events WHERE action = $1 ORDER BY occurred_at, id', [action])).rows;
  // Zatwierdzone zawiadomienie: szkic (board) + zatwierdzenie (board2 — inna osoba).
  const approvedNotice = async (meeting) => {
    const draft = await call(cookies.board, 'POST', `/api/meetings/${meeting.id}/notices`, {});
    assert.ok([200, 201].includes(draft.status), JSON.stringify(draft.body));
    const approved = await call(cookies.board2, 'POST',
      `/api/meetings/${meeting.id}/notices/${draft.body.notice.id}/approval`, {});
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    return approved.body.notice;
  };
  return { db, env, cookies, call, count, create, addItem, view, revision, audits, approvedNotice, close: () => db.close() };
}

async function family(db, id, { classes = ['ca'], guardians = 1 } = {}) {
  await db.query('INSERT INTO households (id) VALUES ($1)', [id]);
  for (let i = 1; i <= guardians; i += 1) {
    await db.query(
      `INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
       VALUES ($1, $2, 'Opiekun', 'Syntetyczny', $3, true)`,
      [`${id}-g${i}`, id, `${id}-g${i}@example.invalid`]);
  }
  for (const classId of classes) {
    const studentId = `${id}-s-${classId}`;
    await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, $2, 'Uczeń', $1)", [studentId, id]);
    await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)',
      [`e-${studentId}`, studentId, classId, YEAR]);
    for (let i = 1; i <= guardians; i += 1) {
      await db.query('INSERT INTO student_guardians (student_id, guardian_id, contact_allowed) VALUES ($1, $2, true)',
        [studentId, `${id}-g${i}`]);
    }
  }
}

// ---------- odwołanie ----------

test('odwołanie wymaga powodu, zapisuje kto/kiedy/dlaczego i jedno zdarzenie; podwójne kliknięcie to powtórka', async () => {
  const t = await setup();
  try {
    const meeting = await t.create();
    const path = `/api/meetings/${meeting.id}/cancellation`;

    for (const body of [{ revision: 1 }, { revision: 1, reason: 'ab' }, { revision: 1, reason: 'x'.repeat(501) }]) {
      const bad = await t.call(t.cookies.board, 'POST', path, body);
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error, 'invalid_reason');
    }
    assert.equal((await t.call(t.cookies.board, 'POST', path, { reason: 'Brak sali' })).body.error, 'invalid_revision');
    assert.equal((await t.view(meeting)).meeting.status, 'scheduled');

    const first = await t.call(t.cookies.board, 'POST', path, { reason: 'Brak sali na ten termin', revision: 1 });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.replayed, false);
    assert.equal(first.body.meeting.status, 'cancelled');
    assert.equal(first.body.meeting.cancellationReason, 'Brak sali na ten termin');
    assert.equal(first.body.meeting.cancelledBy, 'u-bd');
    assert.ok(first.body.meeting.cancelledAt);

    // Drugie kliknięcie z tą samą (już nieaktualną) wersją: powtórka, bez drugiego zdarzenia.
    const second = await t.call(t.cookies.board, 'POST', path, { reason: 'Brak sali na ten termin', revision: 1 });
    assert.equal(second.status, 200);
    assert.equal(second.body.replayed, true);
    const events = await t.audits('meeting.cancelled');
    assert.equal(events.length, 1);
    assert.equal(events[0].entity_id, meeting.id);
    assert.equal(events[0].actor_id, 'u-bd');
    assert.equal(events[0].metadata_json.schoolYearId, YEAR);
    assert.equal(events[0].metadata_json.fromStatus, 'scheduled');
    // Powód jest wolnym tekstem: zostaje w wierszu zebrania, nie w metadanych dziennika.
    assert.ok(!JSON.stringify(events[0].metadata_json).includes('Brak sali'));

    // Inny powód po odwołaniu to konflikt, a nie cicha zmiana historii.
    const other = await t.call(t.cookies.board, 'POST', path, { reason: 'Inny powód', revision: 1 });
    assert.equal(other.status, 409);
    assert.equal(other.body.error, 'meeting_cancelled');
    assert.equal((await t.view(meeting)).meeting.cancellationReason, 'Brak sali na ten termin');
  } finally { await t.close(); }
});

test('odwołane zebranie nie przyjmuje obecności, porządku, quorum, protokołu, uchwał ani edycji (409)', async () => {
  const t = await setup();
  try {
    const meeting = await t.create();
    const item = await t.addItem(meeting, 'Punkt pierwszy');
    const cancelled = await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/cancellation`,
      { reason: 'Odwołanie testowe', revision: await t.revision(meeting) });
    assert.equal(cancelled.status, 200);
    const base = `/api/meetings/${meeting.id}`;
    const post = (path, body, headers = {}) => t.call(t.cookies.board, 'POST', `${base}${path}`, body, headers);
    const key = () => ({ 'Idempotency-Key': `k-${Math.random().toString(36).slice(2)}-abcdefgh` });

    const attempts = {
      attendance: await post('/attendance', { userId: 'u-bd', capacity: 'board_member', votingEligible: true, present: true }),
      agenda: await post('/agenda-items', { title: 'Nowy punkt' }, key()),
      withdraw: await post(`/agenda-items/${item.id}/withdrawal`, {}),
      quorum: await post('/quorum-checks', {}, key()),
      minutes: await post('/minutes', { body: 'Protokół roboczy zebrania' }, key()),
      resolution: await post('/resolutions', { title: 'Uchwała', body: 'Treść', status: 'draft' }, key()),
      edit: await t.call(t.cookies.board, 'PATCH', base, { revision: await t.revision(meeting), title: 'Nowy tytuł' }),
      reschedule: await post('/reschedule', { scheduledAt: inDays(30), reason: 'Nowy termin', revision: await t.revision(meeting) }),
    };
    for (const [name, res] of Object.entries(attempts)) {
      assert.equal(res.status, 409, `${name}: ${JSON.stringify(res.body)}`);
    }
    assert.equal(attempts.attendance.body.error, 'meeting_cancelled');
    assert.equal(attempts.agenda.body.error, 'meeting_cancelled');
    assert.equal(attempts.edit.body.error, 'meeting_cancelled');
    assert.equal(attempts.reschedule.body.error, 'meeting_cancelled');
    assert.ok(['quorum_requires_held_meeting', 'meeting_cancelled'].includes(attempts.quorum.body.error));
    assert.ok(['minutes_require_held_meeting', 'meeting_cancelled'].includes(attempts.minutes.body.error));
    assert.ok(['resolution_requires_held_meeting', 'meeting_cancelled'].includes(attempts.resolution.body.error));

    // PATCH statusu nie omija powodu: 'cancelled' tylko przez dedykowaną trasę.
    const viaPatch = await t.call(t.cookies.board, 'PATCH', `/api/meetings/${(await t.create()).id}`,
      { revision: 1, status: 'cancelled' });
    assert.equal(viaPatch.status, 400);
    // Odwołanie jest końcowe także w bazie (bezpośredni UPDATE z pominięciem API).
    await assert.rejects(t.db.query("UPDATE meetings SET status = 'scheduled' WHERE id = $1", [meeting.id]),
      /meeting_cancelled/);
    await assert.rejects(t.db.query('DELETE FROM meetings WHERE id = $1', [meeting.id]), /meetings_cannot_be_deleted/);
  } finally { await t.close(); }
});

test('odwołać można tylko szkic i zebranie zaplanowane; zebranie odbyte to 409', async () => {
  const t = await setup();
  try {
    const draft = await t.create({ status: 'draft' });
    const ok = await t.call(t.cookies.board, 'POST', `/api/meetings/${draft.id}/cancellation`,
      { reason: 'Szkic niepotrzebny', revision: 1 });
    assert.equal(ok.status, 200);

    const held = await t.create();
    const toHeld = await t.call(t.cookies.board, 'PATCH', `/api/meetings/${held.id}`, { revision: 1, status: 'held' });
    assert.equal(toHeld.status, 200, JSON.stringify(toHeld.body));
    const res = await t.call(t.cookies.board, 'POST', `/api/meetings/${held.id}/cancellation`,
      { reason: 'Za późno', revision: await t.revision(held) });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'meeting_status_transition_invalid');
    assert.equal((await t.view(held)).meeting.status, 'held');
  } finally { await t.close(); }
});

test('granice ról: odwołanie, zmiana terminu i zawiadomienia tylko dla zarządu z MFA i właściwym zakresem', async () => {
  const t = await setup();
  try {
    const plenary = await t.create();
    const classMeeting = await t.create({ kind: 'class', classId: 'ca', title: 'Zebranie klasy 1A' });
    const otherClass = await t.create({ kind: 'class', classId: 'cb', title: 'Zebranie klasy 2B' });
    await t.addItem(classMeeting, 'Punkt klasowy');
    const revisionOf = (m) => t.revision(m);
    const cancelBody = async (m) => ({ reason: 'Powód testowy', revision: await revisionOf(m) });
    const rescheduleBody = async (m) => ({ scheduledAt: inDays(40), reason: 'Nowy termin', revision: await revisionOf(m) });

    for (const [name, cookie] of Object.entries({ repA: t.cookies.repA, audit: t.cookies.audit, boardA: t.cookies.boardA })) {
      // Zarząd z przydziałem klasy nie zarządza zebraniem ogólnym ani cudzej klasy; przedstawiciel
      // klasy i Komisja Rewizyjna nie zarządzają żadnym.
      for (const target of name === 'boardA' ? [plenary, otherClass] : [plenary, classMeeting, otherClass]) {
        const base = `/api/meetings/${target.id}`;
        assert.equal((await t.call(cookie, 'POST', `${base}/cancellation`, await cancelBody(target))).status, 403, `${name} cancel`);
        assert.equal((await t.call(cookie, 'POST', `${base}/reschedule`, await rescheduleBody(target))).status, 403, `${name} reschedule`);
        assert.equal((await t.call(cookie, 'POST', `${base}/notices`, {})).status, 403, `${name} notice`);
        assert.equal((await t.call(cookie, 'POST', `${base}/notices/n1/approval`, {})).status, 403, `${name} approval`);
        assert.equal((await t.call(cookie, 'POST', `${base}/notices/n1/campaign-draft`, {})).status, 403, `${name} campaign`);
      }
    }
    assert.equal((await t.view(plenary)).meeting.status, 'scheduled');
    assert.equal((await t.audits('meeting.cancelled')).length, 0);

    // Brak potwierdzonego MFA: 403 mfa_required, bez zapisu.
    const noMfa = await t.call(t.cookies.boardNoMfa, 'POST', `/api/meetings/${plenary.id}/cancellation`, await cancelBody(plenary));
    assert.equal(noMfa.status, 403);
    assert.equal((await t.view(plenary)).meeting.status, 'scheduled');

    // Zarząd z przydziałem klasy 1A obsługuje wyłącznie zebranie klasy 1A.
    const own = await t.call(t.cookies.boardA, 'POST', `/api/meetings/${classMeeting.id}/notices`, {});
    assert.equal(own.status, 201, JSON.stringify(own.body));
    // Przedstawiciel klasy nie widzi zawiadomień (odczyt szczegółów zebrania jest wewnętrzny).
    assert.equal((await t.call(t.cookies.repA, 'GET', `/api/meetings/${classMeeting.id}`)).status, 404);
    // Brak sesji.
    assert.equal((await t.call(undefined, 'POST', `/api/meetings/${plenary.id}/cancellation`, await cancelBody(plenary))).status, 401);
    // Zebranie innej klasy: zarząd klasy 1A nie widzi zawiadomień 2B.
    assert.equal((await t.call(t.cookies.boardA, 'GET', `/api/meetings/${otherClass.id}`)).status, 404);
  } finally { await t.close(); }
});

// ---------- zmiana terminu ----------

test('zmiana terminu wymaga powodu, zapisuje starą i nową datę, jedno zdarzenie; podwójne kliknięcie to powtórka', async () => {
  const t = await setup();
  try {
    const meeting = await t.create({ scheduledAt: '2026-11-10T17:00:00Z' });
    const path = `/api/meetings/${meeting.id}/reschedule`;
    assert.equal((await t.call(t.cookies.board, 'POST', path, { scheduledAt: '2026-11-17T17:00:00Z', revision: 1 })).body.error, 'invalid_reason');
    assert.equal((await t.call(t.cookies.board, 'POST', path, { reason: 'Kolizja terminów', revision: 1 })).status, 400);
    assert.equal((await t.call(t.cookies.board, 'POST', path, { scheduledAt: '2026-11-10T17:00:00Z', reason: 'Ten sam', revision: 1 })).body.error, 'reschedule_no_change');

    const body = { scheduledAt: '2026-11-17T17:00:00Z', reason: 'Kolizja terminów', revision: 1 };
    const first = await t.call(t.cookies.board, 'POST', path, body);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.replayed, false);
    assert.equal(first.body.meeting.scheduledAt, '2026-11-17T17:00:00.000Z');
    assert.equal(first.body.rescheduleNotice, null, 'bez zatwierdzonego zawiadomienia nie ma czego poprawiać');
    const second = await t.call(t.cookies.board, 'POST', path, body);
    assert.equal(second.status, 200);
    assert.equal(second.body.replayed, true);

    const events = await t.audits('meeting.rescheduled');
    assert.equal(events.length, 1);
    assert.equal(events[0].metadata_json.fromScheduledAt, '2026-11-10T17:00:00.000Z');
    assert.equal(events[0].metadata_json.toScheduledAt, '2026-11-17T17:00:00.000Z');
    assert.ok(!JSON.stringify(events[0].metadata_json).includes('Kolizja'));
    const detail = await t.view(meeting);
    assert.equal(detail.reschedules.length, 1);
    assert.equal(detail.reschedules[0].reason, 'Kolizja terminów');
    assert.equal(detail.reschedules[0].actorId, 'u-bd');
    // Tabela jest dopisywana: żadnego UPDATE ani DELETE, nawet bezpośrednio.
    await assert.rejects(t.db.query("UPDATE meeting_reschedules SET reason = 'zmiana'"), /meeting_reschedules_cannot_be_changed/);
    await assert.rejects(t.db.query('DELETE FROM meeting_reschedules'), /meeting_reschedules_cannot_be_changed/);

    // Nieaktualna wersja zebrania: konflikt.
    const stale = await t.call(t.cookies.board, 'POST', path, { scheduledAt: '2026-11-24T17:00:00Z', reason: 'Kolejna zmiana', revision: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'revision_conflict');
  } finally { await t.close(); }
});

test('po zatwierdzonym zawiadomieniu PATCH nie zmienia terminu; zmiana terminu tworzy tylko szkic nowego zawiadomienia', async () => {
  const t = await setup();
  try {
    const meeting = await t.create();
    await t.addItem(meeting, 'Sprawozdanie');
    const notice = await t.approvedNotice(meeting);
    assert.equal(notice.kind, 'invitation');

    const patch = await t.call(t.cookies.board, 'PATCH', `/api/meetings/${meeting.id}`,
      { revision: await t.revision(meeting), scheduledAt: inDays(25) });
    assert.equal(patch.status, 409);
    assert.equal(patch.body.error, 'use_reschedule_endpoint');
    // Inne pola nadal edytuje się zwykłym PATCH.
    const title = await t.call(t.cookies.board, 'PATCH', `/api/meetings/${meeting.id}`,
      { revision: await t.revision(meeting), location: 'Sala 2' });
    assert.equal(title.status, 200);

    const before = await t.count('SELECT count(*) AS n FROM email_campaigns');
    const moved = await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/reschedule`,
      { scheduledAt: inDays(27), reason: 'Zmiana sali i terminu', revision: await t.revision(meeting) });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.rescheduleNotice.kind, 'reschedule');
    assert.equal(moved.body.rescheduleNotice.status, 'draft');
    assert.equal(moved.body.rescheduleNotice.version, 2);
    assert.equal(moved.body.rescheduleNotice.previousScheduledAt !== null, true);
    assert.equal(await t.count('SELECT count(*) AS n FROM email_campaigns'), before, 'zmiana terminu nie tworzy kampanii');
    assert.equal(await t.count('SELECT count(*) AS n FROM email_outbox'), 0);
  } finally { await t.close(); }
});

// ---------- porządek obrad i zawiadomienie ----------

test('zawiadomienie: porządek obrad wymagany, wersje niezmienne, cztery oczy, ponowienie to powtórka', async () => {
  const t = await setup();
  try {
    const meeting = await t.create();
    const path = `/api/meetings/${meeting.id}/notices`;
    const empty = await t.call(t.cookies.board, 'POST', path, {});
    assert.equal(empty.status, 409);
    assert.equal(empty.body.error, 'notice_requires_agenda');

    await t.addItem(meeting, 'Sprawozdanie zarządu');
    const item2 = await t.addItem(meeting, 'Wolne wnioski');
    const first = await t.call(t.cookies.board, 'POST', path, {});
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.notice.kind, 'invitation');
    assert.equal(first.body.notice.status, 'draft');
    assert.equal(first.body.notice.version, 1);
    // Podwójne kliknięcie: ta sama wersja, jedno zdarzenie.
    const again = await t.call(t.cookies.board, 'POST', path, {});
    assert.equal(again.status, 200);
    assert.equal(again.headers.get('Idempotency-Replayed'), 'true');
    assert.equal(again.body.notice.id, first.body.notice.id);
    assert.equal((await t.audits('meeting.notice.created')).length, 1);
    assert.equal((await t.audits('meeting.agenda_version.created')).length, 1);

    // Autor nie zatwierdza własnego zawiadomienia.
    const self = await t.call(t.cookies.board, 'POST', `${path}/${first.body.notice.id}/approval`, {});
    assert.equal(self.status, 403);
    assert.equal(self.body.error, 'notice_four_eyes_required');
    const detail0 = await t.view(meeting);
    assert.equal(detail0.notices[0].status, 'draft');

    const approved = await t.call(t.cookies.board2, 'POST', `${path}/${first.body.notice.id}/approval`, {});
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.notice.status, 'approved');
    assert.equal(approved.body.replayed, false);
    const replay = await t.call(t.cookies.board2, 'POST', `${path}/${first.body.notice.id}/approval`, {});
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    const approvals = await t.audits('meeting.notice.approved');
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].actor_id, 'u-bd2');
    assert.equal(approvals[0].metadata_json.schoolYearId, YEAR);
    assert.equal(approvals[0].metadata_json.contentHash, first.body.notice.contentHash);

    // Treść zatwierdzonego zawiadomienia jest niezmienna w bazie.
    await assert.rejects(t.db.query("UPDATE meeting_notices SET title = 'Zmiana'"), /meeting_notice_immutable/);
    await assert.rejects(t.db.query('DELETE FROM meeting_notices'), /meeting_notices_cannot_be_deleted/);
    await assert.rejects(t.db.query("UPDATE meeting_agenda_versions SET content_hash = repeat('a', 64)"),
      /meeting_agenda_versions_cannot_be_changed/);

    // Nic się nie zmieniło: nowa wersja nie jest potrzebna.
    const nothing = await t.call(t.cookies.board, 'POST', path, {});
    assert.equal(nothing.status, 409);
    assert.equal(nothing.body.error, 'notice_up_to_date');

    // Zmiana porządku po zatwierdzeniu: zawiadomienie przestaje być aktualne (unieważnienie),
    // a szkic kampanii z niego nie powstaje.
    const withdrawn = await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/agenda-items/${item2.id}/withdrawal`, {});
    assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
    assert.equal(withdrawn.body.agendaItem.withdrawnAt !== null, true);
    const withdrawAgain = await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/agenda-items/${item2.id}/withdrawal`, {});
    assert.equal(withdrawAgain.body.replayed, true);
    assert.equal((await t.audits('meeting.agenda_item.withdrawn')).length, 1);
    const detail1 = await t.view(meeting);
    assert.equal(detail1.notices[0].outdated, true);
    const stale = await t.call(t.cookies.board, 'POST', `${path}/${first.body.notice.id}/campaign-draft`, {});
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'notice_outdated');
    assert.equal(await t.count('SELECT count(*) AS n FROM email_campaigns'), 0);

    // Nowa wersja: kolejny szkic z nową migawką porządku (bez wycofanego punktu).
    const second = await t.call(t.cookies.board, 'POST', path, {});
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(second.body.notice.kind, 'update');
    assert.equal(second.body.notice.version, 2);
    const versions = (await t.view(meeting)).agendaVersions;
    assert.equal(versions.length, 2);
    assert.deepEqual(versions[0].items.map((i) => i.title), ['Sprawozdanie zarządu', 'Wolne wnioski']);
    assert.deepEqual(versions[1].items.map((i) => i.title), ['Sprawozdanie zarządu']);
    assert.notEqual(versions[0].contentHash, versions[1].contentHash);
    // Starsza wersja nie jest już najnowsza; zatwierdzenie nowej jest osobnym krokiem.
    const oldCampaign = await t.call(t.cookies.board, 'POST', `${path}/${first.body.notice.id}/campaign-draft`, {});
    assert.equal(oldCampaign.body.error, 'notice_not_latest');
    // Wycofanie jest trwałe także w bazie.
    await assert.rejects(t.db.query('UPDATE meeting_agenda_items SET withdrawn_at = NULL, withdrawn_by = NULL WHERE id = $1', [item2.id]),
      /agenda_item_withdrawal_immutable/);
  } finally { await t.close(); }
});

test('zatwierdzenie starszej wersji i przestarzałej treści jest odrzucone; spóźnione zawiadomienie tylko odnotowane', async () => {
  const t = await setup();
  try {
    // Reguła: co najmniej 14 dni; zebranie za 5 dni -> odnotowane jako spóźnione, ale zatwierdzone (bez blokady).
    const late = await t.create({ scheduledAt: inDays(5), noticeMinDays: 14, noticeRuleSource: 'Założenie testowe (D-21)' });
    await t.addItem(late, 'Punkt');
    const lateNotice = await t.approvedNotice(late);
    assert.equal(lateNotice.noticeLate, true);
    assert.ok(lateNotice.noticeDaysBefore >= 4 && lateNotice.noticeDaysBefore <= 5);
    assert.equal((await t.audits('meeting.notice.approved'))[0].metadata_json.noticeLate, true);

    const ontime = await t.create({ scheduledAt: inDays(30), noticeMinDays: 14, noticeRuleSource: 'Założenie testowe (D-21)' });
    await t.addItem(ontime, 'Punkt');
    assert.equal((await t.approvedNotice(ontime)).noticeLate, false);

    const noRule = await t.create({ scheduledAt: inDays(2) });
    await t.addItem(noRule, 'Punkt');
    assert.equal((await t.approvedNotice(noRule)).noticeLate, null);

    // Reguła terminu podawana razem (jak reguła quorum).
    const half = await t.call(t.cookies.board, 'POST', '/api/meetings', {
      schoolYearId: YEAR, kind: 'plenary', title: 'Zebranie z połową reguły', scheduledAt: inDays(20), noticeMinDays: 7,
    }, { 'Idempotency-Key': 'half-rule-key-1' });
    assert.equal(half.status, 400);
    assert.equal(half.body.error, 'invalid_notice_rule');

    // Zmiana tytułu po sporządzeniu szkicu: szkic jest nieaktualny i nie da się go zatwierdzić.
    const meeting = await t.create();
    await t.addItem(meeting, 'Punkt');
    const draft = await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/notices`, {});
    await t.call(t.cookies.board, 'PATCH', `/api/meetings/${meeting.id}`, { revision: 1, title: 'Zmieniony tytuł zebrania' });
    const stale = await t.call(t.cookies.board2, 'POST', `/api/meetings/${meeting.id}/notices/${draft.body.notice.id}/approval`, {});
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'notice_outdated');
    // Nowa wersja zastępuje szkic; zatwierdzenie starej wersji jest odrzucone jako nienajnowsze.
    const fresh = await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/notices`, {});
    assert.equal(fresh.body.notice.version, 2);
    const old = await t.call(t.cookies.board2, 'POST', `/api/meetings/${meeting.id}/notices/${draft.body.notice.id}/approval`, {});
    assert.equal(old.body.error, 'notice_not_latest');
    // Zawiadomienie zebrania w szkicu nie jest zatwierdzane, dopóki zebranie nie jest zaplanowane.
    const inDraft = await t.create({ status: 'draft' });
    await t.addItem(inDraft, 'Punkt');
    const d = await t.call(t.cookies.board, 'POST', `/api/meetings/${inDraft.id}/notices`, {});
    assert.equal(d.status, 201);
    const notScheduled = await t.call(t.cookies.board2, 'POST', `/api/meetings/${inDraft.id}/notices/${d.body.notice.id}/approval`, {});
    assert.equal(notScheduled.body.error, 'meeting_not_scheduled');
    assert.equal((await t.call(t.cookies.board2, 'POST', `/api/meetings/${inDraft.id}/notices/nieistniejace/approval`, {})).body.error, 'notice_not_found');
  } finally { await t.close(); }
});

test('odwołanie po zatwierdzonym zawiadomieniu tworzy tylko szkic zawiadomienia o odwołaniu', async () => {
  const t = await setup();
  try {
    const meeting = await t.create();
    await t.addItem(meeting, 'Punkt');
    await t.approvedNotice(meeting);
    const res = await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/cancellation`,
      { reason: 'Choroba prowadzącego', revision: await t.revision(meeting) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.cancellationNotice.kind, 'cancellation');
    assert.equal(res.body.cancellationNotice.status, 'draft');
    const detail = await t.view(meeting);
    assert.deepEqual(detail.notices.map((n) => [n.version, n.kind, n.status]), [[1, 'invitation', 'approved'], [2, 'cancellation', 'draft']]);
    // Publicznie nadal tylko zatwierdzone (zaproszenie); odwołanie pojawia się dopiero po zatwierdzeniu.
    const pub1 = await t.call(undefined, 'GET', `/api/meetings/public-notices?schoolYearId=${YEAR}`);
    assert.equal(pub1.body.notices[0].kind, 'invitation');
    const ok = await t.call(t.cookies.board2, 'POST', `/api/meetings/${meeting.id}/notices/${detail.notices[1].id}/approval`, {});
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const pub2 = await t.call(undefined, 'GET', `/api/meetings/public-notices?schoolYearId=${YEAR}`);
    assert.equal(pub2.body.notices.length, 1);
    assert.equal(pub2.body.notices[0].cancelled, true);
    assert.deepEqual(pub2.body.notices[0].agenda, []);
    assert.ok(!JSON.stringify(pub2.body).includes('Choroba'), 'powód odwołania jest wewnętrzny');
    assert.equal(networkGuardCalls(), 0);
    assert.equal(await t.count('SELECT count(*) AS n FROM email_outbox'), 0);
    // Zamknięcie: po odwołaniu nie powstaje kolejna wersja zawiadomienia o zebraniu.
    const more = await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/notices`, {});
    assert.equal(more.body.error, 'meeting_cancelled');
  } finally { await t.close(); }
});

// ---------- widok publiczny ----------

test('publicznie widać wyłącznie zatwierdzone zawiadomienia zebrań ogólnych, bez opisów i powodów', async () => {
  const t = await setup();
  try {
    const pub = () => t.call(undefined, 'GET', `/api/meetings/public-notices?schoolYearId=${YEAR}`);
    assert.equal((await pub()).status, 200);
    assert.deepEqual((await pub()).body.notices, []);

    const meeting = await t.create({ title: 'Zebranie ogólne jesień', location: 'Aula' });
    const item = await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/agenda-items`,
      { title: 'Sprawozdanie', description: 'Opis wewnętrzny punktu' }, { 'Idempotency-Key': 'agenda-desc-key-1' });
    assert.equal(item.status, 201);
    const draft = await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/notices`, {});
    assert.deepEqual((await pub()).body.notices, [], 'szkic zawiadomienia nie jest publiczny');
    await t.call(t.cookies.board2, 'POST', `/api/meetings/${meeting.id}/notices/${draft.body.notice.id}/approval`, {});
    const shown = (await pub()).body.notices;
    assert.equal(shown.length, 1);
    assert.equal(shown[0].title, 'Zebranie ogólne jesień');
    assert.equal(shown[0].location, 'Aula');
    assert.deepEqual(shown[0].agenda, [{ position: 1, title: 'Sprawozdanie' }]);
    assert.ok(!JSON.stringify(shown).includes('Opis wewnętrzny'));

    // Zebranie klasowe i zebranie zarządu nie trafiają na stronę publiczną.
    const classMeeting = await t.create({ kind: 'class', classId: 'ca', title: 'Zebranie klasy 1A' });
    await t.addItem(classMeeting, 'Punkt klasowy');
    await t.approvedNotice(classMeeting);
    const boardMeeting = await t.create({ kind: 'board', title: 'Posiedzenie zarządu' });
    await t.addItem(boardMeeting, 'Punkt zarządu');
    await t.approvedNotice(boardMeeting);
    assert.equal((await pub()).body.notices.length, 1);
    // Inny rok szkolny: pusto.
    assert.deepEqual((await t.call(undefined, 'GET', '/api/meetings/public-notices?schoolYearId=inny')).body.notices, []);
    // Tylko GET.
    assert.equal((await t.call(undefined, 'POST', '/api/meetings/public-notices', {})).status, 405);
    // Zebranie cofnięte do szkicu znika z widoku publicznego.
    await t.call(t.cookies.board, 'PATCH', `/api/meetings/${meeting.id}`, { revision: await t.revision(meeting), status: 'draft' });
    assert.deepEqual((await pub()).body.notices, []);
  } finally { await t.close(); }
});

// ---------- szkic kampanii ----------

test('szkic kampanii powstaje wyłącznie z zatwierdzonego zawiadomienia i niczego nie wysyła', async () => {
  const t = await setup();
  try {
    const meeting = await t.create({ title: 'Zebranie ogólne', scheduledAt: '2026-12-01T18:00:00Z', location: 'Aula' });
    await t.addItem(meeting, 'Sprawozdanie');
    await t.addItem(meeting, 'Wolne wnioski');
    const draft = await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/notices`, {});
    const campaignPath = `/api/meetings/${meeting.id}/notices/${draft.body.notice.id}/campaign-draft`;
    const early = await t.call(t.cookies.board, 'POST', campaignPath, {});
    assert.equal(early.status, 409);
    assert.equal(early.body.error, 'notice_not_approved');
    assert.equal(await t.count('SELECT count(*) AS n FROM email_campaigns'), 0);

    await t.call(t.cookies.board2, 'POST', `/api/meetings/${meeting.id}/notices/${draft.body.notice.id}/approval`, {});
    const made = await t.call(t.cookies.board, 'POST', campaignPath, {});
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.campaign.status, 'draft');
    assert.equal(made.body.campaign.audience, 'all_households');
    assert.equal(made.body.sent, false);
    const again = await t.call(t.cookies.board, 'POST', campaignPath, {});
    assert.equal(again.status, 200);
    assert.equal(again.body.campaign.id, made.body.campaign.id);
    assert.equal(await t.count('SELECT count(*) AS n FROM email_campaigns'), 1);

    const { rows: [campaign] } = await t.db.query('SELECT * FROM email_campaigns WHERE id = $1', [made.body.campaign.id]);
    assert.equal(campaign.status, 'draft');
    assert.equal(campaign.approved_at, null);
    assert.equal(campaign.recipients_hash, null, 'lista odbiorców powstaje i jest zatwierdzana w module kampanii');
    assert.equal(campaign.meeting_id, meeting.id);
    assert.equal(campaign.meeting_notice_id, draft.body.notice.id);
    assert.equal(campaign.category, 'organizational');
    assert.match(campaign.body_text, /01\.12\.2026, 19:00/, 'data w czasie brukselskim');
    assert.match(campaign.body_text, /Miejsce: Aula/);
    assert.match(campaign.body_text, /1\. Sprawozdanie\n2\. Wolne wnioski/);
    assert.equal(await t.count('SELECT count(*) AS n FROM email_campaign_recipients'), 0);
    assert.equal(await t.count('SELECT count(*) AS n FROM email_outbox'), 0);
    assert.equal(networkGuardCalls(), 0);
    const created = await t.audits('meeting.notice.campaign_drafted');
    assert.equal(created.length, 1);
    assert.equal(created[0].metadata_json.campaignId, campaign.id);

    // Zwykły moduł kampanii przejmuje dalej: audience nie do zmiany, brak zatwierdzenia bez listy.
    const email = await t.call(t.cookies.board, 'GET', `/api/email/campaigns/${campaign.id}`);
    assert.equal(email.status, 200, JSON.stringify(email.body));
    assert.equal(email.body.campaign.meetingNoticeId, draft.body.notice.id);
    const preview = await t.call(t.cookies.board2, 'POST', `/api/email/campaigns/${campaign.id}/approve`,
      { contentHash: campaign.content_hash, recipientsHash: 'a'.repeat(64) });
    assert.notEqual(preview.status, 200, 'bez migawki odbiorców nie da się zatwierdzić');
    const change = await t.call(t.cookies.board, 'PUT', `/api/email/campaigns/${campaign.id}`, {
      revision: campaign.revision_no, title: campaign.title, audience: 'no_payment_record',
      subject: campaign.subject, bodyText: campaign.body_text,
    });
    assert.equal(change.status, 409);
    assert.equal(change.body.error, 'campaign_audience_locked');

    // Ręcznie tworzona kampania nie może dostać odbiorców klasowych.
    const manual = await t.call(t.cookies.board, 'POST', '/api/email/campaigns', {
      schoolYearId: YEAR, title: 'Ręczny szkic', audience: 'class_households', subject: 'Temat wiadomości',
      bodyText: 'Treść wiadomości organizacyjnej dla rodziców, dwadzieścia znaków.',
    }, { 'Idempotency-Key': 'manual-class-key-1' });
    assert.equal(manual.status, 400);
    assert.equal(manual.body.error, 'invalid_audience');
  } finally { await t.close(); }
});

test('baza odrzuca kampanię powiązaną z zebraniem inaczej niż szkic z zatwierdzonego zawiadomienia dla właściwych odbiorców', async () => {
  const t = await setup();
  try {
    const meeting = await t.create();
    await t.addItem(meeting, 'Punkt');
    const draft = await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/notices`, {});
    const insert = (over = {}) => {
      const row = {
        id: crypto.randomUUID(), audience: 'all_households', classId: null, status: 'draft', notice: draft.body.notice.id,
        meeting: meeting.id, ...over,
      };
      return t.db.query(
        `INSERT INTO email_campaigns (id, school_year_id, title, audience, category, subject, body_text, content_hash,
           status, created_by, updated_by, idempotency_key, meeting_id, meeting_notice_id, class_id)
         VALUES ($1, $2, 'Tytuł kampanii', $3, 'organizational', 'Temat wiadomości', 'Treść wiadomości powyżej dwudziestu znaków',
           repeat('a', 64), $4, 'u-bd', 'u-bd', $5, $6, $7, $8)`,
        [row.id, YEAR, row.audience, row.status, `key-${row.id}`, row.meeting, row.notice, row.classId]);
    };
    // Niezatwierdzone zawiadomienie.
    await assert.rejects(insert(), /email_campaign_meeting_requires_approved_notice/);
    await t.call(t.cookies.board2, 'POST', `/api/meetings/${meeting.id}/notices/${draft.body.notice.id}/approval`, {});
    // Zebranie ogólne, ale odbiorcy klasowi.
    await assert.rejects(insert({ audience: 'class_households', classId: 'ca' }), /email_campaign_meeting_audience_mismatch/);
    // Kampania powiązana z zebraniem bez zawiadomienia.
    await assert.rejects(insert({ notice: null }), /email_campaign_meeting_requires_approved_notice|email_campaigns_notice_needs_meeting/);
    // Tylko szkic.
    await assert.rejects(insert({ status: 'approved' }), /email_campaign_meeting_requires_approved_notice|email_campaign_approved_exact/);
    // Odbiorcy klasowi bez klasy.
    await assert.rejects(insert({ audience: 'class_households' }), /email_campaign_meeting_audience_mismatch|email_campaigns_class_audience/);
    await insert();
    // Powiązanie jest niezmienne.
    await assert.rejects(t.db.query('UPDATE email_campaigns SET meeting_notice_id = NULL'), /email_campaign_meeting_link_immutable/);
  } finally { await t.close(); }
});

test('zebranie klasowe: lista odbiorców tylko z klasy zebrania, rodzeństwo i dwoje opiekunów to jedna wiadomość na rodzinę', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h-a', { classes: ['ca'], guardians: 2 }); // dwoje opiekunów jednego dziecka
    await family(t.db, 'h-sib', { classes: ['ca', 'cb'] }); // rodzeństwo w 1A i 2B
    await family(t.db, 'h-b', { classes: ['cb'] }); // tylko 2B
    const meeting = await t.create({ kind: 'class', classId: 'ca', title: 'Zebranie klasy 1A' });
    await t.addItem(meeting, 'Punkt klasowy');
    const notice = await t.approvedNotice(meeting);
    const made = await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/notices/${notice.id}/campaign-draft`, {});
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.campaign.audience, 'class_households');
    assert.equal(made.body.campaign.classId, 'ca');

    const snap = await t.call(t.cookies.board, 'POST', `/api/email/campaigns/${made.body.campaign.id}/snapshot`);
    assert.equal(snap.status, 200, JSON.stringify(snap.body));
    const { rows } = await t.db.query(
      'SELECT household_id FROM email_campaign_recipients WHERE campaign_id = $1 ORDER BY household_id', [made.body.campaign.id]);
    assert.deepEqual(rows.map((r) => r.household_id), ['h-a', 'h-sib']);
    // Kampania 2B (osobne zebranie) dostaje rodziny z 2B — inne niż 1A.
    const snapB = await computeSnapshot(t.db, { school_year_id: YEAR, audience: 'class_households', class_id: 'cb' });
    assert.deepEqual(snapB.recipients.map((r) => r.householdId).sort(), ['h-b', 'h-sib']);
    await assert.rejects(computeSnapshot(t.db, { school_year_id: YEAR, audience: 'class_households' }), /class_households_requires_class/);
    assert.equal(await t.count('SELECT count(*) AS n FROM email_outbox'), 0);
    assert.equal(networkGuardCalls(), 0);
  } finally { await t.close(); }
});

test('zebranie zarządu nie ma jeszcze szkicu kampanii (lista zaproszonych kont poza zakresem)', async () => {
  const t = await setup();
  try {
    const meeting = await t.create({ kind: 'board', title: 'Posiedzenie zarządu' });
    await t.addItem(meeting, 'Punkt');
    const notice = await t.approvedNotice(meeting);
    const res = await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/notices/${notice.id}/campaign-draft`, {});
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'notice_campaign_audience_unsupported');
    assert.equal(await t.count('SELECT count(*) AS n FROM email_campaigns'), 0);
  } finally { await t.close(); }
});

// ---------- zamknięty rok ----------

test('zamknięty rok: odwołanie, zmiana terminu i zawiadomienia dają 409 school_year_closed', async () => {
  const t = await setup();
  try {
    const meeting = await t.create();
    await t.addItem(meeting, 'Punkt');
    const draft = await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/notices`, {});
    const rev = await t.revision(meeting);
    await t.db.exec(`
      SET session_replication_role = replica;
      INSERT INTO school_year_closures (id, school_year_id, next_school_year_id, status, initiated_by,
        closed_by, closed_at, income_cents, expense_cents, opening_balance_cents, closing_balance_cents,
        carried_opening_balance_id, expired_grant_count)
      VALUES ('clo-1', '${YEAR}', 'next', 'closed', 'u-bd', 'u-bd2', now(), 0, 0, 0, 0, 'ob-fake-1', 0);
      SET session_replication_role = origin;
    `);
    const base = `/api/meetings/${meeting.id}`;
    const results = [
      await t.call(t.cookies.board, 'POST', `${base}/cancellation`, { reason: 'Powód testowy', revision: rev }),
      await t.call(t.cookies.board, 'POST', `${base}/reschedule`, { scheduledAt: inDays(50), reason: 'Powód testowy', revision: rev }),
      await t.call(t.cookies.board2, 'POST', `${base}/notices/${draft.body.notice.id}/approval`, {}),
      await t.call(t.cookies.board, 'POST', `${base}/agenda-items/x/withdrawal`, {}),
    ];
    assert.deepEqual(results.slice(0, 3).map((r) => [r.status, r.body.error]), Array(3).fill([409, 'school_year_closed']));
    assert.equal(results[3].status, 404);
    const item = (await t.view(meeting)).agenda[0];
    const withdrawal = await t.call(t.cookies.board, 'POST', `${base}/agenda-items/${item.id}/withdrawal`, {});
    assert.equal(withdrawal.status, 409);
    assert.equal(withdrawal.body.error, 'school_year_closed');
    // Nowe zawiadomienie (wymaga nowej treści) też jest zamrożone na poziomie bazy.
    await assert.rejects(t.db.query(
      `INSERT INTO meeting_reschedules (id, meeting_id, school_year_id, from_scheduled_at, to_scheduled_at, reason, actor_id)
       VALUES ('r-x', $1, $2, now(), now() + interval '1 day', 'Powód testowy', 'u-bd')`, [meeting.id, YEAR]),
    /school_year_closed/);
    // #80: trigger a0_year_freeze na trzech nowych tabelach — INSERT/UPDATE/DELETE
    // zamkniętego roku daje school_year_closed (przed strażnikami tabel).
    await assert.rejects(t.db.query(
      `INSERT INTO meeting_agenda_versions (id, meeting_id, school_year_id, version, snapshot, content_hash, created_by)
       VALUES ('av-x', $1, $2, 99, '[]'::jsonb, 'h', 'u-bd')`, [meeting.id, YEAR]), /school_year_closed/);
    await assert.rejects(t.db.query('UPDATE meeting_agenda_versions SET content_hash = $1 WHERE meeting_id = $2', ['h2', meeting.id]), /school_year_closed/);
    await assert.rejects(t.db.query('UPDATE meeting_notices SET title = $1 WHERE meeting_id = $2', ['Inny', meeting.id]), /school_year_closed/);
    await assert.rejects(t.db.query('DELETE FROM meeting_notices WHERE meeting_id = $1', [meeting.id]), /school_year_closed/);
    await assert.rejects(t.db.query('DELETE FROM meeting_agenda_versions WHERE meeting_id = $1', [meeting.id]), /school_year_closed/);
    for (const table of ['meeting_agenda_versions', 'meeting_notices']) {
      assert.ok(await t.count(`SELECT count(*) AS n FROM ${table} WHERE meeting_id = $1`, [meeting.id]) > 0, `${table}: wiersze nietknięte`);
    }
    assert.equal((await t.view(meeting)).meeting.status, 'scheduled');
  } finally { await t.close(); }
});
