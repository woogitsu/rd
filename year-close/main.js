import {
  CHECKLIST_ITEMS,
  CHECKLIST_ITEM_LABELS,
  STATUS_LABELS,
  YEAR_END_DISCREPANCY_REASONS,
  YEAR_END_DISCREPANCY_REASON_LABELS,
  accessReviewSummary,
  canOfferClose,
  canOfferStart,
  checklistProgress,
  checklistUrl,
  closeRequestBody,
  closeUrl,
  describeApiError,
  handoverUrl,
  hasChecklistAccess,
  hasCloseAccess,
  hasReadAccess,
  isLikelyOwnClosure,
  isValidId,
  needsYearEndConfirmation,
  startConfirmation,
  startUrl,
  statusUrl,
  warningRows,
  yearEndCheckRows,
} from "./core.js";
import { formatEur } from "../panel/money.js";
import { api as apiRequest } from "../shared/api.js";
import { confirmAction } from "../shared/confirm-dialog.js";
import { fillYearSelect, selectYearValue, formatSchoolYear } from "../shared/school-year.js";
import { mountShell } from "../shared/shell.js";
import "../shared/shell.css";

mountShell();

const api = apiRequest;
const byId = (id) => document.getElementById(id);

const state = {
  schoolYearId: "",
  status: null,
  actorId: null,
  grants: [],
  checklistItem: null,
};

const filtersForm = byId("filters-form");
const yearInput = byId("school-year-id");
const message = byId("message");
const statusSection = byId("status-section");

function setMessage(text, isError = false) {
  message.textContent = text;
  message.className = isError ? "message error" : "message";
}

async function loadStatus(schoolYearId) {
  const data = await api(statusUrl(schoolYearId));
  state.schoolYearId = schoolYearId;
  state.status = data;
  statusSection.hidden = false;
  render();
}

function render() {
  const status = state.status;
  if (!status) return;

  byId("status-badge").textContent = STATUS_LABELS[status.status] ?? status.status;
  byId("status-badge").className = `badge status-${status.status}`;
  byId("initiated-by").textContent = status.initiatedBy ?? "—";
  byId("initiated-at").textContent = status.initiatedAt ? new Date(status.initiatedAt).toLocaleString("pl-PL") : "—";
  byId("closed-by").textContent = status.closedBy ?? "—";
  byId("closed-at").textContent = status.closedAt ? new Date(status.closedAt).toLocaleString("pl-PL") : "—";
  byId("next-year").textContent = status.nextSchoolYearId ?? "—";

  const balance = status.balance ?? {};
  byId("balance-source").textContent = balance.source === "closed" ? "zamknięty" : "bieżący, na żywo";
  byId("bal-opening").textContent = formatEur(balance.openingBalanceCents);
  byId("bal-income").textContent = formatEur(balance.incomeCents);
  byId("bal-expense").textContent = formatEur(balance.expenseCents);
  byId("bal-closing").textContent = formatEur(balance.closingBalanceCents);
  byId("bal-cash").textContent = formatEur(balance.closingCashCents);
  byId("bal-bank").textContent = formatEur(balance.closingBankCents);

  renderYearEndCheck(status);
  renderChecklist(status);
  renderWarnings(status);
  renderAccessReview(status);

  byId("open-start").hidden = !canOfferStart(status, state.grants, state.schoolYearId);

  const canClose = hasCloseAccess(state.grants, state.schoolYearId);
  const own = isLikelyOwnClosure(status, state.actorId);
  const closeButton = byId("open-close");
  closeButton.hidden = !canClose || status.status !== "closing" || own;
  closeButton.disabled = !canOfferClose(status, state.actorId);
  byId("close-waiting").hidden = !(canClose && status.status === "closing" && own);

  byId("open-handover").hidden = status.status === "open";
}

function renderChecklist(status) {
  const body = byId("checklist-body");
  const byItem = new Map((status.checklist ?? []).map((entry) => [entry.item, entry]));
  const canConfirm = hasChecklistAccess(state.grants, state.schoolYearId) && status.status === "closing";
  body.replaceChildren(...CHECKLIST_ITEMS.map((item) => {
    const entry = byItem.get(item) ?? { confirmed: false };
    const row = document.createElement("tr");

    const labelCell = document.createElement("td");
    labelCell.textContent = CHECKLIST_ITEM_LABELS[item] ?? item;
    row.append(labelCell);

    const stateCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `badge ${entry.confirmed ? "status-approved" : "status-draft"}`;
    badge.textContent = entry.confirmed ? "Potwierdzone" : "Do potwierdzenia";
    stateCell.append(badge);
    row.append(stateCell);

    row.append(textCell(entry.confirmedBy ?? "—"));
    row.append(textCell(entry.note ?? "—"));

    const actionsCell = document.createElement("td");
    actionsCell.className = "row-actions";
    if (!entry.confirmed && canConfirm) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Potwierdź";
      button.addEventListener("click", () => openChecklistDialog(item));
      actionsCell.append(button);
    }
    row.append(actionsCell);
    return row;
  }));
  const progress = checklistProgress(status);
  byId("checklist-progress").textContent = `${progress.confirmed}/${progress.total}`;
}

// #169: bilans zamknięcia vs saldo księgi na ostatni dzień roku (serwer liczy
// oba niezależnie). Rozbieżność nie blokuje przycisku — serwer wymaga wtedy
// potwierdzenia z powodem w oknie zamknięcia.
function renderYearEndCheck(status) {
  const view = yearEndCheckRows(status);
  const summary = byId("year-end-summary");
  byId("year-end-wrap").hidden = !view;
  if (!view) {
    summary.textContent = "Kontrola salda końca roku niedostępna w tej wersji API.";
    byId("year-end-body").replaceChildren();
    return;
  }
  summary.textContent = view.ok
    ? "Zgodne: bilans zamknięcia równa się saldu księgi na ostatni dzień roku (kontrola bieżąca, liczona przez serwer)."
    : "Niezgodne: bilans zamknięcia różni się od salda księgi na ostatni dzień roku. Sprawdź wpisy datowane po końcu roku (raport Komisji Rewizyjnej, kontrola dat). Zamknięcie wymaga potwierdzenia rozbieżności z powodem.";
  byId("year-end-body").replaceChildren(...view.rows.map((entry) => {
    const row = document.createElement("tr");
    row.append(textCell(entry.label));
    for (const cents of [entry.closingCents, entry.atYearEndCents, entry.differenceCents]) {
      const cell = textCell(cents === null ? "—" : formatEur(cents));
      cell.className = "amount";
      row.append(cell);
    }
    return row;
  }));
}

function renderWarnings(status) {
  const rows = warningRows(status);
  byId("warnings-empty").hidden = rows.length > 0;
  byId("warnings-body").replaceChildren(...rows.map((entry) => {
    const row = document.createElement("tr");
    row.append(textCell(entry.label));
    const count = textCell(String(entry.count));
    count.className = "amount";
    const amount = textCell(entry.amountCents === null ? "—" : formatEur(entry.amountCents));
    amount.className = "amount";
    row.append(count, amount);
    return row;
  }));
}

function renderAccessReview(status) {
  const summary = accessReviewSummary(status);
  const body = byId("access-review-body");
  if (!summary) {
    byId("access-review-summary").textContent = "—";
    body.replaceChildren();
    return;
  }
  byId("access-review-summary").textContent = `Odczyty w roku: ${summary.total}. Odczyty bez ważnego przydziału w chwili odczytu: ${summary.withoutValidGrant}. Aktywne przydziały do wygaszenia przy zamknięciu: ${summary.activeGrants}.`;
  body.replaceChildren(...summary.byKind.map((entry) => {
    const row = document.createElement("tr");
    row.append(textCell(entry.label));
    const hits = textCell(String(entry.hits));
    hits.className = "amount";
    const actors = textCell(String(entry.actors));
    actors.className = "amount";
    row.append(hits, actors);
    return row;
  }));
}

function textCell(value) {
  const cell = document.createElement("td");
  cell.textContent = value;
  return cell;
}

// Wczytuje stan dla podanego roku; używane zarówno przy ręcznym „Pokaż”, jak i
// przy wypełnieniu domyślnym rokiem po wejściu na panel (puste ekrany bez akcji).
async function showYear(value) {
  if (!isValidId(value)) { setMessage("Podaj poprawny identyfikator roku szkolnego.", true); return; }
  setMessage("");
  selectYearValue(yearInput, value);
  try {
    await loadStatus(value);
  } catch (error) {
    setMessage(`Nie udało się pobrać stanu zamknięcia: ${error.message}`, true);
  }
}

filtersForm.addEventListener("submit", (event) => {
  event.preventDefault();
  showYear(yearInput.value.trim());
});

async function refreshStatus() {
  if (state.schoolYearId) await loadStatus(state.schoolYearId).catch(() => {});
}

// --- rozpoczęcie zamknięcia (nieodwracalne — okno <dialog>, bez window.confirm) ---

const startDialog = byId("start-dialog");
byId("open-start").addEventListener("click", () => {
  byId("start-error").textContent = "";
  startDialog.showModal();
});
startDialog.querySelector("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") { startDialog.close(); return; }
  const form = event.target;
  if (!form.reportValidity()) return;
  const nextSchoolYearId = String(new FormData(form).get("nextSchoolYearId")).trim();
  const button = event.submitter;
  // Nieodwracalne: osobne okno potwierdzenia z opisem skutków (shared/confirm-dialog.js).
  if (!(await confirmAction(startConfirmation(state.schoolYearId, nextSchoolYearId)))) return;
  button.disabled = true;
  const errorBox = byId("start-error");
  errorBox.textContent = "";
  try {
    await api(startUrl(state.schoolYearId), {
      method: "POST",
      body: JSON.stringify({ nextSchoolYearId }),
    });
    startDialog.close();
    form.reset();
    await refreshStatus();
    setMessage("Zamknięcie roku rozpoczęte.");
  } catch (error) {
    errorBox.textContent = describeApiError(error.status, error.code) ?? error.message;
  } finally {
    button.disabled = false;
  }
});
startDialog.addEventListener("close", () => { byId("start-error").textContent = ""; });

// --- lista kontrolna ---------------------------------------------------------

const checklistDialog = byId("checklist-dialog");
function openChecklistDialog(item) {
  state.checklistItem = item;
  byId("checklist-dialog-item").textContent = CHECKLIST_ITEM_LABELS[item] ?? item;
  byId("checklist-error").textContent = "";
  checklistDialog.querySelector("form").reset();
  checklistDialog.showModal();
}
checklistDialog.querySelector("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") { checklistDialog.close(); return; }
  const form = event.target;
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const note = String(data.get("note") ?? "").trim();
  const documentId = String(data.get("documentId") ?? "").trim();
  const button = event.submitter;
  button.disabled = true;
  const errorBox = byId("checklist-error");
  errorBox.textContent = "";
  try {
    await api(checklistUrl(state.schoolYearId, state.checklistItem), {
      method: "POST",
      body: JSON.stringify({ note: note || undefined, documentId: documentId || undefined }),
    });
    checklistDialog.close();
    await refreshStatus();
    setMessage("Punkt listy kontrolnej potwierdzony.");
  } catch (error) {
    errorBox.textContent = describeApiError(error.status, error.code) ?? error.message;
  } finally {
    button.disabled = false;
  }
});
checklistDialog.addEventListener("close", () => { byId("checklist-error").textContent = ""; });

// --- zamknięcie roku (nieodwracalne — okno <dialog>, bez window.confirm) ----

const closeDialog = byId("close-dialog");
const reasonSelect = byId("close-dialog-reason");
reasonSelect.append(...YEAR_END_DISCREPANCY_REASONS.map((code) => {
  const option = document.createElement("option");
  option.value = code;
  option.textContent = YEAR_END_DISCREPANCY_REASON_LABELS[code] ?? code;
  return option;
}));

// Część okna o rozbieżności salda końca roku — tylko gdy ostatni odczyt ją pokazał.
function renderCloseDiscrepancy() {
  const needed = needsYearEndConfirmation(state.status);
  byId("close-dialog-discrepancy").hidden = !needed;
  reasonSelect.required = needed;
  reasonSelect.value = "";
  const check = state.status?.yearEndCheck ?? {};
  byId("close-dialog-diff-total").textContent = formatEur(check.balanceDifferenceCents);
  byId("close-dialog-diff-cash").textContent = formatEur(check.cashDifferenceCents);
}

byId("open-close").addEventListener("click", () => {
  byId("close-error").textContent = "";
  byId("close-dialog-year").textContent = formatSchoolYear(state.schoolYearId);
  byId("close-dialog-balance").textContent = formatEur(state.status?.balance?.closingBalanceCents);
  renderCloseDiscrepancy();
  closeDialog.showModal();
});
byId("close-dialog-cancel").addEventListener("click", () => closeDialog.close());
byId("close-dialog-cancel-2").addEventListener("click", () => closeDialog.close());
byId("close-dialog-confirm").addEventListener("click", async () => {
  const button = byId("close-dialog-confirm");
  const errorBox = byId("close-error");
  errorBox.textContent = "";
  let body;
  try {
    body = closeRequestBody(state.status, reasonSelect.value);
  } catch (error) {
    errorBox.textContent = error.message;
    reasonSelect.focus();
    return;
  }
  button.disabled = true;
  try {
    await api(closeUrl(state.schoolYearId), { method: "POST", body: JSON.stringify(body) });
    closeDialog.close();
    await refreshStatus();
    setMessage("Rok szkolny zamknięty.");
  } catch (error) {
    errorBox.textContent = describeApiError(error.status, error.code) ?? error.message;
    // Rozbieżność pojawiła się albo zmieniła od odczytu: nowe liczby z serwera,
    // osoba zamykająca musi je zobaczyć i wybrać powód ponownie.
    if (error.code === "year_end_balance_mismatch" || error.code === "year_end_confirmation_mismatch") {
      await refreshStatus();
      renderCloseDiscrepancy();
    }
  } finally {
    button.disabled = false;
  }
});
closeDialog.addEventListener("close", () => { byId("close-error").textContent = ""; });

// --- zestawienie przekazania --------------------------------------------------

const handoverDialog = byId("handover-dialog");
byId("open-handover").addEventListener("click", async () => {
  try {
    const data = await api(handoverUrl(state.schoolYearId));
    byId("handover-content").textContent = JSON.stringify(data, null, 2);
    handoverDialog.showModal();
  } catch (error) {
    setMessage(`Nie udało się pobrać zestawienia przekazania: ${describeApiError(error.status, error.code) ?? error.message}`, true);
  }
});
byId("handover-close").addEventListener("click", () => handoverDialog.close());
byId("handover-print").addEventListener("click", () => window.print());

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
  if (!hasReadAccess(state.grants)) {
    filtersForm.closest("section").hidden = true;
    const notice = byId("access-notice");
    notice.textContent = access.mfaRequired === true
      ? describeApiError(403, "mfa_required")
      : describeApiError(403, "forbidden");
    notice.hidden = false;
    return;
  }
  // Rok domyślny: najnowszy z przydziałów, awaryjnie heurystyka daty
  // (shared/school-year.js) — panel ładuje dane bez klikania „Pokaż”.
  await showYear(fillYearSelect(yearInput, state.grants));
}
applyAccess();
