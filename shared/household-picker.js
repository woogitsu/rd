// Wybór gospodarstwa przez klasę → ucznia → gospodarstwo, zamiast wpisywania UUID
// (issue #128, p.2). Czyste funkcje budujące znaczniki i podsumowanie; pobieranie danych
// (GET /api/classes, GET /api/classes/{id}/students) i wiązanie z formularzem zostają w
// main.js, tak jak reszta logiki DOM w tym repozytorium.

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function classOptionsHtml(classes, selectedId) {
  if (!classes.length) return '<option value="">Brak klas w Twoim zakresie</option>';
  return (
    '<option value="">Wybierz klasę…</option>' +
    classes
      .map((cls) => `<option value="${escapeHtml(cls.id)}"${cls.id === selectedId ? " selected" : ""}>${escapeHtml(cls.name)}</option>`)
      .join("")
  );
}

function studentLabel(student) {
  return [student.lastName, student.firstName].filter(Boolean).join(" ") || "(bez nazwiska)";
}

export function studentOptionsHtml(students, selectedId) {
  if (!students.length) return '<option value="">Brak uczniów w tej klasie</option>';
  return (
    '<option value="">Wybierz ucznia…</option>' +
    students
      .map((s) => `<option value="${escapeHtml(s.id)}"${s.id === selectedId ? " selected" : ""}>${escapeHtml(studentLabel(s))}</option>`)
      .join("")
  );
}

// Gospodarstwa przypisane do wybranego ucznia (może być kilka — opieka dzielona).
export function householdsForStudent(students, studentId) {
  const student = students.find((s) => s.id === studentId);
  return student ? student.households || [] : [];
}

// Przy opiece dzielonej (kilka gospodarstw) wybór musi być jawny — bez domyślnego.
export function requiresExplicitHouseholdChoice(households) {
  return households.length > 1;
}

export function householdOptionsHtml(households, selectedId) {
  if (!households.length) return '<option value="">Brak przypisanego gospodarstwa</option>';
  const needsChoice = requiresExplicitHouseholdChoice(households);
  const placeholder = needsChoice ? '<option value="">Wybierz gospodarstwo…</option>' : "";
  return (
    placeholder +
    households
      .map((h, i) => {
        // Jedno gospodarstwo (typowy przypadek) może być zaznaczone od razu; przy kilku
        // (opieka dzielona) żadne nie jest domyślnie zaznaczone.
        const selected = needsChoice ? h.householdId === selectedId : i === 0;
        const label = h.isPrimary ? `${h.householdId} (główne)` : h.householdId;
        return `<option value="${escapeHtml(h.householdId)}"${selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
      })
      .join("")
  );
}

// Krótkie podsumowanie do potwierdzenia wyboru — bez e-maili ani adresów (AGENTS.md).
export function householdSummary(student, households) {
  if (!student) return "";
  const count = households.length;
  const scope = count > 1 ? `${count} gospodarstwa (opieka dzielona)` : "1 gospodarstwo";
  return `${studentLabel(student)} · ${scope}`;
}
