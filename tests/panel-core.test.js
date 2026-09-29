import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import {
  allocationReversalUrl,
  allocationSummaryText,
  allocationsUrl,
  assertHouseholdNotAllocated,
  buildAllocationBody,
  buildAllocationReversalBody,
  normalizeAllocations,
  validateAllocationAmount,
  buildPaymentsUrl,
  formatCents,
  makeIdempotencyKey,
  normalizePayment,
  parseEuroAmount,
} from "../panel/core.js";

test("kwota EUR jest zamieniana na całkowitą liczbę centów", () => {
  assert.equal(parseEuroAmount("123,45"), 12_345);
  assert.equal(parseEuroAmount("10"), 1_000);
  assert.throws(() => parseEuroAmount("10,501"));
  assert.throws(() => parseEuroAmount("-10"));
  assert.match(formatCents(12_345), /123,45/);
});

test("adres listy zawiera wyłącznie zwalidowane filtry", () => {
  assert.equal(
    buildPaymentsUrl({ schoolYearId: "2026-2027", status: "unmatched", cursor: "next:42" }),
    "/api/payments?schoolYearId=2026-2027&limit=50&status=unmatched&cursor=next%3A42",
  );
  assert.throws(() => buildPaymentsUrl({ schoolYearId: "" }));
  assert.throws(() => buildPaymentsUrl({ schoolYearId: "2026", status: "overdue" }));
});

test("klucz idempotencji otrzymuje stabilny prefiks", () => {
  assert.equal(makeIdempotencyKey("payment", () => "uuid-1"), "payment-uuid-1");
});

test("normalizacja wylicza kwotę netto i bezpieczne etykiety", () => {
  assert.deepEqual(normalizePayment({
    id: "pay-1",
    schoolYearId: "2026-2027",
    receivedOn: "2026-09-27",
    method: "bank",
    status: "recorded",
    amountCents: 5_000,
    correctedCents: 500,
  }), {
    id: "pay-1",
    schoolYearId: "2026-2027",
    householdId: null,
    receivedOn: "2026-09-27",
    method: "bank",
    status: "recorded",
    reference: "",
    amountCents: 5_000,
    correctedCents: 500,
    netCents: 4_500,
  });
});

// #192: „Wczytaj następne” używa zapamiętanego zapytania, nie bieżących pól formularza.
test("dociągnięcie strony używa zapamiętanego zapytania i kursora", async () => {
  const { paymentsQuery, buildNextPaymentsUrl, paymentsFilterChanged } = await import("../panel/core.js");
  const query = paymentsQuery({ schoolYearId: " y2026 ", status: "recorded" });
  assert.deepEqual({ ...query }, { schoolYearId: "y2026", status: "recorded" });
  assert.ok(Object.isFrozen(query));
  assert.equal(
    buildNextPaymentsUrl(query, "abc"),
    "/api/payments?schoolYearId=y2026&limit=50&status=recorded&cursor=abc",
  );
  // Brak kursora (mniej wyników niż limit) albo brak zapytania: żadnego żądania.
  assert.equal(buildNextPaymentsUrl(query, null), null);
  assert.equal(buildNextPaymentsUrl(query, ""), null);
  assert.equal(buildNextPaymentsUrl(null, "abc"), null);
  // Zmiana pola bez „Pokaż” jest wykrywana; spacje wokół roku nie są zmianą.
  assert.equal(paymentsFilterChanged(query, { schoolYearId: "y2026 ", status: "recorded" }), false);
  assert.equal(paymentsFilterChanged(query, { schoolYearId: "y2027", status: "recorded" }), true);
  assert.equal(paymentsFilterChanged(query, { schoolYearId: "y2026", status: "unmatched" }), true);
  assert.equal(paymentsFilterChanged(null, { schoolYearId: "y2027", status: "" }), false);
  assert.throws(() => paymentsQuery({ schoolYearId: "", status: "" }));
  assert.throws(() => paymentsQuery({ schoolYearId: "y2026", status: "reversed" }));
});

// --- #127: podział wpłaty (dane syntetyczne, kwoty w centach) ---

const SPLIT_RESPONSE = {
  paymentEntryId: "pay-1",
  status: "unmatched",
  householdId: null,
  netAmountCents: 7_500,
  allocatedCents: 5_000,
  allocations: [
    { id: "al-1", householdId: "hh-a", amountCents: 2_500, createdAt: "2026-09-01T10:00:00.000Z", reversal: null },
    { id: "al-2", householdId: "hh-b", amountCents: 2_500, createdAt: "2026-09-01T10:01:00.000Z", reversal: null },
    { id: "al-3", householdId: "hh-c", amountCents: 1_000, createdAt: "2026-09-01T10:02:00.000Z", reversal: { id: "r-1", reason: "pomyłka", createdAt: "2026-09-01T10:03:00.000Z" } },
  ],
};

test("adresy podziału wpłaty są kodowane i walidowane", () => {
  assert.equal(allocationsUrl("pay-1"), "/api/payments/pay-1/allocations");
  assert.equal(allocationReversalUrl("pay-1", "al-2"), "/api/payments/pay-1/allocations/al-2/reversal");
  assert.throws(() => allocationsUrl("../x"));
  assert.throws(() => allocationReversalUrl("pay-1", ""));
});

test("normalizeAllocations liczy sumę bieżących części i resztę, pomija cofnięte", () => {
  const view = normalizeAllocations(SPLIT_RESPONSE);
  assert.equal(view.allocatedCents, 5_000);
  assert.equal(view.remainingCents, 2_500);
  assert.equal(view.active.length, 2);
  assert.equal(view.reversed.length, 1);
  assert.equal(view.canAllocate, true);
  assert.match(allocationSummaryText(view), /75,00.*50,00.*25,00/);
  assert.equal(normalizeAllocations({ ...SPLIT_RESPONSE, status: "recorded", householdId: "hh-a" }).canAllocate, false);
});

test("kwota części: dodatnia, w centach, nie większa niż reszta netto", () => {
  assert.equal(validateAllocationAmount(2_500, 2_500), 2_500);
  assert.equal(validateAllocationAmount(1, 2_500), 1);
  assert.throws(() => validateAllocationAmount(2_501, 2_500), /przekracza/);
  assert.throws(() => validateAllocationAmount(0, 2_500), /dodatnia/);
  assert.throws(() => validateAllocationAmount(-5, 2_500), /dodatnia/);
  assert.throws(() => validateAllocationAmount(10.5, 2_500), /dodatnia/);
  assert.throws(() => validateAllocationAmount(100, 0), /już podzielona/);
  // wpłata częściowo skorygowana: reszta liczona od netto, nie od kwoty brutto
  const corrected = normalizeAllocations({ ...SPLIT_RESPONSE, netAmountCents: 4_000 });
  assert.equal(corrected.remainingCents, -1_000);
  assert.throws(() => validateAllocationAmount(100, corrected.remainingCents), /już podzielona/);
});

test("to samo gospodarstwo nie dostaje drugiej bieżącej części, po cofnięciu może", () => {
  const view = normalizeAllocations(SPLIT_RESPONSE);
  assert.throws(() => assertHouseholdNotAllocated(view, "hh-a"), /ma już część/);
  assert.doesNotThrow(() => assertHouseholdNotAllocated(view, "hh-c"));
  assert.throws(() => assertHouseholdNotAllocated(view, ""), /Wybierz/);
});

test("treść żądań podziału ma kształt API, a powód cofnięcia 3–500 znaków", () => {
  assert.deepEqual(buildAllocationBody(" hh-a ", 2_500), { householdId: "hh-a", amountCents: 2_500 });
  assert.throws(() => buildAllocationBody("hh-a", 0));
  assert.deepEqual(buildAllocationReversalBody("  pomyłka  "), { reason: "pomyłka" });
  assert.throws(() => buildAllocationReversalBody("ab"));
  assert.throws(() => buildAllocationReversalBody("x".repeat(501)));
  const source = readFileSync(new URL("../src/pg/routes/payments.js", import.meta.url), "utf8");
  assert.match(source, /data\.householdId/);
  assert.match(source, /readAmount\(data\.amountCents\)/);
  assert.match(source, /textOrNull\(data\.reason, 500\)/);
});

test("panel podziału nie wprowadza statusu „dłużnik”", () => {
  for (const file of ["../panel/core.js", "../panel/main.js", "../panel/index.html"]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(text, /dłużnik/i, file);
  }
});
