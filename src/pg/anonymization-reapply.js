// Ponowne zastosowanie przebiegów anonimizacji po odtworzeniu kopii (#91).
// Prototyp — nie jest wdrożony i nie jest gotowy do pracy na danych rodzin.
//
// Wejście: wpisy z dziennika przechowywanego POZA bazą (src/pg/anonymization-log.js).
// To nie jest nowa decyzja: zatwierdzenie (polityka D-04 albo żądanie D-07 i
// wskazany plan) zapadło przy przebiegu pierwotnym i jest w dzienniku. Dlatego
// ponowienie NIE sprawdza ponownie polityk ani żądania osoby (w odtworzonej bazie
// mogą nie istnieć) — dane do zmiany wylicza ten sam plan co przebieg z trasy
// (`planAnonymization`, te same tabele i kolumny, ta sama furtka
// `rd.anonymization_run`). Autentyczność pliku jest poza kodem (sumę kontrolną
// pliku sprawdza parseAnonymizationLog); wykonuje wyłącznie aktywny administrator
// podany jako `actorId`.
//
// Zachowanie:
//   - wpisy w kolejności wykonania pierwotnego (executedAt, runId), wszystkie w
//     JEDNEJ transakcji: błąd wycofuje całość, a podgląd (dryRun) wykonuje tę samą
//     pracę i wycofuje — dlatego jest dokładny także dla osób wspólnych kilku
//     gospodarstw (późniejszy wpis widzi skutek wcześniejszego);
//   - `already_recorded`  — baza ma już wiersz o tym `runId` (kopia sprzed zapisu
//     dziennika nie, ale kopia po przebiegu tak): pominięty;
//   - `household_missing` — gospodarstwa nie ma w odtworzonej bazie (np. założone
//     po kopii, albo paczka roczna go nie obejmuje): pominięty, bez błędu;
//   - `nothing_to_change` — gospodarstwo jest już zanonimizowane (plan pusty):
//     pominięty, bez wiersza i bez zdarzenia (jak `replayed` z trasy);
//   - `applied` / `would_apply` — zmiana według planu; wiersz `anonymization_runs`
//     z kodem `restore_reapply`, identyfikatorem pierwotnego przebiegu i danymi
//     źródłowymi w `source_run` oraz zdarzenie audytu `household.anonymized`
//     (aktor = osoba uruchamiająca ponowienie, nie wykonawca pierwotny).
// Skrót planu z dziennika (`planSha256`) nie jest warunkiem: baza z kopii ma inny
// stan niż baza w chwili przebiegu, więc skrót może się różnić (`planMatchesSource`
// w wyniku to informacja, nie bramka). Ponowienie obejmuje wszystko, co w
// gospodarstwie wymaga zmiany w chwili ponowienia — zachowawczo względem prywatności.
//
// Wynik i zdarzenia zawierają wyłącznie identyfikatory, kody i liczniki.

import { insertAuditEvent } from './audit.js';
import { AnonymizationError, applyAnonymizationPlan, planAnonymization, planCounts, planDigest } from './anonymization.js';
import { sourceRunFromEntry } from './anonymization-log.js';

export const REAPPLY_REASON_CODE = 'restore_reapply';

class DryRunRollback extends Error {
  constructor() {
    super('dry_run_rollback');
  }
}

async function requireActiveAdmin(tx, actorId) {
  const { rows } = await tx.query(
    `SELECT 1 FROM users u
      WHERE u.id = $1 AND u.disabled_at IS NULL
        AND EXISTS (SELECT 1 FROM role_grants g
                     WHERE g.user_id = u.id AND g.role = 'admin' AND g.revoked_at IS NULL
                       AND (g.expires_at IS NULL OR g.expires_at > now()))`,
    [actorId],
  );
  if (!rows.length) throw new AnonymizationError('reapply_actor_not_admin', 403);
}

async function reapplyOne(tx, entry, { actorId, dryRun }) {
  const base = { runId: entry.runId, householdId: entry.householdId, reasonCode: entry.reasonCode };
  const { rows: known } = await tx.query('SELECT 1 FROM anonymization_runs WHERE id = $1', [entry.runId]);
  if (known.length) return { ...base, outcome: 'already_recorded' };
  const { rows: household } = await tx.query('SELECT 1 FROM households WHERE id = $1', [entry.householdId]);
  if (!household.length) return { ...base, outcome: 'household_missing' };

  const plan = await planAnonymization(tx, entry.householdId);
  const counts = planCounts(plan);
  const planSha256 = planDigest(plan);
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const details = { planSha256, planMatchesSource: planSha256 === entry.planSha256, counts, retained: plan.retained };
  if (total === 0) return { ...base, outcome: 'nothing_to_change', ...details };

  await applyAnonymizationPlan(tx, plan, entry.runId);
  await tx.query(
    `INSERT INTO anonymization_runs
       (id, household_id, reason_code, data_subject_request_id, retention_policy_ids, plan_sha256, counts, executed_by, source_run)
     VALUES ($1, $2, $3, NULL, '{}'::text[], $4, $5::jsonb, $6, $7::jsonb)`,
    [entry.runId, entry.householdId, REAPPLY_REASON_CODE, planSha256, JSON.stringify(counts), actorId, JSON.stringify(sourceRunFromEntry(entry))],
  );
  await insertAuditEvent(tx, {
    actorId, action: 'household.anonymized', entityType: 'anonymization_run', entityId: entry.runId,
    metadata: {
      householdId: entry.householdId, reasonCode: REAPPLY_REASON_CODE, planSha256, counts,
      retainedGuardians: plan.retained.guardians, retainedStudents: plan.retained.students,
      sourceReasonCode: entry.reasonCode, sourcePlanSha256: entry.planSha256,
      sourceExecutedAt: entry.executedAt, sourceExecutedBy: entry.executedBy,
      ...(entry.dataSubjectRequestId ? { sourceDataSubjectRequestId: entry.dataSubjectRequestId } : {}),
      ...(entry.retentionPolicyIds.length ? { sourceRetentionPolicyIds: entry.retentionPolicyIds } : {}),
    },
  });
  return { ...base, outcome: dryRun ? 'would_apply' : 'applied', ...details };
}

/**
 * Ponawia przebiegi z dziennika po odtworzeniu kopii.
 *
 * @param {object} db baza (`db.transaction`)
 * @param {object} options
 * @param {string} options.actorId aktywny administrator uruchamiający ponowienie
 * @param {Array<object>} options.runs wpisy dziennika (po parseAnonymizationLog/mergeLogRuns)
 * @param {boolean} options.dryRun podgląd: ta sama praca w transakcji, która jest wycofywana
 * @returns {Promise<{mode:'dry_run'|'apply', total:number, summary:Record<string,number>, runs:object[]}>}
 */
export async function reapplyAnonymizationRuns(db, { actorId, runs, dryRun }) {
  if (typeof actorId !== 'string' || !actorId) throw new AnonymizationError('reapply_actor_required', 400);
  const outcomes = [];
  const work = async (tx) => {
    outcomes.length = 0;
    await requireActiveAdmin(tx, actorId);
    // Jedno ponowienie naraz; blokada gospodarstwa jak w trasie (podwójne kliknięcie, równoległy przebieg z panelu).
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['rd_reapply_anonymization']);
    for (const entry of runs) {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rd_anonymize_household:${entry.householdId}`]);
      outcomes.push(await reapplyOne(tx, entry, { actorId, dryRun }));
    }
  };

  if (dryRun) {
    try {
      await db.transaction(async (tx) => {
        await work(tx);
        throw new DryRunRollback();
      }, { retries: 0 });
    } catch (error) {
      if (!(error instanceof DryRunRollback)) throw error;
    }
    // Podgląd niczego nie zmienia, ale ujawnia liczności — zostaje ślad jak po podglądzie z trasy.
    const previewed = outcomes.filter((outcome) => outcome.outcome === 'would_apply');
    if (previewed.length) {
      await db.transaction(async (tx) => {
        for (const outcome of previewed) {
          await insertAuditEvent(tx, {
            actorId, action: 'household.anonymization_previewed', entityType: 'household', entityId: outcome.householdId,
            metadata: { reasonCode: REAPPLY_REASON_CODE, planSha256: outcome.planSha256, counts: outcome.counts, sourceRunId: outcome.runId },
          });
        }
      });
    }
  } else {
    await db.transaction(work);
  }

  const summary = {};
  for (const { outcome } of outcomes) summary[outcome] = (summary[outcome] ?? 0) + 1;
  return { mode: dryRun ? 'dry_run' : 'apply', total: outcomes.length, summary, runs: [...outcomes] };
}
