// Wczytuje dane zapisane przez tests/e2e/support/server.js (hasła, cookies
// sesji, identyfikatory syntetycznych danych) — plik NIE jest w repo (.gitignore).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RUNTIME_FILE = fileURLToPath(new URL('.runtime.json', import.meta.url));

export function readRuntime() {
  const raw = readFileSync(RUNTIME_FILE, 'utf8');
  return JSON.parse(raw);
}
