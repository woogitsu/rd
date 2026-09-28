// Zebrania, obecność, quorum, protokoły i uchwały (#13) na PostgreSQL.
//
// Usługi mają postać `(db, actor, input)`, gdzie `db` udostępnia `query(sql, params)`
// (pg.Pool, dedykowany pg.Client albo PGlite), a `actor = { userId, grants, mfaVerified }`.
// Uprawnienia sprawdza czysta funkcja `isAuthorized` z src/authorization.js.
//
// Założenia (do zatwierdzenia w D-08/D-09, patrz docs/MEETINGS.md i docs/DECISIONS.md):
// - zarządzanie zebraniami: role admin i board,
// - odczyt wewnętrzny (także projektów protokołów): admin, board, audit,
// - przedstawiciel klasy: wyłącznie protokoły zatwierdzone i udostępnione rodzicom,
//   dla zebrań ogólnych i zebrań własnej klasy,
// - dyrekcja (principal): brak dostępu do czasu decyzji D-09,
// - skarbnik: tylko sprawdzenie przyjętej uchwały po numerze (księga, wydatki > 3000 EUR).
// Nie ma głosowania elektronicznego (D-19): zapisywane są wyłącznie wyniki głosowań
// przeprowadzonych na zebraniu.

import { createHash, randomUUID } from 'node:crypto';
import { isSameOrigin } from '../auth.js';
import { isAuthorized } from '../authorization.js';

export const MANAGE_ROLES = Object.freeze(['admin', 'board']);
export const READ_ROLES = Object.freeze(['admin', 'board', 'audit']);
export const RESOLUTION_LOOKUP_ROLES = Object.freeze(['admin', 'board', 'audit', 'treasurer']);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;
const KINDS = new Set(['plenary', 'board', 'class']);
const STATUSES = new Set(['draft', 'scheduled', 'held', 'archived']);
const QUORUM_MODES = new Set(['not_configured', 'fraction', 'minimum_count']);
const CAPACITIES = new Set([
  'representative', 'board_member', 'audit_member', 'principal', 'teacher', 'guardian', 'guest', 'other',
]);
const VISIBILITIES = new Set(['internal', 'parents', 'public']);
const RESOLUTION_STATUSES = new Set(['draft', 'adopted', 'rejected', 'withdrawn']);
const MAX_BODY_BYTES = 256 * 1024;

const DATABASE_CONFLICTS = new Set([
  'meeting_locked', 'meeting_status_transition_invalid', 'meeting_archive_requires_approved_minutes',
  'meeting_identity_immutable', 'meeting_must_start_as_draft_or_scheduled',
  'quorum_requires_held_meeting', 'quorum_rule_not_configured', 'quorum_attendance_exceeds_voting_body',
  'minutes_require_held_meeting', 'minutes_version_mismatch', 'minutes_approved_immutable',
  'minutes_version_immutable', 'minutes_not_latest_version', 'minutes_not_approved',
  'resolution_final_immutable', 'resolution_identity_immutable', 'resolution_correction_mismatch',
  'resolution_amends_requires_adopted', 'resolution_requires_held_meeting',
  'resolution_quorum_check_required', 'resolution_votes_exceed_present_voters',
  // 0021_meetings_integrity.sql (#81)
  'minutes_open_resolutions', 'resolution_quorum_check_stale',
  // Zwykle nieosiągalne z API (moduł wstawia projekt i nie usuwa zebrań), ale to
  // odmowa reguły danych, nie awaria — 409 zamiast 503.
  'minutes_must_start_as_draft', 'meetings_cannot_be_deleted',
  // Rok zamknięty (0017_year_close.sql, triggery a0_year_freeze).
  'school_year_closed',
]);

export class MeetingError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// ---------- validation ----------

function requireId(value, code = 'invalid_request') {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new MeetingError(code);
  return value;
}

function optionalId(value) {
  if (value === undefined || value === null) return null;
  return requireId(value);
}

function text(value, min, max, { optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    throw new MeetingError('invalid_request');
  }
  if (typeof value !== 'string') throw new MeetingError('invalid_request');
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    if (optional && !normalized) return null;
    throw new MeetingError('invalid_request');
  }
  return normalized;
}

function integer(value, min, max, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    throw new MeetingError('invalid_request');
  }
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new MeetingError('invalid_request');
  return value;
}

function bool(value) {
  if (typeof value !== 'boolean') throw new MeetingError('invalid_request');
  return value;
}

function timestamp(value) {
  if (typeof value !== 'string' || value.length > 40
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new MeetingError('invalid_request');
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new MeetingError('invalid_request');
  return date.toISOString();
}

function idempotencyKey(value) {
  if (typeof value !== 'string' || !IDEMPOTENCY_PATTERN.test(value)) {
    throw new MeetingError('invalid_idempotency_key');
  }
  return value;
}

function parseQuorumRule(input) {
  const mode = input.quorumMode ?? 'not_configured';
  if (!QUORUM_MODES.has(mode)) throw new MeetingError('invalid_quorum_rule');
  const rule = {
    quorumMode: mode,
    quorumNumerator: null,
    quorumDenominator: null,
    quorumInclusive: null,
    quorumMinCount: null,
    votingBodySize: integer(input.votingBodySize, 1, 10000, { optional: true }),
    quorumRuleSource: text(input.quorumRuleSource, 3, 200, { optional: true }),
  };
  // Skonfigurowana reguła musi wskazywać swoje źródło (np. paragraf regulaminu, D-21);
  // ten sam wymóg ma formularz (meetings/core.js, buildQuorumRule).
  if (mode !== 'not_configured' && rule.quorumRuleSource === null) {
    throw new MeetingError('quorum_rule_source_required');
  }
  try {
    if (mode === 'fraction') {
      rule.quorumNumerator = integer(input.quorumNumerator, 1, 1000);
      rule.quorumDenominator = integer(input.quorumDenominator, 1, 1000);
      rule.quorumInclusive = bool(input.quorumInclusive);
      if (rule.votingBodySize === null || rule.quorumNumerator > rule.quorumDenominator
          || (!rule.quorumInclusive && rule.quorumNumerator === rule.quorumDenominator)) {
        throw new MeetingError('invalid_quorum_rule');
      }
    } else if (mode === 'minimum_count') {
      rule.quorumMinCount = integer(input.quorumMinCount, 1, 10000);
    }
  } catch (error) {
    if (error instanceof MeetingError) throw new MeetingError('invalid_quorum_rule');
    throw error;
  }
  return rule;
}

const QUORUM_FIELDS = [
  'quorumMode', 'quorumNumerator', 'quorumDenominator', 'quorumInclusive',
  'quorumMinCount', 'votingBodySize', 'quorumRuleSource',
];

// Reguła zapisana w wierszu zebrania w postaci pól wejściowych API.
function storedQuorumInput(row) {
  return {
    quorumMode: row.quorum_mode,
    quorumNumerator: row.quorum_numerator ?? null,
    quorumDenominator: row.quorum_denominator ?? null,
    quorumInclusive: row.quorum_inclusive ?? null,
    quorumMinCount: row.quorum_min_count ?? null,
    votingBodySize: row.voting_body_size ?? null,
    quorumRuleSource: row.quorum_rule_source ?? null,
  };
}

function parseVotes(input) {
  return {
    votesFor: integer(input.votesFor, 0, 10000, { optional: true }),
    votesAgainst: integer(input.votesAgainst, 0, 10000, { optional: true }),
    votesAbstain: integer(input.votesAbstain, 0, 10000, { optional: true }),
  };
}

function requireFinalVotes(status, votes, quorumCheckId) {
  if (status !== 'adopted' && status !== 'rejected') return;
  if (votes.votesFor === null || votes.votesAgainst === null || votes.votesAbstain === null || !quorumCheckId) {
    throw new MeetingError('vote_record_required');
  }
}

// ---------- authorization ----------

function contextFor(actor, classId) {
  if (!actor || typeof actor.userId !== 'string' || !actor.userId) {
    throw new MeetingError('unauthenticated', 401);
  }
  const grants = Array.isArray(actor.grants) ? actor.grants : [];
  // A class-scoped grant never reaches a plenary or board meeting, and never a
  // different class; isAuthorized alone would let it through when classId is absent.
  const scoped = grants.filter(grant => !grant.classId || (classId && grant.classId === classId));
  return {
    session: { user: { id: actor.userId }, mfaVerified: Boolean(actor.mfaVerified) },
    grants: scoped,
  };
}

function authorize(actor, roles, { schoolYearId, classId = null }) {
  const context = contextFor(actor, classId);
  const requirement = { roles: [...roles], schoolYearId };
  if (classId) requirement.classId = classId;
  if (!isAuthorized(context, requirement)) throw new MeetingError('forbidden', 403);
}

function actorClassIds(actor, schoolYearId) {
  const grants = Array.isArray(actor?.grants) ? actor.grants : [];
  return [...new Set(grants
    .filter(grant => grant.role === 'representative' && grant.classId
      && (!grant.schoolYearId || grant.schoolYearId === schoolYearId))
    .map(grant => grant.classId))]
    .filter(classId => isAuthorized(contextFor(actor, classId),
      { roles: ['representative'], schoolYearId, classId }));
}

// ---------- database helpers ----------

async function inTransaction(db, work) {
  if (typeof db.transaction === 'function') return db.transaction(work);
  if (typeof db.connect === 'function' && 'totalCount' in db) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  await db.query('BEGIN');
  try {
    const result = await work(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function one(db, sql, params) {
  const { rows } = await db.query(sql, params);
  return rows[0] ?? null;
}

async function audit(tx, actor, action, entityType, entityId, metadata = {}) {
  await tx.query(
    `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, metadata_json)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [randomUUID(), actor.userId, action, entityType, entityId, JSON.stringify(metadata)],
  );
}

function databaseError(error) {
  if (error instanceof MeetingError) return error;
  const message = String(error?.message ?? '');
  if (DATABASE_CONFLICTS.has(message)) return new MeetingError(message, 409);
  if (message === 'meeting_not_found') return new MeetingError('meeting_not_found', 404);
  // #205: identyfikator (guardianId/userId spoza klasy/roku zebrania,
  // amendsResolutionId spoza roku/klasy) — sam kod dla spoza zakresu i
  // nieistniejącego, żeby odpowiedź nie była wyrocznią istnienia.
  if (message === 'invalid_reference') return new MeetingError('invalid_reference');
  if (error?.code === '23505') {
    if (error.constraint === 'resolutions_number_per_year_idx') {
      return new MeetingError('resolution_number_taken', 409);
    }
    if (error.constraint === 'meeting_agenda_items_meeting_id_position_key') {
      return new MeetingError('agenda_position_taken', 409);
    }
    if (error.constraint === 'meeting_minutes_meeting_id_version_key'
        || error.constraint === 'meeting_minutes_supersedes_id_key'
        || error.constraint === 'resolutions_corrects_id_key') {
      return new MeetingError('concurrent_version', 409);
    }
    return new MeetingError('conflict', 409);
  }
  if (error?.code === '23503') return new MeetingError('invalid_reference');
  if (error?.code === '23514') return new MeetingError('invalid_request');
  return error;
}

function requestHash(operation, input) {
  const canonical = JSON.stringify(input, Object.keys(input).sort());
  return createHash('sha256').update(`${operation}\n${canonical}`).digest('hex');
}

// Runs `work(tx)` once per Idempotency-Key. A repeated key with the same actor,
// operation and input returns the original entity id; anything else is a conflict.
async function idempotent(db, actor, key, operation, input, work) {
  const hash = requestHash(operation, input);
  const replay = async () => {
    const row = await one(db,
      `SELECT actor_id, operation, request_hash, entity_id FROM meeting_request_keys
        WHERE idempotency_key = $1`, [key]);
    if (!row) return null;
    if (row.actor_id !== actor.userId || row.operation !== operation || row.request_hash !== hash) {
      throw new MeetingError('idempotency_conflict', 409);
    }
    return { entityId: row.entity_id, replayed: true };
  };
  const existing = await replay();
  if (existing) return existing;
  try {
    return await inTransaction(db, async tx => {
      const { entityType, entityId } = await work(tx);
      await tx.query(
        `INSERT INTO meeting_request_keys
           (idempotency_key, actor_id, operation, request_hash, entity_type, entity_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [key, actor.userId, operation, hash, entityType, entityId],
      );
      return { entityId, replayed: false };
    });
  } catch (error) {
    if (error?.code === '23505' && error.constraint === 'meeting_request_keys_pkey') {
      const again = await replay();
      if (again) return again;
    }
    throw databaseError(error);
  }
}

async function mutate(db, work) {
  try {
    return await inTransaction(db, work);
  } catch (error) {
    throw databaseError(error);
  }
}

// ---------- row mappers ----------

function iso(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function meetingFromRow(row) {
  return {
    id: row.id,
    schoolYearId: row.school_year_id,
    kind: row.kind,
    classId: row.class_id ?? null,
    title: row.title,
    scheduledAt: iso(row.scheduled_at),
    location: row.location ?? null,
    status: row.status,
    quorumRule: {
      mode: row.quorum_mode,
      numerator: row.quorum_numerator ?? null,
      denominator: row.quorum_denominator ?? null,
      inclusive: row.quorum_inclusive ?? null,
      minCount: row.quorum_min_count ?? null,
      votingBodySize: row.voting_body_size ?? null,
      source: row.quorum_rule_source ?? null,
    },
  };
}

function agendaItemFromRow(row) {
  return { id: row.id, meetingId: row.meeting_id, position: row.position, title: row.title,
    description: row.description ?? null };
}

function attendeeFromRow(row) {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    userId: row.user_id ?? null,
    guardianId: row.guardian_id ?? null,
    capacity: row.capacity,
    votingEligible: row.voting_eligible,
    present: row.present,
  };
}

const QUORUM_CHECK_SELECT = `SELECT c.*,
    c.attendance_revision IS NOT NULL AND c.attendance_revision = COALESCE(s.revision, 0) AS is_current
  FROM meeting_quorum_checks c
  LEFT JOIN meeting_attendance_state s ON s.meeting_id = c.meeting_id`;

function quorumCheckFromRow(row) {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    mode: row.quorum_mode,
    numerator: row.quorum_numerator ?? null,
    denominator: row.quorum_denominator ?? null,
    inclusive: row.quorum_inclusive ?? null,
    minCount: row.quorum_min_count ?? null,
    votingBodySize: row.voting_body_size ?? null,
    presentEligible: row.present_eligible,
    requiredCount: row.required_count,
    met: row.met,
    determinedAt: iso(row.determined_at),
    // false: attendance changed since this check (or unknown for checks older
    // than 0021); such a check cannot be the basis of a new decision (#81).
    current: row.is_current === true,
  };
}

function minutesFromRow(row) {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    version: row.version,
    supersedesId: row.supersedes_id ?? null,
    body: row.body,
    changeNote: row.change_note ?? null,
    status: row.status,
    approvedAt: iso(row.approved_at),
    approvalNote: row.approval_note ?? null,
    visibility: row.visibility ?? 'internal',
  };
}

function resolutionFromRow(row) {
  return {
    id: row.id,
    schoolYearId: row.school_year_id,
    meetingId: row.meeting_id,
    number: row.number ?? null,
    revision: row.revision,
    correctsId: row.corrects_id ?? null,
    correctionReason: row.correction_reason ?? null,
    amendsResolutionId: row.amends_resolution_id ?? null,
    title: row.title,
    body: row.body,
    status: row.status,
    votesFor: row.votes_for ?? null,
    votesAgainst: row.votes_against ?? null,
    votesAbstain: row.votes_abstain ?? null,
    quorumCheckId: row.quorum_check_id ?? null,
    decidedAt: iso(row.decided_at),
  };
}

// ---------- loaders ----------

async function loadMeeting(db, meetingId) {
  const row = await one(db, 'SELECT * FROM meetings WHERE id = $1', [requireId(meetingId, 'invalid_meeting_id')]);
  if (!row) throw new MeetingError('meeting_not_found', 404);
  return row;
}

async function meetingForManage(db, actor, meetingId) {
  const meeting = await loadMeeting(db, meetingId);
  authorize(actor, MANAGE_ROLES, { schoolYearId: meeting.school_year_id, classId: meeting.class_id });
  return meeting;
}

async function loadMinutes(db, minutesId, meetingId) {
  const row = await one(db,
    `SELECT m.*, v.visibility FROM meeting_minutes m
       JOIN meeting_minutes_visibility v ON v.minutes_id = m.id WHERE m.id = $1`,
    [requireId(minutesId, 'invalid_minutes_id')]);
  if (!row || (meetingId && row.meeting_id !== meetingId)) throw new MeetingError('minutes_not_found', 404);
  return row;
}

async function loadResolution(db, resolutionId, meetingId) {
  const row = await one(db, 'SELECT * FROM resolutions WHERE id = $1',
    [requireId(resolutionId, 'invalid_resolution_id')]);
  if (!row || (meetingId && row.meeting_id !== meetingId)) throw new MeetingError('resolution_not_found', 404);
  return row;
}

// ---------- meetings ----------

export async function listMeetings(db, actor, input = {}) {
  const schoolYearId = requireId(input.schoolYearId);
  const context = contextFor(actor, null);
  context.grants = actor.grants ?? [];
  // Any read grant for the year (also class-scoped) may list; rows are filtered below.
  if (!isAuthorized(context, { roles: [...READ_ROLES], schoolYearId })) throw new MeetingError('forbidden', 403);
  const { rows } = await db.query(
    'SELECT * FROM meetings WHERE school_year_id = $1 ORDER BY scheduled_at DESC, id DESC LIMIT 500',
    [schoolYearId]);
  // Class-scoped read grants (if ever issued) see only their class.
  const visible = rows.filter(row => {
    try {
      authorize(actor, READ_ROLES, { schoolYearId, classId: row.class_id });
      return true;
    } catch {
      return false;
    }
  });
  return { meetings: visible.map(meetingFromRow) };
}

export async function getMeeting(db, actor, input = {}) {
  const meeting = await loadMeeting(db, input.meetingId);
  try {
    authorize(actor, READ_ROLES, { schoolYearId: meeting.school_year_id, classId: meeting.class_id });
  } catch (error) {
    // Ta sama odpowiedź dla brakującego i niedostępnego zebrania (SR-07).
    if (error instanceof MeetingError && error.status === 403) throw new MeetingError('meeting_not_found', 404);
    throw error;
  }
  const [agenda, attendees, checks, minutes, resolutions] = await Promise.all([
    db.query('SELECT * FROM meeting_agenda_items WHERE meeting_id = $1 ORDER BY position', [meeting.id]),
    db.query('SELECT * FROM meeting_attendees WHERE meeting_id = $1 ORDER BY recorded_at, id', [meeting.id]),
    db.query(`${QUORUM_CHECK_SELECT} WHERE c.meeting_id = $1 ORDER BY c.seq`, [meeting.id]),
    db.query(
      `SELECT m.*, v.visibility FROM meeting_minutes m
         JOIN meeting_minutes_visibility v ON v.minutes_id = m.id
        WHERE m.meeting_id = $1 ORDER BY m.version`, [meeting.id]),
    db.query('SELECT * FROM resolutions WHERE meeting_id = $1 ORDER BY created_at, revision, id', [meeting.id]),
  ]);
  return {
    meeting: meetingFromRow(meeting),
    agenda: agenda.rows.map(agendaItemFromRow),
    attendees: attendees.rows.map(attendeeFromRow),
    quorumChecks: checks.rows.map(quorumCheckFromRow),
    minutes: minutes.rows.map(minutesFromRow),
    resolutions: resolutions.rows.map(resolutionFromRow),
  };
}

export async function createMeeting(db, actor, input = {}) {
  const key = idempotencyKey(input.idempotencyKey);
  const schoolYearId = requireId(input.schoolYearId);
  if (!KINDS.has(input.kind)) throw new MeetingError('invalid_request');
  const classId = optionalId(input.classId);
  if ((input.kind === 'class') !== Boolean(classId)) throw new MeetingError('invalid_request');
  const status = input.status ?? 'draft';
  if (status !== 'draft' && status !== 'scheduled') throw new MeetingError('invalid_request');
  const data = {
    schoolYearId,
    kind: input.kind,
    classId,
    title: text(input.title, 3, 200),
    scheduledAt: timestamp(input.scheduledAt),
    location: text(input.location, 1, 200, { optional: true }),
    status,
    ...parseQuorumRule(input),
  };
  authorize(actor, MANAGE_ROLES, { schoolYearId, classId });
  const result = await idempotent(db, actor, key, 'meeting.create', data, async tx => {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO meetings (id, school_year_id, kind, class_id, title, scheduled_at, location, status,
         quorum_mode, quorum_numerator, quorum_denominator, quorum_inclusive, quorum_min_count,
         voting_body_size, quorum_rule_source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [id, data.schoolYearId, data.kind, data.classId, data.title, data.scheduledAt, data.location, data.status,
        data.quorumMode, data.quorumNumerator, data.quorumDenominator, data.quorumInclusive,
        data.quorumMinCount, data.votingBodySize, data.quorumRuleSource, actor.userId]);
    await audit(tx, actor, 'meeting.created', 'meeting', id, { kind: data.kind, status: data.status });
    return { entityType: 'meeting', entityId: id };
  });
  return { meeting: meetingFromRow(await loadMeeting(db, result.entityId)), replayed: result.replayed };
}

export async function updateMeeting(db, actor, input = {}) {
  const meeting = await meetingForManage(db, actor, input.meetingId);
  const changes = {};
  if (input.title !== undefined) changes.title = text(input.title, 3, 200);
  if (input.scheduledAt !== undefined) changes.scheduled_at = timestamp(input.scheduledAt);
  if (input.location !== undefined) changes.location = text(input.location, 1, 200, { optional: true });
  if (input.status !== undefined) {
    if (!STATUSES.has(input.status)) throw new MeetingError('invalid_request');
    changes.status = input.status;
  }
  if (QUORUM_FIELDS.some(field => input[field] !== undefined)) {
    // PATCH: pola reguły nieobecne w żądaniu zostają z zapisanej reguły;
    // jawne null czyści pole. Pola nieużywane przez nowy tryb są zerowane.
    const merged = storedQuorumInput(meeting);
    for (const field of QUORUM_FIELDS) {
      if (input[field] !== undefined) merged[field] = input[field];
    }
    const rule = parseQuorumRule(merged);
    Object.assign(changes, {
      quorum_mode: rule.quorumMode,
      quorum_numerator: rule.quorumNumerator,
      quorum_denominator: rule.quorumDenominator,
      quorum_inclusive: rule.quorumInclusive,
      quorum_min_count: rule.quorumMinCount,
      voting_body_size: rule.votingBodySize,
      quorum_rule_source: rule.quorumRuleSource,
    });
  }
  const columns = Object.keys(changes);
  if (!columns.length) throw new MeetingError('invalid_request');
  await mutate(db, async tx => {
    const assignments = columns.map((column, index) => `${column} = $${index + 2}`).join(', ');
    await tx.query(`UPDATE meetings SET ${assignments} WHERE id = $1`,
      [meeting.id, ...columns.map(column => changes[column])]);
    await audit(tx, actor, 'meeting.updated', 'meeting', meeting.id, {
      fields: columns,
      ...(changes.status && changes.status !== meeting.status
        ? { fromStatus: meeting.status, toStatus: changes.status } : {}),
    });
  });
  return { meeting: meetingFromRow(await loadMeeting(db, meeting.id)) };
}

export async function addAgendaItem(db, actor, input = {}) {
  const key = idempotencyKey(input.idempotencyKey);
  const meeting = await meetingForManage(db, actor, input.meetingId);
  const data = {
    meetingId: meeting.id,
    title: text(input.title, 3, 300),
    description: text(input.description, 1, 2000, { optional: true }),
    position: integer(input.position, 1, 200, { optional: true }),
  };
  const result = await idempotent(db, actor, key, 'meeting.agenda_item.add', data, async tx => {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO meeting_agenda_items (id, meeting_id, position, title, description, created_by)
       VALUES ($1, $2, COALESCE($3::int,
         (SELECT COALESCE(max(position), 0) + 1 FROM meeting_agenda_items WHERE meeting_id = $2)),
         $4, $5, $6)`,
      [id, data.meetingId, data.position, data.title, data.description, actor.userId]);
    await audit(tx, actor, 'meeting.agenda_item.added', 'meeting_agenda_item', id, { meetingId: meeting.id });
    return { entityType: 'meeting_agenda_item', entityId: id };
  });
  const row = await one(db, 'SELECT * FROM meeting_agenda_items WHERE id = $1', [result.entityId]);
  return { agendaItem: agendaItemFromRow(row), replayed: result.replayed };
}

// Records or corrects one attendee (upsert by person reference, naturally idempotent).
export async function recordAttendance(db, actor, input = {}) {
  const meeting = await meetingForManage(db, actor, input.meetingId);
  const userId = optionalId(input.userId);
  const guardianId = optionalId(input.guardianId);
  if (Boolean(userId) === Boolean(guardianId)) throw new MeetingError('invalid_request');
  if (!CAPACITIES.has(input.capacity)) throw new MeetingError('invalid_request');
  const votingEligible = bool(input.votingEligible);
  const present = bool(input.present);
  const row = await mutate(db, async tx => {
    const column = userId ? 'user_id' : 'guardian_id';
    const reference = userId ?? guardianId;
    const existing = await one(tx,
      `SELECT id FROM meeting_attendees WHERE meeting_id = $1 AND ${column} = $2 FOR UPDATE`,
      [meeting.id, reference]);
    let id;
    if (existing) {
      id = existing.id;
      await tx.query(
        `UPDATE meeting_attendees SET capacity = $2, voting_eligible = $3, present = $4, recorded_by = $5
          WHERE id = $1`, [id, input.capacity, votingEligible, present, actor.userId]);
    } else {
      id = randomUUID();
      await tx.query(
        `INSERT INTO meeting_attendees
           (id, meeting_id, user_id, guardian_id, capacity, voting_eligible, present, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING`,
        [id, meeting.id, userId, guardianId, input.capacity, votingEligible, present, actor.userId]);
      const inserted = await one(tx, 'SELECT id FROM meeting_attendees WHERE id = $1', [id]);
      if (!inserted) throw new MeetingError('concurrent_version', 409);
    }
    await audit(tx, actor, existing ? 'meeting.attendance.corrected' : 'meeting.attendance.recorded',
      'meeting_attendee', id, { meetingId: meeting.id, votingEligible, present });
    return one(tx, 'SELECT * FROM meeting_attendees WHERE id = $1', [id]);
  });
  return { attendee: attendeeFromRow(row) };
}

export async function determineQuorum(db, actor, input = {}) {
  const key = idempotencyKey(input.idempotencyKey);
  const meeting = await meetingForManage(db, actor, input.meetingId);
  const result = await idempotent(db, actor, key, 'meeting.quorum.determine', { meetingId: meeting.id },
    async tx => {
      const id = randomUUID();
      const row = await one(tx,
        `INSERT INTO meeting_quorum_checks (id, meeting_id, determined_by) VALUES ($1, $2, $3)
         RETURNING met, present_eligible, required_count`, [id, meeting.id, actor.userId]);
      await audit(tx, actor, 'meeting.quorum.determined', 'meeting_quorum_check', id, {
        meetingId: meeting.id, met: row.met, presentEligible: row.present_eligible,
        requiredCount: row.required_count,
      });
      return { entityType: 'meeting_quorum_check', entityId: id };
    });
  const row = await one(db, `${QUORUM_CHECK_SELECT} WHERE c.id = $1`, [result.entityId]);
  return { quorumCheck: quorumCheckFromRow(row), replayed: result.replayed };
}

// ---------- minutes ----------

export async function createMinutesVersion(db, actor, input = {}) {
  const key = idempotencyKey(input.idempotencyKey);
  const meeting = await meetingForManage(db, actor, input.meetingId);
  const data = {
    meetingId: meeting.id,
    body: text(input.body, 10, 200000),
    changeNote: text(input.changeNote, 3, 500, { optional: true }),
  };
  const result = await idempotent(db, actor, key, 'meeting.minutes.create', data, async tx => {
    const latest = await one(tx,
      'SELECT id, version FROM meeting_minutes WHERE meeting_id = $1 ORDER BY version DESC LIMIT 1',
      [meeting.id]);
    const id = randomUUID();
    const version = latest ? latest.version + 1 : 1;
    await tx.query(
      `INSERT INTO meeting_minutes (id, meeting_id, version, supersedes_id, body, change_note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, meeting.id, version, latest?.id ?? null, data.body, data.changeNote, actor.userId]);
    await audit(tx, actor, 'meeting.minutes.version_created', 'meeting_minutes', id,
      { meetingId: meeting.id, version });
    return { entityType: 'meeting_minutes', entityId: id };
  });
  return { minutes: minutesFromRow(await loadMinutes(db, result.entityId)), replayed: result.replayed };
}

export async function approveMinutes(db, actor, input = {}) {
  const minutes = await loadMinutes(db, input.minutesId, input.meetingId);
  await meetingForManage(db, actor, minutes.meeting_id);
  const approvalNote = text(input.approvalNote, 3, 500, { optional: true });
  if (minutes.status === 'approved') return { minutes: minutesFromRow(minutes), replayed: true };
  const changed = await mutate(db, async tx => {
    const { rows } = await tx.query(
      `UPDATE meeting_minutes SET status = 'approved', approved_by = $2, approved_at = now(), approval_note = $3
        WHERE id = $1 AND status = 'draft' RETURNING id`, [minutes.id, actor.userId, approvalNote]);
    if (!rows.length) return false;
    await audit(tx, actor, 'meeting.minutes.approved', 'meeting_minutes', minutes.id,
      { meetingId: minutes.meeting_id, version: minutes.version });
    return true;
  });
  return { minutes: minutesFromRow(await loadMinutes(db, minutes.id)), replayed: !changed };
}

export async function setMinutesVisibility(db, actor, input = {}) {
  const key = idempotencyKey(input.idempotencyKey);
  const minutes = await loadMinutes(db, input.minutesId, input.meetingId);
  await meetingForManage(db, actor, minutes.meeting_id);
  if (!VISIBILITIES.has(input.visibility)) throw new MeetingError('invalid_request');
  const data = {
    minutesId: minutes.id,
    visibility: input.visibility,
    reason: text(input.reason, 3, 500, { optional: true }),
  };
  const result = await idempotent(db, actor, key, 'meeting.minutes.visibility', data, async tx => {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO meeting_minutes_publications (id, minutes_id, visibility, reason, created_by)
       VALUES ($1, $2, $3, $4, $5)`, [id, data.minutesId, data.visibility, data.reason, actor.userId]);
    await audit(tx, actor, 'meeting.minutes.visibility_set', 'meeting_minutes', minutes.id,
      { meetingId: minutes.meeting_id, visibility: data.visibility, publicationId: id });
    return { entityType: 'meeting_minutes_publication', entityId: id };
  });
  return { minutes: minutesFromRow(await loadMinutes(db, minutes.id)), replayed: result.replayed };
}

const SHARED_MINUTES_SQL = `
  SELECT e.id, e.meeting_id, e.version, e.body, e.approved_at, e.visibility,
         m.school_year_id, m.kind, m.class_id, m.title, m.scheduled_at
    FROM meeting_effective_minutes e
    JOIN meetings m ON m.id = e.meeting_id
   WHERE m.school_year_id = $1 AND e.visibility = ANY($2::text[])
     AND (m.class_id IS NULL OR $3::boolean OR m.class_id = ANY($4::text[]))
   ORDER BY m.scheduled_at DESC, m.id
   LIMIT 200`;

function sharedFromRow(row) {
  return {
    minutesId: row.id,
    meetingId: row.meeting_id,
    schoolYearId: row.school_year_id,
    kind: row.kind,
    classId: row.class_id ?? null,
    title: row.title,
    scheduledAt: iso(row.scheduled_at),
    version: row.version,
    approvedAt: iso(row.approved_at),
    visibility: row.visibility,
    body: row.body,
  };
}

// Approved minutes shared with parents (or public). Representatives see plenary
// and board minutes plus minutes of their own classes only.
export async function listSharedMinutes(db, actor, input = {}) {
  const schoolYearId = requireId(input.schoolYearId);
  contextFor(actor, null);
  let allClasses = true;
  try {
    authorize(actor, READ_ROLES, { schoolYearId });
  } catch {
    allClasses = false;
  }
  const classIds = allClasses ? [] : actorClassIds(actor, schoolYearId);
  if (!allClasses && !classIds.length) throw new MeetingError('forbidden', 403);
  const { rows } = await db.query(SHARED_MINUTES_SQL,
    [schoolYearId, ['parents', 'public'], allClasses, classIds]);
  return { minutes: rows.map(sharedFromRow) };
}

// Parent-facing query for a future parent session: only approved minutes shared
// with parents or the public, for the given classes of the parent's children.
// The caller must derive `classIds` server-side from the parent's own children.
export async function listMinutesForParents(db, input = {}) {
  const schoolYearId = requireId(input.schoolYearId);
  const classIds = Array.isArray(input.classIds) ? input.classIds.map(id => requireId(id)) : [];
  const { rows } = await db.query(SHARED_MINUTES_SQL, [schoolYearId, ['parents', 'public'], false, classIds]);
  return { minutes: rows.map(sharedFromRow) };
}

export async function listPublicMinutes(db, input = {}) {
  const schoolYearId = requireId(input.schoolYearId);
  const { rows } = await db.query(SHARED_MINUTES_SQL, [schoolYearId, ['public'], true, []]);
  return { minutes: rows.map(sharedFromRow) };
}

// ---------- resolutions ----------

export async function createResolution(db, actor, input = {}) {
  const key = idempotencyKey(input.idempotencyKey);
  const meeting = await meetingForManage(db, actor, input.meetingId);
  const status = input.status ?? 'draft';
  if (!RESOLUTION_STATUSES.has(status)) throw new MeetingError('invalid_request');
  const data = {
    meetingId: meeting.id,
    number: text(input.number, 3, 64, { optional: true }),
    title: text(input.title, 3, 300),
    body: text(input.body, 3, 20000),
    status,
    ...parseVotes(input),
    quorumCheckId: optionalId(input.quorumCheckId),
    amendsResolutionId: optionalId(input.amendsResolutionId),
  };
  if (status === 'adopted' && !data.number) throw new MeetingError('resolution_number_required');
  requireFinalVotes(status, data, data.quorumCheckId);
  const result = await idempotent(db, actor, key, 'resolution.create', data, async tx => {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO resolutions (id, school_year_id, meeting_id, number, title, body, status,
         votes_for, votes_against, votes_abstain, quorum_check_id, amends_resolution_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, meeting.school_year_id, meeting.id, data.number, data.title, data.body, data.status,
        data.votesFor, data.votesAgainst, data.votesAbstain, data.quorumCheckId,
        data.amendsResolutionId, actor.userId]);
    await audit(tx, actor, 'resolution.created', 'resolution', id, { meetingId: meeting.id, status });
    return { entityType: 'resolution', entityId: id };
  });
  return { resolution: resolutionFromRow(await loadResolution(db, result.entityId)), replayed: result.replayed };
}

// Edits a draft or records its final outcome. Final resolutions are immutable.
export async function updateResolution(db, actor, input = {}) {
  const resolution = await loadResolution(db, input.resolutionId, input.meetingId);
  await meetingForManage(db, actor, resolution.meeting_id);
  if (resolution.status !== 'draft') throw new MeetingError('resolution_final_immutable', 409);
  const next = {
    number: input.number !== undefined ? text(input.number, 3, 64, { optional: true }) : resolution.number,
    title: input.title !== undefined ? text(input.title, 3, 300) : resolution.title,
    body: input.body !== undefined ? text(input.body, 3, 20000) : resolution.body,
    status: input.status ?? resolution.status,
    votesFor: input.votesFor !== undefined ? integer(input.votesFor, 0, 10000, { optional: true }) : resolution.votes_for,
    votesAgainst: input.votesAgainst !== undefined
      ? integer(input.votesAgainst, 0, 10000, { optional: true }) : resolution.votes_against,
    votesAbstain: input.votesAbstain !== undefined
      ? integer(input.votesAbstain, 0, 10000, { optional: true }) : resolution.votes_abstain,
    quorumCheckId: input.quorumCheckId !== undefined ? optionalId(input.quorumCheckId) : resolution.quorum_check_id,
  };
  if (!RESOLUTION_STATUSES.has(next.status)) throw new MeetingError('invalid_request');
  if (next.status === 'adopted' && !next.number) throw new MeetingError('resolution_number_required');
  requireFinalVotes(next.status, next, next.quorumCheckId);
  await mutate(db, async tx => {
    const { rows } = await tx.query(
      `UPDATE resolutions SET number = $2, title = $3, body = $4, status = $5, votes_for = $6,
         votes_against = $7, votes_abstain = $8, quorum_check_id = $9
       WHERE id = $1 AND status = 'draft' RETURNING id`,
      [resolution.id, next.number, next.title, next.body, next.status, next.votesFor,
        next.votesAgainst, next.votesAbstain, next.quorumCheckId]);
    if (!rows.length) throw new MeetingError('resolution_final_immutable', 409);
    await audit(tx, actor, 'resolution.updated', 'resolution', resolution.id,
      { meetingId: resolution.meeting_id, fromStatus: resolution.status, toStatus: next.status });
  });
  return { resolution: resolutionFromRow(await loadResolution(db, resolution.id)) };
}

// Corrects the record of a final resolution (e.g. a mistyped vote count) as a new
// revision with the same number. Allowed only until the minutes are approved;
// afterwards a change needs a new amending resolution (amendsResolutionId).
export async function correctResolution(db, actor, input = {}) {
  const key = idempotencyKey(input.idempotencyKey);
  const previous = await loadResolution(db, input.resolutionId, input.meetingId);
  await meetingForManage(db, actor, previous.meeting_id);
  const status = input.status ?? previous.status;
  if (status !== 'adopted' && status !== 'rejected') throw new MeetingError('invalid_request');
  const votes = parseVotes({
    votesFor: input.votesFor ?? previous.votes_for,
    votesAgainst: input.votesAgainst ?? previous.votes_against,
    votesAbstain: input.votesAbstain ?? previous.votes_abstain,
  });
  const data = {
    correctsId: previous.id,
    reason: text(input.reason, 3, 500),
    title: input.title !== undefined ? text(input.title, 3, 300) : previous.title,
    body: input.body !== undefined ? text(input.body, 3, 20000) : previous.body,
    status,
    ...votes,
    quorumCheckId: input.quorumCheckId !== undefined ? optionalId(input.quorumCheckId) : previous.quorum_check_id,
  };
  if (status === 'adopted' && !previous.number) throw new MeetingError('resolution_number_required');
  requireFinalVotes(status, data, data.quorumCheckId);
  const result = await idempotent(db, actor, key, 'resolution.correct', data, async tx => {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO resolutions (id, school_year_id, meeting_id, number, revision, corrects_id,
         correction_reason, amends_resolution_id, title, body, status, votes_for, votes_against,
         votes_abstain, quorum_check_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [id, previous.school_year_id, previous.meeting_id, previous.number, previous.revision + 1,
        previous.id, data.reason, previous.amends_resolution_id, data.title, data.body, data.status,
        data.votesFor, data.votesAgainst, data.votesAbstain, data.quorumCheckId, actor.userId]);
    await audit(tx, actor, 'resolution.corrected', 'resolution', id,
      { meetingId: previous.meeting_id, correctsId: previous.id, revision: previous.revision + 1, status });
    return { entityType: 'resolution', entityId: id };
  });
  return { resolution: resolutionFromRow(await loadResolution(db, result.entityId)), replayed: result.replayed };
}

// Lookup used by the ledger for expenses above 3000 EUR: the current revision of
// an adopted resolution with exactly this number in the school year.
export async function findAdoptedResolution(db, actor, input = {}) {
  const schoolYearId = requireId(input.schoolYearId);
  const number = text(input.number, 3, 64);
  authorize(actor, RESOLUTION_LOOKUP_ROLES, { schoolYearId });
  const row = await one(db,
    `SELECT * FROM resolution_current
      WHERE school_year_id = $1 AND number = $2 AND status = 'adopted'`, [schoolYearId, number]);
  if (!row) throw new MeetingError('resolution_not_found', 404);
  return { resolution: resolutionFromRow(row) };
}

// ---------- HTTP ----------

async function readJson(request) {
  const type = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw new MeetingError('invalid_content_type', 415);
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new MeetingError('request_too_large', 413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) throw new MeetingError('request_too_large', 413);
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not_object');
    return data;
  } catch {
    throw new MeetingError('invalid_json');
  }
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new MeetingError('invalid_request');
  }
}

async function loadActor(request, env) {
  if (typeof env?.loadAuthorizationContext !== 'function') throw new MeetingError('service_unavailable', 503);
  const context = await env.loadAuthorizationContext(request, env);
  if (!context?.session?.user?.id) throw new MeetingError('unauthenticated', 401);
  return {
    userId: context.session.user.id,
    grants: Array.isArray(context.grants) ? context.grants : [],
    mfaVerified: Boolean(context.session.mfaVerified),
  };
}

// { name: 'method', allowed } niesie dozwolone metody dla tej ścieżki (#156,
// RFC 9110 §15.5.6 wymaga nagłówka Allow przy 405) — handle() go odczytuje.
function route(method, pathname) {
  const parts = pathname.split('/').filter(Boolean).slice(2).map(decode);
  const [a, b, c, d, e] = parts;
  const n = parts.length;
  if (n === 0) {
    if (method === 'GET') return { name: 'list' };
    if (method === 'POST') return { name: 'create', create: true };
    return { name: 'method', allowed: ['GET', 'POST'] };
  }
  if (n === 1 && a === 'shared-minutes') {
    return method === 'GET' ? { name: 'shared' } : { name: 'method', allowed: ['GET'] };
  }
  if (n === 1 && a === 'public-minutes') {
    return method === 'GET' ? { name: 'public' } : { name: 'method', allowed: ['GET'] };
  }
  if (n === 2 && a === 'resolutions' && b === 'lookup') {
    return method === 'GET' ? { name: 'lookup' } : { name: 'method', allowed: ['GET'] };
  }
  const meetingId = a;
  if (n === 1) {
    if (method === 'GET') return { name: 'get', meetingId };
    if (method === 'PATCH') return { name: 'update', meetingId };
    return { name: 'method', allowed: ['GET', 'PATCH'] };
  }
  const post = method === 'POST';
  if (n === 2 && b === 'agenda-items') {
    return post ? { name: 'agenda', meetingId, create: true } : { name: 'method', allowed: ['POST'] };
  }
  if (n === 2 && b === 'attendance') {
    return post ? { name: 'attendance', meetingId } : { name: 'method', allowed: ['POST'] };
  }
  if (n === 2 && b === 'quorum-checks') {
    return post ? { name: 'quorum', meetingId, create: true } : { name: 'method', allowed: ['POST'] };
  }
  if (n === 2 && b === 'minutes') {
    return post ? { name: 'minutes', meetingId, create: true } : { name: 'method', allowed: ['POST'] };
  }
  if (n === 4 && b === 'minutes' && d === 'approval') {
    return post ? { name: 'approve', meetingId, minutesId: c } : { name: 'method', allowed: ['POST'] };
  }
  if (n === 4 && b === 'minutes' && d === 'visibility') {
    return post ? { name: 'visibility', meetingId, minutesId: c, create: true } : { name: 'method', allowed: ['POST'] };
  }
  if (n === 2 && b === 'resolutions') {
    return post ? { name: 'resolution', meetingId, create: true } : { name: 'method', allowed: ['POST'] };
  }
  if (n === 3 && b === 'resolutions') {
    return method === 'PATCH' ? { name: 'resolutionUpdate', meetingId, resolutionId: c } : { name: 'method', allowed: ['PATCH'] };
  }
  if (n === 4 && b === 'resolutions' && d === 'corrections' && e === undefined) {
    return post ? { name: 'resolutionCorrect', meetingId, resolutionId: c, create: true } : { name: 'method', allowed: ['POST'] };
  }
  return null;
}

// Handles /api/meetings... Returns null for other paths. `env.db` is the PostgreSQL
// handle and `env.loadAuthorizationContext(request, env)` is injected by the app.
export async function handle(request, env, url, json) {
  if (url.pathname !== '/api/meetings' && !url.pathname.startsWith('/api/meetings/')) return null;
  try {
    const target = route(request.method, url.pathname);
    if (!target) return json({ error: 'not_found' }, 404);
    if (target.name === 'method') return json({ error: 'method_not_allowed' }, 405, { Allow: target.allowed.join(', ') });
    const mutation = request.method !== 'GET' && request.method !== 'HEAD';
    if (mutation && !isSameOrigin(request)) return json({ error: 'invalid_origin' }, 403);
    const db = env?.db;
    if (!db) throw new MeetingError('service_unavailable', 503);
    const query = url.searchParams;

    if (target.name === 'public') {
      return json(await listPublicMinutes(db, { schoolYearId: query.get('schoolYearId') }));
    }

    const actor = await loadActor(request, env);
    if (!mutation) {
      if (target.name === 'list') return json(await listMeetings(db, actor, { schoolYearId: query.get('schoolYearId') }));
      if (target.name === 'shared') {
        return json(await listSharedMinutes(db, actor, { schoolYearId: query.get('schoolYearId') }));
      }
      if (target.name === 'lookup') {
        return json(await findAdoptedResolution(db, actor, {
          schoolYearId: query.get('schoolYearId'), number: query.get('number'),
        }));
      }
      return json(await getMeeting(db, actor, { meetingId: target.meetingId }));
    }

    const body = await readJson(request);
    const input = { ...body, meetingId: target.meetingId, minutesId: target.minutesId,
      resolutionId: target.resolutionId };
    if (target.create) input.idempotencyKey = request.headers.get('Idempotency-Key')?.trim();

    const handlers = {
      create: () => createMeeting(db, actor, input),
      update: () => updateMeeting(db, actor, input),
      agenda: () => addAgendaItem(db, actor, input),
      attendance: () => recordAttendance(db, actor, input),
      quorum: () => determineQuorum(db, actor, input),
      minutes: () => createMinutesVersion(db, actor, input),
      approve: () => approveMinutes(db, actor, input),
      visibility: () => setMinutesVisibility(db, actor, input),
      resolution: () => createResolution(db, actor, input),
      resolutionUpdate: () => updateResolution(db, actor, input),
      resolutionCorrect: () => correctResolution(db, actor, input),
    };
    const { replayed, ...result } = await handlers[target.name]();
    if (!target.create) return json(result);
    return json(result, replayed ? 200 : 201, { 'Idempotency-Replayed': replayed ? 'true' : 'false' });
  } catch (error) {
    if (error instanceof MeetingError) return json({ error: error.code }, error.status);
    throw error;
  }
}
