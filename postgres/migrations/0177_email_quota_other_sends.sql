-- #84: ręczna ewidencja wiadomości wysłanych poza kolejką (POST /api/email/quota/other-sends).
--
-- Dotąd wpis „other” w email_send_ledger powstawał wyłącznie z funkcji
-- recordOtherSends() (bez aktora, powodu i klucza idempotencji), a liczba musiała
-- być dodatnia. Teraz dziennik pozwala dopisać także KOREKTĘ pomyłki jako nowy
-- wpis z liczbą ujemną; nic nie jest edytowane ani usuwane (trigger
-- email_send_ledger_append_only z 0007 zostaje bez zmian).
--
-- Zmiany (tylko dla wierszy source = 'other'; wiersze 'campaign' i 'preview' (0056) bez zmian):
--   * message_count: dozwolone −10000..10000 bez zera (dotąd 1..10000). Wiersz
--     kampanii nadal ma dokładnie 1 (email_ledger_campaign_row z 0007);
--   * nowe kolumny, wszystkie NULL dla wierszy kampanii i dla wpisów sprzed
--     migracji: actor_id (kto dopisał), reason_code (kod z listy), idempotency_key
--     (UNIQUE — podwójne kliknięcie/ponowienie daje jeden wpis), corrects_id
--     (wpis korygowany; tylko przy liczbie ujemnej i kodzie 'correction');
--   * CHECK email_ledger_other_manual: wpis z aktorem ma kod, klucz i
--     spójny znak (korekta ⇔ liczba ujemna ⇔ corrects_id).
--
-- Skutki dla danych: istniejące wiersze pozostają ważne i nie są zmieniane;
-- pula (remainingQuota) nadal liczy SUM(message_count), więc korekta ujemna
-- zmniejsza zużycie dnia. Trasa pilnuje, by suma „other” danej doby nie spadła
-- poniżej zera. Dziennik nie zawiera adresów ani treści — wyłącznie liczby i kody.
-- Migracja jest wstecznie zgodna (nowe kolumny opcjonalne, zluzowany CHECK).

ALTER TABLE email_send_ledger DROP CONSTRAINT email_send_ledger_message_count_check;
ALTER TABLE email_send_ledger ADD CONSTRAINT email_send_ledger_message_count_check
  CHECK (message_count BETWEEN -10000 AND 10000 AND message_count <> 0);

ALTER TABLE email_send_ledger
  ADD COLUMN actor_id TEXT,
  ADD COLUMN reason_code TEXT CHECK (reason_code IN ('manual_brevo_panel', 'invitation', 'audit_committee', 'other', 'correction')),
  ADD COLUMN idempotency_key TEXT UNIQUE CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$'),
  ADD COLUMN corrects_id TEXT REFERENCES email_send_ledger(id);

ALTER TABLE email_send_ledger ADD CONSTRAINT email_ledger_other_manual CHECK (
  (source IN ('campaign', 'preview') AND message_count = 1 AND actor_id IS NULL AND reason_code IS NULL
     AND idempotency_key IS NULL AND corrects_id IS NULL)
  OR (source = 'other' AND actor_id IS NULL AND reason_code IS NULL AND idempotency_key IS NULL
        AND corrects_id IS NULL AND message_count > 0)
  OR (source = 'other' AND actor_id IS NOT NULL AND reason_code IS NOT NULL AND idempotency_key IS NOT NULL
        AND ((reason_code = 'correction' AND message_count < 0 AND corrects_id IS NOT NULL)
          OR (reason_code <> 'correction' AND message_count > 0 AND corrects_id IS NULL)))
);

CREATE INDEX email_send_ledger_corrects_idx ON email_send_ledger(corrects_id) WHERE corrects_id IS NOT NULL;
