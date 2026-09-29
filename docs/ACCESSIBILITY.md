# Dostępność — przegląd WCAG 2.2 AA i widoku mobilnego (#16)

Zakres: cztery aplikacje Vite — `import/` (import uczniów), `panel/` (wpłaty), `ledger/` (księga), `print/` (kartki o składce). Przegląd dotyczy HTML, CSS i `main.js`; kontrakty API się nie zmieniły. Jedyna zmiana w `core.js`: nagłówek kartki w `print/core.js` jest `h3` zamiast `h2` (kartki leżą w sekcji z nagłówkiem `h2`).

Statusy:
- **spełnione** — spełnione przed przeglądem, sprawdzone;
- **poprawione** — poprawione w tym przeglądzie;
- **do sprawdzenia z czytnikiem ekranu** — poprawione lub zgodne w kodzie, ale ostateczną ocenę trzeba wykonać ręcznie z NVDA (Windows, Firefox/Chrome) i VoiceOver (macOS Safari, iOS Safari);
- **nie dotyczy** — funkcja jeszcze nie istnieje; opisano wymaganie na przyszłość.

To jest przegląd prototypu. Nie jest to deklaracja zgodności ani audyt przeprowadzony z udziałem użytkowników z niepełnosprawnościami.

## Jak sprawdzono

1. `tests/a11y-static.test.js` (w `npm test`, bez nowych zależności) sprawdza dla każdej aplikacji: `lang="pl"`, skip link do `#main`, punkty orientacyjne (`header`, `nav`, `main`), jeden `h1`, tę samą nawigację w tej samej kolejności, `caption` i `th scope` w tabelach, etykietę każdego pola, istnienie identyfikatorów w `aria-describedby`/`aria-labelledby`, nazwę okien dialogowych, rolę live komunikatów błędów, widoczny fokus, `min-height: 44px` przycisków i `prefers-reduced-motion`. Liczy też kontrast par kolorów użytych w CSS.
2. `docs/a11y/audit.mjs` (Playwright + Chromium, uruchamiany ręcznie, Playwright nie jest zależnością projektu) renderuje zbudowane strony przy 320, 640 (odpowiednik powiększenia 200% przy 1280 px) i 1280 px na syntetycznych danych. Sprawdza brak poziomego przewijania strony, cele mniejsze niż 24×24 px, obrys fokusu dla pierwszych 30 kroków klawisza Tab, a także czy okno dialogowe otwiera się klawiszem Enter, zamyka klawiszem Esc i czy fokus wraca do przycisku otwierającego. Wynik po poprawkach: brak przepełnienia, brak zbyt małych celów, obrys fokusu na każdym elemencie.
3. Zrzuty ekranu (syntetyczne, bez danych rodzin): `docs/a11y/{import,panel,ledger,print}-{320,1280}.png`.

## Kontrast (1.4.3, 1.4.11)

Tło wszystkich aplikacji jest teraz białe `#FFFFFF` (wcześniej `import`, `panel`, `ledger` miały beżowe tło — niezgodne z DESIGN.md). Czerwień ujednolicono do palety z DESIGN.md.

| Kolor | Tło | Kontrast | Użycie | Status |
|---|---|---|---|---|
| `#282C2F` grafit | `#FFFFFF` | 14,2:1 | tekst | spełnione |
| `#B3262D` czerwień | `#FFFFFF` | 6,50:1 | aktywna zakładka, eyebrow, obramowanie przycisku | spełnione |
| `#FFFFFF` | `#B3262D` | 6,50:1 | tekst przycisku głównego | poprawione (ujednolicone z `#B91F25`/`#B52330`/`#A1222A`) |
| `#FFFFFF` | `#8E2026` | 8,81:1 | przycisk główny po najechaniu | spełnione |
| `#8E2026` | `#FFFFFF` | 8,81:1 | obrys fokusu, skip link | poprawione |
| `#9B1A23` | `#FFFFFF` | 8,18:1 | komunikaty błędów | spełnione |
| `#5D6266` | `#FFFFFF` | 6,17:1 | tekst pomocniczy | spełnione |
| `#8A817C` | `#FFFFFF` | 3,81:1 | panel: „Wczytywanie…” | poprawione → `#5D6266` |
| `#777777` | `#FFFFFF` | 4,48:1 | księga: liczniki, podpisy, kontekst korekty | poprawione → `#5D6266` |
| `#BBB3AE`, `#BBBBBB`, `#ACB3B8` | `#FFFFFF` | 1,9–2,1:1 | obramowania pól (1.4.11 wymaga 3:1) | poprawione → `#767676` (4,54:1) |
| `#F4C8CA`, `rgba(198,41,54,.14)` | `#FFFFFF` | ok. 1,5:1 | obrys fokusu pól | poprawione → `#8E2026`, 3 px |
| `#23613E` / `#E9F5ED`, `#8A5411` / `#FFF3DC` | — | 6,58:1 / 5,69:1 | statusy wpłat | spełnione |
| `#276447` / `#E5F2EA`, `#9D1723` / `#F8E7E9` | — | 6,07:1 / 6,87:1 | przychód / wydatek | spełnione |

Wyłączone przyciski (`disabled`) są zwolnione z wymogu kontrastu. Status nie jest przekazywany wyłącznie kolorem: plakietki mają tekst („Przypisana”, „Do przypisania”, „Przychód”, „Wydatek”).

## Lista kontrolna według aplikacji

### Import uczniów (`import/`)

| Kryterium | Status | Uwagi |
|---|---|---|
| 3.1.1 Język strony | spełnione | `lang="pl"` |
| 2.4.1 Pominięcie bloków | poprawione | dodany skip link „Przejdź do treści” |
| 1.3.1 Punkty orientacyjne | poprawione | `header`, `nav aria-label="Panel"`, `main id="main"`; sekcje z `aria-labelledby` |
| 3.2.3 Spójna nawigacja | poprawione | import nie miał nawigacji; teraz te same 4 linki co inne aplikacje, `aria-current="page"` |
| 1.3.1 Kolejność nagłówków | spełnione | h1 → h2 (kroki) → h3 (Błędy, Uwagi) |
| 3.3.2 Etykiety | spełnione | pole pliku w `label`; listy mapowania kolumn w `label`, grupa `role="group"` z opisem gwiazdki |
| 3.3.1 / 4.1.3 Błędy i komunikaty | poprawione | komunikat o pliku w `role="status"`, powiązany z polem przez `aria-describedby`; przy błędzie `aria-invalid="true"`; podsumowanie wyniku w `role="status"` |
| 2.4.3 Kolejność fokusu | poprawione | po „Sprawdź dane” fokus przechodzi na nagłówek „3. Wynik sprawdzenia” |
| 2.4.7 / 2.4.11 Widoczny, niezasłonięty fokus | poprawione | `:focus-visible` 3 px `#8E2026`; brak przyklejonych nagłówków |
| 2.5.8 Rozmiar celu | poprawione | przyciski i pola min. 44 px wysokości |
| 1.3.1 Tabela | poprawione | `caption`, `th scope="col"`; kontener przewijany ma `role="region"`, nazwę i `tabindex="0"` (przewijanie klawiaturą) |
| 1.4.10 Reflow 320 px | spełnione | strona bez poziomego przewijania; tabela podglądu (8 kolumn) przewija się we własnym kontenerze — dopuszczalny wyjątek dla danych dwuwymiarowych |
| 2.3.3 / ograniczony ruch | poprawione | `scrollIntoView` bez animacji przy `prefers-reduced-motion: reduce`; reguła CSS wyłącza animacje |
| Wyłączony przycisk „Zatwierdź import” | poprawione | wyjaśnienie widoczne w tekście i w `aria-describedby` zamiast samego `title` |
| Czytnik ekranu | do sprawdzenia z czytnikiem ekranu | odczyt komunikatu po wyborze pliku, liczba błędów w podsumowaniu, nawigacja po tabeli 8 kolumn |

### Wpłaty (`panel/`)

| Kryterium | Status | Uwagi |
|---|---|---|
| 3.1.1 Język | spełnione | `lang="pl"` |
| 2.4.1 Skip link | poprawione | dodany |
| 1.3.1 Punkty orientacyjne, nagłówki | poprawione | `main id="main"`; h1 → h2; okna mają własny h2 |
| 3.2.3 Spójna nawigacja | poprawione | dodany link „Kartki”; usunięty dekoracyjny znak „RR” (DESIGN.md: bez dekoracyjnych znaczków) |
| 3.3.2 Etykiety | spełnione | wszystkie pola w `label`; kolumna akcji ma ukryty nagłówek „Akcje” |
| 1.3.1 Tabela | poprawione | ukryty `caption`, `th scope="col"`, kontener przewijany z nazwą i `tabindex="0"` |
| 3.3.1 Błędy w oknach | poprawione | `.form-error` z `id` i `role="alert"`, powiązany z przyciskiem zapisu przez `aria-describedby`; walidacja natywna (`required`) |
| 4.1.3 Komunikaty o stanie | poprawione | „Wczytywanie…” w `role="status"`; licznik wpłat w `aria-live="polite"`; po zapisie komunikat „Zapisano wpłatę.” / „Dodano korektę.” / „Przypisano rodzinę.” |
| Okna dialogowe — klawiatura | poprawione | natywny `<dialog>` z `showModal()` (pułapka fokusu, Esc); nazwa z `aria-labelledby`, kontekst korekty w `aria-describedby`; fokus startuje na pierwszym polu do wypełnienia (`autofocus`); po Esc wraca do przycisku otwierającego (sprawdzone w Playwright); po zapisie, gdy wiersz został przerysowany, fokus trafia na nagłówek „Wpłaty” zamiast na `<body>` |
| Podwójne kliknięcie | spełnione | przycisk wyłączony w trakcie zapisu, klucz idempotencji bez zmian |
| 2.4.7 / 2.4.11 Fokus | poprawione | wcześniej obrys pól 1,5:1; teraz 3 px `#8E2026` |
| 2.5.8 Rozmiar celu | poprawione | przyciski min. 44 px, przyciski w wierszach min. 32 px, zamknięcie „×” 44 px, logo-link 44 px |
| 1.4.10 Reflow 320 px | poprawione | ukryty `span.sr-only` w nagłówku tabeli wychodził poza kontener i dawał 217 px poziomego przewijania strony; kontener tabeli ma `position: relative`. Nawigacja na telefonie w jednym rzędzie zamiast kolumny. Okno dialogowe mieści się w 320 px i przewija się pionowo |
| Ograniczony ruch | poprawione | reguła `prefers-reduced-motion` |
| Czytnik ekranu | do sprawdzenia z czytnikiem ekranu | ogłoszenie błędu serwera w oknie (`role="alert"`), komunikat po zapisie, odczyt kontekstu korekty po otwarciu okna, tabela z kwotami (czy „EUR” i przecinek dziesiętny są czytane poprawnie) |

### Księga (`ledger/`)

| Kryterium | Status | Uwagi |
|---|---|---|
| 3.1.1 Język | spełnione | `lang="pl"` |
| 2.4.1 Skip link | poprawione | dodany |
| 1.3.1 Punkty orientacyjne, nagłówki | poprawione | `main id="main"`; sekcja podsumowania dostała ukryty nagłówek h2 „Podsumowanie roku”; `aria-label` na zwykłym `div` (ignorowany przez czytniki) usunięty; kafelki `article` zamienione na `div` |
| 3.2.3 Spójna nawigacja | poprawione | dodany link „Kartki”; usunięty znak „RR” |
| 3.3.2 Etykiety i instrukcje | poprawione | wszystkie pola w `label`; podpowiedź do referencji uchwały w `aria-describedby`; wyłączony „Dodaj wpis” ma widoczne wyjaśnienie „Dostępne po wczytaniu roku szkolnego.” |
| 1.3.1 Tabele | poprawione | dwie tabele: ukryte `caption`, `th scope="col"`, kontenery z nazwą i `tabindex="0"` |
| 3.3.1 Błędy w oknach | poprawione | jak w panelu: `id`, `role="alert"`, `aria-describedby` na przycisku zapisu |
| 4.1.3 Komunikaty o stanie | poprawione | liczniki pozycji w `aria-live="polite"`; po zapisie „Zapisano wpis w księdze.” / „Dodano korektę.” |
| Okna dialogowe | poprawione | nazwa, opis kontekstu, `autofocus` na kwocie, powrót fokusu jak w panelu |
| 2.4.7 Fokus | poprawione | obrys pól `rgba(…, .14)` zastąpiony 3 px `#8E2026` |
| 2.5.8 Rozmiar celu | poprawione | przyciski 44 px, w wierszach 32 px, „×” 44 px |
| 1.4.10 Reflow 320 px | poprawione | ten sam błąd `sr-only` (161 px przewijania); nagłówek miał stałą wysokość 72 px — teraz `min-height`, więc przy powiększeniu tekstu (1.4.4, 1.4.12) nic nie jest ucinane |
| Czytnik ekranu | do sprawdzenia z czytnikiem ekranu | odczyt kafelków bilansu (etykieta + kwota), pojawienie się pola „Referencja uchwały” po wpisaniu kwoty > 3000 EUR (pole pojawia się bez ogłoszenia — ocenić, czy potrzebny komunikat live) |

### Kartki o składce (`print/`)

| Kryterium | Status | Uwagi |
|---|---|---|
| 3.1.1 Język, 2.4.1 Skip link, punkty orientacyjne | spełnione | aplikacja miała już skip link, `main id="main"`, `caption`, `th scope` |
| 3.2.3 Spójna nawigacja | spełnione | 4 linki, ta sama kolejność |
| 1.3.1 Nagłówki | poprawione | tytuł kartki `h3` (był `h2` na tym samym poziomie co „4. Podgląd i druk”); podgląd ma `role="region"` z nazwą |
| 3.3.2 Etykiety i instrukcje | poprawione | objaśnienie gwiazdki „pole wymagane”; format roku („2026/2027”) jako widoczna podpowiedź, nie tylko placeholder |
| 3.3.1 Błędy | poprawione | pola wymagane i kwota/IBAN wskazują `#config-error` przez `aria-describedby`; pole z błędem ma `aria-invalid="true"`; błędy pliku powiązane z polem pliku |
| 4.1.3 Komunikaty | poprawione | `#config-error` zmieniony z `role="alert"` na `role="status"`: błędy liczone przy każdym naciśnięciu klawisza przerywały czytnik ekranu. Regiony live aktualizowane tylko, gdy tekst się zmienia (bez powtarzania „Wybrano 0 z 0 rodzin”) |
| 2.5.8 Rozmiar celu | poprawione | pola wyboru 24×24 px (były 18 px) |
| 1.4.10 Reflow 320 px | spełnione | brak poziomego przewijania; kontener tabeli dostał `position: relative` zapobiegawczo |
| Ograniczony ruch | poprawione | reguła `prefers-reduced-motion` |
| Wydruk | spełnione | tryb druku pokazuje wyłącznie kartki, bez skip linku i nawigacji |
| Czytnik ekranu | do sprawdzenia z czytnikiem ekranu | pole wyboru w każdym wierszu ma nazwę „Wybierz rodzinę H-1: …” — sprawdzić długość odczytu przy wielu uczniach; ogłoszenie liczby wybranych rodzin |

## Kryteria przekrojowe WCAG 2.2

| Kryterium | Status | Uwagi |
|---|---|---|
| 1.3.5 Cel pola | nie dotyczy | pola nie zbierają danych osobowych użytkownika (identyfikatory rodzin, kwoty, kontakt Rady). Przy formularzu profilu lub logowania dodać `autocomplete` (`email`, `name`, `username`) |
| 2.4.11 Fokus niezasłonięty | spełnione | brak przyklejonych nagłówków i banerów; okna modalne zasłaniają stronę w całości i mają własny fokus |
| 2.5.7 Ruchy przeciągania | nie dotyczy | brak przeciągania |
| 3.2.6 Spójna pomoc | nie dotyczy | żadna aplikacja nie ma jeszcze mechanizmu pomocy (kontaktu, instrukcji). Adres kontaktowy i nadawca to decyzja zarządu. Po decyzji umieścić ten sam link w tym samym miejscu (np. stopka) we wszystkich aplikacjach |
| 3.3.7 Zbędne ponowne wpisywanie | spełnione | panel przenosi rok szkolny z filtra do okna „Dodaj wpłatę”, księga — ukrytym polem; data domyślnie dzisiejsza. Po błędzie serwera formularz zachowuje wpisane dane |
| 3.3.8 Dostępne uwierzytelnianie | do sprawdzenia z czytnikiem ekranu | Ekran `login/`: wklejanie i menedżery haseł dozwolone, `autocomplete="username"`, `"current-password"`, `"new-password"`, `"one-time-code"` (pole kodu `inputmode="numeric"`), przycisk „Pokaż hasło” z `aria-pressed`, bez CAPTCHA; błędy w `role="alert"` powiązane z polami (`aria-describedby`, `aria-invalid`). Kod QR ma obok klucz do wpisania ręcznie. Test statyczny: `tests/login-core.test.js`; ocena z NVDA/VoiceOver — do wykonania |
| 1.4.4 / 1.4.12 Powiększenie tekstu, odstępy | spełnione | jednostki względne; brak stałych wysokości kontenerów z tekstem (poza wydrukiem A5) |
| 1.4.13 Treść pod kursorem | nie dotyczy | brak tooltipów; `title` na przycisku importu zastąpiony widocznym tekstem |

## Co wymaga ręcznego testu z czytnikiem ekranu

Wykonać przed pracą na danych rodzin, na danych syntetycznych, w konfiguracjach: NVDA 2024+ z Firefox i Chrome (Windows), VoiceOver z Safari (macOS) i VoiceOver z Safari (iOS, pionowo i poziomo).

1. Skip link: pierwszy Tab pokazuje „Przejdź do treści”, Enter przenosi czytnik do `main`.
2. Nawigacja po punktach orientacyjnych (NVDA: D, VoiceOver: rotor „Punkty orientacyjne”) i nagłówkach (H) — kolejność ma odpowiadać krokom na stronie.
3. Okna dialogowe w panelu i księdze: po otwarciu czytany jest tytuł okna i, dla korekty, kontekst wpłaty lub wpisu; Tab nie wychodzi z okna; Esc zamyka; fokus wraca do przycisku. Na iOS sprawdzić, czy VoiceOver nie czyta treści strony pod oknem.
4. Błąd serwera (np. 401 bez sesji) w oknie: komunikat `role="alert"` jest czytany raz, a po powrocie na przycisk zapisu — jako opis przycisku.
5. Komunikaty o stanie: „Wczytywanie…”, liczba wpłat lub wpisów, „Zapisano wpłatę.”, wynik importu, liczba wybranych rodzin — czytane bez przenoszenia fokusu i bez wielokrotnego powtarzania.
6. Kartki: podczas wpisywania roku szkolnego błąd jest czytany grzecznie (polite), nie przerywa pisania; pole ma stan „nieprawidłowe”.
7. Tabele: nawigacja komórkami (NVDA: Ctrl+Alt+strzałki, VoiceOver: VO+strzałki) czyta nagłówek kolumny; kolumna akcji ma nazwę „Akcje”; kwoty „50,00 €” są czytane zrozumiale.
8. Import: po wyborze pliku czytany jest komunikat o liczbie wierszy lub błędzie; po „Sprawdź dane” fokus trafia na „3. Wynik sprawdzenia”, a podsumowanie jest czytane.
9. Powiększenie 200% i 400% w przeglądarce (nie tylko szerokość okna) oraz tryb wysokiego kontrastu Windows (`forced-colors`) — obrys fokusu i obramowania pól muszą pozostać widoczne.

## Strona publiczna (`site/`) i galeria zdjęć — #124

Rozszerzenie testu statycznego na `site/` (i `documents/`, `events/`, `meetings/`) jest zrobione w osobnym PR dla #112, żeby nie dublować pracy — lista `APPS` tam jest wyprowadzona automatycznie z `STATIC_PREFIXES`, więc obejmuje `site/` bez zmian w tym PR.

Zmiany w tym PR (#124):
- `site/main.js`: komunikaty błędów wczytywania (wydarzenia, protokoły, aktualności) dostają `role="alert"` zamiast dzielić `role="status"` ze stanem pustym/informacyjnym — błąd jest teraz ogłaszany asertywnie czytnikowi ekranu.
- Pozycja „Aktualności” w nawigacji i sama sekcja są teraz **zawsze widoczne** (bez `hidden` do czasu wczytania) — brak trasy API (starsze wdrożenie) i brak opublikowanych wpisów wyglądają tak samo: pusty stan, a nie znikająca/pojawiająca się nawigacja (WCAG 3.2.3).
- `news_photos.alt_text` jest teraz obowiązkowy przy rejestracji zdjęcia (albo jawne `decorative = true`) — patrz `docs/NEWS.md` i migracja `0071_news_photo_alt_text_required.sql`. Publiczny JSON zwraca `altText: ""` (nie `null`) dla zdjęć dekoracyjnych.
- Szkic deklaracji dostępności strony publicznej: `docs/ACCESSIBILITY_DECLARATION_DRAFT.md` — tekst do zatwierdzenia przez zarząd/szkołę, bez twierdzeń o zgodności.

**Poza zakresem tego PR** (patrz #124, propozycja pkt. 3): `<figure>`/`<figcaption>` dla zdjęć z autorem i licencją nie jest jeszcze potrzebne — w chwili pisania `site/` nie renderowała zdjęć; obecnie `site/main.js` renderuje galerię jako `<figure>` z `<figcaption>` (#96), a model danych (`altText`/`decorative`) jest już używany. Pełna weryfikacja z czytnikiem ekranu nie została wykonana. Kontrast `site/styles.css` i `prefers-reduced-motion` — patrz PR dla #112 (ten sam plik, żeby uniknąć nakładania się zmian).

**Stan po #96 i kolejnym PR dla #124** (`site/`, aktualności i galeria; `documents/` poza tym zakresem):

| Kryterium | Stan | Weryfikacja |
|---|---|---|
| Język strony, skip link, jeden `h1`, `main#main`, nawigacja z etykietą, sekcje nazwane przez `h2` | spełnione | `tests/a11y-static.test.js`, `tests/site-a11y.test.js` |
| Kontrast tekstu (`--text`, `--muted`, `--red`, `--red-dark`) ≥ 4,5:1 na białym i jasnoszarym tle; obrys fokusu ≥ 3:1 | spełnione | `tests/site-a11y.test.js` (tokeny czytane z `site/styles.css`) |
| Fokus widoczny (`:focus-visible`, 3 px), `prefers-reduced-motion`, `forced-colors` | spełnione | `tests/a11y-static.test.js` |
| Błąd wczytywania ogłaszany (`role="alert"`), stan pusty grzeczny (`role="status"`), nawigacja bez zmian po wczytaniu | spełnione | `tests/site-a11y.test.js` |
| Zdjęcia: `<figure>` + `<figcaption>` (autor · źródło · licencja), `alt` wyłącznie z pola `altText` zatwierdzonego wpisu, `alt=""` tylko dla `decorative`; zdjęcie bez opisu i bez `decorative` nie jest pokazywane; tekst nie jest nigdzie wymyślany | spełnione | `tests/site-a11y.test.js`, `tests/site-core.test.js` |
| Długie tytuły i 20 wpisów przy 320 px: `overflow-wrap: anywhere`, `max-width: 100%` obrazów, brak sztywnych szerokości | sprawdzone statycznie (CSS + logika), **nie renderowane w przeglądarce** | `tests/site-a11y.test.js` |
| Renderowanie 320/640/1280 px w Playwright (`docs/a11y/audit.mjs`) dla `site/` | **do wykonania ręcznie** (Playwright nie jest zależnością projektu; skrypt nadal obsługuje `import`, `panel`, `ledger`, `print`) | — |
| NVDA / VoiceOver dla strony publicznej i galerii | **niewykonane** | lista kontrolna powyżej |

Reguła opisu zdjęć (bez imion i nazwisk dzieci) jest zasadą redakcyjną, nie da się jej wymusić technicznie; jej treść czeka na D-18 (docs/DECISIONS.md) i nie jest tu rozstrzygana.

## Rozszerzenie przeglądu na wszystkie aplikacje statyczne (#112)

`tests/a11y-static.test.js` obejmował wcześniej tylko `import`, `panel`, `ledger`, `print` (na sztywno w kodzie testu). Lista `APPS` jest teraz wyprowadzana z `STATIC_PREFIXES` w `src/node-app.js`, więc obejmuje automatycznie każdą aplikację serwowaną przez serwer — dodanie nowej bez skip linku, `main#main`, `:focus-visible`, `prefers-reduced-motion` czy `caption`/`th[scope]` nie przejdzie CI.

| Aplikacja | Stan przed #112 | Zmiana |
|---|---|---|
| `admin/` | brak `:focus-visible`/`prefers-reduced-motion`/`min-height:44px`, stara paleta (`#c92127`, `#f4c8ca`, `#bbb3ae`, `#8a817c`), `border-radius` na przyciskach/polach/kartach, 4 tabele bez `caption`/`th[scope]`, 3 `.form-error` bez `id` | tokeny DESIGN.md, usunięty `border-radius`, dodane `:focus-visible`, `prefers-reduced-motion`, `min-height:44px`, `caption`+`th[scope]` w 4 tabelach, `id` na `.form-error`, reguła `forced-colors` dla plakietek i aktywnej zakładki |
| `families/` | jak wyżej (`#a11e2a`/`#b52330`/`#c62936`, `rgba(198,41,54,.14)` na obrysie fokusu ok. 1,1:1, `border-radius`), 4 tabele bez `caption`/`th[scope]`, oba `<dialog>` bez `aria-labelledby`, `.form-error` bez `id`, `#message` zawsze `role="status"` (błąd krytyczny nie ogłaszany asertywnie) | jak wyżej + `aria-labelledby` na obu oknach (z `id` na nagłówku), `#message` dostaje `role="alert"` dynamicznie, gdy pokazuje błąd (`families/main.js` `showMessage`) |
| `documents/`, `events/`, `meetings/` | brakowało `prefers-reduced-motion` i `min-height:44px` na przycisku; `.section:focus`/`.detail:focus { outline: none }` gasiły fokus również dla klawiatury (nadpisywały globalny `:focus-visible` wyższą specyficznością) | dodane `prefers-reduced-motion`, `min-height:44px`; usunięte zbędne `outline: none` (dla `documents/` domyślne zachowanie przeglądarki uzupełnia już istniejący `.section:focus-visible`); w `meetings/` 9 kolejnych `.form-error` dostało `id` |
| `site/` | brakowało `prefers-reduced-motion`; `main:focus { outline: none }` gasił fokus klawiatury na punkcie orientacyjnym | dodane `prefers-reduced-motion`, `forced-colors` dla plakietki „odwołane”; usunięte `outline: none`. Strona nie ma żadnego `<button>`, więc kryterium 44 px przycisku jej nie dotyczy (test to sprawdza warunkowo) |
| `login/` | już zgodny (miał wszystko z listy), ale nie był w `tests/a11y-static.test.js` — brak nawigacji paneli powodował, że nie pasował do dawnej sztywnej asercji etykiet | test teraz pomija asercję nawigacji, gdy `<nav aria-label="…">` nie występuje wcale — `login/` przechodzi pozostałe (jedyny, zawsze widoczny `<h1>`, etykiety, fokus, itd.) bez zmian w kodzie |

Nawigacja różni się realnie między aplikacjami (statyczne linki w czterech pierwotnych, `<ul id="shell-nav">` wypełniany w czasie działania przez `shared/shell.js` w `admin`/`families`/`events`/`meetings`/`documents`, sekcje strony w `site/`, brak w `login/`) — test sprawdza teraz dla każdego wariantu to, co ma sens dla niego (etykieta `nav`, brak powtórzonych etykiet, co najwyżej jeden `aria-current="page"`), zamiast jednej sztywnej listy etykiet z czterech pierwotnych aplikacji.

Aplikacje z kilkoma wzajemnie wykluczającymi się widokami pod jednym `main` (`families/`: klasy / klasa / gospodarstwo) mogą mieć po jednym `<h1>` na widok, o ile każdy jest wewnątrz elementu z atrybutem `hidden` — test liczy tylko `<h1>`, które nigdy nie są `hidden` (musi być ich najwyżej jeden).

**`forced-colors` we wszystkich aplikacjach (#112, pkt. 3).** Każdy `styles.css`, który zaznacza aktywną zakładkę przez `box-shadow` albo używa `.badge`, musi mieć `@media (forced-colors: active)` z obramowaniem/podkreśleniem zastępującym tło i cień — pilnuje tego `tests/a11y-static.test.js` (dla wszystkich aplikacji z `STATIC_PREFIXES`). Reguła dodana w `events/`, `panel/`, `ledger/`, `email/`, `reconciliation/`, `year-close/`, `audit/`, `data-export/`, `news/`, `import/`, `print/`. Reguły nie sprawdzono w przeglądarce z włączonym trybem wysokiego kontrastu Windows — do sprawdzenia ręcznie.

**Klawiatura w oknach `families/` (#112, Playwright).** `tests/e2e/families-keyboard.spec.js`: skip link jako pierwszy Tab, dojście do karty gospodarstwa samą klawiaturą, Enter otwiera okno „Edytuj kontakt” (nazwa dostępna, fokus w oknie), Tab nie ustawia fokusu poza oknem, Esc zamyka okno i zwraca fokus na przycisk. Test używa syntetycznej sesji administratora, bo edycja kontaktu wymaga roli admin/board.

**Nadal poza zakresem** (patrz #112, pkt. 4 propozycji): `docs/a11y/audit.mjs` (zrzuty 320/1280 px) renderuje tylko cztery pierwotne aplikacje — rozszerzenie o `families/`, `documents/`, `events/` wymaga ręcznego uruchomienia z Playwright i danych syntetycznych; przegląd z NVDA/VoiceOver (tabela przydziałów ról w `admin/`, karta gospodarstwa z dwojgiem opiekunów i rodzeństwem) — do wykonania.

## Poza zakresem przeglądu

- Ekran logowania (`login/`) — sprawdzany statycznie zarówno w `tests/login-core.test.js`, jak i (od #112) w `tests/a11y-static.test.js`. Przegląd z czytnikiem ekranu i przy 320 px — do wykonania.
- Plakietki statusu mają zaokrąglone rogi (`border-radius: 999px`) — kwestia stylu, nie dostępności; zostawione.
- Kolejność Tab w długich tabelach (przycisk w każdym wierszu) — przy dużej liczbie wierszy rozważyć paginację lub jedną akcję na zaznaczenie; wymaga decyzji projektowej.
