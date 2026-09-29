// Test staging Storage Bucket na syntetycznym pliku (issue #39).
// Zapisuje wygenerowany PDF pod losowym kluczem smoke/<uuid>, odczytuje go,
// porównuje SHA-256 i usuwa. Nie dotyka dokumentów (docs/…) ani bazy.
// Wypisuje wyłącznie wynik — bez adresu, nazwy bucketu i kluczy dostępu.

import { appEnvWarning, isProductionLikeEnv } from '../src/app-env.js';
import { sha256Hex, storageFromEnv } from '../src/storage.js';

function syntheticPdf() {
  const stamp = new Date().toISOString();
  return new TextEncoder().encode(`%PDF-1.4\n% RD storage smoke test ${stamp} - dane syntetyczne\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n`);
}

if (isProductionLikeEnv(process.env.APP_ENV)) {
  const warning = appEnvWarning(process.env.APP_ENV);
  if (warning) console.error(warning);
  console.error('Storage smoke test is for staging only (set APP_ENV=staging). Nothing was written.');
  process.exitCode = 1;
} else {
  let storage = null;
  try {
    storage = storageFromEnv(process.env);
  } catch (error) {
    console.error(`Storage configuration error: ${error.code ?? 'invalid'}`);
    process.exitCode = 1;
  }
  if (!storage && !process.exitCode) {
    console.error('BUCKET_* variables are not set. Nothing was written.');
    process.exitCode = 1;
  }
  if (storage) {
    const key = `smoke/${crypto.randomUUID()}`;
    const bytes = syntheticPdf();
    try {
      await storage.putObject(key, bytes, 'application/pdf');
      const object = await storage.getObject(key);
      if (sha256Hex(object.body) !== sha256Hex(bytes)) throw Object.assign(new Error('mismatch'), { code: 'smoke_checksum_mismatch' });
      console.log(`Storage smoke test OK: ${bytes.length} bytes written, read back and verified.`);
    } catch (error) {
      console.error(`Storage smoke test failed: ${error.code ?? 'error'}`);
      process.exitCode = 1;
    } finally {
      await storage.deleteObject(key).catch(() => console.error('Cleanup of the synthetic object failed; remove smoke/* manually.'));
    }
  }
}
