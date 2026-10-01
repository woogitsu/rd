# Żądania osób (RODO): rejestr i eksport danych jednej rodziny

**Status:** prototyp — model w bazie i API na PostgreSQL, bez panelu; nie jest wdrożony (staging: nie, produkcja: nie) i nie jest gotowy do pracy na danych rodzin. Testy wyłącznie na danych syntetycznych (`@example.invalid`). Wszystkie zasady poniżej są wariantem zachowawczym do decyzji zarządu **D-07** (kto przyjmuje żądanie, termin, weryfikacja tożsamości), **D-01** (w czyim imieniu odpowiadamy) i **D-08/D-09** (kto ma dostęp do rejestru) — patrz [DECISIONS.md](DECISIONS.md).

## Co jest zrobione (#100)

| Element | Gdzie | Stan |
|---|---|---|
| Rejestr żądań (`access`, `rectification`, `erasure`, `restriction`, `objection`, `portability`) i przejścia stanu bez cofania | `data_subject_requests` (migracja 0068), `GET/POST /api/admin/data-requests`, `POST …/{id}/status` | zrobione |
| Eksport danych jednej rodziny (JSON + CSV do wydruku) | `POST /api/admin/data-requests/{id}/export?format=json\|csv`, `src/pg/family-export.js` | zrobione (ten dokument) |
| Sprostowanie imienia/nazwiska z historią (`identity_changes`) | `PATCH /api/students/{id}/identity`, `PATCH /api/guardians/{id}/identity`, migracja 0182 | zrobione (prototyp); opis niżej |
| Ograniczenie przetwarzania (`processing_restricted`, wykluczenie z kampanii i kartek) | — | nie zrobione: wymaga migracji |
| Anonimizacja gospodarstwa na żądanie usunięcia (`erasure`) | `POST /api/admin/anonymizations` (`reasonCode: data_subject_request`), `src/pg/anonymization.js`, migracja 0174 | zrobione jako mechanizm (prototyp, dane syntetyczne); zakres i procedura — [RETENTION.md](RETENTION.md); fizyczne usunięcie nie istnieje |
| Raport „kto oglądał dane rodziny” (z `data_access_log`) w odpowiedzi dla rodzica | — | nie zrobione: D-07 (czy i w jakim zakresie to ujawniać) |

## Przebieg (założenie do D-07)

1. Żądanie wpływa poza panelem (pismo, e-mail do administratora danych). Korespondencja **nie** jest przechowywana w panelu ani w repozytorium — w rejestrze zostaje tylko odwołanie `decisionNoteRef` (np. numer w teczce administratora), bez treści żądania i bez danych kontaktowych wnioskodawcy.
2. Administrator techniczny (rola `admin`, MFA) rejestruje żądanie: rodzaj, gospodarstwo / opiekun / uczeń, data wpływu, opcjonalny termin odpowiedzi (`dueOn` — liczba dni do decyzji D-07, nie jest wpisana w kod).
3. Po weryfikacji tożsamości wnioskodawcy (sposób: D-07) administrator zmienia stan na `identity_verified`. Dopiero wtedy eksport jest możliwy.
4. Eksport (`access` albo `portability`, stan `identity_verified` lub `in_progress`) — paczka trafia wyłącznie do osoby obsługującej, która po sprawdzeniu przekazuje ją wnioskodawcy kanałem ustalonym przez administratora danych. Serwer nie zapisuje paczki.
5. Administrator zamyka żądanie (`answered` albo `rejected`) z odwołaniem do dokumentu odpowiedzi. Po zamknięciu eksport zwraca 409 `data_request_closed`.

Kto w Radzie przyjmuje żądania i kto (poza adminem) ma dostęp do rejestru — do decyzji D-07/D-08/D-09. Do tego czasu zarząd, skarbnik, Komisja Rewizyjna, dyrekcja i przedstawiciele klas dostają 403.

## Eksport danych jednej rodziny

`POST /api/admin/data-requests/{id}/export` (domyślnie JSON) lub `…?format=csv`.

**Dostęp:** wyłącznie `admin` z MFA potwierdzonym w ciągu 15 minut (krok w górę jak eksport roczny, #150); starsze MFA → `403 mfa_stale`. Odmowy nie tworzą wpisu w dzienniku ani zdarzenia eksportu.

**Warunki (409):** `data_request_kind_not_exportable` (inny rodzaj niż dostęp/przenoszenie), `data_request_identity_not_verified` (stan `received`), `data_request_closed`, `data_request_subject_mismatch` (np. opiekun w żądaniu nie należy do wskazanego gospodarstwa — obsługujący poprawia rejestr zamiast dostać dane dwóch rodzin), `data_request_export_in_progress` (równoczesny drugi przebieg).

### Zakres

Pierwszeństwo podmiotu: gospodarstwo → opiekun → uczeń.

| Żądanie dla | Uczniowie | Opiekunowie | Gospodarstwa | Wpłaty, kampanie, informacja o przetwarzaniu |
|---|---|---|---|---|
| gospodarstwa | członkowie gospodarstwa (także przez `student_households`, wszystkie okresy) | członkowie gospodarstwa (także przez `guardian_households`) | to jedno | tego gospodarstwa |
| opiekuna | dzieci z `student_guardians` (także zakończone powiązania) | tylko ten opiekun | wszystkie, do których należy | tych gospodarstw (założenie do D-07: opiekun jest członkiem gospodarstwa, na które zapisano wpłatę) |
| ucznia | tylko ten uczeń | brak | jego gospodarstwa (same identyfikatory i członkostwo) | brak (dane gospodarstwa, nie dziecka) |

Wszystkie lata szkolne. Tabele: gospodarstwa, uczniowie, opiekunowie, powiązania uczeń–opiekun i ich historia, członkostwo w gospodarstwach, przypisania do klas i ich historia, historia zgody na kontakt, historia sprostowań imienia i nazwiska (imiona przed i po, bez powodu; opiekunowie i uczniowie z zakresu), prośby o aktualizację danych (stan i daty), wpłaty z korektami, zwrotami, przypisaniami, przeniesieniami i częściami podzielonych wpłat, adresaci/wysyłki/wykluczenia kampanii e-mail, przekazanie informacji o przetwarzaniu danych, obecność na zebraniach, zgłoszenia do zadań wydarzeń, zdarzenia dziennika dotyczące tych obiektów (rodzaj, obiekt, czas — bez aktora i metadanych), sumy wpłat per rok z widoku `household_payment_totals` oraz słowniki (lata, klasy, tematy kampanii, zebrania).

### Osoby trzecie

- Opiekun dziecka spoza zakresu (np. drugi rodzic w innym gospodarstwie przy opiece dzielonej) jest **pominięty**: bez imienia, nazwiska, e-maila i bez wiersza powiązania. Rodzeństwo przyrodnie z innego gospodarstwa trafia do paczki tylko wtedy, gdy wnioskodawca jest jego opiekunem (żądanie opiekuna).
- Identyfikator gospodarstwa spoza zakresu w kolumnie wiersza (np. gospodarstwo główne dziecka, druga strona przeniesienia wpłaty) jest zastąpiony `null`.
- Adresat kampanii spoza zakresu (inny opiekun przy tym samym gospodarstwie) jest pominięty.
- Obsługujący dostaje tylko liczby pominiętych: nagłówki `X-Data-Export-Omitted-Guardians`, `X-Data-Export-Omitted-Households` i te same liczby w metadanych zdarzenia audytu — bez identyfikatorów. Czy i w jakim zakresie ujawniać wnioskodawcy fakt istnienia relacji z osobą trzecią — D-07.

### Poza paczką (do decyzji D-03/D-04/D-07)

Wolny tekst wpisany przez Radę (powody korekt, zwrotów, zmian i zakończeń; tytuł przelewu `payment_entries.reference`; notatki), historia adresów e-mail (`guardian_contact_changes.previous_email/new_email`, proponowany adres i notatka w `guardian_update_requests`), referencje OGM-VCS (`payment_references`), skróty adresów w blokadach i preferencjach e-mail, identyfikatory kont członków Rady (`created_by`, `actor_id`), metadane zdarzeń audytu, dziennik odczytu `data_access_log`. Obsługujący może je dopisać ręcznie po ocenie, poza panelem.

### Format

- **JSON** (`rd-family-export`, wersja 1): kanoniczny JSON (klucze posortowane, wiersze w stałej kolejności), pole `sha256` = SHA-256 treści bez tego pola; nagłówek `X-Export-Manifest-Sha256`. Paczka nie zawiera czasu wygenerowania ani identyfikatora przebiegu — te same dane dają bajt w bajt tę samą paczkę (podwójne kliknięcie = dwa przebiegi z tym samym SHA-256).
- **CSV** do wydruku: jedna sekcja na tabelę z polskimi etykietami kolumn, kwoty w EUR z przecinkiem dziesiętnym, neutralizacja formuł i BOM UTF-8 przez wspólny moduł `src/pg/csv.js`; na końcu SHA-256 paczki JSON. CSV powstaje z tego samego modelu co JSON (bez osobnego odczytu bazy).

### Ślad

W tej samej transakcji co budowa paczki (awaria zapisu = brak pliku):

- `data_access_log`: wpis `household_card` (outcome `ok`, liczba wierszy) **na każde gospodarstwo zakresu**, bez scalania w oknie 5 minut (`dedupe: false`) — każdy przebieg to osobny wiersz. Osobny rodzaj (np. `data_subject_export`) wymaga rozszerzenia `CHECK` migracją — follow-up; do tego czasu eksport od odczytu karty odróżnia zdarzenie poniżej (ten sam aktor i czas). Meta-test `tests/pg-data-access-coverage.test.js` obejmuje trasę (`admin.dataRequestExport`).
- `audit_events`: `data_subject_request.exported` (domena `privacy`) z aktorem, identyfikatorem żądania, formatem, wersją, SHA-256, licznościami tabel, rodzajem podmiotu i liczbami pominiętych osób trzecich — bez danych osobowych.
- `export_runs` **nie** jest używane: jego `CHECK kind` i `school_year_id NOT NULL` (0016) nie przyjmują eksportu wielu lat bez migracji. Rozliczalność zapewniają dwa wpisy powyżej.

## Usunięcie, anonimizacja, ograniczenie i sprostowanie

- **Usunięcie/anonimizacja** (`erasure`, #91): administrator (rola `admin`, MFA ≤15 min) po `identity_verified` wywołuje `POST /api/admin/anonymizations` z `reasonCode: "data_subject_request"` i `dataRequestId` żądania rodzaju `erasure` — najpierw podgląd (`dryRun`, liczniki i `planSha256`, bez danych osobowych), potem wykonanie z `confirm` = id gospodarstwa i `expectedPlanSha256`. Ten tryb działa niezależnie od polityk retencji (D-04 nieustalone): decyzję o usunięciu podejmuje administrator danych w trybie żądania osoby (D-07). **Założenie:** zakres to całe gospodarstwo wskazane przez obsługującego, nie tylko osoba z żądania; osoby wspólne z innym gospodarstwem (opieka dzielona) są anonimizowane dopiero, gdy zanonimizowane są wszystkie ich gospodarstwa. Zmieniane są imiona, nazwiska, e-maile, historia zmian kontaktu, powody w historii członkostw i zapisów, e-maile w migawkach kampanii, tytuły przelewów i powody korekt/zwrotów/przeniesień; kwoty, daty, księga, sumy wpłat i `email_hash` pozostają (szczegóły i lista kolumn: [RETENTION.md](RETENTION.md)). Wynik nie zamyka żądania — administrator ustawia `answered`/`rejected` z odwołaniem do decyzji. Kopie zapasowe i wcześniej wygenerowane paczki (np. eksport danych rodziny, roczny) zawierają dane sprzed przebiegu — procedura „długu anonimizacji” w RETENTION.md. Dziennik: `anonymization_runs` i zdarzenie `household.anonymized` (identyfikatory i liczniki).
- **Ograniczenie przetwarzania** (`restriction`) i **sprzeciw** (`objection`): do czasu flagi `processing_restricted` (migracja) obsługujący może wyłączyć zgodę na kontakt opiekuna (`PATCH /api/guardians/{id}/contact`), co wyklucza go z kampanii; wydruk kartek nie ma jeszcze wykluczenia.
- **Sprostowanie** (`rectification`): e-mail i zgoda — `PATCH /api/guardians/{id}/contact` (historia w `guardian_contact_changes`); imię/nazwisko ucznia lub opiekuna — `PATCH /api/students/{id}/identity` i `PATCH /api/guardians/{id}/identity` (#100, migracja 0182).
  - Treść: `{ firstName?, lastName?, reason, dataRequestId?, confirmPersonalData? }` (przynajmniej jedno imię; 1–100 znaków, bez `@` i znaków sterujących; powód 3–500 znaków). Powód przechodzi bramkę danych osobowych (#152): e-mail, IBAN i numer rejestru → `422 personal_data_forbidden`; imię/nazwisko lub telefon wymagają `confirmPersonalData: true`.
  - Role jak `PATCH /api/guardians/{id}/contact`: admin i zarząd; zarząd z przydziałem klasy tylko dla ucznia z własnej klasy i opiekuna, którego wszystkie aktywne relacje są z uczniami własnej klasy (inaczej `403 guardian_shared_outside_scope`, ślad `access.denied`).
  - Historia: tabela `identity_changes` (tylko dopisywanie; poprzednie i nowe imię, powód, aktor, czas z bazy, opcjonalnie `data_request_id`). Poprawka bez zmiany wartości (podwójne kliknięcie) → `200 changed: false`, bez wpisu. Korekta błędnego sprostowania to kolejna zmiana — nowy wpis, stary zostaje. Audyt: `student.identity.updated` / `guardian.identity.updated` z identyfikatorami i `fields` — bez imion.
  - Powiązanie z rejestrem (`dataRequestId`): tylko admin (rejestr widzi wyłącznie admin, D-07/D-08); żądanie musi być rodzaju `rectification`, po `identity_verified`, niezamknięte i dotyczyć tej osoby, jej gospodarstwa, dziecka lub opiekuna (409 `data_request_kind_not_rectification`, `data_request_identity_not_verified`, `data_request_closed`, `data_request_subject_mismatch`; 404 `data_request_not_found`). Trasa NIE zamyka żądania — robi to administrator (`answered`/`rejected`).
  - Eksport danych rodziny zawiera tę historię (imiona przed/po, bez powodu); eksport roczny jej nie zawiera (wariant zachowawczy); anonimizacja gospodarstwa zastępuje imiona w historii wartością `[zanonimizowano]` i zeruje powód.
  - Poza zakresem: propagacja do już wysłanych wiadomości, wydruków i kopii zapasowych (dług jak w RETENCJI); zakres sprostowania innych danych (adres, data urodzenia) — nie ma ich w schemacie.

## Testy

`tests/pg-anonymization.test.js` (anonimizacja: rodzeństwo, opieka dzielona, sumy netto, ponowienie, role, historia kontaktu), `tests/pg-data-subject-requests.test.js` (rejestr), `tests/pg-data-subject-export.test.js` (eksport: rodzeństwo w dwóch klasach, dwoje opiekunów z różnych gospodarstw, opiekun w dwóch gospodarstwach, rodzeństwo przyrodnie, żądanie ucznia, znaczniki innych rodzin, sumy = `household_payment_totals`, podwójne kliknięcie, stan i rodzaj żądania, granice ról i MFA, CSV), `tests/pg-authz-matrix.test.js` (`admin.dataRequestExport`), `tests/pg-data-access-coverage.test.js`.
