// #130: harmonogram kampanii — arytmetyka okna wysyłki w strefie Europe/Brussels,
// w tym tygodnie zmiany czasu (29.03.2026 i 25.10.2026). Sztuczny zegar, bez bazy,
// bez transportu, bez sieci.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emailConfig, withinSendWindow } from '../src/email/brevo.js';
import { estimateSchedule, nextSendOpening } from '../src/email/schedule.js';
import { localInputToIso, isoToLocalInput, zonedInstant } from '../shared/zoned-time.js';

const config = emailConfig({
  EMAIL_SEND_WINDOW_ENABLED: 'true', EMAIL_SEND_WINDOW_TIMEZONE: 'Europe/Brussels',
  EMAIL_SEND_WINDOW_DAYS: '1-5', EMAIL_SEND_WINDOW_START: '09:00', EMAIL_SEND_WINDOW_END: '18:00',
});
const window = config.sendWindow;
const at = (iso) => new Date(iso);
const iso = (date) => date?.toISOString() ?? null;

test('okno 9:00-18:00 w Brukseli po zmianie czasu na letni (29.03.2026)', () => {
  // Przed zmianą (CET, UTC+1): 09:00 lokalnie = 08:00Z.
  assert.equal(withinSendWindow(at('2026-03-27T07:59:00Z'), window), false);
  assert.equal(withinSendWindow(at('2026-03-27T08:00:00Z'), window), true);
  assert.equal(withinSendWindow(at('2026-03-27T16:59:00Z'), window), true);
  assert.equal(withinSendWindow(at('2026-03-27T17:00:00Z'), window), false);
  // Niedziela ze zmianą czasu: cały dzień poza oknem.
  for (const h of ['00:30', '06:00', '10:00', '15:00']) assert.equal(withinSendWindow(at(`2026-03-29T${h}:00Z`), window), false);
  // Po zmianie (CEST, UTC+2): 09:00 lokalnie = 07:00Z; okno przesuwa się o godzinę w UTC.
  assert.equal(withinSendWindow(at('2026-03-30T06:59:00Z'), window), false);
  assert.equal(withinSendWindow(at('2026-03-30T07:00:00Z'), window), true);
  assert.equal(withinSendWindow(at('2026-03-30T15:59:00Z'), window), true);
  assert.equal(withinSendWindow(at('2026-03-30T16:00:00Z'), window), false);
});

test('okno 9:00-18:00 w Brukseli po zmianie czasu na zimowy (25.10.2026)', () => {
  // Przed zmianą (CEST): 09:00 lokalnie = 07:00Z.
  assert.equal(withinSendWindow(at('2026-10-23T06:59:00Z'), window), false);
  assert.equal(withinSendWindow(at('2026-10-23T07:00:00Z'), window), true);
  assert.equal(withinSendWindow(at('2026-10-23T15:59:00Z'), window), true);
  assert.equal(withinSendWindow(at('2026-10-23T16:00:00Z'), window), false);
  for (const h of ['00:30', '01:30', '08:00', '12:00']) assert.equal(withinSendWindow(at(`2026-10-25T${h}:00Z`), window), false);
  // Po zmianie (CET): 09:00 lokalnie = 08:00Z.
  assert.equal(withinSendWindow(at('2026-10-26T07:59:00Z'), window), false);
  assert.equal(withinSendWindow(at('2026-10-26T08:00:00Z'), window), true);
  assert.equal(withinSendWindow(at('2026-10-26T16:59:00Z'), window), true);
  assert.equal(withinSendWindow(at('2026-10-26T17:00:00Z'), window), false);
});

test('nextSendOpening: najbliższe otwarcie okna przez weekend i zmianę czasu', () => {
  // W oknie: bez zmian.
  assert.equal(iso(nextSendOpening(at('2026-03-27T10:00:00Z'), window)), '2026-03-27T10:00:00.000Z');
  // Piątek wieczorem (CET) → poniedziałek 09:00 CEST = 07:00Z (weekend ze zmianą czasu).
  assert.equal(iso(nextSendOpening(at('2026-03-27T18:00:00Z'), window)), '2026-03-30T07:00:00.000Z');
  // Niedziela zmiany czasu → poniedziałek 07:00Z.
  assert.equal(iso(nextSendOpening(at('2026-03-29T10:00:00Z'), window)), '2026-03-30T07:00:00.000Z');
  // Piątek wieczorem (CEST) → poniedziałek 09:00 CET = 08:00Z (jesień).
  assert.equal(iso(nextSendOpening(at('2026-10-23T18:00:00Z'), window)), '2026-10-26T08:00:00.000Z');
  // Wczesny ranek przed otwarciem tego samego dnia.
  assert.equal(iso(nextSendOpening(at('2026-10-26T05:00:00Z'), window)), '2026-10-26T08:00:00.000Z');
  // Okno wyłączone: bez zmian. Puste okno (start >= end): nigdy się nie otwiera.
  assert.equal(iso(nextSendOpening(at('2026-10-25T10:00:00Z'), { enabled: false })), '2026-10-25T10:00:00.000Z');
  const empty = emailConfig({ EMAIL_SEND_WINDOW_ENABLED: 'true', EMAIL_SEND_WINDOW_START: '18:00', EMAIL_SEND_WINDOW_END: '09:00' }).sendWindow;
  assert.equal(nextSendOpening(at('2026-10-26T10:00:00Z'), empty), null);
});

test('estimateSchedule: start nie wcześniej niż send_not_before, koniec w czasie brukselskim', () => {
  // 7 dni roboczych od piątku 27.03.2026 obejmuje zmianę czasu: pt, pn..pt, pn.
  const plan = estimateSchedule({ now: at('2026-03-27T09:00:00Z'), sendNotBefore: null, days: 7, sendWindow: window });
  assert.equal(plan.startsAt, '2026-03-27T09:00:00.000Z');
  assert.equal(plan.startsAtLocal, '2026-03-27 10:00');
  assert.equal(plan.endsAtLocal, '2026-04-06 18:00', 'pt 27.03, pn-pt 30.03-03.04, pn 06.04');
  assert.equal(plan.endsAt, '2026-04-06T16:00:00.000Z', '18:00 CEST = 16:00Z, nie 17:00Z');
  assert.equal(plan.timezone, 'Europe/Brussels');
  assert.equal(plan.estimated, true);

  // Termin w przyszłości przesuwa start; sobota → poniedziałek 09:00.
  const later = estimateSchedule({ now: at('2026-03-20T09:00:00Z'), sendNotBefore: '2026-03-28T10:00:00Z', days: 1, sendWindow: window });
  assert.equal(later.startsAtLocal, '2026-03-30 09:00');
  assert.equal(later.endsAtLocal, '2026-03-30 18:00');

  // Termin w przeszłości nie cofa startu przed „teraz”.
  const past = estimateSchedule({ now: at('2026-10-26T09:00:00Z'), sendNotBefore: '2026-01-01T00:00:00Z', days: 1, sendWindow: window });
  assert.equal(past.startsAt, '2026-10-26T09:00:00.000Z');
  assert.equal(past.endsAtLocal, '2026-10-26 18:00');

  // Bez okna: koniec = koniec doby lokalnej ostatniego dnia (dni kalendarzowe).
  const noWindow = estimateSchedule({ now: at('2026-10-24T09:00:00Z'), sendNotBefore: null, days: 3, sendWindow: { enabled: false, timezone: 'Europe/Brussels' } });
  assert.equal(noWindow.endsAtLocal, '2026-10-27 00:00');
  assert.equal(noWindow.windowEnabled, false);

  // Brak dni (pusta lista odbiorców): tylko start.
  const none = estimateSchedule({ now: at('2026-10-26T09:00:00Z'), sendNotBefore: null, days: 0, sendWindow: window });
  assert.equal(none.endsAt, null);
});

test('pole datetime-local jest czasem brukselskim, także w dobie zmiany czasu', () => {
  assert.equal(localInputToIso('2026-03-30T09:00', 'Europe/Brussels'), '2026-03-30T07:00:00.000Z');
  assert.equal(localInputToIso('2026-03-23T09:00', 'Europe/Brussels'), '2026-03-23T08:00:00.000Z');
  assert.equal(localInputToIso('2026-10-26T09:00', 'Europe/Brussels'), '2026-10-26T08:00:00.000Z');
  assert.equal(localInputToIso('2026-10-19T09:00', 'Europe/Brussels'), '2026-10-19T07:00:00.000Z');
  assert.equal(localInputToIso('', 'Europe/Brussels'), null);
  assert.equal(localInputToIso('nie-data', 'Europe/Brussels'), null);
  for (const value of ['2026-03-30T09:00', '2026-10-26T18:00', '2026-07-01T00:00']) {
    assert.equal(isoToLocalInput(localInputToIso(value, 'Europe/Brussels'), 'Europe/Brussels'), value);
  }
  assert.equal(isoToLocalInput(null, 'Europe/Brussels'), '');
  // Nieistniejąca godzina 02:30 (29.03.2026) przesuwa się na istniejącą po luce.
  assert.equal(zonedInstant({ year: 2026, month: 3, day: 29 }, 150, 'Europe/Brussels').toISOString(), '2026-03-29T01:30:00.000Z');
});
