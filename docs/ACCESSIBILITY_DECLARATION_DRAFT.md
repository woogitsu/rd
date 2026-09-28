# Szkic deklaracji dostępności strony publicznej (do zatwierdzenia)

**To jest szkic do przeczytania i zatwierdzenia przez zarząd/szkołę, nie opublikowany tekst.** Nie twierdzi o zgodności — taką ocenę można wystawić dopiero po audycie z udziałem osób korzystających z technologii wspomagających (czytniki ekranu, powiększenie, klawiatura), którego jeszcze nie przeprowadzono. Umieszczenie deklaracji dostępności na stronie publicznej i to, czy obowiązek prawny (np. dla podmiotów sektora publicznego) obejmuje Radę Rodziców, wymaga decyzji zarządu i/lub szkoły — nie rozstrzygamy tego tutaj (patrz issue #124, założenie).

---

## Deklaracja dostępności

Rada Rodziców Szkoły Polskiej im. Joachima Lelewela w Brukseli dąży do tego, aby strona publiczna była dostępna zgodnie z wytycznymi Web Content Accessibility Guidelines (WCAG) 2.2 na poziomie AA.

### Stan zgodności

Strona jest w budowie. Zastosowano m.in.: łącze pomijające do treści głównej, jeden nagłówek `<h1>` na stronę, punkty orientacyjne (`header`, `nav`, `main`), widoczny obrys fokusu klawiatury, ograniczenie animacji dla osób preferujących mniej ruchu (`prefers-reduced-motion`) oraz kontrast tekstu i elementów interfejsu sprawdzany automatycznie w testach (`tests/a11y-static.test.js`).

Nie przeprowadzono jeszcze pełnego przeglądu z osobami korzystającymi z czytnika ekranu (NVDA, VoiceOver) ani formalnego audytu zgodności — status poniżej jest oparty na przeglądzie kodu i automatycznych testach, nie na ocenie użytkowników.

### Zgłaszanie problemów z dostępnością

*[Do uzupełnienia po decyzji o adresie kontaktowym Rady — D-17.]*

### Data sporządzenia i metoda oceny

*[Do uzupełnienia po zatwierdzeniu tekstu i wykonaniu przeglądu z czytnikiem ekranu — patrz docs/ACCESSIBILITY.md.]*

---

## Do rozstrzygnięcia przed publikacją

- Czy przepisy o dostępności podmiotów publicznych obejmują Radę Rodziców (nie jest to rozstrzygnięte w tym repozytorium).
- Adres/kanał zgłaszania problemów z dostępnością (zależny od D-17: adres nadawcy/kontaktu).
- Termin i zakres przeglądu z czytnikiem ekranu przed pierwszą publikacją tej deklaracji (docs/ACCESSIBILITY.md, sekcja „Co wymaga ręcznego testu”).
