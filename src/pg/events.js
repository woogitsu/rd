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
import { createHash } from 'node:crypto';
import { isSameOrigin } from '../auth.js';
import { actorContext, authorizedClassIds, isAuthorizedForOwnClass, isAuthorizedScoped } from './scope.js';
import { buildCalendar, icalUidDomain } from '../ical.js';
import { insertAuditEvent } from './audit.js';
import { recordDataAccess } from './data-access.js';
import { gateFreeText, piiAuditMetadata } from './pii-gate.js';
import { createJsonReader, isUniqueError } from './input.js';

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
  constructor(code, status = 400, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    // #152: pola dodatkowe odpowiedzi (kategorie bramki danych osobowych) — nigdy treść.
    this.extra = extra;
  }
}

// #152: błąd 422 bramki pól wolnego tekstu (src/pg/pii-gate.js).
const piiFail = (code, categories) => new EventError(code, 422, { categories });

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

// Zakres z src/pg/scope.js (#155): szkolny — wyłącznie przydział bez klasy
// (SR-01); klasowy — wyłącznie przydział tej klasy.
function schoolWide(actor, roles, schoolYearId) {
  return isAuthorizedScoped(actorContext(actor), { roles: [...roles], schoolYearId });
}

function classScoped(actor, classId, schoolYearId) {
  return isAuthorizedForOwnClass(actorContext(actor), { roles: [...EVENT_POLICY.draftClass], classId, schoolYearId });
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

// #184: przechodzi przez insertAuditEvent (assertNoPii), nie własny INSERT.
// entityType domyślnie 'event'; #142 audytuje też event_task/event_task_signup
// (metadata carries only workflow numbers and identifiers, never titles,
// reasons or personal data — no guardian/user id either).
async function audit(tx, actorId, action, eventId, metadata, entityType = 'event') {
  await insertAuditEvent(tx, { actorId, action, entityType, entityId: eventId, metadata });
}

async function lockEvent(tx, eventId) {
  if (!validId(eventId)) throw new EventError('invalid_event_id');
  const { rows } = await tx.query(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = $1 FOR UPDATE`, [eventId]);
  if (!rows[0]) throw new EventError('event_not_found', 404);
  return rows[0];
}

function mapDatabaseError(error) {
  const message = String(error?.message ?? error);
  if (message.includes('event_four_eyes_required')) throw new EventError('four_eyes_required', 409);
  if (message.includes('event_cancelled_is_final')) throw new EventError('event_cancelled', 409);
  if (/event_invalid_|event_content_and_workflow_change/.test(message)) throw new EventError('invalid_transition', 409);
  // Rok zamknięty (0017_year_close.sql): stan danych, nie awaria usługi.
  if (message.includes('school_year_closed')) throw new EventError('school_year_closed', 409);
  // Issue #142: limit miejsc i odwołanie wydarzenia (trigger event_task_signup_capacity, 0076).
  if (message.includes('task_full')) throw new EventError('task_full', 409);
  if (message.includes('event_cancelled')) throw new EventError('event_cancelled', 409);
  if (message.includes('event_task_not_found')) throw new EventError('event_task_not_found', 404);
  if (message.includes('event_tasks_are_immutable') || message.includes('event_task_already_cancelled')) {
    throw new EventError('event_task_already_cancelled', 409);
  }
  if (message.includes('event_task_signups_identity_is_immutable')) throw new EventError('invalid_request', 409);
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
      await audit(tx, actor.userId, 'event.created', id,
        { schoolYearId: scope.school_year_id, revision: 1, status: 'draft' });
      return { event: internalEvent(rows[0]), replayed: false };
    });
  } catch (error) {
    if (isUniqueError(error)) {
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
        if (repeated && sameContent(row, repeated)) {
          return { event: internalEvent(row), replayed: true, tasksOutsideEventTime: await tasksOutsideEventTime(tx, row) };
        }
      }
      throw new EventError('revision_conflict', 409);
    }
    const content = parseContent(input, base);
    if (sameContent(row, content)) {
      return { event: internalEvent(row), replayed: true, tasksOutsideEventTime: await tasksOutsideEventTime(tx, row) };
    }
    const { rows } = await tx.query(
      `UPDATE events SET title = $2, description = $3, begins_at = $4, ends_at = $5,
         location = $6, organizer = $7, audience = $8, updated_by = $9
       WHERE id = $1 RETURNING ${EVENT_COLUMNS}`,
      [row.id, content.title, content.description, content.beginsAt, content.endsAt,
        content.location, content.organizer, content.audience, actor.userId],
    );
    await audit(tx, actor.userId, 'event.revised', row.id,
      { schoolYearId: row.school_year_id, revision: rows[0].revision_no, status: 'draft' });
    // #142: zmiana czasu wydarzenia nie odwołuje zadań ani zapisów — wykazujemy
    // w odpowiedzi zadania, których okno wykracza poza nowy czas wydarzenia.
    return { event: internalEvent(rows[0]), replayed: false, tasksOutsideEventTime: await tasksOutsideEventTime(tx, rows[0]) };
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
    // #150 (SR-10): zatwierdzenie i publikacja wymagają jawnie potwierdzonego MFA
    // na poziomie trasy, niezależnie od bramki routera. Sprawdzane PO roli/zakresie
    // (SR-07) — sama rola bez MFA nadal dostaje ogólny `forbidden`, jeśli w ogóle
    // nie ma dostępu; `mfa_required` tylko gdy dostęp jest, brakuje tylko MFA.
    if (spec.requireMfa && !actor.mfaVerified) throw new EventError('mfa_required', 403);
    if (spec.alreadyDone(row, expected)) return { event: internalEvent(row), replayed: true };
    if (row.status === 'cancelled') throw new EventError('event_cancelled', 409);
    if (row.revision_no !== expected) throw new EventError('revision_conflict', 409);
    if (!spec.from.includes(row.status)) throw new EventError('invalid_transition', 409);
    spec.validate?.(actor, row);
    const { sql, params } = spec.update(row, actor);
    const { rows } = await tx.query(
      `UPDATE events SET ${sql} WHERE id = $1 RETURNING ${EVENT_COLUMNS}`, [row.id, ...params],
    );
    await audit(tx, actor.userId, spec.action, row.id,
      { schoolYearId: row.school_year_id, revision: row.revision_no, status: rows[0].status });
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
    requireMfa: true,
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
    requireMfa: true,
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
  const classIds = authorizedClassIds(actorContext(actor), { roles: [...EVENT_POLICY.draftClass], schoolYearId });
  if (!classIds.length) throw new EventError('forbidden', 403);
  const { rows } = await db.query(
    `SELECT ${EVENT_COLUMNS} FROM events
      WHERE school_year_id = $1 AND class_id = ANY($2::text[]) ORDER BY begins_at, id`,
    [schoolYearId, classIds],
  );
  return { events: rows.map(internalEvent) };
}

// ---------- volunteer tasks and signups (issue #142, Etap 1) ----------
//
// No parent accounts yet (D-10): a class representative signs up an EXISTING
// guardian of a child in THEIR OWN class (checked below), or a board/admin
// account signs up any guardian or user account. No new personal data is
// collected — only a reference to an existing guardian or user id.

const TASK_TITLE_LIMIT = { min: 3, max: 200, code: 'invalid_title' };

function toTask(row) {
  return {
    id: row.id,
    eventId: row.event_id,
    title: row.title,
    startsAtUtc: iso(row.starts_at),
    endsAtUtc: iso(row.ends_at),
    slotsNeeded: row.slots_needed,
    isPublic: row.is_public,
    cancelledAt: iso(row.cancelled_at),
    cancellationReason: row.cancellation_reason ?? null,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
  };
}

function toSignup(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    userId: row.user_id ?? null,
    guardianId: row.guardian_id ?? null,
    // Nazwisko dołączane wyłącznie w odpowiedzi dla autoryzowanego widoku
    // (GET listy zadań), nigdy w publicznym API ani w dzienniku.
    personName: row.person_name ?? undefined,
    status: row.status,
    recordedBy: row.recorded_by,
    createdAt: iso(row.created_at),
    updatedBy: row.updated_by,
    updatedAt: iso(row.updated_at),
  };
}

// Okno zadania poza czasem wydarzenia (początek zadania przed początkiem
// wydarzenia albo koniec zadania po końcu wydarzenia, gdy wydarzenie ma koniec).
// Przy tworzeniu zadania odrzucane (task_time_outside_event); po późniejszej
// zmianie czasu wydarzenia tylko wykazywane — zadanie i zapisy zostają.
function isOutsideEventTime(task, event) {
  const begins = new Date(event.begins_at).getTime();
  const ends = event.ends_at ? new Date(event.ends_at).getTime() : null;
  if (task.starts_at && new Date(task.starts_at).getTime() < begins) return true;
  if (task.ends_at && ends !== null && new Date(task.ends_at).getTime() > ends) return true;
  return false;
}

async function tasksOutsideEventTime(executor, event) {
  const { rows } = await executor.query(
    'SELECT id, title, starts_at, ends_at FROM event_tasks WHERE event_id = $1 AND cancelled_at IS NULL ORDER BY created_at, id',
    [event.id],
  );
  return rows.filter((task) => isOutsideEventTime(task, event)).map((task) => ({ id: task.id, title: task.title }));
}

function parseTaskInput(input, event) {
  const title = text(input?.title, { ...TASK_TITLE_LIMIT, required: true });
  const slotsNeeded = input?.slotsNeeded;
  if (!Number.isSafeInteger(slotsNeeded) || slotsNeeded < 1 || slotsNeeded > 200) {
    throw new EventError('invalid_slots_needed');
  }
  const isPublic = Boolean(input?.isPublic);
  const parseOptional = (value) => (value === undefined || value === null || value === '' ? null : parseBrusselsLocal(value));
  const startsAt = parseOptional(input?.startsAt);
  const endsAt = parseOptional(input?.endsAt);
  if (startsAt && endsAt && endsAt < startsAt) throw new EventError('ends_before_start');
  // "W obrębie wydarzenia" (issue #142 propozycja punkt 1): zadanie nie może
  // zaczynać się przed wydarzeniem ani kończyć po nim (gdy wydarzenie ma
  // koniec). Zmiana czasu wydarzenia PO utworzeniu zadania jest wykazywana
  // (outsideEventTime w liście, tasksOutsideEventTime w odpowiedzi PATCH).
  if (isOutsideEventTime({ starts_at: startsAt, ends_at: endsAt }, event)) throw new EventError('task_time_outside_event');
  return { title, slotsNeeded, isPublic, startsAt, endsAt };
}

function sameTaskContent(row, content, eventId) {
  return row.event_id === eventId && row.title === content.title && row.slots_needed === content.slotsNeeded
    && row.is_public === content.isPublic
    && iso(row.starts_at) === (content.startsAt ? content.startsAt.toISOString() : null)
    && iso(row.ends_at) === (content.endsAt ? content.endsAt.toISOString() : null);
}

export async function createTask(db, actor, input) {
  requireActor(actor);
  const eventId = decodeId(input?.eventId);
  const idempotencyKey = input?.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    throw new EventError('invalid_idempotency_key');
  }
  return run(db, async (tx) => {
    const event = await lockEvent(tx, eventId);
    // Ten sam 404 dla wydarzenia nieznanego i niedostępnego (brak wyroczni istnienia).
    if (!canEdit(actor, event)) throw new EventError('event_not_found', 404);
    const existing = (await tx.query('SELECT * FROM event_tasks WHERE idempotency_key = $1', [idempotencyKey])).rows[0];
    const content = parseTaskInput(input, event);
    if (existing) {
      if (!sameTaskContent(existing, content, eventId)) throw new EventError('idempotency_conflict', 409);
      return { task: toTask(existing), replayed: true };
    }
    const gate = gateFreeText([['event_tasks.title', content.title]], { confirm: input?.confirmPersonalData === true, fail: piiFail });
    const id = crypto.randomUUID();
    const { rows } = await tx.query(
      `INSERT INTO event_tasks (id, event_id, title, starts_at, ends_at, slots_needed, is_public, created_by, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [id, eventId, content.title, content.startsAt, content.endsAt, content.slotsNeeded, content.isPublic, actor.userId, idempotencyKey],
    );
    await audit(tx, actor.userId, 'event.task_created', id, { eventId, schoolYearId: event.school_year_id, slotsNeeded: content.slotsNeeded, ...piiAuditMetadata(gate) }, 'event_task');
    return { task: toTask(rows[0]) };
  });
}

export async function cancelTask(db, actor, input) {
  requireActor(actor);
  const eventId = decodeId(input?.eventId);
  const taskId = decodeId(input?.taskId);
  const reason = text(input?.reason, { min: 3, max: 500, required: true, code: 'invalid_reason' });
  return run(db, async (tx) => {
    const event = await lockEvent(tx, eventId);
    if (!canEdit(actor, event)) throw new EventError('event_not_found', 404);
    const { rows } = await tx.query('SELECT * FROM event_tasks WHERE id = $1 AND event_id = $2 FOR UPDATE', [taskId, eventId]);
    const task = rows[0];
    if (!task) throw new EventError('event_task_not_found', 404);
    if (task.cancelled_at) return { task: toTask(task), replayed: true };
    const gate = gateFreeText([['event_tasks.cancellation_reason', reason]], { confirm: input?.confirmPersonalData === true, fail: piiFail });
    const { rows: updated } = await tx.query(
      `UPDATE event_tasks SET cancelled_at = now(), cancelled_by = $2, cancellation_reason = $3 WHERE id = $1 RETURNING *`,
      [taskId, actor.userId, reason],
    );
    await audit(tx, actor.userId, 'event.task_cancelled', taskId, { eventId, schoolYearId: event.school_year_id, ...piiAuditMetadata(gate) }, 'event_task');
    return { task: toTask(updated[0]) };
  });
}

export async function listTasks(db, actor, input) {
  requireActor(actor);
  const eventId = decodeId(input?.eventId);
  const { rows } = await db.query(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = $1`, [eventId]);
  const event = rows[0];
  if (!event || !canEdit(actor, event)) throw new EventError('event_not_found', 404);
  const { rows: taskRows } = await db.query('SELECT * FROM event_tasks WHERE event_id = $1 ORDER BY created_at, id', [eventId]);
  const { rows: signupRows } = await db.query(
    `SELECT s.*, COALESCE(g.first_name || ' ' || g.last_name, u.display_name) AS person_name
       FROM event_task_signups s
       LEFT JOIN guardians g ON g.id = s.guardian_id
       LEFT JOIN users u ON u.id = s.user_id
      WHERE s.task_id = ANY($1::text[]) ORDER BY s.created_at, s.id`,
    [taskRows.map((row) => row.id)],
  );
  // #133: nazwisko opiekuna w zgłoszeniach = odczyt danych opiekuna; ślad bez
  // nazwisk i identyfikatorów opiekunów (tylko liczba), tylko gdy lista je zawiera.
  const guardianSignups = signupRows.filter((row) => row.guardian_id).length;
  if (guardianSignups > 0) {
    await insertAuditEvent(db, {
      actorId: actor.userId, action: 'event.task_signups_viewed', entityType: 'event', entityId: eventId,
      metadata: { schoolYearId: event.school_year_id, guardianSignups },
    });
  }
  const byTask = new Map();
  for (const row of signupRows) {
    const list = byTask.get(row.task_id) ?? [];
    list.push(toSignup(row));
    byTask.set(row.task_id, list);
  }
  return {
    tasks: taskRows.map((row) => ({
      ...toTask(row),
      outsideEventTime: !row.cancelled_at && isOutsideEventTime(row, event),
      signups: byTask.get(row.id) ?? [],
      confirmedCount: (byTask.get(row.id) ?? []).filter((s) => s.status === 'confirmed').length,
    })),
  };
}

// Przedstawiciel może wskazać wyłącznie opiekuna dziecka z przypisanej klasy
// w bieżącym roku (issue #142, kryteria akceptacji) — sprawdzone po stronie
// serwera niezależnie od tego, co pokazuje formularz. Zarząd/administrator
// (przydział bez klasy) nie ma tego ograniczenia.
// Tylko BIEŻĄCE relacje i przypisania (widoki student_guardians_current i
// enrollments_current, #157/#86): opiekun po zakończeniu relacji albo dziecko,
// które odeszło z klasy, nie może być już zapisane przez przedstawiciela.
async function assertGuardianInClass(tx, guardianId, event) {
  if (!event.class_id) return; // wydarzenie ogólnoszkolne: brak ograniczenia klasy
  const { rows } = await tx.query(
    `SELECT 1 FROM student_guardians_current sg
       JOIN enrollments_current en ON en.student_id = sg.student_id
      WHERE sg.guardian_id = $1 AND en.class_id = $2 AND en.school_year_id = $3 LIMIT 1`,
    [guardianId, event.class_id, event.school_year_id],
  );
  if (!rows[0]) throw new EventError('guardian_outside_class', 400);
}

// Lista opiekunów do wyboru w formularzu zapisu (panel events/): wyłącznie
// imię i nazwisko opiekunów z bieżącą relacją do dziecka bieżąco przypisanego
// do klasy wydarzenia — bez e-maili, dzieci i gospodarstw. Wydarzenie
// ogólnoszkolne (tylko zarząd/admin): klasa wskazana parametrem, z roku
// wydarzenia. Odczyt imion opiekunów klasy = wpis w data_access_log
// (class_students, #133), także przy odmowie.
export async function listTaskCandidates(db, actor, input) {
  requireActor(actor);
  const eventId = decodeId(input?.eventId);
  if (!validId(eventId)) throw new EventError('invalid_event_id');
  const { rows } = await db.query(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = $1`, [eventId]);
  const event = rows[0];
  if (!event || !canEdit(actor, event)) throw new EventError('event_not_found', 404);
  let classId = event.class_id;
  if (!classId) {
    classId = input?.classId ?? null;
    if (!classId) throw new EventError('class_required');
    if (!validId(classId)) throw new EventError('invalid_class');
  } else if (input?.classId && input.classId !== classId) {
    throw new EventError('invalid_class');
  }
  const { rows: classRows } = await db.query(
    'SELECT id FROM classes WHERE id = $1 AND school_year_id = $2', [classId, event.school_year_id],
  );
  if (!classRows[0]) {
    await recordDataAccess({ db }, {
      actorId: actor.userId, accessKind: 'class_students', schoolYearId: event.school_year_id, outcome: 'not_found',
    });
    throw new EventError('class_not_found', 404);
  }
  const { rows: guardians } = await db.query(
    `SELECT DISTINCT g.id, g.first_name, g.last_name
       FROM enrollments_current en
       JOIN student_guardians_current sg ON sg.student_id = en.student_id
       JOIN guardians g ON g.id = sg.guardian_id
      WHERE en.class_id = $1 AND en.school_year_id = $2
      ORDER BY g.last_name, g.first_name, g.id`,
    [classId, event.school_year_id],
  );
  await recordDataAccess({ db }, {
    actorId: actor.userId, accessKind: 'class_students', schoolYearId: event.school_year_id, classId,
    outcome: 'ok', rowCount: guardians.length,
  });
  return {
    classId,
    guardians: guardians.map((row) => ({ id: row.id, name: `${row.first_name} ${row.last_name}`.trim() })),
  };
}

export async function createSignup(db, actor, input) {
  requireActor(actor);
  const eventId = decodeId(input?.eventId);
  const taskId = decodeId(input?.taskId);
  const idempotencyKey = input?.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    throw new EventError('invalid_idempotency_key');
  }
  const guardianId = input?.guardianId ?? null;
  const userId = input?.userId ?? null;
  if (Boolean(guardianId) === Boolean(userId)) throw new EventError('invalid_signup_target');
  if (guardianId && !validId(guardianId)) throw new EventError('invalid_signup_target');
  if (userId && !validId(userId)) throw new EventError('invalid_signup_target');

  return run(db, async (tx) => {
    const event = await lockEvent(tx, eventId);
    if (!canEdit(actor, event)) throw new EventError('event_not_found', 404);
    const { rows: taskRows } = await tx.query('SELECT * FROM event_tasks WHERE id = $1 AND event_id = $2', [taskId, eventId]);
    const task = taskRows[0];
    if (!task) throw new EventError('event_task_not_found', 404);
    if (guardianId && !schoolWide(actor, EVENT_POLICY.draftSchoolWide, event.school_year_id)) {
      await assertGuardianInClass(tx, guardianId, event);
    }
    const existing = (await tx.query(
      `SELECT * FROM event_task_signups WHERE task_id = $1 AND (user_id = $2 OR guardian_id = $3) FOR UPDATE`,
      [taskId, userId, guardianId],
    )).rows[0];
    if (existing && existing.status === 'confirmed') {
      // Już zapisany: bezpieczna powtórka (podwójne kliknięcie), niezależnie od klucza.
      return { signup: toSignup(existing), replayed: true };
    }
    if (existing) {
      // Wycofany wcześniej -> ponowny zapis to przejście stanu tego samego
      // wiersza (historia w audit_events), nie nowy wiersz — patrz migracja.
      const { rows: updated } = await tx.query(
        `UPDATE event_task_signups SET status = 'confirmed', updated_by = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [existing.id, actor.userId],
      );
      await audit(tx, actor.userId, 'event.task_signup_created', existing.id, { taskId, eventId, schoolYearId: event.school_year_id }, 'event_task_signup');
      return { signup: toSignup(updated[0]) };
    }
    const id = crypto.randomUUID();
    let inserted;
    try {
      inserted = (await tx.query(
        `INSERT INTO event_task_signups (id, task_id, user_id, guardian_id, status, recorded_by, updated_by)
         VALUES ($1, $2, $3, $4, 'confirmed', $5, $5) RETURNING *`,
        [id, taskId, userId, guardianId, actor.userId],
      )).rows[0];
    } catch (error) {
      // Wyścig: dwa równoległe pierwsze zapisy tej samej osoby do tego
      // samego zadania (FOR UPDATE wyżej nie blokuje wiersza, który jeszcze
      // nie istnieje) — drugi przegrywa unikalny indeks, nie limit miejsc.
      if (isUniqueError(error)) {
        const again = (await tx.query(
          'SELECT * FROM event_task_signups WHERE task_id = $1 AND (user_id = $2 OR guardian_id = $3)',
          [taskId, userId, guardianId],
        )).rows[0];
        if (again) return { signup: toSignup(again), replayed: true };
      }
      throw error;
    }
    await audit(tx, actor.userId, 'event.task_signup_created', id, { taskId, eventId, schoolYearId: event.school_year_id }, 'event_task_signup');
    return { signup: toSignup(inserted) };
  });
}

export async function withdrawSignup(db, actor, input) {
  requireActor(actor);
  const eventId = decodeId(input?.eventId);
  const taskId = decodeId(input?.taskId);
  const signupId = decodeId(input?.signupId);
  return run(db, async (tx) => {
    const event = await lockEvent(tx, eventId);
    if (!canEdit(actor, event)) throw new EventError('event_not_found', 404);
    const { rows } = await tx.query(
      'SELECT * FROM event_task_signups WHERE id = $1 AND task_id = $2 FOR UPDATE', [signupId, taskId],
    );
    const signup = rows[0];
    if (!signup) throw new EventError('event_task_signup_not_found', 404);
    if (signup.status === 'withdrawn') return { signup: toSignup(signup), replayed: true };
    const { rows: updated } = await tx.query(
      `UPDATE event_task_signups SET status = 'withdrawn', updated_by = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [signupId, actor.userId],
    );
    await audit(tx, actor.userId, 'event.task_signup_withdrawn', signupId, { taskId, eventId, schoolYearId: event.school_year_id }, 'event_task_signup');
    return { signup: toSignup(updated[0]) };
  });
}

// Publiczna strona: najwyżej "potrzebni jeszcze: N" dla zadań JAWNIE
// oznaczonych jako publiczne, wyłącznie wydarzeń opublikowanych. Bez
// identyfikatorów osób i bez zadań niepublicznych.
export async function listPublicTasks(db, input) {
  const eventId = decodeId(input?.eventId);
  const { rows: published } = await db.query('SELECT id FROM public_events WHERE id = $1', [eventId]);
  if (!published[0]) throw new EventError('event_not_found', 404);
  return { tasks: (await publicTasksFor(db, [eventId])).get(eventId) ?? [] };
}

// Wspólne źródło dla GET /api/public/events (pole volunteerTasks) i
// GET /api/public/events/:id/tasks: jedno zapytanie dla wielu wydarzeń,
// wyłącznie { id, title, stillNeeded } zadań publicznych i nieodwołanych.
async function publicTasksFor(db, eventIds) {
  const byEvent = new Map();
  if (!eventIds.length) return byEvent;
  const { rows } = await db.query(
    `SELECT t.id, t.event_id, t.title, t.slots_needed,
            (SELECT count(*) FROM event_task_signups s WHERE s.task_id = t.id AND s.status = 'confirmed') AS confirmed_count
       FROM event_tasks t
      WHERE t.event_id = ANY($1::text[]) AND t.is_public AND t.cancelled_at IS NULL
      ORDER BY t.created_at, t.id`,
    [eventIds],
  );
  for (const row of rows) {
    const list = byEvent.get(row.event_id) ?? [];
    list.push({ id: row.id, title: row.title, stillNeeded: Math.max(0, row.slots_needed - Number(row.confirmed_count)) });
    byEvent.set(row.event_id, list);
  }
  return byEvent;
}

const PUBLIC_ICS_COLUMNS = `id, title, description, begins_at, ends_at, location, organizer, timezone,
            public_status, published_at, first_published_at,
            (SELECT e.status <> 'cancelled' AND e.revision_no <> e.published_revision_no
               FROM events e WHERE e.id = public_events.id) AS pending_change,
            (SELECT e.published_revision_no FROM events e WHERE e.id = public_events.id) AS sequence_no`;

async function publicEventRows(db, input = {}) {
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
    `SELECT ${PUBLIC_ICS_COLUMNS}
       FROM public_events
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY begins_at, id LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export async function listPublic(db, input = {}) {
  const rows = await publicEventRows(db, input);
  const tasks = await publicTasksFor(db, rows.filter((row) => row.public_status !== 'cancelled').map((row) => row.id));
  return {
    timezone: EVENT_TIMEZONE,
    events: rows.map((row) => ({ ...publicEvent(row), volunteerTasks: tasks.get(row.id) ?? [] })),
  };
}

// #116: pojedyncze wydarzenie dla stałego adresu /site/wydarzenia/{id}
// (renderowanie serwerowe, src/pg/public-site.js). Ten sam kształt co pozycja
// listPublic; wyłącznie widok public_events. Nieznany identyfikator, szkic,
// wydarzenie wewnętrzne i nieopublikowane dają ten sam błąd 404.
export async function getPublic(db, input = {}) {
  if (!validId(input.eventId)) throw new EventError('event_not_found', 404);
  const { rows } = await db.query(`SELECT ${PUBLIC_ICS_COLUMNS} FROM public_events WHERE id = $1`, [input.eventId]);
  const row = rows[0];
  if (!row) throw new EventError('event_not_found', 404);
  const tasks = row.public_status === 'cancelled' ? new Map() : await publicTasksFor(db, [row.id]);
  return { timezone: EVENT_TIMEZONE, event: { ...publicEvent(row), volunteerTasks: tasks.get(row.id) ?? [] } };
}

// Wewnętrzne: to samo źródło co listPublic, do budowy kalendarza iCal
// (src/ical.js). Nigdy nie ujawnia autorów, klas ani powodu odwołania.
async function listPublicForIcs(db, input) {
  const rows = await publicEventRows(db, input);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    location: row.location ?? null,
    organizer: row.organizer ?? null,
    startsAtUtc: row.begins_at,
    endsAtUtc: row.ends_at ?? null,
    status: row.public_status,
    sequence: row.sequence_no ?? 0,
    dtstamp: row.published_at,
  }));
}

async function getPublicForIcs(db, eventId) {
  if (!validId(eventId)) throw new EventError('invalid_event_id');
  const { rows } = await db.query(
    `SELECT ${PUBLIC_ICS_COLUMNS} FROM public_events WHERE id = $1`, [eventId],
  );
  const row = rows[0];
  if (!row) throw new EventError('event_not_found', 404);
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    location: row.location ?? null,
    organizer: row.organizer ?? null,
    startsAtUtc: row.begins_at,
    endsAtUtc: row.ends_at ?? null,
    status: row.public_status,
    sequence: row.sequence_no ?? 0,
    dtstamp: row.published_at,
  };
}

// ---------- HTTP ----------

const readJson = createJsonReader({
  maxBytes: MAX_BODY_BYTES,
  declaredLength: true,
  error: (code, status) => new EventError(code, status),
});

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

function icsETag(content) {
  return `"${createHash('sha256').update(content, 'utf8').digest('hex')}"`;
}

// 304 gdy If-None-Match zawiera bieżący ETag (RFC 9110 §13.1.1: porównanie listy
// znaczników rozdzielonych przecinkami, dopuszcza W/"..." jako słabe dopasowanie).
function icsResponse(content, request) {
  const etag = icsETag(content);
  const headers = {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Cache-Control': 'public, max-age=60',
    ETag: etag,
  };
  const inm = request.headers.get('If-None-Match');
  const matches = inm && inm.split(',').map((s) => s.trim().replace(/^W\//, '')).includes(etag);
  if (matches) return new Response(null, { status: 304, headers });
  return new Response(content, { status: 200, headers });
}

// Handles /api/public/events, /api/public/events.ics, /api/public/events/:id.ics
// and /api/events... Returns null for other paths.
// env.db: { query, transaction }; env.loadAuthorizationContext(request, env)
// -> { session: { user: { id }, mfaVerified }, grants } | null.
export async function handle(request, env, url, json) {
  const path = url.pathname;
  const isPublic = path === '/api/public/events';
  const isPublicIcsChannel = path === '/api/public/events.ics';
  const icsMatch = path.match(/^\/api\/public\/events\/([^/]+)\.ics$/);
  const isPublicIcs = isPublicIcsChannel || Boolean(icsMatch);
  const publicTasksMatch = path.match(/^\/api\/public\/events\/([^/]+)\/tasks$/);
  if (!isPublic && !isPublicIcs && !publicTasksMatch && path !== '/api/events' && !path.startsWith('/api/events/')) return null;
  try {
    if (!env?.db) throw new EventError('service_unavailable', 503);
    if (isPublic) {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
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
    if (isPublicIcs) {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
      if (isPublicIcsChannel) {
        const limitText = url.searchParams.get('limit');
        if (limitText !== null && !/^\d{1,3}$/.test(limitText)) throw new EventError('invalid_limit');
        const from = url.searchParams.get('from');
        if (from !== null && !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new EventError('invalid_date');
        const schoolYearId = url.searchParams.get('schoolYearId');
        if (schoolYearId !== null && !validId(schoolYearId)) throw new EventError('invalid_school_year');
        const events = await listPublicForIcs(env.db, {
          schoolYearId: schoolYearId ?? undefined,
          from: from ?? undefined,
          limit: limitText === null ? 200 : Number(limitText),
        });
        return icsResponse(buildCalendar(events, { uidDomain: icalUidDomain(env) }), request);
      }
      const event = await getPublicForIcs(env.db, decodeId(icsMatch[1]));
      return icsResponse(buildCalendar([event], { uidDomain: icalUidDomain(env), calName: event.title }), request);
    }
    if (publicTasksMatch) {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
      const result = await listPublicTasks(env.db, { eventId: decodeId(publicTasksMatch[1]) });
      return json(result, 200, { 'Cache-Control': 'public, max-age=60' });
    }

    const itemMatch = path.match(/^\/api\/events\/([^/]+)$/);
    const actionMatch = path.match(/^\/api\/events\/([^/]+)\/(submit|approve|publish|cancel)$/);
    const tasksMatch = path.match(/^\/api\/events\/([^/]+)\/tasks$/);
    const candidatesMatch = path.match(/^\/api\/events\/([^/]+)\/tasks\/candidates$/);
    const taskCancelMatch = path.match(/^\/api\/events\/([^/]+)\/tasks\/([^/]+)\/cancel$/);
    const signupsMatch = path.match(/^\/api\/events\/([^/]+)\/tasks\/([^/]+)\/signups$/);
    const withdrawMatch = path.match(/^\/api\/events\/([^/]+)\/tasks\/([^/]+)\/signups\/([^/]+)\/withdraw$/);
    const isList = path === '/api/events' && request.method === 'GET';
    const isCreate = path === '/api/events' && request.method === 'POST';
    const isGet = itemMatch && request.method === 'GET';
    const isUpdate = itemMatch && request.method === 'PATCH';
    const isAction = actionMatch && request.method === 'POST';
    const isTasksList = tasksMatch && request.method === 'GET';
    const isCandidates = candidatesMatch && request.method === 'GET';
    const isTaskCreate = tasksMatch && request.method === 'POST';
    const isTaskCancel = taskCancelMatch && request.method === 'POST';
    const isSignupCreate = signupsMatch && request.method === 'POST';
    const isSignupWithdraw = withdrawMatch && request.method === 'POST';
    if (!isList && !isCreate && !isGet && !isUpdate && !isAction
        && !isTasksList && !isCandidates && !isTaskCreate && !isTaskCancel && !isSignupCreate && !isSignupWithdraw) {
      return json({ error: 'not_found' }, 404);
    }
    if ((isCreate || isUpdate || isAction || isTaskCreate || isTaskCancel || isSignupCreate || isSignupWithdraw)
        && !isSameOrigin(request)) {
      return json({ error: 'invalid_origin' }, 403);
    }
    const actor = await loadActor(request, env);
    const noStore = { 'Cache-Control': 'no-store' };

    if (isList) return json(await listInternal(env.db, actor, { schoolYearId: url.searchParams.get('schoolYearId') }), 200, noStore);
    if (isGet) return json(await getInternal(env.db, actor, { eventId: decodeId(itemMatch[1]) }), 200, noStore);
    if (isTasksList) return json(await listTasks(env.db, actor, { eventId: decodeId(tasksMatch[1]) }), 200, noStore);
    if (isCandidates) {
      return json(await listTaskCandidates(env.db, actor, {
        eventId: decodeId(candidatesMatch[1]), classId: url.searchParams.get('classId') || undefined,
      }), 200, noStore);
    }

    if (isTaskCreate || isSignupCreate) {
      const idempotencyKey = request.headers.get('Idempotency-Key')?.trim();
      if (!idempotencyKey || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) throw new EventError('invalid_idempotency_key');
      const data = await readJson(request);
      if (isTaskCreate) {
        const result = await createTask(env.db, actor, {
          ...pick(data, ['title', 'startsAt', 'endsAt', 'slotsNeeded', 'isPublic', 'confirmPersonalData']),
          eventId: decodeId(tasksMatch[1]), idempotencyKey,
        });
        return json({ task: result.task, replayed: Boolean(result.replayed) }, result.replayed ? 200 : 201, noStore);
      }
      const result = await createSignup(env.db, actor, {
        ...pick(data, ['guardianId', 'userId']),
        eventId: decodeId(signupsMatch[1]), taskId: decodeId(signupsMatch[2]), idempotencyKey,
      });
      return json({ signup: result.signup, replayed: Boolean(result.replayed) }, result.replayed ? 200 : 201, noStore);
    }
    if (isTaskCancel) {
      const data = await readJson(request);
      const result = await cancelTask(env.db, actor, {
        ...pick(data, ['reason', 'confirmPersonalData']), eventId: decodeId(taskCancelMatch[1]), taskId: decodeId(taskCancelMatch[2]),
      });
      return json({ task: result.task, replayed: Boolean(result.replayed) }, 200, noStore);
    }
    if (isSignupWithdraw) {
      const result = await withdrawSignup(env.db, actor, {
        eventId: decodeId(withdrawMatch[1]), taskId: decodeId(withdrawMatch[2]), signupId: decodeId(withdrawMatch[3]),
      });
      return json({ signup: result.signup, replayed: Boolean(result.replayed) }, 200, noStore);
    }

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
      return json({
        event: result.event, replayed: result.replayed, tasksOutsideEventTime: result.tasksOutsideEventTime ?? [],
      }, 200, noStore);
    }
    const operations = { submit, approve, publish, cancel };
    const result = await operations[actionMatch[2]](env.db, actor, {
      ...pick(data, ['revision', 'reason']), eventId: decodeId(actionMatch[1]),
    });
    return json({ event: result.event, replayed: result.replayed }, 200, noStore);
  } catch (error) {
    if (error instanceof EventError) {
      // #184: ślad odmowy (poza transakcją żądania — ta już się zakończyła).
      if (error.status === 403 && error.code === 'forbidden') await env?.onAccessDenied?.();
      return json({ error: error.code, ...error.extra }, error.status);
    }
    throw error;
  }
}
