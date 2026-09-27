# Zasady pracy w repozytorium RD

Przeczytaj README i dokumenty w docs/ przed zmianą kodu. Najpierw ustal istniejącą funkcję, rolę użytkownika i granicę danych. Przy niejasności regulaminu lub prawa opisz założenie zamiast dopowiadać przepis.

## Bezpieczeństwo i dane
- Nie dodawaj prawdziwych danych uczniów, adresów rodziców, wyciągów bankowych, kluczy API ani nieanonimizowanych zrzutów do kodu, logów, testów lub zgłoszeń.
- Każde API wykonuje sprawdzenie sesji i uprawnień po stronie serwera. Ukrycie przycisku nie jest kontrolą dostępu. Przedstawiciel klasy ma dostęp wyłącznie do przypisanych klas.
- Dokumenty w docelowym Railway Storage Bucket są prywatne. Generuj krótkotrwały dostęp dopiero po autoryzacji; waliduj typ i wielkość pliku.
- Wpłaty, operacje finansowe, zmiany ról i wysyłki mają trwały dziennik zdarzeń z aktorem, czasem i identyfikatorem obiektu. Korekta tworzy nowy zapis lub zdarzenie, nie zaciera historii.
- Nie wysyłaj przypomnienia bez jawnego zatwierdzenia treści i listy odbiorców. Żadne zadanie testowe nie może wysłać wiadomości do prawdziwego rodzica.
- Nie stosuj automatycznego statusu „dłużnik”: składki są dobrowolne. Lista „brak wpisu wpłaty” może być nieaktualna.

## Migracja hostingu
- Docelowy stos to Railway Node.js + PostgreSQL + prywatny Storage Bucket; Brevo pozostaje dostawcą e-mail. Szczegóły i kolejność: [docs/RAILWAY_MIGRATION.md](docs/RAILWAY_MIGRATION.md) i issue #31.
- Nie przedstawiaj obecnego Workera/D1 jako gotowego deploymentu Railway. Nie usuwaj starych ścieżek przed testami równoważności i próbą odtworzenia. Nie wdrażaj produkcyjnie bez osobnej decyzji szkoły.

## Zasady implementacji
- Jeden PR = jeden spójny zakres. Przed rozpoczęciem sprawdź issues i PR, by nie dublować pracy.
- Dodaj migrację dla każdej zmiany schematu oraz opis jej skutków dla danych.
- Testuj granice ról, dwie osoby opiekujące się jednym dzieckiem, rodzeństwo, wpłaty częściowe, podwójne kliknięcie, ponowienie zadania, błędny e-mail i korekty.
- Przy zadaniach e-mail stosuj idempotentny klucz (kampania + rodzina), stan kolejki i osobne wiadomości. Respektuj limity Brevo.
- Zachowuj polską terminologię Rady i EUR. Widok publiczny używa wyłącznie zatwierdzonych danych.
- Projekt UI: białe tło, oszczędny czerwony akcent, uporządkowane tabele i proste przyciski. Bez dekoracyjnych ikon, generycznych sloganów i fikcyjnych relacji z wydarzeń.
- Zdjęcia archiwalne publikuj dopiero po sprawdzeniu praw i zgód na publikację wizerunku, zwłaszcza dzieci. Zapisuj źródło, autora, datę i treść zgody/licencji.
- Wyjaśnij w PR zmianę, migrację, testy i ryzyka. Nie oznaczaj prototypu jako gotowego do pracy na danych rodzin.

## Decyzje wymagające zarządu lub szkoły
Administrator danych, zakres importu, czas przechowywania, zasady publikacji zdjęć, bank i rozliczanie wpłat, sugerowana składka, szablon wiadomości, adres nadawcy oraz zakres uprawnień dyrekcji i Komisji Rewizyjnej. Nie zastępuj ich własnym domysłem.
