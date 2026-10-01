// #152: wspólna bramka po stronie serwera dla pól wolnego tekstu w tabelach
// niezmiennych (wpisu nie da się potem poprawić ani usunąć; trafia do eksportu
// rocznego i kopii zapasowych). Opiera się na src/pg/pii-check.js — wzorce,
// bez nazw własnych (nazwisk nie da się wiarygodnie wykryć; wyjątek: miejsca,
// które już przekazują listę znanych imion i nazwisk z roku szkolnego).
//
// Wariant zachowawczy (do decyzji zarządu/IOD, patrz docs/PII_CHECK.md):
//   * wzorce JEDNOZNACZNE — e-mail, IBAN (BE/PL, mod-97), numer rejestru
//     krajowego BE (suma kontrolna) — są ODRZUCANE zawsze (422
//     `personal_data_forbidden`), bez flagi obejścia. Wpisu nie da się potem
//     usunąć, a tekst nigdy nie musi zawierać tych danych (do powiązania
//     z rodziną służy identyfikator, nie adres ani rachunek).
//   * wzorce DWUZNACZNE — telefon, znane imię i nazwisko — wymagają
//     potwierdzenia (422 `possible_personal_data`, ponowienie z
//     `confirmPersonalData: true`); możliwy fałszywy alarm.
// Odpowiedź, audyt i logi zawierają wyłącznie kategorie — nigdy fragment tekstu.

import { detectPossiblePersonalData } from './pii-check.js';

// Kategorie odrzucane bez możliwości potwierdzenia.
export const FORBIDDEN_CATEGORIES = Object.freeze(['email', 'iban', 'national_id']);

// Pola wolnego tekstu z tabel niezmiennych, do których podpięto bramkę.
// Klucz `tabela.kolumna` musi występować literalnie w wywołaniu bramki w
// kodzie serwera (test tests/pii-gate-coverage.test.js sprawdza to na podstawie
// privacy/data-inventory.json).
export const GATED_FIELDS = Object.freeze([
  'payment_corrections.reason',
  'payment_allocation_reversals.reason',
  'payment_refunds.reason',
  'payment_reassignments.reason',
  'payment_entries.reference',
  'payment_reference_revocations.reason',
  'ledger_entries.description',
  'ledger_corrections.reason',
  'ledger_opening_balance_adjustments.reason',
  'ledger_opening_balances.note',
  'ledger_budget_lines.note',
  'ledger_transfers.description',
  'ledger_entry_reviews.note',
  'ledger_budget_adoptions.note',
  'ledger_category_deactivations.reason',
  'ledger_allocation_versions.reason',
  'resolution_spending_authorizations.note',
  'resolution_execution_events.note',
  'bank_reconciliations.notes',
  'bank_reconciliations.abandon_reason',
  'bank_reconciliations.confirmation_note',
  'bank_reconciliation_matches.revoke_reason',
  'bank_reconciliation_group_match_revocations.reason',
  'document_status_events.reason',
  'document_descriptions.title',
  'document_descriptions.description',
  'event_tasks.title',
  'event_tasks.cancellation_reason',
  'meeting_agenda_items.description',
  'meetings.cancellation_reason',
  'meeting_reschedules.reason',
  'meeting_minutes.body',
  'meeting_minutes.change_note',
  'meeting_minutes.approval_note',
  'meeting_minutes_publications.reason',
  'resolutions.body',
  'resolutions.correction_reason',
  'news_photos.alt_text',
  'news_photos.author',
  'news_photos.source_detail',
  'news_photos.license_text',
  'news_photos.rights_note',
  'news_photos.revocation_reason',
  'school_year_closure_checklist.note',
  'enrollments.ended_reason',
  'student_households.created_reason',
  'student_households.ended_reason',
  'guardian_households.ended_reason',
  'financial_report_snapshots.supersede_reason',
  'audit_review_notes.body',
  'enrollment_history.reason',
  'student_guardian_changes.reason',
  'guardian_contact_changes.reason',
  'identity_changes.reason',
  'guardian_update_requests.note',
  'email_suppression_releases.confirmation_note',
  'role_grant_requests.reject_reason',
]);

// Pola wolnego tekstu z tabel niezmiennych świadomie BEZ bramki — z uzasadnieniem.
export const EXEMPT_FIELDS = Object.freeze({
  'email_campaigns.subject': 'treść wiadomości do rodziców, zatwierdzana jawnie razem z listą odbiorców; adres kontaktowy Rady jest zamierzony',
  'email_campaigns.body_text': 'treść wiadomości do rodziców, zatwierdzana jawnie razem z listą odbiorców; adres kontaktowy Rady jest zamierzony',
  'privacy_notices.body_text': 'tekst klauzuli informacyjnej, nie zawiera danych osobowych (personal: none)',
  'meeting_agenda_versions.snapshot': 'migawka JSON kopiuje tytuły i opisy punktów porządku; opis przechodzi bramkę przy zapisie punktu (meeting_agenda_items.description), a migawka niczego nie dodaje',
  'payment_references.revoke_reason': 'kopiowane z payment_reference_revocations.reason, które przechodzi przez bramkę',
});

/** Domyślny błąd bramki — dla modułów bez własnej klasy błędu z polem dodatkowym. */
export class PersonalDataError extends Error {
  constructor(code, categories) {
    super(code);
    this.code = code;
    this.status = 422;
    this.categories = categories;
  }
}

// Kody błędów 422 (docs/API_ERRORS.md, shared/messages.js).
const REJECTION = Object.freeze({
  forbidden: { code: 'personal_data_forbidden' },
  confirm: { code: 'possible_personal_data' },
});

function classify(categories) {
  return {
    forbidden: categories.filter((category) => FORBIDDEN_CATEGORIES.includes(category)),
    confirmable: categories.filter((category) => !FORBIDDEN_CATEGORIES.includes(category)),
  };
}

/**
 * Sprawdza jedno lub kilka pól wolnego tekstu przed zapisem.
 *
 * @param {Array<[string, unknown]>} fields pary [`tabela.kolumna`, wartość]
 * @param {object} options
 * @param {boolean} [options.confirm] potwierdzenie (`confirmPersonalData`) dla kategorii dwuznacznych
 * @param {Array<{firstName: string, lastName: string}>} [options.knownNames]
 * @param {(code: string, categories: string[]) => Error} options.fail fabryka błędu modułu (422); domyślnie PersonalDataError
 * @returns {{piiConfirmed: boolean, piiCategories: string[]}} metadane do audytu (bez treści)
 */
export function gateFreeText(fields, { confirm = false, knownNames = [], fail = (code, categories) => new PersonalDataError(code, categories) }) {
  const forbidden = new Set();
  const confirmable = new Set();
  for (const [key, value] of fields) {
    if (!GATED_FIELDS.includes(key)) throw new Error(`pii_gate_unknown_field:${key}`);
    if (value === null || value === undefined || value === '') continue;
    const parts = classify(detectPossiblePersonalData(/** @type {string} */ (value), { knownNames }).categories);
    parts.forbidden.forEach((category) => forbidden.add(category));
    parts.confirmable.forEach((category) => confirmable.add(category));
  }
  if (forbidden.size) throw fail(REJECTION.forbidden.code, [...forbidden, ...confirmable]);
  if (confirmable.size && confirm !== true) throw fail(REJECTION.confirm.code, [...confirmable]);
  return { piiConfirmed: confirmable.size > 0, piiCategories: [...confirmable] };
}

/** Fragment metadanych audytu (pusty, gdy nie było potwierdzenia). */
export function piiAuditMetadata(gate) {
  return gate?.piiConfirmed ? { piiConfirmed: true, piiCategories: gate.piiCategories } : {};
}

/** Znani uczniowie i opiekunowie zapisani w danym roku szkolnym (imię, nazwisko). */
export async function loadKnownNames(executor, schoolYearId) {
  const { rows } = await executor.query(
    `SELECT first_name, last_name FROM students
      WHERE id IN (SELECT student_id FROM enrollments WHERE school_year_id = $1)
     UNION
     SELECT g.first_name, g.last_name FROM guardians g
      WHERE g.household_id IN (
        SELECT household_id FROM students
         WHERE id IN (SELECT student_id FROM enrollments WHERE school_year_id = $1)
      )`,
    [schoolYearId],
  );
  return rows.map((row) => ({ firstName: row.first_name, lastName: row.last_name }));
}
