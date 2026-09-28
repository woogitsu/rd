// Administracja kontami i przydziałami ról na PostgreSQL (issues #3, #4, #9).
// Prototyp — nie jest wdrożony i nie jest gotowy do pracy na danych rodzin.
//
//   GET  /api/admin/users
//   POST /api/admin/users/{id}/disable          wyłącza konto i wycofuje wszystkie sesje
//   POST /api/admin/users/{id}/enable
//   POST /api/admin/users/{id}/revoke-sessions
//   POST /api/admin/users/{id}/password-reset   { ttlHours? } — jednorazowy token resetu hasła (zwracany raz); krok w górę MFA (#150)
//   POST /api/admin/users/{id}/mfa-reset        { confirm: "<id konta>" } — wyłącza MFA i kody odzyskiwania; krok w górę MFA (#150)
//   GET  /api/admin/grants?userId=&role=&schoolYearId=&classId=&status=
//   POST /api/admin/grants                      { userId, role, classId?, schoolYearId?, expiresAt? } — krok w górę MFA (#150)
//   POST /api/admin/grants/{id}/revoke
//   POST /api/admin/school-years/{id}/expire-grants   { confirm: "<id roku>" } — wygaszenie kadencji
//   GET  /api/admin/invitations
//   POST /api/admin/invitations                 { email, role, classId?, schoolYearId?, ttlHours? }
//   POST /api/admin/invitations/{id}/revoke
//   POST /api/admin/invitations/{id}/reissue    wycofuje i tworzy nowe zaproszenie (#108); tylko oczekujące
//   GET  /api/admin/school-years                lata i klasy do formularzy
//   POST /api/admin/school-years                { id, label, startsOn, endsOn } — nowy rok szkolny (#78)
//   POST /api/admin/school-years/{id}/classes    { names: [...] } — nowe klasy roku (#78); bez usuwania
//   GET  /api/admin/class-coverage?schoolYearId= obsada klas roku: przydziały, oczekujące zaproszenia, ostatnie logowanie (#108)
//   GET  /api/admin/audit?limit=                dziennik zmian kont i ról
//
// Dostęp: wyłącznie rola `admin` z potwierdzonym MFA, także do odczytu.
// Założenie do decyzji D-08/D-09: zarząd nie ma tu nawet odczytu, dopóki
// szkoła nie zatwierdzi macierzy kompetencji. Przyjęcie zaproszenia z hasłem:
// POST /api/invitations/accept (src/pg/routes/login.js).
//
// Każda zmiana i jej zdarzenie audytu powstają w jednej transakcji. Metadane
// audytu zawierają wyłącznie identyfikatory (bez e-maili i nazw). Zmiany
// przydziałów admina są serializowane blokadą doradczą, aby dwie równoległe
// operacje nie odebrały sobie nawzajem ostatniego dostępu administratora.

import { createInvitation, isoTimestamp, revokeInvitation, revokeUserSessions, ROLES } from '../auth.js';
import { freshMfaForbiddenCode, MFA_STEP_UP_MAX_AGE_SECONDS, requireAccess } from '../authorization.js';
import { insertAuditEvent } from '../audit.js';
import {
  adminResetMfa, issuePasswordReset, LoginError, PASSWORD_RESET_MAX_TTL_SECONDS, revokePasswordResetTokens,
} from '../login.js';
import { computeOpsStatus } from '../ops-status.js';

export const name = 'admin';

const PREFIX = '/api/admin/';
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_GRANT_YEARS = 3;
const MAX_LIST = 500;
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

async function readJson(request) {
  const type = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw new RequestError('invalid_content_type', 415);
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new RequestError('request_too_large', 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new RequestError('request_too_large', 413);
  if (!text.trim()) return {};
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new RequestError('invalid_json');
  }
}

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

async function listUsers(env, json) {
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
      ORDER BY lower(u.email)
      LIMIT ${MAX_LIST}`,
  );
  return json({
    users: rows.map((row) => ({
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
  const changed = await env.db.transaction(async (tx) => {
    const { rows: existing } = await tx.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!existing[0]) throw new Abort('user_not_found', 404);
    const { rows } = await tx.query(
      disabled
        ? 'UPDATE users SET disabled_at = now() WHERE id = $1 AND disabled_at IS NULL RETURNING id'
        : 'UPDATE users SET disabled_at = NULL WHERE id = $1 AND disabled_at IS NOT NULL RETURNING id',
      [userId],
    );
    if (!rows[0]) return false;
    await insertAuditEvent(tx, {
      actorId, action: disabled ? 'user.disabled' : 'user.enabled', entityType: 'user', entityId: userId,
    });
    // Po ponownym włączeniu konta stary token resetu nie może znów zadziałać (#193).
    if (disabled) await revokePasswordResetTokens(tx, { userId, actorId, reason: 'user_disabled' });
    return true;
  });
  // loadSession odrzuca konto z disabled_at, więc sesje przestają działać już
  // po powyższym COMMIT. Wycofanie (osobna transakcja revokeUserSessions)
  // zapisuje to trwale z audytem każdej sesji; ponowienie jest bezpieczne.
  const revokedSessions = disabled
    ? await revokeUserSessions(env, { userId, actorId, reason: 'user_disabled' })
    : 0;
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
    return json(await adminResetMfa(env, { actorId, userId }));
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
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await env.db.query(
    `SELECT ${GRANT_COLUMNS} FROM role_grants g ${where}
      ORDER BY g.granted_at DESC, g.id
      LIMIT ${MAX_LIST}`,
    values,
  );
  return json({ grants: rows.map(grantFromRow) });
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
    const { rows: users } = await tx.query('SELECT id, disabled_at FROM users WHERE id = $1 FOR UPDATE', [data.userId]);
    if (!users[0]) throw new Abort('user_not_found', 404);
    if (users[0].disabled_at) throw new Abort('user_disabled', 409);

    // Podwójne kliknięcie: identyczny aktywny przydział nie powstaje drugi raz.
    const { rows: duplicate } = await tx.query(
      `SELECT ${GRANT_COLUMNS} FROM role_grants g
        WHERE g.user_id = $1 AND g.role = $2
          AND g.class_id IS NOT DISTINCT FROM $3 AND g.school_year_id IS NOT DISTINCT FROM $4
          AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())
        LIMIT 1`,
      [data.userId, role, scope.classId, scope.schoolYearId],
    );
    if (duplicate[0]) return { grant: grantFromRow(duplicate[0]), created: false };

    const grantId = crypto.randomUUID();
    let rows;
    try {
      ({ rows } = await tx.query(
        `INSERT INTO role_grants AS g (id, user_id, role, class_id, school_year_id, expires_at, granted_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${GRANT_COLUMNS}`,
        [grantId, data.userId, role, scope.classId, scope.schoolYearId, expiresAt, actorId],
      ));
    } catch (error) {
      // Trigger zamrożenia (0017/0022): rok zamknięty to konflikt, nie awaria.
      if (error?.message === 'school_year_closed') throw new Abort('school_year_closed', 409);
      if (error?.message === 'class_not_in_school_year') throw new Abort('class_not_in_school_year', 422);
      throw error;
    }
    await insertAuditEvent(tx, {
      actorId, action: 'role_grant.created', entityType: 'role_grant', entityId: grantId,
      metadata: grantAuditMetadata(rows[0], { expiresAt }),
    });
    return { grant: grantFromRow(rows[0]), created: true };
  });
  return json(result, result.created ? 201 : 200);
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

async function listInvitations(env, json) {
  const { rows } = await env.db.query(
    `SELECT ${INVITATION_COLUMNS} FROM invitations i ORDER BY i.created_at DESC, i.id LIMIT ${MAX_LIST}`,
  );
  return json({ invitations: rows.map(invitationFromRow) });
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
  const scope = await resolveScope(env.db, { role: data.role, classId, schoolYearId: schoolYearIdInput });

  // Podwójne kliknięcie: drugie zaproszenie o tym samym zakresie dla adresu,
  // który ma już oczekujące zaproszenie, jest odrzucane (token nie wraca drugi raz).
  const { rows: pending } = await env.db.query(
    `SELECT 1 FROM invitations
      WHERE lower(email) = $1 AND role = $2
        AND class_id IS NOT DISTINCT FROM $3 AND school_year_id IS NOT DISTINCT FROM $4
        AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      LIMIT 1`,
    [email, data.role, scope.classId, scope.schoolYearId],
  );
  if (pending[0]) throw new RequestError('invitation_pending', 409);

  let created;
  try {
    created = await createInvitation(env, {
      actorId, email, role: data.role, classId: scope.classId, schoolYearId: scope.schoolYearId, ttlSeconds,
    });
  } catch (error) {
    if (['invalid_email', 'invalid_role', 'class_required'].includes(error?.message)) throw new RequestError(error.message);
    if (error?.message === 'class_not_in_school_year') throw new RequestError(error.message, 422);
    throw error;
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
// (nowe zaproszenie od zera przez POST /api/admin/invitations).
async function reissueInvitationRoute(env, actorId, invitationId, json) {
  const { rows } = await env.db.query(`SELECT ${INVITATION_COLUMNS} FROM invitations i WHERE i.id = $1`, [invitationId]);
  const invitation = rows[0];
  if (!invitation) throw new RequestError('invitation_not_found', 404);
  if (invitation.status !== 'pending') throw new RequestError('invitation_not_pending', 409);
  const revoked = await revokeInvitation(env, { invitationId, actorId });
  if (!revoked) throw new RequestError('invitation_not_pending', 409);
  const created = await createInvitation(env, {
    actorId, email: invitation.email, role: invitation.role,
    classId: invitation.class_id, schoolYearId: invitation.school_year_id,
    replacesInvitationId: invitationId,
  });
  return json({
    invitation: {
      id: created.invitationId, email: invitation.email, role: invitation.role,
      classId: invitation.class_id, schoolYearId: invitation.school_year_id,
      expiresAt: created.expiresAt, status: 'pending', replacesInvitationId: invitationId,
    },
    token: created.secret,
  }, 201);
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

const AUDIT_ACTIONS = [
  'role_grant.created', 'role_grant.revoked', 'role_grant.expired', 'role_grant.school_year_backfilled',
  'school_year.grants_expired', 'school_year.created', 'class.created',
  'invitation.created', 'invitation.revoked', 'invitation.accepted', 'invitation.reissued',
  'user.disabled', 'user.enabled', 'user.created', 'session.revoked',
  'auth.password_reset_issued', 'auth.password_reset_revoked', 'auth.password_reset_completed', 'auth.password_set',
  'auth.password_changed', 'mfa.reset',
];

async function listAudit(env, url, json) {
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam === null ? 100 : Number(limitParam);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST) throw new RequestError('invalid_limit');
  const { rows } = await env.db.query(
    `SELECT id, actor_id, action, entity_type, entity_id, occurred_at, metadata_json
       FROM audit_events
      WHERE action = ANY($1::text[])
      ORDER BY occurred_at DESC, id
      LIMIT $2`,
    [AUDIT_ACTIONS, limit],
  );
  return json({
    events: rows.map((row) => ({
      id: row.id, actorId: row.actor_id ?? null, action: row.action, entityType: row.entity_type,
      entityId: row.entity_id, occurredAt: isoTimestamp(row.occurred_at),
      metadata: typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : (row.metadata_json ?? {}),
    })),
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
function allowedMethodsFor(section, pathLength, action) {
  if (section === 'users') {
    if (pathLength === 1) return ['GET'];
    if (pathLength === 3 && ['disable', 'enable', 'revoke-sessions', 'password-reset', 'mfa-reset'].includes(action)) return ['POST'];
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
    if (pathLength === 1) return ['GET'];
    if (pathLength === 3 && action === 'expire-grants') return ['POST'];
    return null;
  }
  if (section === 'class-coverage' && pathLength === 1) return ['GET'];
  if (section === 'audit' && pathLength === 1) return ['GET'];
  if (section === 'ops-status' && pathLength === 1) return ['GET'];
  return null;
}

// #150 (SR-10, krok w górę/step-up): operacje nieodwracalne na cudzym koncie
// (reset hasła, wyłączenie MFA) i nadanie roli wymagają MFA potwierdzonego od
// niedawna, nie tylko kiedyś w tej sesji — sprawdzane PO roli 'admin' (SR-07),
// więc konto bez dostępu dostaje ten sam `forbidden` niezależnie od wieku MFA.
// Pozostałe trasy admina (lista, wyłączenie/włączenie konta, cofnięcie sesji,
// zaproszenia, lata szkolne, cofnięcie przydziału, audyt) zostają przy MFA
// "kiedyś w sesji" jak dotąd — poza zakresem #150 część 2.
function requireFreshMfa(context) {
  const staleCode = freshMfaForbiddenCode(context, MFA_STEP_UP_MAX_AGE_SECONDS);
  if (staleCode) throw new RequestError(staleCode, 403);
}

async function route(request, env, url, json, actorId, context) {
  const path = url.pathname.slice(PREFIX.length).split('/');
  const method = request.method;
  const [section, rawId, action, ...rest] = path;
  if (rest.length) return null;

  if (section === 'users') {
    if (path.length === 1 && method === 'GET') return listUsers(env, json);
    if (path.length === 3 && method === 'POST') {
      const userId = decodeId(rawId);
      if (action === 'disable') return setUserDisabled(env, actorId, userId, true, json);
      if (action === 'enable') return setUserDisabled(env, actorId, userId, false, json);
      if (action === 'revoke-sessions') return revokeSessionsOf(env, actorId, userId, json);
      if (action === 'password-reset') { requireFreshMfa(context); return passwordResetRoute(env, actorId, userId, request, json); }
      if (action === 'mfa-reset') { requireFreshMfa(context); return mfaResetRoute(env, actorId, userId, request, json); }
    }
  }
  if (section === 'grants') {
    if (path.length === 1 && method === 'GET') return listGrants(env, url, json);
    if (path.length === 1 && method === 'POST') { requireFreshMfa(context); return createGrant(env, actorId, request, json); }
    if (path.length === 3 && action === 'revoke' && method === 'POST') return revokeGrant(env, actorId, decodeId(rawId), json);
  }
  if (section === 'invitations') {
    if (path.length === 1 && method === 'GET') return listInvitations(env, json);
    if (path.length === 1 && method === 'POST') return createInvitationRoute(env, actorId, request, json);
    if (path.length === 3 && action === 'revoke' && method === 'POST') return revokeInvitationRoute(env, actorId, decodeId(rawId), json);
    if (path.length === 3 && action === 'reissue' && method === 'POST') return reissueInvitationRoute(env, actorId, decodeId(rawId), json);
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
  if (section === 'class-coverage' && path.length === 1 && method === 'GET') return classCoverage(env, url, json);
  if (section === 'audit' && path.length === 1 && method === 'GET') return listAudit(env, url, json);
  if (section === 'ops-status' && path.length === 1 && method === 'GET') return opsStatus(env, json);
  return undefined;
}

const KNOWN_SECTIONS = new Set(['users', 'grants', 'invitations', 'school-years', 'class-coverage', 'audit', 'ops-status']);

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
    const allowed = rest.length ? null : allowedMethodsFor(section, path.length, action);
    if (!allowed) return null;
    return json({ error: 'method_not_allowed' }, 405, { Allow: allowed.join(', ') });
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.code }, error.status);
    throw error;
  }
}
