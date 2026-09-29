// Belgijska komunikacja strukturalna (OGM-VCS) na gospodarstwo i rok (#83).
// Prototyp — nie jest wdrożony. Zastępuje w kartkach/e-mailu przepisywanie
// wewnętrznego household_id (UUID bez sumy kontrolnej); patrz src/pg/ogm.js.
//
//   GET  /api/payment-references?schoolYearId=…&householdId=…   (aktywna + historia)
//   POST /api/payment-references                    (Idempotency-Key) — generuje aktywną
//   POST /api/payment-references/{id}/revoke        (Idempotency-Key) — unieważnia
//
// Rok i rola: te same wymogi co odczyt/zapis wpłat (admin/board/treasurer + MFA,
// zakres roku). Poza zakresem tego PR: widoczność ograniczona do własnej klasy
// dla przedstawiciela (wymaga integracji z kartkami print/print.js — #92) — tu
// przedstawiciel zawsze dostaje 403, co jest zachowaniem bezpiecznym (mniej danych).
//
// Referencja to pseudonim gospodarstwa: NIGDY nie trafia do metadanych zdarzenia
// audytu (assertNoPii nie łapie samych cyfr, więc pilnujemy tego tutaj ręcznie).

import { isSameOrigin } from '../../auth.js';
import { isAuthorizedScoped, loadAuthorizationContext } from '../authorization.js';
import { insertAuditEvent } from '../audit.js';
import { gateFreeText, piiAuditMetadata } from '../pii-gate.js';
import { generateStructuredReference, isValidStructuredReference } from '../ogm.js';
import { createJsonReader, isUniqueError } from '../input.js';

export const name = 'payment-references';

const FINANCIAL_ROLES = ['admin', 'board', 'treasurer'];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;
const MAX_BODY_BYTES = 4 * 1024;
const MAX_GENERATE_ATTEMPTS = 8;

class RequestError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

class Replay {
  constructor(body) {
    this.body = body;
  }
}

function validId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function decodeId(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new RequestError('invalid_id');
  }
}

function textOrNull(value, maxLength) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new RequestError('invalid_request');
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new RequestError('invalid_request');
  return normalized;
}

function readIdempotencyKey(request) {
  const key = request.headers.get('Idempotency-Key')?.trim();
  if (!key || !IDEMPOTENCY_PATTERN.test(key)) throw new RequestError('invalid_idempotency_key');
  return key;
}

const readJson = createJsonReader({
  maxBytes: MAX_BODY_BYTES,
  declaredLength: true,
  error: (code, status) => new RequestError(code, status),
});

function mapDatabaseError(error) {
  if (error instanceof RequestError) throw error;
  const message = String(error?.message ?? '');
  if (message.includes('payment_reference_already_revoked')) throw new RequestError('payment_reference_already_revoked', 409);
  if (message.includes('school_year_closed')) throw new RequestError('school_year_closed', 409);
  if (error?.code === '23503') throw new RequestError('invalid_reference');
  throw error;
}

async function requireFinancialContext(request, env, schoolYearId) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) throw new RequestError('unauthenticated', 401);
  if (!isAuthorizedScoped(context, { roles: FINANCIAL_ROLES, schoolYearId, requireMfa: true })) {
    throw new RequestError('forbidden', 403);
  }
  return context;
}

function referenceFromRow(row) {
  return {
    id: row.id,
    schoolYearId: row.school_year_id,
    householdId: row.household_id,
    structuredReference: row.structured_reference,
    active: row.revoked_at === null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    revokeReason: row.revoke_reason ?? null,
  };
}

async function loadReferenceByKey(executor, key) {
  const { rows } = await executor.query(
    `SELECT id, school_year_id, household_id, structured_reference, revoked_at, revoke_reason
       FROM payment_references WHERE idempotency_key = $1 LIMIT 1`,
    [key],
  );
  return rows[0] ?? null;
}

async function listReferences(request, env, url, json) {
  const schoolYearId = url.searchParams.get('schoolYearId');
  const householdId = url.searchParams.get('householdId');
  if (!validId(schoolYearId) || !validId(householdId)) throw new RequestError('invalid_request');
  await requireFinancialContext(request, env, schoolYearId);
  const { rows } = await env.db.query(
    `SELECT id, school_year_id, household_id, structured_reference, revoked_at, revoke_reason
       FROM payment_references
      WHERE school_year_id = $1 AND household_id = $2
      ORDER BY created_at DESC`,
    [schoolYearId, householdId],
  );
  return json({ paymentReferences: rows.map(referenceFromRow) });
}

async function createReference(request, env, json) {
  const idempotencyKey = readIdempotencyKey(request);
  const data = await readJson(request);
  if (!validId(data.schoolYearId) || !validId(data.householdId)) throw new RequestError('invalid_request');
  const { schoolYearId, householdId } = data;
  const context = await requireFinancialContext(request, env, schoolYearId);
  const actorId = context.session.user.id;

  const existingByKey = await loadReferenceByKey(env.db, idempotencyKey);
  if (existingByKey) {
    if (existingByKey.school_year_id !== schoolYearId || existingByKey.household_id !== householdId) {
      throw new RequestError('idempotency_conflict', 409);
    }
    return json({ paymentReference: referenceFromRow(existingByKey) }, 200, { 'Idempotency-Replayed': 'true' });
  }

  let result;
  try {
    result = await env.db.transaction(async (tx) => {
      const active = await tx.query(
        `SELECT id FROM payment_references
          WHERE school_year_id = $1 AND household_id = $2 AND revoked_at IS NULL
          FOR UPDATE`,
        [schoolYearId, householdId],
      );
      if (active.rows.length) throw new RequestError('payment_reference_already_active', 409);

      let row = null;
      for (let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS && !row; attempt += 1) {
        const structuredReference = generateStructuredReference();
        const id = crypto.randomUUID();
        try {
          const inserted = await tx.query(
            `INSERT INTO payment_references
               (id, school_year_id, household_id, structured_reference, created_by, idempotency_key)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, school_year_id, household_id, structured_reference, revoked_at, revoke_reason`,
            [id, schoolYearId, householdId, structuredReference, actorId, idempotencyKey],
          );
          row = inserted.rows[0];
        } catch (error) {
          // Kolizja losowania w tym samym roku (skrajnie rzadka) — ponów z nową bazą.
          if (isUniqueError(error) && String(error.message ?? '').includes('payment_references_year_ref_idx')) continue;
          throw error;
        }
      }
      if (!row) throw new RequestError('service_unavailable', 503);
      await insertAuditEvent(tx, {
        actorId, action: 'payment_reference.generated', entityType: 'payment_reference',
        entityId: row.id, metadata: { householdId, schoolYearId },
      });
      return { paymentReference: referenceFromRow(row) };
    });
  } catch (error) {
    if (isUniqueError(error)) {
      // idempotency_key: równoległe żądanie z tym samym kluczem zdążyło zapisać wiersz.
      const replay = await loadReferenceByKey(env.db, idempotencyKey);
      if (replay && replay.school_year_id === schoolYearId && replay.household_id === householdId) {
        return json({ paymentReference: referenceFromRow(replay) }, 200, { 'Idempotency-Replayed': 'true' });
      }
      throw new RequestError('idempotency_conflict', 409);
    }
    mapDatabaseError(error);
  }
  return json(result, 201, { 'Idempotency-Replayed': 'false' });
}

async function revokeReference(request, env, referenceId, json) {
  if (!validId(referenceId)) throw new RequestError('invalid_id');
  const idempotencyKey = readIdempotencyKey(request);
  const data = await readJson(request);
  const reason = textOrNull(data.reason, 500);
  if (!reason || reason.length < 3) throw new RequestError('invalid_reason');
  const confirmPersonalData = data.confirmPersonalData === true;

  const context = await loadAuthorizationContext(request, env);
  if (!context) throw new RequestError('unauthenticated', 401);
  const actorId = context.session.user.id;

  const existingByKey = await env.db.query(
    `SELECT id, payment_reference_id, reason FROM payment_reference_revocations WHERE idempotency_key = $1 LIMIT 1`,
    [idempotencyKey],
  );
  if (existingByKey.rows.length) {
    const row = existingByKey.rows[0];
    if (row.payment_reference_id !== referenceId || row.reason !== reason) throw new RequestError('idempotency_conflict', 409);
    const { rows } = await env.db.query(
      `SELECT id, school_year_id, household_id, structured_reference, revoked_at, revoke_reason
         FROM payment_references WHERE id = $1`,
      [referenceId],
    );
    return json({ paymentReference: referenceFromRow(rows[0]) }, 200, { 'Idempotency-Replayed': 'true' });
  }

  let result;
  try {
    result = await env.db.transaction(async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, school_year_id, household_id, revoked_at
           FROM payment_references WHERE id = $1 FOR UPDATE`,
        [referenceId],
      );
      const reference = rows[0];
      if (!reference) throw new RequestError('payment_reference_not_found', 404);
      if (!isAuthorizedScoped(context, { roles: FINANCIAL_ROLES, schoolYearId: reference.school_year_id, requireMfa: true })) {
        throw new RequestError('forbidden', 403);
      }
      if (reference.revoked_at !== null) throw new RequestError('payment_reference_already_revoked', 409);
      // #152: powód wpisu niezmiennego — bramka na dane osobowe (src/pg/pii-gate.js).
      const gate = gateFreeText([['payment_reference_revocations.reason', reason]], {
        confirm: confirmPersonalData, fail: (code, categories) => new RequestError(code, 422, { categories }),
      });
      const revocationId = crypto.randomUUID();
      await tx.query(
        `INSERT INTO payment_reference_revocations (id, payment_reference_id, reason, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5)`,
        [revocationId, referenceId, reason, actorId, idempotencyKey],
      );
      // Zdarzenie bez samej referencji (pseudonim gospodarstwa) w metadanych.
      await insertAuditEvent(tx, {
        actorId, action: 'payment_reference.revoked', entityType: 'payment_reference', entityId: referenceId,
        metadata: { householdId: reference.household_id, schoolYearId: reference.school_year_id, ...piiAuditMetadata(gate) },
      });
      const updated = await tx.query(
        `SELECT id, school_year_id, household_id, structured_reference, revoked_at, revoke_reason
           FROM payment_references WHERE id = $1`,
        [referenceId],
      );
      return { paymentReference: referenceFromRow(updated.rows[0]) };
    });
  } catch (error) {
    if (isUniqueError(error)) {
      const replay = await env.db.query(
        `SELECT id, payment_reference_id, reason FROM payment_reference_revocations WHERE idempotency_key = $1 LIMIT 1`,
        [idempotencyKey],
      );
      if (replay.rows.length && replay.rows[0].payment_reference_id === referenceId && replay.rows[0].reason === reason) {
        const { rows } = await env.db.query(
          `SELECT id, school_year_id, household_id, structured_reference, revoked_at, revoke_reason
             FROM payment_references WHERE id = $1`,
          [referenceId],
        );
        return json({ paymentReference: referenceFromRow(rows[0]) }, 200, { 'Idempotency-Replayed': 'true' });
      }
      throw new RequestError('idempotency_conflict', 409);
    }
    mapDatabaseError(error);
  }
  return json(result, 201, { 'Idempotency-Replayed': 'false' });
}

export async function handle(request, env, url, json) {
  const revokeMatch = url.pathname.match(/^\/api\/payment-references\/([^/]+)\/revoke$/);
  const isList = request.method === 'GET' && url.pathname === '/api/payment-references';
  const isCreate = request.method === 'POST' && url.pathname === '/api/payment-references';
  const isRevoke = request.method === 'POST' && revokeMatch;
  if (!isList && !isCreate && !isRevoke) return null;
  if ((isCreate || isRevoke) && !isSameOrigin(request)) return json({ error: 'invalid_origin' }, 403);

  try {
    if (isList) return await listReferences(request, env, url, json);
    if (isCreate) return await createReference(request, env, json);
    return await revokeReference(request, env, decodeId(revokeMatch[1]), json);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.code, ...error.extra }, error.status);
    throw error;
  }
}

// Reużywalne przez inne moduły tras (import wyciągu, propozycje dopasowania,
// przyszłe #92): sprawdza sumę kontrolną, nie autoryzuje niczego samo z siebie.
export { isValidStructuredReference };
