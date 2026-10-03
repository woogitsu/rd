import { AUDIT_DOCUMENT_KIND, AUDIT_READABLE_CATEGORIES, AUDIT_REMOVED_ELEMENT_IDS, isDocumentsAuditView, uploadableKinds } from "./core.js";
import {
  DEFAULT_MAX_BYTES,
  ERROR_MESSAGES,
  KIND_HINTS,
  KIND_LABELS,
  LIST_LIMIT,
  SNIFF_BYTES,
  buildDescriptionRequest,
  buildListUrl,
  buildStatusRequest,
  buildUploadRequest,
  canChangeStatus,
  categoryLabel,
  checkFile,
  contentUrl,
  errorMessage,
  formatBytes,
  formatDateTime,
  isRetryable,
  linkLabel,
  documentCountLabel,
  makeIdempotencyKey,
  metadataRows,
  metadataUrl,
  pdfPreviewUrl,
  previewKind,
  previewUrl,
  replacementCandidates,
  normalizeDocument,
  statusConfirmation,
  statusLabel,
  submissionFingerprint,
  titleLabel,
  typeLabel,
  validateDescriptionInput,
  validateStatusReason,
  validateUploadMeta,
} from "./core.js";
import { MESSAGES, api, errorMessage as sharedErrorMessage, handleAuthFailure } from "../shared/api.js";
import { confirmAction } from "../shared/confirm-dialog.js";
import { mountShell } from "../shared/shell.js";
import "../shared/shell.css";
import { fillClassSelect } from "../shared/class-choice.js";
import { fillYearSelect } from "../shared/school-year.js";

const shellReady = mountShell();
// D-09 (#137): widok tylko do odczytu Komisji Rewizyjnej — rozstrzygany raz, po sesji (capabilities
// z GET /api/session) i uprawnieniach. Skrót interfejsu; zapisy i tak odrzuca serwer.
const auditViewReady = shellReady.then((result) => isDocumentsAuditView(result?.grants, result?.capabilities), () => false);

// Tekst błędu (#99): słownik dokumentów, potem wspólny (np. mfa_required), potem
// komunikaty dokumentów według statusu; pozostałe statusy — wspólny tekst.
const DOCUMENT_STATUS_TEXTS = new Set([0, 400, 401, 403, 404, 409, 413, 415, 503]);
function apiErrorText(status, body) {
  const code = typeof body?.error === "string" ? body.error : "";
  if (Object.hasOwn(ERROR_MESSAGES, code)) return errorMessage(status, body);
  if (Object.hasOwn(MESSAGES, code) || !DOCUMENT_STATUS_TEXTS.has(status)) return sharedErrorMessage(code, status);
  return errorMessage(status, body);
}

const byId = (id) => document.getElementById(id);
const state = { auditView: false, documents: [], query: null, cursor: "", pending: null, uploading: false, detailsRequest: null, grants: [], statusAction: null, statusPending: null };

const filtersForm = byId("filters-form");
const yearInput = byId("filter-year");
const listBody = byId("documents-body");
const listMessage = byId("list-message");
const listSummary = byId("list-summary");
const tableWrap = byId("table-wrap");
const loadMore = byId("load-more");
const details = byId("details");
const detailsList = byId("details-list");
const detailsDownload = byId("details-download");
const detailsPreview = byId("details-preview");
const previewArea = byId("preview-area");
const previewMessage = byId("preview-message");
const previewImage = byId("preview-image");
const previewPdf = byId("preview-pdf");
let pdfPreview = null;
let previewToken = 0;
const descriptionHistory = byId("description-history");
const descriptionForm = byId("description-form");
const descriptionStatus = byId("description-status");
const versionHistory = byId("version-history");
const statusActions = byId("status-actions");
const statusForm = byId("status-form");
const statusMessage = byId("status-message");
const uploadForm = byId("upload-form");
const fileInput = byId("upload-file");
const fileCheck = byId("file-check");
const kindSelect = byId("upload-kind");
const kindHint = byId("kind-hint");
const classField = byId("class-field");
const linkField = byId("link-field");
const submitButton = byId("upload-submit");
const progress = byId("upload-progress");
const uploadStatus = byId("upload-status");

class ApiError extends Error {
  constructor(status, body) {
    super(apiErrorText(status, body));
    this.status = status;
  }
}

// Wspólny klient (#99): 401/403 MFA → /login/ z powrotem.
async function getJson(url, options) {
  try {
    return await api(url, options);
  } catch (error) {
    throw new ApiError(error.status ?? 0, error.data ?? null);
  }
}

function setMessage(element, text, kind = "") {
  element.className = kind ? `message ${kind}` : "message";
  element.textContent = text;
}

function cell(label, text, className = "") {
  const td = document.createElement("td");
  td.dataset.label = label;
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function documentRow(raw) {
  const doc = normalizeDocument(raw);
  const row = document.createElement("tr");
  row.append(
    cell("Tytuł", titleLabel(doc)),
    cell("Kategoria", categoryLabel(doc)),
    cell("Stan", statusLabel(doc)),
    cell("Dodano", formatDateTime(doc.createdAt)),
    cell("Rodzaj", doc.kind ? KIND_LABELS[doc.kind] : "Nieznany"),
    cell("Klasa", doc.classId ?? "—"),
    cell("Typ", typeLabel(doc.mimeType)),
    cell("Rozmiar", doc.byteSize === null ? "—" : formatBytes(doc.byteSize), "num"),
    cell("Powiązanie", linkLabel(doc)),
  );
  // Pełny identyfikator powiązania w podpowiedzi; komórka pokazuje skrót (shortId).
  if (doc.linkedEntityId) row.lastElementChild.title = doc.linkedEntityId;
  const actions = document.createElement("td");
  actions.className = "row-actions";
  const show = document.createElement("button");
  show.type = "button";
  show.dataset.id = doc.id;
  show.textContent = "Szczegóły";
  // #124: nazwa z tytułem odróżnia przyciski w liście przycisków czytnika ekranu.
  show.setAttribute("aria-label", `Szczegóły dokumentu: ${titleLabel(doc)}, dodano ${formatDateTime(doc.createdAt)}`);
  const download = document.createElement("a");
  download.textContent = "Pobierz";
  download.rel = "noopener";
  try {
    download.href = contentUrl(doc.id);
  } catch {
    download.removeAttribute("href");
  }
  actions.append(show, download);
  row.append(actions);
  return row;
}

function renderList() {
  listBody.replaceChildren(...state.documents.map(documentRow));
  const count = state.documents.length;
  listSummary.textContent = documentCountLabel(count);
  tableWrap.hidden = count === 0;
  if (count === 0) setMessage(listMessage, "Brak dostępnych dokumentów dla wybranych filtrów.");
}

async function loadList({ append = false } = {}) {
  if (!append) {
    const data = new FormData(filtersForm);
    state.query = {
      schoolYearId: String(data.get("schoolYearId") ?? ""),
      kind: String(data.get("kind") ?? ""),
      classId: String(data.get("classId") ?? ""),
      category: String(data.get("category") ?? ""),
      q: String(data.get("q") ?? ""),
      includeInactive: data.get("includeInactive") === "on",
      validationOutdated: data.get("validationOutdated") === "on",
    };
    state.cursor = "";
  }
  let url;
  try {
    url = buildListUrl({ ...state.query, limit: LIST_LIMIT, cursor: append ? state.cursor : "" });
  } catch (error) {
    setMessage(listMessage, error.message, "error");
    return;
  }
  setMessage(listMessage, "Wczytywanie…");
  filtersForm.querySelector("button").disabled = true;
  loadMore.disabled = true;
  try {
    const result = await getJson(url);
    const items = Array.isArray(result.documents) ? result.documents : [];
    state.documents = append ? [...state.documents, ...items] : items;
    state.cursor = result.nextCursor ?? "";
    setMessage(listMessage, "");
    renderList();
    // Serwer podaje kursor następnej strony; brak kursora = koniec listy.
    loadMore.hidden = !state.cursor;
  } catch (error) {
    setMessage(listMessage, error.message, "error");
    if (!append) {
      state.documents = [];
      tableWrap.hidden = true;
      loadMore.hidden = true;
      listSummary.textContent = "Nie udało się pobrać listy.";
    }
  } finally {
    filtersForm.querySelector("button").disabled = false;
    loadMore.disabled = false;
  }
}

function renderDescriptionHistory(history) {
  const rows = (history ?? []).flatMap((entry) => {
    const dt = document.createElement("dt");
    dt.textContent = `Wersja ${entry.revisionNo}, ${formatDateTime(entry.createdAt)}`;
    const dd = document.createElement("dd");
    dd.textContent = `${entry.title} (${categoryLabel({ category: entry.category })})`;
    return [dt, dd];
  });
  descriptionHistory.replaceChildren(...rows);
  if (!rows.length) {
    const dt = document.createElement("dt");
    dt.textContent = "Historia opisu";
    const dd = document.createElement("dd");
    dd.textContent = "Brak wpisu — dokument nie ma jeszcze tytułu.";
    descriptionHistory.replaceChildren(dt, dd);
  }
}

async function showDetails(id, trigger) {
  details.hidden = false;
  detailsList.replaceChildren();
  descriptionHistory.replaceChildren();
  descriptionForm.reset();
  setMessage(descriptionStatus, "");
  state.currentDocumentId = null;
  state.currentDocument = null;
  clearPreview();
  detailsPreview.hidden = true;
  state.descriptionPending = null;
  resetStatusPanel();
  // Link pobierania nigdy nie wskazuje poprzedniego dokumentu (#192).
  detailsDownload.hidden = true;
  detailsDownload.removeAttribute("href");
  const request = Symbol(id);
  state.detailsRequest = request;
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = "Wczytywanie metadanych…";
  detailsList.replaceChildren(status);
  // #124: odświeżenie szczegółów bez przycisku (po zapisie opisu albo zmianie
  // stanu) zachowuje dotychczasowy cel powrotu fokusu zamiast go gubić.
  if (trigger) details.returnFocus = trigger;
  details.focus();
  try {
    const result = await getJson(metadataUrl(id));
    if (state.detailsRequest !== request) return;
    const rows = metadataRows(result.document).flatMap(([label, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      return [dt, dd];
    });
    detailsList.replaceChildren(...rows);
    detailsDownload.href = contentUrl(result.document.id);
    detailsDownload.hidden = false;
    detailsPreview.hidden = previewKind(result.document.mimeType) === null;
    state.currentDocumentId = result.document.id;
    state.currentDocument = result.document;
    renderDescriptionHistory(result.descriptionHistory);
    await renderStatusPanel(result, request);
  } catch (error) {
    if (state.detailsRequest !== request) return;
    status.className = "message error";
    status.textContent = error.message;
  }
}

// Wersje i stan (#82). Łańcuch zastąpień budujemy z metadanych sąsiednich dokumentów
// (każdy odczyt autoryzuje serwer; brak dostępu kończy łańcuch). Limit kroków chroni przed
// nadmiarem żądań.
const CHAIN_LIMIT = 10;

function resetStatusPanel() {
  state.statusAction = null;
  state.statusPending = null;
  versionHistory.replaceChildren();
  statusActions.hidden = true;
  statusForm.hidden = true;
  statusForm.reset();
  setMessage(statusMessage, "");
}

async function fetchChainNeighbour(id) {
  try {
    return await getJson(metadataUrl(id));
  } catch {
    return null;
  }
}

async function loadChain(current) {
  const before = [];
  let previous = current.supersedes;
  while (previous && before.length < CHAIN_LIMIT) {
    const found = await fetchChainNeighbour(previous);
    if (!found) break;
    before.unshift({ doc: found.document });
    previous = found.supersedes;
  }
  const after = [];
  let next = current.document.replacementDocumentId;
  while (next && after.length < CHAIN_LIMIT) {
    const found = await fetchChainNeighbour(next);
    if (!found) break;
    after.push({ doc: found.document });
    next = found.document.replacementDocumentId;
  }
  return [...before, { doc: current.document, current: true }, ...after];
}

function versionItem({ doc: raw, current }) {
  const doc = normalizeDocument(raw);
  const item = document.createElement("li");
  if (current) {
    item.className = "current";
    item.setAttribute("aria-current", "true");
  }
  item.append(`${titleLabel(doc)} — ${statusLabel(doc)}, dodano ${formatDateTime(doc.createdAt)}${current ? " (ten dokument)" : ""}`);
  if (!current) {
    const open = document.createElement("button");
    open.type = "button";
    open.dataset.id = doc.id;
    open.textContent = "Otwórz";
    open.setAttribute("aria-label", `Otwórz wersję z ${formatDateTime(doc.createdAt)}`);
    item.append(open);
  }
  return item;
}

async function renderStatusPanel(result, request) {
  // Widok Komisji Rewizyjnej nie ma bloku wersji i zmiany stanu (usunięty z DOM); łańcuch zastąpień
  // nie jest też czytany sąsiednimi odczytami metadanych.
  if (state.auditView) return;
  const doc = normalizeDocument(result.document);
  const chain = await loadChain({ document: result.document, supersedes: result.supersedes ?? null });
  if (state.detailsRequest !== request) return;
  const alone = chain.length === 1;
  versionHistory.replaceChildren(...(alone
    ? [versionItem(chain[0])]
    : chain.map(versionItem)));
  if (alone && doc.status === "active") {
    const note = document.createElement("li");
    note.textContent = "Brak innych wersji tego dokumentu.";
    versionHistory.append(note);
  }
  if (doc.status !== "active") {
    setMessage(statusMessage, doc.status === "voided"
      ? "Dokument jest unieważniony. Plik zostaje w archiwum."
      : "Dokument jest zastąpiony nowszą wersją. Plik zostaje w archiwum.");
  }
  statusActions.hidden = !canChangeStatus(state.grants, doc);
}

function openStatusForm(action) {
  const doc = state.currentDocument && normalizeDocument(state.currentDocument);
  if (!doc) return;
  state.statusAction = action;
  state.statusPending = null;
  statusForm.hidden = false;
  byId("status-replacement-field").hidden = action !== "supersede";
  const select = byId("status-replacement");
  select.replaceChildren();
  const hint = byId("status-replacement-hint");
  hint.textContent = "";
  if (action === "supersede") {
    const candidates = replacementCandidates(state.documents, doc);
    select.append(new Option("Wybierz…", ""));
    for (const other of candidates) select.append(new Option(`${titleLabel(other)} — dodano ${formatDateTime(other.createdAt)}`, other.id));
    hint.textContent = candidates.length
      ? "Dokument zastępujący musi być już przesłany, aktualny i mieć ten sam rodzaj, rok szkolny oraz klasę."
      : "Najpierw prześlij poprawiony dokument (ten sam rodzaj, rok i klasa), a potem odśwież listę i wróć tutaj.";
  }
  byId("status-submit").disabled = false;
  setMessage(statusMessage, "");
  (action === "supersede" ? select : byId("status-reason")).focus();
}

function closeStatusForm() {
  state.statusAction = null;
  state.statusPending = null;
  statusForm.hidden = true;
  statusForm.reset();
}

byId("status-supersede").addEventListener("click", () => openStatusForm("supersede"));
byId("status-void").addEventListener("click", () => openStatusForm("void"));
byId("status-cancel").addEventListener("click", () => {
  closeStatusForm();
  setMessage(statusMessage, "");
});
versionHistory.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-id]");
  if (button) showDetails(button.dataset.id, details.returnFocus);
});

statusForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const action = state.statusAction;
  const id = state.currentDocumentId;
  const doc = state.currentDocument && normalizeDocument(state.currentDocument);
  if (!action || !id || !doc) return;
  const reason = validateStatusReason(byId("status-reason").value);
  if (!reason.ok) {
    setMessage(statusMessage, reason.error, "error");
    return;
  }
  const replacementId = action === "supersede" ? byId("status-replacement").value : null;
  if (action === "supersede" && !replacementId) {
    setMessage(statusMessage, "Wybierz dokument zastępujący.", "error");
    return;
  }
  const replacement = replacementId ? state.documents.map(normalizeDocument).find((other) => other.id === replacementId) : null;
  // Okno potwierdzenia (wspólny komponent, #136): operacja jest trwała w panelu.
  const confirmed = await confirmAction(statusConfirmation(action, titleLabel(doc), replacement ? titleLabel(replacement) : "", doc.kind));
  if (!confirmed) return;

  // Te same dane = ponowienie z tym samym kluczem idempotencji (podwójne kliknięcie, błąd sieci).
  const fingerprint = JSON.stringify([action, id, replacementId, reason.value]);
  if (state.statusPending?.fingerprint !== fingerprint) {
    try {
      state.statusPending = { fingerprint, key: makeIdempotencyKey() };
    } catch (error) {
      setMessage(statusMessage, error.message, "error");
      return;
    }
  }
  const submit = byId("status-submit");
  submit.disabled = true;
  setMessage(statusMessage, "Zapisywanie…");
  try {
    const req = buildStatusRequest(action, id, { reason: reason.value, replacementDocumentId: replacementId }, state.statusPending.key);
    const result = await getJson(req.url, { method: req.method, body: req.body, idempotencyKey: req.idempotencyKey });
    state.statusPending = null;
    const text = result.replayed
      ? "Ta zmiana była już zapisana wcześniej — nie utworzono duplikatu."
      : action === "void" ? "Dokument unieważniony. Plik zostaje w archiwum." : "Dokument zastąpiony. Plik zostaje w archiwum.";
    closeStatusForm();
    await showDetails(id);
    setMessage(statusMessage, text, "success");
    if (state.query) loadList();
  } catch (error) {
    if (error.status && !isRetryable(error.status)) state.statusPending = null;
    setMessage(statusMessage, error.message, "error");
  } finally {
    submit.disabled = false;
  }
});

function clearPreview() {
  previewToken += 1;
  pdfPreview?.destroy();
  pdfPreview = null;
  previewImage.hidden = true;
  previewImage.removeAttribute("src");
  previewPdf.hidden = true;
  previewPdf.replaceChildren();
  previewArea.hidden = true;
  previewMessage.textContent = "";
}

function previewFailure(text) {
  previewMessage.className = "message error";
  previewMessage.textContent = text;
}

const PREVIEW_FAILED = "Nie udało się wczytać podglądu. Sesja mogła wygasnąć, brak dostępu albo plik nie przechodzi bieżącej kontroli struktury — spróbuj pobrać plik.";

// PDF (#89, PDF.js): bajty z autoryzowanego endpointu (purpose=preview, zdarzenie
// document.viewed), render stron do canvas biblioteką dołączoną do panelu — bez ramki,
// bez wbudowanego czytnika przeglądarki.
async function showPdf(id, token) {
  let blob;
  try {
    // Wspólny klient (#99): 401/403 MFA → /login/, błędy JSON jak w reszcie panelu.
    ({ blob } = await getJson(pdfPreviewUrl(id), { binary: true, cache: "no-store", headers: { Accept: "application/pdf" } }));
  } catch (error) {
    if (token === previewToken) previewFailure(error instanceof ApiError ? error.message : PREVIEW_FAILED);
    return;
  }
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (token !== previewToken) return;
    previewPdf.hidden = false;
    const { mountPdfPreview } = await import("./pdf-preview.js");
    let failed = false;
    const mounted = await mountPdfPreview(previewPdf, bytes, { onError: () => { failed = true; previewFailure(PREVIEW_FAILED); } });
    if (token !== previewToken) { mounted.destroy(); return; }
    pdfPreview = mounted;
    if (!failed) previewMessage.textContent = "";
  } catch {
    if (token === previewToken) {
      previewPdf.hidden = true;
      previewFailure(PREVIEW_FAILED);
    }
  }
}

// Podgląd (#89): obraz przez <img> (inline), PDF przez PDF.js. Adres to autoryzowany
// endpoint serwera, nie token.
detailsPreview.addEventListener("click", () => {
  const id = state.currentDocumentId;
  if (!id) return;
  const kind = previewKind(state.currentDocument?.mimeType);
  clearPreview();
  if (!kind) return;
  previewArea.hidden = false;
  previewMessage.className = "message";
  previewMessage.textContent = "Wczytywanie podglądu…";
  if (kind === "pdf") {
    showPdf(id, previewToken);
    return;
  }
  previewImage.addEventListener("load", () => { previewMessage.textContent = ""; }, { once: true });
  previewImage.addEventListener("error", () => {
    previewFailure(PREVIEW_FAILED);
    previewImage.hidden = true;
  }, { once: true });
  previewImage.src = previewUrl(id);
  previewImage.hidden = false;
});

// #124: fokus wraca do „Szczegóły” tego samego dokumentu. Lista mogła zostać
// przerysowana (loadList po zmianie stanu), więc odłączony przycisk zastępuje
// jego odpowiednik w nowej liście; gdy dokumentu na liście już nie ma
// (np. unieważniony, a filtr pokazuje tylko aktualne) — nagłówek listy.
function returnFocusTarget(previous) {
  if (previous?.isConnected) return previous;
  const id = previous?.dataset?.id;
  const same = id ? [...listBody.querySelectorAll("button[data-id]")].find((button) => button.dataset.id === id) : null;
  if (same) return same;
  const heading = byId("list-title");
  heading.tabIndex = -1;
  return heading;
}

function closeDetails() {
  clearPreview();
  details.hidden = true;
  returnFocusTarget(details.returnFocus).focus();
}

descriptionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = state.currentDocumentId;
  if (!id) return;
  const data = new FormData(descriptionForm);
  const input = validateDescriptionInput(Object.fromEntries(data.entries()));
  if (!input.ok) {
    setMessage(descriptionStatus, input.error, "error");
    return;
  }
  // Ten sam dokument i te same dane = ponowienie z tym samym kluczem idempotencji.
  const fingerprint = JSON.stringify([id, input.value]);
  if (state.descriptionPending?.fingerprint !== fingerprint) {
    try {
      state.descriptionPending = { fingerprint, key: makeIdempotencyKey() };
    } catch (error) {
      setMessage(descriptionStatus, error.message, "error");
      return;
    }
  }
  setMessage(descriptionStatus, "Zapisywanie…");
  byId("description-submit").disabled = true;
  try {
    const req = buildDescriptionRequest(id, input.value, state.descriptionPending.key);
    const result = await getJson(req.url, { method: req.method, body: req.body, idempotencyKey: req.idempotencyKey });
    state.descriptionPending = null;
    setMessage(
      descriptionStatus,
      result.replayed ? "Opis był już zapisany wcześniej — nie utworzono duplikatu." : "Zapisano opis.",
      "success",
    );
    showDetails(id);
  } catch (error) {
    setMessage(descriptionStatus, error.message, "error");
  } finally {
    byId("description-submit").disabled = false;
  }
});

filtersForm.addEventListener("submit", (event) => {
  event.preventDefault();
  loadList();
});
loadMore.addEventListener("click", () => loadList({ append: true }));
listBody.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-id]");
  if (button) showDetails(button.dataset.id, button);
});
byId("close-details").addEventListener("click", closeDetails);
details.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDetails();
});

// Klasy z listy (GET /api/classes — serwer zawęża do zakresu roli), zamiast wpisywania
// identyfikatora (#128). Błąd 403 (rola bez dostępu do klas) daje pustą listę.
const classApi = (url) => api(url);
function syncFilterClassChoice() {
  if (state.auditView) return Promise.resolve();
  return fillClassSelect(byId("filter-class"), classApi, yearInput.value, {
    optional: true, emptyLabel: "Wszystkie klasy", selected: byId("filter-class").value,
  });
}
function syncUploadClassChoice() {
  return fillClassSelect(byId("upload-class"), classApi, byId("upload-year").value, { selected: byId("upload-class").value });
}
yearInput.addEventListener("change", syncFilterClassChoice);
byId("upload-year").addEventListener("change", syncUploadClassChoice);

// Formularz przesyłania

function syncKindFields() {
  const kind = kindSelect.value;
  kindHint.textContent = KIND_HINTS[kind] ?? "";
  classField.hidden = kind !== "class";
  linkField.hidden = kind !== "financial";
  byId("upload-class").required = kind === "class";
  if (kind !== "class") byId("upload-class").value = "";
  else syncUploadClassChoice();
  if (kind !== "financial") {
    byId("upload-link-type").value = "";
    byId("upload-link-id").value = "";
  }
}

async function readHead(file) {
  const buffer = await file.slice(0, SNIFF_BYTES).arrayBuffer();
  return new Uint8Array(buffer);
}

async function precheck() {
  const file = fileInput.files?.[0];
  if (!file) {
    fileCheck.textContent = "";
    return null;
  }
  const result = checkFile(file, await readHead(file), DEFAULT_MAX_BYTES);
  fileCheck.className = result.ok ? "hint" : "hint error";
  fileCheck.textContent = result.ok
    ? `Wybrano plik ${typeLabel(result.mime)}, ${formatBytes(file.size)}. Ostateczną kontrolę wykona serwer.`
    : result.error;
  return result;
}

function sendUpload(request, file) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open(request.method, request.url);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Accept", "application/json");
    for (const [name, value] of Object.entries(request.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) progress.value = Math.round((event.loaded / event.total) * 100);
    });
    xhr.addEventListener("load", () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { body = null; }
      // 401 / 403 MFA: ten sam powrót przez /login/ co w kliencie API (#99).
      if (xhr.status === 401 || xhr.status === 403) handleAuthFailure(xhr.status, body?.error);
      resolve({ status: xhr.status, body });
    });
    xhr.addEventListener("error", () => resolve({ status: 0, body: null }));
    xhr.addEventListener("abort", () => resolve({ status: 0, body: null }));
    xhr.send(file);
  });
}

function setUploading(busy) {
  state.uploading = busy;
  submitButton.disabled = busy;
  uploadForm.setAttribute("aria-busy", String(busy));
  progress.hidden = !busy;
  if (busy) progress.value = 0;
}

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.uploading) return;
  const file = fileInput.files?.[0];
  const data = new FormData(uploadForm);
  const meta = validateUploadMeta(Object.fromEntries(data.entries()));
  if (!file) {
    setMessage(uploadStatus, "Wybierz plik.", "error");
    fileInput.focus();
    return;
  }
  if (!meta.ok) {
    setMessage(uploadStatus, meta.error, "error");
    return;
  }
  const check = await precheck();
  if (!check?.ok) {
    setMessage(uploadStatus, check?.error ?? "Wybierz plik.", "error");
    fileInput.focus();
    return;
  }

  // Ten sam plik i te same dane = ponowienie z tym samym kluczem idempotencji.
  const fingerprint = submissionFingerprint(file, meta.value);
  if (state.pending?.fingerprint !== fingerprint) {
    try {
      state.pending = { fingerprint, key: makeIdempotencyKey() };
    } catch (error) {
      setMessage(uploadStatus, error.message, "error");
      return;
    }
  }
  const retry = Boolean(state.pending.attempted);
  state.pending.attempted = true;

  setUploading(true);
  setMessage(uploadStatus, retry ? "Ponawianie przesyłania…" : "Przesyłanie…");
  const { status, body } = await sendUpload(buildUploadRequest(meta.value, check.mime, state.pending.key), file);
  setUploading(false);

  if (status === 200 || status === 201) {
    state.pending = null;
    const doc = normalizeDocument(body?.document);
    setMessage(
      uploadStatus,
      body?.replayed
        ? "Dokument był już zapisany wcześniej — nie utworzono duplikatu."
        : `Zapisano dokument (${KIND_LABELS[doc.kind] ?? "dokument"}, ${formatBytes(doc.byteSize)}).`,
      "success",
    );
    uploadForm.reset();
    fileCheck.textContent = "";
    syncKindFields();
    if (state.query && state.query.schoolYearId === doc.schoolYearId) loadList();
    return;
  }
  const text = apiErrorText(status, body);
  if (isRetryable(status)) {
    setMessage(uploadStatus, `${text} Kliknij „Prześlij dokument”, aby ponowić tę samą operację.`, "error");
  } else {
    // Błąd trwały: kolejna próba to już nowa operacja.
    state.pending = null;
    setMessage(uploadStatus, text, "error");
  }
});

fileInput.addEventListener("change", () => {
  setMessage(uploadStatus, "");
  precheck();
});
kindSelect.addEventListener("change", syncKindFields);
syncKindFields();

// D-09 (#137): widok tylko do odczytu Komisji Rewizyjnej. Usuwa z DOM formularz przesyłania, opis, wersje
// i zmianę stanu oraz filtry spoza zakresu audit; zawęża rodzaj do dowodów finansowych, a kategorie do
// czytelnych dla audit. Zostaje lista, metadane, podgląd i pobranie. Idempotentna.
function applyAuditView() {
  state.auditView = true;
  for (const id of AUDIT_REMOVED_ELEMENT_IDS) byId(id)?.remove();
  const kind = byId("filter-kind");
  for (const option of [...kind.options]) if (option.value !== AUDIT_DOCUMENT_KIND) option.remove();
  kind.value = AUDIT_DOCUMENT_KIND;
  const category = byId("filter-category");
  for (const option of [...category.options]) if (option.value && !AUDIT_READABLE_CATEGORIES.includes(option.value)) option.remove();
  byId("audit-notice").hidden = false;
}

// #225: rodzaje dokumentów w formularzu według ról konta (/api/access). Sesja przed MFA
// dostaje puste grants — wtedy formularz przesyłania jest ukryty.
async function applyAccess() {
  let grants;
  try {
    const access = await getJson("/api/access");
    grants = Array.isArray(access.grants) ? access.grants : [];
    state.grants = grants;
  } catch {
    // Bez informacji o rolach formularz zostaje; serwer i tak autoryzuje. Listy roku
    // dostają rok z heurystyki daty, żeby panel nie został z pustym wyborem.
    fillYearSelect(yearInput, []);
    fillYearSelect(byId("upload-year"), []);
    return;
  }
  if (await auditViewReady) {
    applyAuditView();
    fillYearSelect(yearInput, grants);
    if (yearInput.value) await loadList();
    return;
  }
  // Rok domyślny (puste ekrany bez klikania „Pokaż”): najnowszy z przydziałów,
  // awaryjnie heurystyka daty (shared/school-year.js). Bez tego pole zostaje puste,
  // dopóki użytkownik sam nie wpisze roku. Użytkownik nadal może go zmienić.
  fillYearSelect(byId("upload-year"), grants);
  await syncUploadClassChoice();
  if (!yearInput.value.trim()) {
    fillYearSelect(yearInput, grants);
    await syncFilterClassChoice();
    if (yearInput.value) await loadList();
  }
  const allowed = new Set(uploadableKinds(grants));
  for (const option of [...kindSelect.options]) {
    if (option.value && !allowed.has(option.value)) option.remove();
  }
  if (allowed.size === 1) kindSelect.value = [...allowed][0];
  syncKindFields();
  if (allowed.size === 0) {
    const note = document.createElement("p");
    note.className = "message";
    note.textContent = "To konto nie może przesyłać dokumentów.";
    uploadForm.replaceWith(note);
  }
}
applyAccess();
