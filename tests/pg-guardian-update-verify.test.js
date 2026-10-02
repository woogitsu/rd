// Kod weryfikacyjny na NOWY adres z wniosku rodzica o aktualizację kontaktu
// (#140 pkt 5, migracja 0184). Wyłącznie dane syntetyczne (@example.invalid);
// żadna wiadomość nie wychodzi — worker dostaje transport-atrapę, a prawdziwy
// transport Brevo odmawia pod `node --test` (src/email/brevo.js).
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { emailConfig, EmailTransportError } from '../src/email/brevo.js';
import { emailHash } from '../src/email/content.js';
import { runEmailBatch } from '../src/email/worker.js';
import { VERIFY_CODE_TTL_MS, VERIFY_MAX_FAILED_ATTEMPTS } from '../src/email/guardian-verify.js';
import { createTestDb, request, seedClass, seedPublishedPrivacyNotice, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const Y = 'y-2026';
const FLAG = { GUARDIAN_VERIFY_EMAIL_ENABLED: 'true' };
const TEMPLATE = {
  subject: 'Potwierdzenie adresu e-mail dla Rady Rodziców',
  bodyText: 'Twój kod potwierdzający nowy adres to {kod}. Kod jest ważny {waznosc} godzin. Jeśli to nie Ty, zignoruj tę wiadomość.',
};
const WORKER_ENV = {
  APP_ENV: 'test', EMAIL_SENDING_ENABLED: 'true', BREVO_FROM_EMAIL: 'rada@rada.example.invalid',
  EMAIL_TEST_ALLOWLIST: '*@example.invalid', ...FLAG,
};
const CODE_IN_TEXT = /\b(\d{8})\b/;

async function call(env, path, { cookie, method, body } = {}) {
  const response = await handlePgRequest(request(path, { cookie, method: method ?? (body ? 'POST' : 'GET'), body }), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

function fakeTransport({ fail = [] } = {}) {
  const sent = [];
  const queue = [...fail];
  return {
    sent,
    calls: 0,
    async send(message) {
      this.calls += 1;
      const failure = queue.shift();
      if (failure) throw failure;
      sent.push(message);
      return { messageId: `fx-verify-${sent.length}` };
    },
  };
}

async function runWorker(env, transport, { now = new Date(), extra = {} } = {}) {
  return runEmailBatch(env, { dryRun: false, transport, now, config: emailConfig({ ...WORKER_ENV, ...extra }) });
}

async function seedGuardian(db, { id, householdId, studentId, sharedStudentId, classId = 'c-1a', firstName = 'Anna' }) {
  await db.query('INSERT INTO households (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [householdId]);
  await db.query(
    `INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
     VALUES ($1, $2, $3, 'Testowa', $4, true)`,
    [id, householdId, firstName, `stary-${id}@example.invalid`],
  );
  if (studentId) {
    await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, $2, 'Jan', 'Testowy')", [studentId, householdId]);
    await seedClass(db, { id: classId, schoolYearId: Y, name: classId });
    await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)',
      [`e-${studentId}`, studentId, classId, Y]);
  }
  await db.query(
    `INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact)
     SELECT $1, $2, true, NOT EXISTS (SELECT 1 FROM student_guardians WHERE student_id = $1)`,
    [studentId ?? sharedStudentId, id],
  );
}

async function setup({ env: extraEnv = FLAG, notice = true } = {}) {
  const db = await createTestDb();
  await seedSchoolYear(db, Y);
  if (notice) await seedPublishedPrivacyNotice(db);
  const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
  const author = await seedUserSession(db, { userId: 'u-board-author', roles: [{ role: 'board', schoolYearId: Y }], mfa: true });
  const approver = await seedUserSession(db, { userId: 'u-board-approver', roles: [{ role: 'board', schoolYearId: Y }], mfa: true });
  const rep = await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: Y }] });
  const env = { db, ...extraEnv };
  return { db, env, cookies: { admin, author, approver, rep } };
}

async function approvedTemplate(ctx) {
  const created = await call(ctx.env, '/api/admin/guardian-verify-templates', { cookie: ctx.cookies.author, body: TEMPLATE });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const approved = await call(ctx.env, `/api/admin/guardian-verify-templates/${created.data.template.id}/approve`, {
    cookie: ctx.cookies.approver, body: { contentHash: created.data.template.contentHash },
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  return approved.data.template;
}

async function submitRequest(ctx, guardianId, body) {
  const link = await call(ctx.env, '/api/admin/guardian-links', { cookie: ctx.cookies.admin, body: { guardianId } });
  assert.equal(link.status, 201);
  const submitted = await call(ctx.env, '/api/public/guardian-update', { body: { token: link.data.token, ...body } });
  assert.equal(submitted.status, 201, JSON.stringify(submitted.data));
  return { token: link.data.token, requestId: submitted.data.requestId, response: submitted.data };
}

async function queueEntry(ctx, requestId) {
  const queue = await call(ctx.env, '/api/admin/guardian-update-requests?status=pending', { cookie: ctx.cookies.approver });
  assert.equal(queue.status, 200);
  return queue.data.requests.find((item) => item.id === requestId);
}

async function verificationRow(db, requestId) {
  const { rows } = await db.query('SELECT * FROM guardian_update_verifications WHERE request_id = $1', [requestId]);
  return rows[0] ?? null;
}

function codeFrom(message) {
  const match = CODE_IN_TEXT.exec(message.text);
  assert.ok(match, 'wiadomość zawiera kod');
  return match[1];
}

describe('kod weryfikacyjny nowego adresu z wniosku rodzica (#140 pkt 5)', () => {
  test('bez flagi albo bez zatwierdzonego szablonu: nic nie trafia do kolejki, kolejka wniosków pokazuje none z powodem', async () => {
    const off = await setup({ env: {} });
    await seedGuardian(off.db, { id: 'g-1', householdId: 'h-1', studentId: 's-1' });
    await approvedTemplate(off);
    const disabled = await submitRequest(off, 'g-1', { email: 'nowy1@example.invalid' });
    assert.equal(disabled.response.emailVerification, 'none');
    assert.deepEqual(
      (({ state, last_error: reason }) => ({ state, reason }))(await verificationRow(off.db, disabled.requestId)),
      { state: 'skipped', reason: 'verification_disabled' },
    );
    const entry = await queueEntry(off, disabled.requestId);
    assert.equal(entry.verification, 'none');
    assert.equal(entry.verificationReason, 'verification_disabled');
    const transport = fakeTransport();
    await runWorker(off.env, transport);
    assert.equal(transport.calls, 0, 'wyłączona flaga przy wniosku — worker nic nie wysyła');
    await off.db.close();

    const noTemplate = await setup();
    await seedGuardian(noTemplate.db, { id: 'g-2', householdId: 'h-2', studentId: 's-2' });
    // Szkic bez zatwierdzenia nie wystarcza.
    assert.equal((await call(noTemplate.env, '/api/admin/guardian-verify-templates', { cookie: noTemplate.cookies.author, body: TEMPLATE })).status, 201);
    const missing = await submitRequest(noTemplate, 'g-2', { email: 'nowy2@example.invalid' });
    assert.equal(missing.response.emailVerification, 'none');
    assert.equal((await queueEntry(noTemplate, missing.requestId)).verificationReason, 'template_missing');
    const { rows } = await noTemplate.db.query("SELECT count(*)::int AS n FROM guardian_update_verifications WHERE state IN ('queued', 'sending', 'sent')");
    assert.equal(rows[0].n, 0, 'nic w kolejce');
    // Wniosek bez nowego adresu (sama zgoda) — bez wiersza weryfikacji.
    const consentOnly = await submitRequest(noTemplate, 'g-2', { contactAllowed: false });
    assert.equal(await verificationRow(noTemplate.db, consentOnly.requestId), null);
    assert.equal((await queueEntry(noTemplate, consentOnly.requestId)).verificationReason, 'no_new_email');
    await noTemplate.db.close();
  });

  test('szablon: walidacja {kod}, autor nie zatwierdza własnego, admin i przedstawiciel — 403, zatwierdzenie wymaga świeżego MFA', async () => {
    const ctx = await setup();
    const bad = [
      [{ ...TEMPLATE, bodyText: 'Treść bez kodu, ale dostatecznie długa.' }, 'verify_code_placeholder_required'],
      [{ ...TEMPLATE, bodyText: `${TEMPLATE.bodyText} {imie}` }, 'invalid_verify_template'],
      [{ ...TEMPLATE, subject: 'Kod {kod}' }, 'invalid_verify_template'],
    ];
    for (const [body, error] of bad) {
      assert.deepEqual(await call(ctx.env, '/api/admin/guardian-verify-templates', { cookie: ctx.cookies.author, body }), { status: 400, data: { error } });
    }
    assert.equal((await call(ctx.env, '/api/admin/guardian-verify-templates', { cookie: ctx.cookies.rep })).status, 403);
    const created = await call(ctx.env, '/api/admin/guardian-verify-templates', { cookie: ctx.cookies.author, body: TEMPLATE });
    const path = `/api/admin/guardian-verify-templates/${created.data.template.id}/approve`;
    assert.deepEqual(await call(ctx.env, path, { cookie: ctx.cookies.author, body: {} }), { status: 403, data: { error: 'self_approval_forbidden' } });
    assert.deepEqual(await call(ctx.env, path, { cookie: ctx.cookies.admin, body: {} }), { status: 403, data: { error: 'forbidden' } });
    await ctx.db.query("UPDATE sessions SET mfa_verified_at = now() - interval '20 minutes' WHERE user_id = 'u-board-approver'");
    assert.deepEqual(await call(ctx.env, path, { cookie: ctx.cookies.approver, body: {} }), { status: 403, data: { error: 'mfa_stale' } });
    await ctx.db.query("UPDATE sessions SET mfa_verified_at = now() WHERE user_id = 'u-board-approver'");
    assert.deepEqual(await call(ctx.env, path, { cookie: ctx.cookies.approver, body: { contentHash: 'f'.repeat(64) } }),
      { status: 409, data: { error: 'verify_template_changed' } });
    const approved = await call(ctx.env, path, { cookie: ctx.cookies.approver, body: {} });
    assert.equal(approved.status, 200);
    assert.equal(approved.data.template.status, 'approved');
    assert.equal(approved.data.template.approvedBy, 'u-board-approver');
    // Podwójne kliknięcie: ten sam stan, jedno zdarzenie.
    assert.equal((await call(ctx.env, path, { cookie: ctx.cookies.approver, body: {} })).status, 200);
    const { rows } = await ctx.db.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'guardian_verify_template.approved' AND entity_id = $1",
      [created.data.template.id],
    );
    assert.equal(rows[0].n, 1);
    await assert.rejects(
      ctx.db.query("UPDATE guardian_verify_templates SET body_text = body_text || ' {kod}' WHERE id = $1", [created.data.template.id]),
      /guardian_verify_template_immutable_fields/,
    );
    const list = await call(ctx.env, '/api/admin/guardian-verify-templates', { cookie: ctx.cookies.admin });
    assert.equal(list.data.currentTemplateId, created.data.template.id);
    assert.equal(list.data.enabled, true);
    await ctx.db.close();
  });

  test('z flagą i szablonem: jedna wiadomość tylko na nowy adres; podwójne wysłanie formularza i ponowienie workera nie wysyłają drugiej', async () => {
    const ctx = await setup();
    await seedGuardian(ctx.db, { id: 'g-3', householdId: 'h-3', studentId: 's-3' });
    const template = await approvedTemplate(ctx);
    const { token, requestId, response } = await submitRequest(ctx, 'g-3', { email: 'nowy3@example.invalid' });
    assert.equal(response.emailVerification, 'requested');
    assert.deepEqual(await call(ctx.env, '/api/public/guardian-update', { body: { token, email: 'inny3@example.invalid' } }),
      { status: 409, data: { error: 'link_used' } });
    const before = await queueEntry(ctx, requestId);
    assert.equal(before.verification, 'sent');
    assert.equal(before.verificationDelivery, 'queued');

    const transport = fakeTransport();
    // Flaga wyłączona w workerze: zlecony kod czeka w kolejce, nic nie wychodzi.
    await runWorker(ctx.env, transport, { extra: { GUARDIAN_VERIFY_EMAIL_ENABLED: 'false' } });
    assert.equal(transport.calls, 0);
    assert.equal((await verificationRow(ctx.db, requestId)).state, 'queued');
    const first = await runWorker(ctx.env, transport);
    assert.equal(first.sent, 1);
    await runWorker(ctx.env, transport);
    await runWorker(ctx.env, transport);
    assert.equal(transport.sent.length, 1, 'ponowienie przebiegu nie wysyła drugiej wiadomości');
    const [message] = transport.sent;
    assert.equal(message.to, 'nowy3@example.invalid', 'odbiorca = wyłącznie nowy adres z wniosku');
    assert.equal(message.idempotencyKey, `verify:${requestId}`);
    assert.equal(message.sender.email, 'rada@rada.example.invalid');
    assert.equal(message.subject, template.subject);
    assert.match(message.text, /ważny 24 godzin/);
    assert.match(message.text, /Informacja o przetwarzaniu danych osobowych \(wersja \d+\)/);
    const code = codeFrom(message);

    const row = await verificationRow(ctx.db, requestId);
    assert.equal(row.state, 'sent');
    assert.match(row.code_hash, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(row).includes(code), false, 'w bazie tylko skrót kodu');
    assert.ok(Date.parse(row.code_expires_at) - Date.parse(row.claimed_at) <= VERIFY_CODE_TTL_MS, 'termin ważności kodu najwyżej 24 h');
    const ledger = await ctx.db.query("SELECT count(*)::int AS n FROM email_send_ledger WHERE source = 'verification' AND verification_id = $1", [row.id]);
    assert.equal(ledger.rows[0].n, 1, 'jedna wiadomość w dzienniku limitu Brevo');
    const audit = await ctx.db.query(
      "SELECT action, metadata_json::text AS meta FROM audit_events WHERE entity_id = $1 ORDER BY occurred_at",
      [requestId],
    );
    assert.ok(audit.rows.some((r) => r.action === 'guardian_update_request.verification_sent'));
    const auditText = audit.rows.map((r) => r.meta).join('\n');
    assert.equal(auditText.includes('nowy3@example.invalid'), false, 'audyt bez adresu');
    assert.equal(auditText.includes(code), false, 'audyt bez kodu');
    // Stary adres opiekuna bez zmian do decyzji zarządu.
    const guardian = await ctx.db.query('SELECT email FROM guardians WHERE id = $1', ['g-3']);
    assert.equal(guardian.rows[0].email, 'stary-g-3@example.invalid');
    await ctx.db.close();
  });

  test('adres na liście wyłączeń: brak wysyłki i stan failed z powodem — przy złożeniu wniosku i po blokadzie dodanej później', async () => {
    const ctx = await setup();
    await seedGuardian(ctx.db, { id: 'g-4', householdId: 'h-4', studentId: 's-4' });
    await seedGuardian(ctx.db, { id: 'g-5', householdId: 'h-5', studentId: 's-5' });
    await approvedTemplate(ctx);
    await ctx.db.query("INSERT INTO email_suppressions (id, email_hash, reason) VALUES ('sup-4', $1, 'hard_bounce')", [emailHash('odbity4@example.invalid')]);
    const blocked = await submitRequest(ctx, 'g-4', { email: 'odbity4@example.invalid' });
    // Publicznie bez wyroczni listy wyłączeń: ta sama odpowiedź co przy zleconym kodzie.
    assert.equal(blocked.response.emailVerification, 'requested');
    const later = await submitRequest(ctx, 'g-5', { email: 'pozniej5@example.invalid' });
    await ctx.db.query("INSERT INTO email_suppressions (id, email_hash, reason) VALUES ('sup-5', $1, 'complaint')", [emailHash('pozniej5@example.invalid')]);

    const transport = fakeTransport();
    await runWorker(ctx.env, transport);
    assert.equal(transport.calls, 0);
    for (const requestId of [blocked.requestId, later.requestId]) {
      const entry = await queueEntry(ctx, requestId);
      assert.deepEqual([entry.verification, entry.verificationReason], ['failed', 'address_suppressed']);
    }
    await ctx.db.close();
  });

  test('poprawny kod → confirmed (ponowienie: ta sama odpowiedź); zły token i zły kod dają tę samą odpowiedź; limit prób', async () => {
    const ctx = await setup();
    await seedGuardian(ctx.db, { id: 'g-6', householdId: 'h-6', studentId: 's-6' });
    await seedGuardian(ctx.db, { id: 'g-7', householdId: 'h-7', studentId: 's-7' });
    await approvedTemplate(ctx);
    const good = await submitRequest(ctx, 'g-6', { email: 'nowy6@example.invalid' });
    const locked = await submitRequest(ctx, 'g-7', { email: 'nowy7@example.invalid' });
    const transport = fakeTransport();
    await runWorker(ctx.env, transport);
    const codes = Object.fromEntries(transport.sent.map((message) => [message.to, codeFrom(message)]));
    const failed = { status: 400, data: { error: 'invalid_or_expired_code' } };
    const verify = (body) => call(ctx.env, '/api/public/guardian-update/verify', { body });

    const wrong = codes['nowy6@example.invalid'] === '00000000' ? '11111111' : '00000000';
    assert.deepEqual(await verify({ token: 'a'.repeat(64), code: codes['nowy6@example.invalid'] }), failed, 'zły token');
    assert.deepEqual(await verify({ token: good.token, code: wrong }), failed, 'zły kod — ta sama odpowiedź');
    assert.deepEqual(await verify({ token: good.token, code: 'abc' }), failed, 'kod w złym formacie — ta sama odpowiedź');
    assert.deepEqual(await verify({ token: good.token, code: codes['nowy6@example.invalid'] }), { status: 200, data: { verification: 'confirmed' } });
    assert.deepEqual(await verify({ token: good.token, code: codes['nowy6@example.invalid'] }), { status: 200, data: { verification: 'confirmed' } },
      'podwójne kliknięcie po potwierdzeniu');
    assert.equal((await queueEntry(ctx, good.requestId)).verification, 'confirmed');
    const confirmations = await ctx.db.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'guardian_update_request.verification_confirmed' AND entity_id = $1", [good.requestId],
    );
    assert.equal(confirmations.rows[0].n, 1);

    const lockedWrong = codes['nowy7@example.invalid'] === '22222222' ? '33333333' : '22222222';
    for (let i = 0; i < VERIFY_MAX_FAILED_ATTEMPTS; i += 1) assert.deepEqual(await verify({ token: locked.token, code: lockedWrong }), failed);
    assert.deepEqual(await verify({ token: locked.token, code: codes['nowy7@example.invalid'] }), failed, 'po limicie prób nawet poprawny kod nie przechodzi');
    const entry = await queueEntry(ctx, locked.requestId);
    assert.deepEqual([entry.verification, entry.verificationReason], ['failed', 'attempts_exhausted']);
    assert.equal((await verificationRow(ctx.db, locked.requestId)).failed_attempts, VERIFY_MAX_FAILED_ATTEMPTS);
    await ctx.db.close();
  });

  test('wygasły kod (wstrzykiwany zegar env.now): po terminie ten sam błąd, kolejka pokazuje expired', async () => {
    let now = null;
    const ctx = await setup({ env: { ...FLAG, now: () => now ?? new Date() } });
    await seedGuardian(ctx.db, { id: 'g-8', householdId: 'h-8', studentId: 's-8' });
    await approvedTemplate(ctx);
    const { token, requestId } = await submitRequest(ctx, 'g-8', { email: 'nowy8@example.invalid' });
    now = new Date();
    const transport = fakeTransport();
    await runWorker(ctx.env, transport, { now });
    const code = codeFrom(transport.sent[0]);
    now = new Date(now.getTime() + VERIFY_CODE_TTL_MS + 60_000);
    assert.deepEqual(await call(ctx.env, '/api/public/guardian-update/verify', { body: { token, code } }),
      { status: 400, data: { error: 'invalid_or_expired_code' } });
    assert.equal((await queueEntry(ctx, requestId)).verification, 'expired');
    assert.equal((await verificationRow(ctx.db, requestId)).failed_attempts, 0, 'wygasły kod nie zużywa prób');
    await ctx.db.close();
  });

  test('dwoje opiekunów jednego dziecka: kod opiekuna A nie potwierdza wniosku opiekuna B', async () => {
    const ctx = await setup();
    await seedGuardian(ctx.db, { id: 'g-9a', householdId: 'h-9', studentId: 's-9', firstName: 'Ola' });
    await seedGuardian(ctx.db, { id: 'g-9b', householdId: 'h-9', sharedStudentId: 's-9', firstName: 'Bartek' });
    await approvedTemplate(ctx);
    const a = await submitRequest(ctx, 'g-9a', { email: 'ola9@example.invalid' });
    const b = await submitRequest(ctx, 'g-9b', { email: 'bartek9@example.invalid' });
    const transport = fakeTransport();
    await runWorker(ctx.env, transport);
    assert.deepEqual(transport.sent.map((message) => message.to).sort(), ['bartek9@example.invalid', 'ola9@example.invalid'],
      'osobne wiadomości, każda na adres z własnego wniosku');
    const codeA = codeFrom(transport.sent.find((message) => message.to === 'ola9@example.invalid'));
    const codeB = codeFrom(transport.sent.find((message) => message.to === 'bartek9@example.invalid'));
    if (codeA !== codeB) {
      assert.deepEqual(await call(ctx.env, '/api/public/guardian-update/verify', { body: { token: b.token, code: codeA } }),
        { status: 400, data: { error: 'invalid_or_expired_code' } });
    }
    assert.notEqual((await queueEntry(ctx, b.requestId)).verification, 'confirmed', 'kod A nie potwierdza B');
    assert.equal((await call(ctx.env, '/api/public/guardian-update/verify', { body: { token: a.token, code: codeA } })).status, 200);
    assert.equal((await queueEntry(ctx, a.requestId)).verification, 'confirmed');
    assert.equal((await queueEntry(ctx, b.requestId)).verification, 'sent');
    await ctx.db.close();
  });

  test('zatwierdzenie bez potwierdzenia działa i zapisuje ostrzeżenie w audycie; niewysłany kod zostaje anulowany', async () => {
    const ctx = await setup();
    await seedGuardian(ctx.db, { id: 'g-10', householdId: 'h-10', studentId: 's-10' });
    await seedGuardian(ctx.db, { id: 'g-11', householdId: 'h-11', studentId: 's-11' });
    await approvedTemplate(ctx);
    const unverified = await submitRequest(ctx, 'g-10', { email: 'nowy10@example.invalid' });
    const approved = await call(ctx.env, `/api/admin/guardian-update-requests/${unverified.requestId}/approve`, { cookie: ctx.cookies.approver, body: {} });
    assert.equal(approved.status, 200);
    assert.equal(approved.data.status, 'approved');
    assert.equal(approved.data.verification, 'sent');
    assert.equal((await ctx.db.query('SELECT email FROM guardians WHERE id = $1', ['g-10'])).rows[0].email, 'nowy10@example.invalid');
    const { rows: [event] } = await ctx.db.query(
      "SELECT metadata_json FROM audit_events WHERE action = 'guardian_update_request.approved' AND entity_id = $1", [unverified.requestId],
    );
    assert.equal(event.metadata_json.unverifiedContactChange, true);
    assert.equal(event.metadata_json.verification, 'sent');
    assert.equal(JSON.stringify(event.metadata_json).includes('@'), false, 'audyt bez adresu');
    assert.deepEqual(
      (({ state, last_error: reason }) => ({ state, reason }))(await verificationRow(ctx.db, unverified.requestId)),
      { state: 'cancelled', reason: 'request_decided' },
    );
    const transport = fakeTransport();
    await runWorker(ctx.env, transport);

    // Drugi wniosek: kod wysłany i potwierdzony przed zatwierdzeniem — bez ostrzeżenia.
    const verified = await submitRequest(ctx, 'g-11', { email: 'nowy11@example.invalid' });
    await runWorker(ctx.env, transport);
    assert.deepEqual(transport.sent.map((message) => message.to), ['nowy11@example.invalid'], 'anulowany kod nie wyszedł');
    const code = codeFrom(transport.sent[0]);
    assert.equal((await call(ctx.env, '/api/public/guardian-update/verify', { body: { token: verified.token, code } })).status, 200);
    await call(ctx.env, `/api/admin/guardian-update-requests/${verified.requestId}/approve`, { cookie: ctx.cookies.approver, body: {} });
    const { rows: [confirmedEvent] } = await ctx.db.query(
      "SELECT metadata_json FROM audit_events WHERE action = 'guardian_update_request.approved' AND entity_id = $1", [verified.requestId],
    );
    assert.equal(confirmedEvent.metadata_json.verification, 'confirmed');
    assert.equal(Object.hasOwn(confirmedEvent.metadata_json, 'unverifiedContactChange'), false);
    // Po decyzji kod nie przyjmuje już potwierdzenia (ten sam ogólny błąd).
    assert.equal((await call(ctx.env, '/api/public/guardian-update/verify', { body: { token: unverified.token, code: '12345678' } })).status, 400);
    await ctx.db.close();
  });

  test('przedstawiciel klasy: 403 na kolejce wniosków i szablonach; zarząd z przydziałem klasy — 403', async () => {
    const ctx = await setup();
    const boardA = await seedUserSession(ctx.db, { userId: 'u-board-a', roles: [{ role: 'board', classId: 'c-1a', schoolYearId: Y }], mfa: true });
    for (const cookie of [ctx.cookies.rep, boardA]) {
      assert.equal((await call(ctx.env, '/api/admin/guardian-update-requests', { cookie })).status, 403);
      assert.equal((await call(ctx.env, '/api/admin/guardian-verify-templates', { cookie })).status, 403);
      assert.equal((await call(ctx.env, '/api/admin/guardian-verify-templates', { cookie, body: TEMPLATE })).status, 403);
    }
    const { rows } = await ctx.db.query('SELECT count(*)::int AS n FROM guardian_verify_templates');
    assert.equal(rows[0].n, 0);
    await ctx.db.close();
  });

  test('kod wpisany, zanim worker zapisze wynik: wysyłka kończy się „sent”, a wynik niepewny nie unieważnia potwierdzenia', async () => {
    const ctx = await setup();
    await seedGuardian(ctx.db, { id: 'g-14', householdId: 'h-14', studentId: 's-14' });
    await seedGuardian(ctx.db, { id: 'g-15', householdId: 'h-15', studentId: 's-15' });
    await approvedTemplate(ctx);
    const quick = await submitRequest(ctx, 'g-14', { email: 'nowy14@example.invalid' });
    // Atrapa „rodzica”: kod dociera i jest wpisany w trakcie wywołania dostawcy.
    const transport = {
      sent: [],
      async send(message) {
        this.sent.push(message);
        const confirmed = await call(ctx.env, '/api/public/guardian-update/verify', { body: { token: quick.token, code: codeFrom(message) } });
        assert.equal(confirmed.status, 200);
        return { messageId: 'fx-verify-quick' };
      },
    };
    await runWorker(ctx.env, transport);
    const row = await verificationRow(ctx.db, quick.requestId);
    assert.equal(row.state, 'sent');
    assert.ok(row.confirmed_at, 'potwierdzenie zostaje');
    assert.equal((await queueEntry(ctx, quick.requestId)).verification, 'confirmed');

    const uncertain = await submitRequest(ctx, 'g-15', { email: 'nowy15@example.invalid' });
    const flaky = {
      async send(message) {
        await call(ctx.env, '/api/public/guardian-update/verify', { body: { token: uncertain.token, code: codeFrom(message) } });
        throw new EmailTransportError('delivery_unknown', { uncertain: true });
      },
    };
    await runWorker(ctx.env, flaky);
    assert.equal((await queueEntry(ctx, uncertain.requestId)).verification, 'confirmed', 'wynik niepewny nie nadpisuje potwierdzenia');
    await ctx.db.close();
  });

  test('błąd dostawcy: 429 wraca do kolejki bez zużycia próby, potem jedna wiadomość; wynik niepewny → failed bez ponowienia', async () => {
    const ctx = await setup();
    await seedGuardian(ctx.db, { id: 'g-12', householdId: 'h-12', studentId: 's-12' });
    await seedGuardian(ctx.db, { id: 'g-13', householdId: 'h-13', studentId: 's-13' });
    await approvedTemplate(ctx);
    const limited = await submitRequest(ctx, 'g-12', { email: 'nowy12@example.invalid' });
    const now = new Date();
    const rateLimited = fakeTransport({ fail: [new EmailTransportError('provider_rate_limited', { retryable: true, retryAfterSeconds: 60 })] });
    const run = await runWorker(ctx.env, rateLimited, { now });
    assert.equal(run.stoppedReason, 'provider_rate_limited');
    const afterLimit = await verificationRow(ctx.db, limited.requestId);
    assert.deepEqual([afterLimit.state, afterLimit.attempts, afterLimit.send_started_at], ['queued', 0, null]);
    await runWorker(ctx.env, rateLimited, { now: new Date(now.getTime() + 120_000) });
    assert.equal(rateLimited.sent.length, 1);

    const unknown = await submitRequest(ctx, 'g-13', { email: 'nowy13@example.invalid' });
    const uncertain = fakeTransport({ fail: [new EmailTransportError('delivery_unknown', { uncertain: true })] });
    await runWorker(ctx.env, uncertain, { now: new Date(now.getTime() + 180_000) });
    await runWorker(ctx.env, uncertain, { now: new Date(now.getTime() + 240_000) });
    assert.equal(uncertain.calls, 1, 'wynik niepewny nie jest ponawiany');
    const entry = await queueEntry(ctx, unknown.requestId);
    assert.deepEqual([entry.verification, entry.verificationReason], ['failed', 'delivery_unknown']);
    await ctx.db.close();
  });
});
