// Czyste funkcje ekranu „Anonimizacja” (#91; trasa POST /api/admin/anonymizations,
// src/pg/anonymization.js, docs/RETENTION.md). Bez DOM i sieci — testy:
// tests/admin-anonymization.test.js. Serwer powtarza całą walidację, wymaga roli
// administratora z MFA i skrótu planu z podglądu; tu tylko czytelne komunikaty.
// Podgląd i historia pokazują wyłącznie identyfikatory i liczniki z API — nigdy imiona,
// e-maile ani teksty. Wykonanie jest nieodwracalne: poprzednie wartości nie są nigdzie kopiowane.

import { isValidId } from "./core.js";

export const REASON_LABELS = Object.freeze({
  data_subject_request: "Żądanie usunięcia danych osoby (art. 17, D-07)",
  retention_policy: "Upłynął okres retencji z polityki (D-04)",
});

// Klucze liczników w odpowiedzi API (src/pg/anonymization.js: planCounts).
export const COUNT_LABELS = Object.freeze({
  guardians: "Opiekunowie (imię, nazwisko, e-mail)",
  students: "Uczniowie (imię, nazwisko)",
  guardian_contact_changes: "Historia zmian kontaktu opiekunów",
  guardian_households: "Powody w członkostwach opiekunów",
  guardian_update_requests: "Prośby o aktualizację danych",
  campaign_recipients: "E-maile w migawkach kampanii",
  student_guardian_changes: "Powody zmian powiązań uczeń–opiekun",
  student_households: "Powody w członkostwach uczniów",
  enrollments: "Powody zakończenia zapisów",
  enrollment_history: "Powody w historii zapisów",
  payment_entries: "Tytuły przelewów",
  payment_corrections: "Powody korekt wpłat",
  payment_refunds: "Powody zwrotów",
  payment_reassignments: "Powody przeniesień wpłat",
  payment_allocation_reversals: "Powody odwróceń przypisań",
});

export const HISTORY_ACTION = "household.anonymized";
const PLAN_DIGEST = /^[0-9a-f]{64}$/;

// Treść podglądu: dryRun zawsze jawnie true (serwer domyślnie też, ale nie polegamy na tym).
export function previewBody({ reasonCode, householdId, dataRequestId } = {}) {
  if (!Object.hasOwn(REASON_LABELS, reasonCode)) throw new Error("Wybierz powód przebiegu.");
  const household = String(householdId ?? "").trim();
  if (!household) throw new Error("Podaj identyfikator gospodarstwa.");
  if (!isValidId(household)) throw new Error("Niepoprawny identyfikator gospodarstwa. Skopiuj go z panelu Rodziny.");
  const request = String(dataRequestId ?? "").trim();
  if (reasonCode === "data_subject_request") {
    if (!request) throw new Error("Podaj identyfikator żądania usunięcia z rejestru „Żądania osób”.");
    if (!isValidId(request)) throw new Error("Niepoprawny identyfikator żądania. Skopiuj go z rejestru.");
    return { householdId: household, reasonCode, dataRequestId: request, dryRun: true };
  }
  return { householdId: household, reasonCode, dryRun: true };
}

export function totalCount(counts) {
  return Object.values(counts ?? {}).reduce((sum, value) => sum + (Number.isSafeInteger(value) && value > 0 ? value : 0), 0);
}

// Wykonanie możliwe tylko po podglądzie z niezerowym planem i poprawnym skrótem.
export function canExecute(preview) {
  return Boolean(preview) && preview.status === "dry_run" && PLAN_DIGEST.test(String(preview.planSha256 ?? ""))
    && Boolean(preview.householdId) && totalCount(preview.counts) > 0;
}

export function executeBlocker(preview) {
  if (!preview) return "Najpierw wykonaj podgląd.";
  if (preview.status !== "dry_run") return "Ten wynik nie jest podglądem — wykonaj podgląd od nowa.";
  if (totalCount(preview.counts) === 0) return "Plan jest pusty — nie ma nic do zmiany.";
  return "";
}

// Wykonanie zatwierdza dokładnie ten plan, który pokazał podgląd (skrót planu + id gospodarstwa).
// `dataRequestId` pochodzi z treści podglądu, bo odpowiedź serwera go nie zwraca.
export function executeBody(preview, previewRequest = {}) {
  if (!canExecute(preview)) throw new Error("Najpierw wykonaj podgląd, który ma co zmienić.");
  const { householdId, reasonCode, planSha256 } = preview;
  const dataRequestId = reasonCode === "data_subject_request" ? previewRequest.dataRequestId : undefined;
  return {
    householdId, reasonCode,
    ...(dataRequestId ? { dataRequestId } : {}),
    dryRun: false, confirm: householdId, expectedPlanSha256: planSha256,
  };
}

// Wiersze tabeli planu: tylko pozycje z licznikiem większym od zera; nieznany klucz pokazany surowo.
export function planRows(counts) {
  return Object.entries(counts ?? {})
    .filter(([, value]) => Number.isSafeInteger(value) && value > 0)
    .map(([key, value]) => ({ key, label: COUNT_LABELS[key] ?? key, count: value }));
}

export function retainedNote(retained) {
  const guardians = Number(retained?.guardians) || 0;
  const students = Number(retained?.students) || 0;
  if (guardians <= 0 && students <= 0) return "";
  return `Osoby wspólne z innymi gospodarstwami (opieka dzielona) zostają bez zmian do czasu anonimizacji wszystkich ich gospodarstw: opiekunów ${guardians}, uczniów ${students}.`;
}

export function previewSummary(preview) {
  if (!preview) return "";
  const total = totalCount(preview.counts);
  if (total === 0) return "Plan jest pusty: nic do zmiany (dane tego gospodarstwa są już zanonimizowane albo nie ma pól do zmiany).";
  return `Plan obejmuje ${total} pozycji w ${planRows(preview.counts).length} kategoriach. Podgląd niczego nie zmienia.`;
}

// Okno potwierdzenia z polem: trzeba przepisać identyfikator gospodarstwa (jak w serwerze: `confirm`).
// Nieodwracalny skutek opisany wprost; fokus startuje na polu, a „Anuluj” jest zawsze dostępne.
export function executeConfirmation(preview) {
  const total = totalCount(preview?.counts);
  return {
    title: "Zanonimizować dane gospodarstwa?",
    effects: [
      `Gospodarstwo: ${preview?.householdId ?? "—"}. Powód: ${REASON_LABELS[preview?.reasonCode] ?? preview?.reasonCode ?? "—"}.`,
      `Zmieni się ${total} pozycji: imiona i nazwiska, e-maile, tytuły przelewów i powody zapisane w historii zostaną usunięte albo zastąpione tekstem „[zanonimizowano]”.`,
      "Tej operacji nie można cofnąć z panelu: poprzednie wartości nie są nigdzie kopiowane. Odtworzyć je można wyłącznie z kopii zapasowej sprzed przebiegu, a po jej odtworzeniu przebieg trzeba zastosować ponownie.",
      "Kwoty, daty, statusy, rok, księga i sumy wpłat nie zmieniają się. Wiersze historii zostają, bez danych osobowych.",
      "Przebieg zostanie zapisany w dzienniku (kto, kiedy, gospodarstwo, liczniki, skrót planu) — bez danych osobowych.",
      "Potrzebny jest świeży kod MFA; panel poprosi o niego, jeśli minęło ponad 15 minut.",
    ],
    confirmLabel: "Anonimizuj",
    destructive: true,
    input: { label: "Przepisz identyfikator gospodarstwa, aby potwierdzić", expected: preview?.householdId ?? "" },
  };
}

export function resultMessage(result) {
  if (result?.status === "applied") return `Anonimizacja wykonana (przebieg ${String(result.runId ?? "").slice(0, 8)}): zmieniono ${totalCount(result.counts)} pozycji.`;
  if (result?.status === "replayed") return "Nic do zmiany: to gospodarstwo jest już zanonimizowane (powtórzenie nie dodało wpisu).";
  return "Podgląd gotowy. Dane nie zostały zmienione.";
}

// Historia z dziennika zdarzeń (domena „privacy”): serwer nie ma osobnej listy przebiegów,
// a metadane audytu zawierają tylko identyfikatory i liczniki.
export function historyRows(events) {
  return (Array.isArray(events) ? events : [])
    .filter((event) => event?.action === HISTORY_ACTION)
    .map((event) => {
      const meta = event.metadata ?? {};
      return {
        id: event.id, runId: event.entityId ?? null, occurredAt: event.occurredAt, actorId: event.actorId ?? null,
        householdId: meta.householdId ?? null, reasonCode: meta.reasonCode ?? null,
        total: meta.counts && typeof meta.counts === "object" ? totalCount(meta.counts) : null,
        planSha256: typeof meta.planSha256 === "string" ? meta.planSha256 : null,
      };
    });
}

export function historySummary(count, hasMore) {
  const more = hasMore ? " Lista jest niepełna — użyj „Pokaż więcej”." : "";
  return count ? `Przebiegów na wczytanych stronach dziennika: ${count}.${more}` : `Brak przebiegów na wczytanych stronach dziennika.${more}`;
}
