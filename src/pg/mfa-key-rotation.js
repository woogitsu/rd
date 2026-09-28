// Rotacja MFA_ENCRYPTION_KEY (#134). `user_mfa_factors` jest niezmienna (trigger
// z 0013_mfa.sql) — nie da się przeszyfrować wiersza w miejscu. Rotacja więc:
//   1. odszyfrowuje sekret starym kluczem (wersja z `key_version` wiersza),
//   2. wyłącza stary wiersz (disabled_at) — bez tego nowy potwierdzony wiersz
//      naruszyłby `user_mfa_factors_one_confirmed` (najwyżej jeden aktywny),
//   3. wstawia nowy wiersz zaszyfrowany BIEŻĄCĄ wersją klucza, z przeniesionym
//      confirmed_at i last_used_step (ochrona przed ponownym użyciem kroku),
//   4. przepina nieużyte kody odzyskiwania na nowy wiersz (rotated_to_factor_id),
//   5. zapisuje zdarzenie audytu mfa.key_rotated (identyfikatory i wersje,
//      bez sekretów).
// Cały krok jednego konta biegnie w jednej transakcji z `SELECT … FOR UPDATE`
// na wierszu czynnika — dwa równoległe uruchomienia skryptu na tym samym
// koncie serializują się na tej blokadzie; drugie po odblokowaniu widzi już
// przestawiony (disabled_at) stary wiersz i pomija konto (idempotencja).
//
// dryRun (domyślnie true w CLI) nie zapisuje niczego — tylko liczy, ile
// czynników wymagałoby rotacji i czy dla którejś starej wersji brakuje klucza
// w pierścieniu (`MFA_ENCRYPTION_KEYS`).

import { insertAuditEvent } from './audit.js';
import { decryptSecret, encryptSecret, loadEncryptionKeys } from './mfa.js';

export class MfaKeyRotationError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function database(env) {
  if (!env?.db || typeof env.db.query !== 'function') throw new Error('database_unavailable');
  return env.db;
}

// Zwraca { currentVersion, rotated, skippedAlready, missingKey, accounts }.
// `accounts` (szczegóły per konto) jest do testów/diagnostyki — CLI (scripts/
// rotate-mfa-key.js) wypisuje na stdout tylko liczby, bez identyfikatorów osób.
export async function rotateMfaKeys(env, { apply = false } = {}) {
  const keys = loadEncryptionKeys(env);
  if (!keys) throw new MfaKeyRotationError('mfa_unavailable');
  const db = database(env);
  const { rows: candidates } = await db.query(
    `SELECT DISTINCT user_id FROM user_mfa_factors
      WHERE confirmed_at IS NOT NULL AND disabled_at IS NULL AND key_version <> $1
      ORDER BY user_id`,
    [keys.currentVersion],
  );

  const report = {
    currentVersion: keys.currentVersion, rotated: 0, skippedAlready: 0, missingKey: 0, accounts: [],
  };

  for (const { user_id: userId } of candidates) {
    // eslint-disable-next-line no-await-in-loop -- rotacja jednego konta na raz, celowo sekwencyjnie.
    const outcome = await db.transaction(async (tx) => rotateOneAccount(tx, userId, keys, apply));
    if (outcome.status === 'already_current' || outcome.status === 'no_factor') {
      report.skippedAlready += 1;
    } else if (outcome.status === 'missing_key') {
      report.missingKey += 1;
      report.accounts.push({ userId, status: outcome.status, fromKeyVersion: outcome.fromKeyVersion });
    } else {
      report.rotated += 1;
      report.accounts.push({ userId, status: outcome.status, fromKeyVersion: outcome.fromKeyVersion, toKeyVersion: keys.currentVersion });
    }
  }
  return report;
}

async function rotateOneAccount(tx, userId, keys, apply) {
  const { rows } = await tx.query(
    `SELECT id, method, secret_ciphertext, secret_iv, secret_tag, key_version, confirmed_at, last_used_step
       FROM user_mfa_factors
      WHERE user_id = $1 AND confirmed_at IS NOT NULL AND disabled_at IS NULL
      FOR UPDATE`,
    [userId],
  );
  const factor = rows[0];
  if (!factor) return { status: 'no_factor' };
  const fromKeyVersion = Number(factor.key_version);
  if (fromKeyVersion === keys.currentVersion) return { status: 'already_current' };
  const oldKey = keys.ring.get(fromKeyVersion);
  if (!oldKey) return { status: 'missing_key', fromKeyVersion };
  if (!apply) return { status: 'would_rotate', fromKeyVersion };

  const secret = decryptSecret(
    oldKey,
    { ciphertext: factor.secret_ciphertext, iv: factor.secret_iv, tag: factor.secret_tag },
    { factorId: factor.id, userId, keyVersion: fromKeyVersion },
  );
  const newFactorId = crypto.randomUUID();
  const sealed = encryptSecret(keys.currentKey, secret, { factorId: newFactorId, userId, keyVersion: keys.currentVersion });
  secret.fill(0);

  // Stary wiersz WYŁĄCZAMY PRZED wstawieniem nowego: przez chwilę konto nie ma
  // aktywnego potwierdzonego czynnika, ale to jedna transakcja — z zewnątrz
  // niewidoczne. Odwrotna kolejność naruszyłaby `user_mfa_factors_one_confirmed`
  // (najwyżej jeden aktywny potwierdzony czynnik na konto).
  await tx.query('UPDATE user_mfa_factors SET disabled_at = now() WHERE id = $1', [factor.id]);
  await tx.query(
    `INSERT INTO user_mfa_factors (id, user_id, method, secret_ciphertext, secret_iv, secret_tag, key_version, confirmed_at, last_used_step)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [newFactorId, userId, factor.method, sealed.ciphertext, sealed.iv, sealed.tag, keys.currentVersion, factor.confirmed_at, factor.last_used_step],
  );
  await tx.query(
    `UPDATE mfa_recovery_codes SET rotated_to_factor_id = $2
       WHERE factor_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
    [factor.id, newFactorId],
  );
  await insertAuditEvent(tx, {
    actorId: null, action: 'mfa.key_rotated', entityType: 'mfa_factor', entityId: newFactorId,
    metadata: { previousFactorId: factor.id, fromKeyVersion, toKeyVersion: keys.currentVersion },
  });
  return { status: 'rotated', fromKeyVersion };
}
