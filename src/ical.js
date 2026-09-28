// Moduł iCalendar (RFC 5545): czyste funkcje formatujące, bez dostępu do bazy
// i bez DOM. Używany przez /api/public/events.ics oraz /api/public/events/:id.ics
// (src/pg/events.js). Docelowo posłuży też załącznikowi zawiadomienia o zebraniu
// (osobne issue #113).
//
// Zakres: tylko strefa Europe/Brussels (jedyna używana w projekcie,
// zob. EVENT_TIMEZONE w src/pg/events.js). VTIMEZONE opisuje regułę UE
// (ostatnia niedziela marca/października), obowiązującą od 1996 r.

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
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T`
    + `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: ICAL_TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function localStamp(date) {
  const d = date instanceof Date ? date : new Date(date);
  const parts = Object.fromEntries(partsFormatter.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}${parts.month}${parts.day}T${parts.hour}${parts.minute}${parts.second}`;
}

// VTIMEZONE dla Europe/Brussels: reguła UE, ostatnia niedziela marca (CET->CEST)
// i ostatnia niedziela października (CEST->CET), obowiązuje od 1996.
function vtimezoneBlock() {
  return [
    'BEGIN:VTIMEZONE',
    `TZID:${ICAL_TIMEZONE}`,
    'X-LIC-LOCATION:Europe/Brussels',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'TZNAME:CEST',
    'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'TZNAME:CET',
    'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
  ].map(foldLine);
}

// event: { id, title, description, location, organizer, startsAtUtc, endsAtUtc,
//          status: 'scheduled'|'cancelled', sequence (int >= 0), dtstamp (Date|string) }
export function buildEventComponent(event, { uidDomain = 'rd.example.invalid' } = {}) {
  const lines = ['BEGIN:VEVENT'];
  lines.push(line('UID', `event-${event.id}@${uidDomain}`));
  lines.push(line('DTSTAMP', utcStamp(event.dtstamp ?? event.startsAtUtc)));
  lines.push(line('DTSTART', localStamp(event.startsAtUtc), `;TZID=${ICAL_TIMEZONE}`));
  if (event.endsAtUtc) lines.push(line('DTEND', localStamp(event.endsAtUtc), `;TZID=${ICAL_TIMEZONE}`));
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

export function buildCalendar(events, { calName = 'Kalendarz Rady Rodziców', uidDomain = 'rd.example.invalid', method = 'PUBLISH' } = {}) {
  const usesTimezone = events.length > 0;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Rada Rodzicow//RD Kalendarz//PL',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    line('X-WR-CALNAME', escapeText(calName)),
    line('X-WR-TIMEZONE', ICAL_TIMEZONE),
  ];
  if (usesTimezone) lines.push(...vtimezoneBlock());
  for (const event of events) lines.push(...buildEventComponent(event, { uidDomain }));
  lines.push('END:VCALENDAR');
  return lines.join(CRLF) + CRLF;
}
