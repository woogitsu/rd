// Czyste funkcje ekranu „Nowy rok — promocja uczniów” (#78; trasy src/pg/promotions.js).
// Bez DOM i bez sieci. Podgląd nie zawiera imion — tylko identyfikatory i liczby.
// Serwer powtarza całą walidację; tu tylko wcześniejsze, czytelne komunikaty.

import { isValidId } from "./core.js";
import { plural } from "./onboarding.js";

// Wartości wyboru klasy docelowej w tabeli mapy (poza identyfikatorem klasy).
export const MAP_SKIP = "";
export const MAP_FINAL = "__final";

export const STATUS_LABELS = Object.freeze({
  promote: "Do przeniesienia",
  graduating: "Klasa końcowa (bez przypisania)",
  unmapped: "Klasa poza mapą (nie przenoszeni)",
  excluded: "Wykluczeni",
  conflict: "Już przypisani w roku docelowym (konflikt)",
  withdrawn: "Odeszli ze szkoły (nie przenoszeni)",
});

const MAX_EXCLUSIONS = 2000;

// Identyfikatory uczniów: po jednym w wierszu albo oddzielone przecinkiem/średnikiem.
export function parseExclusions(text) {
  const ids = [...new Set(String(text ?? "").split(/[\s,;]+/).filter(Boolean))];
  if (ids.length > MAX_EXCLUSIONS) throw new Error("Zbyt wiele wykluczeń (najwyżej 2000).");
  const bad = ids.find((id) => !isValidId(id));
  if (bad) throw new Error(`Niepoprawny identyfikator ucznia „${String(bad).slice(0, 40)}”. Skopiuj go z panelu Rodziny.`);
  return ids;
}

// mapping: { [id klasy źródłowej]: id klasy docelowej | MAP_FINAL | MAP_SKIP }.
// Klasa bez wyboru (MAP_SKIP) nie wchodzi do mapy — jej uczniowie nie są przenoszeni.
export function promotionBody({ fromSchoolYearId, toSchoolYearId, mapping, exclusionsText }) {
  if (!fromSchoolYearId || !toSchoolYearId) throw new Error("Wybierz rok źródłowy i docelowy.");
  if (fromSchoolYearId === toSchoolYearId) throw new Error("Rok źródłowy i docelowy muszą być różne.");
  const classMap = {};
  for (const [fromClassId, target] of Object.entries(mapping ?? {})) {
    if (target === MAP_SKIP || target === undefined) continue;
    classMap[fromClassId] = target === MAP_FINAL ? null : target;
  }
  if (!Object.keys(classMap).length) throw new Error("Wskaż klasę docelową (albo „klasa końcowa”) dla przynajmniej jednej klasy.");
  const exclusions = parseExclusions(exclusionsText);
  return { fromSchoolYearId, toSchoolYearId, classMap, ...(exclusions.length ? { exclusions } : {}) };
}

// Klucz zatwierdzenia: jeden na podgląd; podwójne kliknięcie i ponowienie po
// zerwanym połączeniu wysyłają ten sam klucz (serwer: replayed: true).
export function newPromotionKey(random = () => globalThis.crypto.randomUUID()) {
  return `promo-${random()}`;
}

export const studentsCount = (count) => plural(count, "uczeń", "uczniowie", "uczniów");

export function canApplyPromotion(plan) {
  return Boolean(plan?.planDigest) && (plan.counts?.promote ?? 0) > 0;
}

export function promotionSummary(plan) {
  const counts = plan?.counts;
  if (!counts) return "";
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  if (!total) return "Rok źródłowy nie ma żadnych przypisań uczniów.";
  const parts = [`Do przeniesienia: ${counts.promote}`];
  for (const status of ["graduating", "unmapped", "excluded", "conflict", "withdrawn"]) {
    if (counts[status]) parts.push(`${STATUS_LABELS[status].toLowerCase()}: ${counts[status]}`);
  }
  const hint = counts.promote ? "" : " Nic nie zostanie zapisane — zmień mapę klas albo wykluczenia.";
  return `${parts.join("; ")}.${hint}`;
}

// Wiersze tabeli podglądu (liczności per klasa źródłowa).
export function promotionRows(plan) {
  return (plan?.classes ?? []).map((row) => ({
    fromName: row.fromName,
    toName: !row.mapped ? "— (poza mapą)" : row.toName ?? "Klasa końcowa",
    total: row.total, promote: row.promote, graduating: row.graduating, unmapped: row.unmapped,
    excluded: row.excluded, conflict: row.conflict, withdrawn: row.withdrawn,
  }));
}

// Uczniowie wymagający uwagi: konflikt i odejścia (identyfikatory, bez imion).
export function attentionStudents(plan, classNames = new Map()) {
  return (plan?.students ?? [])
    .filter((item) => item.status === "conflict" || item.status === "withdrawn")
    .map((item) => ({
      studentId: item.studentId,
      status: STATUS_LABELS[item.status],
      fromName: classNames.get(item.fromClassId) ?? item.fromClassId,
    }));
}

export function missingRepresentativeNote(plan) {
  const missing = plan?.missingRepresentative ?? [];
  if (!missing.length) return "Każda klasa docelowa z przenoszonymi uczniami ma aktywnego przedstawiciela.";
  return `Klasy docelowe bez aktywnego przedstawiciela: ${missing.map((item) => item.name).join(", ")}. `
    + "Promocja uczniów nie przedłuża przydziałów — użyj kroku „Przedłużenie przydziałów przedstawicieli” poniżej albo partii zaproszeń.";
}

export function promotionConfirmation(plan, labels) {
  return {
    title: "Zastosować promocję?",
    effects: [
      `${labels.from} → ${labels.to}: liczba nowych przypisań do klas w roku docelowym: ${plan.counts.promote}.`,
      "Historia roku źródłowego i dane gospodarstw nie zmieniają się; konfliktów nie nadpisujemy.",
      "Zmiana jest zapisana w dzienniku zdarzeń. Pomyłkę poprawia ręczna zmiana klasy ucznia w panelu Rodziny.",
    ],
    confirmLabel: "Zastosuj promocję",
  };
}

export function promotionResultMessage(result) {
  if (result.replayed) return "Ta promocja była już zapisana — nie utworzono nowych przypisań.";
  return `Promocja zapisana: przeniesionych uczniów: ${result.counts.promote}.`;
}
