// Czysta arytmetyka czasu w wybranej strefie (Intl, bez stałych przesunięć UTC),
// wspólna dla workera/API e-mail (#130) i panelu. Zmiana czasu (koniec marca
// i października) jest obsługiwana przez Intl, nie przez ręczne +1 h.

export function zoneParts(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

// Przesunięcie strefy względem UTC w minutach w danej chwili.
function offsetMinutes(instant, timeZone) {
  const p = zoneParts(instant, timeZone);
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(instant.getTime() / 60_000) * 60_000) / 60_000;
}

// Chwila UTC dla lokalnej daty i minuty doby. Dwa przybliżenia przesunięcia
// wystarczą również w dobie zmiany czasu; nieistniejąca godzina lokalna
// (luka wiosenna) przesuwa się na pierwszą istniejącą po niej.
export function zonedInstant({ year, month, day }, minutesOfDay, timeZone) {
  const naive = Date.UTC(year, month - 1, day, 0, minutesOfDay);
  let guess = new Date(naive - offsetMinutes(new Date(naive), timeZone) * 60_000);
  guess = new Date(naive - offsetMinutes(guess, timeZone) * 60_000);
  return guess;
}

// Data i godzina lokalna do wyświetlenia, np. "2026-03-30 09:00".
export function localLabel(instant, timeZone) {
  const p = zoneParts(instant, timeZone);
  const two = (n) => String(n).padStart(2, '0');
  return `${p.year}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)}`;
}

// Wartość pola <input type="datetime-local"> ("2026-03-30T09:00") → ISO UTC,
// liczona w strefie `timeZone`. Zły format → null.
export function localInputToIso(value, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value ?? ''));
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  return zonedInstant({ year, month, day }, hour * 60 + minute, timeZone).toISOString();
}

// ISO UTC → wartość pola datetime-local w strefie `timeZone` (pusty tekst dla null).
export function isoToLocalInput(iso, timeZone) {
  if (!iso) return '';
  return localLabel(new Date(iso), timeZone).replace(' ', 'T');
}

// Data lub znacznik czasu do raportów i tabel (przegląd demo 4, raport Komisji
// Rewizyjnej, wydruki): polski zapis dd.mm.rrrr — sama data „2026-10-20” →
// „20.10.2026”; znacznik czasu (ISO UTC albo Date) → „20.10.2026 16:05” w strefie
// `timeZone`, nigdy w UTC (decyzja użytkownika 30.09: wydruki w zapisie polskim).
// Pusta wartość → null (wywołujący wybiera „—” albo pusty tekst); tekst w innym
// kształcie wraca bez zmian.
const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

const polishDate = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const polishLabel = (instant, timeZone) => {
  const label = localLabel(instant, timeZone);
  return `${polishDate(label.slice(0, 10))}${label.slice(10)}`;
};

export function formatDateOrTimestamp(value, timeZone) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : polishLabel(value, timeZone);
  const text = String(value).trim();
  if (ISO_DATE_ONLY.test(text)) return polishDate(text);
  if (ISO_TIMESTAMP.test(text)) {
    const instant = new Date(text);
    if (!Number.isNaN(instant.getTime())) return polishLabel(instant, timeZone);
  }
  return text;
}
