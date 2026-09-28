-- Magazyn plików zdjęć galerii: osobny prefiks w buckecie, usuwanie
-- EXIF/GPS przy przetwarzaniu, warianty web/thumb, publiczny odczyt tylko
-- zweryfikowanych zdjęć należących do opublikowanej wersji (#96, część).
--
-- Skutki dla danych:
-- * Nowa tabela news_photo_files: jeden wiersz na wariant pliku zdjęcia
--   (`web`, `thumb`). Klucz obiektu w prywatnym buckecie ma prefiks
--   `photos/` — oddzielny od `docs/` używanego przez dokumenty
--   (src/documents.js `newObjectKey`), więc bucket dokumentów finansowych/
--   zarządu/klas nie miesza się ze zdjęciami galerii i odwrotnie.
-- * WARIANT ZACHOWAWCZY (brak D-18/D-04/D-05 co do przechowywania
--   oryginałów): serwer NIE zapisuje przesłanego oryginału — wyłącznie
--   przetworzone warianty bez metadanych EXIF/GPS (przetwarzanie w
--   src/pg/news-photo-files.js ponownie koduje obraz przez `sharp`, co
--   domyślnie odrzuca segmenty EXIF/XMP/ICC, chyba że jawnie zachowane).
--   Jeśli zarząd zdecyduje inaczej, potrzebna będzie kolejna migracja
--   dodająca wariant `original` z osobną, bardziej restrykcyjną polityką
--   dostępu (dowód, nie treść publiczna).
-- * `news_photos.document_id` NIE jest zmieniane ani usuwane w tej migracji
--   (istniejące rejestracje metadanych zdjęć — bez pliku — nadal działają).
--   Plik jest opcjonalnym uzupełnieniem: zdjęcie może mieć zarejestrowane
--   metadane bez pliku (jeszcze nie przesłany) albo z plikiem (po
--   POST /api/news-photos/:id/file).
-- Wycofanie: usunąć tabelę news_photo_files; nic innego nie jest zmieniane
-- (obiekty w buckecie pod prefiksem photos/ zostają osierocone — do
-- ręcznego sprzątania, jak przy każdym wycofaniu migracji dot. plików).

CREATE TABLE news_photo_files (
  id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  photo_id TEXT NOT NULL REFERENCES news_photos(id),
  variant TEXT NOT NULL CHECK (variant IN ('web', 'thumb')),
  object_key TEXT NOT NULL UNIQUE CHECK (object_key ~ '^photos/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  mime_type TEXT NOT NULL CHECK (mime_type = 'image/jpeg'),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 10000),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 10000),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  -- Skrót WYNIKOWEGO wariantu (nie oryginału) — do potwierdzenia integralności
  -- przy odczycie i do porównania przy ponowieniu (ten sam plik źródłowy daje
  -- deterministyczny wariant przy tych samych parametrach kodowania).
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- Skrót pliku ŹRÓDŁOWEGO (oryginału) wspólny dla obu wariantów jednego
  -- przesłania — pozwala rozpoznać podwójne kliknięcie (ten sam oryginał)
  -- bez przechowywania go.
  source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (photo_id, variant)
);
CREATE INDEX news_photo_files_photo_idx ON news_photo_files(photo_id);

CREATE TRIGGER news_photo_files_no_change
  BEFORE UPDATE OR DELETE ON news_photo_files
  FOR EACH ROW EXECUTE FUNCTION news_immutable_row();

-- Czy dany photo_id jest publicznie widoczny: zweryfikowany i należący do
-- opublikowanej wersji nie wycofanego wpisu — to samo kryterium co widok
-- public_news (0018_news.sql), wyrażone jako predykat do użycia przez trasę
-- odczytu pliku (uniknięcie powielenia zapytania z jsonb_array_elements na
-- każde żądanie obrazu).
CREATE FUNCTION news_photo_is_public(p_photo_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM news_posts p
    JOIN news_post_revisions r ON r.post_id = p.id AND r.revision_no = p.published_revision_no
    JOIN news_photos ph ON ph.id = p_photo_id AND ph.rights_status = 'verified'
    WHERE p.published_revision_no IS NOT NULL AND p.status <> 'withdrawn'
      AND ph.id = ANY (r.photo_ids)
  )
$$;
