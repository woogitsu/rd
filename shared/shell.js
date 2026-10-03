// Wspólna powłoka paneli (issue #85): jedna nawigacja, blok konta i wylogowanie.
// Część czysta (bez DOM) jest testowana w tests/shell-core.test.js.
// Część z DOM/fetch (mountShell) nie ma testu jednostkowego — jak main.js pozostałych
// paneli, jest wiązana ręcznie; kontrolę dostępu i tak wykonuje wyłącznie serwer.

import { api as apiRequest, checkSession } from "./api.js";
import { forgetSession } from "./session-hint.js";
import { applySchoolName } from "./school.js";
import { defaultYear, formatSchoolYear, yearsFromGrants } from "./school-year.js";
import { AUDIT_LEDGER_READ, AUDIT_READ_ROLES, sessionCapabilities } from "./audit-view.js";

export { sessionCapabilities };

// Kolejność stała dla wszystkich paneli (patrz issue #85, propozycja p.3; rozszerzone
// o #226 — uzgodnienia, kampanie e-mail i zamknięcie roku miały wcześniej własne,
// niepełne paski nawigacji zamiast tej listy).
// `capabilityRoles` (opcjonalne) dodaje panel tylko dla konta z daną rolą, gdy serwer zgłosił
// możliwość w GET /api/session (`capabilities`, shared/audit-view.js) — dziś wyłącznie widok
// tylko do odczytu Komisji Rewizyjnej przy fladze AUDIT_LEDGER_READ (D-09, #137).
// `roles` to WYŁĄCZNIE wskazówka UI — ukrycie linku nie jest kontrolą dostępu;
// każde API sprawdza uprawnienia niezależnie (docs/AUTHORIZATION.md). Lista ról każdego
// panelu odwzorowuje stałe modułu tras odpowiedzialnego za dane API (patrz komentarz
// przy każdym wpisie) i jest sprawdzana testem tests/shell-panels-authz.test.js. Zakresy
// ról pozostają założeniem prototypu do czasu decyzji D-08/D-09 (docs/DECISIONS.md) —
// tu jedynie odwzorowujemy to, co już wdrożono po stronie serwera, nie dopowiadamy nic
// ponad to.
export const PANELS = Object.freeze([
  // src/pg/routes/families.js READ_ROLES (klasy/uczniowie/gospodarstwa).
  { id: "families", href: "/families/", label: "Rodziny", roles: ["admin", "board", "treasurer", "representative"] },
  // src/pg/routes/payments.js FINANCIAL_ROLES.
  { id: "panel", href: "/panel/", label: "Wpłaty", roles: ["admin", "board", "treasurer"] },
  // src/pg/routes/ledger.js FINANCIAL_ROLES.
  // Komisja Rewizyjna (audit) ma odczyt księgi tylko przy fladze AUDIT_LEDGER_READ (capabilityRoles).
  { id: "ledger", href: "/ledger/", label: "Księga", roles: ["admin", "board", "treasurer"], capabilityRoles: { [AUDIT_LEDGER_READ]: AUDIT_READ_ROLES } },
  // src/pg/routes/email.js EDITOR_ROLES (admin nie ma dostępu do kampanii e-mail).
  { id: "email", href: "/email/", label: "Kampanie", roles: ["board", "treasurer"] },
  // src/pg/routes/reconciliation.js WRITE_ROLES (widok tylko-do-odczytu Komisji
  // Rewizyjnej — REPORT_ROLES — nie ma dziś osobnego ekranu, patrz reconciliation/core.js).
  { id: "reconciliation", href: "/reconciliation/", label: "Uzgodnienia", roles: ["admin", "board", "treasurer"] },
  // src/pg/routes/print.js PRINT_ROLES (FINANCIAL_ROLES + representative).
  { id: "print", href: "/print/", label: "Kartki", roles: ["admin", "board", "treasurer", "representative"] },
  // src/pg/events.js EVENT_POLICY (suma ról ze wszystkich akcji).
  { id: "events", href: "/events/", label: "Wydarzenia", roles: ["admin", "board", "representative"] },
  // src/pg/meetings.js — admin/board/audit widzą pełne zebrania; representative wyłącznie
  // udostępnione protokoły (meetings/core.js dostosowuje widok do zakresu).
  { id: "meetings", href: "/meetings/", label: "Zebrania", roles: ["admin", "board", "audit", "principal", "representative"] },
  // src/pg/routes/documents.js DOCUMENT_POLICIES (suma ról wszystkich rodzajów dokumentów).
  // Komisja Rewizyjna (audit) czyta dowody finansowe tylko przy fladze AUDIT_LEDGER_READ (capabilityRoles).
  { id: "documents", href: "/documents/", label: "Dokumenty", roles: ["admin", "board", "treasurer", "representative"], capabilityRoles: { [AUDIT_LEDGER_READ]: AUDIT_READ_ROLES } },
  // src/pg/routes/import.js IMPORT_ROLES.
  { id: "import", href: "/import/", label: "Import", roles: ["admin", "board"] },
  // src/pg/routes/year-close.js READ_ROLES (admin i Komisja Rewizyjna bez dostępu).
  { id: "year-close", href: "/year-close/", label: "Zamknięcie", roles: ["board", "treasurer"] },
  // src/pg/routes/reconciliation.js REPORT_ROLES = audit, board, treasurer (GET
  // /api/reports/audit). Do nawigacji trafia wyłącznie Komisja Rewizyjna — zarząd i
  // skarbnik mają ten sam raport jako odnośnik w panelu uzgodnień. Tylko odczyt.
  { id: "audit", href: "/audit/", label: "Komisja Rewizyjna", roles: ["audit"] },
  // src/pg/routes/exports.js YEARLY_EXPORT_ROLES (admin, board) + ROSTER_ROLES
  // (representative — wyłącznie lista własnej klasy; serwer weryfikuje klasę i MFA).
  { id: "data-export", href: "/data-export/", label: "Eksport", roles: ["admin", "board", "representative"] },
  // src/pg/news.js NEWS_POLICY (suma draftSchoolWide, draftClass, review). Przedstawiciel
  // widzi wyłącznie wpisy własnej klasy — zakres egzekwuje serwer.
  { id: "news", href: "/news/", label: "Aktualności", roles: ["admin", "board", "representative"] },
  // wyłącznie admin (docs/AUTHORIZATION.md: „wyłącznie admin”).
  { id: "admin", href: "/admin/", label: "Konta i role", roles: ["admin"] },
]);

const ROLE_LABELS = Object.freeze({
  admin: "Administrator",
  board: "Zarząd",
  treasurer: "Skarbnik",
  representative: "Przedstawiciel klasy",
  audit: "Komisja Rewizyjna",
  principal: "Dyrekcja",
});

export function roleLabel(role) {
  return ROLE_LABELS[role] || role;
}

// Zwraca podzbiór PANELS w stałej kolejności, widoczny dla podanych przydziałów
// (jak z GET /api/access → grants) i możliwości sesji (GET /api/session → capabilities,
// por. sessionCapabilities). Bez możliwości lista zależy wyłącznie od ról. Czysta funkcja —
// bez DOM, bez sieci.
export function visiblePanels(grants, capabilities = {}) {
  const roles = new Set((Array.isArray(grants) ? grants : []).map((g) => g && g.role).filter(Boolean));
  if (roles.size === 0) return [];
  const byCapability = (panel) => Object.entries(panel.capabilityRoles || {})
    .some(([capability, capabilityRoles]) => capabilities?.[capability] === true && capabilityRoles.some((role) => roles.has(role)));
  return PANELS.filter((panel) => panel.roles.some((role) => roles.has(role)) || byCapability(panel));
}

// Krótki opis zakresu do bloku konta, np. "Przedstawiciel klasy, Skarbnik".
// Pełne etykiety klas (nazwy zamiast identyfikatorów) to zakres issue #128
// (potrzebują GET /api/classes) — tu pokazujemy wyłącznie nazwy ról. Rok szkolny
// pokazuje osobno wskaźnik roku (activeYearLabel).
export function scopeSummary(grants) {
  const list = Array.isArray(grants) ? grants : [];
  if (list.length === 0) return "Brak przydzielonej roli";
  return [...new Set(list.map((g) => roleLabel(g && g.role)))].join(", ");
}

// Wskaźnik roku szkolnego w bloku konta: najnowszy rok z przydziałów (tak samo jak
// domyślny rok w panelach, shared/school-year.js). Pusty napis, gdy przydziały nie
// niosą roku (np. rola globalna) — wtedy panele stosują własny rok domyślny.
export function activeYearLabel(grants) {
  const year = defaultYear(yearsFromGrants(grants), "");
  return year ? `Rok szkolny ${formatSchoolYear(year)}` : "";
}

// Aktywny panel: porównanie ścieżki bieżącej strony z href panelu (prefiks, bez query).
export function isActivePanel(panel, pathname) {
  const path = String(pathname || "");
  return path === panel.href || path.startsWith(panel.href);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Buduje znaczniki <li> nawigacji — czysta funkcja tekstowa, testowalna bez DOM.
export function navItemsHtml(panels, pathname) {
  return panels
    .map((panel) => {
      const active = isActivePanel(panel, pathname);
      const cls = active ? ' class="active"' : "";
      const current = active ? ' aria-current="page"' : "";
      return `<li><a href="${escapeHtml(panel.href)}"${cls}${current}>${escapeHtml(panel.label)}</a></li>`;
    })
    .join("");
}

// Tryb tylko do odczytu (#143): GET /api/session zwraca writeMode. Baner to wyłącznie
// informacja dla użytkownika — zapisy i tak odrzuca serwer (503 read_only).
export const READ_ONLY_BANNER_TEXT = "Trwają prace serwisowe — zapisy wstrzymane. Możesz przeglądać dane; zmiany będą możliwe po zakończeniu prac.";

export function isReadOnlySession(session) {
  return Boolean(session) && session.writeMode === "read_only";
}

// Wstawia (raz) baner na początek strony; usuwa go, gdy tryb wrócił do normalnego.
function syncWriteModeBanner(doc, session) {
  if (!doc || typeof doc.createElement !== "function" || !doc.body) return;
  const existing = typeof doc.getElementById === "function" ? doc.getElementById("shell-write-mode") : null;
  if (!isReadOnlySession(session)) {
    if (existing && typeof existing.remove === "function") existing.remove();
    return;
  }
  if (existing) return;
  const banner = doc.createElement("div");
  banner.id = "shell-write-mode";
  banner.className = "shell-write-mode";
  banner.setAttribute("role", "status");
  banner.textContent = READ_ONLY_BANNER_TEXT;
  doc.body.insertBefore(banner, doc.body.firstChild);
}

let logoutInFlight = null;

async function logout() {
  // Jedno żądanie na podwójne kliknięcie (test: tests/shell-core.test.js pokrywa
  // tylko część czystą; ta ochrona jest analogiczna do wzorców w panel/main.js).
  if (logoutInFlight) return logoutInFlight;
  logoutInFlight = apiRequest("/api/logout", { method: "POST" }).catch(() => {});
  try {
    await logoutInFlight;
  } finally {
    // Wskazówka dla /login/ (shared/session-hint.js): po wylogowaniu nie pytać o stan sesji.
    forgetSession();
    window.location.href = "/login/";
  }
}

// Montuje nawigację i blok konta w istniejących kontenerach strony.
// Oczekuje w HTML: <nav aria-label="Panel"><ul id="shell-nav"></ul></nav>
// oraz <div id="shell-account"></div> (patrz zmiany w */index.html).
// Nazwa wyświetlana zalogowanej osoby (nagłówek powłoki, stopka wydruku #151).
// GET /api/session zwraca { user: { displayName, email } }; płaski kształt
// { displayName } obsługujemy dla zgodności ze starszymi odpowiedziami i testami.
export function sessionDisplayName(session) {
  if (!session || typeof session !== "object") return null;
  const user = session.user && typeof session.user === "object" ? session.user : {};
  for (const value of [user.displayName, session.displayName, user.email, session.email]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export async function mountShell({ document: doc = document, location: loc = window.location } = {}) {
  applySchoolName(doc);
  const navList = doc.getElementById("shell-nav");
  const account = doc.getElementById("shell-account");
  let grants = [];
  let session = null;
  // Przegląd demo 5 (propozycja 4): najpierw jedno GET /api/session, zanim wyjdzie
  // jakiekolwiek inne żądanie strony (także z main.js panelu — czekają na bramkę w
  // shared/api.js). Bez sesji: jedno 401 i od razu /login/#next=…, dalsze żądania nie
  // wychodzą. Wywołanie musi zostać przed pierwszym `await` (synchronicznie przy starcie).
  try {
    session = await checkSession();
  } catch {
    session = null;
  }
  try {
    const access = await apiRequest("/api/access");
    grants = access && Array.isArray(access.grants) ? access.grants : [];
  } catch {
    grants = [];
  }
  const capabilities = sessionCapabilities(session);
  if (navList) navList.innerHTML = navItemsHtml(visiblePanels(grants, capabilities), loc.pathname);
  syncWriteModeBanner(doc, session);
  if (account) {
    if (!session) {
      account.innerHTML = "";
      return { grants, session, capabilities };
    }
    const name = escapeHtml(sessionDisplayName(session) || "Konto");
    const yearLabel = activeYearLabel(grants);
    account.innerHTML =
      `<span class="shell-account-name">${name}</span>` +
      `<span class="shell-account-scope">${escapeHtml(scopeSummary(grants))}</span>` +
      (yearLabel ? `<span class="shell-account-year">${escapeHtml(yearLabel)}</span>` : "") +
      `<a href="/login/#change">Zmień hasło</a>` +
      `<button type="button" id="shell-logout">Wyloguj</button>`;
    const btn = doc.getElementById("shell-logout");
    if (btn) btn.addEventListener("click", () => { btn.disabled = true; logout(); });
  }
  return { grants, session, capabilities };
}
