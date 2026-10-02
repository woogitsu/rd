// Widok tylko do odczytu dla Komisji Rewizyjnej (`audit`) w panelach księgi i dokumentów
// (D-09 wariant b, issue #137). Część czysta (bez DOM i sieci), testowana w
// tests/shell-core.test.js i testach rdzeni paneli.
//
// Panel dowiaduje się o fladze serwera AUDIT_LEDGER_READ z `GET /api/session`:
// `capabilities.auditLedgerRead === true` dostaje WYŁĄCZNIE konto z rolą `audit` przy włączonej
// fladze (src/pg/routes/session.js); dla innych kont pola nie ma. To wskazówka dla interfejsu —
// ukrycie przycisku nie jest kontrolą dostępu: trasy odczytu i zapisu autoryzuje serwer.

// Role z dostępem odczytu przy fladze (jak AUDIT_LEDGER_READ_ROLES w src/pg/audit-ledger-read.js;
// zgodność pilnuje tests/shell-panels-authz.test.js).
export const AUDIT_READ_ROLES = Object.freeze(["audit"]);

// Nazwa możliwości w `GET /api/session` → `capabilities`.
export const AUDIT_LEDGER_READ = "auditLedgerRead";

// Możliwości z odpowiedzi `GET /api/session`; wszystko poza dokładnym `true` to brak możliwości.
export function sessionCapabilities(session) {
  const raw = session && typeof session === "object" ? session.capabilities : null;
  return Object.freeze({ [AUDIT_LEDGER_READ]: Boolean(raw) && typeof raw === "object" && raw[AUDIT_LEDGER_READ] === true });
}

// Przydział `audit` bez klasy (jak na trasach odczytu: przydział klasowy nie daje dostępu).
export function hasAuditReadGrant(grants) {
  return (Array.isArray(grants) ? grants : []).some((grant) => AUDIT_READ_ROLES.includes(grant?.role) && !grant.classId);
}

// Czy panel ma pokazać widok tylko do odczytu: serwer zgłosił możliwość, konto ma rolę `audit`
// i NIE ma dostępu standardowego do tego panelu (`standardAccess` liczy panel ze swoich ról —
// wtedy pozostaje dotychczasowy widok pełny).
export function isAuditReadView({ grants, capabilities, standardAccess = false } = {}) {
  return capabilities?.[AUDIT_LEDGER_READ] === true && !standardAccess && hasAuditReadGrant(grants);
}
