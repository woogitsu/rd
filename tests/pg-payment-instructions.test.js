// API zatwierdzonych danych do wpłaty (IBAN/BIC/odbiorca) na PostgreSQL (#92).
// Wyłącznie dane syntetyczne; IBAN jest przykładem podręcznikowym (Wikipedia/ISO 13616), nie prawdziwym rachunkiem.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedSchoolYear, seedUserSession, assertOwnerGuard } from './helpers/pg.js';

const IBAN = 'BE68539007547034';

async function backend({ role = 'board', mfa = true, schoolYearId = 'y2026' } = {}) {
  const db = await createTestDb();
  await seedSchoolYear(db, 'y2025', { startsOn: '2025-09-01', endsOn: '2026-08-31' });
  await seedSchoolYear(db, 'y2026');
  const cookie = await seedUserSession(db, { userId: 'u1', mfa, roles: [{ role, schoolYearId }] });
  const env = { db };
  return {
    db, env, cookie,
    fetch: (req) => handlePgRequest(req, env),
    as: (userId, options) => seedUserSession(db, { userId, ...options }),
    close: () => db.close(),
  };
}

async function readBody(response) {
  const text = await response.text();
  return { status: response.status, replayed: response.headers.get('Idempotency-Replayed'), body: text ? JSON.parse(text) : null };
}

const approve = (ctx, { cookie = ctx.cookie, key = 'appr-key-0000001', schoolYearId = 'y2026', iban = IBAN, bic, payeeName = 'Rada Rodziców' } = {}) =>
  ctx.fetch(request('/api/payment-instructions', {
    method: 'POST', cookie, headers: { 'Idempotency-Key': key }, body: { schoolYearId, iban, bic, payeeName },
  }));

const getCurrent = (ctx, { cookie = ctx.cookie, schoolYearId = 'y2026' } = {}) =>
  ctx.fetch(request(`/api/payment-instructions?schoolYearId=${schoolYearId}`, { cookie }));

test('zatwierdza dane do wpłaty i loguje zdarzenie bez IBAN w metadanych', async () => {
  const ctx = await backend();
  const { status, replayed, body } = await readBody(await approve(ctx));
  assert.equal(status, 201);
  assert.equal(replayed, 'false');
  assert.equal(body.paymentInstructions.iban, IBAN);
  const events = await ctx.db.query("SELECT metadata_json::text AS meta FROM audit_events WHERE action = 'payment_instructions.approved'");
  assert.equal(events.rows.length, 1);
  assert.ok(!events.rows[0].meta.includes(IBAN), 'IBAN nie trafia do metadanych audytu');
  await ctx.close();
});

test('brak zatwierdzonej wersji -> null, status 200 (kartka pozostaje szkicem bez QR)', async () => {
  const ctx = await backend();
  const { status, body } = await readBody(await getCurrent(ctx));
  assert.equal(status, 200);
  assert.equal(body.paymentInstructions, null);
  await ctx.close();
});

test('podwójne kliknięcie „zatwierdź konfigurację” -> jedna wersja (idempotencja)', async () => {
  const ctx = await backend();
  const first = await readBody(await approve(ctx, { key: 'dup-key-0000001' }));
  const second = await readBody(await approve(ctx, { key: 'dup-key-0000001' }));
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.replayed, 'true');
  const { rows } = await ctx.db.query('SELECT count(*)::int AS n FROM payment_instructions');
  assert.equal(rows[0].n, 1);
  await ctx.close();
});

test('korekta rachunku w trakcie roku: nowa wersja, GET zwraca najnowszą, stara zostaje (id w stopce)', async () => {
  const ctx = await backend();
  const first = await readBody(await approve(ctx, { key: 'v1-key-00000001', iban: IBAN }));
  const second = await readBody(await approve(ctx, { key: 'v2-key-00000001', iban: 'BE71096123456769' }));
  assert.notEqual(first.body.paymentInstructions.id, second.body.paymentInstructions.id);
  const current = await readBody(await getCurrent(ctx));
  assert.equal(current.body.paymentInstructions.id, second.body.paymentInstructions.id);
  assert.equal(current.body.paymentInstructions.iban, 'BE71096123456769');
  const { rows } = await ctx.db.query('SELECT count(*)::int AS n FROM payment_instructions');
  assert.equal(rows[0].n, 2, 'stara wersja zostaje (niezmienność), nie jest nadpisana');
  await ctx.close();
});

test('błędny IBAN -> 400 przed zapisem', async () => {
  const ctx = await backend();
  const { status, body } = await readBody(await approve(ctx, { iban: 'BE00000000000000' }));
  assert.equal(status, 400);
  assert.equal(body.error, 'invalid_iban');
  const { rows } = await ctx.db.query('SELECT count(*)::int AS n FROM payment_instructions');
  assert.equal(rows[0].n, 0);
  await ctx.close();
});

test('nazwa odbiorcy z polskimi znakami, 70 OK / 71 odrzucone', async () => {
  const ctx = await backend();
  const name70 = 'Ą'.repeat(70);
  const ok = await readBody(await approve(ctx, { key: 'name70-key-001', payeeName: name70 }));
  assert.equal(ok.status, 201);
  const name71 = 'Ą'.repeat(71);
  const bad = await readBody(await approve(ctx, { key: 'name71-key-001', payeeName: name71 }));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_payee_name');
  await ctx.close();
});

test('skarbnik nie może zatwierdzić danych do wpłaty (wariant zachowawczy do D-08), ale może je odczytać', async () => {
  const ctx = await backend({ role: 'board' });
  await approve(ctx);
  const treasurerCookie = await ctx.as('u-treasurer', { mfa: true, roles: [{ role: 'treasurer', schoolYearId: 'y2026' }] });
  const approveAttempt = await readBody(await approve(ctx, { cookie: treasurerCookie, key: 'treasurer-appr-01' }));
  assert.equal(approveAttempt.status, 403);
  const readAttempt = await readBody(await getCurrent(ctx, { cookie: treasurerCookie }));
  assert.equal(readAttempt.status, 200);
  await ctx.close();
});

test('przedstawiciel klasy -> 403 (integracja z kartkami własnej klasy poza zakresem #92 w tym PR)', async () => {
  const ctx = await backend();
  const repCookie = await ctx.as('u-rep', { mfa: true, roles: [{ role: 'representative', classId: 'kl-1a', schoolYearId: 'y2026' }] });
  const { status } = await readBody(await getCurrent(ctx, { cookie: repCookie }));
  assert.equal(status, 403);
  await ctx.close();
});

test('sesja bez potwierdzonego MFA -> 403', async () => {
  const ctx = await backend({ mfa: false });
  const { status } = await readBody(await approve(ctx));
  assert.equal(status, 403);
  await ctx.close();
});

test('baza: zatwierdzona wersja jest niezmienna (trigger)', async () => {
  const ctx = await backend();
  const created = await readBody(await approve(ctx));
  const id = created.body.paymentInstructions.id;
  await assert.rejects(
    ctx.db.query("UPDATE payment_instructions SET iban = 'BE71096123456769' WHERE id = $1", [id]),
    /payment_instructions_immutable/,
  );
  await assertOwnerGuard(ctx.db, 'DELETE FROM payment_instructions WHERE id = $1', /payment_instructions_immutable/, [id]);
  await ctx.close();
});
