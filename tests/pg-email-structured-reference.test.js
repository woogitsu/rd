// #83: placeholder {komunikat} w kampanii e-mail — aktywna komunikacja
// strukturalna OGM-VCS rodziny w roku kampanii zamiast identyfikatora rodziny.
// Wyłącznie dane syntetyczne (@example.invalid). Żaden test nie łączy się z
// siecią: wysyłka używa atrapy transportu, a pułapka sieci liczy próby.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { runEmailBatch } from '../src/email/worker.js';
import {
  ContentError, SAMPLE_STRUCTURED_REFERENCE, contentWarnings, parseCampaignContent, renderMessage,
} from '../src/email/content.js';
import { formatStructuredReference, generateStructuredReference, isValidStructuredReference } from '../src/pg/ogm.js';
import { createTestDb, networkGuardCalls, request, seedClass, seedSchoolYear, seedUserSession, seedPublishedPrivacyNotice } from './helpers/pg.js';

const YEAR = 'y2026';
const NEXT = 'y2027';
const DAY1 = new Date('2026-10-05T08:00:00Z');
const BODY = 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Komunikacja strukturalna: {komunikat}. Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.';

function fakeTransport() {
  const calls = [];
  return {
    calls,
    name: 'fake',
    async send(message) {
      calls.push(message);
      return { messageId: `fake-${calls.length}-${message.outboxId}` };
    },
  };
}

async function setup() {
  const db = await createTestDb();
  await seedPublishedPrivacyNotice(db);
  await seedClass(db, { id: 'c1', schoolYearId: YEAR });
  await seedSchoolYear(db, NEXT, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  const treasurer = await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
  const board = await seedUserSession(db, { userId: 'u-bd', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] });
  const env = {
    db,
    APP_ENV: 'development',
    EMAIL_SENDING_ENABLED: 'true',
    EMAIL_TEST_ALLOWLIST: '*@example.invalid',
    BREVO_FROM_EMAIL: 'rada@example.invalid',
    BREVO_WEBHOOK_SECRET: 'w'.repeat(48),
  };
  const call = async (cookie, path, options = {}) => {
    const response = await handlePgRequest(request(path, { cookie, ...options }), env);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { db, env, treasurer, board, call };
}

async function family(db, householdId, { students = 1, guardians = 1 } = {}) {
  await db.query('INSERT INTO households (id) VALUES ($1) ON CONFLICT DO NOTHING', [householdId]);
  const studentIds = [];
  for (let i = 1; i <= students; i += 1) {
    const id = `${householdId}-s${i}`;
    studentIds.push(id);
    await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, $2, 'Uczeń', 'Testowy')", [id, householdId]);
    await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)', [`e-${id}`, id, 'c1', YEAR]);
  }
  for (let g = 1; g <= guardians; g += 1) {
    const id = `${householdId}-g${g}`;
    await db.query(
      `INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
       VALUES ($1, $2, 'Opiekun', 'Testowy', $3, true)`,
      [id, householdId, `${id}@example.invalid`],
    );
    for (const studentId of studentIds) {
      await db.query(
        'INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ($1, $2, true, $3)',
        [studentId, id, g === 1],
      );
    }
  }
}

let refSeq = 0;
async function seedReference(db, householdId, schoolYearId = YEAR) {
  const reference = generateStructuredReference();
  const id = `pr-${householdId}-${++refSeq}`;
  await db.query(
    `INSERT INTO payment_references (id, school_year_id, household_id, structured_reference, created_by, idempotency_key)
     VALUES ($1, $2, $3, $4, 'u-tr', $5)`,
    [id, schoolYearId, householdId, reference, `email-83-${id}`],
  );
  return { id, reference, formatted: formatStructuredReference(reference) };
}

async function revoke(db, referenceId) {
  await db.query(
    `INSERT INTO payment_reference_revocations (id, payment_reference_id, reason, created_by, idempotency_key)
     VALUES ($1, $2, 'Unieważnienie syntetyczne', 'u-tr', $3)`,
    [`prr-${referenceId}`, referenceId, `email-83-prr-${referenceId}`],
  );
}

async function draftAndSnapshot(t, bodyText = BODY) {
  const created = await t.call(t.treasurer, '/api/email/campaigns', {
    method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: { schoolYearId: YEAR, title: 'Przypomnienie z komunikacją', audience: 'all_households', subject: 'Dobrowolna składka {rok}', bodyText },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.campaign.id;
  const snapshot = await t.call(t.treasurer, `/api/email/campaigns/${id}/snapshot`, { method: 'POST' });
  assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
  return { id, snapshot: snapshot.body };
}

async function approveAndQueue(t, id) {
  const preview = await t.call(t.board, `/api/email/campaigns/${id}/preview`);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const approved = await t.call(t.board, `/api/email/campaigns/${id}/approve`, {
    method: 'POST', body: { contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash },
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const queued = await t.call(t.treasurer, `/api/email/campaigns/${id}/queue`, { method: 'POST' });
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  return preview.body;
}

test('{komunikat}: rodzina bez aktywnej referencji roku jest wykluczona w migawce; rodzeństwo i dwoje opiekunów = jedna wiadomość', async () => {
  const t = await setup();
  const networkBefore = networkGuardCalls();
  try {
    await family(t.db, 'h-a');
    await family(t.db, 'h-b');
    await family(t.db, 'h-c');
    await family(t.db, 'h-d');
    await family(t.db, 'h-sib', { students: 2, guardians: 2 });
    const refA = await seedReference(t.db, 'h-a');
    const refC = await seedReference(t.db, 'h-c');
    await revoke(t.db, refC.id);
    await seedReference(t.db, 'h-d', NEXT);
    const refSib = await seedReference(t.db, 'h-sib');

    const { id, snapshot } = await draftAndSnapshot(t);
    assert.equal(snapshot.recipientsCount, 2);
    // h-b: brak; h-c: unieważniona; h-d: tylko inny rok.
    assert.deepEqual(snapshot.exclusions, { no_payment_reference: 3 });
    const { rows: excluded } = await t.db.query(
      'SELECT household_id, reason FROM email_campaign_exclusions WHERE campaign_id = $1 ORDER BY household_id', [id],
    );
    assert.deepEqual(excluded.map((row) => row.household_id), ['h-b', 'h-c', 'h-d']);

    const preview = await approveAndQueue(t, id);
    assert.equal(preview.sample.householdId, 'h-a');
    assert.ok(preview.sample.text.includes(`Komunikacja strukturalna: ${refA.formatted}.`));
    assert.ok(!preview.warnings.includes('missing_payment_reference'));
    assert.ok(!preview.warnings.includes('household_id_as_payment_reference'));

    const transport = fakeTransport();
    await runEmailBatch(t.env, { transport, dryRun: false, now: new Date(DAY1.getTime() + 30 * 60_000) });
    const byTo = Object.fromEntries(transport.calls.map((message) => [message.to, message.text]));
    assert.deepEqual(Object.keys(byTo).sort(), ['h-a-g1@example.invalid', 'h-sib-g1@example.invalid']);
    assert.ok(byTo['h-a-g1@example.invalid'].includes(refA.formatted));
    assert.ok(byTo['h-sib-g1@example.invalid'].includes(refSib.formatted));
    for (const text of Object.values(byTo)) {
      assert.doesNotMatch(text, /\{komunikat\}|h-a|h-sib/);
      assert.doesNotMatch(text, /zaległ|dług|dłużn|należnoś/i);
    }
    // Ponowienie zadania nie wysyła drugiej wiadomości (klucz kampania + rodzina).
    const again = fakeTransport();
    await runEmailBatch(t.env, { transport: again, dryRun: false, now: new Date(DAY1.getTime() + 90 * 60_000) });
    assert.equal(again.calls.length, 0);
    // Dziennik nie zawiera wartości referencji.
    const { rows: audit } = await t.db.query('SELECT metadata_json FROM audit_events');
    const dump = JSON.stringify(audit);
    assert.ok(!dump.includes(refA.reference) && !dump.includes(refSib.reference), 'referencja nie trafia do audit_events');
    assert.equal(networkGuardCalls(), networkBefore);
  } finally {
    await t.db.close();
  }
});

test('{komunikat}: referencja unieważniona po zatwierdzeniu — wiersz pominięty; nowa referencja po unieważnieniu — wiadomość z nową', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h-gone');
    await family(t.db, 'h-new');
    const gone = await seedReference(t.db, 'h-gone');
    const old = await seedReference(t.db, 'h-new');
    const { id } = await draftAndSnapshot(t);
    await approveAndQueue(t, id);
    await revoke(t.db, gone.id);
    await revoke(t.db, old.id);
    const fresh = await seedReference(t.db, 'h-new');

    const transport = fakeTransport();
    await runEmailBatch(t.env, { transport, dryRun: false, now: new Date(DAY1.getTime() + 30 * 60_000) });
    assert.deepEqual(transport.calls.map((message) => message.to), ['h-new-g1@example.invalid']);
    assert.ok(transport.calls[0].text.includes(fresh.formatted));
    assert.ok(!transport.calls[0].text.includes(old.formatted));
    const { rows } = await t.db.query('SELECT household_id, state, last_error FROM email_outbox WHERE campaign_id = $1 ORDER BY household_id', [id]);
    assert.deepEqual(rows.map((row) => [row.household_id, row.state, row.last_error]), [
      ['h-gone', 'skipped', 'payment_reference_missing'],
      ['h-new', 'sent', null],
    ]);
  } finally {
    await t.db.close();
  }
});

test('kampania z {rodzina} bez {komunikat}: bez wykluczeń za brak referencji, ostrzeżenie o identyfikatorze', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h-a');
    const { id, snapshot } = await draftAndSnapshot(t, BODY.replace('Komunikacja strukturalna: {komunikat}', 'Tytuł przelewu: {rodzina}'));
    assert.equal(snapshot.recipientsCount, 1);
    assert.deepEqual(snapshot.exclusions, {});
    const preview = await t.call(t.board, `/api/email/campaigns/${id}/preview`);
    assert.ok(preview.body.warnings.includes('household_id_as_payment_reference'));
  } finally {
    await t.db.close();
  }
});

test('treść: {komunikat} jest dozwolony tylko w treści; render wymaga poprawnej referencji; ostrzeżenia', () => {
  const base = { title: 'Tytuł', subject: 'Składka {rok}', audience: 'all_households' };
  assert.equal(parseCampaignContent({ ...base, bodyText: BODY }).bodyText, BODY);
  assert.throws(() => parseCampaignContent({ ...base, subject: 'Składka {komunikat}', bodyText: BODY }),
    (error) => error instanceof ContentError && error.code === 'invalid_placeholder');
  const campaign = { subject: 'Składka {rok}', body_text: BODY };
  const reference = generateStructuredReference();
  const rendered = renderMessage(campaign, { schoolYearLabel: '2026/2027', householdId: 'h-x', structuredReference: reference });
  assert.ok(rendered.text.includes(formatStructuredReference(reference)));
  assert.ok(!rendered.text.includes('h-x'));
  for (const bad of [null, '', reference.slice(0, 11), `${reference.slice(0, 10)}${String((Number(reference.slice(10)) % 97) + 1).padStart(2, '0')}`]) {
    assert.throws(() => renderMessage(campaign, { schoolYearLabel: '2026/2027', householdId: 'h-x', structuredReference: bad }),
      (error) => error instanceof ContentError && error.code === 'payment_reference_missing', String(bad));
  }
  // Przykładowa referencja podglądu ma poprawny format i nie jest losowana przez generator.
  assert.equal(isValidStructuredReference(SAMPLE_STRUCTURED_REFERENCE), true);
  assert.equal(formatStructuredReference(SAMPLE_STRUCTURED_REFERENCE), '+++000/0000/00097+++');
  assert.deepEqual(contentWarnings({ bodyText: BODY }).filter((code) => code !== 'template_requires_board_decision_d16'), []);
  assert.ok(contentWarnings({ bodyText: 'Składka dobrowolna, bez tytułu przelewu.' }).includes('missing_payment_reference'));
  assert.ok(contentWarnings({ bodyText: 'Tytuł: {rodzina}. Wpłacający mogą pominąć.' }).includes('household_id_as_payment_reference'));
});
