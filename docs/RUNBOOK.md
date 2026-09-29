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
  (`BACKUP_MAX_AGE_HOURS`, `EMAIL_WORKER_MAX_AGE_HOURS`, `EMAIL_QUEUE_MAX_AGE_HOURS`).
- Narzędzie monitora zewnętrznego i dyżur/zastępstwa — do decyzji zarządu
  (nierozstrzygnięte tutaj).
