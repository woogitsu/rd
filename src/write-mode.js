// Tryb tylko do odczytu (issue #143): wstrzymanie zapisów bez wyłączania panelu
// (okno serwisowe, cutover, incydent). Sterowane wyłącznie zmienną środowiskową
// APP_WRITE_MODE — redeploy Railway po zmianie.

export const WRITE_MODE_NORMAL = 'normal';
export const WRITE_MODE_READ_ONLY = 'read_only';

// Sekundy, po których klient/Brevo może bezpiecznie ponowić żądanie.
export const READ_ONLY_RETRY_AFTER_SECONDS = 300;

// Trasy zwolnione z blokady zapisu w read_only: wylogowanie musi zawsze
// działać (osoba kończąca sesję nie powinna utknąć zalogowana), a logowanie
// hasłem (/api/login) pozostaje możliwe, by dało się zweryfikować dostęp
// w trakcie okna serwisowego. Inne trasy modułu login (zaproszenia, zmiana
// i reset hasła) pozostają zablokowane — to zapisy stanu konta.
const EXEMPT_PATHS = new Set(['/api/login', '/api/logout']);

/**
 * Odczytuje i waliduje APP_WRITE_MODE. Nieznana wartość to błąd konfiguracji —
 * wołający (start serwera) ma się zatrzymać, a nie po cichu przyjąć 'normal'.
 */
export function resolveWriteMode(rawValue) {
  const value = rawValue === undefined || rawValue === null || rawValue === '' ? WRITE_MODE_NORMAL : String(rawValue);
  if (value !== WRITE_MODE_NORMAL && value !== WRITE_MODE_READ_ONLY) {
    throw new Error(`invalid_app_write_mode: APP_WRITE_MODE musi być "${WRITE_MODE_NORMAL}" albo "${WRITE_MODE_READ_ONLY}" (otrzymano wartość o innej treści)`);
  }
  return value;
}

export function isReadOnly(env) {
  return env?.APP_WRITE_MODE === WRITE_MODE_READ_ONLY;
}

export function isWriteExempt(pathname) {
  return EXEMPT_PATHS.has(pathname);
}
