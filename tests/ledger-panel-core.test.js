import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLedgerUrl,
  buildOverviewUrl,
  buildNextLedgerUrl,
  ledgerFilterChanged,
  ledgerQuery,
  formatCents,
  makeIdempotencyKey,
  needsResolution,
  normalizeEntry,
  parseEuroAmount,
} from "../ledger/core.js";

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
