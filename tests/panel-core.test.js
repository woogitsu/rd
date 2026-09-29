import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPaymentsUrl,
  formatCents,
  makeIdempotencyKey,
  normalizePayment,
  parseEuroAmount,
  paymentsFilterChanged,
  paymentsQuery,
  buildNextPaymentsUrl,
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

test("filtry listy wpłat trafiają do adresu, walidacja odrzuca złe wartości, zmiana filtra jest wykrywana (#128)", () => {
  const filters = { schoolYearId: "y2026", method: "bank", dateFrom: "2026-09-01", dateTo: "2026-09-30", householdId: "h1", q: " 100% " };
  const params = new URL(buildPaymentsUrl(filters), "https://rd.example").searchParams;
  assert.equal(params.get("method"), "bank");
  assert.equal(params.get("dateFrom"), "2026-09-01");
  assert.equal(params.get("householdId"), "h1");
  assert.equal(params.get("q"), "100%");
  assert.equal(new URL(buildPaymentsUrl({ schoolYearId: "y2026" }), "https://rd.example").searchParams.has("q"), false);
  assert.throws(() => buildPaymentsUrl({ ...filters, method: "blik" }));
  assert.throws(() => buildPaymentsUrl({ ...filters, dateFrom: "wczoraj" }));
  assert.throws(() => buildPaymentsUrl({ ...filters, dateFrom: "2026-10-01", dateTo: "2026-09-01" }));
  assert.throws(() => buildPaymentsUrl({ ...filters, q: "a".repeat(101) }));
  const query = paymentsQuery(filters);
  assert.equal(paymentsFilterChanged(query, filters), false);
  assert.equal(paymentsFilterChanged(query, { ...filters, q: "inna" }), true);
  assert.equal(paymentsFilterChanged(query, { ...filters, method: "" }), true);
  const next = new URL(buildNextPaymentsUrl(query, "kursor"), "https://rd.example").searchParams;
  assert.equal(next.get("cursor"), "kursor");
  assert.equal(next.get("q"), "100%");
});
