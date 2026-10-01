// Administracja kontami i przydziałami ról na PostgreSQL (issues #3, #4, #9).
// Prototyp — nie jest wdrożony i nie jest gotowy do pracy na danych rodzin.
//
//   GET  /api/admin/users?limit=&cursor=       lista z kursorem keyset (#159, docs/API.md)
//   POST /api/admin/users/{id}/disable          wyłącza konto i wycofuje wszystkie sesje
//   POST /api/admin/users/{id}/enable
//   POST /api/admin/users/{id}/revoke-sessions
//   POST /api/admin/users/{id}/password-reset   { ttlHours? } — jednorazowy token resetu hasła (zwracany raz); krok w górę MFA (#150)
//   POST /api/admin/users/{id}/mfa-reset        { confirm: "<id konta>" } — wyłącza MFA i kody odzyskiwania; krok w górę MFA (#150)
//        #146: konto z rolą admin/board/treasurer (poza resetem hasła WŁASNEGO konta)
//        nie dostaje tokenu/resetu od razu — odpowiedź 202 to wniosek, który zatwierdza
//        INNY administrator (POST /api/admin/account-requests/{id}/approve).
//   GET  /api/admin/account-requests?status=     wnioski o reset hasła/MFA kont chronionych (#146)
//   POST /api/admin/account-requests/{id}/approve  zatwierdza (nie wnioskodawca, nie właściciel konta) i wykonuje; krok w górę MFA
//   POST /api/admin/account-requests/{id}/reject   odrzuca lub wycofuje wniosek
//   GET  /api/admin/grant-requests?status=       wnioski o nadanie roli chronionej (#146)
//   POST /api/admin/grant-requests/{id}/approve  zatwierdza INNY administrator (nie wnioskodawca, nie adresat)
//        i wykonuje nadanie (przydział albo zaproszenie z tokenem, zwracanym raz); krok w górę MFA
//   POST /api/admin/grant-requests/{id}/reject   { reason?, confirmPersonalData? } — odrzuca lub wycofuje wniosek;
//        opcjonalny powód (0159) przez bramkę danych osobowych #152 (422 bez zapisu)
//   GET  /api/admin/grants?userId=&role=&schoolYearId=&classId=&status=&limit=&cursor=
//   POST /api/admin/grants                      { userId, role, classId?, schoolYearId?, expiresAt? } — krok w górę MFA (#150)
//        #146: rola admin/board/treasurer przy drugim aktywnym administratorze — 202 i wniosek
//        (src/pg/grant-requests.js); tak samo POST /invitations i …/reissue dla tych ról.
//        Bez drugiego administratora (pierwsze uruchomienie) — bezpośrednio + role_grant.four_eyes_waived.
//   POST /api/admin/grants/{id}/revoke
//   POST /api/admin/school-years/{id}/expire-grants   { confirm: "<id roku>" } — wygaszenie kadencji
//   GET  /api/admin/invitations?limit=&cursor=
//   POST /api/admin/invitations                 { email, role, classId?, schoolYearId?, ttlHours? }
//   POST /api/admin/invitations/{id}/revoke
//   POST /api/admin/invitations/{id}/reissue    wycofuje i tworzy nowe zaproszenie (#108); tylko oczekujące
//   POST /api/admin/invitation-batches/preview|apply  zaproszenia zbiorcze przedstawicieli z podglądem,
//        planDigest i Idempotency-Key (#108); krok w górę MFA; patrz src/pg/invitation-batch.js
//   GET  /api/admin/school-years                lata i klasy do formularzy
//   POST /api/admin/school-years                { id, label, startsOn, endsOn } — nowy rok szkolny (#78)
//   POST /api/admin/school-years/{id}/classes    { names: [...] } — nowe klasy roku (#78); bez usuwania
//   POST /api/admin/promotions/classes/preview|apply   kopiowanie klas roku wg jawnej mapy (#78); patrz src/pg/promotions.js
//   POST /api/admin/promotions/preview|apply           promocja uczniów z podglądem, planDigest i Idempotency-Key (#78)
//   GET  /api/admin/class-coverage?schoolYearId= obsada klas roku: przydziały, oczekujące zaproszenia, ostatnie logowanie (#108)
//   GET  /api/admin/audit?limit=&cursor=&domain=&actorId=&from=&to=&schoolYearId=
//        dziennik zdarzeń; bez `domain` — jak dotąd (zmiany kont i ról).
//        Z `domain` (access|security|finance|email|documents|year_close|families|
//        privacy|meetings|events|news; słownik shared/audit-actions.js) — akcje
//        tej domeny (#181). Każda domena ma listę ról z prawem odczytu
//        (dziś wyłącznie admin — D-08/D-09); inna rola: 403. `schoolYearId`
//        filtruje wg roku z metadanych, a starsze zdarzenia — wg roku obiektu (#174).
//        Metadane w odpowiedzi bez wolnego tekstu (auditMetadataForView).
//        Każde zdarzenie niesie `domain`; ukryte pola metadanych: `redactedFields`.
//        `access.denied` (od 0160, #184) niesie też `denialCount` — liczbę odmów
//        tego aktora dla tej metody i ścieżki w oknie 5 minut od zdarzenia.
//   GET  /api/admin/audit/entity/{entityType}/{entityId}
//        historia jednego obiektu (#181): payment_entry, ledger_entry,
//        reconciliation, email_campaign. 404, gdy obiekt nie istnieje. Wymaga
//        odczytu domeny obiektu (finance/email); zdarzenia innych domen, których
//        aktor nie może czytać, są pomijane.
//   GET  /api/admin/access-log?kind=&actorId=&householdId=&classId=&schoolYearId=&outcome=&from=&to=&limit=&cursor=
//        przegląd dziennika odczytu danych dzieci i opiekunów (#133): tylko do
//        odczytu, kursor (occurred_at, id) malejąco, BEZ danych osobowych i bez
//        e-maili członków Rady (aktor = identyfikator + bieżące role). Sam
//        zapisuje `access_log.viewed` (bez parametrów). Wyłącznie admin + MFA
//        (wariant zachowawczy do D-04/D-07/D-08/D-09; zarząd, skarbnik, KR,
//        dyrekcja i przedstawiciele: 403).
//   GET  /api/admin/data-requests?status=&kind=  rejestr żądań osób (RODO, #100)
//   POST /api/admin/data-requests                { kind, householdId?|guardianId?|studentId?, receivedOn, dueOn? }
//   POST /api/admin/data-requests/{id}/status     { status, decisionNoteRef? }
//   POST /api/admin/data-requests/{id}/export?format=json|csv
//        eksport danych jednej rodziny (src/pg/family-export.js, docs/DATA_REQUESTS.md):
//        tylko żądanie `access`/`portability` w stanie identity_verified/in_progress;
//        krok w górę MFA; wpis data_access_log (strict, na każde gospodarstwo zakresu)
//        i zdarzenie data_subject_request.exported w tej samej transakcji.
//
// #100 wariant zachowawczy: rejestr żądań, przejścia stanu (bez cofania, bez
// usuwania — patrz migracja 0068) i eksport danych jednej rodziny.
// Sprostowanie identyfikacyjne, ograniczenie przetwarzania (kampanie/kartki)
// i usunięcie/anonimizacja NIE są tu zaimplementowane — wymagają migracji i
// decyzji D-07 (kto przyjmuje, weryfikacja tożsamości, termin), D-04 (#91,
// mechanizm anonimizacji) i D-08/D-09 (kto czyta rejestr); do tego czasu odczyt
// i zapis są wyłącznie dla admina, jak reszta modułu.
//   GET  /api/admin/retention/preview           raport kandydatów do retencji (D-04, #91):
//                                                 wyłącznie liczności per kategoria i rok/rok szkolny
//                                                 + zarejestrowane polityki (`retention_policies`, bez PII).
//                                                 Nie usuwa ani nie anonimizuje żadnych danych — sam odczyt.
//   GET  /api/admin/anonymizations?limit=&cursor=  lista przebiegów anonimizacji (#91, `anonymization_runs`), od najnowszego:
//                                                 id, gospodarstwo, powód, żądanie osoby, id polityk, skrót planu, liczniki
//                                                 i suma, aktor, czas; kursor keyset (executed_at, id). Tylko identyfikatory
//                                                 i liczniki (to samo, co tabela) — bez imion, e-maili i tekstów.
//   POST /api/admin/anonymizations              { householdId, reasonCode, dataRequestId?, dryRun?, expectedPlanSha256?, confirm? }
//                                                 anonimizacja gospodarstwa z zachowaniem księgi i sum wpłat (#91);
//                                                 krok w górę MFA (#150). `dryRun` (domyślnie true) zwraca plan i
//                                                 planSha256 (liczniki, bez danych osobowych); wykonanie wymaga
//                                                 dryRun:false, confirm = id gospodarstwa i expectedPlanSha256 z podglądu.
//                                                 201 applied / 200 replayed (nic do zmiany) / 409 retention_policy_missing…
//
// Dostęp: wyłącznie rola `admin` z potwierdzonym MFA, także do odczytu.
// #181: docelowo domeny finance/email mają też role zarządu/skarbnika/kampanii
// (nie tylko admina) — zostaje to do decyzji D-08/D-09 (kto z zarządu i
// Komisji Rewizyjnej czyta które domeny); do tego czasu odczyt dziennika
// (listing i historia obiektu) jest wariantem zachowawczym: wyłącznie admin.
// Założenie do decyzji D-08/D-09: zarząd nie ma tu nawet odczytu, dopóki
// szkoła nie zatwierdzi macierzy kompetencji. Przyjęcie zaproszenia z hasłem:
// POST /api/invitations/accept (src/pg/routes/login.js).
//
// Każda zmiana i jej zdarzenie audytu powstają w jednej transakcji. Metadane
// audytu zawierają wyłącznie identyfikatory (bez e-maili i nazw). Zmiany
// przydziałów admina są serializowane blokadą doradczą, aby dwie równoległe
// operacje nie odebrały sobie nawzajem ostatniego dostępu administratora.

import {
  allowPendingRoles, CLASS_SCOPE_ROLES, insertInvitation, isoTimestamp, normalizeEmail, reissueInvitation, revokeInvitation,
  revokeUserSessions,
  revokeUserSessionsWith, ROLE_STATUS, ROLES,
} from '../auth.js';
import {
  freshMfaForbiddenCode, isAuthorizedScoped, logAccessDenied, MFA_STEP_UP_MAX_AGE_SECONDS, requireAccess,
} from '../authorization.js';
import { auditMetadataForView, insertAuditEvent } from '../audit.js';
import { AUDIT_DOMAINS, auditActionDomain, auditDomainActions, auditEventSource } from '../../../shared/audit-actions.js';
import { auditYearByObjectSql } from '../export.js';
import {
  adminResetMfa, issuePasswordReset, LoginError, PASSWORD_RESET_MAX_TTL_SECONDS, revokePasswordResetTokens,
} from '../login.js';
import {
  approveGrantRequest, grantApprovalMode, GrantRequestError, insertGrantRequest, isProtectedRole, listGrantRequests,
  recordFourEyesWaiver, rejectGrantRequest,
} from '../grant-requests.js';
import {
  approveRecoveryRequest, createRecoveryRequest, listRecoveryRequests, rejectRecoveryRequest, requiresRecoveryApproval,
} from '../account-recovery.js';
import { computeOpsStatus } from '../ops-status.js';
import { promotionAllowedMethods, PromotionError, routePromotions } from '../promotions.js';
import { invitationBatchAllowedMethods, routeInvitationBatches } from '../invitation-batch.js';
import {
  afterTimestampDescSql, afterTupleAscSql, cursorTimestampSql, decodeListCursor, pageOf, parseListLimit,
} from '../list-cursor.js';
import { DATA_ACCESS_KINDS, recordDataAccess } from '../data-access.js';
import {
  buildFamilyExport, buildFamilyExportCsv, EXPORTABLE_REQUEST_KINDS, EXPORTABLE_REQUEST_STATUSES,
  FAMILY_EXPORT_FORMAT_VERSION, FamilyExportError,
} from '../family-export.js';
import { csvResponse } from '../csv.js';
import { ANONYMIZATION_REASON_CODES, AnonymizationError, anonymizeHousehold } from '../anonymization.js';
import { createJsonReader } from '../input.js';

export const name = 'admin';

const PREFIX = '/api/admin/';
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_GRANT_YEARS = 3;
const MAX_LIST = 500;
// #159: listy administracyjne mają kursor keyset i jawny `truncated`; domyślna
// strona bez `limit` to jak dotąd MAX_LIST wierszy.
const LIST_LIMITS = { defaultLimit: MAX_LIST, maxLimit: MAX_LIST };
function failList(code) { throw new RequestError(code); }
function listLimit(url, options = LIST_LIMITS) { return parseListLimit(url.searchParams.get('limit'), options, failList); }
function listCursor(url, kind, scope) { return decodeListCursor(url.searchParams.get('cursor'), { kind, scope }, failList); }
const GRANT_STATUSES = new Set(['active', 'expired', 'revoked', 'all']);
// Stały klucz blokady doradczej dla zmian przydziałów (hashtext w SQL).
const ADMIN_LOCK_KEY = 'rd:role_grants';

class RequestError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// Wyjątek przerywający transakcję (ROLLBACK) z odpowiedzią dla klienta.
class Abort extends RequestError {}

function validId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function decodeId(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new RequestError('invalid_id');
  }
  if (!validId(decoded)) throw new RequestError('invalid_id');
  return decoded;
}

function optionalId(value, code) {
  if (value === undefined || value === null || value === '') return null;
  if (!validId(value)) throw new RequestError(code);
  return value;
}

const readJson = createJsonReader({
  maxBytes: MAX_BODY_BYTES,
  declaredLength: true,
  emptyBody: 'blank',
  error: (code, status) => new RequestError(code, status),
});

function readExpiresAt(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 40) throw new RequestError('invalid_expires_at');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new RequestError('invalid_expires_at');
  const now = Date.now();
  if (date.getTime() <= now) throw new RequestError('invalid_expires_at');
  if (date.getTime() > now + MAX_GRANT_YEARS * 366 * 24 * 3600 * 1000) throw new RequestError('invalid_expires_at');
  return date.toISOString();
}

function grantStatusSql(alias = 'g') {
  return `CASE WHEN ${alias}.revoked_at IS NOT NULL THEN 'revoked'
               WHEN ${alias}.expires_at IS NOT NULL AND ${alias}.expires_at <= now() THEN 'expired'
               ELSE 'active' END`;
}

const GRANT_COLUMNS = `g.id, g.user_id, g.role, g.class_id, g.school_year_id, g.expires_at,
  g.granted_at, g.granted_by, g.revoked_at, g.revoked_by, g.source_invitation_id,
  ${grantStatusSql('g')} AS status`;

function grantFromRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    role: row.role,
    classId: row.class_id ?? null,
    schoolYearId: row.school_year_id ?? null,
    expiresAt: isoTimestamp(row.expires_at),
    grantedAt: isoTimestamp(row.granted_at),
    grantedBy: row.granted_by ?? null,
    revokedAt: isoTimestamp(row.revoked_at),
    revokedBy: row.revoked_by ?? null,
    invitationId: row.source_invitation_id ?? null,
    status: row.status,
  };
}

function grantAuditMetadata(grant, extra = {}) {
  return { userId: grant.user_id, role: grant.role, classId: grant.class_id ?? null, schoolYearId: grant.school_year_id ?? null, ...extra };
}

async function lockGrantChanges(tx) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ADMIN_LOCK_KEY]);
}

// Ochrona przed zablokowaniem się: po zmianie wykonujący musi nadal mieć
// aktywny przydział admina. Wywoływane w transakcji — naruszenie cofa zmianę.
async function assertActorStillAdmin(tx, actorId) {
  const { rows } = await tx.query(
    `SELECT 1 FROM role_grants
      WHERE user_id = $1 AND role = 'admin' AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1`,
    [actorId],
  );
  if (!rows[0]) throw new Abort('last_admin_grant', 409);
}

// Rok i klasa muszą istnieć. Klasa bez roku dziedziczy rok klasy, aby
// przydział przedstawiciela podlegał wygaszeniu kadencji.
async function resolveScope(executor, { role, classId, schoolYearId }) {
  if (!ROLES.includes(role)) throw new RequestError('invalid_role');
  if (role === 'representative' && !classId) throw new RequestError('class_required');
  // #176: przydział klasowy dla roli bez żadnej trasy klasowej jest dziś ciche
  // „nic” (isAuthorizedScoped odfiltrowuje przydziały klasowe na trasach
  // ogólnoszkolnych, a klasowej trasy te role nie mają) — odrzucamy zamiast
  // milcząco zapisywać przydział, który niczego nie da.
  if (classId && !CLASS_SCOPE_ROLES.includes(role)) throw new RequestError('class_scope_not_supported', 422);
  let yearId = schoolYearId;
  if (classId) {
    const { rows } = await executor.query('SELECT school_year_id FROM classes WHERE id = $1', [classId]);
    if (!rows[0]) throw new RequestError('class_not_found', 422);
    if (yearId && yearId !== rows[0].school_year_id) throw new RequestError('class_not_in_school_year', 422);
    yearId = rows[0].school_year_id;
  }
  if (yearId) {
    const { rows } = await executor.query('SELECT 1 FROM school_years WHERE id = $1', [yearId]);
    if (!rows[0]) throw new RequestError('school_year_not_found', 422);
  }
  return { classId, schoolYearId: yearId };
}

// --- Użytkownicy -----------------------------------------------------------

async function listUsers(env, url, json) {
  const limit = listLimit(url);
  const cursor = listCursor(url, 'text', 'users');
  const values = [];
  // Kursor niesie tylko id konta (adres e-mail nie trafia do URL-a ani logów dostępu);
  // pozycję w kolejności (lower(email), id) odczytujemy z bazy.
  const after = cursor
    ? (values.push(cursor.id), 'WHERE (lower(u.email), u.id) > (SELECT lower(p.email), p.id FROM users p WHERE p.id = $1)')
    : '';
  // Adres i nazwa wyświetlana to jedyne dane osobowe w module (potrzebne
  // administratorowi do rozpoznania konta). Nie łączymy z danymi rodzin.
  const { rows } = await env.db.query(
    `SELECT u.id, u.email, u.display_name, u.disabled_at, u.created_at,
            (SELECT count(*)::int FROM role_grants g
              WHERE g.user_id = u.id AND g.revoked_at IS NULL
                AND (g.expires_at IS NULL OR g.expires_at > now())) AS active_grants,
            (SELECT count(*)::int FROM sessions s
              WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions,
            EXISTS (SELECT 1 FROM user_mfa_factors f
                     WHERE f.user_id = u.id AND f.confirmed_at IS NOT NULL AND f.disabled_at IS NULL) AS mfa_enrolled
       FROM users u
      ${after}
      ORDER BY lower(u.email), u.id
      LIMIT ${limit + 1}`,
    values,
  );
  const page = pageOf(rows, limit, (row) => ({ key: row.id, id: row.id }), 'users');
  return json({
    nextCursor: page.nextCursor,
    truncated: page.truncated,
    limit: page.limit,
    users: page.items.map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      disabledAt: isoTimestamp(row.disabled_at),
      createdAt: isoTimestamp(row.created_at),
      mfaEnrolled: Boolean(row.mfa_enrolled),
      activeGrants: Number(row.active_grants),
      activeSessions: Number(row.active_sessions),
    })),
  });
}

async function setUserDisabled(env, actorId, userId, disabled, json) {
  if (disabled && userId === actorId) throw new RequestError('cannot_disable_self', 409);
  // disabled_at i trwałe wycofanie sesji (revoked_at) muszą zatwierdzić się
  // razem. Osobna, późniejsza transakcja mogła (#256) zawieść już po
  // zapisaniu disabled_at: loadSession i tak odrzucał sesję po disabled_at,
  // więc błąd był niewidoczny — ale sesje zostawały w bazie z
  // revoked_at IS NULL i po ponownym włączeniu konta znów były akceptowane
  // aż do wygaśnięcia TTL. Jedna transakcja usuwa to okno.
  const { changed, revokedSessions } = await env.db.transaction(async (tx) => {
    const { rows: existing } = await tx.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!existing[0]) throw new Abort('user_not_found', 404);
    const { rows } = await tx.query(
      disabled
        ? 'UPDATE users SET disabled_at = now() WHERE id = $1 AND disabled_at IS NULL RETURNING id'
        : 'UPDATE users SET disabled_at = NULL WHERE id = $1 AND disabled_at IS NOT NULL RETURNING id',
      [userId],
    );
    if (!rows[0]) return { changed: false, revokedSessions: 0 };
    await insertAuditEvent(tx, {
      actorId, action: disabled ? 'user.disabled' : 'user.enabled', entityType: 'user', entityId: userId,
    });
    // Po ponownym włączeniu konta stary token resetu nie może znów zadziałać (#193).
    if (disabled) await revokePasswordResetTokens(tx, { userId, actorId, reason: 'user_disabled' });
    const revoked = disabled ? await revokeUserSessionsWith(tx, { userId, actorId, reason: 'user_disabled' }) : 0;
    return { changed: true, revokedSessions: revoked };
  });
  return json({ userId, disabled, changed, revokedSessions });
}

async function revokeSessionsOf(env, actorId, userId, json) {
  const { rows } = await env.db.query('SELECT 1 FROM users WHERE id = $1', [userId]);
  if (!rows[0]) throw new RequestError('user_not_found', 404);
  const revokedSessions = await revokeUserSessions(env, { userId, actorId, reason: 'admin' });
  return json({ userId, revokedSessions });
}

// Token resetu hasła: zwracany wyłącznie tutaj, jeden raz (baza ma tylko skrót).
// Operator przekazuje go osobnym, zaufanym kanałem — moduł nie wysyła e-maili
// (szablon i nadawca to decyzje D-16/D-17). Nowy token unieważnia poprzedni.
async function passwordResetRoute(env, actorId, userId, request, json) {
  const data = await readJson(request);
  let ttlSeconds;
  if (data.ttlHours !== undefined && data.ttlHours !== null && data.ttlHours !== '') {
    if (!Number.isInteger(data.ttlHours) || data.ttlHours < 1 || data.ttlHours * 3600 > PASSWORD_RESET_MAX_TTL_SECONDS) {
      throw new RequestError('invalid_ttl');
    }
    ttlSeconds = data.ttlHours * 3600;
  }
  try {
    // #146: konto z rolą chronioną — tylko wniosek, token wyda drugi administrator.
    if (await requiresRecoveryApproval(env, { actorId, userId, kind: 'password_reset' })) {
      return json(await createRecoveryRequest(env, { actorId, userId, kind: 'password_reset', ttlSeconds }), 202);
    }
    const reset = await issuePasswordReset(env, { actorId, userId, ttlSeconds });
    return json({ reset: { id: reset.resetId, userId, expiresAt: reset.expiresAt }, token: reset.secret }, 201);
  } catch (error) {
    if (error instanceof LoginError) throw new RequestError(error.code, error.status);
    throw error;
  }
}

// Utrata telefonu i kodów odzyskiwania. Wymaga wpisania identyfikatora konta.
async function mfaResetRoute(env, actorId, userId, request, json) {
  const data = await readJson(request);
  if (data.confirm !== userId) throw new RequestError('confirmation_required');
  try {
    if (actorId !== userId && await requiresRecoveryApproval(env, { actorId, userId, kind: 'mfa_reset' })) {
      return json(await createRecoveryRequest(env, { actorId, userId, kind: 'mfa_reset' }), 202);
    }
    return json(await adminResetMfa(env, { actorId, userId }));
  } catch (error) {
    if (error instanceof LoginError) throw new RequestError(error.code, error.status);
    throw error;
  }
}

// --- Wnioski o reset hasła/MFA kont chronionych (#146) ---------------------

async function recoveryRequestsList(env, url, json) {
  const status = url.searchParams.get('status') || 'pending';
  try {
    return json(await listRecoveryRequests(env, { status }));
  } catch (error) {
    if (error instanceof LoginError) throw new RequestError(error.code, error.status);
    throw error;
  }
}

async function recoveryRequestDecision(env, actorId, requestId, decision, json) {
  try {
    if (decision === 'approve') return json(await approveRecoveryRequest(env, { actorId, requestId }), 200);
    return json(await rejectRecoveryRequest(env, { actorId, requestId }), 200);
  } catch (error) {
    if (error instanceof LoginError) throw new RequestError(error.code, error.status);
    throw error;
  }
}

// --- Przydziały ról --------------------------------------------------------

async function listGrants(env, url, json) {
  const params = url.searchParams;
  const userId = optionalId(params.get('userId'), 'invalid_user_id');
  const classId = optionalId(params.get('classId'), 'invalid_class_id');
  const schoolYearId = optionalId(params.get('schoolYearId'), 'invalid_school_year_id');
  const role = params.get('role') || null;
  if (role && !ROLES.includes(role)) throw new RequestError('invalid_role');
  const status = params.get('status') || 'active';
  if (!GRANT_STATUSES.has(status)) throw new RequestError('invalid_status');

  const conditions = [];
  const values = [];
  const add = (sql, value) => { values.push(value); conditions.push(sql.replace('?', `$${values.length}`)); };
  if (userId) add('g.user_id = ?', userId);
  if (classId) add('g.class_id = ?', classId);
  if (schoolYearId) add('g.school_year_id = ?', schoolYearId);
  if (role) add('g.role = ?', role);
  if (status !== 'all') add(`${grantStatusSql('g')} = ?`, status);
  const limit = listLimit(url);
  // Kursor wiąże filtr (użytkownik, klasa, rok, rola, status) — inny filtr → 400 invalid_cursor.
  const scope = JSON.stringify(['grants', userId, classId, schoolYearId, role, status]);
  const cursor = listCursor(url, 'timestamp', scope);
  if (cursor) conditions.push(afterTimestampDescSql('g.granted_at', 'g.id', cursor, values));
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await env.db.query(
    `SELECT ${GRANT_COLUMNS}, ${cursorTimestampSql('g.granted_at')} AS cursor_ts
       FROM role_grants g ${where}
      ORDER BY g.granted_at DESC, g.id
      LIMIT ${limit + 1}`,
    values,
  );
  const page = pageOf(rows, limit, (row) => ({ key: row.cursor_ts, id: row.id }), scope);
  return json({
    grants: page.items.map(grantFromRow), nextCursor: page.nextCursor, truncated: page.truncated, limit: page.limit,
  });
}

async function createGrant(env, actorId, request, json) {
  const data = await readJson(request);
  if (!validId(data.userId)) throw new RequestError('invalid_user_id');
  // #146: samonadanie roli (np. admin nadaje sobie treasurer/board) omija zasadę
  // czterech oczu wymaganą wszędzie indziej dla ważnych decyzji. Odrzucamy przed
  // transakcją: żaden wiersz nie powstaje, żadne zdarzenie audytu się nie zapisuje.
  if (data.userId === actorId) throw new RequestError('cannot_grant_self', 409);
  const role = data.role;
  const classId = optionalId(data.classId, 'invalid_class_id');
  const schoolYearIdInput = optionalId(data.schoolYearId, 'invalid_school_year_id');
  const expiresAt = readExpiresAt(data.expiresAt);

  const result = await env.db.transaction(async (tx) => {
    await lockGrantChanges(tx);
    const scope = await resolveScope(tx, { role, classId, schoolYearId: schoolYearIdInput });
    await lockGrantTarget(tx, data.userId);
    // #146: rola chroniona (admin/board/treasurer) — tylko wniosek, przydział
    // powstanie po zatwierdzeniu przez innego administratora. Decyzja zapada pod
    // blokadą zmian przydziałów, więc równoległe nadanie nie zmienia jej w trakcie.
    const mode = await grantApprovalMode(tx, { actorId, role, targetUserId: data.userId });
    if (mode === 'request') {
      const duplicate = await findActiveGrant(tx, { userId: data.userId, role, ...scope });
      if (duplicate) return { grant: duplicate, created: false };
      return { ...await insertGrantRequest(tx, {
        actorId, kind: 'grant', role, targetUserId: data.userId, schoolYearId: scope.schoolYearId, grantExpiresAt: expiresAt,
      }), pending: true };
    }
    const created = await insertGrantInTx(tx, actorId, { userId: data.userId, role, ...scope, expiresAt });
    if (mode === 'waived' && created.created) {
      await recordFourEyesWaiver(tx, {
        actorId, entityType: 'role_grant', entityId: created.grant.id, role, userId: data.userId, schoolYearId: scope.schoolYearId,
      });
    }
    return created;
  }).catch((error) => {
    if (error instanceof GrantRequestError) throw new RequestError(error.code, error.status);
    throw error;
  });
  if (result.pending) {
    const { pending, ...body } = result;
    return json(body, 202);
  }
  return json(result, result.created ? 201 : 200);
}

async function lockGrantTarget(tx, userId) {
  const { rows: users } = await tx.query('SELECT id, disabled_at FROM users WHERE id = $1 FOR UPDATE', [userId]);
  if (!users[0]) throw new Abort('user_not_found', 404);
  if (users[0].disabled_at) throw new Abort('user_disabled', 409);
}

async function findActiveGrant(tx, { userId, role, classId, schoolYearId }) {
  const { rows } = await tx.query(
    `SELECT ${GRANT_COLUMNS} FROM role_grants g
      WHERE g.user_id = $1 AND g.role = $2
        AND g.class_id IS NOT DISTINCT FROM $3 AND g.school_year_id IS NOT DISTINCT FROM $4
        AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())
      LIMIT 1`,
    [userId, role, classId ?? null, schoolYearId ?? null],
  );
  return rows[0] ? grantFromRow(rows[0]) : null;
}

// Zapis przydziału i zdarzenia `role_grant.created` w transakcji wywołującego
// (po lockGrantChanges i lockGrantTarget). `auditExtra` — np. requestId,
// requestedBy przy zatwierdzeniu wniosku (#146).
async function insertGrantInTx(tx, actorId, { userId, role, classId = null, schoolYearId = null, expiresAt = null, auditExtra = {} }) {
  // Podwójne kliknięcie: identyczny aktywny przydział nie powstaje drugi raz.
  const duplicate = await findActiveGrant(tx, { userId, role, classId, schoolYearId });
  if (duplicate) return { grant: duplicate, created: false };

  const grantId = crypto.randomUUID();
  let rows;
  try {
    ({ rows } = await tx.query(
      `INSERT INTO role_grants AS g (id, user_id, role, class_id, school_year_id, expires_at, granted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${GRANT_COLUMNS}`,
      [grantId, userId, role, classId, schoolYearId, expiresAt, actorId],
    ));
  } catch (error) {
    // Trigger zamrożenia (0017/0022): rok zamknięty to konflikt, nie awaria.
    if (error?.message === 'school_year_closed') throw new Abort('school_year_closed', 409);
    if (error?.message === 'class_not_in_school_year') throw new Abort('class_not_in_school_year', 422);
    throw error;
  }
  await insertAuditEvent(tx, {
    actorId, action: 'role_grant.created', entityType: 'role_grant', entityId: grantId,
    metadata: grantAuditMetadata(rows[0], { expiresAt, ...auditExtra }),
  });
  return { grant: grantFromRow(rows[0]), created: true };
}

async function revokeGrant(env, actorId, grantId, json) {
  const result = await env.db.transaction(async (tx) => {
    await lockGrantChanges(tx);
    const { rows: existing } = await tx.query(`SELECT ${GRANT_COLUMNS} FROM role_grants g WHERE g.id = $1 FOR UPDATE`, [grantId]);
    if (!existing[0]) throw new Abort('grant_not_found', 404);
    if (existing[0].revoked_at) return { grant: grantFromRow(existing[0]), changed: false };
    const { rows } = await tx.query(
      `UPDATE role_grants AS g SET revoked_at = now(), revoked_by = $2
        WHERE g.id = $1 AND g.revoked_at IS NULL
        RETURNING ${GRANT_COLUMNS}`,
      [grantId, actorId],
    );
    await insertAuditEvent(tx, {
      actorId, action: 'role_grant.revoked', entityType: 'role_grant', entityId: grantId,
      metadata: grantAuditMetadata(rows[0]),
    });
    await assertActorStillAdmin(tx, actorId);
    return { grant: grantFromRow(rows[0]), changed: true };
  });
  return json(result);
}

// Wygaszenie kadencji: wszystkie aktywne przydziały zakończonego roku
// szkolnego (także przydziały klas tego roku bez wpisanego roku) dostają
// expires_at = now(). Wiersze zostają; każdy ma zdarzenie role_grant.expired.
async function expireSchoolYear(env, actorId, schoolYearId, request, json) {
  const data = await readJson(request);
  if (data.confirm !== schoolYearId) throw new RequestError('confirmation_required');
  const result = await env.db.transaction(async (tx) => {
    await lockGrantChanges(tx);
    const { rows: years } = await tx.query(
      'SELECT id, ends_on < current_date AS finished FROM school_years WHERE id = $1',
      [schoolYearId],
    );
    if (!years[0]) throw new Abort('school_year_not_found', 404);
    if (!years[0].finished) throw new Abort('school_year_not_finished', 409);
    const { rows } = await tx.query(
      `UPDATE role_grants AS g SET expires_at = now()
        WHERE g.revoked_at IS NULL
          AND (g.expires_at IS NULL OR g.expires_at > now())
          AND role_grant_in_school_year(g.class_id, g.school_year_id, $1)
        RETURNING g.id, g.user_id, g.role, g.class_id, g.school_year_id`,
      [schoolYearId],
    );
    for (const row of rows) {
      await insertAuditEvent(tx, {
        actorId, action: 'role_grant.expired', entityType: 'role_grant', entityId: row.id,
        metadata: grantAuditMetadata(row, { reason: 'term_closed' }),
      });
    }
    await insertAuditEvent(tx, {
      actorId, action: 'school_year.grants_expired', entityType: 'school_year', entityId: schoolYearId,
      metadata: { count: rows.length },
    });
    await assertActorStillAdmin(tx, actorId);
    return { schoolYearId, expired: rows.length, grantIds: rows.map((row) => row.id) };
  });
  return json(result);
}

// --- Zaproszenia -----------------------------------------------------------

function invitationFromRow(row) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    classId: row.class_id ?? null,
    schoolYearId: row.school_year_id ?? null,
    createdBy: row.created_by,
    createdAt: isoTimestamp(row.created_at),
    expiresAt: isoTimestamp(row.expires_at),
    acceptedAt: isoTimestamp(row.accepted_at),
    revokedAt: isoTimestamp(row.revoked_at),
    status: row.status,
  };
}

const INVITATION_COLUMNS = `i.id, i.email, i.role, i.class_id, i.school_year_id, i.created_by, i.created_at,
  i.expires_at, i.accepted_at, i.revoked_at,
  CASE WHEN i.accepted_at IS NOT NULL THEN 'accepted'
       WHEN i.revoked_at IS NOT NULL THEN 'revoked'
       WHEN i.expires_at <= now() THEN 'expired'
       ELSE 'pending' END AS status`;

async function listInvitations(env, url, json) {
  const limit = listLimit(url);
  const cursor = listCursor(url, 'timestamp', 'invitations');
  const values = [];
  const where = cursor ? `WHERE ${afterTimestampDescSql('i.created_at', 'i.id', cursor, values)}` : '';
  const { rows } = await env.db.query(
    `SELECT ${INVITATION_COLUMNS}, ${cursorTimestampSql('i.created_at')} AS cursor_ts
       FROM invitations i ${where}
      ORDER BY i.created_at DESC, i.id LIMIT ${limit + 1}`,
    values,
  );
  const page = pageOf(rows, limit, (row) => ({ key: row.cursor_ts, id: row.id }), 'invitations');
  return json({
    invitations: page.items.map(invitationFromRow), nextCursor: page.nextCursor, truncated: page.truncated,
    limit: page.limit,
  });
}

async function createInvitationRoute(env, actorId, request, json) {
  const data = await readJson(request);
  const classId = optionalId(data.classId, 'invalid_class_id');
  const schoolYearIdInput = optionalId(data.schoolYearId, 'invalid_school_year_id');
  let ttlSeconds;
  if (data.ttlHours !== undefined && data.ttlHours !== null && data.ttlHours !== '') {
    if (!Number.isInteger(data.ttlHours) || data.ttlHours < 1 || data.ttlHours > 24 * 14) throw new RequestError('invalid_ttl');
    ttlSeconds = data.ttlHours * 3600;
  }
  if (typeof data.email !== 'string') throw new RequestError('invalid_email');
  const email = data.email.trim().toLowerCase();
  // #146: zaproszenie na WŁASNY adres i jego przyjęcie własnym hasłem nadawało
  // rolę bez drugiej osoby — to samo samonadanie, które POST /grants odrzuca.
  // Odrzucamy przed zapisem (bez zaproszenia i zdarzenia audytu); przyjęcie
  // sprawdza to jeszcze raz (src/pg/auth.js, src/pg/login.js).
  const { rows: self } = await env.db.query('SELECT 1 FROM users WHERE id = $1 AND lower(email) = $2', [actorId, email]);
  if (self[0]) throw new RequestError('cannot_grant_self', 409);
  // #176: rola bez żadnej trasy chronionej dziś (`pending_decision`, np. principal)
  // tworzy konto z danymi osobowymi bez celu (D-01/D-06) — odrzucamy, chyba że
  // ALLOW_PENDING_ROLES=true (przygotowanie kont z wyprzedzeniem przed D-09, testy).
  if (ROLE_STATUS[data.role] === 'pending_decision' && !allowPendingRoles(env)) {
    throw new RequestError('role_pending_decision', 422);
  }
  const scope = await resolveScope(env.db, { role: data.role, classId, schoolYearId: schoolYearIdInput });

  // Podwójne kliknięcie: drugie zaproszenie o tym samym zakresie dla adresu,
  // który ma już oczekujące zaproszenie, jest odrzucane (token nie wraca drugi raz).
  // Sprawdzenie jest w transakcji zapisu, pod blokadą adresu (rejectPending, #208).
  let created;
  try {
    const normalized = normalizeEmail(email);
    // #146: zaproszenie do roli chronionej to też nadanie roli (w chwili
    // przyjęcia) — przy drugim administratorze tylko wniosek, bez tokenu.
    created = await env.db.transaction(async (tx) => {
      // Blokada zmian przydziałów tylko dla roli chronionej (decyzja o wniosku);
      // zaproszenie innej roli serializuje wyłącznie blokada adresu w insertInvitation.
      if (isProtectedRole(data.role)) await lockGrantChanges(tx);
      const mode = await grantApprovalMode(tx, { actorId, role: data.role, targetEmail: normalized });
      if (mode === 'request') {
        return { ...await insertGrantRequest(tx, {
          actorId, kind: 'invitation', role: data.role, targetEmail: normalized, schoolYearId: scope.schoolYearId,
          invitationTtlSeconds: ttlSeconds ?? null,
        }), pending: true };
      }
      const inserted = await insertInvitation(tx, {
        actorId, email: normalized, role: data.role, classId: scope.classId, schoolYearId: scope.schoolYearId,
        ...(ttlSeconds ? { ttlSeconds } : {}), rejectPending: true,
      });
      if (mode === 'waived') {
        await recordFourEyesWaiver(tx, {
          actorId, entityType: 'invitation', entityId: inserted.invitationId, role: data.role, schoolYearId: scope.schoolYearId,
        });
      }
      return inserted;
    });
  } catch (error) {
    if (error instanceof GrantRequestError) throw new RequestError(error.code, error.status);
    if (error?.message === 'invitation_pending') throw new RequestError('invitation_pending', 409);
    if (['invalid_email', 'invalid_role', 'class_required'].includes(error?.message)) throw new RequestError(error.message);
    if (error?.message === 'class_not_in_school_year') throw new RequestError(error.message, 422);
    if (error?.message === 'school_year_closed') throw new RequestError('school_year_closed', 409);
    throw error;
  }
  if (created.pending) {
    const { pending, ...body } = created;
    return json(body, 202);
  }
  // Token zwracany jest wyłącznie tutaj, jeden raz. Baza ma tylko jego skrót.
  // Operator przekazuje go osobnym kanałem; moduł nie wysyła e-maili.
  return json({
    invitation: {
      id: created.invitationId, email, role: data.role, classId: scope.classId,
      schoolYearId: scope.schoolYearId, expiresAt: created.expiresAt, status: 'pending',
    },
    token: created.secret,
  }, 201);
}

async function revokeInvitationRoute(env, actorId, invitationId, json) {
  const { rows } = await env.db.query(`SELECT ${INVITATION_COLUMNS} FROM invitations i WHERE i.id = $1`, [invitationId]);
  if (!rows[0]) throw new RequestError('invitation_not_found', 404);
  if (rows[0].accepted_at) throw new RequestError('invitation_already_accepted', 409);
  const changed = await revokeInvitation(env, { invitationId, actorId });
  return json({ invitationId, changed });
}

// --- Konfiguracja roku (#78) ------------------------------------------------
// Założenie do decyzji D-08: dopóki zarząd nie ma odczytu w tym module (patrz
// nagłówek pliku), tworzenie roku i klas zostaje wyłącznie przy adminie —
// wariant zachowawczy węższy niż propozycja z issue (admin, zarząd).
// Usuwanie klas i lat nie ma trasy (AC issue #78: brak drogi do usunięcia
// klasy z przypisaniami) — korekta to nowa klasa i przeniesienie uczniów.

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function slugify(name) {
  return String(name).trim().toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function createSchoolYear(env, actorId, request, json) {
  const data = await readJson(request);
  if (!validId(data.id)) throw new RequestError('invalid_id');
  const label = typeof data.label === 'string' ? data.label.trim() : '';
  if (!label || label.length > 200) throw new RequestError('invalid_label');
  if (!validDate(data.startsOn) || !validDate(data.endsOn)) throw new RequestError('invalid_date');
  if (data.endsOn < data.startsOn) throw new RequestError('invalid_date_range');
  const result = await env.db.transaction(async (tx) => {
    const existing = await tx.query('SELECT 1 FROM school_years WHERE id = $1 OR label = $2', [data.id, label]);
    if (existing.rows.length) throw new Abort('school_year_exists', 409);
    await tx.query(
      'INSERT INTO school_years (id, label, starts_on, ends_on) VALUES ($1, $2, $3, $4)',
      [data.id, label, data.startsOn, data.endsOn],
    );
    await insertAuditEvent(tx, {
      actorId, action: 'school_year.created', entityType: 'school_year', entityId: data.id,
      metadata: { startsOn: data.startsOn, endsOn: data.endsOn },
    });
    return { id: data.id, label, startsOn: data.startsOn, endsOn: data.endsOn };
  });
  return json({ schoolYear: result }, 201);
}

async function createClasses(env, actorId, schoolYearId, request, json) {
  const data = await readJson(request);
  if (!Array.isArray(data.names) || !data.names.length || data.names.length > 100) {
    throw new RequestError('invalid_names');
  }
  const names = [];
  const seen = new Set();
  for (const raw of data.names) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name || name.length > 60) throw new RequestError('invalid_names');
    const key = name.toLowerCase();
    if (seen.has(key)) throw new RequestError('duplicate_name');
    seen.add(key);
    names.push(name);
  }
  const result = await env.db.transaction(async (tx) => {
    const year = await tx.query('SELECT id FROM school_years WHERE id = $1', [schoolYearId]);
    if (!year.rows[0]) throw new Abort('school_year_not_found', 404);
    const existing = await tx.query('SELECT name FROM classes WHERE school_year_id = $1', [schoolYearId]);
    const existingNames = new Set(existing.rows.map((row) => row.name.toLowerCase()));
    const created = [];
    const usedIds = new Set();
    for (const name of names) {
      if (existingNames.has(name.toLowerCase())) throw new Abort('class_exists', 409);
      let id = `${schoolYearId}-${slugify(name)}`;
      if (id === `${schoolYearId}-` || usedIds.has(id)) id = `${schoolYearId}-${crypto.randomUUID()}`;
      usedIds.add(id);
      await tx.query('INSERT INTO classes (id, school_year_id, name) VALUES ($1, $2, $3)', [id, schoolYearId, name]);
      await insertAuditEvent(tx, {
        actorId, action: 'class.created', entityType: 'class', entityId: id,
        metadata: { schoolYearId, name },
      });
      created.push({ id, name, schoolYearId });
    }
    return created;
  });
  return json({ classes: result }, 201);
}

// „Wyślij ponownie” (#108): wycofuje stare zaproszenie i tworzy nowe o tym
// samym zakresie (token wraca raz, jak przy utworzeniu). Tylko dla zaproszeń
// wciąż oczekujących — przyjęte, wygasłe lub już wycofane nie mają tu drogi
// (nowe zaproszenie od zera przez POST /api/admin/invitations). Wycofanie i
// nowe zaproszenie w jednej transakcji pod blokadą adresu (reissueInvitation
// w src/pg/auth.js, #293/#576).
async function reissueInvitationRoute(env, actorId, invitationId, json) {
  // #146: nowy token dla roli chronionej daje tę rolę temu, kto go użyje —
  // przy drugim administratorze tylko wniosek; stare zaproszenie działa do
  // zatwierdzenia (wtedy jest wycofywane w tej samej transakcji, pod blokadą adresu).
  const { rows } = await env.db.query(`SELECT ${INVITATION_COLUMNS} FROM invitations i WHERE i.id = $1`, [invitationId]);
  const invitation = rows[0];
  if (!invitation) throw new RequestError('invitation_not_found', 404);
  if (invitation.status === 'pending' && isProtectedRole(invitation.role)) {
    const email = String(invitation.email).toLowerCase();
    const pending = await env.db.transaction(async (tx) => {
      await lockGrantChanges(tx);
      if (await grantApprovalMode(tx, { actorId, role: invitation.role, targetEmail: email }) !== 'request') return null;
      return insertGrantRequest(tx, {
        actorId, kind: 'invitation', role: invitation.role, targetEmail: email,
        schoolYearId: invitation.school_year_id ?? null, replacesInvitationId: invitationId,
      });
    }).catch((error) => {
      if (error instanceof GrantRequestError) throw new RequestError(error.code, error.status);
      throw error;
    });
    if (pending) return json(pending, 202);
  }
  let created;
  try {
    created = await reissueInvitation(env, { actorId, invitationId });
  } catch (error) {
    // rejectPending w insertInvitation: inne oczekujące zaproszenie o tym samym zakresie.
    if (error?.message === 'invitation_pending') throw new RequestError('invitation_pending', 409);
    throw error;
  }
  if (created.error === 'invitation_not_found') throw new RequestError('invitation_not_found', 404);
  if (created.error) throw new RequestError(created.error, 409);
  return json({
    invitation: {
      id: created.invitationId, email: created.email, role: created.role,
      classId: created.classId, schoolYearId: created.schoolYearId,
      expiresAt: created.expiresAt, status: 'pending', replacesInvitationId: invitationId,
    },
    token: created.secret,
  }, 201);
}

// --- Wnioski o nadanie roli chronionej (#146) ---------------------------------

async function grantRequestsList(env, url, json) {
  try {
    return json(await listGrantRequests(env, { status: url.searchParams.get('status') || 'pending' }));
  } catch (error) {
    if (error instanceof GrantRequestError) throw new RequestError(error.code, error.status);
    throw error;
  }
}

// Wykonanie zatwierdzonego wniosku w transakcji zatwierdzenia (po blokadzie
// zmian przydziałów i wiersza wniosku). Przydział/zaproszenie wystawia
// zatwierdzający (granted_by/created_by); zdarzenia mają requestId i requestedBy.
async function executeGrantRequest(tx, actorId, row) {
  const auditExtra = { requestId: row.id, requestedBy: row.requested_by, approvedBy: actorId };
  if (row.kind === 'grant') {
    await lockGrantTarget(tx, row.target_user_id);
    if (row.grant_expires_at && new Date(row.grant_expires_at).getTime() <= Date.now()) {
      throw new Abort('invalid_expires_at', 409);
    }
    const created = await insertGrantInTx(tx, actorId, {
      userId: row.target_user_id, role: row.role, schoolYearId: row.school_year_id ?? null,
      expiresAt: row.grant_expires_at ? new Date(row.grant_expires_at).toISOString() : null, auditExtra,
    });
    return { resultId: created.grant.id, outcome: created };
  }
  if (row.replaces_invitation_id) {
    // Ta sama blokada adresu co reissueInvitation (#293) i insertInvitation.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rd:invitation:${row.target_email}`]);
    const { rows: old } = await tx.query(
      `UPDATE invitations SET revoked_at = now(), revoked_by = $2
        WHERE id = $1 AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at > now()
        RETURNING id`,
      [row.replaces_invitation_id, actorId],
    );
    if (!old[0]) throw new Abort('invitation_not_pending', 409);
    await insertAuditEvent(tx, {
      actorId, action: 'invitation.revoked', entityType: 'invitation', entityId: row.replaces_invitation_id,
      metadata: { reason: 'reissued', requestId: row.id },
    });
  }
  let created;
  try {
    created = await insertInvitation(tx, {
      actorId, email: row.target_email, role: row.role, classId: null, schoolYearId: row.school_year_id ?? null,
      ...(row.invitation_ttl_seconds ? { ttlSeconds: row.invitation_ttl_seconds } : {}),
      replacesInvitationId: row.replaces_invitation_id ?? null, rejectPending: true,
    });
  } catch (error) {
    if (error?.message === 'invitation_pending') throw new Abort('invitation_pending', 409);
    if (error?.message === 'school_year_closed') throw new Abort('school_year_closed', 409);
    throw error;
  }
  return {
    resultId: created.invitationId,
    outcome: {
      invitation: {
        id: created.invitationId, email: row.target_email, role: row.role, classId: null,
        schoolYearId: row.school_year_id ?? null, expiresAt: created.expiresAt, status: 'pending',
        ...(row.replaces_invitation_id ? { replacesInvitationId: row.replaces_invitation_id } : {}),
      },
      token: created.secret,
    },
  };
}

async function grantRequestDecision(env, actorId, requestId, decision, request, json) {
  try {
    if (decision === 'approve') {
      return json(await approveGrantRequest(env, {
        actorId, requestId, lockFirst: lockGrantChanges, execute: (tx, row) => executeGrantRequest(tx, actorId, row),
      }));
    }
    // Ciało opcjonalne (zgodność z klientami sprzed 0159): bez treści = bez powodu.
    const data = request.body === null && !request.headers.get('Content-Type') ? {} : await readJson(request);
    return json(await rejectGrantRequest(env, {
      actorId, requestId, reason: data.reason, confirmPersonalData: data.confirmPersonalData === true,
    }));
  } catch (error) {
    if (error instanceof GrantRequestError) {
      // #152: 422 bramki danych osobowych zwraca kategorie (bez fragmentu tekstu).
      throw Object.assign(new RequestError(error.code, error.status), error.categories ? { categories: error.categories } : {});
    }
    throw error;
  }
}

// Tabela obsady klas roku (#108): przydziały przedstawiciela aktywne dziś,
// oczekujące zaproszenia (bez tokenów) i data ostatniego logowania (bez
// godziny) przedstawiciela tej klasy — wyłącznie liczby i daty, bez e-maili.
function toSafeInteger(value) {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number)) throw new Error('unsafe_integer');
  return number;
}

async function classCoverage(env, url, json) {
  const schoolYearId = url.searchParams.get('schoolYearId');
  if (!validId(schoolYearId)) throw new RequestError('invalid_school_year_id');
  const year = await env.db.query('SELECT 1 FROM school_years WHERE id = $1', [schoolYearId]);
  if (!year.rows[0]) throw new RequestError('school_year_not_found', 404);
  const { rows } = await env.db.query(
    `SELECT c.id, c.name,
            (SELECT count(DISTINCT g.user_id) FROM role_grants g
               WHERE g.class_id = c.id AND g.role = 'representative'
                 AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())) AS active_count,
            (SELECT count(*) FROM invitations i
               WHERE i.class_id = c.id AND i.role = 'representative'
                 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()) AS pending_count,
            (SELECT min(i.expires_at) FROM invitations i
               WHERE i.class_id = c.id AND i.role = 'representative'
                 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()) AS next_expires_at,
            (SELECT to_char(max(s.created_at), 'YYYY-MM-DD') FROM sessions s
               JOIN role_grants g2 ON g2.user_id = s.user_id
              WHERE g2.class_id = c.id AND g2.role = 'representative'
                AND g2.revoked_at IS NULL AND (g2.expires_at IS NULL OR g2.expires_at > now())) AS last_login_on
       FROM classes c WHERE c.school_year_id = $1
       ORDER BY c.name, c.id`,
    [schoolYearId],
  );
  return json({
    schoolYearId,
    classes: rows.map((row) => ({
      id: row.id,
      name: row.name,
      activeRepresentativeCount: toSafeInteger(row.active_count),
      pendingInvitationCount: toSafeInteger(row.pending_count),
      nextInvitationExpiresAt: isoTimestamp(row.next_expires_at),
      lastRepresentativeLoginOn: row.last_login_on ?? null,
    })),
  });
}

// --- Słowniki i dziennik ---------------------------------------------------

async function listSchoolYears(env, json) {
  const { rows: years } = await env.db.query(
    `SELECT id, label, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on,
            ends_on < current_date AS finished
       FROM school_years ORDER BY starts_on DESC, id`,
  );
  const { rows: classes } = await env.db.query('SELECT id, school_year_id, name FROM classes ORDER BY school_year_id, name, id');
  return json({
    schoolYears: years.map((year) => ({
      id: year.id, label: year.label, startsOn: year.starts_on, endsOn: year.ends_on, finished: Boolean(year.finished),
      classes: classes.filter((item) => item.school_year_id === year.id).map((item) => ({ id: item.id, name: item.name })),
    })),
  });
}

export const AUDIT_ACTIONS = [
  'role_grant.created', 'role_grant.revoked', 'role_grant.expired', 'role_grant.school_year_backfilled',
  'school_year.grants_expired', 'school_year.created', 'class.created',
  'invitation.created', 'invitation.revoked', 'invitation.accepted', 'invitation.reissued', 'invitation.batch_created',
  'user.disabled', 'user.enabled', 'user.created', 'session.revoked',
  'auth.password_reset_issued', 'auth.password_reset_revoked', 'auth.password_reset_completed', 'auth.password_set',
  'auth.password_changed', 'auth.account_under_pressure', 'mfa.reset',
  'account_recovery.requested', 'account_recovery.approved', 'account_recovery.rejected', 'account_recovery.expired',
  'role_grant.four_eyes_waived', 'role_grant_request.requested', 'role_grant_request.approved',
  'role_grant_request.rejected', 'role_grant_request.expired',
];

// #181: domeny dziennika i etykiety akcji są w shared/audit-actions.js
// (AUDIT_DOMAINS, AUDIT_ACTION_CATALOG) — każda akcja zapisywana w src/pg/**
// i src/email/** ma tam dokładnie jedną domenę (test przekrojowy
// tests/audit-actions-catalog.test.js). Filtr `domain` to dokładna lista akcji
// domeny, nie przedrostki: rodziny `payment_reference.`, `payment_instructions.`,
// `ledger_category.`, `report.snapshot.`/`report.annual.` należą do `finance`
// (przedrostki z #181 cz. 1 ich nie obejmowały).
//
// Kontrola ról per domena (serwer): `readRoles` z AUDIT_DOMAINS. Wariant
// zachowawczy do D-08/D-09 — każda domena wyłącznie `admin`; bramka modułu
// (requireAccess admin + MFA) jest pierwszą linią, ta — drugą: zmiana
// `readRoles` po decyzji nie otworzy innych domen niż wskazane.
function canReadAuditDomain(context, domain) {
  // Akcja spoza słownika (np. stary wiersz o nazwie, której już nikt nie zapisuje)
  // nie ma domeny — widzi ją wyłącznie admin.
  const readRoles = domain === null ? ['admin'] : AUDIT_DOMAINS[domain]?.readRoles;
  return Boolean(readRoles?.length) && isAuthorizedScoped(context, { roles: readRoles });
}

// Domyślny widok (bez `domain`) = AUDIT_ACTIONS; wymaga odczytu każdej domeny,
// do której należą te akcje (dziś: access i security).
const DEFAULT_VIEW_DOMAINS = [...new Set(AUDIT_ACTIONS.map((action) => auditActionDomain(action)))];

// #184 etap 3: odmowa domeny to odmowa roli (`readRoles`), więc zostawia ten
// sam ślad `access.denied` co bramka modułu — przed jakimkolwiek odczytem,
// poza transakcją (listAudit/entityAudit jej nie otwierają). Dziś każda domena
// ma `readRoles: ['admin']`, a moduł wpuszcza tylko admina, więc gałąź jest
// nieosiągalna przez HTTP; ślad zaczyna działać dopiero, gdy decyzja D-08/D-09
// zawęzi `readRoles` domeny bez admina. Odpowiedź 403 `forbidden` bez zmian.
// Eksport wyłącznie dla testu tests/pg-access-denied.test.js.
export async function requireAuditDomains(env, request, context, domains) {
  const denied = domains.find((domain) => !canReadAuditDomain(context, domain));
  if (denied === undefined) return;
  const readRoles = AUDIT_DOMAINS[denied]?.readRoles ?? ['admin'];
  await logAccessDenied(env, context, { roles: [...readRoles] }, request);
  throw new RequestError('forbidden', 403);
}

export function auditEventForView(row, { withEntity = true } = {}) {
  const { metadata, redactedFields } = auditMetadataForView(row.metadata_json ?? {});
  const event = {
    id: row.id, actorId: row.actor_id ?? null, action: row.action, domain: auditActionDomain(row.action),
    // #181 pkt 3: zdarzenia bez aktora rozróżnione pochodną z akcji (bez migracji).
    ...auditEventSource(row.action, row.actor_id, row.metadata_json ?? {}),
  };
  if (withEntity) Object.assign(event, { entityType: row.entity_type, entityId: row.entity_id });
  // #184: `access.denied` — liczba odmów w oknie 5 minut od tego zdarzenia (0160).
  if (row.denial_count != null) event.denialCount = Number(row.denial_count);
  return { ...event, occurredAt: isoTimestamp(row.occurred_at), metadata, redactedFields };
}

function parseAuditFilters(url) {
  const domain = url.searchParams.get('domain');
  if (domain !== null && !Object.hasOwn(AUDIT_DOMAINS, domain)) throw new RequestError('invalid_domain');
  const actorId = optionalId(url.searchParams.get('actorId'), 'invalid_actor_id');
  const schoolYearId = optionalId(url.searchParams.get('schoolYearId'), 'invalid_school_year_id');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (from !== null && Number.isNaN(Date.parse(from))) throw new RequestError('invalid_from');
  if (to !== null && Number.isNaN(Date.parse(to))) throw new RequestError('invalid_to');
  return { domain, actorId, schoolYearId, from, to };
}

async function listAudit(request, env, url, json, actorId, context) {
  const limit = listLimit(url, { defaultLimit: 100, maxLimit: MAX_LIST });
  const filters = parseAuditFilters(url);
  await requireAuditDomains(env, request, context, filters.domain ? [filters.domain] : DEFAULT_VIEW_DOMAINS);
  // Kursor wiąże wszystkie filtry: zmiana `from`/`to`/`domain`… → 400 invalid_cursor.
  const scope = JSON.stringify(['audit', filters.domain, filters.actorId, filters.schoolYearId, filters.from, filters.to]);
  const cursor = listCursor(url, 'timestamp', scope);
  const values = [];
  const conditions = [];
  values.push(filters.domain ? auditDomainActions(filters.domain) : AUDIT_ACTIONS);
  conditions.push(`action = ANY($${values.length}::text[])`);
  if (filters.actorId) { values.push(filters.actorId); conditions.push(`actor_id = $${values.length}`); }
  if (filters.from) { values.push(filters.from); conditions.push(`occurred_at >= $${values.length}`); }
  if (filters.to) { values.push(filters.to); conditions.push(`occurred_at <= $${values.length}`); }
  if (filters.schoolYearId) {
    values.push(filters.schoolYearId);
    // #174: rok z metadanych; zdarzenia zapisane przed dopisaniem roku do
    // metadanych (dziennik trwały — nie poprawiamy ich) przypisujemy przy
    // odczycie do roku OBIEKTU (entity_type/entity_id), jak eksport roczny.
    // Zdarzenia bez obiektu roku (sesje, MFA, konta) nie należą do żadnego
    // roku — nie przypisujemy ich wg daty (zawężanie filtrem from/to).
    const param = `$${values.length}`;
    conditions.push(`(metadata_json ->> 'schoolYearId' = ${param}
      OR (metadata_json ->> 'schoolYearId' IS NULL AND ${auditYearByObjectSql(param)}))`);
  }
  if (cursor) conditions.push(afterTimestampDescSql('occurred_at', 'id', cursor, values));
  values.push(limit + 1);
  // #184: licznik odmów z okna 5 minut (0160) dołączany do zdarzenia
  // `access.denied`; pozostałe zdarzenia nie mają okna (denial_count = NULL).
  const { rows } = await env.db.query(
    `SELECT a.*, w.denial_count
       FROM (SELECT id, actor_id, action, entity_type, entity_id, occurred_at, metadata_json,
                    ${cursorTimestampSql('occurred_at')} AS cursor_ts
               FROM audit_events
              WHERE ${conditions.join(' AND ')}
              ORDER BY occurred_at DESC, id
              LIMIT $${values.length}) a
       LEFT JOIN access_denial_windows w ON w.audit_event_id = a.id
      ORDER BY a.occurred_at DESC, a.id`,
    values,
  );
  const page = pageOf(rows, limit, (row) => ({ key: row.cursor_ts, id: row.id }), scope);
  // #181 pkt 4: odczyt dziennika sam zapisuje zdarzenie, bez parametrów zapytania.
  await insertAuditEvent(env.db, {
    actorId, action: 'audit.viewed', entityType: 'audit_log', entityId: filters.domain ?? 'access',
    metadata: {},
  });
  return json({
    nextCursor: page.nextCursor,
    truncated: page.truncated,
    limit: page.limit,
    events: page.items.map((row) => auditEventForView(row)),
  });
}

// --- Przegląd dziennika odczytu danych rodzin (#133) -----------------------

const ACCESS_LOG_OUTCOMES = ['ok', 'not_found'];
const ACCESS_LOG_TS = `to_char(l.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function encodeAccessLogCursor(row) {
  return Buffer.from(JSON.stringify({ t: row.occurred_key, i: row.id }), 'utf8').toString('base64url');
}

function decodeAccessLogCursor(value) {
  if (value === null || value === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed?.t !== 'string' || typeof parsed?.i !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed.t) || !validId(parsed.i)) throw new Error();
    return { occurredKey: parsed.t, id: parsed.i };
  } catch {
    throw new RequestError('invalid_cursor');
  }
}

async function listAccessLog(env, url, json, actorId) {
  const params = url.searchParams;
  const limitParam = params.get('limit');
  const limit = limitParam === null ? 100 : Number(limitParam);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST) throw new RequestError('invalid_limit');
  const kind = params.get('kind');
  if (kind !== null && !DATA_ACCESS_KINDS.includes(kind)) throw new RequestError('invalid_access_kind');
  const outcome = params.get('outcome');
  if (outcome !== null && !ACCESS_LOG_OUTCOMES.includes(outcome)) throw new RequestError('invalid_outcome');
  const filterActor = optionalId(params.get('actorId'), 'invalid_actor_id');
  const householdId = optionalId(params.get('householdId'), 'invalid_household_id');
  const classId = optionalId(params.get('classId'), 'invalid_class_id');
  const schoolYearId = optionalId(params.get('schoolYearId'), 'invalid_school_year_id');
  const from = params.get('from');
  const to = params.get('to');
  if (from !== null && Number.isNaN(Date.parse(from))) throw new RequestError('invalid_from');
  if (to !== null && Number.isNaN(Date.parse(to))) throw new RequestError('invalid_to');
  const cursor = decodeAccessLogCursor(params.get('cursor'));

  const values = [];
  const conditions = ['TRUE'];
  const add = (sql, value) => { values.push(value); conditions.push(sql.replace('?', `$${values.length}`)); };
  if (kind) add('l.access_kind = ?', kind);
  if (outcome) add('l.outcome = ?', outcome);
  if (filterActor) add('l.actor_id = ?', filterActor);
  if (householdId) add('l.household_id = ?', householdId);
  if (classId) add('l.class_id = ?', classId);
  if (schoolYearId) add('l.school_year_id = ?', schoolYearId);
  if (from) add('l.occurred_at >= ?::timestamptz', new Date(from).toISOString());
  if (to) add('l.occurred_at <= ?::timestamptz', new Date(to).toISOString());
  if (cursor) {
    values.push(cursor.occurredKey, cursor.id);
    conditions.push(`(l.occurred_at, l.id) < ($${values.length - 1}::timestamptz, $${values.length})`);
  }
  values.push(limit + 1);
  const { rows } = await env.db.query(
    `SELECT l.id, l.actor_id, l.access_kind, l.school_year_id, l.class_id, l.household_id, l.outcome,
            l.row_count, l.hit_count, ${ACCESS_LOG_TS} AS occurred_key, l.occurred_at, l.last_seen_at,
            COALESCE((
              SELECT array_agg(DISTINCT rg.role ORDER BY rg.role) FROM role_grants rg
               WHERE rg.user_id = l.actor_id AND rg.revoked_at IS NULL
                 AND (rg.expires_at IS NULL OR rg.expires_at > now())
            ), ARRAY[]::text[]) AS actor_roles
       FROM data_access_log l
      WHERE ${conditions.join(' AND ')}
      ORDER BY l.occurred_at DESC, l.id DESC
      LIMIT $${values.length}`,
    values,
  );
  const visible = rows.slice(0, limit);
  const nextCursor = rows.length > limit && visible.length ? encodeAccessLogCursor(visible[visible.length - 1]) : null;
  // Odczyt przeglądu sam zostawia ślad, bez parametrów zapytania (jak audit.viewed).
  await insertAuditEvent(env.db, {
    actorId, action: 'access_log.viewed', entityType: 'data_access_log', entityId: 'data_access_log', metadata: {},
  });
  return json({
    entries: visible.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      actorRoles: row.actor_roles ?? [],
      accessKind: row.access_kind,
      schoolYearId: row.school_year_id ?? null,
      classId: row.class_id ?? null,
      householdId: row.household_id ?? null,
      outcome: row.outcome,
      rowCount: Number(row.row_count),
      hitCount: Number(row.hit_count),
      occurredAt: isoTimestamp(row.occurred_at),
      lastSeenAt: isoTimestamp(row.last_seen_at),
    })),
    nextCursor,
  });
}

// --- Rejestr żądań osób (RODO, #100) ---------------------------------------

const DATA_REQUEST_KINDS = new Set(['access', 'rectification', 'erasure', 'restriction', 'objection', 'portability']);
const DATA_REQUEST_STATUSES = ['received', 'identity_verified', 'in_progress', 'answered', 'rejected'];
const DATA_REQUEST_STATUS_RANK = { received: 0, identity_verified: 1, in_progress: 2, answered: 3, rejected: 3 };
const DATA_REQUEST_COLUMNS = `id, kind, household_id, guardian_id, student_id, received_on, due_on, status,
  handled_by, decision_note_ref, created_by, created_at, updated_at`;

function dataRequestFromRow(row) {
  return {
    id: row.id, kind: row.kind,
    householdId: row.household_id, guardianId: row.guardian_id, studentId: row.student_id,
    receivedOn: row.received_on, dueOn: row.due_on, status: row.status,
    handledBy: row.handled_by, decisionNoteRef: row.decision_note_ref,
    createdBy: row.created_by, createdAt: isoTimestamp(row.created_at), updatedAt: isoTimestamp(row.updated_at),
  };
}

async function listDataRequests(env, url, json) {
  const status = url.searchParams.get('status');
  const kind = url.searchParams.get('kind');
  if (status !== null && !DATA_REQUEST_STATUSES.includes(status)) throw new RequestError('invalid_status');
  if (kind !== null && !DATA_REQUEST_KINDS.has(kind)) throw new RequestError('invalid_kind');
  // #159: keyset (received_on, created_at, id) rosnąco zamiast całego rejestru naraz;
  // kursor wiąże filtry status/kind (zmiana filtra → 400 invalid_cursor).
  const limit = listLimit(url);
  const scope = JSON.stringify(['data-requests', status, kind]);
  const cursor = listCursor(url, 'text', scope);
  const conditions = [];
  const values = [];
  if (status) { values.push(status); conditions.push(`status = $${values.length}`); }
  if (kind) { values.push(kind); conditions.push(`kind = $${values.length}`); }
  if (cursor) {
    const parts = cursor.key.split('|');
    if (parts.length !== 2 || !validDate(parts[0]) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,6}Z$/.test(parts[1])) {
      throw new RequestError('invalid_cursor');
    }
    conditions.push(afterTupleAscSql(['received_on', 'created_at', 'id'], [parts[0], parts[1], cursor.id], values, ['::date', '::timestamptz', '']));
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows: fetched } = await env.db.query(
    `SELECT ${DATA_REQUEST_COLUMNS}, ${cursorTimestampSql('created_at')} AS cursor_ts,
            to_char(received_on, 'YYYY-MM-DD') AS received_key
       FROM data_subject_requests ${where} ORDER BY received_on, created_at, id LIMIT ${limit + 1}`,
    values,
  );
  const page = pageOf(fetched, limit, (row) => ({ key: `${row.received_key}|${row.cursor_ts}`, id: row.id }), scope);
  const rows = page.items;
  return json({ requests: rows.map(dataRequestFromRow), nextCursor: page.nextCursor, truncated: page.truncated, limit: page.limit });
}

function anonymizationRunFromRow(row) {
  const counts = row.counts && typeof row.counts === 'object' ? row.counts : {};
  return {
    id: row.id, householdId: row.household_id, reasonCode: row.reason_code,
    dataSubjectRequestId: row.data_subject_request_id, retentionPolicyIds: row.retention_policy_ids,
    planSha256: row.plan_sha256, counts,
    totalChanged: Object.values(counts).reduce((sum, value) => sum + (Number.isInteger(value) ? value : 0), 0),
    executedBy: row.executed_by, executedAt: isoTimestamp(row.executed_at),
  };
}

// #91: dziennik przebiegów anonimizacji, od najnowszego (keyset executed_at DESC, id).
async function listAnonymizations(env, url, json) {
  const limit = listLimit(url);
  const scope = 'anonymizations';
  const cursor = listCursor(url, 'timestamp', scope);
  const values = [];
  const where = cursor ? `WHERE ${afterTimestampDescSql('executed_at', 'id', cursor, values)}` : '';
  const { rows } = await env.db.query(
    `SELECT id, household_id, reason_code, data_subject_request_id, retention_policy_ids, plan_sha256, counts,
            executed_by, executed_at, ${cursorTimestampSql('executed_at')} AS cursor_ts
       FROM anonymization_runs ${where}
      ORDER BY executed_at DESC, id LIMIT ${limit + 1}`,
    values,
  );
  const page = pageOf(rows, limit, (row) => ({ key: row.cursor_ts, id: row.id }), scope);
  return json({ runs: page.items.map(anonymizationRunFromRow), nextCursor: page.nextCursor, truncated: page.truncated, limit: page.limit });
}

async function createDataRequest(env, actorId, request, json) {
  const data = await readJson(request);
  if (!DATA_REQUEST_KINDS.has(data.kind)) throw new RequestError('invalid_kind');
  const householdId = optionalId(data.householdId, 'invalid_household_id');
  const guardianId = optionalId(data.guardianId, 'invalid_guardian_id');
  const studentId = optionalId(data.studentId, 'invalid_student_id');
  if (!householdId && !guardianId && !studentId) throw new RequestError('subject_required');
  if (!validDate(data.receivedOn)) throw new RequestError('invalid_received_on');
  const dueOn = data.dueOn === undefined || data.dueOn === null || data.dueOn === '' ? null : data.dueOn;
  if (dueOn !== null && !validDate(dueOn)) throw new RequestError('invalid_due_on');

  const result = await env.db.transaction(async (tx) => {
    if (householdId) {
      const { rows } = await tx.query('SELECT 1 FROM households WHERE id = $1', [householdId]);
      if (!rows.length) throw new Abort('household_not_found', 404);
    }
    if (guardianId) {
      const { rows } = await tx.query('SELECT 1 FROM guardians WHERE id = $1', [guardianId]);
      if (!rows.length) throw new Abort('guardian_not_found', 404);
    }
    if (studentId) {
      const { rows } = await tx.query('SELECT 1 FROM students WHERE id = $1', [studentId]);
      if (!rows.length) throw new Abort('student_not_found', 404);
    }
    const id = crypto.randomUUID();
    await tx.query(
      `INSERT INTO data_subject_requests (id, kind, household_id, guardian_id, student_id, received_on, due_on, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, data.kind, householdId, guardianId, studentId, data.receivedOn, dueOn, actorId],
    );
    await insertAuditEvent(tx, {
      actorId, action: 'data_subject_request.created', entityType: 'data_subject_request', entityId: id,
      metadata: { kind: data.kind },
    });
    const { rows } = await tx.query(`SELECT ${DATA_REQUEST_COLUMNS} FROM data_subject_requests WHERE id = $1`, [id]);
    return dataRequestFromRow(rows[0]);
  });
  return json({ request: result }, 201);
}

async function setDataRequestStatus(env, actorId, requestId, request, json) {
  const data = await readJson(request);
  if (!DATA_REQUEST_STATUSES.includes(data.status)) throw new RequestError('invalid_status');
  const decisionNoteRef = data.decisionNoteRef === undefined || data.decisionNoteRef === null || data.decisionNoteRef === ''
    ? null
    : String(data.decisionNoteRef);
  if (decisionNoteRef !== null && (decisionNoteRef.length < 1 || decisionNoteRef.length > 200)) {
    throw new RequestError('invalid_decision_note_ref');
  }
  const result = await env.db.transaction(async (tx) => {
    const { rows } = await tx.query(`SELECT ${DATA_REQUEST_COLUMNS} FROM data_subject_requests WHERE id = $1 FOR UPDATE`, [requestId]);
    if (!rows[0]) throw new Abort('data_request_not_found', 404);
    const current = rows[0];
    // Podwójne kliknięcie / ponowienie: to samo docelowe przejście nic nie zmienia i nie audytuje ponownie.
    if (current.status === data.status) return { request: dataRequestFromRow(current), changed: false };
    if (DATA_REQUEST_STATUS_RANK[data.status] < DATA_REQUEST_STATUS_RANK[current.status]
        || ['answered', 'rejected'].includes(current.status)) {
      throw new Abort('data_request_status_cannot_go_back', 409);
    }
    const { rows: updated } = await tx.query(
      `UPDATE data_subject_requests SET status = $2, handled_by = $3,
              decision_note_ref = COALESCE($4, decision_note_ref), updated_at = now()
        WHERE id = $1
        RETURNING ${DATA_REQUEST_COLUMNS}`,
      [requestId, data.status, actorId, decisionNoteRef],
    );
    await insertAuditEvent(tx, {
      actorId, action: 'data_subject_request.status_changed', entityType: 'data_subject_request', entityId: requestId,
      metadata: { status: data.status },
    });
    return { request: dataRequestFromRow(updated[0]), changed: true };
  });
  return json(result);
}

// Eksport danych jednej rodziny dla żądania osoby (#100 pkt 2–3). Paczka nie
// jest zapisywana na serwerze — trafia wyłącznie do obsługującego; w bazie
// zostaje wpis dziennika odczytu i zdarzenie audytu (liczności i SHA-256, bez
// danych osobowych). export_runs NIE jest używane: CHECK kind i NOT NULL
// school_year_id (0016) nie przyjmują eksportu wielu lat bez migracji.
async function exportDataRequest(env, actorId, requestId, url) {
  const format = url.searchParams.get('format') ?? 'json';
  if (format !== 'json' && format !== 'csv') throw new RequestError('invalid_format');
  let result;
  try {
    result = await env.db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      // Podwójne kliknięcie: równoczesny drugi przebieg tego samego żądania dostaje
      // 409 zamiast budować paczkę drugi raz; kolejny (po zakończeniu) daje ten sam SHA-256.
      const lock = await tx.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked', [`rd_data_request_export:${requestId}`]);
      if (!lock.rows[0].locked) throw new RequestError('data_request_export_in_progress', 409);
      const { rows } = await tx.query(
        `SELECT id, kind, status, household_id, guardian_id, student_id, to_char(received_on, 'YYYY-MM-DD') AS received_on
           FROM data_subject_requests WHERE id = $1`,
        [requestId],
      );
      const current = rows[0];
      if (!current) throw new Abort('data_request_not_found', 404);
      if (!EXPORTABLE_REQUEST_KINDS.includes(current.kind)) throw new Abort('data_request_kind_not_exportable', 409);
      if (['answered', 'rejected'].includes(current.status)) throw new Abort('data_request_closed', 409);
      if (!EXPORTABLE_REQUEST_STATUSES.includes(current.status)) throw new Abort('data_request_identity_not_verified', 409);
      const built = await buildFamilyExport(tx, current);
      const totalRows = Object.values(built.rowCounts).reduce((sum, n) => sum + n, 0);
      // #133: dziennik odczytu w tej samej transakcji co eksport (strict), osobny
      // wiersz na każdy przebieg i gospodarstwo (bez scalania z odczytem karty).
      const householdIds = built.scope.households.length ? built.scope.households : [null];
      for (const householdId of householdIds) {
        await recordDataAccess({ db: tx }, {
          actorId, accessKind: 'household_card', householdId, outcome: 'ok', rowCount: totalRows,
        }, { strict: true, dedupe: false });
      }
      await insertAuditEvent(tx, {
        actorId, action: 'data_subject_request.exported', entityType: 'data_subject_request', entityId: requestId,
        metadata: {
          format, formatVersion: FAMILY_EXPORT_FORMAT_VERSION, manifestSha256: built.sha256, rowCounts: built.rowCounts,
          subjectType: built.scope.subjectType,
          omittedGuardians: built.scope.omitted.guardians, omittedHouseholds: built.scope.omitted.households,
        },
      });
      return built;
    });
  } catch (error) {
    if (error instanceof FamilyExportError) throw new RequestError(error.code, error.status);
    throw error;
  }
  const headers = {
    'X-Export-Manifest-Sha256': result.sha256,
    // Osoby trzecie pominięte w paczce — liczby dla obsługującego (bez identyfikatorów).
    'X-Data-Export-Omitted-Guardians': String(result.scope.omitted.guardians),
    'X-Data-Export-Omitted-Households': String(result.scope.omitted.households),
  };
  const filePart = requestId.replace(/[^A-Za-z0-9_-]/g, '_');
  if (format === 'csv') {
    return csvResponse(buildFamilyExportCsv(result.bundle), `rd-dane-rodziny-${filePart}.csv`, headers);
  }
  return new Response(result.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="rd-dane-rodziny-${filePart}-v${FAMILY_EXPORT_FORMAT_VERSION}.json"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

// --- Retencja (D-04, #91): raport kandydatów, wyłącznie odczyt --------------
//
// Kategorie zgodne z privacy/data-inventory.json (retention_category, #123) i
// z CHECK w postgres/migrations/0074_retention_policies.sql. Zapytanie liczy
// WYŁĄCZNIE wiersze (COUNT), nigdy imion/nazwisk/e-maili/referencji — odpowiedź
// zawiera tylko identyfikatory techniczne (id roku szkolnego, etykieta roku,
// rok kalendarzowy) i liczby, zgodnie z kryterium akceptacji #91.
const RETENTION_PREVIEW_SQL = `
  SELECT 'guardian_contact' AS category, NULL::text AS school_year_id, NULL::text AS school_year_label,
         EXTRACT(YEAR FROM changed_at)::int AS period_year, COUNT(*) AS candidate_count
    FROM guardian_contact_changes GROUP BY 4
  UNION ALL
  SELECT 'student_identity', e.school_year_id, sy.label, NULL, COUNT(*)
    FROM enrollments e JOIN school_years sy ON sy.id = e.school_year_id GROUP BY 2, 3
  UNION ALL
  SELECT 'email_snapshot', c.school_year_id, sy.label, NULL, COUNT(*)
    FROM email_campaign_recipients r
    JOIN email_campaigns c ON c.id = r.campaign_id
    JOIN school_years sy ON sy.id = c.school_year_id
   GROUP BY 2, 3
  UNION ALL
  SELECT 'payment_reference', p.school_year_id, sy.label, NULL, COUNT(*)
    FROM payment_entries p JOIN school_years sy ON sy.id = p.school_year_id
   WHERE p.reference IS NOT NULL AND btrim(p.reference) <> ''
   GROUP BY 2, 3
  UNION ALL
  SELECT 'document_financial', NULL, NULL, EXTRACT(YEAR FROM created_at)::int, COUNT(*)
    FROM documents GROUP BY 4
  UNION ALL
  SELECT 'audit_event', NULL, NULL, EXTRACT(YEAR FROM occurred_at)::int, COUNT(*)
    FROM audit_events GROUP BY 4
  UNION ALL
  SELECT 'export_package', er.school_year_id, sy.label, NULL, COUNT(*)
    FROM export_runs er JOIN school_years sy ON sy.id = er.school_year_id
   GROUP BY 2, 3
  UNION ALL
  SELECT 'import_file', ib.school_year_id, sy.label, NULL, COUNT(*)
    FROM import_batches ib JOIN school_years sy ON sy.id = ib.school_year_id
   GROUP BY 2, 3
  ORDER BY 1, 4, 2
`;

async function retentionPreview(env, json) {
  const [{ rows: candidateRows }, { rows: policyRows }] = await Promise.all([
    env.db.query(RETENTION_PREVIEW_SQL),
    env.db.query(
      `SELECT id, data_category, retain_for, retain_until_rule, decision_ref, effective_from, approved_by, created_by, created_at
         FROM retention_policies
        ORDER BY data_category, effective_from DESC`,
    ),
  ]);
  const currentByCategory = new Map();
  for (const row of policyRows) {
    if (!currentByCategory.has(row.data_category)) currentByCategory.set(row.data_category, row);
  }
  return json({
    generatedAt: isoTimestamp(new Date()),
    candidates: candidateRows.map((row) => ({
      category: row.category,
      schoolYearId: row.school_year_id ?? null,
      schoolYearLabel: row.school_year_label ?? null,
      periodYear: row.period_year ?? null,
      count: Number(row.candidate_count),
      hasPolicy: currentByCategory.has(row.category),
    })),
    policies: policyRows.map((row) => ({
      id: row.id,
      category: row.data_category,
      retainFor: row.retain_for ?? null,
      retainUntilRule: row.retain_until_rule ?? null,
      decisionRef: row.decision_ref,
      effectiveFrom: isoTimestamp(row.effective_from),
      approvedBy: row.approved_by ?? null,
      createdBy: row.created_by,
      createdAt: isoTimestamp(row.created_at),
      current: currentByCategory.get(row.data_category)?.id === row.id,
    })),
  });
}

// Anonimizacja gospodarstwa (#91, src/pg/anonymization.js). Podgląd domyślny:
// wykonanie wymaga jawnego dryRun:false, potwierdzenia identyfikatorem
// gospodarstwa i skrótu planu z podglądu (zatwierdzenie dokładnie tego planu).
async function anonymizationRoute(env, actorId, request, json) {
  const data = await readJson(request);
  const householdId = optionalId(data.householdId, 'invalid_household_id');
  if (!householdId) throw new RequestError('invalid_household_id');
  if (!ANONYMIZATION_REASON_CODES.includes(data.reasonCode)) throw new RequestError('invalid_reason_code');
  const dataRequestId = optionalId(data.dataRequestId, 'invalid_data_request_id');
  if (data.reasonCode === 'data_subject_request' && !dataRequestId) throw new RequestError('invalid_data_request_id');
  if (data.reasonCode === 'retention_policy' && dataRequestId) throw new RequestError('invalid_data_request_id');
  if (data.dryRun !== undefined && typeof data.dryRun !== 'boolean') throw new RequestError('invalid_dry_run');
  const dryRun = data.dryRun !== false;
  let expectedPlanSha256 = null;
  if (!dryRun) {
    if (data.confirm !== householdId) throw new RequestError('confirmation_required');
    if (typeof data.expectedPlanSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(data.expectedPlanSha256)) {
      throw new RequestError('invalid_plan_sha256');
    }
    expectedPlanSha256 = data.expectedPlanSha256;
  }
  try {
    const result = await anonymizeHousehold(env.db, {
      actorId, householdId, reasonCode: data.reasonCode, dataRequestId, dryRun, expectedPlanSha256,
    });
    return json(result, result.status === 'applied' ? 201 : 200, { 'Cache-Control': 'no-store' });
  } catch (error) {
    if (error instanceof AnonymizationError) throw new RequestError(error.code, error.status);
    throw error;
  }
}

// #181: historia jednego obiektu. Wariant zachowawczy — tylko admin (jak cały
// moduł); role finansowe/kampanii własnego zakresu (skarbnik widzi historię
// swojej wpłaty) zostają do decyzji D-08/D-09, kiedy dojdzie osobna trasa
// spoza /api/admin z ich autoryzacją. Etykieta roli aktora w chwili zdarzenia
// (z issue) nie jest tu liczona — wymagałaby złączenia z historią przydziałów
// ról po czasie; odłożone jako osobne rozszerzenie.
export const ENTITY_TABLES = {
  payment_entry: 'payment_entries',
  ledger_entry: 'ledger_entries',
  reconciliation: 'bank_reconciliations',
  email_campaign: 'email_campaigns',
};
// Domena, której odczyt jest wymagany do historii obiektu danego typu.
export const ENTITY_DOMAIN = {
  payment_entry: 'finance', ledger_entry: 'finance', reconciliation: 'finance', email_campaign: 'email',
};
// Zdarzenia uzgodnienia zapisują entity_type 'bank_reconciliation' (routes/
// reconciliation.js) — bez tej mapy historia uzgodnienia gubiła jego utworzenie,
// potwierdzenie i porzucenie (zostawały tylko zdarzenia z reconciliationId).
const ENTITY_AUDIT_TYPE = { reconciliation: 'bank_reconciliation' };
// Zdarzenia powiązane (korekta, przypisanie, zwrot, dopasowanie…) mają własny
// entity_type/entity_id, a odniesienie do obiektu głównego trzymają w
// metadanych pod tym kluczem (konwencja już istniejąca w routes/payments.js,
// ledger.js, reconciliation.js — patrz ich insertAuditEvent).
const RELATED_METADATA_KEY = {
  payment_entry: 'paymentEntryId',
  ledger_entry: 'ledgerEntryId',
  reconciliation: 'reconciliationId',
  email_campaign: 'campaignId',
};

// Surowe zdarzenia obiektu (samego i powiązane przez metadane), od najstarszego.
// Wspólne dla trasy admina i GET /api/audit/entity/... (routes/audit-history.js).
export async function readEntityAuditRows(db, entityType, entityId) {
  const { rows } = await db.query(
    `SELECT id, actor_id, action, occurred_at, metadata_json
       FROM audit_events
      WHERE (entity_type = ANY($1::text[]) AND entity_id = $2) OR metadata_json ->> $3 = $2
      ORDER BY occurred_at, id`,
    [[entityType, ENTITY_AUDIT_TYPE[entityType] ?? entityType], entityId, RELATED_METADATA_KEY[entityType]],
  );
  return rows;
}

async function entityAudit(request, env, entityType, entityId, json, actorId, context) {
  const table = ENTITY_TABLES[entityType];
  if (!table) throw new RequestError('invalid_entity_type');
  await requireAuditDomains(env, request, context, [ENTITY_DOMAIN[entityType]]);
  const { rows: exists } = await env.db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [entityId]);
  if (!exists.length) throw new RequestError('not_found', 404);
  const rows = await readEntityAuditRows(env.db, entityType, entityId);
  // Historia obiektu obejmuje zdarzenia różnych domen (np. `audit.viewed` z
  // domeny privacy) — pokazujemy tylko te, których domenę aktor może czytać.
  const visible = rows.filter((row) => canReadAuditDomain(context, auditActionDomain(row.action)));
  await insertAuditEvent(env.db, {
    actorId, action: 'audit.viewed', entityType, entityId, metadata: {},
  });
  return json({
    entityType, entityId,
    events: visible.map((row) => auditEventForView(row, { withEntity: false })),
  });
}

// Stan techniczny systemu (issue #149). Cache-Control: no-store — nigdy nie
// trzymane w pamięci podręcznej przeglądarki/proxy; tylko liczby i znaczniki
// czasu (bez adresów, nazw rodzin i treści — patrz src/pg/ops-status.js).
async function opsStatus(env, json) {
  const status = await computeOpsStatus({ db: env.db, env });
  return json(status, 200, { 'Cache-Control': 'no-store' });
}

// --- Router ----------------------------------------------------------------

// Zwraca dozwolone metody dla ROZPOZNANEGO kształtu ścieżki (#156, RFC 9110
// §15.5.6 wymaga nagłówka Allow przy 405); null = ścieżka w ogóle nieznana
// (404, nie 405).
function allowedMethodsFor(section, pathLength, action, path) {
  if (section === 'users') {
    if (pathLength === 1) return ['GET'];
    if (pathLength === 3 && ['disable', 'enable', 'revoke-sessions', 'password-reset', 'mfa-reset'].includes(action)) return ['POST'];
    return null;
  }
  if (section === 'account-requests' || section === 'grant-requests') {
    if (pathLength === 1) return ['GET'];
    if (pathLength === 3 && ['approve', 'reject'].includes(action)) return ['POST'];
    return null;
  }
  if (section === 'grants') {
    if (pathLength === 1) return ['GET', 'POST'];
    if (pathLength === 3 && action === 'revoke') return ['POST'];
    return null;
  }
  if (section === 'invitations') {
    if (pathLength === 1) return ['GET', 'POST'];
    if (pathLength === 3 && ['revoke', 'reissue'].includes(action)) return ['POST'];
    return null;
  }
  if (section === 'school-years') {
    if (pathLength === 1) return ['GET', 'POST'];
    if (pathLength === 3 && ['expire-grants', 'classes'].includes(action)) return ['POST'];
    return null;
  }
  if (section === 'promotions') return promotionAllowedMethods(path);
  if (section === 'invitation-batches') return invitationBatchAllowedMethods(path);
  if (section === 'class-coverage' && pathLength === 1) return ['GET'];
  if (section === 'audit' && pathLength === 1) return ['GET'];
  if (section === 'access-log' && pathLength === 1) return ['GET'];
  if (section === 'data-requests') {
    if (pathLength === 1) return ['GET', 'POST'];
    if (pathLength === 3 && (action === 'status' || action === 'export')) return ['POST'];
    return null;
  }
  if (section === 'retention' && pathLength === 2) return ['GET'];
  if (section === 'anonymizations' && pathLength === 1) return ['GET', 'POST'];
  if (section === 'ops-status' && pathLength === 1) return ['GET'];
  return null;
}

// #150 (SR-10, krok w górę/step-up): operacje nieodwracalne na cudzym koncie
// (reset hasła, wyłączenie MFA) i nadanie roli wymagają MFA potwierdzonego od
// niedawna, nie tylko kiedyś w tej sesji — sprawdzane PO roli 'admin' (SR-07),
// więc konto bez dostępu dostaje ten sam `forbidden` niezależnie od wieku MFA.
// Utworzenie i ponowne wydanie zaproszenia — jak nadanie roli (rola powstaje
// przy przyjęciu). Pozostałe trasy admina (lista, wyłączenie/włączenie konta,
// cofnięcie sesji, cofnięcie zaproszenia, lata szkolne, cofnięcie przydziału, audyt) zostają przy MFA
// "kiedyś w sesji" jak dotąd — poza zakresem #150 część 2.
function requireFreshMfa(context) {
  const staleCode = freshMfaForbiddenCode(context, MFA_STEP_UP_MAX_AGE_SECONDS);
  if (staleCode) throw new RequestError(staleCode, 403);
}

async function route(request, env, url, json, actorId, context) {
  const path = url.pathname.slice(PREFIX.length).split('/');
  const method = request.method;
  const [section, rawId, action, ...rest] = path;
  // GET /api/admin/audit/entity/{entityType}/{entityId} (#181): jedyna trasa
  // z czterema segmentami, więc obsługiwana przed ogólnym `if (rest.length)`.
  if (section === 'audit' && rawId === 'entity' && rest.length === 1 && method === 'GET') {
    return entityAudit(request, env, action, decodeId(rest[0]), json, actorId, context);
  }
  if (rest.length) return null;

  if (section === 'users') {
    if (path.length === 1 && method === 'GET') return listUsers(env, url, json);
    if (path.length === 3 && method === 'POST') {
      const userId = decodeId(rawId);
      if (action === 'disable') return setUserDisabled(env, actorId, userId, true, json);
      if (action === 'enable') return setUserDisabled(env, actorId, userId, false, json);
      if (action === 'revoke-sessions') return revokeSessionsOf(env, actorId, userId, json);
      if (action === 'password-reset') { requireFreshMfa(context); return passwordResetRoute(env, actorId, userId, request, json); }
      if (action === 'mfa-reset') { requireFreshMfa(context); return mfaResetRoute(env, actorId, userId, request, json); }
    }
  }
  if (section === 'account-requests') {
    if (path.length === 1 && method === 'GET') return recoveryRequestsList(env, url, json);
    if (path.length === 3 && action === 'approve' && method === 'POST') {
      requireFreshMfa(context);
      return recoveryRequestDecision(env, actorId, decodeId(rawId), 'approve', json);
    }
    if (path.length === 3 && action === 'reject' && method === 'POST') {
      return recoveryRequestDecision(env, actorId, decodeId(rawId), 'reject', json);
    }
  }
  if (section === 'grant-requests') {
    if (path.length === 1 && method === 'GET') return grantRequestsList(env, url, json);
    if (path.length === 3 && action === 'approve' && method === 'POST') {
      requireFreshMfa(context);
      return grantRequestDecision(env, actorId, decodeId(rawId), 'approve', request, json);
    }
    if (path.length === 3 && action === 'reject' && method === 'POST') {
      return grantRequestDecision(env, actorId, decodeId(rawId), 'reject', request, json);
    }
  }
  if (section === 'grants') {
    if (path.length === 1 && method === 'GET') return listGrants(env, url, json);
    if (path.length === 1 && method === 'POST') { requireFreshMfa(context); return createGrant(env, actorId, request, json); }
    if (path.length === 3 && action === 'revoke' && method === 'POST') return revokeGrant(env, actorId, decodeId(rawId), json);
  }
  if (section === 'invitations') {
    if (path.length === 1 && method === 'GET') return listInvitations(env, url, json);
    // Zaproszenie (i jego ponowne wydanie) nadaje rolę w chwili przyjęcia —
    // to też „nadanie roli”, więc ten sam krok w górę co POST /grants; bez tego
    // admin ze starym MFA (przejęta sesja) zapraszał dowolny adres do roli admin.
    if (path.length === 1 && method === 'POST') { requireFreshMfa(context); return createInvitationRoute(env, actorId, request, json); }
    if (path.length === 3 && action === 'revoke' && method === 'POST') return revokeInvitationRoute(env, actorId, decodeId(rawId), json);
    if (path.length === 3 && action === 'reissue' && method === 'POST') {
      requireFreshMfa(context);
      return reissueInvitationRoute(env, actorId, decodeId(rawId), json);
    }
  }
  if (section === 'school-years') {
    if (path.length === 1 && method === 'GET') return listSchoolYears(env, json);
    if (path.length === 1 && method === 'POST') return createSchoolYear(env, actorId, request, json);
    if (path.length === 3 && action === 'expire-grants' && method === 'POST') {
      return expireSchoolYear(env, actorId, decodeId(rawId), request, json);
    }
    if (path.length === 3 && action === 'classes' && method === 'POST') {
      return createClasses(env, actorId, decodeId(rawId), request, json);
    }
  }
  if (section === 'promotions') return routePromotions(env, actorId, request, path, json);
  // Zaproszenia zbiorcze (#108): jak pojedyncze zaproszenie — krok w górę MFA
  // także dla podglądu (podgląd ujawnia, które adresy mają już konto).
  if (section === 'invitation-batches' && path.length === 2 && method === 'POST') {
    requireFreshMfa(context);
    return routeInvitationBatches(env, actorId, request, path, json);
  }
  if (section === 'class-coverage' && path.length === 1 && method === 'GET') return classCoverage(env, url, json);
  if (section === 'audit' && path.length === 1 && method === 'GET') return listAudit(request, env, url, json, actorId, context);
  if (section === 'access-log' && path.length === 1 && method === 'GET') return listAccessLog(env, url, json, actorId);
  if (section === 'data-requests') {
    if (path.length === 1 && method === 'GET') return listDataRequests(env, url, json);
    if (path.length === 1 && method === 'POST') return createDataRequest(env, actorId, request, json);
    if (path.length === 3 && action === 'status' && method === 'POST') {
      return setDataRequestStatus(env, actorId, decodeId(rawId), request, json);
    }
    // #100: eksport danych rodziny ujawnia pełne dane osobowe — krok w górę MFA jak eksport roczny (#150).
    if (path.length === 3 && action === 'export' && method === 'POST') {
      requireFreshMfa(context);
      return exportDataRequest(env, actorId, decodeId(rawId), url);
    }
  }
  if (section === 'retention' && rawId === 'preview' && path.length === 2 && method === 'GET') {
    return retentionPreview(env, json);
  }
  // #91: lista przebiegów — identyfikatory i liczniki; ta sama rola co POST (admin + MFA), bez kroku w górę (nic nie zmienia).
  if (section === 'anonymizations' && path.length === 1 && method === 'GET') return listAnonymizations(env, url, json);
  // #91: anonimizacja zmienia dane osobowe nieodwracalnie — krok w górę MFA (#150), także dla podglądu.
  if (section === 'anonymizations' && path.length === 1 && method === 'POST') {
    requireFreshMfa(context);
    return anonymizationRoute(env, actorId, request, json);
  }
  if (section === 'ops-status' && path.length === 1 && method === 'GET') return opsStatus(env, json);
  return undefined;
}

const KNOWN_SECTIONS = new Set(['users', 'account-requests', 'grant-requests', 'grants', 'invitations', 'invitation-batches', 'school-years', 'promotions', 'class-coverage', 'audit', 'access-log', 'data-requests', 'retention', 'anonymizations', 'ops-status']);

export async function handle(request, env, url, json) {
  if (!url.pathname.startsWith(PREFIX)) return null;
  const path = url.pathname.slice(PREFIX.length).split('/');
  const [section, , action, ...rest] = path;
  if (!KNOWN_SECTIONS.has(section)) return null;

  // Sesja i uprawnienia przed walidacją wejścia: anonim nie poznaje kształtu API.
  const access = await requireAccess(request, env, { roles: ['admin'], requireMfa: true }, json);
  if (access.response) return access.response;
  const actorId = access.context.session.user.id;
  try {
    const response = await route(request, env, url, json, actorId, access.context);
    if (response === null) return null;
    if (response !== undefined) return response;
    const allowed = rest.length ? null : allowedMethodsFor(section, path.length, action, path);
    if (!allowed) return null;
    return json({ error: 'method_not_allowed' }, 405, { Allow: allowed.join(', ') });
  } catch (error) {
    if (error instanceof RequestError || error instanceof PromotionError) {
      return json({ error: error.code, ...(error.categories ? { categories: error.categories } : {}) }, error.status, error.headers);
    }
    throw error;
  }
}
