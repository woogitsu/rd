// Dziennik odczytu danych dzieci i opiekunów (#133). Osobna tabela od
// audit_events (retencja i cel inne — patrz migracja 0067). Zapis nie blokuje
// odczytu: przy awarii tylko zdarzenie w logu serwera, bez danych (#133 pkt 2,
// wariant zachowawczy do czasu decyzji zarządu).
//
// Deduplikacja: ten sam aktor + ten sam access_kind + ten sam obiekt (class_id/
// household_id) + ten sam wynik (outcome), w oknie 5 minut, aktualizuje TYLKO
// last_seen_at/hit_count/row_count tego samego wiersza (trigger 0067 blokuje
// zmianę pozostałych pól i każde DELETE) — odświeżenie strony nie zalewa
// dziennika.
const WINDOW_MS = 5 * 60 * 1000;

export async function recordDataAccess(env, {
  actorId, accessKind, schoolYearId = null, classId = null, householdId = null, outcome, rowCount = 0,
}) {
  if (!actorId || !accessKind || !outcome) return;
  if (!env?.db?.query) return;
  try {
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const { rows } = await env.db.query(
      `UPDATE data_access_log
          SET last_seen_at = now(), hit_count = hit_count + 1, row_count = GREATEST(row_count, $6)
        WHERE actor_id = $1 AND access_kind = $2
          AND class_id IS NOT DISTINCT FROM $3 AND household_id IS NOT DISTINCT FROM $4
          AND outcome = $5 AND last_seen_at > $7
        RETURNING id`,
      [actorId, accessKind, classId, householdId, outcome, rowCount, since],
    );
    if (rows[0]) return;
    await env.db.query(
      `INSERT INTO data_access_log
         (id, actor_id, access_kind, school_year_id, class_id, household_id, outcome, row_count, hit_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1)`,
      [crypto.randomUUID(), actorId, accessKind, schoolYearId, classId, householdId, outcome, rowCount],
    );
  } catch (error) {
    // Nigdy nie blokuje odpowiedzi listy/karty; bez danych w logu serwera.
    console.error('access_log_failed', { accessKind, message: error?.message ?? 'unknown' });
  }
}
