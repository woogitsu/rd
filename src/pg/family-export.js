// Eksport danych jednej rodziny dla zarejestrowanego żądania osoby (RODO,
// #100 pkt 2–3). Prototyp — nie jest wdrożony i nie jest gotowy do pracy na
// danych rodzin; opis w docs/DATA_REQUESTS.md.
//
// Wspólny moduł dla obu formatów: JSON (deterministyczny, SHA-256 treści jak
// lista klasy w src/pg/export.js) i CSV do wydruku (src/pg/csv.js) powstają z
// TEGO SAMEGO modelu `bundle` — CSV nie czyta bazy osobno.
//
// Zakres (wariant zachowawczy do decyzji D-07, patrz docs/DATA_REQUESTS.md):
//   * żądanie dla gospodarstwa: uczniowie i opiekunowie należący do tego
//     gospodarstwa (także przez historię członkostwa student_households /
//     guardian_households) oraz wpłaty, kampanie i doręczenia informacji o
//     przetwarzaniu tego gospodarstwa;
//   * żądanie dla opiekuna: ten opiekun, jego dzieci (powiązania
//     student_guardians, także zakończone) i gospodarstwa, do których należy;
//   * żądanie dla ucznia: ten uczeń i jego przypisania do klas — bez danych
//     opiekunów i bez wpłat (dane gospodarstwa, nie dziecka).
// Osoby trzecie (opiekun dziecka spoza zakresu, inne gospodarstwo dziecka przy
// opiece dzielonej) są pominięte w paczce — obsługujący dostaje tylko ich
// liczbę (nagłówki odpowiedzi i metadane audytu), bez identyfikatorów.
// Identyfikator gospodarstwa spoza zakresu w kolumnie wiersza (np.
// students.household_id dziecka z innym gospodarstwem głównym) jest zastąpiony
// wartością null.
//
// Poza paczką (wariant zachowawczy do D-03/D-04/D-07): wolny tekst wpisany
// przez Radę (powody korekt/zmian, tytuły przelewów `payment_entries.reference`,
// notatki), historia adresów e-mail (`guardian_contact_changes` previous/new
// email, proponowany adres w `guardian_update_requests`), referencje OGM-VCS
// (`payment_references`), skróty adresów w blokadach i preferencjach e-mail,
// identyfikatory kont członków Rady (`created_by`, `actor_id`) i metadane
// zdarzeń audytu. Obsługujący może je uzupełnić ręcznie po ocenie.
//
// Paczka zawiera dane osobowe. Nie zapisywać jej w repo, CI, logach ani
// zgłoszeniach.

import { canonicalJson, sha256Hex } from './export.js';
import { csvHeader, csvRow } from './csv.js';

export const FAMILY_EXPORT_FORMAT = 'rd-family-export';
export const FAMILY_EXPORT_FORMAT_VERSION = 1;

// Rodzaje żądań, dla których eksport jest odpowiedzią (dostęp, przenoszenie).
export const EXPORTABLE_REQUEST_KINDS = Object.freeze(['access', 'portability']);
// Eksport tylko po weryfikacji tożsamości i przed zamknięciem żądania.
export const EXPORTABLE_REQUEST_STATUSES = Object.freeze(['identity_verified', 'in_progress']);

export class FamilyExportError extends Error {
  constructor(code, status = 409) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const TS = (column) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const DATE = (column) => `to_char(${column}, 'YYYY-MM-DD')`;
// Identyfikator gospodarstwa spoza zakresu nie trafia do paczki ($H = gospodarstwa zakresu).
const OWN_HOUSEHOLD = (column) => `CASE WHEN ${column} = ANY($H) THEN ${column} END`;

// Kolumny paczki: [klucz, etykieta CSV, typ CSV]. Klucz = alias w SELECT.
// Kolejność tabel = kolejność sekcji w CSV.
const T = 'text';
const A = 'amount';

// Każda tabela: `sql` z nazwanymi tablicami $H (gospodarstwa zakresu), $S
// (uczniowie), $G (opiekunowie), $P (gospodarstwa z wpłatami/kampaniami), $F
// (identyfikatory z tabeli nadrzędnej `from`). bindNamed zamienia je na $1...
// tylko dla użytych (Postgres odrzuca nadmiarowe parametry).
const FAMILY_TABLES = Object.freeze([
  {
    key: 'households', label: 'Gospodarstwa',
    columns: [['id', 'Identyfikator gospodarstwa', T], ['created_at', 'Utworzono', T], ['archived_at', 'Zarchiwizowano', T]],
    sql: `SELECT id, ${TS('created_at')} AS created_at, ${TS('archived_at')} AS archived_at
            FROM households WHERE id = ANY($H) ORDER BY id COLLATE "C"`,
  },
  {
    key: 'students', label: 'Uczniowie',
    columns: [['id', 'Identyfikator ucznia', T], ['household_id', 'Gospodarstwo główne', T],
      ['first_name', 'Imię', T], ['last_name', 'Nazwisko', T]],
    sql: `SELECT id, ${OWN_HOUSEHOLD('household_id')} AS household_id, first_name, last_name
            FROM students WHERE id = ANY($S) ORDER BY id COLLATE "C"`,
  },
  {
    key: 'guardians', label: 'Opiekunowie',
    columns: [['id', 'Identyfikator opiekuna', T], ['household_id', 'Gospodarstwo główne', T],
      ['first_name', 'Imię', T], ['last_name', 'Nazwisko', T], ['email', 'E-mail', T], ['contact_allowed', 'Zgoda na kontakt', T]],
    sql: `SELECT id, ${OWN_HOUSEHOLD('household_id')} AS household_id, first_name, last_name, email, contact_allowed
            FROM guardians WHERE id = ANY($G) ORDER BY id COLLATE "C"`,
  },
  {
    key: 'student_guardians', label: 'Powiązania uczeń–opiekun',
    columns: [['student_id', 'Uczeń', T], ['guardian_id', 'Opiekun', T], ['contact_allowed', 'Zgoda na kontakt', T],
      ['is_primary_contact', 'Kontakt główny', T], ['starts_on', 'Od', T], ['ends_on', 'Do', T]],
    // Wyłącznie pary, w których OBIE osoby są w zakresie — relacja z opiekunem spoza zakresu jest pominięta.
    sql: `SELECT student_id, guardian_id, contact_allowed, is_primary_contact,
                 ${DATE('starts_on')} AS starts_on, ${DATE('ends_on')} AS ends_on
            FROM student_guardians WHERE student_id = ANY($S) AND guardian_id = ANY($G)
           ORDER BY student_id COLLATE "C", guardian_id COLLATE "C"`,
  },
  {
    key: 'student_guardian_changes', label: 'Historia powiązań uczeń–opiekun',
    columns: [['id', 'Identyfikator', T], ['student_id', 'Uczeń', T], ['guardian_id', 'Opiekun', T],
      ['new_contact_allowed', 'Zgoda na kontakt (po zmianie)', T], ['new_is_primary_contact', 'Kontakt główny (po zmianie)', T],
      ['new_starts_on', 'Od (po zmianie)', T], ['new_ends_on', 'Do (po zmianie)', T], ['source', 'Źródło', T], ['changed_at', 'Kiedy', T]],
    sql: `SELECT id, student_id, guardian_id, new_contact_allowed, new_is_primary_contact,
                 ${DATE('new_starts_on')} AS new_starts_on, ${DATE('new_ends_on')} AS new_ends_on, source,
                 ${TS('changed_at')} AS changed_at
            FROM student_guardian_changes WHERE student_id = ANY($S) AND guardian_id = ANY($G)
           ORDER BY changed_at, id COLLATE "C"`,
  },
  {
    key: 'student_households', label: 'Członkostwo uczniów w gospodarstwach',
    columns: [['id', 'Identyfikator', T], ['student_id', 'Uczeń', T], ['household_id', 'Gospodarstwo', T],
      ['is_primary', 'Główne', T], ['starts_on', 'Od', T], ['ends_on', 'Do', T]],
    sql: `SELECT id, student_id, household_id, is_primary, ${DATE('starts_on')} AS starts_on, ${DATE('ends_on')} AS ends_on
            FROM student_households WHERE student_id = ANY($S) AND household_id = ANY($H)
           ORDER BY id COLLATE "C"`,
  },
  {
    key: 'guardian_households', label: 'Członkostwo opiekunów w gospodarstwach',
    columns: [['id', 'Identyfikator', T], ['guardian_id', 'Opiekun', T], ['household_id', 'Gospodarstwo', T],
      ['starts_on', 'Od', T], ['ends_on', 'Do', T]],
    sql: `SELECT id, guardian_id, household_id, ${DATE('starts_on')} AS starts_on, ${DATE('ends_on')} AS ends_on
            FROM guardian_households WHERE guardian_id = ANY($G) AND household_id = ANY($H)
           ORDER BY id COLLATE "C"`,
  },
  {
    key: 'enrollments', label: 'Przypisania do klas',
    columns: [['id', 'Identyfikator', T], ['student_id', 'Uczeń', T], ['school_year_id', 'Rok szkolny', T],
      ['class_id', 'Klasa', T], ['ended_on', 'Zakończono', T]],
    sql: `SELECT id, student_id, school_year_id, class_id, ${DATE('ended_on')} AS ended_on
            FROM enrollments WHERE student_id = ANY($S) ORDER BY school_year_id COLLATE "C", id COLLATE "C"`,
  },
  {
    key: 'enrollment_history', label: 'Historia przypisań do klas',
    columns: [['id', 'Identyfikator', T], ['student_id', 'Uczeń', T], ['school_year_id', 'Rok szkolny', T],
      ['kind', 'Rodzaj', T], ['from_class_id', 'Z klasy', T], ['to_class_id', 'Do klasy', T],
      ['effective_on', 'Od dnia', T], ['changed_at', 'Kiedy', T]],
    sql: `SELECT id, student_id, school_year_id, kind, from_class_id, to_class_id,
                 ${DATE('effective_on')} AS effective_on, ${TS('changed_at')} AS changed_at
            FROM enrollment_history WHERE student_id = ANY($S) ORDER BY changed_at, id COLLATE "C"`,
  },
  {
    key: 'guardian_contact_changes', label: 'Historia zgody na kontakt',
    columns: [['id', 'Identyfikator', T], ['guardian_id', 'Opiekun', T], ['previous_contact_allowed', 'Zgoda (przed)', T],
      ['new_contact_allowed', 'Zgoda (po)', T], ['source', 'Źródło', T], ['changed_at', 'Kiedy', T]],
    sql: `SELECT id, guardian_id, previous_contact_allowed, new_contact_allowed, source, ${TS('changed_at')} AS changed_at
            FROM guardian_contact_changes WHERE guardian_id = ANY($G) ORDER BY changed_at, id COLLATE "C"`,
  },
  {
    // #100 (art. 16): historia sprostowań imienia i nazwiska osób z zakresu — poprzednie i nowe wartości
    // należą do wnioskodawcy (opiekun) albo jego dziecka; bez powodu (wolny tekst, jak pozostałe powody).
    key: 'identity_changes', label: 'Historia sprostowań imienia i nazwiska',
    columns: [['id', 'Identyfikator', T], ['subject_type', 'Podmiot', T], ['student_id', 'Uczeń', T], ['guardian_id', 'Opiekun', T],
      ['previous_first_name', 'Imię (przed)', T], ['previous_last_name', 'Nazwisko (przed)', T],
      ['new_first_name', 'Imię (po)', T], ['new_last_name', 'Nazwisko (po)', T], ['source', 'Źródło', T], ['changed_at', 'Kiedy', T]],
    sql: `SELECT id, subject_type, student_id, guardian_id, previous_first_name, previous_last_name,
                 new_first_name, new_last_name, source, ${TS('changed_at')} AS changed_at
            FROM identity_changes WHERE student_id = ANY($S) OR guardian_id = ANY($G)
           ORDER BY changed_at, id COLLATE "C"`,
  },
  {
    key: 'guardian_update_requests', label: 'Prośby o aktualizację danych',
    columns: [['id', 'Identyfikator', T], ['guardian_id', 'Opiekun', T], ['status', 'Stan', T],
      ['created_at', 'Złożono', T], ['decided_at', 'Rozstrzygnięto', T]],
    sql: `SELECT id, guardian_id, status, ${TS('created_at')} AS created_at, ${TS('decided_at')} AS decided_at
            FROM guardian_update_requests WHERE guardian_id = ANY($G) ORDER BY created_at, id COLLATE "C"`,
  },
  {
    key: 'payment_entries', label: 'Wpłaty',
    columns: [['id', 'Identyfikator wpłaty', T], ['household_id', 'Gospodarstwo', T], ['school_year_id', 'Rok szkolny', T],
      ['amount_cents', 'Kwota (EUR)', A], ['received_on', 'Data wpływu', T], ['method', 'Sposób', T], ['status', 'Stan', T]],
    // Bez `reference` (tytuł przelewu — wolny tekst, może zawierać dane innej osoby).
    sql: `SELECT id, household_id, school_year_id, amount_cents, ${DATE('received_on')} AS received_on, method, status
            FROM payment_entries WHERE household_id = ANY($P)
           ORDER BY school_year_id COLLATE "C", received_on, id COLLATE "C"`,
  },
  {
    key: 'payment_corrections', label: 'Korekty wpłat', from: 'payment_entries',
    columns: [['id', 'Identyfikator', T], ['payment_entry_id', 'Wpłata', T], ['amount_cents', 'Kwota korekty (EUR)', A],
      ['created_at', 'Kiedy', T]],
    sql: `SELECT id, payment_entry_id, amount_cents, ${TS('created_at')} AS created_at
            FROM payment_corrections WHERE payment_entry_id = ANY($F) ORDER BY created_at, id COLLATE "C"`,
  },
  {
    key: 'payment_refunds', label: 'Zwroty wpłat', from: 'payment_entries',
    columns: [['id', 'Identyfikator', T], ['payment_entry_id', 'Wpłata', T], ['amount_cents', 'Kwota zwrotu (EUR)', A],
      ['refunded_on', 'Data zwrotu', T], ['method', 'Sposób', T]],
    sql: `SELECT id, payment_entry_id, amount_cents, ${DATE('refunded_on')} AS refunded_on, method
            FROM payment_refunds WHERE payment_entry_id = ANY($F) ORDER BY refunded_on, id COLLATE "C"`,
  },
  {
    key: 'payment_assignments', label: 'Przypisania wpłat do gospodarstwa',
    columns: [['id', 'Identyfikator', T], ['payment_entry_id', 'Wpłata', T], ['household_id', 'Gospodarstwo', T],
      ['created_at', 'Kiedy', T]],
    sql: `SELECT id, payment_entry_id, household_id, ${TS('created_at')} AS created_at
            FROM payment_assignments WHERE household_id = ANY($P) ORDER BY created_at, id COLLATE "C"`,
  },
  {
    key: 'payment_reassignments', label: 'Przeniesienia wpłat między gospodarstwami',
    columns: [['id', 'Identyfikator', T], ['payment_entry_id', 'Wpłata', T], ['old_household_id', 'Z gospodarstwa', T],
      ['new_household_id', 'Do gospodarstwa', T], ['created_at', 'Kiedy', T]],
    // Druga strona przeniesienia (inna rodzina) jako null.
    sql: `SELECT id, payment_entry_id,
                 CASE WHEN old_household_id = ANY($P) THEN old_household_id END AS old_household_id,
                 CASE WHEN new_household_id = ANY($P) THEN new_household_id END AS new_household_id,
                 ${TS('created_at')} AS created_at
            FROM payment_reassignments WHERE old_household_id = ANY($P) OR new_household_id = ANY($P)
           ORDER BY created_at, id COLLATE "C"`,
  },
  {
    key: 'payment_allocations', label: 'Części podzielonych wpłat',
    columns: [['id', 'Identyfikator', T], ['payment_entry_id', 'Wpłata', T], ['school_year_id', 'Rok szkolny', T],
      ['household_id', 'Gospodarstwo', T], ['amount_cents', 'Kwota części (EUR)', A], ['created_at', 'Kiedy', T]],
    sql: `SELECT id, payment_entry_id, school_year_id, household_id, amount_cents, ${TS('created_at')} AS created_at
            FROM payment_allocations WHERE household_id = ANY($P) ORDER BY created_at, id COLLATE "C"`,
  },
  {
    key: 'payment_allocation_reversals', label: 'Cofnięcia części wpłat', from: 'payment_allocations',
    columns: [['id', 'Identyfikator', T], ['allocation_id', 'Część wpłaty', T], ['school_year_id', 'Rok szkolny', T],
      ['created_at', 'Kiedy', T]],
    sql: `SELECT id, allocation_id, school_year_id, ${TS('created_at')} AS created_at
            FROM payment_allocation_reversals WHERE allocation_id = ANY($F) ORDER BY created_at, id COLLATE "C"`,
  },
  {
    key: 'campaign_recipients', label: 'Adresaci kampanii e-mail',
    columns: [['id', 'Identyfikator', T], ['campaign_id', 'Kampania', T], ['household_id', 'Gospodarstwo', T],
      ['guardian_id', 'Opiekun', T], ['email', 'Adres', T], ['created_at', 'Kiedy', T]],
    // Tylko adresy opiekunów z zakresu — adresat spoza zakresu przy tym samym gospodarstwie jest pominięty.
    sql: `SELECT id, campaign_id, household_id, guardian_id, email, ${TS('created_at')} AS created_at
            FROM email_campaign_recipients WHERE household_id = ANY($P) AND guardian_id = ANY($G)
           ORDER BY created_at, id COLLATE "C"`,
  },
  {
    key: 'campaign_outbox', label: 'Wysyłki kampanii e-mail', from: 'campaign_recipients',
    columns: [['id', 'Identyfikator', T], ['campaign_id', 'Kampania', T], ['recipient_id', 'Adresat', T],
      ['state', 'Stan', T], ['attempts', 'Próby', T], ['sent_at', 'Wysłano', T]],
    // Bez last_error i provider_message_id (dane techniczne dostawcy).
    sql: `SELECT id, campaign_id, recipient_id, state, attempts, ${TS('sent_at')} AS sent_at
            FROM email_outbox WHERE recipient_id = ANY($F) ORDER BY created_at, id COLLATE "C"`,
  },
  {
    key: 'campaign_exclusions', label: 'Wykluczenia z kampanii e-mail',
    columns: [['campaign_id', 'Kampania', T], ['household_id', 'Gospodarstwo', T], ['reason', 'Powód (kod)', T]],
    sql: `SELECT campaign_id, household_id, reason FROM email_campaign_exclusions WHERE household_id = ANY($P)
           ORDER BY campaign_id COLLATE "C", household_id COLLATE "C"`,
  },
  {
    key: 'privacy_notice_deliveries', label: 'Przekazanie informacji o przetwarzaniu danych',
    columns: [['id', 'Identyfikator', T], ['household_id', 'Gospodarstwo', T], ['notice_id', 'Wersja informacji', T],
      ['channel', 'Kanał', T], ['recorded_at', 'Kiedy', T]],
    sql: `SELECT id, household_id, notice_id, channel, ${TS('recorded_at')} AS recorded_at
            FROM privacy_notice_deliveries WHERE household_id = ANY($P) ORDER BY recorded_at, id COLLATE "C"`,
  },
  {
    key: 'meeting_attendees', label: 'Obecność na zebraniach',
    columns: [['id', 'Identyfikator', T], ['meeting_id', 'Zebranie', T], ['guardian_id', 'Opiekun', T],
      ['capacity', 'W charakterze', T], ['voting_eligible', 'Z prawem głosu', T], ['present', 'Obecny', T]],
    sql: `SELECT id, meeting_id, guardian_id, capacity, voting_eligible, present
            FROM meeting_attendees WHERE guardian_id = ANY($G) ORDER BY meeting_id COLLATE "C", id COLLATE "C"`,
  },
  {
    key: 'event_task_signups', label: 'Zgłoszenia do zadań wydarzeń',
    columns: [['id', 'Identyfikator', T], ['task_id', 'Zadanie', T], ['guardian_id', 'Opiekun', T],
      ['status', 'Stan', T], ['created_at', 'Kiedy', T]],
    sql: `SELECT id, task_id, guardian_id, status, ${TS('created_at')} AS created_at
            FROM event_task_signups WHERE guardian_id = ANY($G) ORDER BY created_at, id COLLATE "C"`,
  },
]);

// Słowniki (etykiety) dla identyfikatorów z paczki: rok, klasa, kampania, zebranie.
const LOOKUPS = Object.freeze([
  {
    key: 'school_years', label: 'Lata szkolne',
    columns: [['id', 'Rok szkolny', T], ['label', 'Nazwa', T]],
    ids: (tables) => [...tables.enrollments.map((r) => r.school_year_id), ...tables.enrollment_history.map((r) => r.school_year_id),
      ...tables.payment_entries.map((r) => r.school_year_id), ...tables.payment_allocations.map((r) => r.school_year_id)],
    sql: 'SELECT id, label FROM school_years WHERE id = ANY($1::text[]) ORDER BY starts_on, id COLLATE "C"',
  },
  {
    key: 'classes', label: 'Klasy',
    columns: [['id', 'Klasa', T], ['school_year_id', 'Rok szkolny', T], ['name', 'Nazwa', T]],
    ids: (tables) => [...tables.enrollments.map((r) => r.class_id), ...tables.enrollment_history.flatMap((r) => [r.from_class_id, r.to_class_id])],
    sql: 'SELECT id, school_year_id, name FROM classes WHERE id = ANY($1::text[]) ORDER BY school_year_id COLLATE "C", id COLLATE "C"',
  },
  {
    key: 'campaigns', label: 'Kampanie e-mail',
    columns: [['id', 'Kampania', T], ['school_year_id', 'Rok szkolny', T], ['subject', 'Temat wiadomości', T]],
    ids: (tables) => [...tables.campaign_recipients.map((r) => r.campaign_id), ...tables.campaign_exclusions.map((r) => r.campaign_id)],
    sql: 'SELECT id, school_year_id, subject FROM email_campaigns WHERE id = ANY($1::text[]) ORDER BY id COLLATE "C"',
  },
  {
    key: 'meetings', label: 'Zebrania',
    columns: [['id', 'Zebranie', T], ['school_year_id', 'Rok szkolny', T], ['title', 'Tytuł', T], ['scheduled_at', 'Termin', T]],
    ids: (tables) => tables.meeting_attendees.map((r) => r.meeting_id),
    sql: `SELECT id, school_year_id, title, ${TS('scheduled_at')} AS scheduled_at FROM meetings WHERE id = ANY($1::text[])
           ORDER BY scheduled_at, id COLLATE "C"`,
  },
]);

// Zdarzenia dziennika dotyczące obiektów z paczki — tylko rodzaj, obiekt i czas
// (bez aktora i metadanych). Typ obiektu -> tabela paczki.
const AUDIT_ENTITY_TABLES = Object.freeze({
  household: 'households',
  student: 'students',
  guardian: 'guardians',
  enrollment: 'enrollments',
  student_household: 'student_households',
  guardian_update_request: 'guardian_update_requests',
  payment_entry: 'payment_entries',
  payment_correction: 'payment_corrections',
  payment_refund: 'payment_refunds',
  payment_assignment: 'payment_assignments',
  payment_reassignment: 'payment_reassignments',
  payment_allocation: 'payment_allocations',
});
const AUDIT_COLUMNS = [['id', 'Identyfikator', T], ['action', 'Zdarzenie', T], ['entity_type', 'Rodzaj obiektu', T],
  ['entity_id', 'Obiekt', T], ['occurred_at', 'Kiedy', T]];
const TOTALS_COLUMNS = [['household_id', 'Gospodarstwo', T], ['school_year_id', 'Rok szkolny', T],
  ['net_amount_cents', 'Suma netto (EUR)', A], ['payment_count', 'Liczba wpłat', T]];

function bindNamed(sql, named) {
  const params = [];
  const index = new Map();
  const text = sql.replace(/\$([HSGPF])\b/g, (_, name) => {
    if (!index.has(name)) { params.push(named[name]); index.set(name, params.length); }
    return `$${index.get(name)}::text[]`;
  });
  return { text, params };
}

function uniqueSorted(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value))].sort();
}

function toSafeInt(value) {
  const number = Number(String(value));
  if (!Number.isSafeInteger(number)) throw new FamilyExportError('unsafe_integer', 500);
  return number;
}

function normalizeRow(columns, row) {
  const out = {};
  for (const [key, , type] of columns) {
    const value = row[key];
    if (value === null || value === undefined) out[key] = null;
    else if (type === A || key === 'attempts' || key === 'payment_count') out[key] = toSafeInt(value);
    else if (typeof value === 'boolean') out[key] = value;
    else out[key] = String(value);
  }
  return out;
}

async function ids(executor, sql, params) {
  const { rows } = await executor.query(sql, params);
  return rows.map((row) => row.id);
}

// Zakres żądania. `request` = wiersz data_subject_requests (snake_case).
// Pierwszeństwo: gospodarstwo > opiekun > uczeń; pozostałe wskazane w żądaniu
// obiekty muszą należeć do tego zakresu (inaczej 409 — obsługujący poprawia
// rejestr zamiast dostać sumę dwóch rodzin).
export async function resolveFamilyScope(executor, request) {
  let subjectType;
  let households;
  let students;
  let guardians;
  let paymentHouseholds;
  if (request.household_id) {
    subjectType = 'household';
    const h = request.household_id;
    households = [h];
    students = await ids(executor,
      `SELECT id FROM students WHERE household_id = $1
       UNION SELECT student_id FROM student_households WHERE household_id = $1`, [h]);
    guardians = await ids(executor,
      `SELECT id FROM guardians WHERE household_id = $1
       UNION SELECT guardian_id FROM guardian_households WHERE household_id = $1`, [h]);
    paymentHouseholds = households;
  } else if (request.guardian_id) {
    subjectType = 'guardian';
    const g = request.guardian_id;
    guardians = [g];
    households = await ids(executor,
      `SELECT household_id AS id FROM guardians WHERE id = $1 AND household_id IS NOT NULL
       UNION SELECT household_id FROM guardian_households WHERE guardian_id = $1`, [g]);
    students = await ids(executor, 'SELECT DISTINCT student_id AS id FROM student_guardians WHERE guardian_id = $1', [g]);
    // Założenie do D-07: wpłaty i kampanie gospodarstw, do których opiekun należy.
    paymentHouseholds = households;
  } else if (request.student_id) {
    subjectType = 'student';
    const s = request.student_id;
    students = [s];
    guardians = [];
    households = await ids(executor,
      `SELECT household_id AS id FROM students WHERE id = $1 AND household_id IS NOT NULL
       UNION SELECT household_id FROM student_households WHERE student_id = $1`, [s]);
    paymentHouseholds = [];
  } else {
    throw new FamilyExportError('subject_required', 400);
  }
  households = uniqueSorted(households);
  students = uniqueSorted(students);
  guardians = uniqueSorted(guardians);
  paymentHouseholds = uniqueSorted(paymentHouseholds);
  // Dodatkowe identyfikatory żądania muszą mieścić się w zakresie.
  if ((request.guardian_id && !guardians.includes(request.guardian_id))
      || (request.student_id && !students.includes(request.student_id))) {
    throw new FamilyExportError('data_request_subject_mismatch', 409);
  }
  // Osoby trzecie: tylko liczby dla obsługującego (bez identyfikatorów).
  const { rows: [omitted] } = await executor.query(
    `SELECT
       (SELECT count(DISTINCT guardian_id) FROM student_guardians
         WHERE student_id = ANY($2::text[]) AND NOT (guardian_id = ANY($3::text[])))::int AS guardians,
       (SELECT count(DISTINCT household_id) FROM student_households
         WHERE student_id = ANY($2::text[]) AND NOT (household_id = ANY($1::text[])))::int AS households`,
    [households, students, guardians],
  );
  return {
    subjectType,
    subjectId: request.household_id ?? request.guardian_id ?? request.student_id,
    households, students, guardians, paymentHouseholds,
    omitted: { guardians: Number(omitted.guardians), households: Number(omitted.households) },
  };
}

// Paczka jednej rodziny (deterministyczna: te same dane -> ten sam SHA-256).
// Nie zawiera czasu wygenerowania ani identyfikatora przebiegu.
export async function buildFamilyExport(executor, request) {
  const scope = await resolveFamilyScope(executor, request);
  const named = { H: scope.households, S: scope.students, G: scope.guardians, P: scope.paymentHouseholds };
  const tables = {};
  for (const spec of FAMILY_TABLES) {
    const { text, params } = bindNamed(spec.sql, {
      ...named, F: spec.from ? uniqueSorted(tables[spec.from].map((row) => row.id)) : [],
    });
    const { rows } = await executor.query(text, params);
    tables[spec.key] = rows.map((row) => normalizeRow(spec.columns, row));
  }
  const lookups = {};
  for (const spec of LOOKUPS) {
    const { rows } = await executor.query(spec.sql, [uniqueSorted(spec.ids(tables))]);
    lookups[spec.key] = rows.map((row) => normalizeRow(spec.columns, row));
  }
  // Sumy wpłat per gospodarstwo i rok — z widoku household_payment_totals (to
  // samo źródło co karta gospodarstwa i przegląd zarządu).
  const { rows: totalsRows } = await executor.query(
    `SELECT household_id, school_year_id, net_amount_cents::text AS net_amount_cents, payment_count::text AS payment_count
       FROM household_payment_totals WHERE household_id = ANY($1::text[])
      ORDER BY household_id COLLATE "C", school_year_id COLLATE "C"`,
    [scope.paymentHouseholds],
  );
  const paymentTotals = totalsRows.map((row) => normalizeRow(TOTALS_COLUMNS, row));

  const entityTypes = [];
  const entityIds = [];
  for (const [type, table] of Object.entries(AUDIT_ENTITY_TABLES)) {
    for (const row of tables[table]) { entityTypes.push(type); entityIds.push(row.id); }
  }
  const { rows: auditRows } = await executor.query(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, ${TS('a.occurred_at')} AS occurred_at
       FROM audit_events a
       JOIN unnest($1::text[], $2::text[]) AS o(entity_type, entity_id)
         ON o.entity_type = a.entity_type AND o.entity_id = a.entity_id
      ORDER BY a.occurred_at, a.id COLLATE "C"`,
    [entityTypes, entityIds],
  );
  const auditEvents = auditRows.map((row) => normalizeRow(AUDIT_COLUMNS, row));

  const rowCounts = {};
  for (const spec of FAMILY_TABLES) rowCounts[spec.key] = tables[spec.key].length;
  rowCounts.payment_totals = paymentTotals.length;
  rowCounts.audit_events = auditEvents.length;

  const bundle = {
    format: FAMILY_EXPORT_FORMAT,
    formatVersion: FAMILY_EXPORT_FORMAT_VERSION,
    request: { id: request.id, kind: request.kind, receivedOn: String(request.received_on) },
    subject: { type: scope.subjectType, id: scope.subjectId },
    tables,
    lookups,
    paymentTotals,
    auditEvents,
    rowCounts,
  };
  const sha256 = sha256Hex(canonicalJson(bundle));
  return { bundle, sha256, body: canonicalJson({ ...bundle, sha256 }), rowCounts, scope };
}

const FAMILY_FOOTER = 'Zawiera dane osobowe — przekazać wyłącznie wnioskodawcy po weryfikacji tożsamości, nie przesyłać dalej.';

// CSV do wydruku: sekcja na tabelę (etykieta, nagłówek po polsku, wiersze),
// ten sam model co JSON. Komórki przez src/pg/csv.js (neutralizacja formuł,
// kwoty EUR z centów).
export function buildFamilyExportCsv(bundle) {
  const title = [{ header: '', type: T }];
  const lines = [
    csvRow(title, [`Dane rodziny — żądanie ${bundle.request.id} (${bundle.request.kind}) z dnia ${bundle.request.receivedOn}`]),
    csvRow(title, [`Zakres: ${bundle.subject.type} ${bundle.subject.id}`]),
    '',
  ];
  const section = (label, columns, rows) => {
    const defs = columns.map(([, header, type]) => ({ header, type }));
    lines.push(csvRow(title, [`${label} (${rows.length})`]));
    lines.push(csvHeader(defs));
    for (const row of rows) {
      lines.push(csvRow(defs, columns.map(([key, , type]) => {
        const value = row[key];
        if (type === A) return value;
        if (typeof value === 'boolean') return value ? 'tak' : 'nie';
        return value;
      })));
    }
    lines.push('');
  };
  for (const spec of FAMILY_TABLES) section(spec.label, spec.columns, bundle.tables[spec.key]);
  section('Sumy wpłat według roku', TOTALS_COLUMNS, bundle.paymentTotals);
  for (const spec of LOOKUPS) section(spec.label, spec.columns, bundle.lookups[spec.key]);
  section('Dziennik zdarzeń (bez aktora i szczegółów)', AUDIT_COLUMNS, bundle.auditEvents);
  lines.push(csvRow(title, [`SHA-256 paczki JSON: ${sha256Hex(canonicalJson(bundle))}`]));
  lines.push(csvRow(title, [FAMILY_FOOTER]));
  return `${lines.join('\r\n')}\r\n`;
}

export const FAMILY_EXPORT_TABLE_KEYS = Object.freeze(FAMILY_TABLES.map((spec) => spec.key));
