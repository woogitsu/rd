// Zwijana sekcja „Historia” (#181) — wiązanie DOM dla paneli wpłat, księgi i e-mail.
// Wstawia <details> do `host`, a po `load()` pokazuje ją tylko gdy serwer zwrócił 200.
// Ukrycie przy 403/404 to UX, nie kontrola dostępu (ta jest po stronie serwera).

import { entityHistoryPath, historyOutcome, historyRows } from "./entity-history-core.js";

function cell(text, title = "") {
  const td = document.createElement("td");
  td.textContent = text;
  if (title) td.title = title;
  return td;
}

export function mountEntityHistory(host, { api, idPrefix }) {
  const details = document.createElement("details");
  details.className = "entity-history";
  details.hidden = true;
  const summary = document.createElement("summary");
  summary.textContent = "Historia";
  const note = document.createElement("p");
  note.className = "context";
  note.setAttribute("role", "status");
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  wrap.setAttribute("role", "region");
  wrap.setAttribute("aria-labelledby", `${idPrefix}-caption`);
  wrap.tabIndex = 0;
  const table = document.createElement("table");
  const caption = document.createElement("caption");
  caption.id = `${idPrefix}-caption`;
  caption.className = "sr-only";
  caption.textContent = "Historia zdarzeń obiektu";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const title of ["Czas", "Zdarzenie", "Autor lub źródło"]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = title;
    headRow.append(th);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  table.append(caption, head, body);
  wrap.append(table);
  details.append(summary, note, wrap);
  host.append(details);

  let token = 0;
  function reset() {
    token += 1;
    details.hidden = true;
    details.open = false;
    body.replaceChildren();
    note.textContent = "";
  }

  async function load(entityType, entityId) {
    reset();
    const mine = token;
    let result = null;
    let failure = null;
    try {
      result = await api(entityHistoryPath(entityType, entityId));
    } catch (error) {
      failure = error;
    }
    if (mine !== token) return;
    const outcome = historyOutcome(failure);
    if (outcome === "hidden") return;
    details.hidden = false;
    if (outcome === "unavailable") {
      wrap.hidden = true;
      note.textContent = "Historia jest chwilowo niedostępna.";
      return;
    }
    const rows = historyRows(result?.events);
    note.textContent = rows.length ? "" : "Brak zapisanych zdarzeń.";
    wrap.hidden = rows.length === 0;
    body.replaceChildren(...rows.map((row) => {
      const tr = document.createElement("tr");
      tr.append(cell(row.time), cell(row.label), cell(row.actor, row.actorTitle));
      return tr;
    }));
  }

  return { load, reset, element: details };
}
