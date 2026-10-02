// Czysta logika panelu dokumentów (issue #39, #8). Bez DOM i bez sieci.
//
// Sprawdzenia po stronie przeglądarki służą wyłącznie wygodzie użytkownika
// (szybka informacja przed wysłaniem). O typie, rozmiarze i uprawnieniach
// zawsze rozstrzyga serwer — patrz src/pg/routes/documents.js.

// Domyślny limit serwera (DOCUMENT_MAX_BYTES, domyślnie 10 MiB). Serwer może
// mieć ustawiony inny limit, dlatego to tylko wstępne ostrzeżenie.
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const LIST_LIMIT = 50;

import { isAuditReadView } from "../shared/audit-view.js";
import { statusMessage } from "../shared/messages.js";
import { formatSchoolYear } from "../shared/school-year.js";
import { shortId } from "../shared/short-id.js";

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const KIND_LABELS = Object.freeze({
  financial: "Dowód finansowy",
  board: "Dokument zarządu",
  class: "Materiał klasy",
  council_shared: "Dokument Rady dla przedstawicieli",
});

export const KIND_HINTS = Object.freeze({
  financial: "Faktura, potwierdzenie przelewu, wyciąg. Wymaga roli finansowej i MFA.",
  board: "Protokół zarządu, uchwała.",
  class: "Materiał jednej klasy. Wymaga identyfikatora klasy.",
  council_shared: "Regulamin, plan pracy, informacja o składce. Czytają go przedstawiciele wszystkich klas roku.",
});

// Lista zamknięta — zgodna z DOCUMENT_CATEGORIES w src/pg/routes/documents.js
// (założenie techniczne do zatwierdzenia przez zarząd i skarbnika, issue #76).
export const CATEGORY_LABELS = Object.freeze({
  faktura: "Faktura",
  potwierdzenie_przelewu: "Potwierdzenie przelewu",
  wyciag: "Wyciąg bankowy",
  protokol: "Protokół",
  uchwala: "Uchwała",
  umowa: "Umowa",
  regulamin: "Regulamin",
  sprawozdanie_rewizyjne: "Sprawozdanie dla Komisji Rewizyjnej",
  inne: "Inne",
});

// Stan dokumentu (issue #82): wyliczany przez serwer ze zdarzeń statusu. Plik i wpis zostają
// w archiwum także po zastąpieniu i unieważnieniu.
export const STATUS_LABELS = Object.freeze({
  active: "Aktualny",
  superseded: "Zastąpiony",
  voided: "Unieważniony",
});
export const REASON_MIN = 3;
export const REASON_MAX = 500;

export const LINK_LABELS = Object.freeze({
  ledger_entry: "Wpis księgi",
  payment_entry: "Wpłata",
});

export const TYPES = Object.freeze({
  "application/pdf": { label: "PDF", extensions: ["pdf"], signature: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  "image/png": { label: "PNG", extensions: ["png"], signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  "image/jpeg": { label: "JPEG", extensions: ["jpg", "jpeg"], signature: [0xff, 0xd8, 0xff] },
});

export const SNIFF_BYTES = 8;

export const ERROR_MESSAGES = Object.freeze({
  unauthenticated: "Sesja wygasła lub nie jesteś zalogowany. Zaloguj się ponownie.",
  forbidden: "Brak uprawnień do dokumentów tego rodzaju w wybranym roku lub klasie.",
  invalid_origin: "Żądanie odrzucone: niezgodne pochodzenie strony. Otwórz panel z adresu aplikacji.",
  not_found: "Nie znaleziono dokumentu albo nie masz do niego dostępu.",
  document_too_large: "Plik przekracza limit rozmiaru ustawiony na serwerze.",
  unsupported_media_type: "Niedozwolony typ pliku. Dopuszczalne są wyłącznie PDF, PNG i JPEG, a treść pliku musi odpowiadać typowi.",
  document_active_content: "Plik odrzucony: zawiera potencjalnie aktywną treść (skrypt, załącznik, szyfrowanie) niedozwoloną w dokumentach Rady.",
  document_malformed: "Plik odrzucony: jego struktura nie odpowiada zadeklarowanemu typowi (uszkodzony albo z doklejonymi dodatkowymi danymi).",
  storage_unavailable: "Magazyn dokumentów nie jest skonfigurowany. Przesyłanie i pobieranie są niedostępne.",
  service_unavailable: "Magazyn dokumentów jest chwilowo niedostępny. Spróbuj ponownie później — ponowienie nie utworzy duplikatu.",
  idempotency_conflict: "Ta operacja została już zapisana z inną treścią. Wybierz plik i dane ponownie.",
  idempotency_key_required: "Brak identyfikatora operacji. Odśwież stronę i spróbuj ponownie.",
  invalid_kind: "Nieznany rodzaj dokumentu.",
  invalid_school_year: "Nieznany lub niepoprawny rok szkolny.",
  invalid_class: "Niepoprawna klasa. Klasę podaje się wyłącznie dla materiałów klasy, w tym samym roku szkolnym.",
  invalid_link: "Niepoprawne powiązanie. Wpis księgi lub wpłata musi istnieć w tym samym roku i dotyczy tylko dowodów finansowych.",
  empty_document: "Plik jest pusty.",
  method_not_allowed: "Operacja niedozwolona.",
  invalid_disposition: "Nieznany sposób otwarcia pliku. Użyj podglądu albo pobrania.",
  document_preview_unsupported: "Podglądu tego typu pliku nie ma. Pobierz plik.",
  pdf_inline_not_allowed: "Podgląd PDF działa tylko w panelu (PDF.js), bez wbudowanego czytnika przeglądarki. Otwórz dokument w panelu albo pobierz plik.",
  document_preview_blocked: "Ten plik nie przechodzi bieżącej kontroli struktury, więc nie otworzy się w panelu. Można go pobrać; zgłoś go administratorowi.",
});

const STATUS_FALLBACK = Object.freeze({
  400: "Niepoprawne dane żądania.",
  401: ERROR_MESSAGES.unauthenticated,
  403: ERROR_MESSAGES.forbidden,
  404: ERROR_MESSAGES.not_found,
  409: ERROR_MESSAGES.idempotency_conflict,
  413: ERROR_MESSAGES.document_too_large,
  415: ERROR_MESSAGES.unsupported_media_type,
  503: ERROR_MESSAGES.storage_unavailable,
});

// Komunikat po polsku dla odpowiedzi API ({ error: "kod" }).
export function errorMessage(status, body) {
  const code = typeof body?.error === "string" ? body.error : "";
  if (Object.hasOwn(ERROR_MESSAGES, code)) return ERROR_MESSAGES[code];
  if (Object.hasOwn(STATUS_FALLBACK, status)) return STATUS_FALLBACK[status];
  if (status === 0) return "Brak połączenia z serwerem. Spróbuj ponownie — ponowienie nie utworzy duplikatu.";
  return statusMessage(status);
}

// Czy warto ponowić to samo żądanie z tym samym kluczem idempotencji.
export function isRetryable(status) {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

export function isSafeId(value) {
  return typeof value === "string" && SAFE_ID.test(value.trim());
}

export function isDocumentId(value) {
  return typeof value === "string" && UUID.test(value);
}

// Wykrywa typ po pierwszych bajtach pliku (magic bytes). Zwraca MIME albo null.
export function sniffType(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  for (const [mime, { signature }] of Object.entries(TYPES)) {
    if (bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte)) return mime;
  }
  return null;
}

export function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const format = (number) => new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 1 }).format(number);
  if (bytes < 1024 * 1024) return `${format(bytes / 1024)} KiB`;
  return `${format(bytes / (1024 * 1024))} MiB`;
}

export function formatDateTime(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Brussels" }).format(date);
}

export function typeLabel(mime) {
  return TYPES[mime]?.label ?? "Nieznany";
}

// Wstępna kontrola pliku: rozmiar, deklarowany typ i sygnatura.
// file: { size, type }, head: pierwsze bajty pliku (Uint8Array).
// Zwraca { ok: true, mime } albo { ok: false, error }.
export function checkFile(file, head, maxBytes = DEFAULT_MAX_BYTES) {
  if (!file) return { ok: false, error: "Wybierz plik." };
  const size = Number(file.size);
  if (!Number.isFinite(size) || size <= 0) return { ok: false, error: ERROR_MESSAGES.empty_document };
  if (size > maxBytes) {
    return { ok: false, error: `Plik ma ${formatBytes(size)}, a limit wynosi ${formatBytes(maxBytes)}.` };
  }
  const sniffed = sniffType(head);
  if (!sniffed) {
    return { ok: false, error: "Plik nie wygląda na PDF, PNG ani JPEG. Inne typy (np. CSV, dokumenty biurowe) nie są przyjmowane." };
  }
  const declared = String(file.type ?? "").toLowerCase() === "image/jpg" ? "image/jpeg" : String(file.type ?? "").toLowerCase();
  if (declared && declared !== sniffed) {
    return { ok: false, error: `Rozszerzenie lub typ pliku (${declared}) nie zgadza się z treścią (${typeLabel(sniffed)}).` };
  }
  return { ok: true, mime: sniffed };
}

// Walidacja metadanych formularza przesyłania. Zwraca { ok, value | error }.
export function validateUploadMeta(input) {
  const kind = String(input?.kind ?? "");
  if (!Object.hasOwn(KIND_LABELS, kind)) return { ok: false, error: "Wybierz rodzaj dokumentu." };
  const schoolYearId = String(input?.schoolYearId ?? "").trim();
  if (!isSafeId(schoolYearId)) return { ok: false, error: "Podaj poprawny identyfikator roku szkolnego (litery, cyfry, - lub _)." };
  const classId = String(input?.classId ?? "").trim();
  if (kind === "class" && !isSafeId(classId)) return { ok: false, error: "Materiał klasy wymaga poprawnego identyfikatora klasy." };
  if (kind !== "class" && classId) return { ok: false, error: "Klasę podaje się wyłącznie dla materiałów klasy." };
  const linkedEntityType = String(input?.linkedEntityType ?? "");
  const linkedEntityId = String(input?.linkedEntityId ?? "").trim();
  if (linkedEntityType || linkedEntityId) {
    if (kind !== "financial") return { ok: false, error: "Powiązanie z wpisem księgi lub wpłatą dotyczy tylko dowodów finansowych." };
    if (!Object.hasOwn(LINK_LABELS, linkedEntityType)) return { ok: false, error: "Wybierz rodzaj powiązania." };
    if (!isSafeId(linkedEntityId)) return { ok: false, error: "Podaj poprawny identyfikator wpisu księgi lub wpłaty." };
  }
  return {
    ok: true,
    value: {
      kind,
      schoolYearId,
      classId: kind === "class" ? classId : null,
      linkedEntityType: linkedEntityId ? linkedEntityType : null,
      linkedEntityId: linkedEntityId || null,
    },
  };
}

export function buildUploadRequest(meta, mime, idempotencyKey) {
  if (!Object.hasOwn(TYPES, mime)) throw new Error("Niedozwolony typ pliku.");
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    throw new Error("Niepoprawny identyfikator operacji.");
  }
  const params = new URLSearchParams({ kind: meta.kind, schoolYearId: meta.schoolYearId });
  if (meta.classId) params.set("classId", meta.classId);
  if (meta.linkedEntityType && meta.linkedEntityId) {
    params.set("linkedEntityType", meta.linkedEntityType);
    params.set("linkedEntityId", meta.linkedEntityId);
  }
  return {
    method: "POST",
    url: `/api/documents?${params.toString()}`,
    headers: { "Content-Type": mime, "Idempotency-Key": idempotencyKey },
  };
}

export function buildListUrl({ schoolYearId, kind = "", classId = "", category = "", q = "", includeInactive = false, validationOutdated = false, limit = LIST_LIMIT, offset = 0, cursor = "" }) {
  const year = String(schoolYearId ?? "").trim();
  if (!isSafeId(year)) throw new Error("Podaj poprawny identyfikator roku szkolnego.");
  if (kind && !Object.hasOwn(KIND_LABELS, kind)) throw new Error("Nieznany rodzaj dokumentu.");
  const cls = String(classId ?? "").trim();
  if (cls && !isSafeId(cls)) throw new Error("Niepoprawny identyfikator klasy.");
  if (category && !Object.hasOwn(CATEGORY_LABELS, category)) throw new Error("Nieznana kategoria.");
  const query = String(q ?? "").trim();
  if (query.length > 200) throw new Error("Fraza wyszukiwania jest za długa.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Niepoprawny limit wyników.");
  if (!Number.isInteger(offset) || offset < 0) throw new Error("Niepoprawne przesunięcie listy.");
  const params = new URLSearchParams({ schoolYearId: year });
  if (kind) params.set("kind", kind);
  if (cls) params.set("classId", cls);
  if (category) params.set("category", category);
  if (query) params.set("q", query);
  // Domyślnie serwer zwraca tylko dokumenty aktualne; `status=all` dodaje zastąpione i unieważnione.
  if (includeInactive) params.set("status", "all");
  // #89 (0161): tylko pliki sprawdzone starszą wersją reguł kontroli struktury albo bez wersji.
  if (validationOutdated) params.set("validation", "outdated");
  params.set("limit", String(limit));
  // #159: kursor keyset zastępuje offset (offset zostaje tylko dla zgodności).
  if (cursor) params.set("cursor", String(cursor));
  else if (offset) params.set("offset", String(offset));
  return `/api/documents?${params.toString()}`;
}

export function metadataUrl(id) {
  if (!isDocumentId(id)) throw new Error("Niepoprawny identyfikator dokumentu.");
  return `/api/documents/${id}`;
}

export function contentUrl(id) {
  return `${metadataUrl(id)}/content`;
}

// Podgląd (#89): ten sam autoryzowany adres serwera. Obrazy: `disposition=inline`;
// PDF nie jest wydawany inline (400 pdf_inline_not_allowed) — bajty do PDF.js idą z
// `purpose=preview` (załącznik, zdarzenie document.viewed). Sesja i uprawnienia są
// sprawdzane przy każdym żądaniu; adres nie zawiera tokenu.
export const PREVIEW_MIME = Object.freeze({ "application/pdf": "pdf", "image/png": "image", "image/jpeg": "image" });

export function previewKind(mime) {
  return Object.hasOwn(PREVIEW_MIME, mime) ? PREVIEW_MIME[mime] : null;
}

export function previewUrl(id) {
  return `${contentUrl(id)}?disposition=inline`;
}

export function pdfPreviewUrl(id) {
  return `${contentUrl(id)}?purpose=preview`;
}

export function descriptionUrl(id) {
  return `${metadataUrl(id)}/description`;
}

function isValidCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

// Walidacja formularza opisu (issue #76). Zwraca { ok, value | error }.
export function validateDescriptionInput(input) {
  const title = String(input?.title ?? "").trim();
  if (title.length < 3 || title.length > 200) return { ok: false, error: "Tytuł musi mieć od 3 do 200 znaków." };
  const category = String(input?.category ?? "");
  if (!Object.hasOwn(CATEGORY_LABELS, category)) return { ok: false, error: "Wybierz kategorię z listy." };
  const documentDate = String(input?.documentDate ?? "").trim();
  if (documentDate && !isValidCalendarDate(documentDate)) return { ok: false, error: "Niepoprawna data dokumentu." };
  const description = String(input?.description ?? "").trim();
  if (description.length > 1000) return { ok: false, error: "Opis może mieć najwyżej 1000 znaków." };
  return { ok: true, value: { title, category, documentDate: documentDate || null, description: description || null } };
}

export function buildDescriptionRequest(id, meta, idempotencyKey) {
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    throw new Error("Niepoprawny identyfikator operacji.");
  }
  return { method: "POST", url: descriptionUrl(id), body: meta, idempotencyKey };
}

export function makeIdempotencyKey(randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto)) {
  if (typeof randomUUID !== "function") throw new Error("Ta przeglądarka nie obsługuje bezpiecznych identyfikatorów operacji.");
  return `document-${randomUUID()}`;
}

// Odcisk danych przesłania: zmiana pliku lub metadanych = nowa operacja
// (nowy klucz), ponowienie bez zmian = ten sam klucz.
export function submissionFingerprint(file, meta) {
  return JSON.stringify([
    file?.name ?? "", Number(file?.size ?? 0), Number(file?.lastModified ?? 0),
    meta.kind, meta.schoolYearId, meta.classId, meta.linkedEntityType, meta.linkedEntityId,
  ]);
}

export function normalizeDocument(doc) {
  const byteSize = Number(doc?.byteSize);
  return {
    id: String(doc?.id ?? ""),
    kind: Object.hasOwn(KIND_LABELS, doc?.kind) ? doc.kind : null,
    schoolYearId: doc?.schoolYearId ? String(doc.schoolYearId) : null,
    classId: doc?.classId ? String(doc.classId) : null,
    mimeType: String(doc?.mimeType ?? ""),
    byteSize: Number.isSafeInteger(byteSize) ? byteSize : null,
    sha256: doc?.sha256 ? String(doc.sha256) : null,
    linkedEntityType: Object.hasOwn(LINK_LABELS, doc?.linkedEntityType) ? doc.linkedEntityType : null,
    linkedEntityId: doc?.linkedEntityId ? String(doc.linkedEntityId) : null,
    createdBy: doc?.createdBy ? String(doc.createdBy) : null,
    createdAt: doc?.createdAt ? String(doc.createdAt) : null,
    // Tytuł/kategoria najnowszej wersji opisu (issue #76); null = brak wpisu.
    title: doc?.title ? String(doc.title) : null,
    category: Object.hasOwn(CATEGORY_LABELS, doc?.category) ? doc.category : null,
    documentDate: doc?.documentDate ? String(doc.documentDate) : null,
    // Stan i „zastąpiony przez” (issue #82); brak pola = dokument aktualny.
    status: Object.hasOwn(STATUS_LABELS, doc?.status) ? doc.status : "active",
    replacementDocumentId: isDocumentId(doc?.replacementDocumentId) ? doc.replacementDocumentId : null,
    // Wersja reguł kontroli struktury przy przesłaniu (#89, 0161); null = nieznana.
    validationVersion: Number.isSafeInteger(doc?.validationVersion) && doc.validationVersion >= 1 ? doc.validationVersion : null,
    validationCurrent: doc?.validationCurrent === true,
  };
}

// #89 (0161): opis, którą wersją reguł serwer sprawdził plik przy przesłaniu.
export function validationLabel(doc) {
  if (doc.validationCurrent) return `bieżące reguły (wersja ${doc.validationVersion ?? "—"})`;
  if (doc.validationVersion === null) return "wersja nieznana (plik sprzed zapisu wersji reguł)";
  return `starsze reguły (wersja ${doc.validationVersion})`;
}

export function statusLabel(doc) {
  return STATUS_LABELS[doc?.status] ?? STATUS_LABELS.active;
}

export function titleLabel(doc) {
  return doc.title ?? "Bez tytułu";
}

export function categoryLabel(doc) {
  return doc.category ? CATEGORY_LABELS[doc.category] : "—";
}

// Przegląd demo 4: „1 dokument” obok „Dokumenty: 2” — jedna odmiana jak
// w innych panelach („1 wpis”, „5 pozycji”).
export function documentCountLabel(count) {
  const n = Math.abs(Number(count) || 0);
  if (n === 1) return "1 dokument";
  const last = n % 10;
  const lastTwo = n % 100;
  const few = last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14);
  return `${n} ${few ? "dokumenty" : "dokumentów"}`;
}

export function linkLabel(doc) {
  if (!doc.linkedEntityType || !doc.linkedEntityId) return "—";
  return `${LINK_LABELS[doc.linkedEntityType]} ${shortId(doc.linkedEntityId)}`;
}

// Pary [etykieta, wartość] do widoku metadanych.
export function metadataRows(rawDoc) {
  const doc = normalizeDocument(rawDoc);
  return [
    ["Identyfikator", doc.id || "—"],
    ["Rodzaj", doc.kind ? KIND_LABELS[doc.kind] : "Nieznany"],
    ["Rok szkolny", doc.schoolYearId ? formatSchoolYear(doc.schoolYearId) : "—"],
    ["Klasa", doc.classId ?? "—"],
    ["Typ pliku", typeLabel(doc.mimeType)],
    ["Rozmiar", doc.byteSize === null ? "—" : formatBytes(doc.byteSize)],
    ["SHA-256", doc.sha256 ?? "—"],
    ["Powiązanie", linkLabel(doc)],
    ["Stan", statusLabel(doc)],
    ["Tytuł", titleLabel(doc)],
    ["Kategoria", categoryLabel(doc)],
    ["Data dokumentu", doc.documentDate ?? "—"],
    ["Dodał(a)", doc.createdBy ? `konto ${shortId(doc.createdBy)}` : "—"],
    ["Dodano", formatDateTime(doc.createdAt)],
    ["Kontrola struktury", validationLabel(doc)],
  ];
}

// Role jak DOCUMENT_POLICIES w src/pg/routes/documents.js (test tests/role-policy-parity.test.js
// pilnuje zgodności). Formularz pokazuje tylko rodzaje, które konto może przesłać; serwer
// i tak autoryzuje każdy zapis (#225).
export const DOCUMENT_ROLES = Object.freeze({
  financial: Object.freeze(["admin", "board", "treasurer"]),
  board: Object.freeze(["admin", "board"]),
  class: Object.freeze(["admin", "board", "representative"]),
  // Przesyłają admin i zarząd; przedstawiciele klas tylko czytają (readRoles na serwerze).
  council_shared: Object.freeze(["admin", "board"]),
});

// Rodzaje dokumentów, które konto może przesłać: rodzaje ogólnoszkolne wymagają przydziału
// bez klasy, „Materiał klasy” — przydziału ogólnoszkolnego albo przedstawiciela klasy.
export function uploadableKinds(grants) {
  const list = Array.isArray(grants) ? grants : [];
  return Object.keys(DOCUMENT_ROLES).filter((kind) => list.some((grant) => DOCUMENT_ROLES[kind].includes(grant?.role)
    && (!grant.classId || (kind === "class" && grant.role === "representative"))));
}

// Klasy przedstawiciela (podpowiedź pola „Klasa”); pusta lista dla przydziałów ogólnoszkolnych.
export function representativeClasses(grants) {
  const list = Array.isArray(grants) ? grants : [];
  return [...new Set(list.filter((g) => g?.role === "representative" && g.classId).map((g) => g.classId))].sort();
}

// Czy konto może zastąpić lub unieważnić dokument — podpowiedź dla przycisków; o dostępie
// rozstrzyga serwer (canAccessDocument w src/pg/routes/documents.js: te same role, co przy
// przesłaniu, D-08/D-09 — bez rozszerzania uprawnień). Materiał klasy: przydział ogólnoszkolny
// albo przydział tej klasy; rodzaje ogólnoszkolne: wyłącznie przydział bez klasy.
export function canChangeStatus(grants, rawDoc) {
  const doc = normalizeDocument(rawDoc);
  if (!doc.kind || doc.status !== "active" || !DOCUMENT_ROLES[doc.kind]) return false;
  const list = Array.isArray(grants) ? grants : [];
  return list.some((grant) => {
    if (!DOCUMENT_ROLES[doc.kind].includes(grant?.role)) return false;
    if (grant.schoolYearId && doc.schoolYearId && grant.schoolYearId !== doc.schoolYearId) return false;
    if (doc.kind === "class") return !grant.classId || grant.classId === doc.classId;
    return !grant.classId;
  });
}

// Dokumenty, którymi można zastąpić `doc`: ten sam rodzaj, rok i klasa, aktualne, inne niż sam
// dokument. Serwer sprawdza to samo i odrzuca resztę (400/409).
export function replacementCandidates(documents, rawDoc) {
  const doc = normalizeDocument(rawDoc);
  return (Array.isArray(documents) ? documents : []).map(normalizeDocument).filter((other) => other.id
    && other.id !== doc.id && other.status === "active" && other.kind === doc.kind
    && other.schoolYearId === doc.schoolYearId && other.classId === doc.classId);
}

export function validateStatusReason(value) {
  const reason = String(value ?? "").trim();
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
    return { ok: false, error: `Powód musi mieć od ${REASON_MIN} do ${REASON_MAX} znaków.` };
  }
  return { ok: true, value: reason };
}

export function buildStatusRequest(action, id, { reason, replacementDocumentId } = {}, idempotencyKey) {
  if (action !== "supersede" && action !== "void") throw new Error("Nieznana operacja na dokumencie.");
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    throw new Error("Niepoprawny identyfikator operacji.");
  }
  const body = { reason };
  if (action === "supersede") {
    if (!isDocumentId(replacementDocumentId)) throw new Error("Wybierz dokument zastępujący.");
    body.replacementDocumentId = replacementDocumentId;
  }
  return { method: "POST", url: `${metadataUrl(id)}/${action}`, body, idempotencyKey };
}

// Skutki pokazywane w oknie potwierdzenia (shared/confirm-dialog.js). Bez „usuń”: plik zostaje.
export function statusConfirmation(action, label, replacementLabel = "", kind = "") {
  const keep = "Plik i wpis zostają w archiwum i nie są usuwane; operacja trafia do dziennika zdarzeń.";
  // #82: unieważnienie nie ogranicza dostępu — kto miał dostęp do rodzaju dokumentu, nadal go otworzy.
  const access = "Osoby z dostępem do tego rodzaju dokumentów nadal mogą otworzyć plik.";
  if (action === "supersede") {
    return {
      title: "Zastąpić dokument?",
      confirmLabel: "Zastąp dokument",
      destructive: true,
      effects: [
        `Dokument „${label}” zostanie oznaczony jako zastąpiony przez „${replacementLabel}”.`,
        "Zastąpiony dokument znika z domyślnej listy; widać go po wybraniu „Pokaż też zastąpione i unieważnione”.",
        // Dowody księgowe są wyłącznie dokumentami finansowymi.
        ...(kind === "financial"
          ? ["Jeśli dokument jest dowodem wpisu księgi, powiązanie zostaje przy nim; księga pokaże nową wersję jako aktualną."]
          : []),
        keep,
        access,
        "Tej operacji nie można cofnąć w panelu.",
      ],
    };
  }
  return {
    title: "Unieważnić dokument?",
    confirmLabel: "Unieważnij dokument",
    destructive: true,
    effects: [
      `Dokument „${label}” zostanie oznaczony jako unieważniony.`,
      "Unieważniony dokument znika z domyślnej listy; widać go po wybraniu „Pokaż też zastąpione i unieważnione”.",
      keep,
      access,
      "Tej operacji nie można cofnąć w panelu.",
    ],
  };
}

// --- D-09 (#137), wariant (b): widok tylko do odczytu Komisji Rewizyjnej -----------------------------
// Serwer wydaje `audit` (flaga AUDIT_LEDGER_READ) wyłącznie dowody `financial` roku przydziału, z kategorii
// bez danych płatników i niepowiązane z wpłatą: lista, metadane (bez opisu) i treść. Panel dowiaduje się
// o fladze z `capabilities` w GET /api/session (shared/audit-view.js). Ukrycie akcji to skrót interfejsu —
// przesyłanie, opis, zastąpienie i unieważnienie odrzuca serwer (403/404).

// Role z własnym (standardowym) widokiem panelu — jak `roles` wpisu documents w shared/shell.js
// (tests/shell-panels-authz.test.js pilnuje zgodności z DOCUMENT_POLICIES).
export const DOCUMENT_PANEL_ROLES = Object.freeze(["admin", "board", "treasurer", "representative"]);

// Kategorie dowodów czytelne dla audit — jak AUDIT_READABLE_DOCUMENT_CATEGORIES w src/pg/audit-ledger-read.js.
export const AUDIT_READABLE_CATEGORIES = Object.freeze(["faktura", "umowa", "uchwala", "protokol", "sprawozdanie_rewizyjne"]);

// Jedyny rodzaj, który widzi audit.
export const AUDIT_DOCUMENT_KIND = "financial";

export function isDocumentsAuditView(grants, capabilities) {
  const standardAccess = (Array.isArray(grants) ? grants : []).some((grant) => DOCUMENT_PANEL_ROLES.includes(grant?.role));
  return isAuditReadView({ grants, capabilities, standardAccess });
}

// Elementy panelu, których widok audit NIE renderuje (usuwane z DOM): formularz przesyłania, opis (tytuł,
// kategoria), wersje i zmiana stanu (zastąp, unieważnij) oraz filtry spoza zakresu audit — klasa i
// wyszukiwanie w opisie (opis nie jest wydawany). tests/documents-core.test.js pilnuje, że każdy formularz
// zapisu w documents/index.html jest objęty tą listą.
export const AUDIT_REMOVED_ELEMENT_IDS = Object.freeze([
  "upload-section", "description-block", "status-block", "filter-class-field", "filter-search-field",
]);
