// Propozycja do zatwierdzenia: kandydaci do anonimizacji z polityki retencji (#91).
// Prototyp — nie jest wdrożony i nie jest gotowy do pracy na danych rodzin.
//
// Raport TYLKO DO ODCZYTU (transakcja `READ ONLY`): niczego nie zmienia, nie
// zapisuje wiersza `anonymization_runs`, zdarzenia audytu ani niczego do
// kolejki, i nie ma żadnego wykonawcy — administrator przegląda listę i dla
// wybranych gospodarstw uruchamia ręcznie istniejącą trasę
// `POST /api/admin/anonymizations` (podgląd, potem wykonanie z `confirm` i
// `expectedPlanSha256`). Wskazanie użytkownika z 2026-10-02 (docs/DECISIONS.md,
// D-04): bez automatycznego usuwania. Raport nie jest zadaniem okresowym i nie
// ma harmonogramu; uruchamia go człowiek (npm run anonymization:proposals).
//
// Kandydat = gospodarstwo, dla którego spełnione są warunki trybu `retention_policy`
// (te same funkcje co trasa: loadRetentionPolicies + assertRetentionPeriodElapsed
// — obowiązujące, zatwierdzone polityki `retain_for` dla czterech kategorii i
// upłynięty najdłuższy okres) i plan ma coś do zmiany. Bez kompletu polityk
// (D-04 nieustalone: rejestr `retention_policies` pusty) raport mówi „brak
// polityk” i nie wskazuje nikogo — nie ma wartości domyślnej okresu.
//
// Wynik zawiera wyłącznie identyfikatory techniczne, kody i liczniki. Skrót planu
// dotyczy bieżącego stanu: po wykonaniu przebiegu dla innego gospodarstwa (opieka
// dzielona) plan pozostałych może się zmienić, więc przed wykonaniem zawsze trzeba
// pobrać świeży podgląd z trasy.

import { AnonymizationError, assertRetentionPeriodElapsed, loadRetentionPolicies, planAnonymization, planCounts, planDigest } from './anonymization.js';

// Kody błędów polityk, po których raport kończy się bez kandydatów (niezależne od gospodarstwa).
const POLICY_PROBLEMS = {
  retention_policy_missing: { status: 'no_policies', summary: 'brak polityk' },
  retention_policy_not_approved: { status: 'policies_unusable', summary: 'polityki niezatwierdzone' },
  retention_rule_not_evaluable: { status: 'policies_unusable', summary: 'polityki bez okresu retain_for (tylko opis reguły)' },
};

/**
 * @param {object} db baza (`db.transaction`)
 * @returns {Promise<{execution:'none', status:'no_policies'|'policies_unusable'|'ok', summary:string,
 *   policyIds:string[], evaluated:number, periodNotElapsed:number, nothingToChange:number,
 *   candidates:Array<{householdId:string, planSha256:string, counts:object, retained:object}>}>}
 */
export async function proposeRetentionAnonymizations(db) {
  return db.transaction(async (tx) => {
    await tx.query('SET TRANSACTION READ ONLY');
    const empty = { execution: 'none', policyIds: [], evaluated: 0, periodNotElapsed: 0, nothingToChange: 0, candidates: [] };
    let policies;
    try {
      policies = await loadRetentionPolicies(tx);
    } catch (error) {
      const problem = error instanceof AnonymizationError ? POLICY_PROBLEMS[error.code] : null;
      if (!problem) throw error;
      return { ...empty, ...problem, reasonCode: error.code };
    }

    const { rows: households } = await tx.query('SELECT id FROM households ORDER BY id');
    const result = { ...empty, policyIds: policies.policyIds };
    for (const { id } of households) {
      result.evaluated += 1;
      try {
        await assertRetentionPeriodElapsed(tx, id, policies.intervals);
      } catch (error) {
        if (error instanceof AnonymizationError && error.code === 'retention_period_not_elapsed') {
          result.periodNotElapsed += 1;
          continue;
        }
        throw error;
      }
      const plan = await planAnonymization(tx, id);
      const counts = planCounts(plan);
      if (Object.values(counts).every((n) => n === 0)) {
        result.nothingToChange += 1;
        continue;
      }
      result.candidates.push({ householdId: id, planSha256: planDigest(plan), counts, retained: plan.retained });
    }
    return {
      ...result,
      status: 'ok',
      summary: result.candidates.length ? `kandydatów: ${result.candidates.length}` : 'brak kandydatów',
    };
  });
}
