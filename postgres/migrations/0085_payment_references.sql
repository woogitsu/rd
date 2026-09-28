-- #83: belgijska komunikacja strukturalna (OGM-VCS, +++xxx/xxxx/xxxxx+++) jako
-- tytuł przelewu zamiast wewnętrznego household_id (UUID bez sumy kontrolnej).
--
-- Skutki dla danych: WYŁĄCZNIE nowe tabele. Istniejące wpłaty, korekty,
-- przypisania i uzgodnienia pozostają bez zmian; kolumna payment_entries.reference
-- nie jest tu ruszana (integracja z importem wyciągu i propozycjami dopasowania
-- to osobny zakres, patrz PR). Referencja jest pseudonimem gospodarstwa, więc
-- traktujemy ją jak dane osobowe (D-04 decyduje o retencji).
--
-- Baza (10 cyfr) jest losowana w aplikacji (crypto), nie z sekwencji ani z danych
-- rodziny/klasy — z samej referencji nie da się nic odczytać o gospodarstwie.
-- Unieważnienie (jak przy payment_assignments/payment_corrections) jest osobnym,
-- niezmiennym zdarzeniem, które trigger stosuje do wiersza referencji: żaden
-- wiersz nie jest nadpisywany "z ręki", a historia zostaje w obu tabelach.

CREATE TABLE payment_references (
  id TEXT PRIMARY KEY,
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  household_id TEXT NOT NULL REFERENCES households(id),
  structured_reference TEXT NOT NULL CHECK (structured_reference ~ '^\d{12}$'),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT REFERENCES users(id),
  revoke_reason TEXT CHECK (revoke_reason IS NULL OR length(btrim(revoke_reason)) BETWEEN 3 AND 500),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128),
  CONSTRAINT payment_reference_revoke_consistency CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL)
  )
);

-- Unikalność referencji w obrębie roku (nawet po unieważnieniu — nie wolno
-- ponownie wylosować tej samej liczby, choćby historycznej).
CREATE UNIQUE INDEX payment_references_year_ref_idx
  ON payment_references(school_year_id, structured_reference);

-- Jedna AKTYWNA referencja na gospodarstwo i rok szkolny.
CREATE UNIQUE INDEX payment_references_active_household_year_idx
  ON payment_references(household_id, school_year_id) WHERE revoked_at IS NULL;

CREATE INDEX payment_references_household_idx ON payment_references(household_id, created_at);

CREATE TABLE payment_reference_revocations (
  id TEXT PRIMARY KEY,
  payment_reference_id TEXT NOT NULL UNIQUE REFERENCES payment_references(id),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128)
);

-- Niezmienność faktów: referencja nie zmienia się poza unieważnieniem (poniżej),
-- zdarzenie unieważnienia w ogóle się nie zmienia.
CREATE FUNCTION payment_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment_references_cannot_be_deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.school_year_id IS DISTINCT FROM OLD.school_year_id
     OR NEW.household_id IS DISTINCT FROM OLD.household_id
     OR NEW.structured_reference IS DISTINCT FROM OLD.structured_reference
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'payment_reference_facts_immutable';
  END IF;
  -- Jedyna dozwolona zmiana pól: NULL -> unieważnienie, wykonywana wyłącznie
  -- przez trigger payment_reference_revocation_apply poniżej (SECURITY: brak
  -- innej ścieżki UPDATE w API do tej tabeli).
  IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
     OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
     OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason THEN
    IF OLD.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'payment_reference_already_revoked';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_references_guard_update BEFORE UPDATE ON payment_references
  FOR EACH ROW EXECUTE FUNCTION payment_reference_guard();
CREATE TRIGGER payment_references_guard_delete BEFORE DELETE ON payment_references
  FOR EACH ROW EXECUTE FUNCTION payment_reference_guard();

CREATE FUNCTION payment_reference_revocation_apply() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original payment_references%ROWTYPE;
BEGIN
  SELECT * INTO original FROM payment_references WHERE id = NEW.payment_reference_id FOR UPDATE;
  IF NOT FOUND OR original.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'payment_reference_already_revoked';
  END IF;
  UPDATE payment_references
     SET revoked_at = NEW.created_at, revoked_by = NEW.created_by, revoke_reason = NEW.reason
   WHERE id = NEW.payment_reference_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_reference_revocations_apply_insert AFTER INSERT ON payment_reference_revocations
  FOR EACH ROW EXECUTE FUNCTION payment_reference_revocation_apply();

CREATE FUNCTION immutable_payment_reference_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%_cannot_be_changed', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER payment_reference_revocations_no_change BEFORE UPDATE OR DELETE ON payment_reference_revocations
  FOR EACH ROW EXECUTE FUNCTION immutable_payment_reference_event();
