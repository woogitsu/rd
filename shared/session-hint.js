// Wskazówka „w tej przeglądarce może być aktywna sesja” dla ekranu /login/ (#99, przegląd demo 4).
//
// Po co: ekran logowania przy wejściu pytał zawsze GET /api/auth/state. Bez sesji serwer
// odpowiada 401 (kontrakt API bez zmian), a przeglądarka zapisuje to w konsoli jako błąd —
// przy każdym logowaniu. Z tą wskazówką ekran pyta o stan tylko wtedy, gdy ta przeglądarka
// dostała wcześniej sesję, która jeszcze nie wygasła.
//
// Co jest zapisane: wyłącznie czas wygaśnięcia sesji (ISO 8601) pod kluczem SESSION_HINT_KEY
// w localStorage. Bez sekretu sesji, identyfikatora konta, adresu e-mail ani ról.
// To nie jest kontrola dostępu: o sesji zawsze rozstrzyga serwer (cookie HttpOnly). Błędna
// wskazówka daje w najgorszym razie jedno zbędne pytanie (401 jak dawniej) albo formularz
// logowania mimo działającej sesji — ponowne logowanie tworzy nową sesję, nic nie ginie.
// Niedostępny localStorage (tryb prywatny, blokada) → pytamy zawsze, jak przed zmianą.

export const SESSION_HINT_KEY = "rd.sessionExpiresAt";
// Sesja żyje najwyżej dobę (src/auth.js sessionCookie); dalsza data to uszkodzony wpis.
const MAX_HINT_MS = 25 * 60 * 60 * 1000;

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

// Trasy, których `expiresAt` w odpowiedzi to czas wygaśnięcia BIEŻĄCEJ sesji (nowej albo po
// rotacji). Inne pola `expiresAt` (np. ważność zaproszenia w /api/invitations/preview) pomijamy.
const SESSION_EXPIRY_ROUTES = new Set([
  "/api/auth/state", "/api/login", "/api/invitations/accept",
  "/api/mfa/verify", "/api/mfa/recovery", "/api/mfa/confirm", "/api/password/change",
]);

// Czas wygaśnięcia sesji z odpowiedzi danej trasy albo null.
export function sessionExpiryFrom(url, data) {
  if (!SESSION_EXPIRY_ROUTES.has(String(url).split(/[?#]/)[0])) return null;
  if (!data || data.authenticated === false || typeof data.expiresAt !== "string") return null;
  return data.expiresAt;
}

// Zapis czasu wygaśnięcia z odpowiedzi logowania, MFA, zmiany hasła lub /api/auth/state.
export function rememberSession(expiresAt, storage = defaultStorage()) {
  if (!storage || typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt))) return;
  try { storage.setItem(SESSION_HINT_KEY, new Date(Date.parse(expiresAt)).toISOString()); } catch { /* bez wskazówki */ }
}

// Wylogowanie, 401 albo unieważnienie sesji.
export function forgetSession(storage = defaultStorage()) {
  if (!storage) return;
  try { storage.removeItem(SESSION_HINT_KEY); } catch { /* bez wskazówki */ }
}

// true — warto zapytać serwer o stan sesji; false — w tej przeglądarce nie ma ważnej sesji.
export function mayHaveSession(storage = defaultStorage(), now = Date.now()) {
  if (!storage) return true;
  let value;
  try { value = storage.getItem(SESSION_HINT_KEY); } catch { return true; }
  if (typeof value !== "string") return false;
  const at = Date.parse(value);
  if (!Number.isFinite(at) || at <= now || at - now > MAX_HINT_MS) {
    forgetSession(storage);
    return false;
  }
  return true;
}
