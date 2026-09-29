# Eksport danych

Lokalnie uruchom serwer (`npm start`) oraz interfejs (`npm run dev:data-export`). Ekran korzysta wyłącznie z istniejących tras `POST /api/exports` (eksport roczny — administrator i zarząd) oraz `GET /api/exports/class-roster` (lista klasy — przedstawiciel własnej klasy, także zarząd i administrator) (src/pg/routes/exports.js). Rolę, zakres klasy/roku i MFA sprawdza wyłącznie serwer; sekcje ekranu są tylko wskazówką.

- **Eksport roczny** wymaga świeżego MFA (krok w górę, do 15 minut). Przy `403 mfa_stale` ekran prosi o kod z aplikacji, wysyła go do `POST /api/mfa/verify` i ponawia to samo żądanie raz.
- **Nieodwracalne akcje** (uruchomienie eksportu, pobranie listy klasy) idą przez `shared/confirm-dialog.js` z opisem skutków: dane osobowe, wpis w niezmiennym dzienniku, obowiązek usunięcia pliku. Podwójne kliknięcie daje jedno żądanie.
- **Lista eksportów**: serwer nie ma trasy listującej przebiegi (`export_runs` są w dzienniku po stronie serwera), więc ekran pokazuje wyłącznie pliki pobrane w tej karcie przeglądarki (w pamięci, bez `localStorage`; znikają po odświeżeniu). Trasa listy przebiegów wymagałaby nowego API — poza zakresem.
- **Weryfikacja** paczki rocznej działa w przeglądarce (WebCrypto): skrót manifestu (także względem nagłówka `X-Export-Manifest-Sha256`), skróty i liczności plików tabel. Pełna weryfikacja i próba odtworzenia: `npm run db:verify-export` (docs/EXPORT.md).

Czas przechowywania pobranych plików i zakres uprawnień do eksportu czekają na decyzje zarządu (D-04, D-08, D-09). Prototyp — nie używać na danych rzeczywistych rodzin przed nimi.
