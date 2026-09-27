// Kampanie e-mail o dobrowolnej składce na PostgreSQL (issues #10, #40). Prototyp — nie jest wdrożony.
//
//   GET  /api/email/campaigns?schoolYearId=…         lista kampanii roku
//   POST /api/email/campaigns                        szkic (Idempotency-Key)
//   GET  /api/email/campaigns/{id}                   stan i liczniki kolejki
//   PUT  /api/email/campaigns/{id}                   zmiana treści → szkic, zatwierdzenie traci ważność
//   POST /api/email/campaigns/{id}/snapshot          migawka odbiorców → szkic
//   GET  /api/email/campaigns/{id}/preview           podgląd: próbka, liczby, wykluczenia, plan dni (bez wysyłki)
//   GET  /api/email/campaigns/{id}/recipients        lista odbiorców do weryfikacji (dziennik odczytu)
//   POST /api/email/campaigns/{id}/approve           zarząd + MFA, inna osoba niż autor; dokładne skróty
//   POST /api/email/campaigns/{id}/queue             zakolejkowanie zatwierdzonej kampanii
//   POST /api/email/campaigns/{id}/cancel            anulowanie (wiersze w kolejce → cancelled)
//   POST /api/email/webhooks/brevo                   webhook Brevo, wspólny sekret (bez Origin)
//
// Żadna trasa nie wysyła poczty. Wysyła wyłącznie zadanie scripts/email-worker.js.
// Role (założenie do D-08/D-16/D-17): szkic i lista — board/treasurer z MFA,
// zatwierdzenie — wyłącznie board z MFA. Rola admin (techniczna) nie ma dostępu.

import { timingSafeEqual } from 'node:crypto';
import { isSameOrigin } from '../../auth.js';
import { isAuthorized, loadAuthorizationContext } from '../authorization.js';
import { insertAuditEvent } from '../audit.js';
import { effectiveDay } from '../today.js';
import { emailConfig } from '../../email/brevo.js';
import {
  ContentError, contentHash, contentWarnings, emailHash, maskEmail, normalizeEmail,
  parseCampaignContent, recipientsHash, renderMessage, sha256Hex,
} from '../../email/content.js';
import { campaignDailyCap, planDays } from '../../email/worker.js';

export const name = 'email';

const EDITOR_ROLES = ['board', 'treasurer'];
const APPROVER_ROLES = ['board'];
const WEBHOOK_PATH = '/api/email/webhooks/brevo';
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_BODY_BYTES = 32 * 1024;
const MAX_WEBHOOK_BYTES = 64 * 1024;
const MAX_WEBHOOK_EVENTS = 100;
const RECIPIENT_PAGE = 200;
const SUPPRESS_EVENTS = Object.freeze({
  hard_bounce: 'hard_bounce', invalid_email: 'invalid_email', blocked: 'blocked',
  spam: 'complaint', complaint: 'complaint', unsubscribed: 'unsubscribed',
});
const BOUNCE_EVENTS = new Set(['hard_bounce', 'invalid_email', 'blocked']);

class RequestError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function validId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

async function readBody(request, limit) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > limit) throw new RequestError('request_too_large', 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > limit) throw new RequestError('request_too_large', 413);
  return text;
}

async function readJson(request) {
  const type = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw new RequestError('invalid_content_type', 415);
  const text = await readBody(request, MAX_BODY_BYTES);
  try {
    const data = JSON.parse(text || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new RequestError('invalid_json');
  }
}

async function requireContext(request, env, roles) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) throw new RequestError('unauthenticated', 401);
  if (!isAuthorized(context, { roles, requireMfa: true })) throw new RequestError('forbidden', 403);
  return context;
}

function requireYear(context, roles, schoolYearId) {
  if (!isAuthorized(context, { roles, schoolYearId, requireMfa: true })) throw new RequestError('forbidden', 403);
}

const CAMPAIGN_COLUMNS = `c.id, c.school_year_id, c.title, c.audience, c.subject, c.body_text, c.content_hash,
  c.status, c.recipients_hash, c.recipients_count, c.created_by, c.updated_by, c.snapshot_built_by,
  c.approved_by, c.approved_at, c.approved_content_hash, c.approved_recipients_hash, c.daily_cap,
  c.queued_at, c.completed_at, c.cancelled_at, c.idempotency_key`;

async function loadCampaign(executor, id, { lock = false } = {}) {
  const { rows } = await executor.query(
    `SELECT ${CAMPAIGN_COLUMNS}, y.label AS school_year_label
       FROM email_campaigns c JOIN school_years y ON y.id = c.school_year_id
      WHERE c.id = $1 ${lock ? 'FOR UPDATE OF c' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function campaignView(row) {
  return {
    id: row.id,
    schoolYearId: row.school_year_id,
    title: row.title,
    audience: row.audience,
    subject: row.subject,
    bodyText: row.body_text,
    status: row.status,
    contentHash: row.content_hash,
    recipientsHash: row.recipients_hash ?? null,
    recipientsCount: row.recipients_count ?? null,
    createdBy: row.created_by,
    approvedBy: row.approved_by ?? null,
    approvedAt: iso(row.approved_at),
    dailyCap: row.daily_cap ?? null,
    queuedAt: iso(row.queued_at),
    completedAt: iso(row.completed_at),
    cancelledAt: iso(row.cancelled_at),
  };
}

function mapContentError(error) {
  if (error instanceof ContentError) throw new RequestError(error.code);
  throw error;
}

function mapDatabaseError(error) {
  if (error instanceof RequestError) throw error;
  const message = String(error?.message ?? '');
  if (message.includes('email_campaign_closed') || message.includes('email_campaign_content_locked')
      || message.includes('email_snapshot_locked') || message.includes('email_campaign_invalid_transition')) {
    throw new RequestError('campaign_locked', 409);
  }
  if (error?.code === '23514' && message.includes('four_eyes')) throw new RequestError('self_approval_forbidden', 403);
  if (error?.code === '23503') throw new RequestError('invalid_reference');
  throw error;
}

async function campaignFor(request, env, id, roles) {
  if (!validId(id)) throw new RequestError('invalid_campaign_id');
  const context = await requireContext(request, env, roles);
  const campaign = await loadCampaign(env.db, id);
  if (!campaign) throw new RequestError('campaign_not_found', 404);
  requireYear(context, roles, campaign.school_year_id);
  return { context, campaign };
}

// --- Szkic i edycja -------------------------------------------------------

async function listCampaigns(request, env, url, json) {
  const schoolYearId = url.searchParams.get('schoolYearId');
  if (!validId(schoolYearId)) throw new RequestError('invalid_request');
  const context = await requireContext(request, env, EDITOR_ROLES);
  requireYear(context, EDITOR_ROLES, schoolYearId);
  const { rows } = await env.db.query(
    `SELECT ${CAMPAIGN_COLUMNS} FROM email_campaigns c WHERE c.school_year_id = $1 ORDER BY c.created_at DESC, c.id LIMIT 100`,
    [schoolYearId],
  );
  return json({ campaigns: rows.map(campaignView) });
}

async function createCampaign(request, env, json) {
  const key = request.headers.get('Idempotency-Key')?.trim();
  if (!key || !IDEMPOTENCY_PATTERN.test(key)) throw new RequestError('invalid_idempotency_key');
  const data = await readJson(request);
  if (!validId(data.schoolYearId)) throw new RequestError('invalid_request');
  let input;
  try { input = parseCampaignContent(data); } catch (error) { mapContentError(error); }
  const context = await requireContext(request, env, EDITOR_ROLES);
  requireYear(context, EDITOR_ROLES, data.schoolYearId);
  const actorId = context.session.user.id;
  const hash = contentHash({ schoolYearId: data.schoolYearId, ...input });

  const replay = async (executor) => {
    const { rows } = await executor.query(`SELECT ${CAMPAIGN_COLUMNS} FROM email_campaigns c WHERE c.idempotency_key = $1`, [key]);
    const row = rows[0];
    if (!row) return null;
    if (row.created_by !== actorId || row.school_year_id !== data.schoolYearId || row.title !== input.title
        || row.content_hash !== hash) {
      throw new RequestError('idempotency_conflict', 409);
    }
    return json({ campaign: campaignView(row) }, 200, { 'Idempotency-Replayed': 'true' });
  };

  try {
    return await env.db.transaction(async (tx) => {
      const existing = await replay(tx);
      if (existing) return existing;
      const id = crypto.randomUUID();
      const { rows } = await tx.query(
        `INSERT INTO email_campaigns (id, school_year_id, title, audience, subject, body_text, content_hash,
                                      created_by, updated_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)
         RETURNING ${CAMPAIGN_COLUMNS.replaceAll('c.', '')}`,
        [id, data.schoolYearId, input.title, input.audience, input.subject, input.bodyText, hash, actorId, key],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'email.campaign.created', entityType: 'email_campaign', entityId: id,
        metadata: { schoolYearId: data.schoolYearId, audience: input.audience, contentHash: hash },
      });
      return json({ campaign: campaignView(rows[0]) }, 201, { 'Idempotency-Replayed': 'false' });
    });
  } catch (error) {
    if (error?.code === '23505') {
      const existing = await replay(env.db);
      if (existing) return existing;
    }
    return mapDatabaseError(error);
  }
}

async function updateCampaign(request, env, id, json) {
  const data = await readJson(request);
  let input;
  try { input = parseCampaignContent(data); } catch (error) { mapContentError(error); }
  const { context } = await campaignFor(request, env, id, EDITOR_ROLES);
  const actorId = context.session.user.id;
  try {
    return await env.db.transaction(async (tx) => {
      const campaign = await loadCampaign(tx, id, { lock: true });
      if (!['draft', 'approved'].includes(campaign.status)) throw new RequestError('campaign_locked', 409);
      const hash = contentHash({ schoolYearId: campaign.school_year_id, ...input });
      if (hash === campaign.content_hash && input.title === campaign.title) {
        return json({ campaign: campaignView(campaign), approvalInvalidated: false });
      }
      // Każda zmiana (także tytułu — zmienia updated_by) cofa kampanię do szkicu
      // i usuwa zatwierdzenie; historia zostaje w audit_events.
      const invalidated = campaign.status === 'approved';
      const { rows } = await tx.query(
        `UPDATE email_campaigns SET title = $2, audience = $3, subject = $4, body_text = $5, content_hash = $6,
                updated_by = $7, updated_at = now(), status = 'draft',
                approved_by = NULL, approved_at = NULL, approved_content_hash = NULL, approved_recipients_hash = NULL
          WHERE id = $1
          RETURNING ${CAMPAIGN_COLUMNS.replaceAll('c.', '')}`,
        [id, input.title, input.audience, input.subject, input.bodyText, hash, actorId],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'email.campaign.updated', entityType: 'email_campaign', entityId: id,
        metadata: { contentHash: hash, previousContentHash: campaign.content_hash, approvalInvalidated: invalidated },
      });
      return json({ campaign: campaignView(rows[0]), approvalInvalidated: invalidated });
    });
  } catch (error) {
    return mapDatabaseError(error);
  }
}

// --- Migawka odbiorców ----------------------------------------------------

// Zasada doboru (założenie do D-11/D-17): jedna wiadomość na rodzinę (household
// ucznia zapisanego w danym roku). Adresat: opiekun ze zgodą na kontakt
// zarówno na koncie opiekuna (guardians.contact_allowed), jak i w aktywnej relacji
// z dzieckiem z tej rodziny (student_guardians.contact_allowed); najpierw kontakt
// główny, potem najmniejszy identyfikator. Adres użyty już dla innej rodziny
// w tej kampanii nie jest powtarzany (rodzeństwo w różnych gospodarstwach).
// Rodzina ucznia to jego główne gospodarstwo obowiązujące w dniu `on`
// (student_primary_household_on, #194), a nie kolumna students.household_id.
// Przy opiece naprzemiennej drugie gospodarstwo nie dostaje osobnej wiadomości
// (założenie do D-11/D-17). `on` ('YYYY-MM-DD') domyślnie = rd_today() (Bruksela).
export async function computeSnapshot(executor, campaign, { on = null } = {}) {
  const { rows: candidates } = await executor.query(
    `WITH d AS (SELECT COALESCE($2::date, rd_today()) AS on_date)
     SELECT p.household_id, g.id AS guardian_id, g.email,
            COALESCE(g.contact_allowed, false) AS guardian_allowed,
            COALESCE(bool_or(sg.contact_allowed
              AND (sg.starts_on IS NULL OR sg.starts_on <= d.on_date)
              AND (sg.ends_on IS NULL OR sg.ends_on >= d.on_date)), false) AS relation_allowed,
            COALESCE(bool_or(sg.is_primary_contact), false) AS is_primary
       FROM d
       CROSS JOIN enrollments e
       JOIN student_primary_household_on((SELECT on_date FROM d)) p ON p.student_id = e.student_id
       JOIN households h ON h.id = p.household_id AND h.archived_at IS NULL
       LEFT JOIN student_guardians sg ON sg.student_id = e.student_id
       LEFT JOIN guardians g ON g.id = sg.guardian_id
      WHERE e.school_year_id = $1
      GROUP BY p.household_id, g.id, g.email, g.contact_allowed
      ORDER BY p.household_id, g.id`,
    [campaign.school_year_id, on],
  );
  const paid = new Set();
  if (campaign.audience === 'no_payment_record') {
    const { rows } = await executor.query(
      `SELECT household_id FROM household_payment_totals WHERE school_year_id = $1 AND net_amount_cents > 0`,
      [campaign.school_year_id],
    );
    for (const row of rows) paid.add(row.household_id);
  }
  const households = new Map();
  for (const row of candidates) {
    if (!households.has(row.household_id)) households.set(row.household_id, []);
    if (row.guardian_id) households.get(row.household_id).push(row);
  }
  const hashes = [];
  for (const list of households.values()) {
    for (const row of list) {
      row.normalized = normalizeEmail(row.email);
      row.hash = row.normalized ? emailHash(row.normalized) : null;
      if (row.hash) hashes.push(row.hash);
    }
  }
  const suppressed = new Set();
  if (hashes.length) {
    const { rows } = await executor.query('SELECT email_hash FROM email_suppressions WHERE email_hash = ANY($1::text[])', [hashes]);
    for (const row of rows) suppressed.add(row.email_hash);
  }
  const recipients = [];
  const exclusions = [];
  const used = new Set();
  const ids = [...households.keys()].sort();
  for (const householdId of ids) {
    if (paid.has(householdId)) { exclusions.push({ householdId, reason: 'payment_recorded' }); continue; }
    const consenting = households.get(householdId).filter((row) => row.guardian_allowed && row.relation_allowed);
    if (!consenting.length) { exclusions.push({ householdId, reason: 'no_consent' }); continue; }
    const valid = consenting.filter((row) => row.normalized);
    if (!valid.length) { exclusions.push({ householdId, reason: 'no_valid_email' }); continue; }
    const open = valid.filter((row) => !suppressed.has(row.hash));
    if (!open.length) { exclusions.push({ householdId, reason: 'suppressed' }); continue; }
    open.sort((a, b) => (Number(b.is_primary) - Number(a.is_primary)) || (a.guardian_id < b.guardian_id ? -1 : 1));
    const chosen = open.find((row) => !used.has(row.hash));
    if (!chosen) { exclusions.push({ householdId, reason: 'duplicate_address' }); continue; }
    used.add(chosen.hash);
    recipients.push({ householdId, guardianId: chosen.guardian_id, email: chosen.normalized, emailHash: chosen.hash });
  }
  return { recipients, exclusions, hash: recipientsHash(recipients) };
}

async function buildSnapshot(request, env, id, json) {
  const { context } = await campaignFor(request, env, id, EDITOR_ROLES);
  const actorId = context.session.user.id;
  try {
    return await env.db.transaction(async (tx) => {
      const campaign = await loadCampaign(tx, id, { lock: true });
      if (!['draft', 'approved'].includes(campaign.status)) throw new RequestError('campaign_locked', 409);
      const wasApproved = campaign.status === 'approved';
      await tx.query(
        `UPDATE email_campaigns SET status = 'draft', approved_by = NULL, approved_at = NULL,
                approved_content_hash = NULL, approved_recipients_hash = NULL,
                recipients_hash = NULL, recipients_count = NULL, snapshot_built_by = NULL, snapshot_built_at = NULL
          WHERE id = $1`,
        [id],
      );
      await tx.query('DELETE FROM email_campaign_recipients WHERE campaign_id = $1', [id]);
      await tx.query('DELETE FROM email_campaign_exclusions WHERE campaign_id = $1', [id]);
      const snapshot = await computeSnapshot(tx, campaign, { on: effectiveDay(env) });
      if (snapshot.recipients.length) {
        await tx.query(
          `INSERT INTO email_campaign_recipients (id, campaign_id, household_id, guardian_id, email, email_hash)
           SELECT gen_random_uuid()::text, $1, h, g, e, x
             FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS t(h, g, e, x)`,
          [id, snapshot.recipients.map((r) => r.householdId), snapshot.recipients.map((r) => r.guardianId),
            snapshot.recipients.map((r) => r.email), snapshot.recipients.map((r) => r.emailHash)],
        );
      }
      if (snapshot.exclusions.length) {
        await tx.query(
          `INSERT INTO email_campaign_exclusions (campaign_id, household_id, reason)
           SELECT $1, h, r FROM unnest($2::text[], $3::text[]) AS t(h, r)`,
          [id, snapshot.exclusions.map((e) => e.householdId), snapshot.exclusions.map((e) => e.reason)],
        );
      }
      await tx.query(
        `UPDATE email_campaigns SET recipients_hash = $2, recipients_count = $3, snapshot_built_by = $4,
                snapshot_built_at = now(), updated_at = now()
          WHERE id = $1`,
        [id, snapshot.hash, snapshot.recipients.length, actorId],
      );
      const byReason = summarizeExclusions(snapshot.exclusions);
      await insertAuditEvent(tx, {
        actorId, action: 'email.snapshot.built', entityType: 'email_campaign', entityId: id,
        // Kody powodów jako pary [kod, liczba] — nazwa kodu (np. no_valid_email) nie jest daną osobową.
        metadata: { recipientsHash: snapshot.hash, recipients: snapshot.recipients.length, exclusionCounts: Object.entries(byReason), approvalInvalidated: wasApproved },
      });
      return json({
        recipientsHash: snapshot.hash, recipientsCount: snapshot.recipients.length,
        exclusions: byReason, approvalInvalidated: wasApproved,
      });
    });
  } catch (error) {
    return mapDatabaseError(error);
  }
}

function summarizeExclusions(list) {
  const summary = {};
  for (const item of list) summary[item.reason] = (summary[item.reason] ?? 0) + 1;
  return summary;
}

async function loadRecipients(executor, campaignId) {
  const { rows } = await executor.query(
    `SELECT household_id, guardian_id, email, email_hash FROM email_campaign_recipients
      WHERE campaign_id = $1 ORDER BY household_id`,
    [campaignId],
  );
  return rows;
}

// --- Podgląd i lista ------------------------------------------------------

async function preview(request, env, id, json) {
  const { campaign } = await campaignFor(request, env, id, EDITOR_ROLES);
  const config = emailConfig(env);
  const recipients = campaign.recipients_hash ? await loadRecipients(env.db, id) : [];
  const { rows: exclusions } = await env.db.query(
    'SELECT reason, COUNT(*)::int AS n FROM email_campaign_exclusions WHERE campaign_id = $1 GROUP BY reason ORDER BY reason',
    [id],
  );
  const sampleHousehold = recipients[0]?.household_id ?? 'PRZYKLAD';
  const sample = renderMessage(campaign, { schoolYearLabel: campaign.school_year_label, householdId: sampleHousehold });
  const count = recipients.length;
  const dailyCap = campaign.daily_cap ?? campaignDailyCap(count, config);
  return json({
    campaign: campaignView(campaign),
    contentHash: campaign.content_hash,
    recipientsHash: campaign.recipients_hash ?? null,
    snapshotCurrent: campaign.recipients_hash ? recipientsHash(recipients) === campaign.recipients_hash : false,
    recipientsCount: count,
    exclusions: Object.fromEntries(exclusions.map((row) => [row.reason, row.n])),
    sample: { householdId: sampleHousehold, recipient: recipients[0] ? maskEmail(recipients[0].email) : null, ...sample },
    plan: {
      dailyCap, days: planDays(count, dailyCap, config),
      accountDailyLimit: config.dailyLimit, reservedForOtherMail: config.dailyReserved,
    },
    warnings: contentWarnings({ bodyText: campaign.body_text }),
    sends: false,
  });
}

async function listRecipients(request, env, id, url, json) {
  const { context, campaign } = await campaignFor(request, env, id, EDITOR_ROLES);
  const offsetText = url.searchParams.get('offset') ?? '0';
  if (!/^\d{1,6}$/.test(offsetText)) throw new RequestError('invalid_request');
  const offset = Number(offsetText);
  const { rows } = await env.db.query(
    `SELECT household_id, guardian_id, email FROM email_campaign_recipients
      WHERE campaign_id = $1 ORDER BY household_id LIMIT $2 OFFSET $3`,
    [id, RECIPIENT_PAGE + 1, offset],
  );
  await insertAuditEvent(env.db, {
    actorId: context.session.user.id, action: 'email.recipients.viewed', entityType: 'email_campaign', entityId: id,
    metadata: { offset, recipientsHash: campaign.recipients_hash ?? null },
  });
  return json({
    recipients: rows.slice(0, RECIPIENT_PAGE).map((row) => ({ householdId: row.household_id, guardianId: row.guardian_id, email: row.email })),
    nextOffset: rows.length > RECIPIENT_PAGE ? offset + RECIPIENT_PAGE : null,
  });
}

// --- Zatwierdzenie, kolejka, anulowanie ------------------------------------

async function verifyExact(tx, campaign) {
  const content = contentHash({
    schoolYearId: campaign.school_year_id, audience: campaign.audience,
    subject: campaign.subject, bodyText: campaign.body_text,
  });
  if (content !== campaign.content_hash) throw new RequestError('content_hash_mismatch', 409);
  if (!campaign.recipients_hash) throw new RequestError('snapshot_required', 409);
  const recipients = await loadRecipients(tx, campaign.id);
  if (recipientsHash(recipients) !== campaign.recipients_hash) throw new RequestError('recipients_hash_mismatch', 409);
  return recipients;
}

async function approve(request, env, id, json) {
  const data = await readJson(request);
  if (!HASH_PATTERN.test(data.contentHash ?? '') || !HASH_PATTERN.test(data.recipientsHash ?? '')) {
    throw new RequestError('invalid_request');
  }
  const { context } = await campaignFor(request, env, id, APPROVER_ROLES);
  const actorId = context.session.user.id;
  try {
    return await env.db.transaction(async (tx) => {
      const campaign = await loadCampaign(tx, id, { lock: true });
      if (campaign.status === 'approved' && campaign.approved_by === actorId
          && campaign.approved_content_hash === data.contentHash && campaign.approved_recipients_hash === data.recipientsHash) {
        return json({ campaign: campaignView(campaign) }, 200, { 'Idempotency-Replayed': 'true' });
      }
      if (campaign.status !== 'draft') throw new RequestError('campaign_not_draft', 409);
      if ([campaign.created_by, campaign.updated_by, campaign.snapshot_built_by].includes(actorId)) {
        throw new RequestError('self_approval_forbidden', 403);
      }
      const recipients = await verifyExact(tx, campaign);
      if (data.contentHash !== campaign.content_hash || data.recipientsHash !== campaign.recipients_hash) {
        throw new RequestError('approval_stale', 409);
      }
      if (!recipients.length) throw new RequestError('no_recipients', 409);
      const { rows } = await tx.query(
        `UPDATE email_campaigns SET status = 'approved', approved_by = $2, approved_at = now(),
                approved_content_hash = content_hash, approved_recipients_hash = recipients_hash
          WHERE id = $1 AND content_hash = $3 AND recipients_hash = $4
          RETURNING ${CAMPAIGN_COLUMNS.replaceAll('c.', '')}`,
        [id, actorId, data.contentHash, data.recipientsHash],
      );
      if (!rows[0]) throw new RequestError('approval_stale', 409);
      await insertAuditEvent(tx, {
        actorId, action: 'email.campaign.approved', entityType: 'email_campaign', entityId: id,
        metadata: { contentHash: data.contentHash, recipientsHash: data.recipientsHash, recipients: recipients.length },
      });
      return json({ campaign: campaignView(rows[0]) });
    });
  } catch (error) {
    return mapDatabaseError(error);
  }
}

async function queue(request, env, id, json) {
  const { context } = await campaignFor(request, env, id, EDITOR_ROLES);
  const actorId = context.session.user.id;
  const config = emailConfig(env);
  try {
    return await env.db.transaction(async (tx) => {
      const campaign = await loadCampaign(tx, id, { lock: true });
      if (campaign.status === 'sending') return json({ campaign: campaignView(campaign), queued: 0 }, 200, { 'Idempotency-Replayed': 'true' });
      if (campaign.status !== 'approved') throw new RequestError('approval_required', 409);
      const recipients = await verifyExact(tx, campaign);
      if (campaign.approved_content_hash !== campaign.content_hash || campaign.approved_recipients_hash !== campaign.recipients_hash) {
        throw new RequestError('approval_required', 409);
      }
      const dailyCap = campaignDailyCap(recipients.length, config);
      const { rows: inserted } = await tx.query(
        `INSERT INTO email_outbox (id, campaign_id, household_id, recipient_id, idempotency_key)
         SELECT gen_random_uuid()::text, r.campaign_id, r.household_id, r.id,
                'campaign:' || r.campaign_id || ':household:' || r.household_id
           FROM email_campaign_recipients r WHERE r.campaign_id = $1
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [id],
      );
      const { rows } = await tx.query(
        `UPDATE email_campaigns SET status = 'sending', daily_cap = $2, queued_by = $3, queued_at = now()
          WHERE id = $1 RETURNING ${CAMPAIGN_COLUMNS.replaceAll('c.', '')}`,
        [id, dailyCap, actorId],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'email.campaign.queued', entityType: 'email_campaign', entityId: id,
        metadata: { queued: inserted.length, dailyCap, recipientsHash: campaign.recipients_hash },
      });
      return json({ campaign: campaignView(rows[0]), queued: inserted.length });
    });
  } catch (error) {
    return mapDatabaseError(error);
  }
}

async function cancel(request, env, id, json) {
  const { context } = await campaignFor(request, env, id, EDITOR_ROLES);
  const actorId = context.session.user.id;
  try {
    return await env.db.transaction(async (tx) => {
      const campaign = await loadCampaign(tx, id, { lock: true });
      if (campaign.status === 'cancelled') return json({ campaign: campaignView(campaign), cancelledMessages: 0 }, 200, { 'Idempotency-Replayed': 'true' });
      if (campaign.status === 'done') throw new RequestError('campaign_locked', 409);
      const { rows: cancelled } = await tx.query(
        `UPDATE email_outbox SET state = 'cancelled', last_error = 'campaign_cancelled', updated_at = now()
          WHERE campaign_id = $1 AND state = 'queued' RETURNING id`,
        [id],
      );
      const { rows } = await tx.query(
        `UPDATE email_campaigns SET status = 'cancelled', cancelled_by = $2, cancelled_at = now()
          WHERE id = $1 RETURNING ${CAMPAIGN_COLUMNS.replaceAll('c.', '')}`,
        [id, actorId],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'email.campaign.cancelled', entityType: 'email_campaign', entityId: id,
        metadata: { previousStatus: campaign.status, cancelledMessages: cancelled.length },
      });
      return json({ campaign: campaignView(rows[0]), cancelledMessages: cancelled.length });
    });
  } catch (error) {
    return mapDatabaseError(error);
  }
}

async function status(request, env, id, json) {
  const { campaign } = await campaignFor(request, env, id, EDITOR_ROLES);
  const { rows } = await env.db.query(
    'SELECT state, COUNT(*)::int AS n FROM email_outbox WHERE campaign_id = $1 GROUP BY state ORDER BY state',
    [id],
  );
  const { rows: exclusions } = await env.db.query(
    'SELECT reason, COUNT(*)::int AS n FROM email_campaign_exclusions WHERE campaign_id = $1 GROUP BY reason ORDER BY reason',
    [id],
  );
  return json({
    campaign: campaignView(campaign),
    outbox: Object.fromEntries(rows.map((row) => [row.state, row.n])),
    exclusions: Object.fromEntries(exclusions.map((row) => [row.reason, row.n])),
  });
}

// --- Webhook Brevo --------------------------------------------------------

function sameSecret(provided, expected) {
  const a = Buffer.from(sha256Hex(provided), 'hex');
  const b = Buffer.from(sha256Hex(expected), 'hex');
  return timingSafeEqual(a, b) && provided.length === expected.length;
}

// Brevo nie podpisuje treści HMAC. Weryfikacja: wspólny sekret w nagłówku
// Authorization (Bearer <sekret> albo Basic z sekretem jako hasłem), porównanie w stałym czasie.
function webhookTokenFrom(request) {
  const header = request.headers.get('Authorization') ?? '';
  const bearer = header.match(/^Bearer\s+(\S{1,512})$/i);
  if (bearer) return bearer[1];
  const basic = header.match(/^Basic\s+([A-Za-z0-9+/=]{1,700})$/i);
  if (basic) {
    const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    return colon >= 0 ? decoded.slice(colon + 1) : null;
  }
  return null;
}

async function webhook(request, env, json) {
  const secret = typeof env.BREVO_WEBHOOK_SECRET === 'string' ? env.BREVO_WEBHOOK_SECRET : '';
  if (secret.length < 32) return json({ error: 'webhook_not_configured' }, 503);
  const token = webhookTokenFrom(request);
  if (!token || !sameSecret(token, secret)) return json({ error: 'invalid_signature' }, 401);
  const type = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw new RequestError('invalid_content_type', 415);
  const text = await readBody(request, MAX_WEBHOOK_BYTES);
  let payload;
  try { payload = JSON.parse(text); } catch { throw new RequestError('invalid_json'); }
  const events = Array.isArray(payload) ? payload : [payload];
  if (!events.length || events.length > MAX_WEBHOOK_EVENTS || events.some((e) => !e || typeof e !== 'object')) {
    throw new RequestError('invalid_request');
  }
  let recorded = 0;
  let suppressed = 0;
  for (const event of events) {
    const outcome = await recordWebhookEvent(env.db, event);
    if (outcome.recorded) recorded += 1;
    if (outcome.suppressed) suppressed += 1;
  }
  return json({ received: events.length, recorded, suppressed });
}

async function recordWebhookEvent(db, event) {
  const eventName = typeof event.event === 'string' ? event.event.trim().toLowerCase() : '';
  if (!/^[a-z_]{1,40}$/.test(eventName)) return { recorded: false };
  const messageId = typeof event['message-id'] === 'string' ? event['message-id'].slice(0, 200) : null;
  const custom = typeof event['X-Mailin-custom'] === 'string' && validId(event['X-Mailin-custom']) ? event['X-Mailin-custom'] : null;
  const normalized = normalizeEmail(event.email);
  const hash = normalized ? emailHash(normalized) : null;
  const occurred = Number.isFinite(Number(event.ts_event)) ? new Date(Number(event.ts_event) * 1000) : null;
  const dedupeKey = sha256Hex(JSON.stringify([eventName, messageId, event.id ?? null, event.ts_event ?? event.date ?? null, hash]));
  return db.transaction(async (tx) => {
    const { rows: outboxRows } = await tx.query(
      `SELECT o.id, o.state, o.campaign_id, r.guardian_id, r.email_hash
         FROM email_outbox o JOIN email_campaign_recipients r ON r.id = o.recipient_id
        WHERE ($1::text IS NOT NULL AND o.provider_message_id = $1) OR ($2::text IS NOT NULL AND o.id = $2)
        LIMIT 1 FOR UPDATE OF o`,
      [messageId, custom],
    );
    // Wiersz kolejki przypisujemy tylko, gdy zdarzenie dotyczy tego samego adresu.
    const outbox = outboxRows[0] && (!hash || outboxRows[0].email_hash === hash) ? outboxRows[0] : null;
    const eventId = crypto.randomUUID();
    const { rows } = await tx.query(
      `INSERT INTO email_webhook_events (id, provider, dedupe_key, event, provider_message_id, outbox_id, email_hash, occurred_at)
       VALUES ($1, 'brevo', $2, $3, $4, $5, $6, $7)
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
      [eventId, dedupeKey, eventName, messageId, outbox?.id ?? null, hash ?? outbox?.email_hash ?? null, occurred && !Number.isNaN(occurred.valueOf()) ? occurred.toISOString() : null],
    );
    if (!rows[0]) return { recorded: false };
    const reason = SUPPRESS_EVENTS[eventName];
    const suppressHash = hash ?? outbox?.email_hash ?? null;
    if (!reason || !suppressHash) return { recorded: true };
    await tx.query(
      `INSERT INTO email_suppressions (email_hash, reason, source_event_id) VALUES ($1, $2, $3)
       ON CONFLICT (email_hash) DO NOTHING`,
      [suppressHash, reason, eventId],
    );
    if (outbox && BOUNCE_EVENTS.has(eventName) && outbox.state === 'sent') {
      await tx.query(`UPDATE email_outbox SET state = 'bounced', last_error = $2, updated_at = now() WHERE id = $1`, [outbox.id, eventName]);
    }
    // Zgłoszenie potrzeby poprawy adresu: identyfikator opiekuna, bez adresu.
    await insertAuditEvent(tx, {
      action: 'email.address_suppressed', entityType: outbox ? 'email_outbox' : 'email_webhook_event',
      entityId: outbox?.id ?? eventId,
      metadata: { event: eventName, reason, guardianId: outbox?.guardian_id ?? null, campaignId: outbox?.campaign_id ?? null },
    });
    return { recorded: true, suppressed: true };
  });
}

// --- Router ---------------------------------------------------------------

export function allowsCrossOrigin(request, url) {
  return request.method === 'POST' && url.pathname === WEBHOOK_PATH;
}

export async function handle(request, env, url, json) {
  if (!url.pathname.startsWith('/api/email/')) return null;
  const method = request.method;
  try {
    if (url.pathname === WEBHOOK_PATH) {
      if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return await webhook(request, env, json);
    }
    if (method !== 'GET' && !isSameOrigin(request)) return json({ error: 'invalid_origin' }, 403);
    if (url.pathname === '/api/email/campaigns') {
      if (method === 'GET') return await listCampaigns(request, env, url, json);
      if (method === 'POST') return await createCampaign(request, env, json);
      return json({ error: 'method_not_allowed' }, 405);
    }
    const match = url.pathname.match(/^\/api\/email\/campaigns\/([^/]+)(?:\/(snapshot|preview|recipients|approve|queue|cancel))?$/);
    if (!match) return null;
    let id;
    try { id = decodeURIComponent(match[1]); } catch { throw new RequestError('invalid_campaign_id'); }
    const action = match[2] ?? null;
    if (!action && method === 'GET') return await status(request, env, id, json);
    if (!action && method === 'PUT') return await updateCampaign(request, env, id, json);
    if (action === 'preview' && method === 'GET') return await preview(request, env, id, json);
    if (action === 'recipients' && method === 'GET') return await listRecipients(request, env, id, url, json);
    if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (action === 'snapshot') return await buildSnapshot(request, env, id, json);
    if (action === 'approve') return await approve(request, env, id, json);
    if (action === 'queue') return await queue(request, env, id, json);
    if (action === 'cancel') return await cancel(request, env, id, json);
    return json({ error: 'method_not_allowed' }, 405);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.code }, error.status);
    throw error;
  }
}
