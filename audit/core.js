// Logika czysta ekranu Komisji Rewizyjnej (issue #147 — src/pg/routes/reconciliation.js,
// GET /api/reports/audit). Bez sieci, bez DOM: testy w tests/audit-panel-core.test.js.
// Raport jest tylko do odczytu. Jedyne zapisy ekranu to ścieżka kontroli (uwagi, odpowiedzi, wniosek — #137,
// /api/audit-reviews); księgi, wpłat ani dowodów ekran nie dotyka (D-09).

import { formatEur } from '../panel/money.js';
import { shortId } from '../shared/short-id.js';
import { evidenceNote } from '../shared/evidence-note.js';
import { formatDateOrTimestamp } from '../shared/zoned-time.js';

export const TIME_ZONE = 'Europe/Brussels';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

// Role trasy raportu (REPORT_ROLES w src/pg/routes/reconciliation.js). Ekran w
// nawigacji dotyczy roli `audit`; zarząd i skarbnik mają ten sam raport w panelu
// uzgodnień. Parzystość z serwerem pilnuje tests/audit-panel-core.test.js.
export const REPORT_ROLES = Object.freeze(['audit', 'board', 'treasurer']);

export function isValidId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value.trim());
}

// PRZYBLIŻENIE widoczności ekranu (AGENTS.md: ukrycie przycisku nie jest kontrolą
// dostępu) — serwer i tak sprawdza rolę, rok, MFA przy każdym żądaniu.
export function hasReportAccess(grants, schoolYearId = '') {
  return (Array.isArray(grants) ? grants : []).some((grant) => REPORT_ROLES.includes(grant?.role)
    && !grant.classId
    && (!schoolYearId || !grant.schoolYearId || grant.schoolYearId === String(schoolYearId).trim()));
}

export function reportUrl(schoolYearId, format = 'json') {
  if (!isValidId(schoolYearId)) throw new Error('Podaj poprawny identyfikator roku szkolnego.');
  if (!['json', 'html', 'xlsx'].includes(format)) throw new Error('Nieznany format raportu.');
  return `/api/reports/audit?schoolYearId=${encodeURIComponent(schoolYearId.trim())}&format=${format}`;
}

export function describeApiError(status, code) {
  if (status === 401 || code === 'unauthenticated') return 'Sesja wygasła. Zaloguj się ponownie.';
  if (code === 'mfa_required' || code === 'mfa_enrollment_required') return 'Potwierdź logowanie drugim składnikiem (MFA), aby zobaczyć raport.';
  if (status === 404 || code === 'school_year_not_found') return 'Nie znaleziono wybranego roku szkolnego.';
  if (status === 403 || code === 'forbidden') return 'Nie masz uprawnień do raportu dla wybranego roku szkolnego.';
  return null;
}

const DIRECTION = Object.freeze({ income: 'przychód', expense: 'wydatek' });
const RECONCILIATION_STATUS = Object.freeze({ draft: 'szkic', confirmed: 'zatwierdzone', abandoned: 'porzucone' });
const RESOLUTION_STATUS = Object.freeze({ adopted: 'przyjęta', rejected: 'odrzucona', draft: 'projekt', withdrawn: 'wycofana' });

export const CHECK_LABELS = Object.freeze({
  year_end_balance: 'Saldo księgi na ostatni dzień roku a bilans zamknięcia',
  dates_within_school_year: 'Daty wpisów i wpłat w granicach roku szkolnego',
  payments_in_ledger: 'Wpłaty (netto) a wpłaty ujęte w księdze',
  reconciliation_matches: 'Powiązania pozycji wyciągu: zgodność kwot i brak podwójnego ujęcia',
  latest_confirmed_reconciliation: 'Ostatnie zatwierdzone uzgodnienie rachunku',
});

function text(value) {
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

// Przegląd demo 4: data jak w kolumnach paneli („2026-10-20”), znacznik czasu
// w strefie Europe/Brussels („2026-10-20 16:05”) — nie „UTC”. Ta sama funkcja
// (shared/zoned-time.js) co w raporcie HTML serwera (src/pg/audit-report.js).
export function formatDate(value) {
  return formatDateOrTimestamp(value, TIME_ZONE) ?? '—';
}

// Komórka z identyfikatorem: skrót (shared/short-id.js), pełna wartość w podpowiedzi.
// main.js wstawia `text` przez textContent, a `title` jako atrybut.
export function idCell(value) {
  if (value === null || value === undefined || value === '') return '—';
  return { text: shortId(value), title: String(value) };
}

export function checkDetails(check) {
  switch (check?.id) {
    case 'year_end_balance':
      return `bilans zamknięcia ${formatEur(check.closingBalanceCents)}; saldo na koniec roku ${formatEur(check.balanceAtYearEndCents)}; różnica ${formatEur(check.differenceCents)}`;
    case 'dates_within_school_year':
      return `wpisy księgi poza rokiem: ${text(check.ledgerEntryCount)}; wpłaty poza rokiem: ${text(check.paymentCount)}`;
    case 'payments_in_ledger':
      return `wpłaty ${formatEur(check.paymentsNetCents)}; ujęte w księdze ${formatEur(check.ledgerLinkedNetCents)}; różnica ${formatEur(check.differenceCents)}; wpłaty bez wpisu księgi: ${text(check.paymentsWithoutLedgerEntry)}`;
    case 'reconciliation_matches':
      return `niezgodne kwotowo: ${text(check.amountMismatchCount)}; podwójne ujęcie: ${text(check.doubleCountedCount)}; dopasowania zbiorcze niezgodne: ${text(check.groupAmountMismatchCount ?? 0)}`;
    case 'latest_confirmed_reconciliation':
      return check.statementDate
        ? `wyciąg z ${formatDate(check.statementDate)}; różnica ${formatEur(check.differenceCents)}; przelewy po dacie wyciągu: ${text(check.bankEntriesAfterStatement)}`
        : 'brak zatwierdzonego uzgodnienia w tym roku';
    default:
      return '';
  }
}

export function checkResult(check) {
  if (check?.ok === null || check?.ok === undefined) return 'nie liczono';
  return check.ok ? 'zgodne' : 'niezgodne';
}

// Buduje modele sekcji do wyświetlenia: { id, title, headers, rows, empty, note }.
// Wiersz to tablica napisów (bez HTML — main.js wstawia je przez textContent).
// Raporty starsze (z archiwum) mogą nie mieć niektórych sekcji — każda jest opcjonalna.
export function buildSections(report) {
  if (!report || typeof report !== 'object') return [];
  const sections = [];
  const balance = report.balance ?? {};
  sections.push({
    id: 'balance',
    title: 'Bilans roku',
    headers: ['Pozycja', 'Kwota'],
    rows: [
      ['Bilans otwarcia (z korektami)', formatEur(balance.openingBalanceCents)],
      ['Przychody netto', formatEur(balance.incomeCents)],
      ['Wydatki netto', formatEur(balance.expenseCents)],
      ['Bilans zamknięcia', formatEur(balance.closingBalanceCents)],
      ['Bilans zamknięcia — rachunek', formatEur(balance.closingBankCents)],
      ['Bilans zamknięcia — kasa', formatEur(balance.closingCashCents)],
    ],
    numeric: [1],
  });

  const checks = Array.isArray(report.checks?.items) ? report.checks.items : [];
  sections.push({
    id: 'checks',
    title: 'Kontrole krzyżowe',
    headers: ['Kontrola', 'Wynik', 'Wartości'],
    rows: checks.map((check) => [CHECK_LABELS[check.id] ?? check.id, checkResult(check), checkDetails(check)]),
    empty: 'Brak kontroli.',
    note: 'Wynik kontroli jest wskaźnikiem do sprawdzenia z dokumentami źródłowymi, nie oceną.',
  });

  sections.push({
    id: 'categories',
    title: 'Przychody i wydatki według kategorii',
    headers: ['Rodzaj', 'Kategoria', 'Wpisy', 'Kwota pierwotna', 'Korekty', 'Netto'],
    rows: (report.categories ?? []).map((item) => [
      DIRECTION[item.direction] ?? text(item.direction), text(item.name), text(item.entryCount),
      formatEur(item.grossCents), formatEur(item.correctedCents), formatEur(item.netCents),
    ]),
    numeric: [2, 3, 4, 5],
    empty: 'Brak kategorii w tym roku.',
  });

  sections.push({
    id: 'large-expenses',
    title: 'Wydatki powyżej 3000 EUR',
    headers: ['Data', 'Kategoria', 'Opis', 'Kwota', 'Netto', 'Uchwała', 'Zgodność z przyjętą uchwałą'],
    rows: (report.largeExpenses ?? []).map((item) => [
      formatDate(item.occurredOn), text(item.category), text(item.description),
      formatEur(item.amountCents), formatEur(item.netAmountCents),
      `${text(item.resolutionReference)}${item.resolutionLink === 'text' && item.resolutionReference ? ' (powiązanie tekstowe)' : ''}`,
      item.matchesAdoptedResolution === true ? 'tak'
        : item.matchesAdoptedResolution === false ? 'brak zgodnej przyjętej uchwały' : 'nie sprawdzono',
    ]),
    numeric: [3, 4],
    empty: 'Brak wydatków powyżej 3000 EUR.',
  });

  if (Array.isArray(report.resolutionExecution)) {
    sections.push({
      id: 'resolution-execution',
      title: 'Wykonanie uchwał finansowych',
      headers: ['Uchwała', 'Tytuł', 'Stan', 'Kwota upoważnienia', 'Wydatki netto', 'Pozostało', 'Wpisy'],
      rows: report.resolutionExecution.map((item) => [
        text(item.number), text(item.title), RESOLUTION_STATUS[item.status] ?? text(item.status),
        item.authorizedAmountCents === null ? 'bez kwoty' : formatEur(item.authorizedAmountCents),
        formatEur(item.spentNetCents),
        item.remainingCents === null ? '—' : formatEur(item.remainingCents),
        text(item.entryCount),
      ]),
      numeric: [3, 4, 5, 6],
      empty: 'Brak wydatków powiązanych z uchwałą przez jej wskazanie.',
    });
  }

  if (report.expenseReviews) {
    const reviews = report.expenseReviews;
    sections.push({
      id: 'reviews',
      title: 'Weryfikacja wydatków przez drugą osobę',
      headers: ['Stan', 'Liczba', 'Netto'],
      rows: [
        ['Niezweryfikowane', text(reviews.unverified?.count), formatEur(reviews.unverified?.netCents)],
        ['Zakwestionowane', text(reviews.questioned?.count), formatEur(reviews.questioned?.netCents)],
        ['Zweryfikowane', text(reviews.verified?.count), formatEur(reviews.verified?.netCents)],
      ],
      numeric: [1, 2],
      note: `Możliwe podziały wydatku (kilka wydatków do 3000 EUR w tej samej kategorii w ciągu ${text(reviews.splitWindowDays)} dni): ${(reviews.possibleSplits ?? []).length}. Informacja do sprawdzenia, nie zarzut.`,
    });
  }

  sections.push({
    id: 'corrections',
    title: 'Korekty wpisów księgi',
    headers: ['Zapisano', 'Wpis księgi', 'Data wpisu', 'Rodzaj', 'Kwota korekty', 'Powód'],
    rows: (report.corrections ?? []).map((item) => [
      formatDate(item.createdAt), idCell(item.ledgerEntryId), formatDate(item.entryOccurredOn),
      DIRECTION[item.direction] ?? text(item.direction), formatEur(item.amountCents), text(item.reason),
    ]),
    numeric: [4],
    empty: 'Brak korekt wpisów księgi.',
  });

  const reconciliations = report.reconciliations ?? { items: [] };
  sections.push({
    id: 'reconciliations',
    title: 'Uzgodnienia rachunku bankowego',
    headers: ['Data wyciągu', 'Stan', 'Saldo wyciągu', 'Saldo księgi', 'Różnica', 'Niedopasowane pozycje', 'Wyjaśnienie'],
    rows: (reconciliations.items ?? []).map((item) => [
      formatDate(item.statementDate), RECONCILIATION_STATUS[item.status] ?? text(item.status),
      formatEur(item.statementBalanceCents), formatEur(item.ledgerBalanceCents), formatEur(item.differenceCents),
      text(item.unmatchedLineCount), text(item.confirmationNote),
    ]),
    numeric: [2, 3, 4, 5],
    empty: 'Brak uzgodnień rachunku w tym roku.',
    note: `Zatwierdzone: ${text(reconciliations.confirmedCount)}; szkice: ${text(reconciliations.draftCount)}; porzucone: ${text(reconciliations.abandonedCount ?? 0)}.`,
  });

  if (report.evidence) {
    const missing = report.evidence.expensesWithoutEvidence ?? { count: 0, netCents: 0, items: [] };
    sections.push({
      id: 'evidence',
      title: 'Dowody wydatków',
      headers: ['Data', 'Kategoria', 'Opis', 'Netto', 'Wpis księgi', 'Uwagi'],
      rows: (missing.items ?? []).map((item) => [
        formatDate(item.occurredOn), text(item.category), text(item.description), formatEur(item.netAmountCents), idCell(item.id),
        evidenceNote(item),
      ]),
      numeric: [3],
      empty: 'Każdy wydatek ma co najmniej jeden dokument.',
      note: `Wydatki bez dowodu: ${text(missing.count)}, suma netto ${formatEur(missing.netCents)}. Możliwe duplikaty dowodu: ${(report.evidence.possibleDuplicateEvidence ?? []).length}.`,
    });
  }
  return sections;
}

// --- Ścieżka kontroli: uwagi, odpowiedzi, zamknięcia i wniosek (#137) ---------
// Serwer (src/pg/routes/audit-reviews.js) sprawdza rolę przy każdym żądaniu;
// poniższe funkcje tylko przybliżają widoczność formularzy.

export const REVIEW_READ_ROLES = Object.freeze(['audit', 'board', 'treasurer']);
export const REVIEW_WRITE_ROLES = Object.freeze(['audit']);
export const REVIEW_ANSWER_ROLES = Object.freeze(['board', 'treasurer']);

const KIND_LABEL = Object.freeze({ question: 'pytanie', finding: 'ustalenie' });
const TARGET_LABEL = Object.freeze({ ledger_entry: 'wpis księgi', reconciliation: 'uzgodnienie', year: 'rok szkolny' });
const STATUS_LABEL = Object.freeze({ open: 'otwarta', answered: 'odpowiedź bez zamknięcia', closed: 'zamknięta' });

function hasRole(grants, roles, schoolYearId = '') {
  return (Array.isArray(grants) ? grants : []).some((grant) => roles.includes(grant?.role)
    && !grant.classId
    && (!schoolYearId || !grant.schoolYearId || grant.schoolYearId === String(schoolYearId).trim()));
}

export const canWriteReviews = (grants, schoolYearId) => hasRole(grants, REVIEW_WRITE_ROLES, schoolYearId);
export const canAnswerReviews = (grants, schoolYearId) => hasRole(grants, REVIEW_ANSWER_ROLES, schoolYearId);

export function reviewsUrl(schoolYearId, path = '') {
  if (!isValidId(schoolYearId)) throw new Error('Podaj poprawny identyfikator roku szkolnego.');
  return `/api/audit-reviews/${encodeURIComponent(schoolYearId.trim())}${path}`;
}

export function reviewReplyUrl(schoolYearId, noteId, action) {
  if (!isValidId(noteId) || !['answers', 'closure'].includes(action)) throw new Error('Niepoprawna uwaga.');
  return reviewsUrl(schoolYearId, `/notes/${encodeURIComponent(noteId)}/${action}`);
}

export function reviewStatusLabel(status) {
  return STATUS_LABEL[status] ?? text(status);
}

/** Wiersze tabeli wątków: [zapisano, rodzaj, dotyczy, treść, stan, odpowiedzi, zamknięcie]. */
export function buildReviewRows(reviews) {
  return (reviews?.threads ?? []).map((thread) => ({
    id: thread.id,
    status: thread.status,
    cells: [
      formatDate(thread.createdAt),
      KIND_LABEL[thread.kind] ?? text(thread.kind),
      { text: `${TARGET_LABEL[thread.targetType] ?? text(thread.targetType)} ${shortId(thread.targetId)}`, title: thread.targetId },
      text(thread.body),
      reviewStatusLabel(thread.status),
      thread.answers.length ? thread.answers.map((answer) => `${formatDate(answer.createdAt)}: ${text(answer.body)}`).join('\n') : '—',
      thread.closed ? `${formatDate(thread.closed.createdAt)}${thread.closed.body ? `: ${thread.closed.body}` : ''}` : '—',
    ],
  }));
}

export function reviewSummary(reviews) {
  const counts = reviews?.counts ?? { open: 0, answered: 0, closed: 0 };
  const conclusion = reviews?.currentConclusion;
  return {
    counts: `Otwarte: ${counts.open}; z odpowiedzią, bez zamknięcia: ${counts.answered}; zamknięte: ${counts.closed}.`,
    conclusion: conclusion ? `Wniosek końcowy (${formatDate(conclusion.createdAt)}): ${text(conclusion.body)}` : 'Brak wniosku końcowego w systemie.',
  };
}

/** Klucz idempotencji jednego zamiaru zapisu; ponowne kliknięcie tego samego formularza używa go ponownie. */
export function newIdempotencyKey(prefix = 'ar') {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}
