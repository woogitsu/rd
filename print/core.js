// Czyste funkcje modułu wydruku kartek o dobrowolnej składce (#11).
// Brak dostępu do DOM i sieci — wszystko testowane w tests/print-core.test.js.
import { parseCsv } from "../import/core.js";
import { decodeCsvBytes, detectDelimiter } from "../import/csv.js";
import { formatCents, isValidId, parseEuroAmount } from "../panel/core.js";
import { MoneyError, parseCentsCell } from "../panel/money.js";
import { buildEpcPayload } from "./epc.js";
import { qrSvgMarkup } from "./qr.js";

export const MAX_ROWS = 5000;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const LAYOUTS = Object.freeze({
  a4: "Jedna kartka na stronę A4",
  a5x2: "Dwie kartki na stronę A4 z linią cięcia",
});

// Słowa, których kartka lub wiadomość nie może zawierać: składka jest
// dobrowolna (AGENTS.md). „dług” tylko w formach rzeczownika, aby nie odrzucać
// nazwisk (Długosz) ani ulic (Długa).
const FORBIDDEN_PL = "zaległ\\p{L}*|dług(?:u|iem|owi|i|ów|ami|ach|om)?|dłużn\\p{L}*|zadłuż\\p{L}*|windyk\\p{L}*|należnoś\\p{L}*|monit(?:u|y|ów)?|wezwani\\p{L}*";
// Szkoła działa w Belgii (#120): treść kampanii/kartki nie ma jeszcze pola
// języka (jedna wersja tekstu — pełne wersje FR/NL to osobna funkcja,
// wymagająca migracji), więc sprawdzamy też francuskie i niderlandzkie
// sformułowania sugerujące zadłużenie, niezależnie od tego, w jakim języku
// napisano treść. Przykłady z issue: „votre dette”, „achterstallige
// bijdrage” odrzucone; „cotisation volontaire”, „vrijwillige bijdrage” dozwolone.
const FORBIDDEN_FR = "dette\\p{L}*|créanc\\p{L}*|débit(?:eur|rice)\\p{L}*|mise en demeure";
const FORBIDDEN_NL = "schuld\\p{L}*|achterstand\\p{L}*|achterstallig\\p{L}*|aanmaning\\p{L}*|wanbetal\\p{L}*";
const FORBIDDEN_PATTERN = new RegExp(
  `(^|[^\\p{L}])(${FORBIDDEN_PL}|${FORBIDDEN_FR}|${FORBIDDEN_NL})(?![\\p{L}])`, "iu",
);

export function findForbiddenWording(text) {
  const match = FORBIDDEN_PATTERN.exec(String(text ?? ""));
  return match ? match[2] : null;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"'`]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
    "`": "&#96;",
  })[char]);
}

const clean = (value) => String(value ?? "").trim().replace(/\s+/g, " ");
const normalizeHeader = (value) => clean(value).toLocaleLowerCase("pl-PL");

const HEADER_ALIASES = {
  householdId: ["id rodziny", "identyfikator rodziny", "household_id", "householdid"],
  firstName: ["imię ucznia", "imie ucznia", "imię", "imie", "first_name", "firstname"],
  lastName: ["nazwisko ucznia", "nazwisko", "last_name", "lastname"],
  studentName: ["uczeń", "uczen", "imię i nazwisko ucznia", "student_name", "studentname"],
  className: ["klasa", "oddział", "oddzial", "class", "class_name", "classname"],
  recordedNet: ["wpłaty netto eur", "wplaty netto eur", "wpłaty netto", "recorded_net_eur"],
  recordedNetCents: ["recorded_net_cents", "recordednetcents"],
};

function parseRecordedNet(raw, unit) {
  const value = clean(raw);
  if (value === "") return { cents: null };
  if (unit === "cents") {
    // #173: tylko cyfry ASCII bez separatora — "1e3", "0x10", "25.0" to błąd wiersza.
    try {
      return { cents: parseCentsCell(value) };
    } catch (error) {
      if (error instanceof MoneyError) return { error: "Niepoprawna kwota wpłat w centach." };
      throw error;
    }
  }
  if (/^0+(?:[.,]0{1,2})?$/.test(value)) return { cents: 0 };
  try {
    return { cents: parseEuroAmount(value) };
  } catch {
    return { error: "Niepoprawna kwota wpłat netto (EUR)." };
  }
}

function rowFromValues(get, number) {
  const issues = [];
  const householdId = clean(get("householdId"));
  let name = clean(get("studentName"));
  if (!name) name = clean(`${clean(get("firstName"))} ${clean(get("lastName"))}`);
  const className = clean(get("className"));
  if (!isValidId(householdId)) issues.push("Brak lub niepoprawny identyfikator rodziny.");
  if (!name) issues.push("Brak imienia i nazwiska ucznia.");
  if (!className) issues.push("Brak klasy.");
  if (name.length > 160 || className.length > 40) issues.push("Za długa wartość.");

  let recordedNetCents;
  const centsRaw = get("recordedNetCents");
  const euroRaw = get("recordedNet");
  if (centsRaw !== undefined) {
    const parsed = parseRecordedNet(centsRaw, "cents");
    if (parsed.error) issues.push(parsed.error); else recordedNetCents = parsed.cents;
  } else if (euroRaw !== undefined) {
    const parsed = parseRecordedNet(euroRaw, "eur");
    if (parsed.error) issues.push(parsed.error); else recordedNetCents = parsed.cents;
  }

  return { row: number, householdId, name, className, recordedNetCents, issues };
}

// Wejście: macierz CSV (pierwszy wiersz to nagłówek) albo tablica obiektów z JSON.
export function parseInputRows(input) {
  const rows = [];
  if (Array.isArray(input) && input.every((row) => Array.isArray(row))) {
    if (input.length < 2) throw new Error("Plik musi zawierać nagłówek i co najmniej jeden wiersz danych.");
    const headers = input[0].map(normalizeHeader);
    const index = {};
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
      const found = headers.findIndex((header) => aliases.includes(header));
      if (found >= 0) index[key] = found;
    }
    if (index.householdId === undefined) throw new Error("Brak kolumny „ID rodziny”.");
    if (index.className === undefined) throw new Error("Brak kolumny „Klasa”.");
    if (index.studentName === undefined && (index.firstName === undefined || index.lastName === undefined)) {
      throw new Error("Brak kolumn z imieniem i nazwiskiem ucznia.");
    }
    for (let i = 1; i < input.length; i++) {
      const values = input[i];
      const get = (key) => (index[key] === undefined ? undefined : String(values[index[key]] ?? ""));
      rows.push(rowFromValues(get, i + 1));
    }
  } else {
    const list = Array.isArray(input) ? input : input?.rows;
    if (!Array.isArray(list)) throw new Error("JSON musi być tablicą wierszy albo obiektem z polem „rows”.");
    list.forEach((item, i) => {
      const source = item && typeof item === "object" ? item : {};
      const get = (key) => (Object.hasOwn(source, key) && source[key] !== null ? String(source[key]) : undefined);
      rows.push(rowFromValues(get, i + 1));
    });
  }
  if (rows.length > MAX_ROWS) throw new Error(`Limit wynosi ${MAX_ROWS} wierszy danych.`);
  if (!rows.length) throw new Error("Brak wierszy uczniów.");
  const errors = rows.flatMap((row) => row.issues.map((message) => ({ row: row.row, message })));
  return { rows: rows.filter((row) => !row.issues.length), errors };
}

export function parseInputText(text, fileName) {
  if (typeof text !== "string" || !text.trim()) throw new Error("Plik jest pusty.");
  if (/\.json$/i.test(fileName)) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Plik JSON jest niepoprawny.");
    }
    return parseInputRows(data);
  }
  if (/\.csv$/i.test(fileName)) return parseInputRows(parseCsv(text));
  throw new Error("Wybierz plik .csv lub .json.");
}

// Odczyt bajtów pliku (#77): CSV z wykryciem kodowania (UTF-8/BOM, UTF-16 z BOM, Windows-1250)
// albo z kodowaniem wybranym ręcznie; JSON wyłącznie w UTF-8. Nierozpoznane bajty = błąd, brak wierszy.
// Zwraca wynik parseInputText oraz source: { encoding, label, bom, warnings, delimiter }.
export function parseInputBytes(bytes, fileName, options = {}) {
  const isCsv = /\.csv$/i.test(fileName);
  if (!isCsv && !/\.json$/i.test(fileName)) throw new Error("Wybierz plik .csv lub .json.");
  const decoded = decodeCsvBytes(bytes, { encoding: isCsv ? options.encoding ?? "auto" : "utf-8" });
  const parsed = parseInputText(decoded.text, fileName);
  const { text, ...source } = decoded;
  if (isCsv) source.delimiter = detectDelimiter(text);
  return { ...parsed, source };
}

// Grupowanie: jedna pozycja na rodzinę; każda rodzina zawiera wyłącznie uczniów
// ze swoich wierszy (rodzeństwo razem, uczeń przypisany do dwóch rodzin trafia do obu).
export function buildHouseholds(rows) {
  const map = new Map();
  const errors = [];
  for (const row of rows) {
    let household = map.get(row.householdId);
    if (!household) {
      household = { householdId: row.householdId, students: [], recordedNetCents: undefined, _keys: new Set() };
      map.set(row.householdId, household);
    }
    const key = `${row.name.toLocaleLowerCase("pl-PL")}|${row.className.toLocaleLowerCase("pl-PL")}`;
    if (!household._keys.has(key)) {
      household._keys.add(key);
      household.students.push({ name: row.name, className: row.className });
    }
    if (row.recordedNetCents !== undefined) {
      if (household.recordedNetCents === undefined) household.recordedNetCents = row.recordedNetCents;
      else if (household.recordedNetCents !== row.recordedNetCents) {
        errors.push({ row: row.row, message: `Rodzina ${row.householdId} ma różne kwoty wpłat w kolejnych wierszach.` });
      }
    }
  }
  const households = [...map.values()].map(({ _keys, ...household }) => ({
    ...household,
    students: household.students.sort((a, b) => a.className.localeCompare(b.className, "pl") || a.name.localeCompare(b.name, "pl")),
    paymentEntry: paymentEntryStatus(household.recordedNetCents),
  }));
  households.sort((a, b) => {
    const ac = a.students[0]?.className ?? "";
    const bc = b.students[0]?.className ?? "";
    return ac.localeCompare(bc, "pl") || a.householdId.localeCompare(b.householdId, "pl");
  });
  return { households, errors };
}

// Informacja pomocnicza dla operatora — nie jest statusem rodziny i nie trafia na kartkę.
export function paymentEntryStatus(recordedNetCents) {
  if (recordedNetCents === undefined || recordedNetCents === null) return "unknown";
  return recordedNetCents > 0 ? "recorded" : "none";
}

export const PAYMENT_ENTRY_LABELS = Object.freeze({
  recorded: "jest wpis wpłaty",
  none: "brak wpisu wpłaty",
  unknown: "nie podano",
});

export function filterHouseholds(households, { className = "", hideRecorded = false } = {}) {
  return households.filter((household) => {
    if (className && !household.students.some((student) => student.className === className)) return false;
    if (hideRecorded && household.paymentEntry === "recorded") return false;
    return true;
  });
}

export function classNames(households) {
  return [...new Set(households.flatMap((household) => household.students.map((student) => student.className)))]
    .sort((a, b) => a.localeCompare(b, "pl"));
}

// Tylko jawnie wybrane rodziny, w kolejności listy. Brak wyboru = brak kartek.
export function selectHouseholds(households, selectedIds) {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds ?? []);
  return households.filter((household) => selected.has(household.householdId));
}

// Identyfikator roku z API ("2026-2027") na format treści kartki ("2026/2027").
// Inny kształt identyfikatora zwraca pusty tekst — pole zostaje do ręcznego uzupełnienia.
export function schoolYearCardLabel(schoolYearId) {
  const match = /^(\d{4})-(\d{4})$/.exec(String(schoolYearId ?? "").trim());
  return match ? `${match[1]}/${match[2]}` : "";
}

export function normalizeConfig(raw = {}) {
  const config = {
    councilName: clean(raw.councilName),
    schoolName: clean(raw.schoolName),
    schoolYear: clean(raw.schoolYear),
    contact: clean(raw.contact),
    suggestedAmountCents: null,
    bankAccount: clean(raw.bankAccount).replace(/\s+/g, " "),
    bankRecipient: clean(raw.bankRecipient),
    referenceTemplate: clean(raw.referenceTemplate),
    templateApproved: raw.templateApproved === true,
    layout: Object.hasOwn(LAYOUTS, raw.layout) ? raw.layout : "a4",
  };
  const errors = [];
  if (!config.councilName) errors.push("Podaj nazwę Rady Rodziców.");
  if (!/^\d{4}\/\d{4}$/.test(config.schoolYear)) errors.push("Podaj rok szkolny w formacie 2026/2027.");
  if (!config.contact) errors.push("Podaj kontakt do Rady.");
  const amount = clean(raw.suggestedAmount);
  if (amount) {
    try {
      config.suggestedAmountCents = parseEuroAmount(amount);
    } catch (error) {
      errors.push(`Sugerowana kwota: ${error.message}`);
    }
  }
  if (config.bankAccount && !/^[A-Z]{2}\d{2}[A-Z0-9 ]{8,40}$/.test(config.bankAccount.toUpperCase())) {
    errors.push("Numer rachunku powinien mieć format IBAN, np. BE00 0000 0000 0000.");
  }
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string" && value.length > 300) errors.push(`Za długa wartość pola ${key}.`);
    if (typeof value === "string" && findForbiddenWording(value)) {
      errors.push(`Pole ${key} zawiera słowo sugerujące zadłużenie. Składka jest dobrowolna.`);
    }
  }
  return { config, errors };
}

export function paymentReference(config, household) {
  if (!config.referenceTemplate) return "";
  return config.referenceTemplate
    .replaceAll("{rodzina}", household.householdId)
    .replaceAll("{rok}", config.schoolYear);
}

// Model kartki: wyłącznie dane jednej rodziny i zatwierdzone parametry konfiguracji.
// `paymentInstructions` (opcjonalnie): { iban, bic, payeeName } — zatwierdzona
// na rok konfiguracja z GET /api/print/cards (#92). Gdy podana, ZASTĘPUJE ręcznie
// wpisane pola rachunku/odbiorcy (formularz tylko je pokazuje) i uruchamia
// generator kodu QR EPC. Bez niej kartka nie ma kodu QR (jest szkicem danych
// do wpłaty) — QR powstaje wyłącznie z zatwierdzonej wersji.
export function buildCard(household, config, paymentInstructions = null) {
  const paragraphs = [
    "Składka na Radę Rodziców jest dobrowolna. Decyzja o wpłacie i jej wysokości należy do rodziny.",
  ];
  if (Number.isSafeInteger(config.suggestedAmountCents)) {
    paragraphs.push(`Sugerowana kwota składki w roku szkolnym ${config.schoolYear}: ${formatCents(config.suggestedAmountCents)}.`);
  }
  const approved = paymentInstructions
    ? {
      iban: clean(paymentInstructions.iban),
      bic: clean(paymentInstructions.bic ?? ""),
      payeeName: clean(paymentInstructions.payeeName),
    }
    : null;
  const bankAccount = approved ? approved.iban : config.bankAccount;
  const bankRecipient = approved ? approved.payeeName : config.bankRecipient;
  const payment = [];
  if (bankAccount) payment.push(["Rachunek", bankAccount]);
  if (bankAccount && bankRecipient) payment.push(["Odbiorca", bankRecipient]);
  const reference = bankAccount ? paymentReference(config, household) : "";
  if (reference) payment.push(["Tytuł przelewu", reference]);
  const closing = "Jeśli wpłata została już wykonana, prosimy pominąć tę informację. Dziękujemy.";

  // Kod QR wyłącznie z zatwierdzonych danych. Błąd generatora (np. zbyt długi
  // tytuł przelewu) nie przerywa druku kartki — zostaje czytelny tekst obok.
  let epcSvg = null;
  if (approved) {
    try {
      const payload = buildEpcPayload({
        iban: approved.iban, bic: approved.bic, name: approved.payeeName, unstructuredText: reference,
      });
      epcSvg = qrSvgMarkup(payload, { title: "Kod QR do przelewu (EPC)" });
    } catch {
      epcSvg = null;
    }
  }

  const card = {
    householdId: household.householdId,
    draft: !config.templateApproved,
    paymentApproved: Boolean(approved),
    councilName: config.councilName,
    schoolName: config.schoolName,
    schoolYear: config.schoolYear,
    title: "Informacja o dobrowolnej składce",
    students: household.students.map((student) => ({ name: student.name, className: student.className })),
    paragraphs,
    payment,
    epcSvg,
    closing,
    contact: config.contact,
  };
  const forbidden = findForbiddenWording(cardText(card));
  if (forbidden) throw new Error(`Kartka zawiera niedozwolone sformułowanie („${forbidden}”).`);
  return card;
}

// Tekst kartki bez imion uczniów (nazwiska nie podlegają kontroli słownictwa).
export function cardText(card) {
  return [
    card.councilName, card.schoolName, card.schoolYear, card.title,
    ...card.paragraphs, ...card.payment.flat(), card.closing, card.contact,
  ].join("\n");
}

export function renderCardHtml(card) {
  const e = escapeHtml;
  const students = card.students
    .map((student) => `<li>${e(student.name)}, klasa ${e(student.className)}</li>`)
    .join("");
  const payment = card.payment.length
    ? `<dl class="card-payment">${card.payment.map(([label, value]) => `<dt>${e(label)}</dt><dd>${e(value)}</dd>`).join("")}</dl>`
    : "";
  // Kod QR obok pełnego tekstu IBAN/tytułu (dostępność, wydruk czarno-biały);
  // podpis nie sugeruje zadłużenia (składka jest dobrowolna, AGENTS.md).
  const qr = card.epcSvg
    ? `<div class="card-qr">${card.epcSvg}<p class="card-qr-caption">Kod QR do przelewu (opcjonalnie) — kwotę i tytuł można zmienić w aplikacji bankowej.</p></div>`
    : "";
  return [
    `<article class="print-card" data-household="${e(card.householdId)}">`,
    card.draft ? `<p class="card-draft">WZÓR — treść niezatwierdzona przez Radę (D-16)</p>` : "",
    `<header class="card-header"><p class="card-council">${e(card.councilName)}</p>`,
    card.schoolName ? `<p class="card-school">${e(card.schoolName)}</p>` : "",
    `<p class="card-year">Rok szkolny ${e(card.schoolYear)}</p></header>`,
    `<h3 class="card-title">${e(card.title)}</h3>`,
    `<p class="card-to">Dla rodziców i opiekunów:</p><ul class="card-students">${students}</ul>`,
    card.paragraphs.map((text) => `<p>${e(text)}</p>`).join(""),
    payment,
    qr,
    `<p>${e(card.closing)}</p>`,
    `<p class="card-contact">Kontakt: ${e(card.contact)}</p>`,
    `<p class="card-ref">Nr rodziny: ${e(card.householdId)}</p>`,
    `</article>`,
  ].join("");
}

export function renderCardsHtml(households, selectedIds, rawConfig, paymentInstructions = null) {
  const { config, errors } = normalizeConfig(rawConfig);
  if (errors.length) throw new Error(errors.join(" "));
  const chosen = selectHouseholds(households, selectedIds);
  const cards = chosen.map((household) => buildCard(household, config, paymentInstructions));
  return {
    count: cards.length,
    layout: config.layout,
    html: cards.map(renderCardHtml).join(""),
  };
}
