-- #184 pkt 1 (kryterium 1): licznik odmów 403 `access.denied` w oknie 5 minut.
--
-- Dziennik audit_events jest tylko do dopisywania, więc nie da się w nim
-- zwiększać licznika. Pierwsza odmowa danego aktora dla danej metody i ścieżki
-- zapisuje JEDNO zdarzenie `access.denied` oraz wiersz okna w tej tabeli
-- (ta sama transakcja). Kolejne odmowy w ciągu 5 minut od pierwszej nie
-- dopisują zdarzeń — zwiększają tylko `denial_count` i `last_denied_at` tego
-- okna. Po 5 minutach od pierwszej odmowy następna otwiera nowe okno i nowe
-- zdarzenie. Okno liczone od pierwszej odmowy (nie przesuwa się przy każdym
-- odświeżeniu), więc ciągłe próby dają najwyżej jedno zdarzenie na 5 minut.
--
-- Skutki dla danych:
--   * nowa tabela; nic wstecznego się nie zapisuje — zdarzenia `access.denied`
--     sprzed tej migracji zostają bez licznika (widok dziennika pokazuje wtedy
--     brak liczby, nie „1”);
--   * bez danych osobowych: identyfikator konta (jak actor_id w audit_events),
--     metoda HTTP, ścieżka bez parametrów zapytania i bez treści żądania,
--     liczby i znaczniki czasu. Bez adresu IP i bez nagłówków;
--   * wiersz nie jest nigdy usuwany (retencja do decyzji D-04 — domyślnie
--     nieustalona = nie usuwać, jak data_access_log w 0067). Strażnik pozwala
--     zmienić WYŁĄCZNIE denial_count (tylko w górę) i last_denied_at (nie
--     wstecz); pozostałe pola i DELETE → wyjątek; TRUNCATE blokuje
--     deny_truncate() (0095), a first_denied_at stempluje zegar bazy
--     (stamp_created_now() z 0144 — antydatowany INSERT dostaje now());
--   * poza eksportem rocznym (EXPORT_EXCLUDED_TABLES) — zdarzenie
--     `access.denied` i tak trafia do paczki razem z audit_events.
-- Wycofanie: DROP TABLE access_denial_windows i funkcji strażnika (zdarzenia
-- `access.denied` w audit_events zostają; znikają tylko liczniki powtórzeń).
CREATE TABLE access_denial_windows (
  id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  audit_event_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  method TEXT NOT NULL CHECK (method IN ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE')),
  route TEXT NOT NULL CHECK (length(route) BETWEEN 1 AND 300 AND route LIKE '/%'),
  denial_count INTEGER NOT NULL DEFAULT 1 CHECK (denial_count >= 1),
  first_denied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_denied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (last_denied_at >= first_denied_at)
);
CREATE INDEX access_denial_windows_lookup_idx
  ON access_denial_windows(actor_id, method, route, first_denied_at DESC);

CREATE FUNCTION access_denial_windows_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'access_denial_windows_cannot_be_deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.audit_event_id IS DISTINCT FROM OLD.audit_event_id
     OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
     OR NEW.method IS DISTINCT FROM OLD.method
     OR NEW.route IS DISTINCT FROM OLD.route
     OR NEW.first_denied_at IS DISTINCT FROM OLD.first_denied_at
     OR NEW.denial_count < OLD.denial_count
     OR NEW.last_denied_at < OLD.last_denied_at THEN
    RAISE EXCEPTION 'access_denial_window_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER access_denial_windows_guard BEFORE UPDATE OR DELETE ON access_denial_windows
  FOR EACH ROW EXECUTE FUNCTION access_denial_windows_guard();
CREATE TRIGGER access_denial_windows_no_truncate BEFORE TRUNCATE ON access_denial_windows
  FOR EACH STATEMENT EXECUTE FUNCTION deny_truncate();
CREATE TRIGGER a0_stamp_created_now BEFORE INSERT ON access_denial_windows
  FOR EACH ROW EXECUTE FUNCTION stamp_created_now('first_denied_at');
