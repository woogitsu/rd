// Jedna definicja „dziś” dla relacji uczeń–gospodarstwo (issue #194, #157):
// data kalendarzowa w strefie Europe/Brussels, niezależnie od TimeZone sesji
// PostgreSQL i strefy procesu. Po stronie SQL to samo liczy rd_today()
// (migracja 0023).

const FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Brussels', year: 'numeric', month: '2-digit', day: '2-digit',
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
