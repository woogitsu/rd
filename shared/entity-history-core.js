// Sekcja „Historia” obiektu w panelach (#181). Czyste funkcje bez DOM: wybór
// trasy wg roli, ścieżka, wiersze tabeli i opis autora. To wyłącznie UX — o
// dostępie rozstrzyga serwer: admin z MFA → `GET /api/admin/audit/entity/{typ}/{id}`,
// zarząd i skarbnik z MFA → `GET /api/audit/entity/{typ}/{id}` (D-08/D-09,
// założenie do zatwierdzenia). Inne role nie mają trasy, więc sekcja się nie pojawia.

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

// Trasa wg przydziałów (GET /api/access → grants): admin ma pierwszeństwo,
// zarząd i skarbnik używają trasy wspólnej, pozostałe role (Komisja Rewizyjna,
// dyrekcja, przedstawiciel klasy, brak przydziałów) → null (sekcja ukryta).
export function historyRoute(grants) {
  const roles = new Set((Array.isArray(grants) ? grants : []).map((grant) => grant?.role));
  if (roles.has("admin")) return "admin";
  if (roles.has("board") || roles.has("treasurer")) return "board";
  return null;
}

const ROUTE_PREFIX = Object.freeze({ admin: "/api/admin/audit/entity", board: "/api/audit/entity" });

export function entityHistoryPath(entityType, entityId, route = "admin") {
  if (!Object.hasOwn(ROUTE_PREFIX, route)) throw new Error("Brak trasy historii dla tej roli.");
  if (!HISTORY_ENTITY_TYPES.includes(entityType)) throw new Error("Nieobsługiwany typ obiektu historii.");
  if (typeof entityId !== "string" || !ID_PATTERN.test(entityId.trim())) throw new Error("Niepoprawny identyfikator obiektu.");
  return `${ROUTE_PREFIX[route]}/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId.trim())}`;
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

// 200 → tabela; 404 → sekcja ukryta bez komunikatu (obiekt nieistniejący albo
// poza zakresem — nieodróżnialne); 403 → komunikat o braku uprawnień (np. brak
// MFA lub przydział spoza roku obiektu); inne błędy (sieć, 5xx) → neutralny napis.
export function historyOutcome(error) {
  if (!error) return "shown";
  if (error.status === 404) return "hidden";
  return error.status === 403 ? "forbidden" : "unavailable";
}
