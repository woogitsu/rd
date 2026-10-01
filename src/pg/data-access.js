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
//   * `dedupe: false` (eksport danych rodziny dla żądania osoby, #100): każdy
//     przebieg to osobny wiersz — bez scalania z wcześniejszym odczytem karty
//     tego samego gospodarstwa w oknie 5 minut.
// Zwraca true, gdy wpis (lub odświeżenie licznika) zapisano.
export async function recordDataAccess(env, {
  actorId, accessKind, schoolYearId = null, classId = null, householdId = null, outcome, rowCount = 0,
}, { strict = false, dedupe = true } = {}) {
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
    const { rows } = !dedupe ? { rows: [] } : await env.db.query(
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
  // #142: imiona i nazwiska opiekunów klasy wydarzenia do formularza zapisu wolontariuszy.
  { id: 'events.taskCandidates', method: 'GET', path: '/api/events/:eventId/tasks/candidates', file: 'src/pg/events.js', accessKind: 'class_students' },
  { id: 'print.cards', method: 'GET', path: '/api/print/cards', file: 'src/pg/routes/print.js', accessKind: 'print_cards' },
  { id: 'payments.list', method: 'GET', path: '/api/payments', file: 'src/pg/routes/payments.js', accessKind: 'payment_list' },
  { id: 'payments.exportCsv', method: 'GET', path: '/api/payments/export.csv', file: 'src/pg/routes/payments.js', accessKind: 'payment_export' },
  { id: 'payments.exportXlsx', method: 'GET', path: '/api/payments/export.xlsx', file: 'src/pg/routes/payments.js', accessKind: 'payment_export' },
  { id: 'exports.classRoster', method: 'GET', path: '/api/exports/class-roster', file: 'src/pg/routes/exports.js', accessKind: 'class_roster_export', strict: true },
  { id: 'exports.yearly', method: 'POST', path: '/api/exports', file: 'src/pg/routes/exports.js', accessKind: 'yearly_export', strict: true },
  // #100: eksport danych jednej rodziny dla żądania osoby — wpis `household_card`
  // na każde gospodarstwo zakresu (osobny rodzaj wymaga migracji CHECK — patrz
  // docs/DATA_REQUESTS.md); rozróżnienie od odczytu karty: zdarzenie audytu
  // data_subject_request.exported w tej samej transakcji.
  { id: 'admin.dataRequestExport', method: 'POST', path: '/api/admin/data-requests/:requestId/export', file: 'src/pg/routes/admin.js', accessKind: 'household_card', strict: true },
]);

export const DATA_ACCESS_KINDS = Object.freeze([
  'class_students', 'household_card', 'print_cards', 'payment_list', 'class_roster_export', 'yearly_export', 'payment_export',
]);

// Jawna lista wyjątków (#133): trasy GET, które NIE zapisują wpisu w
// data_access_log, każda z uzasadnieniem. Meta-test
// tests/pg-data-access-coverage.test.js wymaga, by KAŻDA trasa GET z macierzy
// uprawnień (tests/helpers/route-matrix.js, a przez nią z ROUTES w app.js) była
// w DATA_ACCESS_ROUTES albo tutaj — nowa trasa GET bez klasyfikacji wywraca test.
// `audit` = odczyt ma osobny ślad w audit_events (akcja ze słownika, zapisywana
// w źródle; ślady dodane w #133 sprawdzane też wywołaniem); `followUp` = luka
// świadomie odłożona (opis w docs/SECURITY.md).
const EXEMPT_GROUPS = [
  {
    reason: 'sesja, logowanie i własne konto: dane zalogowanego członka Rady, nie rodzin',
    routes: ['session.get', 'session.access', 'sessions.list', 'login.state'],
  },
  {
    reason: 'widok publiczny: wyłącznie zatwierdzone treści (zdjęcia po sprawdzeniu zgód), bez rejestru rodzin',
    routes: ['events.public', 'news.public', 'news.publicItem', 'news.publicSchoolYears', 'news.publicPhotoFileWeb', 'news.publicPhotoFileThumb',
      'meetings.publicMinutes', 'meetings.publicNotices', 'privacyNotice.public'],
  },
  {
    reason: 'finanse Rady (księga, budżet, uzgodnienia, sprawozdania): kwoty i opisy operacji, tytuły wyciągu tylko jako skrót, bez imion i e-maili rodzin',
    routes: ['ledger.list', 'ledger.categories', 'ledger.summary', 'ledger.budget', 'ledger.exportCsv', 'ledger.exportXlsx',
      'ledger.reviews', 'ledger.resolutions', 'ledgerBudget.history', 'ledgerBudget.execution',
      'ledgerCostCenters.report', 'ledgerCostCenters.allocations', 'ledgerCostCenters.eventFinance',
      'ledgerCash.transfers', 'ledgerCash.openingBalance', 'reconciliation.list', 'reconciliation.get',
      'reconciliation.suggestions', 'reconciliation.auditReport', 'reconciliation.auditReportXlsx', 'financialReports.annual', 'financialReports.cashFlow',
      'auditReviews.list', 'financialReports.snapshotList', 'financialReports.snapshotRead', 'payment-instructions.get', 'yearClose.handover'],
  },
  {
    reason: 'zebrania, uchwały, wydarzenia, aktualności i metadane dokumentów Rady (zgody na wizerunek jako numery i referencje, bez imion)',
    routes: ['meetings.list', 'meetings.sharedMinutes', 'meetings.resolutionLookup', 'meetings.get', 'meetings.approvalChecklist', 'meetings.noticeCalendar',
      'meetings.resolutionRegister', 'events.list', 'events.get', 'news.list', 'news.get', 'news.photos', 'news.photoGet',
      'documents.list', 'documents.getFinancial', 'documents.getBoard', 'documents.getClass', 'documents.getCouncilShared'],
  },
  {
    reason: 'agregaty i liczniki (bez imion, e-maili i identyfikatorów rodzin) albo konfiguracja',
    routes: ['families.classes', 'board.overview', 'board.overviewExportCsv', 'board.overviewExportXlsx', 'representative.overview',
      'admin.classCoverage', 'admin.retentionPreview', 'admin.opsStatus', 'yearClose.status', 'import.options',
      'email.list', 'email.status', 'email.report', 'email.providerPause.get', 'email.workerStatus.get'],
  },
  {
    reason: 'administracja kont Rady: dane członków Rady, nie dzieci i opiekunów',
    routes: ['admin.users', 'admin.accountRequests', 'admin.grantRequests', 'admin.grants', 'admin.invitations', 'admin.schoolYears', 'privacyNotice.list'],
  },
  {
    reason: 'rejestr żądań osób i historia ograniczeń przetwarzania (#100): wyłącznie identyfikatory, rodzaj, akcja i daty; tylko admin z MFA',
    routes: ['admin.dataRequests', 'admin.dataRequestRestrictions'],
  },
  {
    reason: 'właściciel jednorazowego tokenu widzi wyłącznie własne dane (bez sesji Rady)',
    routes: ['guardianUpdates.previewPublic', 'email.preferences.get'],
  },
  {
    reason: 'podgląd kampanii: jedna próbka (identyfikator gospodarstwa i zamaskowany adres); pełna lista tylko przez email.recipients ze śladem audytu',
    routes: ['email.preview'],
  },
  { reason: 'treść dokumentu: osobny ślad audytu każdego pobrania', audit: 'document.downloaded', routes: ['documents.contentFinancial', 'documents.contentBoard', 'documents.contentClass', 'documents.contentCouncilShared'] },
  { reason: 'odbiorcy kampanii (adresy opiekunów): osobny ślad audytu', audit: 'email.recipients.viewed', routes: ['email.recipients'] },
  { reason: 'wstrzymane adresy (zamaskowane) z gospodarstwem: osobny ślad audytu', audit: 'email.suppressions.viewed', routes: ['email.suppressions.list'] },
  { reason: 'nieudane doręczenia (adresy zamaskowane): osobny ślad audytu', audit: 'email.attention_list.viewed', routes: ['email.attention'] },
  { reason: 'przegląd dziennika zdarzeń (admin + MFA): sam zapisuje ślad', audit: 'audit.viewed', routes: ['admin.audit'] },
  { reason: 'przegląd dziennika odczytu (admin + MFA): sam zapisuje ślad', audit: 'access_log.viewed', routes: ['admin.accessLog'] },
  {
    reason: 'prośby opiekunów o aktualizację (imię opiekuna, proponowany adres): ślad audytu odczytu; rodzaj w data_access_log wymaga migracji CHECK',
    audit: 'guardian_update_request.list_viewed', routes: ['guardianUpdates.list'], followUp: true,
  },
  {
    reason: 'zgłoszenia do zadań wydarzenia (imię i nazwisko opiekuna): ślad audytu odczytu, gdy lista zawiera opiekunów; rodzaj w data_access_log wymaga migracji CHECK',
    audit: 'event.task_signups_viewed', routes: ['events.tasksList'], followUp: true,
  },
  {
    reason: 'identyfikatory gospodarstw i kwoty jednej wpłaty / referencje OGM jednego gospodarstwa (rola finansowa, bez imion i e-maili); objęcie data_access_log wymaga nowego rodzaju w CHECK (migracja)',
    routes: ['payments.allocations.list', 'payment-references.list'], followUp: true,
  },
];

export const DATA_ACCESS_EXEMPT_ROUTES = Object.freeze(Object.fromEntries(EXEMPT_GROUPS.flatMap((group) => group.routes.map(
  (id) => [id, Object.freeze({ reason: group.reason, audit: group.audit ?? null, followUp: Boolean(group.followUp) })],
))));
