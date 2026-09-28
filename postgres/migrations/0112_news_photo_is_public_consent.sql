-- Uwzględnij zakres/wygaśnięcie/wycofanie zgody na wizerunek w
-- news_photo_is_public (#106, kontynuacja 0083 i 0084).
--
-- Skutki dla danych:
-- * Żaden wiersz nie jest zmieniany ani usuwany — zmienia się wyłącznie
--   wynik funkcji `news_photo_is_public`, więc tylko zachowanie odczytu
--   publicznego pliku zdjęcia (GET /api/news-photo-files/... w
--   src/pg/news.js, `getPublicPhotoFile`).
-- * Po scaleniu z origin/main okazało się, że 0084_news_photo_files.sql
--   (PR #96) napisała `news_photo_is_public` niezależnie od 0083
--   (PR #106, zgody na wizerunek) i powieliła wyłącznie starsze kryterium
--   z 0018 (zweryfikowane zdjęcie + opublikowana, niewycofana wersja) —
--   bez warunku zgody, którego 0083 dodała do widoku `public_news` przez
--   `news_photo_consents_public_ok`. Skutek: wariant pliku zdjęcia (web/
--   thumb) zostawał publicznie odczytywalny nawet po wycofaniu jedynej
--   zgody na to zdjęcie albo po wygaśnięciu jej `valid_until` — mimo że
--   `public_news` to samo zdjęcie już ukrywał. Ta migracja dokłada TEN SAM
--   warunek zgody (`news_photo_consents_public_ok(ph)`) do
--   `news_photo_is_public`, żeby oba miejsca (widok listy publicznej i
--   trasa odczytu pliku) zgadzały się co do tego, które zdjęcie jest
--   publiczne.
-- Wycofanie: `CREATE OR REPLACE FUNCTION news_photo_is_public` wracające do
-- ciała z 0084_news_photo_files.sql (bez warunku zgody). Żadne dane nie są
-- ruszane.

CREATE OR REPLACE FUNCTION news_photo_is_public(p_photo_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM news_posts p
    JOIN news_post_revisions r ON r.post_id = p.id AND r.revision_no = p.published_revision_no
    JOIN news_photos ph ON ph.id = p_photo_id AND ph.rights_status = 'verified'
    WHERE p.published_revision_no IS NOT NULL AND p.status <> 'withdrawn'
      AND ph.id = ANY (r.photo_ids)
      AND news_photo_consents_public_ok(ph)
  )
$$;
