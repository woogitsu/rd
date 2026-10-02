// Anonimizacja gospodarstwa z zachowaniem księgi i sum wpłat (#91, D-04/D-07).
// Prototyp — nie jest wdrożony i nie jest gotowy do pracy na danych rodzin.
//
// To jest MECHANIZM, nie decyzja: moduł nie zawiera żadnego okresu retencji.
// Przebieg jest możliwy w dwóch trybach (reasonCode):
//   - `retention_policy`      — wyłącznie gdy w `retention_policies` istnieją
//     zatwierdzone, wyliczalne (retain_for) polityki dla WSZYSTKICH czterech
//     kategorii dotkniętych przebiegiem i okres od końca ostatniego roku
//     szkolnego gospodarstwa już upłynął. Dziś rejestr jest pusty, więc tryb
//     odmawia (`retention_policy_missing`) — nic nie jest anonimizowane
//     „domyślnie”.
//   - `data_subject_request`  — żądanie usunięcia z rejestru (#100, rodzaj
//     `erasure`, po weryfikacji tożsamości, nie zamknięte), niezależnie od
//     polityk. Założenie do D-07: przebieg obejmuje CAŁE gospodarstwo wskazane
//     przez obsługującego (żądanie opiekuna lub dziecka nie zawęża zakresu).
//
// Co zmienia (tylko pola tekstowe z privacy/data-inventory.json, `personal:
// direct`, powiązane z gospodarstwem — pełna lista kolumn w migracji 0174):
// imiona i nazwiska uczniów/opiekunów, e-maile opiekunów, historia zmian
// kontaktu, sprostowań imienia/nazwiska (`identity_changes`, 0182) i powiązań, powody w historii członkostw i zapisów, prośby o
// aktualizację danych, e-maile w migawkach kampanii oraz tytuł przelewu i
// powody korekt/zwrotów/przeniesień/odwróceń przypisań. NIE zmienia
// identyfikatorów, kwot, dat, statusów, gospodarstwa wpłaty, roku, księgi
// (ledger_*), uzgodnień ani `email_hash` — sumy netto przed i po są równe.
//
// Osoby wspólne dla kilku gospodarstw (opieka dzielona): opiekun lub uczeń jest
// anonimizowany dopiero, gdy WSZYSTKIE jego gospodarstwa (guardian_households /
// student_households / gospodarstwo główne) są zanonimizowane — bieżące albo
// z wcześniejszego przebiegu. Do tego czasu zostaje nietknięty (licznik
// `retained`), a wiersze powiązań (student_guardians) nigdy nie są usuwane.
//
// Idempotencja: przebieg, który nie ma nic do zmiany, zwraca `replayed` i nie
// zapisuje wiersza ani zdarzenia (podwójne kliknięcie, ponowienie zadania).
// Równoległe wywołania dla jednego gospodarstwa serializuje blokada doradcza.
//
// Odpowiedź, dziennik (`anonymization_runs`) i zdarzenie audytu zawierają
// wyłącznie identyfikatory i liczniki — nigdy imiona, e-maile ani teksty.

import { createHash } from 'node:crypto';
import { insertAuditEvent } from './audit.js';
import { brusselsDateSql, brusselsStartOfDaySql } from './today.js';

export const ANONYMIZATION_REASON_CODES = Object.freeze(['retention_policy', 'data_subject_request']);

// Kategorie polityk retencji, których dotyka przebieg (privacy/data-inventory.json).
export const ANONYMIZATION_POLICY_CATEGORIES = Object.freeze([
  'guardian_contact', 'student_identity', 'email_snapshot', 'payment_reference',
]);

// Wartości zastępcze — muszą być zgodne z rd_anonymization_update_allowed (0174).
export const ANONYMIZED_TEXT = '[zanonimizowano]';
export const ANONYMIZED_EMAIL = 'zanonimizowano@anonim.invalid';

const ERASURE_REQUEST_STATUSES = ['identity_verified', 'in_progress'];

export class AnonymizationError extends Error {
  constructor(code, status = 409) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// Gospodarstwa osoby: gospodarstwo główne + wszystkie członkostwa (każdy okres).
const GUARDIAN_LINKED = `
  (g.household_id = $1 OR EXISTS (SELECT 1 FROM guardian_households gh WHERE gh.guardian_id = g.id AND gh.household_id = $1))`;
const GUARDIAN_ALL_ANONYMIZED = `
  NOT EXISTS (
    SELECT 1 FROM (
      SELECT g.household_id AS hid
      UNION SELECT gh.household_id FROM guardian_households gh WHERE gh.guardian_id = g.id
    ) l WHERE l.hid <> ALL ($2::text[]))`;
const STUDENT_LINKED = `
  (s.household_id = $1 OR EXISTS (SELECT 1 FROM student_households sh WHERE sh.student_id = s.id AND sh.household_id = $1))`;
const STUDENT_ALL_ANONYMIZED = `
  NOT EXISTS (
    SELECT 1 FROM (
      SELECT s.household_id AS hid
      UNION SELECT sh.household_id FROM student_households sh WHERE sh.student_id = s.id
    ) l WHERE l.hid <> ALL ($2::text[]))`;

const IDENTITY_CHANGE_NAME_COLUMNS = ['previous_first_name', 'previous_last_name', 'new_first_name', 'new_last_name'];
const IDENTITY_CHANGE_DIRTY = `(${IDENTITY_CHANGE_NAME_COLUMNS.map((column) => `${column} <> '${ANONYMIZED_TEXT}'`).join(' OR ')} OR reason IS NOT NULL)`;
const IDENTITY_CHANGE_SET = `${IDENTITY_CHANGE_NAME_COLUMNS.map((column) => `${column} = '${ANONYMIZED_TEXT}'`).join(', ')}, reason = NULL`;

// Tabele zmieniane przebiegiem: SQL wyboru wierszy WYMAGAJĄCYCH zmiany ($1 =
// lista id obiektu nadrzędnego) i SET. Kolejność = kolejność wykonania.
const CHILD_TABLES = [
  {
    table: 'guardian_contact_changes', parent: 'guardians',
    where: 'guardian_id = ANY($1::text[]) AND (previous_email IS NOT NULL OR new_email IS NOT NULL OR reason IS NOT NULL)',
    set: 'previous_email = NULL, new_email = NULL, reason = NULL',
  },
  {
    table: 'guardian_households', parent: 'guardians',
    where: 'guardian_id = ANY($1::text[]) AND ended_reason IS NOT NULL',
    set: 'ended_reason = NULL',
  },
  {
    table: 'guardian_update_requests', parent: 'guardians',
    where: 'guardian_id = ANY($1::text[]) AND (proposed_email IS NOT NULL OR note IS NOT NULL)',
    set: 'proposed_email = NULL, note = NULL',
  },
  {
    table: 'email_campaign_recipients', parent: 'guardians',
    where: `guardian_id = ANY($1::text[]) AND email <> '${ANONYMIZED_EMAIL}'`,
    set: `email = '${ANONYMIZED_EMAIL}'`,
  },
  {
    table: 'student_guardian_changes', parent: 'students',
    where: 'student_id = ANY($1::text[]) AND reason IS NOT NULL',
    set: 'reason = NULL',
  },
  // #100: historia sprostowań imienia/nazwiska (0182) — jedna tabela, dwa podmioty (osobne klucze planu).
  {
    table: 'identity_changes', key: 'identity_changes_guardians', parent: 'guardians',
    where: `guardian_id = ANY($1::text[]) AND ${IDENTITY_CHANGE_DIRTY}`,
    set: IDENTITY_CHANGE_SET,
  },
  {
    table: 'identity_changes', key: 'identity_changes_students', parent: 'students',
    where: `student_id = ANY($1::text[]) AND ${IDENTITY_CHANGE_DIRTY}`,
    set: IDENTITY_CHANGE_SET,
  },
  {
    table: 'student_households', parent: 'students',
    where: 'student_id = ANY($1::text[]) AND (created_reason IS NOT NULL OR ended_reason IS NOT NULL)',
    set: 'created_reason = NULL, ended_reason = NULL',
  },
  {
    table: 'enrollments', parent: 'students',
    where: 'student_id = ANY($1::text[]) AND ended_reason IS NOT NULL',
    set: 'ended_reason = NULL',
  },
  {
    table: 'enrollment_history', parent: 'students',
    where: 'student_id = ANY($1::text[]) AND reason IS NOT NULL',
    set: 'reason = NULL',
  },
];

// Wpłaty gospodarstwa (aktualny właściciel wpisu) i ich zdarzenia — tylko tekst.
const PAYMENT_CHILD_TABLES = [
  { table: 'payment_corrections', where: `payment_entry_id = ANY($1::text[]) AND reason <> '${ANONYMIZED_TEXT}'`, set: `reason = '${ANONYMIZED_TEXT}'` },
  { table: 'payment_refunds', where: `payment_entry_id = ANY($1::text[]) AND reason <> '${ANONYMIZED_TEXT}'`, set: `reason = '${ANONYMIZED_TEXT}'` },
  { table: 'payment_reassignments', where: `payment_entry_id = ANY($1::text[]) AND reason <> '${ANONYMIZED_TEXT}'`, set: `reason = '${ANONYMIZED_TEXT}'` },
  {
    table: 'payment_allocation_reversals',
    where: `allocation_id IN (SELECT a.id FROM payment_allocations a WHERE a.payment_entry_id = ANY($1::text[])) AND reason <> '${ANONYMIZED_TEXT}'`,
    set: `reason = '${ANONYMIZED_TEXT}'`,
  },
];

const ids = (rows) => rows.map((row) => row.id).sort();

/**
 * Plan przebiegu: które wiersze (identyfikatory) wymagają zmiany. Tylko odczyt.
 * @returns {{ tables: Record<string, string[]>, retained: {guardians:number, students:number}, anonymizedHouseholds: string[] }}
 */
export async function planAnonymization(tx, householdId) {
  const { rows: previous } = await tx.query('SELECT DISTINCT household_id FROM anonymization_runs');
  const anonymizedHouseholds = [...new Set([householdId, ...previous.map((row) => row.household_id)])].sort();

  const { rows: guardianRows } = await tx.query(
    `SELECT g.id, (${GUARDIAN_ALL_ANONYMIZED}) AS eligible,
            (g.first_name <> '${ANONYMIZED_TEXT}' OR g.last_name <> '${ANONYMIZED_TEXT}'
             OR g.email IS NOT NULL OR g.contact_allowed) AS needs_change
       FROM guardians g WHERE ${GUARDIAN_LINKED}`,
    [householdId, anonymizedHouseholds],
  );
  const { rows: studentRows } = await tx.query(
    `SELECT s.id, (${STUDENT_ALL_ANONYMIZED}) AS eligible,
            (s.first_name <> '${ANONYMIZED_TEXT}' OR s.last_name <> '${ANONYMIZED_TEXT}') AS needs_change
       FROM students s WHERE ${STUDENT_LINKED}`,
    [householdId, anonymizedHouseholds],
  );
  const eligibleGuardians = guardianRows.filter((row) => row.eligible);
  const eligibleStudents = studentRows.filter((row) => row.eligible);
  const parents = {
    guardians: ids(eligibleGuardians),
    students: ids(eligibleStudents),
  };

  const tables = {
    guardians: ids(eligibleGuardians.filter((row) => row.needs_change)),
    students: ids(eligibleStudents.filter((row) => row.needs_change)),
  };
  for (const spec of CHILD_TABLES) {
    const { rows } = await tx.query(`SELECT id FROM ${spec.table} WHERE ${spec.where}`, [parents[spec.parent]]);
    tables[spec.key ?? spec.table] = ids(rows);
  }

  const { rows: entryRows } = await tx.query('SELECT id FROM payment_entries WHERE household_id = $1', [householdId]);
  const entryIds = ids(entryRows);
  const { rows: referenceRows } = await tx.query(
    'SELECT id FROM payment_entries WHERE household_id = $1 AND reference IS NOT NULL', [householdId],
  );
  tables.payment_entries = ids(referenceRows);
  for (const spec of PAYMENT_CHILD_TABLES) {
    const { rows } = await tx.query(`SELECT id FROM ${spec.table} WHERE ${spec.where}`, [entryIds]);
    tables[spec.table] = ids(rows);
  }

  return {
    tables,
    retained: {
      guardians: guardianRows.filter((row) => !row.eligible).length,
      students: studentRows.filter((row) => !row.eligible).length,
    },
    anonymizedHouseholds,
  };
}

// Klucze liczników trafiają do odpowiedzi, dziennika przebiegu i metadanych audytu;
// ten ostatni odrzuca klucze z „email” w nazwie, więc tabela migawek ma krótszą etykietę.
const COUNT_LABELS = { email_campaign_recipients: 'campaign_recipients' };

function planCounts(plan) {
  return Object.fromEntries(Object.entries(plan.tables).map(([table, list]) => [COUNT_LABELS[table] ?? table, list.length]));
}

// Skrót listy identyfikatorów (kanonicznie: tabele i id posortowane, puste pominięte).
export function planDigest(plan) {
  const canonical = Object.keys(plan.tables).sort()
    .filter((table) => plan.tables[table].length)
    .map((table) => [table, plan.tables[table]]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

async function requireHousehold(tx, householdId) {
  const { rows } = await tx.query('SELECT 1 FROM households WHERE id = $1', [householdId]);
  if (!rows.length) throw new AnonymizationError('household_not_found', 404);
}

// Tryb żądania osoby (D-07): żądanie `erasure` po weryfikacji tożsamości, otwarte, dotyczące tego gospodarstwa.
async function checkDataRequest(tx, dataRequestId, householdId) {
  const { rows } = await tx.query(
    'SELECT id, kind, status, household_id, guardian_id, student_id FROM data_subject_requests WHERE id = $1',
    [dataRequestId],
  );
  const request = rows[0];
  if (!request) throw new AnonymizationError('data_request_not_found', 404);
  if (request.kind !== 'erasure') throw new AnonymizationError('data_request_kind_not_erasable');
  if (['answered', 'rejected'].includes(request.status)) throw new AnonymizationError('data_request_closed');
  if (!ERASURE_REQUEST_STATUSES.includes(request.status)) throw new AnonymizationError('data_request_identity_not_verified');
  let belongs = request.household_id === householdId;
  if (!belongs && request.guardian_id) {
    const { rows: link } = await tx.query(
      `SELECT 1 FROM guardians g WHERE g.id = $2 AND (g.household_id = $1
         OR EXISTS (SELECT 1 FROM guardian_households gh WHERE gh.guardian_id = g.id AND gh.household_id = $1))`,
      [householdId, request.guardian_id],
    );
    belongs = link.length > 0;
  }
  if (!belongs && request.student_id) {
    const { rows: link } = await tx.query(
      `SELECT 1 FROM students s WHERE s.id = $2 AND (s.household_id = $1
         OR EXISTS (SELECT 1 FROM student_households sh WHERE sh.student_id = s.id AND sh.household_id = $1))`,
      [householdId, request.student_id],
    );
    belongs = link.length > 0;
  }
  if (!belongs) throw new AnonymizationError('data_request_subject_mismatch');
}

// Tryb polityki (D-04): zatwierdzone polityki retain_for dla każdej kategorii i upłynięty okres.
async function checkRetentionPolicies(tx, householdId) {
  const policyIds = [];
  const intervals = [];
  for (const category of ANONYMIZATION_POLICY_CATEGORIES) {
    const { rows } = await tx.query(
      `SELECT id, retain_for::text AS retain_for, approved_by FROM retention_policies
        WHERE data_category = $1 AND effective_from <= now()
        ORDER BY effective_from DESC, created_at DESC, id DESC LIMIT 1`,
      [category],
    );
    const policy = rows[0];
    if (!policy) throw new AnonymizationError('retention_policy_missing');
    if (!policy.approved_by) throw new AnonymizationError('retention_policy_not_approved');
    if (!policy.retain_for) throw new AnonymizationError('retention_rule_not_evaluable');
    policyIds.push(policy.id);
    intervals.push(policy.retain_for);
  }
  // Koniec ostatniego roku szkolnego z aktywnością gospodarstwa (wpłaty, zapisy
  // dzieci, kampanie) albo data założenia gospodarstwa, gdy nie ma żadnej.
  const { rows } = await tx.query(
    `WITH activity AS (
       SELECT sy.ends_on FROM payment_entries p JOIN school_years sy ON sy.id = p.school_year_id WHERE p.household_id = $1
       UNION ALL
       SELECT sy.ends_on FROM enrollments e JOIN school_years sy ON sy.id = e.school_year_id
        WHERE e.student_id IN (SELECT s.id FROM students s WHERE s.household_id = $1
                               UNION SELECT sh.student_id FROM student_households sh WHERE sh.household_id = $1)
       UNION ALL
       SELECT sy.ends_on FROM email_campaign_recipients r
         JOIN email_campaigns c ON c.id = r.campaign_id JOIN school_years sy ON sy.id = c.school_year_id
        WHERE r.household_id = $1
     )
     SELECT COALESCE((SELECT max(ends_on) FROM activity), (SELECT ${brusselsDateSql('created_at')} FROM households WHERE id = $1)) AS last_activity_end`,
    [householdId],
  );
  const lastActivity = rows[0].last_activity_end;
  for (const interval of intervals) {
    const { rows: check } = await tx.query(`SELECT ${brusselsStartOfDaySql('$1::date + $2::interval')} <= now() AS elapsed`, [lastActivity, interval]);
    if (!check[0].elapsed) throw new AnonymizationError('retention_period_not_elapsed');
  }
  return policyIds;
}

/**
 * Podgląd (dryRun) albo wykonanie anonimizacji jednego gospodarstwa.
 *
 * @param {object} db baza (`db.transaction`)
 * @param {object} options
 * @param {string} options.actorId administrator wykonujący
 * @param {string} options.householdId
 * @param {'retention_policy'|'data_subject_request'} options.reasonCode
 * @param {string} [options.dataRequestId] wymagane dla `data_subject_request`
 * @param {boolean} options.dryRun
 * @param {string} [options.expectedPlanSha256] zatwierdzony podgląd (wymagany przy wykonaniu)
 * @returns {Promise<{status:'dry_run'|'applied'|'replayed', runId:string|null, householdId:string, reasonCode:string, planSha256:string, counts:object, retained:object}>}
 */
export async function anonymizeHousehold(db, {
  actorId, householdId, reasonCode, dataRequestId = null, dryRun, expectedPlanSha256 = null,
}) {
  if (!ANONYMIZATION_REASON_CODES.includes(reasonCode)) throw new AnonymizationError('invalid_reason_code', 400);
  return db.transaction(async (tx) => {
    // Podwójne kliknięcie: drugi przebieg czeka i zastaje pusty plan (replayed).
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rd_anonymize_household:${householdId}`]);
    await requireHousehold(tx, householdId);
    let policyIds = [];
    if (reasonCode === 'data_subject_request') {
      await checkDataRequest(tx, dataRequestId, householdId);
    } else {
      policyIds = await checkRetentionPolicies(tx, householdId);
    }

    const plan = await planAnonymization(tx, householdId);
    const counts = planCounts(plan);
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const planSha256 = planDigest(plan);
    const result = { householdId, reasonCode, planSha256, counts, retained: plan.retained };

    if (dryRun) {
      // Podgląd niczego nie zmienia, ale ujawnia liczności — zostaje po nim ślad (aktor, czas, gospodarstwo).
      await insertAuditEvent(tx, {
        actorId, action: 'household.anonymization_previewed', entityType: 'household', entityId: householdId,
        metadata: { reasonCode, planSha256, counts },
      });
      return { status: 'dry_run', runId: null, ...result };
    }
    if (total === 0) return { status: 'replayed', runId: null, ...result };
    if (expectedPlanSha256 !== planSha256) throw new AnonymizationError('anonymization_plan_changed');

    const { rows: [{ run_id: runId }] } = await tx.query('SELECT gen_random_uuid()::text AS run_id');
    await tx.query("SELECT set_config('rd.anonymization_run', $1, true)", [runId]);
    const apply = async (table, set, list) => {
      if (!list.length) return;
      const { rows } = await tx.query(`UPDATE ${table} SET ${set} WHERE id = ANY($1::text[]) RETURNING id`, [list]);
      if (rows.length !== list.length) throw new AnonymizationError('anonymization_row_mismatch');
    };
    await apply('guardians', `first_name = '${ANONYMIZED_TEXT}', last_name = '${ANONYMIZED_TEXT}', email = NULL, contact_allowed = false`, plan.tables.guardians);
    await apply('students', `first_name = '${ANONYMIZED_TEXT}', last_name = '${ANONYMIZED_TEXT}'`, plan.tables.students);
    for (const spec of [...CHILD_TABLES, { table: 'payment_entries', set: 'reference = NULL' }, ...PAYMENT_CHILD_TABLES]) {
      await apply(spec.table, spec.set, plan.tables[spec.key ?? spec.table]);
    }
    await tx.query("SELECT set_config('rd.anonymization_run', '', true)");

    await tx.query(
      `INSERT INTO anonymization_runs
         (id, household_id, reason_code, data_subject_request_id, retention_policy_ids, plan_sha256, counts, executed_by)
       VALUES ($1, $2, $3, $4, $5::text[], $6, $7::jsonb, $8)`,
      [runId, householdId, reasonCode, dataRequestId, policyIds, planSha256, JSON.stringify(counts), actorId],
    );
    await insertAuditEvent(tx, {
      actorId, action: 'household.anonymized', entityType: 'anonymization_run', entityId: runId,
      metadata: {
        householdId, reasonCode, planSha256, counts,
        retainedGuardians: plan.retained.guardians, retainedStudents: plan.retained.students,
        ...(dataRequestId ? { dataSubjectRequestId: dataRequestId } : {}),
        ...(policyIds.length ? { retentionPolicyIds: policyIds } : {}),
      },
    });
    return { status: 'applied', runId, ...result };
  });
}
