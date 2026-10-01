// #92: placeholdery {rachunek}/{odbiorca} w kampanii e-mail — IBAN i odbiorca
// wyłącznie z ZATWIERDZONEJ na rok wersji danych do wpłaty (payment_instructions).
// Bez zatwierdzonej wersji kampanii nie da się zatwierdzić ani wysłać testowo;
// korekta rachunku po zatwierdzeniu kampanii wymaga ponownego zatwierdzenia.
// Wyłącznie dane syntetyczne (@example.invalid). Żaden test nie łączy się z
// siecią: wysyłka używa atrapy transportu, a pułapka sieci liczy próby.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { runEmailBatch } from '../src/email/worker.js';
import {
  BODY_PLACEHOLDERS, ContentError, parseCampaignContent, renderMessage, usesPaymentInstructions,
} from '../src/email/content.js';
import { MESSAGES } from '../shared/messages.js';
import { WARNING_LABELS } from '../email/core.js';
import { createTestDb, networkGuardCalls, request, seedClass, seedUserSession, seedPublishedPrivacyNotice } from './helpers/pg.js';

const YEAR = 'y2026';
const DAY1 = new Date('2026-10-05T08:00:00Z');
const IBAN_OLD = 'BE68539007547034';
const IBAN_NEW = 'BE71096123456769';
const PAYEE = 'Rada Rodziców — Szkoła Testowa';
const BODY = 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Rachunek: {rachunek}, odbiorca: {odbiorca}. Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.';
const PREVIEW_ADDRESS = 'skarbnik-test@rada.example.invalid';

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
  const treasurer = await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
  const board = await seedUserSession(db, { userId: 'u-bd', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] });
  const board2 = await seedUserSession(db, { userId: 'u-bd2', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] });
  const env = {
    db,
    APP_ENV: 'development',
    EMAIL_SENDING_ENABLED: 'true',
    EMAIL_TEST_ALLOWLIST: '*@example.invalid',
    EMAIL_PREVIEW_RECIPIENTS: PREVIEW_ADDRESS,
    BREVO_FROM_EMAIL: 'rada@example.invalid',
    BREVO_WEBHOOK_SECRET: 'w'.repeat(48),
  };
  const call = async (cookie, path, options = {}) => {
    const response = await handlePgRequest(request(path, { cookie, ...options }), env);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { db, env, treasurer, board, board2, call };
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

// Zatwierdzenie danych do wpłaty przez API (zarząd + MFA, Idempotency-Key).
async function approveInstructions(t, iban, { cookie = t.board2, key = crypto.randomUUID() } = {}) {
  const res = await t.call(cookie, '/api/payment-instructions', {
    method: 'POST', headers: { 'Idempotency-Key': key },
    body: { schoolYearId: YEAR, iban, payeeName: PAYEE },
  });
  assert.ok([200, 201].includes(res.status), JSON.stringify(res.body));
  return res.body.paymentInstructions;
}

async function draftAndSnapshot(t, bodyText = BODY) {
  const created = await t.call(t.treasurer, '/api/email/campaigns', {
    method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: { schoolYearId: YEAR, title: 'Przypomnienie z rachunkiem', audience: 'all_households', subject: 'Dobrowolna składka {rok}', bodyText },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.campaign.id;
  const snapshot = await t.call(t.treasurer, `/api/email/campaigns/${id}/snapshot`, { method: 'POST' });
  assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
  return id;
}

async function previewAndApprove(t, id) {
  const preview = await t.call(t.board, `/api/email/campaigns/${id}/preview`);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const approved = await t.call(t.board, `/api/email/campaigns/${id}/approve`, {
    method: 'POST',
    body: {
      contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash,
      paymentInstructionsId: preview.body.paymentInstructions?.id ?? null,
    },
  });
  return { preview: preview.body, approved };
}

test('{rachunek}/{odbiorca} bez zatwierdzonej wersji: podgląd ze znacznikiem, zatwierdzenie i test 409, nic nie wychodzi', async () => {
  const t = await setup();
  const networkBefore = networkGuardCalls();
  try {
    await family(t.db, 'h-a');
    const id = await draftAndSnapshot(t);
    const { preview, approved } = await previewAndApprove(t, id);
    assert.ok(preview.warnings.includes('payment_instructions_missing'));
    assert.equal(preview.paymentInstructions, null);
    assert.ok(preview.sample.text.includes('Rachunek: [brak zatwierdzonych danych do wpłaty]'), preview.sample.text);
    assert.equal(approved.status, 409);
    assert.equal(approved.body.error, 'payment_instructions_missing');
    const { rows } = await t.db.query('SELECT status FROM email_campaigns WHERE id = $1', [id]);
    assert.equal(rows[0].status, 'draft');

    const testSend = await t.call(t.treasurer, `/api/email/campaigns/${id}/test-send`, {
      method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: { recipientEmail: PREVIEW_ADDRESS },
    });
    assert.equal(testSend.status, 409);
    assert.equal(testSend.body.error, 'payment_instructions_missing');
    const { rows: previews } = await t.db.query('SELECT count(*)::int AS n FROM email_preview_sends');
    assert.equal(previews[0].n, 0);
    assert.equal(networkGuardCalls(), networkBefore);
  } finally {
    await t.db.close();
  }
});

test('{rachunek}/{odbiorca}: IBAN i odbiorca z zatwierdzonej wersji; rodzeństwo i dwoje opiekunów = jedna wiadomość; ponowienie nic nie wysyła', async () => {
  const t = await setup();
  const networkBefore = networkGuardCalls();
  try {
    await family(t.db, 'h-a');
    await family(t.db, 'h-sib', { students: 2, guardians: 2 });
    const version = await approveInstructions(t, IBAN_OLD);
    const id = await draftAndSnapshot(t);
    const { preview, approved } = await previewAndApprove(t, id);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.ok(!preview.warnings.includes('payment_instructions_missing'));
    assert.deepEqual(preview.paymentInstructions, { id: version.id, approvedAt: version.approvedAt });
    assert.ok(preview.sample.text.includes(`Rachunek: BE68 5390 0754 7034, odbiorca: ${PAYEE}.`), preview.sample.text);
    const queued = await t.call(t.treasurer, `/api/email/campaigns/${id}/queue`, { method: 'POST' });
    assert.equal(queued.status, 200, JSON.stringify(queued.body));

    const transport = fakeTransport();
    await runEmailBatch(t.env, { transport, dryRun: false, now: new Date(DAY1.getTime() + 30 * 60_000) });
    assert.deepEqual(transport.calls.map((message) => message.to).sort(), ['h-a-g1@example.invalid', 'h-sib-g1@example.invalid']);
    for (const message of transport.calls) {
      assert.ok(message.text.includes('BE68 5390 0754 7034'), message.text);
      assert.ok(message.text.includes(PAYEE));
      assert.doesNotMatch(message.text, /\{rachunek\}|\{odbiorca\}|brak zatwierdzonych/);
      assert.doesNotMatch(message.text, /zaległ|dług|dłużn|należnoś/i);
      // Czysty tekst — bez HTML i bez obrazu kodu QR (D-17).
      assert.equal(message.html, undefined);
      assert.doesNotMatch(message.text, /<svg|<img|data:image/);
    }
    const again = fakeTransport();
    await runEmailBatch(t.env, { transport: again, dryRun: false, now: new Date(DAY1.getTime() + 90 * 60_000) });
    assert.equal(again.calls.length, 0);

    // Zdarzenie zatwierdzenia wskazuje wersję danych do wpłaty; IBAN nie trafia do audytu.
    const { rows: events } = await t.db.query(
      "SELECT metadata_json FROM audit_events WHERE action = 'email.campaign.approved' AND entity_id = $1", [id],
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].metadata_json.paymentInstructionsId, version.id);
    const { rows: audit } = await t.db.query('SELECT metadata_json FROM audit_events');
    assert.ok(!JSON.stringify(audit).includes(IBAN_OLD), 'IBAN nie trafia do audit_events');
    assert.equal(networkGuardCalls(), networkBefore);
  } finally {
    await t.db.close();
  }
});

test('korekta rachunku po zatwierdzeniu, przed kolejką: queue 409; nowa migawka i ponowne zatwierdzenie → wiadomość z nowym rachunkiem', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h-a');
    await approveInstructions(t, IBAN_OLD);
    const id = await draftAndSnapshot(t);
    assert.equal((await previewAndApprove(t, id)).approved.status, 200);
    await approveInstructions(t, IBAN_NEW);
    const refused = await t.call(t.treasurer, `/api/email/campaigns/${id}/queue`, { method: 'POST' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'payment_instructions_changed');

    const snapshot = await t.call(t.treasurer, `/api/email/campaigns/${id}/snapshot`, { method: 'POST' });
    assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
    const { preview, approved } = await previewAndApprove(t, id);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.ok(preview.sample.text.includes('BE71 0961 2345 6769'));
    const queued = await t.call(t.treasurer, `/api/email/campaigns/${id}/queue`, { method: 'POST' });
    assert.equal(queued.status, 200, JSON.stringify(queued.body));
    const transport = fakeTransport();
    await runEmailBatch(t.env, { transport, dryRun: false, now: new Date(DAY1.getTime() + 30 * 60_000) });
    assert.equal(transport.calls.length, 1);
    assert.ok(transport.calls[0].text.includes('BE71 0961 2345 6769'));
    assert.ok(!transport.calls[0].text.includes('BE68 5390 0754 7034'));
  } finally {
    await t.db.close();
  }
});

test('zatwierdzenie wiąże wersję z podglądu: korekta między podglądem a zatwierdzeniem albo brak identyfikatora → 409', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h-a');
    const oldVersion = await approveInstructions(t, IBAN_OLD);
    const id = await draftAndSnapshot(t);
    const preview = await t.call(t.board, `/api/email/campaigns/${id}/preview`);
    assert.equal(preview.body.paymentInstructions.id, oldVersion.id);
    const hashes = { contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash };
    const approve = (body) => t.call(t.board, `/api/email/campaigns/${id}/approve`, { method: 'POST', body: { ...hashes, ...body } });

    const withoutId = await approve({});
    assert.equal(withoutId.status, 409);
    assert.equal(withoutId.body.error, 'payment_instructions_changed');
    assert.equal((await approve({ paymentInstructionsId: 42 })).status, 400);

    // Zarząd koryguje rachunek, gdy zatwierdzający ma otwarty stary podgląd.
    await approveInstructions(t, IBAN_NEW);
    const stale = await approve({ paymentInstructionsId: oldVersion.id });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'payment_instructions_changed');
    const { rows } = await t.db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'email.campaign.approved'");
    assert.equal(rows[0].n, 0);
    // Świeży podgląd pokazuje nowy rachunek i pozwala zatwierdzić.
    const fresh = await previewAndApprove(t, id);
    assert.ok(fresh.preview.sample.text.includes('BE71 0961 2345 6769'));
    assert.equal(fresh.approved.status, 200, JSON.stringify(fresh.approved.body));
  } finally {
    await t.db.close();
  }
});

test('korekta rachunku w trakcie wysyłki: worker wstrzymuje kampanię (wiersze w kolejce), wznowienie po pauzie 409', async () => {
  const t = await setup();
  const networkBefore = networkGuardCalls();
  try {
    await family(t.db, 'h-a');
    await family(t.db, 'h-b');
    await approveInstructions(t, IBAN_OLD);
    const id = await draftAndSnapshot(t);
    assert.equal((await previewAndApprove(t, id)).approved.status, 200);
    assert.equal((await t.call(t.treasurer, `/api/email/campaigns/${id}/queue`, { method: 'POST' })).status, 200);
    await approveInstructions(t, IBAN_NEW);

    const transport = fakeTransport();
    await runEmailBatch(t.env, { transport, dryRun: false, now: new Date(DAY1.getTime() + 30 * 60_000) });
    assert.equal(transport.calls.length, 0, 'ani stary, ani niezatwierdzony w kampanii rachunek nie wychodzi');
    const { rows: outbox } = await t.db.query('SELECT state FROM email_outbox WHERE campaign_id = $1', [id]);
    assert.deepEqual(outbox.map((row) => row.state), ['queued', 'queued']);
    const { rows: runs } = await t.db.query('SELECT stopped_reason, planned FROM email_worker_runs ORDER BY started_at DESC LIMIT 1');
    assert.deepEqual(runs[0], { stopped_reason: 'payment_instructions_changed', planned: 0 });

    assert.equal((await t.call(t.treasurer, `/api/email/campaigns/${id}/pause`, { method: 'POST' })).status, 200);
    const resumed = await t.call(t.treasurer, `/api/email/campaigns/${id}/resume`, { method: 'POST' });
    assert.equal(resumed.status, 409);
    assert.equal(resumed.body.error, 'payment_instructions_changed');
    const cancelled = await t.call(t.treasurer, `/api/email/campaigns/${id}/cancel`, { method: 'POST' });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(networkGuardCalls(), networkBefore);
  } finally {
    await t.db.close();
  }
});

test('treść: {rachunek}/{odbiorca} tylko w treści; render wymaga poprawnego IBAN; komunikaty i etykiety', () => {
  assert.ok(BODY_PLACEHOLDERS.includes('rachunek') && BODY_PLACEHOLDERS.includes('odbiorca'));
  const base = { title: 'Tytuł', subject: 'Składka {rok}', audience: 'all_households' };
  assert.equal(parseCampaignContent({ ...base, bodyText: BODY }).bodyText, BODY);
  assert.throws(() => parseCampaignContent({ ...base, subject: 'Rachunek {rachunek}', bodyText: BODY }),
    (error) => error instanceof ContentError && error.code === 'invalid_placeholder');
  const campaign = { subject: 'Składka {rok}', body_text: BODY };
  assert.equal(usesPaymentInstructions(campaign), true);
  assert.equal(usesPaymentInstructions({ body_text: 'Tylko {rok} i {komunikat}.' }), false);
  assert.equal(usesPaymentInstructions({ body_text: 'Odbiorca: {odbiorca}.' }), true);
  const rendered = renderMessage(campaign, {
    schoolYearLabel: '2026/2027', householdId: 'h-x', paymentInstructions: { iban: IBAN_OLD, payeeName: PAYEE },
  });
  assert.ok(rendered.text.includes(`Rachunek: BE68 5390 0754 7034, odbiorca: ${PAYEE}.`));
  for (const bad of [null, { iban: 'BE68539007547035', payeeName: PAYEE }, { iban: IBAN_OLD, payeeName: '  ' }]) {
    assert.throws(() => renderMessage(campaign, { schoolYearLabel: '2026/2027', householdId: 'h-x', paymentInstructions: bad }),
      (error) => error instanceof ContentError && error.code === 'payment_instructions_missing', JSON.stringify(bad));
  }
  // Treść bez placeholderów rachunku nie wymaga danych do wpłaty.
  const plain = renderMessage({ subject: 'S {rok}', body_text: 'Treść {rok} bez rachunku, wpłacający mogą pominąć.' }, { schoolYearLabel: '2026/2027', householdId: 'h-x' });
  assert.ok(plain.text.includes('2026/2027'));
  for (const code of ['payment_instructions_missing', 'payment_instructions_changed']) {
    assert.equal(typeof MESSAGES[code], 'string', code);
  }
  assert.equal(typeof WARNING_LABELS.payment_instructions_missing, 'string');
});

// --- #92 (0162): wersja danych do wpłaty zapisana w kampanii -----------------

test('0162: zatwierdzenie zapisuje wersję w kampanii; po korekcie podgląd pokazuje ZATWIERDZONY rachunek z ostrzeżeniem, test 409, worker nic nie wysyła (także przy ponowieniu)', async () => {
  const t = await setup();
  const networkBefore = networkGuardCalls();
  try {
    await family(t.db, 'h-a');
    const oldVersion = await approveInstructions(t, IBAN_OLD);
    const id = await draftAndSnapshot(t);
    const draftView = await t.call(t.treasurer, `/api/email/campaigns/${id}/preview`);
    assert.equal(draftView.body.campaign.approvedPaymentInstructionsId, null);
    const { approved } = await previewAndApprove(t, id);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.campaign.approvedPaymentInstructionsId, oldVersion.id);
    const { rows } = await t.db.query('SELECT approved_payment_instructions_id FROM email_campaigns WHERE id = $1', [id]);
    assert.equal(rows[0].approved_payment_instructions_id, oldVersion.id);

    // Korekta rachunku po zatwierdzeniu kampanii.
    const newVersion = await approveInstructions(t, IBAN_NEW);
    assert.notEqual(newVersion.id, oldVersion.id);
    const preview = await t.call(t.board, `/api/email/campaigns/${id}/preview`);
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.paymentInstructions, { id: oldVersion.id, approvedAt: oldVersion.approvedAt });
    assert.ok(preview.body.sample.text.includes('BE68 5390 0754 7034'), 'podgląd zatwierdzonej kampanii = zatwierdzona wersja');
    assert.ok(!preview.body.sample.text.includes('BE71 0961 2345 6769'), 'nie „bieżąca” wersja');
    assert.ok(preview.body.warnings.includes('payment_instructions_changed'));
    assert.ok(!preview.body.warnings.includes('payment_instructions_missing'));
    assert.equal(typeof WARNING_LABELS.payment_instructions_changed, 'string');

    const testSend = await t.call(t.treasurer, `/api/email/campaigns/${id}/test-send`, {
      method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: { recipientEmail: PREVIEW_ADDRESS },
    });
    assert.equal(testSend.status, 409);
    assert.equal(testSend.body.error, 'payment_instructions_changed');
    const { rows: previews } = await t.db.query('SELECT count(*)::int AS n FROM email_preview_sends');
    assert.equal(previews[0].n, 0);

    // Kolejka odmawia, a worker (także ponowiony) nic nie wysyła.
    const refused = await t.call(t.treasurer, `/api/email/campaigns/${id}/queue`, { method: 'POST' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'payment_instructions_changed');
    for (const offset of [30, 90]) {
      const transport = fakeTransport();
      await runEmailBatch(t.env, { transport, dryRun: false, now: new Date(DAY1.getTime() + offset * 60_000) });
      assert.equal(transport.calls.length, 0);
    }
    assert.equal(networkGuardCalls(), networkBefore);
  } finally {
    await t.db.close();
  }
});

test('0162: wiadomość testowa zatwierdzonej kampanii używa zatwierdzonej wersji; podwójne kliknięcie zatwierdzenia = jedno zatwierdzenie', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h-a');
    const version = await approveInstructions(t, IBAN_OLD);
    const id = await draftAndSnapshot(t);
    const preview = await t.call(t.board, `/api/email/campaigns/${id}/preview`);
    const body = {
      contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash,
      paymentInstructionsId: preview.body.paymentInstructions.id,
    };
    const [first, second] = await Promise.all([
      t.call(t.board, `/api/email/campaigns/${id}/approve`, { method: 'POST', body }),
      t.call(t.board, `/api/email/campaigns/${id}/approve`, { method: 'POST', body }),
    ]);
    assert.deepEqual([first.status, second.status], [200, 200], JSON.stringify([first.body, second.body]));
    const third = await t.call(t.board, `/api/email/campaigns/${id}/approve`, { method: 'POST', body });
    assert.equal(third.status, 200);
    assert.equal(third.body.campaign.approvedPaymentInstructionsId, version.id);
    const { rows: events } = await t.db.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'email.campaign.approved' AND entity_id = $1", [id],
    );
    assert.equal(events[0].n, 1);
    // Ponowienie z inną wersją nie jest ponowieniem tego samego zatwierdzenia.
    const other = await t.call(t.board, `/api/email/campaigns/${id}/approve`, {
      method: 'POST', body: { ...body, paymentInstructionsId: 'inna-wersja' },
    });
    assert.equal(other.status, 409);
    assert.equal(other.body.error, 'campaign_not_draft');

    // Wiadomość testowa (atrapa transportu, adres techniczny) po korekcie
    // rachunku: odmowa; przed korektą — rachunek z zatwierdzonej wersji.
    const transport = fakeTransport();
    t.env.emailTransport = transport;
    const testSend = await t.call(t.treasurer, `/api/email/campaigns/${id}/test-send`, {
      method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: { recipientEmail: PREVIEW_ADDRESS },
    });
    assert.equal(testSend.status, 201, JSON.stringify(testSend.body));
    assert.equal(transport.calls.length, 1);
    assert.equal(transport.calls[0].to, PREVIEW_ADDRESS);
    assert.ok(transport.calls[0].text.includes('BE68 5390 0754 7034'), transport.calls[0].text);
    await approveInstructions(t, IBAN_NEW);
    const afterCorrection = await t.call(t.treasurer, `/api/email/campaigns/${id}/test-send`, {
      method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: { recipientEmail: PREVIEW_ADDRESS },
    });
    assert.equal(afterCorrection.status, 409);
    assert.equal(afterCorrection.body.error, 'payment_instructions_changed');
    assert.equal(transport.calls.length, 1, 'po korekcie nic nie wychodzi, nawet test');
  } finally {
    await t.db.close();
  }
});

test('0162: granice ról — skarbnik nie zatwierdza, przedstawiciel klasy bez dostępu do podglądu i zatwierdzenia; kolumna bez zmian', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h-a');
    await approveInstructions(t, IBAN_OLD);
    const rep = await seedUserSession(t.db, { userId: 'u-rep', mfa: true, roles: [{ role: 'representative', classId: 'c1', schoolYearId: YEAR }] });
    const id = await draftAndSnapshot(t);
    const preview = await t.call(t.board, `/api/email/campaigns/${id}/preview`);
    const body = {
      contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash,
      paymentInstructionsId: preview.body.paymentInstructions.id,
    };
    const byTreasurer = await t.call(t.treasurer, `/api/email/campaigns/${id}/approve`, { method: 'POST', body });
    assert.equal(byTreasurer.status, 403);
    assert.equal((await t.call(rep, `/api/email/campaigns/${id}/preview`)).status, 403);
    assert.equal((await t.call(rep, `/api/email/campaigns/${id}/approve`, { method: 'POST', body })).status, 403);
    const { rows } = await t.db.query('SELECT status, approved_payment_instructions_id FROM email_campaigns WHERE id = $1', [id]);
    assert.deepEqual(rows[0], { status: 'draft', approved_payment_instructions_id: null });
  } finally {
    await t.db.close();
  }
});

test('0162: strażnik bazy — wersję ustawia tylko zatwierdzenie, czyści tylko cofnięcie do szkicu; rok musi się zgadzać', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h-a');
    const oldVersion = await approveInstructions(t, IBAN_OLD);
    const id = await draftAndSnapshot(t);
    // Szkic nie może nosić wersji (CHECK).
    await assert.rejects(
      t.db.query('UPDATE email_campaigns SET approved_payment_instructions_id = $2 WHERE id = $1', [id, oldVersion.id]),
      /email_campaign_payment_instructions_immutable|email_campaigns_draft_without_payment_instructions/,
    );
    // Wersja z innego roku.
    await t.db.query("INSERT INTO school_years (id, label, starts_on, ends_on) VALUES ('y2027', '2027/2028', '2027-09-01', '2028-08-31') ON CONFLICT DO NOTHING");
    await t.db.query(
      `INSERT INTO payment_instructions (id, school_year_id, iban, payee_name, approved_by, idempotency_key)
       VALUES ('pi-other-year', 'y2027', $1, $2, 'u-bd2', 'klucz-inny-rok-0001')`,
      [IBAN_NEW, PAYEE],
    );
    await assert.rejects(
      t.db.query(
        `UPDATE email_campaigns SET status = 'approved', approved_by = 'u-bd', approved_at = now(),
                approved_content_hash = content_hash, approved_recipients_hash = recipients_hash,
                approved_payment_instructions_id = 'pi-other-year' WHERE id = $1`, [id],
      ),
      /email_campaign_payment_instructions_year_mismatch/,
    );
    assert.equal((await previewAndApprove(t, id)).approved.status, 200);
    // W stanie 'approved' wersja jest niezmienna.
    await assert.rejects(
      t.db.query('UPDATE email_campaigns SET approved_payment_instructions_id = NULL WHERE id = $1', [id]),
      /email_campaign_payment_instructions_immutable/,
    );
    // Cofnięcie do szkicu bez wyczyszczenia wersji — odrzucone.
    await assert.rejects(
      t.db.query(
        `UPDATE email_campaigns SET status = 'draft', approved_by = NULL, approved_at = NULL,
                approved_content_hash = NULL, approved_recipients_hash = NULL WHERE id = $1`, [id],
      ),
      /email_campaigns_draft_without_payment_instructions/,
    );
    // Nowa migawka (API) czyści wersję razem z zatwierdzeniem.
    const snapshot = await t.call(t.treasurer, `/api/email/campaigns/${id}/snapshot`, { method: 'POST' });
    assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
    const { rows } = await t.db.query('SELECT status, approved_payment_instructions_id FROM email_campaigns WHERE id = $1', [id]);
    assert.deepEqual(rows[0], { status: 'draft', approved_payment_instructions_id: null });
    // Po kolejce (sending) wersja również niezmienna.
    assert.equal((await previewAndApprove(t, id)).approved.status, 200);
    assert.equal((await t.call(t.treasurer, `/api/email/campaigns/${id}/queue`, { method: 'POST' })).status, 200);
    await assert.rejects(
      t.db.query('UPDATE email_campaigns SET approved_payment_instructions_id = NULL WHERE id = $1', [id]),
      /email_campaign_payment_instructions_immutable|email_campaign_sending_locked/,
    );
    // Nowa kampania nie może powstać z wersją.
    await assert.rejects(
      t.db.query(
        `INSERT INTO email_campaigns (id, school_year_id, title, audience, subject, body_text, content_hash, created_by, updated_by, idempotency_key, approved_payment_instructions_id)
         SELECT 'c-new', school_year_id, title, audience, subject, body_text, content_hash, created_by, updated_by, 'klucz-nowej-0001', $2
           FROM email_campaigns WHERE id = $1`, [id, oldVersion.id],
      ),
      /email_campaign_payment_instructions_immutable|email_campaigns_draft_without_payment_instructions/,
    );
  } finally {
    await t.db.close();
  }
});

test('0162: kampania zakolejkowana przed migracją (bez zapisanej wersji) nie wychodzi — worker pomija, wznowienie 409', async () => {
  const t = await setup();
  const networkBefore = networkGuardCalls();
  try {
    await family(t.db, 'h-a');
    await approveInstructions(t, IBAN_OLD);
    const id = await draftAndSnapshot(t);
    assert.equal((await previewAndApprove(t, id)).approved.status, 200);
    // Stan po migracji 0162 dla kampanii zatwierdzonej wcześniej: kolumna NULL
    // (migracja niczego nie uzupełnia). Odtwarzamy go z pominięciem strażnika.
    const legacyState = async () => {
      await t.db.query('ALTER TABLE email_campaigns DISABLE TRIGGER email_campaigns_payment_instructions_guard');
      await t.db.query('UPDATE email_campaigns SET approved_payment_instructions_id = NULL WHERE id = $1', [id]);
      await t.db.query('ALTER TABLE email_campaigns ENABLE TRIGGER email_campaigns_payment_instructions_guard');
    };
    // Kampania w toku (zakolejkowana przed migracją).
    assert.equal((await t.call(t.treasurer, `/api/email/campaigns/${id}/queue`, { method: 'POST' })).status, 200);
    await legacyState();
    const preview = await t.call(t.board, `/api/email/campaigns/${id}/preview`);
    assert.ok(preview.body.warnings.includes('payment_instructions_changed'));
    assert.equal(preview.body.paymentInstructions, null);
    assert.ok(preview.body.sample.text.includes('[brak zatwierdzonych danych do wpłaty]'));
    const transport = fakeTransport();
    await runEmailBatch(t.env, { transport, dryRun: false, now: new Date(DAY1.getTime() + 30 * 60_000) });
    assert.equal(transport.calls.length, 0);
    const { rows: outbox } = await t.db.query('SELECT state FROM email_outbox WHERE campaign_id = $1', [id]);
    assert.deepEqual(outbox.map((row) => row.state), ['queued']);
    assert.equal((await t.call(t.treasurer, `/api/email/campaigns/${id}/pause`, { method: 'POST' })).status, 200);
    const resumed = await t.call(t.treasurer, `/api/email/campaigns/${id}/resume`, { method: 'POST' });
    assert.equal(resumed.status, 409);
    assert.equal(resumed.body.error, 'payment_instructions_changed');
    assert.equal(networkGuardCalls(), networkBefore);
  } finally {
    await t.db.close();
  }
});
