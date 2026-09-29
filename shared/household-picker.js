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

// Etykiety gospodarstw do list wpłat (#128): z listy klas i uczniów, którą serwer już
// zwrócił temu użytkownikowi (GET /api/classes, /api/classes/{id}/students). Rola bez
// dostępu do rodzin nie dostaje tych danych, więc dla niej etykieta się nie tworzy —
// nic nie jest dopisywane do odpowiedzi API. Bez e-maili i adresów.
export function buildHouseholdLabels(classStudents) {
  const map = new Map();
  for (const { className, students } of classStudents || []) {
    for (const student of students || []) {
      for (const household of student.households || []) {
        if (!household || !household.householdId) continue;
        const entry = map.get(household.householdId) || { students: new Map() };
        const classes = entry.students.get(studentLabel(student)) || [];
        if (className && !classes.includes(className)) classes.push(className);
        entry.students.set(studentLabel(student), classes);
        map.set(household.householdId, entry);
      }
    }
  }
  const labels = new Map();
  for (const [householdId, entry] of map) {
    const parts = [...entry.students].map(([name, classes]) => (classes.length ? `${name} (${classes.join(", ")})` : name));
    labels.set(householdId, parts.join(", "));
  }
  return labels;
}

// Rodzina bez etykiety (brak dostępu albo poza wczytanymi klasami): skrócony numer, nie pełny UUID.
export function householdLabel(labels, householdId) {
  if (!householdId) return "Nie przypisano rodziny";
  const known = labels && typeof labels.get === "function" ? labels.get(householdId) : null;
  return known ? `Rodzina: ${known}` : `Rodzina nr ${String(householdId).slice(0, 8)}`;
}

// „Pokazano N wpłat” — łączna liczba nie jest znana przy paginacji kursorem.
export function shownSummary(count, hasMore, noun = ["wpłatę", "wpłaty", "wpłat"]) {
  if (count === 0) return "";
  const last2 = count % 100;
  const last = count % 10;
  const word = count === 1 ? noun[0] : last >= 2 && last <= 4 && !(last2 >= 12 && last2 <= 14) ? noun[1] : noun[2];
  return `Pokazano ${count} ${word}${hasMore ? ", są kolejne (użyj „Wczytaj następne”)" : " — to wszystkie dla wybranych filtrów"}.`;
}
