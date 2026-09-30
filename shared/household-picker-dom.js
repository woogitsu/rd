// Wiązanie wyboru rodziny (klasa → uczeń → gospodarstwo, issue #128) z formularzem.
// Wspólne dla panelu wpłat (panel/) i okna „Utwórz wpłatę” w uzgodnieniach
// (reconciliation/, przegląd demo 5). Znaczniki i etykiety budują czyste funkcje
// z shared/household-picker.js (testy: tests/household-picker-core.test.js);
// tu zostaje tylko DOM i pobieranie danych. O zakresie klas i uczniów decyduje
// serwer (GET /api/classes, GET /api/classes/{id}/students) — rola bez dostępu
// dostaje pustą listę i może zostawić wpłatę bez rodziny.

import {
  classOptionsHtml,
  householdOptionsHtml,
  householdsForStudent,
  householdSummary,
  requiresExplicitHouseholdChoice,
  studentOptionsHtml,
} from "./household-picker.js";

// Oczekuje w HTML elementów o identyfikatorach `${prefix}-class`, `${prefix}-student`,
// `${prefix}-household`, `${prefix}-household-summary` oraz pola `${prefix}-household-id`
// (tekstowe w trybie zaawansowanym albo ukryte), które niesie wybrane gospodarstwo.
// onSelect(householdId) — opcjonalnie, po każdej zmianie wyboru.
export function wireHouseholdPicker({ byId, api, prefix, getSchoolYearId, isValidId, onSelect = () => {} }) {
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
    // Przy opiece dzielonej (kilka gospodarstw) wybór musi być jawny — bez domyślnego.
    idInput.value = requiresExplicitHouseholdChoice(households) ? "" : (households[0]?.householdId ?? "");
    onSelect(idInput.value);
  });

  householdSelect.addEventListener("change", () => {
    idInput.value = householdSelect.value;
    onSelect(idInput.value);
  });

  return { loadClasses, reset };
}
