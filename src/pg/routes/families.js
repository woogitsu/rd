// Katalog klas, uczniów i rodzin na PostgreSQL (issue #5). Prototyp — nie jest wdrożony.
//
//   GET   /api/classes[?schoolYearId=…]           klasy widoczne dla wywołującego
//   GET   /api/classes/{id}/students               uczniowie klasy z gospodarstwami
//   GET   /api/households/{id}                     karta gospodarstwa
//   PATCH /api/guardians/{id}/contact              zmiana e-maila / zgody na kontakt (admin, zarząd)
//   PATCH /api/guardians/{id}/students/{studentId} zgoda na kontakt w relacji z dzieckiem (admin, zarząd; #190)
//   POST  /api/students/{id}/enrollments           przypisanie lub zmiana klasy w roku (admin, zarząd)
//   POST  /api/students/{id}/enrollments/{eid}/end zakończenie przypisania — odejście ze szkoły (admin, zarząd; #86)
//
// Listy klasy, kartka gospodarstwa i licznik uczniów pokazują wyłącznie
// bieżące przypisania (enrollments_current, #86) — uczeń po odejściu znika
// z listy klasy i z karty gospodarstwa dla ról klasowych, ale zostaje
// widoczny w zakresie (STUDENT_IN_SCOPE) dla ról administracyjnych, żeby
// zakończenie dało się skorygować/przejrzeć historię.
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
import { recordDataAccess } from '../data-access.js';

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
// Aktywna relacja opiekun–uczeń: jedyne źródło prawdy to widok
// student_guardians_current (#157) — dlatego wszystkie odwołania do
// `student_guardians` poniżej, które mają liczyć się jako "aktualne",
// czytają z tego widoku zamiast powtarzać warunek starts_on/ends_on.
// Gospodarstwo kontaktowe ucznia (#95, założenie do D-08/D-11): należy do niego
// opiekun z aktywną relacją do tego ucznia i obiema zgodami na kontakt (relacji
// i opiekuna) — ta sama reguła co e-mail w liście klasy (buildClassRoster).
// Tylko takie gospodarstwa widzi przedstawiciel; pełny obraz ma zarząd.
const CONTACT_HOUSEHOLD = (householdExpr, studentExpr) => `EXISTS (
  SELECT 1 FROM guardian_households_current ch
    JOIN guardians cg ON cg.id = ch.guardian_id
    JOIN student_guardians_current csg ON csg.guardian_id = cg.id
   WHERE ch.household_id = ${householdExpr} AND csg.student_id = ${studentExpr}
     AND csg.contact_allowed AND cg.contact_allowed)`;
// Zakres wyłącznie klasowy (przedstawiciel, także zarząd z przydziałem klasy).
const isClassScoped = (scope) => !(scope.allYears || scope.years.length > 0);
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
            (SELECT count(*) FROM enrollments_current e WHERE e.class_id = c.id) AS student_count
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
  const { context, scope } = await requireReadContext(request, env);
  const actorId = context.session.user.id;
  const klass = await loadVisibleClass(env.db, scope, classId);
  if (!klass) {
    await recordDataAccess(env, { actorId, accessKind: 'class_students', classId, outcome: 'not_found' });
    throw notFound();
  }
  // Zakres klasowy: tylko gospodarstwa kontaktowe, bez oznaczenia głównego.
  const households = isClassScoped(scope)
    ? `SELECT json_agg(json_build_object('householdId', m.household_id) ORDER BY m.household_id)
         FROM student_households_current m WHERE m.student_id = s.id AND ${CONTACT_HOUSEHOLD('m.household_id', 's.id')}`
    : `SELECT json_agg(json_build_object('householdId', m.household_id, 'isPrimary', m.is_primary)
                       ORDER BY m.is_primary DESC, m.household_id)
         FROM student_households_current m WHERE m.student_id = s.id`;
  const { rows } = await env.db.query(
    `SELECT s.id, s.first_name, s.last_name,
            COALESCE((${households}), '[]'::json) AS households
       FROM enrollments_current e JOIN students s ON s.id = e.student_id
      WHERE e.class_id = $1
      ORDER BY s.last_name, s.first_name, s.id`,
    [classId],
  );
  await recordDataAccess(env, {
    actorId, accessKind: 'class_students', schoolYearId: klass.school_year_id, classId, outcome: 'ok', rowCount: rows.length,
  });
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
  const classScoped = isClassScoped(scope);
  const params = [...scopeParams(scope), householdId];
  // Zakres klasowy: uczeń tylko wtedy, gdy to gospodarstwo jest dla niego
  // kontaktowe; inne gospodarstwa ucznia tak samo, bez oznaczenia głównego.
  const otherHouseholds = classScoped
    ? `SELECT json_agg(json_build_object('householdId', o.household_id) ORDER BY o.household_id)
         FROM student_households_current o
        WHERE o.student_id = s.id AND o.household_id <> $5 AND ${CONTACT_HOUSEHOLD('o.household_id', 's.id')}`
    : `SELECT json_agg(json_build_object('householdId', o.household_id, 'isPrimary', o.is_primary)
                       ORDER BY o.is_primary DESC, o.household_id)
         FROM student_households_current o WHERE o.student_id = s.id AND o.household_id <> $5`;
  // Uczniowie gospodarstwa widoczni w zakresie (rodzeństwo poza zakresem jest pomijane).
  const students = await env.db.query(
    `SELECT s.id, s.first_name, s.last_name, m.is_primary,
            COALESCE((
              SELECT json_agg(json_build_object('classId', c.id, 'className', c.name, 'schoolYearId', c.school_year_id)
                              ORDER BY y.starts_on DESC, c.name)
                FROM enrollments_current e JOIN classes c ON c.id = e.class_id JOIN school_years y ON y.id = c.school_year_id
               WHERE e.student_id = s.id AND ${CLASS_IN_SCOPE('c')}
            ), '[]'::json) AS classes,
            COALESCE((${otherHouseholds}), '[]'::json) AS other_households
       FROM student_households_current m JOIN students s ON s.id = m.student_id
      WHERE m.household_id = $5 AND ${STUDENT_IN_SCOPE('s.id')}
        ${classScoped ? `AND ${CONTACT_HOUSEHOLD('m.household_id', 's.id')}` : ''}
      ORDER BY s.last_name, s.first_name, s.id`,
    params,
  );
  const actorId = context.session.user.id;
  if (!students.rows.length) {
    await recordDataAccess(env, { actorId, accessKind: 'household_card', householdId, outcome: 'not_found' });
    throw notFound();
  }
  const visibleStudentIds = students.rows.map((row) => row.id);

  const household = await env.db.query('SELECT id, archived_at FROM households WHERE id = $1', [householdId]);
  // Zakres klasowy: tylko opiekunowie z aktywną relacją do widocznego ucznia;
  // e-mail tylko przy zgodzie opiekuna i zgodzie relacji do widocznego ucznia.
  const guardians = await env.db.query(
    `SELECT g.id, g.first_name, g.last_name, g.email, g.contact_allowed,
            EXISTS (
              SELECT 1 FROM student_guardians_current sg
               WHERE sg.guardian_id = g.id AND sg.student_id = ANY($2::text[])
                 AND sg.contact_allowed
            ) AS relation_contact_allowed,
            COALESCE((
              SELECT json_agg(json_build_object('studentId', sg.student_id, 'contactAllowed', sg.contact_allowed,
                                                'isPrimaryContact', sg.is_primary_contact) ORDER BY sg.student_id)
                FROM student_guardians_current sg
               WHERE sg.guardian_id = g.id AND sg.student_id = ANY($2::text[])
            ), '[]'::json) AS relations
       FROM guardian_households_current gh JOIN guardians g ON g.id = gh.guardian_id
      WHERE gh.household_id = $1
        ${classScoped ? `AND EXISTS (SELECT 1 FROM student_guardians_current sg
                                     WHERE sg.guardian_id = g.id AND sg.student_id = ANY($2::text[]))` : ''}
      ORDER BY g.last_name, g.first_name, g.id`,
    [householdId, visibleStudentIds],
  );

  const body = {
    household: { id: household.rows[0].id, archived: Boolean(household.rows[0].archived_at) },
    students: students.rows.map((row) => ({
      id: row.id,
      firstName: row.first_name,
      lastName: row.last_name,
      ...(classScoped ? {} : { isPrimaryHousehold: row.is_primary }),
      classes: row.classes,
      otherHouseholds: row.other_households,
    })),
    guardians: guardians.rows.map((row) => {
      // Założenie (D-08): zakres klasowy widzi e-mail tylko przy obu zgodach;
      // role szerokie widzą e-mail zawsze (bez zmian, do decyzji D-08).
      const contactAllowed = classScoped ? row.contact_allowed && row.relation_contact_allowed : row.contact_allowed;
      return {
        id: row.id,
        firstName: row.first_name,
        lastName: row.last_name,
        email: !classScoped || contactAllowed ? row.email ?? null : null,
        contactAllowed,
        relations: row.relations,
      };
    }),
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
  await recordDataAccess(env, { actorId, accessKind: 'household_card', householdId, outcome: 'ok', rowCount: students.rows.length });
  return json(body);
}

const GUARDIAN_IN_SCOPE = `($1::boolean OR EXISTS (
    SELECT 1 FROM guardian_households_current gh JOIN student_households_current sh ON sh.household_id = gh.household_id
     WHERE gh.guardian_id = g.id AND ${STUDENT_IN_SCOPE('sh.student_id')})
  OR EXISTS (
    SELECT 1 FROM student_guardians_current sg
     WHERE sg.guardian_id = g.id
       AND ${STUDENT_IN_SCOPE('sg.student_id')}))`;
// Zakres klasowy (#200): opiekun tylko przez aktywną relację z uczniem z zakresu,
// nie przez wspólne gospodarstwo — ta sama reguła co karta gospodarstwa (#95).
const GUARDIAN_RELATED_IN_SCOPE = `EXISTS (
    SELECT 1 FROM student_guardians_current sg
     WHERE sg.guardian_id = g.id
       AND ${STUDENT_IN_SCOPE('sg.student_id')})`;

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
        WHERE g.id = $5 AND ${isClassScoped(scope) ? GUARDIAN_RELATED_IN_SCOPE : GUARDIAN_IN_SCOPE}
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

// Zgoda na kontakt w relacji opiekun–dziecko (#190). Tę flagę (razem ze zgodą
// opiekuna) sprawdza dobór adresatów kampanii i lista klasy. Role jak przy
// zmianie kontaktu opiekuna; zakres klasowy — tylko aktywna relacja z uczniem
// z zakresu. Relacja poza zakresem i nieistniejąca: 404. Historia zmian:
// student_guardian_changes (trigger z 0026, aktor i powód z setChangeContext).
function parseRelationInput(data) {
  if (typeof data.contactAllowed !== 'boolean') throw new RequestError('invalid_request');
  return { contactAllowed: data.contactAllowed, reason: readReason(data.reason) };
}

async function updateRelationContact(request, env, guardianId, studentId, json) {
  const { context, scope } = await requireReadContext(request, env, EDIT_ROLES);
  const input = parseRelationInput(await readJson(request));
  const actorId = context.session.user.id;
  const result = await env.db.transaction(async (tx) => {
    // Blokada wiersza relacji serializuje podwójne kliknięcie i ponowienie.
    const { rows } = await tx.query(
      `SELECT sg.contact_allowed, g.contact_allowed AS guardian_contact_allowed,
              student_guardian_relation_ended(sg.guardian_id, sg.student_id) AS ended
         FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
        WHERE sg.guardian_id = $5 AND sg.student_id = $6 AND ${STUDENT_IN_SCOPE('sg.student_id')}
          ${isClassScoped(scope) ? `AND EXISTS (
              SELECT 1 FROM student_guardians_current sgc
               WHERE sgc.guardian_id = sg.guardian_id AND sgc.student_id = sg.student_id)` : ''}
        FOR UPDATE OF sg`,
      [...scopeParams(scope), guardianId, studentId],
    );
    const current = rows[0];
    if (!current) throw notFound();
    const guardianContactAllowed = current.guardian_contact_allowed;
    if (current.contact_allowed === input.contactAllowed) return { changed: false, guardianContactAllowed };
    if (current.ended) throw new RequestError('relation_ended', 409);
    await setChangeContext(tx, { actorId, reason: input.reason });
    await tx.query(
      'UPDATE student_guardians SET contact_allowed = $3 WHERE guardian_id = $1 AND student_id = $2',
      [guardianId, studentId, input.contactAllowed],
    );
    await insertAuditEvent(tx, {
      actorId, action: 'student_guardian.contact.updated', entityType: 'student_guardian',
      entityId: `${studentId}:${guardianId}`,
      metadata: { studentId, guardianId, contactAllowed: input.contactAllowed },
    });
    return { changed: true, guardianContactAllowed };
  });
  return json({
    relation: { guardianId, studentId, contactAllowed: input.contactAllowed },
    // Kampania wymaga obu zgód; bez zgody opiekuna relacja nadal nie daje adresata.
    guardianContactAllowed: result.guardianContactAllowed,
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

// Zakończenie przypisania (#86) — odejście ze szkoły w trakcie roku. Data
// może być przyszła (uczeń widoczny do tej daty); ponowienie tej samej
// operacji nie tworzy drugiego wpisu historii (enrollment_guard blokuje
// dalsze zmiany po ustawieniu ended_on, więc powtórka zwraca changed: false).
// Wpłaty zapisane wcześniej nie są zmieniane; odejście nie tworzy żadnej
// należności ani zwrotu (decyzja o ewentualnym zwrocie — Rada, D-04).
function parseEndEnrollmentInput(data) {
  if (!validDate(data.endedOn)) throw new RequestError('invalid_ended_on');
  return { endedOn: data.endedOn, reason: readReason(data.reason) };
}

async function endEnrollment(request, env, studentId, enrollmentId, json) {
  const { context, scope } = await requireReadContext(request, env, EDIT_ROLES);
  const input = parseEndEnrollmentInput(await readJson(request));
  const actorId = context.session.user.id;
  const result = await env.db.transaction(async (tx) => {
    // Blokada wiersza serializuje podwójne kliknięcie i ponowienie.
    const { rows } = await tx.query(
      `SELECT e.id, to_char(e.ended_on, 'YYYY-MM-DD') AS ended_on
         FROM enrollments e
        WHERE e.id = $5 AND e.student_id = $6 AND ${STUDENT_IN_SCOPE('e.student_id')}
        FOR UPDATE OF e`,
      [...scopeParams(scope), enrollmentId, studentId],
    );
    const enrollment = rows[0];
    if (!enrollment) throw notFound();
    if (enrollment.ended_on) return { changed: false, endedOn: enrollment.ended_on };
    await tx.query(
      'UPDATE enrollments SET ended_on = $2, ended_reason = $3, ended_by = $4, ended_at = now() WHERE id = $1',
      [enrollmentId, input.endedOn, input.reason, actorId],
    );
    await insertAuditEvent(tx, {
      actorId, action: 'enrollment.withdrawn', entityType: 'enrollment', entityId: enrollmentId,
      metadata: { studentId, endedOn: input.endedOn },
    });
    return { changed: true, endedOn: input.endedOn };
  });
  return json({
    enrollment: { id: enrollmentId, studentId, endedOn: result.endedOn },
    changed: result.changed,
  });
}

export async function handle(request, env, url, json) {
  const path = url.pathname;
  const studentsMatch = path.match(/^\/api\/classes\/([^/]+)\/students$/);
  const householdMatch = path.match(/^\/api\/households\/([^/]+)$/);
  const contactMatch = path.match(/^\/api\/guardians\/([^/]+)\/contact$/);
  const relationMatch = path.match(/^\/api\/guardians\/([^/]+)\/students\/([^/]+)$/);
  const enrollmentEndMatch = path.match(/^\/api\/students\/([^/]+)\/enrollments\/([^/]+)\/end$/);
  const enrollmentMatch = path.match(/^\/api\/students\/([^/]+)\/enrollments$/);
  const method = request.method;
  let action = null;
  if (method === 'GET' && path === '/api/classes') action = () => listClasses(request, env, url, json);
  else if (method === 'GET' && studentsMatch) action = () => listClassStudents(request, env, decodeId(studentsMatch[1]), json);
  else if (method === 'GET' && householdMatch) action = () => getHousehold(request, env, decodeId(householdMatch[1]), json);
  else if (method === 'PATCH' && contactMatch) action = () => updateGuardianContact(request, env, decodeId(contactMatch[1]), json);
  else if (method === 'PATCH' && relationMatch) {
    action = () => updateRelationContact(request, env, decodeId(relationMatch[1]), decodeId(relationMatch[2]), json);
  }
  else if (method === 'POST' && enrollmentEndMatch) {
    action = () => endEnrollment(request, env, decodeId(enrollmentEndMatch[1]), decodeId(enrollmentEndMatch[2]), json);
  }
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
