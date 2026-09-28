# Panel kampanii e-mail

Lokalnie uruchom serwer (`npm start`) oraz interfejs (`npm run dev:email`). Panel korzysta wyłącznie z chronionych tras `/api/email/*` (src/pg/routes/email.js); użytkownik musi mieć aktywną sesję, MFA i rolę zarządu lub skarbnika w wybranym roku szkolnym. Zatwierdzenie widzi wyłącznie zarząd, i to inna osoba niż ta, która przygotowała treść albo migawkę odbiorców.

Ekran pokazuje listę kampanii roku, szkic treści, migawkę odbiorców z liczbą i powodami wykluczeń, plan wysyłki względem dziennego limitu Brevo oraz listę odbiorców z zamaskowanymi adresami (pełny adres po kliknięciu; każde otwarcie listy zapisuje się w dzienniku niezależnie od tego, czy panel pokazuje maskę). Zatwierdzenie wymaga aktualnej migawki i pokazuje dokładną liczbę odbiorców przed odblokowaniem przycisku.

**Żaden przycisk tego ekranu nie wysyła poczty.** Zatwierdzenie i zakolejkowanie tylko przygotowują wiersze w `email_outbox` — wysyła je wyłącznie osobne zadanie `scripts/email-worker.js`, uruchamiane niezależnie od panelu.

Prototyp — nie używać na danych rzeczywistych przed decyzją zarządu o szablonie wiadomości (D-16) i nadawcy/adresatach (D-17); ekran pokazuje wtedy ostrzeżenie zamiast domyślnie „zatwierdzonej” treści.
