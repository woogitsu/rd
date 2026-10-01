// Ścieżka kontroli Komisji Rewizyjnej (#137, migracja 0176). Prototyp — nie jest wdrożony.
//
//   GET  /api/audit-reviews/{schoolYearId}                       wątki uwag i wnioski końcowe roku
//   POST /api/audit-reviews/{schoolYearId}/notes                 { kind: question|finding, targetType, targetId, body }   (KR)
//   POST /api/audit-reviews/{schoolYearId}/notes/{id}/answers    { body }                                                (zarząd, skarbnik)
//   POST /api/audit-reviews/{schoolYearId}/notes/{id}/closure    { body? }                                               (KR)
//   POST /api/audit-reviews/{schoolYearId}/conclusion            { body }                                                (KR)
//
// Role i zakres są spójne z raportem KR (GET /api/reports/audit): odczyt mają
// audit, board i treasurer z MFA przydzieleni do całego roku (bez zawężenia do
// klasy). Zapisują: pytania, ustalenia, zamknięcia i wnioski — wyłącznie `audit`;
// odpowiedzi — wyłącznie `board` i `treasurer`. To ZAŁOŻENIE do zatwierdzenia
// przez zarząd (D-09, D-21): trasa NIE daje roli `audit` dostępu do księgi ani
// dowodów, a `admin` (techniczny), dyrekcja, przedstawiciel klasy i przydział
// klasowy dostają 403. Każdy zapis wymaga nagłówka Idempotency-Key (podwójne
// kliknięcie = jeden zapis), jest niezmienny (korekta = nowy zapis), przechodzi
// bramkę danych osobowych (pii-gate) i zapisuje zdarzenie audytu bez treści.
// Zamknięty rok odrzuca zapisy (409 school_year_closed) — wariant zachowawczy.
// Konflikt ról (członek KR z rolą zarządu/skarbnika): nie rozstrzygamy — D-09;
// odpowiedź na pytanie musi jednak złożyć INNA osoba niż jego autor.

import { isSameOrigin } from '../../auth.js';
import {
  isAuthorizedScoped, loadAuthorizationContext, logAccessDenied, mfaAwareForbiddenCode,
} from '../authorization.js';
import {
  appendNote, AuditReviewError, BODY_MAX, BODY_MIN, listReviews, loadNote, NOTE_KINDS, TARGET_TYPES,
} from '../audit-reviews.js';
import { createIdempotencyKeyReader, createJsonReader } from '../input.js';
import { gateFreeText, loadKnownNames, PersonalDataError, piiAuditMetadata } from '../pii-gate.js';

export const name = 'audit-reviews';

const READ_ROLES = ['audit', 'board', 'treasurer'];
const REVIEWER_ROLES = ['audit'];
const ANSWER_ROLES = ['board', 'treasurer'];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_BODY_BYTES = 12 * 1024;
const PATH = /^\/api\/audit-reviews\/([^/]+)(?:\/(notes|conclusion)(?:\/([^/]+)\/(answers|closure))?)?$/;
const NO_STORE = { 'Cache-Control': 'no-store' };

const RequestError = AuditReviewError;
const readKey = createIdempotencyKeyReader({ error: (code, status) => new RequestError(code, status) });
const readJson = createJsonReader({
  maxBytes: MAX_BODY_BYTES,
  emptyBody: 'blank',
  typeAfterEmpty: true,
  error: (code, status) => new RequestError(code, status),
});

function decodeId(value, code = 'invalid_request') {
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { throw new RequestError(code); }
  if (!ID_PATTERN.test(decoded)) throw new RequestError(code);
  return decoded;
}

async function requireAccess(request, env, schoolYearId, roles) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) throw new RequestError('unauthenticated', 401);
  const rule = { roles, schoolYearId, requireMfa: true };
  if (!isAuthorizedScoped(context, rule)) {
    const code = await mfaAwareForbiddenCode(context, rule, env);
    // #184: ślad odmowy roli/zakresu; kody MFA — bez zdarzenia, jak w pozostałych bramkach.
    if (code === 'forbidden') await logAccessDenied(env, context, rule, request);
    throw new RequestError(code, 403);
  }
  return context;
}

async function requireYear(env, schoolYearId) {
  const { rows } = await env.db.query('SELECT 1 FROM school_years WHERE id = $1', [schoolYearId]);
  if (!rows.length) throw new RequestError('school_year_not_found', 404);
}

function parseNoteBody(data, { optional = false } = {}) {
  const raw = data.body;
  if (optional && (raw === undefined || raw === null || raw === '')) return null;
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length < BODY_MIN || text.length > BODY_MAX) throw new RequestError('invalid_audit_review_body');
  return text;
}

async function gate(env, schoolYearId, data, body) {
  if (body === null) return {};
  return piiAuditMetadata(gateFreeText([['audit_review_notes.body', body]], {
    confirm: data.confirmPersonalData === true,
    knownNames: await loadKnownNames(env.db, schoolYearId),
  }));
}

async function list(request, env, schoolYearId, json) {
  await requireAccess(request, env, schoolYearId, READ_ROLES);
  await requireYear(env, schoolYearId);
  return json({ schoolYearId, ...(await listReviews(env.db, schoolYearId)) }, 200, NO_STORE);
}

async function respond(json, result) {
  return json({ note: result.note, replayed: result.replayed }, result.replayed ? 200 : 201, NO_STORE);
}

async function addNote(request, env, schoolYearId, json) {
  // Rola i zakres przed jakąkolwiek walidacją ciała (odmowa 403 nie zdradza reguł walidacji).
  const context = await requireAccess(request, env, schoolYearId, REVIEWER_ROLES);
  const data = await readJson(request);
  const { kind, targetType, targetId } = data;
  if (!NOTE_KINDS.includes(kind) || !TARGET_TYPES.includes(targetType)) throw new RequestError('invalid_request');
  if (typeof targetId !== 'string' || !ID_PATTERN.test(targetId)) throw new RequestError('invalid_request');
  if (targetType === 'year' && targetId !== schoolYearId) throw new RequestError('audit_review_target_not_found', 404);
  const idempotencyKey = readKey(request);
  const body = parseNoteBody(data);
  await requireYear(env, schoolYearId);
  const pii = await gate(env, schoolYearId, data, body);
  return respond(json, await appendNote(env.db, {
    actorId: context.session.user.id, schoolYearId, kind, targetType, targetId, body, idempotencyKey, auditMetadata: pii,
  }));
}

async function reply(request, env, schoolYearId, noteId, action, json) {
  const roles = action === 'answers' ? ANSWER_ROLES : REVIEWER_ROLES;
  const context = await requireAccess(request, env, schoolYearId, roles);
  const data = await readJson(request);
  const idempotencyKey = readKey(request);
  const body = parseNoteBody(data, { optional: action === 'closure' });
  const parent = await loadNote(env.db, schoolYearId, noteId);
  if (!parent || !['question', 'finding'].includes(parent.kind)) throw new RequestError('audit_review_not_found', 404);
  const pii = await gate(env, schoolYearId, data, body);
  return respond(json, await appendNote(env.db, {
    actorId: context.session.user.id, schoolYearId, kind: action === 'answers' ? 'answer' : 'closed',
    targetType: parent.target_type, targetId: parent.target_id, parentId: parent.id, body, idempotencyKey,
    auditMetadata: pii,
  }));
}

async function conclusion(request, env, schoolYearId, json) {
  const context = await requireAccess(request, env, schoolYearId, REVIEWER_ROLES);
  const data = await readJson(request);
  const idempotencyKey = readKey(request);
  const body = parseNoteBody(data);
  await requireYear(env, schoolYearId);
  const pii = await gate(env, schoolYearId, data, body);
  return respond(json, await appendNote(env.db, {
    actorId: context.session.user.id, schoolYearId, kind: 'conclusion', targetType: 'year', targetId: schoolYearId,
    body, idempotencyKey, auditMetadata: pii,
  }));
}

export async function handle(request, env, url, json) {
  const match = PATH.exec(url.pathname);
  if (!match) return null;
  const [, rawYear, section, rawNote, action] = match;
  const isList = !section;
  const allowed = isList ? 'GET' : 'POST';
  if (request.method !== allowed) return json({ error: 'method_not_allowed' }, 405, { Allow: allowed });
  if (section === 'notes' && !!rawNote !== !!action) return null;
  if (section === 'conclusion' && rawNote) return null;
  if (!isList && !isSameOrigin(request)) return json({ error: 'invalid_origin' }, 403);
  try {
    const schoolYearId = decodeId(rawYear, 'invalid_school_year_id');
    if (isList) return await list(request, env, schoolYearId, json);
    if (section === 'conclusion') return await conclusion(request, env, schoolYearId, json);
    if (!rawNote) return await addNote(request, env, schoolYearId, json);
    return await reply(request, env, schoolYearId, decodeId(rawNote, 'audit_review_not_found'), action, json);
  } catch (error) {
    if (error instanceof PersonalDataError) return json({ error: error.code, categories: error.categories }, 422);
    if (error instanceof RequestError) return json({ error: error.code }, error.status);
    throw error;
  }
}
