import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCard,
  buildHouseholds,
  escapeHtml,
  filterHouseholds,
  findForbiddenWording,
  normalizeConfig,
  parseInputRows,
  parseInputText,
  renderCardsHtml,
  selectHouseholds,
} from "../print/core.js";

// Wyłącznie sztuczne dane testowe.
const CSV = [
  "ID rodziny;Imię ucznia;Nazwisko ucznia;Klasa;Wpłaty netto EUR",
  "H-1;Ala;Testowa;3a;",
  "H-1;Olek;Testowy;5b;",
  "H-2;Ewa;Przykładowa;3a;50,00",
  "H-3;Jan;Fikcyjny;1c;0",
  "H-4;Jan;Fikcyjny;1c;",
].join("\n");

const CONFIG = {
  councilName: "Rada Rodziców",
  schoolName: "Szkoła Testowa",
  schoolYear: "2026/2027",
  contact: "rada@example.test",
};

const DEBT_WORDS = /zaległ|dług|dłuż|zadłuż|windyk|należnoś/i;

function households() {
  const parsed = parseInputText(CSV, "lista.csv");
  assert.deepEqual(parsed.errors, []);
  return buildHouseholds(parsed.rows).households;
}

test("rodzeństwo trafia na jedną kartkę, uczeń dwóch rodzin na obie osobno", () => {
  const list = households();
  assert.equal(list.length, 4);
  const h1 = list.find((h) => h.householdId === "H-1");
  assert.deepEqual(h1.students.map((s) => s.name), ["Ala Testowa", "Olek Testowy"]);
  const h3 = list.find((h) => h.householdId === "H-3");
  const h4 = list.find((h) => h.householdId === "H-4");
  assert.deepEqual(h3.students, [{ name: "Jan Fikcyjny", className: "1c" }]);
  assert.deepEqual(h4.students, [{ name: "Jan Fikcyjny", className: "1c" }]);
});

test("kartki powstają wyłącznie dla jawnie wybranych rodzin", () => {
  const list = households();
  assert.equal(renderCardsHtml(list, new Set(), CONFIG).count, 0);
  assert.equal(renderCardsHtml(list, undefined, CONFIG).html, "");

  const result = renderCardsHtml(list, new Set(["H-2", "H-1"]), CONFIG);
  assert.equal(result.count, 2);
  assert.equal((result.html.match(/<article /g) || []).length, 2);
  assert.doesNotMatch(result.html, /H-3|H-4|Jan Fikcyjny/);
  assert.deepEqual(selectHouseholds(list, ["H-9"]), []);
});

test("kartka rodziny nie zawiera imion uczniów z innych rodzin", () => {
  const list = households();
  const { config } = normalizeConfig(CONFIG);
  for (const household of list) {
    const html = renderCardsHtml(list, [household.householdId], CONFIG).html;
    const own = new Set(household.students.map((s) => s.name));
    for (const other of list) {
      for (const student of other.students) {
        if (!own.has(student.name)) assert.doesNotMatch(html, new RegExp(student.name));
      }
    }
    const card = buildCard(household, config);
    assert.equal(card.householdId, household.householdId);
  }
});

test("treść jest neutralna: brak słów o zadłużeniu, jest informacja o dobrowolności", () => {
  const list = households();
  const html = renderCardsHtml(list, list.map((h) => h.householdId), {
    ...CONFIG, suggestedAmount: "40", bankAccount: "BE00 0000 0000 0000", bankRecipient: "Rada", referenceTemplate: "RR {rok} {rodzina}",
  }).html;
  assert.doesNotMatch(html, DEBT_WORDS);
  assert.match(html, /dobrowolna/);
  assert.match(html, /prosimy pominąć/);
  assert.doesNotMatch(html, /brak wpisu|jest wpis/);
  assert.match(html, /RR 2026\/2027 H-2/);
});

test("słowa sugerujące dług w konfiguracji są odrzucane, nazwiska i ulice nie", () => {
  assert.equal(findForbiddenWording("Spłata zaległości"), "zaległości");
  assert.equal(findForbiddenWording("lista dłużników"), "dłużników");
  assert.equal(findForbiddenWording("brak długu"), "długu");
  assert.equal(findForbiddenWording("ul. Długa 5"), null);
  assert.equal(findForbiddenWording("Jan Długosz"), null);
  // #120: szkoła jest w Belgii — te same słowa po francusku i niderlandzku.
  assert.equal(findForbiddenWording("Merci de régler votre dette avant la fin du mois."), "dette");
  assert.equal(findForbiddenWording("Vous êtes en mise en demeure de payer."), "mise en demeure");
  assert.equal(findForbiddenWording("Gelieve uw achterstallige bijdrage te betalen."), "achterstallige");
  assert.equal(findForbiddenWording("Lijst van wanbetalers."), "wanbetalers");
  assert.equal(findForbiddenWording("Cotisation volontaire pour l'année scolaire."), null);
  assert.equal(findForbiddenWording("Vrijwillige bijdrage voor het schooljaar."), null);
  const { errors } = normalizeConfig({ ...CONFIG, contact: "w sprawie zaległości: rada@example.test" });
  assert.equal(errors.length, 1);
  assert.throws(() => renderCardsHtml(households(), ["H-1"], { ...CONFIG, contact: "dług" }));

  const list = buildHouseholds(parseInputRows([{ householdId: "H-9", studentName: "Anna Długosz", className: "2a" }]).rows).households;
  assert.match(renderCardsHtml(list, ["H-9"], CONFIG).html, /Anna Długosz/);
});

test("brak sugerowanej kwoty pomija zdanie o kwocie; brak IBAN pomija dane do wpłaty", () => {
  const list = households();
  const without = renderCardsHtml(list, ["H-1"], { ...CONFIG, referenceTemplate: "RR {rodzina}" }).html;
  assert.doesNotMatch(without, /Sugerowana/);
  assert.doesNotMatch(without, /Rachunek|Tytuł przelewu/);
  const withAmount = renderCardsHtml(list, ["H-1"], { ...CONFIG, suggestedAmount: "40,50" }).html;
  assert.match(withAmount, /Sugerowana kwota składki w roku szkolnym 2026\/2027: 40,50/);
  assert.throws(() => renderCardsHtml(list, ["H-1"], { ...CONFIG, suggestedAmount: "-5" }));
});

test("wszystkie wartości są escapowane", () => {
  assert.equal(escapeHtml(`<img src=x onerror="a">'&\``), "&lt;img src=x onerror=&quot;a&quot;&gt;&#39;&amp;&#96;");
  const list = buildHouseholds(parseInputRows([
    { householdId: "H-1", studentName: "<script>alert(1)</script>", className: "<b>3a</b>" },
  ]).rows).households;
  const html = renderCardsHtml(list, ["H-1"], {
    ...CONFIG,
    councilName: "Rada <i>x</i>",
    contact: `"><img src=x onerror=alert(1)>`,
    bankAccount: "BE00 0000 0000 0000",
    bankRecipient: "<svg onload=alert(1)>",
  }).html;
  assert.doesNotMatch(html, /<script|<img|<svg|<b>|<i>/);
  assert.match(html, /&lt;script&gt;/);
});

test("wzór bez zatwierdzenia ma oznaczenie; zatwierdzony — nie", () => {
  const list = households();
  assert.match(renderCardsHtml(list, ["H-1"], CONFIG).html, /WZÓR/);
  assert.doesNotMatch(renderCardsHtml(list, ["H-1"], { ...CONFIG, templateApproved: true }).html, /WZÓR/);
});

test("wpis wpłaty jest tylko informacją dla operatora i opcjonalnym filtrem", () => {
  const list = households();
  const status = Object.fromEntries(list.map((h) => [h.householdId, h.paymentEntry]));
  assert.deepEqual(status, { "H-1": "unknown", "H-2": "recorded", "H-3": "none", "H-4": "unknown" });
  assert.equal(filterHouseholds(list).length, 4);
  assert.deepEqual(filterHouseholds(list, { hideRecorded: true }).map((h) => h.householdId).sort(), ["H-1", "H-3", "H-4"]);
  assert.deepEqual(filterHouseholds(list, { className: "5b" }).map((h) => h.householdId), ["H-1"]);
});

test("walidacja wejścia raportuje błędne wiersze i niespójne kwoty", () => {
  const parsed = parseInputRows([
    ["ID rodziny", "Uczeń", "Klasa", "Wpłaty netto EUR"],
    ["", "Ala Testowa", "3a", ""],
    ["H 1", "Ola Testowa", "3a", ""],
    ["H-2", "", "3a", "abc"],
    ["H-3", "Ewa Testowa", "2a", "10"],
    ["H-3", "Iza Testowa", "4a", "20"],
  ]);
  assert.equal(parsed.errors.filter((e) => e.row === 2).length, 1);
  assert.ok(parsed.errors.some((e) => e.row === 3));
  assert.ok(parsed.errors.some((e) => e.row === 4));
  assert.equal(buildHouseholds(parsed.rows).errors.length, 1);
  assert.throws(() => parseInputText("{", "a.json"), /JSON/);
  assert.throws(() => parseInputText("x", "a.xlsx"), /\.csv/);
  assert.throws(() => parseInputRows([["Klasa"], ["3a"]]), /ID rodziny/);
  const { errors } = normalizeConfig({ councilName: "", schoolYear: "2026", contact: "" });
  assert.equal(errors.length, 3);
});

test("JSON z polami rows i kwotą w centach", () => {
  const parsed = parseInputText(JSON.stringify({ rows: [
    { householdId: "H-1", firstName: "Ala", lastName: "Testowa", className: "3a", recordedNetCents: 0 },
  ] }), "dane.json");
  assert.deepEqual(parsed.errors, []);
  assert.equal(buildHouseholds(parsed.rows).households[0].paymentEntry, "none");
});

test("#173: kolumna centów odrzuca 1e3, 0x10 i 25.0 (bez separatorów)", () => {
  for (const value of ["1e3", "0x10", "25.0", "-5", "12,50"]) {
    const parsed = parseInputText(JSON.stringify({ rows: [
      { householdId: "H-1", firstName: "Ala", lastName: "Testowa", className: "3a", recordedNetCents: value },
    ] }), "dane.json");
    assert.equal(parsed.errors.length, 1, `wartość: ${value}`);
    assert.match(parsed.errors[0].message, /centach/);
  }
  const ok = parseInputText(JSON.stringify({ rows: [
    { householdId: "H-1", firstName: "Ala", lastName: "Testowa", className: "3a", recordedNetCents: "2500" },
  ] }), "dane.json");
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.rows[0].recordedNetCents, 2500);
});

// --- #92: dane do wpłaty i kod QR EPC wyłącznie z zatwierdzonej konfiguracji ---

const PAYMENT_INSTRUCTIONS = { iban: "BE68539007547034", bic: "GKCCBEBB", payeeName: "Rada Rodziców Szkoły" };

test("brak zatwierdzonej konfiguracji: kartka bez kodu QR, dane do wpłaty tylko z formularza (szkic)", () => {
  const list = households();
  const withoutServer = renderCardsHtml(list, ["H-1"], CONFIG);
  assert.doesNotMatch(withoutServer.html, /card-qr/);

  const card = buildCard(list.find((h) => h.householdId === "H-1"), normalizeConfig(CONFIG).config, null);
  assert.equal(card.paymentApproved, false);
  assert.equal(card.epcSvg, null);
});

test("zatwierdzona konfiguracja zastępuje ręcznie wpisany rachunek i generuje kod QR", () => {
  const list = households();
  const config = { ...CONFIG, bankAccount: "BE00 0000 0000 0000", bankRecipient: "Ktoś inny", referenceTemplate: "RR {rok} {rodzina}" };
  const result = renderCardsHtml(list, ["H-1"], config, PAYMENT_INSTRUCTIONS);
  assert.match(result.html, /card-qr-svg/);
  assert.match(result.html, /BE68539007547034/);
  assert.match(result.html, /Rada Rodziców Szkoły/);
  assert.doesNotMatch(result.html, /BE00 0000 0000 0000/);
  assert.doesNotMatch(result.html, /Ktoś inny/);
});

test("kod QR: rodzeństwo w jednej rodzinie ma jedną kartkę i jeden kod QR z tą samą konfiguracją", () => {
  const list = households();
  const household = list.find((h) => h.householdId === "H-1");
  assert.ok(household.students.length >= 2, "test zakłada rodzeństwo w H-1");
  const result = renderCardsHtml(list, ["H-1"], CONFIG, PAYMENT_INSTRUCTIONS);
  assert.equal((result.html.match(/card-qr-svg/g) ?? []).length, 1);
});

test("zbyt długi tytuł przelewu nie przerywa druku — kartka zostaje bez kodu QR", () => {
  const list = households();
  const config = { ...CONFIG, referenceTemplate: "R".repeat(200) };
  const result = renderCardsHtml(list, ["H-1"], config, PAYMENT_INSTRUCTIONS);
  assert.doesNotMatch(result.html, /card-qr-svg/);
  assert.match(result.html, /R{100,}/); // tekst tytułu zostaje czytelny mimo braku QR
});

test("podpis przy kodzie QR nie sugeruje zadłużenia", () => {
  const list = households();
  const result = renderCardsHtml(list, ["H-1"], CONFIG, PAYMENT_INSTRUCTIONS);
  const caption = result.html.match(/<p class="card-qr-caption">([^<]*)<\/p>/)[1];
  assert.equal(findForbiddenWording(caption), null);
});
