# Runbook incydentów

Status: **prototyp, nie do pracy na danych rodzin.** Karty poniżej opisują
reakcję na typowe zdarzenia w środowisku docelowym (Railway + PostgreSQL +
Storage Bucket + Brevo). Żaden przykład nie zawiera prawdziwych danych.
Kontekst: [Railway — operacje](RAILWAY_OPERATIONS.md), [plan migracji]
(RAILWAY_MIGRATION.md), [zasady repozytorium](../AGENTS.md).

Każda karta: **Objaw → Diagnoza → Działanie → Kto decyduje → Wpis do
protokołu.** Po każdym incydencie wypełnić [szablon protokołu](#szablon-protokołu-incydentu)
poniżej i dołączyć go do dokumentacji zarządu/Komisji Rewizyjnej — nigdy z
adresami, nazwiskami dzieci ani treścią wiadomości, tylko fakty techniczne
i decyzje.

## Sygnały i narzędzia

| Sygnał | Gdzie | Uwagi |
|---|---|---|
| `GET /health` | publiczny | proces żyje (liveness Railway) |
| `GET /health/ready` | publiczny, bez szczegółów zadań | baza i migracje; 503 = brak ruchu |
| `GET /health/jobs` | `Authorization: Bearer <HEALTH_JOBS_TOKEN>` | 401 bez tokenu; 503 z nazwą progu (`backup_too_old`, `email_worker_stale`, `email_queue_too_old`, `guardian_verify_queue_too_old`); progi: `BACKUP_MAX_AGE_HOURS`, `EMAIL_WORKER_MAX_AGE_HOURS`, `EMAIL_QUEUE_MAX_AGE_HOURS`, `GUARDIAN_VERIFY_QUEUE_MAX_AGE_HOURS` |
| `GET /api/admin/ops-status` | tylko rola `admin`; panel `admin/`, sekcja „Stan systemu” | liczby, znaczniki czasu, kody, bez danych osobowych; brak dziennika kopii = „brak danych”, nie „w normie” |

Karty opisują **docelowe** środowisko Railway (Node.js + PostgreSQL + prywatny
Storage Bucket + Brevo). Obecny Worker/D1 to stara ścieżka utrzymywana do
czasu testów równoważności — nie jest wdrożeniem Railway i nie ma własnych kart.

## 1. `/health/ready` zwraca 503 (`database: error/timeout`)

- **Diagnoza:** metryki usługi PostgreSQL (CPU, pamięć, wolumen, liczba
  połączeń); log `readiness_*`.
- **Działanie:** sprawdzić, czy usługa PostgreSQL działa i ma zasoby; jeśli
  padła — restart usługi w Railway. Jeśli odpowiada, ale wolno — sprawdzić
  zajętość wolumenu i liczbę połączeń (limit `PG_POOL_MAX`).
- **Kto decyduje:** administrator techniczny; eskalacja do zarządu, jeśli
  przestój przekracza okno ogłoszone rodzicom.
- **Protokół:** czas wykrycia/naprawy, przyczyna, czy dane były zagrożone.

## 2. `/health/ready` zwraca 503 (`migrations: pending`)

- **Diagnoza:** deploy nowej wersji wyprzedził `npm run db:migrate:postgres`,
  albo migracja nie przeszła.
- **Działanie:** **backup przed migracją** (patrz #90), potem
  `npm run db:migrate:postgres` ręcznie; sprawdzić log migratora pod kątem
  błędu SQL. Nie nakładać migracji ręcznie edytując bazę.
- **Kto decyduje:** administrator techniczny.
- **Protokół:** numer migracji, wynik, czas przestoju.

## 3. Wzrost 5xx lub pętla restartów po deployu

- **Diagnoza:** `http_metrics.status_5xx`, zdarzenia `api_route_error` w
  logu (pole `class`: `bug` = błąd programu, `transient` = przejściowy,
  `outcome_unknown` = błąd przy COMMIT, wynik zapisu nieznany (#156: sprawdzić
  stan danych, nie ponawiać na ślepo), `business` = odmowa stanu — nie jest
  awarią).
- **Działanie:** rollback deploymentu do poprzedniej wersji w Railway
  (zakładka Deployments → poprzedni udany deploy → Redeploy). Nie naprawiać
  na gorąco na produkcji.
- **Kto decyduje:** administrator techniczny; poinformować zarząd, jeśli
  przestój trwa > 30 min.
- **Protokół:** wersja wadliwa i poprzednia, godzina rollbacku, przyczyna
  (jeśli znana).

## 4. Uszkodzenie lub podejrzenie utraty danych

- **Diagnoza:** rozbieżność w raporcie uzgodnienia, zniknięcie wierszy,
  zgłoszenie użytkownika.
- **Działanie:** **natychmiast tryb tylko do odczytu** (`APP_WRITE_MODE=read_only`,
  patrz #143) — zatrzymuje dalsze zapisy, zanim ustalimy zakres. Nie
  przywracać backupu "na oślep" — najpierw ustalić zakres uszkodzenia.
  Przywrócenie: procedura próbnego odtworzenia (#90) do bazy **innej** niż
  produkcyjna, porównanie raportu, dopiero potem decyzja o przywróceniu
  produkcji (osobna decyzja zarządu — to nie jest automatyczny krok).
  Korekty w księdze/wpłatach to zawsze **nowe zapisy**, nigdy nadpisanie
  historii (AGENTS.md).
- **Kto decyduje:** zarząd (przywrócenie produkcji), administrator
  techniczny (tryb tylko do odczytu, diagnoza).
- **Protokół:** zakres (które tabele/okresy), przyczyna, czy dotyczy danych
  osobowych (patrz karta 8).

## 5. Błędna lub niezamierzona wysyłka e-mail

- **Diagnoza:** zgłoszenie rodzica, nietypowa liczba w `email_outbox`,
  literówka w treści kampanii wykryta po starcie.
- **Działanie:** `EMAIL_SENDING_ENABLED=false` natychmiast zatrzymuje
  wysyłkę (worker kończy przebieg bez wysyłki); wstrzymać/anulować kampanię
  w bazie. Raport strat: liczba wysłanych, **bez adresów** (audyt jest
  techniczny). Sprostowanie do rodzin — dopiero po zatwierdzeniu treści i
  listy odbiorców przez zarząd (AGENTS.md: żadne zadanie testowe ani
  automatyczne nie wysyła do prawdziwego rodzica).
- **Kto decyduje:** zarząd (treść sprostowania, lista odbiorców).
- **Protokół:** liczba dotkniętych odbiorców, przyczyna, treść decyzji
  zarządu (nie treść samego e-maila).

## 6. Wyciek lub podejrzenie wycieku sekretu

- **Diagnoza:** sekret w publicznym repo/logu, nietypowa aktywność konta,
  zgłoszenie.
- **Działanie:** rotacja natychmiast: `DATABASE_URL` (nowe hasło w
  PostgreSQL Railway), klucze bucketu (`BUCKET_*`), `BREVO_API_KEY`. Jeśli
  dotyczy sesji użytkownika — `POST /api/admin/users/{id}/revoke-sessions`.
  Jeśli dotyczy `MFA_ENCRYPTION_KEY` — patrz #134 (osobna procedura, sekrety
  TOTP zaszyfrowane tym kluczem stają się nieczytelne po rotacji bez
  migracji danych).
- **Kto decyduje:** administrator techniczny (rotacja), zarząd (czy i jak
  informować rodziny — zależy od zakresu).
- **Protokół:** który sekret, czas między wyciekiem a rotacją, czy było
  wykorzystanie.

## 7. Twardy limit kosztów wyłączył usługi

- **Diagnoza:** usługi zatrzymane, alert Usage z Railway.
- **Działanie:** sprawdzić przyczynę wzrostu kosztów (load test uruchomiony
  przez pomyłkę? wyciek zasobów?) przed podniesieniem limitu. Podniesienie
  limitu wymaga zatwierdzenia budżetu przez zarząd.
- **Kto decyduje:** zarząd (kwota limitu).
- **Protokół:** przyczyna wzrostu, nowy limit, data zatwierdzenia.

## 8. Usunięty lub uszkodzony obiekt w Storage Bucket

- **Diagnoza:** raport kopii bucketu (#103) zgłasza niezgodny skrót lub
  brakujący obiekt; zgłoszenie "nie mogę otworzyć dokumentu".
- **Działanie:** sprawdzić w drugiej kopii (S3 poza Railway, #103), czy
  obiekt istnieje z poprawnym skrótem; jeśli tak — przywrócić ręcznie z
  kopii. Jeśli obiekt brakuje też w kopii — dokument jest utracony;
  zanotować w protokole, nie próbować "zgadywać" treści.
- **Kto decyduje:** administrator techniczny (przywrócenie z kopii); zarząd,
  jeśli dokument jest dowodem księgowym i nie da się go odtworzyć.
- **Protokół:** identyfikator dokumentu (nie nazwa pliku), czy odzyskano.

## 9. Podejrzenie naruszenia ochrony danych

- **Diagnoza:** dowolne zdarzenie z kart 4/6/8, które mogło ujawnić dane
  osobowe rodzin, lub bezpośrednie zgłoszenie.
- **Działanie:** zebrać fakty techniczne (co, kiedy, zakres, czy
  potwierdzone) i przekazać **wyłącznie** administratorowi danych/IOD.
  Runbook **nie ocenia**, czy i w jakim terminie zgłosić naruszenie — to
  decyzja IOD, nie techniczna (założenie, nie przepis).
- **Kto decyduje:** administrator danych/IOD.
- **Protokół:** godzina przekazania do IOD, zebrane fakty (bez ich dalszej
  interpretacji prawnej w tym dokumencie).

## 10. Wyciek danych osobowych (dostęp osoby nieuprawnionej, błędny eksport, wysyłka do złych osób)

To karta **techniczna**: zabezpieczenie i zebranie faktów. Ocena, czy to
naruszenie ochrony danych, i decyzja o zgłoszeniu — wyłącznie administrator
danych/IOD (karta 9; założenie, nie przepis).

- **Diagnoza:** co i komu mogło zostać ujawnione — dziennik zdarzeń
  (identyfikatory, aktor, czas; bez adresów), ostatni eksport roczny
  (sekcja „Stan systemu”), przydziały ról (`GET /api/admin/grants`).
  Dokumenty leżą w prywatnym buckecie i są dostępne tylko przez krótkotrwały
  link po autoryzacji.
- **Działanie:** (1) ograniczyć dostęp: `POST /api/admin/users/{id}/disable`
  i `…/revoke-sessions` dla konta podejrzanego o przejęcie, wycofać przydział
  w panelu Konta i role (tryb `APP_WRITE_MODE=read_only` z karty 4 zatrzymuje
  zapisy, ale nie odczyt); (2) jeśli wyciekł sekret — rotacja wg karty 6;
  (3) niczego nie kasować i nie „poprawiać” historii — dziennik jest tylko do
  dopisywania; (4) zapisać fakty w protokole i przekazać IOD (karta 9);
  (5) nie wysyłać wiadomości do rodzin, dopóki zarząd i IOD nie zatwierdzą
  treści i listy odbiorców.
- **Kto decyduje:** administrator techniczny (zabezpieczenie), administrator
  danych/IOD (ocena i zgłoszenie), zarząd (komunikacja z rodzicami).
- **Protokół:** zakres (kategorie danych, liczba rodzin/uczniów — liczby, nie
  nazwiska), okno czasowe, wykonane zabezpieczenia, godzina przekazania IOD.

## 11. Awaria Brevo (e-mail nie wychodzi lub wychodzi błędnie)

- **Diagnoza:** „Stan systemu” / `GET /api/admin/ops-status`: kolejka
  (oczekujące, `failed`) i ostatni przebieg workera (`stoppedReason`).
  Kody zatrzymania (docs/EMAIL.md): `provider_rate_limited` (429 — wiadomości
  wracają do kolejki, czekać), `provider_unreachable` (brak połączenia —
  wiadomość wraca do kolejki), `provider_unavailable` (5xx/timeout — wynik
  **niepewny**, `delivery_unknown`), `provider_account_rejected`
  (401/402/403 — klucz, kredyty, nadawca), `provider_account_paused`
  (pauza po takiej odmowie, bez połączenia z Brevo). Monitor zewnętrzny widzi to jako
  `503` z `GET /health/jobs` (`email_worker_stale`, `email_queue_too_old`,
  `guardian_verify_queue_too_old` — kod weryfikacyjny nowego adresu czeka
  w kolejce; ten sam worker, te same przyczyny), jeśli został skonfigurowany
  (decyzja zarządu). Kolejka kodów: `guardianVerifyQueue` w `ops-status`
  (liczby, bez adresów i kodów).
- **Działanie:** nie ponawiać na ślepo. Wiadomości `delivery_unknown`
  sprawdzić w panelu Brevo (nagłówki `X-Mailin-custom` = id wiersza,
  `X-RD-Idempotency-Key`) zanim ktokolwiek zdecyduje o ponowieniu; klucz
  idempotencji (kampania + rodzina) chroni przed duplikatem po naszej
  stronie, nie po stronie Brevo. Przy `provider_account_rejected` /
  `provider_account_paused` (#209: po odmowie konta wysyłka jest wstrzymana
  do jawnego potwierdzenia) poprawić klucz (`BREVO_API_KEY`, karta 6) lub
  konto, sprawdzić `npm run email:preflight -- --check-account`, a potem
  członek zarządu potwierdza naprawę w panelu kampanii
  (`POST /api/email/provider-pause/lift`); w tym czasie wysyłkę można
  wyłączyć `EMAIL_SENDING_ENABLED=false`. Wstrzymanie kampanii:
  `POST /api/email/campaigns/{id}/pause` (wznowienie: `…/resume`). Wynik
  wiadomości niepewnych rozstrzyga zarząd przez `…/resolutions`. Błędy
  pojedynczych adresów (`failed`, `bounced`) to nie awaria dostawcy — lista
  `…/attention` pokazuje adres maskowany.
- **Kto decyduje:** administrator techniczny (klucz, przełącznik wysyłki);
  zarząd/skarbnik (wstrzymanie, wznowienie, rozstrzygnięcie niepewnych).
- **Protokół:** kod zatrzymania, liczba wiadomości `failed` i
  `delivery_unknown` (liczby, bez adresów), decyzja o wznowieniu.

## 12. Awaria bazy danych (PostgreSQL) — dane budzą wątpliwości

Uzupełnia kartę 1 o przypadki, w których baza odpowiada, ale wynik zapisów
lub stan danych jest niepewny.

- **Sygnały:** `GET /health` (proces żyje), `GET /health/ready` (`database`,
  `migrations`; 503 = aplikacja nie obsługuje ruchu — patrz karta 1).
  `GET /health/jobs` nie zastępuje readiness.
- **Działanie:** (1) nie uruchamiać `npm run db:migrate:postgres` ani ręcznych
  zmian w bazie „na próbę”; (2) jeśli w logu jest `api_route_error` z
  `class: outcome_unknown` (karta 3) — sprawdzić stan danych, nie ponawiać
  zapisów; (3) przy możliwej niespójności `APP_WRITE_MODE=read_only`
  (karta 4); (4) odtworzenie wyłącznie do bazy **innej niż produkcyjna**:
  `npm run restore:drill` po kopii z `npm run backup:postgres`, porównanie
  raportu (procedura w docs/RAILWAY_OPERATIONS.md); przywrócenie produkcji to
  osobna decyzja zarządu.
- **Kto decyduje:** administrator techniczny (diagnoza, tryb odczytu); zarząd
  (przywrócenie produkcji).
- **Protokół:** czas niedostępności, ostatnia znana dobra kopia (znacznik
  czasu ze „Stanu systemu”; „brak danych” nie znaczy „aktualna”), zakres luki
  danych.

## 13. Zablokowany skarbnik (utrata hasła, telefonu lub kodów MFA)

- **Diagnoza:** `429 too_many_attempts` (blokada logowania 15 min) i
  `429 mfa_locked` mijają same po `Retry-After` (docs/AUTH.md) — bez
  interwencji. Utrata hasła lub telefonu i kodów odzyskiwania wymaga resetu.
- **Działanie:** konto skarbnika jest **chronione** (#146): reset nie
  powstaje z jednej ręki. Administrator A zgłasza wniosek —
  `POST /api/admin/users/{id}/password-reset` lub `…/mfa-reset` (odpowiedź
  `202`); inny administrator B zatwierdza —
  `POST /api/admin/account-requests/{requestId}/approve` (krok w górę MFA).
  Token resetu hasła dostaje zatwierdzający i przekazuje go skarbnikowi
  **osobnym, zaufanym kanałem** (aplikacja nie wysyła tokenu e-mailem).
  Wniosek ważny 24 h; odrzucenie: `…/reject`. Przy jednym administratorze
  reset skarbnika nie jest możliwy — to luka organizacyjna do decyzji zarządu
  (drugi administrator/zastępca); nie omijać jej edycją bazy. Sposób
  potwierdzenia tożsamości osoby przed resetem: D-10 (nierozstrzygnięte
  tutaj). Wnioski i zdarzenia resetu są w dzienniku (aktor, czas, id wniosku).
- **Kto decyduje:** dwóch różnych administratorów (wniosek i zatwierdzenie);
  zarząd — zasady potwierdzania tożsamości.
- **Protokół:** czas zgłoszenia, identyfikator wniosku, kto zatwierdził, czas
  odzyskania dostępu. Bez haseł, tokenów i kodów.

## 14. Błędny import uczniów

- **Diagnoza:** raport błędów CSV (bez imion i adresów), różnice po zapisie,
  zgłoszenie użytkownika. Zapis (`POST /api/import/commit`) to jedna
  transakcja „wszystko albo nic”, ze zdarzeniem `import.committed`
  (identyfikator partii, rok, liczniki).
- **Działanie:** **nie ma trasy cofającej import** — nie usuwać wierszy
  ręcznie. (1) Ustalić zakres z licznikami zdarzenia i dziennika partii
  (`import_batches`); (2) błąd niewielu rekordów — poprawić zwykłymi trasami
  (zmiany relacji zapisują się jako nowe wiersze historii) albo zaimportować
  poprawiony plik po podglądzie (`POST /api/import/preview`); (3) błąd
  masowy — `APP_WRITE_MODE=read_only` (karta 4) i odtworzenie do osobnej bazy
  z kopii sprzed importu (karta 12); zamiana produkcji to decyzja zarządu.
  Przed każdym importem produkcyjnym wykonać kopię (`npm run backup:postgres`).
  Do czasu sprawdzenia danych nie tworzyć kampanii e-mail.
- **Kto decyduje:** zarząd (zakres poprawki, przywrócenie), administrator
  techniczny (diagnoza).
- **Protokół:** identyfikator partii, rok szkolny, liczniki, sposób poprawki
  (nowe zapisy albo odtworzenie).

## 15. Cofnięcie wysyłki e-mail

Wiadomości przyjętej przez Brevo **nie da się cofnąć**; można zatrzymać resztę
(uzupełnia kartę 5).

- **Diagnoza:** kampania w trakcie wysyłki, rosnąca liczba `sent` w raporcie
  (`GET /api/email/campaigns/{id}/report` — wyłącznie agregaty).
- **Działanie:** (1) natychmiast `POST /api/email/campaigns/{id}/pause`
  (wznowienie: `…/resume`) albo `POST …/cancel` (zatrzymuje wiersze
  oczekujące; odpowiedź podaje `inFlight` — wiadomości już przekazane
  dostawcy, które mogą jeszcze wyjść); (2) jeśli to za mało —
  `EMAIL_SENDING_ENABLED=false`; (3) raport: ile wysłano i do ilu rodzin
  (liczby, **bez adresów**); (4) sprostowanie tylko po zatwierdzeniu treści i
  listy odbiorców przez zarząd — jako nowa kampania z własnym kluczem
  idempotencji, nie ponowienie starej (AGENTS.md). Żadnych „testów” do
  prawdziwych rodziców.
- **Kto decyduje:** zarząd/skarbnik (wstrzymanie, anulowanie); zarząd
  (sprostowanie).
- **Protokół:** czas wykrycia i zatrzymania, liczba wysłanych i zatrzymanych
  (`cancelledMessages`, `inFlight`), decyzja o sprostowaniu.

---

## Szablon protokołu incydentu

```
Data i godzina wykrycia:
Kto wykrył (rola, nie nazwisko — chyba że to konieczne):
Godzina pierwszej reakcji:
Karta runbooka użyta:
Zakres (usługi/tabele/okresy dotknięte — bez danych osobowych):
Działania podjęte (chronologicznie):
Decyzje podjęte i przez kogo:
Czy dotyczy danych osobowych rodzin/dzieci: TAK / NIE — jeśli TAK, przekazano IOD o (godzina):
Godzina zamknięcia incydentu:
Wnioski / co zmienić w procedurze:
```

## Zobacz też

- [`/api/admin/ops-status`](RAILWAY_OPERATIONS.md#stan-systemu-149) — stan
  migracji, workera e-mail, kolejki, ostatniej kopii zapasowej i eksportu,
  dla administratora.
- [`/health/jobs`](RAILWAY_OPERATIONS.md#stan-systemu-149) — heartbeat dla
  monitora zewnętrznego (chroniony tokenem), progi w zmiennych środowiskowych
  (`BACKUP_MAX_AGE_HOURS`, `EMAIL_WORKER_MAX_AGE_HOURS`, `EMAIL_QUEUE_MAX_AGE_HOURS`, `GUARDIAN_VERIFY_QUEUE_MAX_AGE_HOURS`).
- Narzędzie monitora zewnętrznego i dyżur/zastępstwa — do decyzji zarządu
  (nierozstrzygnięte tutaj).
