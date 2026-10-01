// Sekcja „Historia” obiektu w panelach (#181). Czyste funkcje bez DOM: ścieżka
// trasy, wiersze tabeli i opis autora. To wyłącznie UX — o dostępie do trasy
// `GET /api/admin/audit/entity/{typ}/{id}` rozstrzyga serwer (dziś tylko admin
// z MFA, D-08/D-09); panel pokazuje sekcję tylko po odpowiedzi 200.

import { auditActionLabel } from "./audit-actions.js";
import { shortId } from "./short-id.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

// Typy obiektów obsługiwane w panelach (ENTITY_TABLES w src/pg/routes/admin.js).
export const HISTORY_ENTITY_TYPES = Object.freeze(["payment_entry", "ledger_entry", "email_campaign"]);

// Źródła zdarzeń systemowych (`source`, PR #622). Pole jest opcjonalne — do
// czasu scalenia #622 serwer go nie zwraca.
export const HISTORY_SOURCE_LABELS = Object.freeze({
  email_worker: "Zadanie wysyłki e-mail",
  brevo_webhook: "Webhook dostawcy e-mail",
  login: "Logowanie",
});

export function entityHistoryPath(entityType, entityId) {
  if (!HISTORY_ENTITY_TYPES.includes(entityType)) throw new Error("Nieobsługiwany typ obiektu historii.");
  if (typeof entityId !== "string" || !ID_PATTERN.test(entityId.trim())) throw new Error("Niepoprawny identyfikator obiektu.");
  return `/api/admin/audit/entity/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId.trim())}`;
}

// Autor albo źródło. `actorKind` (`user`/`system`/`anonymous`) i `source` są
// opcjonalne; bez nich pozostaje `actorId` (skrócony), a jego brak oznacza zdarzenie systemowe.
export function historyActorText(event) {
  const kind = event?.actorKind;
  const source = typeof event?.source === "string" ? event.source : "";
  const sourceText = HISTORY_SOURCE_LABELS[source] ?? "";
  if (kind === "anonymous") return sourceText || "Osoba niezalogowana";
  if (kind === "system") return sourceText || "System";
  if (event?.actorId) return shortId(event.actorId);
  return sourceText || "System";
}

export function historyTimeText(iso) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date).replace(",", "");
}

// Od najstarszego zdarzenia; nieznana akcja zostaje pod własną nazwą.
export function historyRows(events) {
  if (!Array.isArray(events)) return [];
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => String(a.event?.occurredAt ?? "").localeCompare(String(b.event?.occurredAt ?? "")) || a.index - b.index)
    .map(({ event }) => ({
      id: String(event?.id ?? ""),
      time: historyTimeText(event?.occurredAt),
      label: auditActionLabel(event?.action) ?? String(event?.action ?? "—"),
      actor: historyActorText(event),
      actorTitle: event?.actorId ? String(event.actorId) : "",
    }));
}

// 200 → tabela; 403/404 → sekcja ukryta bez komunikatu; inne błędy (sieć, 5xx)
// → neutralny napis, bez szczegółów.
export function historyOutcome(error) {
  if (!error) return "shown";
  return error.status === 403 || error.status === 404 ? "hidden" : "unavailable";
}
