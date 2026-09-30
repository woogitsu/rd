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
//   - zapowiedzi wydarzeń są w przyszłości (za 14 i 42 dni, najpóźniej 31 sierpnia);
//     termin wypadający w belgijskie święto ustawowe (np. 1.11, 11.11, 25.12) przesuwa
//     się na następny dzień bez święta (przegląd demo 5: kiermasz wypadał 11.11).
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

// Belgijskie święta ustawowe (dni wolne od pracy): stałe daty i święta ruchome
// liczone od Wielkanocy. Tylko do układania dat DEMO — to nie jest kalendarz szkoły
// (dni wolne szkoły ustala szkoła, nie ten plik).
const FIXED_HOLIDAYS = new Set(['01-01', '05-01', '07-21', '08-15', '11-01', '11-11', '12-25']);

// Niedziela Wielkanocna (kalendarz gregoriański, algorytm Meeusa/Jonesa/Butchera).
export function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function isBelgianPublicHoliday(isoDate) {
  if (FIXED_HOLIDAYS.has(isoDate.slice(5))) return true;
  const easter = easterSunday(Number(isoDate.slice(0, 4)));
  // Poniedziałek Wielkanocny (+1), Wniebowstąpienie (+39), Poniedziałek Zielonych Świątek (+50).
  return [1, 39, 50].some((offset) => addDays(easter, offset) === isoDate);
}

// Czas lokalny w Brukseli (RRRR-MM-DD + GG:MM) → znacznik ISO z przesunięciem strefy
// (+01:00 zimą, +02:00 latem), np. dla POST /api/meetings (wymaga strefy w znaczniku).
export function brusselsLocalIso(isoDate, time) {
  for (const offset of ['+01:00', '+02:00']) {
    const candidate = `${isoDate}T${time}:00${offset}`;
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(candidate));
    if (local === time && brusselsDate(new Date(candidate)) === isoDate) return candidate;
  }
  throw new Error(`brusselsLocalIso: ${isoDate} ${time} nie istnieje w strefie ${TIME_ZONE}.`);
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
  // Termin zapowiedzi: za `daysAhead` dni, poza belgijskimi świętami ustawowymi
  // (przesunięcie na następny dzień bez święta), najpóźniej ostatni dzień roku szkolnego
  // (wtedy przesunięcie wstecz, ale nie przed dzień jutrzejszy).
  const upcoming = (daysAhead) => {
    let date = addDays(today, daysAhead);
    while (date <= endsOn && isBelgianPublicHoliday(date)) date = addDays(date, 1);
    if (date > endsOn) {
      date = endsOn;
      while (date > today && isBelgianPublicHoliday(date)) date = addDays(date, -1);
    }
    return date;
  };
  return {
    now, today, schoolYearId, schoolYearLabel: formatSchoolYear(schoolYearId), startsOn, endsOn,
    statementDate, elapsedDays, scale, beforeStatement, upcoming,
  };
}
