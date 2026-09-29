import {
  MAX_FILE_BYTES,
  PAYMENT_ENTRY_LABELS,
  buildHouseholds,
  classNames,
  filterHouseholds,
  normalizeConfig,
  parseInputBytes,
  parseInputRows,
  renderCardsHtml,
  schoolYearCardLabel,
} from "./core.js";
import { describeSource } from "../import/csv.js";
import { api as apiRequest } from "../shared/api.js";
import { fillYearSelect } from "../shared/school-year.js";
import { mountShell } from "../shared/shell.js";
import "../shared/shell.css";

mountShell();

// Stan wyłącznie w pamięci karty przeglądarki: nic nie jest zapisywane ani wysyłane.
// Jedyne żądanie sieciowe to odczyt GET /api/print/cards po kliknięciu „Wczytaj z serwera”.
// paymentInstructions: zatwierdzona na rok konfiguracja danych do wpłaty z
// GET /api/print/cards (#92), albo null (rok bez zatwierdzonej wersji — kartki
// zostają szkicem, bez kodu QR). Wypełniana wyłącznie odczytem z serwera.
const state = {
  households: [],
  selected: new Set(),
  paymentInstructions: null,
  configTouched: false,
};
const byId = (id) => document.getElementById(id);
const configForm = byId("config-form");
const configError = byId("config-error");
const fileInput = byId("file-input");
const fileEncoding = byId("file-encoding");
const fileMessage = byId("file-message");
const fileErrors = byId("file-errors");
const selectSection = byId("select-section");
const classFilter = byId("class-filter");
const hideRecorded = byId("hide-recorded");
const body = byId("households-body");
const count = byId("selection-count");
const previewSection = byId("preview-section");
const preview = byId("preview");
const previewMessage = byId("preview-message");
const confirmBox = byId("confirm-selection");
const confirmLabel = byId("confirm-label");
const printButton = byId("print-button");

// Wczytanie z chronionego API (/api/print/cards, src/pg/routes/print.js).
// Serwer sprawdza sesję, rolę i przypisanie klas; kwoty netto zwraca wyłącznie
// roli finansowej z MFA. Dane trafiają tylko do pamięci tej karty.
const API_ERRORS = {
  unauthenticated: "Brak aktywnej sesji. Zaloguj się w panelu i spróbuj ponownie.",
  forbidden: "Brak uprawnień do tej klasy lub roku szkolnego.",
  class_required: "Podaj identyfikator swojej klasy.",
  class_not_found: "Nie znaleziono klasy w tym roku szkolnym.",
  school_year_not_found: "Nie znaleziono roku szkolnego.",
  invalid_request: "Niepoprawny identyfikator roku szkolnego lub klasy.",
  too_many_rows: "Za dużo wierszy — wybierz klasę.",
};

// Rok i klasa to listy wyboru (jak w Wpłatach): lata z przydziałów konta (/api/access),
// klasy z /api/classes dla wybranego roku. Serwer i tak sprawdza zakres każdego żądania.
function createApiControls() {
  const anchor = fileMessage;
  const wrapper = document.createElement("div");
  wrapper.className = "toolbar";
  const field = (labelText, name) => {
    const label = document.createElement("label");
    label.textContent = labelText;
    const select = document.createElement("select");
    select.name = name;
    label.append(select);
    return { label, select };
  };
  const year = field("Rok szkolny", "apiSchoolYearId");
  const klass = field("Klasa", "apiClassId");
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Wczytaj z serwera";
  wrapper.append(year.label, klass.label, button);
  anchor.before(wrapper);
  return { yearInput: year.select, classInput: klass.select, button };
}

// Pole „Rok szkolny” treści kartki wypełniane z wybranego roku (2026-2027 → 2026/2027),
// dopóki użytkownik nie zmienił formularza treści ręcznie.
function syncCardYear() {
  if (state.configTouched) return;
  const label = schoolYearCardLabel(api.yearInput.value);
  if (label) configForm.elements.schoolYear.value = label;
}

async function loadClassOptions() {
  const schoolYearId = api.yearInput.value;
  const select = api.classInput;
  select.replaceChildren(new Option("Wszystkie klasy (zarząd)", ""));
  if (!schoolYearId) return;
  try {
    const params = new URLSearchParams({ schoolYearId });
    const data = await apiRequest(`/api/classes?${params}`, { cache: "no-store", messages: API_ERRORS });
    if (api.yearInput.value !== schoolYearId) return;
    for (const item of Array.isArray(data?.classes) ? data.classes : []) {
      select.append(new Option(item.name, item.id));
    }
  } catch {
    // Brak listy klas nie blokuje wczytania całego roku (zarząd); serwer oceni zakres.
  }
}

async function initApiControls() {
  let grants = [];
  try {
    const access = await apiRequest("/api/access", { cache: "no-store", messages: API_ERRORS });
    grants = Array.isArray(access?.grants) ? access.grants : [];
  } catch {
    // Bez przydziałów lista zawiera rok z daty; serwer i tak autoryzuje żądanie.
  }
  fillYearSelect(api.yearInput, grants);
  syncCardYear();
  await loadClassOptions();
}

async function loadFromApi(schoolYearId, classId) {
  const params = new URLSearchParams({ schoolYearId });
  if (classId) params.set("classId", classId);
  // Wspólny klient (#99): polskie komunikaty, 401/403 MFA → /login/ z powrotem.
  const data = await apiRequest(`/api/print/cards?${params}`, { cache: "no-store", messages: API_ERRORS });
  if (!data || !Array.isArray(data.rows)) throw new Error("Niepoprawna odpowiedź serwera.");
  return data;
}

function readConfig() {
  const data = new FormData(configForm);
  return {
    councilName: data.get("councilName"),
    schoolName: data.get("schoolName"),
    schoolYear: data.get("schoolYear"),
    suggestedAmount: data.get("suggestedAmount"),
    bankAccount: data.get("bankAccount"),
    bankRecipient: data.get("bankRecipient"),
    referenceTemplate: data.get("referenceTemplate"),
    contact: data.get("contact"),
    layout: data.get("layout"),
    templateApproved: data.get("templateApproved") === "on",
  };
}

// Regiony aria-live ogłaszają każdą zmianę tekstu; nie podmieniamy identycznej treści,
// żeby czytnik ekranu nie powtarzał komunikatu przy każdym naciśnięciu klawisza.
function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

// Oznacza pola, których dotyczą błędy z normalizeConfig (aria-invalid, WCAG 3.3.1).
const ERROR_FIELDS = [
  ["councilName", "Podaj nazwę Rady"],
  ["schoolYear", "Podaj rok szkolny"],
  ["contact", "Podaj kontakt"],
  ["suggestedAmount", "Sugerowana kwota"],
  ["bankAccount", "Numer rachunku"],
];
function markInvalid(errors) {
  for (const [name, prefix] of ERROR_FIELDS) {
    const field = configForm.elements[name];
    if (errors.some((error) => error.startsWith(prefix))) field.setAttribute("aria-invalid", "true");
    else field.removeAttribute("aria-invalid");
  }
}

function resetConfirmation() {
  confirmBox.checked = false;
  printButton.disabled = true;
}

function visibleHouseholds() {
  return filterHouseholds(state.households, { className: classFilter.value, hideRecorded: hideRecorded.checked });
}

function studentsText(household) {
  return household.students.map((student) => `${student.name} (${student.className})`).join(", ");
}

function renderTable() {
  const rows = visibleHouseholds().map((household) => {
    const row = document.createElement("tr");
    const checkCell = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = `hh-${household.householdId}`;
    checkbox.dataset.householdId = household.householdId;
    checkbox.checked = state.selected.has(household.householdId);
    checkbox.setAttribute("aria-label", `Wybierz rodzinę ${household.householdId}: ${studentsText(household)}`);
    checkCell.append(checkbox);
    const id = document.createElement("td");
    id.textContent = household.householdId;
    const students = document.createElement("td");
    students.textContent = studentsText(household);
    const entry = document.createElement("td");
    entry.textContent = PAYMENT_ENTRY_LABELS[household.paymentEntry];
    row.append(checkCell, id, students, entry);
    return row;
  });
  body.replaceChildren(...rows);
  updateSummary();
}

function updateSummary() {
  const selected = state.selected.size;
  const hidden = [...state.selected].filter((id) => !visibleHouseholds().some((h) => h.householdId === id)).length;
  setText(count, `Wybrano ${selected} z ${state.households.length} rodzin.` + (hidden ? ` ${hidden} wybranych jest ukrytych przez filtr.` : ""));
  setText(confirmLabel, `Sprawdziłem/am wybór ${selected} rodzin i podgląd kartek.`);
  resetConfirmation();
  renderPreview();
}

// Błędy walidacji konfiguracji kartki są ogłaszane (i pola oznaczane aria-invalid)
// dopiero po tym, jak użytkownik dotknął formularza konfiguracji albo spróbował
// wydrukować — inaczej pierwszy widok strony to czerwony komunikat błędu, zanim
// ktokolwiek cokolwiek wpisał (przegląd UI przed pokazem dla zarządu).
function renderPreview() {
  previewSection.hidden = state.households.length === 0;
  const { errors } = normalizeConfig(readConfig());
  if (state.configTouched) {
    setText(configError, errors.join(" "));
    markInvalid(errors);
  } else {
    setText(configError, "");
    markInvalid([]);
  }
  if (errors.length) {
    preview.replaceChildren();
    setText(previewMessage, "Uzupełnij treść kartki, aby zobaczyć podgląd.");
    confirmBox.disabled = true;
    return;
  }
  if (!state.selected.size) {
    preview.replaceChildren();
    setText(previewMessage, "Nie wybrano żadnej rodziny.");
    confirmBox.disabled = true;
    return;
  }
  try {
    const result = renderCardsHtml(state.households, state.selected, readConfig(), state.paymentInstructions);
    // HTML powstaje w core.js z escapowaniem każdej wartości (test XSS).
    preview.innerHTML = result.html;
    preview.dataset.layout = result.layout;
    document.body.dataset.layout = result.layout;
    setText(previewMessage, `Podgląd: ${result.count} kartek.`);
    confirmBox.disabled = false;
  } catch (error) {
    preview.replaceChildren();
    setText(previewMessage, error.message);
    confirmBox.disabled = true;
  }
}

// Pola rachunku/odbiorcy formularza tylko POKAZUJĄ zatwierdzoną konfigurację
// (#92) — nie da się jej zmienić tutaj, zmiana wymaga nowego zatwierdzenia
// (POST /api/payment-instructions, poza tym panelem).
function applyPaymentInstructions(paymentInstructions) {
  state.paymentInstructions = paymentInstructions;
  const account = configForm.elements.bankAccount;
  const recipient = configForm.elements.bankRecipient;
  if (paymentInstructions) {
    account.value = paymentInstructions.iban;
    recipient.value = paymentInstructions.payeeName;
    account.readOnly = true;
    recipient.readOnly = true;
  } else {
    account.readOnly = false;
    recipient.readOnly = false;
  }
}

function resetData() {
  state.households = [];
  state.selected.clear();
  applyPaymentInstructions(null);
  fileErrors.hidden = true;
  fileErrors.replaceChildren();
  selectSection.hidden = true;
  fileInput.removeAttribute("aria-invalid");
}

// Wspólny przepływ dla pliku i API: parsowanie → grupowanie → wybór bez zaznaczeń.
// invalidField: pole oznaczane aria-invalid przy błędzie (plik) albo null (API).
function loadParsed(parse, sourceLabel, invalidField = null) {
  try {
    const parsed = parse();
    const grouped = buildHouseholds(parsed.rows);
    const errors = [...parsed.errors, ...grouped.errors];
    if (errors.length) {
      fileMessage.textContent = `${sourceLabel} zawiera ${errors.length} błędów. Popraw dane i wczytaj je ponownie.`;
      invalidField?.setAttribute("aria-invalid", "true");
      fileErrors.replaceChildren(...errors.slice(0, 50).map(({ row, message }) => {
        const item = document.createElement("li");
        item.textContent = `Wiersz ${row}: ${message}`;
        return item;
      }));
      fileErrors.hidden = false;
      renderTable();
      return;
    }
    state.households = grouped.households;
    classFilter.replaceChildren(new Option("Wszystkie", ""), ...classNames(state.households).map((name) => new Option(name, name)));
    fileMessage.textContent = `Wczytano ${state.households.length} rodzin. Żadna nie jest zaznaczona — wybierz rodziny ręcznie.`;
    selectSection.hidden = false;
  } catch (error) {
    fileMessage.textContent = error.message;
    invalidField?.setAttribute("aria-invalid", "true");
  }
  renderTable();
}

async function handleFile(file) {
  resetData();
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) {
    fileMessage.textContent = "Plik jest większy niż 2 MB.";
    fileInput.setAttribute("aria-invalid", "true");
    renderTable();
    return;
  }
  let bytes;
  try {
    // #77: bajty zamiast file.text(), które po cichu zamienia znaki Windows-1250 na „�”.
    bytes = await file.arrayBuffer();
  } catch {
    fileMessage.textContent = "Nie udało się odczytać pliku.";
    fileInput.setAttribute("aria-invalid", "true");
    renderTable();
    return;
  }
  let source = null;
  loadParsed(() => {
    const parsed = parseInputBytes(bytes, file.name, { encoding: fileEncoding.value });
    source = parsed.source;
    return parsed;
  }, "Plik", fileInput);
  if (source) {
    const described = describeSource(source, source.delimiter);
    fileMessage.textContent += ` Odczytano: ${described}.${source.warnings.length ? ` Uwaga: ${source.warnings.join(" ")}` : ""}`;
  }
}

const api = createApiControls();
let apiLoading = false;

async function handleApiLoad() {
  if (apiLoading) return;
  const schoolYearId = api.yearInput.value;
  const classId = api.classInput.value;
  if (!schoolYearId) {
    fileMessage.textContent = "Wybierz rok szkolny.";
    return;
  }
  apiLoading = true;
  api.button.disabled = true;
  resetData();
  fileInput.value = "";
  fileMessage.textContent = "Wczytywanie z serwera…";
  try {
    const data = await loadFromApi(schoolYearId, classId);
    applyPaymentInstructions(data.paymentInstructions ?? null);
    loadParsed(() => parseInputRows(data), "Odpowiedź serwera");
    if (state.households.length && !data.paymentInfoIncluded) {
      fileMessage.textContent += " Informacja o wpisach wpłat nie jest dostępna dla tej roli lub sesji.";
    }
    if (state.households.length) {
      fileMessage.textContent += data.paymentInstructions
        ? " Dane do wpłaty i kod QR pochodzą z zatwierdzonej konfiguracji roku."
        : " Rok nie ma jeszcze zatwierdzonej konfiguracji danych do wpłaty — kartki będą szkicem, bez kodu QR.";
    }
  } catch (error) {
    fileMessage.textContent = error.message;
    renderTable();
  } finally {
    apiLoading = false;
    api.button.disabled = false;
  }
}

api.button.addEventListener("click", handleApiLoad);
api.yearInput.addEventListener("change", () => {
  syncCardYear();
  renderPreview();
  loadClassOptions();
});
fileInput.addEventListener("change", () => handleFile(fileInput.files?.[0]));
fileEncoding.addEventListener("change", () => {
  if (fileInput.files?.[0]) handleFile(fileInput.files[0]);
});
configForm.addEventListener("input", () => {
  state.configTouched = true;
  updateSummary();
});
configForm.addEventListener("submit", (event) => event.preventDefault());
classFilter.addEventListener("change", renderTable);
hideRecorded.addEventListener("change", renderTable);

body.addEventListener("change", (event) => {
  const box = event.target.closest("input[data-household-id]");
  if (!box) return;
  if (box.checked) state.selected.add(box.dataset.householdId);
  else state.selected.delete(box.dataset.householdId);
  updateSummary();
});

byId("select-visible").addEventListener("click", () => {
  for (const household of visibleHouseholds()) state.selected.add(household.householdId);
  renderTable();
});

byId("select-none").addEventListener("click", () => {
  state.selected.clear();
  renderTable();
});

confirmBox.addEventListener("change", () => {
  printButton.disabled = !confirmBox.checked || !state.selected.size;
});

printButton.addEventListener("click", () => {
  state.configTouched = true;
  if (!confirmBox.checked || !state.selected.size) return;
  renderPreview();
  window.print();
});

initApiControls().then(renderPreview);
renderPreview();
