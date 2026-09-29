// Sekcja „Stan systemu” panelu administracji (#149). Osobny moduł ładowany
// z index.html — nie zmienia funkcji main.js. Korzysta wyłącznie z
// GET /api/admin/ops-status (tylko liczby, znaczniki czasu i kody; brak danych
// osobowych). Uprawnienia sprawdza serwer (rola admin); przy 403 widok pokazuje
// komunikat, nic nie ukrywa po stronie klienta jako kontroli dostępu.
import { api as apiRequest } from "../shared/api.js";
import { ERROR_MESSAGES } from "./core.js";
import { STATE_LABELS, buildOpsRows, overallState } from "./ops-status-core.js";

const byId = (id) => document.getElementById(id);

function cell(text, className = "") {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function render(status) {
  const rows = buildOpsRows(status);
  const tbody = byId("ops-body");
  tbody.replaceChildren(...rows.map((row) => {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.scope = "row";
    th.textContent = row.label;
    const stateTd = document.createElement("td");
    const span = document.createElement("span");
    span.className = `status ops-${row.state}`;
    span.textContent = row.stateLabel;
    stateTd.append(span);
    tr.append(th, stateTd, cell(row.whenText), cell(row.detail));
    return tr;
  }));
  const overall = overallState(rows);
  byId("ops-summary").textContent = `Ogólnie: ${STATE_LABELS[overall]}. Stan z ${new Date(status.generatedAt ?? Date.now()).toLocaleString("pl-BE")}.`;
}

async function load() {
  const message = byId("ops-message");
  const button = byId("reload-ops");
  message.textContent = "";
  button.disabled = true;
  try {
    render(await apiRequest("/api/admin/ops-status", { messages: ERROR_MESSAGES }));
  } catch (error) {
    byId("ops-body").replaceChildren();
    byId("ops-summary").textContent = "";
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

byId("reload-ops").addEventListener("click", load);
load();
