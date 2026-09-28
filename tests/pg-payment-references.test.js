// API komunikacji strukturalnej OGM-VCS na PostgreSQL (#83). Wyłącznie dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { isValidStructuredReference } from '../src/pg/ogm.js';
import { createTestDb, request, seedSchoolYear, seedUserSession } from './helpers/pg.js';

async function backend({ role = 'treasurer', mfa = true, schoolYearId = 'y2026' } = {}) {
  const db = await createTestDb();
  await seedSchoolYear(db, 'y2025', { startsOn: '2025-09-01', endsOn: '2026-08-31' });
  await seedSchoolYear(db, 'y2026');
  await db.query("INSERT INTO households (id) VALUES ('h1'), ('h2')");
  const cookie = await seedUserSession(db, { userId: 'u1', mfa, roles: [{ role, schoolYearId }] });
  const env = { db };
  return {
    db, env, cookie,
    fetch: (req) => handlePgRequest(req, env),
    as: (userId, options) => seedUserSession(db, { userId, ...options }),
    count: async (table, where = 'TRUE') => Number((await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n),
    close: () => db.close(),
  };
}

async function readBody(response) {
  const text = await response.text();
  return { status: response.status, replayed: response.headers.get('Idempotency-Replayed'), body: text ? JSON.parse(text) : null };
}

const create = (ctx, { cookie = ctx.cookie, key = 'gen-key-0000001', householdId = 'h1', schoolYearId = 'y2026' } = {}) =>
  ctx.fetch(request('/api/payment-references', {
    method: 'POST', cookie, headers: { 'Idempotency-Key': key }, body: { schoolYearId, householdId },
  }));

const revoke = (ctx, id, { cookie = ctx.cookie, key = 'rev-key-0000001', reason = 'Zgubiona kartka, korekta syntetyczna' } = {}) =>
  ctx.fetch(request(`/api/payment-references/${id}/revoke`, {
    method: 'POST', cookie, headers: { 'Idempotency-Key': key }, body: { reason },
  }));

const list = (ctx, { cookie = ctx.cookie, householdId = 'h1', schoolYearId = 'y2026' } = {}) =>
  ctx.fetch(request(`/api/payment-references?schoolYearId=${schoolYearId}&householdId=${householdId}`, { cookie }));

test('generuje aktywną referencję z poprawną sumą kontrolną i loguje zdarzenie', async () => {
  const ctx = await backend();
  const { status, replayed, body } = await readBody(await create(ctx));
  assert.equal(status, 201);
  assert.equal(replayed, 'false');
  assert.match(body.paymentReference.structuredReference, /^\d{12}$/);
  assert.equal(isValidStructuredReference(body.paymentReference.structuredReference), true);
  assert.equal(body.paymentReference.householdId, 'h1');
  assert.equal(body.paymentReference.active, true);
  const events = await ctx.db.query(
    "SELECT metadata_json::text AS meta FROM audit_events WHERE action = 'payment_reference.generated'",
  );
  assert.equal(events.rows.length, 1);
  assert.ok(!events.rows[0].meta.includes(body.paymentReference.structuredReference), 'referencja nie trafia do metadanych audytu');
  await ctx.close();
});

test('podwójne kliknięcie (ten sam klucz idempotencji) -> jedna referencja, replay', async () => {
  const ctx = await backend();
  const first = await readBody(await create(ctx, { key: 'dup-key-000001' }));
  const second = await readBody(await create(ctx, { key: 'dup-key-000001' }));
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.replayed, 'true');
  assert.equal(second.body.paymentReference.id, first.body.paymentReference.id);
  assert.equal(await ctx.count('payment_references'), 1);
  await ctx.close();
});

test('ten sam klucz idempotencji z innym gospodarstwem -> konflikt', async () => {
  const ctx = await backend();
  await create(ctx, { key: 'conf-key-00001', householdId: 'h1' });
  const { status, body } = await readBody(await create(ctx, { key: 'conf-key-00001', householdId: 'h2' }));
  assert.equal(status, 409);
  assert.equal(body.error, 'idempotency_conflict');
  await ctx.close();
});

test('druga referencja dla tego samego gospodarstwa/roku bez unieważnienia -> 409', async () => {
  const ctx = await backend();
  await create(ctx, { key: 'act-key-000001' });
  const { status, body } = await readBody(await create(ctx, { key: 'act-key-000002' }));
  assert.equal(status, 409);
  assert.equal(body.error, 'payment_reference_already_active');
  assert.equal(await ctx.count('payment_references'), 1);
  await ctx.close();
});

test('unieważnienie i nowa referencja: stara zostaje jako historyczna, nowa aktywna', async () => {
  const ctx = await backend();
  const created = await readBody(await create(ctx, { key: 'rev-flow-0001' }));
  const oldId = created.body.paymentReference.id;
  const revoked = await readBody(await revoke(ctx, oldId, { key: 'rev-flow-do-0001' }));
  assert.equal(revoked.status, 201);
  assert.equal(revoked.body.paymentReference.active, false);
  assert.equal(revoked.body.paymentReference.revokeReason, 'Zgubiona kartka, korekta syntetyczna');
  const recreated = await readBody(await create(ctx, { key: 'rev-flow-0002' }));
  assert.equal(recreated.status, 201);
  assert.notEqual(recreated.body.paymentReference.structuredReference, created.body.paymentReference.structuredReference);
  const { body: listing } = await readBody(await list(ctx));
  assert.equal(listing.paymentReferences.length, 2);
  const active = listing.paymentReferences.filter((r) => r.active);
  assert.equal(active.length, 1);
  assert.equal(active[0].id, recreated.body.paymentReference.id);
  await ctx.close();
});

test('podwójne kliknięcie unieważnienia -> jeden zapis, replay', async () => {
  const ctx = await backend();
  const created = await readBody(await create(ctx, { key: 'rev-dup-0001' }));
  const id = created.body.paymentReference.id;
  const first = await readBody(await revoke(ctx, id, { key: 'rev-dup-do-0001' }));
  const second = await readBody(await revoke(ctx, id, { key: 'rev-dup-do-0001' }));
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.replayed, 'true');
  assert.equal(await ctx.count('payment_reference_revocations'), 1);
  await ctx.close();
});

test('unieważnienie już unieważnionej referencji (inny klucz) -> 409', async () => {
  const ctx = await backend();
  const created = await readBody(await create(ctx, { key: 'rev-twice-0001' }));
  const id = created.body.paymentReference.id;
  await revoke(ctx, id, { key: 'rev-twice-do-01' });
  const { status, body } = await readBody(await revoke(ctx, id, { key: 'rev-twice-do-02' }));
  assert.equal(status, 409);
  assert.equal(body.error, 'payment_reference_already_revoked');
  await ctx.close();
});

test('unieważnienie nieistniejącej referencji -> 404', async () => {
  const ctx = await backend();
  const { status, body } = await readBody(await revoke(ctx, 'brak-takiej-id', { key: 'rev-404-0001' }));
  assert.equal(status, 404);
  assert.equal(body.error, 'payment_reference_not_found');
  await ctx.close();
});

test('przedstawiciel klasy -> 403 (widoczność ograniczona do kartek własnej klasy poza zakresem tego PR)', async () => {
  const ctx = await backend();
  const repCookie = await ctx.as('u-rep', { mfa: true, roles: [{ role: 'representative', classId: 'kl-1a', schoolYearId: 'y2026' }] });
  const { status } = await readBody(await create(ctx, { cookie: repCookie }));
  assert.equal(status, 403);
  const { status: listStatus } = await readBody(await list(ctx, { cookie: repCookie }));
  assert.equal(listStatus, 403);
  await ctx.close();
});

test('skarbnik innego roku -> 403', async () => {
  const ctx = await backend({ schoolYearId: 'y2025' });
  const { status } = await readBody(await create(ctx));
  assert.equal(status, 403);
  await ctx.close();
});

test('sesja bez potwierdzonego MFA -> 403', async () => {
  const ctx = await backend({ mfa: false });
  const { status } = await readBody(await create(ctx));
  assert.equal(status, 403);
  await ctx.close();
});

test('baza: referencja jest niezmienna poza unieważnieniem (trigger)', async () => {
  const ctx = await backend();
  const created = await readBody(await create(ctx, { key: 'immut-key-001' }));
  const id = created.body.paymentReference.id;
  await assert.rejects(
    ctx.db.query("UPDATE payment_references SET structured_reference = '999999999999' WHERE id = $1", [id]),
    /payment_reference_facts_immutable/,
  );
  await assert.rejects(
    ctx.db.query('DELETE FROM payment_references WHERE id = $1', [id]),
    /payment_references_cannot_be_deleted/,
  );
  await ctx.close();
});

test('baza: zdarzenie unieważnienia jest niezmienne', async () => {
  const ctx = await backend();
  const created = await readBody(await create(ctx, { key: 'immut-rev-001' }));
  const id = created.body.paymentReference.id;
  await revoke(ctx, id, { key: 'immut-rev-do-001' });
  const { rows } = await ctx.db.query('SELECT id FROM payment_reference_revocations WHERE payment_reference_id = $1', [id]);
  await assert.rejects(
    ctx.db.query("UPDATE payment_reference_revocations SET reason = 'inny powod' WHERE id = $1", [rows[0].id]),
    /payment_reference_revocations_cannot_be_changed/,
  );
  await ctx.close();
});
