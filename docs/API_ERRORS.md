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
| `agenda_position_taken` | Ta pozycja porządku obrad jest już zajęta. | Zależy od kontekstu (patrz moduł trasy). |
| `already_matched_via_ledger` | Pozycja jest już dopasowana do wpisu księgi. | Nie — popraw dane żądania. |
| `already_matched_via_payment` | Pozycja jest już dopasowana do wpłaty. | Nie — popraw dane żądania. |
| `already_matched` | Pozycja jest już dopasowana. | Nie — popraw dane żądania. |
| `ambiguous_local_time` | Ta godzina występuje dwa razy (zmiana czasu z letniego na zimowy). Wybierz, o które wystąpienie chodzi. | Zależy od kontekstu (patrz moduł trasy). |
| `approval_required` | Operacja wymaga wcześniejszego zatwierdzenia. | Nie — popraw dane żądania. |
| `approval_stale` | Zatwierdzenie jest nieaktualne, bo dane zmieniły się po nim. Zatwierdź ponownie. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `authorization_superseded` | Kwota upoważnienia zmieniła się w międzyczasie. Odśwież widok i spróbuj ponownie. | Zależy od kontekstu (patrz moduł trasy). |
| `backup_failed` | Kopia zapasowa bazy nie powiodła się. Sprawdź dziennik operacyjny. | Zależy od kontekstu (patrz moduł trasy). |
| `campaign_locked` | Wysyłka jest zablokowana i nie można jej zmienić. | Zależy od kontekstu (patrz moduł trasy). |
| `campaign_not_draft` | Wysyłkę można zmieniać tylko jako szkic. | Zależy od kontekstu (patrz moduł trasy). |
| `campaign_not_found` | Nie znaleziono wysyłki. | Nie — popraw dane żądania. |
| `cannot_disable_self` | Nie można wyłączyć własnego konta. | Zależy od kontekstu (patrz moduł trasy). |
| `cannot_grant_self` | Nie można nadać roli własnemu kontu. Potrzeba drugiej osoby z dostępem do panelu. | Zależy od kontekstu (patrz moduł trasy). |
| `cannot_reset_own_mfa` | Nie można zresetować weryfikacji dwuetapowej własnego konta. Poproś innego administratora. | Zależy od kontekstu (patrz moduł trasy). |
| `cash_below_zero` | Ta operacja doprowadziłaby saldo kasy poniżej zera. | Zależy od kontekstu (patrz moduł trasy). |
| `checklist_incomplete` | Lista kontrolna nie jest ukończona. | Zależy od kontekstu (patrz moduł trasy). |
| `class_exists` | Klasa o tej nazwie już istnieje w tym roku szkolnym. | Zależy od kontekstu (patrz moduł trasy). |
| `class_not_found` | Nie znaleziono klasy albo nie masz do niej dostępu. | Nie — popraw dane żądania. |
| `class_not_in_school_year` | Klasa nie należy do wskazanego roku szkolnego. | Zależy od kontekstu (patrz moduł trasy). |
| `class_required` | Wskaż klasę. | Nie — popraw dane żądania. |
| `class_year_mismatch` | Klasa należy do innego roku szkolnego. | Nie — popraw dane żądania. |
| `closing_balance_out_of_range` | Saldo zamknięcia jest poza dozwolonym zakresem. | Zależy od kontekstu (patrz moduł trasy). |
| `concurrent_version` | Ktoś inny zapisał zmianę w tym samym czasie. Odśwież widok. | Zależy od kontekstu (patrz moduł trasy). |
| `confirmation_required` | Potwierdź operację, wpisując wymagany identyfikator. | Nie — popraw dane żądania. |
| `conflict` | Dane zmieniły się w międzyczasie. Odśwież widok i spróbuj ponownie. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `consent_conflict` | Zapis zgody nie zgadza się z danymi zdjęcia. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `consents_locked` | Zgód nie można zmienić w obecnym stanie wpisu. | Zależy od kontekstu (patrz moduł trasy). |
| `content_hash_mismatch` | Plik uszkodził się podczas przesyłania. Wyślij go ponownie. | Nie — popraw dane żądania. |
| `correction_exceeds_remaining_amount` | Korekta przekracza kwotę pozostałą po wcześniejszych korektach. | Zależy od kontekstu (patrz moduł trasy). |
| `date_outside_school_year` | Data wpisu jest poza rokiem szkolnym. | Zależy od kontekstu (patrz moduł trasy). |
| `difference_requires_note` | Różnica wymaga wpisania wyjaśnienia. | Zależy od kontekstu (patrz moduł trasy). |
| `document_active_content` | Plik odrzucony: zawiera potencjalnie aktywną treść (skrypt, załącznik, szyfrowanie) niedozwoloną w dokumentach Rady. | Zależy od kontekstu (patrz moduł trasy). |
| `document_content_missing` | Plik zniknął z magazynu. Zgłoś to administratorowi; metadane dokumentu pozostają w dzienniku. | Zależy od kontekstu (patrz moduł trasy). |
| `document_integrity_mismatch` | Plik w magazynie nie zgadza się z zapisaną sumą kontrolną. Zgłoś to administratorowi. | Nie — popraw dane żądania. |
| `document_malformed` | Plik odrzucony: jego struktura nie odpowiada zadeklarowanemu typowi (uszkodzony albo doklejone dodatkowe dane). | Zależy od kontekstu (patrz moduł trasy). |
| `document_too_large` | Plik przekracza dozwolony rozmiar. | Zależy od kontekstu (patrz moduł trasy). |
| `duplicate_name` | Nazwy klas na liście powtarzają się. | Nie — popraw dane żądania. |
| `duplicate_photo` | To zdjęcie jest już dodane. | Nie — popraw dane żądania. |
| `empty_document` | Plik jest pusty. | Zależy od kontekstu (patrz moduł trasy). |
| `ends_before_start` | Koniec nie może być wcześniej niż początek. | Zależy od kontekstu (patrz moduł trasy). |
| `event_cancelled` | Wydarzenie jest odwołane; odwołanie jest ostateczne. | Zależy od kontekstu (patrz moduł trasy). |
| `event_not_found` | Nie znaleziono wydarzenia albo nie masz do niego dostępu. | Nie — popraw dane żądania. |
| `event_not_public` | Publikować można tylko wydarzenie z odbiorcami „Publiczne”. | Zależy od kontekstu (patrz moduł trasy). |
| `export_in_progress` | Eksport tego roku już trwa. Poczekaj na jego zakończenie i spróbuj ponownie. | Tak, po chwili (drugi równoczesny eksport tego samego roku). |
| `export_too_large` | Eksport jest za duży. Zawęź zakres. | Zależy od kontekstu (patrz moduł trasy). |
| `fingerprint_mismatch` | Dane różnią się od podglądu. Wyślij podgląd ponownie. | Nie — popraw dane żądania. |
| `forbidden` | Brak uprawnień do tej operacji w Twoim zakresie. | Nie — zależy od sesji/uprawnień, nie od ponowienia. |
| `four_eyes_required` | Tę operację musi zatwierdzić inna osoba niż autor. | Nie — popraw dane żądania. |
| `grant_not_found` | Nie znaleziono przydziału. | Nie — popraw dane żądania. |
| `idempotency_conflict` | Ten formularz był już wysłany z innymi danymi. Odśwież widok i sprawdź, czy zapis istnieje, zanim wyślesz ponownie. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `idempotency_key_required` | Brak identyfikatora operacji. Odśwież stronę i spróbuj ponownie. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `idempotency_key_reused` | Ten podgląd był już użyty dla innych danych. Wyślij podgląd ponownie. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `import_disabled` | Import jest wyłączony na tym środowisku. | Zależy od kontekstu (patrz moduł trasy). |
| `import_has_conflicts` | Import zawiera konflikty lub błędy. Popraw plik albo zaznacz pominięcie tych wierszy. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `inconsistent_matches` | Dopasowania są niespójne. Odśwież widok. | Zależy od kontekstu (patrz moduł trasy). |
| `invalid_alt_text` | Podaj opis zdjęcia (tekst alternatywny). | Nie — popraw dane żądania. |
| `invalid_amount` | Niepoprawna kwota. Podaj kwotę w EUR większą od zera, np. 25,00. | Nie — popraw dane żądania. |
| `invalid_audience` | Wybierz odbiorców. | Nie — popraw dane żądania. |
| `invalid_author` | Niepoprawny autor. | Nie — popraw dane żądania. |
| `invalid_body` | Treść jest pusta albo za długa. | Nie — popraw dane żądania. |
| `invalid_campaign_id` | Niepoprawny identyfikator wysyłki. | Nie — popraw dane żądania. |
| `invalid_category` | Wybierz kategorię z listy. | Nie — popraw dane żądania. |
| `invalid_cell` | Niepoprawna wartość komórki. | Nie — popraw dane żądania. |
| `invalid_cents_value` | Niepoprawna kwota w EUR. | Nie — popraw dane żądania. |
| `invalid_checklist_item` | Niepoprawny punkt listy kontrolnej. | Nie — popraw dane żądania. |
| `invalid_class` | Niepoprawny identyfikator klasy. | Nie — popraw dane żądania. |
| `invalid_code` | Kod jest nieprawidłowy. Sprawdź aplikację i wpisz aktualny kod. | Nie — popraw dane żądania. |
| `invalid_columns` | Niepoprawne kolumny importu. | Nie — popraw dane żądania. |
| `invalid_consent` | Niepoprawny zapis zgody na publikację. | Nie — popraw dane żądania. |
| `invalid_content_type` | Serwer nie odczytał formatu danych. | Nie — popraw dane żądania. |
| `invalid_credentials` | Nieprawidłowy adres e-mail lub hasło. | Nie — popraw dane żądania. |
| `invalid_csv_header` | Plik CSV ma niepoprawny nagłówek. | Nie — popraw dane żądania. |
| `invalid_csv` | Nie udało się odczytać pliku CSV. | Nie — popraw dane żądania. |
| `invalid_current_password` | Obecne hasło jest nieprawidłowe. | Nie — popraw dane żądania. |
| `invalid_cursor` | Nie udało się wczytać kolejnej strony wyników. Odśwież listę. | Nie — popraw dane żądania. |
| `invalid_date_range` | Data końca nie może być wcześniejsza niż data początku. | Nie — popraw dane żądania. |
| `invalid_date` | Niepoprawna data. | Nie — popraw dane żądania. |
| `invalid_datetime` | Niepoprawna data lub godzina. | Nie — popraw dane żądania. |
| `invalid_depicts_children` | Zaznacz, czy zdjęcie przedstawia dzieci. | Nie — popraw dane żądania. |
| `invalid_description` | Opis jest za długi. | Nie — popraw dane żądania. |
| `invalid_display_name` | Nazwa wyświetlana może mieć najwyżej 100 znaków. | Nie — popraw dane żądania. |
| `invalid_document_id` | Niepoprawny identyfikator dokumentu. | Nie — popraw dane żądania. |
| `invalid_effective_on` | Podaj poprawną datę. | Nie — popraw dane żądania. |
| `invalid_email` | Podaj poprawny adres e-mail. | Nie — popraw dane żądania. |
| `invalid_ended_on` | Podaj poprawną datę odejścia (RRRR-MM-DD). | Nie — popraw dane. |
| `invalid_event_id` | Niepoprawny identyfikator wydarzenia. | Nie — popraw dane żądania. |
| `invalid_expires_at` | Data wygaśnięcia musi być w przyszłości (najwyżej 3 lata). | Nie — popraw dane żądania. |
| `invalid_explicit_license` | Niepoprawna licencja zdjęcia. | Nie — popraw dane żądania. |
| `invalid_format` | Wybierz format eksportu z listy (CSV albo JSON). | Nie — popraw dane żądania. |
| `invalid_id` | Niepoprawny identyfikator. | Nie — popraw dane żądania. |
| `invalid_idempotency_key` | Niepoprawny identyfikator operacji. Zamknij formularz i otwórz go ponownie. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `invalid_identifier` | Niepoprawny identyfikator. | Nie — popraw dane żądania. |
| `invalid_import` | Niepoprawne dane importu. | Nie — popraw dane żądania. |
| `invalid_invitation` | Zaproszenie jest nieważne, wygasło albo zostało już wykorzystane. | Nie — popraw dane żądania. |
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
| `invalid_options` | Niepoprawne ustawienia importu. | Nie — popraw dane żądania. |
| `invalid_organizer` | Organizator może mieć najwyżej 200 znaków. | Nie — popraw dane żądania. |
| `invalid_origin` | Żądanie odrzucone: niezgodne pochodzenie strony. Otwórz panel z adresu aplikacji. | Nie — popraw dane żądania. |
| `invalid_payload` | Niepoprawne dane importu. | Nie — popraw dane żądania. |
| `invalid_payment_id` | Niepoprawny identyfikator wpłaty. | Nie — popraw dane żądania. |
| `invalid_payment_link` | Niepoprawne powiązanie z wpłatą. | Nie — popraw dane żądania. |
| `invalid_photo_id` | Niepoprawny identyfikator zdjęcia. | Nie — popraw dane żądania. |
| `invalid_photos` | Niepoprawna lista zdjęć. | Nie — popraw dane żądania. |
| `invalid_post_id` | Niepoprawny identyfikator wpisu. | Nie — popraw dane żądania. |
| `invalid_quorum_rule` | Niepoprawna reguła quorum. | Nie — popraw dane żądania. |
| `invalid_reason` | Podaj powód (3–500 znaków). | Nie — popraw dane żądania. |
| `invalid_reference_text` | Opis wpłaty jest za długi albo zawiera niedozwolone znaki. | Nie — popraw dane żądania. |
| `invalid_reference` | Wskazany rok szkolny, klasa lub powiązany wpis nie istnieje. | Nie — popraw dane żądania. |
| `invalid_request` | Serwer odrzucił dane formularza. Sprawdź pola. | Nie — popraw dane żądania. |
| `invalid_reversal` | Tego przeniesienia nie można cofnąć w obecnym stanie. | Nie — popraw dane żądania. |
| `invalid_revision` | Brak numeru wersji. Odśwież widok. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `invalid_rights_note` | Niepoprawna notatka o prawach. | Nie — popraw dane żądania. |
| `invalid_role` | Wybierz rolę z listy. | Nie — popraw dane żądania. |
| `invalid_row_numbers` | Niepoprawne numery wierszy. | Nie — popraw dane żądania. |
| `invalid_rows` | Niepoprawne wiersze importu. | Nie — popraw dane żądania. |
| `invalid_school_year_id` | Niepoprawny identyfikator roku szkolnego. | Nie — popraw dane żądania. |
| `invalid_school_year` | Niepoprawny identyfikator roku szkolnego. | Nie — popraw dane żądania. |
| `invalid_send_not_before` | Podaj poprawną datę i godzinę startu wysyłki. | Nie — popraw dane. |
| `invalid_signature` | Niepoprawny podpis żądania. | Nie — popraw dane żądania. |
| `invalid_source_detail` | Niepoprawny opis źródła. | Nie — popraw dane żądania. |
| `invalid_source_document` | Niepoprawny dokument źródłowy. | Nie — popraw dane żądania. |
| `invalid_source` | Niepoprawne źródło wpisu. | Nie — popraw dane żądania. |
| `invalid_statement_line` | Niepoprawna pozycja wyciągu. | Nie — popraw dane żądania. |
| `invalid_status` | Niepoprawny status. | Nie — popraw dane żądania. |
| `invalid_taken_on` | Niepoprawna data wykonania zdjęcia. | Nie — popraw dane żądania. |
| `invalid_title` | Tytuł musi mieć od 3 do 200 znaków. | Nie — popraw dane żądania. |
| `invalid_token` | Kod jest nieważny, wygasł albo został już użyty. | Nie — popraw dane żądania. |
| `invalid_transition` | Tego kroku nie można wykonać w obecnym stanie. Odśwież widok. | Nie — popraw dane żądania. |
| `invalid_ttl` | Ważność zaproszenia: od 1 do 336 godzin. | Nie — popraw dane żądania. |
| `invalid_user_id` | Niepoprawny identyfikator konta. | Nie — popraw dane żądania. |
| `invalid_window` | Niepoprawny zakres dat. | Nie — popraw dane żądania. |
| `invitation_already_accepted` | Zaproszenie zostało już przyjęte. | Zależy od kontekstu (patrz moduł trasy). |
| `invitation_not_found` | Nie znaleziono zaproszenia. | Nie — popraw dane żądania. |
| `invitation_not_pending` | To zaproszenie nie oczekuje już na przyjęcie. Utwórz nowe zaproszenie. | Zależy od kontekstu (patrz moduł trasy). |
| `invitation_pending` | Dla tego adresu i zakresu istnieje już oczekujące zaproszenie. | Zależy od kontekstu (patrz moduł trasy). |
| `last_admin_grant` | Nie można odebrać sobie ostatniego aktywnego przydziału administratora. | Zależy od kontekstu (patrz moduł trasy). |
| `ledger_correction_required` | Najpierw skoryguj powiązany wpis księgi o tę samą kwotę, dopiero potem powtórz tę operację. | Nie — popraw dane żądania. |
| `ledger_entry_already_corrected_to_zero` | Wpis jest już w pełni skorygowany do zera. Nie można go przeksięgować. | Zależy od kontekstu (patrz moduł trasy). |
| `ledger_entry_already_replaced` | Ten wpis został już przeksięgowany. | Zależy od kontekstu (patrz moduł trasy). |
| `ledger_entry_not_found` | Nie znaleziono wpisu księgi. | Nie — popraw dane żądania. |
| `login_busy` | Serwer jest chwilowo przeciążony logowaniami. Spróbuj ponownie za kilka sekund. | Tak — po chwili. |
| `match_already_revoked` | Dopasowanie zostało już wycofane. | Zależy od kontekstu (patrz moduł trasy). |
| `match_amount_mismatch` | Kwoty dopasowania się nie zgadzają. | Nie — popraw dane żądania. |
| `match_method_mismatch` | Sposób wpłaty nie pasuje do pozycji wyciągu. | Nie — popraw dane żądania. |
| `match_not_found` | Nie znaleziono dopasowania. | Nie — popraw dane żądania. |
| `meeting_not_found` | Nie znaleziono zebrania. | Nie — popraw dane żądania. |
| `method_not_allowed` | Ta operacja jest niedostępna. | Zależy od kontekstu (patrz moduł trasy). |
| `mfa_enrollment_required` | Twoja rola wymaga weryfikacji dwuetapowej. Skonfiguruj aplikację uwierzytelniającą. | Nie — popraw dane żądania. |
| `mfa_key_missing` | Weryfikacja dwuetapowa jest chwilowo niedostępna (brak klucza do odszyfrowania). Skontaktuj się z administratorem. | Nie — zależy od sesji i uprawnień. |
| `mfa_locked` | Zbyt wiele błędnych kodów. Spróbuj ponownie za kilkanaście minut. | Nie — zależy od sesji/uprawnień, nie od ponowienia. |
| `mfa_required` | Potwierdź logowanie kodem z aplikacji uwierzytelniającej. | Nie — popraw dane żądania. |
| `mfa_unavailable` | Weryfikacja dwuetapowa jest chwilowo niedostępna. Skontaktuj się z administratorem. | Tak, po chwili (usługa/zasób chwilowo niedostępne). |
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
| `offset_not_valid_in_europe_brussels` | Wybrane przesunięcie czasu nie pasuje do tej daty w Brukseli. | Zależy od kontekstu (patrz moduł trasy). |
| `opening_balance_exists` | Bilans otwarcia dla tego roku szkolnego już istnieje. | Zależy od kontekstu (patrz moduł trasy). |
| `opening_balance_not_found` | Nie znaleziono bilansu otwarcia dla tego roku szkolnego. | Nie — popraw dane żądania. |
| `password_mismatch` | Hasła nie są takie same. | Nie — popraw dane żądania. |
| `password_required` | Podaj hasło. | Nie — popraw dane żądania. |
| `password_too_long` | Hasło jest za długie. | Zależy od kontekstu (patrz moduł trasy). |
| `password_unchanged` | Nowe hasło musi być inne niż obecne. | Zależy od kontekstu (patrz moduł trasy). |
| `payment_already_assigned` | Wpłata jest już przypisana do rodziny. | Zależy od kontekstu (patrz moduł trasy). |
| `payment_already_linked` | Wpłata jest już powiązana z innym wpisem. | Zależy od kontekstu (patrz moduł trasy). |
| `payment_amount_mismatch` | Kwota wpłaty nie zgadza się z powiązanym wpisem księgi. Odśwież widok i sprawdź dane. | Nie — popraw dane żądania. |
| `payment_cannot_be_corrected` | Tej wpłaty nie można skorygować w obecnym stanie. | Zależy od kontekstu (patrz moduł trasy). |
| `payment_cannot_be_refunded` | Tej wpłaty nie można zwrócić w obecnym stanie. | Zależy od kontekstu (patrz moduł trasy). |
| `payment_linked_entry_not_replaceable` | Wpisu powiązanego z wpłatą nie można przeksięgować. Skoryguj albo wpłatę, albo wpis. | Zależy od kontekstu (patrz moduł trasy). |
| `payment_not_assigned` | Wpłata nie jest przypisana do żadnej rodziny. | Zależy od kontekstu (patrz moduł trasy). |
| `payment_not_found` | Nie znaleziono wpłaty albo nie masz do niej dostępu. | Nie — popraw dane żądania. |
| `payment_reassignment_household_mismatch` | Nie można przepisać wpłaty na tę rodzinę — powiązany wpis księgi wskazuje inną rodzinę. | Nie — popraw dane żądania. |
| `payment_reassignment_same_household` | Wpłata jest już przypisana do tej rodziny. | Zależy od kontekstu (patrz moduł trasy). |
| `pending_admin_invitation` | Istnieje już oczekujące zaproszenie administratora. Poczekaj albo je unieważnij. | Zależy od kontekstu (patrz moduł trasy). |
| `photo_not_found` | Nie znaleziono zdjęcia. | Nie — popraw dane żądania. |
| `photo_revoked` | Zgoda na publikację zdjęcia została wycofana. | Zależy od kontekstu (patrz moduł trasy). |
| `photos_require_school_wide_role` | Zdjęcia może dodawać tylko osoba z uprawnieniami dla całej szkoły. | Zależy od kontekstu (patrz moduł trasy). |
| `post_not_found` | Nie znaleziono wpisu. | Nie — popraw dane żądania. |
| `post_withdrawn` | Wpis został wycofany. | Zależy od kontekstu (patrz moduł trasy). |
| `preview_required` | Najpierw wyślij podgląd importu. | Nie — popraw dane żądania. |
| `preview_stale` | Dane w bazie zmieniły się od podglądu. Wyślij podgląd ponownie. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `production_requires_flag` | Uruchomienie w środowisku produkcyjnym wymaga jawnego potwierdzenia. | Zależy od kontekstu (patrz moduł trasy). |
| `production_restore_requires_allow_production` | Odtworzenie na produkcji wymaga osobnego potwierdzenia. | Zależy od kontekstu (patrz moduł trasy). |
| `public_copy_requires_license` | Publiczna kopia wymaga zapisanej licencji lub zgody. | Zależy od kontekstu (patrz moduł trasy). |
| `quorum_rule_source_required` | Podaj źródło reguły quorum (np. regulamin). | Nie — popraw dane żądania. |
| `recipients_hash_mismatch` | Lista odbiorców zmieniła się od zatwierdzenia. Sprawdź ją i zatwierdź ponownie. | Nie — popraw dane żądania. |
| `reconciliation_confirmed` | Uzgodnienie jest już potwierdzone i nie można go zmienić. | Zależy od kontekstu (patrz moduł trasy). |
| `reconciliation_not_found` | Nie znaleziono uzgodnienia. | Nie — popraw dane żądania. |
| `refund_exceeds_remaining_amount` | Zwrot przekracza kwotę pozostałą po wcześniejszych korektach i zwrotach. | Zależy od kontekstu (patrz moduł trasy). |
| `relation_ended` | Ta relacja opiekuna z uczniem została już zakończona. Zmiana nie jest możliwa. | Zależy od kontekstu (patrz moduł trasy). |
| `replacement_target_mismatch` | Przeksięgowanie nie zgadza się z zastępowanym wpisem. Odśwież widok i spróbuj ponownie. | Nie — popraw dane żądania. |
| `request_too_large` | Za dużo danych w jednym żądaniu. | Zależy od kontekstu (patrz moduł trasy). |
| `resolution_expense_only` | Uchwałę jako upoważnienie można wskazać tylko przy wydatku. | Zależy od kontekstu (patrz moduł trasy). |
| `resolution_final_immutable` | Uchwała przyjęta lub odrzucona jest niezmienna. Użyj poprawki zapisu. | Zależy od kontekstu (patrz moduł trasy). |
| `resolution_not_adopted` | Wskazana uchwała nie jest przyjęta. | Zależy od kontekstu (patrz moduł trasy). |
| `resolution_not_current` | Wskazana uchwała ma nowszą wersję (poprawkę). Wybierz aktualną wersję. | Zależy od kontekstu (patrz moduł trasy). |
| `resolution_not_found` | Nie znaleziono uchwały. | Nie — popraw dane żądania. |
| `resolution_number_required` | Uchwała przyjęta wymaga numeru. | Nie — popraw dane żądania. |
| `resolution_number_taken` | Ten numer uchwały jest już zajęty w tym roku szkolnym. | Zależy od kontekstu (patrz moduł trasy). |
| `resolution_reference_mismatch` | Referencja uchwały nie zgadza się z numerem wskazanej uchwały. | Nie — popraw dane żądania. |
| `resolution_required` | Ten wydatek wymaga wskazania uchwały. | Nie — popraw dane żądania. |
| `restore_drill_failed` | Próba odtworzenia kopii nie powiodła się. Sprawdź dziennik operacyjny. | Zależy od kontekstu (patrz moduł trasy). |
| `retry_later` | Baza danych jest chwilowo przeciążona. Spróbuj ponownie za chwilę. | Tak, po chwili (usługa/zasób chwilowo niedostępne). |
| `review_expense_only` | Weryfikacja drugiej osoby dotyczy wyłącznie wydatków. | Zależy od kontekstu (patrz moduł trasy). |
| `revision_conflict` | Ktoś zmienił dane w międzyczasie. Odśwież widok i dopiero wtedy powtórz operację. | Tak, po odświeżeniu widoku (dane zmieniły się w międzyczasie). |
| `school_year_closed` | Rok szkolny jest zamknięty. Zmiany nie są możliwe. | Zależy od kontekstu (patrz moduł trasy). |
| `school_year_exists` | Taki rok szkolny już istnieje. | Zależy od kontekstu (patrz moduł trasy). |
| `school_year_not_finished` | Rok szkolny jeszcze się nie zakończył. | Zależy od kontekstu (patrz moduł trasy). |
| `school_year_not_found` | Nie znaleziono roku szkolnego. | Nie — popraw dane żądania. |
| `self_approval_forbidden` | Nie można zatwierdzić własnego wpisu. Zatwierdzić musi inna osoba. | Zależy od kontekstu (patrz moduł trasy). |
| `service_unavailable` | Usługa jest chwilowo niedostępna. Spróbuj ponownie za chwilę. | Tak, po chwili (usługa/zasób chwilowo niedostępne). |
| `snapshot_required` | Najpierw utwórz kopię stanu danych. | Nie — popraw dane żądania. |
| `statement_date_outside_school_year` | Data wyciągu jest poza rokiem szkolnym. | Zależy od kontekstu (patrz moduł trasy). |
| `statement_line_after_statement_date` | Pozycja wyciągu ma datę późniejszą niż data wyciągu. | Zależy od kontekstu (patrz moduł trasy). |
| `storage_unavailable` | Magazyn dokumentów jest niedostępny. Przesyłanie i pobieranie są wyłączone. | Tak, po chwili (usługa/zasób chwilowo niedostępne). |
| `timeout` | Operacja trwała za długo i została przerwana. Spróbuj ponownie, ewentualnie zawęź zakres. | Tak, po chwili (usługa/zasób chwilowo niedostępne). |
| `too_many_attempts` | Zbyt wiele prób. Spróbuj ponownie później. | Zależy od kontekstu (patrz moduł trasy). |
| `too_many_rows` | Za dużo wierszy w jednym żądaniu. | Zależy od kontekstu (patrz moduł trasy). |
| `transfer_already_reversed` | To przeniesienie zostało już cofnięte. | Zależy od kontekstu (patrz moduł trasy). |
| `transfer_not_found` | Nie znaleziono przeniesienia kasa ↔ rachunek. | Nie — popraw dane żądania. |
| `unauthenticated` | Sesja wygasła lub nie jesteś zalogowany. Zaloguj się ponownie. | Nie — zależy od sesji/uprawnień, nie od ponowienia. |
| `unknown_school_year` | Nie znaleziono roku szkolnego. | Zależy od kontekstu (patrz moduł trasy). |
| `unsafe_integer` | Eksport zawiera liczbę spoza obsługiwanego zakresu. | Zależy od kontekstu (patrz moduł trasy). |
| `unsupported_media_type` | Niedozwolony typ danych lub pliku. | Nie — popraw dane żądania. |
| `unsupported_value` | Eksport zawiera nieobsługiwaną wartość. | Nie — popraw dane żądania. |
| `unsupported_version` | Nieobsługiwana wersja danych importu. Odśwież stronę. | Nie — popraw dane żądania. |
| `user_disabled` | Konto jest wyłączone. | Zależy od kontekstu (patrz moduł trasy). |
| `user_not_found` | Nie znaleziono konta. | Nie — popraw dane żądania. |
| `vote_record_required` | Wynik uchwały wymaga wszystkich trzech liczb głosów i ustalenia quorum. | Nie — popraw dane żądania. |
| `webhook_not_configured` | Powiadomienia zwrotne nie są skonfigurowane na tym środowisku. | Zależy od kontekstu (patrz moduł trasy). |
| `year_close_already_started` | Zamknięcie roku zostało już rozpoczęte. | Zależy od kontekstu (patrz moduł trasy). |
| `year_close_not_started` | Zamknięcie roku nie zostało rozpoczęte. | Zależy od kontekstu (patrz moduł trasy). |

## Czego nie obejmuje ten dokument

Część #160 — ten katalog to tylko punkt 4 propozycji z issue ("katalog
błędów"). Nie obejmuje:

- statusu HTTP kanonicznego per kod ani opisanej per-moduł polityki 403 vs
  404 dla obiektu poza zakresem (patrz różnice między `families.js`/
  `documents.js` i `payments.js`/`ledger.js`/`email.js`/`reconciliation.js`
  opisane w issue #160);
- generatora `docs/openapi.json` ze schematami wejścia/wyjścia
  (`scripts/build-openapi.js` — poza zakresem tego PR, `scripts/` jest dziś
  dotykane przez otwarte PR #288/#289/#297/#302/#311);
- `jsconfig.json`, adnotacji `@ts-check`/JSDoc typów i kroku `tsc --noEmit` w
  CI (wymagałoby dodania `typescript` jako zależności — instalacja pakietu
  wymaga połączenia z rejestrem npm, co jest poza zakresem sesji tego
  agenta poprawek).

To zostaje do kolejnych PR.
