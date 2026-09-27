// Eksport roczny i lista klasy na PostgreSQL (issue #9). Prototyp — nie jest wdrożony.
//
//   POST /api/exports                         { "schoolYearId": "…" }
//        admin albo zarząd (założenie do D-08/D-09), sesja z MFA, zakres roku.
//        Zwraca deterministyczną paczkę JSON jako załącznik (docs/EXPORT.md).
//   GET  /api/exports/class-roster?classId=…
//        przedstawiciel wyłącznie własnej klasy (także admin/zarząd), MFA.
//        Tylko lista uczniów i opiekunów klasy — bez wpłat i identyfikatorów rodzin.
//
// Każdy przebieg zapisuje wiersz export_runs (liczności i SHA-256, bez treści)
// oraz zdarzenie audytu `export.created` w tej samej transakcji.

import { isSameOrigin } from '../../auth.js';
import { isAuthorized, isAuthorizedScoped, loadAuthorizationContext } from '../authorization.js';
import { insertAuditEvent } from '../audit.js';
import {
  buildClassRoster, buildYearlyExport, EXPORT_FORMAT_VERSION, ExportError, ROSTER_FORMAT_VERSION,
} from '../export.js';

export const name = 'exports';

// Założenie do czasu decyzji D-08/D-09: pełny eksport roczny (dane rodzin i
// finanse) tylko admin i zarząd; skarbnik, Komisja Rewizyjna i dyrekcja nie.
export const YEARLY_EXPORT_ROLES = Object.freeze(['admin', 'board']);
export const ROSTER_ROLES = Object.freeze(['representative', 'board', 'admin']);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_BODY_BYTES = 4 * 1024;

class RequestError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

async function readJson(request) {
  const type = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw new RequestError('invalid_content_type', 415);
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

function safeFilePart(value) {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function attachment(body, filename, headers = {}) {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

async function authorize(request, env, requirement, json) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) return { response: json({ error: 'unauthenticated' }, 401) };
  // Eksport roczny (bez classId) wymaga przydziału bez class_id; lista klasy — przydziału tej klasy.
  if (!isAuthorizedScoped(context, requirement)) return { response: json({ error: 'forbidden' }, 403) };
  return { context };
}

async function recordRun(tx, { kind, schoolYearId, classId = null, formatVersion, actorId, sha256, rowCounts }) {
  const runId = crypto.randomUUID();
  await tx.query(
    `INSERT INTO export_runs (id, kind, school_year_id, class_id, format_version, requested_by, manifest_sha256, row_counts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [runId, kind, schoolYearId, classId, formatVersion, actorId, sha256, JSON.stringify(rowCounts)],
  );
  await insertAuditEvent(tx, {
    actorId,
    action: 'export.created',
    entityType: 'export_run',
    entityId: runId,
    metadata: { kind, schoolYearId, classId, formatVersion, manifestSha256: sha256, rowCounts },
  });
  return runId;
}

async function createYearlyExport(request, env, json) {
  const data = await readJson(request);
  const schoolYearId = data.schoolYearId;
  if (typeof schoolYearId !== 'string' || !ID_PATTERN.test(schoolYearId)) throw new RequestError('invalid_school_year');

  const access = await authorize(request, env, { roles: [...YEARLY_EXPORT_ROLES], requireMfa: true, schoolYearId }, json);
  if (access.response) return access.response;
  const actorId = access.context.session.user.id;

  let result;
  try {
    result = await env.db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const built = await buildYearlyExport(tx, schoolYearId);
      const runId = await recordRun(tx, {
        kind: 'yearly', schoolYearId, formatVersion: EXPORT_FORMAT_VERSION, actorId,
        sha256: built.manifestSha256, rowCounts: built.rowCounts,
      });
      return { ...built, runId };
    });
  } catch (error) {
    if (error instanceof ExportError && error.code === 'school_year_not_found') throw new RequestError('school_year_not_found', 404);
    throw error;
  }

  return attachment(result.body, `rd-eksport-${safeFilePart(schoolYearId)}-v${EXPORT_FORMAT_VERSION}.json`, {
    'X-Export-Run-Id': result.runId,
    'X-Export-Manifest-Sha256': result.manifestSha256,
  });
}

async function exportClassRoster(request, env, url, json) {
  const classId = url.searchParams.get('classId');
  if (!classId || !ID_PATTERN.test(classId)) throw new RequestError('invalid_class');

  // Najpierw zakres klasy: przedstawiciel innej klasy dostaje 403 niezależnie
  // od tego, czy klasa istnieje.
  const access = await authorize(request, env, { roles: [...ROSTER_ROLES], requireMfa: true, classId }, json);
  if (access.response) return access.response;
  const actorId = access.context.session.user.id;

  const result = await env.db.transaction(async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    let built;
    try {
      built = await buildClassRoster(tx, classId);
    } catch (error) {
      if (error instanceof ExportError && error.code === 'class_not_found') return { notFound: true };
      throw error;
    }
    // Drugi krok: zakres roku szkolnego klasy.
    if (!isAuthorized(access.context, { roles: [...ROSTER_ROLES], requireMfa: true, classId, schoolYearId: built.schoolYearId })) {
      return { forbidden: true };
    }
    const runId = await recordRun(tx, {
      kind: 'class_roster', schoolYearId: built.schoolYearId, classId, formatVersion: ROSTER_FORMAT_VERSION,
      actorId, sha256: built.sha256, rowCounts: built.rowCounts,
    });
    return { ...built, runId };
  });
  if (result.notFound) return json({ error: 'class_not_found' }, 404);
  if (result.forbidden) return json({ error: 'forbidden' }, 403);

  return attachment(result.body, `rd-lista-klasy-${safeFilePart(classId)}-v${ROSTER_FORMAT_VERSION}.json`, {
    'X-Export-Run-Id': result.runId,
    'X-Export-Manifest-Sha256': result.sha256,
  });
}

export async function handle(request, env, url, json) {
  const isYearly = url.pathname === '/api/exports';
  const isRoster = url.pathname === '/api/exports/class-roster';
  if (!isYearly && !isRoster) return null;
  if (isYearly && request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  if (isRoster && request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
  // handlePgRequest sprawdza Origin wcześniej; tu powtórnie, gdyby moduł użyto samodzielnie.
  if (isYearly && !isSameOrigin(request)) return json({ error: 'invalid_origin' }, 403);

  try {
    if (isYearly) return await createYearlyExport(request, env, json);
    return await exportClassRoster(request, env, url, json);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.code }, error.status);
    throw error;
  }
}
