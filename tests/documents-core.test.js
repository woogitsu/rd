import test from "node:test";
import assert from "node:assert/strict";

import {
  CATEGORY_LABELS,
  DEFAULT_MAX_BYTES,
  TYPES,
  buildDescriptionRequest,
  buildListUrl,
  buildUploadRequest,
  categoryLabel,
  checkFile,
  contentUrl,
  descriptionUrl,
  errorMessage,
  formatBytes,
  isRetryable,
  makeIdempotencyKey,
  metadataRows,
  metadataUrl,
  normalizeDocument,
  sniffType,
  submissionFingerprint,
  titleLabel,
  validateDescriptionInput,
  validateUploadMeta,
} from "../documents/core.js";
import { ALLOWED_TYPES, DEFAULT_MAX_UPLOAD_BYTES } from "../src/documents.js";
import { DOCUMENT_CATEGORIES } from "../src/pg/routes/documents.js";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const HTML = new TextEncoder().encode("<html><b");
const CSV = new TextEncoder().encode("imie;nazw");
const DOC_ID = "3f2b8c1e-6d4a-4b7e-9c2f-1a2b3c4d5e6f";

test("typy i limit klienta są zgodne z serwerem", () => {
  assert.deepEqual(Object.keys(TYPES).sort(), Object.keys(ALLOWED_TYPES).sort());
  for (const [mime, { signature }] of Object.entries(ALLOWED_TYPES)) assert.deepEqual(TYPES[mime].signature, signature);
  assert.equal(DEFAULT_MAX_BYTES, DEFAULT_MAX_UPLOAD_BYTES);
});

test("sygnatura pliku rozpoznaje PDF, PNG i JPEG, odrzuca HTML i CSV", () => {
  assert.equal(sniffType(PDF), "application/pdf");
  assert.equal(sniffType(PNG), "image/png");
  assert.equal(sniffType(JPEG), "image/jpeg");
  assert.equal(sniffType(HTML), null);
  assert.equal(sniffType(CSV), null);
  assert.equal(sniffType(new Uint8Array([0x25, 0x50])), null);
  assert.equal(sniffType("%PDF-"), null);
});

test("wstępna kontrola pliku sprawdza rozmiar, sygnaturę i zgodność typu", () => {
  assert.deepEqual(checkFile({ size: 1000, type: "application/pdf" }, PDF), { ok: true, mime: "application/pdf" });
  assert.deepEqual(checkFile({ size: 1000, type: "image/jpg" }, JPEG), { ok: true, mime: "image/jpeg" });
  assert.deepEqual(checkFile({ size: 1000, type: "" }, PNG), { ok: true, mime: "image/png" });
  assert.equal(checkFile(null, PDF).ok, false);
  assert.match(checkFile({ size: 0, type: "application/pdf" }, PDF).error, /pusty/);
  assert.match(checkFile({ size: DEFAULT_MAX_BYTES + 1, type: "application/pdf" }, PDF).error, /limit/);
  assert.equal(checkFile({ size: DEFAULT_MAX_BYTES, type: "application/pdf" }, PDF).ok, true);
  assert.equal(checkFile({ size: 2000, type: "application/pdf" }, PDF, 1000).ok, false);
  assert.match(checkFile({ size: 10, type: "text/csv" }, CSV).error, /CSV/);
  // Plik HTML przemianowany na .pdf albo PNG z rozszerzeniem .pdf.
  assert.equal(checkFile({ size: 10, type: "application/pdf" }, HTML).ok, false);
  assert.match(checkFile({ size: 10, type: "application/pdf" }, PNG).error, /nie zgadza się/);
});

test("metadane: klasa tylko dla materiałów klasy, powiązanie tylko dla dowodów finansowych", () => {
  assert.deepEqual(validateUploadMeta({ kind: "financial", schoolYearId: " 2026-2027 ", linkedEntityType: "payment_entry", linkedEntityId: "pay_1" }), {
    ok: true,
    value: { kind: "financial", schoolYearId: "2026-2027", classId: null, linkedEntityType: "payment_entry", linkedEntityId: "pay_1" },
  });
  assert.deepEqual(validateUploadMeta({ kind: "class", schoolYearId: "2026-2027", classId: "3a" }).value.classId, "3a");
  assert.equal(validateUploadMeta({ kind: "", schoolYearId: "2026-2027" }).ok, false);
  assert.equal(validateUploadMeta({ kind: "public", schoolYearId: "2026-2027" }).ok, false);
  assert.equal(validateUploadMeta({ kind: "board", schoolYearId: "" }).ok, false);
  assert.equal(validateUploadMeta({ kind: "board", schoolYearId: "2026/2027" }).ok, false);
  assert.equal(validateUploadMeta({ kind: "class", schoolYearId: "2026-2027" }).ok, false);
  assert.equal(validateUploadMeta({ kind: "board", schoolYearId: "2026-2027", classId: "3a" }).ok, false);
  assert.equal(validateUploadMeta({ kind: "board", schoolYearId: "2026-2027", linkedEntityType: "ledger_entry", linkedEntityId: "e1" }).ok, false);
  assert.equal(validateUploadMeta({ kind: "financial", schoolYearId: "2026-2027", linkedEntityType: "", linkedEntityId: "e1" }).ok, false);
  assert.equal(validateUploadMeta({ kind: "financial", schoolYearId: "2026-2027", linkedEntityType: "ledger_entry", linkedEntityId: "" }).ok, false);
  assert.equal(validateUploadMeta({ kind: "financial", schoolYearId: "2026-2027", linkedEntityType: "household", linkedEntityId: "h1" }).ok, false);
});

test("żądanie przesłania ma parametry w adresie, typ z sygnatury i klucz idempotencji", () => {
  const meta = validateUploadMeta({ kind: "financial", schoolYearId: "2026-2027", linkedEntityType: "ledger_entry", linkedEntityId: "entry_7" }).value;
  assert.deepEqual(buildUploadRequest(meta, "application/pdf", "document-abc12345"), {
    method: "POST",
    url: "/api/documents?kind=financial&schoolYearId=2026-2027&linkedEntityType=ledger_entry&linkedEntityId=entry_7",
    headers: { "Content-Type": "application/pdf", "Idempotency-Key": "document-abc12345" },
  });
  const classMeta = validateUploadMeta({ kind: "class", schoolYearId: "2026-2027", classId: "3a" }).value;
  assert.equal(buildUploadRequest(classMeta, "image/png", "document-abc12345").url, "/api/documents?kind=class&schoolYearId=2026-2027&classId=3a");
  assert.throws(() => buildUploadRequest(meta, "text/html", "document-abc12345"));
  assert.throws(() => buildUploadRequest(meta, "application/pdf", "short"));
});

test("klucz idempotencji jest stały dla ponowienia i nowy dla zmienionych danych", () => {
  assert.equal(makeIdempotencyKey(() => "uuid-1"), "document-uuid-1");
  assert.throws(() => makeIdempotencyKey(null));
  const file = { name: "a.pdf", size: 10, lastModified: 1 };
  const meta = validateUploadMeta({ kind: "board", schoolYearId: "2026-2027" }).value;
  assert.equal(submissionFingerprint(file, meta), submissionFingerprint({ ...file }, { ...meta }));
  assert.notEqual(submissionFingerprint(file, meta), submissionFingerprint({ ...file, size: 11 }, meta));
  assert.notEqual(submissionFingerprint(file, meta), submissionFingerprint(file, { ...meta, schoolYearId: "2027-2028" }));
});

test("adres listy zawiera wyłącznie zwalidowane filtry", () => {
  assert.equal(buildListUrl({ schoolYearId: "2026-2027" }), "/api/documents?schoolYearId=2026-2027&limit=50");
  assert.equal(
    buildListUrl({ schoolYearId: "2026-2027", kind: "class", classId: "3a", offset: 50 }),
    "/api/documents?schoolYearId=2026-2027&kind=class&classId=3a&limit=50&offset=50",
  );
  assert.throws(() => buildListUrl({ schoolYearId: "" }));
  assert.throws(() => buildListUrl({ schoolYearId: "2026-2027", kind: "all" }));
  assert.throws(() => buildListUrl({ schoolYearId: "2026-2027", classId: "3a&kind=board" }));
  assert.throws(() => buildListUrl({ schoolYearId: "2026-2027", limit: 101 }));
});

test("adresy metadanych i pobrania przyjmują tylko UUID", () => {
  assert.equal(metadataUrl(DOC_ID), `/api/documents/${DOC_ID}`);
  assert.equal(contentUrl(DOC_ID), `/api/documents/${DOC_ID}/content`);
  assert.throws(() => contentUrl("../session"));
  assert.throws(() => metadataUrl(`${DOC_ID}/content`));
});

test("komunikaty błędów są po polsku dla kodów i statusów API", () => {
  assert.match(errorMessage(503, { error: "storage_unavailable" }), /magazyn dokumentów nie jest skonfigurowany/i);
  assert.match(errorMessage(503, null), /magazyn dokumentów nie jest skonfigurowany/i);
  assert.match(errorMessage(503, { error: "service_unavailable" }), /chwilowo niedostępny/);
  assert.match(errorMessage(413, { error: "document_too_large" }), /limit/);
  assert.match(errorMessage(413, null), /limit/);
  assert.match(errorMessage(415, { error: "unsupported_media_type" }), /PDF, PNG i JPEG/);
  assert.match(errorMessage(403, { error: "forbidden" }), /Brak uprawnień/);
  assert.match(errorMessage(403, { error: "invalid_origin" }), /pochodzenie/);
  assert.match(errorMessage(404, { error: "not_found" }), /Nie znaleziono/);
  assert.match(errorMessage(409, { error: "idempotency_conflict" }), /inną treścią/);
  assert.match(errorMessage(0, null), /połączenia/);
  assert.match(errorMessage(500, { error: "<script>" }), /chwilowo niedostępna/);
  assert.doesNotMatch(errorMessage(500, { error: "<script>" }), /Błąd serwera|script/);
  assert.equal(isRetryable(0), true);
  assert.equal(isRetryable(503), true);
  assert.equal(isRetryable(415), false);
  assert.equal(isRetryable(409), false);
});

test("normalizacja i metadane nie ufają nieznanym wartościom", () => {
  const doc = normalizeDocument({
    id: DOC_ID, kind: "financial", schoolYearId: "2026-2027", classId: null, mimeType: "application/pdf",
    byteSize: 2048, sha256: "ab".repeat(32), linkedEntityType: "payment_entry", linkedEntityId: "pay_1",
    createdBy: "user_1", createdAt: "2026-09-27T10:00:00.000Z",
  });
  assert.equal(doc.kind, "financial");
  assert.equal(normalizeDocument({ kind: "public", linkedEntityType: "household" }).kind, null);
  assert.equal(normalizeDocument({ linkedEntityType: "household" }).linkedEntityType, null);
  const rows = Object.fromEntries(metadataRows(doc));
  assert.equal(rows.Rodzaj, "Dowód finansowy");
  assert.equal(rows.Klasa, "—");
  assert.equal(rows["Typ pliku"], "PDF");
  assert.equal(rows.Rozmiar, "2 KiB");
  assert.equal(rows["Powiązanie"], "Wpłata: pay_1");
  assert.match(rows.Dodano, /27\.09\.2026/);
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(10 * 1024 * 1024), "10 MiB");
});

// --- Tytuł, kategoria i wyszukiwanie (issue #76) ------------------------------------

test("kategorie panelu odpowiadają liście serwera (DOCUMENT_CATEGORIES)", () => {
  assert.deepEqual(Object.keys(CATEGORY_LABELS).sort(), [...DOCUMENT_CATEGORIES].sort());
});

test("validateDescriptionInput: tytuł, kategoria, data i opis", () => {
  const ok = validateDescriptionInput({ title: "Faktura — wynajem sali", category: "faktura", documentDate: "2026-10-05", description: "  " });
  assert.deepEqual(ok, { ok: true, value: { title: "Faktura — wynajem sali", category: "faktura", documentDate: "2026-10-05", description: null } });
  assert.equal(validateDescriptionInput({ title: "ab", category: "faktura" }).ok, false);
  assert.equal(validateDescriptionInput({ title: "x".repeat(201), category: "faktura" }).ok, false);
  assert.equal(validateDescriptionInput({ title: "Poprawny tytuł", category: "nieznana" }).ok, false);
  assert.equal(validateDescriptionInput({ title: "Poprawny tytuł", category: "faktura", documentDate: "2026-13-01" }).ok, false);
  assert.equal(validateDescriptionInput({ title: "Poprawny tytuł", category: "faktura", description: "y".repeat(1001) }).ok, false);
  assert.equal(validateDescriptionInput({ title: "Poprawny tytuł", category: "inne" }).ok, true);
});

test("descriptionUrl i buildDescriptionRequest", () => {
  assert.equal(descriptionUrl(DOC_ID), `/api/documents/${DOC_ID}/description`);
  const req = buildDescriptionRequest(DOC_ID, { title: "T", category: "inne" }, "12345678");
  assert.equal(req.method, "POST");
  assert.equal(req.url, `/api/documents/${DOC_ID}/description`);
  assert.deepEqual(req.body, { title: "T", category: "inne" });
  assert.equal(req.idempotencyKey, "12345678");
  assert.throws(() => buildDescriptionRequest(DOC_ID, {}, "short"));
});

test("titleLabel i categoryLabel: dokument bez opisu pokazuje wartości domyślne", () => {
  assert.equal(titleLabel({ title: null }), "Bez tytułu");
  assert.equal(titleLabel({ title: "Regulamin" }), "Regulamin");
  assert.equal(categoryLabel({ category: null }), "—");
  assert.equal(categoryLabel({ category: "wyciag" }), "Wyciąg bankowy");
});

test("buildListUrl koduje kategorię i wyszukiwaną frazę", () => {
  const url = buildListUrl({ schoolYearId: "2026-2027", category: "faktura", q: "wynajem sali" });
  assert.match(url, /category=faktura/);
  assert.match(url, /q=wynajem\+sali/);
  assert.throws(() => buildListUrl({ schoolYearId: "2026-2027", category: "nieznana" }));
  assert.throws(() => buildListUrl({ schoolYearId: "2026-2027", q: "x".repeat(201) }));
});

test("normalizeDocument i metadataRows pokazują tytuł, kategorię i datę dokumentu", () => {
  const doc = normalizeDocument({
    id: DOC_ID, kind: "financial", schoolYearId: "2026-2027", classId: null, mimeType: "application/pdf",
    byteSize: 2048, createdBy: "user_1", createdAt: "2026-09-27T10:00:00.000Z",
    title: "Faktura — wynajem sali", category: "faktura", documentDate: "2026-10-05",
  });
  assert.equal(doc.title, "Faktura — wynajem sali");
  assert.equal(doc.category, "faktura");
  assert.equal(doc.documentDate, "2026-10-05");
  const rows = Object.fromEntries(metadataRows(doc));
  assert.equal(rows["Tytuł"], "Faktura — wynajem sali");
  assert.equal(rows["Kategoria"], "Faktura");
  assert.equal(rows["Data dokumentu"], "2026-10-05");
  const bare = normalizeDocument({ id: DOC_ID, kind: "financial" });
  assert.equal(bare.title, null);
  assert.equal(Object.fromEntries(metadataRows(bare))["Tytuł"], "Bez tytułu");
});

test("buildListUrl przekazuje kursor zamiast offsetu (#159)", () => {
  const url = buildListUrl({ schoolYearId: "2026-2027", cursor: "abc_-9", offset: 50 });
  assert.match(url, /cursor=abc_-9/);
  assert.doesNotMatch(url, /offset=/);
});

test('previewKind i previewUrl: tylko PDF/PNG/JPEG, adres bez tokenu (#89)', async () => {
  const core = await import('../documents/core.js');
  assert.equal(core.previewKind('application/pdf'), 'pdf');
  assert.equal(core.previewKind('image/png'), 'image');
  assert.equal(core.previewKind('image/jpeg'), 'image');
  for (const mime of ['text/html', 'image/svg+xml', 'application/zip', '', undefined, '__proto__', 'constructor']) {
    assert.equal(core.previewKind(mime), null);
  }
  const id = '11111111-2222-4333-8444-555555555555';
  assert.equal(core.previewUrl(id), `/api/documents/${id}/content?disposition=inline`);
  assert.throws(() => core.previewUrl('../x'));
});
