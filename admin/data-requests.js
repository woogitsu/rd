// Czyste funkcje ekranu „Żądania osób (RODO)” (#100; trasy src/pg/routes/admin.js,
// docs/DATA_REQUESTS.md). Bez DOM i sieci — testy: tests/admin-data-requests.test.js.
// Serwer powtarza całą walidację i egzekwuje role oraz krok w górę MFA; tu tylko
// czytelne komunikaty i podpowiedzi dla przycisków. Eksport zawiera dane osobowe:
// nic stąd nie trafia do logów ani konsoli, a treść paczki nie jest przechowywana.

import { isValidId } from "./core.js";

export const KIND_LABELS = Object.freeze({
  access: "Dostęp do danych (art. 15)",
  rectification: "Sprostowanie (art. 16)",
  erasure: "Usunięcie (art. 17)",
  restriction: "Ograniczenie przetwarzania (art. 18)",
  objection: "Sprzeciw (art. 21)",
  portability: "Przenoszenie danych (art. 20)",
});

export const STATUS_LABELS = Object.freeze({
  received: "Przyjęte",
  identity_verified: "Tożsamość potwierdzona",
  in_progress: "W toku",
  answered: "Udzielono odpowiedzi",
  rejected: "Odrzucone",
});

// „Ranga” jak w serwerze: stanu nie da się cofnąć, zamknięte są końcowe.
const STATUS_RANK = Object.freeze({ received: 0, identity_verified: 1, in_progress: 2, answered: 3, rejected: 3 });
const CLOSED = new Set(["answered", "rejected"]);
const EXPORTABLE_KINDS = new Set(["access", "portability"]);
const EXPORTABLE_STATUSES = new Set(["identity_verified", "in_progress"]);

export const SUBJECT_LABELS = Object.freeze({
  household: "Gospodarstwo",
  guardian: "Opiekun",
  student: "Uczeń",
});

export const FILTER_STATUS_OPTIONS = Object.freeze([["", "Wszystkie stany"], ...Object.entries(STATUS_LABELS)]);
export const FILTER_KIND_OPTIONS = Object.freeze([["", "Wszystkie rodzaje"], ...Object.entries(KIND_LABELS)]);

export function dataRequestsPath({ status = "", kind = "", cursor = "" } = {}) {
  const params = new URLSearchParams();
  if (status) {
    if (!Object.hasOwn(STATUS_LABELS, status)) throw new Error("Nieznany stan żądania.");
    params.set("status", status);
  }
  if (kind) {
    if (!Object.hasOwn(KIND_LABELS, kind)) throw new Error("Nieznany rodzaj żądania.");
    params.set("kind", kind);
  }
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return `/api/admin/data-requests${query ? `?${query}` : ""}`;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(value) {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Treść POST /api/admin/data-requests. Jeden podmiot: gospodarstwo, opiekun albo uczeń
// (identyfikator skopiowany z panelu Rodziny). Bez treści żądania i danych kontaktowych.
export function createBody({ kind, subjectType, subjectId, receivedOn, dueOn } = {}) {
  if (!Object.hasOwn(KIND_LABELS, kind)) throw new Error("Wybierz rodzaj żądania.");
  if (!Object.hasOwn(SUBJECT_LABELS, subjectType)) throw new Error("Wybierz, czego dotyczy żądanie.");
  const id = String(subjectId ?? "").trim();
  if (!id) throw new Error("Podaj identyfikator gospodarstwa, opiekuna albo ucznia.");
  if (!isValidId(id)) throw new Error("Niepoprawny identyfikator. Skopiuj go z panelu Rodziny.");
  if (!validDate(receivedOn)) throw new Error("Podaj poprawną datę wpłynięcia żądania.");
  const due = String(dueOn ?? "").trim();
  if (due && !validDate(due)) throw new Error("Podaj poprawną datę terminu odpowiedzi.");
  if (due && due < receivedOn) throw new Error("Termin odpowiedzi nie może być wcześniejszy niż data wpłynięcia.");
  return {
    kind, receivedOn, ...(due ? { dueOn: due } : {}),
    [`${subjectType}Id`]: id,
  };
}

// Klucz rejestracji: jeden na wypełnienie formularza; ponowienie po błędzie sieci
// wysyła ten sam klucz, nowe wypełnienie dostaje nowy.
export function newRequestKey(random = () => globalThis.crypto.randomUUID()) {
  return `dsr-${random()}`;
}

// Podmiot żądania do tabeli: rodzaj i identyfikator (bez imion).
export function subjectOf(request) {
  if (request?.householdId) return { type: "household", id: request.householdId };
  if (request?.guardianId) return { type: "guardian", id: request.guardianId };
  if (request?.studentId) return { type: "student", id: request.studentId };
  return { type: null, id: null };
}

export function isClosed(request) {
  return CLOSED.has(request?.status);
}

// Stany, do których można przejść (tylko do przodu; zamknięte nie mają przejść).
// Serwer jest jedynym źródłem reguły — to podpowiedź dla listy wyboru.
export function nextStatuses(request) {
  const current = request?.status;
  if (!Object.hasOwn(STATUS_RANK, current) || CLOSED.has(current)) return [];
  return Object.keys(STATUS_LABELS).filter((status) => status !== current && STATUS_RANK[status] > STATUS_RANK[current]);
}

export function statusBody(status, decisionNoteRef = "") {
  if (!Object.hasOwn(STATUS_LABELS, status)) throw new Error("Wybierz nowy stan żądania.");
  const ref = String(decisionNoteRef ?? "").trim();
  if (ref.length > 200) throw new Error("Odwołanie do decyzji może mieć najwyżej 200 znaków.");
  if (CLOSED.has(status) && !ref) throw new Error("Zamknięcie żądania wymaga odwołania do dokumentu odpowiedzi (np. numeru w teczce).");
  return { status, ...(ref ? { decisionNoteRef: ref } : {}) };
}

export function statusConfirmation(request, status) {
  const closing = CLOSED.has(status);
  return {
    title: "Zmienić stan żądania?",
    effects: [
      `Żądanie ${request.id}: ${STATUS_LABELS[request.status] ?? request.status} → ${STATUS_LABELS[status]}.`,
      "Stanu nie da się cofnąć. Zmiana jest zapisana w dzienniku zdarzeń z Twoim kontem.",
      closing ? "Po zamknięciu eksport danych dla tego żądania nie będzie już możliwy." : null,
    ],
    confirmLabel: "Zmień stan",
    destructive: closing,
  };
}

// Eksport: rodzaj access/portability i stan identity_verified/in_progress (jak serwer, 409 inaczej).
export function exportBlocker(request) {
  if (!EXPORTABLE_KINDS.has(request?.kind)) return "Eksport przysługuje tylko przy żądaniu dostępu albo przenoszenia danych.";
  if (isClosed(request)) return "Żądanie jest zamknięte — eksport nie jest już możliwy.";
  if (!EXPORTABLE_STATUSES.has(request?.status)) return "Najpierw potwierdź tożsamość wnioskodawcy.";
  return "";
}

export const canExport = (request) => exportBlocker(request) === "";

export function exportConfirmation(request, format) {
  const label = String(format).toUpperCase();
  return {
    title: "Pobrać dane osobowe rodziny?",
    effects: [
      `Plik ${label} zawiera dane osobowe uczniów, opiekunów i wpłat jednej rodziny (żądanie ${request.id}).`,
      "Pobranie zostanie zapisane w dzienniku dostępu i zdarzeń (kto, kiedy, SHA-256 — bez treści). Serwer nie przechowuje paczki.",
      "Przekaż plik wnioskodawcy wyłącznie kanałem ustalonym przez administratora danych i nie zostawiaj kopii na współdzielonym dysku.",
      "Dostęp wymaga świeżego potwierdzenia MFA — panel poprosi o kod, jeśli minęło ponad 15 minut.",
    ],
    confirmLabel: `Pobierz ${label}`,
    destructive: true,
  };
}

// Nazwa pliku z nagłówka Content-Disposition (tylko bezpieczne znaki) albo zapasowa.
export function exportFileName(header, requestId, format) {
  const match = /filename="([A-Za-z0-9_.-]{1,200})"/.exec(String(header ?? ""));
  if (match) return match[1];
  const part = String(requestId ?? "zadanie").replace(/[^A-Za-z0-9_-]/g, "_");
  return `rd-dane-rodziny-${part}.${format === "csv" ? "csv" : "json"}`;
}

export function omittedNote(headers) {
  const guardians = Number(headers?.get?.("X-Data-Export-Omitted-Guardians") ?? 0) || 0;
  const households = Number(headers?.get?.("X-Data-Export-Omitted-Households") ?? 0) || 0;
  if (guardians <= 0 && households <= 0) return "";
  return `Pominięto osoby trzecie: opiekunów ${guardians}, gospodarstw ${households}. Decyzja, czy ujawniać to wnioskodawcy: D-07.`;
}

// Termin odpowiedzi względem dziś (daty kalendarzowe); zamknięte żądania nie są „po terminie”.
export function dueState(request, today) {
  if (!request?.dueOn || isClosed(request)) return "none";
  return String(request.dueOn).slice(0, 10) < today ? "overdue" : "open";
}

export function listSummary(count, hasMore) {
  const more = hasMore ? " Lista jest niepełna — użyj „Pokaż więcej”." : "";
  return `Żądań w widoku: ${count}.${more}`;
}
