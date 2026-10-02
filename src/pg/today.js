// Jedna definicja „dziś” dla relacji uczeń–gospodarstwo (issue #194, #157):
// data kalendarzowa w strefie Europe/Brussels, niezależnie od TimeZone sesji
// PostgreSQL i strefy procesu. Po stronie SQL to samo liczy rd_today()
// (migracja 0023).

// Strefa szkoły: jedyne źródło dla dat dziennych liczonych z czasu (timestamptz).
// Kolumny DATE są już datami i nie przechodzą przez tę strefę.
export const SCHOOL_TIME_ZONE = 'Europe/Brussels';

// SQL: 'YYYY-MM-DD' dnia brukselskiego dla wyrażenia timestamptz — nie zależy od
// TimeZone sesji bazy.
export const brusselsDaySql = (expr) => `to_char((${expr}) AT TIME ZONE '${SCHOOL_TIME_ZONE}', 'YYYY-MM-DD')`;

// SQL: dzień brukselski jako DATE dla wyrażenia timestamptz.
export const brusselsDateSql = (expr) => `((${expr}) AT TIME ZONE '${SCHOOL_TIME_ZONE}')::date`;

// SQL: chwila (timestamptz) początku dnia kalendarzowego (wyrażenie DATE) w Brukseli.
export const brusselsStartOfDaySql = (dateExpr) => `((${dateExpr})::timestamp AT TIME ZONE '${SCHOOL_TIME_ZONE}')`;

const FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: SCHOOL_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

// 'YYYY-MM-DD' dnia w Brukseli dla chwili `now`.
export function brusselsDay(now = new Date()) {
  return FORMAT.format(now);
}

// Dzień obowiązywania członkostw dla żądania. Domyślnie null — zapytanie
// używa wtedy rd_today() w bazie. Testy mogą podać env.now (funkcja zwracająca
// Date), by przesunąć „dziś” parametrem zamiast zegara systemowego.
export function effectiveDay(env) {
  return typeof env?.now === 'function' ? brusselsDay(env.now()) : null;
}
