import {
  ACTION_LABELS,
  AUDIT_DOMAIN_OPTIONS,
  auditListPath,
  accountName,
  entityTypeLabel,
  GRANT_STATUS_LABELS,
  INVITATION_STATUS_LABELS,
  ROLE_LABELS,
  buildGrantsUrl,
  classNamesPayload,
  confirmationDialog,
  describeAuditEvent,
  ERROR_MESSAGES,
  formatDateTime,
  grantPayload,
  indexClasses,
  invitationLink,
  invitationPayload,
  isOwnLastAdminGrant,
  mfaResetConfirmation,
  passwordResetLink,
  roleNeedsPendingDecisionWarning,
  schoolYearPayload,
  scopeLabel,
} from "./core.js";
import {
  batchRowError, batchSummary, canApplyBatch, coverageState, coverageSummary, invitationsCount, newBatchKey, printCardModel, tokenListText,
} from "./onboarding.js";
import { api as apiRequest } from "../shared/api.js";
import { confirmAction, promptAction } from "../shared/confirm-dialog.js";
import { mountShell } from "../shared/shell.js";
import { shortId } from "../shared/short-id.js";
import { formatSchoolYear } from "../shared/school-year.js";
import "../shared/shell.css";

mountShell();

const state = {
  me: null, users: [], grants: [], invitations: [], auditEvents: [], auditDomain: "",
  usersCursor: null, grantsCursor: null, invitationsCursor: null, auditCursor: null,
  years: [], classes: new Map(), yearMap: new Map() };
const byId = (id) => document.getElementById(id);
const globalMessage = byId("global-message");

// Wspólny klient (#99): polskie komunikaty, 401/403 MFA → /login/ z powrotem.
const api = (url, { method = "GET", body, idempotencyKey } = {}) => apiRequest(url, { method, body, idempotencyKey, messages: ERROR_MESSAGES });

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
// serwer i tak traktuje powtórzenie idempotentnie. Okno potwierdzenia (issue #136)
// zastępuje natywne okno przeglądarki; akcje tutaj są nieodwracalne inaczej niż
// nowym zapisem, więc fokus startuje na „Anuluj” (destructive: true).
// `confirmOptions` to wynik confirmationDialog(...) z admin/core.js (tytuł, lista
// skutków, nazwa akcji na przycisku).
async function runAction(element, confirmOptions, fn) {
  if (confirmOptions) {
    const confirmed = await confirmAction(confirmOptions);
    if (!confirmed) return;
  }
  element.disabled = true;
  try {
    await withStepUp(fn);
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    element.disabled = false;
  }
}

// Krok w górę MFA (#150, #224): reset hasła i MFA wymagają kodu potwierdzonego
// od niedawna. Serwer odpowiada 403 mfa_stale; panel prosi o kod z aplikacji
// (POST /api/mfa/verify) i ponawia operację dokładnie raz. Anulowanie okna kończy
// operację bez żadnej zmiany; kod nie jest nigdzie zapisywany.
async function withStepUp(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error?.code !== "mfa_stale") throw error;
  }
  const code = await promptAction({
    title: "Potwierdź kodem z aplikacji",
    effects: [
      "Ta operacja wymaga świeżego potwierdzenia weryfikacji dwuetapowej.",
      "Wpisz aktualny 6-cyfrowy kod. Jeśli właśnie użyto go do logowania, poczekaj na kolejny.",
    ],
    confirmLabel: "Potwierdź kodem",
    input: { label: "Kod z aplikacji", inputMode: "numeric", autocomplete: "one-time-code" },
  });
  if (code === null) throw new Error("Operacja wstrzymana: brak potwierdzenia kodem. Nic nie zmieniono.");
  await api("/api/mfa/verify", { method: "POST", body: { code: code.replace(/\s+/g, "") } });
  return fn();
}

const RECOVERY_REQUEST_MESSAGE = "Konto ma rolę chronioną: zapisano wniosek, nic jeszcze nie zmieniono. Kod resetu lub wyłączenie MFA wymaga zatwierdzenia przez innego administratora.";

// Kontekst okna potwierdzenia (#136): liczby z listy kont w chwili otwarcia okna.
function userContext(user) {
  return { account: user.email, activeSessions: user.activeSessions, activeGrants: user.activeGrants };
}

function invitationContext(invitation) {
  return {
    account: invitation.email,
    role: ROLE_LABELS[invitation.role] ?? invitation.role,
    scope: scopeLabel(invitation, state.classes, state.yearMap),
  };
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
    const years = mode === "finished" ? state.years.filter((year) => year.finished)
      : mode === "open" ? state.years.filter((year) => !year.finished) : state.years;
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
  const more = state.usersCursor ? " Lista jest niepełna — użyj „Pokaż więcej”." : "";
  byId("users-summary").textContent = `${state.users.length} kont. Konta tworzy wyłącznie przyjęcie zaproszenia.${more}`;
  if (!state.users.length) return emptyRow(tbody, 7, "Brak kont.");
  tbody.replaceChildren(...state.users.map((user) => {
    const tr = document.createElement("tr");
    const self = user.id === state.me;
    tr.append(cell(user.email), cell(user.displayName), cell(user.id, "mono"));
    tr.append(user.disabledAt ? statusCell("disabled", "Wyłączone") : statusCell("active", "Aktywne"));
    tr.append(cell(String(user.activeGrants), "num"), cell(String(user.activeSessions), "num"));
    const buttons = [];
    const sessions = button("Wyloguj wszędzie", (event) => runAction(event.currentTarget, confirmationDialog("revoke-sessions", userContext(user)), async () => {
      const result = await api(`/api/admin/users/${encodeURIComponent(user.id)}/revoke-sessions`, { method: "POST", body: {} });
      showMessage(`Wycofano sesje: ${result.revokedSessions}.`);
      await loadUsers();
    }), { disabled: user.activeSessions === 0 });
    buttons.push(sessions);
    // #224: wydanie resetu hasła — dostępne API, brak było ekranu; niedostępne
    // dla własnego konta i konta wyłączonego (to samo konto trzeba najpierw włączyć).
    buttons.push(button("Wydaj kod resetu hasła", (event) => runAction(event.currentTarget, confirmationDialog("password-reset", userContext(user)), async () => {
      hideResetToken();
      const result = await api(`/api/admin/users/${encodeURIComponent(user.id)}/password-reset`, { method: "POST", body: {} });
      // #146: konto z rolą chronioną — serwer (202) zapisał tylko wniosek, bez tokenu.
      if (!result.token) {
        showMessage(RECOVERY_REQUEST_MESSAGE);
        await loadAudit();
        return;
      }
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
      buttons.push(button("Włącz", (event) => runAction(event.currentTarget, confirmationDialog("enable", userContext(user)), async () => {
        await api(`/api/admin/users/${encodeURIComponent(user.id)}/enable`, { method: "POST", body: {} });
        showMessage("Konto włączone.");
        await Promise.all([loadUsers(), loadAudit()]);
      })));
    } else {
      buttons.push(button("Wyłącz", (event) => runAction(event.currentTarget, confirmationDialog("disable", userContext(user)), async () => {
        const result = await api(`/api/admin/users/${encodeURIComponent(user.id)}/disable`, { method: "POST", body: {} });
        showMessage(`Konto wyłączone. Wycofano sesje: ${result.revokedSessions}.`);
        await Promise.all([loadUsers(), loadAudit()]);
      }), { danger: true, disabled: self, title: self ? "Nie można wyłączyć własnego konta" : "" }));
    }
    tr.append(actionsCell(buttons));
    return tr;
  }));
}

// #159: listy mają kursor (`nextCursor`); przycisk „Pokaż więcej” dociąga kolejną stronę
// zamiast pokazywać obciętą listę bez informacji.
function withCursor(url, cursor) {
  if (!cursor) return url;
  return `${url}${url.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`;
}

function toggleMore(id, cursor) {
  byId(id).hidden = !cursor;
}

async function loadUsers({ append = false } = {}) {
  const result = await api(withCursor("/api/admin/users", append ? state.usersCursor : null));
  state.users = append ? [...state.users, ...result.users] : result.users;
  state.usersCursor = result.nextCursor ?? null;
  toggleMore("users-more", state.usersCursor);
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
  const typed = await promptAction({
    title: "Zresetować weryfikację dwuetapową?",
    effects: [
      `Konto ${user.email}: czynnik i kody odzyskiwania zostaną wyłączone, a sesje wycofane.`,
      "Konto zapisze nowy czynnik po następnym logowaniu.",
    ],
    confirmLabel: "Zresetuj MFA",
    destructive: true,
    input: { label: `Aby potwierdzić, wpisz identyfikator konta: ${user.id}`, expected: user.id },
  });
  const check = mfaResetConfirmation(typed, user.id);
  if (check.cancelled) return;
  if (!check.ok) {
    showMessage("Wpisany identyfikator nie zgadza się z kontem. Weryfikacja dwuetapowa nie została zresetowana.", true);
    return;
  }
  element.disabled = true;
  try {
    const result = await withStepUp(() => api(`/api/admin/users/${encodeURIComponent(user.id)}/mfa-reset`, { method: "POST", body: { confirm: user.id } }));
    // #146: konto z rolą chronioną — serwer (202) zapisał tylko wniosek; MFA nie zmieniono.
    showMessage(result.request
      ? RECOVERY_REQUEST_MESSAGE
      : result.changed
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
      const grantContext = {
        account: userLabel(grant.userId),
        role: ROLE_LABELS[grant.role] ?? grant.role,
        scope: scopeLabel(grant, state.classes, state.yearMap),
      };
      tr.append(actionsCell([button("Wycofaj", (event) => runAction(event.currentTarget, confirmationDialog("revoke-grant", grantContext), async () => {
        await api(`/api/admin/grants/${encodeURIComponent(grant.id)}/revoke`, { method: "POST", body: {} });
        showMessage("Przydział wycofany.");
        await Promise.all([loadGrants(), loadUsers(), loadAudit()]);
      }), { danger: true, disabled: lastOwn, title: lastOwn ? "To Twój ostatni aktywny przydział administratora" : "" })]));
    }
    return tr;
  }));
}

async function loadGrants({ append = false } = {}) {
  const filters = Object.fromEntries(new FormData(byId("grant-filters")));
  const result = await api(withCursor(buildGrantsUrl(filters), append ? state.grantsCursor : null));
  state.grants = append ? [...state.grants, ...result.grants] : result.grants;
  state.grantsCursor = result.nextCursor ?? null;
  toggleMore("grants-more", state.grantsCursor);
  renderGrants();
}

// #176: ostrzeżenie przed rolą bez żadnej trasy dziś (decyzja D-09). Front-end
// nie blokuje wysyłki — serwer i tak odrzuca 422 role_pending_decision — to
// tylko wcześniejsza, czytelna informacja zamiast błędu po kliknięciu.
function wirePendingRoleWarning(formId, warningId) {
  const form = byId(formId);
  const warning = byId(warningId);
  const update = () => { warning.hidden = !roleNeedsPendingDecisionWarning(form.elements.role.value); };
  form.elements.role.addEventListener("change", update);
  update();
}
wirePendingRoleWarning("grant-form", "grant-pending-warning");
wirePendingRoleWarning("invitation-form", "invitation-pending-warning");

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
      tr.append(actionsCell([
        // „Wyślij ponownie” (#108): serwer wycofuje stary kod i wydaje nowy; nic nie wysyła e-mailem.
        button("Wyślij ponownie", (event) => runAction(event.currentTarget, confirmationDialog("reissue-invitation", invitationContext(invitation)), async () => {
          hideToken();
          const result = await api(`/api/admin/invitations/${encodeURIComponent(invitation.id)}/reissue`, { method: "POST", body: {} });
          showToken(result);
          showMessage("Wydano nowy link; poprzedni jest nieważny.");
          await Promise.all([loadInvitations(), loadAudit(), loadCoverage()]);
        })),
        button("Wycofaj", (event) => runAction(event.currentTarget, confirmationDialog("revoke-invitation", invitationContext(invitation)), async () => {
          await api(`/api/admin/invitations/${encodeURIComponent(invitation.id)}/revoke`, { method: "POST", body: {} });
          showMessage("Zaproszenie wycofane.");
          await Promise.all([loadInvitations(), loadAudit(), loadCoverage()]);
        }), { danger: true }),
      ]));
    } else {
      tr.append(cell(""));
    }
    return tr;
  }));
}

async function loadInvitations({ append = false } = {}) {
  const result = await api(withCursor("/api/admin/invitations", append ? state.invitationsCursor : null));
  state.invitations = append ? [...state.invitations, ...result.invitations] : result.invitations;
  state.invitationsCursor = result.nextCursor ?? null;
  toggleMore("invitations-more", state.invitationsCursor);
  renderInvitations();
}

function hideToken() {
  byId("invite-link").textContent = "";
  byId("token-value").textContent = "";
  byId("token-meta").textContent = "";
  byId("token-box").hidden = true;
}

function showToken(result) {
  byId("invite-link").textContent = invitationLink(result.token, window.location.origin);
  byId("token-value").textContent = result.token;
  byId("token-meta").textContent = `${ROLE_LABELS[result.invitation.role]} · ${scopeLabel(result.invitation, state.classes, state.yearMap)} · ważne do ${formatDateTime(result.invitation.expiresAt)}`;
  byId("copy-link").textContent = "Kopiuj link";
  byId("copy-token").textContent = "Kopiuj kod";
  byId("token-box").hidden = false;
  byId("token-box").scrollIntoView({ block: "nearest" });
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
    showToken(result);
    form.reset();
    await Promise.all([loadInvitations(), loadAudit(), loadCoverage()]);
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

// --- Obsada klas i zaproszenia zbiorcze (#108) -----------------------------------

function yearLabel(yearId) {
  const year = state.yearMap.get(yearId);
  return year ? year.label : formatSchoolYear(yearId);
}

function defaultYearId() {
  return (state.years.find((year) => !year.finished) ?? state.years[0])?.id ?? "";
}

async function loadCoverage() {
  const select = byId("coverage-year");
  const schoolYearId = select.value;
  const tbody = byId("coverage-body");
  if (!schoolYearId) {
    byId("coverage-summary").textContent = "Brak lat szkolnych.";
    return emptyRow(tbody, 6, "Brak danych.");
  }
  const result = await api(`/api/admin/class-coverage?schoolYearId=${encodeURIComponent(schoolYearId)}`);
  byId("coverage-summary").textContent = `${formatSchoolYear(yearLabel(schoolYearId))}: ${coverageSummary(result.classes)}`;
  if (!result.classes.length) return emptyRow(tbody, 6, "Rok nie ma klas.");
  tbody.replaceChildren(...result.classes.map((row) => {
    const tr = document.createElement("tr");
    const { key, label } = coverageState(row);
    tr.append(cell(row.name), statusCell(key, label));
    tr.append(cell(String(row.activeRepresentativeCount), "num"), cell(String(row.pendingInvitationCount), "num"));
    tr.append(cell(row.nextInvitationExpiresAt ? formatDateTime(row.nextInvitationExpiresAt) : "—"));
    tr.append(cell(row.lastRepresentativeLoginOn ?? "—"));
    return tr;
  }));
}

byId("coverage-year").addEventListener("change", () => loadCoverage().catch((error) => showMessage(error.message, true)));
byId("reload-coverage").addEventListener("click", () => loadCoverage().catch((error) => showMessage(error.message, true)));

// Stan partii: podgląd (z kluczem partii) i wynik z tokenami — wyłącznie w pamięci.
const batch = { preview: null, body: null, key: null, result: null };

function batchBody(form) {
  const data = Object.fromEntries(new FormData(form));
  const ttl = String(data.ttlHours ?? "").trim();
  if (ttl && !/^\d+$/.test(ttl)) throw new Error(ERROR_MESSAGES.invalid_ttl);
  return { schoolYearId: data.schoolYearId, text: String(data.text ?? ""), ...(ttl ? { ttlHours: Number(ttl) } : {}) };
}

function resetBatchPreview() {
  batch.preview = null;
  batch.body = null;
  batch.key = null;
  byId("batch-preview").hidden = true;
  byId("batch-preview-body").replaceChildren();
  byId("batch-apply").disabled = true;
}

function hideBatchResult() {
  batch.result = null;
  byId("batch-result-body").replaceChildren();
  byId("batch-result-summary").textContent = "";
  byId("print-sheets").replaceChildren();
  byId("batch-result").hidden = true;
}

function renderBatchPreview(preview) {
  byId("batch-preview-summary").textContent = batchSummary(preview);
  byId("batch-preview-body").replaceChildren(...preview.rows.map((row) => {
    const tr = document.createElement("tr");
    tr.append(cell(String(row.row), "num"), cell(row.className ?? row.classRef ?? "—"), cell(row.email ?? "—"));
    tr.append(cell(row.error ? "—" : row.existingAccount ? "istniejące (przyjęcie obecnym hasłem)" : "nowe"));
    tr.append(cell(row.error ? batchRowError(row) : "gotowe", row.error ? "row-error" : ""));
    return tr;
  }));
  byId("batch-apply").disabled = !canApplyBatch(preview);
  byId("batch-preview").hidden = false;
}

function renderBatchResult(result) {
  batch.result = result;
  const withTokens = result.invitations.filter((item) => item.token);
  byId("batch-result-summary").textContent = result.replayed
    ? `Ta partia była już zapisana (${invitationsCount(result.invitations.length)}). Linki pokazano wtedy jeden raz — jeśli zginęły, użyj „Wyślij ponownie” przy zaproszeniu.`
    : `Utworzono ${invitationsCount(withTokens.length)} (${formatSchoolYear(yearLabel(result.schoolYearId))}).`;
  byId("batch-result-body").replaceChildren(...result.invitations.map((item) => {
    const tr = document.createElement("tr");
    tr.append(cell(item.row ? String(item.row) : "—", "num"), cell(item.className ?? item.classId), cell(item.email));
    const link = cell(item.token ? invitationLink(item.token, window.location.origin) : "(pokazany wcześniej)", item.token ? "mono" : "");
    tr.append(link, cell(formatDateTime(item.expiresAt)));
    return tr;
  }));
  byId("batch-copy").disabled = !withTokens.length;
  byId("batch-print").disabled = !withTokens.length;
  byId("batch-copy").textContent = "Kopiuj listę";
  byId("batch-result").hidden = false;
  byId("batch-result").scrollIntoView({ block: "nearest" });
}

byId("batch-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = byId("batch-error");
  const submit = form.querySelector("button[type=submit]");
  errorBox.textContent = "";
  resetBatchPreview();
  let body;
  try {
    body = batchBody(form);
  } catch (error) {
    errorBox.textContent = error.message;
    return;
  }
  submit.disabled = true;
  try {
    const preview = await withStepUp(() => api("/api/admin/invitation-batches/preview", { method: "POST", body }));
    batch.preview = preview;
    batch.body = body;
    batch.key = newBatchKey();
    renderBatchPreview(preview);
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

// Zmiana tekstu, roku lub ważności po podglądzie unieważnia podgląd (nowy klucz przy następnym).
byId("batch-form").addEventListener("input", resetBatchPreview);

byId("batch-apply").addEventListener("click", async (event) => {
  const element = event.currentTarget;
  if (!canApplyBatch(batch.preview)) return;
  const confirmed = await confirmAction({
    title: "Utworzyć zaproszenia?",
    effects: [
      `Powstaną osobne zaproszenia dla przedstawicieli klas: ${invitationsCount(batch.preview.counts.valid)}.`,
      "Linki zobaczysz jeden raz. Panel nie wysyła e-maili — przekażesz je sam.",
    ],
    confirmLabel: "Utwórz zaproszenia",
  });
  if (!confirmed) return;
  element.disabled = true;
  byId("batch-error").textContent = "";
  try {
    const result = await withStepUp(() => api("/api/admin/invitation-batches/apply", {
      method: "POST", body: { ...batch.body, planDigest: batch.preview.planDigest }, idempotencyKey: batch.key,
    }));
    resetBatchPreview();
    byId("batch-form").reset();
    byId("batch-form").elements.schoolYearId.value = result.schoolYearId ?? defaultYearId();
    renderBatchResult(result);
    showMessage(result.replayed ? "Partia była już zapisana — nie utworzono nowych zaproszeń." : "Zaproszenia utworzone.");
    await Promise.all([loadInvitations(), loadAudit(), loadCoverage()]);
  } catch (error) {
    byId("batch-error").textContent = error.message;
    element.disabled = !canApplyBatch(batch.preview);
  }
});

byId("batch-hide").addEventListener("click", hideBatchResult);
byId("batch-copy").addEventListener("click", async (event) => {
  const text = tokenListText(batch.result?.invitations, window.location.origin, formatDateTime);
  try {
    await navigator.clipboard.writeText(text);
    event.currentTarget.textContent = "Skopiowano";
  } catch {
    showMessage("Nie udało się skopiować. Zaznacz linki w tabeli i skopiuj ręcznie.", true);
  }
});

function printCardElement(model) {
  const card = document.createElement("section");
  card.className = "print-card";
  const title = document.createElement("h2");
  title.textContent = model.title;
  const meta = document.createElement("p");
  meta.textContent = [model.schoolYear, `Adres konta: ${model.email}`].filter(Boolean).join(" · ");
  const link = document.createElement("code");
  link.textContent = model.link;
  const expires = document.createElement("p");
  expires.textContent = model.expires;
  const stepsTitle = document.createElement("h3");
  stepsTitle.textContent = "Pierwsze logowanie";
  const steps = document.createElement("ol");
  steps.append(...model.steps.map((text) => Object.assign(document.createElement("li"), { textContent: text })));
  const rulesTitle = document.createElement("h3");
  rulesTitle.textContent = "Zasady";
  const rules = document.createElement("ul");
  rules.append(...model.rules.map((text) => Object.assign(document.createElement("li"), { textContent: text })));
  const draft = document.createElement("p");
  draft.className = "draft";
  draft.textContent = model.draftNotice;
  card.append(title, meta, link, expires, stepsTitle, steps, rulesTitle, rules, draft);
  return card;
}

function clearPrintSheets() {
  document.body.classList.remove("printing");
  byId("print-sheets").replaceChildren();
}

byId("batch-print").addEventListener("click", () => {
  const invitations = (batch.result?.invitations ?? []).filter((item) => item.token);
  if (!invitations.length) return;
  const schoolYearLabel = yearLabel(batch.result.schoolYearId);
  byId("print-sheets").replaceChildren(...invitations.map((item) => printCardElement(printCardModel(item, {
    origin: window.location.origin, schoolYearLabel, formatDateTime,
  }))));
  document.body.classList.add("printing");
  window.print();
});
window.addEventListener("afterprint", clearPrintSheets);
// Wspólny komputer: przy opuszczeniu strony linki znikają z DOM.
window.addEventListener("pagehide", () => { hideBatchResult(); hideToken(); clearPrintSheets(); });

// --- Lata szkolne i klasy (#207; trasy #78, wyłącznie admin) ----------------------

async function loadYears() {
  const { schoolYears } = await api("/api/admin/school-years");
  state.years = schoolYears;
  state.classes = indexClasses(schoolYears);
  state.yearMap = new Map(schoolYears.map((year) => [year.id, year]));
  renderYears();
}

function renderYears() {
  const tbody = byId("years-body");
  byId("years-summary").textContent = `${state.years.length} ${state.years.length === 1 ? "rok" : "lat"} szkolnych w systemie.`;
  if (!state.years.length) return emptyRow(tbody, 5, "Brak lat szkolnych. Utwórz pierwszy rok poniżej.");
  tbody.replaceChildren(...state.years.map((year) => {
    const tr = document.createElement("tr");
    const classes = (year.classes ?? []).map((item) => item.name).join(", ");
    tr.append(cell(`${year.label}${year.finished ? " (zakończony)" : ""}`), cell(year.id), cell(year.startsOn), cell(year.endsOn), cell(classes || "Brak klas"));
    return tr;
  }));
}

async function afterYearsChange() {
  await loadYears();
  fillDictionaries();
  await loadAudit();
}

byId("year-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = form.querySelector(".form-error");
  const submit = form.querySelector("button[type=submit]");
  errorBox.textContent = "";
  let payload;
  try {
    payload = schoolYearPayload(Object.fromEntries(new FormData(form)));
  } catch (error) {
    errorBox.textContent = error.message;
    return;
  }
  const confirmed = await confirmAction({
    title: "Utworzyć rok szkolny?",
    effects: [
      `${payload.label} (${payload.id}), od ${payload.startsOn} do ${payload.endsOn}.`,
      "Identyfikatora i dat nie da się później zmienić w panelu; rok nie ma jeszcze klas ani przydziałów ról.",
    ],
    confirmLabel: "Utwórz rok",
  });
  if (!confirmed) return;
  submit.disabled = true;
  try {
    await api("/api/admin/school-years", { method: "POST", body: payload });
    showMessage(`Utworzono rok szkolny ${payload.id}.`);
    form.reset();
    await afterYearsChange();
    byId("classes-form").elements.schoolYearId.value = payload.id;
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

byId("classes-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = form.querySelector(".form-error");
  const submit = form.querySelector("button[type=submit]");
  errorBox.textContent = "";
  const { schoolYearId, names } = Object.fromEntries(new FormData(form));
  let payload;
  try {
    if (!schoolYearId) throw new Error("Wybierz rok szkolny.");
    payload = classNamesPayload(names);
  } catch (error) {
    errorBox.textContent = error.message;
    return;
  }
  const confirmed = await confirmAction({
    title: "Dodać klasy?",
    effects: [
      `Rok ${state.yearMap.get(schoolYearId)?.label ?? formatSchoolYear(schoolYearId)}: ${payload.names.join(", ")}.`,
      "Klas nie można usuwać ani zmieniać ich nazwy; pomyłkę poprawia nowa klasa i przeniesienie uczniów.",
    ],
    confirmLabel: "Dodaj klasy",
  });
  if (!confirmed) return;
  submit.disabled = true;
  try {
    const result = await api(`/api/admin/school-years/${encodeURIComponent(schoolYearId)}/classes`, { method: "POST", body: payload });
    showMessage(`Dodano klasy: ${result.classes.length}.`);
    form.elements.names.value = "";
    await afterYearsChange();
    form.elements.schoolYearId.value = schoolYearId;
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
  const confirmed = await confirmAction({
    title: `Wygasić kadencję roku ${formatSchoolYear(yearLabel(schoolYearId))}?`,
    effects: [
      `Wygaszone zostaną wszystkie aktywne przydziały ról roku ${formatSchoolYear(yearLabel(schoolYearId))}.`,
      "Osoby z przydziałem tylko tego roku stracą dostęp do paneli od następnego żądania.",
      "Cofnięcie jest widoczne w dzienniku zdarzeń; przywrócenie wymaga nowego przydziału.",
    ],
    confirmLabel: "Wygaś przydziały",
    destructive: true,
  });
  if (!confirmed) return;
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

async function loadAudit({ append = false } = {}) {
  const result = await api(withCursor(auditListPath(state.auditDomain), append ? state.auditCursor : null));
  state.auditEvents = append ? [...state.auditEvents, ...result.events] : result.events;
  state.auditCursor = result.nextCursor ?? null;
  toggleMore("audit-more", state.auditCursor);
  const events = state.auditEvents;
  const tbody = byId("audit-body");
  if (!events.length) return emptyRow(tbody, 5, "Brak zdarzeń.");
  tbody.replaceChildren(...events.map((item) => {
    const tr = document.createElement("tr");
    const { label, details } = describeAuditEvent(item, state.users);
    tr.append(cell(formatDateTime(item.occurredAt)), cell(ACTION_LABELS[item.action] ? label : item.action));
    const object = cell(`${entityTypeLabel(item.entityType)} ${shortId(item.entityId)}`);
    object.title = `${item.entityType} ${item.entityId}`;
    const actor = cell(accountName(item.actorId, state.users));
    if (item.actorId) actor.title = item.actorId;
    tr.append(object, cell(details || "—"), actor);
    return tr;
  }));
}

for (const [id, load] of [["users-more", loadUsers], ["grants-more", loadGrants], ["invitations-more", loadInvitations], ["audit-more", loadAudit]]) {
  byId(id).addEventListener("click", () => load({ append: true }).catch((error) => showMessage(error.message, true)));
}
byId("reload-audit").addEventListener("click", () => loadAudit().catch((error) => showMessage(error.message, true)));
// #181: filtr domeny dziennika; serwer sprawdza prawo odczytu każdej domeny.
{
  const select = byId("audit-domain");
  select.replaceChildren(...AUDIT_DOMAIN_OPTIONS.map(({ value, label }) => new Option(label, value)));
  select.addEventListener("change", () => {
    state.auditDomain = select.value;
    loadAudit().catch((error) => showMessage(error.message, true));
  });
}

// --- Start ----------------------------------------------------------------------

async function start() {
  try {
    const session = await api("/api/session");
    state.me = session.user?.id ?? null;
    await loadYears();
    await loadUsers();
    byId("coverage-year").value = defaultYearId();
    byId("batch-form").elements.schoolYearId.value = defaultYearId();
    await Promise.all([loadGrants(), loadInvitations(), loadAudit(), loadCoverage()]);
  } catch (error) {
    showMessage(error.message, true);
  }
}

start();
