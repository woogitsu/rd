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
  userOptionLabel,
  grantPayload,
  grantRequestDialog,
  filterUsers,
  grantRequestRow,
  grantRequestsPath,
  canLoadMoreRequests,
  mergeRequestPages,
  indexClasses,
  invitationLink,
  invitationPayload,
  isOwnLastAdminGrant,
  mfaResetConfirmation,
  passwordResetLink,
  rejectRequestPayload,
  roleNeedsPendingDecisionWarning,
  schoolYearPayload,
  scopeLabel,
  usersSummary,
} from "./core.js";
import {
  batchRowError, batchSummary, canApplyBatch, coverageState, coverageSummary, invitationsCount, newBatchKey, printCardModel, schoolYearsCount, tokenListText,
} from "./onboarding.js";
import {
  attentionStudents, canApplyPromotion, MAP_FINAL, MAP_SKIP, missingRepresentativeNote, newPromotionKey, promotionBody,
  promotionConfirmation, promotionResultMessage, promotionRows, promotionSummary,
} from "./promotion.js";
import {
  FILTER_KIND_OPTIONS, FILTER_STATUS_OPTIONS, KIND_LABELS, STATUS_LABELS as DR_STATUS_LABELS, SUBJECT_LABELS,
  canExport, createBody as dataRequestBody, dataRequestsPath, dueState, exportBlocker, exportConfirmation, exportFileName,
  listSummary as dataRequestsSummary, newRequestKey, nextStatuses, omittedNote, statusBody as dataRequestStatusBody,
  statusConfirmation, subjectOf,
} from "./data-requests.js";
import {
  HISTORY_PATH, REASON_LABELS, canExecute, executeBlocker, executeBody, executeConfirmation, historyRows, historySummary,
  planRows, previewBody, previewSummary, resultMessage, retainedNote,
} from "./anonymization.js";
import { api as apiRequest } from "../shared/api.js";
import { buildEffectsHtml, confirmAction, promptAction } from "../shared/confirm-dialog.js";
import { mountShell } from "../shared/shell.js";
import { shortId } from "../shared/short-id.js";
import { formatSchoolYear } from "../shared/school-year.js";
import { formatDateOrTimestamp } from "../shared/zoned-time.js";
import "../shared/shell.css";

mountShell();

const state = {
  me: null, meEmail: "", grantRequests: [], users: [], grants: [], invitations: [], auditEvents: [], auditDomain: "",
  grantRequestsCursor: null, grantRequestsCursorStatus: null, grantRequestsBusy: false,
  usersCursor: null, grantsCursor: null, invitationsCursor: null, auditCursor: null,
  years: [], classes: new Map(), yearMap: new Map() };
const byId = (id) => document.getElementById(id);
const globalMessage = byId("global-message");

// Wspólny klient (#99): polskie komunikaty, 401/403 MFA → /login/ z powrotem.
const api = (url, { method = "GET", body, idempotencyKey, binary, withMeta } = {}) => apiRequest(url, { method, body, idempotencyKey, binary, withMeta, messages: ERROR_MESSAGES });

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

// #146: rola chroniona (administrator, zarząd, skarbnik) przy drugim administratorze.
const GRANT_REQUEST_MESSAGE = "Rola zarządu, skarbnika albo administratora: zapisano wniosek, nic jeszcze nie nadano. Nadanie (albo link zaproszenia) wymaga zatwierdzenia przez innego administratora.";
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
  fillSelect(byId("grant-form").elements.userId, activeUsers.map((user) => [user.id, userOptionLabel(user)]));
  fillSelect(byId("grant-filters").elements.userId, [["", "Wszystkie"], ...state.users.map((user) => [user.id, user.email])]);
}

// --- Konta ------------------------------------------------------------------

function renderUsers() {
  const tbody = byId("users-body");
  const filters = Object.fromEntries(new FormData(byId("user-filters")));
  const users = filterUsers(state.users, filters);
  const filtered = Boolean(String(filters.q ?? "").trim() || filters.state);
  byId("users-summary").textContent = usersSummary(users.length, state.users.length, Boolean(state.usersCursor), filtered);
  if (!state.users.length) return emptyRow(tbody, 7, "Brak kont.");
  if (!users.length) return emptyRow(tbody, 7, "Brak kont pasujących do filtra.");
  tbody.replaceChildren(...users.map((user) => {
    const tr = document.createElement("tr");
    const self = user.id === state.me;
    // Skrót konta (przegląd demo 5); pełny identyfikator w podpowiedzi komórki.
    const idCell = cell(shortId(user.id), "mono");
    idCell.title = user.id;
    tr.append(cell(user.email), cell(user.displayName), idCell);
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

// --- Wnioski o nadanie roli chronionej (#146) ----------------------------------

// Link zaproszenia z zatwierdzonego wniosku: wyłącznie w pamięci strony (DOM),
// jeden raz — „Zamknij” i opuszczenie strony (pagehide) go usuwają; serwer nie
// pokaże go ponownie (lista wniosków nie zawiera tokenów).
function hideRequestToken() {
  byId("request-link").textContent = "";
  byId("request-token-meta").textContent = "";
  byId("request-token-box").hidden = true;
}

function showRequestToken(result) {
  byId("request-link").textContent = invitationLink(result.token, window.location.origin);
  byId("request-token-meta").textContent = `${result.invitation.email} · ${ROLE_LABELS[result.invitation.role] ?? result.invitation.role} · ${scopeLabel(result.invitation, state.classes, state.yearMap)} · ważne do ${formatDateTime(result.invitation.expiresAt)}`;
  byId("copy-request-link").textContent = "Kopiuj link";
  byId("request-token-box").hidden = false;
  byId("request-token-box").scrollIntoView({ block: "nearest" });
}

byId("hide-request-token").addEventListener("click", hideRequestToken);
window.addEventListener("pagehide", hideRequestToken);
byId("copy-request-link").addEventListener("click", async (event) => {
  try {
    await navigator.clipboard.writeText(byId("request-link").textContent);
    event.currentTarget.textContent = "Skopiowano";
  } catch {
    showMessage("Nie udało się skopiować. Zaznacz link i skopiuj ręcznie.", true);
  }
});

function requestRowContext() {
  return { me: { id: state.me, email: state.meEmail }, users: state.users, classes: state.classes, years: state.yearMap, now: new Date() };
}

// Po zatwierdzeniu lub odrzuceniu (także nieudanym, np. 409 — ktoś inny był
// szybszy) lista wraca ze stanem z serwera.
async function afterRequestDecision() {
  await Promise.all([loadGrantRequests(), loadGrants(), loadUsers(), loadInvitations(), loadAudit(), loadCoverage()]);
}

// Zatwierdzenie albo odrzucenie; po odpowiedzi (także błędzie innym niż
// `mfa_stale`, po którym withStepUp prosi o kod i ponawia) lista się odświeża.
async function decideRequest(requestId, decision, body = {}) {
  try {
    const result = await api(`/api/admin/grant-requests/${encodeURIComponent(requestId)}/${decision}`, { method: "POST", body });
    await afterRequestDecision().catch(() => {});
    return result;
  } catch (error) {
    if (error?.code !== "mfa_stale") await afterRequestDecision().catch(() => {});
    throw error;
  }
}

function renderGrantRequests() {
  const tbody = byId("grant-requests-body");
  const status = byId("grant-request-filters").elements.status.value;
  const pending = state.grantRequests.filter((request) => request.status === "pending").length;
  byId("grant-requests-summary").textContent = status === "pending"
    ? `Oczekujące wnioski: ${pending}.`
    : `${state.grantRequests.length} wniosków w widoku.`;
  // #159: serwer zwraca stronę i `nextCursor`; „Pokaż więcej” dociąga starsze wnioski.
  if (state.grantRequestsCursor) {
    byId("grant-requests-summary").textContent += " Lista jest niepełna — użyj „Pokaż więcej”.";
  }
  if (!state.grantRequests.length) return emptyRow(tbody, 7, status === "pending" ? "Brak oczekujących wniosków." : "Brak wniosków dla wybranego statusu.");
  const context = requestRowContext();
  tbody.replaceChildren(...state.grantRequests.map((request) => {
    const row = grantRequestRow(request, context);
    const tr = document.createElement("tr");
    tr.dataset.requestId = request.id;
    tr.append(cell(row.requester), cell(row.target), cell(row.role), cell(row.scope));
    const age = cell(row.age);
    age.title = formatDateTime(request.createdAt);
    tr.append(age, statusCell(row.status, row.statusLabel));
    const buttons = [];
    if (row.canApprove) {
      buttons.push(button("Zatwierdź", (event) => runAction(event.currentTarget, grantRequestDialog("approve", request, row), async () => {
        hideRequestToken();
        const result = await decideRequest(request.id, "approve");
        if (result.token) {
          showRequestToken(result);
          showMessage("Wniosek zatwierdzony: zaproszenie wystawione. Link jest widoczny tylko teraz.");
        } else {
          showMessage("Wniosek zatwierdzony: rola nadana.");
        }
      })));
    }
    if (row.canReject) {
      buttons.push(button(row.rejectLabel, (event) => openRejectDialog(event.currentTarget, request, row), { danger: true }));
    }
    const actions = actionsCell(buttons);
    if (row.rejectReason) {
      const reason = document.createElement("p");
      reason.className = "hint";
      reason.textContent = row.rejectReason;
      actions.append(reason);
    }
    if (row.note) {
      const note = document.createElement("p");
      note.className = "hint";
      note.textContent = row.note;
      actions.append(note);
    }
    tr.append(actions);
    return tr;
  }));
}

// Okno „Odrzuć”/„Wycofaj wniosek” (0159) z opcjonalnym powodem. Błędy powodu
// (400 invalid_reason, 422 bramki danych osobowych, także anulowane
// potwierdzenie telefonu) zostawiają okno otwarte z treścią do poprawy —
// wniosek pozostaje oczekujący. Podwójne kliknięcie „Odrzuć wniosek”: jedno żądanie.
const rejectDialog = byId("reject-request-dialog");
const rejectForm = byId("reject-request-form");
const rejectConfirm = rejectForm.querySelector('[data-role="confirm"]');
const REASON_ERRORS = new Set(["invalid_reason", "personal_data_forbidden", "possible_personal_data"]);
let rejectTarget = null;
let rejectSubmitting = false;

function openRejectDialog(invoker, request, row) {
  const options = grantRequestDialog("reject", request, row);
  rejectTarget = { invoker, request, row };
  rejectForm.reset();
  byId("reject-request-title").textContent = options.title;
  byId("reject-request-effects").innerHTML = buildEffectsHtml(options.effects);
  byId("reject-request-error").textContent = "";
  rejectConfirm.textContent = options.confirmLabel;
  rejectConfirm.disabled = false;
  rejectDialog.showModal();
  // Akcja destrukcyjna: fokus startuje na „Anuluj” (jak shared/confirm-dialog.js).
  rejectForm.querySelector('[data-role="cancel"]').focus();
}

rejectForm.querySelector('[data-role="cancel"]').addEventListener("click", () => rejectDialog.close());
rejectDialog.addEventListener("close", () => {
  const invoker = rejectTarget?.invoker;
  rejectTarget = null;
  rejectForm.reset(); // powód nie zostaje w DOM po zamknięciu
  if (invoker?.isConnected) invoker.focus();
});
rejectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!rejectTarget || rejectSubmitting) return;
  if (!rejectForm.reportValidity()) return;
  const { request, row } = rejectTarget;
  rejectSubmitting = true;
  rejectConfirm.disabled = true;
  byId("reject-request-error").textContent = "";
  try {
    await withStepUp(() => decideRequest(request.id, "reject", rejectRequestPayload(rejectForm.elements.reason.value)));
    rejectDialog.close();
    showMessage(row.rejectLabel === "Wycofaj wniosek" ? "Wniosek wycofany. Rola nie została nadana." : "Wniosek odrzucony. Rola nie została nadana.");
  } catch (error) {
    if (REASON_ERRORS.has(error?.code)) {
      byId("reject-request-error").textContent = error.message;
      rejectConfirm.disabled = false;
    } else {
      rejectDialog.close();
      showMessage(error.message, true);
    }
  } finally {
    rejectSubmitting = false;
  }
});

async function loadGrantRequests({ append = false } = {}) {
  const status = byId("grant-request-filters").elements.status.value;
  if (append && !canLoadMoreRequests({
    cursor: state.grantRequestsCursor, status, cursorStatus: state.grantRequestsCursorStatus, busy: state.grantRequestsBusy,
  })) return;
  const more = byId("grant-requests-more");
  const cursor = append ? state.grantRequestsCursor : null;
  state.grantRequestsBusy = true;
  more.disabled = true;
  try {
    const result = await api(grantRequestsPath(status, cursor));
    // Filtr zmieniony w trakcie pobierania: wynik tej odpowiedzi jest nieaktualny.
    if (byId("grant-request-filters").elements.status.value !== status) return;
    const page = result.requests ?? [];
    state.grantRequests = append ? mergeRequestPages(state.grantRequests, page) : page;
    state.grantRequestsCursor = result.nextCursor ?? null;
    state.grantRequestsCursorStatus = status;
    more.hidden = !state.grantRequestsCursor;
    renderGrantRequests();
  } finally {
    state.grantRequestsBusy = false;
    more.disabled = false;
  }
}

byId("grant-request-filters").addEventListener("submit", (event) => {
  event.preventDefault();
  resetGrantRequestsPaging();
  loadGrantRequests().catch((error) => showMessage(error.message, true));
});
byId("grant-request-filters").elements.status.addEventListener("change", resetGrantRequestsPaging);
byId("reload-grant-requests").addEventListener("click", () => { resetGrantRequestsPaging(); loadGrantRequests().catch((error) => showMessage(error.message, true)); });
byId("grant-requests-more").addEventListener("click", () => loadGrantRequests({ append: true }).catch((error) => showMessage(error.message, true)));

// Zmiana filtra statusu kasuje kursor i przycisk; stary kursor nie pasuje do nowego filtra.
function resetGrantRequestsPaging() {
  state.grantRequestsCursor = null;
  state.grantRequestsCursorStatus = null;
  byId("grant-requests-more").hidden = true;
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

byId("user-filters").addEventListener("input", renderUsers);
byId("user-filters").addEventListener("submit", (event) => event.preventDefault());
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
    if (result.request) showMessage(GRANT_REQUEST_MESSAGE);
    else showMessage(result.created ? "Rola nadana." : "Identyczny aktywny przydział już istnieje.");
    form.elements.expiresOn.value = "";
    await Promise.all([loadGrantRequests(), loadGrants(), loadUsers(), loadAudit()]);
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
          if (result.request) {
            showMessage(GRANT_REQUEST_MESSAGE);
          } else {
            showToken(result);
            showMessage("Wydano nowy link; poprzedni jest nieważny.");
          }
          await Promise.all([loadGrantRequests(), loadInvitations(), loadAudit(), loadCoverage()]);
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
    if (result.request) showMessage(GRANT_REQUEST_MESSAGE);
    else showToken(result);
    form.reset();
    await Promise.all([loadGrantRequests(), loadInvitations(), loadAudit(), loadCoverage()]);
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
    tr.append(cell(formatDateOrTimestamp(row.lastRepresentativeLoginOn, "Europe/Brussels") ?? "—"));
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
  renderPromoYears();
}

function renderYears() {
  const tbody = byId("years-body");
  byId("years-summary").textContent = `${schoolYearsCount(state.years.length)} w systemie.`;
  if (!state.years.length) return emptyRow(tbody, 5, "Brak lat szkolnych. Utwórz pierwszy rok poniżej.");
  tbody.replaceChildren(...state.years.map((year) => {
    const tr = document.createElement("tr");
    const classes = (year.classes ?? []).map((item) => item.name).join(", ");
    tr.append(cell(`${year.label}${year.finished ? " (zakończony)" : ""}`), cell(year.id), cell(formatDateTime(year.startsOn)), cell(formatDateTime(year.endsOn)), cell(classes || "Brak klas"));
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

// --- Nowy rok: promocja uczniów (#78; trasy src/pg/promotions.js, wyłącznie admin) ---

// Podgląd i klucz zatwierdzenia żyją tylko w pamięci; zmiana formularza unieważnia podgląd.
const promo = { preview: null, body: null, key: null };

function resetPromoPreview() {
  promo.preview = null;
  promo.body = null;
  promo.key = null;
  byId("promo-preview").hidden = true;
  byId("promo-preview-body").replaceChildren();
  byId("promo-apply").disabled = true;
}

function renderPromoYears() {
  const options = state.years.map((year) => [year.id, `${year.label} (${year.id})`]);
  const from = byId("promo-from");
  const to = byId("promo-to");
  fillSelect(from, options);
  fillSelect(to, options);
  // Lata są od najnowszego: domyślnie z poprzedniego roku do najnowszego.
  if (state.years.length > 1 && from.value === to.value) from.value = state.years[1].id;
  renderPromoMap();
}

// Tabela mapy: dla każdej klasy roku źródłowego wybór klasy docelowej; domyślnie „nie przenoś”.
function renderPromoMap() {
  const from = state.yearMap.get(byId("promo-from").value);
  const to = state.yearMap.get(byId("promo-to").value);
  const tbody = byId("promo-map-body");
  resetPromoPreview();
  if (!from?.classes?.length) return emptyRow(tbody, 2, "Rok źródłowy nie ma klas.");
  tbody.replaceChildren(...from.classes.map((klass) => {
    const tr = document.createElement("tr");
    const select = document.createElement("select");
    select.dataset.fromClass = klass.id;
    select.setAttribute("aria-label", `Klasa docelowa dla klasy ${klass.name}`);
    fillSelect(select, [[MAP_SKIP, "Nie przenoś"], [MAP_FINAL, "Klasa końcowa (bez przypisania)"], ...(to?.classes ?? []).map((item) => [item.id, item.name])]);
    const td = document.createElement("td");
    td.append(select);
    tr.append(cell(klass.name), td);
    return tr;
  }));
}

function promoFormBody(form) {
  const mapping = {};
  for (const select of byId("promo-map-body").querySelectorAll("select[data-from-class]")) mapping[select.dataset.fromClass] = select.value;
  return promotionBody({
    fromSchoolYearId: form.elements.fromSchoolYearId.value, toSchoolYearId: form.elements.toSchoolYearId.value,
    mapping, exclusionsText: form.elements.exclusions.value,
  });
}

function renderPromoPreview(plan) {
  byId("promo-preview-summary").textContent = promotionSummary(plan);
  byId("promo-preview-body").replaceChildren(...promotionRows(plan).map((row) => {
    const tr = document.createElement("tr");
    tr.append(cell(row.fromName), cell(row.toName));
    for (const key of ["total", "promote", "graduating", "unmapped", "excluded", "conflict", "withdrawn"]) tr.append(cell(String(row[key]), "num"));
    return tr;
  }));
  const names = new Map((plan.classes ?? []).map((row) => [row.fromClassId, row.fromName]));
  const attention = attentionStudents(plan, names);
  byId("promo-attention").hidden = !attention.length;
  byId("promo-attention-body").replaceChildren(...attention.map((item) => {
    const tr = document.createElement("tr");
    tr.append(cell(item.studentId, "mono"), cell(item.fromName), cell(item.status));
    return tr;
  }));
  byId("promo-representatives").textContent = missingRepresentativeNote(plan);
  byId("promo-apply").disabled = !canApplyPromotion(plan);
  byId("promo-preview").hidden = false;
}

byId("promo-from").addEventListener("change", renderPromoMap);
byId("promo-to").addEventListener("change", renderPromoMap);
byId("promo-map-body").addEventListener("change", resetPromoPreview);
byId("promo-exclusions").addEventListener("input", resetPromoPreview);

byId("promo-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = byId("promo-error");
  const submit = form.querySelector("button[type=submit]");
  errorBox.textContent = "";
  resetPromoPreview();
  let body;
  try {
    body = promoFormBody(form);
  } catch (error) {
    errorBox.textContent = error.message;
    return;
  }
  submit.disabled = true;
  try {
    const plan = await withStepUp(() => api("/api/admin/promotions/preview", { method: "POST", body }));
    promo.preview = plan;
    promo.body = body;
    promo.key = newPromotionKey();
    renderPromoPreview(plan);
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

byId("promo-apply").addEventListener("click", async (event) => {
  const element = event.currentTarget;
  if (!canApplyPromotion(promo.preview)) return;
  const labels = { from: yearLabel(promo.body.fromSchoolYearId), to: yearLabel(promo.body.toSchoolYearId) };
  const confirmed = await confirmAction(promotionConfirmation(promo.preview, labels));
  if (!confirmed) return;
  element.disabled = true; // podwójne kliknięcie; klucz i tak jest jeden na podgląd
  const errorBox = byId("promo-error");
  errorBox.textContent = "";
  try {
    const result = await withStepUp(() => api("/api/admin/promotions/apply", {
      method: "POST", body: { ...promo.body, planDigest: promo.preview.planDigest }, idempotencyKey: promo.key,
    }));
    showMessage(promotionResultMessage(result));
    resetPromoPreview();
    await loadAudit();
  } catch (error) {
    errorBox.textContent = error.message;
    // Błąd sieci: ten sam podgląd i klucz można ponowić. Inny błąd (np. plan_stale): nowy podgląd.
    if (error?.network) element.disabled = !canApplyPromotion(promo.preview);
    else resetPromoPreview();
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

// --- Żądania osób (RODO, #100; trasy GET/POST /api/admin/data-requests, wyłącznie admin) ---
// Eksport zawiera dane osobowe: plik trafia tylko do pobrania (Blob w pamięci karty,
// zwalniany zaraz po kliknięciu); nic nie jest logowane, zapisywane w pamięci przeglądarki ani wyświetlane.

const dr = { requests: [], cursor: null, status: "", kind: "", createKey: null, createSignature: "", busy: false, selected: null };

function drToday() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Brussels" });
}

function renderDataRequests() {
  byId("dr-summary").textContent = dataRequestsSummary(dr.requests.length, Boolean(dr.cursor));
  const tbody = byId("dr-body");
  if (!dr.requests.length) return emptyRow(tbody, 7, "Brak żądań w tym widoku.");
  const today = drToday();
  tbody.replaceChildren(...dr.requests.map((item) => {
    const tr = document.createElement("tr");
    const subject = subjectOf(item);
    const due = cell(item.dueOn ? formatDateOrTimestamp(item.dueOn, "Europe/Brussels") ?? "—" : "—");
    if (dueState(item, today) === "overdue") due.append(" (po terminie)");
    const subjectCell = cell(subject.type ? `${SUBJECT_LABELS[subject.type]} ${shortId(subject.id)}` : "—");
    if (subject.id) subjectCell.title = subject.id;
    const idCell = cell(KIND_LABELS[item.kind] ?? item.kind);
    idCell.title = item.id;
    tr.append(idCell, subjectCell, cell(formatDateOrTimestamp(item.receivedOn, "Europe/Brussels") ?? "—"), due,
      statusCell(item.status, DR_STATUS_LABELS[item.status] ?? item.status), cell(item.decisionNoteRef));
    const blocker = exportBlocker(item);
    const buttons = [];
    if (nextStatuses(item).length) buttons.push(button("Zmień stan", () => openDataRequestStatus(item)));
    for (const format of ["json", "csv"]) {
      buttons.push(button(`Eksport ${format.toUpperCase()}`, (event) => exportDataRequest(event.currentTarget, item, format), {
        disabled: dr.busy || !canExport(item), title: blocker,
      }));
    }
    tr.append(actionsCell(buttons));
    return tr;
  }));
}

async function loadDataRequests({ append = false } = {}) {
  const result = await api(dataRequestsPath({ status: dr.status, kind: dr.kind, cursor: append ? dr.cursor : "" }));
  dr.requests = append ? [...dr.requests, ...result.requests] : result.requests;
  dr.cursor = result.nextCursor ?? null;
  toggleMore("dr-more", dr.cursor);
  renderDataRequests();
}

function setDataRequestsBusy(busy) {
  dr.busy = busy;
  for (const element of byId("dr-body").querySelectorAll("button")) {
    if (busy) element.disabled = true;
  }
  if (!busy) renderDataRequests();
}

function closeDataRequestStatus() {
  dr.selected = null;
  byId("dr-status-form").hidden = true;
  byId("dr-status-error").textContent = "";
}

function openDataRequestStatus(item) {
  dr.selected = item;
  const form = byId("dr-status-form");
  fillSelect(byId("dr-status-select"), nextStatuses(item).map((status) => [status, DR_STATUS_LABELS[status]]));
  form.elements.decisionNoteRef.value = "";
  byId("dr-status-error").textContent = "";
  byId("dr-status-subject").textContent = `Żądanie: ${KIND_LABELS[item.kind] ?? item.kind}, stan obecny: ${DR_STATUS_LABELS[item.status] ?? item.status}. Stanu nie da się cofnąć.`;
  form.hidden = false;
  form.elements.status.focus();
}

async function exportDataRequest(element, item, format) {
  if (dr.busy || !canExport(item)) return;
  const confirmed = await confirmAction(exportConfirmation(item, format));
  if (!confirmed || dr.busy) return;
  const message = byId("dr-message");
  message.textContent = "";
  setDataRequestsBusy(true); // podwójne kliknięcie: jeden przebieg naraz (serwer też blokuje drugi)
  try {
    const { blob, headers } = await withStepUp(() => api(
      `/api/admin/data-requests/${encodeURIComponent(item.id)}/export?format=${format}`,
      { method: "POST", binary: true },
    ));
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = exportFileName(headers.get("Content-Disposition"), item.id, format);
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showMessage(`Pobrano plik ${format.toUpperCase()}. ${omittedNote(headers)}`.trim());
    await loadAudit();
  } catch (error) {
    message.textContent = error.message;
  } finally {
    setDataRequestsBusy(false);
  }
}

byId("dr-create-kind").replaceChildren(...Object.entries(KIND_LABELS).map(([value, label]) => new Option(label, value)));
byId("dr-create-form").elements.subjectType.replaceChildren(...Object.entries(SUBJECT_LABELS).map(([value, label]) => new Option(label, value)));
byId("dr-filter-status").replaceChildren(...FILTER_STATUS_OPTIONS.map(([value, label]) => new Option(label, value)));
byId("dr-filter-kind").replaceChildren(...FILTER_KIND_OPTIONS.map(([value, label]) => new Option(label, value)));
byId("dr-create-form").elements.receivedOn.value = drToday();

byId("dr-create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = byId("dr-create-error");
  const submit = form.querySelector("button[type=submit]");
  errorBox.textContent = "";
  let body;
  try {
    body = dataRequestBody(Object.fromEntries(new FormData(form)));
  } catch (error) {
    errorBox.textContent = error.message;
    return;
  }
  // Ten sam formularz po błędzie sieci = ten sam klucz; zmiana treści = nowy klucz.
  const signature = JSON.stringify(body);
  if (dr.createSignature !== signature) { dr.createKey = newRequestKey(); dr.createSignature = signature; }
  submit.disabled = true;
  try {
    const result = await api("/api/admin/data-requests", { method: "POST", body, idempotencyKey: dr.createKey, withMeta: true });
    dr.createKey = null;
    dr.createSignature = "";
    form.elements.subjectId.value = "";
    form.elements.dueOn.value = "";
    showMessage(`Żądanie zarejestrowane: ${KIND_LABELS[result.data.request?.kind] ?? "ok"}.`);
    await Promise.all([loadDataRequests(), loadAudit()]);
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

byId("dr-status-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const item = dr.selected;
  const errorBox = byId("dr-status-error");
  const submit = form.querySelector("button[type=submit]");
  errorBox.textContent = "";
  if (!item) return;
  let body;
  try {
    body = dataRequestStatusBody(form.elements.status.value, form.elements.decisionNoteRef.value);
  } catch (error) {
    errorBox.textContent = error.message;
    return;
  }
  const confirmed = await confirmAction(statusConfirmation(item, body.status));
  if (!confirmed) return;
  submit.disabled = true;
  try {
    await api(`/api/admin/data-requests/${encodeURIComponent(item.id)}/status`, { method: "POST", body });
    showMessage(`Stan żądania zmieniony: ${DR_STATUS_LABELS[body.status]}.`);
    closeDataRequestStatus();
    await Promise.all([loadDataRequests(), loadAudit()]);
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

byId("dr-status-cancel").addEventListener("click", closeDataRequestStatus);
byId("dr-more").addEventListener("click", () => loadDataRequests({ append: true }).catch((error) => { byId("dr-message").textContent = error.message; }));
byId("reload-dr").addEventListener("click", () => loadDataRequests().catch((error) => { byId("dr-message").textContent = error.message; }));
for (const [id, key] of [["dr-filter-status", "status"], ["dr-filter-kind", "kind"]]) {
  byId(id).addEventListener("change", (event) => {
    dr[key] = event.currentTarget.value;
    loadDataRequests().catch((error) => { byId("dr-message").textContent = error.message; });
  });
}

// --- Anonimizacja (#91; POST /api/admin/anonymizations, wyłącznie admin z MFA) ---
// Podgląd (dryRun) pokazuje tylko liczniki. Wykonanie zatwierdza dokładnie ten plan
// (confirm = id gospodarstwa, expectedPlanSha256 z podglądu); API nie używa Idempotency-Key,
// bo powtórzenie jest idempotentne po stronie serwera (`replayed`). Historia pochodzi z
// GET /api/admin/anonymizations (kursor, tylko identyfikatory i liczniki). Nic nie jest zapisywane w przeglądarce.

const anon = { preview: null, request: null, busy: false, runs: [], cursor: null };

function clearAnonPreview() {
  anon.preview = null;
  anon.request = null;
  byId("anon-plan").hidden = true;
  byId("anon-plan-body").replaceChildren();
}

function setAnonBusy(busy) {
  anon.busy = busy;
  byId("anon-preview").disabled = busy;
  byId("anon-execute").disabled = busy || !canExecute(anon.preview);
}

function renderAnonPlan() {
  const preview = anon.preview;
  byId("anon-plan").hidden = !preview;
  if (!preview) return;
  byId("anon-plan-meta").textContent = `${previewSummary(preview)} Gospodarstwo ${preview.householdId}. Powód: ${REASON_LABELS[preview.reasonCode] ?? preview.reasonCode}.`;
  const rows = planRows(preview.counts);
  const tbody = byId("anon-plan-body");
  if (!rows.length) emptyRow(tbody, 2, "Brak pozycji do zmiany.");
  else tbody.replaceChildren(...rows.map((row) => {
    const tr = document.createElement("tr");
    tr.append(cell(row.label), cell(String(row.count), "num"));
    return tr;
  }));
  byId("anon-retained").textContent = retainedNote(preview.retained);
  const execute = byId("anon-execute");
  execute.disabled = anon.busy || !canExecute(preview);
  execute.title = executeBlocker(preview);
}

function renderAnonHistory() {
  const rows = historyRows(anon.runs);
  byId("anon-history-summary").textContent = historySummary(rows.length, Boolean(anon.cursor));
  const tbody = byId("anon-history-body");
  if (!rows.length) return emptyRow(tbody, 7, "Brak przebiegów.");
  tbody.replaceChildren(...rows.map((row) => {
    const tr = document.createElement("tr");
    const run = cell(row.id ? shortId(row.id) : "—");
    if (row.id) run.title = row.id;
    const household = cell(row.householdId ? shortId(row.householdId) : "—");
    if (row.householdId) household.title = row.householdId;
    const digest = cell(row.planSha256 ? `${row.planSha256.slice(0, 12)}…` : "—");
    if (row.planSha256) digest.title = row.planSha256;
    const actor = cell(accountName(row.actorId, state.users));
    if (row.actorId) actor.title = row.actorId;
    tr.append(cell(formatDateTime(row.occurredAt)), run, household,
      cell(REASON_LABELS[row.reasonCode] ?? row.reasonCode), cell(row.total === null ? "—" : String(row.total), "num"), digest, actor);
    return tr;
  }));
}

async function loadAnonHistory({ append = false } = {}) {
  const result = await api(withCursor(HISTORY_PATH, append ? anon.cursor : null));
  const runs = Array.isArray(result.runs) ? result.runs : [];
  anon.runs = append ? [...anon.runs, ...runs] : runs;
  anon.cursor = result.nextCursor ?? null;
  toggleMore("anon-more", anon.cursor);
  renderAnonHistory();
}

function anonHistoryError(error) {
  byId("anon-history-summary").textContent = error.message;
  byId("anon-history-body").replaceChildren();
}

byId("anon-reason").replaceChildren(...Object.entries(REASON_LABELS).map(([value, label]) => new Option(label, value)));
function syncAnonRequestField() {
  const needed = byId("anon-reason").value === "data_subject_request";
  byId("anon-request").disabled = !needed;
  if (!needed) byId("anon-request").value = "";
}
syncAnonRequestField();
byId("anon-form").addEventListener("input", () => { clearAnonPreview(); byId("anon-error").textContent = ""; });
byId("anon-reason").addEventListener("change", syncAnonRequestField);

byId("anon-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (anon.busy) return;
  const errorBox = byId("anon-error");
  errorBox.textContent = "";
  let body;
  try {
    body = previewBody(Object.fromEntries(new FormData(event.currentTarget)));
  } catch (error) {
    errorBox.textContent = error.message;
    return;
  }
  clearAnonPreview();
  setAnonBusy(true);
  try {
    const result = await withStepUp(() => api("/api/admin/anonymizations", { method: "POST", body }));
    anon.preview = result;
    anon.request = body;
    byId("anon-summary").textContent = resultMessage(result);
    renderAnonPlan();
    await loadAnonHistory().catch(anonHistoryError);
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    setAnonBusy(false);
  }
});

byId("anon-execute").addEventListener("click", async () => {
  if (anon.busy || !canExecute(anon.preview)) return;
  const preview = anon.preview;
  const confirmed = await promptAction(executeConfirmation(preview));
  if (confirmed === null || anon.busy) return;
  const errorBox = byId("anon-error");
  errorBox.textContent = "";
  setAnonBusy(true); // podwójne kliknięcie: jeden przebieg naraz (serwer też serializuje i zwróci `replayed`)
  try {
    const result = await withStepUp(() => api("/api/admin/anonymizations", { method: "POST", body: executeBody(preview, anon.request ?? {}) }));
    clearAnonPreview(); // skrót planu jest zużyty; kolejny przebieg wymaga nowego podglądu
    byId("anon-summary").textContent = resultMessage(result);
    showMessage(resultMessage(result));
    await Promise.all([loadAnonHistory().catch(anonHistoryError), loadAudit()]);
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    setAnonBusy(false);
  }
});

byId("anon-more").addEventListener("click", () => loadAnonHistory({ append: true }).catch(anonHistoryError));
byId("reload-anon").addEventListener("click", () => loadAnonHistory().catch(anonHistoryError));

// --- Start ----------------------------------------------------------------------

async function start() {
  try {
    const session = await api("/api/session");
    state.me = session.user?.id ?? null;
    state.meEmail = session.user?.email ?? "";
    await loadYears();
    await loadUsers();
    byId("coverage-year").value = defaultYearId();
    byId("batch-form").elements.schoolYearId.value = defaultYearId();
    await Promise.all([loadGrantRequests(), loadGrants(), loadInvitations(), loadAudit(), loadCoverage()]);
    await loadDataRequests().catch((error) => { byId("dr-message").textContent = error.message; byId("dr-summary").textContent = ""; });
    await loadAnonHistory().catch(anonHistoryError);
  } catch (error) {
    showMessage(error.message, true);
  }
}

start();
