-- Obowiązkowy tekst alternatywny zdjęć aktualności (#124).
--
-- Skutki dla danych:
-- * Dodaje kolumnę news_photos.decorative (domyślnie false). Żaden istniejący
--   wiersz nie jest zmieniany — kolumna jest wyliczana z DEFAULT dla wierszy
--   już istniejących, więc każde zdjęcie sprzed tej migracji ma decorative =
--   false (bezpieczne domyślne założenie: brak deklaracji "czysto
--   dekoracyjne" u zdjęć wgranych wcześniej).
-- * Dodaje ograniczenie news_photo_alt_text_required: alt_text IS NOT NULL
--   OR decorative. Dodane z NOT VALID — Postgres NIE sprawdza istniejących
--   wierszy wstecznie (żadne dotychczasowe zdjęcie, nawet już zweryfikowane
--   bez opisu, nie jest tym samym unieważnione ani zablokowane do odczytu).
--   Ograniczenie działa dla każdego kolejnego INSERT i UPDATE tego wiersza —
--   w tym dla UPDATE, którym verifyPhoto() zmienia rights_status na
--   'verified'. Zdjęcie wgrane wcześniej bez alt_text i bez decorative,
--   które nie było jeszcze zweryfikowane, nie da się więc zweryfikować, dopóki
--   nie powstanie jego poprawka — metadane są niezmienne (docs/NEWS.md),
--   więc jedyna ścieżka to nowy rekord zdjęcia (POST /api/news-photos) z
--   wypełnionym alt_text albo decorative = true, tak jak przy każdej innej
--   poprawce metadanych zdjęcia.
-- * Zdjęcia już zweryfikowane bez alt_text i bez decorative pozostają
--   zweryfikowane i widoczne publicznie bez zmian (ograniczenie ich nie
--   dotyka, dopóki nikt nie spróbuje ich ponownie zaktualizować) — ale są
--   teraz widoczne w nowym widoku news_photos_missing_alt_text ("do
--   uzupełnienia opisu"), żeby zarząd/redakcja mogły przygotować poprawki.
-- * Aktualizuje widok public_news: pole altText w publicznym JSON-ie zwraca
--   pusty tekst '' (a nie NULL) dla zdjęć oznaczonych decorative = true —
--   zgodnie z WCAG 1.1.1 pusty alt="" oznacza świadomie dekoracyjny obraz,
--   inaczej niż brak atrybutu. Kolejność i liczba kolumn widoku się nie
--   zmienia (bez zmian dla dotychczasowych czytelników API poza dodatkowym
--   kluczem "decorative" w każdym obiekcie photos[]).

ALTER TABLE news_photos ADD COLUMN decorative BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE news_photos ADD CONSTRAINT news_photo_alt_text_required
  CHECK (alt_text IS NOT NULL OR decorative) NOT VALID;

-- Rejestr "do uzupełnienia opisu": zweryfikowane zdjęcia sprzed tej migracji
-- (albo dowolne inne) bez tekstu alternatywnego i bez deklaracji decorative.
-- Tylko odczyt — nic nie zmienia w news_photos. Bez danych osobowych: same
-- identyfikatory i metadane praw, tak jak PHOTO_COLUMNS w src/pg/news.js.
CREATE VIEW news_photos_missing_alt_text AS
SELECT id, document_id, author, source, taken_on, uploaded_by, uploaded_at,
  rights_status, rights_verified_by, rights_verified_at
FROM news_photos
WHERE alt_text IS NULL AND NOT decorative
ORDER BY uploaded_at;

CREATE OR REPLACE VIEW public_news AS
SELECT p.id, p.school_year_id, r.title, r.body, p.published_at, p.first_published_at,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
        'id', ph.id,
        'author', ph.author,
        'source', ph.source,
        'license', ph.license_text,
        'takenOn', to_char(ph.taken_on, 'YYYY-MM-DD'),
        'altText', CASE WHEN ph.decorative THEN '' ELSE ph.alt_text END,
        'decorative', ph.decorative) ORDER BY u.ord)
      FROM unnest(r.photo_ids) WITH ORDINALITY AS u(photo_id, ord)
      JOIN news_photos ph ON ph.id = u.photo_id AND ph.rights_status = 'verified'
  ), '[]'::jsonb) AS photos
FROM news_posts p
JOIN news_post_revisions r ON r.post_id = p.id AND r.revision_no = p.published_revision_no
WHERE p.published_revision_no IS NOT NULL AND p.status <> 'withdrawn';
