// Historia jednego obiektu finansowego lub kampanii dla ról zarządu (#181). Prototyp — nie jest wdrożony.
//
//   GET /api/audit/entity/{entityType}/{entityId}
//        entityType: payment_entry | ledger_entry | reconciliation | email_campaign
//
// Autoryzacja jak odczyt obiektu, wariant zachowawczy (założenie do zatwierdzenia
// przez zarząd — D-08/D-09): board i treasurer z MFA, przydział ogólnoszkolny
// (bez klasy) na rok OBIEKTU. Admin korzysta z GET /api/admin/audit/entity/...,
// a Komisja Rewizyjna, dyrekcja, przedstawiciel klasy i przydział klasowy dostają
// 403. Obiekt nieistniejący albo z roku spoza przydziału: 404 not_found
// (nieodróżnialne — SR-07). Odpowiedź zawiera wyłącznie zdarzenia domeny obiektu
// (finance dla wpłat, księgi i uzgodnień; email dla kampanii), metadane przez
// auditMetadataForView (bez wolnego tekstu, e-maili i imion). Odczyt sam zapisuje
// `audit.viewed` (bez parametrów zapytania). Tylko odczyt.

import { isAuthorizedScoped, loadAuthorizationContext, logAccessDenied } from '../authorization.js';
import { insertAuditEvent } from '../audit.js';
import { auditActionDomain } from '../../../shared/audit-actions.js';
import { auditEventForView, ENTITY_DOMAIN, ENTITY_TABLES, readEntityAuditRows } from './admin.js';

export const name = 'audit-history';

const HISTORY_ROLES = ['board', 'treasurer'];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const PATH = /^\/api\/audit\/entity\/([^/]+)\/([^/]+)$/;

class RequestError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function decodeId(value) {
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { throw new RequestError('invalid_request'); }
  if (!ID_PATTERN.test(decoded)) throw new RequestError('invalid_request');
  return decoded;
}

async function entityHistory(request, env, rawType, rawId, json) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) throw new RequestError('unauthenticated', 401);
  const rule = { roles: HISTORY_ROLES, requireMfa: true };
  if (!isAuthorizedScoped(context, rule)) {
    await logAccessDenied(env, context, { roles: HISTORY_ROLES }, request);
    throw new RequestError('forbidden', 403);
  }
  const entityType = decodeId(rawType);
  const entityId = decodeId(rawId);
  const table = Object.hasOwn(ENTITY_TABLES, entityType) ? ENTITY_TABLES[entityType] : null;
  if (!table) throw new RequestError('invalid_entity_type');
  const { rows: found } = await env.db.query(`SELECT school_year_id FROM ${table} WHERE id = $1`, [entityId]);
  if (!found.length || !isAuthorizedScoped(context, { ...rule, schoolYearId: found[0].school_year_id })) {
    throw new RequestError('not_found', 404);
  }
  const domain = ENTITY_DOMAIN[entityType];
  const rows = (await readEntityAuditRows(env.db, entityType, entityId))
    .filter((row) => auditActionDomain(row.action) === domain);
  await insertAuditEvent(env.db, {
    actorId: context.session.user.id, action: 'audit.viewed', entityType, entityId, metadata: {},
  });
  return json({
    entityType, entityId,
    events: rows.map((row) => auditEventForView(row, { withEntity: false })),
  }, 200, { 'Cache-Control': 'no-store' });
}

export async function handle(request, env, url, json) {
  const match = PATH.exec(url.pathname);
  if (!match) return null;
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
  try {
    return await entityHistory(request, env, match[1], match[2], json);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.code }, error.status);
    throw error;
  }
}
