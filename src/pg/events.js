// Events on PostgreSQL: internal draft -> submission -> approval -> publication.
// Domain functions take (db, actor, input) where db exposes
// query(text, params) -> { rows } and transaction(async tx => ...),
// and actor = { userId, grants, mfaVerified }.
//
// Role policy is an ASSUMPTION pending school decision D-08 (docs/DECISIONS.md):
// - drafting, editing, submitting, reading internally: admin and board
//   (school-wide grant) or a representative for an event of their own class;
// - approving, publishing and cancelling a published event: board only
//   (PRODUCT.md: technical admin does not publish);
// - approver must differ from the event author and the revision author
//   (four eyes, enforced again by the database trigger).
import { isSameOrigin } from '../auth.js';
import { isAuthorized } from '../authorization.js';

export const EVENT_TIMEZONE = 'Europe/Brussels';
export const EVENT_POLICY = Object.freeze({
  draftSchoolWide: Object.freeze(['admin', 'board']),
  draftClass: Object.freeze(['representative']),
  review: Object.freeze(['board']),
});

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;
const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/;
const MAX_BODY_BYTES = 16 * 1024;
const CONTENT_FIELDS = ['title', 'description', 'startsAt', 'endsAt', 'location', 'organizer', 'audience'];

export class EventError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// ---------- Europe/Brussels time handling ----------

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: EVENT_TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function brusselsParts(date) {
  const parts = Object.fromEntries(partsFormatter.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
  };
}

function brusselsOffsetMinutes(date) {
  const p = brusselsParts(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

// Parses a Europe/Brussels wall-clock time ("2026-10-25T02:30"), optionally
// with an explicit offset to disambiguate the repeated hour at the end of
// summer time. Returns a Date (UTC instant).
export function parseBrusselsLocal(value) {
  if (typeof value !== 'string') throw new EventError('invalid_datetime');
  const match = LOCAL_PATTERN.exec(value);
  if (!match) throw new EventError('invalid_datetime');
  const [, y, mo, d, h, mi, s = '00', offsetText] = match;
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const check = new Date(wall);
  if (check.getUTCFullYear() !== Number(y) || check.getUTCMonth() !== Number(mo) - 1
    || check.getUTCDate() !== Number(d) || check.getUTCHours() !== Number(h)
    || check.getUTCMinutes() !== Number(mi) || Number(y) < 2000 || Number(y) > 2100) {
    throw new EventError('invalid_datetime');
  }
  if (offsetText) {
    const offset = offsetText === 'Z' ? 0
      : (offsetText[0] === '-' ? -1 : 1) * (Number(offsetText.slice(1, 3)) * 60 + Number(offsetText.slice(4, 6)));
    const instant = new Date(wall - offset * 60000);
    if (offsetText !== 'Z' && brusselsOffsetMinutes(instant) !== offset) {
      throw new EventError('offset_not_valid_in_europe_brussels');
    }
    return instant;
  }
  const candidates = [60, 120]
    .map((offset) => new Date(wall - offset * 60000))
    .filter((instant) => {
      const p = brusselsParts(instant);
      return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) === wall;
    });
  if (candidates.length === 0) throw new EventError('nonexistent_local_time');
  if (candidates.length > 1) throw new EventError('ambiguous_local_time');
  return candidates[0];
}

export function formatBrusselsLocal(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  const p = brusselsParts(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`
    + formatOffset(brusselsOffsetMinutes(date));
}

function iso(value) {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

// ---------- permissions ----------

function contextFor(actor, grants) {
  if (!actor?.userId || !Array.isArray(actor.grants)) return null;
  return {
    session: { user: { id: actor.userId }, mfaVerified: Boolean(actor.mfaVerified) },
    grants,
  };
}

function schoolWide(actor, roles, schoolYearId) {
  // Only grants without class_id give school-wide scope.
  const context = contextFor(actor, (actor?.grants ?? []).filter((g) => !g.classId));
  return isAuthorized(context, { roles: [...roles], schoolYearId });
}

function classScoped(actor, classId, schoolYearId) {
  if (!classId) return false;
  const context = contextFor(actor, (actor?.grants ?? []).filter((g) => g.classId === classId));
  return isAuthorized(context, { roles: [...EVENT_POLICY.draftClass], classId, schoolYearId });
}

function canEdit(actor, event) {
  return schoolWide(actor, EVENT_POLICY.draftSchoolWide, event.school_year_id)
    || classScoped(actor, event.class_id, event.school_year_id);
}

function canReview(actor, event) {
  return schoolWide(actor, EVENT_POLICY.review, event.school_year_id);
}

function requireActor(actor) {
  if (!actor?.userId || !Array.isArray(actor.grants)) throw new EventError('unauthenticated', 401);
}

// ---------- validation ----------

function validId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function text(value, { min = 1, max, required = false, code }) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new EventError(code);
    return null;
  }
  if (typeof value !== 'string') throw new EventError(code);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) throw new EventError(code);
  return normalized;
}

function parseContent(input, base = null) {
  const pick = (key) => (base && !(key in input) ? base[key] : input[key]);
  const title = text(pick('title'), { min: 3, max: 200, required: true, code: 'invalid_title' });
  const description = text(pick('description'), { max: 4000, code: 'invalid_description' });
  const location = text(pick('location'), { max: 200, code: 'invalid_location' });
  const organizer = text(pick('organizer'), { max: 200, code: 'invalid_organizer' });
  const audience = pick('audience') ?? 'internal';
  if (!['internal', 'public'].includes(audience)) throw new EventError('invalid_audience');
  const startsRaw = pick('startsAt');
  const beginsAt = startsRaw instanceof Date ? startsRaw : parseBrusselsLocal(startsRaw);
  const endsRaw = pick('endsAt');
  const endsAt = endsRaw === undefined || endsRaw === null || endsRaw === ''
    ? null : (endsRaw instanceof Date ? endsRaw : parseBrusselsLocal(endsRaw));
  if (endsAt && endsAt < beginsAt) throw new EventError('ends_before_start');
  return { title, description, location, organizer, audience, beginsAt, endsAt };
}

function readRevision(input) {
  if (!Number.isSafeInteger(input?.revision) || input.revision < 1) throw new EventError('invalid_revision');
  return input.revision;
}

function sameContent(row, content) {
  return row.title === content.title
    && (row.description ?? null) === content.description
    && (row.location ?? null) === content.location
    && (row.organizer ?? null) === content.organizer
    && row.audience === content.audience
    && iso(row.begins_at) === content.beginsAt.toISOString()
    && iso(row.ends_at) === (content.endsAt ? content.endsAt.toISOString() : null);
}

// ---------- persistence helpers ----------

const EVENT_COLUMNS = `id, school_year_id, class_id, title, description, begins_at, ends_at,
  location, organizer, timezone, audience, visibility, status, revision_no, created_by,
  created_at, updated_by, updated_at, submitted_revision_no, submitted_by, submitted_at,
  approved_revision_no, approved_by, approved_at, published_revision_no, published_by,
  published_at, first_published_at, cancelled_by, cancelled_at, cancellation_reason,
  idempotency_key`;

function internalEvent(row) {
  return {
    id: row.id,
    schoolYearId: row.school_year_id,
    classId: row.class_id ?? null,
    status: row.status,
    visibility: row.visibility,
    audience: row.audience,
    revision: row.revision_no,
    title: row.title,
    description: row.description ?? null,
    location: row.location ?? null,
    organizer: row.organizer ?? null,
    timezone: row.timezone,
    startsAt: formatBrusselsLocal(row.begins_at),
    startsAtUtc: iso(row.begins_at),
    endsAt: formatBrusselsLocal(row.ends_at),
    endsAtUtc: iso(row.ends_at),
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
    cancelledAt: iso(row.cancelled_at),
    cancellationReason: row.cancellation_reason ?? null,
  };
}

function revisionFromRow(row) {
  return {
    revision: row.revision_no,
    title: row.title,
    description: row.description ?? null,
    location: row.location ?? null,
    organizer: row.organizer ?? null,
    audience: row.audience,
    startsAt: formatBrusselsLocal(row.begins_at),
    endsAt: formatBrusselsLocal(row.ends_at),
    source: row.source,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
  };
}

function publicEvent(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    location: row.location ?? null,
    organizer: row.organizer ?? null,
    timezone: row.timezone,
    startsAt: formatBrusselsLocal(row.begins_at),
    startsAtUtc: iso(row.begins_at),
    endsAt: formatBrusselsLocal(row.ends_at),
    endsAtUtc: iso(row.ends_at),
    status: row.public_status,
    // True after a re-publication and while a newer revision awaits approval
    // (the public page still shows the last published revision).
    changedAfterPublication: Boolean(row.pending_change || (row.first_published_at && row.published_at
      && iso(row.published_at) !== iso(row.first_published_at))),
  };
}

async function audit(tx, actorId, action, eventId, metadata) {
  // Metadata carries only workflow numbers, never titles, reasons or personal data.
  await tx.query(
    `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, metadata_json)
     VALUES ($1, $2, $3, 'event', $4, $5::jsonb)`,
    [crypto.randomUUID(), actorId, action, eventId, JSON.stringify(metadata)],
  );
}

async function lockEvent(tx, eventId) {
  if (!validId(eventId)) throw new EventError('invalid_event_id');
  const { rows } = await tx.query(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = $1 FOR UPDATE`, [eventId]);
  if (!rows[0]) throw new EventError('event_not_found', 404);
  return rows[0];
}

function isUniqueViolation(error) {
  return error?.code === '23505' || /duplicate key value/.test(String(error?.message ?? ''));
}

function mapDatabaseError(error) {
  const message = String(error?.message ?? error);
  if (message.includes('event_four_eyes_required')) throw new EventError('four_eyes_required', 409);
  if (message.includes('event_cancelled_is_final')) throw new EventError('event_cancelled', 409);
  if (/event_invalid_|event_content_and_workflow_change/.test(message)) throw new EventError('invalid_transition', 409);
  // Rok zamknięty (0017_year_close.sql): stan danych, nie awaria usługi.
  if (message.includes('school_year_closed')) throw new EventError('school_year_closed', 409);
  if (error?.code === '23503') throw new EventError('invalid_reference');
  if (error?.code === '23514') throw new EventError('invalid_request');
  throw error;
}

async function run(db, fn) {
  try {
    return await db.transaction(fn);
  } catch (error) {
    if (error instanceof EventError) throw error;
    mapDatabaseError(error);
  }
}

// ---------- domain operations ----------

export async function createDraft(db, actor, input) {
  requireActor(actor);
  if (!input || typeof input !== 'object') throw new EventError('invalid_request');
  if (!validId(input.schoolYearId)) throw new EventError('invalid_school_year');
  if (input.classId !== undefined && input.classId !== null && !validId(input.classId)) {
    throw new EventError('invalid_class');
  }
  const idempotencyKey = input.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    throw new EventError('invalid_idempotency_key');
  }
  const scope = { school_year_id: input.schoolYearId, class_id: input.classId ?? null };
  if (!canEdit(actor, scope)) throw new EventError('forbidden', 403);
  const content = parseContent(input);

  const replay = async () => {
    const { rows } = await db.query(`SELECT ${EVENT_COLUMNS} FROM events WHERE idempotency_key = $1`, [idempotencyKey]);
    const row = rows[0];
    if (!row) return null;
    const { rows: first } = await db.query(
      `SELECT * FROM event_revisions WHERE event_id = $1 AND revision_no = 1`, [row.id],
    );
    const original = first[0];
    if (row.created_by !== actor.userId || row.school_year_id !== scope.school_year_id
      || (row.class_id ?? null) !== scope.class_id || !original || !sameContent(original, content)) {
      throw new EventError('idempotency_conflict', 409);
    }
    return { event: internalEvent(row), replayed: true };
  };

  const existing = await replay();
  if (existing) return existing;
  const id = crypto.randomUUID();
  try {
    return await db.transaction(async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO events (id, school_year_id, class_id, title, description, begins_at, ends_at,
           location, organizer, audience, visibility, created_by, updated_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           CASE WHEN $10 = 'public' THEN 'draft_public' ELSE 'internal' END, $11, $11, $12)
         RETURNING ${EVENT_COLUMNS}`,
        [id, scope.school_year_id, scope.class_id, content.title, content.description,
          content.beginsAt, content.endsAt, content.location, content.organizer, content.audience,
          actor.userId, idempotencyKey],
      );
      await audit(tx, actor.userId, 'event.created', id, { revision: 1, status: 'draft' });
      return { event: internalEvent(rows[0]), replayed: false };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const replayed = await replay();
      if (replayed) return replayed;
    }
    if (error instanceof EventError) throw error;
    mapDatabaseError(error);
  }
}

// Class and school year are fixed at creation (trigger event_identity_immutable);
// updateDraft changes content only — `classId`/`schoolYearId` in the input are ignored.
export async function updateDraft(db, actor, input) {
  requireActor(actor);
  const expected = readRevision(input);
  return run(db, async (tx) => {
    const row = await lockEvent(tx, input.eventId);
    // Same answer as a missing id: do not reveal other classes' events (SR-07).
    if (!canEdit(actor, row)) throw new EventError('event_not_found', 404);
    if (row.status === 'cancelled') throw new EventError('event_cancelled', 409);
    const base = {
      title: row.title, description: row.description, location: row.location,
      organizer: row.organizer, audience: row.audience,
      startsAt: new Date(row.begins_at), endsAt: row.ends_at ? new Date(row.ends_at) : null,
    };
    // A stale revision is a conflict even when the stale edit would not validate
    // against the current content; only a double submit of the same edit is replayed.
    if (row.revision_no !== expected) {
      if (row.revision_no === expected + 1 && row.updated_by === actor.userId) {
        let repeated = null;
        try { repeated = parseContent(input, base); } catch (error) {
          if (!(error instanceof EventError)) throw error;
        }
        if (repeated && sameContent(row, repeated)) return { event: internalEvent(row), replayed: true };
      }
      throw new EventError('revision_conflict', 409);
    }
    const content = parseContent(input, base);
    if (sameContent(row, content)) return { event: internalEvent(row), replayed: true };
    const { rows } = await tx.query(
      `UPDATE events SET title = $2, description = $3, begins_at = $4, ends_at = $5,
         location = $6, organizer = $7, audience = $8, updated_by = $9
       WHERE id = $1 RETURNING ${EVENT_COLUMNS}`,
      [row.id, content.title, content.description, content.beginsAt, content.endsAt,
        content.location, content.organizer, content.audience, actor.userId],
    );
    await audit(tx, actor.userId, 'event.revised', row.id, { revision: rows[0].revision_no, status: 'draft' });
    return { event: internalEvent(rows[0]), replayed: false };
  });
}

async function transition(db, actor, input, spec) {
  requireActor(actor);
  const expected = readRevision(input);
  return run(db, async (tx) => {
    const row = await lockEvent(tx, input.eventId);
    // Out of scope looks like a missing id (SR-07); visible but not allowed is 403.
    if (!canEdit(actor, row)) throw new EventError('event_not_found', 404);
    if (!spec.allowed(actor, row)) throw new EventError('forbidden', 403);
    if (spec.alreadyDone(row, expected)) return { event: internalEvent(row), replayed: true };
    if (row.status === 'cancelled') throw new EventError('event_cancelled', 409);
    if (row.revision_no !== expected) throw new EventError('revision_conflict', 409);
    if (!spec.from.includes(row.status)) throw new EventError('invalid_transition', 409);
    spec.validate?.(actor, row);
    const { sql, params } = spec.update(row, actor);
    const { rows } = await tx.query(
      `UPDATE events SET ${sql} WHERE id = $1 RETURNING ${EVENT_COLUMNS}`, [row.id, ...params],
    );
    await audit(tx, actor.userId, spec.action, row.id, { revision: row.revision_no, status: rows[0].status });
    return { event: internalEvent(rows[0]), replayed: false };
  });
}

export function submit(db, actor, input) {
  return transition(db, actor, input, {
    action: 'event.submitted',
    from: ['draft'],
    allowed: canEdit,
    alreadyDone: (row, rev) => row.revision_no === rev && row.submitted_revision_no === rev
      && ['submitted', 'approved', 'published'].includes(row.status),
    update: (row, actor) => ({
      sql: `status = 'submitted', submitted_revision_no = $2, submitted_by = $3, submitted_at = now()`,
      params: [row.revision_no, actor.userId],
    }),
  });
}

export function approve(db, actor, input) {
  return transition(db, actor, input, {
    action: 'event.approved',
    from: ['submitted'],
    allowed: canReview,
    alreadyDone: (row, rev) => row.revision_no === rev && row.approved_revision_no === rev
      && ['approved', 'published'].includes(row.status),
    update: (row, actor) => ({
      sql: `status = 'approved', approved_revision_no = $2, approved_by = $3, approved_at = now()`,
      params: [row.revision_no, actor.userId],
    }),
  });
}

export function publish(db, actor, input) {
  return transition(db, actor, input, {
    action: 'event.published',
    from: ['approved'],
    allowed: canReview,
    alreadyDone: (row, rev) => row.revision_no === rev && row.published_revision_no === rev
      && row.status === 'published',
    validate: (_actor, row) => {
      if (row.audience !== 'public') throw new EventError('event_not_public', 409);
    },
    update: (row, actor) => ({
      sql: `status = 'published', published_revision_no = $2, published_by = $3,
            published_at = now(), first_published_at = COALESCE(first_published_at, now())`,
      params: [row.revision_no, actor.userId],
    }),
  });
}

export async function cancel(db, actor, input) {
  requireActor(actor);
  const reason = text(input?.reason, { min: 3, max: 500, required: true, code: 'invalid_reason' });
  return transition(db, actor, input, {
    action: 'event.cancelled',
    from: ['draft', 'submitted', 'approved', 'published'],
    // A published event may be cancelled only by reviewers; an unpublished
    // one also by whoever may edit it (e.g. withdrawing a class proposal).
    allowed: (a, row) => canReview(a, row) || (row.published_revision_no === null && canEdit(a, row)),
    alreadyDone: (row) => row.status === 'cancelled',
    update: (_row, actor) => ({
      sql: `status = 'cancelled', cancelled_by = $2, cancelled_at = now(), cancellation_reason = $3`,
      params: [actor.userId, reason],
    }),
  });
}

export async function getInternal(db, actor, input) {
  requireActor(actor);
  if (!validId(input?.eventId)) throw new EventError('invalid_event_id');
  const { rows } = await db.query(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = $1`, [input.eventId]);
  const row = rows[0];
  // Same answer for missing and forbidden: do not reveal existence of other classes' drafts.
  if (!row || !canEdit(actor, row)) throw new EventError('event_not_found', 404);
  const { rows: revisions } = await db.query(
    'SELECT * FROM event_revisions WHERE event_id = $1 ORDER BY revision_no', [row.id],
  );
  return { event: internalEvent(row), revisions: revisions.map(revisionFromRow) };
}

export async function listInternal(db, actor, input) {
  requireActor(actor);
  if (!validId(input?.schoolYearId)) throw new EventError('invalid_school_year');
  const schoolYearId = input.schoolYearId;
  if (schoolWide(actor, EVENT_POLICY.draftSchoolWide, schoolYearId)
    || schoolWide(actor, EVENT_POLICY.review, schoolYearId)) {
    const { rows } = await db.query(
      `SELECT ${EVENT_COLUMNS} FROM events WHERE school_year_id = $1 ORDER BY begins_at, id`, [schoolYearId],
    );
    return { events: rows.map(internalEvent) };
  }
  const classIds = [...new Set(actor.grants
    .filter((g) => g.classId && classScoped(actor, g.classId, schoolYearId))
    .map((g) => g.classId))];
  if (!classIds.length) throw new EventError('forbidden', 403);
  const { rows } = await db.query(
    `SELECT ${EVENT_COLUMNS} FROM events
      WHERE school_year_id = $1 AND class_id = ANY($2::text[]) ORDER BY begins_at, id`,
    [schoolYearId, classIds],
  );
  return { events: rows.map(internalEvent) };
}

export async function listPublic(db, input = {}) {
  const conditions = [];
  const params = [];
  if (input.schoolYearId !== undefined && input.schoolYearId !== null) {
    if (!validId(input.schoolYearId)) throw new EventError('invalid_school_year');
    params.push(input.schoolYearId);
    conditions.push(`school_year_id = $${params.length}`);
  }
  if (input.from) {
    params.push(parseBrusselsLocal(`${input.from}T00:00`));
    conditions.push(`COALESCE(ends_at, begins_at) >= $${params.length}`);
  }
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new EventError('invalid_limit');
  params.push(limit);
  const { rows } = await db.query(
    `SELECT id, title, description, begins_at, ends_at, location, organizer, timezone,
            public_status, published_at, first_published_at,
            (SELECT e.status <> 'cancelled' AND e.revision_no <> e.published_revision_no
               FROM events e WHERE e.id = public_events.id) AS pending_change
       FROM public_events
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY begins_at, id LIMIT $${params.length}`,
    params,
  );
  return { timezone: EVENT_TIMEZONE, events: rows.map(publicEvent) };
}

// ---------- HTTP ----------

async function readJson(request) {
  const type = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw new EventError('invalid_content_type', 415);
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new EventError('request_too_large', 413);
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) throw new EventError('request_too_large', 413);
  try {
    const data = JSON.parse(body);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new EventError('invalid_json');
  }
}

function decodeId(value) {
  try {
    const id = decodeURIComponent(value);
    if (!validId(id)) throw new Error();
    return id;
  } catch {
    throw new EventError('invalid_event_id');
  }
}

async function loadActor(request, env) {
  if (typeof env?.loadAuthorizationContext !== 'function') throw new EventError('service_unavailable', 503);
  const context = await env.loadAuthorizationContext(request, env);
  if (!context?.session?.user?.id) throw new EventError('unauthenticated', 401);
  return {
    userId: context.session.user.id,
    grants: Array.isArray(context.grants) ? context.grants : [],
    mfaVerified: Boolean(context.session.mfaVerified),
  };
}

function pick(data, keys) {
  return Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]]));
}

// Handles /api/public/events and /api/events... Returns null for other paths.
// env.db: { query, transaction }; env.loadAuthorizationContext(request, env)
// -> { session: { user: { id }, mfaVerified }, grants } | null.
export async function handle(request, env, url, json) {
  const path = url.pathname;
  const isPublic = path === '/api/public/events';
  if (!isPublic && path !== '/api/events' && !path.startsWith('/api/events/')) return null;
  try {
    if (!env?.db) throw new EventError('service_unavailable', 503);
    if (isPublic) {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      const limitText = url.searchParams.get('limit');
      if (limitText !== null && !/^\d{1,3}$/.test(limitText)) throw new EventError('invalid_limit');
      const from = url.searchParams.get('from');
      if (from !== null && !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new EventError('invalid_date');
      const result = await listPublic(env.db, {
        schoolYearId: url.searchParams.get('schoolYearId') ?? undefined,
        from: from ?? undefined,
        limit: limitText === null ? undefined : Number(limitText),
      });
      return json(result, 200, { 'Cache-Control': 'public, max-age=60' });
    }

    const itemMatch = path.match(/^\/api\/events\/([^/]+)$/);
    const actionMatch = path.match(/^\/api\/events\/([^/]+)\/(submit|approve|publish|cancel)$/);
    const isList = path === '/api/events' && request.method === 'GET';
    const isCreate = path === '/api/events' && request.method === 'POST';
    const isGet = itemMatch && request.method === 'GET';
    const isUpdate = itemMatch && request.method === 'PATCH';
    const isAction = actionMatch && request.method === 'POST';
    if (!isList && !isCreate && !isGet && !isUpdate && !isAction) {
      return json({ error: 'not_found' }, 404);
    }
    if ((isCreate || isUpdate || isAction) && !isSameOrigin(request)) {
      return json({ error: 'invalid_origin' }, 403);
    }
    const actor = await loadActor(request, env);
    const noStore = { 'Cache-Control': 'no-store' };

    if (isList) return json(await listInternal(env.db, actor, { schoolYearId: url.searchParams.get('schoolYearId') }), 200, noStore);
    if (isGet) return json(await getInternal(env.db, actor, { eventId: decodeId(itemMatch[1]) }), 200, noStore);

    const data = await readJson(request);
    if (isCreate) {
      const idempotencyKey = request.headers.get('Idempotency-Key')?.trim();
      if (!idempotencyKey || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) throw new EventError('invalid_idempotency_key');
      const result = await createDraft(env.db, actor, {
        ...pick(data, ['schoolYearId', 'classId', ...CONTENT_FIELDS]), idempotencyKey,
      });
      return json({ event: result.event }, result.replayed ? 200 : 201, {
        ...noStore, 'Idempotency-Replayed': String(result.replayed),
      });
    }
    if (isUpdate) {
      const result = await updateDraft(env.db, actor, {
        ...pick(data, ['revision', ...CONTENT_FIELDS]), eventId: decodeId(itemMatch[1]),
      });
      return json({ event: result.event, replayed: result.replayed }, 200, noStore);
    }
    const operations = { submit, approve, publish, cancel };
    const result = await operations[actionMatch[2]](env.db, actor, {
      ...pick(data, ['revision', 'reason']), eventId: decodeId(actionMatch[1]),
    });
    return json({ event: result.event, replayed: result.replayed }, 200, noStore);
  } catch (error) {
    if (error instanceof EventError) return json({ error: error.code }, error.status);
    throw error;
  }
}
