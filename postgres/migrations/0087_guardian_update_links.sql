-- #140: wniosek rodzica o aktualizację kontaktu przez jednorazowy link, z
-- zatwierdzeniem przez zarząd. Dodaje dwie nowe, puste tabele — brak zmian
-- w istniejących danych.
--
-- guardian_update_links: token wydawany dla KONKRETNEGO opiekuna (nie
-- relacji z jednym dzieckiem — e-mail i zgoda są polami na `guardians`).
-- Przechowywany WYŁĄCZNIE jako skrót SHA-256 (64 znaki hex), jednorazowy
-- (`used_at`), z terminem ważności (`expires_at`). Rodzic nie dostaje konta —
-- to jedyny mechanizm uwierzytelnienia, stąd jednorazowość i krótki termin.
--
-- guardian_update_requests: WNIOSEK, nie zmiana. Stan `pending -> approved |
-- rejected`, tylko dopisywanie zdarzeń (trigger niżej blokuje DELETE i każdą
-- zmianę poza jednym przejściem stanu). Zawiera żądaną zmianę
-- (proposed_email / proposed_contact_allowed, z osobnymi flagami "_set",
-- bo `email: null` to poprawna, jawna wartość — czyszczenie e-maila —
-- odróżnialna od "pole nieobecne w formularzu"). Zatwierdzenie wykonuje
-- istniejącą ścieżkę zmiany kontaktu opiekuna (`rd.change_reason =
-- 'parent_request:{id}'`), więc historia zmian (guardian_contact_changes,
-- 0014_households.sql) i to zdarzenie audytu opisują to samo zdarzenie
-- jednym mechanizmem, bez duplikowania logiki zapisu.
--
-- Założenie do decyzji zarządu/administratora danych (D-01, D-06, D-07,
-- D-08, D-16/D-17 w issue #140): implementacja jest wariantem zachowawczym —
-- KAŻDY wniosek, także wycofanie zgody, czeka na zatwierdzenie człowieka
-- (żadnego automatycznego zastosowania); kolejkę widzą wyłącznie admin i
-- zarząd (bez przedstawiciela klasy); brak weryfikacji nowego e-maila kodem
-- (punkt 5 propozycji w #140) — poza zakresem tej migracji/PR do czasu D-16/D-17.

CREATE TABLE guardian_update_links (
  id TEXT PRIMARY KEY,
  guardian_id TEXT NOT NULL REFERENCES guardians(id),
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);
CREATE INDEX guardian_update_links_guardian_idx ON guardian_update_links(guardian_id);

CREATE TABLE guardian_update_requests (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES guardian_update_links(id),
  guardian_id TEXT NOT NULL REFERENCES guardians(id),
  proposed_email TEXT,
  proposed_email_set BOOLEAN NOT NULL DEFAULT false,
  proposed_contact_allowed BOOLEAN,
  proposed_contact_allowed_set BOOLEAN NOT NULL DEFAULT false,
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by TEXT REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  CHECK ((status = 'pending') = (decided_by IS NULL AND decided_at IS NULL)),
  CHECK (proposed_email_set OR proposed_contact_allowed_set)
);
CREATE INDEX guardian_update_requests_guardian_idx ON guardian_update_requests(guardian_id);
CREATE INDEX guardian_update_requests_pending_idx ON guardian_update_requests(status, created_at);

-- Wniosek: tylko dopisywanie, poza jednym przejściem stanu pending -> approved|rejected.
CREATE FUNCTION guardian_update_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'guardian_update_requests_cannot_be_deleted';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'guardian_update_request_already_decided';
  END IF;
  IF NEW.link_id <> OLD.link_id OR NEW.guardian_id <> OLD.guardian_id
     OR NEW.proposed_email IS DISTINCT FROM OLD.proposed_email
     OR NEW.proposed_email_set <> OLD.proposed_email_set
     OR NEW.proposed_contact_allowed IS DISTINCT FROM OLD.proposed_contact_allowed
     OR NEW.proposed_contact_allowed_set <> OLD.proposed_contact_allowed_set
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'guardian_update_request_immutable_fields';
  END IF;
  IF NEW.status = 'pending' THEN
    RAISE EXCEPTION 'guardian_update_request_no_op_update';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guardian_update_request_guard BEFORE UPDATE OR DELETE ON guardian_update_requests
  FOR EACH ROW EXECUTE FUNCTION guardian_update_request_guard();

-- Link: tylko dopisywanie, poza oznaczeniem zużycia (used_at NULL -> ustawione).
CREATE FUNCTION guardian_update_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'guardian_update_links_cannot_be_deleted';
  END IF;
  IF OLD.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'guardian_update_link_already_used';
  END IF;
  IF NEW.guardian_id <> OLD.guardian_id OR NEW.token_hash <> OLD.token_hash
     OR NEW.expires_at <> OLD.expires_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'guardian_update_link_immutable_fields';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guardian_update_link_guard BEFORE UPDATE OR DELETE ON guardian_update_links
  FOR EACH ROW EXECUTE FUNCTION guardian_update_link_guard();
