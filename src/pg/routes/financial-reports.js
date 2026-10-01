// Sprawozdanie roczne i przepływy środków (#125, część). Prototyp — nie jest wdrożony.
//
//   GET /api/reports/annual?schoolYearId=…&format=json|html
//   GET /api/reports/cash-flow?schoolYearId=…&granularity=month
//   GET  /api/reports/annual/snapshots?schoolYearId=…            lista migawek (bez treści)
//   POST /api/reports/annual/snapshots                          { schoolYearId, supersedesId?, reason? }
//   GET  /api/reports/annual/snapshots/{id}?format=json|html    zapisana treść (SHA-256 sprawdzany przy odczycie)
//   POST /api/reports/annual/snapshots/{id}/approve             tylko zarząd, świeże MFA, inna osoba niż autor
//
// Dostęp: zarząd i skarbnik z MFA w zakresie roku. `admin` (techniczny),
// `audit`, `principal` i przedstawiciel klasy: 403 — D-08/D-09 nierozstrzygnięte,
// wariant zachowawczy (KR ma własny raport /api/reports/audit). Każde wygenerowanie
// zapisuje zdarzenie audytu bez treści raportu, w jednej transakcji z odczytem.
// Migawki (0138, src/pg/report-snapshots.js): tworzy zarząd albo skarbnik, zatwierdza
// wyłącznie zarząd (inna osoba niż autor, świeże MFA). Kto zatwierdza (zarząd/KR)
// i forma sprawozdania — D-09, D-12, D-21 nierozstrzygnięte: wariant zachowawczy.
// Publikacja zatwierdzonej migawki (aktualności) — osobny zakres, wymaga decyzji zarządu.

import {
  freshMfaForbiddenCode, isAuthorizedScoped, loadAuthorizationContext, logAccessDenied, MFA_STEP_UP_MAX_AGE_SECONDS,
  mfaAwareForbiddenCode,
} from '../authorization.js';
import { insertAuditEvent } from '../audit.js';
import { reportContentSecurityPolicy } from '../audit-report.js';
import { buildAnnualReport, buildCashFlow, renderAnnualReportHtml } from '../annual-report.js';
import { readSnapshot } from '../db-snapshot.js';
import { gateFreeText, PersonalDataError, piiAuditMetadata } from '../pii-gate.js';
import {
  approveSnapshot, createSnapshot, listSnapshots, loadSnapshotYear, readSnapshotById, ReportError,
} from '../report-snapshots.js';
import { createJsonReader } from '../input.js';

export const name = 'financial-reports';

const REPORT_ROLES = ['board', 'treasurer'];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const APPROVE_ROLES = ['board'];
const MAX_BODY_BYTES = 8 * 1024;
const SNAPSHOT_PATH = /^\/api\/reports\/annual\/snapshots(?:\/([^/]+?)(\/approve)?)?$/;
const RequestError = ReportError;

async function requireReportAccess(request, env, schoolYearId, { roles = REPORT_ROLES, freshMfa = false } = {}) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) throw new RequestError('unauthenticated', 401);
  const rule = { roles, schoolYearId, requireMfa: true };
  if (!isAuthorizedScoped(context, rule)) {
    const code = await mfaAwareForbiddenCode(context, rule, env);
    // #184: ślad odmowy roli/zakresu (przed transakcją żądania); kody MFA — bez zdarzenia.
    if (code === 'forbidden') await logAccessDenied(env, context, rule, request);
    throw new RequestError(code, 403);
  }
  if (freshMfa) {
    // Zatwierdzenie sprawozdania to krok w górę MFA (jak zamknięcie roku, #150).
    const staleCode = freshMfaForbiddenCode(context, MFA_STEP_UP_MAX_AGE_SECONDS);
    if (staleCode) throw new RequestError(staleCode, 403);
  }
  return context;
}

const readJson = createJsonReader({
  maxBytes: MAX_BODY_BYTES,
  emptyBody: 'blank',
  typeAfterEmpty: true,
  error: (code, status) => new RequestError(code, status),
});

function htmlResponse(html, csp) {
  return new Response(html, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    },
  });
}

function readYear(url) {
  const schoolYearId = url.searchParams.get('schoolYearId');
  if (typeof schoolYearId !== 'string' || !ID_PATTERN.test(schoolYearId)) throw new RequestError('invalid_request');
  return schoolYearId;
}

async function annualReport(request, env, url, json) {
  const schoolYearId = readYear(url);
  const format = url.searchParams.get('format') ?? 'json';
  if (!['json', 'html'].includes(format)) throw new RequestError('invalid_request');
  const context = await requireReportAccess(request, env, schoolYearId);
  // Jedna migawka (REPEATABLE READ) dla wszystkich sum i zdarzenie audytu w tej samej transakcji (#213, #178).
  const report = await env.db.transaction(async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const built = await buildAnnualReport(tx, schoolYearId);
    if (!built) return null;
    await insertAuditEvent(tx, {
      actorId: context.session.user.id, action: 'report.annual.generated', entityType: 'school_year',
      entityId: schoolYearId, metadata: { schoolYearId, format },
    });
    return built;
  });
  if (!report) throw new RequestError('school_year_not_found', 404);
  if (format === 'json') return json({ report }, 200, { 'Cache-Control': 'no-store' });
  return htmlResponse(renderAnnualReportHtml(report), await reportContentSecurityPolicy());
}

async function snapshotList(request, env, url, json) {
  const schoolYearId = readYear(url);
  await requireReportAccess(request, env, schoolYearId);
  return json({ snapshots: await listSnapshots(env.db, schoolYearId) }, 200, { 'Cache-Control': 'no-store' });
}

async function snapshotCreate(request, env, json) {
  const data = await readJson(request);
  const { schoolYearId, supersedesId = null, reason = null } = data;
  if (typeof schoolYearId !== 'string' || !ID_PATTERN.test(schoolYearId)) throw new RequestError('invalid_request');
  if (supersedesId !== null && (typeof supersedesId !== 'string' || !ID_PATTERN.test(supersedesId))) throw new RequestError('invalid_request');
  const text = reason === null ? null : (typeof reason === 'string' ? reason.trim() : undefined);
  if (text === undefined || (text !== null && (text.length < 3 || text.length > 500))) throw new RequestError('invalid_reason');
  const context = await requireReportAccess(request, env, schoolYearId);
  // #152: powód zastąpienia migawki jest zapisem niezmiennym — bramka na dane osobowe.
  const gate = gateFreeText([['financial_report_snapshots.supersede_reason', text]], { confirm: data.confirmPersonalData === true });
  const result = await createSnapshot(env.db, {
    actorId: context.session.user.id, schoolYearId, supersedesId, reason: text || null, auditMetadata: piiAuditMetadata(gate),
  });
  return json({ snapshot: result.snapshot, replayed: result.replayed }, result.replayed ? 200 : 201, { 'Cache-Control': 'no-store' });
}

// Rok migawki ustala się z wiersza i dopiero dla niego sprawdza uprawnienie (SR-01):
// aktor bez roli dostaje 403 także dla nieistniejącego identyfikatora (bez wyroczni).
async function snapshotYear(request, env, snapshotId, options) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) throw new RequestError('unauthenticated', 401);
  const generic = { roles: options?.roles ?? REPORT_ROLES, requireMfa: true };
  if (!isAuthorizedScoped(context, generic)) {
    const code = await mfaAwareForbiddenCode(context, generic, env);
    // #184: ślad odmowy roli/zakresu (przed transakcją żądania); kody MFA — bez zdarzenia.
    if (code === 'forbidden') await logAccessDenied(env, context, generic, request);
    throw new RequestError(code, 403);
  }
  const schoolYearId = await loadSnapshotYear(env.db, snapshotId);
  if (!schoolYearId) throw new RequestError('report_snapshot_not_found', 404);
  return schoolYearId;
}

async function snapshotRead(request, env, url, snapshotId, json) {
  const format = url.searchParams.get('format') ?? 'json';
  if (!['json', 'html'].includes(format)) throw new RequestError('invalid_request');
  const schoolYearId = await snapshotYear(request, env, snapshotId);
  await requireReportAccess(request, env, schoolYearId);
  const found = await readSnapshot(env.db, (tx) => readSnapshotById(tx, snapshotId));
  if (!found) throw new RequestError('report_snapshot_not_found', 404);
  // Skrót przeliczony z zapisanej treści musi zgadzać się z zapisanym: inaczej nie oddajemy treści.
  if (!found.integrityOk) throw new RequestError('report_snapshot_integrity_failed', 500);
  if (format === 'json') return json({ snapshot: found.snapshot, report: found.report }, 200, { 'Cache-Control': 'no-store' });
  return htmlResponse(renderAnnualReportHtml(found.report, { snapshot: found.snapshot }), await reportContentSecurityPolicy());
}

async function snapshotApprove(request, env, snapshotId, json) {
  await readJson(request);
  const schoolYearId = await snapshotYear(request, env, snapshotId, { roles: APPROVE_ROLES });
  const context = await requireReportAccess(request, env, schoolYearId, { roles: APPROVE_ROLES, freshMfa: true });
  const result = await approveSnapshot(env.db, { actorId: context.session.user.id, snapshotId });
  return json({ snapshot: result.snapshot, replayed: result.replayed }, result.replayed ? 200 : 201, { 'Cache-Control': 'no-store' });
}

async function cashFlow(request, env, url, json) {
  const schoolYearId = readYear(url);
  const granularity = url.searchParams.get('granularity') ?? 'month';
  if (granularity !== 'month') throw new RequestError('invalid_request');
  const context = await requireReportAccess(request, env, schoolYearId);
  // Jedna migawka (REPEATABLE READ) dla wszystkich sum i zdarzenie audytu w tej samej transakcji (#213, #178).
  const report = await env.db.transaction(async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const built = await buildCashFlow(tx, schoolYearId);
    if (!built) return null;
    await insertAuditEvent(tx, {
      actorId: context.session.user.id, action: 'report.cash_flow.generated', entityType: 'school_year',
      entityId: schoolYearId, metadata: { schoolYearId, granularity },
    });
    return built;
  });
  if (!report) throw new RequestError('school_year_not_found', 404);
  return json({ report }, 200, { 'Cache-Control': 'no-store' });
}

export async function handle(request, env, url, json) {
  const path = url.pathname;
  const snapshotMatch = SNAPSHOT_PATH.exec(path);
  if (snapshotMatch) {
    const [, rawId, approve] = snapshotMatch;
    const allowed = rawId ? (approve ? 'POST' : 'GET') : 'GET, POST';
    if (!allowed.split(', ').includes(request.method)) return json({ error: 'method_not_allowed' }, 405, { Allow: allowed });
    try {
      let snapshotId = null;
      if (rawId) {
        try { snapshotId = decodeURIComponent(rawId); } catch { throw new RequestError('invalid_request'); }
        if (!ID_PATTERN.test(snapshotId)) throw new RequestError('invalid_request');
      }
      if (!snapshotId) return request.method === 'GET' ? await snapshotList(request, env, url, json) : await snapshotCreate(request, env, json);
      if (approve) return await snapshotApprove(request, env, snapshotId, json);
      return await snapshotRead(request, env, url, snapshotId, json);
    } catch (error) {
      if (error instanceof PersonalDataError) return json({ error: error.code, categories: error.categories }, 422);
      if (error instanceof RequestError) return json({ error: error.code }, error.status);
      throw error;
    }
  }
  if (path !== '/api/reports/annual' && path !== '/api/reports/cash-flow') return null;
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
  try {
    if (path === '/api/reports/annual') return await annualReport(request, env, url, json);
    return await cashFlow(request, env, url, json);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.code }, error.status);
    throw error;
  }
}
