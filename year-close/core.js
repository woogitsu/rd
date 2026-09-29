// Logika czysta ekranu zamknięcia roku szkolnego (issue #147, część 3 —
// src/pg/routes/year-close.js). Bez sieci, bez DOM: łatwe do przetestowania
// (tests/year-close-panel-core.test.js).

import { formatSchoolYear } from '../shared/school-year.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

// Role z src/pg/routes/year-close.js (READ_ROLES/CHECKLIST_ROLES/CLOSE_ROLES) —
// test parzystości w tests/year-close-panel-core.test.js pilnuje zgodności z serwerem.
export const READ_ROLES = Object.freeze(['board', 'treasurer']);
export const CHECKLIST_ROLES = Object.freeze(['board', 'treasurer']);
export const CLOSE_ROLES = Object.freeze(['board']);

// Kolejność i kody z CHECKLIST_ITEMS w src/pg/routes/year-close.js.
export const CHECKLIST_ITEMS = Object.freeze([
  'financial_report',
  'audit_commission_report',
  'minutes_approved',
  'resolutions_archived',
  'reconciliation_confirmed',
  'documents_handed_over',
]);

export const CHECKLIST_ITEM_LABELS = Object.freeze({
  financial_report: 'Sprawozdanie finansowe',
  audit_commission_report: 'Raport Komisji Rewizyjnej',
  minutes_approved: 'Protokoły zebrań zatwierdzone',
  resolutions_archived: 'Uchwały zarchiwizowane',
  reconciliation_confirmed: 'Uzgodnienie wyciągu bankowego potwierdzone',
  documents_handed_over: 'Dokumentacja przekazana',
});

export const STATUS_LABELS = Object.freeze({
  open: 'Otwarty',
  closing: 'W trakcie zamykania',
  closed: 'Zamknięty',
});

export function isValidId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value.trim());
}

// Wzorzec jak w email/core.js, reconciliation/core.js: liczą się tylko
// przydziały bez class_id (zamknięcie roku dotyczy całej szkoły).
function hasRoleAccess(grants, roles, schoolYearId = '') {
  return (Array.isArray(grants) ? grants : []).some((grant) => roles.includes(grant?.role)
    && !grant.classId
    && (!schoolYearId || !grant.schoolYearId || grant.schoolYearId === String(schoolYearId).trim()));
}

export function hasReadAccess(grants, schoolYearId = '') {
  return hasRoleAccess(grants, READ_ROLES, schoolYearId);
}

export function hasChecklistAccess(grants, schoolYearId = '') {
  return hasRoleAccess(grants, CHECKLIST_ROLES, schoolYearId);
}

export function hasCloseAccess(grants, schoolYearId = '') {
  return hasRoleAccess(grants, CLOSE_ROLES, schoolYearId);
}

export function statusUrl(schoolYearId) {
  if (!isValidId(schoolYearId)) throw new Error('Podaj poprawny identyfikator roku szkolnego.');
  return `/api/year-close/${encodeURIComponent(schoolYearId.trim())}`;
}

export function startUrl(schoolYearId) {
  return `${statusUrl(schoolYearId)}/start`;
}

export function checklistUrl(schoolYearId, item) {
  if (!CHECKLIST_ITEMS.includes(item)) throw new Error('Nieznany punkt listy kontrolnej.');
  return `${statusUrl(schoolYearId)}/checklist/${item}`;
}

export function closeUrl(schoolYearId) {
  return `${statusUrl(schoolYearId)}/close`;
}

export function handoverUrl(schoolYearId) {
  return `${statusUrl(schoolYearId)}/handover`;
}

// Serwer sprawdza initiated_by przy zamknięciu (four_eyes_required); GET zwraca
// initiatedBy, więc to jest PRZYBLIŻENIE widoczności przycisku, nigdy kontrola
// dostępu (AGENTS.md: „ukrycie przycisku nie jest kontrolą dostępu”).
export function isLikelyOwnClosure(status, actorId) {
  return Boolean(status && actorId && status.initiatedBy === actorId);
}

// Rozpoczęcie zamknięcia: serwer (startClosing) wymaga roli CLOSE_ROLES i roku bez
// wiersza zamknięcia (stan open). Lista kontrolna NIE jest warunkiem rozpoczęcia —
// punkty można potwierdzać dopiero po rozpoczęciu (year_close_not_started), więc
// jej brak nie może blokować przycisku. Warunek dotyczy dopiero „Zamknij rok”.
export function canOfferStart(status, grants, schoolYearId = '') {
  return Boolean(status) && status.status === 'open' && hasCloseAccess(grants, schoolYearId);
}

// Treść okna potwierdzenia rozpoczęcia (shared/confirm-dialog.js, destructive).
export function startConfirmation(schoolYearId, nextSchoolYearId) {
  return {
    title: 'Rozpocząć zamknięcie roku?',
    destructive: true,
    confirmLabel: 'Rozpocznij zamknięcie',
    effects: [
      `Rok ${formatSchoolYear(schoolYearId)} przejdzie w stan „zamykanie”, a rok docelowy ${formatSchoolYear(nextSchoolYearId)} zostanie na stałe zapisany w wierszu zamknięcia.`,
      'Rozpoczęcia nie da się cofnąć ani usunąć — ani z tego ekranu, ani przez API. Zdarzenie trafia do dziennika z Twoim kontem.',
      'Samo rozpoczęcie niczego jeszcze nie zamyka. Zamknięcie roku (przeniesienie bilansu, wygaszenie ról tej kadencji) wymaga potwierdzenia całej listy kontrolnej i drugiej osoby.',
    ],
    warning: 'Na danych demonstracyjnych i próbnych nie rozpoczynaj zamknięcia.',
  };
}

export function canOfferClose(status, actorId) {
  return Boolean(status)
    && status.status === 'closing'
    && Array.isArray(status.missingChecklistItems)
    && status.missingChecklistItems.length === 0
    && !isLikelyOwnClosure(status, actorId);
}

export function checklistProgress(status) {
  const items = Array.isArray(status?.checklist) ? status.checklist : [];
  const confirmed = items.filter((entry) => entry.confirmed).length;
  return { confirmed, total: items.length || CHECKLIST_ITEMS.length };
}

export function describeApiError(status, code) {
  if (status === 401 || code === 'unauthenticated') return 'Sesja wygasła. Zaloguj się ponownie.';
  if (code === 'mfa_required') return 'Potwierdź logowanie drugim składnikiem (MFA), aby zamknąć rok szkolny.';
  if (code === 'four_eyes_required') return 'Zamknąć musi inna osoba niż ta, która rozpoczęła zamknięcie roku.';
  if (code === 'checklist_incomplete') return 'Uzupełnij wszystkie punkty listy kontrolnej przed zamknięciem.';
  if (code === 'year_end_balance_mismatch') return 'Bilans zamknięcia nie zgadza się z saldem księgi na koniec roku. Wyjaśnij rozbieżność (wpisy datowane po końcu roku); potwierdzenie z powodem jest możliwe przez API.';
  if (code === 'year_end_confirmation_mismatch') return 'Rozbieżność salda końca roku zmieniła się od ostatniego podglądu. Odśwież stan i sprawdź kwoty.';
  if (code === 'school_year_closed') return 'Ten rok szkolny jest już zamknięty.';
  if (code === 'year_close_not_started') return 'Zamknięcie roku nie zostało jeszcze rozpoczęte.';
  if (code === 'year_close_already_started') return 'Zamknięcie roku zostało już rozpoczęte z innym rokiem docelowym.';
  if (code === 'invalid_next_school_year') return 'Wskaż poprawny, późniejszy rok szkolny jako docelowy.';
  if (code === 'next_school_year_not_found') return 'Wskazany docelowy rok szkolny nie istnieje.';
  if (code === 'next_school_year_not_open') return 'Docelowy rok szkolny ma już przypisane inne zamknięcie.';
  if (code === 'next_year_opening_balance_exists') return 'Docelowy rok szkolny ma już wpisany bilans otwarcia.';
  if (status === 403 || code === 'forbidden') return 'Nie masz uprawnień do zamknięcia roku w wybranym roku szkolnym.';
  if (status === 404 || code === 'school_year_not_found') return 'Nie znaleziono wybranego roku szkolnego.';
  return null;
}
