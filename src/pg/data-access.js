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

// Gwarancja zapisu (#133, wariant zachowawczy do D-04/D-07/D-08):
//   * trasy list/kart (best effort, domyślnie): zapis jest AWAITOWANY przed
//     wysłaniem odpowiedzi (nie w tle), ale jego awaria nie blokuje odczytu —
//     tylko zdarzenie `access_log_failed` w logu serwera, bez danych;
//   * trasy eksportu (strict): zapis w TEJ SAMEJ transakcji co eksport
//     (executor = tx), a awaria zapisu wycofuje cały eksport — plik nie
//     powstaje bez wpisu.
// Zwraca true, gdy wpis (lub odświeżenie licznika) zapisano.
export async function recordDataAccess(env, {
  actorId, accessKind, schoolYearId = null, classId = null, householdId = null, outcome, rowCount = 0,
}, { strict = false } = {}) {
  if (!actorId || !accessKind || !outcome) {
    if (strict) throw new Error('data_access_log_invalid_entry');
    return false;
  }
  if (!env?.db?.query) {
    if (strict) throw new Error('data_access_log_unavailable');
    return false;
  }
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
    if (rows[0]) return true;
    await env.db.query(
      `INSERT INTO data_access_log
         (id, actor_id, access_kind, school_year_id, class_id, household_id, outcome, row_count, hit_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1)`,
      [crypto.randomUUID(), actorId, accessKind, schoolYearId, classId, householdId, outcome, rowCount],
    );
    return true;
  } catch (error) {
    // W transakcji błąd musi przejść wyżej (transakcja Postgresa i tak jest
    // już przerwana); poza nią nigdy nie blokuje odpowiedzi listy/karty.
    if (strict) throw error;
    console.error('access_log_failed', { accessKind, message: error?.message ?? 'unknown' });
    return false;
  }
}

// Rejestr tras zwracających dane osobowe dzieci/opiekunów (lub identyfikatory
// gospodarstw powiązane z wpłatami). Każda trasa tu wymieniona MUSI zapisywać
// wpis (meta-test tests/pg-data-access-coverage.test.js sprawdza to źródłowo i
// wywołaniem). Nowa trasa czytająca dane rodzin = nowy wiersz tutaj.
export const DATA_ACCESS_ROUTES = Object.freeze([
  { id: 'families.classStudents', method: 'GET', path: '/api/classes/:classId/students', file: 'src/pg/routes/families.js', accessKind: 'class_students' },
  { id: 'families.household', method: 'GET', path: '/api/households/:householdId', file: 'src/pg/routes/families.js', accessKind: 'household_card' },
  { id: 'print.cards', method: 'GET', path: '/api/print/cards', file: 'src/pg/routes/print.js', accessKind: 'print_cards' },
  { id: 'payments.list', method: 'GET', path: '/api/payments', file: 'src/pg/routes/payments.js', accessKind: 'payment_list' },
  { id: 'payments.exportCsv', method: 'GET', path: '/api/payments/export.csv', file: 'src/pg/routes/payments.js', accessKind: 'payment_export' },
  { id: 'exports.classRoster', method: 'GET', path: '/api/exports/class-roster', file: 'src/pg/routes/exports.js', accessKind: 'class_roster_export', strict: true },
  { id: 'exports.yearly', method: 'POST', path: '/api/exports', file: 'src/pg/routes/exports.js', accessKind: 'yearly_export', strict: true },
]);

export const DATA_ACCESS_KINDS = Object.freeze([
  'class_students', 'household_card', 'print_cards', 'payment_list', 'class_roster_export', 'yearly_export', 'payment_export',
]);
