# Panel wydarzeń

Wewnętrzny interfejs do API wydarzeń (#12, `src/pg/events.js`, [docs/EVENTS.md](../docs/EVENTS.md)). Nie zawiera danych demonstracyjnych ani obejścia uwierzytelniania. To prototyp — nie jest gotowy do pracy na danych rodzin.

## Uruchomienie

```bash
npm run build:events  # dist/events
npm start             # serwer Node.js + PostgreSQL: API oraz panel pod /events/
```

`npm run dev:events` uruchamia sam interfejs w Vite (bez API — przydatne tylko do pracy nad układem). Panel i API muszą działać pod tym samym originem: zapisy wymagają nagłówka `Origin` tej samej domeny i ciasteczka sesji. Bez sesji panel pokazuje wyłącznie prośbę o zalogowanie (formularz logowania jeszcze nie istnieje, zob. docs/AUTH.md).

## Zakres

- lista wydarzeń roku szkolnego z filtrem statusu (szkic, zgłoszone, zatwierdzone, opublikowane, odwołane),
- nowy szkic i edycja (tytuł, początek, koniec, miejsce, organizator, odbiorcy, opis; klasa tylko przy tworzeniu, bo API nie zmienia zakresu istniejącego wydarzenia),
- kroki: zgłoś, zatwierdź, opublikuj, odwołaj (z powodem 3–500 znaków),
- historia wersji z oznaczeniem wersji zgłoszonej, zatwierdzonej i opublikowanej oraz listą zmienionych pól.
- zadania i zapisy wolontariuszy (#142, Etap 1): tabela zadań z liczbą „zapisani / potrzebni”, lista zapisanych opiekunów, nowe zadanie, zapis opiekuna wybranego z listy klasy wydarzenia, wycofanie zapisu i odwołanie zadania; ostrzeżenie, gdy po zmianie czasu wydarzenia zadanie wykracza poza nowy czas (szczegóły: [docs/EVENTS.md](../docs/EVENTS.md)).

## Zasady

- Czas wpisuje się jako czas lokalny Europe/Brussels i wyświetla przez `Intl` w tej strefie, niezależnie od strefy przeglądarki. Dla godziny powtórzonej przy przejściu na czas zimowy (np. 25.10.2026 02:00–02:59) formularz wymaga wyboru „czas letni, UTC+02:00” albo „czas zimowy, UTC+01:00”; godzina nieistniejąca (np. 29.03.2026 02:30) jest odrzucana. Komunikaty API `ambiguous_local_time` i `nonexistent_local_time` są pokazywane po polsku przy polu.
- Utworzenie szkicu wysyła `Idempotency-Key` generowany raz na otwarty formularz i używany ponownie przy ponowieniu lub podwójnym kliknięciu. Nowy klucz powstaje dopiero po sukcesie lub zamknięciu formularza. Jeżeli po nieudanej próbie zmieniono dane, serwer odpowie `idempotency_conflict` — panel prosi wtedy o odświeżenie listy zamiast tworzyć duplikat.
- Zmiana i każdy krok przebiegu wysyłają `revision`, którą użytkownik widział. Odpowiedź `409 revision_conflict` pokazuje komunikat „Ktoś zmienił wydarzenie w międzyczasie” z przyciskiem odświeżenia; panel nie ponawia operacji na nowszej wersji samodzielnie.
- Przyciski kroków wynikają ze statusu; uprawnienia (w tym zasadę czterech oczu przy zatwierdzeniu) sprawdza wyłącznie serwer. Odpowiedź 403 jest pokazywana jako komunikat.
- Rok szkolny i klasa są podpowiadane z przydziałów `/api/access`; na tym etapie wpisuje się identyfikatory ręcznie.

Logika bez DOM: `core.js`, testy: `tests/events-core.test.js`.
