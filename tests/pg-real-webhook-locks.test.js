// #208 (inwentaryzacja blokad, scripts/lock-inventory.js): testy z barierą na PRAWDZIWYM
// PostgreSQL dla blokady wiersza kolejki w recordWebhookEvent (src/pg/routes/email.js) —
// zdarzenia dostawcy (bounce, skarga) zmieniają stan wiadomości i dopisują blokadę adresu.
//
// Bez blokady:
//  - zdarzenie, które przychodzi, gdy worker zapisuje wynik wysyłki (sending → sent, jeszcze
//    bez COMMIT), czyta stan „sending” i pomija przejście sent → bounced: wiadomość zostaje
//    „wysłana”, choć dostawca zgłosił twarde odbicie;
//  - dwa RÓŻNE zdarzenia odbicia tej samej wiadomości dopisują dwie blokady adresu (warunek
//    NOT EXISTS nie widzi niezatwierdzonej blokady pierwszego, a tabela nie ma indeksu
//    unikalnego na aktywną blokadę).
// To samo zdarzenie dwa razy odcina UNIQUE email_webhook_events.dedupe_key (ON CONFLICT DO
// NOTHING czeka na pierwsze) — z blokadą i bez niej jeden zapis; trzeci test to dokumentuje.
//
// Schemat jak w pg-real-record-locks (tests/helpers/pg-race.js). Plik działa wyłącznie z
// RD_TEST_PG_URL (npm run test:pg-real); bez niej jest pomijany. Wyłącznie dane syntetyczne
// (@example.invalid). Webhook to atrapa żądania dostawcy (sekret testowy), wysyłka — worker z
// atrapą transportu; pułapka sieci liczy próby, licznik musi być 0.
// Kontrola mutacyjna: scripts/check-lock-mutations.js (mutant email-webhook-outbox).
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { emailHash } from '../src/email/content.js';
import { runEmailBatch } from '../src/email/worker.js';
import { networkGuardCalls, request, seedClass, seedPublishedPrivacyNotice, seedUserSession } from './helpers/pg.js';
import { callApi, countRows } from './helpers/pg-barrier.js';
import { assertWaitsOn, auditCount, race, withReal } from './helpers/pg-race.js';

const skip = process.env.RD_TEST_PG_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';
const YEAR = 'y2026';
const SECRET = 'w'.repeat(48);
const ADDRESS = 'h1-g1@example.invalid';
const BODY = 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}. Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.';
const EMAIL_ENV = {
  APP_ENV: 'development', EMAIL_SENDING_ENABLED: 'true', EMAIL_TEST_ALLOWLIST: '*@example.invalid',
  BREVO_FROM_EMAIL: 'rada@example.invalid', BREVO_WEBHOOK_SECRET: SECRET,
};
const MESSAGE_ID = 'fake-msg-1';
const OUTBOX_LOCK_SQL = /^SELECT o\.id, o\.state, o\.campaign_id/;

const transport = () => ({ name: 'fake', calls: 0, async send() { this.calls += 1; return { messageId: MESSAGE_ID }; } });
const runWorker = (env, fake) => runEmailBatch({ ...env, ...EMAIL_ENV }, { transport: fake, dryRun: false, now: new Date(Date.now() + 60_000) });

// Atrapa żądania Brevo: jedno zdarzenie dotyczące wiadomości (message-id i X-Mailin-custom).
async function webhook(env, outboxId, event, id) {
  const payload = { event, email: ADDRESS, 'message-id': MESSAGE_ID, 'X-Mailin-custom': outboxId, id, ts_event: 1791187200 };
  const response = await handlePgRequest(request('/api/email/webhooks/brevo', {
    method: 'POST', headers: { Authorization: `Bearer ${SECRET}` }, body: payload,
  }), { ...env, ...EMAIL_ENV });
  return { status: response.status, body: await response.json() };
}

// Kampania jednej rodziny h1 w kolejce (szkic → migawka → zatwierdzenie → kolejka). Zwraca id wiersza kolejki.
async function queuedMessage(db) {
  await seedPublishedPrivacyNotice(db);
  await seedClass(db, { id: 'c1', schoolYearId: YEAR });
  const treasurer = await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
  const board = await seedUserSession(db, { userId: 'u-bd', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] });
  await db.exec(`
    INSERT INTO households (id) VALUES ('h1');
    INSERT INTO students (id, household_id, first_name, last_name) VALUES ('h1-s1', 'h1', 'Uczeń', 'Testowy');
    INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('e-h1-s1', 'h1-s1', 'c1', '${YEAR}');
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
      VALUES ('h1-g1', 'h1', 'Opiekun', 'Testowy', '${ADDRESS}', true);
    INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ('h1-s1', 'h1-g1', true, true);
  `);
  const env = { db, ...EMAIL_ENV };
  const created = await callApi(env, 'POST', '/api/email/campaigns', treasurer, {
    schoolYearId: YEAR, title: 'Przypomnienie jesienne', audience: 'all_households', subject: 'Dobrowolna składka {rok}', bodyText: BODY,
  }, crypto.randomUUID());
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.campaign.id;
  assert.equal((await callApi(env, 'POST', `/api/email/campaigns/${id}/snapshot`, treasurer)).status, 200);
  const preview = await callApi(env, 'GET', `/api/email/campaigns/${id}/preview`, board);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const approved = await callApi(env, 'POST', `/api/email/campaigns/${id}/approve`, board, {
    contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash,
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal((await callApi(env, 'POST', `/api/email/campaigns/${id}/queue`, treasurer)).status, 200);
  const { rows } = await db.query('SELECT id FROM email_outbox WHERE campaign_id = $1', [id]);
  assert.equal(rows.length, 1);
  return rows[0].id;
}

async function outboxState(db, outboxId) {
  const { rows } = await db.query('SELECT state, last_error FROM email_outbox WHERE id = $1', [outboxId]);
  return [rows[0].state, rows[0].last_error];
}

const suppressions = (db) => countRows(db, 'SELECT count(*)::int AS n FROM email_suppressions WHERE email_hash = $1', [emailHash(ADDRESS)]);

test('#208 (bariera, e-mail): twarde odbicie zgłoszone, gdy worker zapisuje wynik wysyłki — webhook czeka na blokadę wiersza kolejki i oznacza wiadomość jako odbitą', { skip }, async () => {
  await withReal(async (db) => {
    const outboxId = await queuedMessage(db);
    const fake = transport();
    const r = await race(db, {
      // Worker staje po zapisie „sent” (wiersz kolejki zablokowany, bez COMMIT).
      pauseAfter: /UPDATE email_outbox SET state = 'sent', sent_at = \$2, provider_message_id/,
      first: (env) => runWorker(env, fake),
      second: (env) => webhook(env, outboxId, 'hard_bounce', 'evt-1'),
    });
    assertWaitsOn(r, OUTBOX_LOCK_SQL, 'zdarzenie dostawcy czeka na blokadę wiersza kolejki');
    assert.equal(r.a.sent, 1);
    assert.equal(fake.calls, 1);
    assert.deepEqual(r.b, { status: 200, body: { received: 1, recorded: 1, suppressed: 1, ignored: 0 } });
    // Bez blokady zdarzenie czyta stan „sending” sprzed zatwierdzenia workera, więc nie
    // przestawia wiadomości na „bounced” (zostaje „sent”, mimo twardego odbicia).
    assert.deepEqual(await outboxState(db, outboxId), ['bounced', 'hard_bounce']);
    assert.equal(await suppressions(db), 1);
    assert.equal(await auditCount(db, 'email.sent'), 1);
    assert.equal(await auditCount(db, 'email.address_suppressed'), 1);
    assert.equal(networkGuardCalls(), 0);
  });
});

test('#208 (bariera, e-mail): dwa różne zdarzenia odbicia tej samej wiadomości naraz — drugie czeka na blokadę wiersza kolejki; jedna blokada adresu', { skip }, async () => {
  await withReal(async (db) => {
    const outboxId = await queuedMessage(db);
    assert.equal((await runWorker({ db }, transport())).sent, 1);
    const r = await race(db, {
      pauseAfter: /UPDATE email_outbox SET state = 'bounced'/,
      first: (env) => webhook(env, outboxId, 'hard_bounce', 'evt-1'),
      second: (env) => webhook(env, outboxId, 'blocked', 'evt-2'),
    });
    assertWaitsOn(r, OUTBOX_LOCK_SQL, 'drugie zdarzenie czeka na blokadę wiersza kolejki');
    assert.deepEqual([r.a.status, r.a.body.recorded, r.b.status, r.b.body.recorded], [200, 1, 200, 1]);
    // Bez blokady drugie zdarzenie nie widzi niezatwierdzonej blokady adresu pierwszego i
    // dopisuje drugą (brak indeksu unikalnego), a potem nadpisuje powód odbicia wiadomości.
    assert.equal(await suppressions(db), 1);
    assert.deepEqual(await outboxState(db, outboxId), ['bounced', 'hard_bounce']);
    assert.equal(await countRows(db, 'SELECT count(*)::int AS n FROM email_webhook_events WHERE outbox_id = $1', [outboxId]), 2);
    assert.equal(networkGuardCalls(), 0);
  });
});

test('#208 (bariera, e-mail): to samo zdarzenie dostawcy dwa razy naraz — drugie czeka i nie jest zapisywane; jeden zapis, jedna blokada adresu', { skip }, async () => {
  await withReal(async (db) => {
    const outboxId = await queuedMessage(db);
    assert.equal((await runWorker({ db }, transport())).sent, 1);
    const r = await race(db, {
      pauseAfter: /UPDATE email_outbox SET state = 'bounced'/,
      first: (env) => webhook(env, outboxId, 'hard_bounce', 'evt-1'),
      second: (env) => webhook(env, outboxId, 'hard_bounce', 'evt-1'),
    });
    assertWaitsOn(r, OUTBOX_LOCK_SQL, 'powtórzone zdarzenie czeka na blokadę wiersza kolejki');
    // Ten skutek trzyma też UNIQUE dedupe_key bez blokady (ON CONFLICT DO NOTHING czeka na
    // pierwsze zdarzenie) — blokada zmienia tylko miejsce czekania.
    assert.deepEqual([r.a.body.recorded, r.b.status, r.b.body.recorded, r.b.body.suppressed], [1, 200, 0, 0]);
    assert.equal(await countRows(db, 'SELECT count(*)::int AS n FROM email_webhook_events WHERE outbox_id = $1', [outboxId]), 1);
    assert.equal(await suppressions(db), 1);
    assert.equal(await auditCount(db, 'email.address_suppressed'), 1);
  });
});
