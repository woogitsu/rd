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

// Komunikat po zapisie z kluczem idempotencji (#136): gdy serwer odpowiedział powtórką
// (ponowienie po błędzie sieci, a pierwsze żądanie jednak doszło), użytkownik widzi,
// że nic nie zapisano drugi raz. Czysta funkcja tekstowa.
export function outcomeText(label, replayed) {
  return replayed ? `${label} (operacja była już wykonana — nie utworzono drugiego zapisu)` : label;
}

// Podsumowanie korekty (#136): kwota netto przed i po korekcie (w centach). Zwraca null,
// gdy którejś wartości nie da się policzyć (np. niepoprawna kwota w formularzu) —
// wtedy okno pokazuje samą kwotę korekty, a błąd zgłosi walidacja przy zapisie.
export function netAfterCorrection(netCents, correctionCents) {
  if (!Number.isSafeInteger(netCents) || !Number.isSafeInteger(correctionCents) || correctionCents <= 0) return null;
  const afterCents = netCents - correctionCents;
  return { beforeCents: netCents, afterCents, exceeds: afterCents < 0 };
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
    '<p id="shared-confirm-field" hidden><label for="shared-confirm-input" id="shared-confirm-label"></label> ' +
    '<input id="shared-confirm-input" type="text" autocomplete="off" spellcheck="false"></p>' +
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
export function confirmAction(options = {}) {
  return openDialog(options).then((result) => result.confirmed);
}

// Wariant z polem tekstowym (issue #224): reset MFA wymaga wpisania identyfikatora
// konta (`expected`), a krok w górę MFA — kodu z aplikacji (`inputMode: "numeric"`).
// „Potwierdź” jest nieaktywne, dopóki pole nie zgadza się z `expected` (albo, gdy
// `expected` nie podano, dopóki nie jest niepuste). Zwraca wpisany tekst po
// potwierdzeniu albo null po anulowaniu (Esc, „Anuluj”).
export function promptAction(options = {}) {
  return openDialog({ ...options, input: options.input ?? {} }).then((result) => (result.confirmed ? result.value : null));
}

function openDialog({
  title = "Potwierdzić operację?",
  effects = [],
  warning = "",
  confirmLabel = "Potwierdź",
  cancelLabel = "Anuluj",
  destructive = false,
  input = null,
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
    const field = dialog.querySelector("#shared-confirm-field");
    const inputEl = dialog.querySelector("#shared-confirm-input");
    field.hidden = !input;
    inputEl.value = "";
    if (input) {
      dialog.querySelector("#shared-confirm-label").textContent = input.label ?? "";
      inputEl.setAttribute("inputmode", input.inputMode ?? "text");
      inputEl.setAttribute("autocomplete", input.autocomplete ?? "off");
      inputEl.setAttribute("aria-describedby", "shared-confirm-body");
      confirmBtn.disabled = true;
    }
    const inputValid = () => {
      const value = inputEl.value.trim();
      return input?.expected !== undefined ? value === input.expected : value.length > 0;
    };
    function onInput() {
      confirmBtn.disabled = !inputValid();
    }

    let settled = false;
    let enteredValue = "";
    function cleanup(value) {
      if (settled) return;
      settled = true;
      enteredValue = inputEl.value.trim();
      inputEl.removeEventListener("input", onInput);
      inputEl.value = ""; // kod/identyfikator nie zostaje w DOM po zamknięciu
      dialog.removeEventListener("close", onClose);
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      if (dialog.open) dialog.close();
      if (invoker && typeof invoker.focus === "function") invoker.focus();
      resolve({ confirmed: value, value: input ? enteredValue : "" });
    }
    function onCancel() {
      cleanup(false);
    }
    function onConfirm(event) {
      event.preventDefault();
      if (settled) return; // podwójne kliknięcie „Potwierdź”: jedno rozstrzygnięcie
      if (input && !inputValid()) return;
      confirmBtn.disabled = true;
      cleanup(true);
    }
    function onClose() {
      cleanup(false); // Esc / zamknięcie bez wyboru = anulowanie
    }

    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
    dialog.addEventListener("close", onClose);
    inputEl.addEventListener("input", onInput);

    dialog.showModal();
    (input ? inputEl : destructive ? cancelBtn : confirmBtn).focus();
  });
}
