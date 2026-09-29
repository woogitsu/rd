import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCalendar, buildEventComponent, escapeText, foldLine, icalUidDomain } from '../src/ical.js';

test('escapeText escapes backslash, semicolon, comma and newline per RFC 5545 §3.3.11', () => {
  assert.equal(escapeText('a;b,c\\d\ne'), 'a\\;b\\,c\\\\d\\ne');
  assert.equal(escapeText('a\r\nb'), 'a\\nb');
  assert.equal(escapeText(null), '');
});

test('foldLine wraps at 75 octets without cutting a multi-byte UTF-8 character', () => {
  const long = `SUMMARY:${'ż'.repeat(40)}`; // 2-byte UTF-8 character, ASCII-only property name.
  const folded = foldLine(long);
  const lines = folded.split('\r\n ');
  assert.ok(lines.length > 1);
  for (const segment of lines) {
    const bytes = new TextEncoder().encode(segment);
    assert.ok(bytes.length <= 75, `segment exceeds 75 octets: ${bytes.length}`);
  }
  // Re-joining the folded output and stripping the CRLF+space markers must
  // reconstruct the exact original text (no byte was lost or duplicated).
  const rejoined = folded.split('\r\n ').join('');
  assert.equal(rejoined, long);
});

test('short lines are not folded', () => {
  assert.equal(foldLine('SUMMARY:short'), 'SUMMARY:short');
});

test('icalUidDomain falls back to a safe default and rejects unexpected input', () => {
  assert.equal(icalUidDomain({}), 'rd.example.invalid');
  assert.equal(icalUidDomain({ ICAL_UID_DOMAIN: 'rada.example.org' }), 'rada.example.org');
  assert.equal(icalUidDomain({ ICAL_UID_DOMAIN: 'not a domain; DROP TABLE' }), 'rd.example.invalid');
});

function sampleEvent(overrides = {}) {
  return {
    id: 'evt-1',
    title: 'Zebranie Rady',
    description: null,
    location: null,
    organizer: null,
    startsAtUtc: new Date('2026-11-12T17:30:00Z'),
    endsAtUtc: new Date('2026-11-12T19:00:00Z'),
    status: 'scheduled',
    sequence: 1,
    dtstamp: new Date('2026-10-01T10:00:00Z'),
    ...overrides,
  };
}

test('buildEventComponent has a stable UID across revisions and no ORGANIZER/email field', () => {
  const lines = buildEventComponent(sampleEvent({ organizer: 'Rada Rodziców' }), { uidDomain: 'rd.example.invalid' });
  assert.equal(lines[0], 'BEGIN:VEVENT');
  assert.equal(lines.at(-1), 'END:VEVENT');
  assert.ok(lines.some((l) => l === 'UID:event-evt-1@rd.example.invalid'));
  assert.ok(!lines.some((l) => l.startsWith('ORGANIZER')));
  assert.ok(lines.some((l) => l === 'CONTACT:Rada Rodziców'));
  assert.ok(!lines.join('\n').includes('mailto'));
});

test('DTSTART/DTEND are emitted in UTC (Z), without TZID', () => {
  const lines = buildEventComponent(sampleEvent());
  assert.ok(lines.some((l) => l === 'DTSTART:20261112T173000Z'));
  assert.ok(lines.some((l) => l === 'DTEND:20261112T190000Z'));
  assert.ok(!lines.join('\n').includes('TZID'));
});

function dt(lines, name) {
  return lines.find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1);
}

test('29.03.2026: brak godziny 02:00-02:59, 01:59 CET i 03:00 CEST dzieli 1 minuta UTC', () => {
  // 01:59 CET = 00:59Z; 03:00 CEST = 01:00Z; lokalnie 02:xx nie istnieje.
  const lines = buildEventComponent(sampleEvent({
    startsAtUtc: new Date('2026-03-29T00:59:00Z'),
    endsAtUtc: new Date('2026-03-29T01:00:00Z'),
  }));
  assert.equal(dt(lines, 'DTSTART'), '20260329T005900Z');
  assert.equal(dt(lines, 'DTEND'), '20260329T010000Z');
});

test('25.10.2026: powtórzona godzina 02:30 (CEST i CET) daje dwa różne, jednoznaczne czasy UTC', () => {
  const cest = new Date('2026-10-25T02:30:00+02:00'); // pierwsze 02:30
  const cet = new Date('2026-10-25T02:30:00+01:00'); // drugie 02:30
  const a = buildEventComponent(sampleEvent({ startsAtUtc: cest, endsAtUtc: cet }));
  assert.equal(dt(a, 'DTSTART'), '20261025T003000Z');
  assert.equal(dt(a, 'DTEND'), '20261025T013000Z');
  assert.notEqual(dt(a, 'DTSTART'), dt(a, 'DTEND'));
});

test('wydarzenie przez zmianę czasu (25.10.2026 01:30 CEST -> 03:30 CET) zachowuje rzeczywisty odstęp 3 h', () => {
  const lines = buildEventComponent(sampleEvent({
    startsAtUtc: new Date('2026-10-25T01:30:00+02:00'),
    endsAtUtc: new Date('2026-10-25T03:30:00+01:00'),
  }));
  assert.equal(dt(lines, 'DTSTART'), '20261024T233000Z');
  assert.equal(dt(lines, 'DTEND'), '20261025T023000Z');
});

test('DTSTAMP, DTSTART i DTEND przyjmują też ciągi ISO, a niepoprawna data jest odrzucona', () => {
  const lines = buildEventComponent(sampleEvent({ startsAtUtc: '2026-07-01T10:00:00.000Z', dtstamp: '2026-06-01T08:00:00Z' }));
  assert.equal(dt(lines, 'DTSTART'), '20260701T100000Z');
  assert.equal(dt(lines, 'DTSTAMP'), '20260601T080000Z');
  assert.throws(() => buildEventComponent(sampleEvent({ startsAtUtc: 'nie-data' })), RangeError);
});

test('UID jest stały przy zmianie treści i SEQUENCE', () => {
  const uid = (e) => buildEventComponent(e).find((l) => l.startsWith('UID:'));
  assert.equal(uid(sampleEvent({ sequence: 1 })), uid(sampleEvent({ sequence: 5, title: 'Inny tytuł' })));
});

test('żadna linia całego kalendarza nie przekracza 75 oktetów, a rozwinięcie zwraca oryginał', () => {
  const description = 'Zażółć gęślą jaźń; długi, opis. '.repeat(20);
  const ics = buildCalendar([sampleEvent({ description, title: 'Ż'.repeat(80) })]);
  for (const physical of ics.split('\r\n')) {
    assert.ok(new TextEncoder().encode(physical).length <= 75, `za długa linia: ${physical.length}`);
  }
  const unfolded = ics.replace(/\r\n /g, '');
  assert.ok(unfolded.includes(`DESCRIPTION:${escapeText(description)}`));
  assert.ok(unfolded.includes(`SUMMARY:${'Ż'.repeat(80)}`));
});

test('kanał publiczny nie zawiera pól osobowych (ORGANIZER, ATTENDEE, mailto)', () => {
  const ics = buildCalendar([sampleEvent({ organizer: 'Rada Rodziców' })]);
  for (const forbidden of ['ORGANIZER', 'ATTENDEE', 'mailto']) {
    assert.equal(ics.includes(forbidden), false, forbidden);
  }
});

test('an event with no ends_at has no DTEND', () => {
  const lines = buildEventComponent(sampleEvent({ endsAtUtc: null }));
  assert.ok(!lines.some((l) => l.startsWith('DTEND')));
});

test('cancelled events use STATUS:CANCELLED and carry no cancellation reason field', () => {
  const lines = buildEventComponent(sampleEvent({ status: 'cancelled' }));
  assert.ok(lines.some((l) => l === 'STATUS:CANCELLED'));
  assert.ok(!lines.join('\n').toUpperCase().includes('REASON'));
});

test('buildCalendar wraps events in VCALENDAR (UTC, bez VTIMEZONE) with CRLF line endings', () => {
  const ics = buildCalendar([sampleEvent()], { uidDomain: 'rd.example.invalid' });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.equal(ics.includes('VTIMEZONE'), false);
  assert.equal(ics.includes('TZID'), false);
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.equal(ics.includes('\n\n'), false);
  // Every line must be CRLF-terminated (no lone LF).
  const bare = ics.replace(/\r\n/g, '');
  assert.equal(bare.includes('\n'), false);
});

test('buildCalendar with no events still produces a valid, parseable envelope', () => {
  const ics = buildCalendar([], { uidDomain: 'rd.example.invalid' });
  assert.ok(ics.includes('BEGIN:VCALENDAR'));
  assert.ok(ics.includes('END:VCALENDAR'));
  assert.equal(ics.includes('BEGIN:VEVENT'), false);
});

test('semicolon, comma and newline in title/location are escaped in the output', () => {
  const lines = buildEventComponent(sampleEvent({
    title: 'Zebranie; ważne, pilne',
    location: "Sala A\nBudynek B",
  }));
  assert.ok(lines.some((l) => l === 'SUMMARY:Zebranie\\; ważne\\, pilne'));
  assert.ok(lines.some((l) => l === 'LOCATION:Sala A\\nBudynek B'));
});
