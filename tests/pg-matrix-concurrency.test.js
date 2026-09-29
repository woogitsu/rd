// #211: pola macierzy scenariuszy z AGENTS.md dla zamknięcia roku i aktualności:
// zamknięcie roku równolegle z zapisem w księdze oraz równoległe zatwierdzenie
// i wycofanie wpisu aktualności. Dane wyłącznie syntetyczne.
// PGlite wykonuje transakcje po kolei, więc każdy scenariusz ma dwie wersje:
// deterministyczne obie kolejności (dowód kontroli) oraz Promise.all
// (niezmiennik wyniku niezależny od tego, kto wygra — realny wyścig: #208).
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { CHECKLIST_ITEMS } from '../src/pg/routes/year-close.js';
import { approve, createDraft, listPublic, publish, submit, withdraw } from '../src/pg/news.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';

const OLD = 'y-2026';
const NEW = 'y-2027';
const BASE_CLOSING_CENTS = 100000;

async function closeSetup() {
  const db = await createTestDb();
  await db.query(`INSERT INTO school_years (id, label, starts_on, ends_on) VALUES
    ($1, '2026/27 test', '2026-09-01', '2027-08-31'), ($2, '2027/28 test', '2027-09-01', '2028-08-31')`, [OLD, NEW]);
  const cookies = {
    board: await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board' }], mfa: true }),
    closer: await seedUserSession(db, { userId: 'u-board-closer', roles: [{ role: 'board' }], mfa: true }),
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: OLD }], mfa: true }),
    admin: await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true }),
  };
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES
    ('cat-in', $1, 'income', 'Składki dobrowolne', 'u-treasurer')`, [OLD]);
  await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on, method, created_by, idempotency_key)
    VALUES ('le-base', $1, 'income', $2, 'cat-in', 'Wpływy syntetyczne', '2026-10-01', 'bank', 'u-treasurer', 'le-base-key-1')`, [OLD, BASE_CLOSING_CENTS]);
  const env = { db };
  const post = (path, cookie, body = {}, key) => handlePgRequest(request(path, {
    method: 'POST', cookie, body, ...(key ? { headers: { 'Idempotency-Key': key } } : {}),
  }), env);
  const start = await post(`/api/year-close/${OLD}/start`, cookies.board, { nextSchoolYearId: NEW });
  assert.equal(start.status, 201);
  for (const [index, item] of CHECKLIST_ITEMS.entries()) {
    const response = await post(`/api/year-close/${OLD}/checklist/${item}`, index % 2 ? cookies.treasurer : cookies.board, { note: `Potwierdzenie ${item}` });
    assert.equal(response.status, 201, item);
  }
  const ledgerPost = (key, amountCents) => post('/api/ledger', cookies.admin, {
    schoolYearId: OLD, direction: 'income', amountCents, categoryId: 'cat-in',
    description: 'Wpływ syntetyczny', occurredOn: '2027-08-30', method: 'bank',
  }, key);
  const close = () => post(`/api/year-close/${OLD}/close`, cookies.closer);
  return { db, ledgerPost, close };
}

async function closingBalance(db) {
  const { rows } = await db.query('SELECT closing_balance_cents, status FROM school_year_closures WHERE school_year_id = $1', [OLD]);
  return rows[0];
}

test('#211 zamknięcie roku po zapisie w księdze: wpis jest w bilansie; zapis po zamknięciu daje 409 school_year_closed', async () => {
  const { db, ledgerPost, close } = await closeSetup();
  try {
    const before = await ledgerPost('ledger-before-0001', 2500);
    assert.equal(before.status, 201);
    assert.equal((await close()).status, 200);
    const state = await closingBalance(db);
    assert.equal(state.status, 'closed');
    assert.equal(Number(state.closing_balance_cents), BASE_CLOSING_CENTS + 2500, 'wpis sprzed zamknięcia jest w bilansie');

    const after = await ledgerPost('ledger-after-0001', 700);
    assert.equal(after.status, 409);
    assert.equal((await after.json()).error, 'school_year_closed');
    const { rows } = await db.query("SELECT count(*)::int AS n FROM ledger_entries WHERE idempotency_key = 'ledger-after-0001'");
    assert.equal(rows[0].n, 0, 'brak wpisu po bilansie');
    assert.equal(Number((await closingBalance(db)).closing_balance_cents), BASE_CLOSING_CENTS + 2500);
  } finally { await db.close(); }
});

test('#211 zamknięcie roku równolegle z zapisem w księdze: wpis albo w bilansie, albo 409 — nigdy po bilansie', async () => {
  const { db, ledgerPost, close } = await closeSetup();
  try {
    const [closed, written] = await Promise.all([close(), ledgerPost('ledger-race-0001', 900)]);
    assert.equal(closed.status, 200);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM ledger_entries WHERE idempotency_key = 'ledger-race-0001'");
    const balance = Number((await closingBalance(db)).closing_balance_cents);
    if (written.status === 201) {
      assert.equal(rows[0].n, 1);
      assert.equal(balance, BASE_CLOSING_CENTS + 900, 'zapis przyjęty przed zamknięciem musi być w bilansie');
    } else {
      assert.equal(written.status, 409);
      assert.equal((await written.json()).error, 'school_year_closed');
      assert.equal(rows[0].n, 0);
      assert.equal(balance, BASE_CLOSING_CENTS);
    }
    // Niezmiennik: bilans zamknięcia = suma księgi roku po zamknięciu.
    const { rows: [sum] } = await db.query("SELECT COALESCE(sum(amount_cents),0)::int AS total FROM ledger_entries WHERE school_year_id = $1 AND direction = 'income'", [OLD]);
    assert.equal(balance, sum.total);
  } finally { await db.close(); }
});

// ---------- aktualności ----------

const board1 = { userId: 'board1', grants: [{ role: 'board', classId: null, schoolYearId: null }], mfaVerified: true };
const board2 = { userId: 'board2', grants: [{ role: 'board', classId: null, schoolYearId: null }], mfaVerified: true };
let counter = 0;

async function newsSetup() {
  const db = await createTestDb();
  for (const userId of ['board1', 'board2']) await seedUser(db, { userId });
  await seedSchoolYear(db, 'y-news');
  const submitted = async () => {
    const { post } = await createDraft(db, board1, {
      schoolYearId: 'y-news', title: 'Kiermasz (syntetyczny)', body: 'Treść syntetyczna.', idempotencyKey: `news-matrix-${String(++counter).padStart(6, '0')}`,
    });
    await submit(db, board1, { postId: post.id, revision: 1 });
    return post;
  };
  const isPublic = async () => (await listPublic(db, { schoolYearId: 'y-news' })).posts.length;
  const status = async (id) => (await db.query('SELECT status FROM news_posts WHERE id = $1', [id])).rows[0].status;
  const events = async (id) => (await db.query('SELECT action FROM audit_events WHERE entity_id = $1', [id])).rows.map((r) => r.action);
  return { db, submitted, isPublic, status, events };
}

test('#211 aktualności: wycofanie przed zatwierdzeniem blokuje zatwierdzenie i publikację; po zatwierdzeniu wycofanie wygrywa', async () => {
  const { db, submitted, isPublic, status, events } = await newsSetup();
  try {
    const first = await submitted();
    await withdraw(db, board1, { postId: first.id, revision: 1, reason: 'Błąd w treści' });
    await assert.rejects(approve(db, board2, { postId: first.id, revision: 1 }), (error) => error.status === 409);
    await assert.rejects(publish(db, board2, { postId: first.id, revision: 1 }), (error) => error.status === 409);
    assert.equal(await status(first.id), 'withdrawn');
    assert.equal(await isPublic(), 0);
    assert.equal((await events(first.id)).includes('news_post.approved'), false, 'brak zdarzenia zatwierdzenia po wycofaniu');

    const second = await submitted();
    await approve(db, board2, { postId: second.id, revision: 1 });
    await withdraw(db, board1, { postId: second.id, revision: 1, reason: 'Błąd w treści' });
    await assert.rejects(publish(db, board2, { postId: second.id, revision: 1 }), (error) => error.status === 409);
    assert.equal(await status(second.id), 'withdrawn');
    assert.equal(await isPublic(), 0);
  } finally { await db.close(); }
});

test('#211 aktualności: równoległe zatwierdzenie/publikacja i wycofanie — wpis kończy wycofany i niewidoczny publicznie', async () => {
  const { db, submitted, isPublic, status, events } = await newsSetup();
  try {
    const post = await submitted();
    const results = await Promise.allSettled([
      approve(db, board2, { postId: post.id, revision: 1 }),
      withdraw(db, board1, { postId: post.id, revision: 1, reason: 'Błąd w treści' }),
    ]);
    assert.equal(results[1].status, 'fulfilled', 'wycofanie zawsze się udaje');
    assert.equal(await status(post.id), 'withdrawn');
    assert.equal(await isPublic(), 0);
    const actions = await events(post.id);
    assert.equal(actions.filter((a) => a === 'news_post.withdrawn').length, 1);
    assert.equal(actions.includes('news_post.published'), false);

    const approved = await submitted();
    await approve(db, board2, { postId: approved.id, revision: 1 });
    const raced = await Promise.allSettled([
      publish(db, board2, { postId: approved.id, revision: 1 }),
      withdraw(db, board1, { postId: approved.id, revision: 1, reason: 'Błąd w treści' }),
    ]);
    assert.equal(raced[1].status, 'fulfilled');
    assert.equal(await status(approved.id), 'withdrawn');
    assert.equal(await isPublic(), 0, 'wycofany wpis nie może zostać opublikowany');
  } finally { await db.close(); }
});
