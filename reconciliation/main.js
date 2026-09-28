import {
  STATUS_LABELS,
  auditReportUrl,
  buildReconciliationsUrl,
  candidateLabel,
  canOfferConfirm,
  describeApiError,
  formatCents,
  formatDifference,
  hasWriteAccess,
  isLikelyOwnReconciliation,
  isValidId,
  lineDirectionLabel,
  makeIdempotencyKey,
  parseStatementBalance,
  reconciliationActionUrl,
  reconciliationUrl,
  requiresConfirmationNote,
  summarizeInconsistencies,
} from "./core.js";
import { api as apiRequest } from "../shared/api.js";

const api = apiRequest;
const byId = (id) => document.getElementById(id);

const state = {
  schoolYearId: "",
  reconciliations: [],
  selectedId: null,
  detail: null,
  actorId: null,
  grants: [],
  requestKey: null,
};

const filtersForm = byId("filters-form");
const yearInput = byId("school-year-id");
const message = byId("message");
const listBody = byId("reconciliations-body");
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

function reconciliationRow(item) {
  const row = document.createElement("tr");
  row.append(
    textCell(item.statementDate),
    (() => {
      const cell = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = `badge status-${item.status}`;
      badge.textContent = STATUS_LABELS[item.status] ?? item.status;
      cell.append(badge);
      return cell;
    })(),
    textCell(formatCents(item.statementBalanceCents), "amount"),
    textCell(formatCents(item.ledgerBalanceCents), "amount"),
    textCell(formatCents(item.differenceCents), "amount"),
  );
  const actions = document.createElement("td");
  actions.className = "row-actions";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Otwórz";
  button.addEventListener("click", () => openDetail(item.id));
  actions.append(button);
  row.append(actions);
  return row;
}

function renderList() {
  listBody.replaceChildren(...state.reconciliations.map(reconciliationRow));
  const count = state.reconciliations.length;
  byId("reconciliations-count").textContent = count === 1 ? "1 uzgodnienie" : `${count} uzgodnień`;
  byId("reconciliations-table").hidden = count === 0;
  byId("reconciliations-empty").hidden = count !== 0;
}

async function loadList() {
  const data = await api(buildReconciliationsUrl(state.schoolYearId));
  state.reconciliations = Array.isArray(data.reconciliations) ? data.reconciliations : [];
  renderList();
}

filtersForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = yearInput.value.trim();
  if (!isValidId(value)) { setMessage("Podaj poprawny identyfikator roku szkolnego.", true); return; }
  setMessage("");
  filtersForm.querySelector("button").disabled = true;
  try {
    state.schoolYearId = value;
    await loadList();
    detailSection.hidden = true;
    state.selectedId = null;
    byId("audit-report-link").href = auditReportUrl(value);
    byId("audit-report-box").hidden = false;
  } catch (error) {
    setMessage(`Nie udało się pobrać listy uzgodnień: ${error.message}`, true);
  } finally {
    filtersForm.querySelector("button").disabled = false;
  }
});

// --- szczegóły uzgodnienia ----------------------------------------------------

function lineRow(line) {
  const row = document.createElement("tr");
  row.append(
    textCell(line.bookedOn),
    textCell(lineDirectionLabel(line.amountCents)),
    textCell(formatCents(Math.abs(line.amountCents)), "amount"),
    textCell(line.source),
  );
  const status = document.createElement("td");
  const actions = document.createElement("td");
  actions.className = "row-actions";
  if (line.groupMatch) {
    // Przelew zbiorczy (#127): tworzenie i cofnięcie na razie tylko przez API.
    status.textContent = `Dopasowana zbiorczo (${line.groupMatch.itemCount} poz.)`;
  } else if (line.match) {
    status.textContent = "Dopasowana";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Cofnij dopasowanie";
    button.addEventListener("click", () => openRevoke(line.match.id));
    actions.append(button);
  } else {
    status.textContent = "Niedopasowana";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Dopasuj";
    button.addEventListener("click", () => openMatch(line.id));
    actions.append(button);
  }
  row.append(status, actions);
  return row;
}

function renderDetail() {
  const { reconciliation, lines, summary, unmatchedLedgerEntries, unmatchedLedgerEntriesTruncated, inconsistentMatches } = state.detail;
  byId("detail-title").textContent = `Uzgodnienie ${reconciliation.statementDate}`;
  const statusBadge = byId("detail-status");
  statusBadge.textContent = STATUS_LABELS[reconciliation.status] ?? reconciliation.status;
  statusBadge.className = `badge status-${reconciliation.status}`;
  byId("detail-statement-balance").textContent = formatCents(reconciliation.statementBalanceCents);
  byId("detail-ledger-balance").textContent = formatCents(reconciliation.ledgerBalanceCents);
  byId("detail-difference").textContent = formatDifference(reconciliation.differenceCents);
  byId("detail-notes").textContent = reconciliation.notes || "—";
  byId("detail-summary-counts").textContent =
    `${summary.lineCount} pozycji, ${summary.matchedLineCount} dopasowanych, ${summary.unmatchedLineCount} niedopasowanych.`;

  byId("lines-body").replaceChildren(...lines.map(lineRow));
  byId("lines-empty").hidden = lines.length !== 0;

  const unmatchedList = byId("unmatched-ledger-entries");
  unmatchedList.replaceChildren(...unmatchedLedgerEntries.map((entry) => {
    const item = document.createElement("li");
    item.textContent = `${entry.occurredOn} · ${entry.description || "Bez opisu"} · ${formatCents(entry.netAmountCents)}`;
    return item;
  }));
  byId("unmatched-ledger-box").hidden = unmatchedLedgerEntries.length === 0;
  byId("unmatched-ledger-truncated").hidden = !unmatchedLedgerEntriesTruncated;

  const inconsistent = summarizeInconsistencies(inconsistentMatches);
  const inconsistentList = byId("inconsistent-matches");
  inconsistentList.replaceChildren(...inconsistent.map((item) => {
    const el = document.createElement("li");
    el.textContent = `Dopasowanie ${item.matchId}: ${item.reasonsText}`;
    return el;
  }));
  byId("inconsistent-box").hidden = inconsistent.length === 0;

  const own = isLikelyOwnReconciliation(reconciliation, state.actorId);
  const canWrite = hasWriteAccess(state.grants, state.schoolYearId);
  const draft = reconciliation.status === "draft";
  byId("import-lines-box").hidden = !(draft && canWrite);
  byId("confirm-reconciliation").hidden = !(draft && canWrite) || own || inconsistent.length > 0;
  byId("confirm-waiting").hidden = !(draft && canWrite && own);
  byId("confirm-inconsistent").hidden = !(draft && canWrite && inconsistent.length > 0);
  const activeMatches = (summary?.matchedLineCount ?? 0) + (summary?.inconsistentMatchCount ?? 0);
  byId("abandon-reconciliation").hidden = !(draft && canWrite) || activeMatches > 0;
}

// Karta pobiera pozycje wyciągu stronami (#218, domyślnie 500 na stronę) i
// scala je po stronie panelu, żeby widok nie zmienił się dla skarbnika —
// backend nie zwraca już wszystkich pozycji jednym, nieograniczonym zapytaniem.
async function fetchFullDetail(id) {
  let data = await api(reconciliationUrl(id));
  let lines = data.lines;
  let cursor = data.nextCursor;
  while (cursor) {
    const page = await api(reconciliationUrl(id, cursor));
    lines = lines.concat(page.lines);
    cursor = page.nextCursor;
  }
  return { ...data, lines, nextCursor: null };
}

async function openDetail(id) {
  setMessage("");
  try {
    const data = await fetchFullDetail(id);
    state.selectedId = id;
    state.detail = data;
    detailSection.hidden = false;
    renderDetail();
    detailSection.scrollIntoView({ block: "start" });
    byId("detail-title").tabIndex = -1;
    byId("detail-title").focus();
  } catch (error) {
    setMessage(`Nie udało się otworzyć uzgodnienia: ${error.message}`, true);
  }
}

async function refreshDetail() {
  if (state.selectedId) await openDetail(state.selectedId);
  await loadList().catch(() => {});
}

// --- tworzenie uzgodnienia -----------------------------------------------------

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
      if (!message.classList.contains("error")) setMessage(successText);
    } catch (error) {
      errorBox.textContent = error.code === "idempotency_conflict"
        ? `${error.message} Zamknij okno i sprawdź stan uzgodnienia, zanim spróbujesz ponownie.`
        : error.message;
    } finally {
      button.disabled = false;
    }
  });
  dialog.addEventListener("close", () => { errorBox.textContent = ""; state.requestKey = null; });
  return { dialog, form };
}

const createDialog = configureDialog("create-dialog", "reconciliation-create", async (data, key) => {
  const statementBalanceCents = parseStatementBalance(data.get("statementBalance"));
  const result = await api("/api/reconciliations", {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify({
      schoolYearId: state.schoolYearId,
      statementDate: String(data.get("statementDate")),
      statementBalanceCents,
      notes: String(data.get("notes") || "").trim() || null,
    }),
  });
  state.selectedId = result.reconciliation.id;
}, "Utworzono uzgodnienie.");

byId("open-create").addEventListener("click", () => {
  if (!state.schoolYearId) return;
  createDialog.dialog.showModal();
});

// --- import linii wyciągu (CSV) -----------------------------------------------

byId("import-lines-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const csv = byId("import-csv").value;
  const errorBox = byId("import-error");
  errorBox.textContent = "";
  const button = event.submitter;
  button.disabled = true;
  try {
    const key = makeIdempotencyKey("reconciliation-lines");
    const result = await api(reconciliationActionUrl(state.selectedId, "lines"), {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify({ csv }),
    });
    byId("import-csv").value = "";
    await refreshDetail();
    setMessage(result.possibleDuplicateCount > 0
      ? `Wgrano ${result.import.lineCount} pozycji. Uwaga: ${result.possibleDuplicateCount} może powielać wcześniejszy import.`
      : `Wgrano ${result.import.lineCount} pozycji.`);
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

// --- dopasowania ---------------------------------------------------------------

const matchDialog = byId("match-dialog");
let activeLineId = null;

async function openMatch(lineId) {
  activeLineId = lineId;
  byId("match-error").textContent = "";
  byId("match-candidates").replaceChildren();
  try {
    const data = await api(`${reconciliationActionUrl(state.selectedId, "suggestions")}?windowDays=7`);
    const forLine = (data.suggestions || []).find((s) => s.statementLineId === lineId);
    const candidates = forLine ? forLine.candidates : [];
    if (!candidates.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "Brak propozycji w oknie 7 dni.";
      byId("match-candidates").append(empty);
    }
    byId("match-candidates").append(...candidates.map((candidate) => {
      const wrapper = document.createElement("label");
      wrapper.className = "candidate";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "candidate";
      input.value = JSON.stringify({ type: candidate.type, id: candidate.id });
      const text = document.createElement("span");
      text.textContent = candidateLabel(candidate);
      wrapper.append(input, text);
      return wrapper;
    }));
    matchDialog.showModal();
  } catch (error) {
    setMessage(`Nie udało się pobrać propozycji dopasowania: ${error.message}`, true);
  }
}

byId("match-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") { matchDialog.close(); return; }
  const errorBox = byId("match-error");
  const selected = matchDialog.querySelector('input[name="candidate"]:checked');
  if (!selected) { errorBox.textContent = "Wybierz jedną z propozycji."; return; }
  const { type, id } = JSON.parse(selected.value);
  const button = event.submitter;
  button.disabled = true;
  try {
    const key = makeIdempotencyKey("reconciliation-match");
    await api(reconciliationActionUrl(state.selectedId, "matches"), {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify({
        statementLineId: activeLineId,
        ledgerEntryId: type === "ledger_entry" ? id : null,
        paymentEntryId: type === "payment_entry" ? id : null,
      }),
    });
    matchDialog.close();
    await refreshDetail();
    setMessage("Dopasowanie potwierdzone.");
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
matchDialog.addEventListener("close", () => { byId("match-error").textContent = ""; activeLineId = null; });

// --- cofnięcie dopasowania -----------------------------------------------------

const revokeDialog = byId("revoke-dialog");
let activeMatchId = null;

function openRevoke(matchId) {
  activeMatchId = matchId;
  revokeDialog.querySelector("form").reset();
  byId("revoke-error").textContent = "";
  revokeDialog.showModal();
}

byId("revoke-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") { revokeDialog.close(); return; }
  if (!revokeDialog.querySelector("form").reportValidity()) return;
  const reason = String(new FormData(revokeDialog.querySelector("form")).get("reason"));
  const button = event.submitter;
  button.disabled = true;
  try {
    await api(reconciliationActionUrl(state.selectedId, `matches/${encodeURIComponent(activeMatchId)}/revocation`), {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
    revokeDialog.close();
    await refreshDetail();
    setMessage("Dopasowanie cofnięte.");
  } catch (error) {
    byId("revoke-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

// --- potwierdzenie uzgodnienia (cztery oczy) ----------------------------------

const confirmDialog = byId("confirm-dialog");

byId("confirm-reconciliation").addEventListener("click", () => {
  const requiresNote = requiresConfirmationNote(state.detail.reconciliation);
  byId("confirm-note-field").hidden = !requiresNote;
  confirmDialog.querySelector('[name="confirmationNote"]').required = requiresNote;
  byId("confirm-summary").textContent =
    `${formatDifference(state.detail.reconciliation.differenceCents)} Wyciąg: ${formatCents(state.detail.reconciliation.statementBalanceCents)}. Księga: ${formatCents(state.detail.reconciliation.ledgerBalanceCents)}.`;
  confirmDialog.showModal();
});

byId("confirm-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") { confirmDialog.close(); return; }
  if (!confirmDialog.querySelector("form").reportValidity()) return;
  const note = String(new FormData(confirmDialog.querySelector("form")).get("confirmationNote") || "").trim();
  const button = event.submitter;
  button.disabled = true;
  try {
    await api(reconciliationActionUrl(state.selectedId, "confirm"), {
      method: "POST",
      body: JSON.stringify({ confirmationNote: note || null }),
    });
    confirmDialog.close();
    confirmDialog.querySelector("form").reset();
    await refreshDetail();
    setMessage("Uzgodnienie potwierdzone.");
  } catch (error) {
    byId("confirm-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
confirmDialog.addEventListener("close", () => { byId("confirm-error").textContent = ""; });

// --- porzucenie szkicu (0107) --------------------------------------------------

const abandonDialog = byId("abandon-dialog");

byId("abandon-reconciliation").addEventListener("click", () => { abandonDialog.showModal(); });

byId("abandon-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") { abandonDialog.close(); return; }
  const form = abandonDialog.querySelector("form");
  if (!form.reportValidity()) return;
  const reason = String(new FormData(form).get("reason") || "").trim();
  const button = event.submitter;
  button.disabled = true;
  try {
    await api(reconciliationActionUrl(state.selectedId, "abandon"), {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
    abandonDialog.close();
    form.reset();
    await refreshDetail();
    await loadList();
    setMessage("Szkic porzucony. Wyciąg można zaimportować do nowego szkicu.");
  } catch (error) {
    byId("abandon-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
abandonDialog.addEventListener("close", () => { byId("abandon-error").textContent = ""; });

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
  if (hasWriteAccess(state.grants)) return;
  byId("open-create").hidden = true;
  filtersForm.closest("section").hidden = true;
  const notice = byId("access-notice");
  notice.textContent = access.mfaRequired === true
    ? describeApiError(403, "mfa_required")
    : describeApiError(403, "forbidden");
  notice.hidden = false;
}
applyAccess();
