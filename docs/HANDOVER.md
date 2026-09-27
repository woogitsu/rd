# Handover — praca nad issues RD (sesja 2026-09-27)

Dokument dla modelu/osoby przejmującej pracę. Stan na 2026-09-27 ~17:30 UTC.

## 1. Zasady (przeczytaj najpierw)
- `AGENTS.md` jest wiążący: polski, EUR w centach, dane wyłącznie syntetyczne, autoryzacja po stronie serwera, trwały audyt bez PII, brak statusu „dłużnik”, brak wysyłki bez zatwierdzenia, **brak produkcyjnego deployu bez decyzji szkoły/IOD**, jeden PR = jeden spójny zakres, migracja + opis skutków dla każdej zmiany schematu.
- Decyzje organizacyjne: `docs/DECISIONS.md` (D-01…D-21). Nie podejmuj ich za zarząd/szkołę.
- Gałąź robocza: `claude/determined-noether-95gpi9` (PR-y do `main`, scalanie metodą **merge**, nie squash — inaczej gałąź rozjeżdża się z `main` i potrzebny byłby force-push, zablokowany w tym środowisku).
- CI: `.github/workflows/ci.yml` na runnerze self-hosted, ~2–5 min. Lokalnie: `npm ci`, `node --test --test-concurrency=2 tests/*.test.js` (pełny zestaw ~5 min; PGlite ≈ 550 MB RAM na instancję — nie uruchamiaj wielu równolegle).
- Po scaleniu PR: `git fetch origin main && git merge --ff-only origin/main` na gałęzi roboczej, potem kolejny cherry-pick.

## 2. Co jest na `main` (scalone PR #50–#71)
| PR | Zakres | Issue |
|---|---|---|
| #50 | Rejestr decyzji `docs/DECISIONS.md` | #1 (otwarte — decyzje szkoły) |
| #51 | Warstwa PostgreSQL: `src/db.js`, `src/pg/*`, sesje, role, zaproszenia (dane), audyt, router `src/pg/app.js`, migracja 0004 | #35 ✔ |
| #52 | Druk kartek o dobrowolnej składce `print/` | #11 |
| #53 | `railway.json`, smoke test, test wolumenu, `docs/RAILWAY_OPERATIONS.md` | #41 (część) |
| #54 | Wpłaty na PostgreSQL (parity ze starym Workerem) | #37 ✔ |
| #55 | Wydarzenia backend + migracja 0008 | #12 |
| #56 | Zebrania/protokoły/uchwały + migracja 0009 | #13 |
| #57 | Transakcyjny import CSV/XLSX + migracja 0005 | #36 ✔ |
| #58 | Prywatne dokumenty (Storage Bucket S3/SigV4) + migracja 0006 | #39 ✔ |
| #59 | Księga i preliminarz na PostgreSQL + eksport CSV | #38 ✔ |
| #60 | Panel wydarzeń `events/` | #12 |
| #61 | Przegląd bezpieczeństwa SR-01..SR-04 (`docs/SECURITY_REVIEW.md`) | #4 |
| #62 | Testy równoważności API + poprawka strefy czasu w restore D1 | #31/#41/#47 |
| #63 | Panel dokumentów `documents/` | #39/#8 |
| #64 | Kolejka Brevo, kampanie, limit dzienny + migracja 0007 | #40 ✔ |
| #65 | WCAG 2.2 AA + `docs/ACCESSIBILITY.md` | #16 |
| #66 | Test wydajności `scripts/load-test.js` | #16/#41 |
| #67 | Strona publiczna `site/` | #12/#14 |
| #68 | Panel zebrań `meetings/` | #13 |
| #69 | Aktualności i galeria z weryfikacją praw + migracja 0018 | #14 |
| #70 | Konta i role (admin API + `admin/`) | #3/#4/#9 |
| #71 | Uzgodnienie rachunku + raport Komisji Rewizyjnej + migracja 0015 | #7 |

Uwaga: GitHub zamyka issues z „Closes #N” w opisie PR (✔). Pozostałe issues mają checklisty — zaktualizuj je (np. #31 checklista, #2, #3, #4, #5, #6, #7, #9, #10, #16).

## 3. KOLEJKA — gotowe, NIE scalone (backup: gałąź `claude/determined-noether-95gpi9-queue`, HEAD `d3b7e2a`)
Commity są liniowo na tej gałęzi. Pierwsze pozycje tej gałęzi (2203fe2 … 8f2f159, c86113f, 6541241, ba2a70c, 92c0200) **są już na main** pod innymi hashami — pomiń je. Do zrobienia, w tej kolejności, po jednym PR:

| # | Commit(y) | Zakres | Uwagi |
|---|---|---|---|
| 1 | `dd45858` | Eksport roczny z manifestem SHA-256, restore do pustej bazy, migracja 0016 | #9 |
| 2 | `0c9f092` | Rodziny: wiele gospodarstw ucznia, API rodzin z zakresem klasy, panel `families/`, migracja 0014 | #5; triggery na students/guardians/enrollments — sprawdź `tests/pg-import.test.js` |
| 3 | `7c99bd3` | `GET /api/print/cards` + wczytanie z serwera w `print/` | #11 |
| 4 | `fd0ebf9` | Zamknięcie roku, zamrożenie zapisów (`a0_year_freeze`), migracja 0017 | #15 |
| 5 | `a0b63d9` + `00e3cad` | MFA TOTP, kody odzyskiwania, limity prób, migracja 0013, przekazanie `MFA_ENCRYPTION_KEY` | #3 |
| 6 | `6cc68d0` + `e34676f` | `/health/ready`, logi JSON z redakcją PII, graceful shutdown, `railway.json` start `node src/server.js` + `drainingSeconds` | #16/#41 |
| 7 | `7cae8db`, `c600b26`, następnie `git cherry-pick -m 1 c067ea4`, potem `2533548`, `d3b7e2a` (NIE cherry-pickuj osobno `4de51f6` — jest w merge'u) | Autoryzacja: SR-01b (przydział klasowy działał ogólnoszkolnie w księdze, e-mailu, uzgodnieniach, raporcie, eksporcie), 404 zamiast 403 dla wydarzeń/zebrań poza zakresem, poprawki API wydarzeń i zebrań (quorum PATCH merge, wymagane źródło reguły, 409 dla `school_year_closed`), pełna macierz autoryzacji 118 tras / 16 modułów, DOC-01 | #4; na gałęzi `combined` pełny zestaw 528/528 |

Każdy krok: cherry-pick na gałąź roboczą (zsynchronizowaną z main), `node --test` plików modułu, push, PR z opisem (Zmiana / Migracja / Testy / Ryzyka, jak w poprzednich PR), CI zielone → merge (metoda merge).

Konflikty były rozwiązywane jako sumy: `src/pg/app.js` (importy + ROUTES), `src/node-app.js` STATIC_PREFIXES, `package.json` scripts/`build`, `ci.yml` kroki build, README, `postgres/README.md`, `src/server.js` obiekt env. Pozycje kolejki zostały już zrebazowane na siebie, więc przy zachowaniu kolejności cherry-picki powinny wchodzić czysto.

## 4. W TOKU w chwili przekazania
**Logowanie e-mail + hasło + 2FA TOTP (Google/Microsoft Authenticator)** — wskazanie użytkownika z 2026-09-27 (zapisać w D-10 jako wskazanie do formalnego potwierdzenia przez zarząd/IOD). Agent pracował na gałęzi lokalnej `login` od `c600b26`; poproszony o wypchnięcie na `claude/determined-noether-95gpi9-login` (sprawdź, czy istnieje: `git ls-remote origin 'refs/heads/claude/*'`). Jeśli nie ma — zaimplementuj od zera wg specyfikacji:
- migracja `0020_password_login.sql`: `user_passwords` (scrypt z parametrami w stringu), limity prób (tylko SHA-256 e-maila/IP), jednorazowe tokeny resetu wydawane przez admina;
- `src/pg/password.js` (scrypt, `timingSafeEqual`, polityka NIST 800-63B: min 12 znaków, lista popularnych haseł, weryfikacja na dummy hash dla nieznanego e-maila);
- `src/pg/routes/login.js`: `POST /api/login` (ogólny błąd `invalid_credentials`, 429 z Retry-After, audyt bez e-maila), `POST /api/invitations/accept`, `POST /api/password/change` (cofa inne sesje), `POST /api/password/reset`; w admin API `password-reset` i `mfa-reset`;
- polityka: `MFA_REQUIRED_ROLES` (domyślnie admin, board, treasurer) — bez potwierdzonego czynnika 403 `mfa_enrollment_required`; weryfikacja kodu przez istniejące `/api/mfa/verify` (rotuje sesję);
- UI `login/` (QR otpauth — np. pakiet `qrcode` z przypiętą wersją, bez CDN; `autocomplete` username/current-password/one-time-code; bez CAPTCHA; token zaproszenia we fragmencie URL), `/` → 308 na `/login/`;
- testy `tests/pg-login.test.js`, `tests/login-core.test.js`; dokumentacja AUTH/ACCOUNTS/DECISIONS.
Zależy od pozycji 5 i 7 kolejki (MFA, admin, autoryzacja) — scal ją najpierw.

## 5. Znane otwarte kwestie techniczne
- **SR-05 (ważne przed produkcją):** blokady niezmienności to triggery — właściciel tabel może je obejść (`TRUNCATE`, `DISABLE TRIGGER`, `session_replication_role`). Aplikacja musi łączyć się osobną rolą bez własności tabel; migracje i restore — rolą właściciela. Dopisać instrukcję SQL do `docs/RAILWAY_OPERATIONS.md`.
- SR-07 (częściowo): payments corrections/assignment nadal 403 vs 404 (zachowana zgodność ze starym API); zarządzanie zebraniami 403.
- SR-10: brak MFA dla uchwał i publikacji wydarzeń (decyzja zarządu). SR-12: `PUBLIC_BASE_URL` powinien być obowiązkowy. SR-13: brak rate limitingu poza logowaniem.
- Zamrożenie roku (0017) nie obejmuje tabel z 0012/0015/0016 z `school_year_id` (uzgodnienia, eksporty); w uzgodnieniach/e-mailu/news/dokumentach `school_year_closed` może dawać 503 zamiast 409.
- Dokumenty: lista stosuje LIMIT przed filtrem dostępu (krótsze strony); brak endpointu z limitem `DOCUMENT_MAX_BYTES` dla klienta; brak skanu AV; Railway nie backupuje bucketów.
- E-mail: doba limitu w UTC; brak zdejmowania blokady (suppression); cron Railway tylko opisany (`15 7-18 * * 1-5` UTC, `npm run email:worker -- --send`).
- Migracje mają numery nie w kolejności scalania (0008/0009 przed 0005–0007 itd.) — runner sortuje po nazwie; na świeżej bazie OK, na istniejącej niższe numery wykonałyby się później. Przed pierwszym stagingiem uruchamiać na pustej bazie.
- `scripts/smoke-postgres.js` nie sprawdza wszystkich paneli (events, meetings, documents, site, admin, families).
- Ścieżka `legacy_d1` w 0008 pozwala wstawić opublikowane wydarzenie bez zatwierdzenia bezpośrednim SQL (SR-06) — zablokować migracją po imporcie D1.
- Brak endpointu publicznej listy lat szkolnych (strona `site/` zakłada format ID `2026-2027`).

## 6. Czego NIE robić bez decyzji
- Produkcyjny deploy Railway (D-20), import prawdziwych danych (D-01…D-07), wysyłka e-maili do rodziców (D-16/D-17, domena Brevo), usunięcie Workera/D1 (#42 — dopiero po odbiorze stagingu i próbie odtworzenia).
- Staging na danych syntetycznych jest dozwolony technicznie; użytkownik pytał o uruchomienie na Railway — zaproponowano staging po scaleniu kolejki i logowania (Railway MCP dostępny). Czekało na odpowiedź użytkownika.

## 7. Plan na staging (po scaleniu kolejki + logowania)
1. Projekt Railway w UE (Amsterdam): usługa Node, prywatny PostgreSQL, prywatny Storage Bucket.
2. Zmienne: `DATABASE_URL` (prywatny), `PUBLIC_BASE_URL`, `APP_ENV=staging`, `MFA_ENCRYPTION_KEY`, `BUCKET_*`, `EMAIL_SENDING_ENABLED` **nieustawione**, `EMAIL_TEST_ALLOWLIST` tylko adresy techniczne.
3. Osobna rola bazy aplikacji (SR-05). Ręcznie `npm run db:migrate:postgres` (nigdy przy starcie).
4. `/health/ready`, `npm run storage:smoke`, `npm run load:test -- --target … --i-confirm-staging`, próbne odtworzenie (`docs/RAILWAY_OPERATIONS.md`, `docs/EXPORT.md`), wypełnić tabele wyników.

## 8. Przydatne pliki
`docs/RAILWAY_MIGRATION.md`, `docs/RAILWAY_OPERATIONS.md`, `docs/SECURITY_REVIEW.md`, `docs/AUTHORIZATION.md` (macierz), `docs/EQUIVALENCE.md`, `docs/DECISIONS.md`, `postgres/README.md` (skutki migracji), `tests/helpers/pg.js` (`createTestDb`, `seedUserSession`, `request`), `tests/helpers/route-matrix.js` (dodając nową trasę, dopisz ją do macierzy — meta-test tego pilnuje).
