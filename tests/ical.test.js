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

test('DTSTART/DTEND use Europe/Brussels TZID, not raw UTC', () => {
  const lines = buildEventComponent(sampleEvent());
  assert.ok(lines.some((l) => l === 'DTSTART;TZID=Europe/Brussels:20261112T183000'));
  assert.ok(lines.some((l) => l === 'DTEND;TZID=Europe/Brussels:20261112T200000'));
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

test('buildCalendar wraps events in VCALENDAR/VTIMEZONE with CRLF line endings', () => {
  const ics = buildCalendar([sampleEvent()], { uidDomain: 'rd.example.invalid' });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.includes('BEGIN:VTIMEZONE\r\n'));
  assert.ok(ics.includes('TZID:Europe/Brussels\r\n'));
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
