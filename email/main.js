import {
  AUDIENCE_LABELS,
  STATUS_LABELS,
  buildCampaignsUrl,
  campaignStatusLabel,
  describeProviderPause,
  describeWorkerStatus,
  campaignActionUrl,
  campaignUrl,
  canOfferApproval,
  describeApiError,
  formatDayPlan,
  formatExclusions,
  formatReportRows,
  isSnapshotStale,
  formatSchedule,
  formatWarnings,
  hasApproverAccess,
  hasEditorAccess,
  isLikelyOwnCampaign,
  isValidId,
  makeIdempotencyKey,
  maskEmail,
  scheduleTimezone,
  sendNotBeforeFromInput,
  sendNotBeforeToInput,
} from "./core.js";
import { api as apiRequest } from "../shared/api.js";
import { mountShell } from "../shared/shell.js";
import "../shared/shell.css";
import { confirmAction } from "../shared/confirm-dialog.js";
import { fillYearSelect, selectYearValue } from "../shared/school-year.js";
import { mountSuppressions } from "./suppressions.js";
import { mountResolutions } from "./resolutions.js";
import { reportCsvUrl } from "./resolutions-core.js";

mountShell();

const api = apiRequest;
const byId = (id) => document.getElementById(id);
const suppressions = mountSuppressions({ api });

const state = {
  schoolYearId: "",
  campaigns: [],
  campaignsCursor: null,
  selectedId: null,
  detail: null,
  preview: null,
  report: null,
  recipients: [],
  recipientsCursor: null,
  actorId: null,
  grants: [],
  requestKey: null,
  loading: false,
  providerPause: null,
};

const resolutions = mountResolutions({
  api,
  isBoard: () => hasApproverAccess(state.grants, state.schoolYearId),
  // Po zapisie wyniku odświeżamy wyłącznie raport (liczby), nie całą kartę.
  onResolved: async () => {
    if (!state.selectedId) return;
    state.report = await api(campaignActionUrl(state.selectedId, "report")).catch(() => state.report);
    renderDetail();
  },
});

const filtersForm = byId("filters-form");
const yearInput = byId("school-year-id");
const message = byId("message");
const listBody = byId("campaigns-body");
const detailSection = byId("detail");

function setMessage(text, isError = false) {
  message.textContent = text;
  message.className = isError ? "message error" : "message";
}

function textCell(value, className = "") {
  const cell = document.createElement("td");
  cell.textContent = value;
  if (className) cell.className = className;
  return cell;
}

function campaignRow(campaign) {
  const row = document.createElement("tr");
  row.append(
    textCell(campaign.title),
    textCell(AUDIENCE_LABELS[campaign.audience] ?? campaign.audience),
    (() => {
      const cell = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = `badge status-${campaign.status}`;
      badge.textContent = STATUS_LABELS[campaign.status] ?? campaign.status;
      cell.append(badge);
      return cell;
    })(),
    textCell(campaign.recipientsCount ?? "—", "amount"),
  );
  const actions = document.createElement("td");
  actions.className = "row-actions";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Otwórz";
  button.addEventListener("click", () => openDetail(campaign.id));
  actions.append(button);
  row.append(actions);
  return row;
}

function renderList() {
  listBody.replaceChildren(...state.campaigns.map(campaignRow));
  const count = state.campaigns.length;
  byId("campaigns-count").textContent = count === 1 ? "1 kampania" : `${count} kampanii`;
  byId("campaigns-table").hidden = count === 0;
  byId("campaigns-empty").hidden = count !== 0;
}

async function loadList({ append = false } = {}) {
  const url = buildCampaignsUrl(state.schoolYearId, append ? state.campaignsCursor : '');
  const data = await api(url);
  const items = Array.isArray(data.campaigns) ? data.campaigns : [];
  state.campaigns = append ? [...state.campaigns, ...items] : items;
  state.campaignsCursor = data.nextCursor ?? null;
  byId("campaigns-more").hidden = !state.campaignsCursor;
  renderList();
}

function setBusy(busy) {
  state.loading = busy;
  filtersForm.querySelector("button").disabled = busy;
}

// --- pauza konta dostawcy (#209) ---------------------------------------------

function renderProviderPause() {
  const pause = state.providerPause;
  byId("provider-pause").hidden = !pause;
  if (!pause) return;
  byId("provider-pause-text").textContent = describeProviderPause(pause);
  const approver = hasApproverAccess(state.grants, state.schoolYearId);
  byId("provider-pause-lift").hidden = !approver;
  byId("provider-pause-board-only").hidden = approver;
}

async function loadProviderPause() {
  const data = await api(`/api/email/provider-pause?schoolYearId=${encodeURIComponent(state.schoolYearId)}`);
  state.providerPause = data?.pause ?? null;
  renderProviderPause();
}

byId("provider-pause-lift").addEventListener("click", async () => {
  const pause = state.providerPause;
  if (!pause) return;
  const confirmed = await confirmAction({
    title: "Potwierdzić naprawę konta dostawcy?",
    effects: [
      "Najbliższy przebieg zadania wznowi wysyłkę wszystkich kampanii w toku.",
      "Jeśli klucz lub nadawca nadal są błędne, wysyłka zatrzyma się ponownie po pierwszej próbie.",
    ],
    confirmLabel: "Potwierdź naprawę",
    cancelLabel: "Wróć",
  });
  if (!confirmed) return;
  const button = byId("provider-pause-lift");
  button.disabled = true;
  try {
    await api("/api/email/provider-pause/lift", {
      method: "POST",
      body: JSON.stringify({ schoolYearId: state.schoolYearId, pauseId: pause.id }),
    });
    await loadProviderPause();
    if (state.selectedId) await openDetail(state.selectedId);
    setMessage("Naprawa potwierdzona. Wysyłka zostanie wznowiona przy najbliższym przebiegu zadania.");
  } catch (error) {
    setMessage(`Nie udało się potwierdzić naprawy: ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
});

// --- alarm „brak przebiegów” zadania wysyłki (#130) ---------------------------

function renderWorkerStatus(status) {
  const view = describeWorkerStatus(status);
  byId("worker-status").hidden = !view;
  const list = byId("worker-status-alarms");
  list.replaceChildren();
  if (!view) return;
  for (const line of view.lines) {
    const item = document.createElement("li");
    item.textContent = line;
    list.append(item);
  }
  byId("worker-status-details").textContent = view.details;
}

async function loadWorkerStatus() {
  const data = await api(`/api/email/worker-status?schoolYearId=${encodeURIComponent(state.schoolYearId)}`);
  renderWorkerStatus(data?.workerStatus ?? null);
}

// Wczytuje listę dla podanego roku; używane zarówno przy ręcznym „Pokaż”, jak i
// przy wypełnieniu domyślnym rokiem po wejściu na panel (puste ekrany bez akcji).
// Wczytuje wyłącznie listę już zaplanowanych/wysłanych kampanii — nic tu nie
// wysyła żadnej wiadomości.
async function showYear(value) {
  if (!isValidId(value)) { setMessage("Podaj poprawny identyfikator roku szkolnego.", true); return; }
  setMessage("");
  selectYearValue(yearInput, value);
  setBusy(true);
  try {
    state.schoolYearId = value;
    await loadList();
    detailSection.hidden = true;
    state.selectedId = null;
    await suppressions.load(value);
    await loadProviderPause().catch(() => { state.providerPause = null; renderProviderPause(); });
    await loadWorkerStatus().catch(() => renderWorkerStatus(null));
  } catch (error) {
    setMessage(`Nie udało się pobrać listy kampanii: ${error.message}`, true);
  } finally {
    setBusy(false);
  }
}

byId("campaigns-more").addEventListener("click", async () => {
  setBusy(true);
  try {
    await loadList({ append: true });
  } catch (error) {
    setMessage(`Nie udało się pobrać kolejnych kampanii: ${error.message}`, true);
  } finally {
    setBusy(false);
  }
});

filtersForm.addEventListener("submit", (event) => {
  event.preventDefault();
  showYear(yearInput.value.trim());
});

// --- szczegóły kampanii -----------------------------------------------------

function renderDetail() {
  const { detail, preview } = state;
  if (!detail) return;
  const campaign = detail.campaign;
  byId("detail-title").textContent = campaign.title;
  byId("detail-status").textContent = campaignStatusLabel(campaign, detail.providerPause);
  byId("detail-status").className = `badge status-${campaign.status}`;
  byId("detail-audience").textContent = AUDIENCE_LABELS[campaign.audience] ?? campaign.audience;
  byId("detail-subject").textContent = campaign.subject;
  byId("detail-body").textContent = campaign.bodyText;

  const exclusionsList = byId("detail-exclusions");
  const exclusionLines = preview ? formatExclusions(preview.exclusions) : [];
  exclusionsList.replaceChildren(...exclusionLines.map((line) => {
    const item = document.createElement("li");
    item.textContent = line;
    return item;
  }));
  byId("detail-exclusions-empty").hidden = exclusionLines.length !== 0;

  byId("detail-recipients-count").textContent = preview ? String(preview.recipientsCount) : "—";
  byId("detail-plan").textContent = preview ? formatDayPlan(preview.plan) : "Utwórz migawkę odbiorców, aby zobaczyć plan wysyłki.";
  byId("detail-schedule").textContent = preview?.schedule ? formatSchedule(preview.schedule) : "";
  byId("detail-snapshot-current").hidden = !isSnapshotStale(preview);

  const warningsList = byId("detail-warnings");
  const warnings = preview ? formatWarnings(preview.warnings) : [];
  warningsList.replaceChildren(...warnings.map((text) => {
    const item = document.createElement("li");
    item.textContent = text;
    return item;
  }));
  byId("detail-warnings-box").hidden = warnings.length === 0;

  const outboxList = byId("detail-outbox");
  const outboxEntries = Object.entries(detail.outbox ?? {});
  outboxList.replaceChildren(...outboxEntries.map(([stateName, n]) => {
    const item = document.createElement("li");
    item.textContent = `${stateName}: ${n}`;
    return item;
  }));
  byId("detail-outbox-box").hidden = outboxEntries.length === 0;

  const report = state.report;
  byId("detail-report-box").hidden = !report;
  if (report) {
    byId("detail-report-body").replaceChildren(...formatReportRows(report.summary).map((row) => {
      const tr = document.createElement("tr");
      tr.append(textCell(row.label), textCell(String(row.count), "amount"));
      return tr;
    }));
    const unresolved = Number(report.deliveryUnknownUnresolved) || 0;
    const note = byId("detail-report-unknown");
    note.hidden = unresolved === 0;
    note.textContent = `Nierozstrzygnięte „nie wiadomo”: ${unresolved}.`;
    byId("detail-report-csv").href = reportCsvUrl(campaign.id);
  }

  updateActionVisibility(campaign, preview);
}

function updateActionVisibility(campaign, preview) {
  const editable = ["draft", "approved"].includes(campaign.status);
  byId("edit-campaign").hidden = !editable;
  byId("build-snapshot").hidden = !editable;
  byId("view-recipients").hidden = !campaign.recipientsHash;

  const readyForApproval = canOfferApproval(campaign, state.actorId)
    && preview && preview.recipientsCount > 0 && !isSnapshotStale(preview);
  const own = isLikelyOwnCampaign(campaign, state.actorId);
  const approveButton = byId("approve-campaign");
  const waitingNotice = byId("approve-waiting");
  const canSeeApprove = hasApproverAccess(state.grants, state.schoolYearId);
  approveButton.hidden = !canSeeApprove || campaign.status !== "draft" || !preview || own;
  approveButton.disabled = !readyForApproval;
  waitingNotice.hidden = !(canSeeApprove && campaign.status === "draft" && own);

  byId("queue-campaign").hidden = campaign.status !== "approved";
  byId("pause-campaign").hidden = campaign.status !== "sending";
  byId("resume-campaign").hidden = campaign.status !== "paused";
  byId("cancel-campaign").hidden = !["draft", "approved", "sending", "paused"].includes(campaign.status);
}

async function openDetail(id) {
  setMessage("");
  try {
    const [statusData, previewData, reportData] = await Promise.all([
      api(campaignUrl(id)),
      api(campaignActionUrl(id, "preview")).catch(() => null),
      api(campaignActionUrl(id, "report")).catch(() => null),
    ]);
    state.report = reportData;
    state.selectedId = id;
    resolutions.reset(id);
    state.detail = statusData;
    state.preview = previewData;
    state.recipients = [];
    state.recipientsCursor = null;
    detailSection.hidden = false;
    renderDetail();
    detailSection.scrollIntoView({ block: "start" });
    byId("detail-title").tabIndex = -1;
    byId("detail-title").focus();
  } catch (error) {
    setMessage(`Nie udało się otworzyć kampanii: ${error.message}`, true);
  }
}

async function refreshDetail() {
  if (state.selectedId) await openDetail(state.selectedId);
  await loadList().catch(() => {});
}

// --- formularze i okna -------------------------------------------------------

function configureDialog(id, prefix, submit, successText) {
  const dialog = byId(id);
  const form = dialog.querySelector("form");
  const errorBox = form.querySelector(".form-error");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (event.submitter?.value === "cancel") { dialog.close(); return; }
    if (!form.reportValidity()) return;
    const button = event.submitter;
    button.disabled = true;
    errorBox.textContent = "";
    state.requestKey ||= makeIdempotencyKey(prefix);
    try {
      await submit(new FormData(form), state.requestKey);
      state.requestKey = null;
      dialog.close();
      form.reset();
      await refreshDetail();
      setMessage(successText);
    } catch (error) {
      errorBox.textContent = error.code === "idempotency_conflict"
        ? `${error.message} Zamknij okno i sprawdź stan kampanii, zanim spróbujesz ponownie.`
        : error.message;
      if (error.code === "revision_conflict") {
        // #215: ktoś zmienił kampanię w międzyczasie. Nic nie zapisujemy po
        // cichu; użytkownik wczytuje aktualną wersję i sam poprawia jeszcze raz.
        errorBox.textContent = "Ktoś zmienił tę kampanię w międzyczasie. Wczytaj ponownie, sprawdź zmiany i dopiero wtedy zapisz swoje. ";
        const reload = document.createElement("button");
        reload.type = "button";
        reload.textContent = "Wczytaj ponownie";
        reload.addEventListener("click", async () => {
          reload.disabled = true;
          dialog.close();
          await refreshDetail();
          if (state.detail?.campaign && id === "edit-dialog") byId("edit-campaign").click();
        });
        errorBox.append(reload);
      }
    } finally {
      button.disabled = false;
    }
  });
  dialog.addEventListener("close", () => { errorBox.textContent = ""; state.requestKey = null; });
  return { dialog, form };
}

const createDialog = configureDialog("create-dialog", "email-create", async (data, key) => {
  await api("/api/email/campaigns", {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify({
      schoolYearId: state.schoolYearId,
      title: String(data.get("title")),
      audience: String(data.get("audience")),
      subject: String(data.get("subject")),
      bodyText: String(data.get("bodyText")),
    }),
  });
}, "Utworzono szkic kampanii.");

const editDialog = configureDialog("edit-dialog", "email-edit", async (data) => {
  const id = state.selectedId;
  // Pole terminu wysyłamy tylko po zmianie: pozostawione bez zmian nie może
  // cofać zatwierdzenia przez zaokrąglenie sekund.
  const rawStart = String(data.get("sendNotBefore") ?? "");
  const startChanged = rawStart !== (editDialog.form.dataset.initialSendNotBefore ?? "");
  const schedulePart = startChanged
    ? { sendNotBefore: sendNotBeforeFromInput(rawStart, scheduleTimezone(state.preview?.schedule)) }
    : {};
  const result = await api(campaignUrl(id), {
    method: "PUT",
    body: JSON.stringify({
      ...schedulePart,
      // #215: wersja kampanii widziana w chwili otwarcia okna edycji.
      revision: Number(editDialog.form.dataset.revision),
      title: String(data.get("title")),
      audience: String(data.get("audience")),
      subject: String(data.get("subject")),
      bodyText: String(data.get("bodyText")),
    }),
  });
  if (result.approvalInvalidated) setMessage("Zapisano zmiany. Zatwierdzenie zostało cofnięte — treść wymaga ponownej zgody.");
}, "Zapisano zmiany szkicu.");

byId("open-create").addEventListener("click", () => {
  if (!state.schoolYearId) return;
  createDialog.dialog.showModal();
});

byId("edit-campaign").addEventListener("click", () => {
  const campaign = state.detail.campaign;
  const form = editDialog.form;
  form.elements.title.value = campaign.title;
  // #113: szkic z zawiadomienia o zebraniu ma odbiorców wynikających z zebrania — bez zmiany ręcznej.
  const select = form.elements.audience;
  if (![...select.options].some((option) => option.value === campaign.audience)) {
    select.append(new Option(AUDIENCE_LABELS[campaign.audience] ?? campaign.audience, campaign.audience));
  }
  select.value = campaign.audience;
  for (const option of select.options) option.disabled = Boolean(campaign.meetingNoticeId) && option.value !== campaign.audience;
  form.elements.subject.value = campaign.subject;
  form.elements.bodyText.value = campaign.bodyText;
  form.dataset.revision = String(campaign.revisionNo ?? "");
  const initialStart = sendNotBeforeToInput(campaign.sendNotBefore, scheduleTimezone(state.preview?.schedule));
  form.elements.sendNotBefore.value = initialStart;
  form.dataset.initialSendNotBefore = initialStart;
  editDialog.dialog.showModal();
});

byId("build-snapshot").addEventListener("click", async () => {
  const button = byId("build-snapshot");
  button.disabled = true;
  try {
    const result = await api(campaignActionUrl(state.selectedId, "snapshot"), { method: "POST" });
    await refreshDetail();
    setMessage(result.approvalInvalidated
      ? `Migawka odbiorców utworzona (${result.recipientsCount}). Poprzednie zatwierdzenie zostało cofnięte.`
      : `Migawka odbiorców utworzona (${result.recipientsCount}).`);
  } catch (error) {
    setMessage(`Nie udało się utworzyć migawki: ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
});

// --- odbiorcy (maskowane domyślnie, pełny adres po kliknięciu) --------------

const recipientsDialog = byId("recipients-dialog");
const recipientsBody = byId("recipients-body");

function recipientRow(entry) {
  const row = document.createElement("tr");
  row.append(textCell(entry.householdId));
  const emailCell = document.createElement("td");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "reveal";
  button.textContent = maskEmail(entry.email);
  button.dataset.revealed = "false";
  button.setAttribute("aria-label", `Pokaż pełny adres dla rodziny ${entry.householdId}`);
  button.addEventListener("click", () => {
    const revealed = button.dataset.revealed === "true";
    button.textContent = revealed ? maskEmail(entry.email) : entry.email;
    button.dataset.revealed = revealed ? "false" : "true";
  });
  emailCell.append(button);
  row.append(emailCell);
  return row;
}

async function loadRecipients({ append = false } = {}) {
  // #159: kursor keyset z poprzedniej odpowiedzi zamiast przesunięcia (OFFSET).
  const url = new URL(campaignActionUrl(state.selectedId, "recipients"), window.location.origin);
  if (append && state.recipientsCursor) url.searchParams.set("cursor", state.recipientsCursor);
  const data = await api(`${url.pathname}${url.search}`);
  const items = Array.isArray(data.recipients) ? data.recipients : [];
  state.recipients = append ? [...state.recipients, ...items] : items;
  state.recipientsCursor = data.nextCursor || null;
  recipientsBody.replaceChildren(...state.recipients.map(recipientRow));
  byId("recipients-load-more").hidden = !data.nextCursor;
  byId("recipients-count").textContent = `${state.recipients.length} wczytanych${data.nextCursor ? ", są kolejne" : " — to wszyscy"}`;
}

byId("view-recipients").addEventListener("click", async () => {
  try {
    await loadRecipients();
    recipientsDialog.showModal();
  } catch (error) {
    setMessage(`Nie udało się wczytać listy odbiorców: ${error.message}`, true);
  }
});
byId("recipients-load-more").addEventListener("click", () => loadRecipients({ append: true }).catch(() => {}));
byId("recipients-close").addEventListener("click", () => recipientsDialog.close());

// --- zatwierdzenie, kolejka, anulowanie --------------------------------------

byId("approve-campaign").addEventListener("click", async () => {
  const button = byId("approve-campaign");
  button.disabled = true;
  const campaign = state.detail.campaign;
  try {
    await api(campaignActionUrl(state.selectedId, "approve"), {
      method: "POST",
      body: JSON.stringify({ contentHash: campaign.contentHash, recipientsHash: campaign.recipientsHash }),
    });
    await refreshDetail();
    setMessage("Kampania zatwierdzona.");
  } catch (error) {
    setMessage(`Nie udało się zatwierdzić: ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
});

byId("queue-campaign").addEventListener("click", async () => {
  const button = byId("queue-campaign");
  button.disabled = true;
  try {
    const result = await api(campaignActionUrl(state.selectedId, "queue"), { method: "POST" });
    await refreshDetail();
    setMessage(`Zakolejkowano ${result.queued} wiadomości. Wysyła je wyłącznie zadanie email-worker.`);
  } catch (error) {
    setMessage(`Nie udało się zakolejkować: ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
});

// Wstrzymanie i wznowienie: przejścia stanu z audytem po stronie serwera,
// idempotentne (drugie kliknięcie nie tworzy nowego zdarzenia).
for (const [buttonId, action, done] of [
  ["pause-campaign", "pause", "Wysyłka wstrzymana. Wiadomość, której wysyłka już trwa, zostanie dokończona."],
  ["resume-campaign", "resume", "Wysyłka wznowiona."],
]) {
  byId(buttonId).addEventListener("click", async () => {
    const button = byId(buttonId);
    button.disabled = true;
    try {
      await api(campaignActionUrl(state.selectedId, action), { method: "POST" });
      await refreshDetail();
      setMessage(done);
    } catch (error) {
      setMessage(`Nie udało się zmienić stanu wysyłki: ${error.message}`, true);
    } finally {
      button.disabled = false;
    }
  });
}

byId("cancel-campaign").addEventListener("click", async () => {
  const confirmed = await confirmAction({
    title: "Anulować kampanię?",
    effects: [`Kampania „${state.detail.campaign.title}”.`, "Zakolejkowane wiadomości nie zostaną wysłane."],
    confirmLabel: "Anuluj kampanię",
    cancelLabel: "Wróć",
    destructive: true,
  });
  if (!confirmed) return;
  const button = byId("cancel-campaign");
  button.disabled = true;
  try {
    const result = await api(campaignActionUrl(state.selectedId, "cancel"), { method: "POST" });
    await refreshDetail();
    setMessage(`Kampania anulowana. Cofnięto ${result.cancelledMessages} wiadomości w kolejce.`);
  } catch (error) {
    setMessage(`Nie udało się anulować: ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
});

// --- dostęp -------------------------------------------------------------------

async function applyAccess() {
  let access;
  let session;
  try {
    [access, session] = await Promise.all([api("/api/access"), api("/api/session")]);
  } catch (error) {
    setMessage(error.message, true);
    return;
  }
  state.grants = Array.isArray(access.grants) ? access.grants : [];
  state.actorId = session?.user?.id ?? null;
  if (!hasEditorAccess(state.grants)) {
    byId("open-create").hidden = true;
    filtersForm.closest("section").hidden = true;
    const notice = byId("access-notice");
    notice.textContent = access.mfaRequired === true
      ? describeApiError(403, "mfa_required")
      : describeApiError(403, "forbidden");
    notice.hidden = false;
    return;
  }
  // Rok domyślny: najnowszy z przydziałów, awaryjnie heurystyka daty
  // (shared/school-year.js) — panel ładuje listę bez klikania „Pokaż”.
  await showYear(fillYearSelect(yearInput, state.grants));
}
applyAccess();
