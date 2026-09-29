-- Zakres limitu logowania (e-mail, IP) — blokada konta nie zależy już od samej
-- znajomości adresu e-mail (#126).
--
-- Skutki dla danych:
-- * Żaden wiersz nie jest zmieniany ani usuwany; poszerzone zostaje wyłącznie
--   ograniczenie CHECK na `login_rate_limits.scope_type` o wartość 'pair'.
-- * Nowy zakres 'pair' to SHA-256 pary (znormalizowany e-mail, adres IP) z
--   osobną dziedziną skrótu — w bazie nadal nie ma e-maila ani IP w postaci
--   jawnej. Wiersze podlegają tej samej retencji (usuwanie po dobie).
-- * Zakres 'email' przestaje zakładać twardą blokadę (`locked_until`); służy
--   do miękkiego opóźnienia. Wiersze 'email' z blokadą założoną przed tą zmianą
--   są ignorowane przy sprawdzaniu blokady i wygasają po dobie.
-- * Poprawne logowanie nadal kasuje liczniki pary i e-maila, nie IP.
ALTER TABLE login_rate_limits DROP CONSTRAINT login_rate_limits_scope_type_check;
ALTER TABLE login_rate_limits ADD CONSTRAINT login_rate_limits_scope_type_check
  CHECK (scope_type IN ('email', 'ip', 'pair'));
