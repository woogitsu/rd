# Katalog kodów błędów API (issue #160)

Serwer PostgreSQL (`src/pg/**`) zwraca błędy jako `{ "error": "<kod>" }`.
Ten katalog wylicza każdy kod, jego znaczenie po polsku (ten sam tekst co w
`shared/messages.js`, jedynym dziś miejscu tłumaczenia kodu na komunikat dla
użytkownika) i orientacyjną wskazówkę, czy klient (panel) powinien ponowić
żądanie automatycznie, czy poprawić dane i spróbować ponownie ręcznie.

**Status HTTP nie jest tu wypisany osobno.** Ten sam kod bywa zwracany z
różnym statusem w różnych modułach (np. `not_found` to najczęściej `404`, ale
bywa też częścią odpowiedzi `403` tam, gdzie moduł celowo nie rozróżnia
"nie istnieje" od "poza zakresem" — patrz `docs/AUTHORIZATION.md` i tabela
403 vs 404 w opisie issue #160). Przypisanie jednego kanonicznego statusu do
każdego kodu i opisanie per-moduł polityki 403 vs 404 zostaje do kolejnego
PR — patrz sekcja "Czego nie obejmuje ten dokument" niżej.

**Kolumna "czy ponawiać" to założenie tego PR, nie zweryfikowana polityka
zarządu.** Reguła: kody walidacji (`invalid_*`, `*_not_found`, `*_mismatch`,
`already_*`) — nie, popraw dane; kody współbieżności (`*_conflict`, `*_stale`,
idempotencja, `revision_conflict`) — tak, po odświeżeniu widoku; kody
niedostępności (`*_unavailable`, `timeout`, `retry_later`) — tak, po chwili;
`forbidden`/`unauthenticated`/`mfa_*` — nie, zależy od sesji i uprawnień, nie
od ponowienia. Reszta oznaczona jako "zależy od kontekstu" — wymaga przeglądu
modułu trasy, który ją zwraca.

Wygenerowane z listy kodów w `src/pg/**` (te same reguły wykrywania co
`tests/shared-api.test.js#serverErrorCodes`) i tekstów z
`shared/messages.js`. Test `tests/pg-api-errors-catalog.test.js` sprawdza, że
każdy kod z kodu źródłowego jest w tej tabeli (i odwrotnie — brak martwych
wpisów).

## Kody

| Kod | Znaczenie (po polsku, `shared/messages.js`) | Czy ponawiać |
| --- | --- | --- |
| `active_bank_match` | Wpis jest powiązany z uzgodnieniem w wersji roboczej. Najpierw cofnij powiązanie z powodem, dopiero potem popraw wpis. | Zależy od kontekstu (patrz moduł trasy). |
| `admin_exists` | Administrator już istnieje. Utworzenie pierwszego konta nie jest potrzebne. | Zależy od kontekstu (patrz moduł trasy). |
| `agenda_item_not_found` | Nie znaleziono punktu porządku obrad. | Nie — popraw dane żądania. |
| `agenda_position_taken` | Ta pozycja porządku obrad jest już zajęta. | Zależy od kontekstu (patrz moduł trasy). |
| `allocation_exceeds_net` | Suma przypisań przekracza kwotę wpisu po korektach. Najpierw zmień przypisanie. | Nie — popraw dane żądania. |
| `allocation_reason_required` | Zmiana przypisania wymaga podania powodu. | Nie — popraw dane żądania. |
| `allocation_version_conflict` | Przypisanie tego wpisu zostało w międzyczasie zmienione. Odśwież widok. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `already_matched_via_ledger` | Pozycja jest już dopasowana do wpisu księgi. | Nie — popraw dane żądania. |
| `already_matched_via_payment` | Pozycja jest już dopasowana do wpłaty. | Nie — popraw dane żądania. |
| `already_matched` | Pozycja jest już dopasowana. | Nie — popraw dane żądania. |
| `alt_text_required` | Podaj opis zdjęcia (tekst alternatywny) albo zaznacz, że jest czysto dekoracyjne. | Zależy od kontekstu (patrz moduł trasy). |
| `ambiguous_csv_delimiter` | Nie można ustalić separatora kolumn w pliku CSV (średnik, przecinek lub tabulator występują tyle samo razy). Wybierz separator ręcznie w polu „Separator” albo zapisz plik z jednym separatorem. | Nie — popraw dane żądania. |
| `ambiguous_local_time` | Ta godzina występuje dwa razy (zmiana czasu z letniego na zimowy). Wybierz, o które wystąpienie chodzi. | Zależy od kontekstu (patrz moduł trasy). |
| `approval_required` | Operacja wymaga wcześniejszego zatwierdzenia. | Nie — popraw dane żądania. |
| `approval_stale` | Zatwierdzenie jest nieaktualne, bo dane zmieniły się po nim. Zatwierdź ponownie. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `authorization_superseded` | Kwota upoważnienia zmieniła się w międzyczasie. Odśwież widok i spróbuj ponownie. | Zależy od kontekstu (patrz moduł trasy). |
| `backup_failed` | Kopia zapasowa bazy nie powiodła się. Sprawdź dziennik operacyjny. | Zależy od kontekstu (patrz moduł trasy). |
| `bank_import_not_configured` | Import wyciągu z pliku banku nie jest skonfigurowany. | Zależy od kontekstu (patrz moduł trasy). |
| `budget_empty` | Preliminarz tego roku nie ma jeszcze żadnej linii. | Zależy od kontekstu (patrz moduł trasy). |
| `budget_line_exists` | Ta kategoria ma już linię preliminarza. Zmień ją nową wersją. | Zależy od kontekstu (patrz moduł trasy). |
| `budget_line_not_found` | Nie znaleziono linii preliminarza. | Nie — popraw dane żądania. |
| `budget_line_superseded` | Ta wersja linii preliminarza została już zmieniona. Odśwież widok i zmień aktualną wersję. | Zależy od kontekstu (patrz moduł trasy). |
| `business_rule_violation` | Operacja jest niezgodna z aktualnym stanem danych (np. wpis jest zablokowany lub zatwierdzony). Odśwież widok i sprawdź stan. | Nie automatycznie — najpierw odśwież widok i sprawdź stan (odmowa reguły biznesowej z triggera bazy). |
| `campaign_audience_locked` | Odbiorcy tej kampanii wynikają z zebrania albo z kampanii źródłowej i nie można ich zmienić. | Nie — popraw dane żądania. |
| `campaign_locked` | Wysyłka jest zablokowana i nie można jej zmienić. | Zależy od kontekstu (patrz moduł trasy). |
| `campaign_not_draft` | Wysyłkę można zmieniać tylko jako szkic. | Zależy od kontekstu (patrz moduł trasy). |
| `campaign_not_found` | Nie znaleziono wysyłki. | Nie — popraw dane żądania. |
| `campaign_test_send_required` | Najpierw wyślij wiadomość testową z bieżącą treścią kampanii. Po zmianie treści test trzeba powtórzyć. | Nie — popraw dane żądania. |
| `cannot_disable_self` | Nie można wyłączyć własnego konta. | Zależy od kontekstu (patrz moduł trasy). |
| `cannot_grant_self` | Nie można nadać roli własnemu kontu. Potrzeba drugiej osoby z dostępem do panelu. | Zależy od kontekstu (patrz moduł trasy). |
| `cannot_reset_own_mfa` | Nie można zresetować weryfikacji dwuetapowej własnego konta. Poproś innego administratora. | Zależy od kontekstu (patrz moduł trasy). |
| `cash_below_zero` | Ta operacja doprowadziłaby saldo kasy poniżej zera. | Zależy od kontekstu (patrz moduł trasy). |
| `category_exists` | Kategoria o tej nazwie już istnieje w tym roku. | Zależy od kontekstu (patrz moduł trasy). |
| `category_inactive` | Kategoria jest już wyłączona. | Zależy od kontekstu (patrz moduł trasy). |
| `category_not_found` | Nie znaleziono kategorii księgi. | Nie — popraw dane żądania. |
| `checklist_incomplete` | Lista kontrolna nie jest ukończona. | Zależy od kontekstu (patrz moduł trasy). |
| `class_exists` | Klasa o tej nazwie już istnieje w tym roku szkolnym. | Zależy od kontekstu (patrz moduł trasy). |
| `class_map_required` | Podaj jawną mapę klas (klasa źródłowa → klasa docelowa albo null dla klasy końcowej). Bez mapy nic nie jest przenoszone. | Nie — popraw dane żądania. |
| `class_not_found` | Nie znaleziono klasy albo nie masz do niej dostępu. | Nie — popraw dane żądania. |
| `class_not_in_school_year` | Klasa nie należy do wskazanego roku szkolnego. | Zależy od kontekstu (patrz moduł trasy). |
| `class_required` | Wskaż klasę. | Nie — popraw dane żądania. |
| `class_scope_not_supported` | Ta rola nie ma tras ograniczonych do jednej klasy. Zostaw pole klasy puste. | Nie — popraw dane żądania. |
| `class_year_mismatch` | Klasa należy do innego roku szkolnego. | Nie — popraw dane żądania. |
| `closing_balance_out_of_range` | Saldo zamknięcia jest poza dozwolonym zakresem. | Zależy od kontekstu (patrz moduł trasy). |
| `commit_outcome_unknown` | Nie wiadomo, czy zapis został utrwalony (połączenie z bazą zerwało się przy zatwierdzaniu). Sprawdź aktualny stan i dopiero wtedy ponów operację. | Nie automatycznie — najpierw sprawdź stan (odśwież widok); ponowienie z tym samym `Idempotency-Key` jest bezpieczne tam, gdzie trasa go obsługuje. |
| `concurrent_version` | Ktoś inny zapisał zmianę w tym samym czasie. Odśwież widok. | Zależy od kontekstu (patrz moduł trasy). |
| `confirmation_required` | Potwierdź operację, wpisując wymagany identyfikator. | Nie — popraw dane żądania. |
| `conflict` | Dane zmieniły się w międzyczasie. Odśwież widok i spróbuj ponownie. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `consent_conflict` | Zapis zgody nie zgadza się z danymi zdjęcia. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `consent_not_found` | Nie znaleziono zgody o tym odwołaniu. | Nie — popraw dane żądania. |
| `consents_locked` | Zgód nie można zmienić w obecnym stanie wpisu. | Zależy od kontekstu (patrz moduł trasy). |
| `content_hash_mismatch` | Plik uszkodził się podczas przesyłania. Wyślij go ponownie. | Nie — popraw dane żądania. |
| `correction_exceeds_remaining_amount` | Korekta przekracza kwotę pozostałą po wcześniejszych korektach. | Zależy od kontekstu (patrz moduł trasy). |
| `data_request_not_found` | Nie znaleziono żądania. | Nie — popraw dane żądania. |
| `data_request_status_cannot_go_back` | Nie można cofnąć stanu żądania. | Zależy od kontekstu (patrz moduł trasy). |
| `date_outside_school_year` | Data wpisu jest poza rokiem szkolnym. | Zależy od kontekstu (patrz moduł trasy). |
| `difference_requires_note` | Różnica wymaga wpisania wyjaśnienia. | Zależy od kontekstu (patrz moduł trasy). |
| `document_active_content` | Plik odrzucony: zawiera potencjalnie aktywną treść (skrypt, załącznik, szyfrowanie) niedozwoloną w dokumentach Rady. | Zależy od kontekstu (patrz moduł trasy). |
| `document_content_missing` | Plik zniknął z magazynu. Zgłoś to administratorowi; metadane dokumentu pozostają w dzienniku. | Zależy od kontekstu (patrz moduł trasy). |
| `document_integrity_mismatch` | Plik w magazynie nie zgadza się z zapisaną sumą kontrolną. Zgłoś to administratorowi. | Nie — popraw dane żądania. |
| `document_malformed` | Plik odrzucony: jego struktura nie odpowiada zadeklarowanemu typowi (uszkodzony albo doklejone dodatkowe dane). | Zależy od kontekstu (patrz moduł trasy). |
| `document_preview_blocked` | Ten plik nie przechodzi bieżącej kontroli struktury, więc nie otworzy się w panelu. Można go pobrać; zgłoś go administratorowi. | Nie — plik trzeba pobrać albo zastąpić poprawnym. |
| `document_preview_unsupported` | Podglądu tego typu pliku nie ma. Pobierz plik. | Nie — popraw dane żądania. |
| `document_status_conflict` | Dokument ma już inny zapisany stan (zastąpiony albo unieważniony). Odśwież widok. | Zależy od kontekstu (patrz moduł trasy). |
| `document_status_replacement_not_active` | Dokument zastępujący jest już zastąpiony albo unieważniony. Wybierz inny. | Zależy od kontekstu (patrz moduł trasy). |
| `document_too_large` | Plik przekracza dozwolony rozmiar. | Zależy od kontekstu (patrz moduł trasy). |
| `duplicate_name` | Nazwy klas na liście powtarzają się. | Nie — popraw dane żądania. |
| `duplicate_photo` | To zdjęcie jest już dodane. | Nie — popraw dane żądania. |
| `duplicate_row` | Ten sam adres i klasa powtarzają się w partii. | Nie — popraw dane żądania. |
| `empty_document` | Plik jest pusty. | Zależy od kontekstu (patrz moduł trasy). |
| `empty_photo_file` | Plik zdjęcia jest pusty. | Nie — popraw dane żądania. |
| `ends_before_start` | Koniec nie może być wcześniej niż początek. | Zależy od kontekstu (patrz moduł trasy). |
| `event_cancelled` | Wydarzenie jest odwołane; odwołanie jest ostateczne. | Zależy od kontekstu (patrz moduł trasy). |
| `event_not_found` | Nie znaleziono wydarzenia albo nie masz do niego dostępu. | Nie — popraw dane żądania. |
| `event_not_public` | Publikować można tylko wydarzenie z odbiorcami „Publiczne”. | Zależy od kontekstu (patrz moduł trasy). |
| `event_task_already_cancelled` | To zadanie zostało już odwołane. | Zależy od kontekstu (patrz moduł trasy). |
| `event_task_not_found` | Nie znaleziono zadania albo nie masz do niego dostępu. | Nie — popraw dane żądania. |
| `event_task_signup_not_found` | Nie znaleziono zapisu. | Nie — popraw dane żądania. |
| `export_in_progress` | Eksport tego roku już trwa. Poczekaj na jego zakończenie i spróbuj ponownie. | Tak, po chwili (drugi równoczesny eksport tego samego roku). |
| `export_too_large` | Eksport jest za duży. Zawęź zakres. | Zależy od kontekstu (patrz moduł trasy). |
| `fingerprint_mismatch` | Dane różnią się od podglądu. Wyślij podgląd ponownie. | Nie — popraw dane żądania. |
| `followup_household_already_covered` | Co najmniej jedna rodzina jest już w kolejce innej kampanii uzupełniającej. Utwórz ponownie migawkę odbiorców i zatwierdź listę. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `followup_household_not_eligible` | Co najmniej jedna rodzina nie ma zatwierdzonego potwierdzenia „wiadomość nie wyszła”. Utwórz ponownie migawkę odbiorców i zatwierdź listę. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `followup_no_households` | Brak rodzin do kampanii uzupełniającej: żadne potwierdzenie „wiadomość nie wyszła” nie jest jeszcze zatwierdzone przez drugą osobę z zarządu albo rodziny są już w innym uzupełnieniu. | Zależy od kontekstu (patrz moduł trasy). |
| `followup_source_not_eligible` | Kampanię uzupełniającą można utworzyć tylko dla kampanii, która trafiła do kolejki wysyłki. | Nie — popraw dane żądania. |
| `forbidden` | Brak uprawnień do tej operacji w Twoim zakresie. | Nie — zależy od sesji/uprawnień, nie od ponowienia. |
| `four_eyes_required` | Tę operację musi zatwierdzić inna osoba niż autor. | Nie — popraw dane żądania. |
| `grant_four_eyes_required` | Nadanie roli zarządu, skarbnika albo administratora zatwierdza inny administrator niż wnioskodawca i osoba, która ma otrzymać rolę. | Nie — zatwierdza inny administrator. |
| `grant_not_found` | Nie znaleziono przydziału. | Nie — popraw dane żądania. |
| `grant_request_closed` | Ten wniosek o nadanie roli został już zatwierdzony, odrzucony lub wygasł. | Nie — odśwież listę wniosków. |
| `grant_request_expired` | Wniosek o nadanie roli wygasł. Złóż nowy wniosek. | Nie — złóż nowy wniosek. |
| `grant_request_not_found` | Nie znaleziono wniosku o nadanie roli. | Nie — popraw dane żądania. |
| `group_match_direction_mismatch` | Kierunek wpłaty lub wpisu nie pasuje do pozycji wyciągu (wpływ/wypływ). | Nie — popraw dane żądania. |
| `group_match_sum_mismatch` | Suma wpłat i wpisów nie równa się kwocie pozycji wyciągu. | Nie — popraw dane żądania. |
| `guardian_not_found` | Nie znaleziono opiekuna. | Nie — popraw dane żądania. |
| `guardian_outside_class` | Można zapisać wyłącznie opiekuna dziecka z przypisanej klasy w bieżącym roku. | Zależy od kontekstu (patrz moduł trasy). |
| `guardian_shared_outside_scope` | Ten opiekun ma też dziecko poza Twoją klasą. Zmianę kontaktu wykonuje zarząd bez ograniczenia do klasy. | Nie — zmianę wykonuje zarząd bez zawężenia do klasy. |
| `household_not_found` | Nie znaleziono gospodarstwa. | Nie — popraw dane żądania. |
| `idempotency_conflict` | Ten formularz był już wysłany z innymi danymi. Odśwież widok i sprawdź, czy zapis istnieje, zanim wyślesz ponownie. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `idempotency_key_required` | Brak identyfikatora operacji. Odśwież stronę i spróbuj ponownie. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `idempotency_key_reused` | Ten podgląd był już użyty dla innych danych. Wyślij podgląd ponownie. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `import_disabled` | Import jest wyłączony na tym środowisku. | Zależy od kontekstu (patrz moduł trasy). |
| `import_has_conflicts` | Import zawiera konflikty lub błędy. Popraw plik albo zaznacz pominięcie tych wierszy. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `inconsistent_matches` | Dopasowania są niespójne. Odśwież widok. | Zależy od kontekstu (patrz moduł trasy). |
| `invalid_access_kind` | Wybierz rodzaj odczytu z listy. | Nie — popraw dane żądania. |
| `invalid_agenda_order` | Nowa kolejność musi zawierać dokładnie wszystkie niewycofane punkty porządku obrad, każdy raz. Odśwież widok i spróbuj ponownie. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `invalid_allocation` | Niepoprawny podział wpisu na wydarzenia lub klasy. | Nie — popraw dane żądania. |
| `invalid_alt_text` | Podaj opis zdjęcia (tekst alternatywny). | Nie — popraw dane żądania. |
| `invalid_amount` | Niepoprawna kwota. Podaj kwotę w EUR większą od zera, np. 25,00. | Nie — popraw dane żądania. |
| `invalid_audience` | Wybierz odbiorców. | Nie — popraw dane żądania. |
| `invalid_author` | Niepoprawny autor. | Nie — popraw dane żądania. |
| `invalid_bic` | Numer BIC jest niepoprawny (8 albo 11 znaków). | Nie — popraw dane żądania. |
| `invalid_body_text` | Podaj treść informacji (1–20000 znaków). | Nie — popraw dane żądania. |
| `invalid_body` | Treść jest pusta albo za długa. | Nie — popraw dane żądania. |
| `invalid_campaign_id` | Niepoprawny identyfikator wysyłki. | Nie — popraw dane żądania. |
| `invalid_category` | Wybierz kategorię z listy. | Nie — popraw dane żądania. |
| `invalid_cell` | Niepoprawna wartość komórki. | Nie — popraw dane żądania. |
| `invalid_cents_value` | Niepoprawna kwota w EUR. | Nie — popraw dane żądania. |
| `invalid_checklist_item` | Niepoprawny punkt listy kontrolnej. | Nie — popraw dane żądania. |
| `invalid_class` | Niepoprawny identyfikator klasy. | Nie — popraw dane żądania. |
| `invalid_class_map` | Mapa klas jest niepoprawna (identyfikatory klas, nazwy do 60 znaków, najwyżej 200 wpisów). | Nie — popraw dane żądania. |
| `invalid_code` | Kod jest nieprawidłowy. Sprawdź aplikację i wpisz aktualny kod. | Nie — popraw dane żądania. |
| `invalid_columns` | Niepoprawne kolumny importu. | Nie — popraw dane żądania. |
| `invalid_confirmation_note` | Podaj uzasadnienie (od 3 do 1000 znaków). | Nie — popraw dane. |
| `invalid_consent` | Niepoprawny zapis zgody na publikację. | Nie — popraw dane żądania. |
| `invalid_consent_scope` | Wybierz zakres zgody z listy (strona Rady, druk, media społecznościowe). | Nie — popraw dane żądania. |
| `invalid_consent_valid_until` | Niepoprawna data ważności zgody (RRRR-MM-DD). | Nie — popraw dane żądania. |
| `invalid_content_type` | Serwer nie odczytał formatu danych. | Nie — popraw dane żądania. |
| `invalid_cost_center` | Wskazane wydarzenie lub klasa nie należy do roku tego wpisu. | Nie — popraw dane żądania. |
| `invalid_credentials` | Nieprawidłowy adres e-mail lub hasło. | Nie — popraw dane żądania. |
| `invalid_csv_header` | Plik CSV ma niepoprawny nagłówek. | Nie — popraw dane żądania. |
| `invalid_csv` | Nie udało się odczytać pliku CSV. | Nie — popraw dane żądania. |
| `invalid_csv_encoding` | Plik CSV ma nieznane kodowanie (w tekście są znaki zastępcze). Zapisz go jako „CSV UTF-8” albo wybierz kodowanie i wgraj ponownie. | Nie — popraw dane żądania. |
| `invalid_current_password` | Obecne hasło jest nieprawidłowe. | Nie — popraw dane żądania. |
| `invalid_cursor` | Nie udało się wczytać kolejnej strony wyników. Odśwież listę. | Nie — popraw dane żądania. |
| `invalid_date_range` | Data końca nie może być wcześniejsza niż data początku. | Nie — popraw dane żądania. |
| `invalid_date` | Niepoprawna data. | Nie — popraw dane żądania. |
| `invalid_datetime` | Niepoprawna data lub godzina. | Nie — popraw dane żądania. |
| `invalid_decision_note_ref` | Odwołanie do decyzji może mieć od 1 do 200 znaków. | Nie — popraw dane żądania. |
| `invalid_decision_ref` | Podaj odwołanie do decyzji (np. numer uchwały). | Nie — popraw dane żądania. |
| `invalid_decorative` | Niepoprawna wartość pola „zdjęcie dekoracyjne”. | Nie — popraw dane. |
| `invalid_depicts_children` | Zaznacz, czy zdjęcie przedstawia dzieci. | Nie — popraw dane żądania. |
| `invalid_description` | Opis jest za długi. | Nie — popraw dane żądania. |
| `invalid_display_name` | Nazwa wyświetlana może mieć najwyżej 100 znaków. | Nie — popraw dane żądania. |
| `invalid_disposition` | Nieznany sposób otwarcia pliku. Użyj podglądu albo pobrania. | Nie — popraw dane żądania. |
| `invalid_document_date` | Niepoprawna data dokumentu. | Nie — popraw dane żądania. |
| `invalid_document_id` | Niepoprawny identyfikator dokumentu. | Nie — popraw dane żądania. |
| `invalid_domain` | Wybierz obszar dziennika z listy. | Nie — popraw dane. |
| `invalid_due_on` | Podaj poprawną datę terminu odpowiedzi. | Nie — popraw dane żądania. |
| `invalid_effective_on` | Podaj poprawną datę. | Nie — popraw dane żądania. |
| `invalid_email` | Podaj poprawny adres e-mail. | Nie — popraw dane żądania. |
| `invalid_ended_on` | Podaj poprawną datę odejścia (RRRR-MM-DD). | Nie — popraw dane. |
| `invalid_entity_type` | Nieznany rodzaj obiektu w dzienniku. | Nie — popraw dane. |
| `invalid_event_id` | Niepoprawny identyfikator wydarzenia. | Nie — popraw dane żądania. |
| `invalid_exclusions` | Lista wykluczonych uczniów jest niepoprawna. | Nie — popraw dane żądania. |
| `invalid_execution_status` | Wybierz stan wykonania uchwały z listy. | Nie — popraw dane. |
| `invalid_expires_at` | Data wygaśnięcia musi być w przyszłości (najwyżej 3 lata). | Nie — popraw dane żądania. |
| `invalid_explicit_license` | Niepoprawna licencja zdjęcia. | Nie — popraw dane żądania. |
| `invalid_format` | Wybierz format eksportu z listy (CSV albo JSON). | Nie — popraw dane żądania. |
| `invalid_from` | Podaj poprawną datę początkową (RRRR-MM-DD). | Nie — popraw dane. |
| `invalid_iban` | Numer rachunku (IBAN) jest niepoprawny — sprawdź sumę kontrolną. | Nie — popraw dane żądania. |
| `invalid_id` | Niepoprawny identyfikator. | Nie — popraw dane żądania. |
| `invalid_idempotency_key` | Niepoprawny identyfikator operacji. Zamknij formularz i otwórz go ponownie. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `invalid_identifier` | Niepoprawny identyfikator. | Nie — popraw dane żądania. |
| `invalid_import` | Niepoprawne dane importu. | Nie — popraw dane żądania. |
| `invalid_invitation` | Zaproszenie jest nieważne, wygasło albo zostało już wykorzystane. | Nie — popraw dane żądania. |
| `invalid_invitation_batch_text` | Wklej wiersze w formacie „klasa; e-mail” (najwyżej 24 KB tekstu). | Nie — popraw dane żądania. |
| `invalid_json` | Serwer nie odczytał danych formularza. | Nie — popraw dane żądania. |
| `invalid_kind` | Nieznany rodzaj dokumentu. | Nie — popraw dane żądania. |
| `invalid_label` | Podaj nazwę roku szkolnego (maksymalnie 200 znaków). | Nie — popraw dane żądania. |
| `invalid_ledger_entry_id` | Niepoprawny identyfikator wpisu księgi. | Nie — popraw dane żądania. |
| `invalid_license_text` | Niepoprawna treść licencji. | Nie — popraw dane żądania. |
| `invalid_limit` | Niepoprawna liczba wyników na stronę. | Nie — popraw dane żądania. |
| `invalid_line_count` | Niepoprawna liczba pozycji wyciągu. | Nie — popraw dane żądania. |
| `invalid_link` | Niepoprawne powiązanie dokumentu. | Nie — popraw dane żądania. |
| `invalid_location` | Miejsce może mieć najwyżej 200 znaków. | Nie — popraw dane żądania. |
| `invalid_match_target` | Niepoprawny cel dopasowania. | Nie — popraw dane żądania. |
| `invalid_method` | Wybierz sposób wpłaty z listy. | Nie — popraw dane żądania. |
| `invalid_names` | Podaj nazwy klas (każda do 60 znaków). | Nie — popraw dane żądania. |
| `invalid_next_school_year` | Niepoprawny następny rok szkolny. | Nie — popraw dane żądania. |
| `invalid_notice_content` | Treść zawiadomienia nie nadaje się na wiadomość e-mail (znaki klamrowe, niedozwolone sformułowanie albo za długa treść). Popraw zebranie lub porządek obrad i przygotuj nową wersję. | Nie — popraw dane żądania. |
| `invalid_notice_rule` | Podaj razem minimalną liczbę dni zawiadomienia i źródło tej reguły albo zostaw oba pola puste. | Nie — popraw dane żądania. |
| `invalid_ogm_base` | Niepoprawna baza referencji płatności. | Nie — popraw dane żądania. |
| `invalid_ogm_reference` | Niepoprawna referencja płatności (oczekiwano 12 cyfr). | Nie — popraw dane żądania. |
| `invalid_options` | Niepoprawne ustawienia importu. | Nie — popraw dane żądania. |
| `invalid_or_expired_link` | Ten link jest nieprawidłowy albo już nieaktywny. | Nie — poproś o nowy link. |
| `invalid_organizer` | Organizator może mieć najwyżej 200 znaków. | Nie — popraw dane żądania. |
| `invalid_origin` | Żądanie odrzucone: niezgodne pochodzenie strony. Otwórz panel z adresu aplikacji. | Nie — popraw dane żądania. |
| `invalid_outcome` | Wybierz wynik odczytu z listy. | Nie — popraw dane żądania. |
| `invalid_overrides` | Lista zmian klasy docelowej jest niepoprawna. | Nie — popraw dane żądania. |
| `invalid_payee_name` | Podaj nazwę odbiorcy (maksymalnie 70 znaków). | Nie — popraw dane żądania. |
| `invalid_payload` | Niepoprawne dane importu. | Nie — popraw dane żądania. |
| `invalid_payment_id` | Niepoprawny identyfikator wpłaty. | Nie — popraw dane żądania. |
| `invalid_payment_link` | Niepoprawne powiązanie z wpłatą. | Nie — popraw dane żądania. |
| `invalid_photo_id` | Niepoprawny identyfikator zdjęcia. | Nie — popraw dane żądania. |
| `invalid_photos` | Niepoprawna lista zdjęć. | Nie — popraw dane żądania. |
| `invalid_plan_digest` | Brak poprawnego skrótu planu (planDigest) z podglądu. | Nie — popraw dane żądania. |
| `invalid_post_id` | Niepoprawny identyfikator wpisu. | Nie — popraw dane żądania. |
| `invalid_provider_pause_id` | Niepoprawny identyfikator wstrzymania wysyłki. | Nie — popraw dane żądania. |
| `invalid_quorum_rule` | Niepoprawna reguła quorum. | Nie — popraw dane żądania. |
| `invalid_reason` | Podaj powód (3–500 znaków). | Nie — popraw dane żądania. |
| `invalid_received_on` | Podaj poprawną datę wpłynięcia żądania. | Nie — popraw dane żądania. |
| `invalid_reference_text` | Opis wpłaty jest za długi albo zawiera niedozwolone znaki. | Nie — popraw dane żądania. |
| `invalid_reference` | Wskazany rok szkolny, klasa lub powiązany wpis nie istnieje albo jest poza Twoim zakresem. | Nie — popraw dane żądania. |
| `invalid_relation_kind` | Wybierz rodzaj powiązania uchwały z listy. | Nie — popraw dane. |
| `invalid_release_reason` | Wybierz jeden z dopuszczalnych powodów zdjęcia blokady. | Nie — popraw dane. |
| `invalid_replacement_document` | Dokument zastępujący musi istnieć i mieć ten sam rodzaj, rok szkolny i klasę. | Nie — popraw dane żądania. |
| `invalid_report_snapshot` | Wskazana migawka sprawozdania nie istnieje, nie jest zatwierdzona albo została zastąpiona. | Nie — popraw dane żądania. |
| `invalid_request` | Serwer odrzucił dane formularza. Sprawdź pola. | Nie — popraw dane żądania. |
| `invalid_reversal` | Tego przeniesienia nie można cofnąć w obecnym stanie. | Nie — popraw dane żądania. |
| `invalid_revision` | Brak numeru wersji. Odśwież widok. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `invalid_rights_note` | Niepoprawna notatka o prawach. | Nie — popraw dane żądania. |
| `invalid_role` | Wybierz rolę z listy. | Nie — popraw dane żądania. |
| `invalid_row_format` | Wiersz musi mieć dwie kolumny: klasa i e-mail. | Nie — popraw dane żądania. |
| `invalid_row_numbers` | Niepoprawne numery wierszy. | Nie — popraw dane żądania. |
| `invalid_rows` | Niepoprawne wiersze importu. | Nie — popraw dane żądania. |
| `invalid_school_year_id` | Niepoprawny identyfikator roku szkolnego. | Nie — popraw dane żądania. |
| `invalid_school_year` | Niepoprawny identyfikator roku szkolnego. | Nie — popraw dane żądania. |
| `invalid_send_not_before` | Podaj poprawną datę i godzinę startu wysyłki. | Nie — popraw dane. |
| `invalid_signature` | Niepoprawny podpis żądania. | Nie — popraw dane żądania. |
| `invalid_signup_target` | Wskaż dokładnie jedną osobę: opiekuna albo konto. | Nie — popraw dane żądania. |
| `invalid_slots_needed` | Liczba potrzebnych miejsc musi być od 1 do 200. | Nie — popraw dane żądania. |
| `invalid_source_detail` | Niepoprawny opis źródła. | Nie — popraw dane żądania. |
| `invalid_source_document` | Niepoprawny dokument źródłowy. | Nie — popraw dane żądania. |
| `invalid_source` | Niepoprawne źródło wpisu. | Nie — popraw dane żądania. |
| `invalid_statement_file` | Nie udało się odczytać pliku wyciągu. Sprawdź format pliku. | Nie — popraw dane żądania. |
| `invalid_statement_line` | Niepoprawna pozycja wyciągu. | Nie — popraw dane żądania. |
| `invalid_status` | Niepoprawny status. | Nie — popraw dane żądania. |
| `invalid_taken_on` | Niepoprawna data wykonania zdjęcia. | Nie — popraw dane żądania. |
| `invalid_title` | Tytuł musi mieć od 3 do 200 znaków. | Nie — popraw dane żądania. |
| `invalid_to` | Podaj poprawną datę końcową (RRRR-MM-DD). | Nie — popraw dane. |
| `invalid_token` | Kod jest nieważny, wygasł albo został już użyty. | Nie — popraw dane żądania. |
| `invalid_transition` | Tego kroku nie można wykonać w obecnym stanie. Odśwież widok. | Nie — popraw dane żądania. |
| `invalid_ttl` | Ważność zaproszenia: od 1 do 336 godzin. | Nie — popraw dane żądania. |
| `invalid_user_id` | Niepoprawny identyfikator konta. | Nie — popraw dane żądania. |
| `invalid_window` | Niepoprawny zakres dat. | Nie — popraw dane żądania. |
| `invalid_year_end_confirmation` | Potwierdzenie rozbieżności wymaga jednego z dozwolonych powodów i widzianych różnic w centach. | Nie — popraw dane żądania. |
| `invalid_year_order` | Rok docelowy musi zaczynać się później niż rok źródłowy. | Nie — popraw dane żądania. |
| `invitation_already_accepted` | Zaproszenie zostało już przyjęte. | Zależy od kontekstu (patrz moduł trasy). |
| `invitation_batch_empty` | Brak wierszy do zaproszenia. Wklej co najmniej jeden wiersz „klasa; e-mail”. | Nie — popraw dane żądania. |
| `invitation_batch_invalid` | Partia ma błędne wiersze. Popraw je w podglądzie i zatwierdź ponownie. | Nie — popraw dane żądania. |
| `invitation_batch_stale` | Dane zmieniły się od podglądu zaproszeń. Wygeneruj podgląd ponownie. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `invitation_not_found` | Nie znaleziono zaproszenia. | Nie — popraw dane żądania. |
| `invitation_not_pending` | To zaproszenie nie oczekuje już na przyjęcie. Utwórz nowe zaproszenie. | Zależy od kontekstu (patrz moduł trasy). |
| `invitation_pending` | Dla tego adresu i zakresu istnieje już oczekujące zaproszenie. | Zależy od kontekstu (patrz moduł trasy). |
| `last_admin_grant` | Nie można odebrać sobie ostatniego aktywnego przydziału administratora. | Zależy od kontekstu (patrz moduł trasy). |
| `ledger_correction_required` | Najpierw skoryguj powiązany wpis księgi o tę samą kwotę, dopiero potem powtórz tę operację. | Nie — popraw dane żądania. |
| `ledger_entry_already_corrected_to_zero` | Wpis jest już w pełni skorygowany do zera. Nie można go przeksięgować. | Zależy od kontekstu (patrz moduł trasy). |
| `ledger_entry_already_replaced` | Ten wpis został już przeksięgowany. | Zależy od kontekstu (patrz moduł trasy). |
| `ledger_entry_not_found` | Nie znaleziono wpisu księgi. | Nie — popraw dane żądania. |
| `link_used` | Ten link został już wykorzystany. | Nie — link jest jednorazowy, poproś o nowy. |
| `login_busy` | Serwer jest chwilowo przeciążony logowaniami. Spróbuj ponownie za kilka sekund. | Tak — po chwili. |
| `match_already_revoked` | Dopasowanie zostało już wycofane. | Zależy od kontekstu (patrz moduł trasy). |
| `match_amount_mismatch` | Kwoty dopasowania się nie zgadzają. | Nie — popraw dane żądania. |
| `match_batch_duplicate` | Ta sama pozycja lub wpłata występuje w partii więcej niż raz. | Nie — popraw dane żądania. |
| `match_batch_empty` | Wybierz co najmniej jedną parę pozycji i wpłaty. | Nie — popraw dane żądania. |
| `match_batch_rejected` | Nie zatwierdzono żadnej pary: część wybranych par jest niepoprawna. Odśwież propozycje i wybierz ponownie. | Tak, po odświeżeniu propozycji (lista `failures` wskazuje odrzucone pary). |
| `match_batch_too_large` | Za dużo par w jednej partii. Zatwierdź mniejszą liczbę naraz. | Nie — popraw dane żądania. |
| `match_method_mismatch` | Sposób wpłaty nie pasuje do pozycji wyciągu. | Nie — popraw dane żądania. |
| `match_not_found` | Nie znaleziono dopasowania. | Nie — popraw dane żądania. |
| `matched_in_other_reconciliation` | Ten wpis lub wpłata jest już dopasowany w innym uzgodnieniu tego roku. | Nie — popraw dane żądania. |
| `meeting_cancelled` | Zebranie zostało odwołane i nie przyjmuje już zmian. | Nie — popraw dane żądania. |
| `meeting_not_found` | Nie znaleziono zebrania. | Nie — popraw dane żądania. |
| `meeting_not_reschedulable` | Termin można zmienić tylko dla zebrania w szkicu lub zaplanowanego. | Nie — popraw dane żądania. |
| `meeting_not_scheduled` | Zawiadomienie można zatwierdzić dopiero dla zebrania w stanie „zaplanowane”. | Nie — popraw dane żądania. |
| `meeting_notice_closed` | Dla tego zebrania nie można już przygotować zawiadomienia. | Nie — popraw dane żądania. |
| `meeting_status_transition_invalid` | Ta zmiana stanu zebrania jest niedozwolona. | Nie — popraw dane żądania. |
| `method_not_allowed` | Ta operacja jest niedostępna. | Zależy od kontekstu (patrz moduł trasy). |
| `mfa_enrollment_required` | Twoja rola wymaga weryfikacji dwuetapowej. Skonfiguruj aplikację uwierzytelniającą. | Nie — popraw dane żądania. |
| `mfa_key_missing` | Weryfikacja dwuetapowa jest chwilowo niedostępna (brak klucza do odszyfrowania). Skontaktuj się z administratorem. | Nie — zależy od sesji i uprawnień. |
| `mfa_locked` | Zbyt wiele błędnych kodów. Spróbuj ponownie za kilkanaście minut. | Nie — zależy od sesji/uprawnień, nie od ponowienia. |
| `mfa_required` | Potwierdź logowanie kodem z aplikacji uwierzytelniającej. | Nie — popraw dane żądania. |
| `mfa_unavailable` | Weryfikacja dwuetapowa jest chwilowo niedostępna. Skontaktuj się z administratorem. | Tak, po chwili (usługa/zasób chwilowo niedostępne). |
| `minutes_contain_personal_data` | Protokół zawiera możliwe dane osobowe (imię i nazwisko, e-mail albo IBAN) — publikacja publiczna jest zablokowana. | Nie — popraw dane żądania. |
| `minutes_four_eyes_required` | Protokół zatwierdza inna osoba niż jego autor. | Zależy od kontekstu (patrz moduł trasy). |
| `minutes_not_found` | Nie znaleziono wersji protokołu. | Nie — popraw dane żądania. |
| `next_school_year_not_found` | Nie znaleziono następnego roku szkolnego. | Nie — popraw dane żądania. |
| `next_year_opening_balance_exists` | Bilans otwarcia następnego roku już istnieje. | Zależy od kontekstu (patrz moduł trasy). |
| `no_classes_in_school_year` | Rok szkolny nie ma zdefiniowanych klas. | Zależy od kontekstu (patrz moduł trasy). |
| `no_recipients` | Wysyłka nie ma odbiorców. | Zależy od kontekstu (patrz moduł trasy). |
| `non_finite_number` | Eksport zawiera niepoprawną liczbę. | Zależy od kontekstu (patrz moduł trasy). |
| `nonexistent_local_time` | Ta godzina nie istnieje w Brukseli (zmiana czasu z zimowego na letni). Wybierz inną godzinę. | Zależy od kontekstu (patrz moduł trasy). |
| `not_first_school_year` | Bilans otwarcia można wpisać ręcznie tylko dla pierwszego roku szkolnego w systemie. | Zależy od kontekstu (patrz moduł trasy). |
| `not_found` | Nie znaleziono zasobu albo nie masz do niego dostępu. | Zależy od kontekstu (patrz moduł trasy). |
| `not_resolvable` | Tej wiadomości nie można jeszcze rozstrzygnąć. | Nie — popraw dane żądania. |
| `nothing_to_promote` | Plan nie zawiera żadnego ucznia do przeniesienia. | Nie — popraw dane żądania. |
| `notice_calendar_unavailable` | Plik kalendarza jest dostępny tylko dla najnowszego zatwierdzonego zawiadomienia. | Nie — popraw dane żądania. |
| `notice_campaign_audience_unsupported` | Dla zebrania zarządu nie tworzymy jeszcze szkicu kampanii — lista zaproszonych kont nie jest obsługiwana. | Nie — popraw dane żądania. |
| `notice_four_eyes_required` | Zawiadomienie zatwierdza inna osoba niż jego autor. | Nie — popraw dane żądania. |
| `notice_not_approved` | Szkic kampanii powstaje tylko z zatwierdzonego zawiadomienia. | Nie — popraw dane żądania. |
| `notice_not_found` | Nie znaleziono zawiadomienia. | Nie — popraw dane żądania. |
| `notice_not_latest` | Istnieje nowsza wersja zawiadomienia. Wróć do jej treści. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `notice_outdated` | Termin, miejsce albo porządek obrad zmieniły się po przygotowaniu zawiadomienia. Przygotuj nową wersję. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `notice_requires_agenda` | Zawiadomienie wymaga co najmniej jednego niewycofanego punktu porządku obrad. | Nie — popraw dane żądania. |
| `notice_up_to_date` | Zatwierdzone zawiadomienie odpowiada aktualnemu zebraniu — nowa wersja nie jest potrzebna. | Nie — popraw dane żądania. |
| `offset_not_valid_in_europe_brussels` | Wybrane przesunięcie czasu nie pasuje do tej daty w Brukseli. | Zależy od kontekstu (patrz moduł trasy). |
| `opening_balance_exists` | Bilans otwarcia dla tego roku szkolnego już istnieje. | Zależy od kontekstu (patrz moduł trasy). |
| `opening_balance_not_found` | Nie znaleziono bilansu otwarcia dla tego roku szkolnego. | Nie — popraw dane żądania. |
| `outbox_not_found` | Nie znaleziono tej wiadomości w kolejce. | Nie — popraw dane żądania. |
| `outbox_resolution_not_found` | Nie znaleziono tego rozstrzygnięcia w kampanii. Odśwież listę. | Nie — popraw dane żądania. |
| `password_mismatch` | Hasła nie są takie same. | Nie — popraw dane żądania. |
| `password_required` | Podaj hasło. | Nie — popraw dane żądania. |
| `password_too_long` | Hasło jest za długie. | Zależy od kontekstu (patrz moduł trasy). |
| `password_unchanged` | Nowe hasło musi być inne niż obecne. | Zależy od kontekstu (patrz moduł trasy). |
| `payment_allocation_already_reversed` | Ta część wpłaty została już cofnięta. | Nie — popraw dane żądania. |
| `payment_allocation_exceeds_net` | Suma części wpłaty przekroczyłaby jej kwotę po korektach i zwrotach. Najpierw cofnij część. | Nie — popraw dane żądania. |
| `payment_allocation_household_exists` | To gospodarstwo ma już część tej wpłaty. Cofnij ją, jeśli kwota jest błędna. | Nie — popraw dane żądania. |
| `payment_allocation_not_found` | Nie znaleziono tej części wpłaty. | Nie — popraw dane żądania. |
| `payment_already_assigned` | Wpłata jest już przypisana do rodziny. | Zależy od kontekstu (patrz moduł trasy). |
| `payment_already_linked` | Wpłata jest już powiązana z innym wpisem. | Zależy od kontekstu (patrz moduł trasy). |
| `payment_amount_mismatch` | Kwota wpłaty nie zgadza się z powiązanym wpisem księgi. Odśwież widok i sprawdź dane. | Nie — popraw dane żądania. |
| `payment_cannot_be_corrected` | Tej wpłaty nie można skorygować w obecnym stanie. | Zależy od kontekstu (patrz moduł trasy). |
| `payment_cannot_be_refunded` | Tej wpłaty nie można zwrócić w obecnym stanie. | Zależy od kontekstu (patrz moduł trasy). |
| `payment_has_allocations` | Wpłata jest podzielona na gospodarstwa. Najpierw cofnij części. | Nie — popraw dane żądania. |
| `payment_not_assigned` | Wpłata nie jest przypisana do żadnej rodziny. | Zależy od kontekstu (patrz moduł trasy). |
| `payment_not_found` | Nie znaleziono wpłaty albo nie masz do niej dostępu. | Nie — popraw dane żądania. |
| `payment_reassignment_household_mismatch` | Nie można przepisać wpłaty na tę rodzinę — powiązany wpis księgi wskazuje inną rodzinę. | Nie — popraw dane żądania. |
| `payment_reassignment_same_household` | Wpłata jest już przypisana do tej rodziny. | Zależy od kontekstu (patrz moduł trasy). |
| `payment_reference_already_active` | To gospodarstwo ma już aktywną referencję płatności w tym roku. Najpierw ją unieważnij. | Zależy od kontekstu (patrz moduł trasy). |
| `payment_reference_already_revoked` | Ta referencja płatności jest już unieważniona. | Zależy od kontekstu (patrz moduł trasy). |
| `payment_reference_not_found` | Nie znaleziono referencji płatności. | Nie — popraw dane żądania. |
| `pending_admin_invitation` | Istnieje już oczekujące zaproszenie administratora. Poczekaj albo je unieważnij. | Zależy od kontekstu (patrz moduł trasy). |
| `personal_data_forbidden` | Tekst zawiera adres e-mail, numer rachunku (IBAN) albo numer rejestru krajowego. Ten zapis jest niezmienny i trafia do eksportu — usuń te dane osobowe i zapisz ponownie (nie można tego potwierdzić). | Nie — popraw dane żądania. |
| `photo_file_exists` | To zdjęcie ma już przesłany inny plik. Zarejestruj nowe zdjęcie, żeby przesłać inny plik. | Nie — popraw dane żądania. |
| `photo_file_integrity_mismatch` | Zapisany plik zdjęcia nie zgadza się z zapisanym skrótem. Zgłoś to administratorowi. | Zależy od kontekstu (patrz moduł trasy). |
| `photo_file_malformed` | Plik zdjęcia odrzucony: jego struktura nie odpowiada zadeklarowanemu typowi. | Nie — popraw dane żądania. |
| `photo_file_too_large` | Plik zdjęcia przekracza dozwolony rozmiar. | Nie — popraw dane żądania. |
| `photo_not_found` | Nie znaleziono zdjęcia. | Nie — popraw dane żądania. |
| `photo_revoked` | Zgoda na publikację zdjęcia została wycofana. | Zależy od kontekstu (patrz moduł trasy). |
| `photos_require_school_wide_role` | Zdjęcia może dodawać tylko osoba z uprawnieniami dla całej szkoły. | Zależy od kontekstu (patrz moduł trasy). |
| `plan_stale` | Dane zmieniły się od podglądu promocji. Wygeneruj podgląd ponownie. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `plan_too_large` | Plan promocji jest zbyt duży (najwyżej 2000 uczniów). Skontaktuj się z administratorem. | Nie — popraw dane żądania. |
| `possible_personal_data` | Ten tekst zostanie zapisany na stałe i trafi do eksportu. Usuń dane osobowe albo potwierdź, że to konieczne. | Nie — popraw dane żądania. |
| `post_not_found` | Nie znaleziono wpisu. | Nie — popraw dane żądania. |
| `post_withdrawn` | Wpis został wycofany. | Zależy od kontekstu (patrz moduł trasy). |
| `preview_account_limit` | Wyczerpano dzienny limit wiadomości testowych dla tego konta. Spróbuj jutro. | Zależy od kontekstu (patrz moduł trasy). |
| `preview_campaign_limit` | Wyczerpano limit wiadomości testowych dla tej kampanii. | Zależy od kontekstu (patrz moduł trasy). |
| `preview_required` | Najpierw wyślij podgląd importu. | Nie — popraw dane żądania. |
| `preview_stale` | Dane w bazie zmieniły się od podglądu. Wyślij podgląd ponownie. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `privacy_notice_missing` | Brak opublikowanej informacji o przetwarzaniu danych. Opublikuj ją, zanim zatwierdzisz import. | Zależy od kontekstu (patrz moduł trasy). |
| `privacy_notice_not_approved` | Najpierw zatwierdź tę wersję (inna osoba niż autor). | Zależy od kontekstu (patrz moduł trasy). |
| `privacy_notice_not_draft` | Tę wersję już zatwierdzono albo opublikowano. | Zależy od kontekstu (patrz moduł trasy). |
| `privacy_notice_not_found` | Nie znaleziono tej wersji informacji. | Nie — popraw dane żądania. |
| `production_requires_flag` | Uruchomienie w środowisku produkcyjnym wymaga jawnego potwierdzenia. | Zależy od kontekstu (patrz moduł trasy). |
| `production_restore_requires_allow_production` | Odtworzenie na produkcji wymaga osobnego potwierdzenia. | Zależy od kontekstu (patrz moduł trasy). |
| `provider_pause_not_found` | Nie znaleziono tego wstrzymania wysyłki. Odśwież widok. | Nie — popraw dane żądania. |
| `public_copy_requires_license` | Publiczna kopia wymaga zapisanej licencji lub zgody. | Zależy od kontekstu (patrz moduł trasy). |
| `quorum_rule_source_required` | Podaj źródło reguły quorum (np. regulamin). | Nie — popraw dane żądania. |
| `rate_limited` | Zbyt wiele prób w krótkim czasie. Spróbuj ponownie za chwilę. | Zależy od kontekstu (patrz moduł trasy). |
| `read_only` | Portal działa chwilowo w trybie tylko do odczytu. Zmiany będą możliwe po zakończeniu prac technicznych. | Zależy od kontekstu (patrz moduł trasy). |
| `recipients_hash_mismatch` | Lista odbiorców zmieniła się od zatwierdzenia. Sprawdź ją i zatwierdź ponownie. | Nie — popraw dane żądania. |
| `reconciliation_abandoned` | Szkic uzgodnienia został porzucony i nie można go już zmienić ani potwierdzić. | Nie — utwórz nowy szkic. |
| `reconciliation_confirmed` | Uzgodnienie jest już potwierdzone i nie można go zmienić. | Zależy od kontekstu (patrz moduł trasy). |
| `reconciliation_has_active_matches` | Szkic ma aktywne dopasowania — cofnij je, zanim porzucisz szkic. | Tak — po cofnięciu dopasowań. |
| `reconciliation_not_found` | Nie znaleziono uzgodnienia. | Nie — popraw dane żądania. |
| `recovery_four_eyes_required` | Reset hasła lub MFA konta z rolą zarządu, skarbnika albo administratora zatwierdza inna osoba niż wnioskodawca i właściciel konta. | Nie — zatwierdza inny administrator. |
| `recovery_request_closed` | Ten wniosek został już zatwierdzony, odrzucony lub wygasł. | Nie — odśwież listę wniosków. |
| `recovery_request_expired` | Wniosek wygasł. Złóż nowy wniosek o reset konta. | Nie — złóż nowy wniosek. |
| `recovery_request_not_found` | Nie znaleziono wniosku o reset konta. | Nie — popraw dane żądania. |
| `refund_exceeds_remaining_amount` | Zwrot przekracza kwotę pozostałą po wcześniejszych korektach i zwrotach. | Zależy od kontekstu (patrz moduł trasy). |
| `relation_ended` | Ta relacja opiekuna z uczniem została już zakończona. Zmiana nie jest możliwa. | Zależy od kontekstu (patrz moduł trasy). |
| `release_reason_not_allowed` | Blokadę po skardze lub wypisaniu można zgłosić do zdjęcia wyłącznie z powodem „na wniosek rodzica”. | Zależy od kontekstu (patrz moduł trasy). |
| `replacement_target_mismatch` | Przeksięgowanie nie zgadza się z zastępowanym wpisem. Odśwież widok i spróbuj ponownie. | Nie — popraw dane żądania. |
| `report_snapshot_content_exists` | Migawka o tej treści już istnieje i została zastąpiona. Sprawozdanie nie zmieniło się od tamtej wersji. | Nie — popraw dane żądania. |
| `report_snapshot_integrity_failed` | Zapisana treść migawki nie zgadza się z jej skrótem SHA-256. Zgłoś to administratorowi. | Nie — wymaga interwencji administratora. |
| `report_snapshot_not_found` | Nie znaleziono migawki sprawozdania. | Nie — popraw dane żądania. |
| `report_snapshot_superseded` | Migawka została zastąpiona nowszą. Otwórz bieżącą migawkę roku. | Nie — odśwież widok. |
| `report_snapshot_supersedes_required` | Rok ma już migawkę sprawozdania. Wskaż bieżącą migawkę i powód korekty. | Nie — popraw dane żądania. |
| `representative_already_assigned` | Ta osoba jest już przedstawicielem tej klasy w tym roku. | Nie — popraw dane żądania. |
| `request_already_consumed` | Ten wniosek o zdjęcie blokady został już rozpatrzony. | Zależy od kontekstu (patrz moduł trasy). |
| `request_not_found` | Nie znaleziono wniosku. | Nie — popraw dane żądania. |
| `request_too_large` | Za dużo danych w jednym żądaniu. | Zależy od kontekstu (patrz moduł trasy). |
| `reschedule_no_change` | Podany termin jest taki sam jak obecny. | Nie — popraw dane żądania. |
| `resolution_expense_only` | Uchwałę jako upoważnienie można wskazać tylko przy wydatku. | Zależy od kontekstu (patrz moduł trasy). |
| `resolution_final_immutable` | Uchwała przyjęta lub odrzucona jest niezmienna. Użyj poprawki zapisu. | Zależy od kontekstu (patrz moduł trasy). |
| `resolution_not_adopted` | Wskazana uchwała nie jest przyjęta. | Zależy od kontekstu (patrz moduł trasy). |
| `resolution_not_approvable` | Zatwierdzenia drugiej osoby wymaga tylko potwierdzenie, że wiadomość nie wyszła. | Nie — popraw dane żądania. |
| `resolution_not_current` | Wskazana uchwała ma nowszą wersję (poprawkę). Wybierz aktualną wersję. | Zależy od kontekstu (patrz moduł trasy). |
| `resolution_not_decided` | Stan wykonania można zapisać tylko dla podjętej uchwały. | Zależy od kontekstu (patrz moduł trasy). |
| `resolution_not_found` | Nie znaleziono uchwały. | Nie — popraw dane żądania. |
| `resolution_number_required` | Uchwała przyjęta wymaga numeru. | Nie — popraw dane żądania. |
| `resolution_number_taken` | Ten numer uchwały jest już zajęty w tym roku szkolnym. | Zależy od kontekstu (patrz moduł trasy). |
| `resolution_reference_mismatch` | Referencja uchwały nie zgadza się z numerem wskazanej uchwały. | Nie — popraw dane żądania. |
| `resolution_required` | Ten wydatek wymaga wskazania uchwały. | Nie — popraw dane żądania. |
| `restore_drill_failed` | Próba odtworzenia kopii nie powiodła się. Sprawdź dziennik operacyjny. | Zależy od kontekstu (patrz moduł trasy). |
| `restore_report_bad_identifier` | Raport zgodności odrzucił nieprawidłową nazwę tabeli. Sprawdź schemat bazy. | Zależy od kontekstu (patrz moduł trasy). |
| `retry_later` | Baza danych jest chwilowo przeciążona. Spróbuj ponownie za chwilę. | Tak, po chwili (usługa/zasób chwilowo niedostępne). |
| `review_expense_only` | Weryfikacja drugiej osoby dotyczy wyłącznie wydatków. | Zależy od kontekstu (patrz moduł trasy). |
| `revision_conflict` | Ktoś zmienił dane w międzyczasie. Odśwież widok i dopiero wtedy powtórz operację. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `role_pending_decision` | Ta rola nie daje dziś dostępu do żadnego panelu (decyzja zarządu i szkoły jeszcze nie zapadła). Konto powstałoby bez żadnej funkcji. | Nie — popraw dane żądania. |
| `same_school_year` | Rok źródłowy i docelowy muszą być różne. | Nie — popraw dane żądania. |
| `school_year_closed` | Rok szkolny jest zamknięty. Zmiany nie są możliwe. | Zależy od kontekstu (patrz moduł trasy). |
| `school_year_exists` | Taki rok szkolny już istnieje. | Zależy od kontekstu (patrz moduł trasy). |
| `school_year_not_finished` | Rok szkolny jeszcze się nie zakończył. | Zależy od kontekstu (patrz moduł trasy). |
| `school_year_not_found` | Nie znaleziono roku szkolnego. | Nie — popraw dane żądania. |
| `self_approval_forbidden` | Nie można zatwierdzić własnego wpisu. Zatwierdzić musi inna osoba. | Zależy od kontekstu (patrz moduł trasy). |
| `sending_disabled` | Wysyłka e-mail jest wyłączona w tym środowisku. | Zależy od kontekstu (patrz moduł trasy). |
| `service_unavailable` | Usługa jest chwilowo niedostępna. Spróbuj ponownie za chwilę. | Tak, po chwili (usługa/zasób chwilowo niedostępne). |
| `snapshot_required` | Najpierw utwórz kopię stanu danych. | Nie — popraw dane żądania. |
| `statement_account_mismatch` | Rachunek w pliku wyciągu nie jest zatwierdzonym rachunkiem Rady. | Nie — popraw dane żądania. |
| `statement_account_unsupported` | Ten rodzaj numeru rachunku w wyciągu nie jest obsługiwany. | Nie — popraw dane żądania. |
| `statement_already_imported` | Ten plik wyciągu został już zaimportowany. | Nie — popraw dane żądania. |
| `statement_amount_out_of_range` | Kwota w wyciągu przekracza dozwolony zakres. | Nie — popraw dane żądania. |
| `statement_currency_unsupported` | Obsługiwane są wyłącznie wyciągi w EUR. | Nie — popraw dane żądania. |
| `statement_date_outside_school_year` | Data wyciągu jest poza rokiem szkolnym. | Zależy od kontekstu (patrz moduł trasy). |
| `statement_line_after_statement_date` | Pozycja wyciągu ma datę późniejszą niż data wyciągu. | Zależy od kontekstu (patrz moduł trasy). |
| `statement_line_not_found` | Nie znaleziono pozycji wyciągu. | Nie — popraw dane żądania. |
| `statement_line_not_income` | Z tej pozycji wyciągu nie można utworzyć wpłaty — kwota nie jest dodatnia. | Nie — popraw dane żądania. |
| `statement_multiple_not_supported` | Plik zawiera kilka wyciągów. Zaimportuj każdy wyciąg osobno. | Nie — popraw dane żądania. |
| `statement_transaction_id_missing` | Ruch w wyciągu nie ma identyfikatora transakcji banku. | Nie — popraw dane żądania. |
| `storage_unavailable` | Magazyn dokumentów jest niedostępny. Przesyłanie i pobieranie są wyłączone. | Tak, po chwili (usługa/zasób chwilowo niedostępne). |
| `student_household_overlap` | Uczeń ma już członkostwo w tym gospodarstwie (lub inne główne) w tym okresie. Zakończ poprzednie i dodaj nowe od tej samej daty. | Nie — popraw dane żądania. |
| `student_not_found` | Nie znaleziono ucznia. | Nie — popraw dane żądania. |
| `subject_required` | Podaj gospodarstwo, opiekuna albo ucznia, którego dotyczy żądanie. | Zależy od kontekstu (patrz moduł trasy). |
| `suppression_not_active` | Ta blokada nie jest już aktywna. | Zależy od kontekstu (patrz moduł trasy). |
| `task_full` | Brak wolnych miejsc w tym zadaniu. Odśwież listę. | Zależy od kontekstu (patrz moduł trasy). |
| `task_time_outside_event` | Czas zadania musi mieścić się w czasie wydarzenia. | Zależy od kontekstu (patrz moduł trasy). |
| `timeout` | Operacja trwała za długo i została przerwana. Spróbuj ponownie, ewentualnie zawęź zakres. | Tak, po chwili (usługa/zasób chwilowo niedostępne). |
| `too_many_attempts` | Zbyt wiele prób. Spróbuj ponownie później. | Zależy od kontekstu (patrz moduł trasy). |
| `too_many_rows` | Za dużo wierszy w jednym żądaniu. | Zależy od kontekstu (patrz moduł trasy). |
| `transfer_already_reversed` | To przeniesienie zostało już cofnięte. | Zależy od kontekstu (patrz moduł trasy). |
| `transfer_not_found` | Nie znaleziono przeniesienia kasa ↔ rachunek. | Nie — popraw dane żądania. |
| `unauthenticated` | Sesja wygasła lub nie jesteś zalogowany. Zaloguj się ponownie. | Nie — zależy od sesji/uprawnień, nie od ponowienia. |
| `unknown_school_year` | Nie znaleziono roku szkolnego. | Zależy od kontekstu (patrz moduł trasy). |
| `unknown_source_class` | Mapa klas wskazuje klasę, której nie ma w roku źródłowym. | Nie — popraw dane żądania. |
| `unknown_student` | Wykluczenie lub zmiana klasy dotyczy ucznia, który nie ma przypisania w roku źródłowym. | Nie — popraw dane żądania. |
| `unknown_target_class` | Wskazana klasa docelowa nie istnieje w roku docelowym. | Nie — popraw dane żądania. |
| `unsafe_integer` | Eksport zawiera liczbę spoza obsługiwanego zakresu. | Zależy od kontekstu (patrz moduł trasy). |
| `unsupported_media_type` | Niedozwolony typ danych lub pliku. | Nie — popraw dane żądania. |
| `unsupported_value` | Eksport zawiera nieobsługiwaną wartość. | Nie — popraw dane żądania. |
| `unsupported_version` | Nieobsługiwana wersja danych importu. Odśwież stronę. | Nie — popraw dane żądania. |
| `upload_busy` | Za dużo równoczesnych przesyłań plików. Spróbuj ponownie za chwilę. | Tak, po chwili (usługa/zasób chwilowo niedostępne). |
| `use_reschedule_endpoint` | Po zatwierdzeniu zawiadomienia zmień termin przez „Zmień termin” — wymaga to powodu. | Nie — popraw dane żądania. |
| `user_disabled` | Konto jest wyłączone. | Zależy od kontekstu (patrz moduł trasy). |
| `user_not_found` | Nie znaleziono konta. | Nie — popraw dane żądania. |
| `vote_record_required` | Wynik uchwały wymaga wszystkich trzech liczb głosów i ustalenia quorum. | Nie — popraw dane żądania. |
| `webhook_not_configured` | Powiadomienia zwrotne nie są skonfigurowane na tym środowisku. | Zależy od kontekstu (patrz moduł trasy). |
| `year_close_already_started` | Zamknięcie roku zostało już rozpoczęte. | Zależy od kontekstu (patrz moduł trasy). |
| `year_close_not_started` | Zamknięcie roku nie zostało rozpoczęte. | Zależy od kontekstu (patrz moduł trasy). |
| `year_end_balance_mismatch` | Bilans zamknięcia nie zgadza się z saldem księgi na koniec roku. Potwierdź rozbieżność z powodem albo popraw wpisy. | Nie — popraw dane żądania. |
| `year_end_confirmation_mismatch` | Rozbieżność salda końca roku jest inna niż potwierdzona. Sprawdź aktualne kwoty i potwierdź ponownie. | Nie — popraw dane żądania. |

## Błędy bazy w routerze: klasy, ponowienia, limity (#156)

Sieć bezpieczeństwa w `src/pg/app.js` (`classifyDbError`, `src/pg/db-errors.js`)
i transakcje z `src/db.js`:

| Zdarzenie | Odpowiedź | Klasa w logu | Zachowanie serwera |
|---|---|---|---|
| `school_year_closed`, `school_year_closure_is_final` (trigger) | `409 school_year_closed` | `business` | bez ponowienia |
| `40001`, `40P01` | wewnątrz transakcji ponawiane do 3 prób łącznie (losowy odstęp ok. 10-30 ms, potem 20-60 ms); po wyczerpaniu `503 retry_later` + `Retry-After: 1` | `transient` | ponawiana jest cała funkcja transakcji, więc nie ma podwójnego zapisu ani zdarzenia audytu |
| `55P03` (przekroczony `lock_timeout`) | `503 retry_later` + `Retry-After: 1` | `transient` | bez ponowienia w transakcji |
| `57014` (`statement_timeout`) | `503 timeout` + `Retry-After: 5` | `transient` | bez ponowienia |
| błąd w trakcie `COMMIT` z nieznanym wynikiem (zerwane połączenie, klasa `08`, `57P0x`, timeout) | `503 commit_outcome_unknown`, bez `Retry-After` | `outcome_unknown` | bez ponowienia; połączenie wyrzucane z puli |
| `23505` (`unique_violation`), `23P01` | `409 conflict` | `business` | bez ponowienia; moduły z własnym mapowaniem nazwy ograniczenia zwracają swój kod wcześniej |
| `23503` (`foreign_key_violation`) | `400 invalid_reference` | `business` | bez ponowienia |
| `23514` (`check_violation`), `23502` (`not_null_violation`) | `400 invalid_request` | `business` | bez ponowienia |
| `RAISE EXCEPTION 'nazwa_stanu'` z triggera (SQLSTATE `P0001`) z jawnej listy stanów biznesowych (`src/pg/business-state-codes.js`) lub kończący się na `_immutable`, `_cannot_be_changed`, `_cannot_be_deleted`, `_are_append_only`; `invalid_reference` -> `400 invalid_reference` | `409 business_rule_violation`; nazwa stanu trafia tylko do logu | `business` | bez ponowienia; nowy kod triggera bez klasyfikacji wywala `tests/pg-db-errors.test.js` |
| pozostałe (m.in. kod triggera spoza listy, błąd nieznany; brak łączności z bazą; treść błędu SQL nigdy nie trafia do odpowiedzi) | `503 service_unavailable` | `bug` | bez ponowienia |

- **Ponowienie tylko dla transakcji bez efektów zewnętrznych.** Funkcja
  przekazana do `db.transaction(fn, { retries })` jest uruchamiana ponownie,
  więc musi być czysto bazodanowa (bez Brevo, Storage, sieci). Transakcja
  z takim efektem przekazuje `{ retries: 0 }`. Dziś żadna transakcja w
  `src/**` nie woła transportu ani Storage wewnątrz funkcji (wysyłka i
  `putObject` są PRZED albo PO transakcji; test
  `tests/pg-tx-retry.test.js` pilnuje tego statycznie); jawnie wyłączone jest
  ponowienie tylko przy odtworzeniu kopii (`restoreBundle`).
- **`lock_timeout`.** Każda transakcja zaczyna od `SET LOCAL lock_timeout`
  (`PG_LOCK_TIMEOUT_MS`, domyślnie 3000 ms, najwyżej 60000 — wartość do
  zmierzenia na stagingu, #41). Czekanie na `FOR UPDATE` albo blokadę doradczą
  kończy się więc po ok. 3 s kodem `55P03`, a nie dopiero po `statement_timeout`
  (10 s).
- **`commit_outcome_unknown`: sprawdź stan przed ponowieniem.** Serwer nie wie,
  czy transakcja została zatwierdzona. Klient nie powtarza operacji na ślepo:
  odświeża widok albo, przy trasie z `Idempotency-Key`, powtarza żądanie z tym
  samym kluczem (odtworzy zapis albo wykona go raz). Operacje bez klucza
  (np. wysyłka) wymagają sprawdzenia stanu przez osobę.
- **`405` zawsze z `Allow`.** `tests/pg-tx-retry.test.js` skanuje `src/pg/**`
  i sprawdza odpowiedzi na nieobsługiwane metody.

## OpenAPI (#160, etap 1)

`docs/openapi.json` (OpenAPI 3.1) jest generowany poleceniem
`npm run openapi:build` z `tests/helpers/route-matrix.js` i z tabeli kodów
powyżej; `tests/openapi.test.js` psuje się przy ręcznej edycji pliku albo trasie
dopisanej bez regeneracji. Role w `x-rd-roles` to **założenia** z
`docs/AUTHORIZATION.md` (D-08/D-09), do zatwierdzenia przez zarząd/szkołę.
`x-rd-deny-status` to statusy odmowy wyliczone z macierzy (403 lub 404 per
trasa), więc polityka 403/404 jest już czytelna maszynowo, choć jeszcze nie
opisana słownie per moduł.

## Czego nie obejmuje ten dokument

Część #160 — ten katalog to tylko punkt 4 propozycji z issue ("katalog
błędów"). Nie obejmuje:

- statusu HTTP kanonicznego per kod ani opisanej per-moduł polityki 403 vs
  404 dla obiektu poza zakresem (patrz różnice między `families.js`/
  `documents.js` i `payments.js`/`ledger.js`/`email.js`/`reconciliation.js`
  opisane w issue #160);
- schematów ciał żądań i odpowiedzi w `docs/openapi.json` (etap 1 generatora,
  `scripts/build-openapi.js`, opisuje tylko ścieżki, metody, role, MFA,
  statusy i kody z tego katalogu; patrz sekcja „OpenAPI” niżej);
- `jsconfig.json`, adnotacji `@ts-check`/JSDoc typów i kroku `tsc --noEmit` w
  CI (wymagałoby dodania `typescript` jako zależności — instalacja pakietu
  wymaga połączenia z rejestrem npm, co jest poza zakresem sesji tego
  agenta poprawek).

To zostaje do kolejnych PR.
