// Logika czysta ekranu kampanii e-mail (issue #147, część 1 — src/pg/routes/email.js).
// Bez sieci, bez DOM: łatwe do przetestowania (tests/email-panel-core.test.js).

import { isoToLocalInput, localInputToIso } from '../shared/zoned-time.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

// Role z src/pg/routes/email.js (EDITOR_ROLES/APPROVER_ROLES) — testy równoległości
// w tests/email-panel-core.test.js pilnują zgodności z serwerem, tak jak
// tests/role-policy-parity.test.js dla ról finansowych panelu/księgi.
export const EDITOR_ROLES = Object.freeze(['board', 'treasurer']);
export const APPROVER_ROLES = Object.freeze(['board']);

export const STATUS_LABELS = Object.freeze({
  draft: 'Szkic',
  approved: 'Zatwierdzona',
  sending: 'W wysyłce',
  paused: 'Wstrzymana',
  done: 'Zakończona',
  cancelled: 'Anulowana',
});

export const AUDIENCE_LABELS = Object.freeze({
  all_households: 'Wszystkie rodziny roku',
  no_payment_record: 'Rodziny bez odnotowanej wpłaty',
  class_households: 'Rodziny dzieci jednej klasy (zebranie klasowe)',
});

// Kody z computeSnapshot w src/pg/routes/email.js.
export const EXCLUSION_REASON_LABELS = Object.freeze({
  payment_recorded: 'wpłata już odnotowana',
  no_consent: 'brak zgody na kontakt',
  no_valid_email: 'brak poprawnego adresu e-mail',
  suppressed: 'adres wykluczony (odbicie lub rezygnacja)',
  duplicate_address: 'adres już użyty w innej rodzinie tej kampanii',
});

export function isValidId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value.trim());
}

// Wzorzec jak hasFinancialAccess w panel/core.js i ledger/core.js: liczą się
// tylko przydziały bez class_id (kampanie dotyczą całej szkoły).
function hasRoleAccess(grants, roles, schoolYearId = '') {
  return (Array.isArray(grants) ? grants : []).some((grant) => roles.includes(grant?.role)
    && !grant.classId
    && (!schoolYearId || !grant.schoolYearId || grant.schoolYearId === String(schoolYearId).trim()));
}

export function hasEditorAccess(grants, schoolYearId = '') {
  return hasRoleAccess(grants, EDITOR_ROLES, schoolYearId);
}

export function hasApproverAccess(grants, schoolYearId = '') {
  return hasRoleAccess(grants, APPROVER_ROLES, schoolYearId);
}

export function buildCampaignsUrl(schoolYearId, cursor = '') {
  if (!isValidId(schoolYearId)) throw new Error('Podaj poprawny identyfikator roku szkolnego.');
  const base = `/api/email/campaigns?schoolYearId=${encodeURIComponent(schoolYearId.trim())}`;
  // #159: kolejna strona listy (kursor keyset z poprzedniej odpowiedzi).
  return cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base;
}

export function campaignUrl(id) {
  if (!isValidId(id)) throw new Error('Niepoprawny identyfikator wysyłki.');
  return `/api/email/campaigns/${encodeURIComponent(id)}`;
}

export function campaignActionUrl(id, action) {
  return `${campaignUrl(id)}/${action}`;
}

// Adres zamaskowany do domyślnego widoku listy odbiorców (issue #147: "bez
// pełnych adresów domyślnie — maskowanie […], pełny adres po kliknięciu").
// Serwer i tak zapisuje odczyt w dzienniku przy każdym GET …/recipients,
// niezależnie od tego, czy panel pokazuje maskę czy pełny adres.
export function maskEmail(email) {
  const text = String(email ?? '');
  const at = text.lastIndexOf('@');
  if (at < 1) return '***';
  return `${text[0]}***${text.slice(at)}`;
}

export function makeIdempotencyKey(prefix, randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto)) {
  if (typeof randomUUID !== 'function') throw new Error('Ta przeglądarka nie obsługuje bezpiecznych identyfikatorów operacji.');
  return `${prefix}-${randomUUID()}`;
}

// Serwer sprawdza createdBy/updatedBy/snapshotBuiltBy (four_eyes); GET zwraca
// tylko createdBy (campaignView w src/pg/routes/email.js), więc to jest
// PRZYBLIŻENIE do sterowania widocznością przycisku — nigdy kontrola dostępu
// (AGENTS.md: „ukrycie przycisku nie jest kontrolą dostępu”). Serwer odrzuci
// 403 self_approval_forbidden, jeśli aktor edytował albo budował migawkę.
export function isLikelyOwnCampaign(campaign, actorId) {
  return Boolean(campaign && actorId && campaign.createdBy === actorId);
}

export function canOfferApproval(campaign, actorId) {
  return Boolean(campaign)
    && campaign.status === 'draft'
    && Boolean(campaign.recipientsHash)
    && Number(campaign.recipientsCount) > 0
    && !isLikelyOwnCampaign(campaign, actorId);
}

// Komunikat „dane od migawki zmieniły się” tylko dla istniejącej migawki, która przestała
// być aktualna (snapshotCurrent === false). Bez migawki serwer zwraca null.
export function isSnapshotStale(preview) {
  return Boolean(preview) && Boolean(preview.recipientsHash) && preview.snapshotCurrent === false;
}

export function formatExclusions(exclusions) {
  return Object.entries(exclusions || {})
    .filter(([, count]) => Number(count) > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, count]) => `${EXCLUSION_REASON_LABELS[reason] ?? reason}: ${count}`);
}

export function formatDayPlan(plan) {
  if (!plan) return '';
  // API zwraca liczbę dni (planDays); starsze odpowiedzi mogły mieć listę.
  const days = Array.isArray(plan.days) ? plan.days.length : Number(plan.days) || 0;
  const cap = plan.dailyCap ?? '—';
  if (days <= 1) return `Zmieści się w jednym dniu (limit dzienny konta: ${cap}).`;
  return `Wysyłka rozłoży się na ${days} dni (limit dzienny konta: ${cap}; reszta zarezerwowana na inną pocztę: ${plan.reservedForOtherMail ?? '—'}).`;
}

// Strefa harmonogramu z odpowiedzi podglądu (domyślnie Europe/Brussels).
export const DEFAULT_SCHEDULE_TIMEZONE = 'Europe/Brussels';

export function scheduleTimezone(schedule) {
  return schedule?.timezone || DEFAULT_SCHEDULE_TIMEZONE;
}

// Pole datetime-local (czas lokalny strefy harmonogramu) → ISO UTC do API.
// Puste pole = brak terminu (null); zły format → wyjątek.
export function sendNotBeforeFromInput(value, timeZone = DEFAULT_SCHEDULE_TIMEZONE) {
  if (!value) return null;
  const iso = localInputToIso(value, timeZone);
  if (!iso) throw new Error('Podaj poprawną datę i godzinę startu wysyłki.');
  return iso;
}

export function sendNotBeforeToInput(iso, timeZone = DEFAULT_SCHEDULE_TIMEZONE) {
  return isoToLocalInput(iso, timeZone);
}

// Opis harmonogramu do wyświetlenia. To szacunek serwera (bez pauz i odmów dostawcy).
export function formatSchedule(schedule) {
  if (!schedule) return '';
  const zone = scheduleTimezone(schedule);
  const lines = [];
  lines.push(schedule.sendNotBefore
    ? `Start nie wcześniej niż: ${sendNotBeforeToInput(schedule.sendNotBefore, zone).replace('T', ' ')} (${zone}).`
    : 'Start: jak najszybciej po zakolejkowaniu.');
  if (schedule.window?.enabled) {
    const two = (n) => String(n).padStart(2, '0');
    const time = (m) => `${two(Math.floor(m / 60))}:${two(m % 60)}`;
    lines.push(`Okno wysyłki: dni ${schedule.window.days.join(',')} (1 = pon.), ${time(schedule.window.startMinutes)}–${time(schedule.window.endMinutes)} (${zone}).`);
  } else {
    lines.push('Okno godzin wysyłki wyłączone (zarząd nie ustalił godzin, D-16).');
  }
  if (schedule.startsAtLocal) lines.push(`Szacowany pierwszy przebieg: ${schedule.startsAtLocal} (${zone}).`);
  if (schedule.endsAtLocal) lines.push(`Szacowane zakończenie: do ${schedule.endsAtLocal} (${zone}).`);
  return lines.join(' ');
}

// Kody z contentWarnings w src/email/content.js — nie blokują, informują zatwierdzającego.
export const WARNING_LABELS = Object.freeze({
  missing_skip_if_paid_sentence: 'Treść nie wspomina, że wpłacający mogą pominąć wiadomość.',
  missing_payment_reference: 'Treść nie zawiera znacznika {rodzina} (tytułu przelewu rodziny).',
  template_requires_board_decision_d16: 'Szablon czeka na decyzję zarządu o treści (D-16) — nie jest „zatwierdzonym” wzorem.',
});

export function formatWarnings(warnings) {
  return (Array.isArray(warnings) ? warnings : []).map((code) => WARNING_LABELS[code] ?? code);
}

export function describeApiError(status, code) {
  if (status === 401 || code === 'unauthenticated') return 'Sesja wygasła. Zaloguj się ponownie.';
  if (code === 'mfa_required') return 'Potwierdź logowanie drugim składnikiem (MFA), aby korzystać z kampanii.';
  if (code === 'self_approval_forbidden') return 'Zatwierdzić musi inna osoba niż ta, która przygotowała szkic lub migawkę.';
  if (status === 403 || code === 'forbidden') return 'Nie masz uprawnień do kampanii e-mail w wybranym roku szkolnym.';
  return null;
}
