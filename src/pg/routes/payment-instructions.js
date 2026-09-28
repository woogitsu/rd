// Zatwierdzona na rok konfiguracja danych do wpłaty (IBAN/BIC/odbiorca) do
// kodu QR EPC na kartkach (#92). Prototyp — nie jest wdrożony.
//
//   GET  /api/payment-instructions?schoolYearId=…   (bieżąca zatwierdzona wersja albo null)
//   POST /api/payment-instructions                  (Idempotency-Key) — nowe zatwierdzenie (nowa wersja)
//
// Rola zatwierdzająca (D-08) nie jest jeszcze zdecydowana przez zarząd/szkołę:
// wariant zachowawczy — wyłącznie admin i zarząd (BEZ skarbnika, żeby zmiana
// rachunku wymagała czterech oczu poza księgowością bieżącą; do rewizji po D-08).
// Odczyt: te same role co wpłaty (admin/board/treasurer), MFA wymagane; ta trasa
// nadal zwraca przedstawicielowi klasy 403. Widoczność dla przedstawiciela (do
// druku kartek własnej klasy, bez MFA) jest zrealizowana osobno w
// src/pg/routes/print.js (#92 część 2) — GET /api/print/cards czyta
// payment_instructions bezpośrednio, bo to rachunek Rady sam w sobie, a nie
// dana finansowa rodziny; edycja/zatwierdzanie zostaje wyłącznie tutaj.
//
// IBAN/BIC NIGDY nie trafiają do metadanych zdarzenia audytu (assertNoPii łapie
// klucz "iban", ale nie "bic" — pilnujemy tego tutaj ręcznie też dla BIC).

import { isSameOrigin } from '../../auth.js';
import { isAuthorizedScoped, loadAuthorizationContext } from '../authorization.js';
import { insertAuditEvent } from '../audit.js';
import { isValidIban, normalizeIban } from '../../../print/iban.js';

export const name = 'payment-instructions';

const APPROVE_ROLES = ['admin', 'board'];
const READ_ROLES = ['admin', 'board', 'treasurer'];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;
const BIC_PATTERN = /^[A-Z0-9]{8}([A-Z0-9]{3})?$/;
const MAX_BODY_BYTES = 2 * 1024;

class RequestError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

function validId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function readIdempotencyKey(request) {
  const key = request.headers.get('Idempotency-Key')?.trim();
  if (!key || !IDEMPOTENCY_PATTERN.test(key)) throw new RequestError('invalid_idempotency_key');
  return key;
}

async function readJson(request) {
  const type = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw new RequestError('invalid_content_type', 415);
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) throw new RequestError('request_too_large', 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new RequestError('request_too_large', 413);
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new RequestError('invalid_json');
  }
}

function parseInput(data) {
  if (!validId(data.schoolYearId)) throw new RequestError('invalid_request');
  const iban = normalizeIban(data.iban);
  if (!isValidIban(iban)) throw new RequestError('invalid_iban');
  let bic = null;
  if (data.bic !== undefined && data.bic !== null && data.bic !== '') {
    if (typeof data.bic !== 'string') throw new RequestError('invalid_bic');
    bic = data.bic.trim().toUpperCase();
    if (!BIC_PATTERN.test(bic)) throw new RequestError('invalid_bic');
  }
  const payeeName = typeof data.payeeName === 'string' ? data.payeeName.trim() : '';
  if (!payeeName || payeeName.length > 70) throw new RequestError('invalid_payee_name');
  return { schoolYearId: data.schoolYearId, iban, bic, payeeName };
}

function instructionsFromRow(row) {
  return {
    id: row.id,
    schoolYearId: row.school_year_id,
    iban: row.iban,
    bic: row.bic ?? null,
    payeeName: row.payee_name,
    approvedAt: new Date(row.approved_at).toISOString(),
  };
}

async function requireContext(request, env, roles, schoolYearId) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) throw new RequestError('unauthenticated', 401);
  if (!isAuthorizedScoped(context, { roles, schoolYearId, requireMfa: true })) throw new RequestError('forbidden', 403);
  return context;
}

async function loadByKey(executor, key) {
  const { rows } = await executor.query(
    `SELECT id, school_year_id, iban, bic, payee_name, approved_at
       FROM payment_instructions WHERE idempotency_key = $1 LIMIT 1`,
    [key],
  );
  return rows[0] ?? null;
}

function isUniqueError(error) {
  return error?.code === '23505';
}

async function getCurrent(request, env, url, json) {
  const schoolYearId = url.searchParams.get('schoolYearId');
  if (!validId(schoolYearId)) throw new RequestError('invalid_request');
  await requireContext(request, env, READ_ROLES, schoolYearId);
  const { rows } = await env.db.query(
    `SELECT id, school_year_id, iban, bic, payee_name, approved_at
       FROM payment_instructions
      WHERE school_year_id = $1
      ORDER BY approved_at DESC, id DESC
      LIMIT 1`,
    [schoolYearId],
  );
  return json({ paymentInstructions: rows[0] ? instructionsFromRow(rows[0]) : null });
}

function inputMatches(row, input) {
  return row.school_year_id === input.schoolYearId
    && row.iban === input.iban
    && (row.bic ?? null) === input.bic
    && row.payee_name === input.payeeName;
}

async function approve(request, env, json) {
  const idempotencyKey = readIdempotencyKey(request);
  const input = parseInput(await readJson(request));
  const context = await requireContext(request, env, APPROVE_ROLES, input.schoolYearId);
  const actorId = context.session.user.id;

  const existing = await loadByKey(env.db, idempotencyKey);
  if (existing) {
    if (!inputMatches(existing, input)) throw new RequestError('idempotency_conflict', 409);
    return json({ paymentInstructions: instructionsFromRow(existing) }, 200, { 'Idempotency-Replayed': 'true' });
  }

  let result;
  try {
    result = await env.db.transaction(async (tx) => {
      const id = crypto.randomUUID();
      const inserted = await tx.query(
        `INSERT INTO payment_instructions (id, school_year_id, iban, bic, payee_name, approved_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, school_year_id, iban, bic, payee_name, approved_at`,
        [id, input.schoolYearId, input.iban, input.bic, input.payeeName, actorId, idempotencyKey],
      );
      // Bez IBAN/BIC w metadanych — tylko identyfikatory.
      await insertAuditEvent(tx, {
        actorId, action: 'payment_instructions.approved', entityType: 'payment_instructions',
        entityId: id, metadata: { schoolYearId: input.schoolYearId },
      });
      return { paymentInstructions: instructionsFromRow(inserted.rows[0]) };
    });
  } catch (error) {
    if (isUniqueError(error)) {
      const replay = await loadByKey(env.db, idempotencyKey);
      if (replay && inputMatches(replay, input)) {
        return json({ paymentInstructions: instructionsFromRow(replay) }, 200, { 'Idempotency-Replayed': 'true' });
      }
      throw new RequestError('idempotency_conflict', 409);
    }
    if (error instanceof RequestError) throw error;
    if (error?.code === '23503') throw new RequestError('invalid_reference');
    throw error;
  }
  return json(result, 201, { 'Idempotency-Replayed': 'false' });
}

export async function handle(request, env, url, json) {
  const isGet = request.method === 'GET' && url.pathname === '/api/payment-instructions';
  const isPost = request.method === 'POST' && url.pathname === '/api/payment-instructions';
  if (!isGet && !isPost) return null;
  if (isPost && !isSameOrigin(request)) return json({ error: 'invalid_origin' }, 403);

  try {
    if (isGet) return await getCurrent(request, env, url, json);
    return await approve(request, env, json);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.code, ...error.extra }, error.status);
    throw error;
  }
}
