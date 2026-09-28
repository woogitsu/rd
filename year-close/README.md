# Zamknięcie roku szkolnego

Lokalnie uruchom serwer (`npm start`) oraz interfejs (`npm run dev:year-close`). Panel korzysta wyłącznie z chronionych tras `/api/year-close/*` (src/pg/routes/year-close.js); użytkownik musi mieć aktywną sesję, MFA i rolę zarządu lub skarbnika bez zawężenia do klasy w wybranym roku szkolnym. Rozpoczęcie i punkty listy kontrolnej może potwierdzić zarząd lub skarbnik; samo zamknięcie — wyłącznie zarząd, i to inna osoba niż ta, która rozpoczęła zamknięcie (zasada czterech oczu; serwer jest jedynym źródłem prawdy, ten ekran tylko przybliża widoczność przycisku).

Ekran pokazuje stan zamknięcia (otwarty / w trakcie / zamknięty), bilans (na żywo albo utrwalony po zamknięciu, z podziałem rachunek/kasa), listę kontrolną sześciu punktów z notatką i opcjonalnym identyfikatorem dokumentu oraz zestawienie przekazania (JSON bez danych osobowych, z przyciskiem druku) dla nowej Rady.

**Rozpoczęcie i zamknięcie roku są nieodwracalne** — potwierdzane oknem `<dialog>` z opisem skutków, nigdy `window.confirm` (na `main` nie ma jeszcze wspólnego `shared/confirm-dialog.js`, PR #276). Zamknięcie blokuje nowe zapisy księgi, wpłat, wydarzeń, zebrań i uchwał w tym roku (0017_year_close.sql) i przenosi bilans zamknięcia jako bilans otwarcia następnego roku.

Prototyp — nie używać na danych rzeczywistych przed decyzją zarządu o regulaminie zamknięcia roku (D-21).
