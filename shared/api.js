// Wspólny klient API paneli (issue #99). Bez zależności; każdy panel importuje go przez Vite.
// - 401 → przekierowanie na /login/#next=<bieżąca ścieżka panelu>;
// - 403 mfa_required / mfa_enrollment_required → /login/ (ekran logowania sam wybiera
//   krok kodu albo konfiguracji na podstawie GET /api/auth/state) z tym samym `next`;
// - błąd jako { error: "<kod>" } (napis) → ApiError z polskim komunikatem;
// - brak połączenia → ApiError { network: true, status: 0 }.
// Nic nie jest zapisywane w localStorage ani sessionStorage. Kontrola dostępu jest
// wyłącznie po stronie serwera — klient tylko prowadzi użytkownika do logowania.

import { errorCode, errorMessage } from "./messages.js";
import { confirmPersonalData } from "./pii-confirm.js";

export { MESSAGES, errorMessage, statusMessage } from "./messages.js";

export const LOGIN_PATH = "/login/";
const CHECK_ORIGIN = "https://rd.invalid";
const MAX_NEXT_LENGTH = 512;

export class ApiError extends Error {
  constructor({ status = 0, code = "", network = false, data = null, messages = null } = {}) {
    super(errorMessage(network ? "" : code, network ? 0 : status, messages));
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
  return Boolean(error?.network || error?.status >= 500);
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

export function loginUrl(next) {
  const safe = safeNextPath(next);
  return safe ? `${LOGIN_PATH}#next=${encodeURIComponent(safe)}` : LOGIN_PATH;
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

// Klient z wstrzykiwanymi zależnościami (testy). W przeglądarce używaj `api`.
export function createApiClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
  getLocation = () => globalThis.location,
  navigate = (url) => globalThis.location.assign(url),
  // #152: pytanie o potwierdzenie przy 422 possible_personal_data; bez funkcji — brak ponowienia.
  confirmPersonalData = null,
} = {}) {
  let redirecting = false;

  // Przekierowanie na logowanie po 401 / 403 MFA. Najwyżej raz na stronę, więc
  // równoległe żądania nie powielają przejścia. Zwraca akcję albo null.
  function handleAuthFailure(status, code) {
    const action = authAction(status, errorCode(code));
    if (!action) return null;
    const location = getLocation();
    const path = location?.pathname ?? "";
    if (!redirecting && !(path === "/login" || path.startsWith("/login/"))) {
      redirecting = true;
      navigate(loginUrl(currentPath(location)));
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
      throw new ApiError({ status: response.status, code, data, messages });
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
