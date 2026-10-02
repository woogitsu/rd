# Handover dla następnej sesji (stan na 2026-10-02, ok. 08:30 UTC)

Dokument dla sesji, która przejmuje autonomiczną pracę nad repozytorium. Najpierw przeczytaj
`AGENTS.md`, `README.md`, `docs/DECISIONS.md` (w tym sekcję „Wskazania użytkownika 2026-10-02”)
i `docs/TESTING.md`. Ten plik opisuje stan i sposób pracy, nie zastępuje tamtych dokumentów.

## Tryb pracy uzgodniony z właścicielem

- Praca autonomiczna, równolegle do około 5 agentów (Sonnet) w izolowanych worktree. Gdy agent kończy,
  uruchom następnego. PR otwiera i scala sesja główna, nie agent.
- **Scalanie do `main` tylko przy zielonym `ci-ok`** na aktualnym head PR (`merge`, nie squash,
  z `expectedHeadSha`). Gdy baza PR jest stara, a od tego czasu na `main` weszły zmiany w tych samych
  obszarach — przed scaleniem wciągnij `main` lokalnie i uruchom dotknięte testy.
- Zamykaj ukończone issue z komentarzem i dowodem (PR, pliki testów, wynik).
- Decyzje zarządu/szkoły (D-xx) zadawaj właścicielowi **w formie klikalnej** (pytania z opcjami),
  zapisuj w `docs/DECISIONS.md` jako „wskazanie użytkownika <data>” (to nie jest decyzja zarządu —
  wymaga formalnego potwierdzenia), a dopiero potem wdrażaj.
- Odstępstwo uzgodnione wcześniej: w #80 zostaje kod `422 date_outside_school_year` (opisane w docs).
- Język: polski w PR, commitach, komentarzach i docs. Opis PR: Zmiana / Migracja / Testy / Ryzyka;
  nigdy nie oznaczaj prototypu jako gotowego do pracy na danych rodzin.
- Trailery commitów i stopka PR zgodnie z instrukcjami sesji; bez identyfikatorów modelu w artefaktach.

## Otwarte PR i niedokończona praca

| Co | Gałąź | Stan | Następny krok |
|---|---|---|---|
| D-07: „Pominięto N rodzin z ograniczeniem przetwarzania” na kartkach | `claude/epic-archimedes-dmgc7e-d07-print` | PR #699, CI w toku | Scal po zielonym `ci-ok`. |
| D-09: rola `audit` czyta księgę i dokumenty finansowe (wariant b, za flagą env) | `claude/epic-archimedes-dmgc7e-d09-audit` | **WIP, niezweryfikowane** (commit „WIP …”; agent był przy końcowym przebiegu testów, typecheck czysty) | Przejrzyj diff, uruchom: testy dotknięte, `pg-authz-matrix`, `audit-role-route-inventory`, `pg-api-errors-catalog`, `openapi`, `pg-data-access-coverage`, `env-catalog`, lint, docs-consistency, testing-matrix; otwórz PR. |
| Podgląd PDF przez PDF.js (lokalnie, bez CDN), PDF `inline` → 400 | `claude/epic-archimedes-dmgc7e-pdfjs` | **WIP, niezweryfikowane** (nowa zależność `pdfjs-dist`, vite config w `documents/`) | Dokończ testy: `pg-documents*`, `csp-static` (CSP nie może dostać `unsafe-eval` ani zewnętrznych hostów), `api-errors`, `openapi`, e2e `documents-preview` (po `npm run build`), `npm audit --omit=dev --audit-level=high`; otwórz PR. |
| Rola „dyrekcja” (zebrania + raporty zbiorcze, bez księgi/wpłat/rodzin) | `claude/epic-archimedes-dmgc7e-director` | **WIP, niezweryfikowane**; **brak migracji** rozszerzającej dozwolone role (`role_grants.role`) | Dodaj migrację `0183_*` (sprawdź numer > max na `main`) + akapit w `postgres/README.md` + `npm run migrations:manifest`/`check-functions`; dokończ testy (`tests/pg-principal-role.test.js`, macierz, `pg-api-errors-catalog`, `openapi`, `audit-role-route-inventory`). |

## Pierwsze zadanie: nocny przebieg na prawdziwym PostgreSQL jest czerwony

- Workflow `.github/workflows/nightly-pg-real.yml` (`test:pg-real -- --all` + `test:pg-mutations`).
  Harmonogram 02:17 UTC nie uruchomił się pierwszej nocy (nowy workflow); uruchomiono ręcznie
  (`workflow_dispatch`, run `36978577852`, commit `86d41a1c`) — **padł krok `npm run test:pg-real -- --all`**
  po ok. 16 min. Ogon logu to log kontenera PostgreSQL, więc nazw testów nie ustalono — pobierz pełny log
  kroku (UI Actions albo `get_job_logs` i grep `not ok`/`NIEPOWODZENIE`), napraw w osobnym PR, uruchom
  ponownie `workflow_dispatch` na `main`.
- Pełnego `--all` **nie uruchamiaj w kontenerze sesji** — dwukrotnie zrestartował kontener. Lokalnie
  uruchamiaj pojedyncze pliki: `node scripts/test-pg-real.js tests/<plik>.test.js` (skrypt sam stawia PG16).

## Kolejne zadania (bez dodatkowych decyzji)

1. **Zawiadomienia o zebraniu zarządu** (issue #113, D-21 + D-16/D-17 wskazania 2026-10-02): odbiorcy =
   aktywne przydziały zarządu, przedstawicieli, KR i dyrekcji w roku; dziś `src/pg/meetings.js` zwraca
   409 `notice_campaign_audience_unsupported` dla zebrania zarządu. Wymaga odbiorców-kont w kampaniach
   (klucz idempotencji kampania + konto, migawka odbiorców, kolejka, osobne wiadomości, limity Brevo).
   Treść = szkic z szablonu do zatwierdzenia, wysyłka tylko po jawnym zatwierdzeniu, nadawca wyłącznie
   z konfiguracji (bez domyślnego adresu). Zacznij po scaleniu roli dyrekcji.
2. **E-mail weryfikacyjny przy zmianie kontaktu** (#140, D-16/D-17): jak wyżej — szkic do zatwierdzenia.
3. **D-04**: wskazanie „bez automatycznego usuwania” — dopisz w `docs/RETENTION.md`/`DATA_REQUESTS.md`,
   że dziennik odczytów i historia sprostowań nie są usuwane automatycznie (tylko anonimizacja rodziny).
4. Po scaleniu PDF.js zamknij #89 z dowodem; po D-09 zaktualizuj #137; po D-07 #100.
5. Drobne z przeglądu: test `tests/pg-real-idempotency-quota.test.js` używa dat 2027 r. — przesunąć
   przed ok. czerwcem 2027 r. albo wstrzyknąć czas zapisu.

## Ważne pułapki (powtarzały się w tej sesji)

- **Kolejność migracji**: numer > max na `main` (ostatnia: `0182_identity_changes.sql`); akapit każdej
  migracji w `postgres/README.md` w kolejności numerów, z pustą linią przed; `npm run migrations:manifest`.
- **Pliki generowane** przy konfliktach: `docs/openapi.json` (`npm run openapi:build`),
  `docs/PRIVACY_INVENTORY.md` (`node scripts/privacy-report.js`), `postgres/migrations/MANIFEST.json` —
  generuj, nie rozwiązuj ręcznie. `docs/TESTING.md` i `docs/API.md` często mają konflikty dopisanych
  akapitów/wierszy — zachowaj obie strony. Test `docs-consistency` zabrania znaczników konfliktu.
- **Testy-strażnicy liczące trasy**: `tests/audit-role-route-inventory.test.js` (tabela „Zakres roli audit”
  w `docs/AUTHORIZATION.md` — liczba tras per moduł) i `tests/pg-api-errors-catalog.test.js` (tabela
  403/404 per moduł w `docs/API_ERRORS.md`). Nowa trasa = aktualizacja tych tabel.
- **Lint testów** (`tests/test-quality-lint.test.js`): `every()` wymaga asercji niepustości; równoległe
  zapisy na PGlite muszą mieć w tytule „(PGlite: po kolei, nie wyścig)”; zakaz `DISABLE TRIGGER` /
  `session_replication_role` poza listą (limit `TRIGGER_BYPASS_LIMITS` musi być równy stanowi);
  negatywne asercje na krótkich liczbach (`!x.includes('470')`, `doesNotMatch(/…|2500|…/)`) są zakazane —
  używaj `(?<![\w-])2500(?![\w-])` (losowe UUID dawały fałszywe porażki).
- **Testy kampanii/kartek**: wywołuj `seedPublishedPrivacyNotice(db)` z `tests/helpers/pg.js`.
- **pg vs PGlite**: `int8`/`count(*)` wracają z `pg` jako tekst (PGlite: liczba); `DATE` z `pg` = północ
  lokalna. Używaj `::int`/`toSafeInteger`/`to_char`; daty dzienne z `timestamptz` przez helpery
  `brusselsDaySql`/`brusselsDateSql` z `src/pg/today.js` (strefa szkoły `Europe/Brussels`).
  Test `tests/pg-real-type-parity.test.js` pilnuje znanych rozbieżności.
- **CI**: kolejny push na tę samą gałąź anuluje poprzedni przebieg → `ci-ok` „failure” z `cancelled`
  (to nie błąd). Czasem przebieg główny nie startuje (widać tylko CodeQL) — wciągnięcie `main` i push
  go uruchamia. `npm run typecheck` lokalnie wymaga `@types/node` (`npm ci` w worktree, nie symlink).
- **Dysk**: worktree agentów zajmują dużo miejsca (87 worktree ≈ 27 GB) — usuwaj po scaleniu
  (`git worktree remove --force`, `git worktree prune`).

## Stan na koniec tej sesji

- `main` = `f9a1a99b` (scalone m.in. #672–#698). Zamknięte issue w tej części: #96, #115, #155, #196.
- Issue z komentarzem „czeka na decyzję/weryfikację”: #83, #89, #100, #112, #128, #133, #140.
- Decyzje nadal otwarte (do zarządu/IOD): formalne potwierdzenie wszystkich wskazań z 27.09 i 02.10,
  D-01–D-03, D-06, D-11–D-15, D-18–D-20, D-22, D-23 (`docs/DECISIONS.md`).
