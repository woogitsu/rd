// #184 pkt 6: meta-test pokrycia audytem na poziomie WIERSZY (AGENTS.md: trwały
// dziennik z aktorem, czasem i identyfikatorem obiektu).
//
// tests/pg-authz-matrix.test.js po każdym UDANYM wywołaniu trasy zapisu
// (POST/PATCH/PUT/DELETE) porównuje identyfikatory wierszy wszystkich tabel
// z kolumną `id` (poza audit_events) przed i po żądaniu. Każdy NOWY wiersz musi
// mieć zdarzenie audytu z tego samego żądania, którego entity_id:
//   1. jest identyfikatorem tego wiersza, albo
//   2. jest identyfikatorem obiektu nadrzędnego z AUDIT_ROW_PARENTS (wiersz
//      podrzędny lub historia zmian — zdarzenie wskazuje obiekt, którego dotyczy),
//      albo wpis nazywa klucz metadanych (`metadataKeys`), który niesie id wiersza,
// chyba że tabela jest techniczna (AUDIT_ROW_TECHNICAL) albo para trasa+tabela
// jest na liście AUDIT_ROW_ROUTE_EXEMPT. Każdy wpis ma uzasadnienie.
//
// Nowa tabela biznesowa zapisywana bez zdarzenia = czerwony test. Nie dopisuj
// tu tabeli biznesowej tylko po to, żeby test przeszedł — dopisz
// insertAuditEvent(tx, …) w trasie (etykieta i domena w shared/audit-actions.js).

const composite = (...parts) => parts.join(':');

// Wiersz podrzędny / historia: klucze obiektu nadrzędnego, który wskazuje zdarzenie.
export const AUDIT_ROW_PARENTS = new Map([
  ['document_status_events', {
    keys: (row) => [row.document_id],
    why: 'historia statusu dokumentu (zastąpienie, unieważnienie); document.superseded/voided wskazuje dokument',
  }],
  ['news_photo_files', {
    keys: (row) => [row.photo_id],
    why: 'plik zdjęcia w buckecie; news_photo.file_uploaded wskazuje zdjęcie (news_photo)',
  }],
  ['payment_reference_revocations', {
    keys: (row) => [row.payment_reference_id],
    why: 'wiersz cofnięcia tytułu przelewu; payment_reference.revoked wskazuje tytuł',
  }],
  ['bank_statement_lines', {
    keys: (row) => [row.import_id],
    why: 'linie wyciągu z jednego importu; reconciliation.lines.imported wskazuje import (z licznikami)',
  }],
  ['bank_reconciliation_group_match_items', {
    keys: (row) => [row.group_match_id],
    why: 'pozycje dopasowania grupowego; reconciliation.group_match.confirmed wskazuje dopasowanie',
  }],
  ['email_campaign_recipients', {
    keys: (row) => [row.campaign_id],
    why: 'migawka odbiorców kampanii; email.snapshot.built wskazuje kampanię (skrót listy, bez adresów)',
  }],
  ['email_outbox', {
    keys: (row) => [row.campaign_id],
    why: 'kolejka wiadomości kampanii (klucz kampania + rodzina); email.campaign.queued wskazuje kampanię',
  }],
  ['email_outbox_resolutions', {
    keys: (row) => [row.outbox_id],
    why: 'rozstrzygnięcie wiadomości o nieznanym stanie; email.outbox.resolved wskazuje wiadomość (email_outbox)',
  }],
  ['email_outbox_resolution_approvals', {
    keys: (row) => [row.outbox_id],
    why: 'zatwierdzenie „nie wyszła” przez drugą osobę (#139, 0156); email.outbox.resolution_approved wskazuje wiadomość (email_outbox)',
  }],
  ['email_preview_sends', {
    keys: (row) => [row.campaign_id],
    why: 'wysyłka testowa na adres techniczny Rady; email.preview.sent wskazuje kampanię',
  }],
  ['email_preferences_events', {
    keys: (row) => [row.campaign_id],
    why: 'wypisanie z publicznego linku (hash adresu, bez adresu); email.preference.opt_out wskazuje kampanię z tokenu',
  }],
  ['guardian_contact_changes', {
    keys: (row) => [row.guardian_id],
    why: 'historia zmian kontaktu opiekuna (trigger, powód tylko w tabeli); guardian.contact.updated wskazuje opiekuna',
  }],
  ['identity_changes', {
    keys: (row) => [row.student_id ?? row.guardian_id],
    why: 'historia sprostowań imienia i nazwiska (trigger, imiona i powód tylko w tabeli); student.identity.updated / guardian.identity.updated wskazuje ucznia lub opiekuna',
  }],
  ['student_guardian_changes', {
    keys: (row) => [composite(row.student_id, row.guardian_id)],
    why: 'historia relacji uczeń–opiekun (trigger); student_guardian.* wskazuje parę uczeń:opiekun',
  }],
  ['enrollment_history', {
    keys: (row) => [row.enrollment_id],
    why: 'historia przypisań do klas (trigger); enrollment.* wskazuje przypisanie (enrollment)',
  }],
  ['payment_allocation_reversals', {
    keys: (row) => [row.allocation_id],
    why: 'storno podziału wpłaty (nowy wiersz, bez zacierania); payment.allocation.reversed wskazuje podział, id storna w metadanych',
  }],
  ['ledger_corrections', {
    keys: (row) => [row.ledger_entry_id],
    metadataKeys: ['correctionId'],
    why: 'storno wpisu księgi przy zastąpieniu; ledger.entry.replaced wskazuje nowy wpis, a metadata.correctionId to storno',
  }],
  ['ledger_entry_reviews', {
    keys: (row) => [row.ledger_entry_id],
    why: 'przegląd wpisu księgi (Komisja Rewizyjna); ledger.entry.verified/questioned wskazuje wpis',
  }],
  ['ledger_allocation_versions', {
    keys: (row) => [row.ledger_entry_id],
    why: 'wersja podziału wpisu na centra kosztów (nowa wersja zamiast zmiany); ledger.allocation.created wskazuje wpis',
  }],
  ['ledger_category_deactivations', {
    keys: (row) => [row.category_id],
    why: 'wycofanie kategorii księgi (wiersz zamiast zmiany); ledger.category.deactivated wskazuje kategorię',
  }],
  ['resolution_spending_authorizations', {
    keys: (row) => [row.resolution_id],
    why: 'wersja upoważnienia wydatku z uchwały; resolution.spending_authorization.recorded wskazuje uchwałę',
  }],
  ['bank_reconciliation_group_match_revocations', {
    keys: (row) => [row.group_match_id],
    why: 'cofnięcie dopasowania grupowego (wiersz zamiast usunięcia); reconciliation.group_match.revoked wskazuje dopasowanie',
  }],
  ['meeting_reschedules', {
    keys: (row) => [row.meeting_id],
    why: 'historia zmian terminu zebrania; meeting.rescheduled wskazuje zebranie',
  }],
  ['meeting_minutes_publications', {
    keys: (row) => [row.minutes_id],
    why: 'decyzja o widoczności protokołu (nowy wiersz); meeting.minutes.visibility_set wskazuje protokół',
  }],
  // Wiersze importu mają import_batch_id; import.committed wskazuje partię z licznikami.
  ['households', { keys: (row) => [row.import_batch_id], why: 'gospodarstwo z importu; import.committed wskazuje partię importu (import_batch_id)' }],
  ['guardians', { keys: (row) => [row.import_batch_id], why: 'opiekun z importu; import.committed wskazuje partię importu (import_batch_id)' }],
  ['students', { keys: (row) => [row.import_batch_id], why: 'uczeń z importu; import.committed wskazuje partię importu (import_batch_id)' }],
]);

// Tabele techniczne: nie są obiektem biznesowym albo same są dziennikiem.
// (Tabele bez kolumny `id` — liczniki prób, klucze idempotencji, hasła — są poza
// tym sprawdzeniem; ich zapis w odmowie pilnuje WRITE_TABLES w macierzy.)
export const AUDIT_ROW_TECHNICAL = new Map([
  ['document_uploads', 'zamiar uploadu zapisany przed wysłaniem obiektu do bucketu (#168) — dziennik techniczny; document.uploaded wskazuje dokument'],
  ['email_send_ledger', 'licznik limitu wysyłek Brevo (technika kolejki), nie obiekt biznesowy; wysyłkę opisuje zdarzenie kampanii/wysyłki testowej'],
  ['email_webhook_events', 'dziennik techniczny webhooka Brevo z kluczem deduplikacji; zmiana stanu adresu loguje email.address_suppressed'],
  ['mfa_recovery_codes', 'skróty kodów odzyskiwania tworzone razem z czynnikiem MFA; mfa.enrolled wskazuje czynnik (bez kodów w dzienniku)'],
  ['data_access_log', 'sam jest dziennikiem dostępu do danych osobowych (#133) — zapis o zapisie byłby rekurencją'],
]);

// Para trasa → tabele, których wiersze opisuje jedno zdarzenie zbiorcze bez kolumny łączącej.
export const AUDIT_ROW_ROUTE_EXEMPT = new Map([
  ['import.commit', {
    tables: ['enrollments', 'enrollment_history', 'student_households', 'guardian_households'],
    why: 'import tworzy przypisania i relacje rodzin zbiorczo; import.committed (import_batch) niesie liczniki, a uczeń/gospodarstwo/opiekun mają import_batch_id',
  }],
]);

// Wszystkie tabele z kolumną `id` (poza samym dziennikiem) — kandydaci do sprawdzenia.
// Schemat nie zmienia się w trakcie testu, więc lista jest pamiętana per baza.
const tablesByDb = new WeakMap();
export async function rowCoverageTables(db) {
  if (!tablesByDb.has(db)) tablesByDb.set(db, loadTables(db));
  return tablesByDb.get(db);
}

async function loadTables(db) {
  const { rows } = await db.query(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'id' AND t.table_type = 'BASE TABLE'
        AND c.table_name <> 'audit_events'
      ORDER BY c.table_name`,
  );
  return rows.map((row) => row.table_name);
}

// Zbiór 'tabela|id' wszystkich wierszy wskazanych tabel (jedno zapytanie).
export async function rowIdSnapshot(db, tables) {
  const { rows } = await db.query(tables.map((table) => `SELECT '${table}' AS t, id::text AS id FROM ${table}`).join(' UNION ALL '));
  return new Set(rows.map((row) => `${row.t}|${row.id}`));
}

// Nowe wiersze (pełne) pogrupowane po tabeli: [{ table, row }].
export async function newRows(db, before, after) {
  const byTable = new Map();
  for (const key of after) {
    if (before.has(key)) continue;
    const [table, id] = key.split('|');
    if (!byTable.has(table)) byTable.set(table, []);
    byTable.get(table).push(id);
  }
  const out = [];
  for (const [table, ids] of byTable) {
    const { rows } = await db.query(`SELECT * FROM ${table} WHERE id::text = ANY($1::text[])`, [ids]);
    for (const row of rows) out.push({ table, row });
  }
  return out;
}

function metadataOf(event) {
  const raw = event.metadata_json ?? {};
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// Czysta funkcja detektora (kontrola pozytywna w tests/audit-row-coverage.test.js).
// rows: [{ table, row }] — nowe wiersze; events: nowe zdarzenia audytu tego żądania.
export function rowCoverageProblems(routeId, rows, events) {
  const entities = new Set(events.map((event) => String(event.entity_id)));
  const problems = [];
  for (const { table, row } of rows) {
    if (AUDIT_ROW_TECHNICAL.has(table)) continue;
    if (AUDIT_ROW_ROUTE_EXEMPT.get(routeId)?.tables.includes(table)) continue;
    if (entities.has(String(row.id))) continue;
    const parent = AUDIT_ROW_PARENTS.get(table);
    if (parent && parent.keys(row).some((key) => key != null && entities.has(String(key)))) continue;
    if (parent?.metadataKeys?.some((key) => events.some((event) => String(metadataOf(event)[key] ?? '') === String(row.id)))) continue;
    problems.push(`nowy wiersz ${table} (id ${row.id}) bez zdarzenia audytu wskazującego go`
      + `${parent ? ' ani obiekt nadrzędny' : ''} (zdarzenia: ${events.map((event) => `${event.action}→${event.entity_type}`).join(', ') || 'brak'})`
      + ' — dopisz insertAuditEvent(tx, …) w trasie');
  }
  return problems;
}
