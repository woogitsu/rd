import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPaymentsUrl,
  formatCents,
  makeIdempotencyKey,
  normalizePayment,
  parseEuroAmount,
} from "../panel/core.js";

test("kwota EUR jest zamieniana na całkowitą liczbę centów", () => {
  assert.equal(parseEuroAmount("123,45"), 12_345);
  assert.equal(parseEuroAmount("10"), 1_000);
  assert.equal(parseEuroAmount("-10,50", { allowNegative: true }), -1_050);
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
    method: "bank_transfer",
    status: "recorded",
    amountCents: 5_000,
    correctedCents: -500,
  }), {
    id: "pay-1",
    schoolYearId: "2026-2027",
    familyId: null,
    familyLabel: "—",
    receivedOn: "2026-09-27",
    method: "bank_transfer",
    status: "recorded",
    reference: "",
    amountCents: 5_000,
    correctedCents: -500,
    netCents: 4_500,
  });
});
