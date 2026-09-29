-- Domknięcie luk w zamrożeniu zamkniętego roku szkolnego (issue #80, część
-- „przegląd katalogu”).
--
-- Punkt wyjścia: po 0017/0036/0106 na zbudowanym schemacie tabele z kolumną
-- school_year_id bez triggera a0_year_freeze to: classes, enrollment_history,
-- import_batches, invitations, news_posts, payment_instructions,
-- payment_references, privacy_notices, school_year_closures, data_access_log,
-- export_runs. Dodatkowo school_years i classes nie miały żadnego triggera,
-- więc granice (starts_on/ends_on) i etykietę zamkniętego roku, a także nazwy
-- klas, dało się zmienić zwykłym UPDATE — a bank_reconciliation_guard (0015)
-- sprawdza datę względem ZMIENIONYCH granic roku.
--
-- Nowe triggery a0_year_freeze (funkcja year_freeze_direct z 0017; NULL w
-- school_year_id jest pomijany przez school_year_assert_open):
--   * classes                BEFORE INSERT OR UPDATE OR DELETE — nazwy i skład
--                            klas zamkniętego roku są częścią archiwum (listy,
--                            eksporty). Nowy rok dostaje klasy normalnie.
--   * enrollment_history     BEFORE INSERT — dopisywana historia zapisów; sam
--                            enrollments jest już zamrożony (0017).
--   * import_batches         BEFORE INSERT — nowy import do zamkniętego roku
--                            nie ma sensu (jego skutki, enrollments, i tak
--                            są zamrożone). UPDATE stanu istniejącej paczki
--                            NIE jest blokowany, żeby nie urwać trwającego
--                            przetwarzania.
--   * invitations            BEFORE INSERT — nowe zaproszenie do zamkniętego
--                            roku nie mogłoby zostać przyjęte (role_grants jest
--                            zamrożone). Wycofanie i wygaśnięcie zaproszenia
--                            (UPDATE) pozostaje możliwe: zmniejsza uprawnienia.
--   * payment_instructions   BEFORE INSERT — dane do przelewu na kartkach dla
--                            zamkniętego roku (tabela jest i tak dopisywana,
--                            UPDATE/DELETE blokuje jej własny trigger).
--   * payment_references     BEFORE INSERT OR UPDATE — nowa komunikacja
--                            strukturalna i jej unieważnienie to zapisy
--                            finansowe roku.
--   * news_posts             BEFORE INSERT — DECYZJA NIEROZSTRZYGNIĘTA (wariant
--                            zachowawczy): nie da się utworzyć NOWEGO wpisu
--                            aktualności przypisanego do zamkniętego roku.
--                            UPDATE/DELETE i zmiana stanu istniejącego wpisu
--                            nie są blokowane — cofnięcie publikacji (np.
--                            wycofana zgoda na wizerunek) musi działać zawsze.
--   * school_years           BEFORE UPDATE OR DELETE — nowa funkcja
--                            year_freeze_school_year_row() (klucz to id
--                            wiersza, nie kolumna school_year_id).
--
-- Świadome wyjątki (BEZ triggera; lista utrzymywana też w teście
-- tests/pg-year-close-finance-freeze.test.js i docs/YEAR_CLOSE.md):
--   * school_year_closures — sam rekord zamknięcia, chroni go year_close_guard.
--   * export_runs — eksport archiwum zamkniętego roku ma działać po zamknięciu.
--   * data_access_log — rejestr dostępu (RODO) musi przyjmować zapisy zawsze.
--   * privacy_notices — informacja o przetwarzaniu danych nie zależy od stanu
--     roku; publikacja/zastąpienie wersji nie może być blokowane (D-06).
--
-- year_freeze_via_parent() NIE jest tu redefiniowana (najnowsza definicja to
-- 0106; żadna nowa tabela podrzędna nie została dodana). Tabela
-- payment_reference_revocations nie ma roku i nie ma osobnego triggera:
-- unieważnienie zawsze towarzyszy UPDATE payment_references, który odrzuca
-- trigger powyżej (transakcja się wycofuje).
--
-- Skutki dla danych: żaden istniejący wiersz nie jest zmieniany ani usuwany;
-- triggery działają wyłącznie na przyszłe zapisy. Zapytanie kontrolne (nic nie
-- jest blokowane wstecz; wynik informacyjny — liczba klas zamkniętych lat):
--   SELECT count(*) FROM classes c
--     JOIN school_year_closures s ON s.school_year_id = c.school_year_id AND s.status = 'closed';
--
-- Wycofanie: DROP TRIGGER a0_year_freeze ON <każda z tabel powyżej>;
-- DROP FUNCTION year_freeze_school_year_row(). Nic nie zmienia w danych.

CREATE FUNCTION year_freeze_school_year_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM school_year_assert_open(OLD.id);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER a0_year_freeze BEFORE UPDATE OR DELETE ON school_years
  FOR EACH ROW EXECUTE FUNCTION year_freeze_school_year_row();

CREATE TRIGGER a0_year_freeze BEFORE INSERT OR UPDATE OR DELETE ON classes
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();

CREATE TRIGGER a0_year_freeze BEFORE INSERT ON enrollment_history
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();

CREATE TRIGGER a0_year_freeze BEFORE INSERT ON import_batches
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();

CREATE TRIGGER a0_year_freeze BEFORE INSERT ON invitations
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();

CREATE TRIGGER a0_year_freeze BEFORE INSERT ON payment_instructions
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();

CREATE TRIGGER a0_year_freeze BEFORE INSERT OR UPDATE ON payment_references
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();

CREATE TRIGGER a0_year_freeze BEFORE INSERT ON news_posts
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();
