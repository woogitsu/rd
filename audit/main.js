import {
  buildSections,
  describeApiError,
  formatDate,
  hasReportAccess,
  isValidId,
  reportUrl,
} from "./core.js";
import { api as apiRequest } from "../shared/api.js";
import { formatSchoolYear, initialSchoolYearId, yearOptionsHtml, yearsFromGrants } from "../shared/school-year.js";
import { mountShell } from "../shared/shell.js";
import "../shared/shell.css";

mountShell();

const api = apiRequest;
const byId = (id) => document.getElementById(id);

const state = { grants: [], loading: false };

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
    byId("report-sections").replaceChildren(...buildSections(report).map(sectionElement));
    reportSection.hidden = false;
  } catch (error) {
    reportSection.hidden = true;
    setMessage(`Nie udało się pobrać raportu: ${describeApiError(error.status, error.code) ?? error.message}`, true);
  } finally {
    state.loading = false;
    filtersForm.querySelector("button").disabled = false;
  }
}

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
