// Katalog klas, uczniów i rodzin na PostgreSQL (issue #5). Prototyp — nie jest wdrożony.
//
//   GET   /api/classes[?schoolYearId=…]           klasy widoczne dla wywołującego
//   GET   /api/classes/{id}/students               uczniowie klasy z gospodarstwami
//   GET   /api/households/{id}                     karta gospodarstwa
//   PATCH /api/guardians/{id}/contact              zmiana e-maila / zgody na kontakt (admin, zarząd)
//   POST  /api/students/{id}/enrollments           przypisanie lub zmiana klasy w roku (admin, zarząd)
//
// Zakres (założenie do decyzji D-08/D-09, opisane w docs/DATA_MODEL.md):
// * admin, board, treasurer — wszystkie klasy (lub klasy roku z przydziału),
// * representative — wyłącznie klasy z przydziałów,
// * audit, principal — brak dostępu do danych rodzin (403) do czasu decyzji D-09.
// Każde zapytanie listujące filtruje w SQL po zakresie wywołującego. Obiekt
// nieistniejący i obiekt poza zakresem dają ten sam wynik: 404 not_found.
// Karta gospodarstwa nie zawiera pól zadłużenia; sumy wpłat netto widzą
// wyłącznie role finansowe z MFA. Jednostka ewidencji składki — decyzja D-11.

import { isSameOrigin } from '../../auth.js';
import { isAuthorizedScoped, loadAuthorizationContext } from '../authorization.js';
import { insertAuditEvent } from '../audit.js';

export const name = 'families';

const READ_ROLES = ['admin', 'board', 'treasurer', 'representative'];
const WIDE_ROLES = new Set(['admin', 'board', 'treasurer']);
const EDIT_ROLES = ['admin', 'board'];
const FINANCIAL_ROLES = ['admin', 'board', 'treasurer'];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BODY_BYTES = 8 * 1024;

class RequestError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const notFound = () => new RequestError('not_found', 404);

function decodeId(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw notFound();
  }
  if (!ID_PATTERN.test(decoded)) throw notFound();
  return decoded;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function toSafeInteger(value) {
  if (value === null || value === undefined) return 0;
  const number = Number(String(value));
  if (!Number.isSafeInteger(number)) throw new Error('unsafe_integer');
  return number;
}

async function readJson(request) {
  const type = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw new RequestError('invalid_content_type', 415);
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) throw new RequestError('request_too_large', 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new RequestError('request_too_large', 413);
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new RequestError('invalid_json');
  }
}

function readReason(value) {
  if (typeof value !== 'string') throw new RequestError('invalid_reason');
  const reason = value.trim();
  if (reason.length < 3 || reason.length > 500) throw new RequestError('invalid_reason');
  return reason;
}

// Zakres z przydziałów o podanych rolach. Przydział z class_id (obowiązkowy
// dla przedstawiciela) zawęża do tej klasy; przydział szerokiej roli bez
// class_id — do roku z school_year_id albo do wszystkich lat.
export function scopeFromGrants(grants, roles) {
  const scope = { any: false, allYears: false, years: [], classIds: [], classYears: [] };
  for (const grant of grants) {
    if (!roles.includes(grant.role)) continue;
    if (grant.classId) {
      scope.classIds.push(grant.classId);
      scope.classYears.push(grant.schoolYearId ?? null);
    } else if (WIDE_ROLES.has(grant.role)) {
      if (grant.schoolYearId) scope.years.push(grant.schoolYearId);
      else scope.allYears = true;
    } else {
      continue;
    }
    scope.any = true;
  }
  return scope;
}

// Parametry zakresu zajmują zawsze $1–$4; dalsze parametry zaczynają się od $5.
const scopeParams = (scope) => [scope.allYears, scope.years, scope.classIds, scope.classYears];
const CLASS_IN_SCOPE = (alias) => `($1::boolean OR ${alias}.school_year_id = ANY($2::text[])
  OR EXISTS (SELECT 1 FROM unnest($3::text[], $4::text[]) AS g(class_id, school_year_id)
              WHERE g.class_id = ${alias}.id AND (g.school_year_id IS NULL OR g.school_year_id = ${alias}.school_year_id)))`;
const STUDENT_IN_SCOPE = (studentExpr) => `($1::boolean OR EXISTS (
  SELECT 1 FROM enrollments se JOIN classes sc ON sc.id = se.class_id
   WHERE se.student_id = ${studentExpr} AND ${CLASS_IN_SCOPE('sc')}))`;

async function requireReadContext(request, env, roles = READ_ROLES) {
  const context = await loadAuthorizationContext(request, env);
  if (!context) throw new RequestError('unauthenticated', 401);
  const scope = scopeFromGrants(context.grants, roles);
  if (!scope.any) throw new RequestError('forbidden', 403);
  return { context, scope };
}

async function listClasses(request, env, url, json) {
  const schoolYearId = url.searchParams.get('schoolYearId');
  if (schoolYearId !== null && !ID_PATTERN.test(schoolYearId)) throw new RequestError('invalid_request');
  const { scope } = await requireReadContext(request, env);
  const { rows } = await env.db.query(
    `SELECT c.id, c.name, c.school_year_id, y.label AS school_year_label,
            to_char(y.starts_on, 'YYYY-MM-DD') AS starts_on,
            (SELECT count(*) FROM enrollments e WHERE e.class_id = c.id) AS student_count
       FROM classes c JOIN school_years y ON y.id = c.school_year_id
      WHERE ${CLASS_IN_SCOPE('c')} AND ($5::text IS NULL OR c.school_year_id = $5)
      ORDER BY y.starts_on DESC, c.name, c.id`,
    [...scopeParams(scope), schoolYearId],
  );
  return json({
    classes: rows.map((row) => ({
      id: row.id,
      name: row.name,
      schoolYearId: row.school_year_id,
      schoolYearLabel: row.school_year_label,
      studentCount: toSafeInteger(row.student_count),
    })),
  });
}

async function loadVisibleClass(executor, scope, classId) {
  const { rows } = await executor.query(
    `SELECT c.id, c.name, c.school_year_id, y.label AS school_year_label
       FROM classes c JOIN school_years y ON y.id = c.school_year_id
      WHERE c.id = $5 AND ${CLASS_IN_SCOPE('c')}`,
    [...scopeParams(scope), classId],
  );
  return rows[0] ?? null;
}

async function listClassStudents(request, env, classId, json) {
  const { scope } = await requireReadContext(request, env);
  const klass = await loadVisibleClass(env.db, scope, classId);
  if (!klass) throw notFound();
  const { rows } = await env.db.query(
    `SELECT s.id, s.first_name, s.last_name,
            COALESCE((
              SELECT json_agg(json_build_object('householdId', m.household_id, 'isPrimary', m.is_primary)
                              ORDER BY m.is_primary DESC, m.household_id)
                FROM student_households_current m WHERE m.student_id = s.id
            ), '[]'::json) AS households
       FROM enrollments e JOIN students s ON s.id = e.student_id
      WHERE e.class_id = $1
      ORDER BY s.last_name, s.first_name, s.id`,
    [classId],
  );
  return json({
    class: { id: klass.id, name: klass.name, schoolYearId: klass.school_year_id, schoolYearLabel: klass.school_year_label },
    students: rows.map((row) => ({
      id: row.id, firstName: row.first_name, lastName: row.last_name, households: row.households,
    })),
  });
}

function financialYears(context) {
  if (!isAuthorizedScoped(context, { roles: FINANCIAL_ROLES, requireMfa: true })) return null;
  const scope = scopeFromGrants(context.grants.filter((grant) => !grant.classId), FINANCIAL_ROLES);
  return scope.any ? scope : null;
}

async function getHousehold(request, env, householdId, json) {
  const { context, scope } = await requireReadContext(request, env);
  const params = [...scopeParams(scope), householdId];
  // Uczniowie gospodarstwa widoczni w zakresie (rodzeństwo poza zakresem jest pomijane).
  const students = await env.db.query(
    `SELECT s.id, s.first_name, s.last_name, m.is_primary,
            COALESCE((
              SELECT json_agg(json_build_object('classId', c.id, 'className', c.name, 'schoolYearId', c.school_year_id)
                              ORDER BY y.starts_on DESC, c.name)
                FROM enrollments e JOIN classes c ON c.id = e.class_id JOIN school_years y ON y.id = c.school_year_id
               WHERE e.student_id = s.id AND ${CLASS_IN_SCOPE('c')}
            ), '[]'::json) AS classes,
            COALESCE((
              SELECT json_agg(json_build_object('householdId', o.household_id, 'isPrimary', o.is_primary)
                              ORDER BY o.is_primary DESC, o.household_id)
                FROM student_households_current o WHERE o.student_id = s.id AND o.household_id <> $5
            ), '[]'::json) AS other_households
       FROM student_households_current m JOIN students s ON s.id = m.student_id
      WHERE m.household_id = $5 AND ${STUDENT_IN_SCOPE('s.id')}
      ORDER BY s.last_name, s.first_name, s.id`,
    params,
  );
  if (!students.rows.length) throw notFound();
  const visibleStudentIds = students.rows.map((row) => row.id);

  const household = await env.db.query('SELECT id, archived_at FROM households WHERE id = $1', [householdId]);
  const wide = scope.allYears || scope.years.length > 0;
  const guardians = await env.db.query(
    `SELECT g.id, g.first_name, g.last_name, g.email, g.contact_allowed,
            COALESCE((
              SELECT json_agg(json_build_object('studentId', sg.student_id, 'contactAllowed', sg.contact_allowed,
                                                'isPrimaryContact', sg.is_primary_contact) ORDER BY sg.student_id)
                FROM student_guardians sg
               WHERE sg.guardian_id = g.id AND sg.student_id = ANY($2::text[])
                 AND (sg.ends_on IS NULL OR sg.ends_on > CURRENT_DATE)
            ), '[]'::json) AS relations
       FROM guardian_households_current gh JOIN guardians g ON g.id = gh.guardian_id
      WHERE gh.household_id = $1
      ORDER BY g.last_name, g.first_name, g.id`,
    [householdId, visibleStudentIds],
  );

  const body = {
    household: { id: household.rows[0].id, archived: Boolean(household.rows[0].archived_at) },
    students: students.rows.map((row) => ({
      id: row.id,
      firstName: row.first_name,
      lastName: row.last_name,
      isPrimaryHousehold: row.is_primary,
      classes: row.classes,
      otherHouseholds: row.other_households,
    })),
    guardians: guardians.rows.map((row) => ({
      id: row.id,
      firstName: row.first_name,
      lastName: row.last_name,
      // Założenie (D-08): przedstawiciel widzi e-mail tylko przy zgodzie na kontakt.
      email: wide || row.contact_allowed ? row.email ?? null : null,
      contactAllowed: row.contact_allowed,
      relations: row.relations,
    })),
  };

  const finance = financialYears(context);
  if (finance) {
    const totals = await env.db.query(
      `SELECT t.school_year_id, t.net_amount_cents, t.payment_count
         FROM household_payment_totals t
        WHERE t.household_id = $3 AND ($1::boolean OR t.school_year_id = ANY($2::text[]))
        ORDER BY t.school_year_id`,
      [finance.allYears, finance.years, householdId],
    );
    body.paymentTotals = totals.rows.map((row) => ({
      schoolYearId: row.school_year_id,
      netAmountCents: toSafeInteger(row.net_amount_cents),
      paymentCount: toSafeInteger(row.payment_count),
    }));
  }
  return json(body);
}

const GUARDIAN_IN_SCOPE = `($1::boolean OR EXISTS (
    SELECT 1 FROM guardian_households_current gh JOIN student_households_current sh ON sh.household_id = gh.household_id
     WHERE gh.guardian_id = g.id AND ${STUDENT_IN_SCOPE('sh.student_id')})
  OR EXISTS (
    SELECT 1 FROM student_guardians sg
     WHERE sg.guardian_id = g.id AND (sg.ends_on IS NULL OR sg.ends_on > CURRENT_DATE)
       AND ${STUDENT_IN_SCOPE('sg.student_id')}))`;

function parseContactInput(data) {
  const input = { reason: readReason(data.reason) };
  if (Object.hasOwn(data, 'email')) {
    if (data.email === null || data.email === '') input.email = null;
    else if (typeof data.email === 'string') {
      const email = data.email.trim().toLowerCase();
      if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw new RequestError('invalid_email');
      input.email = email;
    } else throw new RequestError('invalid_email');
  }
  if (Object.hasOwn(data, 'contactAllowed')) {
    if (typeof data.contactAllowed !== 'boolean') throw new RequestError('invalid_request');
    input.contactAllowed = data.contactAllowed;
  }
  if (!Object.hasOwn(input, 'email') && !Object.hasOwn(input, 'contactAllowed')) throw new RequestError('invalid_request');
  return input;
}

async function setChangeContext(tx, { actorId, reason, effectiveOn = null }) {
  await tx.query(
    `SELECT set_config('rd.actor_id', $1, true), set_config('rd.change_reason', $2, true),
            set_config('rd.effective_on', $3, true)`,
    [actorId, reason, effectiveOn ?? ''],
  );
}

async function updateGuardianContact(request, env, guardianId, json) {
  const { context, scope } = await requireReadContext(request, env, EDIT_ROLES);
  const input = parseContactInput(await readJson(request));
  const actorId = context.session.user.id;
  const result = await env.db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT g.id, g.email, g.contact_allowed FROM guardians g
        WHERE g.id = $5 AND ${GUARDIAN_IN_SCOPE}
        FOR UPDATE OF g`,
      [...scopeParams(scope), guardianId],
    );
    const current = rows[0];
    if (!current) throw notFound();
    const next = {
      email: Object.hasOwn(input, 'email') ? input.email : current.email ?? null,
      contactAllowed: Object.hasOwn(input, 'contactAllowed') ? input.contactAllowed : current.contact_allowed,
    };
    const fields = [];
    if (next.email !== (current.email ?? null)) fields.push('email');
    if (next.contactAllowed !== current.contact_allowed) fields.push('contactAllowed');
    if (!fields.length) return { changed: false, next };
    await setChangeContext(tx, { actorId, reason: input.reason });
    await tx.query('UPDATE guardians SET email = $2, contact_allowed = $3 WHERE id = $1', [guardianId, next.email, next.contactAllowed]);
    await insertAuditEvent(tx, {
      actorId, action: 'guardian.contact.updated', entityType: 'guardian', entityId: guardianId,
      metadata: { fields },
    });
    return { changed: true, next };
  });
  return json({
    guardian: { id: guardianId, email: result.next.email, contactAllowed: result.next.contactAllowed },
    changed: result.changed,
  });
}

function parseEnrollmentInput(data) {
  if (!ID_PATTERN.test(String(data.schoolYearId ?? '')) || !ID_PATTERN.test(String(data.classId ?? ''))) {
    throw new RequestError('invalid_request');
  }
  if (typeof data.schoolYearId !== 'string' || typeof data.classId !== 'string') throw new RequestError('invalid_request');
  if (!validDate(data.effectiveOn)) throw new RequestError('invalid_effective_on');
  return { schoolYearId: data.schoolYearId, classId: data.classId, effectiveOn: data.effectiveOn, reason: readReason(data.reason) };
}

async function changeEnrollment(request, env, studentId, json) {
  const { context, scope } = await requireReadContext(request, env, EDIT_ROLES);
  const input = parseEnrollmentInput(await readJson(request));
  const actorId = context.session.user.id;
  const result = await env.db.transaction(async (tx) => {
    // Blokada ucznia serializuje równoległe zmiany (np. podwójne kliknięcie).
    const student = await tx.query(
      `SELECT s.id FROM students s WHERE s.id = $5 AND ${STUDENT_IN_SCOPE('s.id')} FOR UPDATE OF s`,
      [...scopeParams(scope), studentId],
    );
    if (!student.rows[0]) throw notFound();
    const klass = await loadVisibleClass(tx, scope, input.classId);
    if (!klass) throw new RequestError('class_not_found', 404);
    if (klass.school_year_id !== input.schoolYearId) throw new RequestError('class_year_mismatch');
    const existing = await tx.query(
      'SELECT id, class_id FROM enrollments WHERE student_id = $1 AND school_year_id = $2',
      [studentId, input.schoolYearId],
    );
    const enrollment = existing.rows[0];
    if (enrollment && enrollment.class_id === input.classId) {
      return { status: 200, changed: false, enrollmentId: enrollment.id };
    }
    await setChangeContext(tx, { actorId, reason: input.reason, effectiveOn: input.effectiveOn });
    if (enrollment) {
      await tx.query('UPDATE enrollments SET class_id = $2 WHERE id = $1', [enrollment.id, input.classId]);
      await insertAuditEvent(tx, {
        actorId, action: 'enrollment.class_changed', entityType: 'enrollment', entityId: enrollment.id,
        metadata: { studentId, schoolYearId: input.schoolYearId, fromClassId: enrollment.class_id, toClassId: input.classId },
      });
      return { status: 200, changed: true, enrollmentId: enrollment.id };
    }
    const enrollmentId = crypto.randomUUID();
    await tx.query(
      'INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)',
      [enrollmentId, studentId, input.classId, input.schoolYearId],
    );
    await insertAuditEvent(tx, {
      actorId, action: 'enrollment.created', entityType: 'enrollment', entityId: enrollmentId,
      metadata: { studentId, schoolYearId: input.schoolYearId, toClassId: input.classId },
    });
    return { status: 201, changed: true, enrollmentId };
  });
  return json({
    enrollment: { id: result.enrollmentId, studentId, schoolYearId: input.schoolYearId, classId: input.classId },
    changed: result.changed,
  }, result.status);
}

export async function handle(request, env, url, json) {
  const path = url.pathname;
  const studentsMatch = path.match(/^\/api\/classes\/([^/]+)\/students$/);
  const householdMatch = path.match(/^\/api\/households\/([^/]+)$/);
  const contactMatch = path.match(/^\/api\/guardians\/([^/]+)\/contact$/);
  const enrollmentMatch = path.match(/^\/api\/students\/([^/]+)\/enrollments$/);
  const method = request.method;
  let action = null;
  if (method === 'GET' && path === '/api/classes') action = () => listClasses(request, env, url, json);
  else if (method === 'GET' && studentsMatch) action = () => listClassStudents(request, env, decodeId(studentsMatch[1]), json);
  else if (method === 'GET' && householdMatch) action = () => getHousehold(request, env, decodeId(householdMatch[1]), json);
  else if (method === 'PATCH' && contactMatch) action = () => updateGuardianContact(request, env, decodeId(contactMatch[1]), json);
  else if (method === 'POST' && enrollmentMatch) action = () => changeEnrollment(request, env, decodeId(enrollmentMatch[1]), json);
  if (!action) return null;
  // handlePgRequest sprawdza Origin wcześniej; tu powtórnie, gdyby moduł użyto samodzielnie.
  if (method !== 'GET' && !isSameOrigin(request)) return json({ error: 'invalid_origin' }, 403);
  try {
    return await action();
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.code }, error.status);
    throw error;
  }
}
