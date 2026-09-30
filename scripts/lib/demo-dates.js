// Daty danych demo liczone względem dnia uruchomienia seeda (przegląd demo 4).
//
// Wcześniej seed wpisywał stałe daty z października–grudnia 2026, więc przy pokazie
// w połowie października część danych była „z przyszłości” (np. protokół zatwierdzony
// 30 września przy zebraniu 20 listopada ze statusem „Odbyte”). Teraz:
//   - rok szkolny to rok zawierający dzień uruchomienia (Europe/Brussels, od 1 września
//     — ta sama heurystyka co /site/ i panele: shared/school-year.js#heuristicSchoolYearId);
//   - dzień wyciągu bankowego to „wczoraj” (albo 1 września, jeśli rok właśnie się zaczął);
//   - wpłaty, wpisy księgi, pozycje wyciągu i zebranie leżą przed dniem wyciągu, w tych
//     samych odstępach co w dotychczasowym planie (do 61 dni wstecz). Gdy od 1 września
//     minęło mniej dni, odstępy są proporcjonalnie ściśnięte, bo każda data wpłaty i wpisu
//     księgi musi mieścić się w roku szkolnym (trigger z 0027, date_outside_school_year);
//   - zapowiedzi wydarzeń są w przyszłości (za 14 i 42 dni, najpóźniej 31 sierpnia).
// Kolejność zdarzeń i wszystkie kwoty są takie same jak w dotychczasowym planie.
// Deterministyczne: ta sama chwila `now` daje te same daty (testy i `--teraz=RRRR-MM-DD`).
import { formatSchoolYear, heuristicSchoolYearId } from '../../shared/school-year.js';

const TIME_ZONE = 'Europe/Brussels';
const DATE_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

// Najdłuższy odstęp w planie: pierwsza wpłata była 61 dni przed dniem wyciągu
// (dawniej 2026-10-05 → 2026-12-05).
export const DEMO_PLAN_SPAN_DAYS = 61;

// Data kalendarzowa (RRRR-MM-DD) chwili `now` w strefie szkoły.
export function brusselsDate(now) {
  return DATE_PARTS.format(now);
}

export function addDays(isoDate, days) {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS);
}

// `--teraz=RRRR-MM-DD` (albo pełny znacznik ISO) → Date; RRRR-MM-DD oznacza południe
// w Brukseli tego dnia (bez wątpliwości co do strefy przy północy).
export function parseDemoNow(value) {
  if (value === undefined || value === null || value === '') return new Date();
  const text = String(value).trim();
  const date = ISO_DATE.test(text) ? new Date(`${text}T10:00:00Z`) : new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`Nieprawidłowa data „teraz”: ${text} (oczekiwane RRRR-MM-DD).`);
  return date;
}

export function demoTimeline(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('demoTimeline: nieprawidłowa data „teraz”.');
  const schoolYearId = heuristicSchoolYearId(now);
  const startYear = Number(schoolYearId.slice(0, 4));
  const startsOn = `${startYear}-09-01`;
  const endsOn = `${startYear + 1}-08-31`;
  const today = brusselsDate(now);
  const yesterday = addDays(today, -1);
  const statementDate = yesterday < startsOn ? startsOn : yesterday;
  const elapsedDays = daysBetween(startsOn, statementDate);
  const scale = Math.min(1, elapsedDays / DEMO_PLAN_SPAN_DAYS);
  // `daysBefore` = odstęp od dnia wyciągu w pełnym planie; wynik nigdy nie wypada przed 1 września.
  const beforeStatement = (daysBefore) => addDays(statementDate, -Math.round(daysBefore * scale));
  const upcoming = (daysAhead) => {
    const date = addDays(today, daysAhead);
    return date > endsOn ? endsOn : date;
  };
  return {
    now, today, schoolYearId, schoolYearLabel: formatSchoolYear(schoolYearId), startsOn, endsOn,
    statementDate, elapsedDays, scale, beforeStatement, upcoming,
  };
}
