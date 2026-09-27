import {
  DEFAULT_MAX_BYTES,
  KIND_HINTS,
  KIND_LABELS,
  LIST_LIMIT,
  SNIFF_BYTES,
  buildListUrl,
  buildUploadRequest,
  checkFile,
  contentUrl,
  errorMessage,
  formatBytes,
  formatDateTime,
  isRetryable,
  linkLabel,
  makeIdempotencyKey,
  metadataRows,
  metadataUrl,
  normalizeDocument,
  submissionFingerprint,
  typeLabel,
  validateUploadMeta,
} from "./core.js";

const byId = (id) => document.getElementById(id);
const state = { documents: [], query: null, offset: 0, pending: null, uploading: false };

const filtersForm = byId("filters-form");
const listBody = byId("documents-body");
const listMessage = byId("list-message");
const listSummary = byId("list-summary");
const tableWrap = byId("table-wrap");
const loadMore = byId("load-more");
const details = byId("details");
const detailsList = byId("details-list");
const detailsDownload = byId("details-download");
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
    super(errorMessage(status, body));
    this.status = status;
  }
}

async function getJson(url) {
  let response;
  try {
    response = await fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } });
  } catch {
    throw new ApiError(0, null);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, body);
  return body ?? {};
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
    cell("Dodano", formatDateTime(doc.createdAt)),
    cell("Rodzaj", doc.kind ? KIND_LABELS[doc.kind] : "Nieznany"),
    cell("Klasa", doc.classId ?? "—"),
    cell("Typ", typeLabel(doc.mimeType)),
    cell("Rozmiar", doc.byteSize === null ? "—" : formatBytes(doc.byteSize), "num"),
    cell("Powiązanie", linkLabel(doc)),
  );
  const actions = document.createElement("td");
  actions.className = "row-actions";
  const show = document.createElement("button");
  show.type = "button";
  show.dataset.id = doc.id;
  show.textContent = "Szczegóły";
  show.setAttribute("aria-label", `Szczegóły dokumentu z ${formatDateTime(doc.createdAt)}`);
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
  listSummary.textContent = count === 1 ? "1 dokument" : `Dokumenty: ${count}`;
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
    };
    state.offset = 0;
  }
  let url;
  try {
    url = buildListUrl({ ...state.query, limit: LIST_LIMIT, offset: state.offset });
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
    const limit = Number(result.limit) || LIST_LIMIT;
    state.offset += limit;
    setMessage(listMessage, "");
    renderList();
    // Serwer filtruje wiersze po LIMIT, więc pełna strona to jedyny sygnał dalszych wyników.
    loadMore.hidden = items.length < limit;
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

async function showDetails(id, trigger) {
  details.hidden = false;
  detailsList.replaceChildren();
  detailsDownload.hidden = true;
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = "Wczytywanie metadanych…";
  detailsList.replaceChildren(status);
  details.returnFocus = trigger;
  details.focus();
  try {
    const result = await getJson(metadataUrl(id));
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
  } catch (error) {
    status.className = "message error";
    status.textContent = error.message;
  }
}

function closeDetails() {
  details.hidden = true;
  details.returnFocus?.focus?.();
}

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

// Formularz przesyłania

function syncKindFields() {
  const kind = kindSelect.value;
  kindHint.textContent = KIND_HINTS[kind] ?? "";
  classField.hidden = kind !== "class";
  linkField.hidden = kind !== "financial";
  byId("upload-class").required = kind === "class";
  if (kind !== "class") byId("upload-class").value = "";
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
  const text = errorMessage(status, body);
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
