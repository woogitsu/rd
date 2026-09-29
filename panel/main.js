import { describeApiError, hasFinancialAccess } from "./core.js";
import {
  METHOD_LABELS,
  STATUS_LABELS,
  buildNextPaymentsUrl,
  buildPaymentsUrl,
  formatCents,
  isValidId,
  makeIdempotencyKey,
  normalizePayment,
  parseEuroAmount,
  paymentsFilterChanged,
  paymentsQuery,
} from "./core.js";
import { api as apiRequest } from "../shared/api.js";
import { confirmAction } from "../shared/confirm-dialog.js";
import { filtersFromQuery, filtersToQuery } from "../shared/query-filters.js";
import { defaultYear, yearOptionsHtml, yearsFromGrants } from "../shared/school-year.js";
import {
  buildHouseholdLabels,
  classOptionsHtml,
  householdLabel,
  householdOptionsHtml,
  householdSummary,
  householdsForStudent,
  requiresExplicitHouseholdChoice,
  shownSummary,
  studentOptionsHtml,
} from "../shared/household-picker.js";
import { mountShell } from "../shared/shell.js";
import "../shared/shell.css";
import { mountPrintMeta } from "../shared/print-meta.js";
import "../shared/print.css";

let printedBy = null;
mountShell().then((result) => { printedBy = result?.session?.displayName || result?.session?.email || null; });

const FILTER_KEYS = ["schoolYearId", "status"];
const state = { householdLabels: new Map(), labelsYear: null, payments: [], nextCursor: null, query: null, loading: false, requestKey: null, printing: false };
const byId = (id) => document.getElementById(id);
const filtersForm = byId("filters-form");
const yearInput = byId("school-year-id");
const statusInput = byId("status-filter");
const body = byId("payments-body");
const message = byId("message");
const tableWrap = byId("table-wrap");
const loading = byId("loading");
const summary = byId("result-summary");
const loadMore = byId("load-more");
const filterHint = byId("filter-hint");
const printButton = byId("print-payments");

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

function actionButton(label, action, paymentId) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.dataset.action = action;
  button.dataset.paymentId = paymentId;
  return button;
}

function paymentRow(rawPayment) {
  const payment = normalizePayment(rawPayment);
  const row = document.createElement("tr");
  row.append(textCell(payment.receivedOn));

  const reference = textCell(payment.reference || "Bez opisu", "reference");
  const family = document.createElement("small");
  family.textContent = householdLabel(state.householdLabels, payment.householdId);
  reference.append(family);
  row.append(reference);
  row.append(textCell(METHOD_LABELS[payment.method]));

  const status = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = `badge ${payment.status}`;
  badge.textContent = STATUS_LABELS[payment.status];
  status.append(badge);
  row.append(status);
  row.append(textCell(formatCents(payment.amountCents), "amount"));
  row.append(textCell(formatCents(payment.correctedCents), "amount"));
  row.append(textCell(formatCents(payment.netCents), "amount"));

  const actions = document.createElement("td");
  const actionGroup = document.createElement("div");
  actionGroup.className = "row-actions";
  actionGroup.append(actionButton("Korekta", "correct", payment.id));
  if (payment.status === "unmatched") actionGroup.prepend(actionButton("Przypisz", "assign", payment.id));
  actions.append(actionGroup);
  row.append(actions);
  return row;
}

function render() {
  body.replaceChildren(...state.payments.map(paymentRow));
  const count = state.payments.length;
  summary.textContent = count === 0 ? "Brak wpłat." : shownSummary(count, Boolean(state.nextCursor));
  tableWrap.hidden = count === 0;
  message.className = "message";
  message.textContent = count === 0 ? "Brak wpłat dla wybranych filtrów." : "";
  loadMore.hidden = !state.nextCursor;
  updateFilterHint();
  updatePrintMeta();
}

function filterChanged() {
  return paymentsFilterChanged(state.query, { schoolYearId: yearInput.value, status: statusInput.value });
}

// Zmienione, niezatwierdzone pola filtra blokują dociąganie strony (#192).
function updateFilterHint() {
  const changed = filterChanged();
  filterHint.hidden = !changed;
  loadMore.disabled = state.loading || changed;
  printButton.disabled = state.loading || state.printing || changed || !state.query || state.payments.length === 0;
}

// Blok metadanych wydruku (#151), niewidoczny na ekranie (shared/print.css).
function updatePrintMeta() {
  const container = byId("print-meta");
  if (!container) return;
  const yearLabel = yearInput.selectedOptions?.[0]?.textContent || null;
  const filters = state.query?.status ? STATUS_LABELS[state.query.status] : null;
  mountPrintMeta(container, {
    view: "Dobrowolne wpłaty",
    schoolYear: yearLabel,
    filters,
    printedBy,
    incompleteCount: state.nextCursor ? state.payments.length : null,
  });
}

function setBusy(busy) {
  state.loading = busy;
  loading.hidden = !busy;
  filtersForm.querySelector("button").disabled = busy;
  updateFilterHint();
}

// Czytelne etykiety rodzin (#128) z tych samych tras klas/uczniów co wybór rodziny. Serwer
// decyduje o zakresie: rola bez dostępu (403) zostaje przy skróconym numerze, bez PII.
async function loadHouseholdLabels(schoolYearId) {
  if (state.labelsYear === schoolYearId) return;
  state.householdLabels = new Map();
  state.labelsYear = schoolYearId;
  try {
    const { classes = [] } = await api(`/api/classes?schoolYearId=${encodeURIComponent(schoolYearId)}`);
    const loaded = await Promise.all(classes.map(async (cls) => {
      const result = await api(`/api/classes/${encodeURIComponent(cls.id)}/students`);
      return { className: cls.name, students: Array.isArray(result.students) ? result.students : [] };
    }));
    state.householdLabels = buildHouseholdLabels(loaded);
  } catch {
    state.householdLabels = new Map();
  }
}

// append: następna strona zapamiętanego zapytania; bez append: pierwsza strona
// z pól formularza albo (reload) ponownie zapamiętane zapytanie po zapisie.
async function loadPayments({ append = false, reload = false } = {}) {
  if (state.loading) return;
  let url;
  let query = state.query;
  try {
    if (append) {
      url = buildNextPaymentsUrl(state.query, state.nextCursor);
      if (!url || filterChanged()) return;
    } else {
      if (!reload || !query) query = paymentsQuery({ schoolYearId: yearInput.value, status: statusInput.value });
      url = buildPaymentsUrl(query);
    }
  } catch (error) {
    message.className = "message error";
    message.textContent = error.message;
    return;
  }
  message.textContent = "";
  message.className = "message";
  setBusy(true);
  try {
    const result = await api(url);
    await loadHouseholdLabels(query.schoolYearId);
    if (!append) state.query = query;
    const items = Array.isArray(result.payments) ? result.payments : [];
    state.payments = append ? [...state.payments, ...items] : items;
    state.nextCursor = result.nextCursor || null;
    render();
  } catch (error) {
    message.className = "message error";
    message.textContent = error.message;
    if (!append) {
      state.payments = [];
      state.nextCursor = null;
      state.query = null;
      tableWrap.hidden = true;
      summary.textContent = "Nie udało się pobrać danych.";
    }
  } finally {
    setBusy(false);
  }
}

function syncFiltersToUrl() {
  const query = filtersToQuery({ schoolYearId: yearInput.value, status: statusInput.value });
  const url = `${window.location.pathname}${query ? `?${query}` : ""}`;
  window.history.replaceState(null, "", url);
}

filtersForm.addEventListener("submit", (event) => {
  event.preventDefault();
  syncFiltersToUrl();
  loadPayments();
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
  if (restored.status && [...statusInput.options].some((o) => o.value === restored.status)) {
    statusInput.value = restored.status;
  }
  if (year) {
    syncFiltersToUrl();
    loadPayments();
  }
})();
loadMore.addEventListener("click", () => loadPayments({ append: true }));

// „Drukuj zestawienie” dociąga wszystkie strony bieżącego filtra przed wydrukiem
// (#151); state.printing chroni przed podwójnym kliknięciem.
printButton.addEventListener("click", async () => {
  if (state.loading || state.printing || filterChanged() || !state.query) return;
  state.printing = true;
  updateFilterHint();
  try {
    while (buildNextPaymentsUrl(state.query, state.nextCursor)) {
      await loadPayments({ append: true });
    }
    updatePrintMeta();
    window.print();
  } finally {
    state.printing = false;
    updateFilterHint();
  }
});
yearInput.addEventListener("input", updateFilterHint);
statusInput.addEventListener("change", updateFilterHint);

// Po zapisie tabela jest renderowana od nowa, więc przycisk otwierający okno może zniknąć.
// Wtedy przenosimy fokus na nagłówek listy, aby nie spadł na <body> (WCAG 2.4.3).
function restoreFocus() {
  if (document.activeElement && document.activeElement !== document.body) return;
  const heading = byId("payments-title");
  heading.tabIndex = -1;
  heading.focus();
}

function configureDialog(id, prefix, submit, successText, describeConfirm) {
  const dialog = byId(id);
  const form = dialog.querySelector("form");
  const errorBox = form.querySelector(".form-error");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (event.submitter?.value === "cancel") {
      dialog.close();
      state.requestKey = null;
      return;
    }
    if (!form.reportValidity()) return;

    // Podsumowanie skutków przed zapisem (issue #136) — zapis jest trwały,
    // poprawka wymaga nowej korekty widocznej w historii.
    if (describeConfirm) {
      const confirmed = await confirmAction(describeConfirm(new FormData(form)));
      if (!confirmed) return;
    }

    errorBox.textContent = "";
    const submitButton = event.submitter;
    submitButton.disabled = true;
    state.requestKey ||= makeIdempotencyKey(prefix);
    try {
      await submit(new FormData(form), state.requestKey);
      state.requestKey = null;
      dialog.close();
      form.reset();
      await loadPayments({ reload: true });
      if (!message.classList.contains("error")) message.textContent = successText;
      restoreFocus();
    } catch (error) {
      errorBox.textContent = error.code === "idempotency_conflict"
        ? `${error.message} Jeśli chcesz zmienić dane operacji, anuluj formularz i otwórz go ponownie.`
        : error.message;
    } finally {
      submitButton.disabled = false;
    }
  });

  dialog.addEventListener("close", () => {
    errorBox.textContent = "";
    state.requestKey = null;
  });
  return { dialog, form };
}

// Wybór rodziny przez klasę → ucznia → gospodarstwo, zamiast wpisywania UUID (issue #128).
// Pole UUID zostaje jako tryb zaawansowany (<details>) — patrz propozycja p.2 w issue.
function wireHouseholdPicker(prefix, getSchoolYearId) {
  const classSelect = byId(`${prefix}-class`);
  const studentSelect = byId(`${prefix}-student`);
  const householdSelect = byId(`${prefix}-household`);
  const summary = byId(`${prefix}-household-summary`);
  const idInput = byId(`${prefix}-household-id`);
  let students = [];

  function reset() {
    classSelect.innerHTML = "";
    studentSelect.innerHTML = "";
    householdSelect.innerHTML = "";
    studentSelect.disabled = true;
    householdSelect.disabled = true;
    summary.textContent = "";
    students = [];
  }

  async function loadClasses() {
    reset();
    const schoolYearId = getSchoolYearId();
    if (!isValidId(schoolYearId)) {
      classSelect.innerHTML = classOptionsHtml([], "");
      return;
    }
    try {
      const result = await api(`/api/classes?schoolYearId=${encodeURIComponent(schoolYearId)}`);
      classSelect.innerHTML = classOptionsHtml(Array.isArray(result.classes) ? result.classes : [], "");
    } catch {
      classSelect.innerHTML = classOptionsHtml([], "");
    }
  }

  classSelect.addEventListener("change", async () => {
    studentSelect.innerHTML = "";
    householdSelect.innerHTML = "";
    householdSelect.disabled = true;
    summary.textContent = "";
    students = [];
    if (!classSelect.value) {
      studentSelect.disabled = true;
      return;
    }
    try {
      const result = await api(`/api/classes/${encodeURIComponent(classSelect.value)}/students`);
      students = Array.isArray(result.students) ? result.students : [];
      studentSelect.innerHTML = studentOptionsHtml(students, "");
      studentSelect.disabled = false;
    } catch {
      studentSelect.innerHTML = studentOptionsHtml([], "");
      studentSelect.disabled = true;
    }
  });

  studentSelect.addEventListener("change", () => {
    const households = householdsForStudent(students, studentSelect.value);
    householdSelect.innerHTML = householdOptionsHtml(households, "");
    householdSelect.disabled = households.length === 0;
    const student = students.find((s) => s.id === studentSelect.value) || null;
    summary.textContent = householdSummary(student, households);
    idInput.value = requiresExplicitHouseholdChoice(households) ? "" : (households[0]?.householdId ?? "");
  });

  householdSelect.addEventListener("change", () => {
    idInput.value = householdSelect.value;
  });

  return { loadClasses, reset };
}

const paymentPicker = wireHouseholdPicker("payment", () => paymentDialog.form.elements.schoolYearId.value);
const assignmentPicker = wireHouseholdPicker(
  "assignment",
  () => assignmentDialog.form.querySelector(".context").dataset.schoolYearId || ""
);

const paymentDialog = configureDialog("payment-dialog", "payment", async (data, requestKey) => {
  const householdId = String(data.get("householdId") || "").trim();
  if (householdId && !isValidId(householdId)) throw new Error("Niepoprawny identyfikator rodziny.");
  await api("/api/payments", {
    method: "POST",
    headers: { "Idempotency-Key": requestKey },
    body: JSON.stringify({
      schoolYearId: String(data.get("schoolYearId") || "").trim(),
      amountCents: parseEuroAmount(data.get("amount")),
      receivedOn: data.get("receivedOn"),
      method: data.get("method"),
      reference: data.get("reference"),
      ...(householdId ? { householdId } : {}),
    }),
  });
}, "Zapisano wpłatę.", (data) => {
  const householdId = String(data.get("householdId") || "").trim();
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
    title: "Zapisać wpłatę?",
    effects: [
      `Kwota: ${amountText}`,
      `Data wpływu: ${data.get("receivedOn")}`,
      `Metoda: ${METHOD_LABELS[data.get("method")] ?? data.get("method")}`,
      householdId ? householdLabel(state.householdLabels, householdId) : "Bez przypisania rodziny — wpłata trafi do „Do przypisania”.",
      "Zapis jest trwały; pomyłkę poprawisz korektą widoczną w historii.",
    ],
    warning,
    confirmLabel: "Zapisz wpłatę",
  };
});

const correctionDialog = configureDialog("correction-dialog", "correction", async (data, requestKey) => {
  const paymentId = String(data.get("paymentId"));
  await api(`/api/payments/${encodeURIComponent(paymentId)}/corrections`, {
    method: "POST",
    headers: { "Idempotency-Key": requestKey },
    body: JSON.stringify({
      amountCents: parseEuroAmount(data.get("amount")),
      reason: data.get("reason"),
    }),
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
      "Korekta nie usuwa pierwotnego zapisu — kwota netto zostanie przeliczona, historia zostaje widoczna.",
    ],
    confirmLabel: "Dodaj korektę",
  };
});

const assignmentDialog = configureDialog("assignment-dialog", "assignment", async (data, requestKey) => {
  const paymentId = String(data.get("paymentId"));
  const householdId = String(data.get("householdId") || "").trim();
  if (!isValidId(householdId)) throw new Error("Niepoprawny identyfikator rodziny.");
  await api(`/api/payments/${encodeURIComponent(paymentId)}/assignment`, {
    method: "POST",
    headers: { "Idempotency-Key": requestKey },
    body: JSON.stringify({ householdId }),
  });
}, "Przypisano rodzinę.");

paymentDialog.form.elements.schoolYearId.addEventListener("change", () => paymentPicker.loadClasses());
byId("open-payment").addEventListener("click", () => {
  // Rok z listy filtra (lata z przydziałów użytkownika), bez wpisywania (#128).
  const dialogYear = paymentDialog.form.elements.schoolYearId;
  dialogYear.innerHTML = yearInput.innerHTML;
  dialogYear.value = state.query?.schoolYearId ?? yearInput.value;
  paymentDialog.form.elements.receivedOn.value = localDate();
  paymentPicker.loadClasses();
  paymentDialog.dialog.showModal();
});

body.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const payment = state.payments.map(normalizePayment).find((item) => item.id === button.dataset.paymentId);
  if (!payment) return;

  if (button.dataset.action === "correct") {
    correctionDialog.form.elements.paymentId.value = payment.id;
    correctionDialog.form.querySelector(".context").textContent = `${payment.receivedOn} · ${payment.reference || "Bez opisu"} · netto ${formatCents(payment.netCents)}`;
    correctionDialog.dialog.showModal();
  } else if (button.dataset.action === "assign") {
    assignmentDialog.form.elements.paymentId.value = payment.id;
    const context = assignmentDialog.form.querySelector(".context");
    context.textContent = `${payment.receivedOn} · ${payment.reference || "Bez opisu"} · ${formatCents(payment.netCents)}`;
    context.dataset.schoolYearId = payment.schoolYearId;
    assignmentPicker.loadClasses();
    assignmentDialog.dialog.showModal();
  }
});

// #225: Wpłaty prowadzą role finansowe. Inne konta (np. przedstawiciel klasy) nie widzą
// formularzy, tylko jeden komunikat. Sesja przed MFA dostaje z /api/access puste grants.
const financeSections = [filtersForm.closest("section"), body.closest("section")];
async function applyAccess() {
  let grants = [];
  let mfaRequired = false;
  try {
    const access = await api("/api/access");
    grants = Array.isArray(access.grants) ? access.grants : [];
    mfaRequired = access.mfaRequired === true;
  } catch (error) {
    message.className = "message error";
    message.textContent = error.message;
    return;
  }
  if (hasFinancialAccess(grants)) return;
  byId("open-payment").hidden = true;
  for (const section of financeSections) section.hidden = true;
  const notice = byId("access-notice");
  if (mfaRequired) notice.textContent = describeApiError(403, "mfa_required");
  notice.hidden = false;
}
byId("open-payment").hidden = true;
applyAccess().then(() => {
  if (!financeSections[0].hidden) byId("open-payment").hidden = false;
});
