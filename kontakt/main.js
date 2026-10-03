// Publiczna strona „Aktualizacja kontaktu” (#140): wniosek rodzica (jednorazowy token z części
// `#token=…` adresu) i wpisanie 8-cyfrowego kodu weryfikacyjnego nowego adresu. Logika w core.js;
// tu tylko DOM. Wszystkie żądania idą przez wspólny klient (shared/api.js) — bez przekierowań na
// logowanie (rodzic nie ma konta) i bez powłoki panelu. Token jest tylko w pamięci strony.
import { applySchoolName } from "../shared/school.js";
import { createApiClient } from "../shared/api.js";
import { confirmPersonalData, PERSONAL_DATA_HINT } from "../shared/pii-confirm.js";
import {
  KONTAKT_MESSAGES, SUBMIT_URL, VERIFY_SUCCESS_TEXT, VERIFY_URL,
  buildSubmitBody, buildVerifyBody, previewSummary, previewUrl, submitOutcome, tokenFromFragment, verifyFailureText,
} from "./core.js";

applySchoolName();

const byId = (id) => document.getElementById(id);
const VIEWS = ["invalid", "form", "done", "code"];

// Bez ostrzeżenia o wygasłej sesji i bez śledzenia niezapisanych formularzy: to strona anonimowa.
const client = createApiClient({
  confirmPersonalData,
  hasUnsavedChanges: () => false,
  warnUnsaved: () => {},
  clearWarning: () => {},
});
const call = (url, options = {}) => client.request(url, { ...options, messages: KONTAKT_MESSAGES, redirect: false });

let token = tokenFromFragment(window.location.hash);

function show(names, focusId = null) {
  for (const view of VIEWS) byId(`view-${view}`).hidden = !names.includes(view);
  if (focusId) byId(focusId).focus();
}

// Przycisk wyłączony do końca żądania (podwójne kliknięcie). Serwer jest i tak jednorazowy.
async function submitting(form, work) {
  const button = form.querySelector("button[type=submit]");
  if (button.disabled) return;
  button.disabled = true;
  try { await work(); } finally { button.disabled = false; }
}

function setError(id, message, fields = []) {
  byId(id).textContent = message ?? "";
  for (const field of document.querySelectorAll(`[aria-describedby~="${id}"]`)) field.removeAttribute("aria-invalid");
  for (const field of fields) field.setAttribute("aria-invalid", "true");
  if (message && fields[0]) fields[0].focus();
}

async function load() {
  byId("update-note-hint").textContent = PERSONAL_DATA_HINT;
  if (!token) {
    show(["invalid"]);
    return;
  }
  try {
    const preview = await call(previewUrl(token));
    byId("form-summary").textContent = previewSummary(preview);
    show(["form"]);
  } catch (error) {
    // Link zły, wygasły albo już użyty (np. przez tę samą osobę przed chwilą): jedna treść,
    // a pole kodu zostaje dostępne — kod z wiadomości działa z tym samym tokenem.
    byId("invalid-text").textContent = error.message;
    show(["invalid", "code"]);
  }
}

byId("update-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  submitting(form, async () => {
    setError("update-error", "");
    const email = byId("update-email");
    const built = buildSubmitBody({
      token,
      email: email.value,
      consent: new FormData(form).get("consent"),
      note: byId("update-note").value,
    });
    if (built.error) {
      setError("update-error", KONTAKT_MESSAGES[built.error], built.error === "invalid_email" ? [email] : []);
      return;
    }
    try {
      const response = await call(SUBMIT_URL, { method: "POST", body: built.body });
      const outcome = submitOutcome(response);
      byId("done-text").textContent = outcome.text;
      // Pole kodu tylko po odpowiedzi `requested`; adres nie jest wyświetlany ponownie.
      show(outcome.verification === "requested" ? ["done", "code"] : ["done"], "done-title");
    } catch (error) {
      if (error.code === "link_used") {
        byId("invalid-text").textContent = error.message;
        show(["invalid", "code"]);
        return;
      }
      setError("update-error", error.message, error.code === "invalid_email" ? [email] : []);
    }
  });
});

byId("code-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  submitting(form, async () => {
    const input = byId("code-input");
    setError("code-error", "");
    byId("code-success").textContent = "";
    const body = buildVerifyBody(token, input.value);
    // Ta sama treść dla każdej porażki: zły format, odmowa serwera, limit żądań, brak sieci.
    const fail = () => setError("code-error", verifyFailureText(), [input]);
    if (!body) { fail(); return; }
    try {
      await call(VERIFY_URL, { method: "POST", body });
      input.value = "";
      byId("code-success").textContent = VERIFY_SUCCESS_TEXT;
    } catch {
      fail();
    }
  });
});

window.addEventListener("hashchange", () => {
  token = tokenFromFragment(window.location.hash);
  for (const id of ["update-error", "code-error", "code-success"]) byId(id).textContent = "";
  load();
});

load();
