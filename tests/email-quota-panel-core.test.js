// Logika czysta ekranu dziennego limitu Brevo (#84, UI). Bez sieci i bez DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  QUOTA_MAX_COUNT, QUOTA_REASON_CODES, QUOTA_REASON_LABELS, buildOtherSendBody, dayRemaining,
  describeEntry, describeOtherSendEffects, describeQuotaError, describeQuotaSummary, quotaRows, quotaUrl,
} from '../email/quota-core.js';

const server = readFileSync(new URL('../src/pg/routes/email.js', import.meta.url), 'utf8');

test('powody i limity zgadzają się z serwerem', () => {
  const codes = server.match(/QUOTA_REASON_CODES = Object\.freeze\(\[([^\]]+)\]/)[1].match(/'([a-z_]+)'/g).map((x) => x.slice(1, -1));
  assert.ok(codes.length > 0);
  assert.deepEqual([...QUOTA_REASON_CODES], codes);
  assert.equal(Number(server.match(/QUOTA_MAX_COUNT = ([\d_]+);/)[1].replaceAll('_', '')), QUOTA_MAX_COUNT);
  for (const code of Object.keys(QUOTA_REASON_LABELS)) assert.ok(QUOTA_REASON_LABELS[code]);
});

test('kody błędów panelu istnieją na serwerze', () => {
  for (const code of ['invalid_quota_reason', 'invalid_quota_count', 'invalid_quota_day', 'quota_correction_target_not_found', 'quota_correction_exceeds', 'idempotency_conflict']) {
    assert.ok(server.includes(`'${code}'`), code);
    assert.ok(describeQuotaError(400, code), code);
  }
});

const QUOTA = {
  dailyLimit: 300, dailyReserved: 20, inFlight: 2, remaining: 250, generatedAt: '2026-10-05T10:00:00.000Z',
  windows: {
    utc: { today: { day: '2026-10-05', campaign: 10, other: 5, total: 15 }, tomorrow: { day: '2026-10-06', campaign: 0, other: 0, total: 0 } },
    account: { timezone: 'Europe/Brussels', today: { day: '2026-10-05', campaign: 10, other: 5, total: 15 }, tomorrow: { day: '2026-10-06', campaign: 0, other: 0, total: 0 } },
  },
  queuedCampaigns: { campaigns: 1, queuedMessages: 40 },
};

test('wiersze doby: UTC i strefa konta, pozostało nie spada poniżej zera', () => {
  const rows = quotaRows(QUOTA);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].remaining, 265);
  assert.match(rows[2].label, /Europe\/Brussels/);
  assert.equal(dayRemaining(QUOTA, { total: 999 }), 0);
  assert.deepEqual(quotaRows(null), []);
  assert.deepEqual(quotaRows({}), []);
  assert.match(describeQuotaSummary(QUOTA), /Kampanie w kolejce: 1, wiadomości oczekujące: 40/);
});

test('wpis i korekta: ciało zgodne z API (korekta ujemna, powód correction)', () => {
  const base = { schoolYearId: 'y2026', day: '2026-10-05' };
  assert.deepEqual(buildOtherSendBody({ ...base, kind: 'record', count: '7', reasonCode: 'invitation' }),
    { schoolYearId: 'y2026', day: '2026-10-05', count: 7, reasonCode: 'invitation' });
  assert.deepEqual(buildOtherSendBody({ ...base, kind: 'correction', count: '3', correctsId: 'abc-1' }),
    { schoolYearId: 'y2026', day: '2026-10-05', count: -3, reasonCode: 'correction', correctsId: 'abc-1' });
});

test('walidacja formularza odrzuca błędne dane', () => {
  const ok = { schoolYearId: 'y2026', day: '2026-10-05', kind: 'record', count: 5, reasonCode: 'other' };
  const bad = [
    { count: 0 }, { count: -2 }, { count: 1.5 }, { count: QUOTA_MAX_COUNT + 1 }, { count: '' },
    { day: '2026-02-30' }, { day: '5.10.2026' }, { reasonCode: 'correction' }, { reasonCode: '' },
    { kind: 'correction', correctsId: '' }, { kind: 'x' }, { schoolYearId: '' },
  ];
  assert.ok(bad.length > 0);
  for (const patch of bad) assert.throws(() => buildOtherSendBody({ ...ok, ...patch }), Error, JSON.stringify(patch));
});

test('okno potwierdzenia opisuje skutki i mówi, że nic nie jest wysyłane', () => {
  const record = describeOtherSendEffects(buildOtherSendBody({ schoolYearId: 'y1', day: '2026-10-05', kind: 'record', count: 4, reasonCode: 'invitation' }));
  const fix = describeOtherSendEffects(buildOtherSendBody({ schoolYearId: 'y1', day: '2026-10-05', kind: 'correction', count: 2, correctsId: 'e1' }));
  assert.match(record.join(' '), /4 wiadomości/);
  assert.match(fix.join(' '), /e1/);
  assert.match(fix.join(' '), /historii/);
  assert.match(record.at(-1), /Nic nie jest wysyłane/);
  assert.match(describeEntry({ id: 'e1', day: '2026-10-05', count: -2 }), /korekta -2/);
});

test('403 i 401 mają czytelny komunikat, nieznany błąd daje null', () => {
  assert.match(describeQuotaError(403, 'forbidden'), /zarząd lub skarbnik/);
  assert.match(describeQuotaError(401, 'x'), /Sesja wygasła/);
  assert.match(describeQuotaError(403, 'mfa_required'), /MFA/);
  assert.equal(describeQuotaError(500, 'boom'), null);
  assert.equal(quotaUrl('y 1'), '/api/email/quota?schoolYearId=y%201');
});
