import {
  METHOD_LABELS,
  STATUS_LABELS,
  buildPaymentsUrl,
  formatCents,
  isValidId,
  makeIdempotencyKey,
  normalizePayment,
  parseEuroAmount,
} from "./core.js";
import { api as apiRequest } from "../shared/api.js";
import { mountShell } from "../shared/shell.js";
import "../shared/shell.css";

mountShell();

const state = { payments: [], nextCursor: null, requestKey: null };
const byId = (id) => document.getElementById(id);
const filtersForm = byId("filters-form");
const yearInput = byId("school-year-id");
const statusInput = byId("status-filter");
const body = byId("payments-body");
const message = byId("message");
const tableWrap = byId("table-wrap");
const loading = byId("loading");
const summary = byId("result-summary");
const loadMore = byId("load-more");

function localDate() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

// Wspólny klient (#99): polskie komunikaty, 401/403 MFA → /login/ z powrotem.
const api = apiRequest;

function textCell(value, className = "") {
  const cell = document.createElement("td");
  cell.textContent = value;
  if (className) cell.className = className;
  return cell;
}

function actionButton(label, action, paymentId) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.dataset.action = action;
  button.dataset.paymentId = paymentId;
  return button;
}

function paymentRow(rawPayment) {
  const payment = normalizePayment(rawPayment);
  const row = document.createElement("tr");
  row.append(textCell(payment.receivedOn));

  const reference = textCell(payment.reference || "Bez opisu", "reference");
  const family = document.createElement("small");
  family.textContent = payment.householdId ? `Rodzina: ${payment.householdId}` : "Nie przypisano rodziny";
  reference.append(family);
  row.append(reference);
  row.append(textCell(METHOD_LABELS[payment.method]));

  const status = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = `badge ${payment.status}`;
  badge.textContent = STATUS_LABELS[payment.status];
  status.append(badge);
  row.append(status);
  row.append(textCell(formatCents(payment.amountCents), "amount"));
  row.append(textCell(formatCents(payment.correctedCents), "amount"));
  row.append(textCell(formatCents(payment.netCents), "amount"));

  const actions = document.createElement("td");
  const actionGroup = document.createElement("div");
  actionGroup.className = "row-actions";
  actionGroup.append(actionButton("Korekta", "correct", payment.id));
  if (payment.status === "unmatched") actionGroup.prepend(actionButton("Przypisz", "assign", payment.id));
  actions.append(actionGroup);
  row.append(actions);
  return row;
}

function render() {
  body.replaceChildren(...state.payments.map(paymentRow));
  const count = state.payments.length;
  summary.textContent = count === 1 ? "1 widoczna wpłata" : `${count} widocznych wpłat`;
  tableWrap.hidden = count === 0;
  message.className = "message";
  message.textContent = count === 0 ? "Brak wpłat dla wybranych filtrów." : "";
  loadMore.hidden = !state.nextCursor;
}

function setBusy(busy) {
  loading.hidden = !busy;
  filtersForm.querySelector("button").disabled = busy;
  loadMore.disabled = busy;
}

async function loadPayments({ append = false } = {}) {
  message.textContent = "";
  message.className = "message";
  setBusy(true);
  try {
    const url = buildPaymentsUrl({
      schoolYearId: yearInput.value,
      status: statusInput.value,
      cursor: append ? state.nextCursor : "",
    });
    const result = await api(url);
    const items = Array.isArray(result.payments) ? result.payments : [];
    state.payments = append ? [...state.payments, ...items] : items;
    state.nextCursor = result.nextCursor || null;
    render();
  } catch (error) {
    message.className = "message error";
    message.textContent = error.message;
    if (!append) {
      state.payments = [];
      state.nextCursor = null;
      tableWrap.hidden = true;
      summary.textContent = "Nie udało się pobrać danych.";
    }
  } finally {
    setBusy(false);
  }
}

filtersForm.addEventListener("submit", (event) => {
  event.preventDefault();
  loadPayments();
});
loadMore.addEventListener("click", () => loadPayments({ append: true }));

// Po zapisie tabela jest renderowana od nowa, więc przycisk otwierający okno może zniknąć.
// Wtedy przenosimy fokus na nagłówek listy, aby nie spadł na <body> (WCAG 2.4.3).
function restoreFocus() {
  if (document.activeElement && document.activeElement !== document.body) return;
  const heading = byId("payments-title");
  heading.tabIndex = -1;
  heading.focus();
}

function configureDialog(id, prefix, submit, successText) {
  const dialog = byId(id);
  const form = dialog.querySelector("form");
  const errorBox = form.querySelector(".form-error");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (event.submitter?.value === "cancel") {
      dialog.close();
      state.requestKey = null;
      return;
    }
    if (!form.reportValidity()) return;

    errorBox.textContent = "";
    const submitButton = event.submitter;
    submitButton.disabled = true;
    state.requestKey ||= makeIdempotencyKey(prefix);
    try {
      await submit(new FormData(form), state.requestKey);
      state.requestKey = null;
      dialog.close();
      form.reset();
      await loadPayments();
      if (!message.classList.contains("error")) message.textContent = successText;
      restoreFocus();
    } catch (error) {
      errorBox.textContent = error.code === "idempotency_conflict"
        ? `${error.message} Jeśli chcesz zmienić dane operacji, anuluj formularz i otwórz go ponownie.`
        : error.message;
    } finally {
      submitButton.disabled = false;
    }
  });

  dialog.addEventListener("close", () => {
    errorBox.textContent = "";
    state.requestKey = null;
  });
  return { dialog, form };
}

const paymentDialog = configureDialog("payment-dialog", "payment", async (data, requestKey) => {
  const householdId = String(data.get("householdId") || "").trim();
  if (householdId && !isValidId(householdId)) throw new Error("Niepoprawny identyfikator rodziny.");
  await api("/api/payments", {
    method: "POST",
    headers: { "Idempotency-Key": requestKey },
    body: JSON.stringify({
      schoolYearId: String(data.get("schoolYearId") || "").trim(),
      amountCents: parseEuroAmount(data.get("amount")),
      receivedOn: data.get("receivedOn"),
      method: data.get("method"),
      reference: data.get("reference"),
      ...(householdId ? { householdId } : {}),
    }),
  });
}, "Zapisano wpłatę.");

const correctionDialog = configureDialog("correction-dialog", "correction", async (data, requestKey) => {
  const paymentId = String(data.get("paymentId"));
  await api(`/api/payments/${encodeURIComponent(paymentId)}/corrections`, {
    method: "POST",
    headers: { "Idempotency-Key": requestKey },
    body: JSON.stringify({
      amountCents: parseEuroAmount(data.get("amount")),
      reason: data.get("reason"),
    }),
  });
}, "Dodano korektę.");

const assignmentDialog = configureDialog("assignment-dialog", "assignment", async (data, requestKey) => {
  const paymentId = String(data.get("paymentId"));
  const householdId = String(data.get("householdId") || "").trim();
  if (!isValidId(householdId)) throw new Error("Niepoprawny identyfikator rodziny.");
  await api(`/api/payments/${encodeURIComponent(paymentId)}/assignment`, {
    method: "POST",
    headers: { "Idempotency-Key": requestKey },
    body: JSON.stringify({ householdId }),
  });
}, "Przypisano rodzinę.");

byId("open-payment").addEventListener("click", () => {
  paymentDialog.form.elements.schoolYearId.value = yearInput.value;
  paymentDialog.form.elements.receivedOn.value = localDate();
  paymentDialog.dialog.showModal();
});

body.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const payment = state.payments.map(normalizePayment).find((item) => item.id === button.dataset.paymentId);
  if (!payment) return;

  if (button.dataset.action === "correct") {
    correctionDialog.form.elements.paymentId.value = payment.id;
    correctionDialog.form.querySelector(".context").textContent = `${payment.receivedOn} · ${payment.reference || "Bez opisu"} · netto ${formatCents(payment.netCents)}`;
    correctionDialog.dialog.showModal();
  } else if (button.dataset.action === "assign") {
    assignmentDialog.form.elements.paymentId.value = payment.id;
    assignmentDialog.form.querySelector(".context").textContent = `${payment.receivedOn} · ${payment.reference || "Bez opisu"} · ${formatCents(payment.netCents)}`;
    assignmentDialog.dialog.showModal();
  }
});
