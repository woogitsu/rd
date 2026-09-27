# Migracja RD na Railway

Status: decyzja techniczna użytkownika z 27.09.2026; wdrożenie produkcyjne **niezatwierdzone**.

## Cel i zakres

Docelowy stos to jedna usługa Node.js na Railway, prywatny PostgreSQL oraz prywatny Railway Storage Bucket. Aplikacja serwuje API i zbudowane panele z tego samego origin. Brevo pozostaje zewnętrznym dostawcą wiadomości e-mail. Nie używamy produkcyjnie Cloudflare Workers, D1 ani R2 po zakończeniu migracji.

Ta decyzja nie oznacza zgody szkoły na import danych, wysyłkę wiadomości ani publikację panelu. Administrator danych, podstawa i cele przetwarzania, okres retencji, umowy z dostawcami, lokalizacja i role muszą być zatwierdzone przez szkołę oraz IOD. Dla usług Railway wybieramy region UE (Amsterdam) i weryfikujemy region osobno dla aplikacji, bazy i bucketu. Ustawienie regionu nie zastępuje oceny prawnej ani umów powierzenia.

## Mapa komponentów

| Obecnie | Docelowo | Warunek przejścia |
| --- | --- | --- |
| Worker `src/index.js` | serwer Node.js na Railway, `0.0.0.0:$PORT` | te same odpowiedzi HTTP, ochrona origin, testy tras |
| D1 i `migrations/*.sql` | PostgreSQL i wersjonowane migracje | integralność, niezmienność, audyt, test odtworzenia |
| trzy osobne buildy Vite | statyczne zasoby pod tym samym origin co API | brak publicznego serwowania plików prywatnych |
| planowany R2 | prywatny Railway Storage Bucket (S3) | autoryzacja przed pobraniem, limity, audyt |
| planowany Worker cron | Railway cron/worker i kolejka PostgreSQL | idempotencja, dry-run, limit Brevo |
| Brevo API | Brevo API bez zmiany dostawcy | zatwierdzony nadawca i odbiorcy |

## Kolejność

Pełny rozkład i kryteria odbioru są w [issue #31](https://github.com/woogitsu/rd/issues/31) oraz #32–#42. Najpierw portujemy schemat i warstwę danych, potem serwer, sesje, import i operacje finansowe. Dokumenty i pocztę uruchamiamy dopiero po testach kontroli dostępu. Stare pliki Cloudflare usuwamy w ostatnim PR, gdy nowy stos przejdzie testy równoważności.

Nie uruchamiać równoległych produkcyjnych baz D1 i PostgreSQL. Dotychczasowe migracje D1 pozostają wyłącznie źródłem wymagań historycznych; nie są planem migracji danych szkoły. Jeśli kiedykolwiek pojawią się dane w D1, potrzebna będzie odrębna, sprawdzona procedura eksportu, uzgodnienia liczności/sum i cutover z możliwością rollbacku.

## Konfiguracja docelowa

- `DATABASE_URL`: prywatny adres PostgreSQL w projekcie Railway; nie używać publicznego TCP proxy dla aplikacji.
- `PORT`: ustawiany przez Railway; serwer słucha na `0.0.0.0`.
- `APP_ENV` i `PUBLIC_BASE_URL`: rozdzielone dla staging i produkcji.
- Dane dostępu do Storage Bucket oraz `BREVO_API_KEY`: wyłącznie zmienne/secrets Railway, nigdy repo lub build frontendu.
- Osobne środowiska, bazy, buckety i nadawcy testowi. Żadnych danych rodzin na staging.

Staging nie może samoczynnie publikować panelu produkcyjnego ani wysyłać wiadomości do rodziców. Migracji bazy produkcyjnej nie uruchamiać automatycznie przy starcie aplikacji.

## Odbiór i wycofanie

Przed produkcją: pełne CI, testy ról i MFA, testy importu 1000+ syntetycznych uczniów, równoległych korekt, zgodności bilansu, ochrona plików, test 50 użytkowników, backup PostgreSQL oraz próbne odtworzenie bazy i dokumentów. Ustalić limity kosztów i monitoring. Spisać procedurę wycofania wersji aplikacji i odtworzenia bazy. Decyzję o produkcyjnym uruchomieniu dokumentuje szkoła/Rada po przeglądzie IOD.

Źródła techniczne sprawdzone 27.09.2026:

- [Railway: port i adres nasłuchiwania](https://docs.railway.com/networking/troubleshooting/application-failed-to-respond)
- [Railway: PostgreSQL i prywatna sieć](https://docs.railway.com/databases/postgresql)
- [Railway: regiony](https://docs.railway.com/deployments/regions)
- [Railway: prywatne Storage Buckets](https://docs.railway.com/storage-buckets)
- [Railway: backup i próbne odtworzenie PostgreSQL](https://docs.railway.com/guides/postgres-backups-restores)
