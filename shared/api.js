// Wspólny klient API paneli (issue #99). Bez zależności; każdy panel importuje go przez Vite.
// - 401 → przekierowanie na /login/#next=<bieżąca ścieżka panelu>;
// - 403 mfa_required / mfa_enrollment_required → /login/ (ekran logowania sam wybiera
//   krok kodu albo konfiguracji na podstawie GET /api/auth/state) z tym samym `next`;
// - błąd jako { error: "<kod>" } (napis) → ApiError z polskim komunikatem;
// - brak połączenia → ApiError { network: true, status: 0 };
// - 429/503 z nagłówkiem Retry-After → ApiError.retryAfter (sekundy) i czytelny komunikat;
// - 401 przy niezapisanym formularzu: bez przekierowania (dane zostają na stronie), jedno
//   ostrzeżenie role="alert" z linkiem „zaloguj się w nowej karcie” (także przy wielu
//   równoległych żądaniach); pierwsza udana odpowiedź je usuwa;
// - 403 mfa_stale (krok w górę) NIE przekierowuje: kod trafia do panelu (ApiError.code),
//   który sam pokaże okno z kodem — panel admin może później przejść na ten moduł.
// Nic nie jest zapisywane w localStorage ani sessionStorage. Kontrola dostępu jest
// wyłącznie po stronie serwera — klient tylko prowadzi użytkownika do logowania.

import { errorCode, errorMessage } from "./messages.js";
import { confirmPersonalData } from "./pii-confirm.js";

export { MESSAGES, errorMessage, statusMessage } from "./messages.js";

export const LOGIN_PATH = "/login/";
const CHECK_ORIGIN = "https://rd.invalid";
const MAX_NEXT_LENGTH = 512;

const MAX_RETRY_AFTER_SECONDS = 3600;

// Retry-After: liczba sekund albo data HTTP. Zwraca całkowite sekundy 1…3600 albo null.
export function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  let seconds;
  if (/^\d{1,7}$/.test(text)) seconds = Number(text);
  else {
    const at = Date.parse(text);
    if (!Number.isFinite(at)) return null;
    seconds = Math.ceil((at - now) / 1000);
  }
  if (!Number.isFinite(seconds) || seconds < 1) return null;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

const TRAILING_RETRY_SENTENCE = /\s*Spróbuj ponownie(?: za chwilę| później| za kilka sekund| za kilkanaście minut)?\.\s*$/;

function waitText(seconds) {
  if (seconds < 60) return `${seconds} s`;
  return `${Math.ceil(seconds / 60)} min`;
}

export class ApiError extends Error {
  constructor({ status = 0, code = "", network = false, data = null, messages = null, retryAfter = null } = {}) {
    let text = errorMessage(network ? "" : code, network ? 0 : status, messages);
    const wait = !network && (status === 429 || status === 503) ? retryAfter : null;
    // Tekst ze słownika kończy się często ogólnym „Spróbuj ponownie za chwilę/później.” —
    // przy znanym Retry-After zastępujemy to zdanie konkretnym czasem (bez powtórzenia).
    if (wait) text = `${text.replace(TRAILING_RETRY_SENTENCE, "")} Spróbuj ponownie za ok. ${waitText(wait)}.`;
    super(text);
    this.retryAfter = wait || null;
    this.name = "ApiError";
    this.status = network ? 0 : status;
    this.code = network ? "network" : code;
    this.network = network;
    this.data = data;
    this.authAction = network ? null : authAction(status, code);
  }
}

// Czy to samo żądanie warto ponowić z tym samym kluczem idempotencji.
export function isRetryable(error) {
  return Boolean(error?.network || error?.status === 429 || error?.status >= 500);
}

// Co zrobić z odpowiedzią: "login" (401), "mfa" / "enroll" (403 z bramki MFA) albo null.
export function authAction(status, code) {
  if (status === 401) return "login";
  if (status === 403 && code === "mfa_required") return "mfa";
  if (status === 403 && code === "mfa_enrollment_required") return "enroll";
  return null;
}

// Cel powrotu po zalogowaniu: tylko ścieżka względna tego samego origin
// ("/panel/…"), nigdy "//host", "/\host", adres z protokołem ani /login/ i /api/.
export function safeNextPath(value) {
  if (typeof value !== "string" || !value || value.length > MAX_NEXT_LENGTH) return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  if (/[\u0000-\u001f\u007f\s]/.test(value)) return null;
  let url;
  try { url = new URL(value, CHECK_ORIGIN); } catch { return null; }
  if (url.origin !== CHECK_ORIGIN) return null;
  const path = url.pathname;
  if (path === "/login" || path.startsWith("/login/") || path === "/api" || path.startsWith("/api/")) return null;
  return `${path}${url.search}${url.hash}`;
}

// `reason: "enroll"` (#161): przekierowanie po 403 mfa_enrollment_required. Ekran logowania
// prowadzi wtedy prosto do zapisu MFA z komunikatem, po co (bez tego konto bez czynnika,
// którego rola nie jest na liście MFA_REQUIRED_ROLES, wracałoby w pętli strona → start).
export function loginUrl(next, { reason } = {}) {
  const safe = safeNextPath(next);
  if (!safe) return LOGIN_PATH;
  return `${LOGIN_PATH}#next=${encodeURIComponent(safe)}${reason === "enroll" ? "&reason=enroll" : ""}`;
}

function currentPath(location) {
  return location ? `${location.pathname ?? ""}${location.search ?? ""}${location.hash ?? ""}` : "";
}

function isPlainBody(body) {
  return body !== null && typeof body === "object"
    && !(typeof Blob !== "undefined" && body instanceof Blob)
    && !(typeof FormData !== "undefined" && body instanceof FormData)
    && !(typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams)
    && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body);
}

// Śledzenie niezapisanych formularzy (WCAG 3.3.7): pole zmienione przez użytkownika
// oznacza formularz jako „brudny”; `reset` albo usunięcie formularza ze strony to czyści.
// Ostrożnie: fałszywy alarm daje tylko ostrzeżenie zamiast automatycznego przekierowania.
function domUnsavedTracker(doc) {
  const dirty = new Set();
  if (doc?.addEventListener) {
    const mark = (event) => {
      const form = event?.target?.closest?.("form");
      if (form) dirty.add(form);
    };
    doc.addEventListener("input", mark, true);
    doc.addEventListener("change", mark, true);
    doc.addEventListener("reset", (event) => dirty.delete(event?.target), true);
  }
  return () => {
    for (const form of [...dirty]) if (form.isConnected === false) dirty.delete(form);
    return dirty.size > 0;
  };
}

export const SESSION_EXPIRED_WARNING = "Sesja wygasła, a formularz ma niezapisane zmiany. Nie odświeżaj strony: zaloguj się w nowej karcie, wróć tu i zapisz ponownie.";

// Jedno ostrzeżenie na stronie (role="alert") z linkiem do logowania w nowej karcie.
function domSessionWarning(doc) {
  return (url, message) => {
    if (!doc?.createElement || !doc.body) return;
    const box = doc.createElement("div");
    box.setAttribute("role", "alert");
    box.dataset.apiSessionWarning = "true";
    box.style.cssText = "position:sticky;top:0;z-index:1000;padding:12px 16px;background:#fff;border-bottom:2px solid #b3001b;color:#111";
    const text = doc.createElement("span");
    text.textContent = `${message} `;
    const link = doc.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Zaloguj się w nowej karcie";
    box.append(text, link);
    doc.body.prepend(box);
  };
}

// Usunięcie ostrzeżenia po pierwszej udanej odpowiedzi (sesja znów działa, np. po
// zalogowaniu w nowej karcie) — kolejne wygaśnięcie sesji pokaże je ponownie.
function domClearSessionWarning(doc) {
  return () => {
    for (const box of doc?.querySelectorAll?.("[data-api-session-warning]") ?? []) box.remove();
  };
}

// Klient z wstrzykiwanymi zależnościami (testy). W przeglądarce używaj `api`.
export function createApiClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
  getLocation = () => globalThis.location,
  navigate = (url) => globalThis.location.assign(url),
  // #152: pytanie o potwierdzenie przy 422 possible_personal_data; bez funkcji — brak ponowienia.
  confirmPersonalData = null,
  hasUnsavedChanges = domUnsavedTracker(globalThis.document),
  warnUnsaved = domSessionWarning(globalThis.document),
  clearWarning = domClearSessionWarning(globalThis.document),
} = {}) {
  let redirecting = false;
  // Ostrzeżenie zamiast przekierowania (niezapisany formularz): jedno na stronę, dopóki
  // któreś żądanie nie zakończy się sukcesem.
  let warned = false;

  // Przekierowanie na logowanie po 401 / 403 MFA. Najwyżej raz na stronę, więc
  // równoległe żądania nie powielają przejścia. Zwraca akcję albo null.
  function handleAuthFailure(status, code) {
    const action = authAction(status, errorCode(code));
    if (!action) return null;
    const location = getLocation();
    const path = location?.pathname ?? "";
    if (!redirecting && !(path === "/login" || path.startsWith("/login/"))) {
      redirecting = true;
      const url = loginUrl(currentPath(location), { reason: action === "enroll" ? "enroll" : undefined });
      if (hasUnsavedChanges()) { warned = true; warnUnsaved(url, SESSION_EXPIRED_WARNING); }
      else navigate(url);
    }
    return action;
  }

  // Ciało z potwierdzeniem danych osobowych albo null, gdy ciała nie da się uzupełnić.
  function withPersonalDataConfirmation(body) {
    if (isPlainBody(body)) return { ...body, confirmPersonalData: true };
    if (typeof body === "string") {
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return JSON.stringify({ ...parsed, confirmPersonalData: true });
      } catch { /* nie JSON — bez ponowienia */ }
    }
    return null;
  }

  function request(url, options = {}) {
    return execute(url, options, false);
  }

  async function execute(url, {
    method = "GET",
    body,
    headers = {},
    idempotencyKey,
    messages = null,
    redirect = true,
    binary = false,
    ...init
  } = {}, confirmed) {
    const finalHeaders = { Accept: "application/json", ...headers };
    let payload = body;
    if (body !== undefined) {
      const hasType = Object.keys(finalHeaders).some((name) => name.toLowerCase() === "content-type");
      if (isPlainBody(body)) payload = JSON.stringify(body);
      if (!hasType && (isPlainBody(body) || typeof body === "string")) finalHeaders["Content-Type"] = "application/json";
    }
    if (idempotencyKey) finalHeaders["Idempotency-Key"] = idempotencyKey;

    let response;
    try {
      response = await fetchImpl(url, {
        ...init,
        method,
        credentials: "same-origin",
        headers: finalHeaders,
        ...(payload !== undefined ? { body: payload } : {}),
      });
    } catch {
      throw new ApiError({ network: true, messages });
    }
    if (response.ok && warned) {
      warned = false;
      redirecting = false;
      clearWarning();
    }
    // `binary: true` — pobranie pliku (eksport): sukces zwraca { blob, headers } bez
    // ponownego kodowania bajtów; błędy nadal są JSON-em i idą zwykłą ścieżką.
    if (binary && response.ok) return { blob: await response.blob(), headers: response.headers };
    const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = errorCode(data?.error);
      if (redirect) handleAuthFailure(response.status, code);
      if (code === "possible_personal_data" && !confirmed && confirmPersonalData) {
        const retryBody = withPersonalDataConfirmation(body);
        if (retryBody !== null && await confirmPersonalData({ categories: data?.categories ?? [] })) {
          // To samo żądanie i ten sam klucz idempotencji — serwer nie utworzy drugiego wpisu.
          return execute(url, { method, body: retryBody, headers, idempotencyKey, messages, redirect, ...init }, true);
        }
      }
      const retryAfter = parseRetryAfter(response.headers?.get?.("Retry-After") ?? null);
      throw new ApiError({ status: response.status, code, data, messages, retryAfter });
    }
    return data ?? {};
  }

  return { request, handleAuthFailure };
}

let defaultClient = null;
function client() {
  defaultClient ??= createApiClient({ confirmPersonalData });
  return defaultClient;
}

// Żądanie JSON do API. Zwraca dane odpowiedzi albo rzuca ApiError.
export function api(url, options) {
  return client().request(url, options);
}

// Dla żądań spoza fetch (np. XMLHttpRequest z postępem przesyłania).
export function handleAuthFailure(status, code) {
  return client().handleAuthFailure(status, code);
}
