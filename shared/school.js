// Jedno źródło nazwy szkoły i Rady dla wszystkich widoków (nagłówki paneli, /site/,
// /import/, kartki, seed demo). Nazwy nie wpisujemy w HTML ani w innych plikach:
// strony mają znacznik data-school-name, który wypełnia applySchoolName().
//
// ASSUMPTION (do decyzji Rady, docs/DEMO.md): wartość domyślna jest neutralna i
// odpowiada najczęstszemu zapisowi w panelach — bez imienia patrona. Ostateczną
// nazwę (z imieniem patrona lub bez) ustala Rada; zmiana wymaga edycji tylko tego
// pliku. Odmiana jest zapisana jawnie (dopełniacz), bo nie generujemy jej automatycznie.
export const SCHOOL_NAME = "Szkoła Polska w Brukseli";
export const SCHOOL_NAME_GENITIVE = "Szkoły Polskiej w Brukseli";
export const COUNCIL_SHORT_NAME = "Rada Rodziców";
export const COUNCIL_FULL_NAME = `${COUNCIL_SHORT_NAME} ${SCHOOL_NAME_GENITIVE}`;

// Wartości dla atrybutu data-school-name (patrz applySchoolName).
export const SCHOOL_NAME_VARIANTS = Object.freeze({
  school: SCHOOL_NAME,
  council: COUNCIL_FULL_NAME,
});

// Wypełnia elementy [data-school-name="school|council"] (domyślnie "school").
// Tylko textContent — bez HTML. Bezpieczne, gdy dokument nie ma DOM (testy).
export function applySchoolName(doc = typeof document === "undefined" ? null : document) {
  if (!doc || typeof doc.querySelectorAll !== "function") return;
  for (const el of doc.querySelectorAll("[data-school-name]")) {
    const variant = el.getAttribute("data-school-name") || "school";
    el.textContent = SCHOOL_NAME_VARIANTS[variant] ?? SCHOOL_NAME;
  }
}
