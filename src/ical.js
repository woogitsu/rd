// Moduł iCalendar (RFC 5545): czyste funkcje formatujące, bez dostępu do bazy
// i bez DOM. Używany przez /api/public/events.ics oraz /api/public/events/:id.ics
// (src/pg/events.js) oraz przez plik kalendarza zatwierdzonego zawiadomienia
// o zebraniu (GET /api/meetings/:id/notices/:noticeId/calendar, #113).
//
// Czasy DTSTART/DTEND/DTSTAMP są emitowane w UTC (przyrostek Z). Wydarzenia są
// w bazie timestamptz (chwila w czasie), więc UTC jest jednoznaczne także dla
// powtórzonej godziny 02:00-02:59 (25.10.2026, koniec czasu letniego) i nie
// wymaga VTIMEZONE. Czas lokalny z TZID byłby tam niejednoznaczny (CEST i CET
// dają ten sam zapis), a godzina 02:00-02:59 z 29.03.2026 w ogóle nie istnieje.
// Kalendarze subskrybentów przeliczają UTC na własną strefę. ICAL_TIMEZONE
// zostaje tylko jako podpowiedź wyświetlania (X-WR-TIMEZONE).

export const ICAL_TIMEZONE = 'Europe/Brussels';

const CRLF = '\r\n';
const FOLD_LIMIT = 75; // oktety (bajty UTF-8), zgodnie z RFC 5545 §3.1.

// Domena do UID, dopóki nie ma decyzji D-20 (domena produkcyjna). Konfigurowalna
// przez ICAL_UID_DOMAIN, żeby dało się to podmienić bez zmiany kodu.
export function icalUidDomain(env) {
  const raw = (env && Object.hasOwn(env, 'ICAL_UID_DOMAIN') ? env.ICAL_UID_DOMAIN : undefined)
    ?? (typeof process !== 'undefined' ? process.env?.ICAL_UID_DOMAIN : undefined);
  const value = typeof raw === 'string' ? raw.trim() : '';
  return /^[A-Za-z0-9.-]{1,255}$/.test(value) ? value : 'rd.example.invalid';
}

// Escapowanie wartości TEXT (RFC 5545 §3.3.11): najpierw backslash, potem
// średnik, przecinek i nowa linia.
export function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// Zawija jedną logiczną linię do FOLD_LIMIT oktetów UTF-8, bez przecinania
// wielobajtowego znaku. Kontynuacja zaczyna się od pojedynczej spacji.
export function foldLine(line) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(line);
  if (bytes.length <= FOLD_LIMIT) return line;
  const decoder = new TextDecoder();
  const parts = [];
  let start = 0;
  let limit = FOLD_LIMIT;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Nie przecinaj wielobajtowego znaku UTF-8: kontynuacja bajtu ma bity 10xxxxxx (0x80-0xBF).
    while (end < bytes.length && end > start && (bytes[end] & 0xc0) === 0x80) end -= 1;
    parts.push(decoder.decode(bytes.subarray(start, end)));
    start = end;
    limit = FOLD_LIMIT - 1; // kontynuacja ma na początku spację, która liczy się do limitu
  }
  return parts.join(`${CRLF} `);
}

function line(name, value, params = '') {
  return foldLine(`${name}${params}:${value}`);
}

function utcStamp(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new RangeError('invalid_ical_date');
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T`
    + `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

// event: { id, title, description, location, organizer, startsAtUtc, endsAtUtc,
//          status: 'scheduled'|'cancelled', sequence (int >= 0), dtstamp (Date|string) }
// uidPrefix odróżnia przestrzenie UID (wydarzenia: 'event', zebrania: 'meeting').
export function buildEventComponent(event, { uidDomain = 'rd.example.invalid', uidPrefix = 'event' } = {}) {
  const lines = ['BEGIN:VEVENT'];
  lines.push(line('UID', `${uidPrefix}-${event.id}@${uidDomain}`));
  lines.push(line('DTSTAMP', utcStamp(event.dtstamp ?? event.startsAtUtc)));
  lines.push(line('DTSTART', utcStamp(event.startsAtUtc)));
  if (event.endsAtUtc) lines.push(line('DTEND', utcStamp(event.endsAtUtc)));
  lines.push(line('SUMMARY', escapeText(event.title)));
  if (event.description) lines.push(line('DESCRIPTION', escapeText(event.description)));
  if (event.location) lines.push(line('LOCATION', escapeText(event.location)));
  // Bez pola ORGANIZER (wymagałoby adresu e-mail jako CAL-ADDRESS): tylko tekst,
  // bez danych osobowych ani adresu, zgodnie z kryterium akceptacji issue #122.
  if (event.organizer) lines.push(line('CONTACT', escapeText(event.organizer)));
  lines.push(line('SEQUENCE', String(Math.max(0, Number(event.sequence) || 0))));
  lines.push(line('STATUS', event.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'));
  lines.push(line('TRANSP', 'TRANSPARENT'));
  lines.push('END:VEVENT');
  return lines;
}

export function buildCalendar(events, { calName = 'Kalendarz Rady Rodziców', uidDomain = 'rd.example.invalid', method = 'PUBLISH', uidPrefix = 'event' } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Rada Rodzicow//RD Kalendarz//PL',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    line('X-WR-CALNAME', escapeText(calName)),
    line('X-WR-TIMEZONE', ICAL_TIMEZONE),
  ];
  for (const event of events) lines.push(...buildEventComponent(event, { uidDomain, uidPrefix }));
  lines.push('END:VCALENDAR');
  return lines.join(CRLF) + CRLF;
}
