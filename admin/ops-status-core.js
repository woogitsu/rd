// Czyste funkcje widoku „Stan systemu” (#149) — bez DOM i sieci, testowane w
// tests/admin-ops-status.test.js. Wejście: odpowiedź GET /api/admin/ops-status
// (tylko liczby, znaczniki czasu i kody). Progi alarmowe (wiek kopii, workera,
// kolejki) są konfiguracją serwera (/health/jobs); widok ich nie zna i nie
// zgaduje — pokazuje fakty, a stan „uwaga/błąd” tylko tam, gdzie wynika wprost
// z danych (nieudany przebieg, zaległa migracja, wiadomości `failed`).
// Brak danych to osobny stan, nigdy „w normie”.
import { formatDateOrTimestamp } from "../shared/zoned-time.js";

export const STATE_LABELS = Object.freeze({
  ok: "W normie",
  attention: "Uwaga",
  error: "Błąd",
  no_data: "Brak danych",
});

// dd.mm.rrrr gg:mm w Europe/Brussels — ten sam zapis co reszta aplikacji (#563, przegląd demo 5).
export function formatWhen(value) {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return formatDateOrTimestamp(date, "Europe/Brussels") ?? "—";
}

// Wiek zdarzenia po polsku („3 godz. temu”); null, gdy brak daty.
export function ageText(value, now = new Date()) {
  if (!value) return null;
  const ms = now.getTime() - new Date(value).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} min temu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} godz. temu`;
  return `${Math.floor(hours / 24)} dni temu`;
}

function when(value, now) {
  const text = formatWhen(value);
  const age = ageText(value, now);
  return age ? `${text} (${age})` : text;
}

const noData = (name, detail = "Nie zapisano jeszcze żadnego zdarzenia.") => ({ key: name, state: "no_data", when: null, detail });

function backupRow(key, block, now) {
  if (!block || block.status === "no_data" || !block.lastRun) return noData(key, "Brak dziennika przebiegów — nie oznacza, że kopia jest aktualna.");
  const failed = block.lastRun.result !== "success";
  return {
    key,
    state: failed || block.status === "attention" ? "attention" : "ok",
    when: block.lastRun.finishedAt ?? null,
    detail: failed ? "Ostatni przebieg zakończony niepowodzeniem." : "Ostatni przebieg zakończony powodzeniem.",
    whenText: when(block.lastRun.finishedAt, now),
  };
}

// Zwraca listę wierszy { key, label, state, stateLabel, whenText, detail } w stałej kolejności.
export function buildOpsRows(status, now = new Date()) {
  const s = status && typeof status === "object" ? status : {};
  const rows = [];

  const m = s.migrations ?? {};
  if (m.pendingCount == null) rows.push(noData("migrations", "Brak tabeli migracji."));
  else {
    rows.push({
      key: "migrations",
      state: m.pendingCount > 0 ? "error" : "ok",
      when: null,
      detail: m.pendingCount > 0
        ? `Zaległe migracje: ${m.pendingCount}. Zob. runbook, karta 2.`
        : `Nałożone: ${m.appliedCount}, zaległe: 0.`,
    });
  }

  const w = s.emailWorker;
  if (!w) rows.push(noData("emailWorker", "Brak zapisanego przebiegu workera."));
  else {
    rows.push({
      key: "emailWorker",
      state: w.failed > 0 ? "attention" : "ok",
      when: w.finishedAt,
      detail: `Tryb: ${w.mode ?? "—"}; wysłano ${w.sent ?? 0}, ponowiono ${w.retried ?? 0}, błędy ${w.failed ?? 0}${w.stoppedReason ? `; zatrzymano: ${w.stoppedReason}` : ""}.`,
    });
  }

  const q = s.emailQueue;
  if (!q) rows.push(noData("emailQueue", "Brak tabeli kolejki."));
  else {
    rows.push({
      key: "emailQueue",
      state: q.failed > 0 ? "attention" : "ok",
      when: q.oldestPendingAt,
      detail: `Oczekujące: ${q.pending}, nieudane: ${q.failed}.${q.oldestPendingAt ? " Data dotyczy najstarszej oczekującej." : ""}`,
    });
  }

  rows.push(backupRow("backup", s.backup, now));
  rows.push(backupRow("storageBackup", s.storageBackup, now));
  rows.push(backupRow("restoreDrill", s.restoreDrill, now));

  if (!s.lastExport) rows.push(noData("lastExport"));
  else rows.push({ key: "lastExport", state: "ok", when: s.lastExport.createdAt, detail: `Rodzaj: ${s.lastExport.kind ?? "—"}.` });

  rows.push({
    key: "writeMode",
    state: s.writeMode === "read_only" ? "attention" : s.writeMode === "normal" ? "ok" : "no_data",
    when: null,
    detail: s.writeMode === "read_only" ? "Zapisy wyłączone (APP_WRITE_MODE=read_only)." : s.writeMode === "normal" ? "Zapisy włączone." : "Nieznany tryb.",
  });

  const version = typeof s.appVersion === "string" && /^[0-9a-f]{7,64}$/i.test(s.appVersion) ? s.appVersion.slice(0, 7) : null;
  rows.push(version
    ? { key: "appVersion", state: "ok", when: null, detail: `Wersja: ${version}.` }
    : noData("appVersion", "Wersja nie jest ustawiona (RAILWAY_GIT_COMMIT_SHA)."));

  return rows.map((row) => ({
    ...row,
    label: OPS_LABELS[row.key],
    stateLabel: STATE_LABELS[row.state],
    whenText: row.whenText ?? (row.when ? when(row.when, now) : "—"),
  }));
}

export const OPS_LABELS = Object.freeze({
  migrations: "Migracje bazy",
  emailWorker: "Ostatni przebieg workera e-mail",
  emailQueue: "Kolejka e-mail",
  backup: "Kopia zapasowa PostgreSQL",
  storageBackup: "Kopia Storage Bucket",
  restoreDrill: "Próba odtworzenia",
  lastExport: "Ostatni eksport roczny",
  writeMode: "Tryb pracy",
  appVersion: "Wersja aplikacji",
});

export function overallState(rows) {
  if (rows.some((r) => r.state === "error")) return "error";
  if (rows.some((r) => r.state === "attention")) return "attention";
  if (rows.some((r) => r.state === "no_data")) return "no_data";
  return "ok";
}
