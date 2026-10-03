// Czyste funkcje kroku „Przedłużenie przydziałów przedstawicieli” (#78; trasy
// `representatives/preview|apply` w src/pg/promotions.js). Bez DOM i bez sieci.
// Podgląd API zwraca tylko identyfikatory kont, bez imion i e-maili — ekran
// pokazuje wyłącznie liczby per klasa. Serwer powtarza całą walidację.

import { MAP_FINAL, MAP_SKIP } from "./promotion.js";

// Komunikaty kodów tego kroku; `plan_stale` ma tu inną treść niż przy uczniach.
export const REPRESENTATIVE_ERROR_MESSAGES = Object.freeze({
  nothing_to_extend: "Brak przedstawicieli do przedłużenia: żadna wskazana klasa roku źródłowego nie ma aktywnego przedstawiciela. Nic nie zapisano. Zmień mapę klas albo zaproś przedstawicieli partią zaproszeń.",
  plan_stale: "Przydziały przedstawicieli zmieniły się od podglądu. Nic nie zapisano; podgląd został odświeżony — sprawdź liczby i zatwierdź ponownie.",
});

// mapping: { [id klasy źródłowej]: id klasy docelowej | MAP_FINAL | MAP_SKIP } — ta sama mapa
// co przy promocji uczniów. Klasa końcowa i „nie przenoś” nie mają klasy docelowej, więc
// nie wchodzą do mapy (przedstawiciele takich klas nie są przedłużani).
export function representativesBody({ fromSchoolYearId, toSchoolYearId, mapping }) {
  if (!fromSchoolYearId || !toSchoolYearId) throw new Error("Wybierz rok źródłowy i docelowy.");
  if (fromSchoolYearId === toSchoolYearId) throw new Error("Rok źródłowy i docelowy muszą być różne.");
  const classMap = {};
  for (const [fromClassId, target] of Object.entries(mapping ?? {})) {
    if (target === MAP_SKIP || target === MAP_FINAL || target === undefined || target === null) continue;
    classMap[fromClassId] = target;
  }
  if (!Object.keys(classMap).length) throw new Error("Wskaż klasę docelową dla przynajmniej jednej klasy w mapie powyżej.");
  return { fromSchoolYearId, toSchoolYearId, classMap };
}

export function representativesApplyBody(body, plan) {
  return { ...body, planDigest: plan.planDigest, confirm: body.toSchoolYearId };
}

// Zatwierdzenie ma sens tylko, gdy podgląd proponuje coś nowego.
export function canApplyRepresentatives(plan) {
  return Boolean(plan?.planDigest) && (plan.counts?.propose ?? 0) > 0;
}

export function representativesSummary(plan) {
  const counts = plan?.counts;
  if (!counts) return "";
  const self = counts.cannot_grant_self ?? 0;
  const total = counts.propose + counts.already_granted + counts.user_disabled + self;
  if (!total) return "Wskazane klasy roku źródłowego nie mają aktywnych przedstawicieli. Nic nie zostanie zapisane.";
  const parts = [`Nowe przydziały do utworzenia: ${counts.propose}`, `już przydzieleni w roku docelowym: ${counts.already_granted}`];
  if (counts.user_disabled) parts.push(`konta wyłączone (pominięte): ${counts.user_disabled}`);
  if (self) parts.push(`Twoje konto (pominięte — przydział nadaje inny administrator): ${self}`);
  const hint = counts.propose ? "" : " Nic nie zostanie zapisane — przydziały już istnieją albo wiersze są pominięte.";
  return `${parts.join("; ")}.${hint}`;
}

// Wiersze tabeli: jedna na klasę docelową z mapy (także bez żadnej propozycji).
// classNames: Map id klasy → nazwa (klasy obu lat). Bez identyfikatorów kont.
export function representativesRows(plan, body, classNames = new Map()) {
  const name = (id) => classNames.get(id) ?? id;
  const byTarget = new Map();
  for (const [fromClassId, toClassId] of Object.entries(body?.classMap ?? {})) {
    const row = byTarget.get(toClassId) ?? { toClassId, from: new Set(), propose: 0, alreadyGranted: 0, disabled: 0 };
    row.from.add(fromClassId);
    byTarget.set(toClassId, row);
  }
  for (const item of plan?.proposals ?? []) {
    const row = byTarget.get(item.toClassId);
    if (!row) continue;
    if (item.status === "propose") row.propose += 1;
    else if (item.status === "already_granted") row.alreadyGranted += 1;
    else if (item.status === "user_disabled") row.disabled += 1;
  }
  const uncovered = new Set((plan?.withoutRepresentative ?? []).map((item) => item.classId));
  return [...byTarget.values()].map((row) => ({
    toName: name(row.toClassId),
    fromNames: [...row.from].map(name).join(", "),
    propose: row.propose, alreadyGranted: row.alreadyGranted, disabled: row.disabled,
    withoutRepresentative: uncovered.has(row.toClassId),
  }));
}

export function withoutRepresentativeNote(plan) {
  const missing = plan?.withoutRepresentative ?? [];
  if (!missing.length) return "Po zatwierdzeniu każda klasa docelowa z mapy będzie miała aktywnego przedstawiciela.";
  return `Klasy docelowe, które nadal nie będą miały przedstawiciela: ${missing.map((item) => item.name).join(", ")}. `
    + "Przedstawicieli tych klas zapraszasz osobno (partia zaproszeń).";
}

export function representativesConfirmation(plan, labels) {
  return {
    title: "Przedłużyć przydziały przedstawicieli?",
    effects: [
      `${labels.from} → ${labels.to}: liczba nowych przydziałów roli przedstawiciela w roku docelowym: ${plan.counts.propose}.`,
      "Przydziały roku źródłowego zostają bez zmian (nie są cofane ani skracane); przydziały już istniejące w roku docelowym nie są duplikowane.",
      plan.counts.user_disabled
        ? `Konta wyłączone (${plan.counts.user_disabled}) są pomijane — nie dostaną przydziału.`
        : "Konta wyłączone są pomijane.",
      ...(plan.counts.cannot_grant_self
        ? ["Twoje konto jest pomijane: rolę przedstawiciela nadaje Ci inny administrator (tabela przydziałów ról)."]
        : []),
      "Zmiana jest zapisana w dzienniku zdarzeń. Pomyłkę poprawia się cofnięciem przydziału w tabeli przydziałów ról.",
      "Operacja wymaga świeżego potwierdzenia kodem MFA.",
    ],
    confirmLabel: "Przedłuż przydziały",
  };
}

export function representativesResultMessage(result) {
  if (result.replayed) return "Przydziały były już zapisane — nie utworzono nowych.";
  const self = result.skippedSelf ?? 0;
  const disabled = (result.skipped ?? 0) - self;
  const skipped = (disabled ? `; pominięto konta wyłączone: ${disabled}` : "")
    + (self ? `; pominięto Twoje konto (przydział nadaje inny administrator): ${self}` : "");
  return `Przydziały przedstawicieli zapisane: nowe: ${result.created}, już istniały: ${result.alreadyGranted}${skipped}.`;
}

// Co zrobić z ekranem po błędzie zatwierdzenia:
// "refresh" (409 plan_stale: podgląd trzeba odświeżyć), "reset" (np. 422 nothing_to_extend),
// "retry" (błąd sieci: ten sam podgląd można ponowić — serwer jest idempotentny).
export function applyFailureAction(error) {
  if (error?.network) return "retry";
  if (error?.code === "plan_stale") return "refresh";
  return "reset";
}

export function representativesErrorMessage(error) {
  const known = error?.code ? REPRESENTATIVE_ERROR_MESSAGES[error.code] : undefined;
  return known ?? error?.message ?? "Nie udało się wykonać operacji.";
}
