// Promocja uczniów na nowy rok szkolny i kopiowanie struktury klas (#78).
// Prototyp — nie jest wdrożony i nie jest gotowy do pracy na danych rodzin.
//
//   POST /api/admin/promotions/classes/preview  { fromSchoolYearId, toSchoolYearId, classMap }
//   POST /api/admin/promotions/classes/apply    to samo; tworzy brakujące klasy roku docelowego
//   POST /api/admin/promotions/preview          { fromSchoolYearId, toSchoolYearId, classMap, exclusions?, overrides? }
//   POST /api/admin/promotions/apply            to samo + { planDigest }; nagłówek Idempotency-Key
//
// Wariant zachowawczy (decyzje zarządu/szkoły: D-03, D-08, D-21):
// * Bez jawnej mapy klas (`classMap`) nie powstaje żadna promocja ani kopia klas —
//   nie zgadujemy następnika po nazwie klasy. Klasa nieujęta w mapie = uczniowie
//   NIE są przenoszeni (status `unmapped` w raporcie). `null` w mapie = klasa
//   końcowa (`graduating`, bez przypisania).
// * Powtarzanie klasy i inne wyjątki: `exclusions` (uczeń bez przypisania) i
//   `overrides` (inna klasa docelowa) wskazuje wyłącznie admin w podglądzie.
// * Wyłącznie admin z MFA (dispatch w admin.js). Podgląd nic nie zapisuje.
// * Zapis to WYŁĄCZNIE nowe wiersze enrollments w roku docelowym (historia
//   starego roku nietknięta), w jednej transakcji, z powodem 'promotion'
//   w enrollment_history, zdarzeniem podsumowującym i zdarzeniem na przypisanie
//   (same identyfikatory, bez imion i nazwisk). Nie zmienia gospodarstw ani opiekunów.
// * Uczeń już przypisany w roku docelowym to konflikt — nie jest nadpisywany.
// * Uczeń z ustawionym enrollments.ended_on (odejście, #86 — także z datą przyszłą,
//   wariant zachowawczy) nie jest promowany; widnieje jako `withdrawn`.
// * `planDigest` obejmuje cały plan; zmiana danych między podglądem a zapisem
//   daje 409 plan_stale. Ten sam Idempotency-Key + ten sam plan zwraca zapisany
//   wynik (replayed: true) bez nowych wierszy.
// * Przydziały `representative` nie są przedłużane — podgląd tylko wskazuje klasy
//   docelowe bez aktywnego przedstawiciela (missingRepresentative).

import { createHash } from 'node:crypto';
import { insertAuditEvent } from './audit.js';
import { ApiError, readIdempotencyKey, readJsonObject } from './input.js';

export { ApiError as PromotionError };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_MAP_ENTRIES = 200;
const MAX_STUDENTS = 2000;
const LOCK_KEY = 'rd_promotion';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const validId = (value) => typeof value === 'string' && ID_PATTERN.test(value);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function readCommon(data) {
  if (!validId(data.fromSchoolYearId) || !validId(data.toSchoolYearId)) throw new ApiError('invalid_school_year_id');
  if (data.fromSchoolYearId === data.toSchoolYearId) throw new ApiError('same_school_year', 422);
  if (!isPlainObject(data.classMap)) throw new ApiError('class_map_required', 422);
  const entries = Object.entries(data.classMap);
  if (!entries.length) throw new ApiError('class_map_required', 422);
  if (entries.length > MAX_MAP_ENTRIES) throw new ApiError('invalid_class_map');
  for (const [key, value] of entries) {
    if (!validId(key)) throw new ApiError('invalid_class_map');
    if (value !== null && typeof value !== 'string') throw new ApiError('invalid_class_map');
  }
  return { fromSchoolYearId: data.fromSchoolYearId, toSchoolYearId: data.toSchoolYearId, classMap: data.classMap };
}

function readPromotionInput(data) {
  const input = readCommon(data);
  const exclusions = data.exclusions ?? [];
  if (!Array.isArray(exclusions) || exclusions.length > MAX_STUDENTS || !exclusions.every(validId)) {
    throw new ApiError('invalid_exclusions');
  }
  const overrides = data.overrides ?? {};
  if (!isPlainObject(overrides) || Object.keys(overrides).length > MAX_STUDENTS
    || !Object.entries(overrides).every(([student, klass]) => validId(student) && validId(klass))) {
    throw new ApiError('invalid_overrides');
  }
  return { ...input, exclusions: [...new Set(exclusions)], overrides };
}

async function loadYears(q, input) {
  const { rows } = await q.query(
    `SELECT y.id, y.starts_on::text AS starts_on,
            coalesce((SELECT c.status FROM school_year_closures c WHERE c.school_year_id = y.id), 'open') AS status
       FROM school_years y WHERE y.id = ANY($1::text[])`,
    [[input.fromSchoolYearId, input.toSchoolYearId]],
  );
  const from = rows.find((row) => row.id === input.fromSchoolYearId);
  const to = rows.find((row) => row.id === input.toSchoolYearId);
  if (!from || !to) throw new ApiError('school_year_not_found', 404);
  if (to.starts_on <= from.starts_on) throw new ApiError('invalid_year_order', 422);
  return { from, to };
}

async function loadClasses(q, schoolYearId) {
  const { rows } = await q.query('SELECT id, name FROM classes WHERE school_year_id = $1 ORDER BY name, id', [schoolYearId]);
  return rows;
}

function checkMapSources(classMap, fromClasses) {
  const known = new Set(fromClasses.map((row) => row.id));
  for (const key of Object.keys(classMap)) if (!known.has(key)) throw new ApiError('unknown_source_class', 422);
}

// --- Kopiowanie struktury klas ------------------------------------------------

// classMap: { "<id klasy źródłowej>": "<nazwa klasy w roku docelowym>" | null }
async function buildClassCopyPlan(q, input) {
  await loadYears(q, input);
  const fromClasses = await loadClasses(q, input.fromSchoolYearId);
  checkMapSources(input.classMap, fromClasses);
  const toClasses = await loadClasses(q, input.toSchoolYearId);
  const byName = new Map(toClasses.map((row) => [row.name.toLowerCase(), row]));
  const seenTargets = new Set();
  const items = [];
  for (const source of fromClasses) {
    if (!Object.hasOwn(input.classMap, source.id)) {
      items.push({ fromClassId: source.id, fromName: source.name, action: 'unmapped', toName: null, toClassId: null });
      continue;
    }
    const raw = input.classMap[source.id];
    if (raw === null) {
      items.push({ fromClassId: source.id, fromName: source.name, action: 'final', toName: null, toClassId: null });
      continue;
    }
    const name = raw.trim();
    if (!name || name.length > 60) throw new ApiError('invalid_class_map');
    const key = name.toLowerCase();
    if (seenTargets.has(key)) throw new ApiError('duplicate_name');
    seenTargets.add(key);
    const existing = byName.get(key);
    items.push({
      fromClassId: source.id, fromName: source.name, action: existing ? 'exists' : 'create',
      toName: existing ? existing.name : name, toClassId: existing ? existing.id : null,
    });
  }
  return { fromSchoolYearId: input.fromSchoolYearId, toSchoolYearId: input.toSchoolYearId, classes: items };
}

function slugify(name) {
  return String(name).trim().toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function copyClassesPreview(env, request, json) {
  const input = readCommon(await readJsonObject(request, { maxBytes: MAX_BODY_BYTES }));
  return json(await buildClassCopyPlan(env.db, input));
}

async function copyClassesApply(env, actorId, request, json) {
  const input = readCommon(await readJsonObject(request, { maxBytes: MAX_BODY_BYTES }));
  const result = await env.db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK_KEY]);
    const { to } = await loadYears(tx, input);
    if (to.status === 'closed') throw new ApiError('school_year_closed', 409);
    const plan = await buildClassCopyPlan(tx, input);
    const created = [];
    for (const item of plan.classes) {
      if (item.action !== 'create') continue;
      let id = `${input.toSchoolYearId}-${slugify(item.toName)}`;
      const taken = await tx.query('SELECT 1 FROM classes WHERE id = $1', [id]);
      if (id === `${input.toSchoolYearId}-` || taken.rows.length) id = `${input.toSchoolYearId}-${crypto.randomUUID()}`;
      await tx.query('INSERT INTO classes (id, school_year_id, name) VALUES ($1, $2, $3)', [id, input.toSchoolYearId, item.toName]);
      await insertAuditEvent(tx, {
        actorId, action: 'class.created', entityType: 'class', entityId: id,
        metadata: { schoolYearId: input.toSchoolYearId, copiedFromClassId: item.fromClassId },
      });
      item.toClassId = id;
      item.action = 'created';
      created.push(id);
    }
    return { ...plan, createdCount: created.length };
  });
  return json(result, result.createdCount ? 201 : 200);
}

// --- Promocja -----------------------------------------------------------------

async function buildPlan(q, input) {
  await loadYears(q, input);
  const fromClasses = await loadClasses(q, input.fromSchoolYearId);
  const toClasses = await loadClasses(q, input.toSchoolYearId);
  checkMapSources(input.classMap, fromClasses);
  const toById = new Map(toClasses.map((row) => [row.id, row]));
  for (const target of Object.values(input.classMap)) {
    if (target !== null && !toById.has(target)) throw new ApiError('unknown_target_class', 422);
  }
  for (const target of Object.values(input.overrides)) {
    if (!toById.has(target)) throw new ApiError('unknown_target_class', 422);
  }

  const enrollments = await q.query(
    `SELECT e.id, e.student_id, e.class_id,
            (e.ended_on IS NULL) AS active,
            (SELECT t.class_id FROM enrollments t
              WHERE t.student_id = e.student_id AND t.school_year_id = $2) AS existing_class_id
       FROM enrollments e WHERE e.school_year_id = $1 ORDER BY e.student_id`,
    [input.fromSchoolYearId, input.toSchoolYearId],
  );
  if (enrollments.rows.length > MAX_STUDENTS) throw new ApiError('plan_too_large', 422);
  const students = new Set(enrollments.rows.map((row) => row.student_id));
  const excluded = new Set(input.exclusions);
  for (const id of [...excluded, ...Object.keys(input.overrides)]) {
    if (!students.has(id)) throw new ApiError('unknown_student', 422);
  }

  const items = enrollments.rows.map((row) => {
    const item = {
      studentId: row.student_id, enrollmentId: row.id, fromClassId: row.class_id, toClassId: null,
      existingClassId: null, status: null,
    };
    if (!row.active) return { ...item, status: 'withdrawn' };
    if (excluded.has(row.student_id)) return { ...item, status: 'excluded' };
    let target;
    if (Object.hasOwn(input.overrides, row.student_id)) target = input.overrides[row.student_id];
    else if (!Object.hasOwn(input.classMap, row.class_id)) return { ...item, status: 'unmapped' };
    else target = input.classMap[row.class_id];
    if (target === null) return { ...item, status: 'graduating' };
    if (row.existing_class_id) return { ...item, status: 'conflict', toClassId: target, existingClassId: row.existing_class_id };
    return { ...item, status: 'promote', toClassId: target };
  });

  const counts = { promote: 0, graduating: 0, unmapped: 0, excluded: 0, conflict: 0, withdrawn: 0 };
  for (const item of items) counts[item.status] += 1;
  const classes = fromClasses.map((source) => {
    const own = items.filter((item) => item.fromClassId === source.id);
    const target = Object.hasOwn(input.classMap, source.id) ? input.classMap[source.id] : undefined;
    const row = { fromClassId: source.id, fromName: source.name, toClassId: target ?? null, toName: target ? toById.get(target).name : null,
      mapped: target !== undefined, total: own.length };
    for (const status of Object.keys(counts)) row[status] = own.filter((item) => item.status === status).length;
    return row;
  });

  const targets = [...new Set(items.filter((item) => item.status === 'promote').map((item) => item.toClassId))];
  const coverage = targets.length ? await q.query(
    `SELECT c.id, c.name FROM classes c
      WHERE c.id = ANY($1::text[]) AND NOT EXISTS (
        SELECT 1 FROM role_grants g
         WHERE g.class_id = c.id AND g.role = 'representative'
           AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now()))
      ORDER BY c.name, c.id`,
    [targets],
  ) : { rows: [] };

  const planDigest = sha256(JSON.stringify({
    from: input.fromSchoolYearId, to: input.toSchoolYearId,
    items: items.map((item) => [item.studentId, item.enrollmentId, item.status, item.fromClassId, item.toClassId, item.existingClassId]),
  }));
  return {
    fromSchoolYearId: input.fromSchoolYearId, toSchoolYearId: input.toSchoolYearId,
    counts, classes, students: items,
    missingRepresentative: coverage.rows.map((row) => ({ classId: row.id, name: row.name })),
    planDigest,
  };
}

async function previewRoute(env, request, json) {
  const input = readPromotionInput(await readJsonObject(request, { maxBytes: MAX_BODY_BYTES }));
  return json(await buildPlan(env.db, input));
}

function summarize(row) {
  return {
    runId: row.id, fromSchoolYearId: row.from_school_year_id, toSchoolYearId: row.to_school_year_id, planDigest: row.plan_digest,
    counts: {
      promote: row.promoted_count, graduating: row.graduating_count, unmapped: row.unmapped_count,
      excluded: row.excluded_count, conflict: row.conflict_count, withdrawn: row.withdrawn_count,
    },
  };
}

async function applyRoute(env, actorId, request, json) {
  const key = readIdempotencyKey(request);
  const data = await readJsonObject(request, { maxBytes: MAX_BODY_BYTES });
  const input = readPromotionInput(data);
  if (typeof data.planDigest !== 'string' || !HEX64.test(data.planDigest)) throw new ApiError('invalid_plan_digest');

  const result = await env.db.transaction(async (tx) => {
    // Jedna promocja naraz: podwójne kliknięcie i równoległe ponowienia czekają tutaj.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK_KEY]);
    const previous = await tx.query('SELECT * FROM promotion_runs WHERE idempotency_key = $1', [key]);
    if (previous.rows[0]) {
      const row = previous.rows[0];
      if (row.plan_digest !== data.planDigest || row.from_school_year_id !== input.fromSchoolYearId
        || row.to_school_year_id !== input.toSchoolYearId) throw new ApiError('idempotency_key_reused', 409);
      return { status: 200, body: { ...summarize(row), replayed: true } };
    }
    const { to } = await loadYears(tx, input);
    if (to.status === 'closed') throw new ApiError('school_year_closed', 409);
    const plan = await buildPlan(tx, input);
    if (plan.planDigest !== data.planDigest) throw new ApiError('plan_stale', 409);
    const promote = plan.students.filter((item) => item.status === 'promote');
    if (!promote.length) throw new ApiError('nothing_to_promote', 422);

    const runId = crypto.randomUUID();
    await tx.query(
      `SELECT set_config('rd.actor_id', $1, true), set_config('rd.change_reason', 'promotion', true),
              set_config('rd.effective_on', $2, true)`,
      [actorId, to.starts_on],
    );
    for (const item of promote) {
      const enrollmentId = crypto.randomUUID();
      await tx.query(
        'INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)',
        [enrollmentId, item.studentId, item.toClassId, input.toSchoolYearId],
      );
      await insertAuditEvent(tx, {
        actorId, action: 'enrollment.promoted', entityType: 'enrollment', entityId: enrollmentId,
        metadata: {
          runId, studentId: item.studentId, schoolYearId: input.toSchoolYearId, fromSchoolYearId: input.fromSchoolYearId,
          fromClassId: item.fromClassId, toClassId: item.toClassId,
        },
      });
    }
    const c = plan.counts;
    await tx.query(
      `INSERT INTO promotion_runs (id, actor_id, from_school_year_id, to_school_year_id, idempotency_key, plan_digest,
                                   promoted_count, graduating_count, unmapped_count, excluded_count, conflict_count, withdrawn_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [runId, actorId, input.fromSchoolYearId, input.toSchoolYearId, key, plan.planDigest,
        c.promote, c.graduating, c.unmapped, c.excluded, c.conflict, c.withdrawn],
    );
    await insertAuditEvent(tx, {
      actorId, action: 'promotion.applied', entityType: 'promotion_run', entityId: runId,
      metadata: { schoolYearId: input.toSchoolYearId, fromSchoolYearId: input.fromSchoolYearId, ...c },
    });
    return {
      status: 201,
      body: {
        runId, fromSchoolYearId: input.fromSchoolYearId, toSchoolYearId: input.toSchoolYearId,
        planDigest: plan.planDigest, counts: c, replayed: false,
      },
    };
  });
  return json(result.body, result.status);
}

// segments: ścieżka po /api/admin/, np. ['promotions', 'preview'].
// Zwraca undefined dla nieznanej ścieżki (router admina odpowie 404/405).
export function routePromotions(env, actorId, request, segments, json) {
  const method = request.method;
  const [, first, second] = segments;
  if (segments.length === 2 && first === 'preview' && method === 'POST') return previewRoute(env, request, json);
  if (segments.length === 2 && first === 'apply' && method === 'POST') return applyRoute(env, actorId, request, json);
  if (segments.length === 3 && first === 'classes' && second === 'preview' && method === 'POST') return copyClassesPreview(env, request, json);
  if (segments.length === 3 && first === 'classes' && second === 'apply' && method === 'POST') return copyClassesApply(env, actorId, request, json);
  return undefined;
}

export function promotionAllowedMethods(segments) {
  const [, first, second] = segments;
  if (segments.length === 2 && (first === 'preview' || first === 'apply')) return ['POST'];
  if (segments.length === 3 && first === 'classes' && (second === 'preview' || second === 'apply')) return ['POST'];
  return null;
}
