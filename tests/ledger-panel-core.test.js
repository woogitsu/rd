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
