// #80: kampania e-mail rozpoczęta przed zamknięciem roku. Zachowanie zgodne z
// kodem (src/email/worker.js, docs/YEAR_CLOSE.md): zamrożenie obejmuje tylko
// INSERT nowej kampanii (0036), a worker wybiera kampanie po `status = 'sending'`
// i nie sprawdza stanu roku — wysyłka rozpoczęta wcześniej jest DOKOŃCZANA,
// każda rodzina raz, a ponowienie zadania po końcu niczego nie dubluje. Wyłącznie
// dane syntetyczne (@example.invalid), transport Brevo z wstrzykniętym fetchImpl.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createBrevoTransport } from '../src/email/brevo.js';
import { runEmailBatch } from '../src/email/worker.js';
import { CHECKLIST_ITEMS } from '../src/pg/routes/year-close.js';
import { createTestDb, networkGuardCalls, request, seedClass, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const YEAR = 'y2026';
const NEXT = 'y2027';
const DAY1 = new Date('2026-10-05T08:00:00Z');
const HOUR = 60 * 60_000;
const BODY = 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}. Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.';

function brevoStub() {
  const requests = [];
  const fetchImpl = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ messageId: `<m${requests.length}@example.invalid>` }), { status: 201 });
  };
  const transport = createBrevoTransport({ apiKey: 'synthetic-key', appEnv: 'development', fetchImpl, processEnv: {} });
  transport.requests = requests;
  return transport;
}

test('kampania rozpoczęta przed zamknięciem roku jest dokańczana po zamknięciu, każda rodzina raz; ponowienie zadania nic nie dubluje', async () => {
  const db = await createTestDb();
  try {
    await seedClass(db, { id: 'c1', schoolYearId: YEAR });
    await seedSchoolYear(db, NEXT, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
    const treasurer = await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
    const board = await seedUserSession(db, { userId: 'u-bd', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] });
    const board2 = await seedUserSession(db, { userId: 'u-bd2', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] });
    const env = {
      db, APP_ENV: 'development', EMAIL_SENDING_ENABLED: 'true', EMAIL_TEST_ALLOWLIST: '*@example.invalid',
      BREVO_FROM_EMAIL: 'rada@example.invalid', BREVO_WEBHOOK_SECRET: 'w'.repeat(48),
      EMAIL_BATCH_SIZE: '1', // jedna wiadomość na przebieg: wysyłka zostaje „w połowie”
    };
    const call = async (cookie, path, options = {}) => {
      const response = await handlePgRequest(request(path, { cookie, ...options }), env);
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    const count = async (sql, params = []) => Number((await db.query(sql, params)).rows[0].n);

    for (const id of ['h1', 'h2', 'h3']) {
      await db.query('INSERT INTO households (id) VALUES ($1)', [id]);
      await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, $2, 'Uczeń', 'Testowy')", [`${id}-s1`, id]);
      await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)', [`e-${id}`, `${id}-s1`, 'c1', YEAR]);
      await db.query("INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES ($1, $2, 'Opiekun', 'Testowy', $3, true)", [`${id}-g1`, id, `${id}-g1@example.invalid`]);
      await db.query('INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ($1, $2, true, true)', [`${id}-s1`, `${id}-g1`]);
    }
    const created = await call(treasurer, '/api/email/campaigns', {
      method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: { schoolYearId: YEAR, title: 'Przypomnienie jesienne', audience: 'all_households', subject: 'Dobrowolna składka {rok}', bodyText: BODY },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const campaignId = created.body.campaign.id;
    assert.equal((await call(treasurer, `/api/email/campaigns/${campaignId}/snapshot`, { method: 'POST' })).status, 200);
    const preview = await call(board, `/api/email/campaigns/${campaignId}/preview`);
    assert.equal((await call(board, `/api/email/campaigns/${campaignId}/approve`, {
      method: 'POST', body: { contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash },
    })).status, 200);
    assert.equal((await call(treasurer, `/api/email/campaigns/${campaignId}/queue`, { method: 'POST' })).status, 200);

    const transport = brevoStub();
    const first = await runEmailBatch(env, { transport, dryRun: false, now: DAY1 });
    assert.equal(first.sent, 1);
    assert.equal(await count("SELECT count(*)::int AS n FROM email_outbox WHERE campaign_id = $1 AND state = 'queued'", [campaignId]), 2);

    // Prawdziwa procedura zamknięcia (start, lista kontrolna, /close przez inną osobę
    // z zarządu): rok jest zamrożony, a kampania nadal w stanie „sending” z dwiema
    // wiadomościami w kolejce.
    const started = await call(board, `/api/year-close/${YEAR}/start`, { method: 'POST', body: { nextSchoolYearId: NEXT } });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    for (const item of CHECKLIST_ITEMS) {
      const confirmed = await call(board, `/api/year-close/${YEAR}/checklist/${item}`, { method: 'POST', body: { note: `Potwierdzenie ${item}` } });
      assert.equal(confirmed.status, 201, `${item}: ${JSON.stringify(confirmed.body)}`);
    }
    const closed = await call(board2, `/api/year-close/${YEAR}/close`, { method: 'POST', body: {} });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    await assert.rejects(
      db.query(`INSERT INTO email_campaigns (id, school_year_id, title, audience, subject, body_text, content_hash, created_by, updated_by, idempotency_key)
                VALUES ('cmp-late', $1, 'Spóźniona', 'all_households', 'T', 'Treść wiadomości testowej o dostatecznej długości.', repeat('a', 64), 'u-tr', 'u-tr', 'cmp-late-key-1')`, [YEAR]),
      /school_year_closed/,
      'nowa kampania zamkniętego roku nadal blokowana',
    );

    // Kolejne przebiegi dokańczają kolejkę po jednej wiadomości — bez błędów
    // zamrożenia; przebieg po końcu (ponowione zadanie harmonogramu) nic nie wysyła.
    const second = await runEmailBatch(env, { transport, dryRun: false, now: new Date(DAY1.getTime() + HOUR) });
    assert.equal(second.sent, 1);
    assert.equal(second.stoppedReason, null);
    const third = await runEmailBatch(env, { transport, dryRun: false, now: new Date(DAY1.getTime() + 2 * HOUR) });
    assert.equal(third.sent, 1);
    const retry = await runEmailBatch(env, { transport, dryRun: false, now: new Date(DAY1.getTime() + 3 * HOUR) });
    assert.equal(retry.sent, 0, 'ponowienie zadania po końcu nic nie wysyła');

    const keys = transport.requests.map((body) => body.headers['X-RD-Idempotency-Key']);
    assert.equal(keys.length, 3);
    assert.equal(new Set(keys).size, 3, 'każda rodzina dostała jedną wiadomość');
    assert.equal(await count("SELECT count(*)::int AS n FROM email_outbox WHERE campaign_id = $1 AND state = 'sent'", [campaignId]), 3);
    assert.equal(await count("SELECT COALESCE(SUM(message_count), 0)::int AS n FROM email_send_ledger WHERE source = 'campaign'"), 3);
    // Przydziały roku wygasły przy zamknięciu, więc stan kampanii czytamy z bazy, nie przez API roli roku.
    assert.equal((await db.query('SELECT status FROM email_campaigns WHERE id = $1', [campaignId])).rows[0].status, 'done');
    assert.equal(networkGuardCalls(), 0);
  } finally { await db.close(); }
});
