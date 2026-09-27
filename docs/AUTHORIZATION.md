# Autoryzacja i zakres ról

Każda chroniona trasa najpierw ładuje aktywną sesję, a następnie aktywne wpisy z tabeli role_grants. Frontend może ukrywać niedostępne funkcje, ale nie jest granicą bezpieczeństwa.

## Semantyka zakresu

- Trasa jawnie podaje dozwolone role. Pusta lub błędna polityka zawsze odmawia dostępu.
- class_id w przydziale ogranicza dostęp do jednej klasy. Brak class_id oznacza zakres wszystkich klas, ale wyłącznie wtedy, gdy dana trasa jawnie dopuszcza tę rolę.
- school_year_id ogranicza przydział do roku szkolnego. Brak wartości oznacza przydział niezależny od roku.
- Przydziały po expires_at nie są ładowane.
- Polityka operacji finansowej może wymagać sesji z potwierdzonym MFA.

Przedstawiciel klasy ma w schemacie obowiązkowy class_id, dlatego nie może przejść kontroli dla innej klasy. Zakresy poszczególnych funkcji nadal wymagają zatwierdzenia szkoły; ten moduł nie przypisuje rolom domyślnych zdolności.

GET /api/access zwraca zalogowanemu użytkownikowi wyłącznie jego własne aktywne przydziały. Nie zwraca danych innych użytkowników.

## PostgreSQL (issue #35) — prototyp

`src/pg/authorization.js` ładuje przydziały z PostgreSQL i używa tej samej funkcji `isAuthorized`. Pomija przydziały wygasłe oraz cofnięte (`revoked_at`). Cofnięcie (`revokeRoleGrant`) nie usuwa wiersza: zapisuje `revoked_at`, `revoked_by` i zdarzenie `role_grant.revoked` w jednej transakcji; działa od następnego żądania. Przydziału nie da się usunąć ani zmienić jego zakresu — nowy zakres to nowy wiersz (trigger z migracji 0004).

Moduły tras używają `requireAccess(request, env, { roles, classId, schoolYearId, requireMfa }, json)`: `401 unauthenticated` bez sesji, `403 forbidden` bez roli, zakresu lub MFA. Trasa dotycząca klasy lub roku **musi** podać `classId` i `schoolYearId` — bez nich przydział ograniczony do klasy nie jest zawężany. Operacje finansowe podają `requireMfa: true`. Role `principal` i `audit` nie mają domyślnych uprawnień; trasa dopuszcza je tylko jawnie, po decyzji szkoły.

Import uczniów (`/api/import/*`, #36) dopuszcza role `admin` i `board` z MFA i tylko z przydziałem bez `class_id` (wszystkie klasy) obejmującym wybrany rok. Przydział zarządu ograniczony do klasy nie wystarcza — kontrola jest dodatkowa względem `isAuthorized`, która przy braku `classId` w wymaganiu przepuszcza przydziały klasowe. Zakres ról importu to założenie do decyzji D-08.
