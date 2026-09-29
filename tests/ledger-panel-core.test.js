import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLedgerUrl,
  buildOverviewUrl,
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
