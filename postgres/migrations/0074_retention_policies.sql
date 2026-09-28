-- #91: rejestr polityk retencji (D-04) jako dane, nie kod.
--
-- Skutki dla danych: nowa, pusta tabela; brak zmian w istniejących tabelach.
-- Brak wiersza dla kategorii = "nie usuwaj" (obecna semantyka `documents.retain_until`).
-- Tabela jest wyłącznie rejestrem — nie wykonuje żadnego usuwania ani
-- anonimizacji (mechanizm wykonania jest świadomie poza zakresem #91 w tym PR,
-- patrz opis w PR: wymaga osobnej decyzji o funkcji anonimizującej i jej testach).
--
-- Wersjonowanie: wiele wierszy per `data_category` w czasie; obowiązująca
-- polityka to najnowszy wiersz wg `effective_from`. Korekta = nowy wiersz
-- (append-only, jak `event_revisions`/`news_post_revisions`), nigdy UPDATE/DELETE.

CREATE TABLE retention_policies (
  id TEXT PRIMARY KEY,
  data_category TEXT NOT NULL CHECK (data_category IN (
    'guardian_contact', 'student_identity', 'email_snapshot', 'payment_reference',
    'document_financial', 'audit_event', 'export_package', 'import_file'
  )),
  -- Dokładnie jedno z dwóch: stały okres (interval) albo reguła opisowa
  -- (np. "N lat po ostatnim roku szkolnym ucznia") do ręcznej interpretacji,
  -- dopóki nie powstanie mechanizm wykonania.
  retain_for INTERVAL,
  retain_until_rule TEXT CHECK (retain_until_rule IS NULL OR length(btrim(retain_until_rule)) BETWEEN 1 AND 500),
  CONSTRAINT retention_policies_shape CHECK (
    (retain_for IS NOT NULL) <> (retain_until_rule IS NOT NULL)
  ),
  decision_ref TEXT NOT NULL CHECK (length(btrim(decision_ref)) BETWEEN 1 AND 200),
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by TEXT REFERENCES users(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT retention_policies_four_eyes CHECK (approved_by IS NULL OR approved_by <> created_by)
);
CREATE INDEX retention_policies_category_idx ON retention_policies(data_category, effective_from DESC);

CREATE FUNCTION retention_policies_no_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'retention_policies is append-only; corrections insert a new row';
END;
$$;
CREATE TRIGGER retention_policies_no_change BEFORE UPDATE OR DELETE ON retention_policies
  FOR EACH ROW EXECUTE FUNCTION retention_policies_no_change();
