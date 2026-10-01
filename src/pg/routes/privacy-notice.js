// Wersjonowana informacja o przetwarzaniu danych (D-06, #145).
//
//   GET  /api/public/privacy-notice                     bez sesji; tylko opublikowana wersja
//   GET  /api/admin/privacy-notices                      admin/board + MFA; wszystkie wersje
//   POST /api/admin/privacy-notices                      { bodyText, decisionRef, schoolYearId? } — nowy szkic
//   POST /api/admin/privacy-notices/{id}/approve          inna osoba niż autor (cztery oczy)
//   POST /api/admin/privacy-notices/{id}/publish          wymaga zatwierdzenia; idempotentne (druga publikacja = replayed)
//
// Treść (`bodyText`) i `decisionRef` wpisuje zarząd/administrator — moduł nie
// dostarcza żadnej wartości domyślnej. Bramki `privacy_notice_missing` (409):
// import (src/pg/routes/import.js), zatwierdzenie kampanii e-mail
// (src/pg/routes/email.js, email_campaigns.privacy_notice_id, 0179) i wydruk
// kartek (src/pg/routes/print.js). Wspólne odczyty: loadPublishedNotice,
// loadNoticeById i noticeReference poniżej.

import { createHash, randomUUID } from 'node:crypto';
import { requireAccess } from '../authorization.js';
import { insertAuditEvent } from '../audit.js';
import { createJsonReader } from '../input.js';

export const name = 'privacy-notice';

export const NOTICE_ROLES = Object.freeze(['admin', 'board']);
const ACCESS = Object.freeze({ roles: NOTICE_ROLES, requireMfa: true });
const MAX_BODY_BYTES = 8 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

class RequestError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// Obowiązująca (opublikowana) wersja albo null — wspólna dla bramek (#145).
export async function loadPublishedNotice(executor) {
  const { rows } = await executor.query(
    "SELECT id, version FROM privacy_notices WHERE status = 'published' ORDER BY version DESC LIMIT 1",
  );
  return rows[0] ?? null;
}

// Wersja po identyfikatorze (także zastąpiona): kampania używa wersji
// zapamiętanej przy zatwierdzeniu, nie „bieżącej”.
export async function loadNoticeById(executor, id) {
  if (!id) return null;
  const { rows } = await executor.query('SELECT id, version FROM privacy_notices WHERE id = $1', [id]);
  return rows[0] ?? null;
}

// Odwołanie do informacji w stopce e-maila i kartki: numer wersji i adres
// publicznej trasy GET /api/public/privacy-notice (pokazuje wyłącznie wersję
// OBOWIĄZUJĄCĄ — starsza, zapamiętana w kampanii, jest rozpoznawalna po
// numerze). Bez PUBLIC_BASE_URL zostaje sam numer. Treści nie dotyka.
export function noticeReference(notice, publicBaseUrl = null) {
  if (!notice) return null;
  const base = String(publicBaseUrl ?? '').trim().replace(/\/+$/, '');
  return { id: notice.id, version: notice.version, url: base ? `${base}/api/public/privacy-notice` : null };
}

// Wersja informacji dla kampanii e-mail (#145, 0179): w szkicu (i anulowanym
// bez zatwierdzenia) bieżąca opublikowana — tę zatwierdzający zapisze; po
// zatwierdzeniu wersja zapamiętana w kampanii (privacy_notice_id), nie „bieżąca”.
// null = brak (szkic bez publikacji albo kampania zatwierdzona przed 0179).
export async function campaignPrivacyNotice(executor, campaign, publicBaseUrl = null) {
  const draftLike = campaign.status === 'draft' || (campaign.status === 'cancelled' && !campaign.approved_at);
  const notice = draftLike ? await loadPublishedNotice(executor) : await loadNoticeById(executor, campaign.privacy_notice_id);
  return noticeReference(notice, publicBaseUrl);
}

function noticeHash({ schoolYearId, bodyText }) {
  return createHash('sha256').update(JSON.stringify(['rd-privacy-notice-v1', schoolYearId ?? null, bodyText])).digest('hex');
}

const readJson = createJsonReader({
  maxBytes: MAX_BODY_BYTES,
  error: (code, status) => new RequestError(code, status),
});

function noticeView(row) {
  return {
    id: row.id,
    version: row.version,
    schoolYearId: row.school_year_id ?? null,
    bodyText: row.body_text,
    contentHash: row.content_hash,
    decisionRef: row.decision_ref,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    approvedBy: row.approved_by ?? null,
    approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
    publishedBy: row.published_by ?? null,
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
  };
}

async function listNotices(env, json) {
  const { rows } = await env.db.query('SELECT * FROM privacy_notices ORDER BY version DESC');
  return json({ notices: rows.map(noticeView) });
}

async function createNotice(request, env, actorId, json) {
  const data = await readJson(request);
  if (typeof data.bodyText !== 'string' || !data.bodyText.trim() || data.bodyText.length > 20000) {
    throw new RequestError('invalid_body_text');
  }
  if (typeof data.decisionRef !== 'string' || !data.decisionRef.trim() || data.decisionRef.length > 200) {
    throw new RequestError('invalid_decision_ref');
  }
  const schoolYearId = data.schoolYearId ?? null;
  if (schoolYearId !== null && (typeof schoolYearId !== 'string' || !ID_PATTERN.test(schoolYearId))) {
    throw new RequestError('invalid_school_year');
  }
  const id = randomUUID();
  const contentHash = noticeHash({ schoolYearId, bodyText: data.bodyText });
  try {
    return await env.db.transaction(async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO privacy_notices (id, school_year_id, body_text, content_hash, decision_ref, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [id, schoolYearId, data.bodyText.trim(), contentHash, data.decisionRef.trim(), actorId],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'privacy_notice.created', entityType: 'privacy_notice', entityId: id,
        metadata: { version: rows[0].version, schoolYearId },
      });
      return json({ notice: noticeView(rows[0]) }, 201);
    });
  } catch (error) {
    if (error?.code === '23505') throw new RequestError('school_year_not_found', 404);
    throw error;
  }
}

async function approveNotice(env, actorId, id, json) {
  return env.db.transaction(async (tx) => {
    const { rows } = await tx.query('SELECT * FROM privacy_notices WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new RequestError('privacy_notice_not_found', 404);
    const notice = rows[0];
    if (notice.status !== 'draft') {
      if (notice.approved_by) return json({ notice: noticeView(notice) }, 200, { 'Idempotency-Replayed': 'true' });
      throw new RequestError('privacy_notice_not_draft', 409);
    }
    if (notice.created_by === actorId) throw new RequestError('forbidden', 403);
    const { rows: updated } = await tx.query(
      `UPDATE privacy_notices SET status = 'approved', approved_by = $2, approved_at = now()
        WHERE id = $1 RETURNING *`,
      [id, actorId],
    );
    await insertAuditEvent(tx, {
      actorId, action: 'privacy_notice.approved', entityType: 'privacy_notice', entityId: id,
      metadata: { version: notice.version },
    });
    return json({ notice: noticeView(updated[0]) });
  });
}

async function publishNotice(env, actorId, id, json) {
  return env.db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('rd_privacy_notice_publish'))");
    const { rows } = await tx.query('SELECT * FROM privacy_notices WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new RequestError('privacy_notice_not_found', 404);
    const notice = rows[0];
    if (notice.status === 'published' || notice.status === 'superseded') {
      const { rows: current } = await tx.query('SELECT * FROM privacy_notices WHERE id = $1', [id]);
      return json({ notice: noticeView(current[0]) }, 200, { 'Idempotency-Replayed': 'true' });
    }
    if (notice.status !== 'approved') throw new RequestError('privacy_notice_not_approved', 409);
    await tx.query("UPDATE privacy_notices SET status = 'superseded' WHERE status = 'published'");
    const { rows: updated } = await tx.query(
      `UPDATE privacy_notices SET status = 'published', published_by = $2, published_at = now()
        WHERE id = $1 RETURNING *`,
      [id, actorId],
    );
    await insertAuditEvent(tx, {
      actorId, action: 'privacy_notice.published', entityType: 'privacy_notice', entityId: id,
      metadata: { version: notice.version },
    });
    return json({ notice: noticeView(updated[0]) });
  });
}

async function publicNotice(env, json) {
  const { rows } = await env.db.query("SELECT * FROM privacy_notices WHERE status = 'published' ORDER BY version DESC LIMIT 1");
  if (!rows[0]) return json({ error: 'privacy_notice_not_found' }, 404, { 'Cache-Control': 'no-store' });
  const row = rows[0];
  return json({
    version: row.version,
    bodyText: row.body_text,
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
  }, 200, { 'Cache-Control': 'public, max-age=60' });
}

const ADMIN_PREFIX = '/api/admin/privacy-notices';

export async function handle(request, env, url, json) {
  if (url.pathname === '/api/public/privacy-notice') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
    return publicNotice(env, json);
  }
  if (!url.pathname.startsWith(ADMIN_PREFIX)) return null;
  const rest = url.pathname === ADMIN_PREFIX ? [] : url.pathname.slice(ADMIN_PREFIX.length + 1).split('/');
  if (rest.length > 2) return null;

  const access = await requireAccess(request, env, ACCESS, json);
  if (access.response) return access.response;
  const actorId = access.context.session.user.id;

  try {
    if (rest.length === 0) {
      if (request.method === 'GET') return await listNotices(env, json);
      if (request.method === 'POST') return await createNotice(request, env, actorId, json);
      return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET, POST' });
    }
    if (rest.length === 2 && request.method === 'POST') {
      let id;
      try { id = decodeURIComponent(rest[0]); } catch { throw new RequestError('invalid_id'); }
      if (rest[1] === 'approve') return await approveNotice(env, actorId, id, json);
      if (rest[1] === 'publish') return await publishNotice(env, actorId, id, json);
    }
    return null;
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.code }, error.status);
    throw error;
  }
}
