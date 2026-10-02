// Ekran „Szablon wiadomości z kodem weryfikacyjnym” (#140 pkt 5) w panelu Rodziny: lista wersji,
// szkic i zatwierdzenie. Logika w guardian-verify-templates-core.js; tu tylko DOM i żądania
// przez wspólny klient. Ekran niczego nie wysyła do rodziców. Blokada podwójnego kliknięcia:
// jedno żądanie naraz na szkic i na zatwierdzenie; serwer jest dodatkowo idempotentny.
import {
  TEMPLATES_URL, approveBody, approveConfirmation, approveResultMessage, approveUrl, createResultMessage, emptyText,
  failureText, statusSummary, toRows, validateDraft,
} from "./guardian-verify-templates-core.js";

const byId = (id) => document.getElementById(id);
const state = { data: null, loading: false, saving: false, approving: new Set(), ready: false };
let deps = null;

function cell(content, className = "") {
  const td = document.createElement("td");
  if (content instanceof Node) td.append(content);
  else td.textContent = content;
  if (className) td.className = className;
  return td;
}

function templateCell(row) {
  const wrap = document.createElement("div");
  const subject = document.createElement("div");
  subject.textContent = row.subject;
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Treść wiadomości";
  const body = document.createElement("pre");
  body.className = "template-body";
  body.textContent = row.bodyText;
  details.append(summary, body);
  wrap.append(subject, details);
  return wrap;
}

function renderRows() {
  const rows = toRows(state.data);
  byId("vt-body").replaceChildren(...rows.map((row) => {
    const tr = document.createElement("tr");
    const status = document.createElement("div");
    status.textContent = row.current ? `${row.statusLabel} (obowiązuje)` : row.statusLabel;
    const actions = document.createElement("div");
    actions.className = "row-actions";
    if (row.canApprove) {
      const approve = document.createElement("button");
      approve.type = "button";
      approve.textContent = "Zatwierdź";
      approve.disabled = state.approving.has(row.id);
      approve.addEventListener("click", () => openApprove(row));
      actions.append(approve);
    }
    const author = cell(row.author);
    author.title = row.authorFull;
    tr.append(cell(String(row.version ?? "—")), cell(status), cell(templateCell(row)), author, cell(row.createdAt),
      cell(row.approver === "—" ? "—" : `${row.approver}, ${row.approvedAt}`), cell(row.hashShort), cell(actions));
    return tr;
  }));
  byId("vt-summary").textContent = state.data ? statusSummary(state.data) : "";
  byId("vt-empty").textContent = emptyText(state.data);
  byId("vt-empty").hidden = !emptyText(state.data);
}

async function load() {
  if (state.loading) return;
  state.loading = true;
  const error = byId("vt-error");
  error.textContent = "";
  byId("vt-reload").disabled = true;
  try {
    state.data = await deps.api(TEMPLATES_URL);
  } catch (failure) {
    state.data = null;
    error.textContent = failureText(failure);
  } finally {
    state.loading = false;
    byId("vt-reload").disabled = false;
    renderRows();
  }
}

const dialog = () => byId("vt-dialog");

function openApprove(row) {
  if (state.approving.has(row.id)) return;
  const form = dialog().querySelector("form");
  form.dataset.id = row.id;
  byId("vt-dialog-title").textContent = `Zatwierdzić wersję ${row.version}?`;
  byId("vt-dialog-text").textContent = approveConfirmation(row);
  byId("vt-dialog-subject").textContent = row.subject;
  byId("vt-dialog-body").textContent = row.bodyText;
  byId("vt-dialog-error").textContent = "";
  dialog().showModal();
}

async function submitApprove(event) {
  if (event.submitter?.value !== "submit") return;
  event.preventDefault();
  const form = dialog().querySelector("form");
  const { id } = form.dataset;
  const row = toRows(state.data).find((item) => item.id === id);
  const submit = form.querySelector("button.primary");
  if (!row || state.approving.has(id)) return;
  state.approving.add(id);
  submit.disabled = true;
  byId("vt-dialog-error").textContent = "";
  try {
    // contentHash: serwer porównuje z wersją, którą zatwierdzający widział w oknie.
    const response = await deps.api(approveUrl(id), { method: "POST", body: JSON.stringify(approveBody(row)) });
    dialog().close();
    deps.showMessage(approveResultMessage(response, row.version));
    await load();
  } catch (failure) {
    byId("vt-dialog-error").textContent = failureText(failure);
    // Treść zmieniona albo wersja już zatwierdzona: odśwież listę pod oknem.
    if (["verify_template_changed", "verify_template_not_draft"].includes(failure.code)) await load();
  } finally {
    state.approving.delete(id);
    submit.disabled = false;
    renderRows();
  }
}

async function submitDraft(event) {
  event.preventDefault();
  if (state.saving) return;
  const form = event.currentTarget;
  const errorBox = byId("vt-form-error");
  errorBox.textContent = "";
  for (const field of form.elements) field.removeAttribute?.("aria-invalid");
  const checked = validateDraft({ subject: form.elements.subject.value, bodyText: form.elements.bodyText.value });
  if (checked.error) {
    errorBox.textContent = checked.error;
    form.elements[checked.field].setAttribute("aria-invalid", "true");
    form.elements[checked.field].focus();
    return;
  }
  state.saving = true;
  const submit = form.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const response = await deps.api(TEMPLATES_URL, { method: "POST", body: JSON.stringify(checked.payload) });
    form.reset();
    deps.showMessage(createResultMessage(response));
    await load();
  } catch (failure) {
    errorBox.textContent = failureText(failure);
  } finally {
    state.saving = false;
    submit.disabled = false;
  }
}

function setup() {
  byId("vt-reload").addEventListener("click", () => load());
  byId("vt-form").addEventListener("submit", submitDraft);
  dialog().querySelector("form").addEventListener("submit", submitApprove);
  state.ready = true;
}

export async function renderGuardianVerifyTemplates(dependencies) {
  deps = dependencies;
  if (!state.ready) setup();
  deps.setBreadcrumbs([{ text: "Klasy", href: "#/" }, { text: "Szablon kodu weryfikacyjnego" }]);
  deps.showView("guardianVerifyTemplates");
  await load();
}
