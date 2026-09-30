// Odczyt archiwum zamkniętego roku (#195). Prototyp — nie jest wdrożony.
//
// Wariant zachowawczy do czasu decyzji D-08/D-09 (zarząd nic jeszcze nie
// zdecydował): rok N, który jest zamknięty (school_year_closures.status =
// 'closed'), może ODCZYTAĆ osoba z przydziałem bez zawężenia do klasy, z MFA:
//   * zarząd albo skarbnik (zależnie od trasy) z przydziałem roku N+1, gdzie
//     N+1 = school_year_closures.next_school_year_id — tylko jeden rok wstecz,
//     bez łańcucha (przydział N+2 nie otwiera N);
//   * admin techniczny (przydział bez roku albo roku N+1).
// Reguła dotyczy wyłącznie tras: zestawienie przekazania, raport KR i eksport
// roczny. Nie daje prawa zapisu — zapis w roku N nadal odrzucają triggery
// zamrożenia z 0017 (409 school_year_closed). Komisja Rewizyjna po zamknięciu
// nie dostaje odczytu (D-09), a stara kadencja traci dostęp jak dotąd.

import { isAuthorizedScoped } from './authorization.js';
import { insertAuditEvent } from './audit.js';

export const ARCHIVE_ADMIN_ROLES = Object.freeze(['admin']);

// Zwraca identyfikator roku N+1, przez który dostęp został przyznany, albo null.
// `roles` to role trasy uprawnione do odczytu archiwum (podzbiór board/treasurer).
export async function archiveReadVia(executor, context, schoolYearId, roles) {
  if (!context) return null;
  const { rows } = await executor.query(
    `SELECT next_school_year_id FROM school_year_closures
      WHERE school_year_id = $1 AND status = 'closed'`,
    [schoolYearId],
  );
  const nextSchoolYearId = rows[0]?.next_school_year_id;
  if (!nextSchoolYearId) return null;
  const allowed = [...new Set([...roles, ...ARCHIVE_ADMIN_ROLES])];
  // Bez classId isAuthorizedScoped pomija przydziały klasowe.
  if (!isAuthorizedScoped(context, { roles: allowed, schoolYearId: nextSchoolYearId, requireMfa: true })) return null;
  return nextSchoolYearId;
}

// Zdarzenie audytu odczytu archiwum: kto, który rok, jaka trasa. Bez danych osobowych.
export async function recordArchiveRead(executor, { actorId, schoolYearId, viaSchoolYearId, route }) {
  await insertAuditEvent(executor, {
    actorId, action: 'year_close.archive_read', entityType: 'school_year', entityId: schoolYearId,
    // #174: rok archiwum także w metadanych (filtr dziennika, wymóg insertAuditEvent dla 'year_close.').
    metadata: { schoolYearId, route, viaSchoolYearId },
  });
}
