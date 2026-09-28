// Szyfrowanie kopii zapasowej po stronie klienta (issue #90).
//
// Kopia nigdy nie trafia do magazynu w postaci jawnej. Klucz publiczny
// (RSA-OAEP, PEM) szyfruje jednorazowy klucz AES-256-GCM, którym jest
// szyfrowana właściwa treść. Klucz prywatny nie jest częścią tego
// repozytorium ani środowiska Railway — trzyma go zarząd (decyzja
// zarządu: kto i ile osób, patrz AGENTS.md „Decyzje wymagające zarządu”).
//
// Format paczki (Buffer): [4 bajty: długość nagłówka BE][nagłówek JSON]
// [szyfrogram]. Nagłówek: { alg, iv (base64), authTag (base64),
// encryptedKey (base64) }. Bez dodatkowych zależności — wyłącznie node:crypto.

import { createCipheriv, createDecipheriv, constants as cryptoConstants, privateDecrypt, publicEncrypt, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

function cryptoError(code) {
  return Object.assign(new Error(code), { code });
}

function assertPem(pem, code) {
  if (typeof pem !== 'string' || !pem.includes('BEGIN')) throw cryptoError(code);
  return pem;
}

// Szyfruje `plaintext` (Buffer/Uint8Array) kluczem publicznym RSA (PEM).
// Zwraca Buffer gotowy do zapisu w magazynie.
export function encryptEnvelope(plaintext, publicKeyPem) {
  assertPem(publicKeyPem, 'backup_encryption_key_missing');
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const authTag = cipher.getAuthTag();
  let encryptedKey;
  try {
    encryptedKey = publicEncrypt(
      { key: publicKeyPem, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      key,
    );
  } catch {
    throw cryptoError('backup_encryption_key_invalid');
  }
  const header = Buffer.from(JSON.stringify({
    alg: ALGORITHM,
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    encryptedKey: encryptedKey.toString('base64'),
  }), 'utf8');
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(header.length, 0);
  return Buffer.concat([headerLength, header, ciphertext]);
}

// Odszyfrowuje paczkę z encryptEnvelope kluczem prywatnym RSA (PEM).
export function decryptEnvelope(envelope, privateKeyPem) {
  assertPem(privateKeyPem, 'backup_decryption_key_missing');
  const buffer = Buffer.from(envelope);
  if (buffer.length < 4) throw cryptoError('backup_envelope_malformed');
  const headerLength = buffer.readUInt32BE(0);
  if (headerLength <= 0 || 4 + headerLength > buffer.length) throw cryptoError('backup_envelope_malformed');
  let header;
  try {
    header = JSON.parse(buffer.subarray(4, 4 + headerLength).toString('utf8'));
  } catch {
    throw cryptoError('backup_envelope_malformed');
  }
  if (header.alg !== ALGORITHM || !header.iv || !header.authTag || !header.encryptedKey) {
    throw cryptoError('backup_envelope_malformed');
  }
  let key;
  try {
    key = privateDecrypt(
      { key: privateKeyPem, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(header.encryptedKey, 'base64'),
    );
  } catch {
    throw cryptoError('backup_decryption_key_invalid');
  }
  const ciphertext = buffer.subarray(4 + headerLength);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(header.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(header.authTag, 'base64'));
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // Zły klucz prywatny lub uszkodzona/podmieniona paczka (GCM wykrywa oba).
    throw cryptoError('backup_decryption_failed');
  }
}
