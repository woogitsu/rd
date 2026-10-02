// #137: ścieżka kontroli Komisji Rewizyjnej — niezmienne uwagi (pytanie KR → odpowiedź
// zarządu/skarbnika → zamknięcie) i wniosek końcowy roku (migracja 0176,
// src/pg/routes/audit-reviews.js). Dane wyłącznie syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const YEAR = 'y-ar137';
const OTHER_YEAR = 'y-ar137-other';
const AUDIT_NOTE_TABLE = 'audit_review_notes';

let keySeq = 0;
const key = (label = 'k') => `ar137-${label}-${++keySeq}-${'x'.repeat(4)}`;

async function setup() {
  const db = await createTestDb();
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, OTHER_YEAR, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  await seedClass(db, { id: 'c-ar137-1a', schoolYearId: YEAR });
  const grant = (userId, roles, mfa = true) => seedUserSession(db, { userId, roles, mfa });
  const cookies = {
    audit: await grant('u-ar-audit', [{ role: 'audit', schoolYearId: YEAR }]),
    audit2: await grant('u-ar-audit2', [{ role: 'audit', schoolYearId: YEAR }]),
    auditNoMfa: await grant('u-ar-audit-nomfa', [{ role: 'audit', schoolYearId: YEAR }], false),
    auditOtherYear: await grant('u-ar-audit-other', [{ role: 'audit', schoolYearId: OTHER_YEAR }]),
    auditClass: await grant('u-ar-audit-class', [{ role: 'audit', classId: 'c-ar137-1a', schoolYearId: YEAR }]),
    treasurer: await grant('u-ar-treasurer', [{ role: 'treasurer', schoolYearId: YEAR }]),
    board: await grant('u-ar-board', [{ role: 'board', schoolYearId: YEAR }]),
    classTreasurer: await grant('u-ar-class-treasurer', [{ role: 'treasurer', classId: 'c-ar137-1a', schoolYearId: YEAR }]),
    representative: await grant('u-ar-rep', [{ role: 'representative', classId: 'c-ar137-1a', schoolYearId: YEAR }]),
    admin: await grant('u-ar-admin', [{ role: 'admin', schoolYearId: YEAR }]),
    // Konflikt ról: ta sama osoba jest w KR i w zarządzie (decyzja D-09 otwarta).
    both: await grant('u-ar-both', [{ role: 'audit', schoolYearId: YEAR }, { role: 'treasurer', schoolYearId: YEAR }]),
  };
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by)
    VALUES ('cat-ar-out', $1, 'expense', 'Wydatki syntetyczne', 'u-ar-treasurer')`, [YEAR]);
  await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description,
      occurred_on, method, created_by, idempotency_key)
    VALUES ('le-ar-1', $1, 'expense', 4000, 'cat-ar-out', 'Wydatek syntetyczny', '2026-10-10', 'bank', 'u-ar-treasurer', 'ar-le-key-0001')`, [YEAR]);
  const call = (path, options = {}) => handlePgRequest(request(path, options), { db });
  const post = (cookie, path, body, headers = { 'Idempotency-Key': key() }) => call(path, { method: 'POST', cookie, body, headers });
  const ask = (cookie = cookies.audit, body = {}, headers) => post(cookie, `/api/audit-reviews/${YEAR}/notes`, {
    kind: 'question', targetType: 'ledger_entry', targetId: 'le-ar-1', body: 'Prosimy o fakturę do tego wydatku.', ...body,
  }, headers);
  return { db, cookies, call, post, ask };
}

const count = async (db, table = AUDIT_NOTE_TABLE) => Number((await db.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);

test('wątek: pytanie KR → odpowiedź skarbnika → zamknięcie; wniosek końcowy; lista i raport KR', async () => {
  const { db, cookies, call, post, ask } = await setup();
  try {
    const asked = await ask();
    assert.equal(asked.status, 201);
    const note = (await asked.json()).note;
    assert.equal(note.kind, 'question');
    assert.equal(note.createdBy, 'u-ar-audit');

    const answered = await post(cookies.treasurer, `/api/audit-reviews/${YEAR}/notes/${note.id}/answers`, { body: 'Faktura jest w dokumentach roku.' });
    assert.equal(answered.status, 201);

    let list = await (await call(`/api/audit-reviews/${YEAR}`, { cookie: cookies.audit })).json();
    assert.equal(list.threads.length, 1);
    assert.equal(list.threads[0].status, 'answered');
    assert.equal(list.threads[0].answers.length, 1);
    assert.deepEqual(list.counts, { open: 0, answered: 1, closed: 0 });

    const closed = await post(cookies.audit, `/api/audit-reviews/${YEAR}/notes/${note.id}/closure`, {});
    assert.equal(closed.status, 201, 'zamknięcie bez treści jest dozwolone');
    const afterClose = await post(cookies.treasurer, `/api/audit-reviews/${YEAR}/notes/${note.id}/answers`, { body: 'Dopisek po zamknięciu.' });
    assert.equal(afterClose.status, 409);
    assert.equal((await afterClose.json()).error, 'audit_review_closed');
    const closedTwice = await post(cookies.audit, `/api/audit-reviews/${YEAR}/notes/${note.id}/closure`, { body: 'Drugie zamknięcie.' });
    assert.equal(closedTwice.status, 409);

    const concluded = await post(cookies.audit, `/api/audit-reviews/${YEAR}/conclusion`, { body: 'Brak zastrzeżeń po wyjaśnieniach.' });
    assert.equal(concluded.status, 201);
    const corrected = await post(cookies.audit, `/api/audit-reviews/${YEAR}/conclusion`, { body: 'Wniosek poprawiony po drugim przeglądzie.' });
    assert.equal(corrected.status, 201, 'korekta wniosku to nowy zapis');

    list = await (await call(`/api/audit-reviews/${YEAR}`, { cookie: cookies.board })).json();
    assert.equal(list.threads[0].status, 'closed');
    assert.equal(list.conclusions.length, 2);
    assert.equal(list.currentConclusion.body, 'Wniosek poprawiony po drugim przeglądzie.');
    assert.equal(await count(db), 5);

    const report = await (await call(`/api/reports/audit?schoolYearId=${YEAR}&format=json`, { cookie: cookies.audit })).json();
    assert.equal(report.report.reviewNotes.threads.length, 1);
    assert.equal(report.report.reviewNotes.currentConclusion.body, 'Wniosek poprawiony po drugim przeglądzie.');
    const html = await (await call(`/api/reports/audit?schoolYearId=${YEAR}&format=html`, { cookie: cookies.audit })).text();
    assert.match(html, /Prosimy o fakturę do tego wydatku\./);
    assert.match(html, /Wniosek końcowy/);
    const xlsx = await call(`/api/reports/audit?schoolYearId=${YEAR}&format=xlsx`, { cookie: cookies.audit });
    assert.equal(xlsx.status, 200);
  } finally { await db.close(); }
});

test('raport KR pokazuje otwarte pytania z oznaczeniem i escapuje treść', async () => {
  const { db, cookies, call, ask } = await setup();
  try {
    assert.equal((await ask(cookies.audit, { body: 'Uwaga <script>alert(1)</script> do wpisu' })).status, 201);
    const html = await (await call(`/api/reports/audit?schoolYearId=${YEAR}&format=html`, { cookie: cookies.treasurer })).text();
    assert.match(html, /otwarta/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;/);
  } finally { await db.close(); }
});

test('podwójne kliknięcie i ponowienie: jeden zapis i jedno zdarzenie; ten sam klucz z inną treścią to 409', async () => {
  const { db, cookies, post, ask } = await setup();
  try {
    const headers = { 'Idempotency-Key': 'ar137-double-click-0001' };
    const [first, second] = await Promise.all([ask(cookies.audit, {}, headers), ask(cookies.audit, {}, headers)]);
    assert.deepEqual([first.status, second.status].sort(), [200, 201]);
    assert.equal((await first.json()).note.id, (await second.json()).note.id);
    assert.equal(await count(db), 1);
    const events = Number((await db.query("SELECT count(*) AS n FROM audit_events WHERE action = 'audit_review.note_added'")).rows[0].n);
    assert.equal(events, 1);

    const conflict = await ask(cookies.audit, { body: 'Zupełnie inna treść pytania.' }, headers);
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error, 'idempotency_conflict');
    const otherActor = await ask(cookies.audit2, {}, headers);
    assert.equal(otherActor.status, 409, 'cudzy klucz nie odtwarza zapisu');

    const missing = await post(cookies.audit, `/api/audit-reviews/${YEAR}/conclusion`, { body: 'Wniosek bez klucza.' }, {});
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error, 'invalid_idempotency_key');
    assert.equal(await count(db), 1);
  } finally { await db.close(); }
});

test('podwójne kliknięcie odpowiedzi i zamknięcia: jeden zapis każdego rodzaju', async () => {
  const { db, cookies, post, ask } = await setup();
  try {
    const note = (await (await ask()).json()).note;
    const answerHeaders = { 'Idempotency-Key': 'ar137-answer-twice-0001' };
    const closeHeaders = { 'Idempotency-Key': 'ar137-close-twice-0001' };
    const answerPath = `/api/audit-reviews/${YEAR}/notes/${note.id}/answers`;
    const closePath = `/api/audit-reviews/${YEAR}/notes/${note.id}/closure`;
    const answers = await Promise.all([1, 2].map(() => post(cookies.board, answerPath, { body: 'Wyjaśnienie zarządu.' }, answerHeaders)));
    assert.deepEqual(answers.map((r) => r.status).sort(), [200, 201]);
    const closes = await Promise.all([1, 2].map(() => post(cookies.audit, closePath, {}, closeHeaders)));
    assert.deepEqual(closes.map((r) => r.status).sort(), [200, 201]);
    assert.equal(await count(db), 3);
  } finally { await db.close(); }
});

// Backend-niezależnie: PGlite szereguje żądania (drugie widzi zapis pierwszego i dostaje
// odtworzenie 200), prawdziwy PG naprawdę je przeplata — przegrany wyścig o zamknięcie
// widzi w triggerze już zamknięcie zwycięzcy. Z TYM SAMYM kluczem i treścią ma dostać
// odtworzenie (200), nie 409; z INNYM kluczem — 409 audit_review_closed. Zawsze jeden zapis.
test('równoległe zamknięcie tego samego wątku: ten sam klucz = odtworzenie 200, inny klucz = 409 audit_review_closed (PGlite: po kolei, nie wyścig)', async () => {
  const { db, cookies, post, ask } = await setup();
  try {
    const note = (await (await ask()).json()).note;
    const closePath = `/api/audit-reviews/${YEAR}/notes/${note.id}/closure`;
    assert.equal((await post(cookies.board, `/api/audit-reviews/${YEAR}/notes/${note.id}/answers`, { body: 'Wyjaśnienie zarządu.' })).status, 201);
    const sameKey = { 'Idempotency-Key': 'ar137-close-race-same-0001' };
    const same = await Promise.all([1, 2, 3].map(() => post(cookies.audit, closePath, {}, sameKey)));
    const statuses = same.map((r) => r.status).sort();
    assert.equal(statuses.filter((s) => s === 201).length, 1, 'dokładnie jeden zapis');
    assert.deepEqual(statuses.filter((s) => s !== 201), [200, 200], 'pozostałe to odtworzenia');
    const ids = new Set(await Promise.all(same.map(async (r) => (await r.json()).note.id)));
    assert.equal(ids.size, 1);
    assert.equal(await count(db), 3);

    const other = await ask(cookies.audit, { targetId: 'le-ar-1', body: 'Drugie pytanie do wydatku.' });
    const otherNote = (await other.json()).note;
    const otherPath = `/api/audit-reviews/${YEAR}/notes/${otherNote.id}/closure`;
    const differentKeys = await Promise.all([1, 2].map((n) => post(cookies.audit, otherPath, {}, { 'Idempotency-Key': `ar137-close-race-diff-000${n}` })));
    const results = differentKeys.map((r) => r.status).sort();
    assert.deepEqual(results, [201, 409]);
    const loser = differentKeys.find((r) => r.status === 409);
    assert.equal((await loser.json()).error, 'audit_review_closed');
    const closures = Number((await db.query("SELECT count(*) AS n FROM audit_review_notes WHERE kind = 'closed'")).rows[0].n);
    assert.equal(closures, 2);
    assert.equal(await count(db), 5, 'pytanie + odpowiedź + zamknięcie + drugie pytanie + jedno zamknięcie');

    // Prawdziwy PG, deterministycznie: dwa żądania z tym samym kluczem przechodzą wstępne
    // sprawdzenie i czekają w triggerze na blokadzie wątku; „zwycięzca” zapisuje zamknięcie z
    // tym kluczem i zwalnia blokadę. Oba żądania mają dostać odtworzenie (200) tego zapisu.
    // (PGlite ma jedno połączenie — tam wyścig nie istnieje, więc ta część nie ma sensu.)
    if (db.url) {
      const third = (await (await ask(cookies.audit, { body: 'Trzecie pytanie do wydatku.' })).json()).note;
      const thirdPath = `/api/audit-reviews/${YEAR}/notes/${third.id}/closure`;
      const headers = { 'Idempotency-Key': 'ar137-close-race-held-0001' };
      const winnerId = 'arn-held-winner-0001';
      const pending = await db.transaction(async (tx) => {
        await tx.query('SELECT id FROM audit_review_notes WHERE id = $1 FOR UPDATE', [third.id]);
        const requests = [1, 2].map(() => post(cookies.audit, thirdPath, {}, headers));
        let waiting = 0;
        for (let i = 0; i < 100 && waiting < 2; i += 1) {
          waiting = Number((await db.query(
            "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
          )).rows[0].n);
          if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(waiting, 2, 'oba żądania czekają na blokadzie wątku');
        await tx.query(
          `INSERT INTO audit_review_notes (id, school_year_id, kind, target_type, target_id, parent_id, created_by, idempotency_key)
           VALUES ($1, $2, 'closed', $3, $4, $5, 'u-ar-audit', $6)`,
          [winnerId, YEAR, third.targetType, third.targetId, third.id, headers['Idempotency-Key']],
        );
        return requests;
      });
      const responses = await Promise.all(pending);
      assert.deepEqual(responses.map((r) => r.status), [200, 200]);
      const bodies = await Promise.all(responses.map((r) => r.json()));
      assert.ok(bodies.length === 2 && bodies.every((b) => b.replayed === true && b.note.id === winnerId));
      const closed = Number((await db.query("SELECT count(*) AS n FROM audit_review_notes WHERE kind = 'closed' AND parent_id = $1", [third.id])).rows[0].n);
      assert.equal(closed, 1);
    }
  } finally { await db.close(); }
});

test('granice ról: odczyt audit/zarząd/skarbnik; pytanie i zamknięcie tylko audit; odpowiedź tylko zarząd i skarbnik', async () => {
  const { db, cookies, call, post, ask } = await setup();
  try {
    const note = (await (await ask()).json()).note;
    const before = await count(db);
    const answerPath = `/api/audit-reviews/${YEAR}/notes/${note.id}/answers`;
    const closePath = `/api/audit-reviews/${YEAR}/notes/${note.id}/closure`;
    const listPath = `/api/audit-reviews/${YEAR}`;

    for (const actor of ['audit', 'board', 'treasurer']) {
      assert.equal((await call(listPath, { cookie: cookies[actor] })).status, 200, `odczyt: ${actor}`);
    }
    for (const actor of ['auditNoMfa', 'auditOtherYear', 'auditClass', 'classTreasurer', 'representative', 'admin']) {
      const denied = await call(listPath, { cookie: cookies[actor] });
      assert.equal(denied.status, 403, `odczyt: ${actor}`);
      assert.doesNotMatch(await denied.text(), /Prosimy o fakturę/);
    }
    assert.equal((await call(listPath)).status, 401);

    // Odmowa przed walidacją: ciało celowo niepoprawne.
    for (const actor of ['board', 'treasurer', 'auditNoMfa', 'auditOtherYear', 'auditClass', 'classTreasurer', 'representative', 'admin']) {
      assert.equal((await post(cookies[actor], `/api/audit-reviews/${YEAR}/notes`, { kind: 'nieznany' })).status, 403, `pytanie: ${actor}`);
      assert.equal((await post(cookies[actor], closePath, { body: 1 })).status, 403, `zamknięcie: ${actor}`);
      assert.equal((await post(cookies[actor], `/api/audit-reviews/${YEAR}/conclusion`, {})).status, 403, `wniosek: ${actor}`);
    }
    for (const actor of ['audit', 'audit2', 'auditNoMfa', 'auditOtherYear', 'auditClass', 'classTreasurer', 'representative', 'admin']) {
      assert.equal((await post(cookies[actor], answerPath, { body: 1 })).status, 403, `odpowiedź: ${actor}`);
    }
    assert.equal(await count(db), before, 'żadna odmowa nic nie zapisała');
    const denials = Number((await db.query("SELECT count(*) AS n FROM audit_events WHERE action = 'access.denied'")).rows[0].n);
    assert.ok(denials > 0, 'odmowa roli zostawia ślad access.denied');
  } finally { await db.close(); }
});

test('audit innego roku nie dotyka uwag tego roku (także przez identyfikator uwagi z innego roku)', async () => {
  const { db, cookies, post, ask } = await setup();
  try {
    const note = (await (await ask()).json()).note;
    const crossYear = await post(cookies.auditOtherYear, `/api/audit-reviews/${OTHER_YEAR}/notes/${note.id}/closure`, {});
    assert.equal(crossYear.status, 404, 'uwaga z innego roku nie istnieje w tym roku');
    const wrongYear = await post(cookies.treasurer, `/api/audit-reviews/${OTHER_YEAR}/notes/${note.id}/answers`, { body: 'Wyjaśnienie.' });
    assert.equal(wrongYear.status, 403, 'skarbnik roku 1 nie ma roli w roku 2');
    assert.equal(await count(db), 1);
  } finally { await db.close(); }
});

test('konflikt ról: ta sama osoba nie odpowiada na własne pytanie (zasada dwóch osób)', async () => {
  const { db, cookies, post, ask } = await setup();
  try {
    const note = (await (await ask(cookies.both)).json()).note;
    const own = await post(cookies.both, `/api/audit-reviews/${YEAR}/notes/${note.id}/answers`, { body: 'Odpowiadam sam sobie.' });
    assert.equal(own.status, 403);
    assert.equal((await own.json()).error, 'four_eyes_required');
    assert.equal(await count(db), 1);
    const other = await post(cookies.treasurer, `/api/audit-reviews/${YEAR}/notes/${note.id}/answers`, { body: 'Odpowiedź skarbnika.' });
    assert.equal(other.status, 201);
  } finally { await db.close(); }
});

test('walidacja: cel, rodzaj, długość treści, odpowiedź na odpowiedź', async () => {
  const { db, cookies, post, ask } = await setup();
  try {
    assert.equal((await ask(cookies.audit, { targetId: 'le-nie-ma' })).status, 404);
    assert.equal((await ask(cookies.audit, { targetType: 'reconciliation', targetId: 'rec-nie-ma' })).status, 404);
    assert.equal((await ask(cookies.audit, { targetType: 'year', targetId: OTHER_YEAR })).status, 404);
    assert.equal((await ask(cookies.audit, { kind: 'answer' })).status, 400);
    assert.equal((await ask(cookies.audit, { targetType: 'payment' })).status, 400);
    const short = await ask(cookies.audit, { body: 'ok' });
    assert.equal(short.status, 400);
    assert.equal((await short.json()).error, 'invalid_audit_review_body');
    assert.equal((await ask(cookies.audit, { body: 'x'.repeat(2001) })).status, 400);
    assert.equal((await ask(cookies.audit, { targetType: 'year', targetId: YEAR, kind: 'finding', body: 'Ustalenie ogólne dla roku.' })).status, 201);
    const note = (await (await ask()).json()).note;
    const answer = (await (await post(cookies.board, `/api/audit-reviews/${YEAR}/notes/${note.id}/answers`, { body: 'Wyjaśnienie.' })).json()).note;
    const nested = await post(cookies.treasurer, `/api/audit-reviews/${YEAR}/notes/${answer.id}/answers`, { body: 'Odpowiedź na odpowiedź.' });
    assert.equal(nested.status, 404, 'odpowiedzieć można tylko na pytanie lub ustalenie');
    const unknown = await post(cookies.treasurer, `/api/audit-reviews/${YEAR}/notes/arn-nie-ma/answers`, { body: 'Wyjaśnienie.' });
    assert.equal(unknown.status, 404);
    assert.equal(await count(db), 3);
  } finally { await db.close(); }
});

test('bramka danych osobowych: e-mail odrzucony, telefon wymaga potwierdzenia; audyt bez treści', async () => {
  const { db, cookies, post, ask } = await setup();
  try {
    const email = await ask(cookies.audit, { body: 'Proszę o kontakt: ktos@example.invalid w sprawie faktury.' });
    assert.equal(email.status, 422);
    assert.equal((await email.json()).error, 'personal_data_forbidden');

    const phoneText = 'Pytanie o fakturę, kontakt telefoniczny +32 470 12 34 56.';
    const unconfirmed = await ask(cookies.audit, { body: phoneText });
    assert.equal(unconfirmed.status, 422);
    assert.equal((await unconfirmed.json()).error, 'possible_personal_data');
    assert.equal(await count(db), 0);

    const confirmed = await ask(cookies.audit, { body: phoneText, confirmPersonalData: true });
    assert.equal(confirmed.status, 201);
    const note = (await confirmed.json()).note;
    const answerEmail = await post(cookies.treasurer, `/api/audit-reviews/${YEAR}/notes/${note.id}/answers`, { body: 'Odpowiedź do ktos@example.invalid.' });
    assert.equal(answerEmail.status, 422);
    const conclusionEmail = await post(cookies.audit, `/api/audit-reviews/${YEAR}/conclusion`, { body: 'Wniosek ktos@example.invalid.' });
    assert.equal(conclusionEmail.status, 422);

    const { rows } = await db.query("SELECT metadata_json FROM audit_events WHERE action LIKE 'audit_review.%'");
    assert.equal(rows.length, 1);
    const metadata = JSON.stringify(rows[0].metadata_json);
    assert.doesNotMatch(metadata, /Pytanie o fakturę|(?<![\w-])470(?![\w-])/);
    assert.match(metadata, /piiConfirmed/);
    assert.equal(await count(db), 1);
  } finally { await db.close(); }
});

test('zdarzenia audytu: aktor, obiekt i rok; bez treści uwagi', async () => {
  const { db, cookies, post, ask } = await setup();
  try {
    const note = (await (await ask()).json()).note;
    await post(cookies.board, `/api/audit-reviews/${YEAR}/notes/${note.id}/answers`, { body: 'Odpowiedź zarządu.' });
    await post(cookies.audit, `/api/audit-reviews/${YEAR}/notes/${note.id}/closure`, {});
    await post(cookies.audit, `/api/audit-reviews/${YEAR}/conclusion`, { body: 'Wniosek końcowy KR.' });
    const { rows } = await db.query(
      "SELECT action, actor_id, entity_type, entity_id, metadata_json FROM audit_events WHERE action LIKE 'audit_review.%' ORDER BY occurred_at, id",
    );
    assert.deepEqual(rows.map((row) => row.action).sort(), [
      'audit_review.answered', 'audit_review.closed', 'audit_review.conclusion_recorded', 'audit_review.note_added',
    ]);
    for (const row of rows) {
      assert.equal(row.entity_type, 'audit_review_note');
      assert.ok(row.entity_id.startsWith('arn-'));
      assert.equal(row.metadata_json.schoolYearId, YEAR);
      assert.doesNotMatch(JSON.stringify(row.metadata_json), /Odpowiedź zarządu|Wniosek końcowy|fakturę/);
    }
    assert.equal(rows.find((row) => row.action === 'audit_review.answered').actor_id, 'u-ar-board');
  } finally { await db.close(); }
});

test('niezmienność: UPDATE, DELETE i TRUNCATE odrzucone; created_at z zegara bazy', async () => {
  const { db, cookies, ask } = await setup();
  try {
    const note = (await (await ask()).json()).note;
    await assert.rejects(db.query(`UPDATE ${AUDIT_NOTE_TABLE} SET body = 'Zmieniona treść uwagi' WHERE id = $1`, [note.id]), /cannot_be_changed/);
    await assert.rejects(db.query(`DELETE FROM ${AUDIT_NOTE_TABLE} WHERE id = $1`, [note.id]), /cannot_be_changed/);
    await assert.rejects(db.query(`TRUNCATE ${AUDIT_NOTE_TABLE}`));
    await assert.rejects(db.query(
      `INSERT INTO ${AUDIT_NOTE_TABLE} (id, school_year_id, kind, target_type, target_id, body, created_by, idempotency_key, created_at)
       VALUES ('arn-old', $1, 'conclusion', 'year', $1, 'Antydatowany wniosek', 'u-ar-audit', 'ar137-backdated-0001', '2020-01-01')`, [YEAR],
    ).then(() => db.query(`SELECT created_at FROM ${AUDIT_NOTE_TABLE} WHERE id = 'arn-old'`).then(({ rows }) => {
      assert.ok(rows[0].created_at.getUTCFullYear() >= 2026, 'antydatowany znacznik zastąpiony zegarem bazy');
      throw new Error('stamped');
    })), /stamped/);
    assert.equal(cookies.audit.startsWith('rd_session='), true);
  } finally { await db.close(); }
});

test('zamknięty rok: nowe zapisy odrzucone (409), odczyt nadal możliwy', async () => {
  const { db, cookies, call, post, ask } = await setup();
  try {
    const note = (await (await ask()).json()).note;
    await db.exec(`
      SET session_replication_role = replica;
      INSERT INTO school_year_closures (id, school_year_id, next_school_year_id, status, initiated_by,
        closed_by, closed_at, income_cents, expense_cents, opening_balance_cents, closing_balance_cents,
        carried_opening_balance_id, expired_grant_count)
      VALUES ('clo-ar', '${YEAR}', '${OTHER_YEAR}', 'closed', 'u-a', 'u-b', now(), 0, 0, 0, 0, 'ob-ar', 0);
      SET session_replication_role = origin;
    `);
    const rejectedQuestion = await ask();
    assert.equal(rejectedQuestion.status, 409);
    assert.equal((await rejectedQuestion.json()).error, 'school_year_closed');
    const rejectedAnswer = await post(cookies.treasurer, `/api/audit-reviews/${YEAR}/notes/${note.id}/answers`, { body: 'Odpowiedź po zamknięciu.' });
    assert.equal(rejectedAnswer.status, 409);
    const rejectedConclusion = await post(cookies.audit, `/api/audit-reviews/${YEAR}/conclusion`, { body: 'Wniosek po zamknięciu.' });
    assert.equal(rejectedConclusion.status, 409);
    const read = await call(`/api/audit-reviews/${YEAR}`, { cookie: cookies.audit });
    assert.equal(read.status, 200);
    assert.equal((await read.json()).threads.length, 1);
    assert.equal(await count(db), 1);
  } finally { await db.close(); }
});

test('rola audit nadal nie ma dostępu do księgi ani zapisu (to zakres D-09, nie tej zmiany)', async () => {
  const { db, cookies, call } = await setup();
  try {
    for (const path of [`/api/ledger?schoolYearId=${YEAR}`, `/api/ledger/summary?schoolYearId=${YEAR}`, `/api/reconciliations?schoolYearId=${YEAR}`]) {
      assert.equal((await call(path, { cookie: cookies.audit })).status, 403, path);
    }
    assert.equal((await call(`/api/audit-reviews/${YEAR}`, { method: 'DELETE', cookie: cookies.audit })).status, 405);
    assert.equal((await call(`/api/audit-reviews/${YEAR}/notes`, { cookie: cookies.audit })).status, 405);
  } finally { await db.close(); }
});
