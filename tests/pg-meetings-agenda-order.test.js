// #113 (część 2): zmiana kolejności punktów porządku obrad i plik kalendarza (.ics)
// zatwierdzonego zawiadomienia. Testy PGlite przez handlePgRequest; dane syntetyczne
// (@example.invalid), nic nie wychodzi z procesu (networkGuardCalls, email_outbox).
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
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
  const raw = async (cookie, method, path, body, headers = {}) =>
    handlePgRequest(request(path, { method, cookie, body, headers }), env);
  const call = async (cookie, method, path, body, headers = {}) => {
    const response = await raw(cookie, method, path, body, headers);
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  };
  const count = async (sql, params = []) => Number((await db.query(sql, params)).rows[0].n);
  let seq = 0;
  const key = (prefix) => `${prefix}-${++seq}-${Math.random().toString(36).slice(2)}`;
  const create = async (overrides = {}, cookie = cookies.board) => {
    const res = await call(cookie, 'POST', '/api/meetings', {
      schoolYearId: YEAR, kind: 'plenary', title: 'Zebranie plenarne', scheduledAt: inDays(20),
      location: 'Sala 1', status: 'scheduled', ...overrides,
    }, { 'Idempotency-Key': key('meeting-key') });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.meeting;
  };
  const addItem = async (meeting, title, extra = {}, cookie = cookies.board) => {
    const res = await call(cookie, 'POST', `/api/meetings/${meeting.id}/agenda-items`, { title, ...extra },
      { 'Idempotency-Key': key('item-key') });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.agendaItem;
  };
  const view = async (meeting, cookie = cookies.board) => {
    const res = await call(cookie, 'GET', `/api/meetings/${meeting.id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  };
  const reorder = (meeting, itemIds, cookie = cookies.board) =>
    call(cookie, 'POST', `/api/meetings/${meeting.id}/agenda-order`, { itemIds });
  const audits = async (action) => (await db.query(
    'SELECT * FROM audit_events WHERE action = $1 ORDER BY occurred_at, id', [action])).rows;
  const approve = async (meeting, noticeId) => {
    const res = await call(cookies.board2, 'POST', `/api/meetings/${meeting.id}/notices/${noticeId}/approval`, {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.notice;
  };
  const approvedNotice = async (meeting) => {
    const draft = await call(cookies.board, 'POST', `/api/meetings/${meeting.id}/notices`, {});
    assert.ok([200, 201].includes(draft.status), JSON.stringify(draft.body));
    return approve(meeting, draft.body.notice.id);
  };
  const calendar = async (meeting, noticeId, cookie = cookies.board) => {
    const response = await raw(cookie, 'GET', `/api/meetings/${meeting.id}/notices/${noticeId}/calendar`);
    return { status: response.status, headers: response.headers, text: await response.text() };
  };
  const titles = (agenda) => agenda.filter((item) => !item.withdrawnAt)
    .sort((a, b) => a.position - b.position).map((item) => item.title);
  return {
    db, cookies, call, count, create, addItem, view, reorder, audits, approve, approvedNotice, calendar, titles,
    close: () => db.close(),
  };
}

// ---------- kolejność porządku obrad ----------

test('zmiana kolejności: te same numery pozycji, jedno zdarzenie, podwójne kliknięcie to powtórka', async () => {
  const t = await setup();
  try {
    const meeting = await t.create();
    const a = await t.addItem(meeting, 'Punkt A');
    const b = await t.addItem(meeting, 'Punkt B');
    const c = await t.addItem(meeting, 'Punkt C');

    const first = await t.reorder(meeting, [c.id, a.id, b.id]);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.replayed, false);
    assert.deepEqual(first.body.agenda.map((item) => [item.position, item.title]),
      [[1, 'Punkt C'], [2, 'Punkt A'], [3, 'Punkt B']]);

    const second = await t.reorder(meeting, [c.id, a.id, b.id]);
    assert.equal(second.status, 200);
    assert.equal(second.body.replayed, true);
    const events = await t.audits('meeting.agenda.reordered');
    assert.equal(events.length, 1, 'podwójne kliknięcie nie tworzy drugiego zdarzenia');
    assert.equal(events[0].entity_id, meeting.id);
    assert.equal(events[0].actor_id, 'u-bd');
    const metadata = events[0].metadata_json;
    assert.equal(metadata.schoolYearId, YEAR);
    assert.deepEqual(metadata.previousItemIds, [a.id, b.id, c.id]);
    assert.deepEqual(metadata.itemIds, [c.id, a.id, b.id]);
    assert.ok(!JSON.stringify(metadata).includes('Punkt'), 'dziennik bez treści punktów');

    // Zamiana dwóch punktów (cykl) przechodzi przez wolną pozycję w jednej transakcji.
    const swap = await t.reorder(meeting, [a.id, c.id, b.id]);
    assert.equal(swap.status, 200, JSON.stringify(swap.body));
    assert.deepEqual(t.titles(swap.body.agenda), ['Punkt A', 'Punkt C', 'Punkt B']);
    assert.deepEqual(swap.body.agenda.map((item) => item.position), [1, 2, 3]);
    assert.equal((await t.audits('meeting.agenda.reordered')).length, 2);
  } finally { await t.close(); }
});

test('zmiana kolejności: wycofany punkt zachowuje numer; lista musi zawierać dokładnie niewycofane punkty', async () => {
  const t = await setup();
  try {
    const meeting = await t.create();
    const other = await t.create({ title: 'Inne zebranie' });
    const a = await t.addItem(meeting, 'Punkt A');
    const b = await t.addItem(meeting, 'Punkt B');
    const c = await t.addItem(meeting, 'Punkt C');
    const foreign = await t.addItem(other, 'Punkt obcy');
    const withdrawn = await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/agenda-items/${b.id}/withdrawal`, {});
    assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));

    for (const itemIds of [
      [c.id], // brak punktu
      [c.id, a.id, b.id], // punkt wycofany
      [c.id, c.id], // duplikat
      [c.id, foreign.id], // punkt innego zebrania
      [c.id, a.id, 'nie istnieje'], // niepoprawny identyfikator
      [],
      'a,b',
      undefined,
    ]) {
      const bad = await t.reorder(meeting, itemIds);
      assert.equal(bad.status, 400, JSON.stringify(itemIds));
      assert.equal(bad.body.error, 'invalid_agenda_order');
    }
    assert.equal((await t.audits('meeting.agenda.reordered')).length, 0);

    const ok = await t.reorder(meeting, [c.id, a.id]);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.agenda.map((item) => [item.position, item.title, Boolean(item.withdrawnAt)]),
      [[1, 'Punkt C', false], [2, 'Punkt B', true], [3, 'Punkt A', false]]);
  } finally { await t.close(); }
});

test('zmiana kolejności po zatwierdzonym zawiadomieniu: zawiadomienie nieaktualne, nowa wersja do zatwierdzenia, nic nie wychodzi', async () => {
  const t = await setup();
  try {
    const meeting = await t.create();
    const a = await t.addItem(meeting, 'Punkt A');
    const b = await t.addItem(meeting, 'Punkt B');
    const notice = await t.approvedNotice(meeting);
    assert.equal(notice.outdated, false);

    const res = await t.reorder(meeting, [b.id, a.id]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const detail = await t.view(meeting);
    assert.equal(detail.notices[0].outdated, true, 'zmiana kolejności unieważnia zgodność zawiadomienia (skrót)');
    // Szkic kampanii z nieaktualnego zawiadomienia jest odrzucony.
    const campaign = await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/notices/${notice.id}/campaign-draft`, {});
    assert.equal(campaign.status, 409);
    assert.equal(campaign.body.error, 'notice_outdated');

    const next = await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/notices`, {});
    assert.equal(next.status, 201, JSON.stringify(next.body));
    assert.equal(next.body.notice.kind, 'update');
    assert.equal(next.body.notice.status, 'draft');
    const versions = (await t.view(meeting)).agendaVersions;
    assert.equal(versions.length, 2);
    assert.deepEqual(versions[1].items.map((item) => item.title), ['Punkt B', 'Punkt A']);
    assert.equal(await t.count('SELECT count(*) AS n FROM email_campaigns'), 0);
    assert.equal(await t.count('SELECT count(*) AS n FROM email_outbox'), 0);
    assert.equal(networkGuardCalls(), 0);
  } finally { await t.close(); }
});

test('zmiana kolejności: granice ról, MFA i odwołane zebranie', async () => {
  const t = await setup();
  try {
    const plenary = await t.create();
    const classA = await t.create({ kind: 'class', classId: 'ca', title: 'Zebranie klasy 1A' });
    const classB = await t.create({ kind: 'class', classId: 'cb', title: 'Zebranie klasy 2B' });
    const items = {};
    for (const meeting of [plenary, classA, classB]) {
      items[meeting.id] = [await t.addItem(meeting, 'Punkt 1'), await t.addItem(meeting, 'Punkt 2')];
    }
    const reversed = (meeting) => items[meeting.id].map((item) => item.id).reverse();

    for (const [name, cookie, targets] of [
      ['repA', t.cookies.repA, [plenary, classA, classB]],
      ['audit', t.cookies.audit, [plenary, classA, classB]],
      ['boardA', t.cookies.boardA, [plenary, classB]],
    ]) {
      for (const meeting of targets) {
        const res = await t.reorder(meeting, reversed(meeting), cookie);
        assert.equal(res.status, 403, `${name} ${meeting.title}`);
      }
    }
    const noMfa = await t.reorder(plenary, reversed(plenary), t.cookies.boardNoMfa);
    assert.equal(noMfa.status, 403);
    assert.equal((await t.call(undefined, 'POST', `/api/meetings/${plenary.id}/agenda-order`,
      { itemIds: reversed(plenary) })).status, 401);
    assert.equal((await t.audits('meeting.agenda.reordered')).length, 0);

    // Zarząd z przydziałem 1A porządkuje wyłącznie zebranie klasy 1A.
    assert.equal((await t.reorder(classA, reversed(classA), t.cookies.boardA)).status, 200);

    const cancelled = await t.call(t.cookies.board, 'POST', `/api/meetings/${plenary.id}/cancellation`,
      { reason: 'Brak sali', revision: (await t.view(plenary)).meeting.revisionNo });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    const afterCancel = await t.reorder(plenary, reversed(plenary));
    assert.equal(afterCancel.status, 409);
    assert.equal(afterCancel.body.error, 'meeting_cancelled');
  } finally { await t.close(); }
});

test('przedstawiciel-gospodarz (#171) przestawia punkty wyłącznie zebrania własnej klasy', async () => {
  const t = await setup({ MEETINGS_CLASS_HOST: 'representative' });
  try {
    const classA = await t.create({ kind: 'class', classId: 'ca', title: 'Zebranie klasy 1A' });
    const classB = await t.create({ kind: 'class', classId: 'cb', title: 'Zebranie klasy 2B' });
    const a = [await t.addItem(classA, 'Punkt 1'), await t.addItem(classA, 'Punkt 2')];
    const b = [await t.addItem(classB, 'Punkt 1'), await t.addItem(classB, 'Punkt 2')];
    assert.equal((await t.reorder(classA, [a[1].id, a[0].id], t.cookies.repA)).status, 200);
    assert.equal((await t.reorder(classB, [b[1].id, b[0].id], t.cookies.repA)).status, 403);
  } finally { await t.close(); }
});

// ---------- plik kalendarza zawiadomienia ----------

test('plik kalendarza: tylko najnowsze zatwierdzone zawiadomienie, treść z migawki, bez opisów i bez wpisu w dzienniku', async () => {
  const t = await setup();
  try {
    const meeting = await t.create({ title: 'Zebranie plenarne, jesień', location: 'Sala 1; parter' });
    await t.addItem(meeting, 'Sprawozdanie zarządu', { description: 'Opis wewnętrzny punktu' });
    await t.addItem(meeting, 'Wolne wnioski');
    const draft = await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/notices`, {});
    assert.equal(draft.status, 201, JSON.stringify(draft.body));

    const early = await t.calendar(meeting, draft.body.notice.id);
    assert.equal(early.status, 409);
    assert.equal(JSON.parse(early.text).error, 'notice_calendar_unavailable');

    const notice = await t.approve(meeting, draft.body.notice.id);
    const auditBefore = await t.count('SELECT count(*) AS n FROM audit_events');
    const res = await t.calendar(meeting, notice.id);
    assert.equal(res.status, 200, res.text);
    assert.match(res.headers.get('content-type'), /^text\/calendar; charset=utf-8/);
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="zebranie-.+-v1\.ics"$/);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const ics = res.text.replace(/\r\n /g, '');
    assert.ok(res.text.endsWith('\r\n'));
    assert.match(ics, /\r\nMETHOD:PUBLISH\r\n/);
    assert.match(ics, new RegExp(`\\r\\nUID:meeting-${meeting.id}@rd\\.example\\.invalid\\r\\n`));
    assert.match(ics, /\r\nSEQUENCE:1\r\n/);
    assert.match(ics, /\r\nSTATUS:CONFIRMED\r\n/);
    assert.match(ics, /\r\nSUMMARY:Zebranie plenarne\\, jesień\r\n/);
    assert.match(ics, /\r\nLOCATION:Sala 1\\; parter\r\n/);
    const start = new Date(meeting.scheduledAt).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    assert.match(ics, new RegExp(`\\r\\nDTSTART:${start}\\r\\n`));
    assert.ok(ics.includes('1. Sprawozdanie zarządu\\n2. Wolne wnioski'), ics);
    assert.ok(!ics.includes('Opis wewnętrzny'), 'opisy punktów nie trafiają do pliku');
    assert.ok(!ics.includes('ORGANIZER') && !ics.includes('ATTENDEE') && !ics.includes('@example.invalid'));
    assert.equal(await t.count('SELECT count(*) AS n FROM audit_events'), auditBefore, 'odczyt bez zdarzenia');

    // Komisja Rewizyjna czyta jak GET zebrania; przedstawiciel i brak sesji — nie.
    assert.equal((await t.calendar(meeting, notice.id, t.cookies.audit)).status, 200);
    assert.equal((await t.calendar(meeting, notice.id, t.cookies.repA)).status, 404);
    assert.equal((await t.calendar(meeting, notice.id, null)).status, 401);
    assert.equal((await t.calendar(meeting, 'nie-ma-takiego')).status, 404);
    const post = await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/notices/${notice.id}/calendar`, {});
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET');
    assert.equal(networkGuardCalls(), 0);
  } finally { await t.close(); }
});

test('plik kalendarza po odwołaniu: ten sam UID, wyższa SEQUENCE i STATUS:CANCELLED; starsza wersja niedostępna', async () => {
  const t = await setup();
  try {
    const meeting = await t.create();
    await t.addItem(meeting, 'Punkt');
    const invitation = await t.approvedNotice(meeting);
    const cancel = await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/cancellation`,
      { reason: 'Choroba prowadzącego', revision: (await t.view(meeting)).meeting.revisionNo });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    // Szkic odwołania nie zmienia dostępnego pliku: nadal najnowsze zatwierdzone = zaproszenie.
    assert.equal((await t.calendar(meeting, invitation.id)).status, 200);
    assert.equal((await t.calendar(meeting, cancel.body.cancellationNotice.id)).status, 409);

    const cancellation = await t.approve(meeting, cancel.body.cancellationNotice.id);
    const res = await t.calendar(meeting, cancellation.id);
    assert.equal(res.status, 200, res.text);
    const ics = res.text.replace(/\r\n /g, '');
    assert.match(ics, new RegExp(`\\r\\nUID:meeting-${meeting.id}@rd\\.example\\.invalid\\r\\n`));
    assert.match(ics, /\r\nSEQUENCE:2\r\n/);
    assert.match(ics, /\r\nSTATUS:CANCELLED\r\n/);
    assert.ok(!ics.includes('Choroba'), 'powód odwołania jest wewnętrzny');
    assert.ok(!ics.includes('Porządek obrad'));
    const old = await t.calendar(meeting, invitation.id);
    assert.equal(old.status, 409);
    assert.equal(JSON.parse(old.text).error, 'notice_calendar_unavailable');
  } finally { await t.close(); }
});

test('plik kalendarza zebrania klasowego: zarząd klasy 1A tak, zarząd innej klasy nie', async () => {
  const t = await setup();
  try {
    const classA = await t.create({ kind: 'class', classId: 'ca', title: 'Zebranie klasy 1A' });
    await t.addItem(classA, 'Punkt klasowy');
    const notice = await t.approvedNotice(classA);
    assert.equal((await t.calendar(classA, notice.id, t.cookies.boardA)).status, 200);
    const classB = await t.create({ kind: 'class', classId: 'cb', title: 'Zebranie klasy 2B' });
    await t.addItem(classB, 'Punkt klasowy');
    const noticeB = await t.approvedNotice(classB);
    const denied = await t.calendar(classB, noticeB.id, t.cookies.boardA);
    assert.equal(denied.status, 404);
    assert.ok(!denied.text.includes('2B'));
    // Zawiadomienie innego zebrania pod cudzym identyfikatorem zebrania: 404.
    assert.equal((await t.calendar(classA, noticeB.id)).status, 404);
  } finally { await t.close(); }
});
