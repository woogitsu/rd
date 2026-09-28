# Scenariusz pokazu prototypu dla zarządu

Zakres: uzupełnia [#404](https://github.com/woogitsu/rd/pull/404) (`scripts/demo-seed.js`, sekcja README „Pokaz dla zarządu”). Ten dokument nie zmienia kodu ani danych demo — opisuje wyłącznie kolejność ekranów, role i pytania do zarządu na spotkaniu ok. 20–25 minut.

**Zanim ktokolwiek uruchomi pokaz: to jest prototyp na danych wyłącznie syntetycznych, uruchamiany lokalnie, nigdzie niewdrożony.** Żaden krok poniżej nie wysyła e-maila, nie łączy się z prawdziwym bankiem ani z systemem szkoły — `scripts/demo-seed.js` odmawia działania poza `localhost` i przy ustawionym `BREVO_API_KEY` (README, sekcja „Pokaz dla zarządu”, `#404`). Każdy ekran poniżej istnieje dziś na `origin/main`; jedyną rzeczą, którą dodaje `#404`, są dane demo (konta ról, wpłaty, wpisy księgi, zapowiedzi wydarzeń, zebranie z protokołem, szkic kampanii e-mail) — bez scalenia `#404` te same ekrany są puste albo wymagają ręcznego zapisu do bazy (README: „sesję zakłada się ręcznym zapisem do PostgreSQL”).

Zweryfikowano lokalnie 28.09.2026 (`origin/main` + merge `origin/claude/new-session-v02wnl-demo-seed`, Playwright/Chromium): kroki 1–9 poniżej przechodzą z danymi z `npm run demo:seed`. Usterki i rzeczy do poprawienia przed pokazem są opisane w raporcie PR, nie w tym dokumencie.

`npm run demo:seed` zakłada też SZKIC uzgodnienia wyciągu bankowego (nigdy nie zatwierdzany — żadne zadanie testowe nie potwierdza uzgodnienia w cudzym imieniu, AGENTS.md) z 8 pozycjami zaimportowanymi z CSV przez tę samą trasę importu co panel `/reconciliation/`. 6 z 8 pozycji odpowiada wpłatom lub wpisom księgi z pozostałych danych demo — panel może więc zaproponować dopasowania tak jak przy prawdziwych danych; 2 pozycje (2026-11-18 i 2026-11-25) celowo NIE odpowiadają niczemu, do pokazu stanu „niedopasowana” / „do wyjaśnienia” w kroku 4.

## Przygotowanie (nie pokazywać zarządowi, zrobić wcześniej)

```bash
npm ci && npm run build
npm run demo:seed      # tworzy bazę .demo-data/ i wypisuje na konsoli hasła + sekrety TOTP kont demo
npm run demo:start     # PORT=3000 npm start na tej samej bazie
```

Konta powstałe z seeda (hasła i sekrety TOTP tylko na konsoli, nigdzie indziej): `admin@example.invalid` (administrator), `zarzad1@example.invalid` i `zarzad2@example.invalid` (zarząd, prezes/sekretarz), `skarbnik@example.invalid` (skarbnik), `przedstawiciel@example.invalid` (przedstawiciel klasy 0-A), `komisja-rewizyjna@example.invalid` (Komisja Rewizyjna). MFA jest skonfigurowane dla `admin`, `board` i `treasurer` (`MFA_REQUIRED_ROLES`, docs/AUTH.md); dla przedstawiciela i komisji rewizyjnej — nie.

Dziś (przed scaleniem [#408](https://github.com/woogitsu/rd/pull/408)) kilka ekranów (Uzgodnienia wyciągu, Zebrania, Zamknięcie roku) pokazuje dane dopiero po wpisaniu roku szkolnego `2026-2027` w polu „Rok szkolny” i kliknięciu „Pokaż” — zrobić to przed pokazem, żeby nie szukać tego na żywo. Po scaleniu `#408` panele same wypełniają to pole najnowszym rokiem z przydziałów konta (albo, gdy przydział nie wskazuje roku, heurystyką daty 1 września) i ładują dane od razu po wejściu — pole zostaje edytowalne, więc krok „Pokaż” nadal działa, jeśli ktoś chce zmienić rok.

## Kolejność ekranów

### 1. Logowanie z MFA (ok. 2 min)
**Ekran:** `/login/`, konto `zarzad1@example.invalid` (zarząd).
**Co pokazać:** e-mail i hasło, potem 6-cyfrowy kod z aplikacji uwierzytelniającej (TOTP).
**Co powiedzieć:** Logowanie idzie dwuetapowo — hasło, a potem kod z aplikacji na telefonie; role z dostępem do finansów (zarząd, skarbnik, administrator) muszą mieć ten drugi składnik skonfigurowany, inaczej panel ich nie wpuści.
**To prototyp — powiedzieć wprost:** sposób logowania (hasło + TOTP, bez zewnętrznego dostawcy tożsamości) wskazał użytkownik przygotowujący prototyp 2026-09-27, nie zarząd; wymaga formalnego potwierdzenia (docs/DECISIONS.md, **D-10**).
**Pytanie na koniec:** **D-10** — czy ten sposób logowania (e-mail + hasło + TOTP) i lista ról z obowiązkowym MFA są akceptowalne, czy zarząd chce inaczej.

### 2. Panel składek skarbnika — bez statusu „dłużnik” (ok. 3 min)
**Ekran:** `/panel/` (rola: skarbnik), zakładka „Wpłaty”.
**Co pokazać:** listę wpłat z dwóch rodzajów danych demo — pełnych i częściowych (w dwóch ratach) — oraz baner nad tabelą: „Składka Rady Rodziców jest dobrowolna. Panel pokazuje wyłącznie zarejestrowane wpłaty, nie tworzy zadłużenia rodziny.”
**Co powiedzieć:** Panel nie liczy, kto „nie zapłacił” — pokazuje tylko to, co ktoś ręcznie zarejestrował jako wpłatę; brak wpisu może znaczyć, że rodzina zapłaciła gotówką jeszcze nieprzypisaną, albo że nie chce wpłacać, bo składka jest dobrowolna.
**Pytania na koniec:** **D-11** (czy ewidencja jest na rodzinę czy na dziecko, jak traktować rodzeństwo i opiekunów z dwóch gospodarstw), **D-12** (kto i na jakich zasadach zapisuje korektę wpłaty).

### 3. Księga (ok. 3 min)
**Ekran:** `/ledger/` (ta sama sesja skarbnika albo zarządu).
**Co pokazać:** bilans otwarcia/zamknięcia, przychody i wydatki za rok demo, listę wpisów z kategoriami; wskazać przycisk „Korekta” przy wpisie — korekta jest osobnym zapisem, oryginał zostaje.
**Co powiedzieć:** Każdy wpis księgi jest niezmienny — poprawka to nowy zapis, więc historia zawsze pokazuje, co się zmieniło i kto to zmienił.
**Pytania na koniec:** **D-13** (rachunek bankowy, gotówka, kto uzgadnia), **D-15** (format referencji i tryb zatwierdzania wydatku powyżej 3000 EUR).

### 4. Uzgodnienie wyciągu (ok. 2 min)
**Ekran:** `/reconciliation/` — wpisać rok szkolny `2026-2027` i kliknąć „Pokaż”.
**Co pokazać:** SZKIC uzgodnienia z danych demo — 8 pozycji zaimportowanych z wyciągu, 6 z propozycją dopasowania do wpłaty albo wpisu księgi, 2 oznaczone jako „niedopasowana” / „do wyjaśnienia” (2026-11-18, 2026-11-25 — celowo nie odpowiadają niczemu w danych demo). Zdanie na ekranie: „Dopasowania są wyłącznie propozycjami — zatwierdzenie i potwierdzenie są ręczne.” Uzgodnienie jest szkicem — nie zostało i nie zostanie zatwierdzone przez seed.
**Co powiedzieć:** System tylko podpowiada, które wpłaty i wpisy księgi pasują do pozycji z wyciągu banku — nikt nie jest automatycznie uznawany za rozliczonego bez ręcznego potwierdzenia; pozycje bez dopasowania (jak te dwie) wymagają ręcznego wyjaśnienia przez skarbnika, zanim uzgodnienie zostanie zatwierdzone.
**Pytanie na koniec:** **D-13** (kto i jak często uzgadnia księgę z wyciągiem, ten sam punkt co w kroku 3).

### 5. Przedstawiciel widzi tylko swoją klasę (ok. 3 min)
**Ekran:** wylogować skarbnika, zalogować `przedstawiciel@example.invalid` (bez MFA — ta rola go nie wymaga), `/families/`.
**Co pokazać:** listę „Klasy” pokazuje wyłącznie „Klasa 0-A (dane przykładowe)”, ze zdaniem na ekranie „Widoczne są wyłącznie klasy z Twojego zakresu uprawnień.” Podkreślić, że to sprawdzenie serwera, nie tylko ukryty link w interfejsie (AGENTS.md).
**Co powiedzieć:** Przedstawiciel klasy widzi wyłącznie przypisaną klasę — to sprawdza serwer przy każdym żądaniu, więc nawet znajomość adresu innej klasy nic nie daje.
**Pytania na koniec:** **D-08** (czy zarząd zatwierdza macierz ról z PRODUCT.md — dziś to tylko założenie w kodzie), **D-09** (zakres dostępu dyrekcji i Komisji Rewizyjnej, dziś bez dostępu do rodzin).

### 6. Zebrania i protokół publiczny (ok. 3 min)
**Ekran:** `/meetings/` (rola: zarząd) — wpisać rok szkolny i kliknąć „Pokaż zebrania”; pokazać zebranie demo ze statusem, listą obecności i protokołem zatwierdzonym „do publikacji”. Potem przejść na `/site/?rok=2026-2027`, sekcja „Protokoły zebrań” — ten sam protokół widoczny bez logowania.
**Co powiedzieć:** Protokół trafia na stronę publiczną dopiero po zatwierdzeniu przez osobę inną niż ta, która prowadziła zebranie (reguła czterech oczu) i po ręcznym ustawieniu widoczności „publiczna” — nic nie publikuje się samo.
**To prototyp — powiedzieć wprost:** panel nie ma głosowania elektronicznego — sekretarz wpisuje wyniki głosowań przeprowadzonych na zebraniu, a reguła quorum jest wpisywana ręcznie, bo aplikacja nie zna regulaminu Rady.
**Pytania na koniec:** **D-19** (czy regulamin dopuszcza głosowanie elektroniczne), **D-21** (która wersja regulaminu obowiązuje i kto ma do niej dostęp w panelu).

### 7. Kartki z danymi przelewu (ok. 3 min)
**Ekran:** `/print/` (rola: skarbnik albo zarząd), zakładka „Kartki o dobrowolnej składce”.
**Co pokazać:** formularz treści kartki — pola „Sugerowana kwota EUR”, „Rachunek IBAN”, „Tytuł przelewu” są dziś puste z podpisem „czekają na decyzję zarządu”; pokazać, że bez zaznaczenia „Treść kartki została zatwierdzona przez Radę” każda kartka ma oznaczenie „WZÓR”. Wczytać listę rodzin przyciskiem „Wczytaj z serwera” i zaznaczyć ręcznie 2–3 rodziny, żeby pokazać podgląd pojedynczej, dyskretnej kartki.
**Co powiedzieć:** Operator wybiera rodziny ręcznie, po jednej — nie ma wysyłki ani druku zbiorczego bez tego wyboru, a kwota i numer rachunku nie pojawią się na kartce, dopóki zarząd ich nie zatwierdzi.
**Pytania na koniec:** **D-13** (rachunek do wpisania na kartce), **D-14** (kwota sugerowana), **D-16** (treść kartki i szablonu wiadomości).

### 8. Strona publiczna (ok. 2 min)
**Ekran:** `/site/?rok=2026-2027`, bez logowania.
**Co pokazać:** aktualności, najbliższe wydarzenia (zapowiedzi z datą i miejscem, nie sprawozdania) i protokół z kroku 6 — wszystko po polsku, bez zdjęć.
**Co powiedzieć:** Strona pokazuje wyłącznie to, co zostało zatwierdzone i opublikowane w panelu — nie ma tu nic, czego nie widzieliśmy już wcześniej w narzędziu zarządu.
**Pytania na koniec:** **D-18** (zasady publikacji zdjęć — dziś strona ich w ogóle nie pokazuje), **D-22** (czy strona ma mieć wersje językowe poza polską).

### 9. Zamknięcie roku — tylko podgląd (ok. 3 min)
**Ekran:** `/year-close/` (rola: zarząd) — wpisać rok szkolny i kliknąć „Pokaż stan”. **Nie klikać żadnego przycisku zamknięcia ani potwierdzenia checklisty** — dane demo mają rok w stanie otwartym, a zamknięcie jest nieodwracalne (docs/YEAR_CLOSE.md: „Przejście jest jednokierunkowe. Wiersza zamknięcia nie można usunąć ani cofnąć”).
**Co pokazać:** listę kontrolną (raport finansowy, raport Komisji Rewizyjnej, protokoły zatwierdzone, uchwały zarchiwizowane, uzgodnienie z rachunkiem, dokumenty przekazane) i informację, że zamknięcie wymaga innej osoby niż ta, która je rozpoczęła.
**Co powiedzieć:** To jest tylko podgląd checklisty — na danych demo nic tu nie zamykamy, bo zamknięcie jest nieodwracalne i wygasza role poprzedniej kadencji; pokazujemy to, żeby zarząd zobaczył, jakie punkty aplikacja pilnuje przy przekazaniu dokumentacji nowej Radzie.
**Pytanie na koniec:** **D-20** (kto i na jakiej podstawie zgadza się na produkcyjne uruchomienie — ten ekran pokazuje tylko, co prototyp dziś potrafi, nie zgodę na wdrożenie).

## Pytania do zarządu — lista do zadania na końcu spotkania

| Pytanie | Skąd (krok scenariusza) | Odnośnik |
|---|---|---|
| Czy sposób logowania (hasło + TOTP) i lista ról z obowiązkowym MFA są akceptowalne? | 1. Logowanie | [D-10](DECISIONS.md#d-10-dostawca-logowania-i-przyjmowanie-zaproszeń) |
| Ewidencja składki na rodzinę czy na dziecko; jak traktować rodzeństwo i opiekunów z dwóch gospodarstw? | 2. Panel składek | [D-11](DECISIONS.md#d-11-jednostka-ewidencji-składki-i-opieka-dzielona) |
| Kto zapisuje korektę wpłaty i na jakich zasadach? | 2. Panel składek | [D-12](DECISIONS.md#d-12-zasady-korekt-wpłat-i-ich-zatwierdzania) |
| Jaki rachunek bankowy, jak gotówka, kto i jak często uzgadnia księgę z wyciągiem? | 3. Księga, 4. Uzgodnienie wyciągu, 7. Kartki | [D-13](DECISIONS.md#d-13-rachunek-bankowy-gotówka-i-uzgadnianie) |
| Jaka sugerowana kwota składki na rok? | 7. Kartki | [D-14](DECISIONS.md#d-14-sugerowana-składka-na-rok) |
| Format referencji i tryb zatwierdzania wydatku powyżej 3000 EUR? | 3. Księga | [D-15](DECISIONS.md#d-15-zatwierdzanie-wydatków-powyżej-3000-eur) |
| Treść wiadomości e-mail i kartki do zatwierdzenia? | 7. Kartki | [D-16](DECISIONS.md#d-16-szablon-wiadomości-i-kartki) |
| Czy zarząd zatwierdza macierz kompetencji ról z PRODUCT.md? | 5. Przedstawiciel klasy | [D-08](DECISIONS.md#d-08-role-i-macierz-kompetencji) |
| Zakres dostępu dyrekcji i Komisji Rewizyjnej do wpłat, księgi i dokumentów? | 5. Przedstawiciel klasy, 9. Zamknięcie roku | [D-09](DECISIONS.md#d-09-uprawnienia-dyrekcji-i-komisji-rewizyjnej) |
| Czy regulamin Rady dopuszcza głosowanie elektroniczne? | 6. Zebrania | [D-19](DECISIONS.md#d-19-głosowanie-elektroniczne) |
| Która wersja regulaminu obowiązuje i kto ma do niej dostęp w panelu? | 6. Zebrania | [D-21](DECISIONS.md#d-21-aktualny-regulamin-i-dostęp-do-dokumentów-źródłowych) |
| Zasady publikacji zdjęć na stronie publicznej? | 8. Strona publiczna | [D-18](DECISIONS.md#d-18-zasady-publikacji-zdjęć) |
| Czy strona publiczna ma mieć wersje językowe poza polską? | 8. Strona publiczna | [D-22](DECISIONS.md#d-22-wersje-językowe-strony-publicznej) |
| Kto i na jakiej podstawie zgadza się na produkcyjne uruchomienie? | 9. Zamknięcie roku | [D-20](DECISIONS.md#d-20-zgoda-na-produkcję-na-railway) |

Poza scenariuszem, ale warte przypomnienia na wstępie lub zakończeniu spotkania: import prawdziwych danych rodzin czeka na zamknięcie **D-01–D-06** (administrator danych, podstawa i cele przetwarzania, zakres importu, retencja, dostawcy, obowiązek informacyjny) — żaden krok tego pokazu tego nie rozstrzyga ani nie zakłada odpowiedzi.

## Poza zakresem tego pokazu

Panel administratora (`/admin/` — konta, zaproszenia, role), import CSV/XLSX i moduł korespondencji e-mail (poza pokazaniem, że szkic kampanii z danych demo nigdy nie jest zatwierdzany ani wysyłany) nie są w tej kolejności — dodać je osobno, jeśli zarząd o nie zapyta. `npm run dev:<panel>` (Vite) nie nadaje się do pokazu — nie łączy się z API (README).
