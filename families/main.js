import {
  buildContactPatch,
  canEditFamilies,
  classHref,
  ERROR_MESSAGES,
  filterStudentsByName,
  formatCents,
  fullName,
  groupClassesByYear,
  householdHref,
  parseRoute,
  sortStudentsByName,
} from "./core.js";
import { api as apiRequest } from "../shared/api.js";
import { mountShell } from "../shared/shell.js";
import "../shared/shell.css";

mountShell();

const byId = (id) => document.getElementById(id);
const state = { classes: null, canEdit: false, currentClass: null, currentHousehold: null, classStudents: [], studentQuery: "" };
const views = { classes: byId("classes-view"), class: byId("class-view"), household: byId("household-view") };
const message = byId("message");
const breadcrumbs = byId("breadcrumbs");
const contactDialog = byId("contact-dialog");
const enrollmentDialog = byId("enrollment-dialog");

// Wspólny klient (#99): polskie komunikaty, 401/403 MFA → /login/ z powrotem.
const api = (url, options = {}) => apiRequest(url, { ...options, messages: ERROR_MESSAGES });

function showMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle("error", isError);
}

function cell(content, className = "") {
  const td = document.createElement("td");
  if (content instanceof Node) td.append(content);
  else td.textContent = content;
  if (className) td.className = className;
  return td;
}

function link(text, href) {
  const a = document.createElement("a");
  a.href = href;
  a.textContent = text;
  return a;
}

function button(text, onClick) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.addEventListener("click", onClick);
  return element;
}

function setBreadcrumbs(items) {
  breadcrumbs.replaceChildren(...items.flatMap((item, index) => {
    const node = item.href ? link(item.text, item.href) : Object.assign(document.createElement("span"), { textContent: item.text });
    return index ? [document.createTextNode(" / "), node] : [node];
  }));
}

function showView(name) {
  for (const [key, element] of Object.entries(views)) element.hidden = key !== name;
}

async function loadClasses() {
  if (!state.classes) state.classes = (await api("/api/classes")).classes;
  return state.classes;
}

async function renderClasses() {
  const classes = await loadClasses();
  setBreadcrumbs([{ text: "Klasy" }]);
  const years = byId("years");
  years.replaceChildren(...groupClassesByYear(classes).map((group) => {
    const section = document.createElement("section");
    section.className = "card";
    const heading = document.createElement("h2");
    heading.textContent = `Rok szkolny ${group.label}`;
    const table = document.createElement("table");
    table.innerHTML = "<thead><tr><th>Klasa</th><th class=\"amount\">Uczniowie</th></tr></thead>";
    const body = document.createElement("tbody");
    body.append(...group.classes.map((item) => {
      const row = document.createElement("tr");
      row.append(cell(link(item.name, classHref(item.id))), cell(String(item.studentCount), "amount"));
      return row;
    }));
    table.append(body);
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    wrap.append(table);
    section.append(heading, wrap);
    return section;
  }));
  byId("classes-empty").hidden = classes.length > 0;
  showView("classes");
}

function householdLinks(households) {
  const fragment = document.createDocumentFragment();
  households.forEach((household, index) => {
    if (index) fragment.append(", ");
    fragment.append(link(household.householdId, householdHref(household.householdId)));
    if (household.isPrimary) fragment.append(" (główne)");
  });
  return fragment;
}

function renderStudentRows() {
  const filtered = filterStudentsByName(state.classStudents, state.studentQuery);
  byId("students-body").replaceChildren(...filtered.map((student) => {
    const row = document.createElement("tr");
    const actions = cell("", "row-actions");
    if (state.canEdit) actions.append(button("Zmień klasę", () => openEnrollment(student, state.currentClass)));
    row.append(cell(fullName(student)), cell(householdLinks(student.households)), actions);
    return row;
  }));
  const total = state.classStudents.length;
  byId("students-empty").hidden = filtered.length > 0;
  if (filtered.length === 0 && state.studentQuery) {
    byId("students-empty").textContent = `Brak uczniów pasujących do „${state.studentQuery}”.`;
  } else {
    byId("students-empty").textContent = "Brak uczniów przypisanych do tej klasy.";
  }
  byId("student-search-count").textContent =
    state.studentQuery ? `${filtered.length} z ${total} uczniów` : `${total} uczniów`;
}

async function renderClass(classId) {
  const data = await api(`/api/classes/${encodeURIComponent(classId)}/students`);
  state.currentClass = data.class;
  state.classStudents = sortStudentsByName(data.students);
  state.studentQuery = "";
  byId("student-search").value = "";
  setBreadcrumbs([{ text: "Klasy", href: "#/" }, { text: data.class.name }]);
  byId("class-title").textContent = `Klasa ${data.class.name}`;
  byId("class-year").textContent = `Rok szkolny ${data.class.schoolYearLabel}`;
  renderStudentRows();
  showView("class");
}

byId("student-search-form").addEventListener("submit", (event) => event.preventDefault());
byId("student-search").addEventListener("input", (event) => {
  state.studentQuery = event.target.value;
  renderStudentRows();
});

async function renderHousehold(householdId) {
  const data = await api(`/api/households/${encodeURIComponent(householdId)}`);
  state.currentHousehold = data;
  const crumbs = [{ text: "Klasy", href: "#/" }];
  if (state.currentClass) crumbs.push({ text: state.currentClass.name, href: classHref(state.currentClass.id) });
  crumbs.push({ text: `Gospodarstwo ${data.household.id}` });
  setBreadcrumbs(crumbs);
  byId("household-title").textContent = `Gospodarstwo ${data.household.id}${data.household.archived ? " (archiwalne)" : ""}`;
  byId("household-students").replaceChildren(...data.students.map((student) => {
    const row = document.createElement("tr");
    const classes = document.createDocumentFragment();
    student.classes.forEach((item, index) => {
      if (index) classes.append(", ");
      classes.append(link(item.className, classHref(item.classId)));
    });
    row.append(
      cell(fullName(student)),
      cell(classes),
      cell(student.isPrimaryHousehold === undefined ? "—" : student.isPrimaryHousehold ? "główne" : "dodatkowe"),
      cell(student.otherHouseholds.length ? householdLinks(student.otherHouseholds) : "—"),
    );
    return row;
  }));
  byId("household-guardians").replaceChildren(...data.guardians.map((guardian) => {
    const row = document.createElement("tr");
    const actions = cell("", "row-actions");
    if (state.canEdit) actions.append(button("Edytuj kontakt", () => openContact(guardian)));
    row.append(
      cell(fullName(guardian)),
      cell(guardian.email ?? (guardian.contactAllowed ? "—" : "ukryty")),
      cell(guardian.contactAllowed ? "tak" : "nie"),
      actions,
    );
    return row;
  }));
  byId("guardians-empty").hidden = data.guardians.length > 0;
  const payments = byId("payments-card");
  payments.hidden = !Array.isArray(data.paymentTotals);
  if (Array.isArray(data.paymentTotals)) {
    byId("payments-body").replaceChildren(...data.paymentTotals.map((total) => {
      const row = document.createElement("tr");
      row.append(cell(total.schoolYearId), cell(String(total.paymentCount), "amount"), cell(formatCents(total.netAmountCents), "amount"));
      return row;
    }));
    byId("payments-empty").hidden = data.paymentTotals.length > 0;
  }
  showView("household");
}

function openContact(guardian) {
  const form = contactDialog.querySelector("form");
  form.reset();
  form.elements.guardianId.value = guardian.id;
  form.elements.email.value = guardian.email ?? "";
  form.elements.contactAllowed.checked = guardian.contactAllowed;
  form.querySelector(".context").textContent = fullName(guardian);
  form.querySelector(".form-error").textContent = "";
  contactDialog.guardian = guardian;
  contactDialog.showModal();
}

function localDate() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

async function openEnrollment(student, currentClass) {
  const form = enrollmentDialog.querySelector("form");
  form.reset();
  form.elements.studentId.value = student.id;
  form.elements.schoolYearId.value = currentClass.schoolYearId;
  form.elements.effectiveOn.value = localDate();
  form.querySelector(".context").textContent = `${fullName(student)} — obecnie ${currentClass.name}`;
  form.querySelector(".form-error").textContent = "";
  const classes = (await loadClasses()).filter((item) => item.schoolYearId === currentClass.schoolYearId && item.id !== currentClass.id);
  form.elements.classId.replaceChildren(...classes.map((item) => new Option(item.name, item.id)));
  enrollmentDialog.showModal();
}

async function submitDialog(dialog, event, send) {
  if (event.submitter?.value !== "submit") return;
  event.preventDefault();
  const form = dialog.querySelector("form");
  const error = form.querySelector(".form-error");
  const submit = form.querySelector("button.primary");
  submit.disabled = true;
  error.textContent = "";
  try {
    await send(form);
    dialog.close();
    await route();
  } catch (failure) {
    error.textContent = failure.message;
  } finally {
    submit.disabled = false;
  }
}

contactDialog.querySelector("form").addEventListener("submit", (event) => submitDialog(contactDialog, event, async (form) => {
  const result = buildContactPatch({
    email: form.elements.email.value,
    contactAllowed: form.elements.contactAllowed.checked,
    reason: form.elements.reason.value,
  }, contactDialog.guardian);
  if (result.error) throw new Error(result.error);
  await api(`/api/guardians/${encodeURIComponent(form.elements.guardianId.value)}/contact`, {
    method: "PATCH", body: JSON.stringify(result.patch),
  });
  showMessage("Zapisano zmianę kontaktu.");
}));

enrollmentDialog.querySelector("form").addEventListener("submit", (event) => submitDialog(enrollmentDialog, event, async (form) => {
  if (!form.elements.classId.value) throw new Error("Brak innej klasy w tym roku.");
  await api(`/api/students/${encodeURIComponent(form.elements.studentId.value)}/enrollments`, {
    method: "POST",
    body: JSON.stringify({
      schoolYearId: form.elements.schoolYearId.value,
      classId: form.elements.classId.value,
      effectiveOn: form.elements.effectiveOn.value,
      reason: form.elements.reason.value,
    }),
  });
  state.classes = null;
  showMessage("Zapisano zmianę klasy.");
}));

async function route() {
  const target = parseRoute(location.hash);
  try {
    if (target.view === "class") await renderClass(target.id);
    else if (target.view === "household") await renderHousehold(target.id);
    else await renderClasses();
  } catch (error) {
    showView(null);
    showMessage(error.message, true);
  }
}

window.addEventListener("hashchange", () => { showMessage(""); route(); });

(async () => {
  try {
    state.canEdit = canEditFamilies((await api("/api/access")).grants);
  } catch {
    state.canEdit = false;
  }
  await route();
})();
