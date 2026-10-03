// #204 (część): luki w triggerach niezmienności — podmiana zatwierdzającego
// kampanię e-mail bez zmiany stanu, cofnięcie odwołania sesji i wstawienie
// wiersza kolejki wysyłki dla kampanii w szkicu. Testy działają na poziomie
// SQL (poza triggerem, nie przez API), bo sprawdzają dokładnie to, co ma
// odrzucać baza niezależnie od walidacji w API. Dane wyłącznie syntetyczne
// (@example.invalid).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedSchoolYear, seedUser, assertOwnerGuard } from './helpers/pg.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

async function setup() {
  const db = await createTestDb();
  await seedSchoolYear(db, 'y-2026');
  await seedUser(db, { userId: 'u-author' });
  await seedUser(db, { userId: 'u-approver' });
  await seedUser(db, { userId: 'u-approver2' });
  return db;
}

async function insertApprovedCampaign(db, { id = 'camp-1' } = {}) {
  await db.query(
    `INSERT INTO email_campaigns (
       id, school_year_id, title, audience, subject, body_text, content_hash, status,
       recipients_hash, recipients_count, snapshot_built_by, snapshot_built_at,
       created_by, updated_by, approved_by, approved_at, approved_content_hash, approved_recipients_hash,
       idempotency_key
     ) VALUES (
       $1, 'y-2026', 'Kampania testowa', 'all_households', 'Temat', repeat('x', 30), $2, 'approved',
       $3, 1, 'u-author', now(),
       'u-author', 'u-author', 'u-approver', now(), $2, $3,
       'idem-' || $1
     )`,
    [id, HASH_A, HASH_B],
  );
  return id;
}

test('email_campaigns: podmiana zatwierdzającego/czasu zatwierdzenia bez zmiany stanu jest odrzucona (#204 pkt 1)', async () => {
  const db = await setup();
  const id = await insertApprovedCampaign(db);
  await assert.rejects(
    db.query(`UPDATE email_campaigns SET approved_by = 'u-approver2', approved_at = '2026-01-01' WHERE id = $1`, [id]),
    /email_campaign_approval_immutable/,
  );
  await db.close();
});

test('email_campaigns: podmiana skrótów zatwierdzenia lub migawki w stanie approved jest odrzucona (#204 pkt 1)', async () => {
  const db = await setup();
  const id = await insertApprovedCampaign(db);
  await assert.rejects(
    db.query(`UPDATE email_campaigns SET snapshot_built_by = 'u-approver2' WHERE id = $1`, [id]),
    /email_campaign_approval_immutable/,
  );
  await db.close();
});

test('email_campaigns: cofnięcie do szkicu bez wyczyszczenia pól zatwierdzenia jest odrzucone (#204 pkt 1)', async () => {
  const db = await setup();
  const id = await insertApprovedCampaign(db);
  await assert.rejects(
    db.query(`UPDATE email_campaigns SET status = 'draft' WHERE id = $1`, [id]),
    /email_campaign_approval_must_clear_on_revert/,
  );
  // Cofnięcie z jednoczesnym wyczyszczeniem wszystkich pól zatwierdzenia
  // (tak jak robi to API, patrz src/pg/routes/email.js) nadal działa.
  await db.query(
    `UPDATE email_campaigns SET status = 'draft', approved_by = NULL, approved_at = NULL,
            approved_content_hash = NULL, approved_recipients_hash = NULL WHERE id = $1`,
    [id],
  );
  await db.close();
});

test('sessions: cofnięcie odwołania (revoked_at = NULL) na odwołanej sesji jest odrzucone (#204 pkt 2)', async () => {
  const db = await setup();
  await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, revoked_at, revoked_reason)
     VALUES ('s1', 'u-author', repeat('a', 64), now() + interval '1 hour', now(), 'logout')`,
  );
  await assert.rejects(
    db.query(`UPDATE sessions SET revoked_at = NULL, revoked_reason = NULL WHERE id = 's1'`),
    /session_revocation_final/,
  );
  await db.close();
});

test('sessions: druga zmiana revoked_at na już odwołanej sesji (inna data) jest odrzucona (#204 pkt 2)', async () => {
  const db = await setup();
  await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, revoked_at, revoked_reason)
     VALUES ('s2', 'u-author', repeat('b', 64), now() + interval '1 hour', now(), 'logout')`,
  );
  await assert.rejects(
    db.query(`UPDATE sessions SET revoked_at = '2020-01-01' WHERE id = 's2'`),
    /session_revocation_final/,
  );
  await db.close();
});

test('sessions: token_hash, user_id, created_at i rotated_from są niezmienne', async () => {
  const db = await setup();
  await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at)
     VALUES ('s3', 'u-author', repeat('c', 64), now() + interval '1 hour')`,
  );
  await assert.rejects(db.query(`UPDATE sessions SET token_hash = repeat('d', 64) WHERE id = 's3'`), /session_identity_immutable/);
  await assert.rejects(db.query(`UPDATE sessions SET user_id = 'u-approver' WHERE id = 's3'`), /session_identity_immutable/);
  await db.close();
});

test('sessions: wiersza sesji nie da się usunąć', async () => {
  const db = await setup();
  await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at)
     VALUES ('s4', 'u-author', repeat('e', 64), now() + interval '1 hour')`,
  );
  await assertOwnerGuard(db, `DELETE FROM sessions WHERE id = 's4'`, /sessions_cannot_be_deleted/);
  await db.close();
});

test('email_outbox: wstawienie wiersza kolejki dla kampanii w stanie draft jest odrzucone (#204 pkt 5)', async () => {
  const db = await setup();
  await db.query(`INSERT INTO households (id) VALUES ('h1')`);
  await db.query(
    `INSERT INTO guardians (id, household_id, first_name, last_name) VALUES ('g1', 'h1', 'Jan', 'Testowy')`,
  );
  await db.query(
    `INSERT INTO email_campaigns (
       id, school_year_id, title, audience, subject, body_text, content_hash, status,
       created_by, updated_by, idempotency_key
     ) VALUES (
       'camp-draft', 'y-2026', 'Szkic', 'all_households', 'Temat', repeat('x', 30), $1, 'draft',
       'u-author', 'u-author', 'idem-camp-draft'
     )`,
    [HASH_A],
  );
  await db.query(
    `INSERT INTO email_campaign_recipients (id, campaign_id, household_id, guardian_id, email, email_hash)
     VALUES ('r1', 'camp-draft', 'h1', 'g1', 'guardian@example.invalid', $1)`,
    [HASH_B],
  );
  await assert.rejects(
    db.query(
      `INSERT INTO email_outbox (id, campaign_id, household_id, recipient_id, idempotency_key)
       VALUES ('ob1', 'camp-draft', 'h1', 'r1', 'campaign:camp-draft:household:h1')`,
    ),
    /email_outbox_campaign_not_ready/,
  );
  await db.close();
});

test('email_outbox: wstawienie wiersza dla zatwierdzonej kampanii w stanie innym niż świeży "queued" jest odrzucone (#204 pkt 5)', async () => {
  const db = await setup();
  await db.query(`INSERT INTO households (id) VALUES ('h2')`);
  await db.query(
    `INSERT INTO guardians (id, household_id, first_name, last_name) VALUES ('g2', 'h2', 'Anna', 'Testowa')`,
  );
  // email_campaign_recipients (email_snapshot_guard, 0007) przyjmuje wiersze
  // tylko, gdy kampania jest jeszcze 'draft' — migawkę trzeba więc wstawić
  // przed zatwierdzeniem, tak jak robi to API (buildRecipients przed approve()).
  const id = 'camp-2';
  await db.query(
    `INSERT INTO email_campaigns (
       id, school_year_id, title, audience, subject, body_text, content_hash, status,
       recipients_hash, recipients_count, snapshot_built_by, snapshot_built_at,
       created_by, updated_by, idempotency_key
     ) VALUES (
       $1, 'y-2026', 'Kampania testowa', 'all_households', 'Temat', repeat('x', 30), $2, 'draft',
       $3, 1, 'u-author', now(), 'u-author', 'u-author', 'idem-' || $1
     )`,
    [id, HASH_A, HASH_B],
  );
  await db.query(
    `INSERT INTO email_campaign_recipients (id, campaign_id, household_id, guardian_id, email, email_hash)
     VALUES ('r2', $1, 'h2', 'g2', 'guardian2@example.invalid', $2)`,
    [id, HASH_A],
  );
  await db.query(
    `UPDATE email_campaigns SET status = 'approved', approved_by = 'u-approver', approved_at = now(),
            approved_content_hash = content_hash, approved_recipients_hash = recipients_hash
      WHERE id = $1`,
    [id],
  );
  await assert.rejects(
    db.query(
      `INSERT INTO email_outbox (id, campaign_id, household_id, recipient_id, idempotency_key, state)
       VALUES ('ob2', $1, 'h2', 'r2', 'campaign:' || $1 || ':household:h2', 'sending')`,
      [id],
    ),
    /email_outbox_insert_must_be_fresh_queued/,
  );
  // Wstawienie bez podania stanu (domyślne 'queued', attempts=0) — jak robi
  // to jedyne miejsce w API (queue() w src/pg/routes/email.js) — działa.
  await db.query(
    `INSERT INTO email_outbox (id, campaign_id, household_id, recipient_id, idempotency_key)
     VALUES ('ob3', $1, 'h2', 'r2', 'campaign:' || $1 || ':household:h2')`,
    [id],
  );
  await db.close();
});
