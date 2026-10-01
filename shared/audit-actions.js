// Słownik zdarzeń dziennika (#181): każda akcja zapisywana w audit_events ma
// polską etykietę i dokładnie jedną domenę. Jedno źródło prawdy dla serwera
// (filtr `domain` w GET /api/admin/audit, kontrola ról per domena) i panelu
// administracji (etykiety w tabeli dziennika). Kompletność pilnuje test
// tests/audit-actions-catalog.test.js — skan src/pg/** i src/email/**: nowa
// akcja bez wpisu tutaj nie przejdzie CI i nie zniknie po cichu z filtra.
//
// Kontrola ról: `readRoles` to role, które mogą czytać daną domenę. Wariant
// zachowawczy do decyzji D-08/D-09 (kto z zarządu, skarbnika, Komisji
// Rewizyjnej i dyrekcji czyta które domeny): każda domena — wyłącznie `admin`
// z MFA. Zmiana po decyzji = edycja `readRoles` (serwer sprawdza ją przy
// każdym odczycie, src/pg/routes/admin.js), nie ukrycie przycisku.

const ADMIN_ONLY = Object.freeze(['admin']);

export const AUDIT_DOMAINS = Object.freeze({
  access: Object.freeze({ label: 'Konta, role i struktura szkoły', readRoles: ADMIN_ONLY }),
  security: Object.freeze({ label: 'Logowanie i bezpieczeństwo kont', readRoles: ADMIN_ONLY }),
  finance: Object.freeze({ label: 'Finanse: wpłaty, księga, uzgodnienia, sprawozdania', readRoles: ADMIN_ONLY }),
  email: Object.freeze({ label: 'Wiadomości e-mail', readRoles: ADMIN_ONLY }),
  documents: Object.freeze({ label: 'Dokumenty, eksporty i wydruki', readRoles: ADMIN_ONLY }),
  year_close: Object.freeze({ label: 'Zamknięcie roku i salda otwarcia', readRoles: ADMIN_ONLY }),
  families: Object.freeze({ label: 'Dane rodzin i uczniów', readRoles: ADMIN_ONLY }),
  privacy: Object.freeze({ label: 'Ochrona danych i odczyty dziennika', readRoles: ADMIN_ONLY }),
  meetings: Object.freeze({ label: 'Zebrania i uchwały', readRoles: ADMIN_ONLY }),
  events: Object.freeze({ label: 'Wydarzenia', readRoles: ADMIN_ONLY }),
  news: Object.freeze({ label: 'Aktualności i zdjęcia', readRoles: ADMIN_ONLY }),
});

// [domena, etykieta]. Etykieta opisuje czynność, bez danych osobowych.
const CATALOG = {
  // --- access ---
  'role_grant.created': ['access', 'Nadanie roli'],
  'role_grant.revoked': ['access', 'Wycofanie roli'],
  'role_grant.expired': ['access', 'Wygaszenie roli'],
  'role_grant.school_year_backfilled': ['access', 'Uzupełnienie roku szkolnego w przydziale roli'],
  'role_grant.school_year_corrected': ['access', 'Poprawienie roku szkolnego w przydziale roli'],
  'role_grant.four_eyes_waived': ['access', 'Nadanie roli chronionej bez drugiej osoby (brak innego administratora)'],
  'role_grant_request.requested': ['access', 'Wniosek o nadanie roli chronionej'],
  'role_grant_request.approved': ['access', 'Zatwierdzenie nadania roli chronionej'],
  'role_grant_request.rejected': ['access', 'Odrzucenie wniosku o nadanie roli'],
  'role_grant_request.expired': ['access', 'Wygaśnięcie wniosku o nadanie roli'],
  'school_year.grants_expired': ['access', 'Wygaszenie kadencji'],
  'school_year.created': ['access', 'Utworzenie roku szkolnego'],
  'class.created': ['access', 'Utworzenie klasy'],
  'invitation.created': ['access', 'Utworzenie zaproszenia'],
  'invitation.revoked': ['access', 'Wycofanie zaproszenia'],
  'invitation.accepted': ['access', 'Przyjęcie zaproszenia'],
  'invitation.reissued': ['access', 'Ponowne wydanie zaproszenia'],
  'invitation.batch_created': ['access', 'Zaproszenia zbiorcze przedstawicieli'],
  'user.created': ['access', 'Utworzenie konta'],
  'user.disabled': ['access', 'Wyłączenie konta'],
  'user.enabled': ['access', 'Włączenie konta'],
  'session.created': ['access', 'Rozpoczęcie sesji'],
  'session.revoked': ['access', 'Wycofanie sesji'],
  'session.logout': ['access', 'Wylogowanie'],
  'access.denied': ['access', 'Odmowa dostępu do trasy'],

  // --- security ---
  'auth.bootstrap_issued': ['security', 'Wydanie zaproszenia pierwszego administratora'],
  'auth.login_succeeded': ['security', 'Udane logowanie'],
  'auth.login_failed': ['security', 'Nieudane logowanie'],
  'auth.account_under_pressure': ['security', 'Konto pod presją prób logowania'],
  'auth.invitation_preview_failed': ['security', 'Nieudane otwarcie zaproszenia'],
  'auth.invitation_accept_failed': ['security', 'Nieudane przyjęcie zaproszenia'],
  'auth.password_set': ['security', 'Ustawienie hasła'],
  'auth.password_changed': ['security', 'Zmiana hasła'],
  'auth.password_change_failed': ['security', 'Nieudana zmiana hasła'],
  'auth.password_reset_issued': ['security', 'Wydanie kodu resetu hasła'],
  'auth.password_reset_revoked': ['security', 'Unieważnienie kodu resetu hasła'],
  'auth.password_reset_completed': ['security', 'Ustawienie nowego hasła kodem resetu'],
  'auth.password_reset_failed': ['security', 'Nieudane użycie kodu resetu hasła'],
  'mfa.enrollment_started': ['security', 'Rozpoczęcie konfiguracji weryfikacji dwuetapowej'],
  'mfa.enrolled': ['security', 'Włączenie weryfikacji dwuetapowej'],
  'mfa.verified': ['security', 'Potwierdzenie weryfikacji dwuetapowej'],
  'mfa.failed': ['security', 'Nieudana weryfikacja dwuetapowa'],
  'mfa.locked': ['security', 'Blokada weryfikacji dwuetapowej po nieudanych próbach'],
  'mfa.recovery_used': ['security', 'Użycie kodu odzyskiwania'],
  'mfa.reset': ['security', 'Reset weryfikacji dwuetapowej'],
  'mfa.key_rotated': ['security', 'Wymiana klucza szyfrowania weryfikacji dwuetapowej'],
  'account_recovery.requested': ['security', 'Prośba o odzyskanie konta'],
  'account_recovery.approved': ['security', 'Zatwierdzenie odzyskania konta'],
  'account_recovery.rejected': ['security', 'Odrzucenie odzyskania konta'],
  'account_recovery.expired': ['security', 'Wygaśnięcie prośby o odzyskanie konta'],

  // --- finance ---
  'payment.created': ['finance', 'Zapisanie wpłaty'],
  'payment.correction.created': ['finance', 'Korekta wpłaty'],
  'payment.assigned': ['finance', 'Przypisanie wpłaty do rodziny'],
  'payment.reassigned': ['finance', 'Zmiana przypisania wpłaty'],
  'payment.allocation.created': ['finance', 'Podział wpłaty'],
  'payment.allocation.reversed': ['finance', 'Cofnięcie podziału wpłaty'],
  'payment.refund.created': ['finance', 'Zapisanie zwrotu wpłaty'],
  'payment.exported': ['finance', 'Eksport wpłat'],
  'payment_reference.generated': ['finance', 'Wygenerowanie tytułu wpłaty'],
  'payment_reference.revoked': ['finance', 'Wycofanie tytułu wpłaty'],
  'payment_instructions.approved': ['finance', 'Zatwierdzenie danych do wpłat'],
  'ledger.entry.created': ['finance', 'Zapis w księdze'],
  'ledger.entry.replaced': ['finance', 'Zastąpienie zapisu w księdze'],
  'ledger.entry.verified': ['finance', 'Sprawdzenie zapisu w księdze'],
  'ledger.entry.questioned': ['finance', 'Zakwestionowanie zapisu w księdze'],
  'ledger.correction.created': ['finance', 'Korekta zapisu w księdze'],
  'ledger.allocation.created': ['finance', 'Nowa wersja podziału zapisu księgi na wydarzenia i klasy'],
  'ledger.transfer.created': ['finance', 'Przesunięcie środków między kasą a rachunkiem'],
  'ledger.transfer.reversed': ['finance', 'Cofnięcie przesunięcia środków'],
  'ledger.category.created': ['finance', 'Utworzenie kategorii księgi'],
  'ledger.category.deactivated': ['finance', 'Wyłączenie kategorii księgi'],
  'ledger_category.copied': ['finance', 'Skopiowanie kategorii księgi na nowy rok'],
  'ledger_category.deactivated': ['finance', 'Wyłączenie kategorii księgi (rok)'],
  'ledger.budget_line.created': ['finance', 'Dodanie pozycji preliminarza'],
  'ledger.budget_line.revised': ['finance', 'Zmiana pozycji preliminarza'],
  'ledger.budget.adopted': ['finance', 'Przyjęcie preliminarza'],
  'ledger.budget_execution.exported': ['finance', 'Eksport wykonania preliminarza'],
  'ledger.exported': ['finance', 'Eksport księgi'],
  'reconciliation.created': ['finance', 'Rozpoczęcie uzgodnienia wyciągu'],
  'reconciliation.lines.imported': ['finance', 'Wczytanie pozycji wyciągu'],
  'reconciliation.match.confirmed': ['finance', 'Potwierdzenie dopasowania pozycji wyciągu'],
  'reconciliation.match.revoked': ['finance', 'Cofnięcie dopasowania pozycji wyciągu'],
  'reconciliation.group_match.confirmed': ['finance', 'Potwierdzenie dopasowania grupowego'],
  'reconciliation.group_match.revoked': ['finance', 'Cofnięcie dopasowania grupowego'],
  'reconciliation.confirmed': ['finance', 'Potwierdzenie uzgodnienia wyciągu'],
  'reconciliation.abandoned': ['finance', 'Porzucenie uzgodnienia wyciągu'],
  'report.audit.generated': ['finance', 'Raport dla Komisji Rewizyjnej'],
  'report.annual.generated': ['finance', 'Projekt sprawozdania rocznego'],
  'report.cash_flow.generated': ['finance', 'Raport przepływów bank/kasa'],
  'report.snapshot.created': ['finance', 'Utworzenie migawki sprawozdania'],
  'report.snapshot.approved': ['finance', 'Zatwierdzenie migawki sprawozdania'],
  'audit_review.note_added': ['finance', 'Uwaga Komisji Rewizyjnej'],
  'audit_review.answered': ['finance', 'Odpowiedź na uwagę Komisji Rewizyjnej'],
  'audit_review.closed': ['finance', 'Zamknięcie uwagi Komisji Rewizyjnej'],
  'audit_review.conclusion_recorded': ['finance', 'Wniosek końcowy Komisji Rewizyjnej'],
  'board.overview.exported': ['finance', 'Eksport przeglądu zarządu'],

  // --- year_close ---
  'year_close.started': ['year_close', 'Rozpoczęcie zamknięcia roku'],
  'year_close.checklist_confirmed': ['year_close', 'Potwierdzenie punktu listy zamknięcia roku'],
  'year_close.year_end_discrepancy_confirmed': ['year_close', 'Potwierdzenie różnicy salda na koniec roku'],
  'year_close.closed': ['year_close', 'Zamknięcie roku szkolnego'],
  'year_close.archive_read': ['year_close', 'Odczyt archiwum zamkniętego roku'],
  'ledger_opening_balance.created': ['year_close', 'Ustalenie salda otwarcia'],
  'ledger_opening_balance.adjusted': ['year_close', 'Korekta salda otwarcia'],
  'ledger_opening_balance.carried_forward': ['year_close', 'Przeniesienie salda na nowy rok'],

  // --- email ---
  'email.campaign.created': ['email', 'Utworzenie kampanii'],
  'email.campaign.followup_created': ['email', 'Utworzenie kampanii uzupełniającej'],
  'email.campaign.updated': ['email', 'Zmiana kampanii'],
  'email.snapshot.built': ['email', 'Zamrożenie listy odbiorców'],
  'email.recipients.viewed': ['email', 'Odczyt listy odbiorców'],
  'email.preview.sent': ['email', 'Wysłanie wiadomości próbnej'],
  'email.campaign.approved': ['email', 'Zatwierdzenie treści i listy odbiorców'],
  'email.campaign.queued': ['email', 'Umieszczenie kampanii w kolejce'],
  'email.campaign.paused': ['email', 'Wstrzymanie kampanii'],
  'email.campaign.resumed': ['email', 'Wznowienie kampanii'],
  'email.campaign.cancelled': ['email', 'Anulowanie kampanii'],
  'email.campaign.done': ['email', 'Zakończenie kampanii'],
  'email.campaign.integrity_mismatch': ['email', 'Niezgodność treści kampanii z zatwierdzoną'],
  'email.campaign.provider_rejected': ['email', 'Odrzucenie kampanii przez dostawcę'],
  'email.sent': ['email', 'Wysłanie wiadomości'],
  'email.sent_recovered': ['email', 'Potwierdzenie wysłania po przerwie'],
  'email.sent_after_lease_lost': ['email', 'Wysłanie po utracie blokady zadania'],
  'email.retry_scheduled': ['email', 'Zaplanowanie ponownej próby wysyłki'],
  'email.failed': ['email', 'Nieudana wysyłka'],
  'email.skipped': ['email', 'Pominięcie wiadomości (wpłata już zapisana)'],
  'email.suppressed': ['email', 'Wstrzymanie wiadomości (adres lub zgoda)'],
  'email.cancelled': ['email', 'Anulowanie wiadomości'],
  'email.send_deferred': ['email', 'Odroczenie wysyłki'],
  'email.send_aborted': ['email', 'Przerwanie wysyłki'],
  'email.delivery_unknown': ['email', 'Nieznany wynik wysyłki'],
  'email.lease_expired_requeued': ['email', 'Powrót wiadomości do kolejki po wygaśnięciu blokady'],
  'email.requeued': ['email', 'Powrót niewysłanej wiadomości do kolejki'],
  'email.outbox.resolved': ['email', 'Rozstrzygnięcie doręczenia wiadomości'],
  'email.outbox.resolution_approved': ['email', 'Zatwierdzenie przez drugą osobę: wiadomość nie wyszła'],
  'email.address_suppressed': ['email', 'Wstrzymanie adresu po zgłoszeniu dostawcy'],
  'email.preference.opt_out': ['email', 'Rezygnacja z kategorii wiadomości'],
  'email.suppressions.viewed': ['email', 'Odczyt listy wstrzymanych adresów'],
  'email.suppression.release_requested': ['email', 'Prośba o zwolnienie adresu'],
  'email.suppression.released': ['email', 'Zwolnienie adresu z listy wstrzymanych'],
  'email.provider.paused': ['email', 'Wstrzymanie wysyłki — błąd konta u dostawcy'],
  'email.provider.pause_lifted': ['email', 'Zdjęcie wstrzymania wysyłki po naprawie konta'],
  'email.quota.other_recorded': ['email', 'Ewidencja wiadomości wysłanych poza kolejką (limit dzienny)'],
  'email.quota.other_corrected': ['email', 'Korekta ewidencji wiadomości spoza kolejki (limit dzienny)'],
  'email.attention_list.viewed': ['email', 'Odczyt listy nieudanych doręczeń kampanii'],
  'email.report.exported': ['email', 'Pobranie raportu doręczeń kampanii (CSV)'],
  'email.webhook.previous_secret_used': ['email', 'Użycie poprzedniego sekretu powiadomień dostawcy'],

  // --- documents ---
  'document.uploaded': ['documents', 'Dodanie dokumentu'],
  'document.described': ['documents', 'Opisanie dokumentu'],
  'document.viewed': ['documents', 'Podgląd dokumentu'],
  'document.downloaded': ['documents', 'Pobranie dokumentu'],
  'document.superseded': ['documents', 'Zastąpienie dokumentu nowszym'],
  'document.voided': ['documents', 'Unieważnienie dokumentu'],
  'document.access_denied': ['documents', 'Odmowa dostępu do dokumentu'],
  'document.content_missing': ['documents', 'Brak pliku dokumentu w magazynie'],
  'document.preview_blocked': ['documents', 'Zablokowany podgląd dokumentu (bieżąca kontrola struktury)'],
  'export.created': ['documents', 'Utworzenie eksportu rocznego'],
  'export.restored': ['documents', 'Odtworzenie danych z paczki eksportu'],
  'print.cards_requested': ['documents', 'Przygotowanie kartek klasowych'],

  // --- families ---
  'import.committed': ['families', 'Zatwierdzenie importu uczniów'],
  'enrollment.created': ['families', 'Zapis ucznia do klasy'],
  'enrollment.class_changed': ['families', 'Zmiana klasy ucznia'],
  'enrollment.withdrawn': ['families', 'Wypisanie ucznia'],
  'enrollment.promoted': ['families', 'Przeniesienie ucznia do klasy na nowy rok'],
  'promotion.applied': ['families', 'Promocja uczniów na nowy rok'],
  'promotion.representatives_extended': ['families', 'Przedłużenie przydziałów przedstawicieli na nowy rok'],
  'student_household.added': ['families', 'Powiązanie ucznia z gospodarstwem'],
  'student_household.ended': ['families', 'Zakończenie powiązania ucznia z gospodarstwem'],
  'guardian_household.ended': ['families', 'Zakończenie powiązania opiekuna z gospodarstwem'],
  'student_guardian.ended': ['families', 'Zakończenie powiązania ucznia z opiekunem'],
  'student_guardian.contact.updated': ['families', 'Zmiana kontaktu powiązania ucznia z opiekunem'],
  'guardian.contact.updated': ['families', 'Zmiana danych kontaktowych opiekuna'],
  'guardian_update_link.created': ['families', 'Utworzenie linku aktualizacji danych opiekuna'],
  'guardian_update_request.created': ['families', 'Prośba opiekuna o aktualizację danych'],
  'guardian_update_request.approved': ['families', 'Zatwierdzenie aktualizacji danych opiekuna'],
  'guardian_update_request.rejected': ['families', 'Odrzucenie aktualizacji danych opiekuna'],
  'guardian_update_request.list_viewed': ['families', 'Odczyt listy próśb o aktualizację danych opiekunów'],

  // --- privacy ---
  'audit.viewed': ['privacy', 'Odczyt dziennika zdarzeń'],
  'access_log.viewed': ['privacy', 'Odczyt dziennika dostępu do danych'],
  'access_review.viewed': ['privacy', 'Odczyt przeglądu dostępu po kadencji'],
  'data_subject_request.created': ['privacy', 'Rejestracja żądania osoby, której dane dotyczą'],
  'data_subject_request.status_changed': ['privacy', 'Zmiana stanu żądania osoby'],
  'processing_restriction.applied': ['privacy', 'Nałożenie ograniczenia przetwarzania danych (gospodarstwo lub opiekun)'],
  'processing_restriction.lifted': ['privacy', 'Zdjęcie ograniczenia przetwarzania danych (nowy zapis, historia zostaje)'],
  'data_subject_request.exported': ['privacy', 'Eksport danych jednej rodziny dla żądania osoby'],
  'household.anonymization_previewed': ['privacy', 'Podgląd anonimizacji gospodarstwa (bez zmian danych)'],
  'household.anonymized': ['privacy', 'Anonimizacja danych osobowych gospodarstwa z zachowaniem księgi'],
  'privacy_notice.created': ['privacy', 'Utworzenie wersji informacji o prywatności'],
  'privacy_notice.approved': ['privacy', 'Zatwierdzenie informacji o prywatności'],
  'privacy_notice.published': ['privacy', 'Publikacja informacji o prywatności'],

  // --- meetings ---
  'meeting.created': ['meetings', 'Utworzenie zebrania'],
  'meeting.updated': ['meetings', 'Zmiana zebrania'],
  'meeting.rescheduled': ['meetings', 'Zmiana terminu zebrania'],
  'meeting.cancelled': ['meetings', 'Odwołanie zebrania'],
  'meeting.agenda_item.added': ['meetings', 'Dodanie punktu porządku obrad'],
  'meeting.agenda_item.withdrawn': ['meetings', 'Wycofanie punktu porządku obrad'],
  'meeting.agenda.reordered': ['meetings', 'Zmiana kolejności punktów porządku obrad'],
  'meeting.agenda_version.created': ['meetings', 'Nowa wersja porządku obrad'],
  'meeting.notice.created': ['meetings', 'Przygotowanie zawiadomienia o zebraniu'],
  'meeting.notice.approved': ['meetings', 'Zatwierdzenie zawiadomienia o zebraniu'],
  'meeting.notice.campaign_drafted': ['meetings', 'Przygotowanie kampanii z zawiadomieniem'],
  'meeting.attendance.recorded': ['meetings', 'Zapisanie obecności'],
  'meeting.attendance.corrected': ['meetings', 'Korekta obecności'],
  'meeting.quorum.determined': ['meetings', 'Ustalenie kworum'],
  'meeting.minutes.version_created': ['meetings', 'Nowa wersja protokołu'],
  'meeting.minutes.approved': ['meetings', 'Zatwierdzenie protokołu'],
  'meeting.minutes.visibility_set': ['meetings', 'Zmiana udostępnienia protokołu'],
  'resolution.created': ['meetings', 'Zapisanie uchwały'],
  'resolution.updated': ['meetings', 'Zmiana uchwały'],
  'resolution.corrected': ['meetings', 'Korekta uchwały'],
  'resolution.execution.recorded': ['meetings', 'Zapisanie wykonania uchwały'],
  'resolution.spending_authorization.recorded': ['meetings', 'Zapisanie upoważnienia do wydatku'],

  // --- events ---
  'event.created': ['events', 'Utworzenie wydarzenia'],
  'event.revised': ['events', 'Zmiana wydarzenia'],
  'event.submitted': ['events', 'Zgłoszenie wydarzenia do zatwierdzenia'],
  'event.approved': ['events', 'Zatwierdzenie wydarzenia'],
  'event.published': ['events', 'Publikacja wydarzenia'],
  'event.cancelled': ['events', 'Odwołanie wydarzenia'],
  'event.task_created': ['events', 'Dodanie zadania do wydarzenia'],
  'event.task_cancelled': ['events', 'Odwołanie zadania wydarzenia'],
  'event.task_signup_created': ['events', 'Zgłoszenie do zadania wydarzenia'],
  'event.task_signup_withdrawn': ['events', 'Wycofanie zgłoszenia do zadania'],
  'event.task_signups_viewed': ['events', 'Odczyt zgłoszeń opiekunów do zadań wydarzenia'],

  // --- news ---
  'news_post.created': ['news', 'Utworzenie aktualności'],
  'news_post.revised': ['news', 'Zmiana aktualności'],
  'news_post.submitted': ['news', 'Zgłoszenie aktualności do zatwierdzenia'],
  'news_post.approved': ['news', 'Zatwierdzenie aktualności'],
  'news_post.published': ['news', 'Publikacja aktualności'],
  'news_post.withdrawn': ['news', 'Wycofanie aktualności'],
  'news_photo.registered': ['news', 'Rejestracja zdjęcia'],
  'news_photo.file_uploaded': ['news', 'Dodanie pliku zdjęcia'],
  'news_photo.consent_recorded': ['news', 'Zapisanie zgody na publikację wizerunku'],
  'news_photo.rights_verified': ['news', 'Potwierdzenie praw do zdjęcia'],
  'news_photo.revoked': ['news', 'Wycofanie zdjęcia'],
  'image_consent.withdrawn': ['news', 'Wycofanie zgody na publikację wizerunku'],
};

export const AUDIT_ACTION_CATALOG = Object.freeze(Object.fromEntries(
  Object.entries(CATALOG).map(([action, [domain, label]]) => [action, Object.freeze({ domain, label })]),
));

export const AUDIT_ACTION_LABELS = Object.freeze(Object.fromEntries(
  Object.entries(AUDIT_ACTION_CATALOG).map(([action, entry]) => [action, entry.label]),
));

export function auditActionLabel(action) {
  return AUDIT_ACTION_CATALOG[action]?.label ?? null;
}

export function auditActionDomain(action) {
  return AUDIT_ACTION_CATALOG[action]?.domain ?? null;
}

// Wszystkie akcje domeny (do filtra `action = ANY(...)` po stronie serwera).
export function auditDomainActions(domain) {
  return Object.entries(AUDIT_ACTION_CATALOG).filter(([, entry]) => entry.domain === domain).map(([action]) => action);
}

// Czy aktor z podanymi rolami może czytać domenę. Wyłącznie pomocniczo dla
// panelu; wiążąca kontrola jest po stronie serwera (przydziały z sesji).
export function auditDomainReadable(domain, roles = []) {
  const readRoles = AUDIT_DOMAINS[domain]?.readRoles ?? [];
  return roles.some((role) => readRoles.includes(role));
}

// #181 pkt 3: źródło zdarzenia bez aktora (`actor_id = NULL`). Wiersze są
// append-only, więc źródło jest pochodną akcji (i `metadata.source` tam, gdzie
// akcję zapisują dwie ścieżki), liczoną przy odczycie — bez migracji.
// `actorKind`: `user` (jest aktor), `system` (proces serwera: worker e-mail,
// webhook Brevo, bootstrap) albo `anonymous` (osoba bez sesji: logowanie,
// link rezygnacji). Etykiety źródeł: AUDIT_SOURCE_LABELS.
export const AUDIT_SOURCE_LABELS = Object.freeze({
  email_worker: 'Worker e-mail',
  brevo_webhook: 'Powiadomienie dostawcy (Brevo)',
  unsubscribe_link: 'Link rezygnacji z wiadomości',
  login: 'Logowanie (bez sesji)',
  bootstrap: 'Uruchomienie systemu (pierwszy administrator)',
  system: 'Proces systemowy',
});

const WEBHOOK_ACTIONS = new Set(['email.address_suppressed', 'email.webhook.previous_secret_used']);

export function auditEventSource(action, actorId, metadata = {}) {
  if (actorId) return { actorKind: 'user', source: null };
  if (action === 'auth.bootstrap_issued') return { actorKind: 'system', source: 'bootstrap' };
  if (WEBHOOK_ACTIONS.has(action)) return { actorKind: 'system', source: 'brevo_webhook' };
  if (action === 'email.preference.opt_out') {
    return metadata?.source === 'link'
      ? { actorKind: 'anonymous', source: 'unsubscribe_link' }
      : { actorKind: 'system', source: 'brevo_webhook' };
  }
  if (action.startsWith('email.')) return { actorKind: 'system', source: 'email_worker' };
  if (action.startsWith('auth.') || action.startsWith('mfa.')) return { actorKind: 'anonymous', source: 'login' };
  return { actorKind: 'system', source: 'system' };
}
