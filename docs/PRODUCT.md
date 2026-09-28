# Model produktu i uprawnień

## Moduły
1. Rodziny i uczniowie: odrębni opiekunowie, rodzeństwo, przypisanie do klasy i roku szkolnego.
2. Składki: wpłaty dobrowolne, częściowe, z różnych źródeł, niewyjaśnione oraz korekty.
3. Finanse: księga wpływów/wydatków, preliminarz, cel wpłaty, dokumenty, uzgodnienia bankowe.
4. Kalendarz: wydarzenia prywatne i publiczne, odpowiedzialni i stan zatwierdzenia.
5. Zebrania: agenda, obecność, protokół, uchwały, głosowania zgodnie z regulaminem.
6. Korespondencja: szablony, ręcznie zatwierdzane kampanie, oddzielne wiadomości, wydruki.
7. Archiwum: dokumenty kolejnych kadencji, raporty i przekazanie dokumentacji.

## Macierz dostępu

Dwie kolumny celowo się różnią (#163): „Propozycja (do D-08/D-09)” to poziom
zaufania opisany na etapie projektu produktu, jeszcze niezatwierdzony przez
zarząd/szkołę. „Stan prototypu w kodzie” to role wpisane dziś na stałe w
stałych modułu (`src/pg/routes/*.js`) i egzekwowane serwerowo — obowiązują
jako założenie, dopóki D-08/D-09 ich nie zatwierdzą albo nie odrzucą.
Szczegóły zakresu (`class_id`/`school_year_id`, MFA) i pełna macierz tras:
[AUTHORIZATION.md](AUTHORIZATION.md). Rozbieżności dla admina technicznego:
#146; dla Komisji Rewizyjnej: #137.

| Rola | Moduł | Propozycja (do D-08/D-09) | Stan prototypu w kodzie |
|---|---|---|---|
| Admin techniczny | Rodziny | tylko pomoc na upoważnienie | brak dostępu do tras rodzin (`families.js` nie wymienia `admin` w `READ_ROLES`/`EDIT_ROLES`; dostęp wyłącznie przez konto z inną rolą) |
| Zarząd | Rodziny | uzgodniony zakres | pełny odczyt i edycja wszystkich klas/uczniów/opiekunów (`families.js:32,34`, `READ_ROLES`/`EDIT_ROLES` zawiera `board`) |
| Skarbnik | Rodziny | „kontakt potrzebny do rozliczeń” | pełny odczyt wszystkich klas (`families.js:32`, `READ_ROLES`), e-mail opiekuna widoczny **bez względu na zgodę kontaktową** (`families.js:248`, `wide \|\| row.contact_allowed`) — szerszy zakres niż opisany; bez edycji |
| Przedstawiciel klasy | Rodziny | tylko własna klasa, minimum danych | odczyt wyłącznie własnej klasy (`families.js`, zakres z `class_id` przydziału); bez edycji |
| Komisja rewizyjna | Rodziny | minimum potrzebne do kontroli | brak trasy rodzin dla `audit` (poza raportem zbiorczym, `reconciliation.js`) |
| Dyrekcja | Rodziny | zakres uzgodniony | brak dostępu (`principal` nie jest w żadnej liście ról modułu rodzin) |
| Admin techniczny | Wpłaty | nie domyślnie | brak dostępu (`payments.js:26`, `FINANCIAL_ROLES` nie zawiera `admin` — sic, patrz uwaga niżej) |
| Zarząd | Wpłaty | odczyt | zapis, korekty, przypisania (`payments.js:26`, `board` w `FINANCIAL_ROLES`) — szerszy dostęp niż „odczyt” |
| Skarbnik | Wpłaty | zapis/korekta | zapis, korekty, przypisania (`payments.js:26`) — zgodne |
| Przedstawiciel klasy | Wpłaty | wpis dla własnej klasy | brak dostępu (`403` na każdej trasie `/api/payments`, macierz w AUTHORIZATION.md) — funkcja z propozycji nie istnieje w kodzie |
| Komisja rewizyjna | Wpłaty | odczyt | brak bezpośredniej trasy odczytu wpłat; wyłącznie raport zbiorczy (`reconciliation.js`, `REPORT_ROLES`) |
| Dyrekcja | Wpłaty | domyślnie brak | brak dostępu — zgodne |
| Zarząd | Księga | zatwierdzenie | zapis wpisów i korekt (`ledger.js:31`, `FINANCIAL_ROLES`); w kodzie nie ma osobnego kroku „zatwierdzenie” — każdy z `FINANCIAL_ROLES` zapisuje bezpośrednio |
| Skarbnik | Księga | zapis | zapis wpisów i korekt (`ledger.js:31`) — zgodne |
| Komisja rewizyjna | Księga | odczyt i eksport | odczyt raportu uzgodnień (`reconciliation.js:32`, `REPORT_ROLES`); eksport roczny wyłącznie `admin`/`board` (`exports.js:25`, `YEARLY_EXPORT_ROLES`) — `audit` nie eksportuje |
| Dyrekcja | Księga | raport zbiorczy | brak dostępu (`principal` nie jest w `READ_ROLES`/`REPORT_ROLES`) |
| Zarząd, Skarbnik | Korespondencja | (brak w macierzy do #163) | `board`+`treasurer` tworzą/edytują kampanie, wyłącznie `board` zatwierdza (`email.js:35-36`, `EDITOR_ROLES`/`APPROVER_ROLES`) |
| Admin, Zarząd | Import | (brak w macierzy do #163) | `admin`+`board`, tylko z przydziałem bez `class_id` (`import.js:28`, `IMPORT_ROLES`) |
| Admin, Zarząd | Eksport roczny | (brak w macierzy do #163) | `admin`+`board` (`exports.js:25`, `YEARLY_EXPORT_ROLES`); eksport archiwum kadencji wyłącznie `board` (`exports.js:27`, `ARCHIVE_EXPORT_ROLES`) |
| Zarząd | Zamknięcie roku | (brak w macierzy do #163) | odczyt/checklista `board`+`treasurer`, samo zamknięcie wyłącznie `board` (`year-close.js:35-37`) |
| Admin, Zarząd, Skarbnik, Przedstawiciel | Kartki (dowody wpłat) | (brak w macierzy do #163) | odczyt finansowy `admin`+`board`+`treasurer`, `representative` dodatkowo dopuszczony do kartek własnej klasy (`print.js:30-31`, `PRINT_ROLES`) |
| Zarząd, Skarbnik, Komisja rewizyjna | Uzgodnienia bankowe | (brak w macierzy do #163) | zapis `admin`+`board`+`treasurer` (`reconciliation.js:31`), raport `audit`+`board`+`treasurer` (`reconciliation.js:32`), raport archiwum wyłącznie `board`+`treasurer` (`reconciliation.js:34`) |

Wiersz „Admin techniczny — Wpłaty” to celowa niespójność w samej propozycji:
`payments.js` nie daje `admin` żadnych uprawnień finansowych mimo że rola
istnieje w systemie — do potwierdzenia, czy to zamierzone (rozdział ról
technicznych i finansowych) czy przeoczenie (#146).

Dla dokumentów/uchwał i publikacji (kalendarz, zebrania, aktualności) patrz
`docs/MEETINGS.md`, `docs/EVENTS.md` — role tych modułów nie są dziś
wpisane do tej tabeli (poza zakresem #163, do uzupełnienia osobno).

Ostateczny zakres wynika z uzgodnień ze szkołą i upoważnień. Zmiany roli
zapisuj w dzienniku.

## Reguły
- Składka jest dobrowolna. Brak wpłaty nie tworzy wierzytelności.
- Kwota sugerowana jest ustawiana na rok, nie nadpisuje kwot faktycznych.
- Nie wysyłaj przypomnienia do opiekuna z odnotowaną wpłatą bez ręcznego uzasadnienia. **Nieegzekwowane w kodzie (#163, do D-16):** kampania `all_households` (`email.js:288`) wyklucza rodziny z wykluczeniem `no_payment_record`, ale nie sprawdza `payment_recorded` ani wpłaty częściowej/skorygowanej do zera, i nie ma pola uzasadnienia. Zanim D-16 rozstrzygnie treść i warunki przypomnień, kampanię `all_households` do rodzin z wpłatą trzeba przygotować i wysłać ręcznie po indywidualnym sprawdzeniu — AGENTS.md: żadne zadanie testowe ani automatyczne nie wysyła przypomnienia bez jawnego zatwierdzenia treści i listy odbiorców.
- Jedna rodzina może mieć kilka dzieci i kilku opiekunów; jeden opiekun może mieć odrębne prawa do kontaktu.
- Wydatki powyżej 3000 EUR wymagają osobnej zgody Rady według dostarczonego regulaminu.
- Zapis roku szkolnego nie zmienia historycznych przypisań.
