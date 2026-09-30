// Ekran „Do sprawdzenia w logach dostawcy” (#139): lista operacyjna kampanii
// (wiersze failed/delivery_unknown i powtarzające się soft_bounce) oraz zapis
// rozstrzygnięcia. Adres tylko zamaskowany (serwer); otwarcie listy zapisuje
// się w dzienniku, więc lista ładuje się dopiero po kliknięciu. Rozstrzygnięcie
// nic nie wysyła i nie zmienia historii wiersza — to nowy zapis. Uprawnienia
// egzekwuje serwer.
import {
  RESOLUTION_LABELS,
  allowedResolutions,
  attentionUrl,
  canResolve,
  describeAttention,
  describeResolution,
  describeResolutionError,
  parseEvidenceCode,
  resolutionsUrl,
} from "./resolutions-core.js";
import { confirmAction } from "../shared/confirm-dialog.js";

const byId = (id) => document.getElementById(id);

export function mountResolutions({ api, isBoard, onResolved }) {
  const box = byId("attention-box");
  const body = byId("attention-body");
  const dialog = byId("resolution-dialog");
  const form = dialog.querySelector("form");
  const errorBox = byId("resolution-error");
  const state = { campaignId: null, items: [], nextCursor: null, target: null, busy: false };

  function setMessage(text, isError = false) {
    const node = byId("attention-message");
    node.textContent = text;
    node.className = isError ? "message error" : "message";
  }

  function messageFor(error) {
    return describeResolutionError(error.status, error.code) ?? error.message;
  }

  function textCell(value) {
    const cell = document.createElement("td");
    cell.textContent = value;
    return cell;
  }

  function row(item) {
    const tr = document.createElement("tr");
    tr.append(
      textCell(item.outboxId),
      textCell(item.email ?? "—"),
      textCell(describeAttention(item)),
      textCell(item.providerMessageId ?? "—"),
      textCell(describeResolution(item)),
    );
    const actions = document.createElement("td");
    actions.className = "row-actions";
    if (canResolve(item)) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Zapisz wynik sprawdzenia";
      button.addEventListener("click", () => openDialog(item));
      actions.append(button);
    }
    tr.append(actions);
    return tr;
  }

  function render() {
    body.replaceChildren(...state.items.map(row));
    byId("attention-table").hidden = state.items.length === 0;
    byId("attention-empty").hidden = state.items.length !== 0;
    byId("attention-load-more").hidden = !state.nextCursor;
  }

  // Zmiana kampanii chowa listę poprzedniej (inne wiersze, inny dziennik odczytu).
  function reset(campaignId) {
    if (state.campaignId === campaignId) return;
    state.campaignId = campaignId;
    state.items = [];
    state.nextCursor = null;
    box.hidden = true;
    setMessage("");
  }

  async function load({ append = false } = {}) {
    if (!state.campaignId) return;
    if (append && !state.nextCursor) return;
    box.hidden = false;
    try {
      const data = await api(attentionUrl(state.campaignId, append ? state.nextCursor : ""));
      const items = Array.isArray(data.rows) ? data.rows : [];
      state.items = append ? [...state.items, ...items] : items;
      state.nextCursor = data.nextCursor || null;
      render();
    } catch (error) {
      if (!append) { state.items = []; state.nextCursor = null; }
      render();
      setMessage(`Nie udało się pobrać listy do sprawdzenia: ${messageFor(error)}`, true);
    }
  }

  function openDialog(item) {
    state.target = item;
    const select = form.elements.resolution;
    select.replaceChildren(...allowedResolutions(isBoard()).map((code) => {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = RESOLUTION_LABELS[code];
      return option;
    }));
    form.elements.evidenceCode.value = "";
    byId("resolution-target").textContent = `Wiersz kolejki ${item.outboxId}. Adres: ${item.email ?? "—"}. ${describeAttention(item)}.`;
    dialog.showModal();
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (event.submitter?.value === "cancel") { dialog.close(); return; }
    if (!form.reportValidity() || state.busy || !state.target) return;
    const resolution = String(form.elements.resolution.value);
    let evidenceCode;
    try {
      evidenceCode = parseEvidenceCode(form.elements.evidenceCode.value);
    } catch (error) {
      errorBox.textContent = error.message;
      return;
    }
    const target = state.target;
    const submitter = event.submitter;
    if (resolution === "confirmed_not_sent") {
      dialog.close();
      const confirmed = await confirmAction({
        title: "Potwierdzić, że wiadomość nie wyszła?",
        effects: [
          `Wiersz kolejki ${target.outboxId}.`,
          "Potwierdzaj wyłącznie po sprawdzeniu logów dostawcy (wyszukanie po identyfikatorze wiersza).",
          "Zapis jest trwały i nie zmienia historii wiersza. Nic nie jest wysyłane.",
          "Ponowna wiadomość do tej rodziny jest możliwa wyłącznie w nowej kampanii, zatwierdzanej zwykłą ścieżką.",
        ],
        confirmLabel: "Zapisz potwierdzenie",
        cancelLabel: "Wróć",
      });
      if (!confirmed) return;
    }
    state.busy = true;
    if (submitter) submitter.disabled = true;
    errorBox.textContent = "";
    try {
      await api(resolutionsUrl(state.campaignId), {
        method: "POST",
        body: JSON.stringify({ outboxId: target.outboxId, resolution, evidenceCode }),
      });
      if (dialog.open) dialog.close();
      await load();
      setMessage("Zapisano wynik sprawdzenia (nowy zapis; historia wiersza bez zmian). Nic nie zostało wysłane.");
      await onResolved?.();
    } catch (error) {
      const text = messageFor(error);
      if (dialog.open) errorBox.textContent = text;
      else setMessage(`Nie udało się zapisać: ${text}`, true);
    } finally {
      state.busy = false;
      if (submitter) submitter.disabled = false;
    }
  });
  dialog.addEventListener("close", () => { errorBox.textContent = ""; });
  byId("attention-open").addEventListener("click", () => load());
  byId("attention-load-more").addEventListener("click", () => load({ append: true }));

  return { reset, load };
}
