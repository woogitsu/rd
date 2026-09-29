// Ekran „Lista wyłączeń adresów” (#94). Adresy tylko zamaskowane (serwer),
// zdjęcie blokady = wniosek + zatwierdzenie przez inną osobę; nic nie jest
// wysyłane i nic nie dzieje się automatycznie. Uprawnienia egzekwuje serwer.
import {
  RELEASE_REASON_LABELS,
  SUPPRESSION_REASON_LABELS,
  allowedReleaseReasons,
  describeFamily,
  describeSuppressionError,
  formatSuppressionCount,
  parseConfirmationNote,
  rowAction,
  suppressionActionUrl,
  suppressionsUrl,
} from "./suppressions-core.js";
import { confirmAction } from "../shared/confirm-dialog.js";

const byId = (id) => document.getElementById(id);

export function mountSuppressions({ api }) {
  const section = byId("suppressions");
  const body = byId("suppressions-body");
  const dialog = byId("suppression-request-dialog");
  const form = dialog.querySelector("form");
  const errorBox = byId("suppression-request-error");
  const state = { schoolYearId: "", items: [], target: null, busy: false };

  function setMessage(text, isError = false) {
    const box = byId("suppressions-message");
    box.textContent = text;
    box.className = isError ? "message error" : "message";
  }

  function messageFor(error) {
    return describeSuppressionError(error.status, error.code) ?? error.message;
  }

  function textCell(value, className = "") {
    const cell = document.createElement("td");
    cell.textContent = value;
    if (className) cell.className = className;
    return cell;
  }

  function actionButton(label, handler, primary = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (primary) button.className = "primary";
    button.addEventListener("click", handler);
    return button;
  }

  function row(item) {
    const tr = document.createElement("tr");
    const pending = item.pendingRequest;
    const action = rowAction(item);
    tr.append(
      textCell(describeFamily(item)),
      textCell(item.email ?? "—"),
      textCell(SUPPRESSION_REASON_LABELS[item.reason] ?? item.reason),
      textCell(String(item.createdAt ?? "").slice(0, 10)),
      textCell(String(item.events ?? ""), "amount"),
      textCell(pending
        ? `${RELEASE_REASON_LABELS[pending.releaseReason] ?? pending.releaseReason}${pending.requestedByMe ? " (Twój wniosek — czeka na drugą osobę)" : " (czeka na zatwierdzenie)"}`
        : "Brak"),
    );
    const actions = document.createElement("td");
    actions.className = "row-actions";
    if (action === "request") actions.append(actionButton("Złóż wniosek o zdjęcie", () => openRequest(item)));
    if (action === "approve") actions.append(actionButton("Zatwierdź zdjęcie blokady", () => approve(item), true));
    tr.append(actions);
    return tr;
  }

  function render() {
    body.replaceChildren(...state.items.map(row));
    byId("suppressions-count").textContent = formatSuppressionCount(state.items.length);
    byId("suppressions-table").hidden = state.items.length === 0;
    byId("suppressions-empty").hidden = state.items.length !== 0;
  }

  async function load(schoolYearId) {
    state.schoolYearId = schoolYearId;
    section.hidden = false;
    try {
      const data = await api(suppressionsUrl(schoolYearId));
      state.items = Array.isArray(data.suppressions) ? data.suppressions : [];
      setMessage("");
      render();
    } catch (error) {
      state.items = [];
      render();
      setMessage(`Nie udało się pobrać listy wyłączeń: ${messageFor(error)}`, true);
    }
  }

  function openRequest(item) {
    state.target = item;
    const select = form.elements.releaseReason;
    select.replaceChildren(...allowedReleaseReasons(item.reason).map((code) => {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = RELEASE_REASON_LABELS[code];
      return option;
    }));
    form.elements.confirmationNote.value = "";
    byId("suppression-request-target").textContent = `${describeFamily(item)}. Adres: ${item.email ?? "—"}. Powód blokady: ${SUPPRESSION_REASON_LABELS[item.reason] ?? item.reason}.`;
    dialog.showModal();
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (event.submitter?.value === "cancel") { dialog.close(); return; }
    if (!form.reportValidity() || state.busy || !state.target) return;
    const releaseReason = String(form.elements.releaseReason.value);
    let note;
    try {
      note = parseConfirmationNote(form.elements.confirmationNote.value, { required: releaseReason === "parent_request" });
    } catch (error) {
      errorBox.textContent = error.message;
      return;
    }
    state.busy = true;
    event.submitter.disabled = true;
    errorBox.textContent = "";
    try {
      await api(suppressionActionUrl(state.target.emailHash, "release-request"), {
        method: "POST",
        body: JSON.stringify({
          schoolYearId: state.schoolYearId,
          releaseReason,
          ...(note ? { confirmationNote: note } : {}),
        }),
      });
      dialog.close();
      await load(state.schoolYearId);
      setMessage("Wniosek złożony. Blokadę zdejmie dopiero zatwierdzenie przez inną osobę.");
    } catch (error) {
      errorBox.textContent = messageFor(error);
    } finally {
      state.busy = false;
      event.submitter.disabled = false;
    }
  });
  dialog.addEventListener("close", () => { errorBox.textContent = ""; state.target = null; });

  async function approve(item) {
    const pending = item.pendingRequest;
    if (!pending || state.busy) return;
    const confirmed = await confirmAction({
      title: "Zdjąć blokadę adresu?",
      effects: [
        describeFamily(item),
        `Powód zdjęcia: ${RELEASE_REASON_LABELS[pending.releaseReason] ?? pending.releaseReason}.`,
        "Powstaje nowy zapis; historia blokady zostaje. Ponowne odbicie znów zablokuje adres.",
        "Nic nie jest wysyłane — rodzina wróci do listy odbiorców dopiero w nowej kampanii.",
      ],
      confirmLabel: "Zdejmij blokadę",
      cancelLabel: "Wróć",
    });
    if (!confirmed) return;
    state.busy = true;
    try {
      await api(suppressionActionUrl(item.emailHash, "release"), {
        method: "POST",
        body: JSON.stringify({ schoolYearId: state.schoolYearId, requestId: pending.requestId }),
      });
      await load(state.schoolYearId);
      setMessage("Blokada zdjęta (nowy zapis w historii).");
    } catch (error) {
      setMessage(`Nie udało się zdjąć blokady: ${messageFor(error)}`, true);
    } finally {
      state.busy = false;
    }
  }

  return { load };
}
