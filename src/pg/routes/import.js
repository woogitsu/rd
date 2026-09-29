// Import uczniów i opiekunów do PostgreSQL (issue #36, część #2). Prototyp.
//
//   GET  /api/import/options  lata szkolne i nazwy klas dostępne dla importującego
//   POST /api/import/preview  walidacja + różnica względem bazy; NIC nie zapisuje
//   POST /api/import/commit   jedna transakcja, wszystko albo nic; nagłówek Idempotency-Key
//
// Przeglądarka parsuje plik (import/core.js) i wysyła wyłącznie znormalizowane
// wiersze w JSON. Serwer nie otrzymuje ani nie przechowuje pliku źródłowego.
// Walidacja jest powtarzana tutaj tą samą funkcją validateRows.
//
// Dopasowanie do istniejących rekordów wyłącznie po stabilnych identyfikatorach
// ze źródła (ID ucznia, ID rodziny). Nigdy po samym nazwisku ani e-mailu.
// Opiekun jest rozpoznawany tylko w obrębie już ustalonej rodziny.
//
// Role: admin i board z MFA, przydział bez ograniczenia do klasy. To założenie
// do potwierdzenia w decyzji D-08 (docs/DECISIONS.md).
//
// Odpowiedzi nie zawierają imion, nazwisk ani adresów — tylko numery wierszy,
// komunikaty i liczniki. Wiersze danych zna już przeglądarka użytkownika.

import { createHash, randomUUID } from 'node:crypto';
import { FIELDS, validateRows } from '../../../import/core.js';
import { insertAuditEvent } from '../audit.js';
import { requireAccess } from '../authorization.js';
import { isProductionLikeEnv } from '../../app-env.js';

export const name = 'import';
export const IMPORT_ROLES = Object.freeze(['admin', 'board']);
export const FIELD_KEYS = Object.freeze(FIELDS.map(([key]) => key));
export const IMPORT_FORMAT_VERSION = 1;
// #248: powód zmiany, jaki widzi historia rodzin/przypisań (triggery z 0014/0023
// czytają rd.change_reason). Stała, kontrolowana wartość — import nie przyjmuje
// dowolnego tekstu od operatora.
export const IMPORT_CHANGE_REASON = 'import_csv_xlsx';
// Ten sam limit co globalny limit ciała żądania w src/node-app.js.
export const MAX_IMPORT_BODY_BYTES = 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;
const MAX_CELL_LENGTH = 1000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ACCESS = Object.freeze({ roles: IMPORT_ROLES, requireMfa: true });

export const MESSAGES = Object.freeze({
  missingStudentId: 'Brak ID ucznia — wymaga ręcznego powiązania.',
  missingHouseholdId: 'Brak ID rodziny — wymaga ręcznego powiązania albo zgody na utworzenie osobnej rodziny.',
  nameMismatch: 'Imię lub nazwisko ucznia różni się od zapisu w bazie — wymaga ręcznego sprawdzenia.',
  householdMismatch: 'Uczeń jest w bazie przypisany do innej rodziny — wymaga ręcznego powiązania.',
  classMismatch: 'Uczeń ma w tym roku inną klasę w bazie — zmiana wymaga ręcznej decyzji.',
  emailElsewhere: 'Ten sam adres e-mail opiekuna występuje w innej rodzinie — rodzin nie łączymy automatycznie.',
  noCurrentHousehold: 'Uczeń nie ma w bazie bieżącego głównego gospodarstwa — wymaga ręcznego powiązania.',
  noHouseholdLink: 'Wiersz bez ID rodziny: utworzono osobną rodzinę; rodzeństwo nie zostanie powiązane.',
  guardianMaybeChanged: 'Możliwa zmiana danych opiekuna (e-mail lub pisownia) — wymaga ręcznej decyzji. Nie utworzono nowego opiekuna.',
});

class ImportError extends Error {
  constructor(status, code, message) {
    super(code);
    this.status = status;
    this.code = code;
    this.publicMessage = message;
  }
}

const norm = (value) => String(value ?? '').trim().toLocaleLowerCase('pl-PL').replace(/\s+/g, ' ');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// #166: bramka fail-closed przez wspólną normalizację (src/app-env.js).
// Import jest dostępny bez IMPORT_ENABLED=true wyłącznie przy jawnym
// APP_ENV=development|test|staging (dowolna wielkość liter). 'production',
// 'prod', brak APP_ENV i każda nieznana wartość wymagają IMPORT_ENABLED=true
// (dokładnie 'true') — literówka w konfiguracji nie otwiera importu danych
// dzieci i opiekunów.
function importDisabled(env) {
  return isProductionLikeEnv(env?.APP_ENV) && env?.IMPORT_ENABLED !== 'true';
}

// Przydział musi obejmować wszystkie klasy; rok — wskazany albo wszystkie.
function qualifyingGrants(context, schoolYearId) {
  return context.grants.filter((grant) => IMPORT_ROLES.includes(grant.role) && !grant.classId
    && (!schoolYearId || !grant.schoolYearId || grant.schoolYearId === schoolYearId));
}

async function readJsonBody(request) {
  const type = request.headers.get('Content-Type') ?? '';
  if (!/^application\/json\b/i.test(type)) throw new ImportError(415, 'unsupported_media_type');
  const declared = Number(request.headers.get('Content-Length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_IMPORT_BODY_BYTES) throw new ImportError(413, 'request_too_large');
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BODY_BYTES) throw new ImportError(413, 'request_too_large');
  try { return JSON.parse(text); } catch { throw new ImportError(400, 'invalid_json'); }
}

function cell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') throw new ImportError(400, 'invalid_cell');
  if (value.length > MAX_CELL_LENGTH) throw new ImportError(400, 'invalid_cell');
  return value;
}

export function parseImportPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ImportError(400, 'invalid_payload');
  if (body.version !== IMPORT_FORMAT_VERSION) throw new ImportError(400, 'unsupported_version');
  if (typeof body.schoolYearId !== 'string' || !ID_PATTERN.test(body.schoolYearId)) throw new ImportError(400, 'invalid_school_year');
  if (!Array.isArray(body.columns) || body.columns.length !== FIELD_KEYS.length
      || body.columns.some((column, index) => column !== FIELD_KEYS[index])) throw new ImportError(400, 'invalid_columns');
  if (!Array.isArray(body.rows) || body.rows.length < 1) throw new ImportError(400, 'invalid_rows');
  if (body.rows.length > MAX_IMPORT_ROWS) throw new ImportError(413, 'too_many_rows');
  const rows = body.rows.map((row) => {
    if (!Array.isArray(row) || row.length !== FIELD_KEYS.length) throw new ImportError(400, 'invalid_rows');
    return row.map(cell);
  });
  let rowNumbers = null;
  if (body.rowNumbers !== undefined) {
    if (!Array.isArray(body.rowNumbers) || body.rowNumbers.length !== rows.length
        || body.rowNumbers.some((n) => !Number.isInteger(n) || n < 1 || n > 1_000_000)) throw new ImportError(400, 'invalid_row_numbers');
    rowNumbers = body.rowNumbers;
  }
  const options = body.options ?? {};
  if (typeof options !== 'object' || Array.isArray(options)) throw new ImportError(400, 'invalid_options');
  for (const key of ['allowNewHouseholds', 'skipConflicts']) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new ImportError(400, 'invalid_options');
  }
  return {
    schoolYearId: body.schoolYearId,
    rows,
    rowNumbers,
    allowNewHouseholds: options.allowNewHouseholds === true,
    skipConflicts: options.skipConflicts === true,
    fingerprint: body.fingerprint,
    planDigest: body.planDigest,
  };
}

async function loadClasses(executor, schoolYearId) {
  const year = await executor.query('SELECT id FROM school_years WHERE id = $1', [schoolYearId]);
  if (!year.rows[0]) throw new ImportError(422, 'unknown_school_year');
  const { rows } = await executor.query('SELECT id, name FROM classes WHERE school_year_id = $1 ORDER BY name', [schoolYearId]);
  if (!rows.length) throw new ImportError(422, 'no_classes_in_school_year');
  return new Map(rows.map((row) => [row.name, row.id]));
}

// Walidacja tą samą funkcją co w przeglądarce, z listą klas roku z bazy.
function validate(payload, classIds) {
  const matrix = [[...FIELD_KEYS], ...payload.rows];
  const mapping = Object.fromEntries(FIELD_KEYS.map((key, index) => [key, index]));
  let result;
  try {
    result = validateRows(matrix, mapping, { allowedClasses: [...classIds.keys()] });
  } catch (error) {
    throw new ImportError(422, 'invalid_import', String(error?.message ?? '').slice(0, 200));
  }
  // validateRows numeruje wiersze macierzy od 2 (nagłówek = 1); przywracamy numery z pliku.
  const sourceRow = (row) => (payload.rowNumbers ? payload.rowNumbers[row - 2] : row);
  const records = result.records.map((record) => ({ ...record, row: sourceRow(record.row) }));
  const errors = result.errors.map((entry) => ({ row: sourceRow(entry.row), message: entry.message }));
  const warnings = result.warnings.map((entry) => ({ row: sourceRow(entry.row), message: entry.message }));
  return { records, errors, warnings };
}

export function importFingerprint(schoolYearId, allowNewHouseholds, records) {
  return sha256(JSON.stringify({
    v: IMPORT_FORMAT_VERSION,
    schoolYearId,
    allowNewHouseholds,
    rows: records.map((record) => FIELD_KEYS.map((key) => record[key])),
  }));
}

// Przedrostki nazwisk (niderlandzkie/belgijskie, francuskie, niemieckie), które zostają
// przy nazwisku, np. "Anna Maria de Smet" -> imię "Anna Maria", nazwisko "de Smet" (#98).
const NAME_PARTICLES = new Set([
  'de', 'van', 'der', 'den', 'ten', 'ter', 'te', 'op', 'het',
  'la', 'le', 'du', 'des', 'di', 'del', 'della', 'dos', 'das', 'von', 'af', 'av',
]);

export function splitGuardianName(fullName) {
  const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { firstName: parts[0] ?? '', lastName: '' };
  let cut = parts.length - 1;
  while (cut > 0 && NAME_PARTICLES.has(parts[cut - 1].toLocaleLowerCase('pl-PL'))) cut--;
  if (cut === 0) cut = 1; // co najmniej jeden wyraz zostaje w imieniu, reszta (przedrostki) w nazwisku
  return { firstName: parts.slice(0, cut).join(' '), lastName: parts.slice(cut).join(' ') };
}

const guardianKey = (householdId, fullName, email) => `${householdId}|${norm(fullName)}|${norm(email)}`;

// #98: opiekun tej samej rodziny z tym samym e-mailem, ale inną pisownią imienia/nazwiska,
// albo tym samym imieniem i nazwiskiem, ale innym e-mailem — prawdopodobnie ta sama osoba
// z poprawionym zapisem, nie nowy opiekun.
function findPartialGuardianMatch(guardiansByHousehold, householdId, fullName, email) {
  const normFull = norm(fullName);
  const normEmail = norm(email);
  for (const candidate of guardiansByHousehold.get(householdId) ?? []) {
    const candidateFull = norm(`${candidate.first_name} ${candidate.last_name}`);
    const candidateEmail = norm(candidate.email);
    const sameFull = candidateFull === normFull;
    const sameEmail = Boolean(normEmail) && Boolean(candidateEmail) && normEmail === candidateEmail;
    if (sameEmail && !sameFull) return candidate;
    if (sameFull && !sameEmail) return candidate;
  }
  return null;
}

// Plan importu. Wyłącznie odczyty; wykonywany w podglądzie (db) i w zatwierdzeniu (tx).
async function buildPlan(executor, { schoolYearId, classIds, records, errors, warnings, allowNewHouseholds }) {
  const valid = records.filter((record) => record.valid);
  const studentRefs = [...new Set(valid.map((r) => norm(r.studentId)).filter(Boolean))];
  const householdRefs = [...new Set(valid.map((r) => norm(r.householdId)).filter(Boolean))];
  const emails = [...new Set(valid.flatMap((r) => [r.email1, r.email2]).map(norm).filter(Boolean))];

  const existingStudents = new Map();
  if (studentRefs.length) {
    const { rows } = await executor.query(
      // Rodzina = bieżące główne gospodarstwo (#194), nie kolumna students.household_id.
      `SELECT s.id, lower(s.source_ref) AS ref, s.first_name, s.last_name, p.household_id,
              lower(h.source_ref) AS household_ref
         FROM students s
         LEFT JOIN student_primary_household_current p ON p.student_id = s.id
         LEFT JOIN households h ON h.id = p.household_id
        WHERE lower(s.source_ref) = ANY($1::text[])`,
      [studentRefs],
    );
    for (const row of rows) existingStudents.set(row.ref, row);
  }
  const existingHouseholds = new Map();
  if (householdRefs.length) {
    const { rows } = await executor.query(
      'SELECT id, lower(source_ref) AS ref FROM households WHERE lower(source_ref) = ANY($1::text[])',
      [householdRefs],
    );
    for (const row of rows) existingHouseholds.set(row.ref, row.id);
  }
  const studentIds = [...existingStudents.values()].map((s) => s.id);
  const householdIds = [...new Set([...existingStudents.values()].map((s) => s.household_id).filter(Boolean).concat([...existingHouseholds.values()]))];

  const enrollments = new Map();
  const links = new Set();
  if (studentIds.length) {
    const enrolled = await executor.query(
      'SELECT student_id, class_id FROM enrollments WHERE school_year_id = $1 AND student_id = ANY($2::text[])',
      [schoolYearId, studentIds],
    );
    for (const row of enrolled.rows) enrollments.set(row.student_id, row.class_id);
    const linked = await executor.query(
      'SELECT student_id, guardian_id FROM student_guardians WHERE student_id = ANY($1::text[])',
      [studentIds],
    );
    for (const row of linked.rows) links.add(`${row.student_id}|${row.guardian_id}`);
  }
  const guardianIndex = new Map();
  // #98: opiekunowie DB grupowani po rodzinie, żeby wykryć zmianę pisowni/e-maila
  // istniejącego opiekuna (dopasowanie częściowe) zamiast tworzyć drugi rekord.
  const guardiansByHousehold = new Map();
  if (householdIds.length) {
    const { rows } = await executor.query(
      'SELECT id, household_id, first_name, last_name, email FROM guardians WHERE household_id = ANY($1::text[])',
      [householdIds],
    );
    for (const row of rows) {
      const key = guardianKey(row.household_id, `${row.first_name} ${row.last_name}`, row.email);
      if (!guardianIndex.has(key)) guardianIndex.set(key, row.id);
      if (!guardiansByHousehold.has(row.household_id)) guardiansByHousehold.set(row.household_id, []);
      guardiansByHousehold.get(row.household_id).push(row);
    }
  }
  // Uczniowie zapisani w tym roku, których nie ma w pliku (#98) — tylko informacja
  // do ręcznego wyjaśnienia; identyfikatory ze źródła, bez imion i nazwisk.
  // Cała zawartość pliku (także wiersze błędne) — uczeń wpisany w pliku, choćby
  // z błędem, nie powinien trafić na listę „brak w pliku”.
  const fileStudentRefs = new Set(records.map((r) => norm(r.studentId)).filter(Boolean));
  const { rows: enrolledRows } = await executor.query(
    `SELECT s.source_ref FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.school_year_id = $1`,
    [schoolYearId],
  );
  const missingFromFile = enrolledRows
    .map((row) => row.source_ref)
    .filter((ref) => ref && !fileStudentRefs.has(norm(ref)))
    .sort((a, b) => a.localeCompare(b, 'pl-PL'));
  // Adres e-mail → rodziny, w których występuje (baza + planowane). Tylko do ostrzeżeń.
  const emailHouseholds = new Map();
  if (emails.length) {
    const { rows } = await executor.query(
      'SELECT DISTINCT lower(email) AS email, household_id FROM guardians WHERE lower(email) = ANY($1::text[])',
      [emails],
    );
    for (const row of rows) {
      if (!emailHouseholds.has(row.email)) emailHouseholds.set(row.email, new Set());
      emailHouseholds.get(row.email).add(row.household_id);
    }
  }

  const errorsByRow = new Map();
  for (const entry of errors) {
    if (!errorsByRow.has(entry.row)) errorsByRow.set(entry.row, []);
    errorsByRow.get(entry.row).push(entry.message);
  }
  const serverWarnings = [];
  const plannedHouseholds = new Map();
  const inserts = { households: [], guardians: [], students: [], enrollments: [], links: [] };
  const rows = [];

  for (const record of records) {
    if (!record.valid) {
      rows.push({ row: record.row, action: 'skipped', messages: errorsByRow.get(record.row) ?? [] });
      continue;
    }
    const conflict = (message) => rows.push({ row: record.row, action: 'conflict', messages: [message] });
    const studentRef = norm(record.studentId);
    const householdRef = norm(record.householdId);
    if (!studentRef) { conflict(MESSAGES.missingStudentId); continue; }
    const classId = classIds.get(record.className);
    const existing = existingStudents.get(studentRef);
    const changes = [];
    let studentId;
    let householdId;

    if (existing) {
      if (norm(existing.first_name) !== norm(record.firstName) || norm(existing.last_name) !== norm(record.lastName)) { conflict(MESSAGES.nameMismatch); continue; }
      if (!existing.household_id) { conflict(MESSAGES.noCurrentHousehold); continue; }
      if (householdRef && (existing.household_ref ?? '') !== householdRef) { conflict(MESSAGES.householdMismatch); continue; }
      const enrolledClass = enrollments.get(existing.id);
      if (enrolledClass && enrolledClass !== classId) { conflict(MESSAGES.classMismatch); continue; }
      studentId = existing.id;
      householdId = existing.household_id;
      if (!enrolledClass) {
        inserts.enrollments.push({ id: randomUUID(), studentId, classId });
        enrollments.set(studentId, classId);
        changes.push('enrollment');
      }
    } else {
      if (householdRef) {
        householdId = existingHouseholds.get(householdRef) ?? plannedHouseholds.get(householdRef);
        if (!householdId) {
          householdId = randomUUID();
          plannedHouseholds.set(householdRef, householdId);
          inserts.households.push({ id: householdId, sourceRef: record.householdId });
          changes.push('household');
        }
      } else if (allowNewHouseholds) {
        householdId = randomUUID();
        inserts.households.push({ id: householdId, sourceRef: null });
        changes.push('household');
        serverWarnings.push({ row: record.row, message: MESSAGES.noHouseholdLink });
      } else { conflict(MESSAGES.missingHouseholdId); continue; }
      studentId = randomUUID();
      inserts.students.push({ id: studentId, householdId, firstName: record.firstName, lastName: record.lastName, sourceRef: record.studentId });
      inserts.enrollments.push({ id: randomUUID(), studentId, classId });
      existingStudents.set(studentRef, { id: studentId, household_id: householdId });
      changes.push('student', 'enrollment');
    }

    let emailWarning = false;
    let guardianConflict = false;
    for (const [fullName, email] of [[record.guardian1, record.email1], [record.guardian2, record.email2]]) {
      if (!fullName) continue;
      const key = guardianKey(householdId, fullName, email);
      let guardianId = guardianIndex.get(key);
      if (!guardianId) {
        // #98: e-mail lub pisownia zmienione względem zapisu w bazie — to nie jest
        // nowy opiekun. Rozstrzyga uprawniona osoba poza importem (osobna, audytowana
        // zmiana danych opiekuna); import niczego nie nadpisuje ani nie dubluje.
        if (findPartialGuardianMatch(guardiansByHousehold, householdId, fullName, email)) {
          guardianConflict = true;
          continue;
        }
        guardianId = randomUUID();
        guardianIndex.set(key, guardianId);
        inserts.guardians.push({ id: guardianId, householdId, ...splitGuardianName(fullName), email: email || null });
        changes.push('guardian');
      }
      const link = `${studentId}|${guardianId}`;
      if (!links.has(link)) {
        links.add(link);
        inserts.links.push({ studentId, guardianId });
        changes.push('link');
      }
      const emailKey = norm(email);
      if (emailKey) {
        const known = emailHouseholds.get(emailKey) ?? new Set();
        if ([...known].some((id) => id !== householdId)) emailWarning = true;
        known.add(householdId);
        emailHouseholds.set(emailKey, known);
      }
    }
    if (emailWarning) serverWarnings.push({ row: record.row, message: MESSAGES.emailElsewhere });
    if (guardianConflict) {
      rows.push({ row: record.row, action: 'conflict', messages: [MESSAGES.guardianMaybeChanged] });
      continue;
    }
    const action = existing ? (changes.length ? 'update' : 'unchanged') : 'add';
    rows.push({ row: record.row, action, changes: [...new Set(changes)] });
  }

  const count = (action) => rows.filter((row) => row.action === action).length;
  const counts = {
    rowsTotal: rows.length,
    rowsAdded: count('add'),
    rowsUpdated: count('update'),
    rowsUnchanged: count('unchanged'),
    rowsConflict: count('conflict'),
    rowsSkipped: count('skipped'),
    householdsCreated: inserts.households.length,
    guardiansCreated: inserts.guardians.length,
    studentsCreated: inserts.students.length,
    enrollmentsCreated: inserts.enrollments.length,
    linksCreated: inserts.links.length,
  };
  const planDigest = sha256(JSON.stringify({
    rows: rows.map((row) => [row.row, row.action, row.changes ?? [], row.messages ?? []]),
    counts,
  }));
  return {
    rows, counts, planDigest, inserts,
    warnings: [...warnings, ...serverWarnings].sort((a, b) => a.row - b.row),
    // #98: informacyjnie — nie zapisywane, nie wpływa na planDigest ani commitAllowed.
    missingFromFile: { count: missingFromFile.length, refs: missingFromFile },
  };
}

async function prepare(executor, payload) {
  const classIds = await loadClasses(executor, payload.schoolYearId);
  const { records, errors, warnings } = validate(payload, classIds);
  const fingerprint = importFingerprint(payload.schoolYearId, payload.allowNewHouseholds, records);
  const plan = await buildPlan(executor, {
    schoolYearId: payload.schoolYearId, classIds, records, errors, warnings, allowNewHouseholds: payload.allowNewHouseholds,
  });
  return { fingerprint, plan };
}

function batchResult(row, replayed) {
  return {
    batchId: row.id,
    schoolYearId: row.school_year_id,
    replayed,
    counts: {
      rowsTotal: row.rows_total,
      rowsAdded: row.rows_added,
      rowsUpdated: row.rows_updated,
      rowsUnchanged: row.rows_unchanged,
      rowsConflict: row.rows_conflict,
      rowsSkipped: row.rows_skipped,
      householdsCreated: row.households_created,
      guardiansCreated: row.guardians_created,
      studentsCreated: row.students_created,
      enrollmentsCreated: row.enrollments_created,
      linksCreated: row.links_created,
    },
  };
}

// #248: bez tego ustawienia triggery historii rodzin (0014/0023 — student_households,
// guardian_households, enrollment_history) zapisują created_by/changed_by = NULL
// i source = 'direct', jakby zmianę wykonano bezpośrednim SQL-em, mimo że zapis
// wykonuje uwierzytelnione API. `true` = ustawienie lokalne dla tej transakcji
// (nie globalna sesja) — znika automatycznie po COMMIT/ROLLBACK.
async function setImportChangeContext(tx, actorId) {
  await tx.query(
    "SELECT set_config('rd.actor_id', $1, true), set_config('rd.change_reason', $2, true)",
    [actorId, IMPORT_CHANGE_REASON],
  );
}

async function bulkInsert(tx, batchId, inserts) {
  const column = (list, key) => list.map((item) => item[key]);
  if (inserts.households.length) {
    await tx.query(
      `INSERT INTO households (id, source_ref, import_batch_id)
       SELECT h.id, h.ref, $3 FROM unnest($1::text[], $2::text[]) AS h(id, ref)`,
      [column(inserts.households, 'id'), column(inserts.households, 'sourceRef'), batchId],
    );
  }
  if (inserts.guardians.length) {
    const g = inserts.guardians;
    await tx.query(
      `INSERT INTO guardians (id, household_id, first_name, last_name, email, import_batch_id)
       SELECT g.id, g.household_id, g.first_name, g.last_name, g.email, $6
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) AS g(id, household_id, first_name, last_name, email)`,
      [column(g, 'id'), column(g, 'householdId'), column(g, 'firstName'), column(g, 'lastName'), column(g, 'email'), batchId],
    );
  }
  if (inserts.students.length) {
    const s = inserts.students;
    await tx.query(
      `INSERT INTO students (id, household_id, first_name, last_name, source_ref, import_batch_id)
       SELECT s.id, s.household_id, s.first_name, s.last_name, s.ref, $6
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) AS s(id, household_id, first_name, last_name, ref)`,
      [column(s, 'id'), column(s, 'householdId'), column(s, 'firstName'), column(s, 'lastName'), column(s, 'sourceRef'), batchId],
    );
  }
  if (inserts.enrollments.length) {
    const e = inserts.enrollments;
    await tx.query(
      `INSERT INTO enrollments (id, student_id, class_id, school_year_id)
       SELECT e.id, e.student_id, e.class_id, c.school_year_id
         FROM unnest($1::text[], $2::text[], $3::text[]) AS e(id, student_id, class_id)
         JOIN classes c ON c.id = e.class_id`,
      [column(e, 'id'), column(e, 'studentId'), column(e, 'classId')],
    );
  }
  if (inserts.links.length) {
    // contact_allowed i is_primary_contact zostają domyślne (false) — zakres pól to decyzja D-03.
    await tx.query(
      `INSERT INTO student_guardians (student_id, guardian_id)
       SELECT l.student_id, l.guardian_id FROM unnest($1::text[], $2::text[]) AS l(student_id, guardian_id)`,
      [column(inserts.links, 'studentId'), column(inserts.links, 'guardianId')],
    );
  }
}

async function commit(env, actorId, payload, idempotencyKey) {
  // #248: zapis historii bez aktora nie jest anonimowym zapisem awaryjnym —
  // to odmowa. requireAccess wyżej w handle() zawsze daje tu ID uwierzytelnionej
  // sesji; ten warunek jest strażnikiem na wypadek błędu w wywołującym, nie
  // ścieżką, którą ma przechodzić prawdziwy ruch.
  if (!actorId) throw new Error('actor_required');
  return env.db.transaction(async (tx) => {
    // Jeden import naraz: podwójne kliknięcie i ponowienie czekają i widzą zapisany wynik.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('rd_import_commit'))");
    const { fingerprint, plan } = await prepare(tx, payload);
    if (fingerprint !== payload.fingerprint) throw new ImportError(409, 'fingerprint_mismatch');
    const previous = await tx.query(
      'SELECT * FROM import_batches WHERE fingerprint = $1 OR idempotency_key = $2',
      [fingerprint, idempotencyKey],
    );
    const byKey = previous.rows.find((row) => row.idempotency_key === idempotencyKey);
    if (byKey && byKey.fingerprint !== fingerprint) throw new ImportError(409, 'idempotency_key_reused');
    const same = previous.rows.find((row) => row.fingerprint === fingerprint);
    if (same) return { status: 200, body: batchResult(same, true) };

    // #145 (D-06): commit wymaga opublikowanej informacji o przetwarzaniu
    // danych. Sprawdzane dopiero tutaj (nie w preview) — podgląd nie zapisuje
    // niczego i nie powinien blokować pracy nad mapowaniem przed publikacją.
    const { rows: noticeRows } = await tx.query(
      "SELECT id FROM privacy_notices WHERE status = 'published' ORDER BY version DESC LIMIT 1",
    );
    if (!noticeRows[0]) throw new ImportError(409, 'privacy_notice_missing');
    const privacyNoticeId = noticeRows[0].id;

    if (plan.planDigest !== payload.planDigest) throw new ImportError(409, 'preview_stale');
    if ((plan.counts.rowsConflict || plan.counts.rowsSkipped) && !payload.skipConflicts) {
      throw new ImportError(422, 'import_has_conflicts');
    }
    const batchId = randomUUID();
    const c = plan.counts;
    const { rows } = await tx.query(
      `INSERT INTO import_batches (id, actor_id, school_year_id, fingerprint, idempotency_key, plan_digest,
         rows_total, rows_added, rows_updated, rows_unchanged, rows_conflict, rows_skipped,
         households_created, guardians_created, students_created, enrollments_created, links_created,
         privacy_notice_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [batchId, actorId, payload.schoolYearId, fingerprint, idempotencyKey, plan.planDigest,
        c.rowsTotal, c.rowsAdded, c.rowsUpdated, c.rowsUnchanged, c.rowsConflict, c.rowsSkipped,
        c.householdsCreated, c.guardiansCreated, c.studentsCreated, c.enrollmentsCreated, c.linksCreated,
        privacyNoticeId],
    );
    // #248: aktor musi być ustawiony w tej samej transakcji, PRZED zapisami
    // domenowymi — triggery historii rodzin (student_households, guardian_households,
    // enrollment_history) czytają rd.actor_id/rd.change_reason w momencie INSERT-a.
    await setImportChangeContext(tx, actorId);
    await bulkInsert(tx, batchId, plan.inserts);
    // Audyt: aktor, rok i liczniki. Bez imion, nazwisk, adresów i identyfikatorów ze źródła.
    await insertAuditEvent(tx, {
      actorId, action: 'import.committed', entityType: 'import_batch', entityId: batchId,
      metadata: { schoolYearId: payload.schoolYearId, skipConflicts: payload.skipConflicts, allowNewHouseholds: payload.allowNewHouseholds, counts: c },
    });
    return { status: 201, body: batchResult(rows[0], false) };
  });
}

async function options(env, context, json) {
  const grants = qualifyingGrants(context, null);
  if (!grants.length) return json({ error: 'forbidden' }, 403);
  const allYears = grants.some((grant) => !grant.schoolYearId);
  const allowed = [...new Set(grants.map((grant) => grant.schoolYearId).filter(Boolean))];
  const { rows } = await env.db.query(
    `SELECT y.id, y.label, y.starts_on, COALESCE(array_agg(c.name ORDER BY c.name) FILTER (WHERE c.id IS NOT NULL), '{}') AS classes
       FROM school_years y LEFT JOIN classes c ON c.school_year_id = y.id
      WHERE $1::boolean OR y.id = ANY($2::text[])
      GROUP BY y.id, y.label, y.starts_on
      ORDER BY y.starts_on DESC`,
    [allYears, allowed],
  );
  return json({ schoolYears: rows.map((row) => ({ id: row.id, label: row.label, classes: row.classes })) });
}

function errorResponse(error, json) {
  if (!(error instanceof ImportError)) throw error;
  const body = { error: error.code };
  if (error.publicMessage) body.message = error.publicMessage;
  return json(body, error.status);
}

export async function handle(request, env, url, json) {
  if (!url.pathname.startsWith('/api/import/')) return null;
  const route = url.pathname.slice('/api/import/'.length);
  const method = request.method;
  if (!((route === 'options' && method === 'GET') || (['preview', 'commit'].includes(route) && method === 'POST'))) {
    if (route === 'options') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
    if (['preview', 'commit'].includes(route)) return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
    return null;
  }
  const access = await requireAccess(request, env, ACCESS, json);
  if (access.response) return access.response;
  if (importDisabled(env)) return json({ error: 'import_disabled' }, 403);
  const { context } = access;
  if (route === 'options') return options(env, context, json);

  try {
    const idempotencyKey = request.headers.get('Idempotency-Key');
    if (route === 'commit' && (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey))) {
      throw new ImportError(400, 'idempotency_key_required');
    }
    const payload = parseImportPayload(await readJsonBody(request));
    if (!qualifyingGrants(context, payload.schoolYearId).length) return json({ error: 'forbidden' }, 403);

    if (route === 'preview') {
      const { fingerprint, plan } = await prepare(env.db, payload);
      return json({
        schoolYearId: payload.schoolYearId,
        fingerprint,
        planDigest: plan.planDigest,
        counts: plan.counts,
        commitAllowed: plan.counts.rowsConflict + plan.counts.rowsSkipped === 0,
        rows: plan.rows,
        warnings: plan.warnings,
        missingFromFile: plan.missingFromFile,
        written: false,
      });
    }
    if (typeof payload.fingerprint !== 'string' || !HEX64.test(payload.fingerprint)
        || typeof payload.planDigest !== 'string' || !HEX64.test(payload.planDigest)) {
      throw new ImportError(400, 'preview_required');
    }
    const result = await commit(env, context.session.user.id, payload, idempotencyKey);
    return json(result.body, result.status);
  } catch (error) {
    return errorResponse(error, json);
  }
}
