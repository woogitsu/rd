import {
  buildReviewRows,
  buildSections,
  canAnswerReviews,
  canWriteReviews,
  describeApiError,
  formatDate,
  hasReportAccess,
  isValidId,
  newIdempotencyKey,
  reportUrl,
  reviewReplyUrl,
  reviewsUrl,
  reviewSummary,
} from "./core.js";
import { api as apiRequest } from "../shared/api.js";
import { formatSchoolYear, initialSchoolYearId, yearOptionsHtml, yearsFromGrants } from "../shared/school-year.js";
import { mountShell } from "../shared/shell.js";
import "../shared/shell.css";

mountShell();

const api = apiRequest;
const byId = (id) => document.getElementById(id);

const state = { grants: [], loading: false, schoolYearId: "", pending: new Map() };

const filtersForm = byId("filters-form");
const yearSelect = byId("school-year-id");
const message = byId("message");
const reportSection = byId("report-section");

function setMessage(text, isError = false) {
  message.textContent = text;
  message.className = isError ? "message error" : "message";
}

function sectionElement(section, index) {
  const wrapper = document.createElement("section");
  const headingId = `section-${section.id}`;
  wrapper.setAttribute("aria-labelledby", headingId);
  const heading = document.createElement("h3");
  heading.id = headingId;
  heading.textContent = `${index + 1}. ${section.title}`;
  wrapper.append(heading);

  if (section.rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = section.empty ?? "Brak danych.";
    wrapper.append(empty);
  } else {
    const numeric = new Set(section.numeric ?? []);
    const region = document.createElement("div");
    region.className = "table-wrap";
    region.setAttribute("role", "region");
    region.setAttribute("aria-labelledby", headingId);
    region.tabIndex = 0;
    const table = document.createElement("table");
    const caption = document.createElement("caption");
    caption.className = "sr-only";
    caption.textContent = section.title;
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    section.headers.forEach((label, column) => {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = label;
      if (numeric.has(column)) th.className = "amount";
      headRow.append(th);
    });
    head.append(headRow);
    const body = document.createElement("tbody");
    for (const cells of section.rows) {
      const row = document.createElement("tr");
      cells.forEach((value, column) => {
        const td = document.createElement("td");
        // Komórka z identyfikatorem (idCell): skrót w treści, pełna wartość w podpowiedzi.
        if (value && typeof value === "object") {
          td.textContent = value.text;
          td.title = value.title;
        } else {
          td.textContent = value;
        }
        if (numeric.has(column)) td.className = "amount";
        row.append(td);
      });
      body.append(row);
    }
    table.append(caption, head, body);
    region.append(table);
    wrapper.append(region);
  }
  if (section.note) {
    const note = document.createElement("p");
    note.className = "empty";
    note.textContent = section.note;
    wrapper.append(note);
  }
  return wrapper;
}

async function showYear(value) {
  if (!isValidId(value)) { setMessage("Wybierz rok szkolny.", true); return; }
  setMessage("");
  state.loading = true;
  filtersForm.querySelector("button").disabled = true;
  try {
    const data = await api(reportUrl(value, "json"));
    const report = data.report;
    byId("report-title").textContent = `Raport dla Komisji Rewizyjnej — ${formatSchoolYear(report?.schoolYear?.label ?? value)}`;
    byId("report-meta").textContent = (report?.asOf ?? report?.generatedAt) ? `Stan na ${formatDate(report.asOf ?? report.generatedAt)} (czas Europe/Brussels)` : "";
    byId("report-html-link").href = reportUrl(value, "html");
    byId("report-xlsx-link").href = reportUrl(value, "xlsx");
    byId("report-sections").replaceChildren(...buildSections(report).map(sectionElement));
    reportSection.hidden = false;
    state.schoolYearId = value;
    await loadReviews(value);
  } catch (error) {
    reportSection.hidden = true;
    setMessage(`Nie udało się pobrać raportu: ${describeApiError(error.status, error.code) ?? error.message}`, true);
  } finally {
    state.loading = false;
    filtersForm.querySelector("button").disabled = false;
  }
}

// --- Uwagi kontroli (#137) -----------------------------------------------------

const reviewSection = byId("review-section");
const reviewMessage = byId("review-message");
const replyForm = byId("reply-form");
const noteForm = byId("note-form");
const conclusionForm = byId("conclusion-form");

function setReviewMessage(text, isError = false) {
  reviewMessage.textContent = text;
  reviewMessage.className = isError ? "message error" : "message";
}

function actionButton(label, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

function openReply(noteId, action) {
  replyForm.elements.noteId.value = noteId;
  replyForm.elements.action.value = action;
  replyForm.elements.body.value = "";
  replyForm.elements.body.required = action === "answers";
  byId("reply-title").textContent = action === "answers" ? "Odpowiedź na uwagę" : "Zamknięcie uwagi (treść opcjonalna)";
  byId("reply-submit").textContent = action === "answers" ? "Zapisz odpowiedź" : "Zamknij uwagę";
  replyForm.hidden = false;
  replyForm.elements.body.focus();
}

function reviewTable(reviews) {
  const rows = buildReviewRows(reviews);
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Brak uwag zapisanych w systemie.";
    return empty;
  }
  const mayWrite = canWriteReviews(state.grants, state.schoolYearId);
  const mayAnswer = canAnswerReviews(state.grants, state.schoolYearId);
  const region = document.createElement("div");
  region.className = "table-wrap";
  region.setAttribute("role", "region");
  region.setAttribute("aria-labelledby", "review-title");
  region.tabIndex = 0;
  const table = document.createElement("table");
  const caption = document.createElement("caption");
  caption.className = "sr-only";
  caption.textContent = "Uwagi kontroli";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Zapisano", "Rodzaj", "Dotyczy", "Treść", "Stan", "Odpowiedzi", "Zamknięcie", "Działania"]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    headRow.append(th);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const item of rows) {
    const tr = document.createElement("tr");
    for (const value of item.cells) {
      const td = document.createElement("td");
      if (value && typeof value === "object") { td.textContent = value.text; td.title = value.title; } else td.textContent = value;
      td.style.whiteSpace = "pre-wrap";
      tr.append(td);
    }
    const actions = document.createElement("td");
    actions.className = "row-actions";
    if (item.status !== "closed") {
      if (mayAnswer) actions.append(actionButton("Odpowiedz", () => openReply(item.id, "answers")));
      if (mayWrite) actions.append(actionButton("Zamknij", () => openReply(item.id, "closure")));
    }
    tr.append(actions);
    body.append(tr);
  }
  table.append(caption, head, body);
  region.append(table);
  return region;
}

async function loadReviews(schoolYearId) {
  setReviewMessage("");
  replyForm.hidden = true;
  try {
    const reviews = await api(reviewsUrl(schoolYearId));
    const summary = reviewSummary(reviews);
    byId("review-counts").textContent = summary.counts;
    byId("review-conclusion").textContent = summary.conclusion;
    byId("review-threads").replaceChildren(reviewTable(reviews));
    noteForm.hidden = !canWriteReviews(state.grants, schoolYearId);
    conclusionForm.hidden = !canWriteReviews(state.grants, schoolYearId);
    reviewSection.hidden = false;
  } catch (error) {
    reviewSection.hidden = true;
    setMessage(`Nie udało się pobrać uwag kontroli: ${describeApiError(error.status, error.code) ?? error.message}`, true);
  }
}

// Ten sam zamiar zapisu (adres + treść) dostaje ten sam klucz idempotencji,
// więc podwójne kliknięcie albo ponowienie po błędzie sieci nie dopisze drugiego wpisu.
function keyFor(url, payload) {
  const signature = `${url}\n${JSON.stringify(payload)}`;
  if (!state.pending.has(signature)) state.pending.set(signature, newIdempotencyKey());
  return { signature, key: state.pending.get(signature) };
}

async function submitReview(form, url, payload, successText) {
  const buttons = form.querySelectorAll("button");
  buttons.forEach((button) => { button.disabled = true; });
  const { signature, key } = keyFor(url, payload);
  try {
    await api(url, { method: "POST", body: payload, idempotencyKey: key });
    state.pending.delete(signature);
    form.reset();
    if (form === replyForm) form.hidden = true;
    await loadReviews(state.schoolYearId);
    setReviewMessage(successText);
  } catch (error) {
    setReviewMessage(`Nie zapisano: ${error.message}`, true);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

replyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const action = replyForm.elements.action.value;
  const text = replyForm.elements.body.value.trim();
  submitReview(replyForm, reviewReplyUrl(state.schoolYearId, replyForm.elements.noteId.value, action),
    text ? { body: text } : {}, action === "answers" ? "Odpowiedź zapisana." : "Uwaga zamknięta.");
});
byId("reply-cancel").addEventListener("click", () => { replyForm.hidden = true; });

noteForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const targetType = noteForm.elements.targetType.value;
  const targetId = targetType === "year" ? state.schoolYearId : noteForm.elements.targetId.value.trim();
  if (!isValidId(targetId)) { setReviewMessage("Podaj identyfikator wpisu lub uzgodnienia.", true); return; }
  submitReview(noteForm, reviewsUrl(state.schoolYearId, "/notes"), {
    kind: noteForm.elements.kind.value, targetType, targetId, body: noteForm.elements.body.value.trim(),
  }, "Uwaga zapisana.");
});

conclusionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitReview(conclusionForm, reviewsUrl(state.schoolYearId, "/conclusion"), { body: conclusionForm.elements.body.value.trim() }, "Wniosek zapisany.");
});

filtersForm.addEventListener("submit", (event) => {
  event.preventDefault();
  showYear(yearSelect.value);
});

async function applyAccess() {
  let access;
  try {
    access = await api("/api/access");
  } catch (error) {
    setMessage(error.message, true);
    return;
  }
  state.grants = Array.isArray(access.grants) ? access.grants : [];
  if (!hasReportAccess(state.grants)) {
    filtersForm.closest("section").hidden = true;
    byId("access-notice").hidden = false;
    return;
  }
  const years = yearsFromGrants(state.grants.filter((grant) => hasReportAccess([grant])));
  const initial = initialSchoolYearId(state.grants);
  const options = years.length ? years : [initial];
  yearSelect.innerHTML = yearOptionsHtml(options, initial);
  await showYear(yearSelect.value);
}
applyAccess();
