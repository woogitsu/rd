import {
  ACTION_LABELS,
  GRANT_STATUS_LABELS,
  INVITATION_STATUS_LABELS,
  ROLE_LABELS,
  buildGrantsUrl,
  confirmationText,
  describeAuditEvent,
  errorMessage,
  formatDateTime,
  grantPayload,
  indexClasses,
  invitationLink,
  invitationPayload,
  isOwnLastAdminGrant,
  mfaResetConfirmation,
  passwordResetLink,
  scopeLabel,
} from "./core.js";

const state = { me: null, users: [], grants: [], invitations: [], years: [], classes: new Map(), yearMap: new Map() };
const byId = (id) => document.getElementById(id);
const globalMessage = byId("global-message");

class ApiError extends Error {}

async function api(url, { method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(errorMessage(data.error, response.status));
  return data;
}

function showMessage(text, isError = false) {
  globalMessage.textContent = text;
  globalMessage.classList.toggle("error", isError);
}

function cell(value, className = "") {
  const td = document.createElement("td");
  td.textContent = value ?? "—";
  if (className) td.className = className;
  return td;
}

function statusCell(key, label) {
  const td = document.createElement("td");
  const span = document.createElement("span");
  span.className = `status ${key}`;
  span.textContent = label;
  td.append(span);
  return td;
}

function emptyRow(tbody, columns, text) {
  const tr = document.createElement("tr");
  const td = cell(text, "empty");
  td.colSpan = columns;
  tr.append(td);
  tbody.replaceChildren(tr);
}

function button(label, onClick, { danger = false, disabled = false, title = "" } = {}) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  if (danger) element.className = "danger";
  element.disabled = disabled;
  if (title) element.title = title;
  element.addEventListener("click", onClick);
  return element;
}

function actionsCell(buttons) {
  const td = document.createElement("td");
  const group = document.createElement("div");
  group.className = "row-actions";
  group.append(...buttons);
  td.append(group);
  return td;
}

// Blokada przycisku na czas żądania chroni przed podwójnym kliknięciem;
// serwer i tak traktuje powtórzenie idempotentnie.
async function runAction(element, confirmText, fn) {
  if (confirmText && !window.confirm(confirmText)) return;
  element.disabled = true;
  try {
    await fn();
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    element.disabled = false;
  }
}

function userLabel(userId) {
  const user = state.users.find((item) => item.id === userId);
  return user ? user.email : userId;
}

// --- Słowniki w formularzach ----------------------------------------------

function fillSelect(select, options) {
  const current = select.value;
  select.replaceChildren(...options.map(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  }));
  if (options.some(([value]) => value === current)) select.value = current;
}

function fillDictionaries() {
  const roleOptions = Object.entries(ROLE_LABELS);
  for (const select of document.querySelectorAll("[data-roles]")) {
    fillSelect(select, select.dataset.roles === "all" ? [["", "Wszystkie"], ...roleOptions] : roleOptions);
  }
  for (const select of document.querySelectorAll("[data-years]")) {
    const mode = select.dataset.years;
    const years = mode === "finished" ? state.years.filter((year) => year.finished) : state.years;
    const head = mode === "all" ? [["", "Wszystkie"]] : mode === "none" ? [["", "Bez ograniczenia"]] : [];
    fillSelect(select, [...head, ...years.map((year) => [year.id, `${year.label} (${year.id})`])]);
  }
  for (const select of document.querySelectorAll("[data-classes]")) {
    const head = select.dataset.classes === "all" ? [["", "Wszystkie"]] : [["", "Bez klasy"]];
    const classes = [...state.classes.entries()].map(([id, item]) => [id, `${item.name} — ${item.yearLabel}`]);
    fillSelect(select, [...head, ...classes]);
  }
  const activeUsers = state.users.filter((user) => !user.disabledAt);
  fillSelect(byId("grant-form").elements.userId, activeUsers.map((user) => [user.id, `${user.email} (${user.id})`]));
  fillSelect(byId("grant-filters").elements.userId, [["", "Wszystkie"], ...state.users.map((user) => [user.id, user.email])]);
}

// --- Konta ------------------------------------------------------------------

function renderUsers() {
  const tbody = byId("users-body");
  byId("users-summary").textContent = `${state.users.length} kont. Konta tworzy wyłącznie przyjęcie zaproszenia.`;
  if (!state.users.length) return emptyRow(tbody, 7, "Brak kont.");
  tbody.replaceChildren(...state.users.map((user) => {
    const tr = document.createElement("tr");
    const self = user.id === state.me;
    tr.append(cell(user.email), cell(user.displayName), cell(user.id, "mono"));
    tr.append(user.disabledAt ? statusCell("disabled", "Wyłączone") : statusCell("active", "Aktywne"));
    tr.append(cell(String(user.activeGrants), "num"), cell(String(user.activeSessions), "num"));
    const buttons = [];
    const sessions = button("Wyloguj wszędzie", (event) => runAction(event.currentTarget, confirmationText("revoke-sessions", user.email), async () => {
      const result = await api(`/api/admin/users/${encodeURIComponent(user.id)}/revoke-sessions`, { method: "POST", body: {} });
      showMessage(`Wycofano sesje: ${result.revokedSessions}.`);
      await loadUsers();
    }), { disabled: user.activeSessions === 0 });
    buttons.push(sessions);
    // #224: wydanie resetu hasła — dostępne API, brak było ekranu; niedostępne
    // dla własnego konta i konta wyłączonego (to samo konto trzeba najpierw włączyć).
    buttons.push(button("Wydaj kod resetu hasła", (event) => runAction(event.currentTarget, confirmationText("password-reset", user.email), async () => {
      hideResetToken();
      const result = await api(`/api/admin/users/${encodeURIComponent(user.id)}/password-reset`, { method: "POST", body: {} });
      showResetToken(result.token, result.reset.expiresAt);
      await loadAudit();
    }), {
      disabled: self || Boolean(user.disabledAt),
      title: self ? "Nie można wydać resetu hasła dla własnego konta" : user.disabledAt ? "Konto jest wyłączone" : "",
    }));
    // Reset MFA tylko dla konta z zapisanym (potwierdzonym) czynnikiem — inaczej nie ma czego resetować.
    if (user.mfaEnrolled) {
      buttons.push(button("Zresetuj MFA", (event) => runMfaReset(event.currentTarget, user), {
        danger: true, disabled: self, title: self ? "Nie można zresetować MFA własnego konta" : "",
      }));
    }
    if (user.disabledAt) {
      buttons.push(button("Włącz", (event) => runAction(event.currentTarget, confirmationText("enable", user.email), async () => {
        await api(`/api/admin/users/${encodeURIComponent(user.id)}/enable`, { method: "POST", body: {} });
        showMessage("Konto włączone.");
        await Promise.all([loadUsers(), loadAudit()]);
      })));
    } else {
      buttons.push(button("Wyłącz", (event) => runAction(event.currentTarget, confirmationText("disable", user.email), async () => {
        const result = await api(`/api/admin/users/${encodeURIComponent(user.id)}/disable`, { method: "POST", body: {} });
        showMessage(`Konto wyłączone. Wycofano sesje: ${result.revokedSessions}.`);
        await Promise.all([loadUsers(), loadAudit()]);
      }), { danger: true, disabled: self, title: self ? "Nie można wyłączyć własnego konta" : "" }));
    }
    tr.append(actionsCell(buttons));
    return tr;
  }));
}

async function loadUsers() {
  state.users = (await api("/api/admin/users")).users;
  renderUsers();
  fillDictionaries();
}

// --- Reset hasła i MFA (#224) ------------------------------------------------

function hideResetToken() {
  byId("reset-link").textContent = "";
  byId("reset-token-value").textContent = "";
  byId("reset-token-meta").textContent = "";
  byId("reset-token-box").hidden = true;
}

function showResetToken(token, expiresAt) {
  byId("reset-link").textContent = passwordResetLink(token, window.location.origin);
  byId("reset-token-value").textContent = token;
  byId("reset-token-meta").textContent = `Ważny do ${formatDateTime(expiresAt)}.`;
  byId("copy-reset-link").textContent = "Kopiuj link";
  byId("copy-reset-token").textContent = "Kopiuj kod";
  byId("reset-token-box").hidden = false;
}

byId("hide-reset-token").addEventListener("click", hideResetToken);
byId("copy-reset-link").addEventListener("click", async (event) => {
  try {
    await navigator.clipboard.writeText(byId("reset-link").textContent);
    event.currentTarget.textContent = "Skopiowano";
  } catch {
    showMessage("Nie udało się skopiować. Zaznacz link i skopiuj ręcznie.", true);
  }
});
byId("copy-reset-token").addEventListener("click", async (event) => {
  try {
    await navigator.clipboard.writeText(byId("reset-token-value").textContent);
    event.currentTarget.textContent = "Skopiowano";
  } catch {
    showMessage("Nie udało się skopiować. Zaznacz kod i skopiuj ręcznie.", true);
  }
});

// Reset MFA wymaga wpisania identyfikatora konta (kontrakt API) — chroni przed
// przypadkowym wyłączeniem cudzego czynnika jednym kliknięciem.
async function runMfaReset(element, user) {
  const typed = window.prompt(`Aby zresetować weryfikację dwuetapową konta ${user.email}, wpisz jego identyfikator:\n${user.id}`);
  const check = mfaResetConfirmation(typed, user.id);
  if (check.cancelled) return;
  if (!check.ok) {
    showMessage("Wpisany identyfikator nie zgadza się z kontem. Weryfikacja dwuetapowa nie została zresetowana.", true);
    return;
  }
  element.disabled = true;
  try {
    const result = await api(`/api/admin/users/${encodeURIComponent(user.id)}/mfa-reset`, { method: "POST", body: { confirm: user.id } });
    showMessage(result.changed
      ? "Zresetowano weryfikację dwuetapową. Konto zostało wylogowane i zapisze nowy czynnik po zalogowaniu."
      : "Konto nie miało zapisanego czynnika ani kodów odzyskiwania — nic nie zmieniono.");
    await Promise.all([loadUsers(), loadAudit()]);
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    element.disabled = false;
  }
}

// --- Przydziały ---------------------------------------------------------------

function renderGrants() {
  const tbody = byId("grants-body");
  byId("grants-summary").textContent = `${state.grants.length} przydziałów w widoku.`;
  if (!state.grants.length) return emptyRow(tbody, 7, "Brak przydziałów dla wybranych filtrów.");
  tbody.replaceChildren(...state.grants.map((grant) => {
    const tr = document.createElement("tr");
    tr.append(cell(userLabel(grant.userId)), cell(ROLE_LABELS[grant.role] ?? grant.role));
    tr.append(cell(scopeLabel(grant, state.classes, state.yearMap)));
    tr.append(cell(formatDateTime(grant.grantedAt)), cell(grant.expiresAt ? formatDateTime(grant.expiresAt) : "bezterminowo"));
    tr.append(statusCell(grant.status, GRANT_STATUS_LABELS[grant.status] ?? grant.status));
    if (grant.status === "revoked") {
      tr.append(cell(""));
    } else {
      const lastOwn = isOwnLastAdminGrant(state.grants, state.me, grant.id);
      const subject = `${ROLE_LABELS[grant.role] ?? grant.role} — ${userLabel(grant.userId)}`;
      tr.append(actionsCell([button("Wycofaj", (event) => runAction(event.currentTarget, confirmationText("revoke-grant", subject), async () => {
        await api(`/api/admin/grants/${encodeURIComponent(grant.id)}/revoke`, { method: "POST", body: {} });
        showMessage("Przydział wycofany.");
        await Promise.all([loadGrants(), loadUsers(), loadAudit()]);
      }), { danger: true, disabled: lastOwn, title: lastOwn ? "To Twój ostatni aktywny przydział administratora" : "" })]));
    }
    return tr;
  }));
}

async function loadGrants() {
  const filters = Object.fromEntries(new FormData(byId("grant-filters")));
  state.grants = (await api(buildGrantsUrl(filters))).grants;
  renderGrants();
}

byId("grant-filters").addEventListener("submit", (event) => {
  event.preventDefault();
  loadGrants().catch((error) => showMessage(error.message, true));
});

byId("grant-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = form.querySelector(".form-error");
  const submit = form.querySelector("button[type=submit]");
  errorBox.textContent = "";
  let payload;
  try {
    payload = grantPayload(Object.fromEntries(new FormData(form)));
  } catch (error) {
    errorBox.textContent = error.message;
    return;
  }
  submit.disabled = true;
  try {
    const result = await api("/api/admin/grants", { method: "POST", body: payload });
    showMessage(result.created ? "Rola nadana." : "Identyczny aktywny przydział już istnieje.");
    form.elements.expiresOn.value = "";
    await Promise.all([loadGrants(), loadUsers(), loadAudit()]);
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

// --- Zaproszenia ----------------------------------------------------------------

function renderInvitations() {
  const tbody = byId("invitations-body");
  if (!state.invitations.length) return emptyRow(tbody, 7, "Brak zaproszeń.");
  tbody.replaceChildren(...state.invitations.map((invitation) => {
    const tr = document.createElement("tr");
    tr.append(cell(invitation.email), cell(ROLE_LABELS[invitation.role] ?? invitation.role));
    tr.append(cell(scopeLabel(invitation, state.classes, state.yearMap)));
    tr.append(cell(formatDateTime(invitation.createdAt)), cell(formatDateTime(invitation.expiresAt)));
    tr.append(statusCell(invitation.status, INVITATION_STATUS_LABELS[invitation.status] ?? invitation.status));
    if (invitation.status === "pending") {
      tr.append(actionsCell([button("Wycofaj", (event) => runAction(event.currentTarget, confirmationText("revoke-invitation", invitation.email), async () => {
        await api(`/api/admin/invitations/${encodeURIComponent(invitation.id)}/revoke`, { method: "POST", body: {} });
        showMessage("Zaproszenie wycofane.");
        await Promise.all([loadInvitations(), loadAudit()]);
      }), { danger: true })]));
    } else {
      tr.append(cell(""));
    }
    return tr;
  }));
}

async function loadInvitations() {
  state.invitations = (await api("/api/admin/invitations")).invitations;
  renderInvitations();
}

function hideToken() {
  byId("invite-link").textContent = "";
  byId("token-value").textContent = "";
  byId("token-meta").textContent = "";
  byId("token-box").hidden = true;
}

byId("hide-token").addEventListener("click", hideToken);
byId("copy-link").addEventListener("click", async (event) => {
  const link = byId("invite-link").textContent;
  try {
    await navigator.clipboard.writeText(link);
    event.currentTarget.textContent = "Skopiowano";
  } catch {
    showMessage("Nie udało się skopiować. Zaznacz link i skopiuj ręcznie.", true);
  }
});
byId("copy-token").addEventListener("click", async (event) => {
  const token = byId("token-value").textContent;
  try {
    await navigator.clipboard.writeText(token);
    event.currentTarget.textContent = "Skopiowano";
  } catch {
    showMessage("Nie udało się skopiować. Zaznacz token i skopiuj ręcznie.", true);
  }
});

byId("invitation-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = form.querySelector(".form-error");
  const submit = form.querySelector("button[type=submit]");
  errorBox.textContent = "";
  hideToken();
  let payload;
  try {
    payload = invitationPayload(Object.fromEntries(new FormData(form)));
  } catch (error) {
    errorBox.textContent = error.message;
    return;
  }
  submit.disabled = true;
  try {
    const result = await api("/api/admin/invitations", { method: "POST", body: payload });
    byId("invite-link").textContent = invitationLink(result.token, window.location.origin);
    byId("token-value").textContent = result.token;
    byId("token-meta").textContent = `${ROLE_LABELS[result.invitation.role]} · ${scopeLabel(result.invitation, state.classes, state.yearMap)} · ważne do ${formatDateTime(result.invitation.expiresAt)}`;
    byId("copy-link").textContent = "Kopiuj link";
    byId("copy-token").textContent = "Kopiuj kod";
    byId("token-box").hidden = false;
    form.reset();
    await Promise.all([loadInvitations(), loadAudit()]);
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

// --- Kadencja -------------------------------------------------------------------

byId("term-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = form.querySelector(".form-error");
  const submit = form.querySelector("button[type=submit]");
  errorBox.textContent = "";
  const { schoolYearId, confirm } = Object.fromEntries(new FormData(form));
  if (!schoolYearId) { errorBox.textContent = "Brak zakończonych lat szkolnych."; return; }
  if (confirm.trim() !== schoolYearId) { errorBox.textContent = "Wpisany identyfikator nie zgadza się z wybranym rokiem."; return; }
  if (!window.confirm(`Wygasić wszystkie aktywne przydziały roku ${schoolYearId}?`)) return;
  submit.disabled = true;
  try {
    const result = await api(`/api/admin/school-years/${encodeURIComponent(schoolYearId)}/expire-grants`, { method: "POST", body: { confirm: schoolYearId } });
    showMessage(`Wygaszono przydziały: ${result.expired}.`);
    form.elements.confirm.value = "";
    await Promise.all([loadGrants(), loadUsers(), loadAudit()]);
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

// --- Dziennik -------------------------------------------------------------------

async function loadAudit() {
  const { events } = await api("/api/admin/audit?limit=100");
  const tbody = byId("audit-body");
  if (!events.length) return emptyRow(tbody, 5, "Brak zdarzeń.");
  tbody.replaceChildren(...events.map((item) => {
    const tr = document.createElement("tr");
    const { label, details } = describeAuditEvent(item);
    tr.append(cell(formatDateTime(item.occurredAt)), cell(ACTION_LABELS[item.action] ? label : item.action));
    tr.append(cell(`${item.entityType} ${item.entityId}`, "mono"), cell(details || "—"), cell(item.actorId ?? "system", "mono"));
    return tr;
  }));
}

byId("reload-audit").addEventListener("click", () => loadAudit().catch((error) => showMessage(error.message, true)));

// --- Start ----------------------------------------------------------------------

async function start() {
  try {
    const session = await api("/api/session");
    state.me = session.user?.id ?? null;
    const { schoolYears } = await api("/api/admin/school-years");
    state.years = schoolYears;
    state.classes = indexClasses(schoolYears);
    state.yearMap = new Map(schoolYears.map((year) => [year.id, year]));
    await loadUsers();
    await Promise.all([loadGrants(), loadInvitations(), loadAudit()]);
  } catch (error) {
    showMessage(error.message, true);
  }
}

start();
