-- Rejestr zgód na wizerunek: zakres, ważność i wycofanie jednej zgody (#106,
-- częściowo — patrz DOCUMENTS.md / opis PR co do zakresu, który obejmuje ta
-- migracja).
--
-- Skutki dla danych:
-- * news_photo_consents dostaje dwie nowe kolumny: `scope` (lista zamknięta
--   rada_website|print|social_media) i `valid_until` (NULL = bez terminu).
--   Bez D-18 (czy istniejące zgody automatycznie dostają `scope =
--   {rada_website}` i brak terminu) przyjmujemy WARIANT ZACHOWAWCZY: każdy
--   istniejący wiersz dostaje `scope = '{}'` (pusty zakres). To NIE usuwa
--   zdjęć z bazy i NIE cofa weryfikacji — jedynie wstrzymuje publiczną
--   widoczność zdjęć opartych na tych zgodach do czasu, aż osoba weryfikująca
--   jawnie potwierdzi zakres (przez nowy wpis zgody albo przyszłą trasę
--   potwierdzenia zakresu — poza zakresem tej migracji). Zdjęcia bez
--   identyfikowalnych osób (depicts_children = false i identifiable_adults =
--   0) nie mają wierszy w news_photo_consents, więc się nie zmieniają.
-- * Nowa tabela news_photo_consent_withdrawals: dopisywana, nigdy edytowana
--   ani usuwana (ten sam wzorzec co inne rejestry zdarzeń w tym pliku).
--   Wycofanie jednej zgody (po consent_document_ref) ukrywa z public_news
--   każde zdjęcie, które ma choć jeden wiersz zgody z tym odwołaniem —
--   obejmuje to również rodzeństwo, jeśli ta sama zgoda obejmowała oboje
--   dzieci na tym samym zdjęciu.
-- * public_news: zdjęcie jest publiczne tylko, gdy WSZYSTKIE jego wiersze
--   zgody mają `rada_website` w zakresie, nie wygasły (`valid_until IS NULL
--   OR valid_until >= rd_today()`, strefa Europe/Brussels) i nie zostały
--   wycofane. Zdjęcia bez wierszy zgody (brak zidentyfikowanych osób) nie są
--   tym dotknięte.
-- Wycofanie: usunąć widok public_news i przywrócić wersję z 0018 (bez
-- warunków zgody), usunąć kolumny scope/valid_until i tabelę
-- news_photo_consent_withdrawals. Dane w news_photo_consents poza nowymi
-- kolumnami nie są ruszane.

ALTER TABLE news_photo_consents
  ADD COLUMN scope TEXT[] NOT NULL DEFAULT '{}'
    CHECK (scope <@ ARRAY['rada_website', 'print', 'social_media']::TEXT[]),
  ADD COLUMN valid_until DATE;

CREATE TABLE news_photo_consent_withdrawals (
  consent_document_ref TEXT PRIMARY KEY
    CHECK (consent_document_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  withdrawn_on DATE NOT NULL DEFAULT rd_today(),
  recorded_by TEXT NOT NULL REFERENCES users(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER news_photo_consent_withdrawals_no_change
  BEFORE UPDATE OR DELETE ON news_photo_consent_withdrawals
  FOR EACH ROW EXECUTE FUNCTION news_immutable_row();

-- Zdjęcie jest publikowalne tylko, jeśli KAŻDY jego wiersz zgody ma zakres
-- rada_website, nie wygasł i nie został wycofany. Zdjęcie bez wierszy zgody
-- (brak zidentyfikowanych osób) przechodzi automatycznie.
CREATE FUNCTION news_photo_consents_public_ok(photo news_photos) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM news_photo_consents c
    WHERE c.photo_id = photo.id
      AND (
        NOT (c.scope @> ARRAY['rada_website']::TEXT[])
        OR (c.valid_until IS NOT NULL AND c.valid_until < rd_today())
        OR EXISTS (
          SELECT 1 FROM news_photo_consent_withdrawals w
          WHERE w.consent_document_ref = c.consent_document_ref
        )
      )
  )
$$;

CREATE OR REPLACE VIEW public_news AS
SELECT p.id, p.school_year_id, r.title, r.body, p.published_at, p.first_published_at,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
        'id', ph.id,
        'author', ph.author,
        'source', ph.source,
        'license', ph.license_text,
        'takenOn', to_char(ph.taken_on, 'YYYY-MM-DD'),
        'altText', ph.alt_text) ORDER BY u.ord)
      FROM unnest(r.photo_ids) WITH ORDINALITY AS u(photo_id, ord)
      JOIN news_photos ph ON ph.id = u.photo_id AND ph.rights_status = 'verified'
        AND news_photo_consents_public_ok(ph)
  ), '[]'::jsonb) AS photos
FROM news_posts p
JOIN news_post_revisions r ON r.post_id = p.id AND r.revision_no = p.published_revision_no
WHERE p.published_revision_no IS NOT NULL AND p.status <> 'withdrawn';
