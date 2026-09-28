// Rotacja MFA_ENCRYPTION_KEY na wszystkie aktywne potwierdzone czynniki (#134).
//
//   MFA_ENCRYPTION_KEYS="2:<nowy klucz>,1:<stary klucz>" DATABASE_URL=… \
//     npm run mfa:rotate-key            # tryb próbny (nic nie zapisuje)
//   … npm run mfa:rotate-key -- --apply # zapisuje
//
// Bieżąca (docelowa) wersja to NAJWYŻSZY numer w MFA_ENCRYPTION_KEYS — stary
// klucz musi zostać w pierścieniu, dopóki raport nie pokaże zera czynników na
// starej wersji (patrz docs/RAILWAY_OPERATIONS.md, runbook rotacji).
// Wyjście: wyłącznie liczby, bez identyfikatorów osób.

import { createPgDatabase } from '../src/db.js';
import { MfaKeyRotationError, rotateMfaKeys } from '../src/pg/mfa-key-rotation.js';

export async function runRotateCli({ argv, env, db, stdout = process.stdout, stderr = process.stderr }) {
  const apply = argv.includes('--apply');
  if (!db && !env.DATABASE_URL) {
    stderr.write('DATABASE_URL is required. Nothing was changed.\n');
    return 1;
  }
  const database = db ?? createPgDatabase({ connectionString: env.DATABASE_URL, max: 1 });
  try {
    const report = await rotateMfaKeys({ db: database, MFA_ENCRYPTION_KEYS: env.MFA_ENCRYPTION_KEYS, MFA_ENCRYPTION_KEY: env.MFA_ENCRYPTION_KEY }, { apply });
    stdout.write([
      `mode: ${apply ? 'APPLY (zapisano)' : 'DRY RUN (nic nie zapisano — dodaj --apply)'}`,
      `current key version: ${report.currentVersion}`,
      `${apply ? 'rotated' : 'would rotate'}: ${report.rotated}`,
      `already on current version: ${report.skippedAlready}`,
      `missing key for old version (mfa_key_missing, pominięte): ${report.missingKey}`,
      '',
    ].join('\n'));
    return report.missingKey > 0 ? 2 : 0;
  } catch (error) {
    if (error instanceof MfaKeyRotationError) {
      stderr.write(`${error.code}: brak MFA_ENCRYPTION_KEYS/MFA_ENCRYPTION_KEY albo zły format. Nic nie zmieniono.\n`);
      return 1;
    }
    stderr.write(`Rotation failed (${typeof error?.code === 'string' ? error.code : 'error'}). Sprawdź logi bazy — transakcje per konto są atomowe, więc żadne konto nie zostało w stanie pośrednim.\n`);
    return 1;
  } finally {
    if (!db) await database.close();
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  runRotateCli({ argv: process.argv.slice(2), env: process.env }).then((code) => process.exit(code));
}
