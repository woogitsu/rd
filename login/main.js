import {
  PANELS,
  canOfferVoluntaryMfaEnrollment,
  clearSensitiveViews,
  enrollIntroText,
  enrollmentConfirmError,
  errorMessage,
  formatSecret,
  isRecoveryFormat,
  isTotpFormat,
  logoutOutcome,
  nextFromFragment,
  nextView,
  normalizeEmailInput,
  normalizeRecoveryCode,
  normalizeTotp,
  parseFragment,
  qrMatrix,
  qrSvgPath,
  shouldShowNoAccessNotice,
  validateEmail,
  validateNewPassword,
} from "./core.js";

const VIEWS = ["login", "mfa", "enroll", "invite", "reset", "change", "start"];
const TITLES = {
  login: "Logowanie",
  mfa: "Weryfikacja dwuetapowa",
  enroll: "Weryfikacja dwuetapowa",
  invite: "Zaproszenie",
  reset: "Nowe hasło",
  change: "Zmiana hasła",
  start: "Panel Rady Rodziców",
};
const byId = (id) => document.getElementById(id);
const globalMessage = byId("global-message");
let lastState = null;
// Ścieżka panelu, z którego przyszło przekierowanie (#99); tylko w pamięci strony.
let returnTo = nextFromFragment(window.location.hash);

class ApiError extends Error {
  constructor(code, status) { super(errorMessage(code, status)); this.code = code; this.status = status; }
}

async function api(url, { method = "GET", body } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("service_unavailable", 503);
  }
  if (response.status === 204) return {};
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error, response.status);
  return data;
}

function say(text) {
  globalMessage.textContent = text ?? "";
}

function showView(name, { focus = true } = {}) {
  for (const view of VIEWS) byId(`view-${view}`).hidden = view !== name;
  document.title = `${TITLES[name]} — Rada Rodziców`;
  byId("page-title").textContent = TITLES[name];
  if (focus) {
    const first = byId(`view-${name}`).querySelector("input:not([type=hidden]):not([hidden]), button.primary");
    (first ?? byId("page-title")).focus();
  }
}

// Błąd formularza: tekst w elemencie role="alert" i aria-invalid na polach.
function formError(form, errorId, message, fields = []) {
  byId(errorId).textContent = message ?? "";
  for (const input of form.querySelectorAll("input")) input.removeAttribute("aria-invalid");
  for (const field of fields) field.setAttribute("aria-invalid", "true");
  if (message && fields[0]) fields[0].focus();
}

// Podwójne kliknięcie: przycisk wyłączony do końca żądania.
async function submitting(form, work) {
  const button = form.querySelector("button[type=submit]");
  if (button.disabled) return;
  button.disabled = true;
  try { await work(); } finally { button.disabled = false; }
}

// `initial`: stan odczytany przy wejściu na stronę. Wtedy nie przekierowujemy od razu,
// żeby rozjazd stanu sesji z odpowiedzią panelu nie dał pętli przekierowań.
async function goNext(state, { initial = false } = {}) {
  lastState = state;
  // Wejście z „#next=…” (initial) przy koncie bez czynnika MFA to odesłanie z panelu
  // kodem mfa_enrollment_required — od razu konfiguracja, nie lista paneli.
  const view = nextView(state, { mfaWantedByPanel: initial && Boolean(returnTo) });
  // Przejście do kolejnego etapu: pola haseł puste, „Pokaż hasło” wyłączone (#197).
  clearSensitiveViews(document);
  if (view === "start" && returnTo && !initial) {
    window.location.replace(returnTo);
    return;
  }
  if (view === "start") await renderStart();
  if (view === "enroll") { resetEnrollment(); renderEnrollIntro(true); }
  showView(view);
}

// #161: tekst i przycisk powrotu zależą od tego, czy widok wymusiła rola
// (nextView → "enroll") czy konto weszło tu dobrowolnie z widoku startowego.
function renderEnrollIntro(forced) {
  byId("enroll-intro-text").textContent = enrollIntroText(forced);
  byId("enroll-back").hidden = forced;
}

async function refreshState() {
  try {
    return await api("/api/auth/state");
  } catch (error) {
    if (error.status === 401) return { authenticated: false };
    throw error;
  }
}

// --- Pokaż hasło --------------------------------------------------------------

for (const toggle of document.querySelectorAll(".toggle-password")) {
  toggle.addEventListener("click", () => {
    const input = byId(toggle.dataset.target);
    const visible = input.type === "password";
    input.type = visible ? "text" : "password";
    toggle.setAttribute("aria-pressed", String(visible));
    toggle.textContent = visible ? "Ukryj hasło" : "Pokaż hasło";
  });
}

// --- 1. Logowanie -------------------------------------------------------------

byId("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const email = byId("login-email");
  const password = byId("login-password");
  const emailError = validateEmail(email.value);
  if (emailError) return formError(form, "login-error", emailError, [email]);
  if (!password.value) return formError(form, "login-error", "Podaj hasło.", [password]);
  return submitting(form, async () => {
    try {
      const result = await api("/api/login", { method: "POST", body: { email: normalizeEmailInput(email.value), password: password.value } });
      password.value = "";
      formError(form, "login-error", "");
      say("");
      await goNext({ authenticated: true, mfaVerified: false, ...result });
    } catch (error) {
      password.value = "";
      formError(form, "login-error", error.message, error.code === "invalid_credentials" ? [password] : []);
    }
  });
});

// --- 2. Kod TOTP lub kod odzyskiwania ------------------------------------------

byId("totp-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const input = byId("totp-code");
  if (!isTotpFormat(input.value)) return formError(form, "totp-error", "Wpisz 6 cyfr z aplikacji.", [input]);
  return submitting(form, async () => {
    try {
      await api("/api/mfa/verify", { method: "POST", body: { code: normalizeTotp(input.value) } });
      input.value = "";
      formError(form, "totp-error", "");
      await goNext(await refreshState());
    } catch (error) {
      input.value = "";
      formError(form, "totp-error", error.message, [input]);
    }
  });
});

byId("show-recovery").addEventListener("click", (event) => {
  const form = byId("recovery-form");
  form.hidden = !form.hidden;
  event.currentTarget.setAttribute("aria-expanded", String(!form.hidden));
  if (!form.hidden) byId("recovery-code").focus();
});

byId("recovery-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const input = byId("recovery-code");
  if (!isRecoveryFormat(input.value)) return formError(form, "recovery-error", "Kod odzyskiwania ma 16 znaków (litery A–Z i cyfry 2–7).", [input]);
  return submitting(form, async () => {
    try {
      await api("/api/mfa/recovery", { method: "POST", body: { code: normalizeRecoveryCode(input.value) } });
      input.value = "";
      formError(form, "recovery-error", "");
      say("Użyto kodu odzyskiwania. Kod nie zadziała ponownie — rozważ ponowną konfigurację aplikacji.");
      await goNext(await refreshState());
    } catch (error) {
      formError(form, "recovery-error", error.message, [input]);
    }
  });
});

// --- 3. Konfiguracja MFA ---------------------------------------------------------

function resetEnrollment() {
  byId("enroll-intro").hidden = false;
  byId("enroll-scan").hidden = true;
  byId("enroll-codes").hidden = true;
  byId("qr-code").replaceChildren();
  byId("manual-key").textContent = "";
  byId("recovery-codes").replaceChildren();
  byId("codes-saved").checked = false;
  byId("codes-done").disabled = true;
}

function renderQr(uri) {
  const { size, d } = qrSvgPath(qrMatrix(uri));
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("width", "232");
  svg.setAttribute("height", "232");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Kod QR konfiguracji aplikacji uwierzytelniającej");
  svg.setAttribute("shape-rendering", "crispEdges");
  const background = document.createElementNS(ns, "rect");
  background.setAttribute("width", String(size));
  background.setAttribute("height", String(size));
  background.setAttribute("fill", "#ffffff");
  const modules = document.createElementNS(ns, "path");
  modules.setAttribute("d", d);
  modules.setAttribute("fill", "#000000");
  svg.append(background, modules);
  byId("qr-code").replaceChildren(svg);
}

byId("enroll-start").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (button.disabled) return;
  button.disabled = true;
  byId("enroll-start-error").textContent = "";
  try {
    const enrollment = await api("/api/mfa/enroll", { method: "POST" });
    renderQr(enrollment.otpauthUri);
    byId("manual-key").textContent = formatSecret(enrollment.secret);
    byId("enroll-intro").hidden = true;
    byId("enroll-scan").hidden = false;
    byId("enroll-code").focus();
  } catch (error) {
    byId("enroll-start-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

byId("enroll-confirm-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const input = byId("enroll-code");
  if (!isTotpFormat(input.value)) return formError(form, "enroll-error", "Wpisz 6 cyfr z aplikacji.", [input]);
  return submitting(form, async () => {
    try {
      const result = await api("/api/mfa/confirm", { method: "POST", body: { code: normalizeTotp(input.value) } });
      input.value = "";
      formError(form, "enroll-error", "");
      // Klucz i kod QR znikają z ekranu, gdy tylko czynnik jest potwierdzony.
      byId("qr-code").replaceChildren();
      byId("manual-key").textContent = "";
      byId("enroll-scan").hidden = true;
      const list = byId("recovery-codes");
      list.replaceChildren(...(result.recoveryCodes ?? []).map((code) => {
        const item = document.createElement("li");
        const text = document.createElement("code");
        text.textContent = code;
        item.append(text);
        return item;
      }));
      byId("enroll-codes").hidden = false;
      byId("codes-title").focus();
    } catch (error) {
      input.value = "";
      const outcome = enrollmentConfirmError(error.code, error.status);
      if (outcome.restart) {
        // Wygasła lub zastąpiona konfiguracja: stary QR znika, wracamy do „Rozpocznij” (#197).
        formError(form, "enroll-error", "");
        resetEnrollment();
        byId("enroll-start-error").textContent = outcome.message;
        byId("enroll-start").focus();
        return;
      }
      formError(form, "enroll-error", outcome.message, [input]);
    }
  });
});

byId("copy-codes").addEventListener("click", async () => {
  const codes = [...byId("recovery-codes").querySelectorAll("code")].map((node) => node.textContent).join("\n");
  try {
    await navigator.clipboard.writeText(codes);
    say("Skopiowano kody odzyskiwania.");
  } catch {
    say("Nie udało się skopiować. Zaznacz kody i skopiuj je ręcznie.");
  }
});

byId("codes-saved").addEventListener("change", (event) => {
  byId("codes-done").disabled = !event.currentTarget.checked;
});

byId("codes-done").addEventListener("click", async () => {
  byId("recovery-codes").replaceChildren();
  say("Weryfikacja dwuetapowa jest włączona.");
  await goNext(await refreshState());
});

// --- 4. Zaproszenie ----------------------------------------------------------------

byId("invite-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const token = byId("invite-token");
  const password = byId("invite-password");
  const repeat = byId("invite-repeat");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token.value.trim())) return formError(form, "invite-error", "Kod zaproszenia ma 43 znaki. Skopiuj go w całości.", [token]);
  // #164: powtórzenie jest zawsze obowiązkowe — bez niego literówka w haśle
  // nowego konta wychodzi na jaw dopiero przy kolejnym logowaniu (blokada,
  // reset przez admina). Serwer i tak sam wymusza zgodność dla nowego konta.
  if (!password.value) return formError(form, "invite-error", "Podaj hasło.", [password]);
  if (!repeat.value) return formError(form, "invite-error", "Powtórz hasło.", [repeat]);
  if (password.value !== repeat.value) return formError(form, "invite-error", "Hasła nie są takie same.", [repeat]);
  return submitting(form, async () => {
    try {
      const displayName = byId("invite-name").value.trim();
      const result = await api("/api/invitations/accept", {
        method: "POST",
        body: {
          token: token.value.trim(), password: password.value, passwordRepeat: repeat.value,
          ...(displayName ? { displayName } : {}),
        },
      });
      password.value = ""; repeat.value = ""; token.value = "";
      formError(form, "invite-error", "");
      say(result.created ? "Konto zostało utworzone." : "Rola została dodana do Twojego konta.");
      await goNext({ authenticated: true, mfaVerified: false, ...result });
    } catch (error) {
      const fields = error.code === "password_mismatch" ? [repeat]
        : error.code?.startsWith("password") || error.code === "invalid_credentials" ? [password] : [token];
      formError(form, "invite-error", error.message, fields);
    }
  });
});

// --- 5. Reset hasła -------------------------------------------------------------------

byId("reset-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const token = byId("reset-token");
  const password = byId("reset-password");
  const repeat = byId("reset-repeat");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token.value.trim())) return formError(form, "reset-error", "Kod resetu ma 43 znaki. Skopiuj go w całości.", [token]);
  const problem = validateNewPassword(password.value, repeat.value);
  if (problem) return formError(form, "reset-error", problem, [password]);
  return submitting(form, async () => {
    try {
      await api("/api/password/reset", { method: "POST", body: { token: token.value.trim(), newPassword: password.value } });
      password.value = ""; repeat.value = ""; token.value = "";
      formError(form, "reset-error", "");
      say("Hasło zostało zmienione. Zaloguj się nowym hasłem.");
      showView("login");
    } catch (error) {
      formError(form, "reset-error", error.message, error.code?.startsWith("password") ? [password] : [token]);
    }
  });
});

// --- 6. Zmiana hasła --------------------------------------------------------------------

byId("change-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const current = byId("change-current");
  const password = byId("change-password");
  const repeat = byId("change-repeat");
  if (!current.value) return formError(form, "change-error", "Podaj obecne hasło.", [current]);
  const problem = validateNewPassword(password.value, repeat.value);
  if (problem) return formError(form, "change-error", problem, [password]);
  return submitting(form, async () => {
    try {
      const result = await api("/api/password/change", { method: "POST", body: { currentPassword: current.value, newPassword: password.value } });
      current.value = ""; password.value = ""; repeat.value = "";
      formError(form, "change-error", "");
      say(result.revokedSessions ? `Hasło zmienione. Wylogowano inne sesje: ${result.revokedSessions}.` : "Hasło zmienione.");
      await goNext(await refreshState());
    } catch (error) {
      formError(form, "change-error", error.message, error.code === "invalid_current_password" ? [current] : [password]);
    }
  });
});

byId("change-cancel").addEventListener("click", async () => goNext(lastState ?? await refreshState()));
byId("open-change").addEventListener("click", () => showView("change"));

// #161: włączenie MFA z własnej inicjatywy (dowolna rola, konto bez czynnika).
byId("enroll-voluntary").addEventListener("click", () => {
  clearSensitiveViews(document);
  resetEnrollment();
  renderEnrollIntro(false);
  showView("enroll");
});
byId("enroll-back").addEventListener("click", async () => goNext(lastState ?? await refreshState()));

// --- 7. Start i wylogowanie ---------------------------------------------------------------

async function renderStart() {
  // #176: rola bez żadnej aktywnej trasy (np. principal, decyzja D-09 w toku) nie
  // dostaje listy 10 paneli kończących się odmową — serwer (hasActiveRole,
  // GET /api/access) rozstrzyga, czy jest co pokazać.
  let access = null;
  try { access = await api("/api/access"); } catch { access = null; }
  const noAccess = shouldShowNoAccessNotice(access);
  byId("no-access-notice").hidden = !noAccess;
  byId("start-hint").hidden = noAccess;
  const list = byId("panel-list");
  if (noAccess) {
    list.replaceChildren();
  } else {
    const back = returnTo ? [{ href: returnTo, label: "Powrót do poprzedniej strony", hint: returnTo }] : [];
    list.replaceChildren(...[...back, ...PANELS].map((panel) => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = panel.href;
      link.textContent = panel.label;
      const hint = document.createElement("span");
      hint.textContent = panel.hint;
      item.append(link, hint);
      return item;
    }));
  }
  byId("enroll-voluntary").hidden = !canOfferVoluntaryMfaEnrollment(lastState);
}

// Wylogowanie: dane wrażliwe znikają z DOM zawsze; „Wylogowano” tylko po 204/401 (#197).
for (const button of document.querySelectorAll(".logout")) {
  button.addEventListener("click", async () => {
    clearSensitiveViews(document);
    let status = 204;
    try { await api("/api/logout", { method: "POST" }); } catch (error) { status = error.status; }
    const outcome = logoutOutcome(status);
    say(outcome.message);
    if (outcome.loggedOut) {
      lastState = null;
      returnTo = null;
      resetEnrollment();
      showView("login");
    }
  });
}

byId("logout-all").addEventListener("click", async () => {
  clearSensitiveViews(document);
  try {
    const result = await api("/api/sessions/revoke-all", { method: "POST" });
    say(result.scope === "current"
      ? "Wylogowano to urządzenie. Inne urządzenia można wylogować po potwierdzeniu kodu z aplikacji."
      : `Wylogowano ze wszystkich urządzeń (sesje: ${result.revoked}).`);
  } catch (error) {
    const outcome = logoutOutcome(error.status);
    say(outcome.loggedOut ? outcome.message : error.message);
    if (!outcome.loggedOut) return;
  }
  lastState = null;
  returnTo = null;
  showView("login");
});

// --- Start ---------------------------------------------------------------------------------

async function route() {
  const fragment = parseFragment(window.location.hash);
  returnTo = nextFromFragment(window.location.hash);
  if (fragment.view === "invite" || fragment.view === "reset") {
    // Token z części „#…” przenosimy do pola i usuwamy z paska adresu i historii.
    if (fragment.token) byId(`${fragment.view}-token`).value = fragment.token;
    if (window.location.hash.length > 1) history.replaceState(null, "", window.location.pathname);
    showView(fragment.view);
    return;
  }
  try {
    const state = await refreshState();
    if (fragment.view === "change" && state.authenticated !== false && nextView(state) === "start") {
      lastState = state;
      showView("change");
      return;
    }
    await goNext(state, { initial: true });
  } catch (error) {
    say(error.message);
    showView("login");
  }
}

for (const button of document.querySelectorAll(".back-to-login")) {
  button.addEventListener("click", () => {
    clearSensitiveViews(document);
    showView("login");
  });
}

// Token z nowego „#…” wstawia route() dopiero po wyczyszczeniu pól.
window.addEventListener("hashchange", () => {
  clearSensitiveViews(document, { keepTokens: false });
  resetEnrollment();
  route();
});
window.addEventListener("pagehide", () => {
  clearSensitiveViews(document);
  resetEnrollment();
});
// Powrót z pamięci podręcznej przeglądarki (bfcache): widok odtwarzamy ze stanu sesji.
window.addEventListener("pageshow", (event) => { if (event.persisted) route(); });
route();
