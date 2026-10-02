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
  parseStructuredReferenceCell,
  paymentVersionLabel,
  selectHouseholds,
  skippedRestrictedMessage,
  structuredReferenceNotice,
} from "../print/core.js";
import { formatStructuredReference, generateStructuredReference, isValidStructuredReference } from "../src/pg/ogm.js";

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

// --- #83: komunikacja strukturalna OGM-VCS zamiast identyfikatora rodziny ---

function brokenChecksum(reference) {
  const check = Number(reference.slice(10));
  return reference.slice(0, 10) + String((check % 97) + 1).padStart(2, "0");
}

test("komunikacja strukturalna w wierszu: 12 cyfr albo +++…+++; zła suma mod 97 to błąd wiersza", () => {
  const reference = generateStructuredReference();
  const formatted = formatStructuredReference(reference);
  assert.deepEqual(parseStructuredReferenceCell(reference), { reference });
  assert.deepEqual(parseStructuredReferenceCell(` ${formatted} `), { reference });
  assert.deepEqual(parseStructuredReferenceCell(formatted.replaceAll("+++", "***")), { reference });
  assert.deepEqual(parseStructuredReferenceCell(""), { reference: null });
  const broken = brokenChecksum(reference);
  assert.equal(isValidStructuredReference(broken), false);
  assert.match(parseStructuredReferenceCell(broken).error, /mod 97/);
  assert.match(parseStructuredReferenceCell(`Składka ${formatted}`).error, /komunikacja/);

  const parsed = parseInputRows({ rows: [
    { householdId: "H-1", firstName: "Ala", lastName: "Testowa", className: "3a", structuredReference: reference },
    { householdId: "H-2", firstName: "Ewa", lastName: "Przykładowa", className: "3a", structuredReference: broken },
    { householdId: "H-3", firstName: "Jan", lastName: "Fikcyjny", className: "1c", structuredReference: null },
  ] });
  assert.deepEqual(parsed.rows.map((row) => [row.householdId, row.structuredReference]), [["H-1", reference], ["H-3", null]]);
  assert.deepEqual(parsed.errors.map((error) => error.row), [2]);
});

test("rodzeństwo ma jedną referencję; różne referencje jednej rodziny to błąd danych", () => {
  const reference = generateStructuredReference();
  let other = generateStructuredReference();
  while (other === reference) other = generateStructuredReference();
  const rows = (second) => parseInputRows({ rows: [
    { householdId: "H-1", firstName: "Ala", lastName: "Testowa", className: "3a", structuredReference: reference },
    { householdId: "H-1", firstName: "Olek", lastName: "Testowy", className: "5b", structuredReference: second },
  ] }).rows;
  const same = buildHouseholds(rows(reference));
  assert.deepEqual(same.errors, []);
  assert.equal(same.households.length, 1);
  assert.equal(same.households[0].structuredReference, reference);
  const conflict = buildHouseholds(rows(other));
  assert.equal(conflict.errors.length, 1);
  assert.match(conflict.errors[0].message, /różną komunikację strukturalną/);
  const missing = buildHouseholds(rows(null));
  assert.equal(missing.errors.length, 1);
});

test("kartka z referencją: komunikacja +++…+++ zamiast tytułu z identyfikatorem, kod QR z polem strukturalnym", () => {
  const reference = generateStructuredReference();
  const formatted = formatStructuredReference(reference);
  const list = [
    { householdId: "H-1", students: [{ name: "Ala Testowa", className: "3a" }, { name: "Olek Testowy", className: "5b" }], structuredReference: reference, paymentEntry: "unknown" },
    { householdId: "H-2", students: [{ name: "Ewa Przykładowa", className: "3a" }], structuredReference: null, paymentEntry: "unknown" },
  ];
  const config = normalizeConfig({ ...CONFIG, bankAccount: "BE68 5390 0754 7034", referenceTemplate: "Składka {rok} {rodzina}" }).config;
  const withRef = buildCard(list[0], config, PAYMENT_INSTRUCTIONS);
  assert.deepEqual(withRef.payment.find(([label]) => label === "Komunikacja strukturalna"), ["Komunikacja strukturalna", formatted]);
  assert.equal(withRef.payment.some(([label]) => label === "Tytuł przelewu"), false);
  assert.ok(withRef.epcSvg, "kod QR powstaje (referencja w polu strukturalnym, bez tytułu wolnego)");
  const withoutRef = buildCard(list[1], config, PAYMENT_INSTRUCTIONS);
  assert.deepEqual(withoutRef.payment.find(([label]) => label === "Tytuł przelewu"), ["Tytuł przelewu", "Składka 2026/2027 H-2"]);
  // Bez rachunku kartka nie ma danych do wpłaty — ani tytułu, ani komunikacji.
  const noAccount = buildCard(list[0], normalizeConfig(CONFIG).config, null);
  assert.deepEqual(noAccount.payment, []);

  const html = renderCardsHtml(list, ["H-1", "H-2"], { ...CONFIG, bankAccount: "BE68 5390 0754 7034", referenceTemplate: "Składka {rok} {rodzina}" }, PAYMENT_INSTRUCTIONS);
  assert.equal(html.count, 2, "jedna kartka na rodzinę");
  assert.ok(html.html.includes(formatted));
  assert.doesNotMatch(html.html, DEBT_WORDS);
});

test("informacja pod podglądem: ile kartek ma komunikację, ostrzeżenie przy {rodzina}", () => {
  const reference = generateStructuredReference();
  const list = [
    { householdId: "H-1", students: [], structuredReference: reference },
    { householdId: "H-2", students: [], structuredReference: null },
  ];
  const config = { bankAccount: "BE68 5390 0754 7034", referenceTemplate: "Składka {rok} {rodzina}" };
  assert.match(structuredReferenceNotice(list, ["H-1"], config), /Każda wybrana kartka/);
  assert.match(structuredReferenceNotice(list, ["H-1", "H-2"], config), /^1 z 2 .*łatwo przepisać z błędem/);
  assert.match(structuredReferenceNotice(list, ["H-2"], { ...config, referenceTemplate: "Składka {rok}" }), /tytuł z szablonu\.$/);
  assert.equal(structuredReferenceNotice(list, ["H-1"], { bankAccount: "" }), "");
  assert.equal(structuredReferenceNotice(list, [], config), "");
  assert.doesNotMatch(structuredReferenceNotice(list, ["H-1", "H-2"], config), DEBT_WORDS);
});

// #92: wersja danych do wpłaty w stopce kartki (korekta rachunku w trakcie roku).
test("stopka kartki: wersja zatwierdzonych danych do wpłaty; dane ręczne oznaczone jako niezatwierdzone", () => {
  const list = households();
  const v1 = { ...PAYMENT_INSTRUCTIONS, id: "11111111-aaaa-bbbb-cccc-000000000001", approvedAt: "2026-09-01T08:00:00.000Z" };
  const v2 = { ...PAYMENT_INSTRUCTIONS, iban: "BE71096123456769", id: "22222222-aaaa-bbbb-cccc-000000000002", approvedAt: "2026-11-15T09:30:00.000Z" };
  assert.equal(paymentVersionLabel(v1), "Dane do wpłaty: wersja zatwierdzona 01.09.2026 10:00, nr 11111111.");
  const first = renderCardsHtml(list, ["H-1"], CONFIG, v1);
  const second = renderCardsHtml(list, ["H-1"], CONFIG, v2);
  assert.match(first.html, /<p class="card-ref card-payment-version">Dane do wpłaty: wersja zatwierdzona 01\.09\.2026 10:00, nr 11111111\.<\/p>/);
  assert.match(second.html, /wersja zatwierdzona 15\.11\.2026 10:30, nr 22222222\./);
  assert.notEqual(first.html, second.html);
  // Pełny identyfikator wersji nie jest drukowany (wystarcza skrót do rozróżnienia).
  assert.doesNotMatch(first.html, /aaaa-bbbb/);

  // Rachunek wpisany ręcznie (bez zatwierdzonej wersji): wprost oznaczony, bez QR.
  const manual = renderCardsHtml(list, ["H-1"], { ...CONFIG, bankAccount: "BE68 5390 0754 7034" });
  assert.match(manual.html, /Dane do wpłaty wpisane ręcznie, niezatwierdzone na rok — kartka bez kodu QR\./);
  assert.doesNotMatch(manual.html, /card-qr-svg/);
  // Bez rachunku kartka nie ma stopki wersji.
  const none = renderCardsHtml(list, ["H-1"], CONFIG);
  assert.doesNotMatch(none.html, /card-payment-version/);
  // Wersja bez identyfikatora i daty (starsze klienty) — etykieta bez pustych pól.
  assert.equal(paymentVersionLabel(PAYMENT_INSTRUCTIONS), "Dane do wpłaty: wersja zatwierdzona.");
  for (const html of [first.html, second.html, manual.html]) assert.doesNotMatch(html, DEBT_WORDS);
});

test("komunikat o pominiętych rodzinach (D-07): tylko liczba, tylko gdy N>0, polska odmiana", () => {
  for (const empty of [0, -1, null, undefined, "x", 1.5, Number.NaN]) assert.equal(skippedRestrictedMessage(empty), "");
  const expected = new Map([
    [1, "Pominięto 1 rodzinę z ograniczeniem przetwarzania (RODO)."],
    [2, "Pominięto 2 rodziny z ograniczeniem przetwarzania (RODO)."],
    [5, "Pominięto 5 rodzin z ograniczeniem przetwarzania (RODO)."],
    [12, "Pominięto 12 rodzin z ograniczeniem przetwarzania (RODO)."],
    [22, "Pominięto 22 rodziny z ograniczeniem przetwarzania (RODO)."],
  ]);
  assert.ok(expected.size > 0);
  for (const [count, text] of expected) assert.equal(skippedRestrictedMessage(count), text);
});
