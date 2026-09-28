// Sprawozdanie roczne i przepływy środków (#125, część). Prototyp — nie jest wdrożony.
//
//   GET /api/reports/annual?schoolYearId=…&format=json|html
//   GET /api/reports/cash-flow?schoolYearId=…&granularity=month
//
// Dostęp: zarząd i skarbnik z MFA w zakresie roku. `admin` (techniczny),
// `audit`, `principal` i przedstawiciel klasy: 403 — D-08/D-09 nierozstrzygnięte,
// wariant zachowawczy (KR ma własny raport /api/reports/audit). Każde wygenerowanie
// zapisuje zdarzenie audytu bez treści raportu, w jednej transakcji z odczytem.
// Zatwierdzone, niezmienne migawki sprawozdania (financial_report_snapshots) i
// publikacja — osobny zakres (wymaga migracji i decyzji zarządu).

import { isAuthorizedScoped, loadAuthorizationContext, mfaAwareForbiddenCode } from '../authorization.js';
import { insertAuditEvent } from '../audit.js';
import { reportContentSecurityPolicy } from '../audit-report.js';
import { buildAnnualReport, buildCashFlow, renderAnnualReportHtml } from '../annual-report.js';

export const name = 'financial-reports';

const REPORT_ROLES = ['board', 'treasurer'];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

class RequestError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

async function requireReportAccess(request, env, schoolYearId) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) throw new RequestError('unauthenticated', 401);
  const rule = { roles: REPORT_ROLES, schoolYearId, requireMfa: true };
  if (!isAuthorizedScoped(context, rule)) throw new RequestError(await mfaAwareForbiddenCode(context, rule, env), 403);
  return context;
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
  const report = await env.db.transaction(async (tx) => {
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
  return new Response(renderAnnualReportHtml(report), {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': await reportContentSecurityPolicy(),
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    },
  });
}

async function cashFlow(request, env, url, json) {
  const schoolYearId = readYear(url);
  const granularity = url.searchParams.get('granularity') ?? 'month';
  if (granularity !== 'month') throw new RequestError('invalid_request');
  const context = await requireReportAccess(request, env, schoolYearId);
  const report = await env.db.transaction(async (tx) => {
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
