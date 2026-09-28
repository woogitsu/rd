// Czysta logika panelu dokumentów (issue #39, #8). Bez DOM i bez sieci.
//
// Sprawdzenia po stronie przeglądarki służą wyłącznie wygodzie użytkownika
// (szybka informacja przed wysłaniem). O typie, rozmiarze i uprawnieniach
// zawsze rozstrzyga serwer — patrz src/pg/routes/documents.js.

// Domyślny limit serwera (DOCUMENT_MAX_BYTES, domyślnie 10 MiB). Serwer może
// mieć ustawiony inny limit, dlatego to tylko wstępne ostrzeżenie.
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const LIST_LIMIT = 50;

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const KIND_LABELS = Object.freeze({
  financial: "Dowód finansowy",
  board: "Dokument zarządu",
  class: "Materiał klasy",
});

export const KIND_HINTS = Object.freeze({
  financial: "Faktura, potwierdzenie przelewu, wyciąg. Wymaga roli finansowej i MFA.",
  board: "Protokół zarządu, uchwała.",
  class: "Materiał jednej klasy. Wymaga identyfikatora klasy.",
});

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
  return `Błąd serwera (${status}). Spróbuj ponownie.`;
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

export function buildListUrl({ schoolYearId, kind = "", classId = "", limit = LIST_LIMIT, offset = 0 }) {
  const year = String(schoolYearId ?? "").trim();
  if (!isSafeId(year)) throw new Error("Podaj poprawny identyfikator roku szkolnego.");
  if (kind && !Object.hasOwn(KIND_LABELS, kind)) throw new Error("Nieznany rodzaj dokumentu.");
  const cls = String(classId ?? "").trim();
  if (cls && !isSafeId(cls)) throw new Error("Niepoprawny identyfikator klasy.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Niepoprawny limit wyników.");
  if (!Number.isInteger(offset) || offset < 0) throw new Error("Niepoprawne przesunięcie listy.");
  const params = new URLSearchParams({ schoolYearId: year });
  if (kind) params.set("kind", kind);
  if (cls) params.set("classId", cls);
  params.set("limit", String(limit));
  if (offset) params.set("offset", String(offset));
  return `/api/documents?${params.toString()}`;
}

export function metadataUrl(id) {
  if (!isDocumentId(id)) throw new Error("Niepoprawny identyfikator dokumentu.");
  return `/api/documents/${id}`;
}

export function contentUrl(id) {
  return `${metadataUrl(id)}/content`;
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
  };
}

export function linkLabel(doc) {
  if (!doc.linkedEntityType || !doc.linkedEntityId) return "—";
  return `${LINK_LABELS[doc.linkedEntityType]}: ${doc.linkedEntityId}`;
}

// Pary [etykieta, wartość] do widoku metadanych.
export function metadataRows(rawDoc) {
  const doc = normalizeDocument(rawDoc);
  return [
    ["Identyfikator", doc.id || "—"],
    ["Rodzaj", doc.kind ? KIND_LABELS[doc.kind] : "Nieznany"],
    ["Rok szkolny", doc.schoolYearId ?? "—"],
    ["Klasa", doc.classId ?? "—"],
    ["Typ pliku", typeLabel(doc.mimeType)],
    ["Rozmiar", doc.byteSize === null ? "—" : formatBytes(doc.byteSize)],
    ["SHA-256", doc.sha256 ?? "—"],
    ["Powiązanie", linkLabel(doc)],
    ["Dodał(a)", doc.createdBy ?? "—"],
    ["Dodano", formatDateTime(doc.createdAt)],
  ];
}

// Role jak DOCUMENT_POLICIES w src/pg/routes/documents.js (test tests/role-policy-parity.test.js
// pilnuje zgodności). Formularz pokazuje tylko rodzaje, które konto może przesłać; serwer
// i tak autoryzuje każdy zapis (#225).
export const DOCUMENT_ROLES = Object.freeze({
  financial: Object.freeze(["admin", "board", "treasurer"]),
  board: Object.freeze(["admin", "board"]),
  class: Object.freeze(["admin", "board", "representative"]),
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
