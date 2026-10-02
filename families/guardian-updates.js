// Ekran „Wnioski opiekunów o zmianę kontaktu” (#140) w panelu Rodziny. Logika widoku
// w guardian-updates-core.js; tu tylko DOM. Zapisy: POST …/approve|reject (bez treści).
// Blokada podwójnego kliknięcia: jedno żądanie naraz na wniosek i wyłączony przycisk
// w oknie potwierdzenia; serwer jest dodatkowo idempotentny.
import {
  GUARDIAN_UPDATE_MESSAGES, STATUS_OPTIONS, buildListUrl, canDecide, confirmationText, decisionUrl,
  mergePage, pageState, resultMessage, summaryText, toRow,
} from "./guardian-updates-core.js";

const byId = (id) => document.getElementById(id);
const state = { status: "pending", requests: [], nextCursor: null, loading: false, busy: new Set(), ready: false };
let deps = null;

function td(content) {
  const cell = document.createElement("td");
  cell.append(content);
  return cell;
}

function renderRows() {
  const rows = state.requests.map(toRow);
  byId("gu-body").replaceChildren(...rows.map((row) => {
    const tr = document.createElement("tr");
    const change = document.createElement("div");
    for (const [label, part] of [["E-mail", row.email], ["Zgoda", row.consent]]) {
      const line = document.createElement("div");
      line.textContent = `${label}: ${part.text}`;
      change.append(line);
    }
    if (row.verification) {
      // #140 pkt 5: stan kodu weryfikacyjnego nowego adresu; niepotwierdzony — wyróżniony.
      const line = document.createElement(row.verification.confirmed ? "div" : "p");
      if (!row.verification.confirmed) line.className = "form-error";
      line.textContent = `Weryfikacja adresu: ${row.verification.text}`;
      change.append(line);
    }
    if (row.warning) {
      const warn = document.createElement("p");
      warn.className = "form-error";
      warn.textContent = row.warning;
      change.append(warn);
    }
    const actions = document.createElement("div");
    actions.className = "row-actions";
    if (canDecide(state.status)) {
      for (const [decision, text] of [["approve", "Zatwierdź"], ["reject", "Odrzuć"]]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = text;
        button.disabled = state.busy.has(row.id);
        button.addEventListener("click", () => openDecision(decision, row));
        actions.append(button);
      }
    }
    tr.append(td(row.guardian), td(row.classes), td(change), td(row.note || "—"), td(row.createdAt), td(actions));
    return tr;
  }));
  byId("gu-empty").hidden = state.requests.length > 0;
  byId("gu-more").hidden = !state.nextCursor;
  byId("gu-summary").textContent = summaryText(state.status, state.requests.length, Boolean(state.nextCursor));
}

async function load(reset) {
  if (state.loading) return;
  state.loading = true;
  const more = byId("gu-more");
  const error = byId("gu-error");
  more.disabled = true;
  error.textContent = "";
  try {
    const page = await deps.api(buildListUrl(state.status, reset ? null : state.nextCursor));
    state.requests = reset ? mergePage([], page) : mergePage(state.requests, page);
    state.nextCursor = pageState(page).nextCursor;
  } catch (failure) {
    if (reset) { state.requests = []; state.nextCursor = null; }
    error.textContent = GUARDIAN_UPDATE_MESSAGES[failure.code] ?? failure.message;
  } finally {
    state.loading = false;
    more.disabled = false;
    renderRows();
  }
}

const dialog = () => byId("gu-dialog");

function openDecision(decision, row) {
  if (state.busy.has(row.id)) return;
  const form = dialog().querySelector("form");
  form.dataset.id = row.id;
  form.dataset.decision = decision;
  byId("gu-dialog-title").textContent = decision === "approve" ? "Zatwierdzić wniosek?" : "Odrzucić wniosek?";
  byId("gu-dialog-text").textContent = confirmationText(decision, row);
  byId("gu-dialog-error").textContent = "";
  form.querySelector("button.primary").textContent = decision === "approve" ? "Zatwierdź" : "Odrzuć";
  dialog().showModal();
}

async function submitDecision(event) {
  if (event.submitter?.value !== "submit") return;
  event.preventDefault();
  const form = dialog().querySelector("form");
  const { id, decision } = form.dataset;
  const submit = form.querySelector("button.primary");
  if (state.busy.has(id)) return;
  state.busy.add(id);
  submit.disabled = true;
  byId("gu-dialog-error").textContent = "";
  try {
    const response = await deps.api(decisionUrl(id, decision), { method: "POST", body: JSON.stringify({}) });
    dialog().close();
    state.requests = state.requests.filter((item) => item.id !== id);
    deps.showMessage(resultMessage(decision, response));
  } catch (failure) {
    byId("gu-dialog-error").textContent = GUARDIAN_UPDATE_MESSAGES[failure.code] ?? failure.message;
  } finally {
    state.busy.delete(id);
    submit.disabled = false;
    renderRows();
  }
}

function setup() {
  byId("gu-status").replaceChildren(...STATUS_OPTIONS.map((item) => new Option(item.label, item.value)));
  byId("gu-status").addEventListener("change", (event) => { state.status = event.target.value; load(true); });
  byId("gu-more").addEventListener("click", () => load(false));
  byId("gu-reload").addEventListener("click", () => load(true));
  dialog().querySelector("form").addEventListener("submit", submitDecision);
  state.ready = true;
}

export async function renderGuardianUpdates(dependencies) {
  deps = dependencies;
  if (!state.ready) setup();
  deps.setBreadcrumbs([{ text: "Klasy", href: "#/" }, { text: "Wnioski opiekunów" }]);
  deps.showView("guardianUpdates");
  await load(true);
}
