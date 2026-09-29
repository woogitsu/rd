// Metadane wydruku (#151): widoczne wyłącznie w @media print (shared/print.css),
// generowane w DOM tuż przed drukiem. Bez sieci, bez zależności od panelu —
// testowane w tests/print-meta.test.js.
import { formatSchoolYear } from "./school-year.js";

export const TIME_ZONE = "Europe/Brussels";

const DATE_FMT = new Intl.DateTimeFormat("pl-PL", {
  timeZone: TIME_ZONE,
  day: "2-digit",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatPrintedAt(date = new Date()) {
  return `${DATE_FMT.format(date)}`;
}

// Zwraca linie tekstu bloku metadanych, w kolejności do wyświetlenia.
// options:
//  - view: nazwa widoku (np. "Księga przychodów i wydatków")
//  - schoolYear: opis roku szkolnego (np. "2025/2026")
//  - filters: opis zastosowanych filtrów (albo null)
//  - printedBy: nazwa wyświetlana osoby drukującej (albo null — nieznana)
//  - incompleteCount: liczba pokazanych wpisów, gdy wydruk nie obejmuje całości (albo null)
//  - confidential: true → dopisuje znacznik poufności danych rodzin
//  - draft: true → dopisuje znacznik PROJEKT (dokument niezatwierdzony)
export function printMetaLines({
  view = null,
  schoolYear = null,
  filters = null,
  printedBy = null,
  incompleteCount = null,
  confidential = false,
  draft = false,
  now = new Date(),
} = {}) {
  const lines = [];
  if (draft) lines.push({ text: "PROJEKT — dokument niezatwierdzony", strong: true });
  if (view) lines.push({ text: view, strong: true });
  if (schoolYear) lines.push({ text: `Rok szkolny: ${formatSchoolYear(schoolYear)}` });
  if (filters) lines.push({ text: `Filtry: ${filters}` });
  lines.push({ text: `Wydrukowano: ${formatPrintedAt(now)}${printedBy ? ` przez ${printedBy}` : ""}` });
  if (incompleteCount != null) lines.push({ text: `Wydruk niepełny — pokazano ${incompleteCount} wpisów.` });
  if (confidential) lines.push({ text: "Dane poufne Rady Rodziców", strong: true, confidential: true });
  return lines;
}

export function mountPrintMeta(container, options) {
  if (!container) return;
  container.replaceChildren();
  for (const line of printMetaLines(options)) {
    const p = document.createElement("p");
    if (line.confidential) p.className = "confidential";
    else if (line.strong) p.className = "confidential"; // pogrubienie tym samym stylem, bez nowej klasy CSS
    p.textContent = line.text;
    container.append(p);
  }
}
