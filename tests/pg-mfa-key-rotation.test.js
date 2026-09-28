// #134: rotacja MFA_ENCRYPTION_KEY. AAD musi używać WERSJI ZAPISANEJ W WIERSZU
// (nie stałej z kodu), żeby stare czynniki nadal się odszyfrowywały po dodaniu
// nowego klucza. Wyłącznie dane syntetyczne (domeny .invalid).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { handlePgRequest } from '../src/pg/app.js';
import {
  base32Decode, decryptSecret, encryptSecret, loadEncryptionKeys, totp,
} from '../src/pg/mfa.js';
import { rotateMfaKeys } from '../src/pg/mfa-key-rotation.js';
import { createTestDb, request, seedUserSession } from './helpers/pg.js';

const KEY_V1 = randomBytes(32).toString('base64');
const KEY_V2 = randomBytes(32).toString('base64');
const RING = `2:${KEY_V2},1:${KEY_V1}`;

let db;
before(async () => { db = await createTestDb(); });
after(async () => { await db?.close(); });

function cookieFrom(response) {
  const header = response.headers.get('Set-Cookie');
  assert.ok(header, 'Set-Cookie expected');
  return header.split(';', 1)[0];
}
const postWith = (path, cookie, body, env) => handlePgRequest(request(path, { method: 'POST', cookie, body }), env);
const envV1 = () => ({ db, MFA_ENCRYPTION_KEY: KEY_V1 });
const envRing = () => ({ db, MFA_ENCRYPTION_KEYS: RING });
const codeAt = (secretB32, offsetSteps = 0) => totp(base32Decode(secretB32), Date.now() + offsetSteps * 30_000);

async function enrollAndConfirm(userId, env = envV1()) {
  const cookie = await seedUserSession(db, { userId });
  const enrolled = await postWith('/api/mfa/enroll', cookie, undefined, env);
  assert.equal(enrolled.status, 201);
  const { secret, factorId } = await enrolled.json();
  const confirmed = await postWith('/api/mfa/confirm', cookie, { code: codeAt(secret) }, env);
  assert.equal(confirmed.status, 200);
  const { recoveryCodes } = await confirmed.json();
  return { cookie: cookieFrom(confirmed), secret, factorId, recoveryCodes };
}

test('loadEncryptionKeys: pierścień wielu wersji, klucz bieżący to najwyższy numer, brak/zła wartość -> null', () => {
  assert.equal(loadEncryptionKeys({}), null);
  assert.equal(loadEncryptionKeys({ MFA_ENCRYPTION_KEYS: 'not-a-ring' }), null);
  const single = loadEncryptionKeys({ MFA_ENCRYPTION_KEY: KEY_V1 });
  assert.equal(single.currentVersion, 1);
  assert.deepEqual([...single.ring.keys()], [1]);
  const ring = loadEncryptionKeys({ MFA_ENCRYPTION_KEYS: RING });
  assert.equal(ring.currentVersion, 2);
  assert.deepEqual([...ring.ring.keys()].sort(), [1, 2]);
  // Wpis o złym formacie klucza jest pomijany, reszta pierścienia działa.
  const partiallyBad = loadEncryptionKeys({ MFA_ENCRYPTION_KEYS: `3:zle-slowo,${RING}` });
  assert.equal(partiallyBad.currentVersion, 2);
});

test('AAD z wersją wiersza: szyfrogram v1 nie odszyfrowuje się z wersją 2 (i odwrotnie)', () => {
  const bytes = randomBytes(20);
  const keys = loadEncryptionKeys({ MFA_ENCRYPTION_KEYS: RING });
  const sealedV1 = encryptSecret(keys.ring.get(1), bytes, { factorId: 'f1', userId: 'u1', keyVersion: 1 });
  assert.deepEqual(decryptSecret(keys.ring.get(1), sealedV1, { factorId: 'f1', userId: 'u1', keyVersion: 1 }), bytes);
  assert.throws(() => decryptSecret(keys.ring.get(2), sealedV1, { factorId: 'f1', userId: 'u1', keyVersion: 2 }));
  // Zgodność wsteczna: bez jawnego keyVersion domyślna wersja (1) po obu stronach nadal działa.
  const sealedDefault = encryptSecret(keys.ring.get(1), bytes, { factorId: 'f1', userId: 'u1' });
  assert.deepEqual(decryptSecret(keys.ring.get(1), sealedDefault, { factorId: 'f1', userId: 'u1' }), bytes);
});

test('#134: po dodaniu klucza v2 czynniki v1 nadal weryfikują kody; nowe czynniki powstają jako v2', async () => {
  const oldAccount = await enrollAndConfirm('u-rot-old');
  // Zgodność wsteczna: TEN SAM proces obsługuje teraz oba warianty configu.
  // Weryfikacja starego czynnika (v1) działa z pierścieniem, który zawiera v1.
  const okOldWithRing = await postWith('/api/mfa/verify', oldAccount.cookie, { code: codeAt(oldAccount.secret, 1) }, envRing());
  assert.equal(okOldWithRing.status, 200, 'stary czynnik (v1) odszyfrowuje się kluczem v1 z pierścienia');
  const cookieAfterVerify = cookieFrom(okOldWithRing); // każda udana weryfikacja rotuje sesję

  // Nowy czynnik zapisany PRZY AKTYWNYM PIERŚCIENIU dostaje bieżącą (najwyższą) wersję.
  const newAccount = await enrollAndConfirm('u-rot-new', envRing());
  const row = (await db.query('SELECT key_version FROM user_mfa_factors WHERE id = $1', [newAccount.factorId])).rows[0];
  assert.equal(Number(row.key_version), 2);

  // Bez klucza starej wersji w pierścieniu: mfa_key_missing, nie 503 bez przyczyny/500.
  const noOldKeyRing = { db, MFA_ENCRYPTION_KEYS: `2:${KEY_V2}` };
  const missing = await postWith('/api/mfa/verify', cookieAfterVerify, { code: codeAt(oldAccount.secret, 2) }, noOldKeyRing);
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).error, 'mfa_key_missing');
});

test('#134: skrypt rotacji przenosi czynniki v1 na v2, zachowuje last_used_step i kody odzyskiwania', async () => {
  const account = await enrollAndConfirm('u-rot-apply');
  // Zużywamy jeden krok TOTP przed rotacją, żeby sprawdzić ochronę przed replay po rotacji.
  const usedStep = await postWith('/api/mfa/verify', account.cookie, { code: codeAt(account.secret, 1) }, envRing());
  assert.equal(usedStep.status, 200);
  let cookie = cookieFrom(usedStep); // każda udana weryfikacja rotuje sesję — dalej używamy najnowszego cookie
  const beforeRow = (await db.query('SELECT id, last_used_step, confirmed_at FROM user_mfa_factors WHERE id = $1', [account.factorId])).rows[0];

  // Tryb próbny: nic nie zapisuje.
  const dryRun = await rotateMfaKeys(envRing(), { apply: false });
  assert.equal(dryRun.currentVersion, 2);
  assert.ok(dryRun.rotated >= 1);
  const unchanged = (await db.query('SELECT disabled_at FROM user_mfa_factors WHERE id = $1', [account.factorId])).rows[0];
  assert.equal(unchanged.disabled_at, null, 'dry run nie zapisuje niczego');

  // Zapis.
  const applied = await rotateMfaKeys(envRing(), { apply: true });
  assert.ok(applied.rotated >= 1);
  const oldRow = (await db.query('SELECT disabled_at FROM user_mfa_factors WHERE id = $1', [account.factorId])).rows[0];
  assert.ok(oldRow.disabled_at, 'stary wiersz jest wyłączony, nie usunięty ani nadpisany');
  const newRow = (await db.query(
    `SELECT id, key_version, confirmed_at, last_used_step FROM user_mfa_factors
      WHERE user_id = 'u-rot-apply' AND confirmed_at IS NOT NULL AND disabled_at IS NULL`,
  )).rows[0];
  assert.equal(Number(newRow.key_version), 2);
  assert.equal(new Date(newRow.confirmed_at).toISOString(), new Date(beforeRow.confirmed_at).toISOString(), 'confirmed_at przeniesione bez zmian');
  assert.equal(String(newRow.last_used_step), String(beforeRow.last_used_step), 'last_used_step przeniesiony — ochrona przed replay');

  // Ponowne uruchomienie: bezpieczne, nic więcej do zrobienia dla tego konta.
  const idempotent = await rotateMfaKeys(envRing(), { apply: true });
  const stillOneActive = (await db.query(
    "SELECT count(*)::int AS n FROM user_mfa_factors WHERE user_id = 'u-rot-apply' AND confirmed_at IS NOT NULL AND disabled_at IS NULL",
  )).rows[0].n;
  assert.equal(stillOneActive, 1, 'ponowne uruchomienie nie tworzy drugiego aktywnego czynnika');

  // Replay kroku użytego TUŻ PRZED rotacją jest odrzucony jako 'replay' (nie 'mfa_key_missing'
  // ani cichy sukces) — last_used_step został przeniesiony na nowy wiersz. Błąd nie rotuje
  // sesji, więc `cookie` zostaje ważne do kolejnego kroku testu.
  const replay = await postWith('/api/mfa/verify', cookie, { code: codeAt(account.secret, 1) }, envRing());
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, 'invalid_code');
  const replayAudit = (await db.query(
    "SELECT metadata_json FROM audit_events WHERE action = 'mfa.failed' ORDER BY occurred_at DESC LIMIT 1",
  )).rows[0];
  assert.equal(replayAudit.metadata_json.reason, 'replay', 'przyczyna odrzucenia to replay, nie invalid_code z innego powodu');

  // Nieużyty kod odzyskiwania nadal działa po rotacji (przepięty na nowy wiersz czynnika).
  const recovered = await postWith('/api/mfa/recovery', cookie, { code: account.recoveryCodes[0] }, envRing());
  assert.equal(recovered.status, 200, 'nieużyty kod odzyskiwania działa po rotacji');
  cookie = cookieFrom(recovered);
  const reused = await postWith('/api/mfa/recovery', cookie, { code: account.recoveryCodes[0] }, envRing());
  assert.equal(reused.status, 400, 'raz użyty kod odzyskiwania pozostaje wykorzystany');

  assert.equal(idempotent.rotated, 0, 'ponowne uruchomienie nie rotuje już przeniesionego konta');
});

test('#134: brak klucza starej wersji w pierścieniu -> mfa_key_missing w raporcie, konto pominięte (bez wyjątku)', async () => {
  await enrollAndConfirm('u-rot-missing');
  // Wstrzykujemy czynnik na "wersji 9", dla której nie ma klucza w pierścieniu.
  const ghostKeys = loadEncryptionKeys({ MFA_ENCRYPTION_KEYS: `9:${randomBytes(32).toString('base64')}` });
  const sealed = encryptSecret(ghostKeys.currentKey, randomBytes(20), { factorId: 'f-ghost', userId: 'u-rot-missing2', keyVersion: 9 });
  await db.query(
    `INSERT INTO users (id, email, display_name) VALUES ('u-rot-missing2', 'u-rot-missing2@example.invalid', 'Test')
     ON CONFLICT (id) DO NOTHING`,
  );
  await db.query(
    `INSERT INTO user_mfa_factors (id, user_id, method, secret_ciphertext, secret_iv, secret_tag, key_version, confirmed_at)
     VALUES ('f-ghost', 'u-rot-missing2', 'totp', $1, $2, $3, 9, now())`,
    [sealed.ciphertext, sealed.iv, sealed.tag],
  );
  const report = await rotateMfaKeys(envRing(), { apply: true });
  assert.ok(report.missingKey >= 1);
  assert.ok(report.accounts.some((a) => a.userId === 'u-rot-missing2' && a.status === 'missing_key'));
  const stillActive = (await db.query("SELECT disabled_at FROM user_mfa_factors WHERE id = 'f-ghost'")).rows[0];
  assert.equal(stillActive.disabled_at, null, 'konto bez klucza starej wersji zostaje nietknięte, nie ryzykujemy jego zablokowania');
});
