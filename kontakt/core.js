// Czyste funkcje publicznej strony „Aktualizacja kontaktu” (#140) — bez DOM i sieci,
// testowane w tests/kontakt-core.test.js. Strona używa wyłącznie tras publicznych:
//   GET  /api/public/guardian-update?token=…   podgląd (imię opiekuna, klasy)
//   POST /api/public/guardian-update            wniosek (zarząd decyduje, strona niczego nie zmienia)
//   POST /api/public/guardian-update/verify     kod weryfikacyjny nowego adresu (8 cyfr)
// Jednorazowy token jest w części po `#` adresu (`/kontakt/#token=…`), więc nie trafia
// do serwera ani do jego logów; ten sam token służy do wniosku i do wpisania kodu.
// Odpowiedzi serwera nie zdradzają, czy adres jest zablokowany ani dlaczego kod nie pasuje —
// strona też nie: jedna treść dla każdej porażki potwierdzenia.

export const TOKEN_PATTERN = /^[0-9a-f]{32,128}$/;
export const CODE_LENGTH = 8;
export const MAX_NOTE_LENGTH = 500;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

export const SUBMIT_URL = "/api/public/guardian-update";
export const VERIFY_URL = "/api/public/guardian-update/verify";

// Token z `#token=<hex>`; zły format to null (strona pokazuje komunikat o nieaktywnym linku).
export function tokenFromFragment(hash) {
  const text = typeof hash === "string" ? hash.replace(/^#/, "") : "";
  const token = new URLSearchParams(text).get("token") ?? "";
  return TOKEN_PATTERN.test(token) ? token : null;
}

export function previewUrl(token) {
  if (!TOKEN_PATTERN.test(token ?? "")) throw new Error("Niepoprawny token.");
  return `${SUBMIT_URL}?token=${encodeURIComponent(token)}`;
}

// Treści błędów tras publicznych (priorytet przed słownikiem wspólnym). Kod nieznany
// dostaje ogólny tekst ze słownika wspólnego — nigdy surowy kod.
export const KONTAKT_MESSAGES = Object.freeze({
  invalid_or_expired_link: "Ten link jest nieprawidłowy, wygasł albo został już wykorzystany. Poproś Radę Rodziców o nowy.",
  link_used: "Z tego linku złożono już wniosek. Jeśli dostałeś(-aś) kod w wiadomości e-mail, wpisz go poniżej; w innym wypadku poproś Radę o nowy link.",
  invalid_email: "Podaj poprawny adres e-mail, np. imie@przyklad.pl.",
  invalid_request: "Wybierz, co chcesz zmienić: nowy adres e-mail albo zgodę na kontakt.",
  possible_personal_data: "Uwaga zawiera dane, które wyglądają na osobowe (np. numer telefonu). Usuń je albo potwierdź, że są konieczne.",
  personal_data_forbidden: "Uwaga zawiera adres e-mail, numer rachunku albo numer rejestru krajowego. Usuń te dane i wyślij ponownie.",
});

// Jedna treść dla KAŻDEJ porażki potwierdzenia kodu: zły token, zły albo wygasły kod,
// limit prób, wniosek już rozpatrzony, błąd sieci, limit żądań. Bez wyroczni i bez danych.
export const VERIFY_FAILURE_TEXT =
  "Nie udało się potwierdzić adresu tym kodem. Sprawdź, czy wpisujesz 8 cyfr z najnowszej wiadomości — kod mógł też wygasnąć. "
  + "Możesz spróbować ponownie albo pominąć ten krok: wniosek i tak trafi do Rady.";
export const VERIFY_SUCCESS_TEXT =
  "Adres został potwierdzony kodem. Wniosek nadal czeka na decyzję Rady — dane zmienią się dopiero po jej zatwierdzeniu.";

export function verifyFailureText() {
  return VERIFY_FAILURE_TEXT;
}

// Kod wklejony z wiadomości: spacje (także niełamliwe) i myślniki są pomijane.
export function normalizeCode(value) {
  return String(value ?? "").replace(/[\s‐-―-]/g, "");
}

export function isCodeFormat(code) {
  return /^[0-9]{8}$/.test(code);
}

// Ciało `POST …/verify` albo null, gdy token lub kod mają zły format (wtedy żądanie nie wychodzi,
// a użytkownik widzi tę samą treść co przy odrzuceniu przez serwer).
export function buildVerifyBody(token, rawCode) {
  const code = normalizeCode(rawCode);
  if (!TOKEN_PATTERN.test(token ?? "") || !isCodeFormat(code)) return null;
  return { token, code };
}

// Sprawdzenie w przeglądarce jest tylko podpowiedzią; adres normalizuje i ocenia serwer.
export function validateEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email) return { ok: true, email: null };
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return { ok: false, email: null };
  return { ok: true, email };
}

export const CONSENT_CHOICES = Object.freeze({ keep: "keep", allow: "allow", withdraw: "withdraw" });

// Ciało wniosku albo { error } z kodem błędu. Zmiana zgody wymaga jawnego wyboru:
// „bez zmiany” jest domyślne, więc pusty formularz niczego nie wysyła.
export function buildSubmitBody({ token, email, consent = CONSENT_CHOICES.keep, note = "" }) {
  if (!TOKEN_PATTERN.test(token ?? "")) return { error: "invalid_or_expired_link" };
  const checked = validateEmail(email);
  if (!checked.ok) return { error: "invalid_email" };
  const body = { token };
  if (checked.email) body.email = checked.email;
  if (consent === CONSENT_CHOICES.allow) body.contactAllowed = true;
  else if (consent === CONSENT_CHOICES.withdraw) body.contactAllowed = false;
  else if (consent !== CONSENT_CHOICES.keep) return { error: "invalid_request" };
  if (!Object.hasOwn(body, "email") && !Object.hasOwn(body, "contactAllowed")) return { error: "invalid_request" };
  const text = String(note ?? "").trim();
  if (text.length > MAX_NOTE_LENGTH) return { error: "invalid_request" };
  if (text) body.note = text;
  return { body };
}

// Co pokazać po złożeniu wniosku. `requested` pochodzi z odpowiedzi serwera; „kod zlecony”
// nie obiecuje dostarczenia (serwer nie zdradza, czy adres jest zablokowany).
export function submitOutcome(response) {
  const verification = response?.emailVerification === "requested" ? "requested" : "none";
  return {
    verification,
    text: verification === "requested"
      ? "Wniosek został zapisany i czeka na decyzję Rady. Dane zmienią się dopiero po jej zatwierdzeniu. Na podany adres e-mail może dotrzeć wiadomość z kodem — jego wpisanie jest dobrowolne, ale ułatwia Radzie sprawdzenie adresu."
      : "Wniosek został zapisany i czeka na decyzję Rady. Dane zmienią się dopiero po jej zatwierdzeniu.",
  };
}

export function previewSummary(preview) {
  const name = typeof preview?.guardianFirstName === "string" ? preview.guardianFirstName : "";
  const classes = Array.isArray(preview?.classNames) ? preview.classNames.filter((item) => typeof item === "string" && item) : [];
  const parts = [];
  if (name) parts.push(`Opiekun: ${name}`);
  if (classes.length) parts.push(`klasa: ${classes.join(", ")}`);
  return parts.join("; ");
}
