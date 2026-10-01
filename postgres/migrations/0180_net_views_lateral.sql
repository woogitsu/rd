-- #159 (plany zapytań): widoki netto przez LEFT JOIN LATERAL zamiast podzapytania GROUP BY.
--
-- Problem: `ledger_entry_net` (a przez nią `ledger_balance_at`, `ledger_non_bank_net_at`,
-- `ledger_year_summary`, raporty) i `payment_entry_net` (a przez nią
-- `household_payment_totals`) agregowały korekty/zwroty WSZYSTKICH lat przed złączeniem
-- (HashAggregate po pełnym Seq Scan), także przy odczycie jednego roku albo jednego
-- gospodarstwa. Koszt rósł z historią systemu, nie z wielkością bieżącego roku.
-- Wariant LATERAL sumuje tylko wiersze danego wpisu po istniejących indeksach
-- (`ledger_corrections_entry_idx`, `payment_corrections_entry_idx`, `payment_refunds_entry_idx`).
--
-- Skutki dla danych: brak — tylko redefinicja widoków (CREATE OR REPLACE), te same
-- kolumny, w tej samej kolejności i o tych samych typach (sum(integer) = bigint;
-- brak korekt daje 0 jak wcześniej). Żadnych zmian w tabelach ani wierszach.
-- Wycofanie: CREATE OR REPLACE VIEW ze starą treścią z 0040 / 0038.
-- Lista kolumn jest jawna (bez `p.*`), zgodna z bieżącą definicją widoków.

CREATE OR REPLACE VIEW ledger_entry_net AS
SELECT e.id, e.school_year_id, e.direction, e.amount_cents, e.category_id, e.description,
  e.occurred_on, e.method, e.source, e.payment_entry_id, e.source_document_id,
  e.resolution_reference, e.created_by, e.created_at, e.idempotency_key,
  COALESCE(c.corrected_cents, 0) AS corrected_cents,
  e.amount_cents::BIGINT - COALESCE(c.corrected_cents, 0) AS net_amount_cents,
  e.replaces_entry_id
FROM ledger_entries e
LEFT JOIN LATERAL (
  SELECT sum(lc.amount_cents) AS corrected_cents
  FROM ledger_corrections lc WHERE lc.ledger_entry_id = e.id
) c ON true;

CREATE OR REPLACE VIEW payment_entry_net AS
SELECT p.id, p.household_id, p.school_year_id, p.amount_cents, p.received_on, p.method,
  p.reference, p.status, p.created_by, p.created_at, p.idempotency_key,
  COALESCE(c.corrected_cents, 0) AS corrected_cents,
  p.amount_cents::BIGINT - COALESCE(c.corrected_cents, 0) - COALESCE(r.refunded_cents, 0) AS net_amount_cents,
  COALESCE(r.refunded_cents, 0) AS refunded_cents
FROM payment_entries p
LEFT JOIN LATERAL (
  SELECT sum(pc.amount_cents) AS corrected_cents
  FROM payment_corrections pc WHERE pc.payment_entry_id = p.id
) c ON true
LEFT JOIN LATERAL (
  SELECT sum(pr.amount_cents) AS refunded_cents
  FROM payment_refunds pr WHERE pr.payment_entry_id = p.id
) r ON true;
