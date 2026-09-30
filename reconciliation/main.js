import { decodeCsvBytes, describeSource, parseCsvMatrix, resolveDelimiter } from "../import/csv.js";
import {
  STATUS_LABELS,
  auditReportUrl,
  batchCandidates,
  buildBatchBody,
  buildLinePaymentBody,
  buildReconciliationsUrl,
  buildStatementFileBody,
  candidateLabel,
  canCreatePaymentFromLine,
  lineSourceLabel,
  lineStatusLabel,
  linePaymentUrl,
  canOfferConfirm,
  describeBatchFailures,
  decodeStatementBytes,
  describeApiError,
  describeStatementImportError,
  detectStatementFormat,
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
  STATEMENT_FORMAT_LABELS,
  statementFileProblem,
  structuredHouseholdFor,
  summarizeBatchSelection,
  summarizeInconsistencies,
  summarizeStatementImport,
} from "./core.js";
import { MESSAGES, api as apiRequest } from "../shared/api.js";
import { fillYearSelect, selectYearValue } from "../shared/school-year.js";
import { mountShell } from "../shared/shell.js";
import "../shared/shell.css";

mountShell();

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

// Wczytuje listę dla podanego roku; używane zarówno przy ręcznym „Pokaż”, jak i
// przy wypełnieniu domyślnym rokiem po wejściu na panel (#128/#UI: puste ekrany).
async function showYear(value) {
  if (!isValidId(value)) { setMessage("Podaj poprawny identyfikator roku szkolnego.", true); return; }
  setMessage("");
  filtersForm.querySelector("button").disabled = true;
  try {
    state.schoolYearId = value;
    selectYearValue(yearInput, value);
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
}

filtersForm.addEventListener("submit", (event) => {
  event.preventDefault();
  showYear(yearInput.value.trim());
});

// --- szczegóły uzgodnienia ----------------------------------------------------

function actionButton(text, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.addEventListener("click", onClick);
  return button;
}

function lineRow(line, { draft, canWrite }) {
  const row = document.createElement("tr");
  row.append(
    textCell(line.bookedOn),
    textCell(lineDirectionLabel(line.amountCents)),
    textCell(formatCents(Math.abs(line.amountCents)), "amount"),
    textCell(lineSourceLabel(line.source)),
  );
  const status = document.createElement("td");
  const actions = document.createElement("td");
  actions.className = "row-actions";
  status.textContent = lineStatusLabel(line);
  if (line.groupMatch) {
    // Przelew zbiorczy (#127): tworzenie i cofnięcie na razie tylko przez API.
  } else if (line.match) {
    actions.append(actionButton("Cofnij dopasowanie", () => openRevoke(line.match.id)));
  } else {
    actions.append(actionButton("Dopasuj", () => openMatch(line.id)));
    // #115: wpłata wprost z pozycji — kwota i data z wyciągu, bez przepisywania.
    if (canCreatePaymentFromLine(line, { draft, canWrite })) {
      actions.append(actionButton("Utwórz wpłatę", () => openLinePayment(line)));
    }
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

  const own = isLikelyOwnReconciliation(reconciliation, state.actorId);
  const canWrite = hasWriteAccess(state.grants, state.schoolYearId);
  const draft = reconciliation.status === "draft";
  byId("lines-body").replaceChildren(...lines.map((line) => lineRow(line, { draft, canWrite })));
  byId("lines-empty").hidden = lines.length !== 0;
  byId("batch-box").hidden = !(draft && canWrite);
  resetBatch();

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

  byId("import-lines-box").hidden = !(draft && canWrite);
  byId("import-statement-box").hidden = !(draft && canWrite);
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
    if (state.selectedId !== id) clearStatementFile();
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

// #77: plik jest dekodowany w przeglądarce (UTF-8/BOM, UTF-16, Windows-1250/1252) i trafia do pola
// tekstowego, więc serwer dostaje już poprawny tekst. Niejednoznaczne kodowanie = ostrzeżenie; remis
// separatora = blokada z prośbą o wybór w polu „Separator” (wybór trafia do serwera polem `delimiter`).
function describeCsvText(text) {
  try {
    return { delimiter: resolveDelimiter(text, byId("import-delimiter").value), blocked: "" };
  } catch (error) {
    return { delimiter: null, blocked: error.message };
  }
}

async function readStatementFile() {
  const file = byId("import-file").files?.[0];
  const status = byId("import-file-status");
  const errorBox = byId("import-error");
  errorBox.textContent = "";
  if (!file) return;
  if (file.size > 1024 * 1024) { errorBox.textContent = "Plik przekracza 1 MB."; return; }
  try {
    const decoded = decodeCsvBytes(await file.arrayBuffer(), { encoding: byId("import-encoding").value });
    const info = describeCsvText(decoded.text);
    byId("import-csv").value = decoded.text;
    if (info.blocked) {
      status.textContent = `Odczytano: ${describeSource(decoded)}.`;
      errorBox.textContent = info.blocked;
      return;
    }
    const rows = parseCsvMatrix(decoded.text, { delimiter: info.delimiter.delimiter }).length;
    status.textContent = `Odczytano: ${describeSource(decoded, info.delimiter)}, ${Math.max(rows - 1, 0)} wierszy.${decoded.warnings.length ? ` Uwaga: ${decoded.warnings.join(" ")}` : ""}`;
  } catch (error) {
    byId("import-csv").value = "";
    status.textContent = "";
    errorBox.textContent = error.message;
  }
}
byId("import-file").addEventListener("change", readStatementFile);
byId("import-encoding").addEventListener("change", readStatementFile);
byId("import-delimiter").addEventListener("change", () => {
  // Plik czytamy ponownie; tekst wklejony ręcznie sprawdzamy dopiero przy wysłaniu.
  if (byId("import-file").files?.[0]) readStatementFile();
  else byId("import-error").textContent = "";
});

byId("import-lines-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const csv = byId("import-csv").value;
  const errorBox = byId("import-error");
  errorBox.textContent = "";
  if (/[\uFFFD\u0000]/.test(csv)) { errorBox.textContent = "Tekst ma nieznane kodowanie (znaki zastępcze). Zapisz plik jako „CSV UTF-8” albo wybierz kodowanie i wczytaj plik ponownie."; return; }
  const info = describeCsvText(csv);
  if (info.blocked) { errorBox.textContent = info.blocked; return; }
  const button = event.submitter;
  button.disabled = true;
  try {
    const key = makeIdempotencyKey("reconciliation-lines");
    const result = await api(reconciliationActionUrl(state.selectedId, "lines"), {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify(info.delimiter.manual ? { csv, delimiter: info.delimiter.delimiter } : { csv }),
    });
    byId("import-csv").value = "";
    byId("import-file").value = "";
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

// --- import pliku wyciągu CODA / CAMT.053 (#105) --------------------------------

// Treść pliku trzymamy tylko w pamięci tej karty do momentu wysłania; nie trafia do pola
// tekstowego (zawiera dane kontrahentów), a po wysłaniu jest zerowana.
const statementFile = { text: "", format: null };

function statementFormat() {
  const chosen = byId("statement-format").value;
  return chosen === "auto" ? statementFile.format : chosen;
}

function clearStatementFile() {
  statementFile.text = "";
  statementFile.format = null;
  byId("statement-file").value = "";
  byId("statement-error").textContent = "";
  byId("statement-result").textContent = "";
  refreshStatementSubmit();
}

function refreshStatementSubmit() {
  byId("statement-submit").disabled = !(statementFile.text && statementFormat());
}

async function readStatementFileBytes() {
  const file = byId("statement-file").files?.[0];
  const status = byId("statement-file-status");
  const errorBox = byId("statement-error");
  errorBox.textContent = "";
  byId("statement-result").textContent = "";
  statementFile.text = "";
  statementFile.format = null;
  if (!file) { refreshStatementSubmit(); return; }
  const problem = statementFileProblem(file);
  if (problem) { errorBox.textContent = problem; refreshStatementSubmit(); return; }
  try {
    const decoded = decodeStatementBytes(await file.arrayBuffer());
    statementFile.text = decoded.text;
    statementFile.format = detectStatementFormat(decoded.text);
    const format = statementFormat();
    status.textContent = format
      ? `Odczytano plik (${Math.max(1, Math.round(file.size / 1024))} KB), format: ${STATEMENT_FORMAT_LABELS[format]}. Sprawdź, że to wyciąg z właściwego okresu, i wgraj.`
      : "Odczytano plik, ale nie rozpoznano formatu. Wybierz format ręcznie.";
    if (!format) errorBox.textContent = "Nie rozpoznano formatu pliku (CODA albo CAMT.053).";
  } catch (error) {
    errorBox.textContent = error.message;
  }
  refreshStatementSubmit();
}
byId("statement-file").addEventListener("change", readStatementFileBytes);
byId("statement-format").addEventListener("change", () => {
  byId("statement-error").textContent = statementFormat() || !statementFile.text ? "" : "Nie rozpoznano formatu pliku (CODA albo CAMT.053).";
  refreshStatementSubmit();
});

byId("import-statement-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorBox = byId("statement-error");
  const resultBox = byId("statement-result");
  errorBox.textContent = "";
  resultBox.textContent = "";
  const button = byId("statement-submit");
  if (button.disabled) return;
  button.disabled = true;
  try {
    const body = buildStatementFileBody(statementFile.text, statementFormat());
    const key = makeIdempotencyKey("reconciliation-file");
    const result = await api(reconciliationActionUrl(state.selectedId, "lines"), {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify(body),
    });
    statementFile.text = "";
    statementFile.format = null;
    byId("statement-file").value = "";
    await refreshDetail();
    const summary = summarizeStatementImport(result);
    resultBox.textContent = summary.warnings.length ? `${summary.text} Uwaga: ${summary.warnings.join(" ")}` : summary.text;
    setMessage(summary.text);
  } catch (error) {
    errorBox.textContent = describeStatementImportError(error);
  } finally {
    refreshStatementSubmit();
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
    if (type === "household") {
      // Propozycja nowej wpłaty (komunikacja strukturalna) — ten sam zapis co
      // „Utwórz wpłatę”; klucz stały dla otwartego okna (ponowienie = ta sama wpłata).
      state.matchKey ||= makeIdempotencyKey("reconciliation-line-payment");
      await api(linePaymentUrl(state.selectedId, activeLineId), {
        method: "POST",
        headers: { "Idempotency-Key": state.matchKey },
        body: JSON.stringify(buildLinePaymentBody(id)),
      });
      matchDialog.close();
      await refreshDetail();
      setMessage("Utworzono wpłatę z pozycji wyciągu i powiązano ją z pozycją.");
      return;
    }
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
matchDialog.addEventListener("close", () => { byId("match-error").textContent = ""; activeLineId = null; state.matchKey = null; });

// --- wpłata wprost z pozycji wyciągu (#115) --------------------------------------

const linePaymentDialog = byId("line-payment-dialog");
let linePaymentLine = null;

async function openLinePayment(line) {
  linePaymentLine = line;
  const form = byId("line-payment-form");
  form.reset();
  byId("line-payment-error").textContent = "";
  byId("line-payment-hint").textContent = "";
  byId("line-payment-summary").textContent =
    `Pozycja z ${line.bookedOn}, ${formatCents(line.amountCents)}. Wpłata dostanie tę kwotę i datę z wyciągu (przelew).`;
  // Klucz idempotencji na całe otwarte okno: podwójne kliknięcie albo ponowienie
  // po błędzie sieci nie utworzy drugiej wpłaty.
  state.linePaymentKey = makeIdempotencyKey("reconciliation-line-payment");
  try {
    const data = await api(`${reconciliationActionUrl(state.selectedId, "suggestions")}?windowDays=7`);
    const householdId = structuredHouseholdFor(data.suggestions, line.id);
    if (householdId) {
      form.elements.householdId.value = householdId;
      byId("line-payment-hint").textContent =
        "Komunikacja strukturalna pozycji odpowiada tej rodzinie. Sprawdź przed zapisem — nic nie jest zapisywane automatycznie.";
    }
  } catch {
    // Propozycja jest tylko podpowiedzią; bez niej skarbnik wpisuje rodzinę sam.
  }
  linePaymentDialog.showModal();
}

byId("line-payment-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") { linePaymentDialog.close(); return; }
  const errorBox = byId("line-payment-error");
  errorBox.textContent = "";
  const button = event.submitter;
  button.disabled = true;
  try {
    const body = buildLinePaymentBody(new FormData(event.currentTarget).get("householdId"));
    const result = await api(linePaymentUrl(state.selectedId, linePaymentLine.id), {
      method: "POST",
      headers: { "Idempotency-Key": state.linePaymentKey },
      body: JSON.stringify(body),
    });
    linePaymentDialog.close();
    await refreshDetail();
    setMessage(result?.payment?.householdId
      ? "Utworzono wpłatę z pozycji wyciągu i powiązano ją z pozycją."
      : "Utworzono wpłatę nieprzypisaną do rodziny i powiązano ją z pozycją. Rodzinę można wskazać później na liście wpłat.");
  } catch (error) {
    errorBox.textContent = error.code === "idempotency_conflict"
      ? `${error.message} Zamknij okno i sprawdź stan uzgodnienia, zanim spróbujesz ponownie.`
      : error.message;
  } finally {
    button.disabled = false;
  }
});
linePaymentDialog.addEventListener("close", () => {
  byId("line-payment-error").textContent = "";
  linePaymentLine = null;
  state.linePaymentKey = null;
});

// --- zatwierdzanie wsadowe wybranych par (#115) -----------------------------------

const batch = { rows: [], key: null };

function resetBatch() {
  batch.rows = [];
  batch.key = null;
  byId("batch-body").replaceChildren();
  byId("batch-table").hidden = true;
  byId("batch-empty").hidden = true;
  byId("batch-error").textContent = "";
  refreshBatchSummary();
}

function selectedBatchRows() {
  const checked = new Set([...byId("batch-body").querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value));
  return batch.rows.filter((row) => checked.has(row.statementLineId));
}

function refreshBatchSummary() {
  const selected = selectedBatchRows();
  byId("batch-summary").textContent = selected.length ? summarizeBatchSelection(selected) : "Nic nie zaznaczono.";
  byId("batch-submit").disabled = selected.length === 0;
}

function batchRow(item) {
  const row = document.createElement("tr");
  const choose = document.createElement("td");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.value = item.statementLineId;
  input.checked = false;
  input.setAttribute("aria-label", `Zaznacz pozycję z ${item.bookedOn}, ${formatCents(item.amountCents)}`);
  input.addEventListener("change", () => { batch.key = null; refreshBatchSummary(); });
  choose.append(input);
  row.append(choose, textCell(item.bookedOn), textCell(formatCents(item.amountCents), "amount"),
    textCell(item.paymentDate), textCell(item.reason));
  return row;
}

byId("batch-load").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  byId("batch-error").textContent = "";
  try {
    const data = await api(`${reconciliationActionUrl(state.selectedId, "suggestions")}?windowDays=7`);
    batch.rows = batchCandidates(data.suggestions);
    batch.key = null;
    byId("batch-body").replaceChildren(...batch.rows.map(batchRow));
    byId("batch-table").hidden = batch.rows.length === 0;
    byId("batch-empty").hidden = batch.rows.length !== 0;
    refreshBatchSummary();
  } catch (error) {
    byId("batch-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

const batchDialog = byId("batch-dialog");

byId("batch-submit").addEventListener("click", () => {
  const selected = selectedBatchRows();
  if (!selected.length) return;
  byId("batch-dialog-summary").textContent = summarizeBatchSelection(selected);
  byId("batch-dialog-error").textContent = "";
  batchDialog.showModal();
});

byId("batch-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") { batchDialog.close(); return; }
  const selected = selectedBatchRows();
  const button = event.submitter;
  button.disabled = true;
  try {
    const body = buildBatchBody(selected);
    // Ten sam klucz przy ponowieniu tego samego zaznaczenia (zmiana zaznaczenia zeruje klucz).
    batch.key ||= makeIdempotencyKey("reconciliation-batch");
    const result = await api(reconciliationActionUrl(state.selectedId, "matches/batch"), {
      method: "POST",
      headers: { "Idempotency-Key": batch.key },
      body: JSON.stringify(body),
    });
    batchDialog.close();
    await refreshDetail();
    const count = Array.isArray(result?.matches) ? result.matches.length : selected.length;
    setMessage(`Zatwierdzono ${count} ${count === 1 ? "parę" : "par"}.`);
  } catch (error) {
    const failures = describeBatchFailures(error.data?.failures, batch.rows, MESSAGES);
    byId("batch-dialog-error").textContent = failures.length ? `${error.message} ${failures.join(" ")}` : error.message;
    // Po odrzuceniu nic nie zapisano — nowy wybór dostanie nowy klucz; po błędzie
    // sieci klucz zostaje, żeby ponowienie nie zapisało par drugi raz.
    if (error.status && error.status < 500) batch.key = null;
  } finally {
    button.disabled = false;
  }
});
batchDialog.addEventListener("close", () => { byId("batch-dialog-error").textContent = ""; });

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
  if (!hasWriteAccess(state.grants)) {
    byId("open-create").hidden = true;
    filtersForm.closest("section").hidden = true;
    const notice = byId("access-notice");
    notice.textContent = access.mfaRequired === true
      ? describeApiError(403, "mfa_required")
      : describeApiError(403, "forbidden");
    notice.hidden = false;
    return;
  }
  // Rok domyślny (#128/#UI): najnowszy z przydziałów, awaryjnie heurystyka daty
  // (shared/school-year.js) — panel ładuje dane bez klikania „Pokaż”; użytkownik
  // nadal może zmienić rok.
  await showYear(fillYearSelect(yearInput, state.grants));
}
applyAccess();
