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
