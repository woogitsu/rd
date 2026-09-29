// Wspólne okno potwierdzenia (issue #136): zastępuje window.confirm i brak potwierdzenia
// przed operacjami trwałymi lub publicznymi. Oparte na natywnym <dialog> (jak w meetings/),
// więc Esc zamyka okno i liczy się jako anulowanie, a przeglądarka zarządza focus-trap.
//
// Logika czysta (buildEffectsHtml) ma test jednostkowy: tests/confirm-dialog-core.test.js.
// Interakcje okna (Esc, fokus, anulowanie, podsumowanie skutków, podwójne kliknięcie)
// testuje przeglądarka: tests/e2e/confirm-dialog.spec.js.

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Lista skutków jako <ul> — pomija wpisy puste/undefined. Czysta funkcja tekstowa.
export function buildEffectsHtml(effects) {
  const items = (Array.isArray(effects) ? effects : []).filter(Boolean);
  if (!items.length) return "";
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

let dialogEl = null;

function ensureDialog() {
  if (dialogEl && document.body.contains(dialogEl)) return dialogEl;
  dialogEl = document.createElement("dialog");
  dialogEl.id = "shared-confirm-dialog";
  dialogEl.setAttribute("aria-labelledby", "shared-confirm-title");
  dialogEl.setAttribute("aria-describedby", "shared-confirm-body");
  dialogEl.innerHTML =
    '<form method="dialog" class="stack">' +
    '<h2 id="shared-confirm-title"></h2>' +
    '<div id="shared-confirm-body"></div>' +
    '<p id="shared-confirm-warning" role="alert" hidden></p>' +
    '<div class="actions">' +
    '<button type="button" data-role="cancel"></button>' +
    '<button type="submit" class="primary" data-role="confirm"></button>' +
    "</div>" +
    "</form>";
  document.body.append(dialogEl);
  return dialogEl;
}

// Pokazuje okno i zwraca Promise<boolean>: true po potwierdzeniu, false po anulowaniu
// (przycisk „Anuluj”, Esc, kliknięcie poza oknem). Przy akcjach destrukcyjnych fokus
// startuje na „Anuluj” (kryterium a11y z issue). Fokus wraca do przycisku wywołującego.
// Klucz idempotencji do samego żądania generuje wywołujący PRZED otwarciem okna (nie tutaj),
// żeby ponowienie po błędzie sieci używało tego samego klucza — patrz panel/main.js, ledger/main.js.
export function confirmAction({
  title = "Potwierdzić operację?",
  effects = [],
  warning = "",
  confirmLabel = "Potwierdź",
  cancelLabel = "Anuluj",
  destructive = false,
} = {}) {
  return new Promise((resolve) => {
    const dialog = ensureDialog();
    const invoker = document.activeElement;
    dialog.querySelector("#shared-confirm-title").textContent = title;
    dialog.querySelector("#shared-confirm-body").innerHTML = buildEffectsHtml(effects);
    const warningBox = dialog.querySelector("#shared-confirm-warning");
    warningBox.hidden = !warning;
    warningBox.textContent = warning || "";
    const cancelBtn = dialog.querySelector('[data-role="cancel"]');
    const confirmBtn = dialog.querySelector('[data-role="confirm"]');
    cancelBtn.textContent = cancelLabel;
    confirmBtn.textContent = confirmLabel;
    confirmBtn.disabled = false;
    dialog.classList.toggle("destructive", Boolean(destructive));

    let settled = false;
    function cleanup(value) {
      if (settled) return;
      settled = true;
      dialog.removeEventListener("close", onClose);
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      if (dialog.open) dialog.close();
      if (invoker && typeof invoker.focus === "function") invoker.focus();
      resolve(value);
    }
    function onCancel() {
      cleanup(false);
    }
    function onConfirm(event) {
      event.preventDefault();
      if (settled) return; // podwójne kliknięcie „Potwierdź”: jedno rozstrzygnięcie
      confirmBtn.disabled = true;
      cleanup(true);
    }
    function onClose() {
      cleanup(false); // Esc / zamknięcie bez wyboru = anulowanie
    }

    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
    dialog.addEventListener("close", onClose);

    dialog.showModal();
    (destructive ? cancelBtn : confirmBtn).focus();
  });
}
