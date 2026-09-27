import {
  MAX_FILE_BYTES,
  PAYMENT_ENTRY_LABELS,
  buildHouseholds,
  classNames,
  filterHouseholds,
  normalizeConfig,
  parseInputText,
  renderCardsHtml,
} from "./core.js";

// Stan wyłącznie w pamięci karty przeglądarki: nic nie jest zapisywane ani wysyłane.
const state = { households: [], selected: new Set() };
const byId = (id) => document.getElementById(id);
const configForm = byId("config-form");
const configError = byId("config-error");
const fileInput = byId("file-input");
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

// TODO(#11): po wdrożeniu autoryzacji PostgreSQL wczytywać dane z chronionego API,
// np. fetch('/api/print/cards?schoolYearId=…', { credentials: 'same-origin' }).
// Endpoint nie istnieje; serwer musi sprawdzić sesję, MFA, rolę i przypisanie klas.
// async function loadFromApi(schoolYearId) { throw new Error("Nie zaimplementowano."); }

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
  count.textContent = `Wybrano ${selected} z ${state.households.length} rodzin.` + (hidden ? ` ${hidden} wybranych jest ukrytych przez filtr.` : "");
  confirmLabel.textContent = `Sprawdziłem/am wybór ${selected} rodzin i podgląd kartek.`;
  resetConfirmation();
  renderPreview();
}

function renderPreview() {
  previewSection.hidden = state.households.length === 0;
  const { errors } = normalizeConfig(readConfig());
  configError.textContent = errors.join(" ");
  if (errors.length) {
    preview.replaceChildren();
    previewMessage.textContent = "Uzupełnij treść kartki, aby zobaczyć podgląd.";
    confirmBox.disabled = true;
    return;
  }
  if (!state.selected.size) {
    preview.replaceChildren();
    previewMessage.textContent = "Nie wybrano żadnej rodziny.";
    confirmBox.disabled = true;
    return;
  }
  try {
    const result = renderCardsHtml(state.households, state.selected, readConfig());
    // HTML powstaje w core.js z escapowaniem każdej wartości (test XSS).
    preview.innerHTML = result.html;
    preview.dataset.layout = result.layout;
    document.body.dataset.layout = result.layout;
    previewMessage.textContent = `Podgląd: ${result.count} kartek.`;
    confirmBox.disabled = false;
  } catch (error) {
    preview.replaceChildren();
    previewMessage.textContent = error.message;
    confirmBox.disabled = true;
  }
}

async function handleFile(file) {
  state.households = [];
  state.selected.clear();
  fileErrors.hidden = true;
  fileErrors.replaceChildren();
  selectSection.hidden = true;
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) {
    fileMessage.textContent = "Plik jest większy niż 2 MB.";
    renderTable();
    return;
  }
  try {
    const parsed = parseInputText(await file.text(), file.name);
    const grouped = buildHouseholds(parsed.rows);
    const errors = [...parsed.errors, ...grouped.errors];
    if (errors.length) {
      fileMessage.textContent = `Plik zawiera ${errors.length} błędów. Popraw plik i wczytaj go ponownie.`;
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
  }
  renderTable();
}

fileInput.addEventListener("change", () => handleFile(fileInput.files?.[0]));
configForm.addEventListener("input", updateSummary);
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
  if (!confirmBox.checked || !state.selected.size) return;
  renderPreview();
  window.print();
});

renderPreview();
