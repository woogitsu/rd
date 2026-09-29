import {
  describeApiError,
  filenameFromDisposition,
  formatBytes,
  hasRosterAccess,
  hasYearlyAccess,
  isTotpShape,
  needsStepUp,
  normalizeTotp,
  rosterUrl,
  verifyBundleText,
  yearlyBody,
  yearlyYears,
} from "./core.js";
import { api as apiRequest } from "../shared/api.js";
import { confirmAction } from "../shared/confirm-dialog.js";
import { initialSchoolYearId, yearOptionsHtml } from "../shared/school-year.js";
import { mountShell } from "../shared/shell.js";
import "../shared/shell.css";

mountShell();

const api = apiRequest;
const byId = (id) => document.getElementById(id);

const state = { grants: [], runs: [], busy: false, seq: 0 };

const message = byId("message");
function setMessage(text, isError = false) {
  message.textContent = text;
  message.className = isError ? "message error" : "message";
}

// --- krok w górę (mfa_stale): kod → POST /api/mfa/verify, potem ponowienie ---------------

const mfaDialog = byId("mfa-dialog");
function askStepUp() {
  return new Promise((resolve) => {
    const form = mfaDialog.querySelector("form");
    const errorBox = byId("mfa-error");
    errorBox.textContent = "";
    form.reset();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      form.removeEventListener("submit", onSubmit);
      mfaDialog.removeEventListener("close", onClose);
      if (mfaDialog.open) mfaDialog.close();
      resolve(value);
    };
    const onClose = () => finish(false);
    async function onSubmit(event) {
      event.preventDefault();
      if (event.submitter?.value === "cancel") { finish(false); return; }
      const button = event.submitter;
      const code = normalizeTotp(new FormData(form).get("code"));
      if (!isTotpShape(code)) { errorBox.textContent = "Wpisz kod z samych cyfr."; return; }
      button.disabled = true;
      errorBox.textContent = "";
      try {
        await api("/api/mfa/verify", { method: "POST", body: { code }, redirect: false });
        finish(true);
      } catch (error) {
        errorBox.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    }
    form.addEventListener("submit", onSubmit);
    mfaDialog.addEventListener("close", onClose);
    mfaDialog.showModal();
  });
}

// --- pobieranie i lista sesji -----------------------------------------------------------

function saveBlob(run) {
  const anchor = document.createElement("a");
  anchor.href = run.url;
  anchor.download = run.filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function cell(text, className = "") {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function renderRuns() {
  const body = byId("runs-body");
  body.replaceChildren(...state.runs.map((run) => {
    const row = document.createElement("tr");
    const verification = document.createElement("td");
    if (run.verification) {
      const status = document.createElement("span");
      status.className = run.verification.ok ? "verify-ok" : "verify-bad";
      status.textContent = run.verification.ok
        ? `Zgodny (${run.verification.files} plików, ${run.verification.rows} wierszy)`
        : "Niezgodny";
      verification.append(status);
      if (!run.verification.ok) {
        const list = document.createElement("ul");
        list.className = "verify-list";
        for (const item of run.verification.errors) { const li = document.createElement("li"); li.textContent = item; list.append(li); }
        verification.append(list);
      }
    } else {
      verification.textContent = run.kind === "yearly" ? "—" : "nie dotyczy";
    }
    const actions = document.createElement("td");
    actions.className = "row-actions";
    const wrap = document.createElement("div");
    wrap.className = "inline-actions";
    const download = document.createElement("button");
    download.type = "button";
    download.textContent = "Pobierz ponownie";
    download.addEventListener("click", () => saveBlob(run));
    wrap.append(download);
    if (run.kind === "yearly") {
      const verify = document.createElement("button");
      verify.type = "button";
      verify.textContent = "Weryfikuj";
      verify.addEventListener("click", async () => {
        verify.disabled = true;
        try {
          run.verification = await verifyBundleText(await run.blob.text(), { expectedManifestSha256: run.manifestSha256 });
        } catch {
          run.verification = { ok: false, errors: ["Nie udało się sprawdzić pliku w tej przeglądarce."] };
        }
        renderRuns();
      });
      wrap.append(verify);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Usuń z listy";
    remove.addEventListener("click", () => {
      URL.revokeObjectURL(run.url);
      state.runs = state.runs.filter((item) => item !== run);
      renderRuns();
    });
    wrap.append(remove);
    actions.append(wrap);
    row.append(
      cell(run.kind === "yearly" ? "Eksport roczny" : "Lista klasy"),
      cell(run.scope),
      cell(run.at.toLocaleString("pl-PL")),
      cell(formatBytes(run.size)),
      cell(run.runId ?? "—"),
      verification,
      actions,
    );
    return row;
  }));
  const count = state.runs.length;
  byId("runs-section").hidden = false;
  byId("runs-table").hidden = count === 0;
  byId("runs-empty").hidden = count !== 0;
  byId("runs-count").textContent = count === 1 ? "1 plik" : `${count} plików`;
}

// Jedno uruchomienie naraz (podwójne kliknięcie = jedno żądanie). Po mfa_stale prosi o kod
// i ponawia RAZ to samo żądanie — potwierdzenie skutków było już udzielone.
async function runDownload({ kind, scope, fallbackName, send, verify = false, button }) {
  if (state.busy) return;
  state.busy = true;
  button.disabled = true;
  setMessage("");
  try {
    let result;
    try {
      result = await send();
    } catch (error) {
      if (!needsStepUp(error)) throw error;
      if (!(await askStepUp())) { setMessage("Eksport przerwany: brak potwierdzenia kodem.", true); return; }
      result = await send();
    }
    const { blob, headers } = result;
    const run = {
      kind,
      scope,
      at: new Date(),
      size: blob.size,
      blob,
      url: URL.createObjectURL(blob),
      filename: filenameFromDisposition(headers.get("Content-Disposition"), fallbackName),
      runId: headers.get("X-Export-Run-Id"),
      manifestSha256: headers.get("X-Export-Manifest-Sha256"),
      verification: null,
    };
    if (verify) {
      try { run.verification = await verifyBundleText(await blob.text(), { expectedManifestSha256: run.manifestSha256 }); } catch { run.verification = null; }
    }
    state.runs.unshift(run);
    renderRuns();
    saveBlob(run);
    setMessage(`Eksport zapisany w dzienniku (przebieg ${run.runId ?? "bez identyfikatora"}). Plik został pobrany.`);
  } catch (error) {
    setMessage(`Nie udało się wykonać eksportu: ${describeApiError(error.status, error.code) ?? error.message}`, true);
  } finally {
    state.busy = false;
    button.disabled = false;
  }
}

// --- eksport roczny -----------------------------------------------------------------------

byId("yearly-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = byId("yearly-run");
  let body;
  try { body = yearlyBody(byId("yearly-year").value); } catch (error) { setMessage(error.message, true); return; }
  const confirmed = await confirmAction({
    title: `Eksport roczny ${body.schoolYearId}`,
    effects: [
      "Paczka zawiera dane osobowe rodzin i dzieci oraz finanse całego roku szkolnego.",
      "Przebieg zostanie zapisany w dzienniku zdarzeń (kto, kiedy, skrót); wpisu nie da się usunąć.",
      "Plik zapisz w bezpiecznym miejscu i usuń po wykorzystaniu; czas przechowywania czeka na decyzję zarządu.",
    ],
    confirmLabel: "Uruchom eksport",
    destructive: true,
  });
  if (!confirmed) return;
  await runDownload({
    kind: "yearly",
    scope: body.schoolYearId,
    fallbackName: `rd-eksport-${body.schoolYearId}.json`,
    send: () => api("/api/exports", { method: "POST", body, binary: true }),
    verify: true,
    button,
  });
});

// --- lista klasy --------------------------------------------------------------------------

byId("roster-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = byId("roster-run");
  const select = byId("roster-class");
  const format = byId("roster-format").value;
  let url;
  try { url = rosterUrl(select.value, format); } catch (error) { setMessage(error.message, true); return; }
  const className = select.selectedOptions[0]?.textContent ?? select.value;
  const confirmed = await confirmAction({
    title: `Lista klasy ${className}`,
    effects: [
      "Plik zawiera dane osobowe dzieci i opiekunów tej klasy.",
      "Pobranie zostanie zapisane w dzienniku zdarzeń (kto, kiedy).",
      "Nie przesyłaj pliku dalej i usuń go po wykorzystaniu.",
    ],
    confirmLabel: "Pobierz listę",
    destructive: true,
  });
  if (!confirmed) return;
  await runDownload({
    kind: "roster",
    scope: className,
    fallbackName: `lista-klasy.${format}`,
    send: () => api(url, { binary: true }),
    button,
  });
});

// --- sprawdzenie pliku z dysku ---------------------------------------------------------------

byId("verify-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  const box = byId("verify-result");
  box.textContent = "";
  if (!file) return;
  const result = await verifyBundleText(await file.text()).catch(() => ({ ok: false, errors: ["Nie udało się odczytać pliku."] }));
  const paragraph = document.createElement("p");
  paragraph.className = result.ok ? "verify-ok" : "verify-bad";
  paragraph.textContent = result.ok
    ? `Zgodny: rok ${result.schoolYearId}, ${result.files} plików tabel, ${result.rows} wierszy.`
    : "Plik jest niezgodny z manifestem.";
  box.append(paragraph);
  if (!result.ok) {
    const list = document.createElement("ul");
    list.className = "verify-list";
    for (const item of result.errors) { const li = document.createElement("li"); li.textContent = item; list.append(li); }
    box.append(list);
  }
});

// --- dostęp ----------------------------------------------------------------------------------

async function applyAccess() {
  let access;
  try {
    access = await api("/api/access");
  } catch (error) {
    setMessage(error.message, true);
    return;
  }
  state.grants = Array.isArray(access.grants) ? access.grants : [];
  const yearly = hasYearlyAccess(state.grants);
  const roster = hasRosterAccess(state.grants);
  if (!yearly && !roster) {
    byId("access-notice").hidden = false;
    return;
  }
  if (yearly) {
    const years = yearlyYears(state.grants);
    const initial = initialSchoolYearId(state.grants.filter((g) => !g.classId));
    const options = years.length ? years : [initial];
    byId("yearly-year").innerHTML = yearOptionsHtml(options, initial);
    byId("yearly-section").hidden = false;
    byId("verify-section").hidden = false;
    renderRuns();
  }
  if (roster) {
    try {
      const data = await api("/api/classes");
      const classes = Array.isArray(data.classes) ? data.classes : [];
      const select = byId("roster-class");
      select.replaceChildren(...classes.map((item) => {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = `${item.name} (${item.schoolYearLabel ?? item.schoolYearId})`;
        return option;
      }));
      byId("roster-run").disabled = classes.length === 0;
      byId("roster-section").hidden = false;
      renderRuns();
    } catch (error) {
      setMessage(`Nie udało się pobrać listy klas: ${error.message}`, true);
    }
  }
}
applyAccess();
