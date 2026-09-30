// Metadane wydruku (#151): widoczne wyłącznie w @media print (shared/print.css),
// generowane w DOM tuż przed drukiem. Bez sieci, bez zależności od panelu —
// testowane w tests/print-meta.test.js.
import { formatSchoolYear } from "./school-year.js";
import { formatDateOrTimestamp } from "./zoned-time.js";

export const TIME_ZONE = "Europe/Brussels";

// Polski zapis dat w wydrukach (decyzja 30.09, #563): „20.10.2026 16:05” w strefie
// Europe/Brussels — ta sama funkcja co raport Komisji Rewizyjnej i panel audytu.
export function formatPrintedAt(date = new Date()) {
  return formatDateOrTimestamp(date, TIME_ZONE) ?? "";
}

// Data z filtra albo wiersza tabeli („2026-10-20” → „20.10.2026”); pusta → "".
export function formatPrintDate(value) {
  return formatDateOrTimestamp(value, TIME_ZONE) ?? "";
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

// Tekst powtarzany na KAŻDEJ stronie wydruku (pola marginesu @page, Chromium ≥ 131;
// inne przeglądarki pomijają je i zostaje blok metadanych na pierwszej stronie).
// Bez danych osobowych: nazwa widoku, rok, opcjonalnie podsumowanie (np. bilans).
export function runningHeadText({ view = null, schoolYear = null, summary = null, draft = false } = {}) {
  return [draft ? "PROJEKT" : null, view, schoolYear ? `Rok szkolny ${formatSchoolYear(schoolYear)}` : null, summary]
    .filter(Boolean).join(" · ");
}

// Literał CSS "…" dla właściwości content — bez możliwości wyjścia z reguły.
export function cssString(text) {
  return `"${String(text ?? "").replace(/[\\"]/g, "\\$&").replace(/[\r\n\f]+/g, " ").replace(/</g, "\\3c ")}"`;
}

export function runningPageCss(options = {}) {
  const head = runningHeadText(options);
  const foot = options.confidential ? "Dane poufne Rady Rodziców" : "";
  return `@page { @top-left { content: ${cssString(head)}; } @bottom-left { content: ${cssString(foot)}; } }`;
}

// Arkusz konstruowany (adoptedStyleSheets) zamiast <style>: CSP „style-src 'self'”
// blokuje style inline, a CSSOM nie jest nim objęty. Brak API → tylko blok metadanych.
const runningSheets = new WeakMap();
function mountRunningPage(doc, options) {
  const win = doc?.defaultView;
  if (!win?.CSSStyleSheet || !Array.isArray(doc.adoptedStyleSheets)) return;
  let sheet = runningSheets.get(doc);
  try {
    if (!sheet) {
      sheet = new win.CSSStyleSheet();
      runningSheets.set(doc, sheet);
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
    }
    sheet.replaceSync(runningPageCss(options));
  } catch {
    // Nagłówek strony jest pomocniczy — wydruk działa bez niego.
  }
}

export function mountPrintMeta(container, options) {
  if (!container) return;
  mountRunningPage(container.ownerDocument, options ?? {});
  container.replaceChildren();
  for (const line of printMetaLines(options)) {
    const p = document.createElement("p");
    if (line.confidential) p.className = "confidential";
    else if (line.strong) p.className = "confidential"; // pogrubienie tym samym stylem, bez nowej klasy CSS
    p.textContent = line.text;
    container.append(p);
  }
}
