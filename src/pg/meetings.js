// Zebrania, obecność, quorum, protokoły i uchwały (#13) na PostgreSQL.
//
// Usługi mają postać `(db, actor, input)`, gdzie `db` udostępnia `query(sql, params)`
// (pg.Pool, dedykowany pg.Client albo PGlite), a `actor = { userId, grants, mfaVerified }`.
// Uprawnienia sprawdza wspólny resolver zakresu src/pg/scope.js (#155), oparty
// na czystej funkcji `isAuthorized` z src/authorization.js.
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
import { actorContext, authorizedClassIds, hasAnyMatchingGrant, isAuthorizedScoped } from './scope.js';
import { detectPossiblePersonalData } from './pii-check.js';
import { gateFreeText, loadKnownNames, piiAuditMetadata } from './pii-gate.js';
import { insertAuditEvent } from './audit.js';
import { ContentError, contentHash as emailContentHash, parseCampaignContent } from '../email/content.js';
import { createJsonReader } from './input.js';
import { buildCalendar, icalUidDomain } from '../ical.js';

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
  // 0060_resolution_register.sql (#102)
  'resolution_amends_cross_year_requires_flag',
  // Zwykle nieosiągalne z API (moduł wstawia projekt i nie usuwa zebrań), ale to
  // odmowa reguły danych, nie awaria — 409 zamiast 503.
  'minutes_must_start_as_draft', 'meetings_cannot_be_deleted',
  // Rok zamknięty (0017_year_close.sql, triggery a0_year_freeze).
  'school_year_closed',
  // #135: zasada czterech oczu w triggerze (bezpośredni UPDATE z pominięciem
  // serwisu, który tę samą regułę zwraca jako 403 — zob. approveMinutes).
  'minutes_four_eyes_required',
  // 0139_meeting_cancel_notice.sql (#113): odwołanie, wycofanie punktu,
  // zawiadomienie i szkic kampanii powiązany z zebraniem.
  'meeting_cancelled', 'agenda_item_withdrawal_immutable', 'meeting_notice_closed',
  'meeting_notice_immutable', 'meeting_notice_not_latest', 'meeting_notice_must_start_as_draft',
  'email_campaign_meeting_requires_approved_notice', 'email_campaign_meeting_audience_mismatch',
]);

// #135 (SR-10): operacje, które uzasadniają wydatek powyżej 3000 EUR albo
// nieodwracalnie ustalają dokument zebrania, wymagają sesji z potwierdzonym
// MFA (403 mfa_required, zgodnie z obsługą w panelu, zob. #99). Jedna lista,
// udokumentowana w docs/AUTHORIZATION.md. Uwaga: od #150 MFA jest wymagane
// dla CAŁEGO zarządzania zebraniem (meetingForManage, createMeeting), także dla
// szkicu uchwały, porządku obrad, obecności i widoczności internal — ta lista
// opisuje tylko operacje z dodatkowym, własnym sprawdzeniem (#135).
export const MFA_REQUIRED_ACTIONS = Object.freeze([
  'resolution.decide', // createResolution/updateResolution -> adopted|rejected, correctResolution
  'meeting.minutes.approve', // approveMinutes
  'meeting.minutes.publish', // setMinutesVisibility -> parents|public
]);

function requireMfaVerified(actor) {
  if (!actor?.mfaVerified) throw new MeetingError('mfa_required', 403);
}

export class MeetingError extends Error {
  constructor(code, status = 400, details = undefined) {
    super(code);
    this.code = code;
    this.status = status;
    // #102: pole dodatkowe do odpowiedzi błędu (np. świeża podpowiedź numeru
    // po kolizji resolution_number_taken). Nigdy treść uchwały ani protokołu.
    this.details = details;
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

// #215 etap 2: `revision` (numer wersji `revision_no` wiersza) jest wymagane
// przy edycji uchwały i zebrania. Brak lub nie-liczba całkowita → 400
// `invalid_revision`; niezgodność z bieżącą wersją → 409 `revision_conflict`.
function requiredRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000000000) throw new MeetingError('invalid_revision');
  return value;
}

function bool(value) {
  if (typeof value !== 'boolean') throw new MeetingError('invalid_request');
  return value;
}

const RELATION_KINDS = new Set(['amends', 'repeals']);
// #102: relationKind jest wymagane razem z amendsResolutionId (oba albo żadne).
function oneOfRelationKind(value) {
  if (!RELATION_KINDS.has(value)) throw new MeetingError('invalid_relation_kind');
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

// #113: reguła terminu zawiadomienia (D-21) — liczba dni i źródło wpisywane
// razem (jak reguła quorum). Serwer tylko odnotowuje spóźnione zawiadomienie.
function parseNoticeRule(input) {
  const minDays = integer(input.noticeMinDays, 0, 365, { optional: true });
  const source = text(input.noticeRuleSource, 3, 200, { optional: true });
  if ((minDays === null) !== (source === null)) throw new MeetingError('invalid_notice_rule');
  return { noticeMinDays: minDays, noticeRuleSource: source };
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

// Kontekst aktora; bez userId — 401. Zakres (rok, klasa) liczy src/pg/scope.js
// (#155): przydział klasowy nigdy nie dosięga zebrania ogólnego ani zarządu,
// ani innej klasy (isAuthorizedScoped, SR-01).
function meetingContext(actor) {
  if (!actor || typeof actor.userId !== 'string' || !actor.userId) {
    throw new MeetingError('unauthenticated', 401);
  }
  return actorContext({ ...actor, grants: Array.isArray(actor.grants) ? actor.grants : [] });
}

// #150 (SR-10): zarządzanie zebraniami, protokołami i uchwałami (MANAGE_ROLES)
// wymaga jawnie potwierdzonego MFA na poziomie trasy, niezależnie od bramki
// routera (mfa-policy.js) — uchwały uzasadniają wydatki > 3000 EUR (D-15).
// Sprawdzenie zakresu/roli jest ZAWSZE pierwsze (SR-07): ktoś bez roli albo
// spoza klasy dostaje ten sam ogólny `forbidden`, niezależnie od stanu MFA —
// `mfa_required` nie ujawnia nic osobie, która i tak nie ma dostępu.
function authorize(actor, roles, { schoolYearId, classId = null, requireMfa = false } = {}) {
  const context = meetingContext(actor);
  const requirement = { roles: [...roles], schoolYearId };
  if (classId) requirement.classId = classId;
  if (!isAuthorizedScoped(context, requirement)) throw new MeetingError('forbidden', 403);
  if (requireMfa && !context.session.mfaVerified) throw new MeetingError('mfa_required', 403);
}

function actorClassIds(actor, schoolYearId) {
  return authorizedClassIds(meetingContext(actor), { roles: ['representative'], schoolYearId });
}

// #171 (D-08, wariant najbardziej zachowawczy do czasu decyzji zarządu): flaga
// domyślnie wyłączona. Włączona wartością dokładnie 'representative' (zgodnie
// z propozycją issue) pozwala przedstawicielowi klasy prowadzić WYŁĄCZNIE
// zebrania kind='class' własnej klasy — nigdy ogólne ani zarządu, nigdy inną
// klasę. Nie rozszerza to zatwierdzania protokołu, widoczności, ustalania
// quorum ani uchwał: te trasy zostają MANAGE_ROLES-only bez zmian (patrz
// meetingForManage, niżej), co samo w sobie realizuje kryterium akceptacji
// „przedstawiciel nie zatwierdza protokołu, który sam utworzył”.
function classHostEnabled(env) {
  const raw = env && Object.hasOwn(env, 'MEETINGS_CLASS_HOST') ? env.MEETINGS_CLASS_HOST : process.env.MEETINGS_CLASS_HOST;
  return raw === 'representative';
}

function isClassHost(actor, env, { schoolYearId, classId, kind }) {
  if (!classHostEnabled(env) || kind !== 'class' || !classId) return false;
  return isAuthorizedScoped(meetingContext(actor), { roles: ['representative'], schoolYearId, classId });
}

function hasManageRole(actor, { schoolYearId, classId }) {
  try {
    authorize(actor, MANAGE_ROLES, { schoolYearId, classId });
    return true;
  } catch (error) {
    if (error instanceof MeetingError && error.status === 403) return false;
    throw error;
  }
}

// Wpisy obecności/porządku/protokołu zebrania klasowego prowadzonego przez
// przedstawiciela (flaga włączona). Ustalanie quorum, zatwierdzanie protokołu,
// widoczność i uchwały NIE korzystają z tej funkcji — zostają przy
// meetingForManage (admin/board), świadome zawężenie zakresu (patrz PR #171).
async function meetingForManageOrClassHost(db, actor, meetingId, env) {
  const meeting = await loadMeeting(db, meetingId);
  const scope = { schoolYearId: meeting.school_year_id, classId: meeting.class_id };
  // SR-07: sprawdzenie zakresu/roli zawsze pierwsze — brak dostępu daje ten sam
  // `forbidden`, niezależnie od stanu MFA (#150, jak w authorize() niżej).
  let viaClassHost;
  if (hasManageRole(actor, scope)) viaClassHost = false;
  else if (isClassHost(actor, env, { ...scope, kind: meeting.kind })) viaClassHost = true;
  else throw new MeetingError('forbidden', 403);
  // #150 (SR-10): zarządzanie zebraniem wymaga jawnie potwierdzonego MFA,
  // niezależnie od bramki routera — również dla #171 (przedstawiciel-gospodarz).
  requireMfaVerified(actor);
  return { meeting, viaClassHost };
}

// Opiekun należący do klasy zebrania (dla ograniczenia listy obecności prowadzonej
// przez przedstawiciela do własnej klasy — #171, minimalizacja jak w families/).
async function guardianInClass(db, guardianId, classId, schoolYearId) {
  const row = await one(db,
    `SELECT 1 FROM student_guardians_current sg
       JOIN enrollments_current e ON e.student_id = sg.student_id
      WHERE sg.guardian_id = $1 AND e.class_id = $2 AND e.school_year_id = $3
      LIMIT 1`,
    [guardianId, classId, schoolYearId]);
  return Boolean(row);
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

// #184: przechodzi przez insertAuditEvent (assertNoPii), nie własny INSERT.
async function audit(tx, actor, action, entityType, entityId, metadata = {}) {
  await insertAuditEvent(tx, { actorId: actor.userId, action, entityType, entityId, metadata });
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
    // #215: optymistyczna kontrola wersji edycji PATCH — patrz updateMeeting.
    revisionNo: row.revision_no,
    // #113: odwołanie (powód wewnętrzny, usuwany z widoku gospodarza klasy) i reguła terminu zawiadomienia.
    cancelledAt: iso(row.cancelled_at),
    cancelledBy: row.cancelled_by ?? null,
    cancellationReason: row.cancellation_reason ?? null,
    noticeRule: { minDays: row.notice_min_days ?? null, source: row.notice_rule_source ?? null },
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
    description: row.description ?? null, withdrawnAt: iso(row.withdrawn_at) };
}

function agendaVersionFromRow(row) {
  return { id: row.id, meetingId: row.meeting_id, version: row.version, contentHash: row.content_hash,
    items: row.snapshot, createdAt: iso(row.created_at), createdBy: row.created_by };
}

function rescheduleFromRow(row, internalView) {
  return {
    id: row.id, meetingId: row.meeting_id,
    fromScheduledAt: iso(row.from_scheduled_at), toScheduledAt: iso(row.to_scheduled_at),
    reason: internalView ? row.reason : null, actorId: internalView ? row.actor_id : null,
    createdAt: iso(row.created_at),
  };
}

function noticeFromRow(row, { internalView = true, isLatest = false, outdated = false } = {}) {
  return {
    id: row.id, meetingId: row.meeting_id, version: row.version, kind: row.kind, title: row.title,
    scheduledAt: iso(row.scheduled_at), previousScheduledAt: iso(row.previous_scheduled_at),
    location: row.location ?? null, agendaVersionId: row.agenda_version_id ?? null,
    contentHash: row.content_hash, status: row.status,
    createdAt: iso(row.created_at), approvedAt: iso(row.approved_at),
    noticeDaysBefore: row.notice_days_before ?? null, noticeLate: row.notice_late ?? null,
    isLatest,
    // true: zebranie (termin, miejsce, tytuł) albo porządek obrad zmieniły się po
    // sporządzeniu tego zawiadomienia — potrzebna nowa wersja i nowe zatwierdzenie.
    outdated: row.kind === 'cancellation' ? false : outdated,
    campaignId: internalView ? row.campaign_id ?? null : null,
    createdBy: internalView ? row.created_by : null,
    approvedBy: internalView ? row.approved_by ?? null : null,
  };
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
    // #215: revisionNo osobno od revision (łańcucha korekt) — do optymistycznej
    // kontroli wersji edycji PATCH (patrz updateResolution).
    revisionNo: row.revision_no,
    correctsId: row.corrects_id ?? null,
    correctionReason: row.correction_reason ?? null,
    amendsResolutionId: row.amends_resolution_id ?? null,
    relationKind: row.relation_kind ?? null,
    relationCrossYear: Boolean(row.relation_cross_year),
    title: row.title,
    body: row.body,
    status: row.status,
    votesFor: row.votes_for ?? null,
    votesAgainst: row.votes_against ?? null,
    votesAbstain: row.votes_abstain ?? null,
    quorumCheckId: row.quorum_check_id ?? null,
    decidedAt: iso(row.decided_at),
    // #102: obecne wyłącznie, gdy zapytanie dołączyło resolution_effective_status.
    ...(row.effective_status !== undefined ? { effectiveStatus: row.effective_status } : {}),
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
  authorize(actor, MANAGE_ROLES, { schoolYearId: meeting.school_year_id, classId: meeting.class_id, requireMfa: true });
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
  const context = meetingContext(actor);
  // Any read grant for the year (also class-scoped) may list; rows are filtered below.
  if (!hasAnyMatchingGrant(context, { roles: [...READ_ROLES], schoolYearId })) throw new MeetingError('forbidden', 403);
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

// Odczyt zebrania: role wewnętrzne (READ_ROLES) albo przedstawiciel-gospodarz
// zebrania klasowego własnej klasy (#171, internalView = false).
async function meetingForRead(db, actor, meetingId, env) {
  const meeting = await loadMeeting(db, meetingId);
  // #113: powody odwołania/zmiany terminu i powiązane kampanie widzą role
  // wewnętrzne (READ_ROLES); przedstawiciel-gospodarz klasy (#171) — nie.
  let internalView = true;
  try {
    authorize(actor, READ_ROLES, { schoolYearId: meeting.school_year_id, classId: meeting.class_id });
  } catch (error) {
    if (!(error instanceof MeetingError) || error.status !== 403
        || !isClassHost(actor, env, { schoolYearId: meeting.school_year_id, classId: meeting.class_id, kind: meeting.kind })) {
      // Ta sama odpowiedź dla brakującego i niedostępnego zebrania (SR-07).
      if (error instanceof MeetingError && error.status === 403) throw new MeetingError('meeting_not_found', 404);
      throw error;
    }
    internalView = false;
  }
  return { meeting, internalView };
}

export async function getMeeting(db, actor, input = {}, env) {
  // #158: zebranie i jego listy czytane z JEDNEJ migawki REPEATABLE READ, READ
  // ONLY, kolejno na jednym połączeniu (jak readSnapshot w db-snapshot.js, ale
  // przez inTransaction, który obsługuje też gołego klienta) — wcześniej
  // równoległe zapytania na puli dawały kilka migawek.
  return inTransaction(db, async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const { meeting, internalView } = await meetingForRead(tx, actor, input.meetingId, env);
    const agenda = await tx.query('SELECT * FROM meeting_agenda_items WHERE meeting_id = $1 ORDER BY position', [meeting.id]);
    const attendees = await tx.query('SELECT * FROM meeting_attendees WHERE meeting_id = $1 ORDER BY recorded_at, id', [meeting.id]);
    const checks = await tx.query(`${QUORUM_CHECK_SELECT} WHERE c.meeting_id = $1 ORDER BY c.seq`, [meeting.id]);
    const minutes = await tx.query(
      `SELECT m.*, v.visibility FROM meeting_minutes m
         JOIN meeting_minutes_visibility v ON v.minutes_id = m.id
        WHERE m.meeting_id = $1 ORDER BY m.version`, [meeting.id]);
    const resolutions = await tx.query('SELECT * FROM resolutions WHERE meeting_id = $1 ORDER BY created_at, revision, id', [meeting.id]);
    const versions = await tx.query('SELECT * FROM meeting_agenda_versions WHERE meeting_id = $1 ORDER BY version', [meeting.id]);
    const reschedules = await tx.query('SELECT * FROM meeting_reschedules WHERE meeting_id = $1 ORDER BY created_at, id', [meeting.id]);
    const notices = await tx.query(
      `SELECT n.*, c.id AS campaign_id FROM meeting_notices n
         LEFT JOIN email_campaigns c ON c.meeting_notice_id = n.id
        WHERE n.meeting_id = $1 ORDER BY n.version`, [meeting.id]);
    const currentAgendaHash = agendaHash(activeAgendaSnapshot(agenda.rows));
    const versionById = new Map(versions.rows.map(row => [row.id, row]));
    const latestVersion = notices.rows.reduce((max, row) => Math.max(max, row.version), 0);
    const view = {
      meeting: meetingFromRow(meeting),
      agenda: agenda.rows.map(agendaItemFromRow),
      attendees: attendees.rows.map(attendeeFromRow),
      quorumChecks: checks.rows.map(quorumCheckFromRow),
      minutes: minutes.rows.map(minutesFromRow),
      resolutions: resolutions.rows.map(resolutionFromRow),
      agendaVersions: versions.rows.map(agendaVersionFromRow),
      reschedules: reschedules.rows.map(row => rescheduleFromRow(row, internalView)),
      notices: notices.rows.map(row => noticeFromRow(row, {
        internalView, isLatest: row.version === latestVersion,
        outdated: noticeOutdated(row, meeting, currentAgendaHash, versionById.get(row.agenda_version_id)),
      })),
    };
    if (!internalView) {
      view.meeting.cancellationReason = null;
      view.meeting.cancelledBy = null;
    }
    return view;
  });
}

export async function createMeeting(db, actor, input = {}, env) {
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
    ...parseNoticeRule(input),
  };
  // #150 (SR-10): tworzenie zebrania to zarządzanie — wymaga MFA niezależnie
  // od tego, czy aktor wchodzi przez rolę zarządu, czy przez #171 (przedstawiciel
  // prowadzący WYŁĄCZNIE zebranie klasowe własnej klasy).
  if (!hasManageRole(actor, { schoolYearId, classId })
      && !isClassHost(actor, env, { schoolYearId, classId, kind: input.kind })) {
    throw new MeetingError('forbidden', 403);
  }
  requireMfaVerified(actor);
  const result = await idempotent(db, actor, key, 'meeting.create', data, async tx => {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO meetings (id, school_year_id, kind, class_id, title, scheduled_at, location, status,
         quorum_mode, quorum_numerator, quorum_denominator, quorum_inclusive, quorum_min_count,
         voting_body_size, quorum_rule_source, created_by, notice_min_days, notice_rule_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [id, data.schoolYearId, data.kind, data.classId, data.title, data.scheduledAt, data.location, data.status,
        data.quorumMode, data.quorumNumerator, data.quorumDenominator, data.quorumInclusive,
        data.quorumMinCount, data.votingBodySize, data.quorumRuleSource, actor.userId,
        data.noticeMinDays, data.noticeRuleSource]);
    await audit(tx, actor, 'meeting.created', 'meeting', id,
      { schoolYearId: data.schoolYearId, kind: data.kind, status: data.status });
    return { entityType: 'meeting', entityId: id };
  });
  return { meeting: meetingFromRow(await loadMeeting(db, result.entityId)), replayed: result.replayed };
}

// #215: reguła quorum jest scalana z zapisanym stanem (pola nieobecne w
// żądaniu zostają) — ten merge czytał sprzed transakcji, więc druga
// równoległa edycja innego pola quorum po cichu cofała pierwszą. Merge i
// zapis są teraz w jednej transakcji, pod blokadą wiersza (FOR UPDATE), a
// `input.revision` jest WYMAGANE (etap 2 #215) i musi zgadzać się z bieżącym
// `revision_no` (brak → `400 invalid_revision`, niezgodne → `409
// revision_conflict`).
export async function updateMeeting(db, actor, input = {}, env) {
  const { meeting } = await meetingForManageOrClassHost(db, actor, input.meetingId, env);
  const expectedRevision = requiredRevision(input.revision);
  await mutate(db, async tx => {
    const { rows: lockedRows } = await tx.query('SELECT * FROM meetings WHERE id = $1 FOR UPDATE', [meeting.id]);
    const locked = lockedRows[0];
    if (!locked) throw new MeetingError('meeting_not_found', 404);
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
      const merged = storedQuorumInput(locked);
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
    if (input.noticeMinDays !== undefined || input.noticeRuleSource !== undefined) {
      const rule = parseNoticeRule({
        noticeMinDays: input.noticeMinDays !== undefined ? input.noticeMinDays : locked.notice_min_days,
        noticeRuleSource: input.noticeRuleSource !== undefined ? input.noticeRuleSource : locked.notice_rule_source,
      });
      changes.notice_min_days = rule.noticeMinDays;
      changes.notice_rule_source = rule.noticeRuleSource;
    }
    if (!Object.keys(changes).length) throw new MeetingError('invalid_request');
    // Wartości identyczne z zapisanymi (poza scheduled_at, porównywanym jako
    // znacznik czasu) odfiltrowane — podwójne kliknięcie/powtórzenie tej
    // samej edycji nic nie zmienia w wierszu, więc dostaje odtworzenie bez
    // błędu i bez nowego zdarzenia audytu, zamiast konfliktu wersji.
    const columns = Object.keys(changes).filter((column) => (
      column === 'scheduled_at'
        ? new Date(changes[column]).getTime() !== new Date(locked.scheduled_at).getTime()
        : changes[column] !== locked[column]
    ));
    if (!columns.length) return;
    if (locked.revision_no !== expectedRevision) {
      throw new MeetingError('revision_conflict', 409);
    }
    // #113: po zatwierdzeniu zawiadomienia zmiana terminu wymaga powodu i
    // tworzy szkic nowego zawiadomienia — robi to POST .../reschedule.
    if (columns.includes('scheduled_at') && await hasApprovedNotice(tx, meeting.id)) {
      throw new MeetingError('use_reschedule_endpoint', 409);
    }
    // #113: termin zmieniony dostaje własne zdarzenie w dzienniku, ze starą i
    // nową datą jako znaczniki czasu (bez treści zebrania) — dziś nie ma jeszcze
    // zawiadomienia (kampanii) ani jego wersji porządku, do których to zdarzenie
    // mogłoby się odnosić (osobny zakres, patrz docs/MEETINGS.md).
    const reschedule = changes.scheduled_at !== undefined
      && new Date(changes.scheduled_at).getTime() !== new Date(locked.scheduled_at).getTime()
      ? { fromScheduledAt: iso(locked.scheduled_at), toScheduledAt: iso(changes.scheduled_at) } : null;
    const assignments = columns.map((column, index) => `${column} = $${index + 2}`).join(', ');
    const { rows } = await tx.query(`UPDATE meetings SET ${assignments} WHERE id = $1 RETURNING revision_no`,
      [meeting.id, ...columns.map(column => changes[column])]);
    await audit(tx, actor, 'meeting.updated', 'meeting', meeting.id, {
      schoolYearId: meeting.school_year_id,
      fields: columns,
      fromRevision: locked.revision_no, toRevision: rows[0].revision_no,
      ...(changes.status && changes.status !== locked.status
        ? { fromStatus: locked.status, toStatus: changes.status } : {}),
    });
    if (reschedule) {
      await audit(tx, actor, 'meeting.rescheduled', 'meeting', meeting.id,
        { schoolYearId: meeting.school_year_id, ...reschedule });
    }
  });
  return { meeting: meetingFromRow(await loadMeeting(db, meeting.id)) };
}

export async function addAgendaItem(db, actor, input = {}, env) {
  const key = idempotencyKey(input.idempotencyKey);
  const { meeting } = await meetingForManageOrClassHost(db, actor, input.meetingId, env);
  const data = {
    meetingId: meeting.id,
    title: text(input.title, 3, 300),
    description: text(input.description, 1, 2000, { optional: true }),
    position: integer(input.position, 1, 200, { optional: true }),
  };
  const result = await idempotent(db, actor, key, 'meeting.agenda_item.add', data, async tx => {
    const gate = gatePii([['meeting_agenda_items.description', data.description]], input);
    const id = randomUUID();
    await tx.query(
      `INSERT INTO meeting_agenda_items (id, meeting_id, position, title, description, created_by)
       VALUES ($1, $2, COALESCE($3::int,
         (SELECT COALESCE(max(position), 0) + 1 FROM meeting_agenda_items WHERE meeting_id = $2)),
         $4, $5, $6)`,
      [id, data.meetingId, data.position, data.title, data.description, actor.userId]);
    await audit(tx, actor, 'meeting.agenda_item.added', 'meeting_agenda_item', id,
      { meetingId: meeting.id, schoolYearId: meeting.school_year_id, ...piiAuditMetadata(gate) });
    return { entityType: 'meeting_agenda_item', entityId: id };
  });
  const row = await one(db, 'SELECT * FROM meeting_agenda_items WHERE id = $1', [result.entityId]);
  return { agendaItem: agendaItemFromRow(row), replayed: result.replayed };
}

// Records or corrects one attendee (upsert by person reference, naturally idempotent).
export async function recordAttendance(db, actor, input = {}, env) {
  const { meeting, viaClassHost } = await meetingForManageOrClassHost(db, actor, input.meetingId, env);
  const userId = optionalId(input.userId);
  const guardianId = optionalId(input.guardianId);
  if (Boolean(userId) === Boolean(guardianId)) throw new MeetingError('invalid_request');
  if (!CAPACITIES.has(input.capacity)) throw new MeetingError('invalid_request');
  // Przedstawiciel prowadzący zebranie klasowe zapisuje wyłącznie siebie (userId)
  // albo opiekuna z tej samej klasy (#171) — lista obecności nie ujawnia opiekunów
  // spoza klasy, tak samo jak minimalizacja w families/.
  if (viaClassHost) {
    if (userId && userId !== actor.userId) throw new MeetingError('forbidden', 403);
    if (guardianId && !(await guardianInClass(db, guardianId, meeting.class_id, meeting.school_year_id))) {
      throw new MeetingError('invalid_reference');
    }
  }
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
      'meeting_attendee', id, { meetingId: meeting.id, schoolYearId: meeting.school_year_id, votingEligible, present });
    return one(tx, 'SELECT * FROM meeting_attendees WHERE id = $1', [id]);
  });
  return { attendee: attendeeFromRow(row) };
}

export async function determineQuorum(db, actor, input = {}) {
  const key = idempotencyKey(input.idempotencyKey);
  const meeting = await meetingForManage(db, actor, input.meetingId);
  // #81: hash wejścia zawiera stan listy obecności. Ponowienie tego samego
  // klucza po zmianie obecności nie odtwarza starego ustalenia (409
  // idempotency_conflict) — nowe ustalenie wymaga nowego klucza.
  const state = await one(db, 'SELECT revision FROM meeting_attendance_state WHERE meeting_id = $1', [meeting.id]);
  const result = await idempotent(db, actor, key, 'meeting.quorum.determine',
    { meetingId: meeting.id, attendanceRevision: Number(state?.revision ?? 0) },
    async tx => {
      const id = randomUUID();
      const row = await one(tx,
        `INSERT INTO meeting_quorum_checks (id, meeting_id, determined_by) VALUES ($1, $2, $3)
         RETURNING met, present_eligible, required_count`, [id, meeting.id, actor.userId]);
      await audit(tx, actor, 'meeting.quorum.determined', 'meeting_quorum_check', id, {
        meetingId: meeting.id, schoolYearId: meeting.school_year_id, met: row.met,
        presentEligible: row.present_eligible, requiredCount: row.required_count,
      });
      return { entityType: 'meeting_quorum_check', entityId: id };
    });
  const row = await one(db, `${QUORUM_CHECK_SELECT} WHERE c.id = $1`, [result.entityId]);
  return { quorumCheck: quorumCheckFromRow(row), replayed: result.replayed };
}

// ---------- minutes ----------

export async function createMinutesVersion(db, actor, input = {}, env) {
  const key = idempotencyKey(input.idempotencyKey);
  const { meeting } = await meetingForManageOrClassHost(db, actor, input.meetingId, env);
  const data = {
    meetingId: meeting.id,
    body: text(input.body, 10, 200000),
    changeNote: text(input.changeNote, 3, 500, { optional: true }),
  };
  const result = await idempotent(db, actor, key, 'meeting.minutes.create', data, async tx => {
    const gate = gatePii([
      ['meeting_minutes.body', data.body],
      ['meeting_minutes.change_note', data.changeNote],
    ], input);
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
      { meetingId: meeting.id, schoolYearId: meeting.school_year_id, version, ...piiAuditMetadata(gate) });
    return { entityType: 'meeting_minutes', entityId: id };
  });
  return { minutes: minutesFromRow(await loadMinutes(db, result.entityId)), replayed: result.replayed };
}

export async function approveMinutes(db, actor, input = {}) {
  const minutes = await loadMinutes(db, input.minutesId, input.meetingId);
  const meeting = await meetingForManage(db, actor, minutes.meeting_id);
  const approvalNote = text(input.approvalNote, 3, 500, { optional: true });
  if (minutes.status === 'approved') return { minutes: minutesFromRow(minutes), replayed: true };
  requireMfaVerified(actor);
  // #135: zasada czterech oczu — zatwierdzający musi być inną osobą niż autor
  // tej wersji protokołu. Ta sama reguła w triggerze (0042) chroni bezpośredni UPDATE.
  if (minutes.created_by === actor.userId) throw new MeetingError('minutes_four_eyes_required', 403);
  let changed;
  try {
    changed = await mutate(db, async tx => {
      const gate = gatePii([['meeting_minutes.approval_note', approvalNote]], input);
      const { rows } = await tx.query(
        `UPDATE meeting_minutes SET status = 'approved', approved_by = $2, approved_at = now(), approval_note = $3
          WHERE id = $1 AND status = 'draft' RETURNING id`, [minutes.id, actor.userId, approvalNote]);
      if (!rows.length) return false;
      await audit(tx, actor, 'meeting.minutes.approved', 'meeting_minutes', minutes.id,
        { meetingId: minutes.meeting_id, schoolYearId: meeting.school_year_id, version: minutes.version, ...piiAuditMetadata(gate) });
      return true;
    });
  } catch (error) {
    // #81: odmowa niesie samą liczbę otwartych projektów (nigdy tytułów ani treści).
    if (error instanceof MeetingError && error.code === 'minutes_open_resolutions') {
      const open = await countOpenResolutions(db, minutes.meeting_id);
      throw new MeetingError(error.code, error.status, { openResolutions: open });
    }
    throw error;
  }
  return { minutes: minutesFromRow(await loadMinutes(db, minutes.id)), replayed: !changed };
}

// #152: bramka pól wolnego tekstu (src/pg/pii-gate.js) — błąd 422 tego modułu;
// kategorie w `details`, nigdy treść. `confirmPersonalData` z żądania.
function gatePii(fields, input) {
  return gateFreeText(fields, {
    confirm: input?.confirmPersonalData === true,
    fail: (code, categories) => new MeetingError(code, 422, { categories }),
  });
}

async function countOpenResolutions(db, meetingId) {
  const row = await one(db,
    `SELECT count(*)::int AS n FROM resolution_current WHERE meeting_id = $1 AND status = 'draft'`, [meetingId]);
  return row?.n ?? 0;
}

// #81: lista kontrolna przed zatwierdzeniem protokołu — TYLKO ODCZYT, bez wpisu
// w audit_events, bez zmiany danych. Uprawnienia jak przy odczycie zebrania
// (admin, zarząd, Komisja Rewizyjna; zarząd klasowy tylko własnej klasy);
// brak uprawnień jest nieodróżnialny od braku zebrania (SR-07: 404), także
// dla przedstawiciela. Zwraca wyłącznie kody i liczby, bez treści uchwał.
// `blocking: true` — serwer i tak odrzuci zatwierdzenie (409); pozostałe
// pozycje to ostrzeżenia, bo pierwsze zatwierdzenie blokuje zebranie na stałe
// (D-21 otwarte: wariant zachowawczy, korekta po zatwierdzeniu to nowy zapis).
export async function getApprovalChecklist(db, actor, input = {}) {
  const meeting = await loadMeeting(db, input.meetingId);
  try {
    authorize(actor, READ_ROLES, { schoolYearId: meeting.school_year_id, classId: meeting.class_id });
  } catch (error) {
    if (error instanceof MeetingError && error.status === 403) throw new MeetingError('meeting_not_found', 404);
    throw error;
  }
  const [checks, drafts, stale, minutes] = await Promise.all([
    db.query(`${QUORUM_CHECK_SELECT} WHERE c.meeting_id = $1 ORDER BY c.seq`, [meeting.id]),
    countOpenResolutions(db, meeting.id),
    // Bieżące rewizje przyjętych/odrzuconych uchwał wsparte ustaleniem quorum,
    // które nie jest już aktualne (lista obecności zmieniła się po ustaleniu).
    one(db,
      `SELECT count(*)::int AS n
         FROM resolution_current r
         JOIN meeting_quorum_checks c ON c.id = r.quorum_check_id
         LEFT JOIN meeting_attendance_state s ON s.meeting_id = c.meeting_id
        WHERE r.meeting_id = $1 AND r.status IN ('adopted', 'rejected')
          AND NOT (c.attendance_revision IS NOT NULL AND c.attendance_revision = COALESCE(s.revision, 0))`,
      [meeting.id]),
    db.query(
      'SELECT id, version, status FROM meeting_minutes WHERE meeting_id = $1 ORDER BY version DESC LIMIT 1',
      [meeting.id]),
  ]);
  const latestCheck = checks.rows.at(-1);
  const latestMinutes = minutes.rows[0] ?? null;
  const items = [];
  const add = (code, blocking, count = undefined) => items.push({ code, blocking, ...(count === undefined ? {} : { count }) });
  if (meeting.status !== 'held') add('meeting_not_held', true);
  if (drafts > 0) add('open_resolutions', true, drafts);
  if (meeting.quorum_mode === 'not_configured') add('quorum_rule_missing', false);
  else if (!meeting.quorum_rule_source) add('quorum_rule_source_missing', false);
  if (!latestCheck) add('no_quorum_check', false);
  else if (!quorumCheckFromRow(latestCheck).current) add('stale_quorum_check', false);
  if ((stale?.n ?? 0) > 0) add('resolutions_on_stale_check', false, stale.n);
  return {
    meetingId: meeting.id,
    minutesId: latestMinutes?.id ?? null,
    minutesStatus: latestMinutes?.status ?? null,
    ready: !items.some(item => item.blocking),
    items,
  };
}

export async function setMinutesVisibility(db, actor, input = {}) {
  const key = idempotencyKey(input.idempotencyKey);
  const minutes = await loadMinutes(db, input.minutesId, input.meetingId);
  const meeting = await meetingForManage(db, actor, minutes.meeting_id);
  if (!VISIBILITIES.has(input.visibility)) throw new MeetingError('invalid_request');
  // #152: publikacja PUBLICZNA (widok /site/, poza Radą) blokowana twardo przy
  // wykryciu możliwych danych osobowych w treści protokołu — zgodnie z
  // AGENTS.md „widok publiczny wyłącznie zatwierdzone dane”. Widoczność
  // wewnętrzna/dla rodziców („internal”/„parents”) dostaje tylko ostrzeżenie
  // w innych miejscach (#152 zakres tego PR: brak wyjątku z drugim
  // zatwierdzeniem — wariant zachowawczy, patrz opis w PR).
  if (input.visibility === 'public') {
    const knownNames = await loadKnownNames(db, meeting.school_year_id);
    const piiCheck = detectPossiblePersonalData(minutes.body, { knownNames });
    if (piiCheck.categories.length) throw new MeetingError('minutes_contain_personal_data', 409);
  }
  const data = {
    minutesId: minutes.id,
    visibility: input.visibility,
    reason: text(input.reason, 3, 500, { optional: true }),
  };
  // #135: udostępnienie rodzicom lub publicznie wymaga MFA (treść protokołu
  // nie jest automatycznie sprawdzana pod kątem danych osobowych); widoczność
  // wyłącznie wewnętrzna też wymaga MFA, ale już na wejściu (meetingForManage, #150).
  if (data.visibility === 'parents' || data.visibility === 'public') requireMfaVerified(actor);
  const result = await idempotent(db, actor, key, 'meeting.minutes.visibility', data, async tx => {
    const gate = gatePii([['meeting_minutes_publications.reason', data.reason]], input);
    const id = randomUUID();
    await tx.query(
      `INSERT INTO meeting_minutes_publications (id, minutes_id, visibility, reason, created_by)
       VALUES ($1, $2, $3, $4, $5)`, [id, data.minutesId, data.visibility, data.reason, actor.userId]);
    await audit(tx, actor, 'meeting.minutes.visibility_set', 'meeting_minutes', minutes.id,
      { meetingId: minutes.meeting_id, schoolYearId: meeting.school_year_id, visibility: data.visibility, publicationId: id, ...piiAuditMetadata(gate) });
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
  meetingContext(actor);
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

// #102: podpowiedź następnego numeru z resolution_number_pattern roku
// ('{seq}' i '{year}' — rok kalendarzowy początku roku szkolnego). Bez
// ustawionego wzorca (domyślnie, do decyzji D-15) zwraca null: nic nie jest
// narzucane. Tylko podpowiedź — unikalność nadal pilnuje istniejący indeks.
async function suggestResolutionNumber(executor, schoolYearId) {
  const year = await one(executor,
    'SELECT resolution_number_pattern, starts_on FROM school_years WHERE id = $1', [schoolYearId]);
  if (!year?.resolution_number_pattern) return null;
  const { rows } = await executor.query(
    `SELECT count(*)::int AS n FROM resolutions
      WHERE school_year_id = $1 AND corrects_id IS NULL AND number IS NOT NULL`, [schoolYearId]);
  const seq = rows[0].n + 1;
  const yearNumber = new Date(year.starts_on).getUTCFullYear();
  return year.resolution_number_pattern.replace('{seq}', String(seq)).replace('{year}', String(yearNumber));
}

export async function createResolution(db, actor, input = {}) {
  const key = idempotencyKey(input.idempotencyKey);
  const meeting = await meetingForManage(db, actor, input.meetingId);
  const status = input.status ?? 'draft';
  if (!RESOLUTION_STATUSES.has(status)) throw new MeetingError('invalid_request');
  const relationKind = input.amendsResolutionId !== undefined && input.amendsResolutionId !== null
    ? oneOfRelationKind(input.relationKind) : null;
  const data = {
    meetingId: meeting.id,
    number: text(input.number, 3, 64, { optional: true }),
    title: text(input.title, 3, 300),
    body: text(input.body, 3, 20000),
    status,
    ...parseVotes(input),
    quorumCheckId: optionalId(input.quorumCheckId),
    amendsResolutionId: optionalId(input.amendsResolutionId),
    relationKind,
    relationCrossYear: Boolean(input.relationCrossYear),
  };
  if (status === 'adopted' && !data.number) throw new MeetingError('resolution_number_required');
  requireFinalVotes(status, data, data.quorumCheckId);
  // #135: rozstrzygnięcie uchwały (adopted/rejected) wymaga MFA; projekt (draft) nie.
  if (status === 'adopted' || status === 'rejected') requireMfaVerified(actor);
  const suggestedNumber = await suggestResolutionNumber(db, meeting.school_year_id);
  let result;
  try {
    result = await idempotent(db, actor, key, 'resolution.create', data, async tx => {
      const gate = gatePii([['resolutions.body', data.body]], input);
      const id = randomUUID();
      await tx.query(
        `INSERT INTO resolutions (id, school_year_id, meeting_id, number, title, body, status,
           votes_for, votes_against, votes_abstain, quorum_check_id, amends_resolution_id,
           relation_kind, relation_cross_year, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [id, meeting.school_year_id, meeting.id, data.number, data.title, data.body, data.status,
          data.votesFor, data.votesAgainst, data.votesAbstain, data.quorumCheckId,
          data.amendsResolutionId, data.relationKind, data.relationCrossYear, actor.userId]);
      await audit(tx, actor, 'resolution.created', 'resolution', id,
        { meetingId: meeting.id, schoolYearId: meeting.school_year_id, status, ...piiAuditMetadata(gate) });
      return { entityType: 'resolution', entityId: id };
    });
  } catch (error) {
    // #102: kolizja podpowiedzi numeru między dwoma równoległymi projektami —
    // odpowiedź niesie świeżą podpowiedź, żeby drugi sekretarz mógł spróbować dalej.
    if (error instanceof MeetingError && error.code === 'resolution_number_taken') {
      const fresh = await suggestResolutionNumber(db, meeting.school_year_id);
      throw new MeetingError('resolution_number_taken', 409, { suggestedNumber: fresh });
    }
    throw error;
  }
  return {
    resolution: resolutionFromRow(await loadResolution(db, result.entityId)),
    replayed: result.replayed,
    suggestedNumber,
  };
}

// Edits a draft or records its final outcome. Final resolutions are immutable.
//
// #215: read-modify-write happened outside the transaction (stale base for
// fields not present in the request) with no version check, so a parallel
// edit of a different field silently overwrote the first editor's change,
// and a parallel adoption could apply to content already replaced. The row
// is now locked (SELECT ... FOR UPDATE) and merged *inside* the transaction,
// and `input.revision` is REQUIRED (stage 2 of #215): it must match the row's
// current `revision_no` — missing gives `400 invalid_revision`, stale gives
// `409 revision_conflict` instead of silently merging.
export async function updateResolution(db, actor, input = {}) {
  const resolution = await loadResolution(db, input.resolutionId, input.meetingId);
  await meetingForManage(db, actor, resolution.meeting_id);
  const expectedRevision = requiredRevision(input.revision);
  await mutate(db, async tx => {
    const { rows: lockedRows } = await tx.query('SELECT * FROM resolutions WHERE id = $1 FOR UPDATE', [resolution.id]);
    const locked = lockedRows[0];
    if (!locked) throw new MeetingError('resolution_not_found', 404);
    const next = {
      number: input.number !== undefined ? text(input.number, 3, 64, { optional: true }) : locked.number,
      title: input.title !== undefined ? text(input.title, 3, 300) : locked.title,
      body: input.body !== undefined ? text(input.body, 3, 20000) : locked.body,
      status: input.status ?? locked.status,
      votesFor: input.votesFor !== undefined ? integer(input.votesFor, 0, 10000, { optional: true }) : locked.votes_for,
      votesAgainst: input.votesAgainst !== undefined
        ? integer(input.votesAgainst, 0, 10000, { optional: true }) : locked.votes_against,
      votesAbstain: input.votesAbstain !== undefined
        ? integer(input.votesAbstain, 0, 10000, { optional: true }) : locked.votes_abstain,
      quorumCheckId: input.quorumCheckId !== undefined ? optionalId(input.quorumCheckId) : locked.quorum_check_id,
    };
    // Podwójne kliknięcie / powtórzenie tej samej edycji: żądanie opisuje
    // dokładnie stan, w którym wiersz już jest (niezależnie od wersji) —
    // odtworzenie bez błędu i bez drugiego zdarzenia audytu, jak przy
    // wydarzeniach/aktualnościach (events.js/news.js).
    const isNoOp = next.number === locked.number && next.title === locked.title && next.body === locked.body
      && next.status === locked.status && next.votesFor === locked.votes_for
      && next.votesAgainst === locked.votes_against && next.votesAbstain === locked.votes_abstain
      && next.quorumCheckId === locked.quorum_check_id;
    if (isNoOp) return;
    if (locked.revision_no !== expectedRevision) {
      throw new MeetingError('revision_conflict', 409);
    }
    if (locked.status !== 'draft') throw new MeetingError('resolution_final_immutable', 409);
    if (!RESOLUTION_STATUSES.has(next.status)) throw new MeetingError('invalid_request');
    if (next.status === 'adopted' && !next.number) throw new MeetingError('resolution_number_required');
    requireFinalVotes(next.status, next, next.quorumCheckId);
    // #135: rozstrzygnięcie uchwały (adopted/rejected) wymaga MFA; edycja projektu nie.
    if (next.status === 'adopted' || next.status === 'rejected') requireMfaVerified(actor);
    // #152: treść uchwały po zmianie (finalna wersja staje się niezmienna).
    const gate = gatePii([['resolutions.body', next.body !== locked.body ? next.body : null]], input);
    const { rows } = await tx.query(
      `UPDATE resolutions SET number = $2, title = $3, body = $4, status = $5, votes_for = $6,
         votes_against = $7, votes_abstain = $8, quorum_check_id = $9
       WHERE id = $1 AND status = 'draft' RETURNING id, revision_no`,
      [resolution.id, next.number, next.title, next.body, next.status, next.votesFor,
        next.votesAgainst, next.votesAbstain, next.quorumCheckId]);
    if (!rows.length) throw new MeetingError('resolution_final_immutable', 409);
    await audit(tx, actor, 'resolution.updated', 'resolution', resolution.id, {
      meetingId: resolution.meeting_id, schoolYearId: resolution.school_year_id,
      fromStatus: locked.status, toStatus: next.status,
      fromRevision: locked.revision_no, toRevision: rows[0].revision_no, ...piiAuditMetadata(gate),
    });
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
  // #135: korekta zawsze zapisuje rozstrzygnięcie (adopted/rejected) — zawsze wymaga MFA.
  requireMfaVerified(actor);
  const result = await idempotent(db, actor, key, 'resolution.correct', data, async tx => {
    const gate = gatePii([
      ['resolutions.correction_reason', data.reason],
      ['resolutions.body', data.body !== previous.body ? data.body : null],
    ], input);
    const id = randomUUID();
    await tx.query(
      `INSERT INTO resolutions (id, school_year_id, meeting_id, number, revision, corrects_id,
         correction_reason, amends_resolution_id, relation_kind, relation_cross_year, title, body,
         status, votes_for, votes_against, votes_abstain, quorum_check_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [id, previous.school_year_id, previous.meeting_id, previous.number, previous.revision + 1,
        previous.id, data.reason, previous.amends_resolution_id, previous.relation_kind,
        previous.relation_cross_year, data.title, data.body, data.status,
        data.votesFor, data.votesAgainst, data.votesAbstain, data.quorumCheckId, actor.userId]);
    await audit(tx, actor, 'resolution.corrected', 'resolution', id,
      { meetingId: previous.meeting_id, schoolYearId: previous.school_year_id, correctsId: previous.id,
        revision: previous.revision + 1, status, ...piiAuditMetadata(gate) });
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
  // #102: dołącza effective_status, żeby wyszukiwarka pokazała uchylenie/zmianę
  // zamiast milcząco traktować uchwałę jak nadal obowiązującą.
  const row = await one(db,
    `SELECT rc.*, es.effective_status FROM resolution_current rc
       JOIN resolution_effective_status es ON es.id = rc.id
      WHERE rc.school_year_id = $1 AND rc.number = $2 AND rc.status = 'adopted'`, [schoolYearId, number]);
  if (!row) throw new MeetingError('resolution_not_found', 404);
  return { resolution: resolutionFromRow(row) };
}

// ---------- resolution register (#102) ----------

const EXECUTION_STATUSES = new Set(['not_started', 'in_progress', 'done', 'will_not_be_done']);

function oneOfExecutionStatus(value) {
  if (!EXECUTION_STATUSES.has(value)) throw new MeetingError('invalid_execution_status');
  return value;
}

function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
      || Number.isNaN(new Date(`${value}T00:00:00Z`).valueOf())) {
    throw new MeetingError('invalid_request');
  }
  return value;
}

// DATE wraca z pg/PGlite jako Date (północ UTC); zawsze oddajemy zwykły
// 'RRRR-MM-DD', niezależnie od tego, czy zapytanie użyło to_char().
function dateOnlyOut(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 10);
}

const REGISTER_SELECT = `
  SELECT rc.id, rc.number, rc.title, rc.status, rc.revision, rc.votes_for, rc.votes_against,
         rc.votes_abstain, rc.decided_at, rc.meeting_id, rc.amends_resolution_id, rc.relation_kind,
         rc.relation_cross_year, m.class_id, m.scheduled_at AS meeting_scheduled_at, m.title AS meeting_title,
         es.effective_status,
         amender.id AS amended_by_id, amender.number AS amended_by_number,
         repealer.id AS repealed_by_id, repealer.number AS repealed_by_number,
         exec.status AS execution_status, exec.due_on AS execution_due_on,
         exec.responsible_user_id AS execution_responsible_user_id, exec.created_at AS execution_recorded_at
    FROM resolution_current rc
    JOIN meetings m ON m.id = rc.meeting_id
    JOIN resolution_effective_status es ON es.id = rc.id
    LEFT JOIN resolution_current amender
      ON amender.amends_resolution_id = rc.id AND amender.relation_kind = 'amends' AND amender.status = 'adopted'
    LEFT JOIN resolution_current repealer
      ON repealer.amends_resolution_id = rc.id AND repealer.relation_kind = 'repeals' AND repealer.status = 'adopted'
    LEFT JOIN LATERAL (
      SELECT status, due_on, responsible_user_id, created_at FROM resolution_execution_events
       WHERE resolution_id = rc.id ORDER BY created_at DESC LIMIT 1
    ) exec ON true`;

function registerRowToApi(row) {
  return {
    id: row.id,
    number: row.number ?? null,
    title: row.title,
    status: row.status,
    effectiveStatus: row.effective_status,
    revision: row.revision,
    votesFor: row.votes_for ?? null,
    votesAgainst: row.votes_against ?? null,
    votesAbstain: row.votes_abstain ?? null,
    decidedAt: iso(row.decided_at),
    meetingId: row.meeting_id,
    meetingTitle: row.meeting_title,
    meetingScheduledAt: iso(row.meeting_scheduled_at),
    amendsResolutionId: row.amends_resolution_id ?? null,
    relationKind: row.relation_kind ?? null,
    relationCrossYear: Boolean(row.relation_cross_year),
    amendedBy: row.amended_by_id ? { id: row.amended_by_id, number: row.amended_by_number ?? null } : null,
    repealedBy: row.repealed_by_id ? { id: row.repealed_by_id, number: row.repealed_by_number ?? null } : null,
    execution: {
      status: row.execution_status ?? null,
      dueOn: dateOnlyOut(row.execution_due_on),
      responsibleUserId: row.execution_responsible_user_id ?? null,
      recordedAt: iso(row.execution_recorded_at),
    },
  };
}

// Rejestr uchwał roku z filtrami. Dostęp: role odczytu (admin, zarząd, Komisja
// Rewizyjna); przydział klasowy widzi wyłącznie uchwały zebrań tej klasy.
// Uchwała uchylona (`effectiveStatus: 'repealed'`) zostaje w rejestrze — nie
// jest traktowana jako obowiązująca, ale nie znika z historii.
export async function listResolutionRegister(db, actor, input = {}) {
  const schoolYearId = requireId(input.schoolYearId);
  const context = meetingContext(actor);
  if (!hasAnyMatchingGrant(context, { roles: [...READ_ROLES], schoolYearId })) throw new MeetingError('forbidden', 403);
  const status = input.status ? (RESOLUTION_STATUSES.has(input.status) ? input.status
    : (() => { throw new MeetingError('invalid_request'); })()) : null;
  const executionStatus = input.executionStatus
    ? (input.executionStatus === 'none' || EXECUTION_STATUSES.has(input.executionStatus) ? input.executionStatus
      : (() => { throw new MeetingError('invalid_request'); })())
    : null;
  const q = input.q ? text(input.q, 1, 200) : null;
  const { rows } = await db.query(
    `${REGISTER_SELECT}
      WHERE rc.school_year_id = $1
        AND ($2::text IS NULL OR rc.status = $2)
        AND ($3::text IS NULL OR rc.title ILIKE '%' || $3 || '%' OR rc.number ILIKE '%' || $3 || '%')
        AND ($4::text IS NULL
             OR ($4 = 'none' AND exec.status IS NULL)
             OR exec.status = $4)
      ORDER BY m.scheduled_at DESC, rc.number NULLS LAST, rc.id`,
    [schoolYearId, status, q, executionStatus]);
  const visible = rows.filter((row) => {
    try {
      authorize(actor, READ_ROLES, { schoolYearId, classId: row.class_id });
      return true;
    } catch {
      return false;
    }
  });
  return { resolutions: visible.map(registerRowToApi) };
}

function executionEventFromRow(row) {
  return {
    id: row.id,
    resolutionId: row.resolution_id,
    status: row.status,
    responsibleUserId: row.responsible_user_id ?? null,
    dueOn: dateOnlyOut(row.due_on),
    note: row.note ?? null,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
  };
}

// Zapisuje zdarzenie wykonania uchwały (tylko dopisywanie — bieżący stan to
// ostatnie zdarzenie). Dozwolone także po zatwierdzeniu protokołu: tabela nie
// jest objęta blokadą zebrania (meeting_assert_editable dotyczy tylko samej
// uchwały, obecności i protokołu).
export async function recordResolutionExecution(db, actor, input = {}) {
  const key = idempotencyKey(input.idempotencyKey);
  const resolution = await loadResolution(db, input.resolutionId, input.meetingId);
  await meetingForManage(db, actor, resolution.meeting_id);
  if (resolution.status !== 'adopted' && resolution.status !== 'rejected') {
    throw new MeetingError('resolution_not_decided', 409);
  }
  const data = {
    resolutionId: resolution.id,
    status: oneOfExecutionStatus(input.status),
    responsibleUserId: input.responsibleUserId !== undefined ? optionalId(input.responsibleUserId) : null,
    dueOn: input.dueOn !== undefined && input.dueOn !== null ? dateOnly(input.dueOn) : null,
    note: text(input.note, 3, 500, { optional: true }),
  };
  const result = await idempotent(db, actor, key, 'resolution.execution', data, async tx => {
    const gate = gatePii([['resolution_execution_events.note', data.note]], input);
    const id = randomUUID();
    await tx.query(
      `INSERT INTO resolution_execution_events
         (id, resolution_id, status, responsible_user_id, due_on, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, data.resolutionId, data.status, data.responsibleUserId, data.dueOn, data.note, actor.userId]);
    await audit(tx, actor, 'resolution.execution.recorded', 'resolution_execution_event', id,
      { resolutionId: resolution.id, schoolYearId: resolution.school_year_id, status: data.status, ...piiAuditMetadata(gate) });
    return { entityType: 'resolution_execution_event', entityId: id };
  });
  const { rows } = await db.query('SELECT * FROM resolution_execution_events WHERE id = $1', [result.entityId]);
  return { execution: executionEventFromRow(rows[0]), replayed: result.replayed };
}

// ---------- odwołanie, zmiana terminu, zawiadomienie (#113) ----------
//
// Założenia (do decyzji zarządu, opisane w docs/MEETINGS.md): D-08 — zatwierdzenie
// zawiadomienia wymaga innej osoby niż autor (wariant zachowawczy); D-21 — termin
// zawiadomienia jest tylko odnotowywany; D-17 — szkic kampanii korzysta z istniejącej
// migawki odbiorców (jedna wiadomość na rodzinę). NICZEGO tu nie wysyłamy: kampania
// powstaje wyłącznie jako szkic i przechodzi zatwierdzenie treści oraz listy w module
// e-mail (src/pg/routes/email.js).

function activeAgendaSnapshot(rows) {
  return rows
    .filter(row => !row.withdrawn_at)
    .sort((a, b) => a.position - b.position)
    .map(row => ({ position: row.position, title: row.title, description: row.description ?? null }));
}

function agendaHash(snapshot) {
  return createHash('sha256').update(`rd-meeting-agenda-v1\n${JSON.stringify(snapshot)}`).digest('hex');
}

function noticeContentHash({ kind, title, scheduledAt, previousScheduledAt, location, agendaContentHash }) {
  return createHash('sha256').update(JSON.stringify([
    'rd-meeting-notice-v1', kind, title, iso(scheduledAt), iso(previousScheduledAt), location ?? null,
    agendaContentHash ?? null,
  ])).digest('hex');
}

function noticeOutdated(notice, meeting, currentAgendaHash, agendaVersion) {
  return notice.title !== meeting.title
    || iso(notice.scheduled_at) !== iso(meeting.scheduled_at)
    || (notice.location ?? null) !== (meeting.location ?? null)
    || (agendaVersion ? agendaVersion.content_hash !== currentAgendaHash : false);
}

async function hasApprovedNotice(db, meetingId) {
  return Boolean(await one(db,
    "SELECT 1 FROM meeting_notices WHERE meeting_id = $1 AND status = 'approved' LIMIT 1", [meetingId]));
}

async function lockMeeting(tx, meetingId) {
  const row = await one(tx, 'SELECT * FROM meetings WHERE id = $1 FOR UPDATE', [meetingId]);
  if (!row) throw new MeetingError('meeting_not_found', 404);
  return row;
}

// Migawka porządku obrad (bez wycofanych punktów). Ta sama treść = ta sama wersja.
async function ensureAgendaVersion(tx, actor, meeting) {
  const { rows } = await tx.query('SELECT * FROM meeting_agenda_items WHERE meeting_id = $1', [meeting.id]);
  const snapshot = activeAgendaSnapshot(rows);
  const hash = agendaHash(snapshot);
  const latest = await one(tx,
    'SELECT * FROM meeting_agenda_versions WHERE meeting_id = $1 ORDER BY version DESC LIMIT 1', [meeting.id]);
  if (latest && latest.content_hash === hash) return latest;
  const id = randomUUID();
  const version = (latest?.version ?? 0) + 1;
  const created = await one(tx,
    `INSERT INTO meeting_agenda_versions (id, meeting_id, school_year_id, version, snapshot, content_hash, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING *`,
    [id, meeting.id, meeting.school_year_id, version, JSON.stringify(snapshot), hash, actor.userId]);
  await audit(tx, actor, 'meeting.agenda_version.created', 'meeting_agenda_version', id,
    { meetingId: meeting.id, schoolYearId: meeting.school_year_id, version, contentHash: hash });
  return created;
}

// Szkic zawiadomienia (kolejna wersja). Identyczny szkic (ten sam skrót treści) jest
// powtórką, nie drugą wersją. `meeting` musi być zablokowany (FOR UPDATE).
async function createNoticeDraft(tx, actor, meeting, kind, { previousScheduledAt = null, requireAgenda = false } = {}) {
  let agendaVersion = null;
  if (kind !== 'cancellation') {
    agendaVersion = await ensureAgendaVersion(tx, actor, meeting);
    if (requireAgenda && !agendaVersion.snapshot.length) throw new MeetingError('notice_requires_agenda', 409);
  }
  const hash = noticeContentHash({
    kind, title: meeting.title, scheduledAt: meeting.scheduled_at, previousScheduledAt,
    location: meeting.location, agendaContentHash: agendaVersion?.content_hash ?? null,
  });
  const latest = await one(tx,
    'SELECT * FROM meeting_notices WHERE meeting_id = $1 ORDER BY version DESC LIMIT 1', [meeting.id]);
  if (latest && latest.status === 'draft' && latest.content_hash === hash) return { row: latest, replayed: true };
  const id = randomUUID();
  const version = (latest?.version ?? 0) + 1;
  const row = await one(tx,
    `INSERT INTO meeting_notices (id, meeting_id, school_year_id, version, kind, title, scheduled_at,
       previous_scheduled_at, location, agenda_version_id, content_hash, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [id, meeting.id, meeting.school_year_id, version, kind, meeting.title, meeting.scheduled_at,
      previousScheduledAt, meeting.location, agendaVersion?.id ?? null, hash, actor.userId]);
  await audit(tx, actor, 'meeting.notice.created', 'meeting_notice', id,
    { meetingId: meeting.id, schoolYearId: meeting.school_year_id, version, kind, contentHash: hash });
  return { row, replayed: false };
}

function requireReason(value) {
  try {
    return text(value, 3, 500);
  } catch {
    throw new MeetingError('invalid_reason');
  }
}

// Odwołanie: draft|scheduled -> cancelled, z powodem (3-500 znaków, wewnętrzny).
// Stan zamyka zebranie (obecność, quorum, protokół, uchwały: 409 meeting_cancelled).
// Ponowienie (podwójne kliknięcie) z tym samym powodem jest powtórką bez nowego
// zdarzenia. Jeśli zawiadomienie było zatwierdzone, powstaje SZKIC zawiadomienia
// o odwołaniu — wysyłka wymaga osobnego zatwierdzenia w module kampanii.
export async function cancelMeeting(db, actor, input = {}) {
  const meeting = await meetingForManage(db, actor, input.meetingId);
  const reason = requireReason(input.reason);
  // #152: powód odwołania trafia do niezmiennej historii — bramka danych osobowych.
  const gate = gatePii([['meetings.cancellation_reason', reason]], input);
  const expectedRevision = requiredRevision(input.revision);
  const result = await mutate(db, async tx => {
    const locked = await lockMeeting(tx, meeting.id);
    if (locked.status === 'cancelled') {
      if (locked.cancellation_reason === reason) return { replayed: true, notice: null };
      throw new MeetingError('meeting_cancelled', 409);
    }
    if (locked.status !== 'draft' && locked.status !== 'scheduled') {
      throw new MeetingError('meeting_status_transition_invalid', 409);
    }
    if (locked.revision_no !== expectedRevision) throw new MeetingError('revision_conflict', 409);
    const hadApprovedNotice = await hasApprovedNotice(tx, meeting.id);
    await tx.query(
      `UPDATE meetings SET status = 'cancelled', cancellation_reason = $2, cancelled_by = $3, cancelled_at = now()
        WHERE id = $1`, [meeting.id, reason, actor.userId]);
    await audit(tx, actor, 'meeting.cancelled', 'meeting', meeting.id, {
      schoolYearId: meeting.school_year_id, fromStatus: locked.status,
      scheduledAt: iso(locked.scheduled_at), hadApprovedNotice, ...piiAuditMetadata(gate),
    });
    let notice = null;
    if (hadApprovedNotice) {
      const cancelled = await lockMeeting(tx, meeting.id);
      notice = (await createNoticeDraft(tx, actor, cancelled, 'cancellation')).row;
    }
    return { replayed: false, notice };
  });
  return {
    meeting: meetingFromRow(await loadMeeting(db, meeting.id)),
    cancellationNotice: result.notice ? noticeFromRow(result.notice, { isLatest: true }) : null,
    replayed: result.replayed,
  };
}

// Zmiana terminu z powodem: wpis w meeting_reschedules (stara i nowa data, aktor, powód)
// + zdarzenie meeting.rescheduled. Po zatwierdzonym zawiadomieniu powstaje SZKIC
// zawiadomienia o zmianie terminu (nic nie jest wysyłane).
export async function rescheduleMeeting(db, actor, input = {}) {
  const meeting = await meetingForManage(db, actor, input.meetingId);
  const scheduledAt = timestamp(input.scheduledAt);
  const reason = requireReason(input.reason);
  // #152: powód zmiany terminu trafia do niezmiennej historii — bramka danych osobowych.
  const gate = gatePii([['meeting_reschedules.reason', reason]], input);
  const expectedRevision = requiredRevision(input.revision);
  const result = await mutate(db, async tx => {
    const locked = await lockMeeting(tx, meeting.id);
    if (locked.status === 'cancelled') throw new MeetingError('meeting_cancelled', 409);
    if (locked.status !== 'draft' && locked.status !== 'scheduled') {
      throw new MeetingError('meeting_not_reschedulable', 409);
    }
    const same = new Date(locked.scheduled_at).getTime() === new Date(scheduledAt).getTime();
    const previous = await one(tx,
      'SELECT * FROM meeting_reschedules WHERE meeting_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
      [meeting.id]);
    if (same) {
      // Podwójne kliknięcie / ponowienie: ten sam termin i powód co ostatnia zmiana.
      if (previous && previous.reason === reason
          && new Date(previous.to_scheduled_at).getTime() === new Date(scheduledAt).getTime()) {
        return { replayed: true, notice: null };
      }
      throw new MeetingError('reschedule_no_change', 409);
    }
    if (locked.revision_no !== expectedRevision) throw new MeetingError('revision_conflict', 409);
    const rescheduleId = randomUUID();
    await tx.query(
      `INSERT INTO meeting_reschedules (id, meeting_id, school_year_id, from_scheduled_at, to_scheduled_at, reason, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [rescheduleId, meeting.id, meeting.school_year_id, locked.scheduled_at, scheduledAt, reason, actor.userId]);
    const hadApprovedNotice = await hasApprovedNotice(tx, meeting.id);
    await tx.query('UPDATE meetings SET scheduled_at = $2 WHERE id = $1', [meeting.id, scheduledAt]);
    await audit(tx, actor, 'meeting.rescheduled', 'meeting', meeting.id, {
      schoolYearId: meeting.school_year_id, fromScheduledAt: iso(locked.scheduled_at),
      toScheduledAt: iso(scheduledAt), rescheduleId, hadApprovedNotice, ...piiAuditMetadata(gate),
    });
    let notice = null;
    if (hadApprovedNotice) {
      const moved = await lockMeeting(tx, meeting.id);
      notice = (await createNoticeDraft(tx, actor, moved, 'reschedule',
        { previousScheduledAt: locked.scheduled_at })).row;
    }
    return { replayed: false, notice };
  });
  return {
    meeting: meetingFromRow(await loadMeeting(db, meeting.id)),
    rescheduleNotice: result.notice ? noticeFromRow(result.notice, { isLatest: true }) : null,
    replayed: result.replayed,
  };
}

// Wycofanie punktu porządku obrad (wiersz zostaje, punkt znika z nowych migawek).
export async function withdrawAgendaItem(db, actor, input = {}, env) {
  const { meeting } = await meetingForManageOrClassHost(db, actor, input.meetingId, env);
  const itemId = requireId(input.itemId, 'invalid_agenda_item_id');
  const row = await mutate(db, async tx => {
    await lockMeeting(tx, meeting.id);
    const item = await one(tx, 'SELECT * FROM meeting_agenda_items WHERE id = $1 AND meeting_id = $2 FOR UPDATE',
      [itemId, meeting.id]);
    if (!item) throw new MeetingError('agenda_item_not_found', 404);
    if (item.withdrawn_at) return { item, replayed: true };
    const updated = await one(tx,
      'UPDATE meeting_agenda_items SET withdrawn_at = now(), withdrawn_by = $2 WHERE id = $1 RETURNING *',
      [itemId, actor.userId]);
    await audit(tx, actor, 'meeting.agenda_item.withdrawn', 'meeting_agenda_item', itemId,
      { meetingId: meeting.id, schoolYearId: meeting.school_year_id });
    return { item: updated, replayed: false };
  });
  return { agendaItem: agendaItemFromRow(row.item), replayed: row.replayed };
}

// #113: zmiana kolejności punktów porządku obrad. `itemIds` to DOKŁADNIE wszystkie
// niewycofane punkty w nowej kolejności. Punkty zajmują te same numery pozycji co
// dotąd (rosnąco), tylko w nowej kolejności; punkty wycofane zachowują swoje numery.
// Zatwierdzone zawiadomienie przestaje odpowiadać porządkowi (skrót migawki), więc
// potrzebna jest nowa wersja zawiadomienia — nic nie jest wysyłane ani zatwierdzane.
// Ta sama kolejność co obecna (np. podwójne kliknięcie) to powtórka bez zdarzenia.
export async function reorderAgendaItems(db, actor, input = {}, env) {
  const { meeting } = await meetingForManageOrClassHost(db, actor, input.meetingId, env);
  const itemIds = input.itemIds;
  if (!Array.isArray(itemIds) || itemIds.length < 1 || itemIds.length > 200) {
    throw new MeetingError('invalid_agenda_order');
  }
  for (const id of itemIds) requireId(id, 'invalid_agenda_order');
  if (new Set(itemIds).size !== itemIds.length) throw new MeetingError('invalid_agenda_order');
  const result = await mutate(db, async tx => {
    const locked = await lockMeeting(tx, meeting.id);
    if (locked.status === 'cancelled') throw new MeetingError('meeting_cancelled', 409);
    const { rows } = await tx.query(
      'SELECT * FROM meeting_agenda_items WHERE meeting_id = $1 ORDER BY position FOR UPDATE', [meeting.id]);
    const active = rows.filter(row => !row.withdrawn_at);
    const activeIds = new Set(active.map(row => row.id));
    if (itemIds.length !== active.length || itemIds.some(id => !activeIds.has(id))) {
      throw new MeetingError('invalid_agenda_order');
    }
    const target = new Map(itemIds.map((id, index) => [id, active[index].position]));
    if (active.every(row => target.get(row.id) === row.position)) return { replayed: true };
    // UNIQUE (meeting_id, position) jest sprawdzane przy każdym wierszu, więc punkt
    // przechodzi na pozycję docelową dopiero, gdy ta jest wolna; cykl (np. zamiana
    // dwóch punktów) przerywa przeniesienie jednego punktu na wolną pozycję.
    const current = new Map(rows.map(row => [row.id, row.position]));
    const occupied = new Set(rows.map(row => row.position));
    const move = async (id, position) => {
      await tx.query('UPDATE meeting_agenda_items SET position = $2 WHERE id = $1', [id, position]);
      occupied.delete(current.get(id));
      occupied.add(position);
      current.set(id, position);
    };
    let pending = itemIds.filter(id => current.get(id) !== target.get(id));
    while (pending.length) {
      let progressed = false;
      for (const id of pending) {
        if (!occupied.has(target.get(id))) {
          await move(id, target.get(id));
          progressed = true;
        }
      }
      pending = pending.filter(id => current.get(id) !== target.get(id));
      if (pending.length && !progressed) {
        let free = null;
        for (let position = 200; position >= 1 && free === null; position -= 1) {
          if (!occupied.has(position)) free = position;
        }
        if (free === null) throw new MeetingError('agenda_position_taken', 409);
        await move(pending[0], free);
      }
    }
    await audit(tx, actor, 'meeting.agenda.reordered', 'meeting', meeting.id, {
      schoolYearId: meeting.school_year_id,
      previousItemIds: active.map(row => row.id),
      itemIds,
    });
    return { replayed: false };
  });
  const { rows } = await db.query('SELECT * FROM meeting_agenda_items WHERE meeting_id = $1 ORDER BY position', [meeting.id]);
  return { agenda: rows.map(agendaItemFromRow), replayed: result.replayed };
}

// Szkic zawiadomienia (nowa wersja porządku obrad + treść). Bez zatwierdzenia nie jest
// widoczne poza panelem zarządzania i nie tworzy kampanii.
export async function createMeetingNotice(db, actor, input = {}) {
  const meeting = await meetingForManage(db, actor, input.meetingId);
  const result = await mutate(db, async tx => {
    const locked = await lockMeeting(tx, meeting.id);
    if (locked.status === 'cancelled') throw new MeetingError('meeting_cancelled', 409);
    if (locked.status !== 'draft' && locked.status !== 'scheduled') {
      throw new MeetingError('meeting_notice_closed', 409);
    }
    const approved = await one(tx,
      `SELECT n.*, v.content_hash AS agenda_hash FROM meeting_notices n
         LEFT JOIN meeting_agenda_versions v ON v.id = n.agenda_version_id
        WHERE n.meeting_id = $1 AND n.status = 'approved' ORDER BY n.version DESC LIMIT 1`, [meeting.id]);
    if (approved) {
      const { rows } = await tx.query('SELECT * FROM meeting_agenda_items WHERE meeting_id = $1', [meeting.id]);
      const stale = noticeOutdated(approved, locked, agendaHash(activeAgendaSnapshot(rows)),
        approved.agenda_version_id ? { content_hash: approved.agenda_hash } : null);
      if (!stale) throw new MeetingError('notice_up_to_date', 409);
    }
    return createNoticeDraft(tx, actor, locked, approved ? 'update' : 'invitation', { requireAgenda: true });
  });
  return { notice: noticeFromRow(result.row, { isLatest: true }), replayed: result.replayed };
}

async function loadNotice(tx, meetingId, noticeId, { lock = false } = {}) {
  const row = await one(tx,
    `SELECT * FROM meeting_notices WHERE id = $1 AND meeting_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
    [requireId(noticeId, 'invalid_notice_id'), meetingId]);
  if (!row) throw new MeetingError('notice_not_found', 404);
  return row;
}

// Sprawdzenie, że zawiadomienie jest najnowsze i zgodne z aktualnym zebraniem.
async function assertNoticeCurrent(tx, notice, meeting) {
  const newer = await one(tx,
    'SELECT 1 FROM meeting_notices WHERE meeting_id = $1 AND version > $2 LIMIT 1', [meeting.id, notice.version]);
  if (newer) throw new MeetingError('notice_not_latest', 409);
  if (notice.kind === 'cancellation') {
    if (meeting.status !== 'cancelled') throw new MeetingError('invalid_request');
    return;
  }
  if (meeting.status !== 'scheduled') throw new MeetingError('meeting_not_scheduled', 409);
  const version = notice.agenda_version_id
    ? await one(tx, 'SELECT * FROM meeting_agenda_versions WHERE id = $1', [notice.agenda_version_id]) : null;
  if (!version || !version.snapshot.length) throw new MeetingError('notice_requires_agenda', 409);
  const { rows } = await tx.query('SELECT * FROM meeting_agenda_items WHERE meeting_id = $1', [meeting.id]);
  if (noticeOutdated(notice, meeting, agendaHash(activeAgendaSnapshot(rows)), version)) {
    throw new MeetingError('notice_outdated', 409);
  }
}

// Zatwierdzenie treści zawiadomienia (widoczność w panelu jako zatwierdzone i na stronie
// publicznej dla zebrań ogólnych). Zatwierdza inna osoba niż autor; MFA — jak każde
// zarządzanie zebraniem (meetingForManage). Nie wysyła niczego.
export async function approveMeetingNotice(db, actor, input = {}) {
  const meeting = await meetingForManage(db, actor, input.meetingId);
  const result = await mutate(db, async tx => {
    const locked = await lockMeeting(tx, meeting.id);
    const notice = await loadNotice(tx, meeting.id, input.noticeId, { lock: true });
    if (notice.status === 'approved') return { row: notice, replayed: true };
    if (notice.created_by === actor.userId) throw new MeetingError('notice_four_eyes_required', 403);
    await assertNoticeCurrent(tx, notice, locked);
    const row = await one(tx,
      `UPDATE meeting_notices
          SET status = 'approved', approved_by = $2, approved_at = now(),
              notice_days_before = floor(extract(epoch FROM (scheduled_at - now())) / 86400)::int,
              notice_late = CASE WHEN kind = 'cancellation' OR $3::int IS NULL THEN NULL
                ELSE floor(extract(epoch FROM (scheduled_at - now())) / 86400) < $3::int END
        WHERE id = $1 RETURNING *`, [notice.id, actor.userId, locked.notice_min_days]);
    await audit(tx, actor, 'meeting.notice.approved', 'meeting_notice', notice.id, {
      meetingId: meeting.id, schoolYearId: meeting.school_year_id, version: notice.version,
      kind: notice.kind, contentHash: notice.content_hash,
      noticeDaysBefore: row.notice_days_before, noticeLate: row.notice_late,
    });
    return { row, replayed: false };
  });
  return { notice: noticeFromRow(result.row, { isLatest: true }), replayed: result.replayed };
}

const NOTICE_KIND_LABELS = {
  invitation: 'Zawiadomienie o zebraniu',
  update: 'Zaktualizowane zawiadomienie o zebraniu',
  reschedule: 'Zmiana terminu zebrania',
  cancellation: 'Odwołanie zebrania',
};

function brusselsDateTime(value) {
  return new Intl.DateTimeFormat('pl-PL', {
    timeZone: 'Europe/Brussels', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
}

function noticeEmailContent(notice, agenda) {
  const lines = [`${NOTICE_KIND_LABELS[notice.kind]}: ${notice.title}`, ''];
  if (notice.kind === 'cancellation') {
    lines.push(`Zebranie zaplanowane na ${brusselsDateTime(notice.scheduled_at)} (czas brukselski) zostało odwołane.`);
  } else {
    if (notice.kind === 'reschedule') {
      lines.push(`Dotychczasowy termin: ${brusselsDateTime(notice.previous_scheduled_at)} (czas brukselski).`);
    }
    lines.push(`Termin: ${brusselsDateTime(notice.scheduled_at)} (czas brukselski).`);
    if (notice.location) lines.push(`Miejsce: ${notice.location}.`);
    lines.push('', 'Porządek obrad:');
    for (const item of agenda) lines.push(`${item.position}. ${item.title}`);
  }
  return {
    subject: `${NOTICE_KIND_LABELS[notice.kind]} — ${brusselsDateTime(notice.scheduled_at)}`,
    bodyText: lines.join('\n'),
  };
}

// Szkic kampanii e-mail z zatwierdzonego zawiadomienia. WYŁĄCZNIE szkic: brak migawki
// odbiorców, brak zatwierdzenia i brak kolejki — treść i listę zatwierdza osoba w
// module kampanii (cztery oczy, dzienny limit, idempotentny klucz kampania + rodzina).
// Zebranie ogólne -> wszystkie rodziny roku; klasowe -> rodziny dzieci tej klasy;
// zebranie zarządu (konta użytkowników) nie ma jeszcze kampanii (poza zakresem).
export async function createNoticeCampaignDraft(db, actor, input = {}) {
  const meeting = await meetingForManage(db, actor, input.meetingId);
  const result = await mutate(db, async tx => {
    const locked = await lockMeeting(tx, meeting.id);
    const notice = await loadNotice(tx, meeting.id, input.noticeId, { lock: true });
    const existing = await one(tx,
      'SELECT id, status, audience, class_id FROM email_campaigns WHERE meeting_notice_id = $1', [notice.id]);
    if (existing) return { campaign: existing, replayed: true };
    if (notice.status !== 'approved') throw new MeetingError('notice_not_approved', 409);
    if (locked.kind === 'board') throw new MeetingError('notice_campaign_audience_unsupported', 409);
    await assertNoticeCurrent(tx, notice, locked);
    const agendaVersion = notice.agenda_version_id
      ? await one(tx, 'SELECT * FROM meeting_agenda_versions WHERE id = $1', [notice.agenda_version_id]) : null;
    const audience = locked.kind === 'class' ? 'class_households' : 'all_households';
    const { subject, bodyText } = noticeEmailContent(notice, agendaVersion?.snapshot ?? []);
    let content;
    try {
      content = parseCampaignContent({
        title: `Zawiadomienie o zebraniu (wersja ${notice.version}): ${notice.title}`.slice(0, 200),
        subject, bodyText, audience: 'all_households', category: 'organizational',
      });
    } catch (error) {
      if (error instanceof ContentError) throw new MeetingError('invalid_notice_content', 409, { field: error.code });
      throw error;
    }
    const hash = emailContentHash({ schoolYearId: locked.school_year_id, ...content, audience });
    const id = randomUUID();
    await tx.query(
      `INSERT INTO email_campaigns (id, school_year_id, title, audience, category, subject, body_text, content_hash,
         created_by, updated_by, idempotency_key, meeting_id, meeting_notice_id, class_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11, $12, $13)`,
      [id, locked.school_year_id, content.title, audience, content.category, content.subject, content.bodyText,
        hash, actor.userId, `meeting-notice-${notice.id}`, meeting.id, notice.id,
        audience === 'class_households' ? locked.class_id : null]);
    await insertAuditEvent(tx, {
      actorId: actor.userId, action: 'email.campaign.created', entityType: 'email_campaign', entityId: id,
      metadata: { schoolYearId: locked.school_year_id, audience, category: content.category, contentHash: hash,
        meetingId: meeting.id, meetingNoticeId: notice.id },
    });
    await audit(tx, actor, 'meeting.notice.campaign_drafted', 'meeting_notice', notice.id,
      { meetingId: meeting.id, schoolYearId: locked.school_year_id, version: notice.version, campaignId: id });
    return { campaign: { id, status: 'draft', audience, class_id: audience === 'class_households' ? locked.class_id : null },
      replayed: false };
  });
  return {
    campaign: {
      id: result.campaign.id, status: result.campaign.status, audience: result.campaign.audience,
      classId: result.campaign.class_id ?? null,
    },
    // Przypomnienie dla interfejsu: nic nie zostało wysłane ani zakolejkowane.
    sent: false,
    replayed: result.replayed,
  };
}

// #113: plik kalendarza (RFC 5545) NAJNOWSZEGO zatwierdzonego zawiadomienia. Tylko
// odczyt, bez zdarzenia w dzienniku; dostęp jak GET zebrania (brak dostępu = 404).
// Treść wyłącznie z migawki zawiadomienia: tytuł, termin, miejsce i tytuły punktów
// porządku (bez opisów, powodów odwołania i danych osób). METHOD:PUBLISH, a nie
// REQUEST/CANCEL: iTIP (RFC 5546) wymaga pola ORGANIZER z adresem nadawcy, a adres
// nadawcy to decyzja D-17 — do tego czasu plik nie udaje zaproszenia. Odwołanie to
// STATUS:CANCELLED; UID jest stały dla zebrania, a SEQUENCE = wersja zawiadomienia,
// więc import nowszego pliku aktualizuje wpis w kalendarzu zamiast go dublować.
// Nic nie jest wysyłane; dołączenie pliku do wiadomości e-mail to osobny krok.
export async function getMeetingNoticeCalendar(db, actor, input = {}, env) {
  const { meeting } = await meetingForRead(db, actor, input.meetingId, env);
  const notice = await loadNotice(db, meeting.id, input.noticeId);
  const newerApproved = await one(db,
    "SELECT 1 FROM meeting_notices WHERE meeting_id = $1 AND status = 'approved' AND version > $2 LIMIT 1",
    [meeting.id, notice.version]);
  if (notice.status !== 'approved' || newerApproved) throw new MeetingError('notice_calendar_unavailable', 409);
  const agendaVersion = notice.agenda_version_id
    ? await one(db, 'SELECT snapshot FROM meeting_agenda_versions WHERE id = $1', [notice.agenda_version_id]) : null;
  const cancelled = notice.kind === 'cancellation';
  const description = [NOTICE_KIND_LABELS[notice.kind]];
  if (!cancelled) {
    const agenda = agendaVersion?.snapshot ?? [];
    if (agenda.length) description.push('', 'Porządek obrad:', ...agenda.map(item => `${item.position}. ${item.title}`));
  }
  const content = buildCalendar([{
    id: meeting.id,
    title: notice.title,
    description: description.join('\n'),
    location: notice.location,
    startsAtUtc: notice.scheduled_at,
    status: cancelled ? 'cancelled' : 'scheduled',
    sequence: notice.version,
    dtstamp: notice.approved_at,
  }], { calName: notice.title, uidDomain: icalUidDomain(env), uidPrefix: 'meeting' });
  return { content, filename: `zebranie-${meeting.id}-v${notice.version}.ics` };
}

// Publiczne: wyłącznie zatwierdzone zawiadomienia zebrań ogólnych (widok public_meeting_notices).
export async function listPublicMeetingNotices(db, input = {}) {
  const schoolYearId = requireId(input.schoolYearId);
  const { rows } = await db.query(
    'SELECT * FROM public_meeting_notices WHERE school_year_id = $1 ORDER BY scheduled_at, id LIMIT 200', [schoolYearId]);
  return {
    notices: rows.map(row => ({
      id: row.id,
      kind: row.kind,
      cancelled: row.kind === 'cancellation',
      title: row.title,
      scheduledAt: iso(row.scheduled_at),
      previousScheduledAt: iso(row.previous_scheduled_at),
      location: row.location ?? null,
      agenda: row.kind === 'cancellation' ? []
        : (row.agenda_snapshot ?? []).map(item => ({ position: item.position, title: item.title })),
      approvedAt: iso(row.approved_at),
    })),
  };
}

// ---------- HTTP ----------

const readJson = createJsonReader({
  maxBytes: MAX_BODY_BYTES,
  declaredLength: true,
  error: (code, status) => new MeetingError(code, status),
});

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
  if (n === 1 && a === 'public-notices') {
    return method === 'GET' ? { name: 'publicNotices' } : { name: 'method', allowed: ['GET'] };
  }
  if (n === 2 && a === 'resolutions' && b === 'lookup') {
    return method === 'GET' ? { name: 'lookup' } : { name: 'method', allowed: ['GET'] };
  }
  // #102: rejestr uchwał roku i śledzenie wykonania — nie zebranie, więc
  // rozpoznawane przed traktowaniem `a` jako meetingId poniżej.
  if (n === 1 && a === 'resolutions') return method === 'GET' ? { name: 'resolutionRegister' } : { name: 'method', allowed: ['GET'] };
  if (n === 3 && a === 'resolutions' && c === 'execution') {
    return method === 'POST' ? { name: 'resolutionExecution', resolutionId: b, create: true } : { name: 'method', allowed: ['POST'] };
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
  if (n === 2 && b === 'approval-checklist') {
    return method === 'GET' ? { name: 'approvalChecklist', meetingId } : { name: 'method', allowed: ['GET'] };
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
  // #113: odwołanie, zmiana terminu, wycofanie punktu i zawiadomienia. Stanowe (bez
  // Idempotency-Key): ponowienie tej samej operacji zwraca powtórkę.
  if (n === 2 && b === 'cancellation') {
    return post ? { name: 'cancel', meetingId } : { name: 'method', allowed: ['POST'] };
  }
  if (n === 2 && b === 'reschedule') {
    return post ? { name: 'reschedule', meetingId } : { name: 'method', allowed: ['POST'] };
  }
  if (n === 4 && b === 'agenda-items' && d === 'withdrawal') {
    return post ? { name: 'agendaWithdraw', meetingId, itemId: c } : { name: 'method', allowed: ['POST'] };
  }
  if (n === 2 && b === 'notices') {
    return post ? { name: 'noticeCreate', meetingId, created: true } : { name: 'method', allowed: ['POST'] };
  }
  if (n === 4 && b === 'notices' && d === 'approval') {
    return post ? { name: 'noticeApprove', meetingId, noticeId: c } : { name: 'method', allowed: ['POST'] };
  }
  if (n === 4 && b === 'notices' && d === 'calendar') {
    return method === 'GET' ? { name: 'noticeCalendar', meetingId, noticeId: c } : { name: 'method', allowed: ['GET'] };
  }
  if (n === 2 && b === 'agenda-order') {
    return post ? { name: 'agendaReorder', meetingId } : { name: 'method', allowed: ['POST'] };
  }
  if (n === 4 && b === 'notices' && d === 'campaign-draft') {
    return post ? { name: 'noticeCampaign', meetingId, noticeId: c, created: true }
      : { name: 'method', allowed: ['POST'] };
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
    if (target.name === 'publicNotices') {
      return json(await listPublicMeetingNotices(db, { schoolYearId: query.get('schoolYearId') }));
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
      if (target.name === 'resolutionRegister') {
        return json(await listResolutionRegister(db, actor, {
          schoolYearId: query.get('schoolYearId'), status: query.get('status') || undefined,
          q: query.get('q') || undefined, executionStatus: query.get('executionStatus') || undefined,
        }));
      }
      if (target.name === 'approvalChecklist') {
        return json(await getApprovalChecklist(db, actor, { meetingId: target.meetingId }));
      }
      if (target.name === 'noticeCalendar') {
        const { content, filename } = await getMeetingNoticeCalendar(db, actor,
          { meetingId: target.meetingId, noticeId: target.noticeId }, env);
        return new Response(content, {
          status: 200,
          headers: {
            'Content-Type': 'text/calendar; charset=utf-8',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Cache-Control': 'private, no-store',
          },
        });
      }
      return json(await getMeeting(db, actor, { meetingId: target.meetingId }, env));
    }

    const body = await readJson(request);
    const input = { ...body, meetingId: target.meetingId, minutesId: target.minutesId,
      resolutionId: target.resolutionId, itemId: target.itemId, noticeId: target.noticeId };
    if (target.create) input.idempotencyKey = request.headers.get('Idempotency-Key')?.trim();

    const handlers = {
      create: () => createMeeting(db, actor, input, env),
      update: () => updateMeeting(db, actor, input, env),
      agenda: () => addAgendaItem(db, actor, input, env),
      attendance: () => recordAttendance(db, actor, input, env),
      quorum: () => determineQuorum(db, actor, input),
      minutes: () => createMinutesVersion(db, actor, input, env),
      approve: () => approveMinutes(db, actor, input),
      visibility: () => setMinutesVisibility(db, actor, input),
      resolution: () => createResolution(db, actor, input),
      resolutionUpdate: () => updateResolution(db, actor, input),
      resolutionCorrect: () => correctResolution(db, actor, input),
      resolutionExecution: () => recordResolutionExecution(db, actor, input),
      cancel: () => cancelMeeting(db, actor, input),
      reschedule: () => rescheduleMeeting(db, actor, input),
      agendaWithdraw: () => withdrawAgendaItem(db, actor, input, env),
      agendaReorder: () => reorderAgendaItems(db, actor, input, env),
      noticeCreate: () => createMeetingNotice(db, actor, input),
      noticeApprove: () => approveMeetingNotice(db, actor, input),
      noticeCampaign: () => createNoticeCampaignDraft(db, actor, input),
    };
    const { replayed, ...result } = await handlers[target.name]();
    // Operacje stanowe (bez Idempotency-Key): 201 przy pierwszym utworzeniu, 200 przy powtórce.
    if (target.created) {
      return json(result, replayed ? 200 : 201, { 'Idempotency-Replayed': replayed ? 'true' : 'false' });
    }
    if (replayed !== undefined && !target.create) return json({ ...result, replayed });
    if (!target.create) return json(result);
    return json(result, replayed ? 200 : 201, { 'Idempotency-Replayed': replayed ? 'true' : 'false' });
  } catch (error) {
    if (error instanceof MeetingError) {
      return json({ error: error.code, ...(error.details ?? {}) }, error.status);
    }
    throw error;
  }
}
