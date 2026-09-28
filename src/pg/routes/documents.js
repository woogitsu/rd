// Prywatne dokumenty w Railway Storage Bucket (issue #39, #8). Prototyp.
//
//   POST /api/documents?kind=…&schoolYearId=…[&classId=…][&linkedEntityType=…&linkedEntityId=…]
//        ciało = surowe bajty pliku, nagłówki Content-Type i Idempotency-Key
//   GET  /api/documents?schoolYearId=…[&kind=…][&classId=…][&q=…][&category=…][&limit=…][&offset=…]
//   GET  /api/documents/{id}            metadane (z historią opisu)
//   GET  /api/documents/{id}/content    pobranie przez serwer (proxy) po autoryzacji
//   POST /api/documents/{id}/description  tytuł, kategoria, data dokumentu (issue #76)
//
// Autoryzacja jest liczona dla KAŻDEGO dokumentu na podstawie jego rodzaju,
// roku i klasy. Nieznany identyfikator i dokument niedostępny dla użytkownika
// dają tę samą odpowiedź 404 (brak wyroczni istnienia) — także dla opisu.
//
// Macierz poniżej to założenie techniczne do zatwierdzenia (D-08, D-09):
// dyrekcja (`principal`) i Komisja Rewizyjna (`audit`) nie mają dostępu.

import { isAuthorized, loadAuthorizationContext } from '../authorization.js';
import { insertAuditEvent } from '../audit.js';
import { isoTimestamp } from '../auth.js';
import { sha256Hex } from '../../storage.js';
import {
  ALLOWED_TYPES, declaredType, detectType, downloadFilename, maxUploadBytes, newObjectKey, readLimited, UPLOAD_PATH,
  validateStructure,
} from '../../documents.js';

// Lista zamknięta — założenie techniczne do zatwierdzenia przez zarząd i
// skarbnika (issue #76, sekcja „Zależności”), niezależna od `kind`.
export const DOCUMENT_CATEGORIES = Object.freeze([
  'faktura', 'potwierdzenie_przelewu', 'wyciag', 'protokol', 'uchwala',
  'umowa', 'regulamin', 'sprawozdanie_rewizyjne', 'inne',
]);
const MAX_DESCRIPTION_BODY_BYTES = 4096;

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
const DESCRIPTION_PATH = /^\/api\/documents\/([^/]+)\/description$/;
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
    // Najnowsza wersja opisu (issue #76); null = brak wpisu ("Bez tytułu" w panelu).
    title: row.description_title ?? null,
    category: row.description_category ?? null,
    documentDate: row.description_document_date ?? null,
  };
}

function toDescription(row) {
  return {
    documentId: row.document_id,
    revisionNo: row.revision_no,
    title: row.title,
    category: row.category,
    documentDate: row.document_date ?? null,
    description: row.description ?? null,
    createdBy: row.created_by,
    createdAt: isoTimestamp(row.created_at),
  };
}

const SELECT_DOCUMENT = `SELECT d.id, d.object_key, d.kind, d.school_year_id, d.class_id, d.mime_type, d.byte_size,
       d.sha256, d.linked_entity_type, d.linked_entity_id, d.created_by, d.created_at, d.idempotency_key,
       dd.title AS description_title, dd.category AS description_category,
       to_char(dd.document_date, 'YYYY-MM-DD') AS description_document_date
  FROM documents d
  LEFT JOIN LATERAL (
    SELECT title, category, document_date, description FROM document_descriptions
     WHERE document_id = d.id ORDER BY revision_no DESC LIMIT 1
  ) dd ON true`;

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
  const descriptionMatch = DESCRIPTION_PATH.exec(url.pathname);
  if (descriptionMatch) {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
    return createDescription(request, env, descriptionMatch[1], json);
  }
  const match = DOCUMENT_PATH.exec(url.pathname);
  if (!match) return null;
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
  return match[2] ? download(request, env, match[1], json) : metadata(request, env, match[1], json);
}

// Ładuje dokument i sprawdza dostęp. null = 404 (nieznany LUB niedozwolony).
async function authorizedDocument(env, context, id, { auditDenied }) {
  if (!UUID.test(id)) return null;
  const row = (await env.db.query(`${SELECT_DOCUMENT} WHERE d.id = $1`, [id])).rows[0];
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
  const history = await env.db.query(
    `SELECT document_id, revision_no, title, category, to_char(document_date, 'YYYY-MM-DD') AS document_date,
            description, created_by, created_at
       FROM document_descriptions WHERE document_id = $1 ORDER BY revision_no DESC`,
    [id],
  );
  return json({ document: found.doc, descriptionHistory: history.rows.map(toDescription) });
}

async function download(request, env, id, json) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) return json({ error: 'unauthenticated' }, 401);
  if (!env.storage) return json({ error: 'storage_unavailable' }, 503);
  const found = await authorizedDocument(env, context, id, { auditDenied: true });
  if (!found) return json({ error: 'not_found' }, 404);
  const { doc, objectKey } = found;

  let object;
  try {
    object = await env.storage.getObject(objectKey);
  } catch (error) {
    // Wiersz documents istnieje, ale obiektu nie ma w buckecie (#168): to
    // rozstrzygnięty, trwały stan („brak treści”), nie awaria bucketu —
    // odróżniamy go od storage_unreachable (503 z Retry-After, niżej bez zmian).
    if (error?.code === 'storage_object_not_found') {
      await insertAuditEvent(env.db, {
        actorId: context.session.user.id, action: 'document.content_missing', entityType: 'document', entityId: doc.id,
        metadata: { kind: doc.kind, schoolYearId: doc.schoolYearId, classId: doc.classId, sessionId: context.session.sessionId },
      });
      return json({ error: 'document_content_missing' }, 409);
    }
    throw error;
  }
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
  const categoryFilter = url.searchParams.get('category');
  if (categoryFilter && !DOCUMENT_CATEGORIES.includes(categoryFilter)) return json({ error: 'invalid_category' }, 400);
  const rawQuery = url.searchParams.get('q');
  if (rawQuery !== null && rawQuery.length > 200) return json({ error: 'invalid_request' }, 400);
  // Ucieczka znaków specjalnych ILIKE, żeby "%"/"_" w wyszukiwanej frazie nie działały jako wieloznaczniki.
  const searchQuery = rawQuery ? rawQuery.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`) : '';
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

  // Wyszukiwanie i filtr kategorii zawężają zapytanie w SQL, PRZED LIMIT
  // (issue #76 wprost pilnuje tego, by pełna strona znaczyła realne wyniki).
  const { rows } = await env.db.query(
    `${SELECT_DOCUMENT}
      WHERE d.school_year_id = $1
        AND (d.kind = ANY($2::text[]) OR (d.kind = 'class' AND ($3::boolean OR d.class_id = ANY($4::text[]))))
        AND ($5::text IS NULL OR d.kind = $5)
        AND ($6::text IS NULL OR d.class_id = $6)
        AND ($9::text IS NULL OR dd.category = $9)
        AND ($10::text IS NULL OR dd.title ILIKE '%' || $10 || '%' OR dd.description ILIKE '%' || $10 || '%')
      ORDER BY d.created_at DESC, d.id
      LIMIT $7 OFFSET $8`,
    [schoolYearId, unscopedKinds, allClasses, ownClasses, kindFilter || null, classFilter.value, limit, offset,
      categoryFilter || null, searchQuery || null],
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
  // Kontrola struktury (issue #89): heurystyka przed zapisem do bucketu —
  // walidacja odrzuca plik zanim putObject zostanie wywołane.
  const structure = validateStructure(bytes, detected);
  if (!structure.ok) return json({ error: structure.code }, 415);
  const sha256 = sha256Hex(bytes);
  const actorId = context.session.user.id;

  const replay = await findReplay(env.db, idempotencyKey, { actorId, sha256, ...target, linkedEntityType, linkedEntityId: linkedEntityId.value }, env.storage);
  if (replay) {
    if (replay.contentMissing) return json({ error: 'document_content_missing' }, 409);
    return replay.conflict ? json({ error: 'idempotency_conflict' }, 409) : json({ document: replay.doc, replayed: true }, 200);
  }

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
  const uploadId = crypto.randomUUID();
  // Zamiar uploadu zapisany PRZED wysłaniem obiektu do bucketu (#168): każdy
  // obiekt, który trafi do bucketu, ma od razu wpis z aktorem i czasem, więc
  // nic nie zostaje osierocone bez śladu (zadanie porządkowe: scripts/
  // document-uploads-cleanup.js).
  await env.db.query(
    `INSERT INTO document_uploads (id, object_key, idempotency_key, sha256, byte_size, mime_type, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [uploadId, objectKey, idempotencyKey, sha256, bytes.length, detected, actorId],
  );
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
      await tx.query(
        `UPDATE document_uploads SET state = 'committed', resolved_at = now(), resolution = 'committed'
           WHERE id = $1 AND state = 'pending'`,
        [uploadId],
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
    if (error?.code === '23505') {
      // Równoległe podwójne kliknięcie: drugi zapis przegrał wyścig o klucz.
      // Wiersz documents istnieje (z drugiego żądania) — nie usuwamy naszego
      // obiektu na ślepo, tylko sprawdzamy stan poniżej jak przy każdym błędzie.
      const again = await findReplay(env.db, idempotencyKey, { actorId, sha256, ...target, linkedEntityType, linkedEntityId: linkedEntityId.value }, env.storage);
      if (again) {
        await env.storage.deleteObject?.(objectKey).catch(() => {});
        await env.db.query(
          `UPDATE document_uploads SET state = 'abandoned', resolved_at = now(), resolution = 'duplicate_idempotency_key'
             WHERE id = $1 AND state = 'pending'`,
          [uploadId],
        ).catch(() => {});
        if (again.contentMissing) return json({ error: 'document_content_missing' }, 409);
        return again.conflict ? json({ error: 'idempotency_conflict' }, 409) : json({ document: again.doc, replayed: true }, 200);
      }
    }
    // Rok zamknięty (0017_year_close.sql, trigger a0_year_freeze, rozszerzony
    // w #80 na documents) — stan, nie awaria bazy (#156). Jednoznaczne: trigger
    // odrzuca INSERT przed zatwierdzeniem, więc transakcja na pewno się
    // wycofała — bez niejednoznaczności, którą rozstrzyga blok #168 niżej.
    if (String(error?.message ?? '').includes('school_year_closed')) {
      await env.storage.deleteObject?.(objectKey).catch(() => {});
      await env.db.query(
        `UPDATE document_uploads SET state = 'abandoned', resolved_at = now(), resolution = 'school_year_closed'
           WHERE id = $1 AND state = 'pending'`,
        [uploadId],
      ).catch(() => {});
      return json({ error: 'school_year_closed' }, 409);
    }
    // Utracone potwierdzenie COMMIT (#168): błąd z transakcji nie znaczy, że
    // się wycofała — połączenie mogło zerwać się PO zatwierdzeniu. Zanim
    // usuniemy obiekt, świeżym zapytaniem sprawdzamy, czy wiersz jednak
    // powstał:
    //  - jest -> transakcja się zatwierdziła; nic nie usuwamy, zwracamy sukces.
    //  - zapytanie się udało i wiersza nie ma -> naprawdę się wycofała; obiekt
    //    można bezpiecznie usunąć i oznaczyć upload jako porzucony.
    //  - zapytania nie da się wykonać (baza nadal nie odpowiada) -> nie
    //    wiadomo; zostawiamy obiekt i wpis „pending” zadaniu porządkowemu.
    let confirmed;
    try {
      confirmed = await env.db.query(`${SELECT_DOCUMENT} WHERE d.id = $1`, [id]);
    } catch {
      throw error;
    }
    const confirmedRow = confirmed.rows[0];
    if (confirmedRow) return json({ document: toDocument(confirmedRow) }, 201);
    await env.storage.deleteObject?.(objectKey).catch(() => {});
    await env.db.query(
      `UPDATE document_uploads SET state = 'abandoned', resolved_at = now(), resolution = 'insert_rolled_back'
         WHERE id = $1 AND state = 'pending'`,
      [uploadId],
    ).catch(() => {});
    throw error;
  }
}

async function findReplay(db, idempotencyKey, expected, storage) {
  const row = (await db.query(`${SELECT_DOCUMENT} WHERE d.idempotency_key = $1`, [idempotencyKey])).rows[0];
  if (!row) return null;
  const doc = toDocument(row);
  const same = row.created_by === expected.actorId && doc.sha256 === expected.sha256 && doc.kind === expected.kind
    && doc.schoolYearId === expected.schoolYearId && doc.classId === expected.classId
    && doc.linkedEntityType === expected.linkedEntityType && doc.linkedEntityId === expected.linkedEntityId;
  if (!same) return { conflict: true };
  // Ponowienie nie może zwrócić „sukces”, jeśli obiektu nie ma w buckecie
  // (#168) — inaczej panel pokazuje sukces dla dokumentu, którego nie da się
  // pobrać.
  if (storage && !(await storage.headObject(row.object_key))) return { contentMissing: true };
  return { doc };
}

const DOCUMENT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validDocumentDate(value) {
  if (!DOCUMENT_DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function parseDescriptionInput(body) {
  if (!body || typeof body !== 'object') return { error: 'invalid_request' };
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (title.length < 3 || title.length > 200) return { error: 'invalid_title' };
  const category = body.category;
  if (typeof category !== 'string' || !DOCUMENT_CATEGORIES.includes(category)) return { error: 'invalid_category' };
  let documentDate = null;
  if (body.documentDate !== undefined && body.documentDate !== null && body.documentDate !== '') {
    if (typeof body.documentDate !== 'string' || !validDocumentDate(body.documentDate)) return { error: 'invalid_document_date' };
    documentDate = body.documentDate;
  }
  let description = null;
  if (body.description !== undefined && body.description !== null && body.description !== '') {
    if (typeof body.description !== 'string') return { error: 'invalid_description' };
    const trimmed = body.description.trim();
    if (!trimmed || trimmed.length > 1000) return { error: 'invalid_description' };
    description = trimmed;
  }
  return { value: { title, category, documentDate, description } };
}

async function readDescriptionBody(request) {
  const type = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') return { error: 'invalid_content_type' };
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DESCRIPTION_BODY_BYTES) return { error: 'request_too_large' };
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_DESCRIPTION_BODY_BYTES) return { error: 'request_too_large' };
  try {
    return { value: text ? JSON.parse(text) : {} };
  } catch {
    return { error: 'invalid_json' };
  }
}

// Dodaje nową wersję opisu (tytuł, kategoria, data dokumentu — issue #76).
// documents jest niezmienne (0006); document_descriptions jest dopisywane —
// zmiana opisu to zawsze NOWY wiersz, nigdy edycja poprzedniego.
async function createDescription(request, env, id, json) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) return json({ error: 'unauthenticated' }, 401);
  if (!UUID.test(id)) return json({ error: 'not_found' }, 404);

  const idempotencyKey = (request.headers.get('idempotency-key') ?? '').trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 128) return json({ error: 'idempotency_key_required' }, 400);

  const body = await readDescriptionBody(request);
  if (body.error) return json({ error: body.error }, body.error === 'request_too_large' ? 413 : 400);
  const parsed = parseDescriptionInput(body.value);
  if (parsed.error) return json({ error: parsed.error }, 400);
  const input = parsed.value;
  const actorId = context.session.user.id;

  const sameInput = (row) => row.title === input.title && row.category === input.category
    && (row.document_date ?? null) === input.documentDate && (row.description ?? null) === input.description;

  try {
    const result = await env.db.transaction(async (tx) => {
      // Blokada wiersza documents: serializuje równoległe zapisy opisu tego
      // samego dokumentu, więc numer wersji (MAX + 1) jest bezpieczny.
      const { rows } = await tx.query(
        `SELECT id, kind, school_year_id, class_id FROM documents WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const doc = rows[0];
      if (!doc || !canAccessDocument(context, { kind: doc.kind, schoolYearId: doc.school_year_id, classId: doc.class_id })) {
        return { notFound: true };
      }
      const existing = (await tx.query(
        `SELECT document_id, revision_no, title, category, to_char(document_date, 'YYYY-MM-DD') AS document_date,
                description, created_by, created_at, idempotency_key
           FROM document_descriptions WHERE idempotency_key = $1`, [idempotencyKey],
      )).rows[0];
      if (existing) {
        if (existing.document_id !== id || !sameInput(existing)) return { conflict: true };
        return { replayed: toDescription(existing) };
      }
      const nextRevision = Number((await tx.query(
        'SELECT COALESCE(MAX(revision_no), 0) + 1 AS next FROM document_descriptions WHERE document_id = $1', [id],
      )).rows[0].next);
      const inserted = (await tx.query(
        `INSERT INTO document_descriptions (document_id, revision_no, title, category, document_date, description, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING document_id, revision_no, title, category, to_char(document_date, 'YYYY-MM-DD') AS document_date,
                   description, created_by, created_at`,
        [id, nextRevision, input.title, input.category, input.documentDate, input.description, actorId, idempotencyKey],
      )).rows[0];
      // Bez tytułu w metadanych (issue #76, "Kryteria akceptacji"): tytuł
      // może zawierać opisową treść dokumentu, dlatego dziennik dostaje tylko
      // identyfikatory, kategorię i numer wersji.
      await insertAuditEvent(tx, {
        actorId, action: 'document.described', entityType: 'document', entityId: id,
        metadata: {
          kind: doc.kind, schoolYearId: doc.school_year_id, classId: doc.class_id,
          category: input.category, revisionNo: nextRevision, sessionId: context.session.sessionId,
        },
      });
      return { created: toDescription(inserted) };
    });
    if (result.notFound) return json({ error: 'not_found' }, 404);
    if (result.conflict) return json({ error: 'idempotency_conflict' }, 409);
    if (result.replayed) return json({ description: result.replayed, replayed: true }, 200);
    return json({ description: result.created }, 201);
  } catch (error) {
    if (error?.code === '23505') {
      // Równoległe podwójne kliknięcie: drugi zapis przegrał wyścig o klucz idempotencji.
      const existing = (await env.db.query(
        `SELECT document_id, revision_no, title, category, to_char(document_date, 'YYYY-MM-DD') AS document_date,
                description, created_by, created_at, idempotency_key
           FROM document_descriptions WHERE idempotency_key = $1`, [idempotencyKey],
      )).rows[0];
      if (existing) {
        if (existing.document_id !== id || !sameInput(existing)) return json({ error: 'idempotency_conflict' }, 409);
        return json({ description: toDescription(existing), replayed: true }, 200);
      }
    }
    // Uwaga (poza zakresem tego PR): document_descriptions NIE ma jeszcze
    // triggera zamrożenia roku (a0_year_freeze/0036) — dodanie opisu do
    // dokumentu z zamkniętego roku szkolnego jest dziś możliwe. Zamierzone
    // rozszerzenie year_freeze_via_parent wymaga wyjścia od jego najnowszej
    // wersji na origin/main (fix-common.md) i osobnego PR, żeby nie
    // powtórzyć incydentu z #279.
    throw error;
  }
}
