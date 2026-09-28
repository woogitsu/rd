-- Lista wyłączeń: zdjęcie blokady jako nowy zapis, nie edycja (issue #94).
-- Zmienia klucz główny email_suppressions z email_hash na id, żeby ten sam
-- adres mógł mieć kilka zdarzeń blokady w czasie (blokada -> zdjęcie ->
-- ponowna blokada); żaden istniejący wiersz nie jest usuwany ani zmieniany
-- poza dodaniem identyfikatora.

ALTER TABLE email_suppressions ADD COLUMN id TEXT;
UPDATE email_suppressions SET id = gen_random_uuid()::text WHERE id IS NULL;
ALTER TABLE email_suppressions ALTER COLUMN id SET NOT NULL;
ALTER TABLE email_suppressions DROP CONSTRAINT email_suppressions_pkey;
ALTER TABLE email_suppressions ADD CONSTRAINT email_suppressions_pkey PRIMARY KEY (id);
CREATE INDEX email_suppressions_hash_idx ON email_suppressions(email_hash, created_at);

-- Wniosek o zdjęcie blokady (zgłoszenie jednej osoby; drugi krok — release —
-- zatwierdza inna osoba). Nie jest append-only: skonsumowany wniosek jest
-- oznaczany, żeby nie dało się go użyć dwa razy; historia decyzji jest w
-- email_suppression_releases (poniżej), która jest append-only.
CREATE TABLE email_suppression_release_requests (
  id TEXT PRIMARY KEY,
  email_hash TEXT NOT NULL CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  suppression_reason TEXT NOT NULL CHECK (suppression_reason IN ('hard_bounce', 'invalid_email', 'complaint', 'unsubscribed', 'blocked')),
  release_reason TEXT NOT NULL CHECK (release_reason IN ('address_corrected', 'provider_unblocked', 'bounce_reviewed', 'parent_request')),
  confirmation_note TEXT CHECK (confirmation_note IS NULL OR confirmation_note ~ '^[a-z0-9_]{1,40}$'),
  requested_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ,
  consumed_by TEXT REFERENCES users(id),
  CONSTRAINT email_suppression_release_request_consumed CHECK ((consumed_at IS NULL) = (consumed_by IS NULL)),
  -- Blokada po skardze/wypisaniu tylko na wyraźną prośbę rodzica (#94).
  CONSTRAINT email_suppression_release_request_parent_only CHECK (
    release_reason = 'parent_request' OR suppression_reason NOT IN ('complaint', 'unsubscribed')
  )
);
CREATE INDEX email_suppression_release_requests_open_idx
  ON email_suppression_release_requests(email_hash) WHERE consumed_at IS NULL;

-- Zdjęcie blokady: nowy, niezmienialny zapis (tylko dopisywanie). Zatwierdzający
-- (approved_by) nie może być tą samą osobą, która zgłosiła wniosek (released_by).
CREATE TABLE email_suppression_releases (
  id TEXT PRIMARY KEY,
  email_hash TEXT NOT NULL CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  suppression_reason TEXT NOT NULL CHECK (suppression_reason IN ('hard_bounce', 'invalid_email', 'complaint', 'unsubscribed', 'blocked')),
  release_reason TEXT NOT NULL CHECK (release_reason IN ('address_corrected', 'provider_unblocked', 'bounce_reviewed', 'parent_request')),
  confirmation_note TEXT CHECK (confirmation_note IS NULL OR confirmation_note ~ '^[a-z0-9_]{1,40}$'),
  request_id TEXT NOT NULL REFERENCES email_suppression_release_requests(id),
  released_by TEXT NOT NULL REFERENCES users(id),
  approved_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT email_suppression_release_four_eyes CHECK (released_by <> approved_by),
  CONSTRAINT email_suppression_release_parent_only CHECK (
    release_reason = 'parent_request' OR suppression_reason NOT IN ('complaint', 'unsubscribed')
  )
);
CREATE INDEX email_suppression_releases_hash_idx ON email_suppression_releases(email_hash, created_at);

CREATE TRIGGER email_suppression_releases_append_only BEFORE UPDATE OR DELETE ON email_suppression_releases
  FOR EACH ROW EXECUTE FUNCTION email_append_only();

-- Definicja jedynej "aktywnej blokady": dla każdy skrót adresu porównujemy
-- najnowsze zdarzenie blokady z najnowszym zdjęciem blokady. Migawka i
-- worker mają używać WYŁĄCZNIE tego widoku (#94), nie surowej tabeli.
CREATE VIEW email_active_suppressions AS
WITH latest_block AS (
  SELECT DISTINCT ON (email_hash) email_hash, reason, id AS suppression_id, created_at
    FROM email_suppressions
   ORDER BY email_hash, created_at DESC, id DESC
), latest_release AS (
  SELECT DISTINCT ON (email_hash) email_hash, created_at
    FROM email_suppression_releases
   ORDER BY email_hash, created_at DESC, id DESC
)
SELECT b.email_hash, b.reason, b.suppression_id, b.created_at
  FROM latest_block b
  LEFT JOIN latest_release r ON r.email_hash = b.email_hash
 WHERE r.email_hash IS NULL OR b.created_at > r.created_at;
