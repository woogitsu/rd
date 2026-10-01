// Ekran „Dzienny limit Brevo” (#84): stan puli doby i ręczna ewidencja wiadomości spoza
// kolejki wraz z korektą. Niczego nie wysyła. Uprawnienia egzekwuje serwer (zarząd lub
// skarbnik z MFA); formularz jest tylko podpowiedzią, a 403 pokazuje komunikat.
import {
  OTHER_SENDS_URL,
  QUOTA_REASON_LABELS,
  buildOtherSendBody,
  describeEntry,
  describeOtherSendEffects,
  describeQuotaError,
  describeQuotaSummary,
  otherSendsListUrl,
  quotaRows,
  quotaUrl,
} from "./quota-core.js";
import { makeIdempotencyKey } from "./core.js";
import { confirmAction } from "../shared/confirm-dialog.js";

const byId = (id) => document.getElementById(id);

export function mountQuota({ api, canEdit }) {
  const section = byId("quota");
  const form = byId("quota-form");
  const errorBox = byId("quota-form-error");
  const state = { schoolYearId: "", quota: null, entries: [], busy: false, key: null, keyBody: null };

  function setMessage(text, isError = false) {
    const box = byId("quota-message");
    box.textContent = text;
    box.className = isError ? "message error" : "message";
  }

  function messageFor(error) {
    return describeQuotaError(error.status, error.code) ?? error.message;
  }

  function cell(value, className = "") {
    const td = document.createElement("td");
    td.textContent = value;
    if (className) td.className = className;
    return td;
  }

  function renderQuota() {
    const rows = quotaRows(state.quota);
    byId("quota-body").replaceChildren(...rows.map((row) => {
      const tr = document.createElement("tr");
      tr.append(cell(row.label), cell(row.day), cell(String(row.campaign), "amount"), cell(String(row.other), "amount"),
        cell(String(row.total), "amount"), cell(String(row.remaining), "amount"));
      return tr;
    }));
    byId("quota-table").hidden = rows.length === 0;
    byId("quota-summary").textContent = describeQuotaSummary(state.quota);
  }

  function renderEntries() {
    const body = byId("quota-entries-body");
    body.replaceChildren(...state.entries.map((entry) => {
      const tr = document.createElement("tr");
      tr.append(cell(entry.day), cell(String(entry.count), "amount"),
        cell(entry.reasonCode === "correction" ? "Korekta" : (QUOTA_REASON_LABELS[entry.reasonCode] ?? entry.reasonCode)),
        cell(entry.reasonCode === "correction" ? `Koryguje ${entry.correctsId}` : (entry.corrected ? `Skorygowano: ${entry.correctedCount}` : "Bez korekty")),
        cell(entry.id));
      const actions = document.createElement("td");
      actions.className = "row-actions";
      if (entry.count > 0 && (entry.correctableCount ?? entry.count) > 0) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Koryguj ten wpis";
        button.addEventListener("click", () => prefillCorrection(entry));
        actions.append(button);
      }
      tr.append(actions);
      return tr;
    }));
    byId("quota-entries-box").hidden = state.entries.length === 0;
  }

  function syncKind() {
    const correction = form.elements.kind.value === "correction";
    byId("quota-reason-label").hidden = correction;
    byId("quota-target-label").hidden = !correction;
    form.elements.reasonCode.required = !correction;
    form.elements.correctsId.required = correction;
  }

  function prefillCorrection(entry) {
    form.elements.kind.value = "correction";
    form.elements.correctsId.value = entry.id;
    form.elements.day.value = entry.day;
    form.elements.count.value = String(-(entry.correctableCount ?? entry.count));
    syncKind();
    form.elements.count.focus();
  }

  async function load(schoolYearId) {
    if (state.schoolYearId !== schoolYearId) { state.entries = []; renderEntries(); }
    state.schoolYearId = schoolYearId;
    section.hidden = false;
    form.hidden = !canEdit();
    try {
      const data = await api(quotaUrl(schoolYearId));
      state.quota = data.quota ?? null;
      if (!form.elements.day.value && state.quota?.windows?.utc?.today?.day) {
        form.elements.day.value = state.quota.windows.utc.today.day;
      }
      setMessage("");
    } catch (error) {
      state.quota = null;
      // 403 pokazuje komunikat; ukryty formularz nie jest kontrolą dostępu.
      setMessage(`Nie udało się pobrać stanu limitu: ${messageFor(error)}`, true);
    }
    renderQuota();
    await loadEntries(schoolYearId);
  }

  // Lista wpisów ręcznych z serwera (te same role co formularz); błąd nie blokuje stanu puli.
  async function loadEntries(schoolYearId) {
    try {
      const data = await api(otherSendsListUrl(schoolYearId));
      if (state.schoolYearId !== schoolYearId) return;
      state.entries = Array.isArray(data?.entries) ? data.entries : [];
    } catch (error) {
      state.entries = [];
      setMessage(`Nie udało się pobrać listy wpisów: ${messageFor(error)}`, true);
    }
    renderEntries();
  }

  for (const radio of form.querySelectorAll('input[name="kind"]')) radio.addEventListener("change", syncKind);
  syncKind();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.busy) return;
    if (!form.reportValidity()) return;
    let body;
    try {
      body = buildOtherSendBody({
        schoolYearId: state.schoolYearId,
        kind: form.elements.kind.value,
        day: form.elements.day.value,
        count: form.elements.count.value,
        reasonCode: form.elements.reasonCode.value,
        correctsId: form.elements.correctsId.value,
      });
    } catch (error) {
      errorBox.textContent = error.message;
      return;
    }
    errorBox.textContent = "";
    state.busy = true;
    const button = byId("quota-submit");
    button.disabled = true;
    try {
      const confirmed = await confirmAction({
        title: body.correctsId ? "Zapisać korektę wpisu?" : "Zapisać wiadomości spoza kolejki?",
        effects: describeOtherSendEffects(body),
        confirmLabel: "Zapisz",
        cancelLabel: "Wróć",
      });
      if (!confirmed) return;
      // Ten sam klucz dla tych samych danych: ponowienie po błędzie sieci nie zapisze drugiego wpisu.
      const serialized = JSON.stringify(body);
      if (!state.key || state.keyBody !== serialized) {
        state.key = makeIdempotencyKey("quota");
        state.keyBody = serialized;
      }
      const data = await api(OTHER_SENDS_URL, { method: "POST", body, idempotencyKey: state.key });
      state.key = null;
      state.keyBody = null;
      form.elements.count.value = "";
      form.elements.correctsId.value = "";
      await load(state.schoolYearId);
      setMessage(`Zapisano: ${describeEntry(data?.entry)}. Nic nie zostało wysłane.`);
    } catch (error) {
      errorBox.textContent = messageFor(error);
    } finally {
      state.busy = false;
      button.disabled = false;
    }
  });

  return { load };
}
