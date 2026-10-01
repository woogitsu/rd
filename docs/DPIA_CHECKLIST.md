# Checklista DPIA (projekt — nie jest oceną prawną)

> To jest **lista kontrolna** do wypełnienia razem z Inspektorem Ochrony Danych (IOD)
> i administratorem danych (D-01). Nie zastępuje oceny skutków dla ochrony danych
> (DPIA) ani decyzji, czy DPIA jest w ogóle wymagana — to ustala administrator.
> Powiązane: [`docs/PRIVACY_INVENTORY.md`](./PRIVACY_INVENTORY.md) (wygenerowany
> z [`privacy/data-inventory.json`](../privacy/data-inventory.json)),
> [`docs/PROCESSORS.md`](./PROCESSORS.md), [`docs/DECISIONS.md`](./DECISIONS.md).

## Czy DPIA jest wymagana? (decyzja administratora)

- [ ] Ocena wstępna wykonana przez administratora/IOD — **nierozstrzygnięte w repo**.
- Właściwość organu nadzorczego (PL czy BE) zależy od D-01 i nie jest tu rozstrzygana.

## Czynniki ryzyka do oceny

- [ ] **Dzieci jako osoby szczególnie chronione** — schemat przechowuje imię i nazwisko
      ucznia (`students.first_name`/`last_name`) oraz pośrednio w wolnym tekście
      (patrz sekcja niżej). Środek: `src/pg/pii-check.js` (#152) ostrzega przed
      zapisem imienia dziecka w polu wolnego tekstu; publikacja publiczna protokołu
      z wykrytym imieniem jest blokowana.
- [ ] **Opieka dzielona / rodzeństwo** — dziecko może mieć dwóch opiekunów w różnych
      gospodarstwach (`student_guardians`); anonimizacja lub usunięcie jednego
      gospodarstwa nie może naruszyć relacji drugiego (patrz #91, testy rodzeństwa
      i dwóch opiekunów w `tests/families-core.test.js`, `tests/pg-families.test.js`).
- [ ] **Finanse rodzin** — kwoty i tytuły wpłat (`payment_entries`, `ledger_entries`)
      są w niezmiennej księdze; wolny tekst może zawierać imię dziecka (patrz niżej).
- [ ] **E-mail masowy** — migawka adresów w `email_campaign_recipients.email`;
      środek: `email_hash` do dziennika limitu/tłumienia bez jawnego adresu (do oceny
      IOD, czy sam skrót wymaga własnej retencji — patrz #91).
- [ ] **Zdjęcia** — `news_photos` zawiera znaczniki `depicts_children`,
      `identifiable_children`, zgodę (`explicit_license_granted`, `rights_status`)
      i możliwość wycofania (`revoked_at`); publikacja bez sprawdzonych praw jest
      zabroniona przez AGENTS.md.
- [ ] **Przedstawiciele klas jako rodzice-wolontariusze** — mają dostęp wyłącznie do
      przypisanych klas (macierz uprawnień `tests/pg-authz-matrix.test.js`); do oceny,
      czy zakres widoczności (D-08/D-09) jest wystarczająco wąski.
- [ ] **Transfer poza UE** — dostawcy w `docs/PROCESSORS.md`; status D-05 otwarty.
- [ ] **404 zamiast 403** — mechanizm ukrywania istnienia zasobu zamiast ujawniania
      odmowy dostępu (patrz `docs/AUTHORIZATION.md`) — środek ograniczający
      enumerację danych.
- [ ] **Niezmienny dziennik (`audit_events`)** — bez danych osobowych w treści zdarzeń
      (asercja w testach, np. `tests/audit-transaction-boundary.test.js`); do
      potwierdzenia, że żadne nowe zdarzenie nie loguje wolnego tekstu.
- [ ] **Brak PII w logach aplikacji** (`src/log.js`) — do potwierdzenia przy każdej
      zmianie logowania.
- [ ] **Klucze obiektów w Storage Bucket bez nazw** (`docs/DOCUMENTS.md`) — środek
      ograniczający wyciek nazwisk przez nazwy plików.

## Ryzyko: pola wolnego tekstu w niezmiennych tabelach (możliwe dane osobowe)

Każde poniższe pole może zostać wypełnione wolnym tekstem zawierającym dane osobowe
(np. imię i nazwisko dziecka w tytule przelewu) i **nie da się go poprawić ani
usunąć** po zapisie (triggery `*_no_change` / brak triggera w ogóle). Środek: #152 —
wspólna bramka `src/pg/pii-gate.js` (oparta na `src/pg/pii-check.js`) przed zapisem
we wszystkich trasach zapisu tych pól oraz blokada publikacji publicznej protokołu.
Heurystyka nie wykrywa nazwisk poza znanymi z roku szkolnego, więc nie zastępuje
odpowiedzialności osoby zapisującej.

| Kolumna | Typowe ryzyko |
|---|---|
| `payment_entries.reference` | tytuł przelewu z wyciągu, często imię i nazwisko dziecka |
| `payment_corrections.reason` | opis okoliczności rodzinnych przy zwrocie |
| `payment_allocation_reversals.reason` | powód cofnięcia części wpłaty, może opisywać rodzinę lub dziecko (#127) |
| `ledger_entries.description` | nazwisko wystawcy faktury / osoby rozliczanej |
| `ledger_corrections.reason` | jw. |
| `ledger_allocation_versions.reason` | jw. (powód zmiany przypisania do centrum kosztów, #117) |
| `ledger_opening_balance_adjustments.reason` | jw. |
| `bank_reconciliations.notes` | treść przepisana z wyciągu bankowego |
| `bank_reconciliations.confirmation_note` | jw. |
| `bank_reconciliations.abandon_reason` | powód porzucenia szkicu — może przepisywać treść z wyciągu |
| `bank_reconciliation_matches.revoke_reason` | uzasadnienie cofnięcia dopasowania z wyciągu |
| `bank_reconciliation_group_match_revocations.reason` | uzasadnienie cofnięcia dopasowania zbiorczego (przelew kilku rodzin, #127) |
| `meeting_agenda_items.description` | sprawa konkretnego ucznia w porządku obrad |
| `meetings.cancellation_reason` | powód odwołania zebrania (wewnętrzny, 3–500 znaków) — może wspomnieć osobę; nigdy nie trafia do dziennika zdarzeń ani na stronę publiczną (#113) |
| `meeting_reschedules.reason` | powód zmiany terminu zebrania (wewnętrzny) — j.w. (#113) |
| `meeting_agenda_versions.snapshot` | migawka tytułów i opisów punktów porządku obrad wysłanego w zawiadomieniu — może opisywać konkretne dzieci/rodziny; publicznie tylko tytuły zatwierdzonego zawiadomienia zebrania ogólnego (#113) |
| `meeting_minutes.body` | treść protokołu — może opisywać konkretne dzieci/rodziny |
| `meeting_minutes.change_note` | jw., przy poprawce protokołu |
| `meeting_minutes.approval_note` | jw. |
| `resolutions.body` | treść uchwały — może dotyczyć konkretnego ucznia |
| `resolutions.correction_reason` | uzasadnienie korekty uchwały |
| `resolution_execution_events.note` | notatka o postępie wykonania uchwały — może opisywać sytuację konkretnej rodziny (#102) |
| `guardian_contact_changes.reason` | opis sytuacji rodzinnej przy zmianie kontaktu |
| `guardian_update_requests.note` | uzasadnienie wniosku rodzica o zmianę kontaktu przez jednorazowy link (#140), może opisywać sytuację rodzinną |
| `enrollments.ended_reason` | powód odejścia ucznia ze szkoły, może opisywać sytuację rodzinną (#86) |
| `student_households.created_reason` | powód dodania członkostwa ucznia w gospodarstwie, może opisywać sytuację rodzinną (#86) |
| `student_households.ended_reason` | powód zakończenia członkostwa ucznia w gospodarstwie, jw. (#86) |
| `guardian_households.ended_reason` | powód zakończenia członkostwa opiekuna w gospodarstwie, jw. (#86, migracja 0163) |
| `news_photos.author` | imię i nazwisko autora zdjęcia |
| `news_photos.rights_note` | treść zgody/licencji, może zawierać imię i nazwisko |
| `news_photos.license_text` | jw. |
| `news_photos.alt_text` | opis zdjęcia może zawierać imiona dzieci |
| `news_photos.revocation_reason` | powód wycofania zgody, może zawierać dane osoby wycofującej |
| `email_campaigns.subject` | temat kampanii — do przeglądu przy zatwierdzeniu treści |
| `email_campaigns.body_text` | treść kampanii — do przeglądu przy zatwierdzeniu treści |
| `payment_references.revoke_reason` | uzasadnienie unieważnienia referencji OGM-VCS, może opisywać sytuację rodzinną (#83) |
| `payment_reference_revocations.reason` | jw. |
| `ledger_category_deactivations.reason` | powód wyłączenia kategorii może zawierać imię i nazwisko lub okoliczności rodzinne (#107) |
| `ledger_budget_adoptions.note` | uwaga przy przyjęciu preliminarza może zawierać imię i nazwisko lub okoliczności rodzinne (#107) |
| `financial_report_snapshots.supersede_reason` | powód korekty migawki sprawozdania rocznego jest wolnym tekstem i może zawierać imię i nazwisko; migawka jest niezmienna, więc treści nie da się usunąć (#125) |
| `audit_review_notes.body` | treść uwagi Komisji Rewizyjnej, odpowiedzi zarządu/skarbnika, zamknięcia i wniosku końcowego jest wolnym tekstem i może zawierać imię i nazwisko; zapis jest niezmienny, więc treści nie da się usunąć (#137, migracja 0176) |
| `ledger_entry_reviews.note` | uwaga przy zakwestionowaniu wydatku może zawierać imię i nazwisko lub okoliczności rodzinne (#97) |
| `resolution_spending_authorizations.note` | uzasadnienie kwoty upoważnienia może zawierać imię i nazwisko lub okoliczności rodzinne (#93) |
| `event_tasks.title` | tytuł zadania wolontariackiego może zawierać imię i nazwisko lub okoliczności rodzinne (#142) |
| `event_tasks.cancellation_reason` | powód odwołania zadania może zawierać imię i nazwisko lub okoliczności rodzinne (#142) |
| `document_status_events.reason` | powód zastąpienia/unieważnienia dokumentu może zawierać imię i nazwisko lub okoliczności rodzinne (#82) |
| `document_descriptions.title` | tytuł dokumentu może zawierać imię i nazwisko (np. „Zwrot dla rodziny Kowalski”) (#76/#313) |
| `document_descriptions.description` | opis dokumentu może zawierać imię i nazwisko lub okoliczności rodzinne (#76/#313) |
| `payment_refunds.reason` | uzasadnienie zwrotu wpłaty, może opisywać rodzinę lub dziecko (#138) |
| `payment_reassignments.reason` | uzasadnienie zmiany przypisania wpłaty do gospodarstwa (#138) |
| `ledger_transfers.description` | opis przeniesienia gotówka–bank, może zawierać nazwisko osoby (#152) |
| `ledger_opening_balances.note` | uwaga do bilansu otwarcia (#152) |
| `ledger_budget_lines.note` | uwaga do linii preliminarza (#152) |
| `meeting_minutes_publications.reason` | powód zmiany widoczności protokołu (#152) |
| `school_year_closure_checklist.note` | uwaga do punktu listy zamknięcia roku (#152) |
| `enrollment_history.reason` | uzasadnienie zmiany klasy, może opisywać sytuację rodzinną (#152) |
| `student_guardian_changes.reason` | uzasadnienie zmiany relacji opiekun–uczeń (#152) |
| `news_photos.source_detail` | opis źródła zdjęcia, może zawierać dane osoby przekazującej (#152) |
| `email_suppression_releases.confirmation_note` | uwaga do zwolnienia adresu z listy wykluczeń (#152) |
| `role_grant_requests.reject_reason` | opcjonalny powód odrzucenia lub wycofania wniosku o nadanie roli chronionej (0159, #146) — może wspomnieć osobę adresata; w dzienniku zdarzeń tylko flaga `reasonGiven`, tabela poza eksportem rocznym |

## Środki już istniejące (do odwołania w DPIA)

- MFA dla ról zarządu (`postgres/migrations/0013_mfa.sql`).
- Autoryzacja po stronie serwera dla każdego API (`docs/AUTHORIZATION.md`).
- Niezmienny dziennik zdarzeń z aktorem, czasem i identyfikatorem obiektu (AGENTS.md).
- Solony SHA-256 referencji bankowej zamiast tekstu jawnego przy uzgodnieniu
  (`postgres/migrations/0015_reconciliation.sql`).
- Klucze obiektów w Storage Bucket bez oryginalnej nazwy pliku (`docs/DOCUMENTS.md`).
- Bramka danych osobowych po stronie serwera dla pól wolnego tekstu w tabelach niezmiennych
  (`src/pg/pii-gate.js`, #152, `docs/PII_CHECK.md`): e-mail, IBAN i numer rejestru krajowego BE
  są odrzucane bez możliwości obejścia (422 `personal_data_forbidden`), telefon i znane imię
  wymagają potwierdzenia (422 `possible_personal_data`). Test
  `tests/pii-gate-coverage.test.js` wymaga bramki dla każdego pola `free_text` z tabeli niezmiennej.

## Do ustalenia przez zarząd/IOD

Patrz `docs/DECISIONS.md`: D-01, D-02, D-04, D-05, D-08, D-09, D-21 (nazwiska
członków Rady w publicznym protokole), D-03 (czy wolny tekst wymaga osobnej
klasyfikacji jako „pole importu”).
