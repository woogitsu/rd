// Eksport roczny i lista klasy na PostgreSQL (issue #9). Prototyp — nie jest wdrożony.
//
//   POST /api/exports                         { "schoolYearId": "…" }
//        admin albo zarząd (założenie do D-08/D-09), sesja z MFA, zakres roku.
//        Zwraca deterministyczną paczkę JSON jako załącznik (docs/EXPORT.md).
//   GET  /api/exports/class-roster?classId=…[&format=json|csv|xlsx]
//        przedstawiciel wyłącznie własnej klasy (także admin/zarząd), MFA.
//        Tylko lista uczniów i opiekunów klasy — bez wpłat i identyfikatorów rodzin.
//
// Każdy przebieg zapisuje wiersz export_runs (liczności i SHA-256, bez treści)
// oraz zdarzenie audytu `export.created` w tej samej transakcji.

import { isSameOrigin } from '../../auth.js';
import {
  freshMfaForbiddenCode, isAuthorized, isAuthorizedScoped, loadAuthorizationContext, mfaAwareForbiddenCode,
  MFA_STEP_UP_MAX_AGE_SECONDS,
} from '../authorization.js';
import { insertAuditEvent } from '../audit.js';
import { csvResponse } from '../csv.js';
import { xlsxResponse } from '../xlsx.js';
import { recordDataAccess } from '../data-access.js';
import { archiveReadVia, recordArchiveRead } from '../archive-access.js';
import {
  buildClassRoster, buildClassRosterCsv, buildClassRosterXlsx, buildYearlyExport, EXPORT_FORMAT_VERSION, ExportError, ROSTER_FORMAT_VERSION,
} from '../export.js';
import { createJsonReader } from '../input.js';
import { createExportSpool } from '../export-spool.js';

export const name = 'exports';

// Założenie do czasu decyzji D-08/D-09: pełny eksport roczny (dane rodzin i
// finanse) tylko admin i zarząd; skarbnik, Komisja Rewizyjna i dyrekcja nie.
export const YEARLY_EXPORT_ROLES = Object.freeze(['admin', 'board']);
// Eksport zamkniętego roku (#195): także zarząd roku następnego (admin ma go i tak).
export const ARCHIVE_EXPORT_ROLES = Object.freeze(['board']);
export const ROSTER_ROLES = Object.freeze(['representative', 'board', 'admin']);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_BODY_BYTES = 4 * 1024;

class RequestError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const readJson = createJsonReader({
  maxBytes: MAX_BODY_BYTES,
  declaredLength: true,
  error: (code, status) => new RequestError(code, status),
});

function safeFilePart(value) {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function attachment(body, filename, headers = {}, contentType = 'application/json; charset=utf-8') {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

async function authorize(request, env, requirement, json) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) return { response: json({ error: 'unauthenticated' }, 401) };
  // Eksport roczny (bez classId) wymaga przydziału bez class_id; lista klasy — przydziału tej klasy.
  if (!isAuthorizedScoped(context, requirement)) {
    // #161: sam brak MFA (rola i zakres klasy pasują) zwraca mfa_required/
    // mfa_enrollment_required zamiast ogólnego forbidden, by ekran logowania
    // mógł poprowadzić przedstawiciela do zapisania czynnika.
    const code = await mfaAwareForbiddenCode(context, requirement, env);
    return { response: json({ error: code }, 403) };
  }
  return { context };
}

async function recordRun(tx, { kind, schoolYearId, classId = null, formatVersion, actorId, sha256, rowCounts, format = 'json' }) {
  const runId = crypto.randomUUID();
  await tx.query(
    `INSERT INTO export_runs (id, kind, school_year_id, class_id, format_version, requested_by, manifest_sha256, row_counts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [runId, kind, schoolYearId, classId, formatVersion, actorId, sha256, JSON.stringify(rowCounts)],
  );
  await insertAuditEvent(tx, {
    actorId,
    action: 'export.created',
    entityType: 'export_run',
    entityId: runId,
    // `format` (#132: json domyślnie, także csv) trafia tylko do audytu — bez
    // migracji `export_runs`, kolumna `row_counts` zostaje jak dotąd (json/CSV
    // niosą te same liczności).
    metadata: { kind, schoolYearId, classId, formatVersion, manifestSha256: sha256, rowCounts, format },
  });
  return runId;
}

async function createYearlyExport(request, env, json) {
  const data = await readJson(request);
  const schoolYearId = data.schoolYearId;
  if (typeof schoolYearId !== 'string' || !ID_PATTERN.test(schoolYearId)) throw new RequestError('invalid_school_year');

  const context = await loadAuthorizationContext(request, env);
  if (!context) return json({ error: 'unauthenticated' }, 401);
  const actorId = context.session.user.id;
  let archiveVia = null;
  if (!isAuthorizedScoped(context, { roles: [...YEARLY_EXPORT_ROLES], requireMfa: true, schoolYearId })) {
    archiveVia = await archiveReadVia(env.db, context, schoolYearId, ARCHIVE_EXPORT_ROLES);
    if (!archiveVia) return json({ error: 'forbidden' }, 403);
  }
  // #150 (SR-10, krok w górę): eksport roczny ujawnia pełne dane rodzin i
  // finansowe — rola/zakres dają dostęp, ale MFA musi być potwierdzone od
  // niedawna (nie tylko kiedyś w tej sesji). Sprawdzane PO roli/zakresie
  // (SR-07): brak dostępu to zawsze `forbidden`, niezależnie od wieku MFA.
  const staleCode = freshMfaForbiddenCode(context, MFA_STEP_UP_MAX_AGE_SECONDS);
  if (staleCode) return json({ error: staleCode }, 403);

  // #216: paczka trafia fragmentami do anonimowego pliku tymczasowego
  // (src/pg/export-spool.js), a nie do pamięci; wysyłka zaczyna się po COMMIT.
  const spool = await createExportSpool();
  let result;
  try {
    result = await env.db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      // #216: podwójne kliknięcie „Eksportuj” to były dwa niezależne, w pełni
      // symultaniczne przebiegi (pamięć i czas rosły dwukrotnie, dwa wiersze
      // export_runs). Blokada doradcza na (rok) — zwalnia się sama na
      // COMMIT/ROLLBACK tej transakcji — pozwala tylko jednemu przebiegowi
      // na raz; drugi dostaje 409 zamiast czekać (klient sam decyduje, czy ponowić).
      const lock = await tx.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked', [`rd_export:${schoolYearId}`]);
      if (!lock.rows[0].locked) throw new RequestError('export_in_progress', 409);
      // #216: budowa paczki idzie partiami przez kursor i oddaje pętlę zdarzeń;
      // przerwy między zapytaniami są krótkie, ale limit „idle in transaction”
      // (15 s w puli) podnosimy lokalnie dla tej jednej transakcji, żeby wolny
      // współdzielony vCPU nie zrywał eksportu w trakcie.
      await tx.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
      // Ponowienie transakcji (40001/40P01) zaczyna paczkę od zera.
      await spool.reset();
      const built = await buildYearlyExport(tx, schoolYearId, { sink: (chunk) => spool.write(chunk) });
      const runId = await recordRun(tx, {
        kind: 'yearly', schoolYearId, formatVersion: EXPORT_FORMAT_VERSION, actorId,
        sha256: built.manifestSha256, rowCounts: built.rowCounts,
      });
      // #133: dziennik odczytu w tej samej transakcji co eksport (strict).
      await recordDataAccess({ db: tx }, {
        actorId, accessKind: 'yearly_export', schoolYearId, outcome: 'ok',
        rowCount: Object.values(built.rowCounts ?? {}).reduce((sum, n) => sum + (Number(n) || 0), 0),
      }, { strict: true });
      if (archiveVia) {
        await recordArchiveRead(tx, { actorId, schoolYearId, viaSchoolYearId: archiveVia, route: 'exports.yearly' });
      }
      return { ...built, runId };
    });
  } catch (error) {
    await spool.discard();
    if (error instanceof ExportError && error.code === 'school_year_not_found') throw new RequestError('school_year_not_found', 404);
    throw error;
  }
  if (spool.size !== result.bodyBytes) {
    await spool.discard();
    throw new Error('export_spool_size_mismatch');
  }

  return attachment(spool.body(), `rd-eksport-${safeFilePart(schoolYearId)}-v${EXPORT_FORMAT_VERSION}.json`, {
    'X-Export-Run-Id': result.runId,
    'X-Export-Manifest-Sha256': result.manifestSha256,
    // Znany rozmiar: adapter Node przesyła odpowiedź strumieniowo, bez kopii w pamięci.
    'Content-Length': String(result.bodyBytes),
  });
}

async function exportClassRoster(request, env, url, json) {
  const classId = url.searchParams.get('classId');
  if (!classId || !ID_PATTERN.test(classId)) throw new RequestError('invalid_class');
  // #132: formaty czytelne dla człowieka (CSV, XLSX z src/pg/xlsx.js) obok
  // kanonicznego JSON (domyślny, zgodność wsteczna). Zakres ról, klasy i MFA
  // jest ten sam dla wszystkich formatów.
  const format = url.searchParams.get('format') ?? 'json';
  if (format !== 'json' && format !== 'csv' && format !== 'xlsx') throw new RequestError('invalid_format');

  // Najpierw zakres klasy: przedstawiciel innej klasy dostaje 403 niezależnie
  // od tego, czy klasa istnieje.
  const access = await authorize(request, env, { roles: [...ROSTER_ROLES], requireMfa: true, classId }, json);
  if (access.response) return access.response;
  const actorId = access.context.session.user.id;

  const result = await env.db.transaction(async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    let built;
    try {
      built = await buildClassRoster(tx, classId);
    } catch (error) {
      if (error instanceof ExportError && error.code === 'class_not_found') return { notFound: true };
      throw error;
    }
    // Drugi krok: zakres roku szkolnego klasy.
    if (!isAuthorized(access.context, { roles: [...ROSTER_ROLES], requireMfa: true, classId, schoolYearId: built.schoolYearId })) {
      return { forbidden: true };
    }
    const runId = await recordRun(tx, {
      kind: 'class_roster', schoolYearId: built.schoolYearId, classId, formatVersion: ROSTER_FORMAT_VERSION,
      actorId, sha256: built.sha256, rowCounts: built.rowCounts, format,
    });
    // #133: dziennik odczytu w tej samej transakcji co eksport (strict).
    await recordDataAccess({ db: tx }, {
      actorId, accessKind: 'class_roster_export', schoolYearId: built.schoolYearId, classId, outcome: 'ok',
      rowCount: Object.values(built.rowCounts ?? {}).reduce((sum, n) => sum + (Number(n) || 0), 0),
    }, { strict: true });
    return { ...built, runId };
  });
  if (result.notFound) {
    await recordDataAccess(env, { actorId, accessKind: 'class_roster_export', classId, outcome: 'not_found' });
    return json({ error: 'class_not_found' }, 404);
  }
  if (result.forbidden) return json({ error: 'forbidden' }, 403);

  if (format === 'csv') {
    const csv = buildClassRosterCsv(result.roster);
    return csvResponse(
      csv,
      `lista-klasy-${safeFilePart(result.roster.class.name)}-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.csv`,
      { 'X-Export-Run-Id': result.runId, 'X-Export-Manifest-Sha256': result.sha256 },
    );
  }
  if (format === 'xlsx') {
    return xlsxResponse(
      buildClassRosterXlsx(result.roster),
      `lista-klasy-${safeFilePart(result.roster.class.name)}-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.xlsx`,
      { 'X-Export-Run-Id': result.runId, 'X-Export-Manifest-Sha256': result.sha256 },
    );
  }
  return attachment(result.body, `rd-lista-klasy-${safeFilePart(classId)}-v${ROSTER_FORMAT_VERSION}.json`, {
    'X-Export-Run-Id': result.runId,
    'X-Export-Manifest-Sha256': result.sha256,
  });
}

export async function handle(request, env, url, json) {
  const isYearly = url.pathname === '/api/exports';
  const isRoster = url.pathname === '/api/exports/class-roster';
  if (!isYearly && !isRoster) return null;
  if (isYearly && request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  if (isRoster && request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
  // handlePgRequest sprawdza Origin wcześniej; tu powtórnie, gdyby moduł użyto samodzielnie.
  if (isYearly && !isSameOrigin(request)) return json({ error: 'invalid_origin' }, 403);

  try {
    if (isYearly) return await createYearlyExport(request, env, json);
    return await exportClassRoster(request, env, url, json);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.code }, error.status);
    throw error;
  }
}
