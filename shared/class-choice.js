// Wybór klasy z listy zamiast wpisywania identyfikatora (issue #128). Źródłem jest
// GET /api/classes?schoolYearId=… — serwer zwraca wyłącznie klasy w zakresie roli
// (przedstawiciel: tylko przypisane klasy), więc lista nie ujawnia niczego więcej.

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Opcje <select>: pusta opcja (gdy pole jest opcjonalne) + klasy roku według nazwy.
export function classChoiceOptionsHtml(classes, { selected = "", emptyLabel = "Wybierz klasę…", optional = false } = {}) {
  const list = (Array.isArray(classes) ? classes : []).filter((c) => c && c.id);
  const empty = optional ? `<option value="">${escapeHtml(emptyLabel)}</option>` : "";
  if (!list.length) return optional ? empty : '<option value="">Brak klas w Twoim zakresie</option>';
  const head = optional ? empty : '<option value="">Wybierz klasę…</option>';
  return (
    head +
    list
      .map((c) => `<option value="${escapeHtml(c.id)}"${c.id === selected ? " selected" : ""}>${escapeHtml(c.name || c.id)}</option>`)
      .join("")
  );
}

// Klasy wskazanego roku (odpowiedź /api/classes może obejmować kilka lat).
export function classesOfYear(classes, schoolYearId) {
  return (Array.isArray(classes) ? classes : []).filter((c) => c && c.schoolYearId === schoolYearId);
}

export function classesUrl(schoolYearId) {
  return `/api/classes?schoolYearId=${encodeURIComponent(schoolYearId)}`;
}

// Wypełnia <select> klasami roku. Błąd (np. 403 dla roli bez dostępu do klas) daje pustą
// listę — serwer i tak autoryzuje każde żądanie, lista nie jest kontrolą dostępu.
export async function fillClassSelect(select, api, schoolYearId, options = {}) {
  let classes = [];
  if (schoolYearId) {
    try {
      const result = await api(classesUrl(schoolYearId));
      classes = classesOfYear(result && result.classes, schoolYearId);
    } catch {
      classes = [];
    }
  }
  select.innerHTML = classChoiceOptionsHtml(classes, options);
  if (options.selected && classes.some((c) => c.id === options.selected)) select.value = options.selected;
  return classes;
}
