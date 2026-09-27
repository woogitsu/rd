// Prywatne dokumenty w Railway Storage Bucket (issue #39, #8). Prototyp.
//
//   POST /api/documents?kind=…&schoolYearId=…[&classId=…][&linkedEntityType=…&linkedEntityId=…]
//        ciało = surowe bajty pliku, nagłówki Content-Type i Idempotency-Key
//   GET  /api/documents?schoolYearId=…[&kind=…][&classId=…][&limit=…][&offset=…]
//   GET  /api/documents/{id}            metadane
//   GET  /api/documents/{id}/content    pobranie przez serwer (proxy) po autoryzacji
//
// Autoryzacja jest liczona dla KAŻDEGO dokumentu na podstawie jego rodzaju,
// roku i klasy. Nieznany identyfikator i dokument niedostępny dla użytkownika
// dają tę samą odpowiedź 404 (brak wyroczni istnienia).
//
// Macierz poniżej to założenie techniczne do zatwierdzenia (D-08, D-09):
// dyrekcja (`principal`) i Komisja Rewizyjna (`audit`) nie mają dostępu.

import { isAuthorized, loadAuthorizationContext } from '../authorization.js';
import { insertAuditEvent } from '../audit.js';
import { isoTimestamp } from '../auth.js';
import { sha256Hex } from '../../storage.js';
import {
  ALLOWED_TYPES, declaredType, detectType, downloadFilename, maxUploadBytes, newObjectKey, readLimited, UPLOAD_PATH,
} from '../../documents.js';

export const name = 'documents';

export const DOCUMENT_POLICIES = Object.freeze({
  // Dowody finansowe: jak zapis księgi — MFA i role finansowe.
  financial: Object.freeze({ roles: ['admin', 'board', 'treasurer'], requireMfa: true, classScoped: false }),
  // Dokumenty zarządu (protokoły, uchwały): bez przedstawicieli klas.
  board: Object.freeze({ roles: ['admin', 'board'], requireMfa: false, classScoped: false }),
  // Materiały jednej klasy: przedstawiciel wyłącznie własnej klasy.
  class: Object.freeze({ roles: ['admin', 'board', 'representative'], requireMfa: false, classScoped: true }),
});

const LINK_TABLES = Object.freeze({ ledger_entry: 'ledger_entries', payment_entry: 'payment_entries' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DOCUMENT_PATH = /^\/api\/documents\/([^/]+)(\/content)?$/;
const MAX_LIST_LIMIT = 100;
const MAX_OFFSET = 10_000;

const DOWNLOAD_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "sandbox; default-src 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
});

// Czy kontekst (sesja + aktywne przydziały) pozwala na dostęp do dokumentu.
// Dla dokumentów bez klasy liczą się wyłącznie przydziały bez ograniczenia
// do klasy — przydział klasowy nie otwiera dokumentów całej Rady.
export function canAccessDocument(context, doc) {
  const policy = DOCUMENT_POLICIES[doc?.kind];
  if (!policy || !doc.schoolYearId) return false;
  if (policy.classScoped !== Boolean(doc.classId)) return false;
  const requirement = { roles: policy.roles, requireMfa: policy.requireMfa, schoolYearId: doc.schoolYearId };
  if (policy.classScoped) return isAuthorized(context, { ...requirement, classId: doc.classId });
  return isAuthorized({ ...context, grants: context.grants.filter((grant) => !grant.classId) }, requirement);
}

function toDocument(row) {
  return {
    id: row.id,
    kind: row.kind,
    schoolYearId: row.school_year_id ?? null,
    classId: row.class_id ?? null,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    sha256: row.sha256 ?? null,
    linkedEntityType: row.linked_entity_type ?? null,
    linkedEntityId: row.linked_entity_id ?? null,
    createdBy: row.created_by,
    createdAt: isoTimestamp(row.created_at),
  };
}

const SELECT_DOCUMENT = `SELECT id, object_key, kind, school_year_id, class_id, mime_type, byte_size, sha256,
       linked_entity_type, linked_entity_id, created_by, created_at, idempotency_key
  FROM documents`;

function optionalId(value) {
  if (value === null || value === '') return { ok: true, value: null };
  return SAFE_ID.test(value) ? { ok: true, value } : { ok: false };
}

export async function handle(request, env, url, json) {
  if (url.pathname === UPLOAD_PATH) {
    if (request.method === 'POST') return upload(request, env, url, json);
    if (request.method === 'GET') return list(request, env, url, json);
    return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET, POST' });
  }
  const match = DOCUMENT_PATH.exec(url.pathname);
  if (!match) return null;
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
  return match[2] ? download(request, env, match[1], json) : metadata(request, env, match[1], json);
}

// Ładuje dokument i sprawdza dostęp. null = 404 (nieznany LUB niedozwolony).
async function authorizedDocument(env, context, id, { auditDenied }) {
  if (!UUID.test(id)) return null;
  const row = (await env.db.query(`${SELECT_DOCUMENT} WHERE id = $1`, [id])).rows[0];
  if (!row) return null;
  const doc = toDocument(row);
  if (!canAccessDocument(context, doc)) {
    if (auditDenied) {
      await insertAuditEvent(env.db, {
        actorId: context.session.user.id, action: 'document.access_denied', entityType: 'document', entityId: doc.id,
        metadata: { kind: doc.kind, sessionId: context.session.sessionId },
      });
    }
    return null;
  }
  return { doc, objectKey: row.object_key };
}

async function metadata(request, env, id, json) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) return json({ error: 'unauthenticated' }, 401);
  const found = await authorizedDocument(env, context, id, { auditDenied: false });
  if (!found) return json({ error: 'not_found' }, 404);
  return json({ document: found.doc });
}

async function download(request, env, id, json) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) return json({ error: 'unauthenticated' }, 401);
  if (!env.storage) return json({ error: 'storage_unavailable' }, 503);
  const found = await authorizedDocument(env, context, id, { auditDenied: true });
  if (!found) return json({ error: 'not_found' }, 404);
  const { doc, objectKey } = found;

  const object = await env.storage.getObject(objectKey);
  // Integralność: obiekt musi odpowiadać zapisanemu rozmiarowi i skrótowi.
  if (object.body.length !== doc.byteSize || (doc.sha256 && sha256Hex(object.body) !== doc.sha256)) {
    const error = new Error('document_integrity_mismatch');
    error.code = 'document_integrity_mismatch';
    throw error;
  }
  // Dziennik odczytu przed wydaniem treści; błąd zapisu = brak pobrania.
  await insertAuditEvent(env.db, {
    actorId: context.session.user.id, action: 'document.downloaded', entityType: 'document', entityId: doc.id,
    metadata: { kind: doc.kind, schoolYearId: doc.schoolYearId, classId: doc.classId, sessionId: context.session.sessionId },
  });
  return new Response(object.body, {
    status: 200,
    headers: {
      ...DOWNLOAD_HEADERS,
      'Content-Type': doc.mimeType,
      'Content-Length': String(object.body.length),
      'Content-Disposition': `attachment; filename="${downloadFilename(doc.id, doc.mimeType)}"`,
    },
  });
}

async function list(request, env, url, json) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) return json({ error: 'unauthenticated' }, 401);
  const schoolYearId = url.searchParams.get('schoolYearId');
  if (!schoolYearId || !SAFE_ID.test(schoolYearId)) return json({ error: 'invalid_school_year' }, 400);
  const kindFilter = url.searchParams.get('kind');
  if (kindFilter && !DOCUMENT_POLICIES[kindFilter]) return json({ error: 'invalid_kind' }, 400);
  const classFilter = optionalId(url.searchParams.get('classId'));
  if (!classFilter.ok) return json({ error: 'invalid_class' }, 400);
  const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), MAX_LIST_LIMIT);
  const offset = Math.min(Math.max(Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0), MAX_OFFSET);

  // Zakres widoczności z przydziałów; SQL zawęża, a canAccessDocument
  // sprawdza jeszcze każdy wiersz (obrona w głąb).
  const unscopedKinds = Object.entries(DOCUMENT_POLICIES)
    .filter(([, policy]) => !policy.classScoped)
    .filter(([kind]) => canAccessDocument(context, { kind, schoolYearId, classId: null }))
    .map(([kind]) => kind);
  const classPolicy = DOCUMENT_POLICIES.class;
  const allClasses = isAuthorized(
    { ...context, grants: context.grants.filter((grant) => !grant.classId) },
    { roles: classPolicy.roles, requireMfa: classPolicy.requireMfa, schoolYearId },
  );
  // DOC-01: przydział klasowy liczy się tylko w swoim roku (i z MFA, jeśli rodzaj go wymaga) —
  // przydział z innego roku nie może zamienić odmowy (403) w pustą listę.
  const ownClasses = [...new Set(context.grants
    .filter((grant) => grant.classId && isAuthorized(
      { ...context, grants: [grant] },
      { roles: classPolicy.roles, requireMfa: classPolicy.requireMfa, schoolYearId, classId: grant.classId },
    ))
    .map((grant) => grant.classId))];
  if (!unscopedKinds.length && !allClasses && !ownClasses.length) return json({ error: 'forbidden' }, 403);

  const { rows } = await env.db.query(
    `${SELECT_DOCUMENT}
      WHERE school_year_id = $1
        AND (kind = ANY($2::text[]) OR (kind = 'class' AND ($3::boolean OR class_id = ANY($4::text[]))))
        AND ($5::text IS NULL OR kind = $5)
        AND ($6::text IS NULL OR class_id = $6)
      ORDER BY created_at DESC, id
      LIMIT $7 OFFSET $8`,
    [schoolYearId, unscopedKinds, allClasses, ownClasses, kindFilter || null, classFilter.value, limit, offset],
  );
  const documents = rows.map(toDocument).filter((doc) => canAccessDocument(context, doc));
  return json({ documents, limit, offset });
}

function tooLarge(json) {
  return json({ error: 'document_too_large' }, 413);
}

async function upload(request, env, url, json) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) return json({ error: 'unauthenticated' }, 401);

  const kind = url.searchParams.get('kind');
  const policy = DOCUMENT_POLICIES[kind];
  if (!policy) return json({ error: 'invalid_kind' }, 400);
  const schoolYearId = url.searchParams.get('schoolYearId');
  if (!schoolYearId || !SAFE_ID.test(schoolYearId)) return json({ error: 'invalid_school_year' }, 400);
  const classId = optionalId(url.searchParams.get('classId'));
  if (!classId.ok || policy.classScoped !== Boolean(classId.value)) return json({ error: 'invalid_class' }, 400);
  const linkedEntityType = url.searchParams.get('linkedEntityType') || null;
  const linkedEntityId = optionalId(url.searchParams.get('linkedEntityId'));
  if (!linkedEntityId.ok || Boolean(linkedEntityType) !== Boolean(linkedEntityId.value)
      || (linkedEntityType && (!LINK_TABLES[linkedEntityType] || kind !== 'financial'))) {
    return json({ error: 'invalid_link' }, 400);
  }
  const idempotencyKey = (request.headers.get('idempotency-key') ?? '').trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 128) return json({ error: 'idempotency_key_required' }, 400);

  // Uprawnienie do zapisu = uprawnienie do odczytu danego rodzaju w tym roku/klasie.
  const target = { kind, schoolYearId, classId: classId.value };
  if (!canAccessDocument(context, target)) return json({ error: 'forbidden' }, 403);
  if (!env.storage) return json({ error: 'storage_unavailable' }, 503);

  const limit = maxUploadBytes(env.documentMaxBytes);
  const declared = declaredType(request.headers.get('content-type'));
  if (!ALLOWED_TYPES[declared]) {
    // Nie czytamy ciała niedozwolonego typu, ale nadal pilnujemy limitu.
    if (Number(request.headers.get('content-length')) > limit) return tooLarge(json);
    return json({ error: 'unsupported_media_type' }, 415);
  }
  let bytes;
  try {
    bytes = await readLimited(request, limit);
  } catch (error) {
    if (error instanceof RangeError) return tooLarge(json);
    throw error;
  }
  if (!bytes.length) return json({ error: 'empty_document' }, 400);
  const detected = detectType(bytes);
  if (!detected || detected !== declared) return json({ error: 'unsupported_media_type' }, 415);
  const sha256 = sha256Hex(bytes);
  const actorId = context.session.user.id;

  const replay = await findReplay(env.db, idempotencyKey, { actorId, sha256, ...target, linkedEntityType, linkedEntityId: linkedEntityId.value });
  if (replay) return replay.conflict ? json({ error: 'idempotency_conflict' }, 409) : json({ document: replay.doc, replayed: true }, 200);

  // Rok, klasa i powiązany wpis muszą istnieć i należeć do tego samego roku.
  const year = await env.db.query('SELECT 1 FROM school_years WHERE id = $1', [schoolYearId]);
  if (!year.rows[0]) return json({ error: 'invalid_school_year' }, 400);
  if (classId.value) {
    const cls = await env.db.query('SELECT 1 FROM classes WHERE id = $1 AND school_year_id = $2', [classId.value, schoolYearId]);
    if (!cls.rows[0]) return json({ error: 'invalid_class' }, 400);
  }
  if (linkedEntityType) {
    const linked = await env.db.query(
      `SELECT 1 FROM ${LINK_TABLES[linkedEntityType]} WHERE id = $1 AND school_year_id = $2`,
      [linkedEntityId.value, schoolYearId],
    );
    if (!linked.rows[0]) return json({ error: 'invalid_link' }, 400);
  }

  const id = crypto.randomUUID();
  const objectKey = newObjectKey();
  await env.storage.putObject(objectKey, bytes, detected);
  try {
    const row = await env.db.transaction(async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by, school_year_id, class_id,
                                linked_entity_type, linked_entity_id, sha256, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, kind, school_year_id, class_id, mime_type, byte_size, sha256,
                   linked_entity_type, linked_entity_id, created_by, created_at`,
        [id, objectKey, detected, bytes.length, kind, actorId, schoolYearId, classId.value,
          linkedEntityType, linkedEntityId.value, sha256, idempotencyKey],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'document.uploaded', entityType: 'document', entityId: id,
        metadata: {
          kind, schoolYearId, classId: classId.value, mimeType: detected, byteSize: bytes.length, sha256,
          linkedEntityType, linkedEntityId: linkedEntityId.value, sessionId: context.session.sessionId,
        },
      });
      return rows[0];
    });
    return json({ document: toDocument(row) }, 201);
  } catch (error) {
    // Obiekt bez wpisu w bazie nie jest dokumentem — sprzątamy go (best effort).
    await env.storage.deleteObject?.(objectKey).catch(() => {});
    if (error?.code === '23505') {
      // Równoległe podwójne kliknięcie: drugi zapis przegrał wyścig o klucz.
      const again = await findReplay(env.db, idempotencyKey, { actorId, sha256, ...target, linkedEntityType, linkedEntityId: linkedEntityId.value });
      if (again) return again.conflict ? json({ error: 'idempotency_conflict' }, 409) : json({ document: again.doc, replayed: true }, 200);
    }
    throw error;
  }
}

async function findReplay(db, idempotencyKey, expected) {
  const row = (await db.query(`${SELECT_DOCUMENT} WHERE idempotency_key = $1`, [idempotencyKey])).rows[0];
  if (!row) return null;
  const doc = toDocument(row);
  const same = row.created_by === expected.actorId && doc.sha256 === expected.sha256 && doc.kind === expected.kind
    && doc.schoolYearId === expected.schoolYearId && doc.classId === expected.classId
    && doc.linkedEntityType === expected.linkedEntityType && doc.linkedEntityId === expected.linkedEntityId;
  return same ? { doc } : { conflict: true };
}
