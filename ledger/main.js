import { describeApiError, hasFinancialAccess } from "./core.js";
import {
  DIRECTION_LABELS,
  METHOD_LABELS,
  buildLedgerUrl,
  buildNextLedgerUrl,
  buildOverviewUrl,
  formatCents,
  isValidId,
  ledgerFilterChanged,
  ledgerQuery,
  makeIdempotencyKey,
  needsResolution,
  normalizeEntry,
  parseEuroAmount,
} from "./core.js";
import { api as apiRequest } from "../shared/api.js";
import { confirmAction } from "../shared/confirm-dialog.js";
import { filtersFromQuery, filtersToQuery } from "../shared/query-filters.js";
import { defaultYear, yearOptionsHtml, yearsFromGrants } from "../shared/school-year.js";
import { mountShell } from "../shared/shell.js";
import "../shared/shell.css";
import { mountPrintMeta } from "../shared/print-meta.js";
import "../shared/print.css";

let printedBy = null;
mountShell().then((result) => { printedBy = result?.session?.displayName || result?.session?.email || null; });

const FILTER_KEYS = ["schoolYearId", "direction"];
const state = { entries: [], categories: [], nextCursor: null, query: null, loading: false, requestKey: null, printing: false };
const byId = (id) => document.getElementById(id);
const filtersForm = byId("filters-form");
const yearInput = byId("school-year-id");
const directionInput = byId("direction-filter");
const message = byId("message");
const overview = byId("overview");
const entriesBody = byId("entries-body");
const budgetBody = byId("budget-body");
const loadMore = byId("load-more");
const printButton = byId("print-ledger");

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
  updateControls();
  updatePrintMeta();
}

// Blok metadanych wydruku (#151) — niewidoczny na ekranie, wypełniany przed
// każdym renderowaniem, żeby wydruk zawsze pokazywał rok, filtry i kompletność.
function updatePrintMeta() {
  const container = byId("print-meta");
  if (!container) return;
  const yearLabel = yearInput.selectedOptions?.[0]?.textContent || null;
  const filters = state.query?.direction ? DIRECTION_LABELS[state.query.direction] : null;
  mountPrintMeta(container, {
    view: "Księga przychodów i wydatków",
    schoolYear: yearLabel,
    filters,
    printedBy,
    incompleteCount: state.nextCursor ? state.entries.length : null,
  });
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

const OPEN_ENTRY_HINT = "Dostępne po wczytaniu roku szkolnego.";
const FILTER_CHANGED_HINT = "Zmieniono filtr. Kliknij „Pokaż”, aby wczytać księgę dla nowego filtra.";

function filterChanged() {
  return ledgerFilterChanged(state.query, { schoolYearId: yearInput.value, direction: directionInput.value });
}

// „Dodaj wpis” i „Wczytaj następne” działają tylko dla zatwierdzonego (wczytanego) zapytania (#192).
function updateControls() {
  const changed = filterChanged();
  const openEntry = byId("open-entry");
  const hint = byId("open-entry-hint");
  openEntry.disabled = state.loading || !state.query || changed;
  hint.textContent = changed ? FILTER_CHANGED_HINT : OPEN_ENTRY_HINT;
  hint.hidden = !openEntry.disabled || state.loading;
  loadMore.disabled = state.loading || changed;
  byId("load-more-hint").hidden = !changed || !state.nextCursor;
  printButton.disabled = state.loading || state.printing || !state.query || changed || state.entries.length === 0;
}

function setBusy(busy) {
  state.loading = busy;
  filtersForm.querySelector("button").disabled = busy;
  updateControls();
}

// Pierwsza strona dla podanego zapytania albo (append) następna strona zapamiętanego zapytania.
async function loadEntries({ append = false, query = state.query } = {}) {
  const url = append ? buildNextLedgerUrl(state.query, state.nextCursor) : buildLedgerUrl(query);
  if (!url) return;
  const data = await api(url);
  const items = Array.isArray(data.entries) ? data.entries : [];
  state.entries = append ? [...state.entries, ...items] : items;
  state.nextCursor = data.nextCursor || null;
  renderEntries();
}

async function loadOverview({ reload = false } = {}) {
  if (state.loading) return;
  let query;
  try {
    query = reload && state.query
      ? state.query
      : ledgerQuery({ schoolYearId: yearInput.value, direction: directionInput.value });
  } catch (error) {
    message.className = "message error";
    message.textContent = error.message;
    return;
  }
  message.textContent = "";
  message.className = "message";
  overview.hidden = true;
  state.query = null;
  setBusy(true);
  try {
    const year = query.schoolYearId;
    const [summaryData, budgetData, categoriesData] = await Promise.all([
      api(buildOverviewUrl("summary", year)),
      api(buildOverviewUrl("budget", year)),
      api(buildOverviewUrl("categories", year)),
      loadEntries({ query }),
    ]);
    state.query = query;
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

function syncFiltersToUrl() {
  const query = filtersToQuery({ schoolYearId: yearInput.value, direction: directionInput.value });
  const url = `${window.location.pathname}${query ? `?${query}` : ""}`;
  window.history.replaceState(null, "", url);
}

filtersForm.addEventListener("submit", (event) => {
  event.preventDefault();
  syncFiltersToUrl();
  loadOverview();
});

// Wybór roku z listy zamiast wpisywania identyfikatora (issue #128); filtry odtwarzane
// z adresu (query string), nie z localStorage.
(async function initFilters() {
  const restored = filtersFromQuery(window.location.search, FILTER_KEYS);
  let years = [];
  try {
    const access = await api("/api/access");
    years = yearsFromGrants(access && access.grants);
  } catch {
    years = [];
  }
  const year = defaultYear(years, restored.schoolYearId);
  yearInput.innerHTML = yearOptionsHtml(years, year);
  if (restored.direction && [...directionInput.options].some((o) => o.value === restored.direction)) {
    directionInput.value = restored.direction;
  }
  if (year) {
    syncFiltersToUrl();
    loadOverview();
  }
})();
loadMore.addEventListener("click", async () => {
  if (state.loading || filterChanged() || !buildNextLedgerUrl(state.query, state.nextCursor)) return;
  setBusy(true);
  try { await loadEntries({ append: true }); }
  catch (error) { message.className = "message error"; message.textContent = error.message; }
  finally { setBusy(false); }
});

// „Drukuj zestawienie” dociąga wszystkie strony bieżącego filtra przed wydrukiem,
// żeby wydruk nigdy nie ucinał wpisów po jednej stronie (#151). Znacznik
// state.printing chroni przed podwójnym kliknięciem, tak jak state.loading wyżej.
printButton.addEventListener("click", async () => {
  if (state.loading || state.printing || filterChanged() || !state.query) return;
  state.printing = true;
  updateControls();
  try {
    while (buildNextLedgerUrl(state.query, state.nextCursor)) {
      await loadEntries({ append: true });
      renderEntries();
    }
    updatePrintMeta();
    window.print();
  } catch (error) {
    message.className = "message error";
    message.textContent = error.message;
  } finally {
    state.printing = false;
    updateControls();
  }
});

// #225: Księgę prowadzą role finansowe. Inne konta widzą jeden komunikat zamiast
// formularzy. Sesja przed MFA dostaje z /api/access puste grants (brak akcji).
async function applyAccess() {
  let access;
  try {
    access = await api("/api/access");
  } catch (error) {
    message.className = "message error";
    message.textContent = error.message;
    return;
  }
  const grants = Array.isArray(access.grants) ? access.grants : [];
  if (hasFinancialAccess(grants)) return;
  byId("open-entry").hidden = true;
  byId("open-entry-hint").hidden = true;
  filtersForm.closest("section").hidden = true;
  const notice = byId("access-notice");
  if (access.mfaRequired === true) notice.textContent = describeApiError(403, "mfa_required");
  notice.hidden = false;
}
applyAccess();

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
      await loadOverview({ reload: true });
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
  if (!state.query || filterChanged()) return;
  entryDialog.form.elements.schoolYearId.value = state.query.schoolYearId;
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

yearInput.addEventListener("input", updateControls);
directionInput.addEventListener("change", updateControls);
updateControls();
