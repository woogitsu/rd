// Czyste funkcje ekranu logowania (testy: tests/login-core.test.js).
// Bez DOM i bez sieci — main.js odpowiada za widoki i wywołania API.

import qrcode from "qrcode-generator";
import { safeNextPath } from "../shared/api.js";

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

// Panele po zalogowaniu. Dostęp do każdego sprawdza serwer — lista to tylko skróty.
export const PANELS = Object.freeze([
  { href: "/panel/", label: "Wpłaty", hint: "Ewidencja dobrowolnych wpłat i korekt" },
  { href: "/ledger/", label: "Księga", hint: "Przychody i wydatki Rady w EUR" },
  { href: "/families/", label: "Rodziny", hint: "Gospodarstwa, opiekunowie i rodzeństwo" },
  { href: "/import/", label: "Import uczniów", hint: "Wczytanie listy uczniów z pliku" },
  { href: "/print/", label: "Kartki", hint: "Kartki informacyjne o składce" },
  { href: "/events/", label: "Wydarzenia", hint: "Kalendarz i zatwierdzanie wydarzeń" },
  { href: "/meetings/", label: "Zebrania", hint: "Protokoły i uchwały" },
  { href: "/documents/", label: "Dokumenty", hint: "Prywatne dokumenty Rady" },
  { href: "/admin/", label: "Konta i role", hint: "Zaproszenia, role, reset hasła i MFA" },
  { href: "/site/", label: "Strona publiczna", hint: "Informacje dla rodziców" },
]);

const MESSAGES = {
  invalid_credentials: "Nieprawidłowy adres e-mail lub hasło.",
  too_many_attempts: "Zbyt wiele nieudanych prób. Spróbuj ponownie później.",
  invalid_origin: "Żądanie odrzucone. Otwórz stronę logowania bezpośrednio i spróbuj ponownie.",
  invalid_invitation: "Zaproszenie jest nieważne, wygasło albo zostało już wykorzystane. Poproś administratora o nowe.",
  invalid_token: "Kod resetu hasła jest nieważny, wygasł albo został już użyty. Poproś administratora o nowy.",
  invalid_current_password: "Obecne hasło jest nieprawidłowe.",
  password_too_short: `Hasło musi mieć co najmniej ${PASSWORD_MIN} znaków.`,
  password_too_long: `Hasło może mieć najwyżej ${PASSWORD_MAX} znaków.`,
  password_common: "To hasło jest zbyt popularne lub przewidywalne. Wybierz inne, np. kilka niezwiązanych słów.",
  password_contains_email: "Hasło nie może zawierać adresu e-mail.",
  password_unchanged: "Nowe hasło musi być inne niż obecne.",
  password_mismatch: "Hasła nie są takie same.",
  invalid_display_name: "Nazwa wyświetlana może mieć najwyżej 100 znaków.",
  invalid_code: "Kod jest nieprawidłowy. Sprawdź aplikację i wpisz aktualny kod.",
  mfa_locked: "Zbyt wiele błędnych kodów. Spróbuj ponownie za kilkanaście minut.",
  mfa_required: "Potwierdź logowanie kodem z aplikacji uwierzytelniającej.",
  mfa_enrollment_required: "Twoja rola wymaga weryfikacji dwuetapowej. Skonfiguruj aplikację uwierzytelniającą.",
  mfa_unavailable: "Weryfikacja dwuetapowa jest chwilowo niedostępna. Skontaktuj się z administratorem.",
  mfa_enrollment_not_found: "Konfiguracja wygasła. Rozpocznij ją ponownie.",
  mfa_not_enrolled: "Konto nie ma skonfigurowanej aplikacji uwierzytelniającej.",
  unauthenticated: "Sesja wygasła. Zaloguj się ponownie.",
  conflict: "Dane zmieniły się w międzyczasie. Spróbuj ponownie.",
  service_unavailable: "Usługa jest chwilowo niedostępna. Spróbuj ponownie za chwilę.",
};

export function errorMessage(code, status) {
  if (code && MESSAGES[code]) return MESSAGES[code];
  if (status === 429) return MESSAGES.too_many_attempts;
  if (status >= 500) return MESSAGES.service_unavailable;
  return "Nie udało się wykonać operacji. Spróbuj ponownie.";
}

export function normalizeEmailInput(value) {
  return String(value ?? "").trim();
}

export function validateEmail(value) {
  const email = normalizeEmailInput(value);
  if (!email) return "Podaj adres e-mail.";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Podaj adres e-mail w formacie nazwa@domena.pl.";
  return null;
}

// Długość liczona w znakach (jak na serwerze, po NFKC). Pełną politykę
// (popularne hasła, adres e-mail) sprawdza serwer.
export function passwordLength(value) {
  return [...String(value ?? "").normalize("NFKC")].length;
}

export function validateNewPassword(password, repeat) {
  const length = passwordLength(password);
  if (length < PASSWORD_MIN) return MESSAGES.password_too_short;
  if (length > PASSWORD_MAX) return MESSAGES.password_too_long;
  if (repeat !== undefined && password !== repeat) return "Hasła nie są takie same.";
  return null;
}

// Kod TOTP: aplikacje pokazują go czasem jako „123 456”.
export function normalizeTotp(value) {
  return String(value ?? "").replace(/[\s-]/g, "");
}

export function isTotpFormat(value) {
  return /^\d{6}$/.test(normalizeTotp(value));
}

export function normalizeRecoveryCode(value) {
  return String(value ?? "").toUpperCase().replace(/[\s-]/g, "");
}

export function isRecoveryFormat(value) {
  return /^[A-Z2-7]{16}$/.test(normalizeRecoveryCode(value));
}

// Token w części URL po „#” nie trafia do serwera ani jego logów.
export function parseFragment(hash) {
  const text = String(hash ?? "").replace(/^#/, "");
  const params = new URLSearchParams(text);
  const token = (name) => {
    const value = params.get(name);
    return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
  };
  if (params.has("invite")) return { view: "invite", token: token("invite") };
  if (params.has("reset")) return { view: "reset", token: token("reset") };
  if (params.has("change")) return { view: "change" };
  return { view: null };
}

// Powrót do panelu po zalogowaniu (#99): „#next=/panel/”. Tylko ścieżka względna
// tego samego origin (zaczyna się od „/”, nie od „//”), inaczej null.
export function nextFromFragment(hash) {
  const params = new URLSearchParams(String(hash ?? "").replace(/^#/, ""));
  return safeNextPath(params.get("next"));
}

// Następny widok po zalogowaniu lub odczycie stanu sesji.
// `mfaWantedByPanel`: panel odesłał tu zalogowane konto kodem mfa_enrollment_required
// (wejście na stronę z „#next=…”, bez wymogu MFA dla roli z MFA_REQUIRED_ROLES — np. Komisja
// Rewizyjna i raport roczny). Bez tego konto lądowało na liście paneli bez żadnego
// wyjaśnienia, a po kliknięciu „Powrót” wracało do odmowy.
export function nextView(state, { mfaWantedByPanel = false } = {}) {
  if (!state || state.authenticated === false) return "login";
  if (state.mfaVerified) return state.mustChangePassword ? "change" : "start";
  if (state.mfaEnrolled) return "mfa";
  if (state.mfaRequiredByRole || state.mfaRequired) return "enroll";
  if (state.mustChangePassword) return "change";
  return mfaWantedByPanel ? "enroll" : "start";
}

// #161: dowolne zalogowane konto bez potwierdzonego czynnika może dobrowolnie
// włączyć weryfikację dwuetapową z widoku startowego, niezależnie od roli.
export function canOfferVoluntaryMfaEnrollment(state) {
  return Boolean(state && state.authenticated !== false && !state.mfaEnrolled);
}

// #176: ekran startowy pokazuje listę paneli tylko gdy konto ma co najmniej jedną
// rolę z aktywnymi trasami (`hasActiveRole` z GET /api/access, obliczone przez
// serwer z ROLE_STATUS — src/pg/auth.js — jedyne źródło prawdy). Brak odpowiedzi
// (błąd sieci, `mfaRequired`) traktujemy jak "nieznane" i pokazujemy panele
// jak dotychczas — komunikat nie może fałszywie stwierdzić braku dostępu.
export function shouldShowNoAccessNotice(access) {
  return Boolean(access) && access.hasActiveRole === false;
}

// Treść widoku konfiguracji: inna, gdy rola jej wymaga (nie można pominąć),
// niż gdy konto włącza ją z własnej inicjatywy (można wrócić do paneli).
export function enrollIntroText(forced) {
  return forced
    ? "Twoja rola wymaga drugiego składnika logowania. Zainstaluj na telefonie Google Authenticator albo Microsoft Authenticator (lub inną aplikację zgodną z TOTP)."
    : "Dodaj drugi składnik logowania dla własnego bezpieczeństwa. Zainstaluj na telefonie Google Authenticator albo Microsoft Authenticator (lub inną aplikację zgodną z TOTP).";
}

// Klucz ręczny w grupach po 4 znaki (łatwiej przepisać do aplikacji).
export function formatSecret(secret) {
  return String(secret ?? "").replace(/\s+/g, "").match(/.{1,4}/g)?.join(" ") ?? "";
}

// Sprawdza URI z POST /api/mfa/enroll przed pokazaniem kodu QR.
export function parseOtpauthUri(uri) {
  let url;
  try { url = new URL(uri); } catch { return null; }
  if (url.protocol !== "otpauth:" || url.hostname !== "totp") return null;
  const label = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const secret = url.searchParams.get("secret") ?? "";
  if (!/^[A-Z2-7]{16,128}$/.test(secret)) return null;
  const separator = label.indexOf(":");
  return {
    issuer: url.searchParams.get("issuer") ?? (separator > 0 ? label.slice(0, separator) : ""),
    account: separator >= 0 ? label.slice(separator + 1) : label,
    secret,
    algorithm: url.searchParams.get("algorithm") ?? "SHA1",
    digits: Number(url.searchParams.get("digits") ?? 6),
    period: Number(url.searchParams.get("period") ?? 30),
  };
}

// Macierz kodu QR (poziom korekcji M, tryb bajtowy, wersja dobierana automatycznie).
// Kod powstaje w przeglądarce — sekret nie trafia do zewnętrznych usług.
export function qrMatrix(text) {
  if (!parseOtpauthUri(text)) throw new Error("invalid_otpauth_uri");
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => qr.isDark(row, col)));
}

// Ścieżka SVG (jeden <path>) z marginesem 4 modułów wymaganym przez normę.
export function qrSvgPath(matrix, quiet = 4) {
  const size = matrix.length + quiet * 2;
  const parts = [];
  matrix.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) { x += 1; continue; }
      const start = x;
      while (x < row.length && row[x]) x += 1;
      parts.push(`M${start + quiet} ${y + quiet}h${x - start}v1h-${x - start}z`);
    }
  });
  return { size, d: parts.join("") };
}

// --- Dane wrażliwe w DOM (#197) ---------------------------------------------------------
// Ekran jest jedną stroną: ukryte widoki zostają w drzewie DOM tej samej karty (wspólny
// komputer). Przy wylogowaniu, powrocie do logowania, zmianie „#…” i opuszczeniu strony
// czyścimy sekret TOTP, kod QR, kody odzyskiwania i wszystkie pola haseł i kodów.

export const SECRET_INPUT_IDS = Object.freeze([
  "login-password", "totp-code", "recovery-code", "enroll-code",
  "invite-password", "invite-repeat", "reset-password", "reset-repeat",
  "change-current", "change-password", "change-repeat",
]);
const TOKEN_INPUT_IDS = Object.freeze(["invite-token", "reset-token"]);
const SECRET_TEXT_IDS = Object.freeze(["manual-key"]);
const SECRET_CONTAINER_IDS = Object.freeze(["qr-code", "recovery-codes"]);

export function resetPasswordToggle(doc, toggle) {
  const input = doc.getElementById(toggle.dataset.target);
  if (input) input.type = "password";
  toggle.setAttribute("aria-pressed", "false");
  toggle.textContent = "Pokaż hasło";
}

export function clearSensitiveViews(doc, { keepTokens = false } = {}) {
  for (const id of SECRET_TEXT_IDS) { const node = doc.getElementById(id); if (node) node.textContent = ""; }
  for (const id of SECRET_CONTAINER_IDS) doc.getElementById(id)?.replaceChildren();
  for (const id of SECRET_INPUT_IDS) { const input = doc.getElementById(id); if (input) input.value = ""; }
  if (!keepTokens) for (const id of TOKEN_INPUT_IDS) { const input = doc.getElementById(id); if (input) input.value = ""; }
  for (const toggle of doc.querySelectorAll(".toggle-password")) resetPasswordToggle(doc, toggle);
}

// Wynik POST /api/logout (status odpowiedzi albo błędu; błąd sieci = 503). Tylko 204
// (wylogowano) i 401 (sesji już nie ma) oznaczają brak aktywnej sesji.
export function logoutOutcome(status) {
  if (status === 204 || status === 200 || status === 401) return { loggedOut: true, message: "Wylogowano." };
  return {
    loggedOut: false,
    message: "Nie udało się wylogować. Sesja może być nadal aktywna — spróbuj ponownie albo zamknij przeglądarkę.",
  };
}

// Błąd POST /api/mfa/confirm w trakcie konfiguracji.
export function enrollmentConfirmError(code, status) {
  if (code === "mfa_enrollment_not_found") {
    return { restart: true, message: "Konfiguracja wygasła albo została rozpoczęta ponownie w innej karcie. Rozpocznij ją ponownie przyciskiem poniżej." };
  }
  if (code === "invalid_code") {
    return { restart: false, message: `${MESSAGES.invalid_code} Jeśli konfigurację rozpoczęto w innej karcie, użyj najnowszego kodu QR.` };
  }
  return { restart: false, message: errorMessage(code, status) };
}
