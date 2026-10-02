import test from "node:test";
import assert from "node:assert/strict";
import {
  AUDIT_REMOVED_ELEMENT_IDS,
  PAYMENT_LINKED_DESCRIPTION,
  buildLedgerExportUrl,
  entryTexts,
  isLedgerAuditView,
  buildLedgerUrl,
  buildOverviewUrl,
  buildNextLedgerUrl,
  ledgerFilterChanged,
  ledgerQuery,
  formatCents,
  makeIdempotencyKey,
  needsResolution,
  attachmentStatusLabel,
  attachmentStatusSummary,
  normalizeEntry,
  parseEuroAmount,
} from "../ledger/core.js";
import { readFileSync } from "node:fs";
import { assertEvery } from "./helpers/assertions.js";

test("kwoty EUR są parsowane bez błędów zmiennoprzecinkowych", () => {
  assert.equal(parseEuroAmount("3000,01"), 300001);
  assert.throws(() => parseEuroAmount("10,999"), /maksymalnie dwoma/);
});

test("uchwała jest wymagana tylko dla wydatku ponad 3000 EUR", () => {
  assert.equal(needsResolution("expense", 300000), false);
  assert.equal(needsResolution("expense", 300001), true);
  assert.equal(needsResolution("income", 900000), false);
});

test("adresy API kodują filtry i odrzucają błędne identyfikatory", () => {
  assert.equal(buildLedgerUrl({ schoolYearId: "2026-2027", direction: "expense" }), "/api/ledger?schoolYearId=2026-2027&limit=50&direction=expense");
  assert.equal(buildOverviewUrl("categories", "rok:2026", "income"), "/api/ledger/categories?schoolYearId=rok%3A2026&direction=income");
  assert.throws(() => buildOverviewUrl("summary", "zły id"), /Niepoprawne/);
});

test("normalizacja wylicza netto, gdy API nie zwróci go wprost", () => {
  const entry = normalizeEntry({ id: "e1", direction: "expense", amountCents: 1200, correctedCents: 200, method: "bank" });
  assert.equal(entry.netCents, 1000);
  assert.match(formatCents(entry.netCents), /10,00/);
});

test("klucz idempotencji jest stabilnie prefiksowany", () => {
  assert.equal(makeIdempotencyKey("ledger", () => "uuid"), "ledger-uuid");
});

// #192: rok A wczytany, pole zmienione na rok B bez „Pokaż” — dociągnięcie dotyczy roku A.
test("dociągnięcie księgi używa zapamiętanego zapytania", async () => {
  const { ledgerQuery, buildNextLedgerUrl, ledgerFilterChanged } = await import("../ledger/core.js");
  const query = ledgerQuery({ schoolYearId: "y2026", direction: "" });
  const current = { schoolYearId: "y2027", direction: "" };
  assert.equal(ledgerFilterChanged(query, current), true);
  assert.equal(buildNextLedgerUrl(query, "abc"), "/api/ledger?schoolYearId=y2026&limit=50&cursor=abc");
  assert.equal(buildNextLedgerUrl(query, null), null);
  assert.equal(buildNextLedgerUrl(null, "abc"), null);
  assert.equal(ledgerFilterChanged(query, { schoolYearId: "y2026", direction: "expense" }), true);
  assert.equal(ledgerFilterChanged(query, { schoolYearId: " y2026", direction: "" }), false);
  assert.throws(() => ledgerQuery({ schoolYearId: "y2026", direction: "transfer" }));
});

test("#107: wiersz plan vs wykonanie — brak planu to „poza planem”, przekroczenie opisane tekstem", async () => {
  const { budgetExecutionRow, buildOverviewUrl } = await import("../ledger/core.js");
  assert.equal(buildOverviewUrl("budget/execution", "y2026"), "/api/ledger/budget/execution?schoolYearId=y2026");
  const over = budgetExecutionRow({ categoryName: "Wydarzenia", direction: "expense", currentPlanCents: 80000, executedNetCents: 90000, executionPercent: 112.5, overBudget: true, active: true });
  assert.equal(over.percent, "112,5%");
  assert.equal(over.note, "przekroczenie planu");
  assert.equal(over.overBudget, true);
  const outside = budgetExecutionRow({ categoryName: "Inne", direction: "expense", currentPlanCents: null, executedNetCents: 1500, executionPercent: null, active: false });
  assert.deepEqual([outside.planned, outside.percent, outside.note], ["—", "—", "kategoria wyłączona, poza planem"]);
});

test("#117: wynik wydarzeń w panelu — adres, wiersze i pozycja bez przypisania", async () => {
  const { buildCostCentersUrl, costCenterRows } = await import("../ledger/core.js");
  assert.equal(buildCostCentersUrl("y2026"), "/api/ledger/cost-centers?schoolYearId=y2026&type=event&format=json");
  assert.equal(buildCostCentersUrl("y2026", "csv"), "/api/ledger/cost-centers?schoolYearId=y2026&type=event&format=csv");
  assert.throws(() => buildCostCentersUrl("../x"));
  assert.throws(() => buildCostCentersUrl("y2026", "xml"));
  const view = costCenterRows({
    centers: [{ id: "ev-1", name: "Bal testowy", status: "cancelled", entryCount: 1, incomeCents: 0, expenseCents: 9000, resultCents: -9000 }],
    general: { incomeCents: 100, expenseCents: 0, resultCents: 100 },
    totals: { incomeCents: 100, expenseCents: 9000, resultCents: -8900 },
  });
  assert.deepEqual([view.centers[0].name, view.centers[0].status, view.centers[0].entryCount, view.centers[0].negative], ["Bal testowy", "odwołane", 1, true]);
  assert.equal(view.general.name, "Bez przypisania");
  assert.equal(view.totals.negative, true);
  assert.deepEqual(costCenterRows(null).centers, []);
});

test("#93: lista uchwał zamiast wolnego tekstu — adres, opis pozycji i limit upoważnienia", async () => {
  const { buildResolutionsUrl, resolutionOptionLabel, resolutionLimitInfo } = await import("../ledger/core.js");
  assert.equal(buildResolutionsUrl("y2026"), "/api/ledger/resolutions?schoolYearId=y2026");
  assert.throws(() => buildResolutionsUrl("../x"));
  const limited = { id: "r1", number: "U-1/2026", title: "Budżet", authorizedAmountCents: 500000, spentNetCents: 200000, remainingCents: 300000, validUntil: "2026-12-31" };
  const open = { id: "r2", number: "U-2/2026", title: "Wycieczka", authorizedAmountCents: null, spentNetCents: 0, remainingCents: null, validUntil: null };
  assert.match(resolutionOptionLabel(limited), /^U-1\/2026 — Budżet \(pozostało .*3\s?000,00.*\)$/);
  assert.match(resolutionOptionLabel(open), /bez limitu kwoty/);
  assert.equal(resolutionLimitInfo(null, 100, "").text, "");
  const ok = resolutionLimitInfo(limited, 300000, "2026-10-01");
  assert.deepEqual([ok.exceeded, ok.expired], [false, false]);
  const over = resolutionLimitInfo(limited, 300001, "2026-10-01");
  assert.equal(over.exceeded, true);
  assert.match(over.text, /przekracza pozostałą kwotę/);
  const late = resolutionLimitInfo(limited, 100, "2027-01-02");
  assert.equal(late.expired, true);
  const noLimit = resolutionLimitInfo(open, 9_999_999, "2030-01-01");
  assert.deepEqual([noLimit.exceeded, noLimit.expired], [false, false]);
  assert.match(noLimit.text, /nie określa kwoty/);
});

test("#93: panel nie wysyła już wolnego tekstu referencji uchwały", async () => {
  const { readFile } = await import("node:fs/promises");
  const [html, main] = await Promise.all([readFile(new URL("../ledger/index.html", import.meta.url), "utf8"), readFile(new URL("../ledger/main.js", import.meta.url), "utf8")]);
  assert.doesNotMatch(html, /name="resolutionReference"/);
  assert.match(html, /<select name="resolutionId"/);
  assert.match(main, /resolutionId: resolutionId \|\| null/);
  assert.doesNotMatch(main, /resolutionReference:/);
});

test("#107: historia preliminarza — wersje per kategoria, kwoty w centach, przyjęcia", async () => {
  const { buildBudgetHistoryUrl, budgetHistoryView, canAdoptBudget } = await import("../ledger/core.js");
  assert.equal(buildBudgetHistoryUrl("y2026"), "/api/ledger/budget/history?schoolYearId=y2026");
  assert.throws(() => buildBudgetHistoryUrl("zły id"));
  const view = budgetHistoryView({
    lines: [
      { id: "l1", categoryId: "c1", categoryName: "Wydarzenia", direction: "expense", plannedCents: 80000, note: null, createdBy: "u1", createdAt: "2026-10-01T09:30:00.000Z", current: false },
      { id: "l2", categoryId: "c1", categoryName: "Wydarzenia", direction: "expense", plannedCents: 95050, note: "Zmiana", createdBy: "u1", createdAt: "2026-11-02T10:00:00.000Z", current: true },
    ],
    adoptions: [{ id: "a1", adoptedOn: "2026-10-15", note: "Zebranie", resolutionNumber: "U/1", adoptedBy: "u2", lineIds: ["l1"] }],
  });
  assert.deepEqual(view.rows.map((r) => r.version), [1, 2]);
  assert.deepEqual(view.rows[0].adoptedOn, ["2026-10-15"]);
  assert.deepEqual(view.rows[1].adoptedOn, []);
  assert.equal(view.currentLines.length, 1);
  assert.equal(view.currentLines[0].plannedCents, 95050);
  assert.match(view.rows[1].planned, /950,50/);
  assert.equal(view.rows[0].createdAt, "2026-10-01 09:30 UTC");
  assert.equal(view.adoptionRows[0].lineCount, 1);
  assert.equal(budgetHistoryView(null).rows.length, 0);
  assert.equal(canAdoptBudget([{ role: "board" }], "y1"), true);
  assert.equal(canAdoptBudget([{ role: "treasurer" }], "y1"), false);
  assert.equal(canAdoptBudget([{ role: "board", classId: "c" }], "y1"), false);
});

test("#107: treści żądań preliminarza — centy EUR, walidacja przed wysyłką", async () => {
  const c = await import("../ledger/core.js");
  assert.deepEqual(c.budgetLineRequestBody({ schoolYearId: "y1", categoryId: "c1", amount: "1500,50", note: "" }), { schoolYearId: "y1", categoryId: "c1", plannedCents: 150050 });
  assert.equal(c.budgetLineRequestBody({ schoolYearId: "y1", categoryId: "c1", amount: "10", note: " Uwaga " }).note, "Uwaga");
  assert.throws(() => c.budgetLineRequestBody({ schoolYearId: "y1", categoryId: "c1", amount: "10,999" }), /dwoma/);
  assert.throws(() => c.budgetLineRequestBody({ schoolYearId: "y1", categoryId: "", amount: "10" }), /kategorię/);
  assert.deepEqual(c.budgetRevisionRequestBody({ lineId: "l2", amount: "20", reason: " Nowa wycena " }), { lineId: "l2", body: { plannedCents: 2000, reason: "Nowa wycena" } });
  assert.throws(() => c.budgetRevisionRequestBody({ lineId: "l2", amount: "20", reason: "ab" }), /powód/i);
  assert.deepEqual(c.categoryRequestBody({ schoolYearId: "y1", direction: "income", name: " Składki " }), { schoolYearId: "y1", direction: "income", name: "Składki" });
  assert.throws(() => c.categoryRequestBody({ schoolYearId: "y1", direction: "x", name: "Składki" }));
  assert.deepEqual(c.budgetAdoptionRequestBody({ schoolYearId: "y1", adoptedOn: "2026-10-15", note: "Zebranie", resolutionId: "" }), { schoolYearId: "y1", adoptedOn: "2026-10-15", note: "Zebranie" });
  assert.equal(c.budgetAdoptionRequestBody({ schoolYearId: "y1", adoptedOn: "2026-10-15", note: "Zebranie", resolutionId: "r1" }).resolutionId, "r1");
  assert.throws(() => c.budgetAdoptionRequestBody({ schoolYearId: "y1", adoptedOn: "", note: "Zebranie" }), /datę/);
  assert.equal(c.deactivationRequestBody({ categoryId: "c1", reason: "Nieaktualna" }).body.reason, "Nieaktualna");
});

test("#207: „Dodaj wpis” wyłączony z komunikatem, gdy rok nie ma kategorii", async () => {
  const { openEntryState, NO_CATEGORIES_HINT } = await import("../ledger/core.js");
  const query = { schoolYearId: "2026-2027", direction: "" };
  assert.deepEqual(openEntryState({ query, categoryCount: 2 }), { disabled: false, hint: "" });
  assert.deepEqual(openEntryState({ query, categoryCount: 0 }), { disabled: true, hint: NO_CATEGORIES_HINT });
  assert.match(NO_CATEGORIES_HINT, /^Brak kategorii dla tego roku\./);
  assert.equal(openEntryState({ query: null, categoryCount: 3 }).hint, "Dostępne po wczytaniu roku szkolnego.");
  assert.equal(openEntryState({ query, categoryCount: 3, loading: true }).disabled, true);
  assert.match(openEntryState({ query, categoryCount: 0, changed: true }).hint, /Zmieniono filtr/);
});

test("#207: kopiowanie kategorii — treść żądania i potwierdzenie z podglądu", async () => {
  const { categoryCopyRequestBody, categoryCopyConfirm } = await import("../ledger/core.js");
  const body = categoryCopyRequestBody({ fromSchoolYearId: " 2026-2027 ", toSchoolYearId: "2027-2028" });
  assert.deepEqual(body, { fromSchoolYearId: "2026-2027", toSchoolYearId: "2027-2028" });
  assert.throws(() => categoryCopyRequestBody({ fromSchoolYearId: "2027-2028", toSchoolYearId: "2027-2028" }), /inny/);
  assert.throws(() => categoryCopyRequestBody({ fromSchoolYearId: "", toSchoolYearId: "2027-2028" }), /źródłowego/);
  const confirm = categoryCopyConfirm({
    copied: [{ direction: "income", name: "Składki" }],
    skipped: [{ direction: "expense", name: "Wycieczki" }],
  }, body);
  assert.equal(confirm.confirmLabel, "Kopiuj kategorie");
  assert.ok(confirm.effects.some((line) => line === "Nowa: Składki (Przychód)"));
  assert.ok(confirm.effects.some((line) => /Pominięte.*Wycieczki \(Wydatek\)/.test(line)));
  assert.throws(() => categoryCopyConfirm({ copied: [], skipped: [{ direction: "income", name: "Składki" }] }, body), /Nic nie zapisano/);
  assert.throws(() => categoryCopyConfirm({ copied: [], skipped: [] }, body), /nie ma aktywnych kategorii/);
});

test("#207: bilans otwarcia pierwszego roku — kwoty w centach, rachunek ze znakiem, kasa ≥ 0, tylko zarząd", async () => {
  const { openingBalanceRequestBody, canRecordOpeningBalance } = await import("../ledger/core.js");
  assert.deepEqual(
    openingBalanceRequestBody({ schoolYearId: "2026-2027", bank: "1 250,50", cash: "", note: "Stan z papierowej księgi", sourceDocumentId: "" }),
    { schoolYearId: "2026-2027", bankCents: 125050, cashCents: 0, note: "Stan z papierowej księgi" },
  );
  assert.equal(openingBalanceRequestBody({ schoolYearId: "y", bank: "-20,00", cash: "5", note: "abc" }).bankCents, -2000);
  assert.equal(openingBalanceRequestBody({ schoolYearId: "y", bank: "0", cash: "5", note: "abc", sourceDocumentId: "doc-1" }).sourceDocumentId, "doc-1");
  assert.throws(() => openingBalanceRequestBody({ schoolYearId: "y", bank: "10", cash: "-1", note: "abc" }), /kasy/);
  assert.throws(() => openingBalanceRequestBody({ schoolYearId: "y", bank: "abc", cash: "0", note: "abc" }), /rachunku/);
  assert.throws(() => openingBalanceRequestBody({ schoolYearId: "y", bank: "1", cash: "0", note: "a" }), /opis/);
  const board = [{ role: "board", schoolYearId: "y" }];
  const empty = { openingBalance: null };
  assert.equal(canRecordOpeningBalance(board, "y", empty), true);
  assert.equal(canRecordOpeningBalance(board, "y", { openingBalance: { id: "ob-1" } }), false, "rok z bilansem");
  assert.equal(canRecordOpeningBalance(board, "y", null), false, "brak danych o bilansie");
  for (const role of ["treasurer", "admin", "audit"]) {
    assert.equal(canRecordOpeningBalance([{ role, schoolYearId: "y" }], "y", empty), false, role);
  }
  assert.equal(canRecordOpeningBalance([{ role: "board", schoolYearId: "inny" }], "y", empty), false);
});

test("#207: panel ma akcje kopiowania kategorii i bilansu otwarcia na istniejących trasach", async () => {
  const { readFile } = await import("node:fs/promises");
  const [html, main] = await Promise.all([readFile(new URL("../ledger/index.html", import.meta.url), "utf8"), readFile(new URL("../ledger/main.js", import.meta.url), "utf8")]);
  for (const id of ["open-copy", "copy-dialog", "opening-actions", "open-opening", "opening-dialog"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(main, /\/api\/ledger\/categories\/copy/);
  assert.match(main, /dryRun/);
  assert.match(main, /\/api\/ledger\/opening-balance/);
});

test("filtry księgi trafiają do adresu, walidacja odrzuca złe wartości, zmiana filtra jest wykrywana (#128)", () => {
  const filters = { schoolYearId: "y2026", direction: "income", category: "cat-fees", dateFrom: "2026-09-01", dateTo: "2026-09-30" };
  const params = new URL(buildLedgerUrl(filters), "https://rd.example").searchParams;
  assert.equal(params.get("category"), "cat-fees");
  assert.equal(params.get("dateFrom"), "2026-09-01");
  assert.equal(params.get("dateTo"), "2026-09-30");
  assert.equal(new URL(buildLedgerUrl({ schoolYearId: "y2026" }), "https://rd.example").searchParams.has("category"), false);
  assert.throws(() => buildLedgerUrl({ ...filters, category: "a b" }));
  assert.throws(() => buildLedgerUrl({ ...filters, dateTo: "2026-13-01" }));
  assert.throws(() => buildLedgerUrl({ ...filters, dateFrom: "2026-10-01", dateTo: "2026-09-01" }));
  const query = ledgerQuery(filters);
  assert.equal(ledgerFilterChanged(query, filters), false);
  assert.equal(ledgerFilterChanged(query, { ...filters, category: "" }), true);
  assert.equal(ledgerFilterChanged(query, { ...filters, dateFrom: "2026-09-02" }), true);
  assert.equal(new URL(buildNextLedgerUrl(query, "kursor"), "https://rd.example").searchParams.get("category"), "cat-fees");
});

// #144: łańcuch przeksięgowań w wierszu księgi (storno + wpis zastępczy).
test("#144: wiersz opisuje, co wpis zastępuje i czym został zastąpiony", async () => {
  const { normalizeEntry, replacementChainLabels } = await import("../ledger/core.js");
  const loaded = [
    { id: "e-old", occurredOn: "2026-10-01", categoryName: "Składki A", replacedByEntryId: "e-mid" },
    { id: "e-mid", occurredOn: "2026-10-02", categoryName: "Składki B", replacesEntryId: "e-old", replacedByEntryId: "e-new" },
  ];
  assert.deepEqual(replacementChainLabels(normalizeEntry(loaded[1]), loaded),
    ["Zastępuje wpis z 2026-10-01 (Składki A)", "Zastąpiony przez wpis e-new"]);
  assert.deepEqual(replacementChainLabels(normalizeEntry(loaded[0]), loaded), ["Zastąpiony przez wpis z 2026-10-02 (Składki B)"]);
  assert.deepEqual(replacementChainLabels(normalizeEntry({ id: "e-plain" }), loaded), []);
  // Niepoprawny identyfikator z API nie trafia do opisu.
  assert.equal(normalizeEntry({ id: "x", replacesEntryId: "zły id" }).replacesEntryId, "");
});

test("#82: stan dowodów wpisu — dopisek do „Dowody: N”, bez słowa „usunięty”", () => {
  const entry = normalizeEntry({
    id: "e1", direction: "expense", amountCents: 1200, method: "bank",
    attachmentIds: ["d1", "d2", "d3"],
    attachments: [
      { documentId: "d1", status: "superseded", currentDocumentId: "d9" },
      { documentId: "d2", status: "voided", currentDocumentId: null },
      { documentId: "d3", status: "superseded", currentDocumentId: null },
    ],
  });
  assert.equal(entry.attachmentCount, 3);
  assert.deepEqual(entry.attachmentStatus, { superseded: 2, voided: 1, withoutCurrent: 1 });
  const label = attachmentStatusLabel(entry.attachmentStatus);
  assert.equal(label, " (zastąpione nowszą wersją: 2, unieważnione: 1, bez aktualnej wersji: 1)");
  assert.doesNotMatch(label, /usuni/i);
  // Starsze API (bez pola attachments) i same aktualne dowody: bez dopisku.
  assert.equal(attachmentStatusLabel(normalizeEntry({ id: "e2", attachmentIds: ["d1"] }).attachmentStatus), "");
  assert.deepEqual(attachmentStatusSummary([{ status: "active", currentDocumentId: "d1" }]), { superseded: 0, voided: 0, withoutCurrent: 0 });
});

// --- D-09 (#137): widok tylko do odczytu Komisji Rewizyjnej w panelu księgi -------------------------------
// Ukrycie przycisku NIE jest kontrolą dostępu (zapisy odrzuca serwer: tests/pg-audit-ledger-read.test.js);
// te testy pilnują, że panel w widoku audit nie renderuje i nie woła niczego z zapisu.

const ledgerHtml = readFileSync(new URL("../ledger/index.html", import.meta.url), "utf8");
const ledgerMain = readFileSync(new URL("../ledger/main.js", import.meta.url), "utf8");
const AUDIT_ON = { auditLedgerRead: true };
const AUDIT_GRANT = [{ role: "audit", classId: null, schoolYearId: "2026-2027" }];

function functionSource(source, header) {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `brak ${header}`);
  const next = source.indexOf("\n}\n", start);
  return source.slice(start, next + 3);
}

test("D-09: widok audit tylko dla konta audit bez klasy, z możliwością z sesji i bez roli finansowej", () => {
  assert.equal(isLedgerAuditView(AUDIT_GRANT, AUDIT_ON), true);
  assert.equal(isLedgerAuditView(AUDIT_GRANT, { auditLedgerRead: false }), false, "flaga serwera wyłączona");
  assert.equal(isLedgerAuditView(AUDIT_GRANT, {}), false);
  assert.equal(isLedgerAuditView(AUDIT_GRANT, undefined), false);
  assert.equal(isLedgerAuditView([{ role: "audit", classId: "1A", schoolYearId: "2026-2027" }], AUDIT_ON), false, "przydział klasowy");
  assert.equal(isLedgerAuditView([{ role: "representative", classId: "1A" }], AUDIT_ON), false, "możliwość bez roli audit");
  // Rola finansowa zostawia widok pełny (dotychczasowe zachowanie panelu).
  for (const role of ["admin", "board", "treasurer"]) assert.equal(isLedgerAuditView([...AUDIT_GRANT, { role }], AUDIT_ON), false, role);
  assert.equal(isLedgerAuditView([...AUDIT_GRANT, { role: "board", classId: "1A" }], AUDIT_ON), true, "zarząd tylko klasowy nie ma dostępu finansowego");
});

test("D-09: lista usuwanych elementów wskazuje istniejące elementy i obejmuje każdy <dialog> oraz każdy przycisk poza odczytem", () => {
  assertEvery(AUDIT_REMOVED_ELEMENT_IDS, (id) => ledgerHtml.includes(`id="${id}"`), "elementy z AUDIT_REMOVED_ELEMENT_IDS istnieją w ledger/index.html");
  const dialogs = [...ledgerHtml.matchAll(/<dialog id="([^"]+)"/g)].map((match) => match[1]);
  assertEvery(dialogs, (id) => AUDIT_REMOVED_ELEMENT_IDS.includes(id), "każdy <dialog> (formularz zapisu) jest usuwany w widoku audit", { min: 8 });
  // Zakresy usuwanych sekcji i okien dialogowych w kodzie strony.
  const range = (open, close, from) => [ledgerHtml.indexOf(open, from), ledgerHtml.indexOf(close, ledgerHtml.indexOf(open, from))];
  const removedRanges = [
    ...["budget-section", "history-section", "events-section"].map((id) => range(`id="${id}"`, "</section>", 0)),
    range('id="opening-actions"', "</div>", 0),
    ...[...ledgerHtml.matchAll(/<dialog id="/g)].map((match) => range("<dialog", "</dialog>", match.index)),
  ];
  assertEvery(removedRanges, ([from, to]) => from > 0 && to > from, "zakresy usuwanych bloków znalezione", { min: 12 });
  // Każdy przycisk z identyfikatorem jest usuwany w widoku audit (wprost albo wraz z blokiem) — poza
  // jawnie dozwolonymi przyciskami odczytu. Nowy przycisk wymaga decyzji: dopisz go tu albo do listy.
  const READ_ONLY_BUTTONS = ["load-more", "print-ledger"];
  const uncovered = [...ledgerHtml.matchAll(/<button[^>]*\bid="([^"]+)"/g)]
    .filter((match) => !AUDIT_REMOVED_ELEMENT_IDS.includes(match[1]) && !removedRanges.some(([from, to]) => match.index > from && match.index < to))
    .map((match) => match[1]);
  assert.deepEqual(uncovered.sort(), READ_ONLY_BUTTONS);
  // Wszystkie przyciski otwierające zapis (open-*) są pokryte.
  const openButtons = [...ledgerHtml.matchAll(/<button[^>]*\bid="(open-[a-z-]+)"/g)].map((match) => match[1]);
  assertEvery(openButtons, (id) => !uncovered.includes(id), "przyciski open-* usuwane w widoku audit", { min: 8 });
});

test("D-09: wiersz księgi w widoku audit nie ma kolumny ani przycisku akcji (korekta), a w widoku pełnym ma", () => {
  const entryRow = functionSource(ledgerMain, "function entryRow(raw)");
  const guard = entryRow.indexOf("if (state.auditView) return row;");
  assert.notEqual(guard, -1, "wiersz audit kończy się przed akcjami");
  assert.ok(guard < entryRow.indexOf('"Korekta"'), "strażnik stoi przed utworzeniem przycisku „Korekta”");
  assert.ok(guard < entryRow.indexOf("row-actions"));
});

test("D-09: wczytanie roku w widoku audit woła wyłącznie trasy odczytu (podsumowanie, kategorie, lista) i nic z zapisu ani preliminarza", () => {
  const audit = functionSource(ledgerMain, "async function loadAuditOverview(query)");
  assert.match(audit, /buildOverviewUrl\("summary"/);
  assert.match(audit, /buildOverviewUrl\("categories"/);
  assert.match(audit, /loadEntries\(/);
  assert.match(audit, /buildLedgerExportUrl\("csv"/);
  assert.match(audit, /buildLedgerExportUrl\("xlsx"/);
  assert.doesNotMatch(audit, /budget|CostCenters|Resolutions|opening-balance|History|method:|POST|PATCH|DELETE|Idempotency/i);
  // loadOverview przełącza się na tę ścieżkę przed jakimkolwiek wywołaniem tras preliminarza.
  const overview = functionSource(ledgerMain, "async function loadOverview(");
  assert.ok(overview.indexOf("loadAuditOverview(query)") !== -1 && overview.indexOf("loadAuditOverview(query)") < overview.indexOf("budget/execution"));
});

test("D-09: widok audit rozstrzygany przed pierwszym wczytaniem roku i zastępuje komunikat o braku dostępu", () => {
  const init = ledgerMain.slice(ledgerMain.indexOf("(async function initFilters()"));
  assert.ok(init.indexOf("await auditViewReady") !== -1 && init.indexOf("await auditViewReady") < init.indexOf("loadOverview();"));
  const access = functionSource(ledgerMain, "async function applyAccess()");
  assert.ok(access.indexOf("await auditViewReady") !== -1 && access.indexOf("await auditViewReady") < access.indexOf("access-notice"), "audit nie dostaje „To konto nie ma dostępu”");
  const apply = functionSource(ledgerMain, "function applyAuditView()");
  assert.match(apply, /\.remove\(\)/, "elementy zapisu są usuwane z DOM, nie tylko ukrywane");
});

test("D-09: wpis powiązany z wpłatą rodziny — stały opis i znacznik „wpłata rodziny”, bez wolnego tekstu z odpowiedzi", () => {
  const raw = {
    id: "e-wplata", direction: "income", amountCents: 5000, method: "bank", categoryName: "Składki dobrowolne",
    description: "MRK-OPIS-RODZINY", source: "MRK-ZRODLO-RODZINY", resolutionReference: "MRK-UCHWALA-RODZINY",
    paymentLinked: true, paymentEntryId: null,
  };
  const entry = normalizeEntry(raw);
  assert.equal(entry.paymentLinked, true);
  const texts = entryTexts(entry);
  assert.equal(texts.description, PAYMENT_LINKED_DESCRIPTION);
  assert.equal(texts.badge, "wpłata rodziny");
  assert.deepEqual([texts.source, texts.resolutionReference], ["", ""]);
  assert.doesNotMatch(JSON.stringify(texts), /MRK-/);
  // Zwykły wpis (bez znacznika) zachowuje opis, źródło i uchwałę oraz nie ma znacznika.
  const plain = entryTexts(normalizeEntry({ ...raw, id: "e-wydatek", paymentLinked: undefined, direction: "expense" }));
  assert.deepEqual([plain.description, plain.source, plain.resolutionReference, plain.badge], ["MRK-OPIS-RODZINY", "MRK-ZRODLO-RODZINY", "MRK-UCHWALA-RODZINY", ""]);
  assert.equal(entryTexts(normalizeEntry({ id: "e3" })).description, "Bez opisu");
  // Tylko dokładne `true` oznacza wpis powiązany z wpłatą.
  for (const value of ["true", 1, null, undefined, false]) assert.equal(normalizeEntry({ id: "e4", paymentLinked: value }).paymentLinked, false, String(value));
  assert.match(ledgerMain, /texts\.badge/, "wiersz w panelu używa entryTexts, nie surowego opisu");
});

test("D-09: adresy eksportu CSV i XLSX roku; zły format lub rok jest odrzucany", () => {
  assert.equal(buildLedgerExportUrl("csv", "2026-2027"), "/api/ledger/export.csv?schoolYearId=2026-2027");
  assert.equal(buildLedgerExportUrl("xlsx", " y2026 "), "/api/ledger/export.xlsx?schoolYearId=y2026");
  assert.throws(() => buildLedgerExportUrl("pdf", "y2026"), /eksportu/);
  assert.throws(() => buildLedgerExportUrl("csv", "../x"), /eksportu/);
  assert.throws(() => buildLedgerExportUrl("csv", ""), /eksportu/);
  for (const id of ["audit-export", "export-csv", "export-xlsx", "audit-notice"]) assert.ok(ledgerHtml.includes(`id="${id}"`), id);
  // Elementy widoku audit są domyślnie ukryte — pojawiają się dopiero po rozstrzygnięciu widoku.
  assert.match(ledgerHtml, /id="audit-export" hidden/);
  assert.match(ledgerHtml, /id="audit-notice"[^>]* hidden/);
});
