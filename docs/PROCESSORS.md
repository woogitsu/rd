# Podmioty przetwarzające (projekt — do weryfikacji przez IOD)

> Ta tabela jest materiałem technicznym dla rejestru czynności (D-01, D-05).
> **Nie jest** umową powierzenia ani jej streszczeniem — treść umów (DPA) i status
> ich zawarcia ustala administrator z każdym dostawcą osobno. Repo odwołuje się do
> publicznych dokumentów dostawców, nie kopiuje ich treści.

| Usługa | Jakie dane | Region | Umowa powierzenia (DPA) | Podprzetwarzający | Status D-05 |
|---|---|---|---|---|---|
| Railway — usługa aplikacji (Node.js) | wszystkie dane w pamięci procesu podczas obsługi żądań; brak trwałego przechowywania w usłudze aplikacji | UE, Amsterdam (`europe-west4-drams3a`) — weryfikować osobno przy każdym provisioningu ([`docs/RAILWAY_OPERATIONS.md`](./RAILWAY_OPERATIONS.md)) | [Railway DPA](https://railway.com/legal/dpa) (zawiera SCC — założenie: dostawca spoza UE, transfer do oceny) | lista podprzetwarzających Railway — [Railway Compliance](https://docs.railway.com/enterprise/compliance) | otwarta |
| Railway — PostgreSQL | wszystkie dane osobowe ze spisu ([`PRIVACY_INVENTORY.md`](./PRIVACY_INVENTORY.md)) | UE, Amsterdam — weryfikować osobno od usługi aplikacji | jw. | jw. | otwarta |
| Railway — Storage Bucket (prywatny) | dokumenty i zdjęcia; klucze obiektów bez oryginalnej nazwy pliku ([`docs/DOCUMENTS.md`](./DOCUMENTS.md)) | UE, Amsterdam — weryfikować osobno; druga lokalizacja kopii zapasowej też w UE ([`docs/RAILWAY_OPERATIONS.md`](./RAILWAY_OPERATIONS.md) „Kopie zapasowe”) | jw. | jw. | otwarta |
| Railway — logi platformy | logi aplikacji (bez PII wg `src/log.js`, do potwierdzenia praktyką) | zależne od planu; czas przechowywania „zależy od planu” ([`RAILWAY_OPERATIONS.md`](./RAILWAY_OPERATIONS.md)) | jw. | jw. | otwarta |
| Brevo — wysyłka e-mail | migawka adresu e-mail odbiorcy, treść kampanii, status dostarczenia/odbicia | do zweryfikowania przed produkcją (warunki przetwarzania danych dostawcy — [`docs/EMAIL.md`](./EMAIL.md)) | do zweryfikowania z dostawcą | do zweryfikowania z dostawcą | otwarta |
| GitHub — repozytorium i CI | wyłącznie dane syntetyczne (`@example.invalid`/`.test`) wg AGENTS.md; brak danych rodzin | — | nie dotyczy (brak danych osobowych w repo) | — | nie dotyczy |
| Cloudflare Workers/D1 (stary stos) | **nigdy nie wdrożony produkcyjnie**, brak danych szkoły ([`docs/RAILWAY_MIGRATION.md`](./RAILWAY_MIGRATION.md) „Stan wyjściowy”); pozostaje w repo do czasu usunięcia w #42 | — | nie dotyczy | — | do zamknięcia po #42 |
| Dostawca logowania/uwierzytelniania (D-10) | — | — | — | — | otwarta, brak decyzji |

## Zasady

- Region UE jest weryfikowany **osobno** dla aplikacji, bazy i bucketu — ustawienie
  regionu nie zastępuje oceny prawnej ani umowy powierzenia
  ([`docs/RAILWAY_MIGRATION.md`](./RAILWAY_MIGRATION.md)).
- Żadna nowa integracja zewnętrzna nie trafia na tę listę bez wpisu tutaj i bez
  odwołania w PR do statusu D-05.
- Repozytorium nie przechowuje numerów umów, danych kontaktowych IOD ani treści
  umów — wyłącznie odwołania do publicznych stron dostawców.

Powiązane: [`docs/PRIVACY_INVENTORY.md`](./PRIVACY_INVENTORY.md),
[`docs/DPIA_CHECKLIST.md`](./DPIA_CHECKLIST.md), [`docs/DECISIONS.md`](./DECISIONS.md) (D-05).
