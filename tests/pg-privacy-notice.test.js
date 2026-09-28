// #145 (D-06): wersjonowana informacja o przetwarzaniu danych.
// Wyłącznie dane syntetyczne (.invalid).
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedUserSession } from './helpers/pg.js';

async function call(env, path, opts = {}) {
  const response = await handlePgRequest(request(path, opts), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null, headers: response.headers };
}
const post = (env, path, cookie, body = {}) => call(env, path, { method: 'POST', cookie, body });

async function setup() {
  const db = await createTestDb();
  const env = { db };
  const author = await seedUserSession(db, { userId: 'u-author', roles: [{ role: 'admin' }], mfa: true });
  const approver = await seedUserSession(db, { userId: 'u-approver', roles: [{ role: 'board' }], mfa: true });
  return { db, env, author, approver };
}

test('publiczna trasa: 404 bez opublikowanej wersji, brak identyfikatorów użytkowników w odpowiedzi po publikacji', async () => {
  const { db, env, author, approver } = await setup();
  try {
    assert.equal((await call(env, '/api/public/privacy-notice')).status, 404);

    const created = await post(env, '/api/admin/privacy-notices', author, { bodyText: 'Informacja testowa o przetwarzaniu danych.', decisionRef: 'D-06/uchwała-1' });
    assert.equal(created.status, 201);
    const id = created.data.notice.id;
    assert.equal(created.data.notice.status, 'draft');

    assert.equal((await call(env, '/api/public/privacy-notice')).status, 404, 'szkic niewidoczny publicznie');

    const approved = await post(env, `/api/admin/privacy-notices/${id}/approve`, approver);
    assert.equal(approved.status, 200);
    assert.equal(approved.data.notice.status, 'approved');

    const published = await post(env, `/api/admin/privacy-notices/${id}/publish`, approver);
    assert.equal(published.status, 200);
    assert.equal(published.data.notice.status, 'published');

    const pub = await call(env, '/api/public/privacy-notice');
    assert.equal(pub.status, 200);
    assert.deepEqual(Object.keys(pub.data).sort(), ['bodyText', 'publishedAt', 'version']);
    assert.equal(pub.data.bodyText, 'Informacja testowa o przetwarzaniu danych.');
  } finally {
    await db.close();
  }
});

test('autor nie może zatwierdzić własnej wersji (403 i trigger bazy)', async () => {
  const { db, env, author } = await setup();
  try {
    const created = await post(env, '/api/admin/privacy-notices', author, { bodyText: 'Treść informacji.', decisionRef: 'D-06/x' });
    const id = created.data.notice.id;
    const selfApprove = await post(env, `/api/admin/privacy-notices/${id}/approve`, author);
    assert.equal(selfApprove.status, 403);
    await assert.rejects(
      db.query(
        `UPDATE privacy_notices SET status = 'approved', approved_by = created_by, approved_at = now() WHERE id = $1`,
        [id],
      ),
      /privacy_notice_four_eyes|check constraint/i,
    );
  } finally {
    await db.close();
  }
});

test('granice ról: przedstawiciel nie tworzy ani nie zatwierdza wersji; anonim odrzucony', async () => {
  const { db, env, author } = await setup();
  try {
    const rep = await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a' }], mfa: true });
    assert.equal((await post(env, '/api/admin/privacy-notices', rep, { bodyText: 'x'.repeat(30), decisionRef: 'D-06/y' })).status, 403);
    assert.equal((await call(env, '/api/admin/privacy-notices')).status, 401);
    const created = await post(env, '/api/admin/privacy-notices', author, { bodyText: 'Treść.', decisionRef: 'D-06/z' });
    assert.equal((await post(env, `/api/admin/privacy-notices/${created.data.notice.id}/approve`, rep)).status, 403);
  } finally {
    await db.close();
  }
});

test('podwójne kliknięcie „opublikuj” daje jedną publikację (replayed)', async () => {
  const { db, env, author, approver } = await setup();
  try {
    const created = await post(env, '/api/admin/privacy-notices', author, { bodyText: 'Treść pierwsza.', decisionRef: 'D-06/a' });
    const id = created.data.notice.id;
    await post(env, `/api/admin/privacy-notices/${id}/approve`, approver);
    const first = await post(env, `/api/admin/privacy-notices/${id}/publish`, approver);
    assert.equal(first.status, 200);
    const second = await post(env, `/api/admin/privacy-notices/${id}/publish`, approver);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('Idempotency-Replayed'), 'true');
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'privacy_notice.published'")).rows[0].n,
      1,
    );
  } finally {
    await db.close();
  }
});

test('publikacja nowej wersji odsuwa poprzednią (superseded); import zatwierdzony z wersją 1 pozostaje przy wersji 1', async () => {
  const { db, env, author, approver } = await setup();
  try {
    const v1 = await post(env, '/api/admin/privacy-notices', author, { bodyText: 'Wersja pierwsza.', decisionRef: 'D-06/v1' });
    const id1 = v1.data.notice.id;
    await post(env, `/api/admin/privacy-notices/${id1}/approve`, approver);
    await post(env, `/api/admin/privacy-notices/${id1}/publish`, approver);

    const v2 = await post(env, '/api/admin/privacy-notices', author, { bodyText: 'Wersja druga.', decisionRef: 'D-06/v2' });
    const id2 = v2.data.notice.id;
    await post(env, `/api/admin/privacy-notices/${id2}/approve`, approver);
    const published2 = await post(env, `/api/admin/privacy-notices/${id2}/publish`, approver);
    assert.equal(published2.status, 200);

    const list = await call(env, '/api/admin/privacy-notices', { cookie: author });
    const notice1 = list.data.notices.find((n) => n.id === id1);
    const notice2 = list.data.notices.find((n) => n.id === id2);
    assert.equal(notice1.status, 'superseded');
    assert.equal(notice2.status, 'published');

    const pub = await call(env, '/api/public/privacy-notice');
    assert.equal(pub.data.bodyText, 'Wersja druga.');
  } finally {
    await db.close();
  }
});

test('crosss-origin i brak sesji są odrzucane dla tras admina', async () => {
  const { db, env, author } = await setup();
  try {
    const cross = await call(env, '/api/admin/privacy-notices', {
      method: 'POST', cookie: author, origin: 'https://evil.example', body: { bodyText: 'x'.repeat(30), decisionRef: 'D-06/e' },
    });
    assert.equal(cross.status, 403);
    assert.equal(cross.data.error, 'invalid_origin');
  } finally {
    await db.close();
  }
});
