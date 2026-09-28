// Wybór roku szkolnego z listy zamiast wpisywania identyfikatora (issue #128).
// Źródłem jest GET /api/access (grants), które każdy panel już wywołuje przy starcie
// (401/403 obsługuje shared/api.js). Identyfikator roku jest już czytelny dla człowieka
// (np. "2026-2027" — patrz istniejące placeholdery), więc pełny słownik nazw z
// GET /api/classes nie jest tu potrzebny.

// Zwraca unikalne, posortowane malejąco (najnowszy pierwszy) lata z przydziałów.
export function yearsFromGrants(grants) {
  const ids = new Set((Array.isArray(grants) ? grants : []).map((g) => g && g.schoolYearId).filter(Boolean));
  return [...ids].sort((a, b) => b.localeCompare(a));
}

// Buduje znaczniki <option> — czysta funkcja tekstowa, testowalna bez DOM.
export function yearOptionsHtml(years, selected) {
  if (!years.length) return '<option value="">Brak lat w Twoim zakresie</option>';
  return years
    .map((year) => `<option value="${escapeHtml(year)}"${year === selected ? " selected" : ""}>${escapeHtml(year)}</option>`)
    .join("");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Wybiera domyślny rok: ostatnio wybrany (jeśli nadal w zakresie), inaczej najnowszy.
export function defaultYear(years, previous) {
  if (previous && years.includes(previous)) return previous;
  return years[0] || "";
}
