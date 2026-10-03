// Widok „Stan systemu” (#149): czyste funkcje admin/ops-status-core.js. Dane wyłącznie syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STATE_LABELS, ageText, buildOpsRows, overallState } from '../admin/ops-status-core.js';
import { assertEvery } from './helpers/assertions.js';

const NOW = new Date('2026-09-29T12:00:00Z');
const byKey = (rows) => Object.fromEntries(rows.map((r) => [r.key, r]));

test('świeża baza bez dzienników: „brak danych”, nigdy „w normie”', () => {
  const rows = byKey(buildOpsRows({
    migrations: { appliedCount: 5, pendingCount: 0, pending: [] },
    emailWorker: null, emailQueue: { pending: 0, failed: 0, oldestPendingAt: null },
    guardianVerifyQueue: { queued: 0, sending: 0, oldestPendingAt: null, overdue: false },
    backup: { status: 'no_data', lastRun: null }, storageBackup: { status: 'no_data', lastRun: null },
    restoreDrill: { status: 'no_data', lastRun: null }, lastExport: null, writeMode: 'normal', appVersion: null,
  }, NOW));
  for (const key of ['emailWorker', 'backup', 'storageBackup', 'restoreDrill', 'lastExport', 'appVersion']) {
    assert.equal(rows[key].state, 'no_data', key);
    assert.equal(rows[key].stateLabel, STATE_LABELS.no_data);
  }
  assert.equal(rows.migrations.state, 'ok');
});

test('pusta odpowiedź lub brak pól nie rzuca i daje „brak danych”', () => {
  for (const input of [undefined, null, {}, 'x']) {
    const rows = buildOpsRows(input, NOW);
    assert.equal(rows.length, 10);
    assertEvery(rows, (r) => r.label && r.stateLabel);
  }
});

test('zaległa migracja to błąd, nieudany backup i wiadomości failed to uwaga', () => {
  const rows = byKey(buildOpsRows({
    migrations: { appliedCount: 5, pendingCount: 2, pending: ['0200_x.sql'] },
    emailWorker: { mode: 'live', finishedAt: '2026-09-29T11:00:00Z', sent: 3, retried: 1, failed: 2, stoppedReason: 'provider_rate_limited' },
    emailQueue: { pending: 4, failed: 1, oldestPendingAt: '2026-09-28T12:00:00Z' },
    backup: { status: 'attention', lastRun: { result: 'failure', finishedAt: '2026-09-29T02:00:00Z' } },
    storageBackup: { status: 'ok', lastRun: { result: 'success', finishedAt: '2026-09-29T03:00:00Z' } },
    restoreDrill: { status: 'no_data', lastRun: null },
    lastExport: { kind: 'year', createdAt: '2026-08-31T10:00:00Z' }, writeMode: 'read_only', appVersion: 'ABCDEF1234567',
  }, NOW));
  assert.equal(rows.migrations.state, 'error');
  assert.equal(rows.emailWorker.state, 'attention');
  assert.equal(rows.emailQueue.state, 'attention');
  assert.equal(rows.backup.state, 'attention');
  assert.equal(rows.storageBackup.state, 'ok');
  assert.equal(rows.writeMode.state, 'attention');
  assert.match(rows.appVersion.detail, /abcdef1/i);
  assert.equal(overallState(Object.values(rows)), 'error');
});

test('kolejka kodów weryfikacyjnych (#140 pkt 5): liczby i wiek, uwaga tylko gdy serwer oznaczył zaległość, brak tabeli to „brak danych”', () => {
  const quiet = byKey(buildOpsRows({ guardianVerifyQueue: { queued: 0, sending: 0, oldestPendingAt: null, overdue: false } }, NOW)).guardianVerifyQueue;
  assert.equal(quiet.state, 'ok');
  assert.equal(quiet.label, 'Kolejka kodów weryfikacyjnych');
  assert.match(quiet.detail, /W kolejce: 0, w wysyłce: 0\./);
  const waiting = byKey(buildOpsRows({ guardianVerifyQueue: { queued: 3, sending: 1, oldestPendingAt: '2026-09-29T11:30:00Z', overdue: false } }, NOW)).guardianVerifyQueue;
  assert.equal(waiting.state, 'ok', 'widok sam nie zgaduje progu');
  assert.match(waiting.detail, /W kolejce: 3, w wysyłce: 1\. Data dotyczy najstarszego oczekującego\./);
  assert.match(waiting.whenText, /30 min temu/);
  const late = byKey(buildOpsRows({ guardianVerifyQueue: { queued: 2, sending: 0, oldestPendingAt: '2026-09-29T07:00:00Z', overdue: true } }, NOW)).guardianVerifyQueue;
  assert.equal(late.state, 'attention');
  assert.match(late.detail, /sprawdź zadanie wysyłki/);
  for (const missing of [undefined, null]) {
    const row = byKey(buildOpsRows({ guardianVerifyQueue: missing }, NOW)).guardianVerifyQueue;
    assert.equal(row.state, 'no_data');
  }
  // Wiersz nie niesie niczego poza liczbami i czasem: ani adresu, ani kodu.
  assert.doesNotMatch(JSON.stringify([quiet, waiting, late]), /@|example\.invalid/);
});

test('wiek zdarzenia po polsku; przyszłość i brak daty dają null', () => {
  assert.equal(ageText('2026-09-29T11:30:00Z', NOW), '30 min temu');
  assert.equal(ageText('2026-09-29T09:00:00Z', NOW), '3 godz. temu');
  assert.equal(ageText('2026-09-20T12:00:00Z', NOW), '9 dni temu');
  assert.equal(ageText('2026-09-30T12:00:00Z', NOW), null);
  assert.equal(ageText(null, NOW), null);
});

test('wersja niebędąca skrótem commita nie jest wyświetlana (brak wstrzyknięcia treści)', () => {
  const rows = byKey(buildOpsRows({ appVersion: '<img src=x onerror=1>' }, NOW));
  assert.equal(rows.appVersion.state, 'no_data');
  assert.doesNotMatch(rows.appVersion.detail, /img/);
});

test('sekcja jest w admin/index.html, skrypt bez inline, a moduł używa textContent zamiast innerHTML', () => {
  const html = readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="ops-title"/);
  assert.match(html, /<script type="module" src="\/ops-status\.js"><\/script>/);
  const source = readFileSync(new URL('../admin/ops-status.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /innerHTML|localStorage|sessionStorage/);
  assert.match(source, /\/api\/admin\/ops-status/);
});

test('runbook zawiera karty wymagane w #149 i odwołuje się do istniejących tras', () => {
  const doc = readFileSync(new URL('../docs/RUNBOOK.md', import.meta.url), 'utf8');
  const cards = doc.match(/^## \d+\. /gm) ?? [];
  assert.ok(cards.length >= 14);
  for (const needle of ['/health/ready', '/health/jobs', '/api/admin/ops-status', 'Awaria Brevo', 'Zablokowany skarbnik', 'Błędny import', 'Cofnięcie wysyłki', 'Wyciek danych osobowych', 'Awaria bazy']) {
    assert.ok(doc.includes(needle), needle);
  }
  assert.doesNotMatch(doc, /@(?!example\.invalid)[a-z0-9-]+\.[a-z]{2,}/i);
});

// Przegląd demo 5: „Stan z 30.09.2026, 19:07:01” → zapis aplikacji dd.mm.rrrr gg:mm (#563).
test('formatWhen: dd.mm.rrrr gg:mm w Europe/Brussels', async () => {
  const { formatWhen } = await import('../admin/ops-status-core.js');
  assert.equal(formatWhen('2026-09-30T17:07:01Z'), '30.09.2026 19:07');
  assert.equal(formatWhen(new Date('2026-01-15T12:22:00Z')), '15.01.2026 13:22');
  assert.equal(formatWhen(null), '—');
  assert.equal(formatWhen('nie-data'), '—');
});
