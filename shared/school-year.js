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

// Rok szkolny na podstawie daty (Europe/Brussels, rok zaczyna się 1 września) —
// ta sama heurystyka co site/core.js#defaultSchoolYearId, stąd wspólna funkcja
// zamiast dwóch kopii (patrz panele: pusty ekran bez domyślnego roku). Używana
// jako wartość awaryjna, gdy przydziały (grants) nie dają żadnego roku, np. rola
// bez przypisanego roku szkolnego (admin/board o zasięgu globalnym).
const HEURISTIC_TIME_ZONE = "Europe/Brussels";
const HEURISTIC_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: HEURISTIC_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
});

export function heuristicSchoolYearId(now = new Date()) {
  const [year, month] = HEURISTIC_PARTS.format(now).split("-").map(Number);
  const start = month >= 9 ? year : year - 1;
  return `${start}-${start + 1}`;
}

// Rok do wstępnego wypełnienia panelu przy wejściu (bez klikania „Pokaż”):
// ostatnio wybrany/z adresu (previous), inaczej najnowszy z przydziałów (grants),
// inaczej heurystyka daty. Użytkownik nadal może zmienić rok ręcznie.
export function initialSchoolYearId(grants, { previous = "", now = new Date() } = {}) {
  return defaultYear(yearsFromGrants(grants), previous) || heuristicSchoolYearId(now);
}
