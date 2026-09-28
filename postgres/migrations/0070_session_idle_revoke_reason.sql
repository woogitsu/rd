-- #150: sesja bez aktywności dłużej niż limit jest teraz jawnie wycofywana
-- (revoked_reason='idle'), zamiast tylko przestać działać po cichu — zgodnie
-- z zasadą repozytorium, że operacje na sesji mają trwały dziennik zdarzeń
-- (session.revoked, jak przy innych powodach). Rozszerza WYŁĄCZNIE listę
-- dozwolonych powodów; żaden istniejący wiersz się nie zmienia.
ALTER TABLE sessions DROP CONSTRAINT sessions_revoked_reason_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_revoked_reason_check
  CHECK (revoked_reason IN ('logout','rotated','admin','user_disabled','user_revoke_all',
                            'password_changed','password_reset','mfa_reset','idle'));
