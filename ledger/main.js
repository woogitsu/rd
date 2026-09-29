import { describeApiError, hasFinancialAccess } from "./core.js";
import { canRecordOpeningBalance, categoryCopyConfirm, categoryCopyRequestBody, openEntryState, openingBalanceRequestBody } from "./core.js";
import {
  DIRECTION_LABELS,
  METHOD_LABELS,
  buildLedgerUrl,
  buildNextLedgerUrl,
  budgetAdoptionRequestBody,
  budgetExecutionRow,
  budgetHistoryView,
  budgetLineRequestBody,
  budgetRevisionRequestBody,
  buildBudgetHistoryUrl,
  canAdoptBudget,
  categoryRequestBody,
  deactivationRequestBody,
  buildCostCentersUrl,
  buildOverviewUrl,
  costCenterRows,
  buildResolutionsUrl,
  formatCents,
  isValidId,
  ledgerFilterChanged,
  ledgerQuery,
  makeIdempotencyKey,
  needsResolution,
  normalizeEntry,
  parseEuroAmount,
  resolutionLimitInfo,
  resolutionOptionLabel,
} from "./core.js";
import { api as apiRequest } from "../shared/api.js";
import { confirmAction } from "../shared/confirm-dialog.js";
import { filtersFromQuery, filtersToQuery } from "../shared/query-filters.js";
import { panelYearState, yearOptionsHtml, yearsFromGrants } from "../shared/school-year.js";
import { mountShell } from "../shared/shell.js";
import "../shared/shell.css";
import { mountPrintMeta } from "../shared/print-meta.js";
import "../shared/print.css";

let printedBy = null;
mountShell().then((result) => { printedBy = result?.session?.displayName || result?.session?.email || null; });

const FILTER_KEYS = ["schoolYearId", "direction"];
const state = { entries: [], categories: [], resolutions: [], resolutionsError: "", grants: [], history: { rows: [], adoptionRows: [], currentLines: [] }, opening: null, nextCursor: null, query: null, loading: false, requestKey: null, printing: false };
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
  const evidence = entry.attachmentCount === null ? "" : `Dowody: ${entry.attachmentCount}`;
  if (entry.source || entry.resolutionReference || evidence) {
    const details = document.createElement("small");
    details.textContent = [entry.source && `Źródło: ${entry.source}`, entry.resolutionReference && `Uchwała: ${entry.resolutionReference}`, evidence].filter(Boolean).join(" · ");
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

// #107: preliminarz bieżący a wykonanie netto (GET /api/ledger/budget/execution).
function renderBudget(lines) {
  const rows = lines.map((item) => {
    const view = budgetExecutionRow(item);
    const row = document.createElement("tr");
    row.append(textCell(view.categoryName));
    const type = textCell(DIRECTION_LABELS[view.direction] ?? "—");
    type.className = view.direction === "expense" ? "expense" : "income";
    row.append(type, textCell(view.planned, "amount"),
      textCell(view.executed, view.overBudget ? "amount over-budget" : "amount"), textCell(view.percent, "amount"),
      textCell(view.note || "—"));
    return row;
  });
  budgetBody.replaceChildren(...rows);
  byId("budget-count").textContent = lines.length === 1 ? "1 pozycja" : `${lines.length} pozycji`;
  budgetBody.closest(".table-wrap").hidden = rows.length === 0;
  byId("budget-empty").hidden = rows.length !== 0;
}

// #107: historia wersji linii i przyjęcia (GET /api/ledger/budget/history).
function renderHistory(history, error) {
  const errorBox = byId("history-error");
  errorBox.hidden = !error;
  errorBox.textContent = error ? `Nie udało się pobrać historii preliminarza: ${error}` : "";
  const view = budgetHistoryView(error ? null : history);
  state.history = view;
  const rows = view.rows.map((item) => {
    const row = document.createElement("tr");
    const state_ = [item.current ? "bieżąca" : "zastąpiona", item.adoptedOn.length ? `przyjęta ${item.adoptedOn.join(", ")}` : ""].filter(Boolean).join("; ");
    row.append(textCell(item.categoryName), textCell(DIRECTION_LABELS[item.direction]), textCell(String(item.version), "amount"),
      textCell(item.planned, "amount"), textCell(item.reason), textCell(`${item.createdAt} · ${item.createdBy}`), textCell(state_));
    return row;
  });
  byId("history-body").replaceChildren(...rows);
  byId("history-count").textContent = rows.length === 1 ? "1 wersja" : `${rows.length} wersji`;
  byId("history-body").closest(".table-wrap").hidden = rows.length === 0;
  byId("history-empty").hidden = error || rows.length !== 0;
  const adoptions = view.adoptionRows.map((item) => {
    const row = document.createElement("tr");
    row.append(textCell(item.adoptedOn), textCell(item.note), textCell(item.resolution), textCell(String(item.lineCount), "amount"), textCell(item.adoptedBy));
    return row;
  });
  byId("adoptions-body").replaceChildren(...adoptions);
  byId("adoptions-body").closest(".table-wrap").hidden = adoptions.length === 0;
  byId("adoptions-empty").hidden = error || adoptions.length !== 0;
}

function renderCostCenters(report, error) {
  const body = byId("events-body");
  const errorBox = byId("events-error");
  errorBox.hidden = !error;
  errorBox.textContent = error ? `Nie udało się pobrać wyniku wydarzeń: ${error}` : "";
  const wrap = body.closest(".table-wrap");
  if (error || !report) { body.replaceChildren(); wrap.hidden = true; byId("events-empty").hidden = true; byId("events-count").textContent = ""; return; }
  const view = costCenterRows(report);
  const build = (item, strong) => {
    const row = document.createElement("tr");
    const name = textCell(item.name);
    if (strong) name.style.fontWeight = "700";
    row.append(name, textCell(item.status || "—"), textCell(item.entryCount === null ? "—" : String(item.entryCount), "amount"),
      textCell(item.income, "amount"), textCell(item.expense, "amount"),
      // Wynik ujemny opisany też tekstem (znak minus), nie tylko kolorem.
      textCell(item.result, item.negative ? "amount over-budget" : "amount"));
    return row;
  };
  body.replaceChildren(...view.centers.map((item) => build(item, false)), build(view.general, false), build(view.totals, true));
  byId("events-count").textContent = view.centers.length === 1 ? "1 wydarzenie" : `${view.centers.length} wydarzeń`;
  byId("events-empty").hidden = view.centers.length !== 0;
  wrap.hidden = false;
}

function renderSummary(summary) {
  byId("opening-balance").textContent = formatCents(summary.openingBalanceCents);
  byId("income-total").textContent = formatCents(summary.incomeCents);
  byId("expense-total").textContent = formatCents(summary.expenseCents);
  byId("closing-balance").textContent = formatCents(summary.closingBalanceCents);
}

function filterChanged() {
  return ledgerFilterChanged(state.query, { schoolYearId: yearInput.value, direction: directionInput.value });
}

// „Dodaj wpis” i „Wczytaj następne” działają tylko dla zatwierdzonego (wczytanego) zapytania (#192).
function updateControls() {
  const changed = filterChanged();
  const openEntry = byId("open-entry");
  const hint = byId("open-entry-hint");
  // #207: rok bez kategorii — przycisk wyłączony z wyjaśnieniem zamiast błędu invalid_category po zapisie.
  const entryState = openEntryState({ loading: state.loading, query: state.query, changed, categoryCount: state.categories.length });
  openEntry.disabled = entryState.disabled;
  hint.textContent = entryState.hint;
  hint.hidden = !openEntry.disabled || state.loading;
  loadMore.disabled = state.loading || changed;
  byId("load-more-hint").hidden = !changed || !state.nextCursor;
  printButton.disabled = state.loading || state.printing || !state.query || changed || state.entries.length === 0;
}

// Skrót interfejsu: serwer i tak sprawdza rolę, MFA i rok przy każdym zapisie.
function updateBudgetActions() {
  const year = state.query?.schoolYearId ?? "";
  const financial = hasFinancialAccess(state.grants, year);
  byId("budget-actions").hidden = !financial;
  byId("open-adoption").hidden = !canAdoptBudget(state.grants, year);
  byId("open-line").disabled = state.history.rows.length === 0 && state.categories.length === 0;
  byId("opening-actions").hidden = !canRecordOpeningBalance(state.grants, year, state.opening);
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
  state.categories = [];
  state.opening = null;
  setBusy(true);
  try {
    const year = query.schoolYearId;
    const [summaryData, budgetData, categoriesData, costCentersData, resolutionsData, historyData, openingData] = await Promise.all([
      api(buildOverviewUrl("summary", year)),
      api(buildOverviewUrl("budget/execution", year)),
      api(buildOverviewUrl("categories", year)),
      // Widok pomocniczy: jego błąd nie blokuje podglądu księgi.
      api(buildCostCentersUrl(year)).catch((error) => ({ error })),
      // Lista uchwał jest pomocnicza: jej błąd nie blokuje podglądu księgi.
      api(buildResolutionsUrl(year)).catch((error) => ({ error })),
      // Historia preliminarza jest pomocnicza: jej błąd nie blokuje podglądu księgi.
      api(buildBudgetHistoryUrl(year)).catch((error) => ({ error })),
      // #207: bilans otwarcia (podział rachunek/kasa) — pomocniczy; błąd ukrywa tylko formularz.
      api(`/api/ledger/opening-balance?${new URLSearchParams({ schoolYearId: year })}`).catch(() => null),
      loadEntries({ query }),
    ]);
    state.query = query;
    state.categories = Array.isArray(categoriesData.categories) ? categoriesData.categories : [];
    state.opening = openingData && typeof openingData === "object" ? openingData : null;
    state.resolutions = Array.isArray(resolutionsData?.resolutions) ? resolutionsData.resolutions : [];
    state.resolutionsError = resolutionsData?.error ? resolutionsData.error.message : "";
    renderSummary(summaryData.summary ?? {});
    renderHistory(historyData, historyData?.error ? historyData.error.message : "");
    updateBudgetActions();
    renderCostCenters(costCentersData?.report ?? null, costCentersData?.error ? costCentersData.error.message : "");
    byId("events-csv").href = buildCostCentersUrl(year, "csv");
    renderBudget(Array.isArray(budgetData.execution?.items) ? budgetData.execution.items : []);
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
  let year = "";
  try {
    const access = await api("/api/access");
    ({ years, year } = panelYearState(access && access.grants, restored.schoolYearId));
  } catch {
    years = [];
  }
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
  state.grants = grants;
  updateBudgetActions();
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
  const resolutionId = direction === "expense" ? String(data.get("resolutionId") || "").trim() : "";
  if (needsResolution(direction, amountCents) && !resolutionId) throw new Error("Dla tego wydatku wybierz uchwałę z listy.");
  if (resolutionId && !isValidId(resolutionId)) throw new Error("Niepoprawny identyfikator uchwały.");
  const sourceDocumentId = String(data.get("sourceDocumentId") || "").trim();
  if (sourceDocumentId && !isValidId(sourceDocumentId)) throw new Error("Niepoprawny identyfikator dokumentu.");
  const categoryId = String(data.get("categoryId") || "");
  if (!isValidId(categoryId)) throw new Error("Brak kategorii tego rodzaju w tym roku. Dodaj albo skopiuj kategorie w sekcji „Historia preliminarza”.");
  const evidenceFile = data.get("evidenceFile");
  const hasFile = evidenceFile && typeof evidenceFile === "object" && evidenceFile.size > 0;
  const schoolYearId = String(data.get("schoolYearId"));
  const created = await api("/api/ledger", {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify({
      schoolYearId, direction, amountCents,
      categoryId, description: String(data.get("description")),
      occurredOn: String(data.get("occurredOn")), method: String(data.get("method")),
      source: String(data.get("source") || "") || null,
      sourceDocumentId: sourceDocumentId || null,
      resolutionId: resolutionId || null,
    }),
  });
  // #87: dowód dołączany po zapisie wpisu, z kluczem pochodnym od klucza wpisu —
  // ponowienie po błędzie odtwarza wpis (ten sam klucz) i dołącza plik raz.
  if (hasFile && created?.entry?.id) {
    const query = new URLSearchParams({ kind: "financial", schoolYearId, linkedEntityType: "ledger_entry", linkedEntityId: created.entry.id });
    try {
      await api(`/api/documents?${query}`, {
        method: "POST", headers: { "Idempotency-Key": `${key}-doc`, "Content-Type": evidenceFile.type }, body: evidenceFile,
      });
    } catch (error) {
      error.message = `Wpis zapisano, ale nie dołączono dowodu: ${error.message} Zapisz ponownie, aby dołączyć plik.`;
      throw error;
    }
  }
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
  // #207: pusty rodzaj opisany wprost (zamiast pustej listy i błędu invalid_category po zapisie).
  fillSelect(select, state.categories.filter((item) => item.direction === direction).map((item) => ({ value: item.id, label: item.name })),
    `Brak kategorii: ${direction === "expense" ? "wydatki" : "przychody"} w tym roku`);
}

function updateResolutionField() {
  const form = entryDialog.form;
  let amount = 0;
  try { amount = parseEuroAmount(form.elements.amount.value); } catch {}
  const isExpense = form.elements.direction.value === "expense";
  const required = needsResolution(form.elements.direction.value, amount);
  const select = form.elements.resolutionId;
  const previous = select.value;
  // Uchwałę można wskazać przy każdym wydatku (upoważnienie kwotowe); wymagana powyżej progu.
  byId("resolution-field").hidden = !isExpense;
  byId("resolution-hint").hidden = !isExpense;
  select.required = required;
  const placeholder = document.createElement("option");
  placeholder.value = ""; placeholder.textContent = required ? "Wybierz uchwałę" : "Bez uchwały";
  const options = state.resolutions.map((item) => {
    const option = document.createElement("option"); option.value = item.id; option.textContent = resolutionOptionLabel(item); return option;
  });
  select.replaceChildren(placeholder, ...options);
  if (state.resolutions.some((item) => item.id === previous)) select.value = previous;
  const hint = byId("resolution-hint");
  const chosen = state.resolutions.find((item) => item.id === select.value);
  if (chosen) {
    const info = resolutionLimitInfo(chosen, amount, form.elements.occurredOn.value);
    hint.textContent = info.text;
    hint.classList.toggle("warning", info.exceeded || info.expired);
  } else {
    hint.classList.remove("warning");
    hint.textContent = state.resolutionsError
      ? `Nie udało się pobrać listy uchwał: ${state.resolutionsError}`
      : required && state.resolutions.length === 0
        ? "Brak przyjętych uchwał zebrań ogólnych w tym i poprzednim roku. Uchwałę wpisuje zarząd w rejestrze uchwał."
        : "Wymagana dla wydatku powyżej 3000 EUR. Na liście są przyjęte uchwały zebrań ogólnych z tego i poprzedniego roku.";
  }
}

entryDialog.form.elements.direction.addEventListener("change", () => { updateCategories(); updateResolutionField(); });
entryDialog.form.elements.amount.addEventListener("input", updateResolutionField);
entryDialog.form.elements.occurredOn.addEventListener("input", updateResolutionField);
entryDialog.form.elements.resolutionId.addEventListener("change", updateResolutionField);
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

// --- #107: formularze preliminarza (istniejące trasy ledger-budget.js) ---------------

const post = (path, key, body) => api(path, { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(body) });
const centsText = (value) => { try { return formatCents(parseEuroAmount(value)); } catch { return String(value || ""); } };

function fillSelect(select, items, placeholder) {
  const options = items.map(({ value, label }) => {
    const option = document.createElement("option"); option.value = value; option.textContent = label; return option;
  });
  select.replaceChildren(...options);
  select.disabled = options.length === 0;
  if (options.length === 0 && placeholder) { const empty = document.createElement("option"); empty.textContent = placeholder; select.replaceChildren(empty); }
}

const categoryDialog = configureDialog("category-dialog", "ledger-category", async (data, key) => {
  await post("/api/ledger/categories", key, categoryRequestBody({
    schoolYearId: data.get("schoolYearId"), direction: data.get("direction"), name: data.get("name"),
  }));
}, "Dodano kategorię.", (data) => ({
  title: "Dodać kategorię?",
  effects: [`Nazwa: ${String(data.get("name") || "").trim()}`, `Rodzaj: ${DIRECTION_LABELS[data.get("direction")] ?? "—"}`, "Nazwa kategorii jest trwała; kategorię można później wyłączyć, ale nie usunąć."],
  confirmLabel: "Dodaj kategorię",
}));

const deactivateDialog = configureDialog("deactivate-dialog", "ledger-deactivate", async (data, key) => {
  const { categoryId, body } = deactivationRequestBody({ categoryId: data.get("categoryId"), reason: data.get("reason") });
  await post(`/api/ledger/categories/${encodeURIComponent(categoryId)}/deactivation`, key, body);
}, "Wyłączono kategorię.", (data) => {
  const category = state.categories.find((c) => c.id === data.get("categoryId"));
  return {
    title: "Wyłączyć kategorię?",
    effects: [`Kategoria: ${category ? category.name : "—"}`, `Powód: ${String(data.get("reason") || "").trim() || "—"}`, "Kategoria nie przyjmie nowych wpisów; dotychczasowe wpisy i plan zostają widoczne."],
    confirmLabel: "Wyłącz kategorię",
  };
});

const lineDialog = configureDialog("line-dialog", "ledger-budget-line", async (data, key) => {
  await post("/api/ledger/budget", key, budgetLineRequestBody({
    schoolYearId: data.get("schoolYearId"), categoryId: data.get("categoryId"), amount: data.get("amount"), note: data.get("note"),
  }));
}, "Zapisano linię preliminarza.", (data) => {
  const category = state.categories.find((c) => c.id === data.get("categoryId"));
  return {
    title: "Zapisać linię planu?",
    effects: [`Kategoria: ${category ? category.name : "—"}`, `Plan: ${centsText(data.get("amount"))}`, "Kolejną zmianę zapiszesz jako nową wersję; historia zostaje."],
    confirmLabel: "Zapisz linię",
  };
});

const revisionDialog = configureDialog("revision-dialog", "ledger-budget-revision", async (data, key) => {
  const { lineId, body } = budgetRevisionRequestBody({ lineId: data.get("lineId"), amount: data.get("amount"), reason: data.get("reason") });
  await post(`/api/ledger/budget/${encodeURIComponent(lineId)}/revisions`, key, body);
}, "Zapisano nową wersję linii.", (data) => {
  const line = state.history.currentLines.find((item) => item.id === data.get("lineId"));
  return {
    title: "Zapisać nową wersję planu?",
    effects: [`Kategoria: ${line ? line.categoryName : "—"}`, `Dotychczas: ${line ? line.planned : "—"}`, `Nowy plan: ${centsText(data.get("amount"))}`, `Powód: ${String(data.get("reason") || "").trim() || "—"}`, "Poprzednia wersja zostaje w historii."],
    confirmLabel: "Zapisz nową wersję",
  };
});

const adoptionDialog = configureDialog("adoption-dialog", "ledger-budget-adoption", async (data, key) => {
  await post("/api/ledger/budget/adoptions", key, budgetAdoptionRequestBody({
    schoolYearId: data.get("schoolYearId"), adoptedOn: data.get("adoptedOn"), note: data.get("note"), resolutionId: data.get("resolutionId"),
  }));
}, "Zapisano przyjęcie preliminarza.", (data) => ({
  title: "Zapisać przyjęcie preliminarza?",
  effects: [`Data przyjęcia: ${data.get("adoptedOn")}`, `Liczba linii: ${state.history.currentLines.length}`, "Zapis jest trwały; późniejsze zmiany planu tworzą nowe wersje i nie zmieniają przyjętego zestawu."],
  confirmLabel: "Zapisz przyjęcie",
}));

// #207: kopiowanie kategorii z innego roku — najpierw podgląd (dryRun), potem
// potwierdzenie z listą skutków, dopiero wtedy zapis. Serwer nie duplikuje
// kategorii przy ponowieniu (ON CONFLICT DO NOTHING), więc podwójne kliknięcie
// nie tworzy drugiego zestawu.
const copyDialog = configureDialog("copy-dialog", "ledger-category-copy", async (data) => {
  const body = categoryCopyRequestBody({ fromSchoolYearId: data.get("fromSchoolYearId"), toSchoolYearId: data.get("schoolYearId") });
  const copy = (dryRun) => api("/api/ledger/categories/copy", { method: "POST", body: JSON.stringify({ ...body, dryRun }) });
  const confirmed = await confirmAction(categoryCopyConfirm(await copy(true), body));
  if (!confirmed) throw new Error("Anulowano kopiowanie. Nic nie zapisano.");
  await copy(false);
}, "Skopiowano kategorie.");

const openingDialog = configureDialog("opening-dialog", "ledger-opening", async (data, key) => {
  await post("/api/ledger/opening-balance", key, openingBalanceRequestBody({
    schoolYearId: data.get("schoolYearId"), bank: data.get("bank"), cash: data.get("cash"),
    note: data.get("note"), sourceDocumentId: data.get("sourceDocumentId"),
  }));
}, "Zapisano bilans otwarcia.", (data) => {
  let amounts = [];
  try {
    const body = openingBalanceRequestBody({ schoolYearId: data.get("schoolYearId"), bank: data.get("bank"), cash: data.get("cash"), note: data.get("note") });
    amounts = [`Rachunek: ${formatCents(body.bankCents)}`, `Kasa: ${formatCents(body.cashCents)}`, `Razem: ${formatCents(body.bankCents + body.cashCents)}`];
  } catch (error) {
    amounts = [error.message];
  }
  return {
    title: "Zapisać bilans otwarcia?",
    effects: [...amounts, "Zapis jest trwały; pomyłkę poprawia wpis poprawki, pierwotna kwota zostaje w historii."],
    confirmLabel: "Zapisz bilans",
  };
});

function openBudgetDialog(dialogRef, prepare) {
  if (!state.query || filterChanged()) return;
  const form = dialogRef.form;
  if (form.elements.schoolYearId) form.elements.schoolYearId.value = state.query.schoolYearId;
  prepare(form);
  dialogRef.dialog.showModal();
}

byId("open-category").addEventListener("click", () => openBudgetDialog(categoryDialog, () => {}));
byId("open-copy").addEventListener("click", () => openBudgetDialog(copyDialog, () => {
  const current = state.query?.schoolYearId ?? "";
  const options = yearsFromGrants(state.grants).filter((year) => year !== current).map((year) => {
    const option = document.createElement("option"); option.value = year; return option;
  });
  byId("copy-year-options").replaceChildren(...options);
}));
byId("open-opening").addEventListener("click", () => openBudgetDialog(openingDialog, (form) => { form.elements.cash.value = "0,00"; }));
byId("open-deactivate").addEventListener("click", () => openBudgetDialog(deactivateDialog, (form) => {
  fillSelect(form.elements.categoryId, state.categories.filter((c) => c.active !== false).map((c) => ({ value: c.id, label: `${c.name} (${DIRECTION_LABELS[c.direction] ?? "—"})` })), "Brak aktywnych kategorii");
}));
byId("open-line").addEventListener("click", () => openBudgetDialog(lineDialog, (form) => {
  const withLine = new Set(state.history.rows.map((row) => row.categoryId));
  fillSelect(form.elements.categoryId, state.categories.filter((c) => c.active !== false && !withLine.has(c.id)).map((c) => ({ value: c.id, label: `${c.name} (${DIRECTION_LABELS[c.direction] ?? "—"})` })), "Wszystkie kategorie mają już linię");
}));
byId("open-revision").addEventListener("click", () => openBudgetDialog(revisionDialog, (form) => {
  fillSelect(form.elements.lineId, state.history.currentLines.map((row) => ({ value: row.id, label: `${row.categoryName} — plan ${row.planned} (wersja ${row.version})` })), "Brak linii preliminarza");
}));
byId("open-adoption").addEventListener("click", () => openBudgetDialog(adoptionDialog, (form) => {
  form.elements.adoptedOn.value = localDate();
  const select = form.elements.resolutionId;
  const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = "Bez uchwały";
  select.replaceChildren(placeholder, ...state.resolutions.map((item) => {
    const option = document.createElement("option"); option.value = item.id; option.textContent = resolutionOptionLabel(item); return option;
  }));
}));
