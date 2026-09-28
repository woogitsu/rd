import { canManageMeetings, meetingsViewMode } from "./core.js";
import {
  CAPACITY_LABELS,
  KIND_LABELS,
  MINUTES_STATUS_LABELS,
  QUORUM_MODE_LABELS,
  RESOLUTION_STATUS_LABELS,
  STATUS_ACTION_LABELS,
  STATUS_LABELS,
  VISIBILITY_LABELS,
  allowedStatusTransitions,
  attendeeReference,
  brusselsLocalToIso,
  buildAttendancePayload,
  buildMeetingsUrl,
  buildQuorumRule,
  buildSharedMinutesUrl,
  canApproveMinutes,
  currentResolutions,
  describeQuorumCheck,
  describeQuorumRule,
  ERROR_MESSAGES,
  errorMessage,
  formatBrussels,
  formatVotes,
  isMeetingLocked,
  isValidId,
  isoToBrusselsLocal,
  latestMinutes,
  makeIdempotencyKey,
  meetingUrl,
  resolutionActions,
  summarizeAttendance,
  validateVotes,
} from "./core.js";
import { api as apiRequest } from "../shared/api.js";
import { mountShell } from "../shared/shell.js";
import "../shared/shell.css";
import { mountPrintMeta } from "../shared/print-meta.js";
import "../shared/print.css";

let printedBy = null;
mountShell().then((result) => { printedBy = result?.session?.displayName || result?.session?.email || null; });

const byId = (id) => document.getElementById(id);
const state = { schoolYearId: "", meetings: [], detail: null, keys: new Map() };

class ApiError extends Error {
  constructor(code, status, network = false) {
    super(network ? "Brak połączenia z serwerem. Spróbuj ponownie — ponowienie nie utworzy duplikatu." : errorMessage(code, status));
    this.code = code;
    this.status = status;
    this.network = network;
  }
}

// Wspólny klient (#99): 401/403 MFA → /login/ z powrotem; kody spoza słownika
// zebrań dostają tekst ze wspólnego słownika (np. mfa_required).
async function api(url, { method = "GET", body, idempotencyKey } = {}) {
  try {
    return await apiRequest(url, { method, body, idempotencyKey });
  } catch (shared) {
    if (shared.network) throw new ApiError("network", 0, true);
    const error = new ApiError(shared.code, shared.status);
    if (!Object.hasOwn(ERROR_MESSAGES, shared.code)) error.message = shared.message;
    throw error;
  }
}

// Tworzenie: jeden klucz na próbę wysłania formularza. Klucz zostaje przy błędzie
// sieci lub 5xx (ponowienie odtworzy pierwotny wynik), znika po sukcesie i po
// odpowiedzi rozstrzygającej, w tym 409.
async function create(slot, prefix, url, body) {
  if (!state.keys.has(slot)) state.keys.set(slot, makeIdempotencyKey(prefix));
  try {
    const result = await api(url, { method: "POST", body, idempotencyKey: state.keys.get(slot) });
    state.keys.delete(slot);
    return result;
  } catch (error) {
    if (!(error instanceof ApiError) || !(error.network || error.status >= 500)) state.keys.delete(slot);
    throw error;
  }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (name === "className") node.className = value;
    else if (name === "dataset") Object.assign(node.dataset, value);
    else node.setAttribute(name, value === true ? "" : value);
  }
  node.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

function options(select, entries, { placeholder } = {}) {
  select.replaceChildren(
    ...(placeholder ? [el("option", { value: "" }, placeholder)] : []),
    ...entries.map(([value, label]) => el("option", { value }, label)),
  );
}

function setMessage(node, text, kind = "") {
  node.textContent = text;
  node.className = `message${kind ? ` ${kind}` : ""}`;
}

function fields(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function trimmed(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

// Wspólna obsługa formularza: blokada przycisku (podwójne kliknięcie), komunikat
// błędu przy formularzu, odświeżenie zebrania po konflikcie.
function handleSubmit(form, work) {
  const errorBox = form.querySelector(".form-error");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (form.dataset.busy === "true") return;
    errorBox.textContent = "";
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    form.dataset.busy = "true";
    const buttons = [...form.querySelectorAll("button[type=submit]")];
    buttons.forEach((button) => { button.disabled = true; });
    try {
      await work(fields(form), form);
    } catch (error) {
      errorBox.textContent = error.message;
      if (error instanceof ApiError && error.status === 409 && state.detail) await reloadDetail({ quiet: true });
    } finally {
      form.dataset.busy = "false";
      buttons.forEach((button) => { button.disabled = false; });
    }
  });
}

// ---------- reguła quorum (wspólny fragment formularzy) ----------

function buildQuorumFieldset(fieldset) {
  const mode = el("select", { name: "quorumMode" });
  options(mode, Object.entries(QUORUM_MODE_LABELS));
  const fraction = el("div", { className: "field-row", dataset: { mode: "fraction" } },
    el("label", {}, "Licznik", el("input", { name: "quorumNumerator", inputmode: "numeric", maxlength: "4" })),
    el("label", {}, "Mianownik", el("input", { name: "quorumDenominator", inputmode: "numeric", maxlength: "4" })),
  );
  const relation = el("fieldset", { className: "choice", dataset: { mode: "fraction" } },
    el("legend", {}, "Wymagane"),
    el("label", { className: "inline" }, el("input", { type: "radio", name: "quorumInclusive", value: "true" }), " co najmniej ułamek składu"),
    el("label", { className: "inline" }, el("input", { type: "radio", name: "quorumInclusive", value: "false" }), " więcej niż ułamek składu"),
  );
  const minimum = el("label", { dataset: { mode: "minimum_count" } }, "Minimalna liczba obecnych z prawem głosu",
    el("input", { name: "quorumMinCount", inputmode: "numeric", maxlength: "5" }));
  const size = el("label", { dataset: { mode: "fraction minimum_count" } }, "Liczebność składu uprawnionego do głosowania",
    el("input", { name: "votingBodySize", inputmode: "numeric", maxlength: "5" }));
  const source = el("label", { dataset: { mode: "fraction minimum_count" } }, "Źródło reguły (obowiązkowe, np. paragraf regulaminu lub uchwała)",
    el("input", { name: "quorumRuleSource", maxlength: "200" }));
  const preview = el("p", { className: "muted", "aria-live": "polite" });
  fieldset.append(el("label", {}, "Rodzaj reguły", mode), fraction, relation, minimum, size, source, preview);

  const form = fieldset.form;
  const update = () => {
    for (const node of fieldset.querySelectorAll("[data-mode]")) {
      node.hidden = !node.dataset.mode.split(" ").includes(mode.value);
    }
    try {
      const rule = buildQuorumRule(fields(form));
      preview.textContent = rule.quorumMode === "not_configured"
        ? "Bez reguły nie da się ustalić quorum ani wpisać wyniku uchwały."
        : `Podgląd: ${describeQuorumRule(rule)}.`;
    } catch (error) {
      preview.textContent = mode.value === "not_configured" ? "" : error.message;
    }
  };
  fieldset.addEventListener("input", update);
  fieldset.addEventListener("change", update);
  update();
  return {
    fill(rule = {}) {
      mode.value = rule.mode || "not_configured";
      form.elements.quorumNumerator.value = rule.numerator ?? "";
      form.elements.quorumDenominator.value = rule.denominator ?? "";
      form.elements.quorumMinCount.value = rule.minCount ?? "";
      form.elements.votingBodySize.value = rule.votingBodySize ?? "";
      form.elements.quorumRuleSource.value = rule.source ?? "";
      for (const radio of form.querySelectorAll("input[name=quorumInclusive]")) {
        radio.checked = rule.inclusive !== null && rule.inclusive !== undefined && radio.value === String(rule.inclusive);
      }
      update();
    },
    update,
  };
}

// ---------- lista zebrań ----------

const filtersForm = byId("filters-form");
const yearInput = byId("school-year-id");
const listBody = byId("list-body");
const listWrap = byId("list-wrap");
const listMessage = byId("list-message");
const listLoading = byId("list-loading");

function renderList() {
  listBody.replaceChildren(...state.meetings.map((meeting) => el("tr", {},
    el("td", { className: "nowrap" }, formatBrussels(meeting.scheduledAt)),
    el("td", {}, KIND_LABELS[meeting.kind] ?? meeting.kind, meeting.classId ? el("small", {}, `Klasa: ${meeting.classId}`) : null),
    el("td", {}, meeting.title),
    el("td", {}, STATUS_LABELS[meeting.status] ?? meeting.status),
    el("td", { className: "row-actions" }, el("button", {
      type: "button",
      dataset: { open: meeting.id },
      "aria-label": `Otwórz: ${meeting.title}`,
      "aria-pressed": state.detail?.meeting.id === meeting.id ? "true" : "false",
    }, "Otwórz")),
  )));
  listWrap.hidden = state.meetings.length === 0;
  setMessage(listMessage, state.meetings.length
    ? `Zebrania w roku ${state.schoolYearId}: ${state.meetings.length}.`
    : `Brak zebrań w roku ${state.schoolYearId}.`);
}

async function loadList() {
  listLoading.hidden = false;
  try {
    const url = buildMeetingsUrl(yearInput.value);
    state.schoolYearId = yearInput.value.trim();
    const result = await api(url);
    state.meetings = Array.isArray(result.meetings) ? result.meetings : [];
    renderList();
    rememberLocation();
  } catch (error) {
    state.meetings = [];
    listWrap.hidden = true;
    setMessage(listMessage, error.message, "error");
  } finally {
    listLoading.hidden = true;
  }
}

// ---------- widok przedstawiciela: protokoły udostępnione (#167) ----------
// Bez roli z MEETING_READ_ROLES nie wołamy GET /api/meetings (kończy się 403),
// tylko od razu GET /api/meetings/shared-minutes — te same dane co strona
// publiczna/rodzice, plus zebrania klasowe własnej klasy.
const sharedBody = byId("shared-body");
const sharedWrap = byId("shared-wrap");
const sharedMessage = byId("shared-message");
const sharedLoading = byId("shared-loading");
state.sharedMinutes = [];

function renderSharedList() {
  sharedBody.replaceChildren(...state.sharedMinutes.map((item) => el("tr", {},
    el("td", { className: "nowrap" }, item.scheduledAt ? formatBrussels(item.scheduledAt) : "—"),
    el("td", {}, KIND_LABELS[item.kind] ?? item.kind),
    el("td", {}, item.classId ?? "—"),
    el("td", {}, item.title),
    el("td", { className: "num" }, String(item.version)),
    el("td", { className: "nowrap" }, item.approvedAt ? formatBrussels(item.approvedAt) : "—"),
    el("td", { className: "row-actions" }, el("button", {
      type: "button", dataset: { shared: item.id }, "aria-label": `Pokaż protokół: ${item.title}`,
    }, "Pokaż")),
  )));
  sharedWrap.hidden = state.sharedMinutes.length === 0;
  setMessage(sharedMessage, state.sharedMinutes.length
    ? `Udostępnione protokoły w roku ${state.schoolYearId}: ${state.sharedMinutes.length}.`
    : `Brak udostępnionych protokołów w roku ${state.schoolYearId}.`);
}

async function loadSharedList() {
  sharedLoading.hidden = false;
  try {
    const url = buildSharedMinutesUrl(yearInput.value);
    state.schoolYearId = yearInput.value.trim();
    const result = await api(url);
    state.sharedMinutes = Array.isArray(result.minutes) ? result.minutes : [];
    renderSharedList();
    rememberLocation();
  } catch (error) {
    state.sharedMinutes = [];
    sharedWrap.hidden = true;
    setMessage(sharedMessage, error.message, "error");
  } finally {
    sharedLoading.hidden = true;
  }
}

sharedBody.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-shared]");
  if (!button) return;
  const item = state.sharedMinutes.find((entry) => entry.id === button.dataset.shared);
  if (!item) return;
  byId("minutes-view-title").textContent = `${item.title} — wersja ${item.version}`;
  byId("minutes-view-body").textContent = item.body;
  state.viewingMinutes = item;
  minutesView.dialog.showModal();
});

// state.viewMode: "full" (READ_ROLES — bez zmian), "shared" (przedstawiciel —
// tylko protokoły udostępnione), "none" (brak przydziału, np. sesja przed MFA).
function applyViewMode(mode) {
  state.viewMode = mode;
  byId("list-section").hidden = mode !== "full";
  byId("shared-section").hidden = mode !== "shared";
  byId("open-meeting").hidden = mode !== "full" || !state.canManage;
}

filtersForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!filtersForm.reportValidity()) return;
  closeDetail();
  if (state.viewMode === "shared") loadSharedList();
  else loadList();
});

listBody.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-open]");
  if (button) openDetail(button.dataset.open, { focus: true });
});

function rememberLocation() {
  const params = new URLSearchParams();
  if (state.schoolYearId) params.set("rok", state.schoolYearId);
  if (state.detail) params.set("zebranie", state.detail.meeting.id);
  history.replaceState(null, "", `${location.pathname}${params.toString() ? `?${params}` : ""}`);
}

// ---------- szczegóły zebrania ----------

const detail = byId("detail");
const detailMessage = byId("detail-message");
const editForm = byId("meeting-edit-form");
const statusForm = byId("status-form");
const agendaForm = byId("agenda-form");
const attendanceForm = byId("attendance-form");
const minutesForm = byId("minutes-form");
const editQuorum = buildQuorumFieldset(editForm.querySelector("[data-quorum-fields]"));
options(attendanceForm.querySelector("[data-capacity]"), Object.entries(CAPACITY_LABELS), { placeholder: "Wybierz" });

function closeDetail() {
  state.detail = null;
  detail.hidden = true;
}

async function openDetail(meetingId, { focus = false } = {}) {
  if (!isValidId(meetingId)) return;
  setMessage(detailMessage, "Wczytywanie zebrania…");
  detail.hidden = false;
  try {
    state.detail = await api(meetingUrl(meetingId));
    renderDetail({ refill: true });
    setMessage(detailMessage, "");
    rememberLocation();
    renderList();
    if (focus) detail.focus();
  } catch (error) {
    state.detail = null;
    detail.hidden = false;
    setMessage(detailMessage, error.message, "error");
  }
}

async function reloadDetail({ quiet = false, refill = false } = {}) {
  if (!state.detail) return;
  const id = state.detail.meeting.id;
  try {
    state.detail = await api(meetingUrl(id));
    renderDetail({ refill });
    const index = state.meetings.findIndex((item) => item.id === id);
    if (index >= 0) state.meetings[index] = state.detail.meeting;
    renderList();
    if (!quiet) setMessage(detailMessage, "Dane zebrania odświeżone.");
  } catch (error) {
    setMessage(detailMessage, error.message, "error");
  }
}

byId("reload-detail").addEventListener("click", () => reloadDetail({ refill: true }));

function setDisabled(form, disabled) {
  for (const control of form.elements) control.disabled = disabled;
}

function renderDetail({ refill = false } = {}) {
  const { meeting, agenda = [], attendees = [], quorumChecks = [], minutes = [], resolutions = [] } = state.detail;
  const locked = isMeetingLocked(state.detail);
  byId("detail-title").textContent = meeting.title;
  byId("detail-meta").textContent = [
    KIND_LABELS[meeting.kind] ?? meeting.kind,
    meeting.classId ? `klasa ${meeting.classId}` : null,
    formatBrussels(meeting.scheduledAt),
    meeting.location,
    `status: ${STATUS_LABELS[meeting.status] ?? meeting.status}`,
  ].filter(Boolean).join(" · ");
  byId("locked-note").hidden = !locked;

  if (refill) {
    editForm.elements.title.value = meeting.title;
    editForm.elements.scheduledAt.value = isoToBrusselsLocal(meeting.scheduledAt);
    editForm.elements.location.value = meeting.location ?? "";
    editQuorum.fill(meeting.quorumRule);
    minutesForm.elements.body.value = latestMinutes(minutes)?.body ?? "";
    minutesForm.elements.changeNote.value = "";
  }
  setDisabled(editForm, locked);
  if (!locked) editQuorum.update();

  const transitions = allowedStatusTransitions(meeting.status);
  options(statusForm.elements.status, transitions.map((status) => [status, STATUS_ACTION_LABELS[status]]),
    { placeholder: transitions.length ? "Wybierz" : "Brak dostępnych zmian" });
  setDisabled(statusForm, transitions.length === 0);

  byId("agenda-body").replaceChildren(...(agenda.length ? agenda.map((item) => el("tr", {},
    el("td", { className: "num" }, String(item.position)),
    el("td", {}, item.title),
    el("td", {}, item.description ?? ""),
  )) : [el("tr", {}, el("td", { colspan: "3", className: "muted" }, "Brak punktów."))]));
  setDisabled(agendaForm, locked);

  const summary = summarizeAttendance(attendees);
  byId("attendance-summary").textContent =
    `Wpisów: ${summary.recorded}; obecnych: ${summary.present}; z prawem głosu: ${summary.eligible}; obecnych z prawem głosu: ${summary.presentEligible}.`;
  byId("attendance-body").replaceChildren(...(attendees.length ? attendees.map((attendee) => {
    const reference = attendeeReference(attendee);
    return el("tr", {},
      el("td", { className: "break" }, reference.label),
      el("td", {}, CAPACITY_LABELS[attendee.capacity] ?? attendee.capacity),
      el("td", {}, attendee.present ? "obecna" : "nieobecna"),
      el("td", {}, attendee.votingEligible ? "tak" : "nie"),
      el("td", { className: "row-actions" }, locked ? null : el("button", {
        type: "button", dataset: { attendee: attendee.id }, "aria-label": `Popraw wpis: ${reference.label}`,
      }, "Popraw")),
    );
  }) : [el("tr", {}, el("td", { colspan: "5", className: "muted" }, "Brak wpisów."))]));
  setDisabled(attendanceForm, locked);

  byId("quorum-rule").textContent = `Reguła: ${describeQuorumRule(meeting.quorumRule)}.${meeting.quorumRule.source ? ` Źródło reguły: ${meeting.quorumRule.source}.` : ""}`;
  const latestCheck = quorumChecks.at(-1);
  const result = byId("quorum-result");
  if (latestCheck) {
    const described = describeQuorumCheck(latestCheck);
    result.hidden = false;
    result.className = `result ${described.met ? "met" : "not-met"}`;
    result.replaceChildren(
      el("strong", {}, `${described.headline} (ustalenie z ${formatBrussels(latestCheck.determinedAt)})`),
      el("p", {}, described.detail),
      el("p", { className: "muted" }, described.basis),
    );
  } else {
    result.hidden = true;
    result.replaceChildren();
  }
  const quorumButton = byId("determine-quorum");
  quorumButton.disabled = locked || meeting.status !== "held" || meeting.quorumRule.mode === "not_configured";
  quorumButton.title = meeting.status !== "held" ? "Dostępne dla zebrania oznaczonego jako odbyte" : "";
  byId("quorum-history-wrap").hidden = quorumChecks.length === 0;
  byId("quorum-body").replaceChildren(...[...quorumChecks].reverse().map((check) => el("tr", {},
    el("td", { className: "nowrap" }, formatBrussels(check.determinedAt)),
    el("td", { className: "num" }, String(check.presentEligible)),
    el("td", { className: "num" }, String(check.requiredCount)),
    el("td", {}, check.met ? "osiągnięte" : "nieosiągnięte"),
  )));

  byId("minutes-body").replaceChildren(...(minutes.length ? [...minutes].reverse().map((item) => el("tr", {},
    el("td", { className: "num" }, String(item.version)),
    el("td", {}, MINUTES_STATUS_LABELS[item.status] ?? item.status),
    el("td", { className: "nowrap" }, item.approvedAt ? formatBrussels(item.approvedAt) : "—",
      item.approvalNote ? el("small", {}, item.approvalNote) : null),
    el("td", {}, item.status === "approved" ? VISIBILITY_LABELS[item.visibility] ?? item.visibility : "—"),
    el("td", {}, item.changeNote ?? ""),
    el("td", { className: "row-actions" },
      el("button", { type: "button", dataset: { minutes: item.id, action: "view" }, "aria-label": `Pokaż wersję ${item.version}` }, "Pokaż"),
      canApproveMinutes(item, minutes, meeting)
        ? el("button", { type: "button", dataset: { minutes: item.id, action: "approve" }, "aria-label": `Zatwierdź wersję ${item.version}` }, "Zatwierdź")
        : null,
      item.status === "approved"
        ? el("button", { type: "button", dataset: { minutes: item.id, action: "visibility" }, "aria-label": `Widoczność wersji ${item.version}` }, "Widoczność")
        : null,
    ),
  )) : [el("tr", {}, el("td", { colspan: "6", className: "muted" }, "Brak wersji protokołu."))]));
  setDisabled(minutesForm, meeting.status !== "held");

  const checksById = new Map(quorumChecks.map((check) => [check.id, check]));
  const current = currentResolutions(resolutions);
  byId("resolutions-body").replaceChildren(...(current.length ? current.map((resolution) => {
    const check = checksById.get(resolution.quorumCheckId);
    return el("tr", {},
      el("td", { className: "nowrap" }, resolution.number ?? "—"),
      el("td", {}, resolution.title,
        resolution.amendsResolutionId ? el("small", {}, "Uchwała zmieniająca") : null,
        resolution.correctionReason ? el("small", {}, `Poprawka zapisu: ${resolution.correctionReason}`) : null),
      el("td", {}, RESOLUTION_STATUS_LABELS[resolution.status] ?? resolution.status),
      el("td", { className: "num" }, formatVotes(resolution)),
      el("td", {}, check ? `${check.met ? "osiągnięte" : "nieosiągnięte"} (${check.presentEligible}/${check.requiredCount})` : "—"),
      el("td", { className: "num" }, String(resolution.revision),
        resolution.history.length ? el("small", {}, `wcześniej: ${resolution.history.map((item) => `${item.revision} (${formatVotes(item)})`).join(", ")}`) : null),
      el("td", { className: "row-actions" }, ...resolutionActions(resolution, { locked }).map((action) => el("button", {
        type: "button",
        dataset: { resolution: resolution.id, action },
        "aria-label": `${action === "edit" ? "Edytuj projekt" : "Popraw zapis"}: ${resolution.title}`,
      }, action === "edit" ? "Edytuj" : "Popraw zapis"))),
    );
  }) : [el("tr", {}, el("td", { colspan: "7", className: "muted" }, "Brak uchwał."))]));
  byId("open-resolution").disabled = locked;
}

handleSubmit(editForm, async (data) => {
  const rule = buildQuorumRule(data);
  // API ustawia wszystkie pola reguły naraz, więc zawsze wysyłamy pełną regułę.
  const result = await api(meetingUrl(state.detail.meeting.id), {
    method: "PATCH",
    body: {
      title: data.title.trim(),
      scheduledAt: brusselsLocalToIso(data.scheduledAt),
      location: trimmed(data.location),
      ...rule,
    },
  });
  state.detail.meeting = result.meeting;
  await reloadDetail({ quiet: true, refill: true });
  setMessage(detailMessage, "Dane zebrania zapisane.", "ok");
});

handleSubmit(statusForm, async (data) => {
  await api(meetingUrl(state.detail.meeting.id), { method: "PATCH", body: { status: data.status } });
  await reloadDetail({ quiet: true });
  setMessage(detailMessage, `Status zmieniony: ${STATUS_LABELS[data.status]}.`, "ok");
});

handleSubmit(agendaForm, async (data, form) => {
  const position = trimmed(data.position);
  if (position !== null && !/^\d{1,3}$/.test(position)) throw new Error("Pozycja: podaj liczbę 1–200.");
  await create("agenda", "agenda", meetingUrl(state.detail.meeting.id, "agenda-items"), {
    title: data.title.trim(),
    description: trimmed(data.description),
    ...(position !== null ? { position: Number(position) } : {}),
  });
  form.reset();
  await reloadDetail({ quiet: true });
  setMessage(detailMessage, "Punkt porządku obrad dodany.", "ok");
});

handleSubmit(attendanceForm, async (data, form) => {
  const payload = buildAttendancePayload(data);
  await api(meetingUrl(state.detail.meeting.id, "attendance"), { method: "POST", body: payload });
  form.reset();
  await reloadDetail({ quiet: true });
  setMessage(detailMessage, "Wpis obecności zapisany.", "ok");
});

byId("attendance-body").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-attendee]");
  if (!button) return;
  const attendee = state.detail.attendees.find((item) => item.id === button.dataset.attendee);
  if (!attendee) return;
  const reference = attendeeReference(attendee);
  const elements = attendanceForm.elements;
  elements.personType.value = reference.type;
  elements.personId.value = reference.id;
  elements.capacity.value = attendee.capacity;
  for (const radio of attendanceForm.querySelectorAll("input[type=radio]")) {
    radio.checked = radio.value === String(radio.name === "present" ? attendee.present : attendee.votingEligible);
  }
  elements.personId.focus();
});

byId("determine-quorum").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const errorBox = byId("quorum-error");
  if (button.dataset.busy === "true") return;
  button.dataset.busy = "true";
  button.disabled = true;
  errorBox.textContent = "";
  try {
    await create("quorum", "quorum", meetingUrl(state.detail.meeting.id, "quorum-checks"), {});
    await reloadDetail({ quiet: true });
    setMessage(detailMessage, "Quorum ustalone. Wynik poniżej.", "ok");
  } catch (error) {
    errorBox.textContent = error.message;
    if (error instanceof ApiError && error.status === 409) await reloadDetail({ quiet: true });
  } finally {
    button.dataset.busy = "false";
    if (state.detail) renderDetail();
  }
});

handleSubmit(minutesForm, async (data) => {
  const result = await create("minutes", "minutes", meetingUrl(state.detail.meeting.id, "minutes"), {
    body: data.body,
    changeNote: trimmed(data.changeNote),
  });
  await reloadDetail({ quiet: true, refill: true });
  setMessage(detailMessage, `Zapisano wersję ${result.minutes?.version ?? ""} protokołu (projekt).`, "ok");
});

// ---------- okna dialogowe ----------

function setupDialog(id, slot) {
  const dialog = byId(id);
  const form = dialog.querySelector("form");
  for (const button of dialog.querySelectorAll("[data-close]")) button.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    if (slot) state.keys.delete(slot);
    const errorBox = dialog.querySelector(".form-error");
    if (errorBox) errorBox.textContent = "";
  });
  return { dialog, form };
}

const minutesView = setupDialog("minutes-view-dialog");
const approveDialog = setupDialog("approve-dialog");
const visibilityDialog = setupDialog("visibility-dialog", "visibility");

// „Drukuj / zapisz jako PDF” w oknie podglądu protokołu (#151, #167). Wydruk
// okna <dialog> jest zawodny w przeglądarkach (drukuje się strona pod spodem
// albo tylko widoczna część), więc protokół kopiujemy do zwykłej sekcji
// #print-minutes i dopiero wtedy drukujemy; okno dialogowe samo znika z
// wydruku (shared/print.css: dialog { display: none }).
function fillPrintMinutes(item) {
  const { meeting, attendees = [], quorumChecks = [] } = state.detail;
  const draft = item.status !== "approved";
  mountPrintMeta(byId("print-minutes-meta"), {
    view: `Protokół zebrania — wersja ${item.version}`,
    schoolYear: meeting.schoolYearId,
    printedBy,
    draft,
  });
  byId("print-minutes-title").textContent = meeting.title;
  byId("print-minutes-info").textContent = [
    KIND_LABELS[meeting.kind] ?? meeting.kind,
    meeting.classId ? `klasa ${meeting.classId}` : null,
    formatBrussels(meeting.scheduledAt),
    meeting.location,
  ].filter(Boolean).join(" · ");
  byId("print-attendance-body").replaceChildren(...(attendees.length ? attendees.map((attendee) => el("tr", {},
    el("td", {}, CAPACITY_LABELS[attendee.capacity] ?? attendee.capacity),
    el("td", {}, attendee.present ? "obecna" : "nieobecna"),
    el("td", {}, attendee.votingEligible ? "tak" : "nie"),
    el("td", { className: "signature" }, ""),
  )) : [el("tr", {}, el("td", { colspan: "4", className: "muted" }, "Brak wpisów obecności."))]));
  const latestCheck = quorumChecks.at(-1);
  byId("print-quorum-result").textContent = latestCheck
    ? `Quorum: ${describeQuorumCheck(latestCheck).headline} (${formatBrussels(latestCheck.determinedAt)}).`
    : "Quorum nie zostało ustalone.";
  byId("print-minutes-body").textContent = item.body;
}

let afterPrintCleanup = null;
byId("print-minutes-button").addEventListener("click", () => {
  const item = state.viewingMinutes;
  if (!item || !state.detail) return;
  fillPrintMinutes(item);
  document.body.dataset.printTarget = "minutes";
  afterPrintCleanup = () => { delete document.body.dataset.printTarget; };
  window.addEventListener("afterprint", afterPrintCleanup, { once: true });
  window.print();
});

byId("minutes-body").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-minutes]");
  if (!button) return;
  const item = state.detail.minutes.find((entry) => entry.id === button.dataset.minutes);
  if (!item) return;
  const label = `Wersja ${item.version} · ${MINUTES_STATUS_LABELS[item.status]}`;
  if (button.dataset.action === "view") {
    byId("minutes-view-title").textContent = `Protokół — wersja ${item.version}`;
    byId("minutes-view-body").textContent = item.body;
    state.viewingMinutes = item;
    minutesView.dialog.showModal();
  } else if (button.dataset.action === "approve") {
    approveDialog.form.reset();
    approveDialog.form.elements.minutesId.value = item.id;
    approveDialog.form.querySelector(".context").textContent = label;
    approveDialog.dialog.showModal();
  } else if (button.dataset.action === "visibility") {
    visibilityDialog.form.reset();
    visibilityDialog.form.elements.minutesId.value = item.id;
    visibilityDialog.form.elements.visibility.value = item.visibility;
    const latestApproved = [...state.detail.minutes].filter((entry) => entry.status === "approved").at(-1);
    visibilityDialog.form.querySelector(".context").textContent = latestApproved?.id === item.id
      ? `${label} · obecnie: ${VISIBILITY_LABELS[item.visibility]}`
      : `${label} · obecnie: ${VISIBILITY_LABELS[item.visibility]}. Uwaga: to nie jest najnowsza zatwierdzona wersja, więc nie będzie udostępniana.`;
    visibilityDialog.dialog.showModal();
  }
});

handleSubmit(approveDialog.form, async (data) => {
  await api(meetingUrl(state.detail.meeting.id, "minutes", data.minutesId, "approval"), {
    method: "POST",
    body: { approvalNote: trimmed(data.approvalNote) },
  });
  approveDialog.dialog.close();
  await reloadDetail({ quiet: true });
  setMessage(detailMessage, "Protokół zatwierdzony. Widoczność: wewnętrzny, dopóki jej nie zmienisz.", "ok");
});

handleSubmit(visibilityDialog.form, async (data) => {
  await create("visibility", "visibility", meetingUrl(state.detail.meeting.id, "minutes", data.minutesId, "visibility"), {
    visibility: data.visibility,
    reason: trimmed(data.reason),
  });
  visibilityDialog.dialog.close();
  await reloadDetail({ quiet: true });
  setMessage(detailMessage, `Widoczność protokołu: ${VISIBILITY_LABELS[data.visibility]}.`, "ok");
});

// Nowe zebranie
const meetingDialog = setupDialog("meeting-dialog", "meeting");
const createQuorum = buildQuorumFieldset(meetingDialog.form.querySelector("[data-quorum-fields]"));

byId("open-meeting").addEventListener("click", () => {
  meetingDialog.form.reset();
  createQuorum.fill({});
  meetingDialog.form.elements.schoolYearId.value = state.schoolYearId || yearInput.value.trim();
  meetingDialog.dialog.showModal();
});

handleSubmit(meetingDialog.form, async (data) => {
  const classId = trimmed(data.classId);
  if (data.kind === "class" && !isValidId(classId ?? "")) throw new Error("Zebranie klasowe wymaga identyfikatora klasy.");
  if (data.kind !== "class" && classId) throw new Error("Klasę podaje się tylko dla zebrania klasowego.");
  if (!isValidId(data.schoolYearId)) throw new Error("Podaj poprawny identyfikator roku szkolnego.");
  const result = await create("meeting", "meeting", "/api/meetings", {
    schoolYearId: data.schoolYearId.trim(),
    kind: data.kind,
    ...(classId ? { classId } : {}),
    title: data.title.trim(),
    scheduledAt: brusselsLocalToIso(data.scheduledAt),
    location: trimmed(data.location),
    status: data.status,
    ...buildQuorumRule(data),
  });
  meetingDialog.dialog.close();
  yearInput.value = result.meeting.schoolYearId;
  await loadList();
  await openDetail(result.meeting.id, { focus: true });
  setMessage(detailMessage, "Zebranie utworzone.", "ok");
});

// Uchwały
const resolutionDialog = setupDialog("resolution-dialog", "resolution");
const resolutionForm = resolutionDialog.form;
const quorumSelect = resolutionForm.querySelector("[data-quorum-checks]");
const voteLimit = resolutionForm.querySelector("[data-vote-limit]");

function selectedCheck() {
  return state.detail?.quorumChecks.find((check) => check.id === quorumSelect.value) ?? null;
}

function updateVoteLimit() {
  const check = selectedCheck();
  voteLimit.textContent = check
    ? `Suma głosów nie może przekroczyć ${check.presentEligible} (obecni z prawem głosu w wybranym ustaleniu). Quorum ${check.met ? "osiągnięte" : "nieosiągnięte"}; panel nie ocenia większości.`
    : "Wynik (przyjęta, odrzucona) wymaga ustalenia quorum i wszystkich trzech liczb głosów.";
}
quorumSelect.addEventListener("change", updateVoteLimit);

function openResolutionDialog(mode, resolution = null) {
  resolutionForm.reset();
  resolutionForm.dataset.mode = mode;
  const elements = resolutionForm.elements;
  const checks = [...(state.detail.quorumChecks ?? [])].reverse();
  options(quorumSelect, checks.map((check) => [check.id,
    `${formatBrussels(check.determinedAt)} — ${check.met ? "osiągnięte" : "nieosiągnięte"}, obecni uprawnieni ${check.presentEligible}`]),
  { placeholder: checks.length ? "Nie wskazano" : "Brak ustaleń quorum" });
  elements.resolutionId.value = resolution?.id ?? "";
  elements.number.value = resolution?.number ?? "";
  elements.number.readOnly = mode === "correct";
  elements.title.value = resolution?.title ?? "";
  elements.body.value = resolution?.body ?? "";
  elements.status.value = resolution?.status ?? "draft";
  for (const option of elements.status.options) {
    option.disabled = mode === "correct" && option.value !== "adopted" && option.value !== "rejected";
  }
  for (const key of ["votesFor", "votesAgainst", "votesAbstain"]) elements[key].value = resolution?.[key] ?? "";
  quorumSelect.value = resolution?.quorumCheckId ?? "";
  resolutionForm.querySelector("[data-reason]").hidden = mode !== "correct";
  elements.reason.required = mode === "correct";
  resolutionForm.querySelector("[data-amends]").hidden = mode !== "create";
  const context = resolutionForm.querySelector(".context");
  context.hidden = mode !== "correct";
  context.textContent = mode === "correct"
    ? `Poprawka zapisu tworzy nową rewizję (${resolution.revision + 1}) z tym samym numerem; poprzednia rewizja zostaje w historii.`
    : "";
  byId("resolution-dialog-title").textContent =
    mode === "create" ? "Nowa uchwała" : mode === "edit" ? "Edycja projektu uchwały" : "Poprawka zapisu uchwały";
  updateVoteLimit();
  resolutionDialog.dialog.showModal();
}

byId("open-resolution").addEventListener("click", () => openResolutionDialog("create"));
byId("resolutions-body").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-resolution]");
  if (!button) return;
  const resolution = state.detail.resolutions.find((item) => item.id === button.dataset.resolution);
  if (resolution) openResolutionDialog(button.dataset.action === "edit" ? "edit" : "correct", resolution);
});

handleSubmit(resolutionForm, async (data, form) => {
  const mode = form.dataset.mode;
  const quorumCheck = selectedCheck();
  const { votes } = validateVotes(data, { status: data.status, quorumCheck });
  const number = trimmed(data.number);
  if (data.status === "adopted" && !number) throw new Error("Uchwała przyjęta wymaga numeru.");
  const meetingId = state.detail.meeting.id;
  const common = { title: data.title.trim(), body: data.body.trim(), status: data.status, quorumCheckId: quorumCheck?.id ?? null };

  if (mode === "create") {
    let amendsResolutionId = null;
    const amendsNumber = trimmed(data.amendsNumber);
    if (amendsNumber) {
      const params = new URLSearchParams({ schoolYearId: state.detail.meeting.schoolYearId, number: amendsNumber });
      const found = await api(`/api/meetings/resolutions/lookup?${params}`).catch((error) => {
        if (error instanceof ApiError && error.status === 404) throw new Error(`Nie znaleziono przyjętej uchwały nr ${amendsNumber} w tym roku szkolnym.`);
        throw error;
      });
      amendsResolutionId = found.resolution.id;
    }
    await create("resolution", "resolution", meetingUrl(meetingId, "resolutions"), {
      ...common, ...votes, number, ...(amendsResolutionId ? { amendsResolutionId } : {}),
    });
  } else if (mode === "edit") {
    await api(meetingUrl(meetingId, "resolutions", data.resolutionId), {
      method: "PATCH",
      body: { ...common, ...votes, number },
    });
  } else {
    await create("resolution", "correction", meetingUrl(meetingId, "resolutions", data.resolutionId, "corrections"), {
      ...common, ...votes, reason: data.reason.trim(),
    });
  }
  resolutionDialog.dialog.close();
  await reloadDetail({ quiet: true });
  setMessage(detailMessage, mode === "correct" ? "Zapisano poprawkę zapisu uchwały." : "Uchwała zapisana.", "ok");
});

// ---------- start ----------

// #167: tryb widoku zależy od GET /api/access, sprawdzany RAZ przed pierwszym
// żądaniem listy — przedstawiciel bez roli READ_ROLES nigdy nie woła
// GET /api/meetings (kończyłoby się to 403, zob. src/pg/meetings.js READ_ROLES).
byId("open-meeting").hidden = true;
byId("list-section").hidden = true;
byId("shared-section").hidden = true;

const initial = new URLSearchParams(location.search);
const hasInitialYear = isValidId(initial.get("rok") ?? "");
if (hasInitialYear) yearInput.value = initial.get("rok");

api("/api/access").then(
  (access) => {
    const grants = access?.grants;
    state.canManage = canManageMeetings(grants);
    applyViewMode(meetingsViewMode(grants));
    if (!hasInitialYear) return;
    if (state.viewMode === "shared") {
      loadSharedList();
    } else if (state.viewMode === "full") {
      loadList().then(() => {
        const meetingId = initial.get("zebranie");
        if (meetingId && isValidId(meetingId)) openDetail(meetingId);
      });
    }
  },
  () => {
    // Sesja przed MFA lub błąd sieci: pokaż pełny widok jak dotychczas —
    // serwer i tak odrzuci każde żądanie zapisu/odczytu bez uprawnień.
    state.canManage = false;
    applyViewMode("full");
    if (hasInitialYear) loadList();
  },
);
