import {
  permittedEventActions,
  ACTION_LABELS,
  ApiError,
  AUDIENCE_LABELS,
  ERROR_MESSAGES,
  STATUS_LABELS,
  canDraftEvents,
  buildActionRequest,
  buildCreateRequest,
  buildEventUrl,
  buildListUrl,
  buildUpdateRequest,
  changedFields,
  classifyBrusselsLocal,
  countByStatus,
  createKeyHolder,
  filterEvents,
  formValuesFromEvent,
  formatBrussels,
  formatRange,
  formatStamp,
  isConflict,
  isUnauthenticated,
  isValidId,
  localToInstant,
  offsetLabel,
  publishedIsBehind,
  revisionMarks,
  validateEventForm,
  validateReason,
} from "./core.js";
import { api as apiRequest } from "../shared/api.js";
import { confirmAction } from "../shared/confirm-dialog.js";
import { mountShell } from "../shared/shell.js";
import "../shared/shell.css";
import { classChoiceOptionsHtml, fillClassSelect } from "../shared/class-choice.js";
import { fillYearSelect, selectYearValue } from "../shared/school-year.js";

mountShell();

const byId = (id) => document.getElementById(id);
const state = {
  schoolYearId: "",
  events: [],
  detail: null, // { event, revisions }
  grants: [], // z /api/access; tylko do ukrywania akcji, serwer i tak autoryzuje
  userId: null,
  editing: null, // event being edited, null = create
  busy: false,
};
const createKey = createKeyHolder("event");

const app = byId("app");
const loginRequired = byId("login-required");
const openCreate = byId("open-create");
const globalMessage = byId("global-message");
const filtersForm = byId("filters-form");
const yearInput = byId("school-year-id");
const statusInput = byId("status-filter");
const listSummary = byId("list-summary");
const listMessage = byId("list-message");
const tableWrap = byId("table-wrap");
const eventsBody = byId("events-body");
const detail = byId("detail");
const detailTitle = byId("detail-title");
const detailMeta = byId("detail-meta");
const detailMessage = byId("detail-message");
const detailFacts = byId("detail-facts");
const detailActions = byId("detail-actions");
const revisionsBody = byId("revisions-body");
const conflict = byId("conflict");
const eventDialog = byId("event-dialog");
const eventForm = byId("event-form");
const eventFormError = byId("event-form-error");
const eventSubmit = byId("event-submit");
const cancelDialog = byId("cancel-dialog");
const cancelForm = byId("cancel-form");
const cancelFormError = byId("cancel-form-error");
const cancelSubmit = byId("cancel-submit");

// ---------- HTTP ----------

// Wspólny klient (#99): 401/403 MFA → /login/ z powrotem; kody spoza słownika
// wydarzeń dostają tekst ze wspólnego słownika (np. mfa_required).
async function api(request) {
  try {
    return await apiRequest(request.url, { method: request.method || "GET", headers: request.headers, body: request.body });
  } catch (shared) {
    const error = new ApiError(shared.network ? null : shared.code || null, shared.status);
    if (!shared.network && !Object.hasOwn(ERROR_MESSAGES, shared.code)) error.message = shared.message;
    if (isUnauthenticated(error)) showLoginRequired();
    throw error;
  }
}

function showLoginRequired() {
  app.hidden = true;
  openCreate.hidden = true;
  loginRequired.hidden = false;
  for (const dialog of [eventDialog, cancelDialog]) if (dialog.open) dialog.close();
  loginRequired.focus();
}

function setMessage(element, text, kind = "") {
  element.className = kind ? `message ${kind}` : "message";
  element.textContent = text;
}

// ---------- start: sesja i przydziały ----------

async function start() {
  try {
    const access = await api({ url: "/api/access" });
    // Sesja przed MFA dostaje { grants: [], mfaRequired: true } — wtedy brak akcji.
    const grants = Array.isArray(access.grants) ? access.grants : [];
    state.grants = grants;
    state.userId = grants.length ? await api({ url: "/api/session" }).then((s) => s?.user?.id ?? null, () => null) : null;
    app.hidden = false;
    openCreate.hidden = !canDraftEvents(grants);
    // Rok domyślny (puste ekrany bez klikania): najnowszy z przydziałów, awaryjnie
    // heurystyka daty (shared/school-year.js). Użytkownik nadal może zmienić rok.
    const year = fillYearSelect(yearInput, grants);
    if (year) await loadList();
  } catch (error) {
    if (!isUnauthenticated(error)) setMessage(globalMessage, error.message, "error");
  }
}

// ---------- lista ----------

function cell(content, className = "") {
  const td = document.createElement("td");
  if (content instanceof Node) td.append(content);
  else td.textContent = content;
  if (className) td.className = className;
  return td;
}

// Etykiety kolumn dla widoku wąskiego (tabela jako lista, styles.css).
function labelCells(tbody) {
  const headers = [...tbody.closest("table").querySelectorAll("thead th")].map((th) => th.textContent);
  for (const row of tbody.rows) [...row.cells].forEach((td, i) => { td.dataset.label = headers[i] ?? ""; });
}

function badge(status) {
  const span = document.createElement("span");
  span.className = `badge status-${status}`;
  span.textContent = STATUS_LABELS[status] ?? status;
  return span;
}

function eventRow(event) {
  const row = document.createElement("tr");
  row.append(cell(formatRange(event.startsAtUtc, event.endsAtUtc), "when"));
  const button = document.createElement("button");
  button.type = "button";
  button.className = "link";
  button.dataset.eventId = event.id;
  button.textContent = event.title;
  row.append(cell(button));
  row.append(cell(event.classId || "Ogólnoszkolne"));
  row.append(cell(AUDIENCE_LABELS[event.audience] ?? event.audience));
  row.append(cell(badge(event.status)));
  row.append(cell(String(event.revision), "number"));
  return row;
}

function renderList() {
  const status = statusInput.value;
  const visible = filterEvents(state.events, status);
  eventsBody.replaceChildren(...visible.map(eventRow));
  labelCells(eventsBody);
  tableWrap.hidden = visible.length === 0;
  const counts = countByStatus(state.events);
  const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([s, n]) => `${STATUS_LABELS[s]}: ${n}`);
  listSummary.textContent = `Rok ${state.schoolYearId} · wszystkich: ${state.events.length}${parts.length ? ` (${parts.join(", ")})` : ""} · widocznych: ${visible.length}`;
  setMessage(listMessage, visible.length === 0 ? "Brak wydarzeń dla wybranych filtrów." : "");
}

async function loadList() {
  setMessage(listMessage, "Wczytywanie…");
  try {
    const url = buildListUrl(yearInput.value);
    const result = await api({ url });
    state.schoolYearId = yearInput.value.trim();
    state.events = Array.isArray(result.events) ? result.events : [];
    renderList();
  } catch (error) {
    state.events = [];
    eventsBody.replaceChildren();
    tableWrap.hidden = true;
    listSummary.textContent = "Nie udało się pobrać wydarzeń.";
    setMessage(listMessage, error.message, "error");
  }
}

filtersForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!filtersForm.reportValidity()) return;
  loadList();
});
statusInput.addEventListener("change", () => {
  if (state.schoolYearId) renderList();
});
eventsBody.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-event-id]");
  if (button) openDetail(button.dataset.eventId);
});

// ---------- szczegóły ----------

function fact(term, value) {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  if (value instanceof Node) dd.append(value);
  else dd.textContent = value || "—";
  return [dt, dd];
}

function actionButton(label, action, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.action = action;
  button.textContent = label;
  if (className) button.className = className;
  return button;
}

function renderDetail() {
  const { event, revisions } = state.detail;
  detailTitle.textContent = event.title;
  detailMeta.textContent = `Wersja ${event.revision} · ${STATUS_LABELS[event.status] ?? event.status}`;
  const facts = [
    ...fact("Status", badge(event.status)),
    ...fact("Termin", formatRange(event.startsAtUtc, event.endsAtUtc)),
    ...fact("Miejsce", event.location),
    ...fact("Organizator", event.organizer),
    ...fact("Odbiorcy", AUDIENCE_LABELS[event.audience] ?? event.audience),
    ...fact("Klasa", event.classId || "Ogólnoszkolne"),
    ...fact("Rok szkolny", event.schoolYearId),
    ...fact("Opis", event.description),
  ];
  if (event.publishedRevision) {
    const note = publishedIsBehind(event)
      ? `wersja ${event.publishedRevision} (strona publiczna pokazuje starszą wersję do czasu ponownej publikacji)`
      : `wersja ${event.publishedRevision}, ${formatStamp(event.publishedAt)}`;
    facts.push(...fact("Opublikowano", note));
  }
  if (event.status === "cancelled") {
    facts.push(...fact("Odwołano", formatStamp(event.cancelledAt)));
    facts.push(...fact("Powód odwołania (wewnętrzny)", event.cancellationReason));
  }
  detailFacts.replaceChildren(...facts);

  const buttons = [];
  const permitted = permittedEventActions(event, { grants: state.grants, userId: state.userId, revisions });
  if (permitted.edit) buttons.push(actionButton("Edytuj", "edit"));
  for (const action of permitted.actions) {
    buttons.push(actionButton(ACTION_LABELS[action], action, action === "cancel" ? "danger" : "primary"));
  }
  detailActions.replaceChildren(...buttons);
  for (const text of permitted.notes) {
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = text;
    detailActions.append(note);
  }
  if (event.status === "approved" && event.audience !== "public") {
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "Wydarzenie wewnętrzne nie jest publikowane na stronie.";
    detailActions.append(note);
  }

  const ordered = [...revisions].sort((a, b) => b.revision - a.revision);
  const byNumber = new Map(revisions.map((r) => [r.revision, r]));
  revisionsBody.replaceChildren(...ordered.map((revision) => {
    const row = document.createElement("tr");
    const marks = revisionMarks(event, revision.revision);
    row.append(cell(marks.length ? `${revision.revision} (${marks.join(", ")})` : String(revision.revision)));
    row.append(cell(formatStamp(revision.createdAt)));
    row.append(cell(revision.createdBy || "—"));
    const summary = [revision.title, formatBrussels(revision.startsAt ? new Date(revision.startsAt) : null)];
    if (revision.location) summary.push(revision.location);
    summary.push(AUDIENCE_LABELS[revision.audience] ?? revision.audience);
    row.append(cell(summary.join(" · ")));
    const changes = changedFields(byNumber.get(revision.revision - 1), revision);
    row.append(cell(revision.revision === 1 ? "pierwsza wersja" : (changes.join(", ") || "bez zmian treści")));
    return row;
  }));
  labelCells(revisionsBody);
}

async function openDetail(eventId, { focus = true } = {}) {
  conflict.hidden = true;
  setMessage(detailMessage, "Wczytywanie…");
  detail.hidden = false;
  try {
    const result = await api({ url: buildEventUrl(eventId) });
    state.detail = { event: result.event, revisions: Array.isArray(result.revisions) ? result.revisions : [] };
    renderDetail();
    setMessage(detailMessage, "");
    if (focus) detailTitle.focus();
  } catch (error) {
    state.detail = null;
    detail.hidden = true;
    setMessage(listMessage, error.message, "error");
  }
}

function replaceInList(event) {
  const index = state.events.findIndex((item) => item.id === event.id);
  if (index >= 0) state.events[index] = event;
  else if (event.schoolYearId === state.schoolYearId) state.events.push(event);
  if (state.schoolYearId) renderList();
}

byId("close-detail").addEventListener("click", () => {
  const id = state.detail?.event.id;
  detail.hidden = true;
  state.detail = null;
  eventsBody.querySelector(`button[data-event-id="${CSS.escape(id ?? "")}"]`)?.focus();
});
byId("conflict-refresh").addEventListener("click", async () => {
  const id = state.detail?.event.id;
  if (!id) return;
  await openDetail(id);
  await loadList();
});

function showConflict() {
  conflict.hidden = false;
  conflict.querySelector("button").focus();
}

async function runAction(action, reason) {
  const { event } = state.detail;
  // Numer wersji, którą użytkownik ma przed oczami — nie pobieramy świeżego po cichu.
  const request = buildActionRequest(event.id, action, event.revision, reason);
  const result = await api(request);
  await openDetail(event.id, { focus: false });
  replaceInList(result.event);
  const label = { submit: "Zgłoszono do zatwierdzenia.", approve: "Zatwierdzono.", publish: "Opublikowano.", cancel: "Odwołano wydarzenie." }[action];
  setMessage(detailMessage, result.replayed ? `${label} (operacja była już wykonana)` : label, "success");
  detailTitle.focus();
}

detailActions.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || !state.detail || state.busy) return;
  const action = button.dataset.action;
  if (action === "edit") return openEdit(state.detail.event);
  if (action === "cancel") return openCancel(state.detail.event);
  if (action === "publish") {
    // Podgląd dokładnie tego, co zobaczy site/ (issue #136) — tytuł, termin w
    // Europe/Brussels, miejsce, odbiorcy.
    const ev = state.detail.event;
    const confirmed = await confirmAction({
      title: "Opublikować wydarzenie?",
      effects: [
        ev.title,
        `Termin: ${formatRange(ev.startsAtUtc, ev.endsAtUtc)}`,
        ev.location ? `Miejsce: ${ev.location}` : null,
        `Odbiorcy: ${AUDIENCE_LABELS[ev.audience] ?? ev.audience}`,
        "Strona publiczna pokaże tę wersję w ciągu ok. 60 s.",
      ],
      confirmLabel: "Opublikuj",
    });
    if (!confirmed) return;
  }
  state.busy = true;
  const buttons = [...detailActions.querySelectorAll("button")];
  buttons.forEach((b) => { b.disabled = true; });
  conflict.hidden = true;
  setMessage(detailMessage, "Wysyłanie…");
  try {
    await runAction(action);
  } catch (error) {
    if (isConflict(error)) {
      setMessage(detailMessage, "");
      showConflict();
    } else setMessage(detailMessage, error.message, "error");
  } finally {
    state.busy = false;
    buttons.forEach((b) => { b.disabled = false; });
  }
});

// ---------- formularz szkicu ----------

const fields = (name) => eventForm.elements.namedItem(name);

function clearFieldErrors(form) {
  for (const span of form.querySelectorAll(".field-error")) span.textContent = "";
  for (const input of form.querySelectorAll("[aria-invalid]")) input.removeAttribute("aria-invalid");
}

function showFieldErrors(errors) {
  let first = null;
  for (const [field, message] of Object.entries(errors)) {
    const span = byId(`err-${field}`);
    if (span) span.textContent = message;
    const input = fields(field);
    if (input instanceof HTMLElement) {
      input.setAttribute("aria-invalid", "true");
      first ||= input;
    }
  }
  return first;
}

function selectedOffset(name) {
  return eventForm.querySelector(`input[name="${name}Offset"]:checked`)?.value ?? "";
}

// Pokazuje wybór przesunięcia tylko dla godziny występującej dwa razy.
function renderOffsetChoice(name, preferred = selectedOffset(name)) {
  const container = byId(`offset-${name}`);
  const value = fields(name).value;
  const info = classifyBrusselsLocal(value);
  if (info.kind !== "ambiguous") {
    container.hidden = true;
    container.replaceChildren();
    return;
  }
  const intro = document.createElement("p");
  intro.textContent = `Godzina ${value.slice(11)} występuje tego dnia dwa razy. Wybierz właściwą:`;
  const options = info.offsets.map((offset, index) => {
    const label = document.createElement("label");
    label.className = "radio";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = `${name}Offset`;
    radio.value = offset;
    radio.checked = offset === preferred;
    const instant = localToInstant(value, offset);
    const utc = instant.toISOString().slice(11, 16);
    label.append(radio, ` ${index === 0 ? "Pierwsze wystąpienie" : "Drugie wystąpienie"} — ${offsetLabel(offset)} (${utc} UTC)`);
    return label;
  });
  container.replaceChildren(intro, ...options);
  container.hidden = false;
}

for (const name of ["startsAt", "endsAt"]) {
  fields(name).addEventListener("change", () => renderOffsetChoice(name));
}

function formValues() {
  return {
    schoolYearId: fields("schoolYearId").value,
    classId: fields("classId").value,
    title: fields("title").value,
    description: fields("description").value,
    startsAt: fields("startsAt").value,
    startsOffset: selectedOffset("startsAt"),
    endsAt: fields("endsAt").value,
    endsOffset: selectedOffset("endsAt"),
    location: fields("location").value,
    organizer: fields("organizer").value,
    audience: fields("audience").value,
  };
}

function fillForm(values) {
  for (const name of ["schoolYearId", "classId", "title", "description", "startsAt", "endsAt", "location", "organizer", "audience"]) {
    fields(name).value = values[name] ?? "";
  }
  renderOffsetChoice("startsAt", values.startsOffset);
  renderOffsetChoice("endsAt", values.endsOffset);
}

function prepareForm(editing) {
  state.editing = editing;
  createKey.reset();
  eventForm.reset();
  clearFieldErrors(eventForm);
  eventFormError.textContent = "";
  const scopeFields = byId("scope-fields");
  const context = byId("event-context");
  scopeFields.hidden = Boolean(editing);
  for (const input of scopeFields.querySelectorAll("select")) input.disabled = Boolean(editing);
  byId("edit-note").hidden = !editing;
  if (editing) {
    byId("event-dialog-title").textContent = "Edytuj wydarzenie";
    eventSubmit.textContent = "Zapisz nową wersję";
    context.hidden = false;
    context.textContent = `Edytujesz wersję ${editing.revision} (${STATUS_LABELS[editing.status]}). Rok ${editing.schoolYearId}, ${editing.classId ? `klasa ${editing.classId}` : "wydarzenie ogólnoszkolne"}.`;
    // Zakres jest tylko do odczytu — opcje zawierają wyłącznie bieżące wartości wydarzenia.
    fields("schoolYearId").innerHTML = "";
    selectYearValue(fields("schoolYearId"), editing.schoolYearId);
    fields("classId").innerHTML = classChoiceOptionsHtml(
      editing.classId ? [{ id: editing.classId, name: editing.classId }] : [],
      { optional: true, emptyLabel: "Ogólnoszkolne", selected: editing.classId || "" },
    );
    fillForm(formValuesFromEvent(editing));
  } else {
    fillYearSelect(fields("schoolYearId"), state.grants, { value: yearInput.value.trim() });
    syncEventClassChoice();
    byId("event-dialog-title").textContent = "Nowy szkic";
    eventSubmit.textContent = "Zapisz szkic";
    context.hidden = true;
    fillForm({ schoolYearId: fields("schoolYearId").value, audience: "internal" });
  }
}

// Klasa wydarzenia z listy (GET /api/classes — serwer zawęża do zakresu roli), #128.
// Puste = wydarzenie ogólnoszkolne.
function syncEventClassChoice() {
  return fillClassSelect(fields("classId"), (url) => api({ url }), fields("schoolYearId").value, {
    optional: true, emptyLabel: "Ogólnoszkolne (bez klasy)", selected: fields("classId").value,
  });
}
eventForm.elements.namedItem("schoolYearId").addEventListener("change", syncEventClassChoice);

function openEdit(event) {
  prepareForm(event);
  eventDialog.showModal();
  fields("title").focus();
}

openCreate.addEventListener("click", () => {
  prepareForm(null);
  eventDialog.showModal();
  fields(fields("schoolYearId").value ? "title" : "schoolYearId").focus();
});

eventForm.addEventListener("submit", async (submitEvent) => {
  submitEvent.preventDefault();
  if (state.busy) return; // podwójne kliknięcie
  clearFieldErrors(eventForm);
  eventFormError.textContent = "";
  for (const name of ["startsAt", "endsAt"]) renderOffsetChoice(name);
  const editing = state.editing;
  const result = validateEventForm(formValues(), { mode: editing ? "edit" : "create" });
  if (Object.keys(result.errors).length) {
    const first = showFieldErrors(result.errors);
    eventFormError.textContent = "Popraw zaznaczone pola.";
    const offsetField = ["startsAt", "endsAt"].find((name) => result.needsOffset[name] && result.errors[name]);
    (offsetField ? byId(`offset-${offsetField}`).querySelector("input") : first)?.focus();
    return;
  }

  state.busy = true;
  eventSubmit.disabled = true;
  eventFormError.textContent = "Zapisywanie…";
  try {
    let saved;
    if (editing) {
      saved = await api(buildUpdateRequest(editing.id, editing.revision, result.content));
    } else {
      // Ten sam klucz przy ponowieniu po błędzie sieci lub podwójnym kliknięciu.
      saved = await api(buildCreateRequest(result, createKey.get()));
    }
    createKey.reset();
    eventDialog.close();
    replaceInList(saved.event);
    await openDetail(saved.event.id, { focus: false });
    setMessage(detailMessage, editing ? (saved.replayed ? "Brak zmian do zapisania." : `Zapisano wersję ${saved.event.revision}.`) : "Utworzono szkic.", "success");
    detailTitle.focus();
  } catch (error) {
    if (isConflict(error)) {
      eventFormError.textContent = `${error.message} Twoje zmiany nie zostały zapisane — skopiuj je, jeśli chcesz, zamknij formularz i odśwież wydarzenie.`;
    } else if (["ambiguous_local_time", "nonexistent_local_time", "offset_not_valid_in_europe_brussels", "invalid_datetime"].includes(error.code)) {
      // Serwer ocenił czas inaczej niż przeglądarka: pokaż wybór dla obu pól.
      for (const name of ["startsAt", "endsAt"]) {
        renderOffsetChoice(name);
        if (classifyBrusselsLocal(fields(name).value).kind !== "ok" && fields(name).value) showFieldErrors({ [name]: error.message });
      }
      eventFormError.textContent = error.message;
    } else if (error.code === "ends_before_start") {
      showFieldErrors({ endsAt: error.message });
      eventFormError.textContent = error.message;
    } else {
      eventFormError.textContent = error.message;
    }
  } finally {
    state.busy = false;
    eventSubmit.disabled = false;
  }
});

// ---------- odwołanie ----------

function openCancel(event) {
  cancelForm.reset();
  clearFieldErrors(cancelForm);
  cancelFormError.textContent = "";
  byId("cancel-context").textContent = `${event.title} · ${formatRange(event.startsAtUtc, event.endsAtUtc)} · wersja ${event.revision}`;
  cancelDialog.showModal();
  cancelForm.elements.reason.focus();
}

cancelForm.addEventListener("submit", async (submitEvent) => {
  submitEvent.preventDefault();
  if (state.busy || !state.detail) return;
  clearFieldErrors(cancelForm);
  const checked = validateReason(cancelForm.elements.reason.value);
  if (checked.error) {
    byId("err-reason").textContent = checked.error;
    cancelForm.elements.reason.setAttribute("aria-invalid", "true");
    cancelForm.elements.reason.focus();
    return;
  }
  state.busy = true;
  cancelSubmit.disabled = true;
  cancelFormError.textContent = "Wysyłanie…";
  try {
    await runAction("cancel", checked.reason);
    cancelDialog.close();
    detailTitle.focus();
  } catch (error) {
    if (isConflict(error)) {
      cancelDialog.close();
      showConflict();
    } else cancelFormError.textContent = error.message;
  } finally {
    state.busy = false;
    cancelSubmit.disabled = false;
  }
});

// ---------- okna dialogowe ----------

for (const dialog of [eventDialog, cancelDialog]) {
  dialog.addEventListener("click", (event) => {
    if (event.target.closest("[data-close]") && !state.busy) dialog.close();
  });
  dialog.addEventListener("cancel", (event) => {
    if (state.busy) event.preventDefault();
  });
}
eventDialog.addEventListener("close", () => {
  createKey.reset();
  const target = state.editing ? detailActions.querySelector('button[data-action="edit"]') : openCreate;
  state.editing = null;
  if (!detail.contains(document.activeElement)) target?.focus();
});

start();
