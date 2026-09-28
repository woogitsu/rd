// Aktualności i galeria na PostgreSQL (#14). Prototyp na danych syntetycznych.
//
// Wpis: szkic -> zgłoszenie -> zatwierdzenie (cztery oczy) -> publikacja;
// wycofanie jest stanem końcowym. Zdjęcie: rejestracja metadanych (autor,
// źródło, data, podpis licencyjny, odwołania do zgód) -> weryfikacja praw
// przez inną osobę niż rejestrująca -> ewentualne cofnięcie praw.
// Plik zdjęcia leży w prywatnym magazynie dokumentów (document_id); ten moduł
// nie przechowuje ani nie udostępnia plików.
//
// Plik obrazu galerii (#96, osobno od document_id powyżej): POST
// /api/news-photos/:id/file przyjmuje surowe bajty PNG/JPEG, ponownie
// koduje je przez `sharp` (odrzuca EXIF/GPS/XMP — sharp domyślnie nie
// przepisuje metadanych wejścia na wyjście) i zapisuje wyłącznie warianty
// `web`/`thumb` pod osobnym prefiksem `photos/` w tym samym prywatnym
// buckecie co dokumenty. WARIANT ZACHOWAWCZY (brak D-18/D-04/D-05): oryginał
// NIE jest przechowywany. Publiczny odczyt (GET /api/public/news-photos/
// :id/:variant) działa tylko dla zdjęć zweryfikowanych i należących do
// opublikowanej wersji niewycofanego wpisu (postgres/migrations/0084).
//
// Polityka ról jest ZAŁOŻENIEM do decyzji D-08 i D-18 (docs/DECISIONS.md):
// - szkic, zmiana, zgłoszenie, podgląd: admin i zarząd (przydział bez klasy)
//   albo przedstawiciel klasy dla wpisu własnej klasy (bez zdjęć);
// - zatwierdzenie, publikacja, wycofanie opublikowanego: zarząd;
// - rejestracja zdjęć i przesłanie pliku: admin i zarząd; weryfikacja i
//   cofnięcie praw: zarząd.
import sharp from 'sharp';
import { isSameOrigin } from '../auth.js';
import { isAuthorized } from '../authorization.js';
import { declaredType, detectType, readLimited, validateStructure } from '../documents.js';
import { sha256Hex } from '../storage.js';
import { insertAuditEvent } from './audit.js';

export const NEWS_POLICY = Object.freeze({
  draftSchoolWide: Object.freeze(['admin', 'board']),
  draftClass: Object.freeze(['representative']),
  review: Object.freeze(['board']),
  photoRegister: Object.freeze(['admin', 'board']),
  photoVerify: Object.freeze(['board']),
});
export const PHOTO_SOURCES = Object.freeze([
  'own_work', 'school_provided', 'parent_provided', 'licensed_third_party', 'public_website_copy',
]);
// Publiczna odpowiedź może być buforowana najwyżej tyle sekund.
export const PUBLIC_CACHE_SECONDS = 60;

// Warianty pliku zdjęcia (#96): maksymalny wymiar (dłuższy bok) i jakość JPEG.
// Lista zamknięta — nowy wariant wymaga migracji (CHECK w
// postgres/migrations/0084_news_photo_files.sql).
export const PHOTO_FILE_VARIANTS = Object.freeze({
  web: Object.freeze({ maxDimension: 1600, quality: 82 }),
  thumb: Object.freeze({ maxDimension: 400, quality: 78 }),
});
const PHOTO_UPLOAD_TYPES = new Set(['image/png', 'image/jpeg']);
// Limit pliku ŹRÓDŁOWEGO przed dekodowaniem (niezależny od limitu dokumentów)
// — ochrona przed „bombami dekompresji” obrazu (issue #96, ryzyko zgłoszone
// w treści issue: pamięć przy dużych plikach). Eksportowany, bo src/server.js
// potrzebuje go, by podnieść limit ciała żądania Node tylko dla tej trasy.
export const PHOTO_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
// Limit wymiarów źródła przed dekodowaniem (megapiksele) — sharp odrzuca
// obraz większy bez pełnego zdekodowania dzięki `limitInputPixels`.
const PHOTO_UPLOAD_MAX_PIXELS = 40_000_000;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// Znaki sterujące poza tabulatorem i nową linią są odrzucane.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PHOTOS = 20;

export class NewsError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// ---------- uprawnienia ----------

function contextFor(actor, grants) {
  return { session: { user: { id: actor.userId }, mfaVerified: Boolean(actor.mfaVerified) }, grants };
}

function schoolWide(actor, roles, schoolYearId) {
  const grants = (actor?.grants ?? []).filter((g) => !g.classId);
  return isAuthorized(contextFor(actor, grants), { roles: [...roles], schoolYearId: schoolYearId ?? undefined });
}

function classScoped(actor, classId, schoolYearId) {
  if (!classId) return false;
  const grants = (actor?.grants ?? []).filter((g) => g.classId === classId);
  return isAuthorized(contextFor(actor, grants), { roles: [...NEWS_POLICY.draftClass], classId, schoolYearId });
}

function canEdit(actor, post) {
  return schoolWide(actor, NEWS_POLICY.draftSchoolWide, post.school_year_id)
    || classScoped(actor, post.class_id, post.school_year_id);
}

function canReview(actor, post) {
  return schoolWide(actor, NEWS_POLICY.review, post.school_year_id);
}

function canAttachPhotos(actor, post) {
  return schoolWide(actor, NEWS_POLICY.draftSchoolWide, post.school_year_id);
}

function canSeePhotos(actor) {
  return schoolWide(actor, NEWS_POLICY.photoRegister) || schoolWide(actor, NEWS_POLICY.photoVerify);
}

function requireActor(actor) {
  if (!actor?.userId || !Array.isArray(actor.grants)) throw new NewsError('unauthenticated', 401);
}

// ---------- walidacja ----------

function validId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

// Tekst jest przechowywany dosłownie (po ujednoliceniu końców linii i
// przycięciu). Nie jest to HTML: interfejs musi go wstawiać jako tekst
// (textContent) albo escapować przy renderowaniu.
function text(value, { min = 1, max, required = false, code, multiline = false }) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new NewsError(code);
    return null;
  }
  if (typeof value !== 'string') throw new NewsError(code);
  let normalized = value.replace(/\r\n?/g, '\n').trim();
  if (!multiline && normalized.includes('\n')) throw new NewsError(code);
  if (CONTROL_CHARS.test(normalized)) throw new NewsError(code);
  normalized = normalized.normalize('NFC');
  if (normalized.length < min || normalized.length > max) throw new NewsError(code);
  return normalized;
}

function reference(value, code, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new NewsError(code);
    return null;
  }
  if (!validId(value)) throw new NewsError(code);
  return value;
}

function count(value, code) {
  if (value === undefined || value === null) return 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) throw new NewsError(code);
  return value;
}

function parsePhotoIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_PHOTOS) throw new NewsError('invalid_photos');
  if (!value.every(validId)) throw new NewsError('invalid_photos');
  if (new Set(value).size !== value.length) throw new NewsError('duplicate_photo');
  return [...value];
}

function parseContent(input, base = null) {
  const pickField = (key) => (base && !(key in input) ? base[key] : input[key]);
  return {
    title: text(pickField('title'), { min: 3, max: 200, required: true, code: 'invalid_title' }),
    body: text(pickField('body'), { min: 1, max: 20000, required: true, code: 'invalid_body', multiline: true }),
    photoIds: parsePhotoIds(pickField('photoIds')),
  };
}

function readRevision(input) {
  if (!Number.isSafeInteger(input?.revision) || input.revision < 1) throw new NewsError('invalid_revision');
  return input.revision;
}

function sameContent(row, content) {
  return row.title === content.title && row.body === content.body
    && JSON.stringify(row.photo_ids ?? []) === JSON.stringify(content.photoIds);
}

function parseConsent(input, index) {
  if (!input || typeof input !== 'object') throw new NewsError('invalid_consent');
  const subjectNo = input.subjectNo ?? index + 1;
  if (!Number.isSafeInteger(subjectNo) || subjectNo < 1 || subjectNo > 200) throw new NewsError('invalid_consent');
  if (!['child', 'adult'].includes(input.subjectKind)) throw new NewsError('invalid_consent');
  return {
    subjectNo,
    subjectKind: input.subjectKind,
    consentDocumentRef: reference(input.consentDocumentRef, 'invalid_consent', { required: true }),
  };
}

function parsePhoto(input) {
  if (!input || typeof input !== 'object') throw new NewsError('invalid_request');
  const source = input.source;
  if (!PHOTO_SOURCES.includes(source)) throw new NewsError('invalid_source');
  if (typeof input.takenOn !== 'string' || !DATE_PATTERN.test(input.takenOn)
    || Number.isNaN(Date.parse(`${input.takenOn}T00:00:00Z`))
    || new Date(`${input.takenOn}T00:00:00Z`).toISOString().slice(0, 10) !== input.takenOn) {
    throw new NewsError('invalid_taken_on');
  }
  if (typeof input.depictsChildren !== 'boolean') throw new NewsError('invalid_depicts_children');
  if (input.explicitLicenseGranted !== undefined && typeof input.explicitLicenseGranted !== 'boolean') {
    throw new NewsError('invalid_explicit_license');
  }
  const photo = {
    documentId: reference(input.documentId, 'invalid_document_id', { required: true }),
    author: text(input.author, { min: 2, max: 200, required: true, code: 'invalid_author' }),
    source,
    sourceDetail: text(input.sourceDetail, { min: 3, max: 500, code: 'invalid_source_detail' }),
    takenOn: input.takenOn,
    licenseText: text(input.licenseText, { min: 10, max: 1000, required: true, code: 'invalid_license_text', multiline: true }),
    explicitLicenseGranted: input.explicitLicenseGranted === true,
    licenseDocumentRef: reference(input.licenseDocumentRef, 'invalid_license_document_ref'),
    rightsNote: text(input.rightsNote, { min: 3, max: 1000, code: 'invalid_rights_note', multiline: true }),
    altText: text(input.altText, { min: 3, max: 300, code: 'invalid_alt_text' }),
    depictsChildren: input.depictsChildren,
    identifiableChildren: count(input.identifiableChildren, 'invalid_identifiable_children'),
    identifiableAdults: count(input.identifiableAdults, 'invalid_identifiable_adults'),
  };
  if (photo.identifiableChildren > 0 && !photo.depictsChildren) throw new NewsError('invalid_depicts_children');
  // Sama publiczna dostępność (np. galeria na stronie szkoły) nie daje prawa do kopiowania.
  if (source === 'public_website_copy' && (!photo.explicitLicenseGranted || !photo.licenseDocumentRef)) {
    throw new NewsError('public_copy_requires_license', 422);
  }
  if (input.consents !== undefined && !Array.isArray(input.consents)) throw new NewsError('invalid_consent');
  photo.consents = (input.consents ?? []).map(parseConsent);
  if (new Set(photo.consents.map((c) => c.subjectNo)).size !== photo.consents.length) {
    throw new NewsError('invalid_consent');
  }
  return photo;
}

// ---------- odczyt i odwzorowanie ----------

const POST_COLUMNS = `id, school_year_id, class_id, title, body, photo_ids, status, revision_no,
  created_by, created_at, updated_by, updated_at, submitted_revision_no, submitted_by, submitted_at,
  approved_revision_no, approved_by, approved_at, published_revision_no, published_by, published_at,
  first_published_at, withdrawn_by, withdrawn_at, withdrawal_reason, idempotency_key`;

const PHOTO_COLUMNS = `id, document_id, author, source, source_detail, to_char(taken_on, 'YYYY-MM-DD') AS taken_on, license_text,
  explicit_license_granted, license_document_ref, rights_note, alt_text, depicts_children,
  identifiable_children, identifiable_adults, uploaded_by, uploaded_at, rights_status,
  rights_verified_by, rights_verified_at, revoked_by, revoked_at, revocation_reason, idempotency_key`;

function iso(value) {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function internalPost(row) {
  return {
    id: row.id,
    schoolYearId: row.school_year_id,
    classId: row.class_id ?? null,
    status: row.status,
    revision: row.revision_no,
    title: row.title,
    body: row.body,
    photoIds: row.photo_ids ?? [],
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedBy: row.updated_by,
    updatedAt: iso(row.updated_at),
    submittedRevision: row.submitted_revision_no ?? null,
    approvedRevision: row.approved_revision_no ?? null,
    approvedBy: row.approved_by ?? null,
    approvedAt: iso(row.approved_at),
    publishedRevision: row.published_revision_no ?? null,
    publishedAt: iso(row.published_at),
    withdrawnAt: iso(row.withdrawn_at),
    withdrawalReason: row.withdrawal_reason ?? null,
  };
}

function internalPhoto(row, consents = null) {
  const photo = {
    id: row.id,
    documentId: row.document_id,
    author: row.author,
    source: row.source,
    sourceDetail: row.source_detail ?? null,
    takenOn: row.taken_on,
    licenseText: row.license_text,
    explicitLicenseGranted: row.explicit_license_granted,
    licenseDocumentRef: row.license_document_ref ?? null,
    rightsNote: row.rights_note ?? null,
    altText: row.alt_text ?? null,
    depictsChildren: row.depicts_children,
    identifiableChildren: row.identifiable_children,
    identifiableAdults: row.identifiable_adults,
    uploadedBy: row.uploaded_by,
    uploadedAt: iso(row.uploaded_at),
    rightsStatus: row.rights_status,
    rightsVerifiedBy: row.rights_verified_by ?? null,
    rightsVerifiedAt: iso(row.rights_verified_at),
    revokedAt: iso(row.revoked_at),
    revocationReason: row.revocation_reason ?? null,
  };
  if (consents) {
    photo.consents = consents.map((c) => ({
      subjectNo: c.subject_no, subjectKind: c.subject_kind, consentDocumentRef: c.consent_document_ref,
      recordedBy: c.recorded_by, recordedAt: iso(c.recorded_at),
    }));
  }
  return photo;
}

function publicPost(row) {
  const photos = typeof row.photos === 'string' ? JSON.parse(row.photos) : (row.photos ?? []);
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    publishedAt: iso(row.published_at),
    photos: photos.map((p) => ({
      id: p.id,
      author: p.author,
      source: p.source,
      license: p.license,
      takenOn: p.takenOn,
      altText: p.altText ?? null,
    })),
  };
}

// ---------- pomocnicze: transakcje, błędy, dziennik ----------

async function audit(tx, actorId, action, entityType, entityId, metadata) {
  // Metadane: wyłącznie numery wersji, statusy i liczby, bez treści i danych osobowych.
  await insertAuditEvent(tx, { actorId, action, entityType, entityId, metadata });
}

function isUniqueViolation(error) {
  return error?.code === '23505' || /duplicate key value/.test(String(error?.message ?? ''));
}

const DB_ERRORS = [
  ['news_post_four_eyes_required', 'four_eyes_required', 409],
  ['news_photo_four_eyes_required', 'four_eyes_required', 409],
  ['news_post_withdrawn_is_final', 'post_withdrawn', 409],
  ['news_post_photo_rights_unverified', 'photo_rights_unverified', 409],
  ['news_post_photo_revoked', 'photo_revoked', 409],
  ['news_post_photo_not_found', 'photo_not_found', 422],
  ['news_post_duplicate_photo', 'duplicate_photo', 400],
  ['news_photo_child_consent_required', 'child_consent_required', 409],
  ['news_photo_consent_missing', 'consent_missing', 409],
  ['news_photo_public_copy_requires_license', 'public_copy_requires_license', 422],
  ['news_photo_revoked_is_final', 'photo_revoked', 409],
  ['news_photo_consents_locked', 'consents_locked', 409],
];

function mapDatabaseError(error) {
  const message = String(error?.message ?? error);
  for (const [needle, code, status] of DB_ERRORS) {
    if (message.includes(needle)) throw new NewsError(code, status);
  }
  if (/news_post_invalid_|news_post_content_and_workflow_change|news_photo_invalid_/.test(message)) {
    throw new NewsError('invalid_transition', 409);
  }
  if (error?.code === '23503') throw new NewsError('invalid_reference');
  if (error?.code === '23514') throw new NewsError('invalid_request');
  throw error;
}

async function run(db, fn) {
  try {
    return await db.transaction(fn);
  } catch (error) {
    if (error instanceof NewsError) throw error;
    return mapDatabaseError(error);
  }
}

async function lockPost(tx, postId) {
  if (!validId(postId)) throw new NewsError('invalid_post_id');
  const { rows } = await tx.query(`SELECT ${POST_COLUMNS} FROM news_posts WHERE id = $1 FOR UPDATE`, [postId]);
  if (!rows[0]) throw new NewsError('post_not_found', 404);
  return rows[0];
}

async function lockPhoto(tx, photoId) {
  if (!validId(photoId)) throw new NewsError('invalid_photo_id');
  const { rows } = await tx.query(`SELECT ${PHOTO_COLUMNS} FROM news_photos WHERE id = $1 FOR UPDATE`, [photoId]);
  if (!rows[0]) throw new NewsError('photo_not_found', 404);
  return rows[0];
}

// ---------- wpisy ----------

export async function createDraft(db, actor, input) {
  requireActor(actor);
  if (!input || typeof input !== 'object') throw new NewsError('invalid_request');
  if (!validId(input.schoolYearId)) throw new NewsError('invalid_school_year');
  if (input.classId !== undefined && input.classId !== null && !validId(input.classId)) {
    throw new NewsError('invalid_class');
  }
  const idempotencyKey = input.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    throw new NewsError('invalid_idempotency_key');
  }
  const scope = { school_year_id: input.schoolYearId, class_id: input.classId ?? null };
  if (!canEdit(actor, scope)) throw new NewsError('forbidden', 403);
  const content = parseContent(input);
  if (content.photoIds.length && !canAttachPhotos(actor, scope)) throw new NewsError('photos_require_school_wide_role', 403);

  const replay = async () => {
    const { rows } = await db.query(`SELECT ${POST_COLUMNS} FROM news_posts WHERE idempotency_key = $1`, [idempotencyKey]);
    const row = rows[0];
    if (!row) return null;
    const { rows: first } = await db.query(
      'SELECT title, body, photo_ids FROM news_post_revisions WHERE post_id = $1 AND revision_no = 1', [row.id],
    );
    if (row.created_by !== actor.userId || row.school_year_id !== scope.school_year_id
      || (row.class_id ?? null) !== scope.class_id || !first[0] || !sameContent(first[0], content)) {
      throw new NewsError('idempotency_conflict', 409);
    }
    return { post: internalPost(row), replayed: true };
  };

  const existing = await replay();
  if (existing) return existing;
  const id = crypto.randomUUID();
  try {
    return await db.transaction(async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO news_posts (id, school_year_id, class_id, title, body, photo_ids,
           created_by, updated_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $7, $8) RETURNING ${POST_COLUMNS}`,
        [id, scope.school_year_id, scope.class_id, content.title, content.body, content.photoIds,
          actor.userId, idempotencyKey],
      );
      await audit(tx, actor.userId, 'news_post.created', 'news_post', id,
        { revision: 1, status: 'draft', photoCount: content.photoIds.length });
      return { post: internalPost(rows[0]), replayed: false };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const replayed = await replay();
      if (replayed) return replayed;
    }
    if (error instanceof NewsError) throw error;
    return mapDatabaseError(error);
  }
}

export async function updateDraft(db, actor, input) {
  requireActor(actor);
  const expected = readRevision(input);
  return run(db, async (tx) => {
    const row = await lockPost(tx, input.postId);
    if (!canEdit(actor, row)) throw new NewsError('post_not_found', 404);
    if (row.status === 'withdrawn') throw new NewsError('post_withdrawn', 409);
    const content = parseContent(input, { title: row.title, body: row.body, photoIds: row.photo_ids ?? [] });
    if (JSON.stringify(content.photoIds) !== JSON.stringify(row.photo_ids ?? []) && !canAttachPhotos(actor, row)) {
      throw new NewsError('photos_require_school_wide_role', 403);
    }
    if (row.revision_no !== expected) {
      if (row.revision_no === expected + 1 && row.updated_by === actor.userId && sameContent(row, content)) {
        return { post: internalPost(row), replayed: true };
      }
      throw new NewsError('revision_conflict', 409);
    }
    if (sameContent(row, content)) return { post: internalPost(row), replayed: true };
    const { rows } = await tx.query(
      `UPDATE news_posts SET title = $2, body = $3, photo_ids = $4::text[], updated_by = $5
        WHERE id = $1 RETURNING ${POST_COLUMNS}`,
      [row.id, content.title, content.body, content.photoIds, actor.userId],
    );
    await audit(tx, actor.userId, 'news_post.revised', 'news_post', row.id,
      { revision: rows[0].revision_no, status: 'draft', photoCount: content.photoIds.length });
    return { post: internalPost(rows[0]), replayed: false };
  });
}

async function transition(db, actor, input, spec) {
  requireActor(actor);
  const expected = readRevision(input);
  return run(db, async (tx) => {
    const row = await lockPost(tx, input.postId);
    if (!canEdit(actor, row) && !canReview(actor, row)) throw new NewsError('post_not_found', 404);
    if (!spec.allowed(actor, row)) throw new NewsError('forbidden', 403);
    if (spec.alreadyDone(row, expected)) return { post: internalPost(row), replayed: true };
    if (row.status === 'withdrawn') throw new NewsError('post_withdrawn', 409);
    if (row.revision_no !== expected) throw new NewsError('revision_conflict', 409);
    if (!spec.from.includes(row.status)) throw new NewsError('invalid_transition', 409);
    const { sql, params } = spec.update(row, actor);
    const { rows } = await tx.query(
      `UPDATE news_posts SET ${sql} WHERE id = $1 RETURNING ${POST_COLUMNS}`, [row.id, ...params],
    );
    await audit(tx, actor.userId, spec.action, 'news_post', row.id,
      { revision: row.revision_no, status: rows[0].status });
    return { post: internalPost(rows[0]), replayed: false };
  });
}

export function submit(db, actor, input) {
  return transition(db, actor, input, {
    action: 'news_post.submitted',
    from: ['draft'],
    allowed: canEdit,
    alreadyDone: (row, rev) => row.revision_no === rev && row.submitted_revision_no === rev
      && ['submitted', 'approved', 'published'].includes(row.status),
    update: (row, a) => ({
      sql: `status = 'submitted', submitted_revision_no = $2, submitted_by = $3, submitted_at = now()`,
      params: [row.revision_no, a.userId],
    }),
  });
}

export function approve(db, actor, input) {
  return transition(db, actor, input, {
    action: 'news_post.approved',
    from: ['submitted'],
    allowed: canReview,
    alreadyDone: (row, rev) => row.revision_no === rev && row.approved_revision_no === rev
      && ['approved', 'published'].includes(row.status),
    update: (row, a) => ({
      sql: `status = 'approved', approved_revision_no = $2, approved_by = $3, approved_at = now()`,
      params: [row.revision_no, a.userId],
    }),
  });
}

export function publish(db, actor, input) {
  return transition(db, actor, input, {
    action: 'news_post.published',
    from: ['approved'],
    allowed: canReview,
    alreadyDone: (row, rev) => row.revision_no === rev && row.published_revision_no === rev
      && row.status === 'published',
    update: (row, a) => ({
      sql: `status = 'published', published_revision_no = $2, published_by = $3,
            published_at = now(), first_published_at = COALESCE(first_published_at, now())`,
      params: [row.revision_no, a.userId],
    }),
  });
}

export async function withdraw(db, actor, input) {
  requireActor(actor);
  const reason = text(input?.reason, { min: 3, max: 500, required: true, code: 'invalid_reason' });
  return transition(db, actor, input, {
    action: 'news_post.withdrawn',
    from: ['draft', 'submitted', 'approved', 'published'],
    // Wpis kiedykolwiek opublikowany wycofuje tylko zarząd; nieopublikowany
    // także osoba, która może go edytować.
    allowed: (a, row) => canReview(a, row) || (row.published_revision_no === null && canEdit(a, row)),
    alreadyDone: (row) => row.status === 'withdrawn',
    update: (_row, a) => ({
      sql: `status = 'withdrawn', withdrawn_by = $2, withdrawn_at = now(), withdrawal_reason = $3`,
      params: [a.userId, reason],
    }),
  });
}

export async function getInternal(db, actor, input) {
  requireActor(actor);
  if (!validId(input?.postId)) throw new NewsError('invalid_post_id');
  const { rows } = await db.query(`SELECT ${POST_COLUMNS} FROM news_posts WHERE id = $1`, [input.postId]);
  const row = rows[0];
  // Ta sama odpowiedź dla brakującego i cudzego wpisu.
  if (!row || !(canEdit(actor, row) || canReview(actor, row))) throw new NewsError('post_not_found', 404);
  const { rows: revisions } = await db.query(
    'SELECT revision_no, title, body, photo_ids, created_by, created_at FROM news_post_revisions WHERE post_id = $1 ORDER BY revision_no',
    [row.id],
  );
  return {
    post: internalPost(row),
    revisions: revisions.map((r) => ({
      revision: r.revision_no, title: r.title, body: r.body, photoIds: r.photo_ids ?? [],
      createdBy: r.created_by, createdAt: iso(r.created_at),
    })),
  };
}

export async function listInternal(db, actor, input) {
  requireActor(actor);
  if (!validId(input?.schoolYearId)) throw new NewsError('invalid_school_year');
  const schoolYearId = input.schoolYearId;
  if (schoolWide(actor, NEWS_POLICY.draftSchoolWide, schoolYearId) || schoolWide(actor, NEWS_POLICY.review, schoolYearId)) {
    const { rows } = await db.query(
      `SELECT ${POST_COLUMNS} FROM news_posts WHERE school_year_id = $1 ORDER BY created_at DESC, id`, [schoolYearId],
    );
    return { posts: rows.map(internalPost) };
  }
  const classIds = [...new Set(actor.grants
    .filter((g) => g.classId && classScoped(actor, g.classId, schoolYearId)).map((g) => g.classId))];
  if (!classIds.length) throw new NewsError('forbidden', 403);
  const { rows } = await db.query(
    `SELECT ${POST_COLUMNS} FROM news_posts WHERE school_year_id = $1 AND class_id = ANY($2::text[])
      ORDER BY created_at DESC, id`,
    [schoolYearId, classIds],
  );
  return { posts: rows.map(internalPost) };
}

export async function listPublic(db, input = {}) {
  const params = [];
  const conditions = [];
  if (input.schoolYearId !== undefined && input.schoolYearId !== null) {
    if (!validId(input.schoolYearId)) throw new NewsError('invalid_school_year');
    params.push(input.schoolYearId);
    conditions.push(`school_year_id = $${params.length}`);
  }
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new NewsError('invalid_limit');
  params.push(limit);
  const { rows } = await db.query(
    `SELECT id, title, body, published_at, photos FROM public_news
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY published_at DESC, id LIMIT $${params.length}`,
    params,
  );
  return { posts: rows.map(publicPost) };
}

// ---------- zdjęcia ----------

async function insertConsents(tx, actor, photoId, consents) {
  for (const consent of consents) {
    await tx.query(
      `INSERT INTO news_photo_consents (photo_id, subject_no, subject_kind, consent_document_ref, recorded_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [photoId, consent.subjectNo, consent.subjectKind, consent.consentDocumentRef, actor.userId],
    );
    await audit(tx, actor.userId, 'news_photo.consent_recorded', 'news_photo', photoId,
      { subjectNo: consent.subjectNo, subjectKind: consent.subjectKind });
  }
}

export async function registerPhoto(db, actor, input) {
  requireActor(actor);
  if (!schoolWide(actor, NEWS_POLICY.photoRegister)) throw new NewsError('forbidden', 403);
  const idempotencyKey = input?.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    throw new NewsError('invalid_idempotency_key');
  }
  const photo = parsePhoto(input);

  const replay = async () => {
    const { rows } = await db.query(`SELECT ${PHOTO_COLUMNS} FROM news_photos WHERE idempotency_key = $1`, [idempotencyKey]);
    const row = rows[0];
    if (!row) return null;
    if (row.uploaded_by !== actor.userId || row.document_id !== photo.documentId
      || row.author !== photo.author || row.source !== photo.source) {
      throw new NewsError('idempotency_conflict', 409);
    }
    return { photo: internalPhoto(row), replayed: true };
  };
  const existing = await replay();
  if (existing) return existing;
  const id = crypto.randomUUID();
  try {
    return await db.transaction(async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO news_photos (id, document_id, author, source, source_detail, taken_on, license_text,
           explicit_license_granted, license_document_ref, rights_note, alt_text, depicts_children,
           identifiable_children, identifiable_adults, uploaded_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         RETURNING ${PHOTO_COLUMNS}`,
        [id, photo.documentId, photo.author, photo.source, photo.sourceDetail, photo.takenOn,
          photo.licenseText, photo.explicitLicenseGranted, photo.licenseDocumentRef, photo.rightsNote,
          photo.altText, photo.depictsChildren, photo.identifiableChildren, photo.identifiableAdults,
          actor.userId, idempotencyKey],
      );
      await audit(tx, actor.userId, 'news_photo.registered', 'news_photo', id, {
        source: photo.source, depictsChildren: photo.depictsChildren,
        identifiableChildren: photo.identifiableChildren, identifiableAdults: photo.identifiableAdults,
      });
      await insertConsents(tx, actor, id, photo.consents);
      return { photo: internalPhoto(rows[0]), replayed: false };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const replayed = await replay();
      if (replayed) return replayed;
    }
    if (error instanceof NewsError) throw error;
    return mapDatabaseError(error);
  }
}

export async function addConsent(db, actor, input) {
  requireActor(actor);
  if (!schoolWide(actor, NEWS_POLICY.photoRegister)) throw new NewsError('forbidden', 403);
  if (!Number.isSafeInteger(input?.subjectNo)) throw new NewsError('invalid_consent');
  const consent = parseConsent(input, 0);
  return run(db, async (tx) => {
    const row = await lockPhoto(tx, input.photoId);
    const { rows: existing } = await tx.query(
      'SELECT subject_kind, consent_document_ref FROM news_photo_consents WHERE photo_id = $1 AND subject_no = $2',
      [row.id, consent.subjectNo],
    );
    if (existing[0]) {
      // Podwójne kliknięcie: ten sam wpis to powtórka, inny — konflikt.
      if (existing[0].subject_kind === consent.subjectKind && existing[0].consent_document_ref === consent.consentDocumentRef) {
        return { replayed: true };
      }
      throw new NewsError('consent_conflict', 409);
    }
    if (row.rights_status !== 'pending') throw new NewsError('consents_locked', 409);
    await insertConsents(tx, actor, row.id, [consent]);
    return { replayed: false };
  });
}

export async function verifyPhoto(db, actor, input) {
  requireActor(actor);
  if (!schoolWide(actor, NEWS_POLICY.photoVerify)) throw new NewsError('forbidden', 403);
  return run(db, async (tx) => {
    const row = await lockPhoto(tx, input?.photoId);
    if (row.rights_status === 'verified') return { photo: internalPhoto(row), replayed: true };
    if (row.rights_status === 'revoked') throw new NewsError('photo_revoked', 409);
    if (row.uploaded_by === actor.userId) throw new NewsError('four_eyes_required', 409);
    const { rows } = await tx.query(
      `UPDATE news_photos SET rights_status = 'verified', rights_verified_by = $2, rights_verified_at = now()
        WHERE id = $1 RETURNING ${PHOTO_COLUMNS}`,
      [row.id, actor.userId],
    );
    await audit(tx, actor.userId, 'news_photo.rights_verified', 'news_photo', row.id, { status: 'verified' });
    return { photo: internalPhoto(rows[0]), replayed: false };
  });
}

// Cofnięcie praw (np. wycofanie zgody): zdjęcie znika z widoku publicznego
// przy następnym zapytaniu, także z już opublikowanych wpisów.
export async function revokePhoto(db, actor, input) {
  requireActor(actor);
  if (!schoolWide(actor, NEWS_POLICY.photoVerify)) throw new NewsError('forbidden', 403);
  const reason = text(input?.reason, { min: 3, max: 500, required: true, code: 'invalid_reason' });
  return run(db, async (tx) => {
    const row = await lockPhoto(tx, input?.photoId);
    if (row.rights_status === 'revoked') return { photo: internalPhoto(row), replayed: true };
    const { rows } = await tx.query(
      `UPDATE news_photos SET rights_status = 'revoked', revoked_by = $2, revoked_at = now(), revocation_reason = $3
        WHERE id = $1 RETURNING ${PHOTO_COLUMNS}`,
      [row.id, actor.userId, reason],
    );
    await audit(tx, actor.userId, 'news_photo.revoked', 'news_photo', row.id, { status: 'revoked' });
    return { photo: internalPhoto(rows[0]), replayed: false };
  });
}

export async function getPhoto(db, actor, input) {
  requireActor(actor);
  if (!canSeePhotos(actor)) throw new NewsError('forbidden', 403);
  if (!validId(input?.photoId)) throw new NewsError('invalid_photo_id');
  const { rows } = await db.query(`SELECT ${PHOTO_COLUMNS} FROM news_photos WHERE id = $1`, [input.photoId]);
  if (!rows[0]) throw new NewsError('photo_not_found', 404);
  const { rows: consents } = await db.query(
    'SELECT * FROM news_photo_consents WHERE photo_id = $1 ORDER BY subject_no', [input.photoId],
  );
  return { photo: internalPhoto(rows[0], consents) };
}

function newPhotoObjectKey() {
  return `photos/${crypto.randomUUID()}`;
}

function internalPhotoFile(row) {
  return {
    variant: row.variant, mimeType: row.mime_type, width: row.width, height: row.height,
    byteSize: row.byte_size, sha256: row.sha256, createdAt: iso(row.created_at),
  };
}

// Ponownie koduje bajty źródłowe do jednego wariantu JPEG bez metadanych
// (sharp nie przepisuje EXIF/XMP/ICC na wyjście, chyba że wywołane byłoby
// .withMetadata() — tu celowo pominięte). `.rotate()` na obrazie źródłowym
// honoruje orientację EXIF przed jej odrzuceniem, więc wynik ma poprawny
// obrót mimo braku metadanych.
async function renderPhotoVariant(source, { maxDimension, quality }) {
  const { data, info } = await source.clone()
    .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { bytes: data, width: info.width, height: info.height };
}

// Przesłanie pliku zarejestrowanego zdjęcia (#96): generuje warianty web/thumb
// bez EXIF/GPS i zapisuje je do prywatnego magazynu pod prefiksem photos/.
// Oryginał NIE jest przechowywany (wariant zachowawczy, brak D-18/D-04/D-05).
export async function uploadPhotoFile(db, storage, actor, input) {
  requireActor(actor);
  if (!schoolWide(actor, NEWS_POLICY.photoRegister)) throw new NewsError('forbidden', 403);
  if (!storage) throw new NewsError('storage_unavailable', 503);
  const idempotencyKey = input?.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    throw new NewsError('invalid_idempotency_key');
  }
  if (!validId(input?.photoId)) throw new NewsError('invalid_photo_id');
  const declared = declaredType(input?.contentType);
  if (!PHOTO_UPLOAD_TYPES.has(declared)) throw new NewsError('unsupported_media_type', 415);
  const bytes = input?.bytes;
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new NewsError('empty_photo_file');
  if (bytes.length > PHOTO_UPLOAD_MAX_BYTES) throw new NewsError('photo_file_too_large', 413);
  const detected = detectType(bytes);
  if (!detected || detected !== declared) throw new NewsError('unsupported_media_type', 415);
  const structure = validateStructure(bytes, detected);
  if (!structure.ok) throw new NewsError(structure.code === 'document_malformed' ? 'photo_file_malformed' : 'photo_file_active_content', 415);

  const { rows: photoRows } = await db.query('SELECT id, rights_status FROM news_photos WHERE id = $1', [input.photoId]);
  const photoRow = photoRows[0];
  if (!photoRow) throw new NewsError('photo_not_found', 404);
  if (photoRow.rights_status === 'revoked') throw new NewsError('photo_revoked', 409);

  const sourceSha256 = sha256Hex(bytes);
  const { rows: existingRows } = await db.query(
    'SELECT variant, mime_type, width, height, byte_size, sha256, source_sha256, created_at FROM news_photo_files WHERE photo_id = $1 ORDER BY variant',
    [input.photoId],
  );
  if (existingRows.length > 0) {
    if (existingRows.every((row) => row.source_sha256 === sourceSha256) && existingRows.length === Object.keys(PHOTO_FILE_VARIANTS).length) {
      return { files: existingRows.map(internalPhotoFile), replayed: true };
    }
    throw new NewsError('photo_file_exists', 409);
  }

  let source;
  try {
    source = sharp(bytes, { limitInputPixels: PHOTO_UPLOAD_MAX_PIXELS }).rotate();
    // Waliduje sygnaturę/strukturę faktycznie dekodując nagłówek — plik
    // uszkodzony poza tym, co wykrywa validateStructure, kończy się tu 415,
    // nie 500 (błąd łapany niżej).
    await source.metadata();
  } catch {
    throw new NewsError('photo_file_malformed', 415);
  }

  const variants = {};
  const uploadedKeys = [];
  try {
    for (const [variant, config] of Object.entries(PHOTO_FILE_VARIANTS)) {
      const rendered = await renderPhotoVariant(source, config);
      const objectKey = newPhotoObjectKey();
      await storage.putObject(objectKey, rendered.bytes, 'image/jpeg');
      uploadedKeys.push(objectKey);
      variants[variant] = {
        objectKey, width: rendered.width, height: rendered.height,
        byteSize: rendered.bytes.length, sha256: sha256Hex(rendered.bytes),
      };
    }

    try {
      const rows = await db.transaction(async (tx) => {
        const inserted = [];
        for (const [variant, file] of Object.entries(variants)) {
          const { rows: r } = await tx.query(
            `INSERT INTO news_photo_files
               (id, photo_id, variant, object_key, mime_type, width, height, byte_size, sha256, source_sha256, created_by)
             VALUES ($1, $2, $3, $4, 'image/jpeg', $5, $6, $7, $8, $9, $10)
             RETURNING variant, mime_type, width, height, byte_size, sha256, created_at`,
            [crypto.randomUUID(), input.photoId, variant, file.objectKey, file.width, file.height,
              file.byteSize, file.sha256, sourceSha256, actor.userId],
          );
          inserted.push(r[0]);
        }
        await audit(tx, actor.userId, 'news_photo.file_uploaded', 'news_photo', input.photoId, {
          variants: Object.fromEntries(Object.entries(variants).map(([v, f]) => (
            [v, { width: f.width, height: f.height, byteSize: f.byteSize, sha256: f.sha256 }]
          ))),
        });
        return inserted;
      });
      return { files: rows.map(internalPhotoFile), replayed: false };
    } catch (error) {
      // Podwójne kliknięcie równoległe: druga transakcja przegrała wyścig o
      // (photo_id, variant) — nasze obiekty w buckecie są zbędne, sprzątamy
      // best effort i zwracamy istniejący wynik jak przy zwykłym ponowieniu.
      if (isUniqueViolation(error)) {
        const { rows: again } = await db.query(
          'SELECT variant, mime_type, width, height, byte_size, sha256, source_sha256 FROM news_photo_files WHERE photo_id = $1 ORDER BY variant',
          [input.photoId],
        );
        await Promise.all(uploadedKeys.map((key) => storage.deleteObject?.(key).catch(() => {})));
        if (again.length > 0 && again.every((row) => row.source_sha256 === sourceSha256)) {
          return { files: again.map(internalPhotoFile), replayed: true };
        }
        throw new NewsError('photo_file_exists', 409);
      }
      throw error;
    }
  } catch (error) {
    if (!(error instanceof NewsError) || error.code !== 'photo_file_exists') {
      // Sprzątanie best effort: transakcja się nie powiodła z innego powodu
      // (np. rok zamknięty nie dotyczy zdjęć, ale sieć/baza mogła paść) —
      // obiekty bez wiersza w bazie zostają usunięte, żeby nie osierocić
      // ich w buckecie (kryterium akceptacji #96).
      await Promise.all(uploadedKeys.map((key) => storage.deleteObject?.(key).catch(() => {})));
    }
    if (error instanceof NewsError) throw error;
    return mapDatabaseError(error);
  }
}

// Odczyt publiczny wariantu pliku (#96): tylko dla zdjęcia zweryfikowanego i
// należącego do opublikowanej wersji niewycofanego wpisu (to samo kryterium
// co public_news — postgres/migrations/0084 `news_photo_is_public`).
// Nieznane zdjęcie, wariant bez pliku i zdjęcie niepubliczne dają identyczną
// odpowiedź „nie znaleziono” (brak wyroczni istnienia).
export async function getPublicPhotoFile(db, storage, input) {
  const photoId = input?.photoId;
  const variant = input?.variant;
  if (!validId(photoId) || !Object.hasOwn(PHOTO_FILE_VARIANTS, variant ?? '')) throw new NewsError('photo_not_found', 404);
  if (!storage) throw new NewsError('service_unavailable', 503);
  const { rows: publicRows } = await db.query('SELECT news_photo_is_public($1) AS is_public', [photoId]);
  if (!publicRows[0]?.is_public) throw new NewsError('photo_not_found', 404);
  const { rows } = await db.query(
    'SELECT object_key, mime_type, sha256 FROM news_photo_files WHERE photo_id = $1 AND variant = $2',
    [photoId, variant],
  );
  const fileRow = rows[0];
  if (!fileRow) throw new NewsError('photo_not_found', 404);
  let object;
  try {
    object = await storage.getObject(fileRow.object_key);
  } catch (error) {
    if (error?.code === 'storage_object_not_found') throw new NewsError('photo_not_found', 404);
    throw error;
  }
  if (sha256Hex(object.body) !== fileRow.sha256) throw new NewsError('photo_file_integrity_mismatch', 409);
  return { body: object.body, mimeType: fileRow.mime_type };
}

export async function listPhotos(db, actor, input = {}) {
  requireActor(actor);
  if (!canSeePhotos(actor)) throw new NewsError('forbidden', 403);
  const status = input.status ?? null;
  if (status !== null && !['pending', 'verified', 'revoked'].includes(status)) throw new NewsError('invalid_status');
  const { rows } = await db.query(
    `SELECT ${PHOTO_COLUMNS} FROM news_photos WHERE ($1::text IS NULL OR rights_status = $1)
      ORDER BY uploaded_at DESC, id LIMIT 200`,
    [status],
  );
  return { photos: rows.map((r) => internalPhoto(r)) };
}

// ---------- HTTP ----------

async function readJson(request) {
  const type = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw new NewsError('invalid_content_type', 415);
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new NewsError('request_too_large', 413);
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) throw new NewsError('request_too_large', 413);
  try {
    const data = JSON.parse(body);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new NewsError('invalid_json');
  }
}

function decodeId(value, code) {
  try {
    const id = decodeURIComponent(value);
    if (!validId(id)) throw new Error();
    return id;
  } catch {
    throw new NewsError(code);
  }
}

async function loadActor(request, env) {
  if (typeof env?.loadAuthorizationContext !== 'function') throw new NewsError('service_unavailable', 503);
  const context = await env.loadAuthorizationContext(request, env);
  if (!context?.session?.user?.id) throw new NewsError('unauthenticated', 401);
  return {
    userId: context.session.user.id,
    grants: Array.isArray(context.grants) ? context.grants : [],
    mfaVerified: Boolean(context.session.mfaVerified),
  };
}

function pick(data, keys) {
  return Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]]));
}

function idempotencyHeader(request) {
  const key = request.headers.get('Idempotency-Key')?.trim();
  if (!key || !IDEMPOTENCY_PATTERN.test(key)) throw new NewsError('invalid_idempotency_key');
  return key;
}

const PHOTO_FIELDS = ['documentId', 'author', 'source', 'sourceDetail', 'takenOn', 'licenseText',
  'explicitLicenseGranted', 'licenseDocumentRef', 'rightsNote', 'altText', 'depictsChildren',
  'identifiableChildren', 'identifiableAdults', 'consents'];

// Obsługuje /api/public/news, /api/news… i /api/news-photos…; inne ścieżki -> null.
export async function handle(request, env, url, json) {
  const path = url.pathname;
  const isPublic = path === '/api/public/news';
  const publicPhotoFile = path.match(/^\/api\/public\/news-photos\/([^/]+)\/(web|thumb)$/);
  const isPosts = path === '/api/news' || path.startsWith('/api/news/');
  const isPhotos = path === '/api/news-photos' || path.startsWith('/api/news-photos/');
  if (!isPublic && !publicPhotoFile && !isPosts && !isPhotos) return null;
  try {
    if (!env?.db) throw new NewsError('service_unavailable', 503);
    if (isPublic) {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
      const limitText = url.searchParams.get('limit');
      if (limitText !== null && !/^\d{1,2}$/.test(limitText)) throw new NewsError('invalid_limit');
      const result = await listPublic(env.db, {
        schoolYearId: url.searchParams.get('schoolYearId') ?? undefined,
        limit: limitText === null ? undefined : Number(limitText),
      });
      // Krótkie buforowanie: wycofanie wpisu lub cofnięcie praw do zdjęcia
      // znika z widoku publicznego najpóźniej po PUBLIC_CACHE_SECONDS.
      return json(result, 200, { 'Cache-Control': `public, max-age=${PUBLIC_CACHE_SECONDS}` });
    }
    if (publicPhotoFile) {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
      let photoId;
      try {
        photoId = decodeURIComponent(publicPhotoFile[1]);
      } catch {
        throw new NewsError('photo_not_found', 404);
      }
      const { body, mimeType } = await getPublicPhotoFile(env.db, env.storage, { photoId, variant: publicPhotoFile[2] });
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': mimeType,
          'Content-Length': String(body.length),
          'Cache-Control': `public, max-age=${PUBLIC_CACHE_SECONDS}`,
          'X-Content-Type-Options': 'nosniff',
          'Cross-Origin-Resource-Policy': 'same-origin',
        },
      });
    }

    const noStore = { 'Cache-Control': 'no-store' };
    const unsafe = request.method !== 'GET';
    if (unsafe && !isSameOrigin(request)) return json({ error: 'invalid_origin' }, 403);

    if (isPosts) {
      const item = path.match(/^\/api\/news\/([^/]+)$/);
      const action = path.match(/^\/api\/news\/([^/]+)\/(submit|approve|publish|withdraw)$/);
      const route = path === '/api/news' && request.method === 'GET' ? 'list'
        : path === '/api/news' && request.method === 'POST' ? 'create'
          : item && request.method === 'GET' ? 'get'
            : item && request.method === 'PATCH' ? 'update'
              : action && request.method === 'POST' ? 'action' : null;
      if (!route) return json({ error: 'not_found' }, 404);
      const actor = await loadActor(request, env);
      if (route === 'list') return json(await listInternal(env.db, actor, { schoolYearId: url.searchParams.get('schoolYearId') }), 200, noStore);
      if (route === 'get') return json(await getInternal(env.db, actor, { postId: decodeId(item[1], 'invalid_post_id') }), 200, noStore);
      const data = await readJson(request);
      if (route === 'create') {
        const result = await createDraft(env.db, actor, {
          ...pick(data, ['schoolYearId', 'classId', 'title', 'body', 'photoIds']), idempotencyKey: idempotencyHeader(request),
        });
        return json({ post: result.post }, result.replayed ? 200 : 201, { ...noStore, 'Idempotency-Replayed': String(result.replayed) });
      }
      if (route === 'update') {
        const result = await updateDraft(env.db, actor, {
          ...pick(data, ['revision', 'title', 'body', 'photoIds']), postId: decodeId(item[1], 'invalid_post_id'),
        });
        return json({ post: result.post, replayed: result.replayed }, 200, noStore);
      }
      const operations = { submit, approve, publish, withdraw };
      const result = await operations[action[2]](env.db, actor, {
        ...pick(data, ['revision', 'reason']), postId: decodeId(action[1], 'invalid_post_id'),
      });
      return json({ post: result.post, replayed: result.replayed }, 200, noStore);
    }

    const item = path.match(/^\/api\/news-photos\/([^/]+)$/);
    const action = path.match(/^\/api\/news-photos\/([^/]+)\/(consents|verify|revoke|file)$/);
    const route = path === '/api/news-photos' && request.method === 'GET' ? 'list'
      : path === '/api/news-photos' && request.method === 'POST' ? 'create'
        : item && request.method === 'GET' ? 'get'
          : action && request.method === 'POST' ? 'action' : null;
    if (!route) return json({ error: 'not_found' }, 404);
    const actor = await loadActor(request, env);
    if (route === 'list') return json(await listPhotos(env.db, actor, { status: url.searchParams.get('status') }), 200, noStore);
    if (route === 'get') return json(await getPhoto(env.db, actor, { photoId: decodeId(item[1], 'invalid_photo_id') }), 200, noStore);
    if (route === 'action' && action[2] === 'file') {
      // Bajty surowe, nie JSON — czytane osobno, PRZED jakąkolwiek próbą
      // odczytu ciała jako JSON (readJson niżej dotyczy tylko innych tras).
      const photoId = decodeId(action[1], 'invalid_photo_id');
      const idempotencyKey = idempotencyHeader(request);
      const contentType = request.headers.get('content-type');
      let bytes;
      try {
        bytes = await readLimited(request, PHOTO_UPLOAD_MAX_BYTES);
      } catch (error) {
        if (error instanceof RangeError) throw new NewsError('photo_file_too_large', 413);
        throw error;
      }
      const result = await uploadPhotoFile(env.db, env.storage, actor, { photoId, bytes, contentType, idempotencyKey });
      return json({ files: result.files }, result.replayed ? 200 : 201, { ...noStore, 'Idempotency-Replayed': String(result.replayed) });
    }
    const data = await readJson(request);
    if (route === 'create') {
      const result = await registerPhoto(env.db, actor, { ...pick(data, PHOTO_FIELDS), idempotencyKey: idempotencyHeader(request) });
      return json({ photo: result.photo }, result.replayed ? 200 : 201, { ...noStore, 'Idempotency-Replayed': String(result.replayed) });
    }
    const photoId = decodeId(action[1], 'invalid_photo_id');
    if (action[2] === 'consents') {
      const result = await addConsent(env.db, actor, { ...pick(data, ['subjectNo', 'subjectKind', 'consentDocumentRef']), photoId });
      return json({ replayed: result.replayed }, result.replayed ? 200 : 201, noStore);
    }
    const result = action[2] === 'verify'
      ? await verifyPhoto(env.db, actor, { photoId })
      : await revokePhoto(env.db, actor, { ...pick(data, ['reason']), photoId });
    return json({ photo: result.photo, replayed: result.replayed }, 200, noStore);
  } catch (error) {
    if (error instanceof NewsError) return json({ error: error.code }, error.status);
    throw error;
  }
}
