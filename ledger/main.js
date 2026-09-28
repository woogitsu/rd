import {
  DIRECTION_LABELS,
  METHOD_LABELS,
  buildLedgerUrl,
  buildOverviewUrl,
  formatCents,
  isValidId,
  makeIdempotencyKey,
  needsResolution,
  normalizeEntry,
  parseEuroAmount,
} from "./core.js";
import { api as apiRequest } from "../shared/api.js";
import { confirmAction } from "../shared/confirm-dialog.js";

const state = { entries: [], categories: [], nextCursor: null, requestKey: null };
const byId = (id) => document.getElementById(id);
const filtersForm = byId("filters-form");
const yearInput = byId("school-year-id");
const directionInput = byId("direction-filter");
const message = byId("message");
const overview = byId("overview");
const entriesBody = byId("entries-body");
const budgetBody = byId("budget-body");
const loadMore = byId("load-more");

function localDate() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

// Wspólny klient (#99): polskie komunikaty, 401/403 MFA → /login/ z powrotem.
const api = apiRequest;

function textCell(value, className = "") {
  const cell = document.createElement("td");
  cell.textContent = value;
  if (className) cell.className = className;
  return cell;
}

function entryRow(raw) {
  const entry = normalizeEntry(raw);
  const row = document.createElement("tr");
  row.append(textCell(entry.occurredOn));
  const description = textCell(entry.description || "Bez opisu", "entry-description");
  if (entry.source || entry.resolutionReference) {
    const details = document.createElement("small");
    details.textContent = [entry.source && `Źródło: ${entry.source}`, entry.resolutionReference && `Uchwała: ${entry.resolutionReference}`].filter(Boolean).join(" · ");
    description.append(details);
  }
  row.append(description, textCell(entry.categoryName), textCell(METHOD_LABELS[entry.method]));
  const type = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = `badge ${entry.direction}`;
  badge.textContent = DIRECTION_LABELS[entry.direction];
  type.append(badge);
  row.append(type, textCell(formatCents(entry.netCents), "amount"));
  const actions = document.createElement("td");
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Korekta";
  button.dataset.entryId = entry.id;
  actions.className = "row-actions";
  actions.append(button);
  row.append(actions);
  return row;
}

function renderEntries() {
  entriesBody.replaceChildren(...state.entries.map(entryRow));
  const count = state.entries.length;
  byId("result-summary").textContent = count === 1 ? "1 widoczny wpis" : `${count} widocznych wpisów`;
  byId("entries-table").hidden = count === 0;
  byId("entries-empty").hidden = count !== 0;
  loadMore.hidden = !state.nextCursor;
}

function renderBudget(lines) {
  const rows = lines.map((line) => {
    const row = document.createElement("tr");
    row.append(textCell(String(line.categoryName ?? "Bez kategorii")));
    const type = textCell(DIRECTION_LABELS[line.direction] ?? "—");
    type.className = line.direction === "expense" ? "expense" : "income";
    row.append(type, textCell(String(line.note ?? "—")), textCell(formatCents(line.plannedCents), "amount"));
    return row;
  });
  budgetBody.replaceChildren(...rows);
  byId("budget-count").textContent = lines.length === 1 ? "1 pozycja" : `${lines.length} pozycji`;
  budgetBody.closest(".table-wrap").hidden = rows.length === 0;
  byId("budget-empty").hidden = rows.length !== 0;
}

function renderSummary(summary) {
  byId("opening-balance").textContent = formatCents(summary.openingBalanceCents);
  byId("income-total").textContent = formatCents(summary.incomeCents);
  byId("expense-total").textContent = formatCents(summary.expenseCents);
  byId("closing-balance").textContent = formatCents(summary.closingBalanceCents);
}

function setBusy(busy) {
  filtersForm.querySelector("button").disabled = busy;
  byId("open-entry").disabled = busy || !isValidId(yearInput.value);
  byId("open-entry-hint").hidden = !byId("open-entry").disabled;
  loadMore.disabled = busy;
}

async function loadEntries({ append = false } = {}) {
  const data = await api(buildLedgerUrl({
    schoolYearId: yearInput.value,
    direction: directionInput.value,
    cursor: append ? state.nextCursor : "",
  }));
  const items = Array.isArray(data.entries) ? data.entries : [];
  state.entries = append ? [...state.entries, ...items] : items;
  state.nextCursor = data.nextCursor || null;
  renderEntries();
}

async function loadOverview() {
  message.textContent = "";
  message.className = "message";
  overview.hidden = true;
  setBusy(true);
  try {
    const year = yearInput.value;
    const [summaryData, budgetData, categoriesData] = await Promise.all([
      api(buildOverviewUrl("summary", year)),
      api(buildOverviewUrl("budget", year)),
      api(buildOverviewUrl("categories", year)),
      loadEntries(),
    ]);
    state.categories = Array.isArray(categoriesData.categories) ? categoriesData.categories : [];
    renderSummary(summaryData.summary ?? {});
    renderBudget(Array.isArray(budgetData.budget) ? budgetData.budget : []);
    overview.hidden = false;
  } catch (error) {
    state.entries = [];
    state.nextCursor = null;
    message.className = "message error";
    message.textContent = `Nie udało się pobrać księgi: ${error.message}`;
  } finally {
    setBusy(false);
  }
}

filtersForm.addEventListener("submit", (event) => { event.preventDefault(); loadOverview(); });
loadMore.addEventListener("click", async () => {
  setBusy(true);
  try { await loadEntries({ append: true }); }
  catch (error) { message.className = "message error"; message.textContent = error.message; }
  finally { setBusy(false); }
});

// Po zapisie tabela jest renderowana od nowa; gdy przycisk otwierający okno zniknie,
// fokus trafia na nagłówek listy zapisów zamiast na <body> (WCAG 2.4.3).
function restoreFocus() {
  if (document.activeElement && document.activeElement !== document.body) return;
  const target = overview.hidden ? byId("filters-title") : byId("entries-title");
  target.tabIndex = -1;
  target.focus();
}

function configureDialog(id, prefix, submit, successText, describeConfirm) {
  const dialog = byId(id);
  const form = dialog.querySelector("form");
  const errorBox = form.querySelector(".form-error");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (event.submitter?.value === "cancel") { dialog.close(); return; }
    if (!form.reportValidity()) return;
    // Podsumowanie skutków przed zapisem (issue #136) — zapis jest trwały.
    if (describeConfirm) {
      const confirmed = await confirmAction(describeConfirm(new FormData(form)));
      if (!confirmed) return;
    }
    const button = event.submitter;
    button.disabled = true;
    errorBox.textContent = "";
    state.requestKey ||= makeIdempotencyKey(prefix);
    try {
      await submit(new FormData(form), state.requestKey);
      state.requestKey = null;
      dialog.close();
      form.reset();
      await loadOverview();
      if (!message.classList.contains("error")) message.textContent = successText;
      restoreFocus();
    } catch (error) {
      errorBox.textContent = error.code === "idempotency_conflict"
        ? `${error.message} Jeśli zmieniasz dane, anuluj formularz i otwórz go ponownie.`
        : error.message;
    } finally { button.disabled = false; }
  });
  dialog.addEventListener("close", () => { errorBox.textContent = ""; state.requestKey = null; });
  return { dialog, form };
}

const entryDialog = configureDialog("entry-dialog", "ledger", async (data, key) => {
  const amountCents = parseEuroAmount(data.get("amount"));
  const direction = String(data.get("direction"));
  const resolutionReference = String(data.get("resolutionReference") || "").trim();
  if (needsResolution(direction, amountCents) && !resolutionReference) throw new Error("Dla tego wydatku podaj referencję uchwały.");
  const sourceDocumentId = String(data.get("sourceDocumentId") || "").trim();
  if (sourceDocumentId && !isValidId(sourceDocumentId)) throw new Error("Niepoprawny identyfikator dokumentu.");
  await api("/api/ledger", {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify({
      schoolYearId: String(data.get("schoolYearId")), direction, amountCents,
      categoryId: String(data.get("categoryId")), description: String(data.get("description")),
      occurredOn: String(data.get("occurredOn")), method: String(data.get("method")),
      source: String(data.get("source") || "") || null,
      sourceDocumentId: sourceDocumentId || null,
      resolutionReference: resolutionReference || null,
    }),
  });
}, "Zapisano wpis w księdze.", (data) => {
  const direction = String(data.get("direction"));
  const category = state.categories.find((c) => c.id === data.get("categoryId"));
  let amountText = String(data.get("amount") || "");
  let warning = "";
  try {
    const cents = parseEuroAmount(data.get("amount"));
    amountText = formatCents(cents);
    if (cents > 100_000) warning = "Kwota jest nietypowo wysoka (ponad 1000 EUR). Sprawdź, zanim zapiszesz.";
  } catch {
    // Nieprawidłowa kwota — właściwy błąd pokaże walidacja przy właściwym zapisie.
  }
  return {
    title: "Zapisać wpis w księdze?",
    effects: [
      `Kwota: ${amountText} (${DIRECTION_LABELS[direction] ?? direction})`,
      `Data: ${data.get("occurredOn")}`,
      `Kategoria: ${category ? category.name : data.get("categoryId")}`,
      "Zapis jest trwały; pomyłkę poprawisz korektą widoczną w historii.",
    ],
    warning,
    confirmLabel: "Zapisz wpis",
  };
});

const correctionDialog = configureDialog("correction-dialog", "ledger-correction", async (data, key) => {
  const entryId = String(data.get("entryId"));
  await api(`/api/ledger/${encodeURIComponent(entryId)}/corrections`, {
    method: "POST", headers: { "Idempotency-Key": key },
    body: JSON.stringify({ amountCents: parseEuroAmount(data.get("amount")), reason: String(data.get("reason")) }),
  });
}, "Dodano korektę.", (data) => {
  let amountText = String(data.get("amount") || "");
  try {
    amountText = formatCents(parseEuroAmount(data.get("amount")));
  } catch {
    // Nieprawidłowa kwota — właściwy błąd pokaże walidacja przy właściwym zapisie.
  }
  return {
    title: "Dodać korektę?",
    effects: [
      `Kwota pomniejszenia: ${amountText}`,
      `Powód: ${String(data.get("reason") || "").trim() || "—"}`,
      "Korekta nie usuwa pierwotnego wpisu — saldo netto zostanie przeliczone, historia zostaje widoczna.",
    ],
    confirmLabel: "Dodaj korektę",
  };
});

function updateCategories() {
  const direction = entryDialog.form.elements.direction.value;
  const select = entryDialog.form.elements.categoryId;
  const options = state.categories.filter((item) => item.direction === direction).map((item) => {
    const option = document.createElement("option"); option.value = item.id; option.textContent = item.name; return option;
  });
  select.replaceChildren(...options);
  select.disabled = options.length === 0;
}

function updateResolutionField() {
  const form = entryDialog.form;
  let amount = 0;
  try { amount = parseEuroAmount(form.elements.amount.value); } catch {}
  const required = needsResolution(form.elements.direction.value, amount);
  byId("resolution-field").hidden = !required;
  form.elements.resolutionReference.required = required;
}

entryDialog.form.elements.direction.addEventListener("change", () => { updateCategories(); updateResolutionField(); });
entryDialog.form.elements.amount.addEventListener("input", updateResolutionField);
byId("open-entry").addEventListener("click", () => {
  entryDialog.form.elements.schoolYearId.value = yearInput.value.trim();
  entryDialog.form.elements.occurredOn.value = localDate();
  updateCategories(); updateResolutionField(); entryDialog.dialog.showModal();
});
entriesBody.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-entry-id]");
  if (!button) return;
  const entry = state.entries.map(normalizeEntry).find((item) => item.id === button.dataset.entryId);
  if (!entry) return;
  correctionDialog.form.elements.entryId.value = entry.id;
  correctionDialog.form.querySelector(".context").textContent = `${entry.occurredOn} · ${entry.description} · netto ${formatCents(entry.netCents)}`;
  correctionDialog.dialog.showModal();
});

byId("open-entry").disabled = true;
byId("open-entry-hint").hidden = false;
