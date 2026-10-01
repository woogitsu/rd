// #145 (D-06): bramka `privacy_notice_missing` przy zatwierdzeniu kampanii e-mail
// i wydruku kartek, migawka wersji informacji (email_campaigns.privacy_notice_id,
// 0179) i odnośnik w stopce. Treść informacji jest syntetyczna; żaden test nie
// łączy się z siecią (atrapa transportu), adresy wyłącznie @example.invalid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { runEmailBatch } from '../src/email/worker.js';
import { renderMessage } from '../src/email/content.js';
import { renderCardsHtml } from '../print/core.js';
import { createTestDb, networkGuardCalls, request, seedClass, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const YEAR = 'y2026';
const DAY1 = new Date('2026-10-05T08:00:00Z');
const BASE = 'https://rada.example.invalid';
const PREVIEW_ADDRESS = 'skarbnik-test@rada.example.invalid';
const BODY = 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.';

function fakeTransport() {
  const calls = [];
  return { calls, name: 'fake', async send(message) { calls.push(message); return { messageId: `fake-${calls.length}-${message.outboxId}` }; } };
}

// Baza BEZ opublikowanej informacji — to stan wyjściowy bramki.
async function setup() {
  const db = await createTestDb();
  await seedSchoolYear(db, YEAR);
  await seedClass(db, { id: 'c1', schoolYearId: YEAR });
  const sessions = {
    treasurer: await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] }),
    board: await seedUserSession(db, { userId: 'u-bd', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] }),
    rep: await seedUserSession(db, { userId: 'u-rep', mfa: true, roles: [{ role: 'representative', classId: 'c1', schoolYearId: YEAR }] }),
    noticeAuthor: await seedUserSession(db, { userId: 'u-na', mfa: true, roles: [{ role: 'admin' }] }),
    noticeApprover: await seedUserSession(db, { userId: 'u-nb', mfa: true, roles: [{ role: 'board' }] }),
  };
  const env = {
    db, APP_ENV: 'development', EMAIL_SENDING_ENABLED: 'true', EMAIL_TEST_ALLOWLIST: '*@example.invalid',
    EMAIL_PREVIEW_RECIPIENTS: PREVIEW_ADDRESS, BREVO_FROM_EMAIL: 'rada@example.invalid',
    BREVO_WEBHOOK_SECRET: 'w'.repeat(48), PUBLIC_BASE_URL: BASE, EMAIL_UNSUBSCRIBE_SECRET: 's'.repeat(32),
  };
  const call = async (cookie, path, options = {}) => {
    const response = await handlePgRequest(request(path, { cookie, ...options }), env);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const publishNotice = async (bodyText) => {
    const created = await call(sessions.noticeAuthor, '/api/admin/privacy-notices', {
      method: 'POST', body: { bodyText, decisionRef: 'D-06/test' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.notice.id;
    assert.equal((await call(sessions.noticeApprover, `/api/admin/privacy-notices/${id}/approve`, { method: 'POST' })).status, 200);
    const published = await call(sessions.noticeApprover, `/api/admin/privacy-notices/${id}/publish`, { method: 'POST' });
    assert.equal(published.status, 200, JSON.stringify(published.body));
    return published.body.notice;
  };
  return { db, env, sessions, call, publishNotice };
}

async function family(db, householdId) {
  await db.query('INSERT INTO households (id) VALUES ($1) ON CONFLICT DO NOTHING', [householdId]);
  await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, $2, 'Uczeń', 'Testowy')", [`${householdId}-s`, householdId]);
  await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)', [`e-${householdId}`, `${householdId}-s`, 'c1', YEAR]);
  await db.query(
    `INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
     VALUES ($1, $2, 'Opiekun', 'Testowy', $3, true)`,
    [`${householdId}-g`, householdId, `${householdId}-g@example.invalid`],
  );
  await db.query('INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ($1, $2, true, true)', [`${householdId}-s`, `${householdId}-g`]);
}

async function draftAndSnapshot(t, title = 'Przypomnienie') {
  const created = await t.call(t.sessions.treasurer, '/api/email/campaigns', {
    method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: { schoolYearId: YEAR, title, audience: 'all_households', subject: 'Dobrowolna składka {rok}', bodyText: BODY },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.campaign.id;
  assert.equal((await t.call(t.sessions.treasurer, `/api/email/campaigns/${id}/snapshot`, { method: 'POST' })).status, 200);
  return id;
}

async function approve(t, id) {
  const preview = await t.call(t.sessions.board, `/api/email/campaigns/${id}/preview`);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const approved = await t.call(t.sessions.board, `/api/email/campaigns/${id}/approve`, {
    method: 'POST', body: { contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash },
  });
  return { preview: preview.body, approved };
}

test('zatwierdzenie kampanii bez opublikowanej informacji: 409 privacy_notice_missing, ostrzeżenie w podglądzie, test 409; po publikacji wersja zapamiętana', async () => {
  const t = await setup();
  const networkBefore = networkGuardCalls();
  try {
    await family(t.db, 'h-a');
    const id = await draftAndSnapshot(t);
    const refused = await approve(t, id);
    assert.equal(refused.approved.status, 409);
    assert.equal(refused.approved.body.error, 'privacy_notice_missing');
    assert.ok(refused.preview.warnings.includes('privacy_notice_missing'));
    assert.equal(refused.preview.privacyNotice, null);
    const testSend = await t.call(t.sessions.treasurer, `/api/email/campaigns/${id}/test-send`, {
      method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: { recipientEmail: PREVIEW_ADDRESS },
    });
    assert.equal(testSend.status, 409);
    assert.equal(testSend.body.error, 'privacy_notice_missing');
    const { rows } = await t.db.query('SELECT status, privacy_notice_id FROM email_campaigns WHERE id = $1', [id]);
    assert.deepEqual(rows[0], { status: 'draft', privacy_notice_id: null });

    const v1 = await t.publishNotice('Syntetyczna informacja, wersja pierwsza.');
    const { preview, approved } = await approve(t, id);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.campaign.privacyNoticeId, v1.id);
    assert.ok(!preview.warnings.includes('privacy_notice_missing'));
    assert.ok(preview.sample.text.includes(`Informacja o przetwarzaniu danych osobowych (wersja ${v1.version}): ${BASE}/api/public/privacy-notice`), preview.sample.text);
    assert.doesNotMatch(preview.sample.text, /Syntetyczna informacja/, 'stopka wskazuje wersję, nie kopiuje treści');
    const { rows: events } = await t.db.query("SELECT metadata_json FROM audit_events WHERE action = 'email.campaign.approved' AND entity_id = $1", [id]);
    assert.equal(events.length, 1);
    assert.match(JSON.stringify(events[0].metadata_json), new RegExp(v1.id));
    assert.doesNotMatch(JSON.stringify(events[0].metadata_json), /Syntetyczna informacja/);
    assert.equal(networkGuardCalls(), networkBefore);
  } finally {
    await t.db.close();
  }
});

test('granice ról: przedstawiciel i skarbnik nie zatwierdzają kampanii; kolumna bez zmian', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h-a');
    await t.publishNotice('Syntetyczna informacja.');
    const id = await draftAndSnapshot(t);
    const preview = await t.call(t.sessions.board, `/api/email/campaigns/${id}/preview`);
    for (const cookie of [t.sessions.rep, t.sessions.treasurer]) {
      const res = await t.call(cookie, `/api/email/campaigns/${id}/approve`, {
        method: 'POST', body: { contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash },
      });
      assert.equal(res.status, 403);
    }
    const { rows } = await t.db.query('SELECT privacy_notice_id FROM email_campaigns WHERE id = $1', [id]);
    assert.equal(rows[0].privacy_notice_id, null);
  } finally {
    await t.db.close();
  }
});

test('migawka: kampania zatwierdzona z wersją 1 zostaje przy niej po publikacji wersji 2 (podgląd, worker); nowa kampania dostaje wersję 2; podwójne kliknięcie = jedno zatwierdzenie', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h-a');
    const v1 = await t.publishNotice('Syntetyczna informacja, wersja pierwsza.');
    const id = await draftAndSnapshot(t);
    const preview = await t.call(t.sessions.board, `/api/email/campaigns/${id}/preview`);
    const body = { contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash };
    const [a, b] = await Promise.all([
      t.call(t.sessions.board, `/api/email/campaigns/${id}/approve`, { method: 'POST', body }),
      t.call(t.sessions.board, `/api/email/campaigns/${id}/approve`, { method: 'POST', body }),
    ]);
    assert.deepEqual([a.status, b.status], [200, 200], JSON.stringify([a.body, b.body]));
    assert.equal((await t.db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'email.campaign.approved' AND entity_id = $1", [id])).rows[0].n, 1);

    const v2 = await t.publishNotice('Syntetyczna informacja, wersja druga.');
    assert.equal(v2.version, v1.version + 1);

    const after = await t.call(t.sessions.board, `/api/email/campaigns/${id}/preview`);
    assert.equal(after.body.privacyNotice.id, v1.id);
    assert.ok(after.body.sample.text.includes(`(wersja ${v1.version})`));
    assert.ok(!after.body.sample.text.includes(`(wersja ${v2.version})`));

    const queued = await t.call(t.sessions.treasurer, `/api/email/campaigns/${id}/queue`, { method: 'POST' });
    assert.equal(queued.status, 200, JSON.stringify(queued.body));
    const transport = fakeTransport();
    await runEmailBatch(t.env, { transport, dryRun: false, now: DAY1 });
    assert.equal(transport.calls.length, 1);
    assert.ok(transport.calls[0].text.includes(`(wersja ${v1.version}): ${BASE}/api/public/privacy-notice`), transport.calls[0].text);
    assert.ok(!transport.calls[0].text.includes(`(wersja ${v2.version})`));

    // Nowa kampania wymaga i zapamiętuje wersję 2.
    const id2 = await draftAndSnapshot(t, 'Druga kampania');
    const { approved } = await approve(t, id2);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.campaign.privacyNoticeId, v2.id);
  } finally {
    await t.db.close();
  }
});

test('strażnik bazy: wersję ustawia tylko zatwierdzenie, w innym stanie jest niezmienna, szkic jej nie nosi', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h-a');
    const v1 = await t.publishNotice('Syntetyczna informacja.');
    const id = await draftAndSnapshot(t);
    const id2 = await draftAndSnapshot(t, 'Szkic');
    assert.equal((await approve(t, id)).approved.status, 200);

    await assert.rejects(t.db.query('UPDATE email_campaigns SET privacy_notice_id = NULL WHERE id = $1', [id]), /email_campaign_privacy_notice_immutable/);
    await assert.rejects(t.db.query('UPDATE email_campaigns SET privacy_notice_id = $2 WHERE id = $1', [id2, v1.id]), /email_campaign_privacy_notice_immutable|email_campaigns_draft_without_privacy_notice/);
    const { rows } = await t.db.query('SELECT privacy_notice_id FROM email_campaigns WHERE id = $1', [id]);
    assert.equal(rows[0].privacy_notice_id, v1.id);
  } finally {
    await t.db.close();
  }
});

test('kartki: bez opublikowanej informacji 409 privacy_notice_missing (po autoryzacji); z informacją odpowiedź niesie wersję i odnośnik, kartka go drukuje', async () => {
  const t = await setup();
  try {
    await family(t.db, 'H-1');
    const get = (cookie, query = `schoolYearId=${YEAR}`) => t.call(cookie, `/api/print/cards?${query}`);
    assert.equal((await get(undefined)).status, 401);
    assert.equal((await get(t.sessions.rep)).status, 400, 'class_required przed bramką informacji');
    for (const cookie of [t.sessions.board, t.sessions.treasurer]) {
      const refused = await get(cookie);
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error, 'privacy_notice_missing');
    }
    assert.equal((await get(t.sessions.rep, `schoolYearId=${YEAR}&classId=c1`)).status, 409);
    assert.equal((await t.db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'print.cards_requested'")).rows[0].n, 0);

    const v1 = await t.publishNotice('Syntetyczna informacja.');
    const ok = await get(t.sessions.board);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.privacyNotice, { id: v1.id, version: v1.version, url: `${BASE}/api/public/privacy-notice` });
    const config = { councilName: 'Rada Rodziców', schoolYear: '2026/2027', contact: 'kontakt w sekretariacie' };
    const households = [{ householdId: 'H-1', students: [{ name: 'Uczeń Testowy', className: '1A' }] }];
    const html = renderCardsHtml(households, new Set(['H-1']), config, null, ok.body.privacyNotice).html;
    assert.ok(html.includes(`Informacja o przetwarzaniu danych osobowych (wersja ${v1.version}): ${BASE}/api/public/privacy-notice.`), html);
    assert.doesNotMatch(renderCardsHtml(households, new Set(['H-1']), config).html, /Informacja o przetwarzaniu danych osobowych/);
    const { rows } = await t.db.query("SELECT metadata_json FROM audit_events WHERE action = 'print.cards_requested'");
    assert.match(JSON.stringify(rows[0].metadata_json), new RegExp(v1.id));
  } finally {
    await t.db.close();
  }
});

test('renderMessage: stopka z informacją stoi przed linkiem wypisania; bez informacji stopki nie ma', () => {
  const campaign = { subject: 'Temat {rok}', body_text: 'Treść {rok}.' };
  const withNotice = renderMessage(campaign, {
    schoolYearLabel: '2026/2027', householdId: 'H', unsubscribeUrl: 'https://x.example.invalid/u',
    privacyNotice: { version: 3, url: 'https://x.example.invalid/n' },
  });
  assert.ok(withNotice.text.indexOf('(wersja 3): https://x.example.invalid/n') < withNotice.text.indexOf('https://x.example.invalid/u'));
  const noUrl = renderMessage(campaign, { schoolYearLabel: '2026/2027', householdId: 'H', privacyNotice: { version: 3, url: null } });
  assert.match(noUrl.text, /\(wersja 3\)$/);
  assert.doesNotMatch(renderMessage(campaign, { schoolYearLabel: '2026/2027', householdId: 'H' }).text, /Informacja o przetwarzaniu/);
});
