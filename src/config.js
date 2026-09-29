// Walidacja konfiguracji przy starcie serwera Node (#114, SR-12).
//
// Poza środowiskiem lokalnym serwer nie startuje z konfiguracją, która dawałaby
// ciche błędy bezpieczeństwa: origin budowany z nagłówka Host (403 invalid_origin
// za proxy TLS), brak klucza MFA (503 dopiero przy zapisie), wspólny licznik
// logowań dla całej szkoły (brak TRUST_PROXY) albo za krótki sekret webhooka.
// Błąd wymienia WYŁĄCZNIE nazwy zmiennych i powody — nigdy wartości.
//
// APP_ENV: lokalne są tylko brak wartości, `development` i `test`. Każda inna
// wartość (staging, production, prod, a także literówka) jest traktowana
// zachowawczo jak środowisko wystawione do sieci — ta sama reguła co przy nazwie
// cookie sesji (src/auth.js). Pełne ujednolicenie APP_ENV w kodzie to #166.

import { isLocalAppEnv } from './auth.js';
import { loadEncryptionKeys } from './pg/mfa.js';

export const MIN_WEBHOOK_SECRET_LENGTH = 32;

export class ConfigError extends Error {
  constructor(problems) {
    super(`Nieprawidłowa konfiguracja: ${problems.map((p) => `${p.variable} (${p.reason})`).join(', ')}`);
    this.name = 'ConfigError';
    this.code = 'config_invalid';
    this.problems = problems;
    this.variables = problems.map((p) => p.variable);
  }
}

// https://host[:port], opcjonalnie jeden końcowy `/`; bez ścieżki, zapytania,
// fragmentu i danych logowania.
function validPublicBaseUrl(raw) {
  if (typeof raw !== 'string' || !/^https:\/\/[^/?#@\s]+\/?$/i.test(raw)) return false;
  try { return new URL(raw).hostname !== ''; } catch { return false; }
}

// Zwraca listę problemów ({ variable, reason }); pusta = konfiguracja poprawna.
export function configProblems(processEnv = process.env) {
  if (isLocalAppEnv(processEnv.APP_ENV)) return [];
  const problems = [];
  if (!validPublicBaseUrl(processEnv.PUBLIC_BASE_URL)) {
    problems.push({ variable: 'PUBLIC_BASE_URL', reason: 'wymagany adres https://host bez ścieżki' });
  }
  // Jawne klucze (także undefined), by loadEncryptionKeys nie sięgał do process.env.
  const mfaEnv = { MFA_ENCRYPTION_KEY: processEnv.MFA_ENCRYPTION_KEY, MFA_ENCRYPTION_KEYS: processEnv.MFA_ENCRYPTION_KEYS };
  if (!loadEncryptionKeys(mfaEnv)) {
    problems.push({ variable: 'MFA_ENCRYPTION_KEY', reason: 'wymagany poprawny klucz 32 bajty (albo MFA_ENCRYPTION_KEYS)' });
  }
  if (processEnv.TRUST_PROXY !== '1' && processEnv.TRUST_PROXY !== 'true') {
    problems.push({ variable: 'TRUST_PROXY', reason: 'wymagane 1 lub true (inaczej wspólny licznik logowań na IP proxy)' });
  }
  const webhook = processEnv.BREVO_WEBHOOK_SECRET;
  if (typeof webhook !== 'string' || webhook.length < MIN_WEBHOOK_SECRET_LENGTH) {
    problems.push({ variable: 'BREVO_WEBHOOK_SECRET', reason: `wymagane co najmniej ${MIN_WEBHOOK_SECRET_LENGTH} znaków` });
  }
  return problems;
}

export function validateConfig(processEnv = process.env) {
  const problems = configProblems(processEnv);
  if (problems.length) throw new ConfigError(problems);
}
