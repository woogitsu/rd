// Funkcja doboru dat scenariuszy przełomu doby konta (#84, tests/helpers/quota-dates.js):
// dla każdego dnia kilku lat wybrany dzień leży w przyszłości z zapasem, w pełni w
// czasie letnim (UTC+2), a rok szkolny obejmuje i „dziś”, i ten dzień. Bez bazy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { accountDay } from '../src/email/worker.js';
import { DEFAULT_LEAD_DAYS, quotaScenarioDates } from './helpers/quota-dates.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BRUSSELS = 'Europe/Brussels';
const addOne = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

test('daty przełomu doby: dla „dziś” 2027-06-01, 2027-08-09 i 2028-01-15 dzień w czasie letnim z zapasem i rok szkolny obejmujący oba końce', () => {
  const expected = [
    { today: '2027-06-01T12:00:00Z', day: '2027-07-01', schoolYear: { startsOn: '2026-09-01', endsOn: '2027-08-31' } },
    { today: '2027-08-09T12:00:00Z', day: '2027-09-08', schoolYear: { startsOn: '2026-09-01', endsOn: '2028-08-31' } },
    { today: '2028-01-15T12:00:00Z', day: '2028-04-01', schoolYear: { startsOn: '2027-09-01', endsOn: '2028-08-31' } },
  ];
  assert.equal(expected.length, 3);
  for (const { today, day, schoolYear } of expected) {
    const dates = quotaScenarioDates(new Date(today));
    assert.equal(dates.day, day, `dziś ${today}`);
    assert.equal(dates.nextDay, addOne(day));
    assert.deepEqual(dates.schoolYear, schoolYear, `dziś ${today}`);
    assert.ok(dates.day > today.slice(0, 10), `dzień ${dates.day} leży po dzisiejszym ${today}`);
  }
});

test('daty przełomu doby: każdy dzień 2026-2031 — zapas, pełne CEST, doba konta zaczyna się o 22:00 UTC, rok szkolny obejmuje dziś i dzień', () => {
  let checked = 0;
  for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2032, 0, 1); ms += DAY_MS) {
    // Początek i koniec doby UTC, żeby dzień graniczny nie ginął.
    for (const hours of [0, 23]) {
      const today = new Date(ms + hours * 60 * 60 * 1000);
      const { day, nextDay, schoolYear } = quotaScenarioDates(today);
      const label = `dziś ${today.toISOString()}`;
      const todayDay = today.toISOString().slice(0, 10);
      assert.ok(Date.parse(`${day}T00:00:00Z`) >= Date.parse(`${todayDay}T00:00:00Z`) + DEFAULT_LEAD_DAYS * DAY_MS, label);
      assert.equal(nextDay, addOne(day), label);
      // CEST: północ w Brukseli = 22:00 UTC dnia D; 21:59 UTC to jeszcze dzień D.
      assert.equal(accountDay(new Date(`${day}T21:59:00Z`), BRUSSELS), day, label);
      assert.equal(accountDay(new Date(`${day}T22:00:00Z`), BRUSSELS), nextDay, label);
      assert.equal(accountDay(new Date(`${nextDay}T01:00:00Z`), BRUSSELS), nextDay, label);
      assert.equal(accountDay(new Date(`${nextDay}T21:59:00Z`), BRUSSELS), nextDay, label);
      assert.equal(accountDay(new Date(`${nextDay}T22:00:00Z`), BRUSSELS), addOne(nextDay), label);
      // Rok szkolny obejmuje i „dziś”, i oba dni scenariusza.
      assert.ok(schoolYear.startsOn <= todayDay && todayDay <= schoolYear.endsOn, label);
      assert.ok(schoolYear.startsOn <= day && nextDay <= schoolYear.endsOn, label);
      checked += 1;
    }
  }
  assert.ok(checked > 4000, `sprawdzono ${checked} chwil`);
});

test('daty przełomu doby: zapas dni jest parametrem; „dziś” w październiku przeskakuje do kwietnia', () => {
  const today = new Date('2026-10-02T10:00:00Z');
  assert.equal(quotaScenarioDates(today, { minLeadDays: 0 }).day, '2027-04-01');
  assert.equal(quotaScenarioDates(today, { minLeadDays: 200 }).day, '2027-04-20');
  assert.equal(quotaScenarioDates(today, { minLeadDays: 365 }).day, '2028-04-01');
});
