-- #134: rotacja MFA_ENCRYPTION_KEY. `user_mfa_factors` jest niezmienna (trigger
-- 0013) — rotacja NIE nadpisuje szyfrogramu w miejscu. Zamiast tego
-- scripts/rotate-mfa-key.js wstawia nowy wiersz czynnika (nowy szyfrogram,
-- nowy key_version, przeniesione confirmed_at/last_used_step) i wyłącza stary
-- (disabled_at). Kody odzyskiwania wskazują `factor_id` czynnika, który je
-- wydał — bez tej kolumny rotacja logicznie unieważniłaby nieużyte kody osoby,
-- bo trafiałyby na wyłączony (disabled_at) czynnik.
--
-- Ta migracja dodaje WYŁĄCZNIE opcjonalną kolumnę repointu; nie zmienia żadnego
-- istniejącego wiersza (domyślnie NULL — brak rotacji, zachowanie jak dotąd).
ALTER TABLE mfa_recovery_codes ADD COLUMN rotated_to_factor_id TEXT REFERENCES user_mfa_factors(id);

CREATE INDEX mfa_recovery_codes_rotated_to_idx
  ON mfa_recovery_codes(rotated_to_factor_id) WHERE rotated_to_factor_id IS NOT NULL;
