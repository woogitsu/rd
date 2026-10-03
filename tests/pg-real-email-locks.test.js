// #208 (inwentaryzacja blokad, scripts/lock-inventory.js): testy z barierą na PRAWDZIWYM
// PostgreSQL dla blokad wierszy w module e-mail, których brak daje podwójny zapis:
// rozstrzygnięcie „wiadomość nie wyszła / doszła” dla jednego wiersza kolejki (#139) i
// zatwierdzenie wniosku o zdjęcie blokady adresu (#94). Żadna z tych tabel nie ma
// indeksu unikalnego na rozstrzygany wiersz, więc jedynym punktem serializacji jest
// `SELECT … FOR UPDATE` w kodzie trasy.
//
// Schemat jak w pg-real-record-locks (tests/helpers/pg-race.js). Plik działa wyłącznie z
// RD_TEST_PG_URL (npm run test:pg-real); bez niej jest pomijany. Wyłącznie dane
// syntetyczne (@example.invalid). Nic nie wychodzi do sieci: kampania źródłowa przechodzi
// przez worker z atrapą transportu, a pułapka sieci (tests/helpers/network-guard.js)
// liczy próby — licznik musi być 0.
// Kontrola mutacyjna: scripts/check-lock-mutations.js (mutanty email-outbox-resolution,
// email-suppression-release).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runEmailBatch } from '../src/email/worker.js';
import { networkGuardCalls, seedClass, seedPublishedPrivacyNotice, seedUserSession } from './helpers/pg.js';
import { callApi, countRows } from './helpers/pg-barrier.js';
import { assertWaitsOn, auditCount, race, withReal } from './helpers/pg-race.js';

const skip = process.env.RD_TEST_PG_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';
const YEAR = 'y2026';
const DAY1 = new Date('2026-10-05T08:00:00Z');
const BODY = 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}. Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.';
const EMAIL_ENV = {
  APP_ENV: 'development',
  EMAIL_SENDING_ENABLED: 'true',
  EMAIL_TEST_ALLOWLIST: '*@example.invalid',
  BREVO_FROM_EMAIL: 'rada@example.invalid',
};

async function seedSessions(db) {
  await seedPublishedPrivacyNotice(db);
  await seedClass(db, { id: 'c1', schoolYearId: YEAR });
  return {
    treasurer: await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] }),
    boardA: await seedUserSession(db, { userId: 'u-bd-1', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] }),
    boardB: await seedUserSession(db, { userId: 'u-bd-2', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] }),
  };
}

// Kampania źródłowa jak w pg-email-followup: jedna rodzina h1, przekazanie do dostawcy
// przerwane (wiersz „sending” sprzed przebiegu) — worker oznacza go failed/delivery_unknown.
async function failedOutbox(db, cookies) {
  await db.exec(`
    INSERT INTO households (id) VALUES ('h1');
    INSERT INTO students (id, household_id, first_name, last_name) VALUES ('h1-s1', 'h1', 'Uczeń', 'Testowy');
    INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('e-h1-s1', 'h1-s1', 'c1', '${YEAR}');
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
      VALUES ('h1-g1', 'h1', 'Opiekun', 'Testowy', 'h1-g1@example.invalid', true);
    INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ('h1-s1', 'h1-g1', true, true);
  `);
  const env = { db, ...EMAIL_ENV };
  const created = await callApi(env, 'POST', '/api/email/campaigns', cookies.treasurer, {
    schoolYearId: YEAR, title: 'Przypomnienie jesienne', audience: 'all_households', subject: 'Dobrowolna składka {rok}', bodyText: BODY,
  }, crypto.randomUUID());
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.campaign.id;
  assert.equal((await callApi(env, 'POST', `/api/email/campaigns/${id}/snapshot`, cookies.treasurer)).status, 200);
  const preview = await callApi(env, 'GET', `/api/email/campaigns/${id}/preview`, cookies.boardA);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const approved = await callApi(env, 'POST', `/api/email/campaigns/${id}/approve`, cookies.boardA, {
    contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash,
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal((await callApi(env, 'POST', `/api/email/campaigns/${id}/queue`, cookies.treasurer)).status, 200);
  await db.query(
    `UPDATE email_outbox SET state = 'sending', attempts = 1, claimed_at = $2, claim_token = $3, send_started_at = $2
      WHERE campaign_id = $1`,
    [id, DAY1.toISOString(), crypto.randomUUID()],
  );
  const transport = { calls: [], name: 'fake', async send(message) { this.calls.push(message); return { messageId: `fake-${this.calls.length}` }; } };
  await runEmailBatch(env, { transport, dryRun: false, now: new Date(DAY1.getTime() + 30 * 60_000) });
  assert.equal(transport.calls.length, 0, 'przerwane przekazanie nie jest ponawiane');
  const { rows } = await db.query('SELECT id, state, last_error FROM email_outbox WHERE campaign_id = $1', [id]);
  assert.deepEqual(rows.map((row) => [row.state, row.last_error]), [['failed', 'delivery_unknown']]);
  return { env, campaignId: id, outboxId: rows[0].id };
}

test('#208 (bariera, e-mail): dwa rozstrzygnięcia tej samej wiadomości naraz („nie wyszła” i „doszła”) — drugie czeka na blokadę wiersza kolejki i zwraca pierwsze; jeden zapis', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await seedSessions(db);
    const { campaignId, outboxId } = await failedOutbox(db, cookies);
    const path = `/api/email/campaigns/${campaignId}/resolutions`;
    const r = await race(db, {
      pauseAfter: /INSERT INTO email_outbox_resolutions/,
      first: (env) => callApi({ ...env, ...EMAIL_ENV }, 'POST', path, cookies.boardA, { outboxId, resolution: 'confirmed_not_sent', evidenceCode: 'brevo_log_no_event' }),
      second: (env) => callApi({ ...env, ...EMAIL_ENV }, 'POST', path, cookies.boardB, { outboxId, resolution: 'confirmed_delivered', evidenceCode: 'brevo_log_delivered' }),
    });
    assertWaitsOn(r, /^SELECT id, state FROM email_outbox WHERE id = \$1 AND campaign_id = \$2 FOR UPDATE/, 'drugie rozstrzygnięcie czeka na blokadę wiersza kolejki');
    assert.equal(r.a.status, 201, JSON.stringify(r.a.body));
    // Bez blokady oba żądania widzą brak rozstrzygnięcia i dopisują dwa sprzeczne wiersze.
    assert.equal(r.b.status, 200, JSON.stringify(r.b.body));
    assert.equal(r.b.replayed, 'true');
    assert.equal(r.b.body.resolution.resolution, 'confirmed_not_sent');
    assert.equal(await countRows(db, 'SELECT count(*)::int AS n FROM email_outbox_resolutions WHERE outbox_id = $1', [outboxId]), 1);
    assert.equal(await auditCount(db, 'email.outbox.resolved'), 1);
    assert.equal(networkGuardCalls(), 0);
  });
});

test('#208 (bariera, e-mail): dwie osoby z zarządu naraz zatwierdzają zdjęcie blokady adresu — druga czeka na blokadę wniosku i dostaje 409 request_already_consumed; jedno zdjęcie', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await seedSessions(db);
    const env = { db, ...EMAIL_ENV };
    const hash = createHash('sha256').update('adres-syntetyczny@example.invalid').digest('hex');
    await db.query("INSERT INTO email_suppressions (id, email_hash, reason) VALUES ('sup-1', $1, 'hard_bounce')", [hash]);
    const requested = await callApi(env, 'POST', `/api/email/suppressions/${hash}/release-request`, cookies.treasurer, {
      schoolYearId: YEAR, releaseReason: 'address_corrected',
    });
    assert.equal(requested.status, 201, JSON.stringify(requested.body));
    const path = `/api/email/suppressions/${hash}/release`;
    const body = { requestId: requested.body.requestId, schoolYearId: YEAR };
    const r = await race(db, {
      pauseAfter: /UPDATE email_suppression_release_requests SET consumed_at/,
      first: (gated) => callApi({ ...gated, ...EMAIL_ENV }, 'POST', path, cookies.boardA, body),
      second: (plain) => callApi({ ...plain, ...EMAIL_ENV }, 'POST', path, cookies.boardB, body),
    });
    assertWaitsOn(r, /^SELECT \* FROM email_suppression_release_requests WHERE id = \$1 AND email_hash = \$2 FOR UPDATE/, 'drugie zatwierdzenie czeka na blokadę wiersza wniosku');
    assert.equal(r.a.status, 201, JSON.stringify(r.a.body));
    // Bez blokady drugie zatwierdzenie widzi wniosek niewykorzystany i blokadę nadal aktywną,
    // więc dopisuje drugie zdjęcie blokady i drugie zdarzenie.
    assert.deepEqual([r.b.status, r.b.body.error], [409, 'request_already_consumed']);
    assert.equal(await countRows(db, 'SELECT count(*)::int AS n FROM email_suppression_releases WHERE email_hash = $1', [hash]), 1);
    assert.equal(await auditCount(db, 'email.suppression.released'), 1);
  });
});
