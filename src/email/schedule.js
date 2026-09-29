// Harmonogram kampanii (#130): czysta arytmetyka czasu w strefie okna wysyłki.
// Bez dostępu do bazy i sieci. Wszystkie obliczenia w strefie Europe/Brussels
// (albo EMAIL_SEND_WINDOW_TIMEZONE), nigdy przez stałe przesunięcie UTC —
// dzięki temu zmiana czasu (koniec marca i października) nie przesuwa okna.
import { withinSendWindow } from './brevo.js';
import { localLabel, zoneParts, zonedInstant } from '../../shared/zoned-time.js';

export { localLabel };

const DAY_MS = 86_400_000;

function addLocalDays({ year, month, day }, n) {
  const d = new Date(Date.UTC(year, month - 1, day) + n * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function isoWeekday({ year, month, day }) {
  const d = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return d === 0 ? 7 : d;
}

// Pierwsza chwila >= `from`, w której wolno wysyłać (okno wyłączone: `from`).
// Null, gdy w najbliższych 14 dniach okno się nie otwiera (np. puste okno).
export function nextSendOpening(from, sendWindow) {
  if (!sendWindow?.enabled || withinSendWindow(from, sendWindow)) return from;
  const today = zoneParts(from, sendWindow.timezone);
  for (let n = 0; n <= 14; n += 1) {
    const date = addLocalDays(today, n);
    if (!sendWindow.days.has(isoWeekday(date))) continue;
    if (sendWindow.endMinutes <= sendWindow.startMinutes) return null;
    const opening = zonedInstant(date, sendWindow.startMinutes, sendWindow.timezone);
    if (opening.getTime() > from.getTime()) return opening;
  }
  return null;
}

// Szacunek terminów dla podglądu: start = najwcześniejsza chwila po `now`
// i po send_not_before, w której wolno wysyłać; koniec = koniec okna w ostatnim
// dniu potrzebnym na wysłanie `days` dziennych partii. To szacunek: nie uwzględnia
// pauz, odmów dostawcy ani wiadomości spoza kampanii zużywających limit.
export function estimateSchedule({ now, sendNotBefore, days, sendWindow }) {
  const timeZone = sendWindow?.timezone ?? 'Europe/Brussels';
  const notBefore = sendNotBefore ? new Date(sendNotBefore) : null;
  const from = notBefore && notBefore.getTime() > now.getTime() ? notBefore : now;
  const start = nextSendOpening(from, sendWindow);
  const base = { timezone: timeZone, estimated: true, windowEnabled: Boolean(sendWindow?.enabled) };
  if (!start || !days) return { ...base, startsAt: start?.toISOString() ?? null, endsAt: null, startsAtLocal: start ? localLabel(start, timeZone) : null, endsAtLocal: null };
  let cursor = zoneParts(start, timeZone);
  let remaining = days;
  let last = start;
  for (let guard = 0; guard < 400 && remaining > 0; guard += 1) {
    const isFirst = remaining === days;
    if (isFirst || !sendWindow?.enabled || sendWindow.days.has(isoWeekday(cursor))) {
      remaining -= 1;
      last = zonedInstant(cursor, sendWindow?.enabled ? sendWindow.endMinutes : 24 * 60, timeZone);
    }
    if (remaining > 0) cursor = addLocalDays(cursor, 1);
  }
  const end = remaining > 0 ? null : last;
  return {
    ...base,
    startsAt: start.toISOString(), endsAt: end?.toISOString() ?? null,
    startsAtLocal: localLabel(start, timeZone), endsAtLocal: end ? localLabel(end, timeZone) : null,
  };
}
