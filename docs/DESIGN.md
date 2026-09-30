# Kierunek wizualny wariantu A

Docelowo: czytelny panel administracyjny i skromna strona informacyjna. Kolory narodowe jako akcent, nie biało-czerwony baner na każdym ekranie.

## Paleta i użycie
- Biel #FFFFFF — tło główne, dużo oddechu.
- Neutralny jasny #F5F5F4 — wybrane obszary (np. nagłówki tabel), nie pasek nawigacji.
- Grafit #282C2F — tekst.
- Czerwień #B3262D — aktywna zakładka, link, data wydarzenia i cienka linia sekcji.
- Ciemniejsza czerwień #8E2026 — focus i hover, sprawdzić kontrast.
- Zieleń tylko do stanów powodzenia; czerwieni nie używać równocześnie jako ostrzeżenia i ozdoby.

## Elementy
Proste prostokątne przyciski, regularne tabele, czerwone nagłówki dat, delikatne poziome linie. Typografia: systemowy sans do interfejsu, Georgia do głównego nagłówka publicznego. Bez okrągłych kart, cieni, dekoracyjnych znaczków, sloganów i liczników na siłę.

## Fotografie
Sekcja „Z życia szkoły”: 2–3 kadry z rzeczywistych wydarzeń, krótkie podpisy z datą i źródłem. Pierwszy kandydat: dekoracja 50-lecia ze strony szkoły (https://bruksela.orpeg.pl/2023/06/06/%F0%9F%8E%82jubileusz-50-lecia-naszej-szkoly-niech-zyje-nasza-droga-jubilatka%F0%9F%92%9D%F0%9F%92%9D/). Dwa kolejne kadry wybrać z archiwum szkoły z potwierdzonym prawem publikacji. Unikać zbliżeń rozpoznawalnych dzieci bez potwierdzenia zgód; w razie braku materiałów nie zastępować ich fikcyjną relacją fotograficzną.

## Widoki
Publiczny: informacja o Radzie, najbliższe wydarzenia, sekcja archiwalna, kontakt i zatwierdzone dokumenty.
Panel: nawigacja boczna, nagłówek roku szkolnego, płaskie listy i tabele; na telefonie przewijana nawigacja. Pasek nagłówka (`.site-header`) jest biały we wszystkich panelach — zgodnie z „białe tło” (AGENTS.md). Nagłówek jest jeden dla wszystkich paneli (`.shell-header` w `shared/shell.css`: wiersz marki i konta, pod nim nawigacja; ta sama wysokość na każdym ekranie), tytuł ekranu (`h1`) ma we wszystkich panelach systemowy sans, a linki w treści czerwień projektu z widocznym fokusem zamiast domyślnego niebieskiego (przegląd demo 5; `tests/panel-header-static.test.js`, `tests/e2e/panel-header.spec.js`).

## Dostępność
Kontrast, fokus, rozmiar celów i reflow: [ACCESSIBILITY.md](ACCESSIBILITY.md). Czerwień `#B3262D` na białym tle ma 6,5:1, a `#8E2026` (fokus, hover) 8,8:1 — obie spełniają WCAG AA dla tekstu.
