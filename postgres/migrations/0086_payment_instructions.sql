-- #92: zatwierdzona na rok, serwerowa konfiguracja danych do wpłaty (IBAN, BIC,
-- odbiorca) do kodu QR EPC/SEPA na kartkach. Skutki dla danych: WYŁĄCZNIE nowa
-- tabela. Żadna istniejąca tabela nie jest zmieniana.
--
-- Zmiana rachunku w trakcie roku NIE nadpisuje poprzedniej wersji — to nowy
-- wiersz (immutable, jak payment_entries/payment_references). "Bieżąca"
-- konfiguracja roku to wiersz o najnowszym approved_at. Stare kartki mogą się
-- powoływać na swój wiersz po id (numer wersji w stopce).
--
-- IBAN jest daną wrażliwą finansowo: NIE trafia do metadanych zdarzeń audytu
-- (assertNoPii w src/pg/audit.js łapie klucz "iban" już dziś).

CREATE TABLE payment_instructions (
  id TEXT PRIMARY KEY,
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  iban TEXT NOT NULL CHECK (iban ~ '^[A-Z]{2}[0-9A-Z]{2,32}$'),
  bic TEXT CHECK (bic IS NULL OR bic ~ '^[A-Z0-9]{8}([A-Z0-9]{3})?$'),
  payee_name TEXT NOT NULL CHECK (length(btrim(payee_name)) BETWEEN 1 AND 70),
  approved_by TEXT NOT NULL REFERENCES users(id),
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128)
);
CREATE INDEX payment_instructions_year_idx ON payment_instructions(school_year_id, approved_at DESC);

-- Niezmienność: zatwierdzona wersja nigdy się nie zmienia ani nie znika.
-- Zmiana rachunku = nowe zatwierdzenie = nowy wiersz.
CREATE FUNCTION payment_instructions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payment_instructions_immutable';
END;
$$;
CREATE TRIGGER payment_instructions_no_change BEFORE UPDATE OR DELETE ON payment_instructions
  FOR EACH ROW EXECUTE FUNCTION payment_instructions_guard();
