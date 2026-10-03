// Dziennik przebiegów anonimizacji poza bazą (#91, dług anonimizacji).
// Prototyp — nie jest wdrożony i nie jest gotowy do pracy na danych rodzin.
//
// Po odtworzeniu kopii lub paczki sprzed przebiegu baza nie wie, co zanonimizowano
// (wiersza `anonymization_runs` jeszcze w niej nie ma). Ten moduł definiuje plik
// przechowywany POZA bazą, z którego scripts/reapply-anonymization.js ponawia
// przebiegi. Plik zawiera wyłącznie identyfikatory techniczne, kody powodów i
// skróty planu — nigdy imion, nazwisk, e-maili, tytułów przelewów ani liczników
// osób. Walidacja przy odczycie odrzuca każdy dodatkowy klucz i każdą wartość
// spoza wzorca identyfikatora (np. zawierającą „@” albo spację), więc plik z
// danymi osobowymi nie zostanie przyjęty.
//
// Format (rd-anonymization-log, wersja 1):
//   { "format": "rd-anonymization-log", "formatVersion": 1, "exportedAt": ISO,
//     "runs": [ { runId, householdId, reasonCode, dataSubjectRequestId|null,
//                 retentionPolicyIds[], planSha256, executedAt, executedBy } ],
//     "runsSha256": SHA-256 kanonicznego JSON-a pola `runs` }
// `runs` jest posortowane po (executedAt, runId): kolejność ma znaczenie, bo
// osoba wspólna dla kilku gospodarstw jest anonimizowana dopiero po ostatnim z
// nich. Suma `runsSha256` wykrywa przypadkowe uszkodzenie lub ręczną edycję; nie
// jest podpisem i nie dowodzi pochodzenia pliku (przechowanie pliku i jego
// pochodzenie to decyzja operacyjna — D-01/D-20).
//
// Przebieg ponownie zastosowany po odtworzeniu (`reason_code = restore_reapply`,
// migracja 0185) jest eksportowany we WŁASNYCH, źródłowych terminach (kod powodu,
// plan, czas i wykonawca przebiegu pierwotnego), więc kolejny eksport nie gubi
// informacji o przebiegu pierwotnym.

import { canonicalJson, sha256Hex } from './export.js';

export const ANONYMIZATION_LOG_FORMAT = 'rd-anonymization-log';
export const ANONYMIZATION_LOG_VERSION = 1;
// Kody powodów przebiegu pierwotnego (jak ANONYMIZATION_REASON_CODES; powtórzone, by moduł nie ciągnął zależności).
const SOURCE_REASON_CODES = Object.freeze(['retention_policy', 'data_subject_request']);

export class AnonymizationLogError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
// Identyfikator techniczny: bez „@”, spacji i znaków spoza ASCII (e-mail ani nazwisko tu nie przejdą).
const TECHNICAL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
// Czas przebiegu: zawsze 6 cyfr ułamka (mikrosekundy z bazy), by porządek tekstowy = chronologiczny.
const RUN_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const EXPORT_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RUN_KEYS = ['dataSubjectRequestId', 'executedAt', 'executedBy', 'householdId', 'planSha256', 'reasonCode', 'retentionPolicyIds', 'runId'];
const FILE_KEYS = ['exportedAt', 'format', 'formatVersion', 'runs', 'runsSha256'];

function fail(code) {
  throw new AnonymizationLogError(code);
}

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail('invalid_timestamp');
  return date.toISOString();
}

function compareRuns(left, right) {
  if (left.executedAt !== right.executedAt) return left.executedAt < right.executedAt ? -1 : 1;
  if (left.runId === right.runId) return 0;
  return left.runId < right.runId ? -1 : 1;
}

export function sortRuns(runs) {
  return [...runs].sort(compareRuns);
}

/** Wiersz `anonymization_runs` -> wpis dziennika (przebieg ponowiony: w terminach źródłowych). */
export function logEntryFromRow(row) {
  if (row.reason_code === 'restore_reapply') {
    const source = typeof row.source_run === 'string' ? JSON.parse(row.source_run) : row.source_run;
    return {
      runId: row.id,
      householdId: row.household_id,
      reasonCode: source.reasonCode,
      dataSubjectRequestId: source.dataSubjectRequestId ?? null,
      retentionPolicyIds: [...(source.retentionPolicyIds ?? [])],
      planSha256: source.planSha256,
      executedAt: source.executedAt,
      executedBy: source.executedBy,
    };
  }
  return {
    runId: row.id,
    householdId: row.household_id,
    reasonCode: row.reason_code,
    dataSubjectRequestId: row.data_subject_request_id ?? null,
    retentionPolicyIds: [...(row.retention_policy_ids ?? [])],
    planSha256: row.plan_sha256,
    executedAt: row.executed_at_iso,
    executedBy: row.executed_by,
  };
}

/** Wpis źródłowy zapisywany w `anonymization_runs.source_run` (bez identyfikatora przebiegu: to `id` wiersza). */
export function sourceRunFromEntry(entry) {
  return {
    reasonCode: entry.reasonCode,
    dataSubjectRequestId: entry.dataSubjectRequestId,
    retentionPolicyIds: entry.retentionPolicyIds,
    planSha256: entry.planSha256,
    executedAt: entry.executedAt,
    executedBy: entry.executedBy,
  };
}

function validateEntry(entry, index) {
  const at = (field) => `runs[${index}].${field}`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`invalid_entry:runs[${index}]`);
  const keys = Object.keys(entry).sort();
  if (keys.length !== RUN_KEYS.length || keys.some((key, i) => key !== RUN_KEYS[i])) fail(`unexpected_fields:runs[${index}]`);
  if (typeof entry.runId !== 'string' || !UUID.test(entry.runId)) fail(`invalid_field:${at('runId')}`);
  if (typeof entry.householdId !== 'string' || !TECHNICAL_ID.test(entry.householdId)) fail(`invalid_field:${at('householdId')}`);
  if (!SOURCE_REASON_CODES.includes(entry.reasonCode)) fail(`invalid_field:${at('reasonCode')}`);
  if (entry.dataSubjectRequestId !== null && (typeof entry.dataSubjectRequestId !== 'string' || !TECHNICAL_ID.test(entry.dataSubjectRequestId))) {
    fail(`invalid_field:${at('dataSubjectRequestId')}`);
  }
  if (!Array.isArray(entry.retentionPolicyIds) || entry.retentionPolicyIds.length > 32
    || entry.retentionPolicyIds.some((id) => typeof id !== 'string' || !TECHNICAL_ID.test(id))) {
    fail(`invalid_field:${at('retentionPolicyIds')}`);
  }
  // Ten sam kształt co CHECK anonymization_runs_reason_shape (0174): powód wyznacza dodatkowe pola.
  if ((entry.reasonCode === 'data_subject_request') !== (entry.dataSubjectRequestId !== null)) fail(`invalid_field:${at('dataSubjectRequestId')}`);
  if ((entry.reasonCode === 'retention_policy') !== (entry.retentionPolicyIds.length > 0)) fail(`invalid_field:${at('retentionPolicyIds')}`);
  if (typeof entry.planSha256 !== 'string' || !SHA256.test(entry.planSha256)) fail(`invalid_field:${at('planSha256')}`);
  if (typeof entry.executedAt !== 'string' || !RUN_INSTANT.test(entry.executedAt) || Number.isNaN(Date.parse(entry.executedAt))) {
    fail(`invalid_field:${at('executedAt')}`);
  }
  if (typeof entry.executedBy !== 'string' || !TECHNICAL_ID.test(entry.executedBy)) fail(`invalid_field:${at('executedBy')}`);
}

/** Buduje plik dziennika z wpisów (sortuje, liczy sumę). Wpisy są walidowane jak przy odczycie. */
export function buildAnonymizationLog(entries, { exportedAt = new Date() } = {}) {
  const runs = sortRuns(entries);
  runs.forEach(validateEntry);
  if (new Set(runs.map((run) => run.runId)).size !== runs.length) fail('duplicate_run_id');
  return {
    format: ANONYMIZATION_LOG_FORMAT,
    formatVersion: ANONYMIZATION_LOG_VERSION,
    exportedAt: toIso(exportedAt),
    runs,
    runsSha256: sha256Hex(canonicalJson(runs)),
  };
}

export function serializeAnonymizationLog(log) {
  return `${JSON.stringify(log, null, 2)}\n`;
}

/** Odczyt z bazy: wszystkie przebiegi (także ponowione) w kolejności wykonania. */
export async function readAnonymizationLog(executor, { exportedAt } = {}) {
  const { rows } = await executor.query(
    `SELECT id, household_id, reason_code, data_subject_request_id, retention_policy_ids, plan_sha256,
            executed_by, source_run,
            to_char(executed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS executed_at_iso
       FROM anonymization_runs ORDER BY executed_at, id`,
  );
  return buildAnonymizationLog(rows.map(logEntryFromRow), { exportedAt });
}

/**
 * Parsuje i weryfikuje plik dziennika (tekst JSON): format, wersja, dokładny zestaw
 * pól, wzorce wartości, brak duplikatów `runId`, suma `runsSha256`. Zwraca wpisy
 * posortowane po (executedAt, runId). Błąd: AnonymizationLogError z kodem.
 */
export function parseAnonymizationLog(text) {
  let log;
  try {
    log = JSON.parse(text);
  } catch {
    fail('log_not_json');
  }
  if (!log || typeof log !== 'object' || Array.isArray(log)) fail('log_not_object');
  if (log.format !== ANONYMIZATION_LOG_FORMAT) fail('log_wrong_format');
  if (log.formatVersion !== ANONYMIZATION_LOG_VERSION) fail('log_unsupported_version');
  const keys = Object.keys(log).sort();
  if (keys.length !== FILE_KEYS.length || keys.some((key, i) => key !== FILE_KEYS[i])) fail('log_unexpected_fields');
  if (typeof log.exportedAt !== 'string' || !EXPORT_INSTANT.test(log.exportedAt)) fail('log_invalid_exported_at');
  if (!Array.isArray(log.runs)) fail('log_runs_not_array');
  log.runs.forEach(validateEntry);
  if (typeof log.runsSha256 !== 'string' || !SHA256.test(log.runsSha256)) fail('log_invalid_checksum');
  if (sha256Hex(canonicalJson(log.runs)) !== log.runsSha256) fail('log_checksum_mismatch');
  if (new Set(log.runs.map((run) => run.runId)).size !== log.runs.length) fail('duplicate_run_id');
  return { exportedAt: log.exportedAt, runs: sortRuns(log.runs) };
}

/**
 * Łączy wpisy z kilku plików (kolejne eksporty): suma zbiorów po `runId`.
 * Ten sam `runId` o różnej treści = błąd (`log_conflict`), nie wybór „nowszego”.
 */
export function mergeLogRuns(lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const run of list) {
      const known = byId.get(run.runId);
      if (known && canonicalJson(known) !== canonicalJson(run)) fail('log_conflict');
      byId.set(run.runId, run);
    }
  }
  return sortRuns([...byId.values()]);
}
