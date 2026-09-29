-- Indeksy pod listy z kursorem keyset (issue #159, kontrakt list: docs/API.md).
--
-- Skutki dla danych:
-- * Wyłącznie CREATE INDEX — bez nowych kolumn, tabel ani zmiany danych;
--   istniejące wiersze bez zmian. Zapisy do tych tabel robią odtąd nieco więcej
--   pracy (utrzymanie indeksów), zaniedbywalne przy skali jednej szkoły.
-- * users (lower(email), id): kolejność GET /api/admin/users.
-- * role_grants (granted_at DESC, id): kolejność GET /api/admin/grants
--   (także status=all obejmujący całą historię kadencji).
-- * invitations (created_at DESC, id): kolejność GET /api/admin/invitations.
-- * documents (school_year_id, created_at DESC, id): kolejność GET /api/documents
--   w obrębie roku (istniejący documents_year_kind_idx ma `kind` przed czasem,
--   więc przy kilku rodzajach wymagał sortowania całego roku).
-- * email_campaigns (school_year_id, created_at DESC, id): kolejność
--   GET /api/email/campaigns (istniejący email_campaigns_year_idx nie ma `id`).
-- audit_events ma już indeksy z 0059 (occurred_at DESC, id).
-- Wycofanie: DROP INDEX każdego z pięciu indeksów (same indeksy, bezpieczne).
-- Na dużej produkcyjnej bazie: rozważyć CREATE INDEX CONCURRENTLY poza
-- transakcją migratora (poza zakresem prototypu, jak w 0059).

CREATE INDEX users_email_order_idx ON users (lower(email), id);
CREATE INDEX role_grants_granted_at_idx ON role_grants (granted_at DESC, id);
CREATE INDEX invitations_created_at_idx ON invitations (created_at DESC, id);
CREATE INDEX documents_year_created_idx ON documents (school_year_id, created_at DESC, id);
CREATE INDEX email_campaigns_year_created_idx ON email_campaigns (school_year_id, created_at DESC, id);
