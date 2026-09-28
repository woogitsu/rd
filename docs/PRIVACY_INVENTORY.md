# Projekt inwentarza danych osobowych (nie jest rejestrem czynności)

> Ten dokument jest **wygenerowany** ze `privacy/data-inventory.json` (`node scripts/privacy-report.js`).
> To jest materiał techniczny dla administratora danych (D-01) — nie zastępuje rejestru czynności
> przetwarzania ani oceny skutków (DPIA), które prowadzi administrator poza repozytorium.
> Retencja (D-04) i odbiorcy (D-08/D-09) są w większości pól „nieustalone” — wypełnia zarząd/IOD.

Zobacz też: [`docs/PROCESSORS.md`](./PROCESSORS.md), [`docs/DPIA_CHECKLIST.md`](./DPIA_CHECKLIST.md),
[`docs/DECISIONS.md`](./DECISIONS.md) (D-01, D-02, D-04, D-05, D-08, D-09).

## Kategorie osób × kategorie danych (tylko kolumny z danymi osobowymi)

| Tabela | Kolumna | Podmiot | Rodzaj | Kategoria | Cel | Retencja (kategoria) | Wolny tekst | Eksport roczny |
|---|---|---|---|---|---|---|---|---|
|`bank_reconciliation_matches`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`bank_reconciliation_matches`|`revoke_reason`|Osoba trzecia|direct|wolny tekst|uzasadnienie cofnięcia dopasowania|document_financial|tak|tak|
|`bank_reconciliation_matches`|`revoked_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`bank_reconciliations`|`confirmation_note`|Osoba trzecia|direct|wolny tekst|notatka potwierdzenia uzgodnienia|document_financial|tak|tak|
|`bank_reconciliations`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`bank_reconciliations`|`notes`|Osoba trzecia|direct|wolny tekst|notatka uzgodnienia banku|document_financial|tak|tak|
|`bank_statement_imports`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`bank_statement_lines`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`data_access_log`|`actor_id`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|nie|
|`data_access_log`|`household_id`|Opiekun|pseudonymous|identyfikacja|powiązanie wpisu z gospodarstwem|nieustalona (D-04)|nie|nie|
|`document_descriptions`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`document_descriptions`|`description`|Osoba trzecia|direct|wolny tekst|opis dokumentu|document_financial|tak|tak|
|`document_descriptions`|`title`|Osoba trzecia|direct|wolny tekst|tytuł dokumentu|document_financial|tak|tak|
|`document_uploads`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|nie|
|`documents`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|nie|
|`email_campaign_recipients`|`email`|Opiekun|direct|kontakt|migawka adresu w chwili wysyłki|email_snapshot|nie|nie|
|`email_campaign_recipients`|`email_hash`|Opiekun|pseudonymous|kontakt|dziennik limitu/tłumienia bez jawnego adresu|email_snapshot|nie|nie|
|`email_campaign_recipients`|`guardian_id`|Opiekun|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|nie|
|`email_campaigns`|`approved_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|nie|
|`email_campaigns`|`body_text`|Opiekun|direct|wolny tekst|treść kampanii e-mail|email_snapshot|tak|nie|
|`email_campaigns`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|nie|
|`email_campaigns`|`paused_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|nie|
|`email_campaigns`|`resumed_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|nie|
|`email_campaigns`|`subject`|Opiekun|direct|wolny tekst|temat kampanii e-mail|email_snapshot|tak|nie|
|`email_outbox_resolutions`|`resolved_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|nie|
|`email_preferences_events`|`email_hash`|Opiekun|pseudonymous|kontakt|preferencje kontaktu wg kategorii (wypisanie jednym kliknięciem)|email_snapshot|nie|nie|
|`email_preview_sends`|`actor_id`|Członek Rady|pseudonymous|identyfikacja|powiązanie wysyłki testowej z osobą|nieustalona (D-04)|nie|nie|
|`email_preview_sends`|`recipient_hash`|Członek Rady|pseudonymous|kontakt|limit wysyłek testowych na adres techniczny Rady|nieustalona (D-04)|nie|nie|
|`email_suppressions`|`email_hash`|Opiekun|pseudonymous|kontakt|lista wypisań/odbić|email_snapshot|nie|nie|
|`enrollment_history`|`student_id`|Uczeń|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`enrollments`|`ended_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`enrollments`|`ended_reason`|Uczeń|direct|wolny tekst|uzasadnienie zmiany|nieustalona (D-04)|tak|tak|
|`enrollments`|`student_id`|Uczeń|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`event_revisions`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`events`|`approved_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`events`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`guardian_contact_changes`|`guardian_id`|Opiekun|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`guardian_contact_changes`|`new_email`|Opiekun|direct|kontakt|historia zmian kontaktu|guardian_contact|nie|nie|
|`guardian_contact_changes`|`previous_email`|Opiekun|direct|kontakt|historia zmian kontaktu|guardian_contact|nie|nie|
|`guardian_contact_changes`|`reason`|Opiekun|direct|wolny tekst|uzasadnienie zmiany kontaktu|guardian_contact|tak|nie|
|`guardian_households`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`guardian_households`|`guardian_id`|Opiekun|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`guardians`|`contact_allowed`|Opiekun|pseudonymous|zgoda|zgoda na kontakt|nieustalona (D-04)|nie|tak|
|`guardians`|`email`|Opiekun|direct|kontakt|kontakt z opiekunem|guardian_contact|nie|tak|
|`guardians`|`first_name`|Opiekun|direct|identyfikacja|identyfikacja opiekuna|guardian_contact|nie|tak|
|`guardians`|`last_name`|Opiekun|direct|identyfikacja|identyfikacja opiekuna|guardian_contact|nie|tak|
|`invitations`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|nie|
|`invitations`|`revoked_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|nie|
|`ledger_budget_adoptions`|`adopted_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie przyjęcia preliminarza z osobą|nieustalona (D-04)|nie|tak|
|`ledger_budget_adoptions`|`note`|Osoba trzecia|direct|wolny tekst|uwaga przy przyjęciu preliminarza|document_financial|tak|tak|
|`ledger_budget_lines`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`ledger_categories`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`ledger_category_deactivations`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`ledger_category_deactivations`|`reason`|Osoba trzecia|direct|wolny tekst|uzasadnienie wyłączenia kategorii|document_financial|tak|tak|
|`ledger_corrections`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`ledger_corrections`|`reason`|Osoba trzecia|direct|wolny tekst|uzasadnienie korekty księgowej|document_financial|tak|tak|
|`ledger_entries`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`ledger_entries`|`description`|Osoba trzecia|direct|wolny tekst|opis operacji księgowej|document_financial|tak|tak|
|`ledger_entry_reviews`|`note`|Osoba trzecia|direct|wolny tekst|uzasadnienie zakwestionowania wydatku|document_financial|tak|tak|
|`ledger_entry_reviews`|`reviewed_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie weryfikacji z osobą|nieustalona (D-04)|nie|tak|
|`ledger_opening_balance_adjustments`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`ledger_opening_balance_adjustments`|`reason`|Osoba trzecia|direct|wolny tekst|uzasadnienie korekty bilansu otwarcia|document_financial|tak|tak|
|`ledger_opening_balances`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`ledger_transfers`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`meeting_agenda_items`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`meeting_agenda_items`|`description`|Członek Rady|direct|wolny tekst|punkt porządku obrad|audit_event|tak|tak|
|`meeting_attendees`|`guardian_id`|Opiekun|pseudonymous|identyfikacja|powiązanie opiekuna z zebraniem|audit_event|nie|tak|
|`meeting_attendees`|`recorded_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`meeting_attendees`|`user_id`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`meeting_minutes`|`approval_note`|Członek Rady|direct|wolny tekst|notatka zatwierdzenia protokołu|audit_event|tak|tak|
|`meeting_minutes`|`approved_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`meeting_minutes`|`body`|Członek Rady|direct|wolny tekst|treść protokołu|audit_event|tak|tak|
|`meeting_minutes`|`change_note`|Członek Rady|direct|wolny tekst|opis zmiany wersji protokołu|audit_event|tak|tak|
|`meeting_minutes`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`meeting_minutes_publications`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`meetings`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`mfa_recovery_codes`|`user_id`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|nie|
|`news_photo_consents`|`recorded_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|nie|
|`news_photos`|`alt_text`|Osoba trzecia|direct|wolny tekst|opis alternatywny zdjęcia|document_financial|tak|nie|
|`news_photos`|`author`|Osoba trzecia|direct|wizerunek|autorstwo zdjęcia|document_financial|tak|nie|
|`news_photos`|`license_text`|Osoba trzecia|direct|wolny tekst|treść licencji/zgody na wizerunek|document_financial|tak|nie|
|`news_photos`|`revocation_reason`|Osoba trzecia|direct|wolny tekst|powód wycofania zgody na wizerunek|document_financial|tak|nie|
|`news_photos`|`revoked_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|nie|
|`news_photos`|`rights_note`|Osoba trzecia|direct|wolny tekst|zgoda/licencja na wizerunek|document_financial|tak|nie|
|`news_post_revisions`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|nie|
|`news_posts`|`approved_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|nie|
|`news_posts`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|nie|
|`password_reset_tokens`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|nie|
|`password_reset_tokens`|`user_id`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|nie|
|`payment_assignments`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`payment_corrections`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`payment_corrections`|`reason`|Opiekun|direct|wolny tekst|uzasadnienie korekty wpłaty|payment_reference|tak|tak|
|`payment_entries`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`payment_entries`|`reference`|Opiekun|direct|wolny tekst|tytuł przelewu z wyciągu bankowego|payment_reference|tak|tak|
|`payment_reassignments`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`payment_refunds`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`resolution_execution_events`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`resolution_execution_events`|`note`|Członek Rady|direct|wolny tekst|notatka o postępie wykonania uchwały|audit_event|tak|tak|
|`resolution_execution_events`|`responsible_user_id`|Członek Rady|pseudonymous|identyfikacja|wskazanie osoby odpowiedzialnej za wykonanie uchwały|nieustalona (D-04)|nie|tak|
|`resolution_spending_authorizations`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`resolution_spending_authorizations`|`note`|Osoba trzecia|direct|wolny tekst|uzasadnienie kwoty upoważnienia wydatku|document_financial|tak|tak|
|`resolutions`|`body`|Członek Rady|direct|wolny tekst|treść uchwały|audit_event|tak|tak|
|`resolutions`|`correction_reason`|Członek Rady|direct|wolny tekst|uzasadnienie korekty uchwały|audit_event|tak|tak|
|`resolutions`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`role_grants`|`revoked_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|nie|
|`role_grants`|`user_id`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|nie|
|`sessions`|`user_id`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|nie|
|`student_guardian_changes`|`guardian_id`|Opiekun|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`student_guardian_changes`|`student_id`|Uczeń|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`student_guardians`|`guardian_id`|Opiekun|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`student_guardians`|`student_id`|Uczeń|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`student_households`|`created_by`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`student_households`|`student_id`|Uczeń|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|tak|
|`students`|`first_name`|Uczeń|direct|identyfikacja|identyfikacja ucznia|student_identity|nie|tak|
|`students`|`last_name`|Uczeń|direct|identyfikacja|identyfikacja ucznia|student_identity|nie|tak|
|`user_mfa_factors`|`user_id`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|nie|
|`user_passwords`|`user_id`|Członek Rady|pseudonymous|identyfikacja|powiązanie rekordu z osobą|nieustalona (D-04)|nie|nie|
|`users`|`display_name`|Członek Rady|direct|identyfikacja|wyświetlanie nazwiska członka Rady|guardian_contact|nie|nie|
|`users`|`email`|Członek Rady|direct|kontakt|logowanie i kontakt z członkiem Rady|guardian_contact|nie|nie|

Łącznie kolumn z danymi osobowymi: **119**, w tym wolnego tekstu: **30** (patrz #152).

## Wszystkie tabele i kolumny (pełny spis)

### `audit_events`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `action` | none | — | tak |
| `actor_id` | none | — | tak |
| `entity_id` | none | — | tak |
| `entity_type` | none | — | tak |
| `id` | none | — | tak |
| `metadata_json` | none | — | tak |
| `occurred_at` | none | — | tak |

### `backup_runs`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `environment` | none | — | nie |
| `error_code` | none | — | nie |
| `finished_at` | none | — | nie |
| `id` | none | — | nie |
| `kind` | none | — | nie |
| `object_key` | none | — | nie |
| `result` | none | — | nie |
| `row_counts` | none | — | nie |
| `sha256` | none | — | nie |
| `size_bytes` | none | — | nie |
| `started_at` | none | — | nie |
| `sums` | none | — | nie |

### `bank_reconciliation_matches`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `id` | none | — | tak |
| `idempotency_key` | none | — | tak |
| `ledger_entry_id` | none | — | tak |
| `payment_entry_id` | none | — | tak |
| `reconciliation_id` | none | — | tak |
| `revoke_reason` | direct | third_party | tak |
| `revoked_at` | none | — | tak |
| `revoked_by` | pseudonymous | board_member | tak |
| `statement_line_id` | none | — | tak |

### `bank_reconciliations`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `confirmation_note` | direct | third_party | tak |
| `confirmed_at` | none | — | tak |
| `confirmed_by` | none | — | tak |
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `difference_cents` | none | — | tak |
| `id` | none | — | tak |
| `idempotency_key` | none | — | tak |
| `ledger_balance_cents` | none | — | tak |
| `ledger_non_bank_cents` | none | — | tak |
| `notes` | direct | third_party | tak |
| `reference_salt` | none | — | tak |
| `school_year_id` | none | — | tak |
| `statement_balance_cents` | none | — | tak |
| `statement_date` | none | — | tak |
| `status` | none | — | tak |

### `bank_statement_imports`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `closing_balance_cents` | none | — | tak |
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `file_hash` | none | — | tak |
| `id` | none | — | tak |
| `idempotency_key` | none | — | tak |
| `line_count` | none | — | tak |
| `opening_balance_cents` | none | — | tak |
| `reconciliation_id` | none | — | tak |
| `request_hash` | none | — | tak |
| `skipped_duplicate_count` | none | — | tak |
| `source` | none | — | tak |
| `statement_number` | none | — | tak |

### `bank_statement_lines`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `amount_cents` | none | — | tak |
| `bank_transaction_hash` | none | — | tak |
| `booked_on` | none | — | tak |
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `id` | none | — | tak |
| `import_id` | none | — | tak |
| `line_no` | none | — | tak |
| `reconciliation_id` | none | — | tak |
| `reference_hash` | none | — | tak |

### `classes`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `id` | none | — | tak |
| `name` | none | — | tak |
| `school_year_id` | none | — | tak |

### `data_access_log`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `access_kind` | none | — | nie |
| `actor_id` | pseudonymous | board_member | nie |
| `class_id` | none | — | nie |
| `hit_count` | none | — | nie |
| `household_id` | pseudonymous | guardian | nie |
| `id` | none | — | nie |
| `last_seen_at` | none | — | nie |
| `occurred_at` | none | — | nie |
| `outcome` | none | — | nie |
| `row_count` | none | — | nie |
| `school_year_id` | none | — | nie |

### `document_descriptions`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `category` | none | — | tak |
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `description` | direct | third_party | tak |
| `document_date` | none | — | tak |
| `document_id` | none | — | tak |
| `idempotency_key` | none | — | tak |
| `revision_no` | none | — | tak |
| `title` | direct | third_party | tak |

### `document_uploads`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `byte_size` | none | — | nie |
| `created_at` | none | — | nie |
| `created_by` | pseudonymous | board_member | nie |
| `id` | none | — | nie |
| `idempotency_key` | none | — | nie |
| `mime_type` | none | — | nie |
| `object_key` | none | — | nie |
| `resolution` | none | — | nie |
| `resolved_at` | none | — | nie |
| `sha256` | none | — | nie |
| `state` | none | — | nie |

### `documents`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `byte_size` | none | — | nie |
| `class_id` | none | — | nie |
| `created_at` | none | — | nie |
| `created_by` | pseudonymous | board_member | nie |
| `id` | none | — | nie |
| `idempotency_key` | none | — | nie |
| `kind` | none | — | nie |
| `linked_entity_id` | none | — | nie |
| `linked_entity_type` | none | — | nie |
| `mime_type` | none | — | nie |
| `object_key` | none | — | nie |
| `retain_until` | none | — | nie |
| `retention_policy` | none | — | nie |
| `school_year_id` | none | — | nie |
| `sha256` | none | — | nie |

### `email_campaign_exclusions`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `campaign_id` | none | — | nie |
| `household_id` | none | — | nie |
| `reason` | none | — | nie |

### `email_campaign_recipients`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `campaign_id` | none | — | nie |
| `created_at` | none | — | nie |
| `email` | direct | guardian | nie |
| `email_hash` | pseudonymous | guardian | nie |
| `guardian_id` | pseudonymous | guardian | nie |
| `household_id` | none | — | nie |
| `id` | none | — | nie |

### `email_campaigns`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `approved_at` | none | — | nie |
| `approved_by` | pseudonymous | board_member | nie |
| `approved_content_hash` | none | — | nie |
| `approved_recipients_hash` | none | — | nie |
| `audience` | none | — | nie |
| `body_text` | direct | guardian | nie |
| `cancelled_at` | none | — | nie |
| `cancelled_by` | none | — | nie |
| `category` | none | — | nie |
| `completed_at` | none | — | nie |
| `content_hash` | none | — | nie |
| `created_at` | none | — | nie |
| `created_by` | pseudonymous | board_member | nie |
| `daily_cap` | none | — | nie |
| `id` | none | — | nie |
| `idempotency_key` | none | — | nie |
| `paused_at` | none | — | nie |
| `paused_by` | pseudonymous | board_member | nie |
| `queued_at` | none | — | nie |
| `queued_by` | none | — | nie |
| `recipients_count` | none | — | nie |
| `recipients_hash` | none | — | nie |
| `resumed_at` | none | — | nie |
| `resumed_by` | pseudonymous | board_member | nie |
| `revision_no` | none | — | tak |
| `school_year_id` | none | — | nie |
| `send_not_before` | none | — | nie |
| `snapshot_built_at` | none | — | nie |
| `snapshot_built_by` | none | — | nie |
| `status` | none | — | nie |
| `subject` | direct | guardian | nie |
| `title` | none | — | nie |
| `updated_at` | none | — | nie |
| `updated_by` | none | — | nie |

### `email_outbox`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `attempts` | none | — | nie |
| `campaign_id` | none | — | nie |
| `claim_token` | none | — | nie |
| `claimed_at` | none | — | nie |
| `created_at` | none | — | nie |
| `household_id` | none | — | nie |
| `id` | none | — | nie |
| `idempotency_key` | none | — | nie |
| `last_error` | none | — | nie |
| `next_attempt_at` | none | — | nie |
| `provider_message_id` | none | — | nie |
| `recipient_id` | none | — | nie |
| `send_started_at` | none | — | nie |
| `sent_at` | none | — | nie |
| `state` | none | — | nie |
| `updated_at` | none | — | nie |

### `email_outbox_resolutions`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `campaign_id` | none | — | nie |
| `created_at` | none | — | nie |
| `evidence_code` | none | — | nie |
| `id` | none | — | nie |
| `outbox_id` | none | — | nie |
| `resolution` | none | — | nie |
| `resolved_by` | pseudonymous | board_member | nie |

### `email_preferences_events`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `action` | none | — | nie |
| `campaign_id` | none | — | nie |
| `category` | none | — | nie |
| `created_at` | none | — | nie |
| `email_hash` | pseudonymous | guardian | nie |
| `id` | none | — | nie |
| `source` | none | — | nie |

### `email_preview_sends`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `actor_id` | pseudonymous | board_member | nie |
| `campaign_id` | none | — | nie |
| `content_hash` | none | — | nie |
| `created_at` | none | — | nie |
| `id` | none | — | nie |
| `idempotency_key` | none | — | nie |
| `provider_message_id` | none | — | nie |
| `recipient_hash` | pseudonymous | board_member | nie |

### `email_send_ledger`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `attempt` | none | — | nie |
| `campaign_id` | none | — | nie |
| `day` | none | — | nie |
| `id` | none | — | nie |
| `message_count` | none | — | nie |
| `outbox_id` | none | — | nie |
| `recorded_at` | none | — | nie |
| `source` | none | — | nie |

### `email_suppressions`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `created_at` | none | — | nie |
| `email_hash` | pseudonymous | guardian | nie |
| `reason` | none | — | nie |
| `source_event_id` | none | — | nie |

### `email_webhook_events`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `dedupe_key` | none | — | nie |
| `email_hash` | none | — | nie |
| `event` | none | — | nie |
| `id` | none | — | nie |
| `occurred_at` | none | — | nie |
| `outbox_id` | none | — | nie |
| `provider` | none | — | nie |
| `provider_message_id` | none | — | nie |
| `received_at` | none | — | nie |

### `email_worker_runs`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `day` | none | — | nie |
| `failed` | none | — | nie |
| `finished_at` | none | — | nie |
| `id` | none | — | nie |
| `mode` | none | — | nie |
| `planned` | none | — | nie |
| `remaining_quota` | none | — | nie |
| `retried` | none | — | nie |
| `sent` | none | — | nie |
| `skipped` | none | — | nie |
| `started_at` | none | — | nie |
| `stopped_reason` | none | — | nie |
| `suppressed` | none | — | nie |

### `enrollment_history`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `changed_at` | none | — | tak |
| `changed_by` | none | — | tak |
| `effective_on` | none | — | tak |
| `enrollment_id` | none | — | tak |
| `from_class_id` | none | — | tak |
| `id` | none | — | tak |
| `kind` | none | — | tak |
| `reason` | none | — | tak |
| `school_year_id` | none | — | tak |
| `source` | none | — | tak |
| `student_id` | pseudonymous | student | tak |
| `to_class_id` | none | — | tak |

### `enrollments`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `class_id` | none | — | tak |
| `ended_at` | none | — | tak |
| `ended_by` | pseudonymous | board_member | tak |
| `ended_on` | none | — | tak |
| `ended_reason` | direct | student | tak |
| `id` | none | — | tak |
| `school_year_id` | none | — | tak |
| `student_id` | pseudonymous | student | tak |

### `event_revisions`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `audience` | none | — | tak |
| `begins_at` | none | — | tak |
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `description` | none | — | tak |
| `ends_at` | none | — | tak |
| `event_id` | none | — | tak |
| `location` | none | — | tak |
| `organizer` | none | — | tak |
| `revision_no` | none | — | tak |
| `source` | none | — | tak |
| `title` | none | — | tak |

### `events`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `approved_at` | none | — | tak |
| `approved_by` | pseudonymous | board_member | tak |
| `approved_revision_no` | none | — | tak |
| `audience` | none | — | tak |
| `begins_at` | none | — | tak |
| `cancellation_reason` | none | — | tak |
| `cancelled_at` | none | — | tak |
| `cancelled_by` | none | — | tak |
| `class_id` | none | — | tak |
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `description` | none | — | tak |
| `ends_at` | none | — | tak |
| `first_published_at` | none | — | tak |
| `id` | none | — | tak |
| `idempotency_key` | none | — | tak |
| `location` | none | — | tak |
| `organizer` | none | — | tak |
| `published_at` | none | — | tak |
| `published_by` | none | — | tak |
| `published_revision_no` | none | — | tak |
| `revision_no` | none | — | tak |
| `school_year_id` | none | — | tak |
| `status` | none | — | tak |
| `submitted_at` | none | — | tak |
| `submitted_by` | none | — | tak |
| `submitted_revision_no` | none | — | tak |
| `timezone` | none | — | tak |
| `title` | none | — | tak |
| `updated_at` | none | — | tak |
| `updated_by` | none | — | tak |
| `visibility` | none | — | tak |

### `export_runs`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `class_id` | none | — | nie |
| `created_at` | none | — | nie |
| `format_version` | none | — | nie |
| `id` | none | — | nie |
| `kind` | none | — | nie |
| `manifest_sha256` | none | — | nie |
| `requested_by` | none | — | nie |
| `row_counts` | none | — | nie |
| `school_year_id` | none | — | nie |

### `guardian_contact_changes`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `changed_at` | none | — | tak |
| `changed_by` | none | — | tak |
| `guardian_id` | pseudonymous | guardian | tak |
| `id` | none | — | tak |
| `new_contact_allowed` | none | — | tak |
| `new_email` | direct | guardian | nie |
| `previous_contact_allowed` | none | — | tak |
| `previous_email` | direct | guardian | nie |
| `reason` | direct | guardian | nie |
| `source` | none | — | tak |

### `guardian_households`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `ended_at` | none | — | tak |
| `ended_by` | none | — | tak |
| `ends_on` | none | — | tak |
| `guardian_id` | pseudonymous | guardian | tak |
| `household_id` | none | — | tak |
| `id` | none | — | tak |
| `source` | none | — | tak |
| `starts_on` | none | — | tak |

### `guardians`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `contact_allowed` | pseudonymous | guardian | tak |
| `email` | direct | guardian | tak |
| `first_name` | direct | guardian | tak |
| `household_id` | none | — | tak |
| `id` | none | — | tak |
| `import_batch_id` | none | — | nie |
| `last_name` | direct | guardian | tak |

### `households`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `archived_at` | none | — | tak |
| `created_at` | none | — | tak |
| `id` | none | — | tak |
| `import_batch_id` | none | — | nie |
| `source_ref` | none | — | nie |

### `import_batches`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `actor_id` | none | — | nie |
| `created_at` | none | — | nie |
| `enrollments_created` | none | — | nie |
| `fingerprint` | none | — | nie |
| `guardians_created` | none | — | nie |
| `households_created` | none | — | nie |
| `id` | none | — | nie |
| `idempotency_key` | none | — | nie |
| `links_created` | none | — | nie |
| `plan_digest` | none | — | nie |
| `rows_added` | none | — | nie |
| `rows_conflict` | none | — | nie |
| `rows_skipped` | none | — | nie |
| `rows_total` | none | — | nie |
| `rows_unchanged` | none | — | nie |
| `rows_updated` | none | — | nie |
| `school_year_id` | none | — | nie |
| `status` | none | — | nie |
| `students_created` | none | — | nie |

### `invitations`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `accepted_at` | none | — | nie |
| `accepted_by` | none | — | nie |
| `class_id` | none | — | nie |
| `created_at` | none | — | nie |
| `created_by` | pseudonymous | board_member | nie |
| `email` | none | — | nie |
| `expires_at` | none | — | nie |
| `id` | none | — | nie |
| `revoked_at` | none | — | nie |
| `revoked_by` | pseudonymous | board_member | nie |
| `role` | none | — | nie |
| `school_year_id` | none | — | nie |
| `token_hash` | none | — | nie |

### `ledger_budget_adoption_lines`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `adoption_id` | none | — | tak |
| `line_id` | none | — | tak |
| `school_year_id` | none | — | tak |

### `ledger_budget_adoptions`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `adopted_at` | none | — | tak |
| `adopted_by` | pseudonymous | board_member | tak |
| `adopted_on` | none | — | tak |
| `id` | none | — | tak |
| `idempotency_key` | none | — | tak |
| `note` | direct | third_party | tak |
| `resolution_id` | none | — | tak |
| `school_year_id` | none | — | tak |

### `ledger_budget_lines`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `category_id` | none | — | tak |
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `id` | none | — | tak |
| `idempotency_key` | none | — | tak |
| `note` | none | — | tak |
| `planned_cents` | none | — | tak |
| `school_year_id` | none | — | tak |
| `supersedes_id` | none | — | tak |

### `ledger_categories`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `active` | none | — | tak |
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `direction` | none | — | tak |
| `id` | none | — | tak |
| `idempotency_key` | none | — | tak |
| `name` | none | — | tak |
| `school_year_id` | none | — | tak |

### `ledger_category_deactivations`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `category_id` | none | — | tak |
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `id` | none | — | tak |
| `idempotency_key` | none | — | tak |
| `reason` | direct | third_party | tak |
| `school_year_id` | none | — | tak |

### `ledger_corrections`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `amount_cents` | none | — | tak |
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `id` | none | — | tak |
| `idempotency_key` | none | — | tak |
| `ledger_entry_id` | none | — | tak |
| `reason` | direct | third_party | tak |

### `ledger_entries`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `amount_cents` | none | — | tak |
| `category_id` | none | — | tak |
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `description` | direct | third_party | tak |
| `direction` | none | — | tak |
| `id` | none | — | tak |
| `idempotency_key` | none | — | tak |
| `method` | none | — | tak |
| `occurred_on` | none | — | tak |
| `payment_entry_id` | none | — | tak |
| `replaces_entry_id` | none | — | tak |
| `resolution_id` | none | — | tak |
| `resolution_reference` | none | — | tak |
| `school_year_id` | none | — | tak |
| `source` | none | — | tak |
| `source_document_id` | none | — | tak |

### `ledger_entry_reviews`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `decision` | none | — | tak |
| `id` | none | — | tak |
| `idempotency_key` | none | — | tak |
| `ledger_entry_id` | none | — | tak |
| `note` | direct | third_party | tak |
| `reviewed_at` | none | — | tak |
| `reviewed_by` | pseudonymous | board_member | tak |
| `school_year_id` | none | — | tak |

### `ledger_opening_balance_adjustments`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `amount_cents` | none | — | tak |
| `cash_cents` | none | — | tak |
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `id` | none | — | tak |
| `idempotency_key` | none | — | tak |
| `opening_balance_id` | none | — | tak |
| `reason` | direct | third_party | tak |

### `ledger_opening_balances`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `amount_cents` | none | — | tak |
| `cash_cents` | none | — | tak |
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `id` | none | — | tak |
| `idempotency_key` | none | — | tak |
| `note` | none | — | tak |
| `school_year_id` | none | — | tak |
| `source_document_id` | none | — | tak |

### `ledger_transfers`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `amount_cents` | none | — | tak |
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `description` | none | — | tak |
| `direction` | none | — | tak |
| `id` | none | — | tak |
| `idempotency_key` | none | — | tak |
| `reverses_id` | none | — | tak |
| `school_year_id` | none | — | tak |
| `source_document_id` | none | — | tak |
| `transferred_on` | none | — | tak |

### `login_rate_limits`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `failure_count` | none | — | nie |
| `locked_until` | none | — | nie |
| `scope_hash` | none | — | nie |
| `scope_type` | none | — | nie |
| `updated_at` | none | — | nie |
| `window_started_at` | none | — | nie |

### `meeting_agenda_items`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `description` | direct | board_member | tak |
| `id` | none | — | tak |
| `meeting_id` | none | — | tak |
| `position` | none | — | tak |
| `title` | none | — | tak |

### `meeting_attendance_state`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `meeting_id` | none | — | tak |
| `revision` | none | — | tak |

### `meeting_attendees`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `capacity` | none | — | tak |
| `guardian_id` | pseudonymous | guardian | tak |
| `id` | none | — | tak |
| `meeting_id` | none | — | tak |
| `present` | none | — | tak |
| `recorded_at` | none | — | tak |
| `recorded_by` | pseudonymous | board_member | tak |
| `updated_at` | none | — | tak |
| `user_id` | pseudonymous | board_member | tak |
| `voting_eligible` | none | — | tak |

### `meeting_minutes`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `approval_note` | direct | board_member | tak |
| `approved_at` | none | — | tak |
| `approved_by` | pseudonymous | board_member | tak |
| `body` | direct | board_member | tak |
| `change_note` | direct | board_member | tak |
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `id` | none | — | tak |
| `meeting_id` | none | — | tak |
| `status` | none | — | tak |
| `supersedes_id` | none | — | tak |
| `version` | none | — | tak |

### `meeting_minutes_publications`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `id` | none | — | tak |
| `minutes_id` | none | — | tak |
| `reason` | none | — | tak |
| `seq` | none | — | tak |
| `visibility` | none | — | tak |

### `meeting_quorum_checks`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `attendance_revision` | none | — | tak |
| `determined_at` | none | — | tak |
| `determined_by` | none | — | tak |
| `id` | none | — | tak |
| `meeting_id` | none | — | tak |
| `met` | none | — | tak |
| `present_eligible` | none | — | tak |
| `quorum_denominator` | none | — | tak |
| `quorum_inclusive` | none | — | tak |
| `quorum_min_count` | none | — | tak |
| `quorum_mode` | none | — | tak |
| `quorum_numerator` | none | — | tak |
| `required_count` | none | — | tak |
| `seq` | none | — | tak |
| `voting_body_size` | none | — | tak |

### `meeting_request_keys`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `actor_id` | none | — | nie |
| `created_at` | none | — | nie |
| `entity_id` | none | — | nie |
| `entity_type` | none | — | nie |
| `idempotency_key` | none | — | nie |
| `operation` | none | — | nie |
| `request_hash` | none | — | nie |

### `meetings`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `class_id` | none | — | tak |
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `id` | none | — | tak |
| `kind` | none | — | tak |
| `location` | none | — | tak |
| `quorum_denominator` | none | — | tak |
| `quorum_inclusive` | none | — | tak |
| `quorum_min_count` | none | — | tak |
| `quorum_mode` | none | — | tak |
| `quorum_numerator` | none | — | tak |
| `quorum_rule_source` | none | — | tak |
| `revision_no` | none | — | tak |
| `scheduled_at` | none | — | tak |
| `school_year_id` | none | — | tak |
| `status` | none | — | tak |
| `title` | none | — | tak |
| `updated_at` | none | — | tak |
| `voting_body_size` | none | — | tak |

### `mfa_rate_limits`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `failure_count` | none | — | nie |
| `locked_until` | none | — | nie |
| `scope_id` | none | — | nie |
| `scope_type` | none | — | nie |
| `updated_at` | none | — | nie |
| `window_started_at` | none | — | nie |

### `mfa_recovery_codes`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `code_hash` | none | — | nie |
| `created_at` | none | — | nie |
| `factor_id` | none | — | nie |
| `id` | none | — | nie |
| `invalidated_at` | none | — | nie |
| `rotated_to_factor_id` | none | — | nie |
| `used_at` | none | — | nie |
| `used_session_id` | none | — | nie |
| `user_id` | pseudonymous | board_member | nie |

### `news_photo_consents`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `consent_document_ref` | none | — | nie |
| `photo_id` | none | — | nie |
| `recorded_at` | none | — | nie |
| `recorded_by` | pseudonymous | board_member | nie |
| `subject_kind` | none | — | nie |
| `subject_no` | none | — | nie |

### `news_photo_files`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `byte_size` | none | — | nie |
| `created_at` | none | — | nie |
| `created_by` | none | — | nie |
| `height` | none | — | nie |
| `id` | none | — | nie |
| `mime_type` | none | — | nie |
| `object_key` | none | — | nie |
| `photo_id` | none | — | nie |
| `sha256` | none | — | nie |
| `source_sha256` | none | — | nie |
| `variant` | none | — | nie |
| `width` | none | — | nie |

### `news_photos`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `alt_text` | direct | third_party | nie |
| `author` | direct | third_party | nie |
| `decorative` | none | — | nie |
| `depicts_children` | none | — | nie |
| `document_id` | none | — | nie |
| `explicit_license_granted` | none | — | nie |
| `id` | none | — | nie |
| `idempotency_key` | none | — | nie |
| `identifiable_adults` | none | — | nie |
| `identifiable_children` | none | — | nie |
| `license_document_ref` | none | — | nie |
| `license_text` | direct | third_party | nie |
| `revocation_reason` | direct | third_party | nie |
| `revoked_at` | none | — | nie |
| `revoked_by` | pseudonymous | board_member | nie |
| `rights_note` | direct | third_party | nie |
| `rights_status` | none | — | nie |
| `rights_verified_at` | none | — | nie |
| `rights_verified_by` | none | — | nie |
| `source` | none | — | nie |
| `source_detail` | none | — | nie |
| `taken_on` | none | — | nie |
| `uploaded_at` | none | — | nie |
| `uploaded_by` | none | — | nie |

### `news_post_revisions`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `body` | none | — | nie |
| `created_at` | none | — | nie |
| `created_by` | pseudonymous | board_member | nie |
| `photo_ids` | none | — | nie |
| `post_id` | none | — | nie |
| `revision_no` | none | — | nie |
| `title` | none | — | nie |

### `news_posts`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `approved_at` | none | — | nie |
| `approved_by` | pseudonymous | board_member | nie |
| `approved_revision_no` | none | — | nie |
| `body` | none | — | nie |
| `class_id` | none | — | nie |
| `created_at` | none | — | nie |
| `created_by` | pseudonymous | board_member | nie |
| `first_published_at` | none | — | nie |
| `id` | none | — | nie |
| `idempotency_key` | none | — | nie |
| `photo_ids` | none | — | nie |
| `published_at` | none | — | nie |
| `published_by` | none | — | nie |
| `published_revision_no` | none | — | nie |
| `revision_no` | none | — | nie |
| `school_year_id` | none | — | nie |
| `status` | none | — | nie |
| `submitted_at` | none | — | nie |
| `submitted_by` | none | — | nie |
| `submitted_revision_no` | none | — | nie |
| `title` | none | — | nie |
| `updated_at` | none | — | nie |
| `updated_by` | none | — | nie |
| `withdrawal_reason` | none | — | nie |
| `withdrawn_at` | none | — | nie |
| `withdrawn_by` | none | — | nie |

### `password_reset_tokens`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `created_at` | none | — | nie |
| `created_by` | pseudonymous | board_member | nie |
| `expires_at` | none | — | nie |
| `id` | none | — | nie |
| `revoked_at` | none | — | nie |
| `token_hash` | none | — | nie |
| `used_at` | none | — | nie |
| `user_id` | pseudonymous | board_member | nie |

### `payment_assignments`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `household_id` | none | — | tak |
| `id` | none | — | tak |
| `idempotency_key` | none | — | tak |
| `payment_entry_id` | none | — | tak |

### `payment_corrections`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `amount_cents` | none | — | tak |
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `id` | none | — | tak |
| `idempotency_key` | none | — | tak |
| `payment_entry_id` | none | — | tak |
| `reason` | direct | guardian | tak |

### `payment_entries`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `amount_cents` | none | — | tak |
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `household_id` | none | — | tak |
| `id` | none | — | tak |
| `idempotency_key` | none | — | tak |
| `method` | none | — | tak |
| `received_on` | none | — | tak |
| `reference` | direct | guardian | tak |
| `school_year_id` | none | — | tak |
| `status` | none | — | tak |

### `payment_reassignments`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `id` | none | — | tak |
| `idempotency_key` | none | — | tak |
| `new_household_id` | none | — | tak |
| `old_household_id` | none | — | tak |
| `payment_entry_id` | none | — | tak |
| `reason` | none | — | tak |

### `payment_refunds`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `amount_cents` | none | — | tak |
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `id` | none | — | tak |
| `idempotency_key` | none | — | tak |
| `method` | none | — | tak |
| `payment_entry_id` | none | — | tak |
| `reason` | none | — | tak |
| `refunded_on` | none | — | tak |

### `resolution_execution_events`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `due_on` | none | — | tak |
| `id` | none | — | tak |
| `note` | direct | board_member | tak |
| `resolution_id` | none | — | tak |
| `responsible_user_id` | pseudonymous | board_member | tak |
| `status` | none | — | tak |

### `resolution_spending_authorizations`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `authorized_amount_cents` | none | — | tak |
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `id` | none | — | tak |
| `idempotency_key` | none | — | tak |
| `note` | direct | third_party | tak |
| `resolution_id` | none | — | tak |
| `school_year_id` | none | — | tak |
| `supersedes_id` | none | — | tak |
| `valid_until` | none | — | tak |

### `resolutions`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `amends_resolution_id` | none | — | tak |
| `body` | direct | board_member | tak |
| `correction_reason` | direct | board_member | tak |
| `corrects_id` | none | — | tak |
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `decided_at` | none | — | tak |
| `id` | none | — | tak |
| `meeting_id` | none | — | tak |
| `number` | none | — | tak |
| `quorum_check_id` | none | — | tak |
| `relation_cross_year` | none | — | tak |
| `relation_kind` | none | — | tak |
| `revision` | none | — | tak |
| `revision_no` | none | — | tak |
| `school_year_id` | none | — | tak |
| `status` | none | — | tak |
| `title` | none | — | tak |
| `updated_at` | none | — | tak |
| `votes_abstain` | none | — | tak |
| `votes_against` | none | — | tak |
| `votes_for` | none | — | tak |

### `role_grants`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `class_id` | none | — | nie |
| `expires_at` | none | — | nie |
| `granted_at` | none | — | nie |
| `granted_by` | none | — | nie |
| `id` | none | — | nie |
| `revoked_at` | none | — | nie |
| `revoked_by` | pseudonymous | board_member | nie |
| `role` | none | — | nie |
| `school_year_id` | none | — | nie |
| `source_invitation_id` | none | — | nie |
| `user_id` | pseudonymous | board_member | nie |

### `school_year_closure_checklist`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `closure_id` | none | — | tak |
| `confirmed_at` | none | — | tak |
| `confirmed_by` | none | — | tak |
| `document_id` | none | — | tak |
| `item` | none | — | tak |
| `note` | none | — | tak |

### `school_year_closures`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `carried_opening_balance_id` | none | — | tak |
| `closed_at` | none | — | tak |
| `closed_by` | none | — | tak |
| `closing_balance_cents` | none | — | tak |
| `closing_cash_cents` | none | — | tak |
| `expense_cents` | none | — | tak |
| `expired_grant_count` | none | — | tak |
| `id` | none | — | tak |
| `income_cents` | none | — | tak |
| `initiated_at` | none | — | tak |
| `initiated_by` | none | — | tak |
| `next_school_year_id` | none | — | tak |
| `opening_balance_cents` | none | — | tak |
| `opening_cash_cents` | none | — | tak |
| `school_year_id` | none | — | tak |
| `status` | none | — | tak |

### `school_years`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `ends_on` | none | — | tak |
| `id` | none | — | tak |
| `label` | none | — | tak |
| `resolution_number_pattern` | none | — | tak |
| `starts_on` | none | — | tak |

### `sessions`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `created_at` | none | — | nie |
| `expires_at` | none | — | nie |
| `id` | none | — | nie |
| `last_seen_at` | none | — | nie |
| `mfa_verified_at` | none | — | nie |
| `revoked_at` | none | — | nie |
| `revoked_reason` | none | — | nie |
| `rotated_from` | none | — | nie |
| `token_hash` | none | — | nie |
| `user_id` | pseudonymous | board_member | nie |

### `student_guardian_changes`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `changed_at` | none | — | tak |
| `changed_by` | none | — | tak |
| `guardian_id` | pseudonymous | guardian | tak |
| `id` | none | — | tak |
| `new_contact_allowed` | none | — | tak |
| `new_ends_on` | none | — | tak |
| `new_is_primary_contact` | none | — | tak |
| `new_starts_on` | none | — | tak |
| `previous_contact_allowed` | none | — | tak |
| `previous_ends_on` | none | — | tak |
| `previous_is_primary_contact` | none | — | tak |
| `previous_starts_on` | none | — | tak |
| `reason` | none | — | nie |
| `source` | none | — | tak |
| `student_id` | pseudonymous | student | tak |

### `student_guardians`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `contact_allowed` | none | — | tak |
| `created_at` | none | — | tak |
| `ends_on` | none | — | tak |
| `guardian_id` | pseudonymous | guardian | tak |
| `is_primary_contact` | none | — | tak |
| `starts_on` | none | — | tak |
| `student_id` | pseudonymous | student | tak |

### `student_households`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `created_at` | none | — | tak |
| `created_by` | pseudonymous | board_member | tak |
| `ended_at` | none | — | tak |
| `ended_by` | none | — | tak |
| `ends_on` | none | — | tak |
| `household_id` | none | — | tak |
| `id` | none | — | tak |
| `is_primary` | none | — | tak |
| `source` | none | — | tak |
| `starts_on` | none | — | tak |
| `student_id` | pseudonymous | student | tak |

### `students`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `first_name` | direct | student | tak |
| `household_id` | none | — | tak |
| `id` | none | — | tak |
| `import_batch_id` | none | — | nie |
| `last_name` | direct | student | tak |
| `source_ref` | none | — | nie |

### `user_mfa_factors`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `confirmed_at` | none | — | nie |
| `created_at` | none | — | nie |
| `disabled_at` | none | — | nie |
| `id` | none | — | nie |
| `key_version` | none | — | nie |
| `last_used_step` | none | — | nie |
| `method` | none | — | nie |
| `secret_ciphertext` | none | — | nie |
| `secret_iv` | none | — | nie |
| `secret_tag` | none | — | nie |
| `user_id` | pseudonymous | board_member | nie |

### `user_passwords`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `hash` | none | — | nie |
| `must_change` | none | — | nie |
| `set_at` | none | — | nie |
| `set_reason` | none | — | nie |
| `user_id` | pseudonymous | board_member | nie |

### `users`

| Kolumna | Dane osobowe | Podmiot | Eksport roczny |
|---|---|---|---|
| `created_at` | none | — | nie |
| `disabled_at` | none | — | nie |
| `display_name` | direct | board_member | nie |
| `email` | direct | board_member | nie |
| `id` | none | — | nie |

