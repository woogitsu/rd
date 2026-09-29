# Aktualności

Lokalnie uruchom serwer (`npm start`) oraz interfejs (`npm run dev:news`). Ekran korzysta wyłącznie z istniejących tras `/api/news*` i `GET /api/news-photos*` (src/pg/news.js, docs/NEWS.md). Rolę, zakres klasy, MFA i regułę czterech oczu sprawdza wyłącznie serwer; przyciski ukryte w interfejsie są tylko wskazówką.

- Przebieg: szkic → zgłoszenie → zatwierdzenie (zarząd, inna osoba niż autor; autor widzi „Czeka na drugą osobę”) → publikacja (zarząd) → wycofanie z powodem. Każdy krok wysyła numer widzianej wersji; `revision_conflict` odświeża widok.
- **Nieodwracalne kroki** (publikacja, wycofanie) idą przez `shared/confirm-dialog.js` z opisem skutków; podwójne kliknięcie daje jedno żądanie. Tworzenie szkicu używa jednego klucza idempotencji na otwarcie okna (ponowienie po błędzie sieci = jeden wpis).
- Przedstawiciel klasy widzi i edytuje tylko wpisy własnej klasy, bez zdjęć.
- **Zdjęcia — tylko odczyt.** Zarząd i administrator widzą rejestr zdjęć, status praw (do weryfikacji / zweryfikowane / cofnięte), liczbę rozpoznawalnych osób i, po kliknięciu „Zgody”, zakres i termin ważności zgód (identyfikatory dokumentów zgód, bez imion). Do wpisu można wybrać tylko zdjęcia ze zweryfikowanymi prawami. Rejestracja, przesyłanie pliku, weryfikacja i cofanie praw pozostają wyłącznie w API (zasady publikacji zdjęć — D-18).
- Treść jest wstawiana jako tekst (`textContent`), nigdy jako HTML.

Prototyp — nie publikować zdjęć ani treści dotyczących rodzin przed decyzjami D-08 i D-18.
