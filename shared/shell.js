// Wspólna powłoka paneli (issue #85): jedna nawigacja, blok konta i wylogowanie.
// Część czysta (bez DOM) jest testowana w tests/shell-core.test.js.
// Część z DOM/fetch (mountShell) nie ma testu jednostkowego — jak main.js pozostałych
// paneli, jest wiązana ręcznie; kontrolę dostępu i tak wykonuje wyłącznie serwer.

import { api as apiRequest } from "./api.js";

// Kolejność stała dla wszystkich paneli (patrz issue #85, propozycja p.3).
// `roles` to WYŁĄCZNIE wskazówka UI — ukrycie linku nie jest kontrolą dostępu;
// każde API sprawdza uprawnienia niezależnie (docs/AUTHORIZATION.md). Zakresy ról są
// założeniem odwzorowującym tests/helpers/route-matrix.js do czasu decyzji D-08/D-09.
export const PANELS = Object.freeze([
  { id: "families", href: "/families/", label: "Rodziny", roles: ["admin", "board", "representative"] },
  { id: "panel", href: "/panel/", label: "Wpłaty", roles: ["admin", "board", "treasurer"] },
  { id: "ledger", href: "/ledger/", label: "Księga", roles: ["admin", "board", "treasurer"] },
  // Role z EDITOR_ROLES w email/core.js (i src/pg/routes/email.js): zarząd + skarbnik.
  { id: "email", href: "/email/", label: "Kampanie e-mail", roles: ["board", "treasurer"] },
  // Role z WRITE_ROLES w reconciliation/core.js (i src/pg/routes/reconciliation.js).
  { id: "reconciliation", href: "/reconciliation/", label: "Uzgodnienia wyciągu", roles: ["admin", "board", "treasurer"] },
  { id: "print", href: "/print/", label: "Kartki", roles: ["admin", "board", "representative"] },
  { id: "events", href: "/events/", label: "Wydarzenia", roles: ["admin", "board", "representative"] },
  { id: "meetings", href: "/meetings/", label: "Zebrania", roles: ["admin", "board", "audit", "representative"] },
  { id: "documents", href: "/documents/", label: "Dokumenty", roles: ["admin", "board", "treasurer", "representative"] },
  { id: "import", href: "/import/", label: "Import uczniów", roles: ["admin", "board"] },
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
// (jak z GET /api/access → grants). Czysta funkcja — bez DOM, bez sieci.
export function visiblePanels(grants) {
  const roles = new Set((Array.isArray(grants) ? grants : []).map((g) => g && g.role).filter(Boolean));
  if (roles.size === 0) return [];
  return PANELS.filter((panel) => panel.roles.some((role) => roles.has(role)));
}

// Krótki opis zakresu do bloku konta, np. "Przedstawiciel klasy · 2 role".
// Pełne etykiety klas i lat (nazwy zamiast identyfikatorów) to zakres issue #128
// (potrzebują GET /api/classes) — tu pokazujemy wyłącznie nazwy ról i surowe lata.
export function scopeSummary(grants) {
  const list = Array.isArray(grants) ? grants : [];
  if (list.length === 0) return "Brak przydzielonej roli";
  const roles = [...new Set(list.map((g) => roleLabel(g.role)))];
  const years = [...new Set(list.map((g) => g.schoolYearId).filter(Boolean))].sort();
  const rolesText = roles.join(", ");
  return years.length ? `${rolesText} · ${years.join(", ")}` : rolesText;
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

let logoutInFlight = null;

async function logout() {
  // Jedno żądanie na podwójne kliknięcie (test: tests/shell-core.test.js pokrywa
  // tylko część czystą; ta ochrona jest analogiczna do wzorców w panel/main.js).
  if (logoutInFlight) return logoutInFlight;
  logoutInFlight = apiRequest("/api/logout", { method: "POST" }).catch(() => {});
  try {
    await logoutInFlight;
  } finally {
    window.location.href = "/login/";
  }
}

// Montuje nawigację i blok konta w istniejących kontenerach strony.
// Oczekuje w HTML: <nav aria-label="Panel"><ul id="shell-nav"></ul></nav>
// oraz <div id="shell-account"></div> (patrz zmiany w */index.html).
export async function mountShell({ document: doc = document, location: loc = window.location } = {}) {
  const navList = doc.getElementById("shell-nav");
  const account = doc.getElementById("shell-account");
  let grants = [];
  let session = null;
  try {
    const access = await apiRequest("/api/access");
    grants = access && Array.isArray(access.grants) ? access.grants : [];
  } catch {
    grants = [];
  }
  if (navList) navList.innerHTML = navItemsHtml(visiblePanels(grants), loc.pathname);
  try {
    session = await apiRequest("/api/session");
  } catch {
    session = null;
  }
  if (account) {
    if (!session) {
      account.innerHTML = "";
      return { grants, session };
    }
    const name = escapeHtml(session.displayName || session.email || "Konto");
    account.innerHTML =
      `<span class="shell-account-name">${name}</span>` +
      `<span class="shell-account-scope">${escapeHtml(scopeSummary(grants))}</span>` +
      `<a href="/login/#change">Zmień hasło</a>` +
      `<button type="button" id="shell-logout">Wyloguj</button>`;
    const btn = doc.getElementById("shell-logout");
    if (btn) btn.addEventListener("click", () => { btn.disabled = true; logout(); });
  }
  return { grants, session };
}
