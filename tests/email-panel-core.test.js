// Testy czystych funkcji ekranu kampanii e-mail (issue #147, część 1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  APPROVER_ROLES,
  EDITOR_ROLES,
  buildCampaignsUrl,
  campaignActionUrl,
  campaignStatusLabel,
  describeProviderPause,
  describeWorkerStatus,
  WORKER_ALARM_LABELS,
  PROVIDER_PAUSE_REASONS,
  campaignUrl,
  canOfferApproval,
  describeApiError,
  formatDayPlan,
  formatExclusions,
  formatReportRows,
  REPORT_LABELS,
  formatSchedule,
  STATUS_LABELS,
  sendNotBeforeFromInput,
  sendNotBeforeToInput,
  formatWarnings,
  hasApproverAccess,
  hasEditorAccess,
  isLikelyOwnCampaign,
  isSnapshotStale,
  isValidId,
  makeIdempotencyKey,
  maskEmail,
} from '../email/core.js';

// Role muszą być identyczne z serwerem (src/pg/routes/email.js) — tak jak
// tests/role-policy-parity.test.js dla ról finansowych panelu/księgi.
test('role panelu odpowiadają EDITOR_ROLES/APPROVER_ROLES na serwerze', () => {
  const source = readFileSync(new URL('../src/pg/routes/email.js', import.meta.url), 'utf8');
  const editor = source.match(/const EDITOR_ROLES = \[([^\]]*)\]/)[1];
  const approver = source.match(/const APPROVER_ROLES = \[([^\]]*)\]/)[1];
  const parse = (text) => [...text.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...EDITOR_ROLES], parse(editor));
  assert.deepEqual([...APPROVER_ROLES], parse(approver));
});

test('isValidId: identyfikatory jak na serwerze', () => {
  assert.equal(isValidId('cmp-1'), true);
  assert.equal(isValidId(''), false);
  assert.equal(isValidId('../etc'), false);
  assert.equal(isValidId(undefined), false);
});

test('buildCampaignsUrl: wymaga poprawnego roku', () => {
  assert.equal(buildCampaignsUrl('y2026'), '/api/email/campaigns?schoolYearId=y2026');
  assert.throws(() => buildCampaignsUrl(''), /szkolnego/);
  assert.throws(() => buildCampaignsUrl('../x'), /szkolnego/);
});

test('campaignUrl / campaignActionUrl: budują poprawne ścieżki, odrzucają zły id', () => {
  assert.equal(campaignUrl('cmp-1'), '/api/email/campaigns/cmp-1');
  assert.equal(campaignActionUrl('cmp-1', 'approve'), '/api/email/campaigns/cmp-1/approve');
  assert.throws(() => campaignUrl(''), /identyfikator/);
});

test('maskEmail: pierwsza litera + domena, bez ujawniania reszty lokalnej części', () => {
  assert.equal(maskEmail('jan.kowalski@example.invalid'), 'j***@example.invalid');
  assert.equal(maskEmail('a@example.invalid'), 'a***@example.invalid');
  assert.equal(maskEmail(''), '***');
  assert.equal(maskEmail(null), '***');
});

test('makeIdempotencyKey: prefiks + losowy UUID, wymaga crypto.randomUUID', () => {
  const key = makeIdempotencyKey('email-create', () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(key, 'email-create-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.throws(() => makeIdempotencyKey('x', null), /bezpiecznych identyfikatorów/);
});

// Serwer (approve()) sprawdza createdBy/updatedBy/snapshotBuiltBy — GET zwraca
// tylko createdBy, więc to jest przybliżenie widoczności przycisku, nigdy kontrola dostępu.
test('isLikelyOwnCampaign: porównuje wyłącznie createdBy (przybliżenie widoczności)', () => {
  assert.equal(isLikelyOwnCampaign({ createdBy: 'u1' }, 'u1'), true);
  assert.equal(isLikelyOwnCampaign({ createdBy: 'u1' }, 'u2'), false);
  assert.equal(isLikelyOwnCampaign(null, 'u1'), false);
  assert.equal(isLikelyOwnCampaign({ createdBy: 'u1' }, null), false);
});

test('canOfferApproval: wymaga szkicu, aktualnej migawki z odbiorcami i innej osoby', () => {
  const base = { status: 'draft', recipientsHash: 'h', recipientsCount: 3, createdBy: 'u1' };
  assert.equal(canOfferApproval(base, 'u2'), true);
  assert.equal(canOfferApproval(base, 'u1'), false, 'autor nie może zatwierdzić własnej kampanii');
  assert.equal(canOfferApproval({ ...base, status: 'approved' }, 'u2'), false);
  assert.equal(canOfferApproval({ ...base, recipientsHash: null }, 'u2'), false, 'bez migawki');
  assert.equal(canOfferApproval({ ...base, recipientsCount: 0 }, 'u2'), false, 'zero odbiorców');
  assert.equal(canOfferApproval(null, 'u2'), false);
});

test('formatExclusions: etykiety po polsku, pomija zera, sortuje po kodzie', () => {
  const lines = formatExclusions({ no_consent: 2, payment_recorded: 0, suppressed: 1 });
  assert.deepEqual(lines, [
    'brak zgody na kontakt: 2',
    'adres wykluczony (odbicie lub rezygnacja): 1',
  ]);
  assert.deepEqual(formatExclusions(undefined), []);
});

test('formatDayPlan: jeden dzień vs kilka dni, pokazuje limit dzienny', () => {
  assert.match(formatDayPlan({ days: ['2026-01-01'], dailyCap: 50 }), /jednym dniu/);
  assert.match(formatDayPlan({ days: ['a', 'b', 'c'], dailyCap: 50, reservedForOtherMail: 10 }), /3 dni/);
  assert.equal(formatDayPlan(null), '');
});

test('formatWarnings: etykiety po polsku, nieznany kod bez zmian', () => {
  const lines = formatWarnings(['missing_skip_if_paid_sentence', 'unknown_code']);
  assert.match(lines[0], /pominąć/);
  assert.equal(lines[1], 'unknown_code');
  assert.deepEqual(formatWarnings(undefined), []);
});

test('hasEditorAccess / hasApproverAccess: tylko przydział bez klasy, właściwa rola i rok', () => {
  assert.equal(hasEditorAccess([{ role: 'treasurer', schoolYearId: 'y1' }], 'y1'), true);
  assert.equal(hasEditorAccess([{ role: 'treasurer', classId: 'c1', schoolYearId: 'y1' }], 'y1'), false, 'przydział klasowy nie wystarcza');
  assert.equal(hasEditorAccess([{ role: 'representative', schoolYearId: 'y1' }], 'y1'), false);
  assert.equal(hasApproverAccess([{ role: 'treasurer', schoolYearId: 'y1' }], 'y1'), false, 'skarbnik nie zatwierdza');
  assert.equal(hasApproverAccess([{ role: 'board', schoolYearId: 'y1' }], 'y1'), true);
  assert.equal(hasEditorAccess(undefined), false);
});

test('describeApiError: komunikaty po polsku dla typowych kodów', () => {
  assert.match(describeApiError(401, 'unauthenticated'), /Zaloguj/);
  assert.match(describeApiError(403, 'mfa_required'), /MFA/);
  assert.match(describeApiError(403, 'forbidden'), /Nie masz uprawnień/);
  assert.match(describeApiError(403, 'self_approval_forbidden'), /inna osoba/);
  assert.equal(describeApiError(500, null), null);
});

test('raport doręczeń: kategorie panelu = kategorie raportu serwera, tylko liczby', () => {
  const server = readFileSync(new URL('../src/pg/routes/email.js', import.meta.url), 'utf8');
  const declared = server.match(/REPORT_CATEGORIES = Object\.freeze\(\[([^\]]+)\]/)[1].match(/'([a-z_]+)'/g).map((x) => x.slice(1, -1));
  assert.deepEqual(Object.keys(REPORT_LABELS), declared);
  const rows = formatReportRows({ sent: 2, delivered: '3', bogus: 9 });
  assert.equal(rows.length, declared.length);
  assert.deepEqual(rows.find((r) => r.key === 'delivered'), { key: 'delivered', label: REPORT_LABELS.delivered, count: 3 });
  assert.equal(rows.find((r) => r.key === 'queued').count, 0);
  assert.deepEqual(formatReportRows(null).map((r) => r.count), declared.map(() => 0));
});

test('buildCampaignsUrl: kursor kolejnej strony (#159)', () => {
  assert.equal(buildCampaignsUrl('y2026', 'abc_-9'), '/api/email/campaigns?schoolYearId=y2026&cursor=abc_-9');
});

test('#130 harmonogram: pole startu to czas brukselski, także przy zmianie czasu', () => {
  assert.equal(sendNotBeforeFromInput('2026-03-30T09:00'), '2026-03-30T07:00:00.000Z');
  assert.equal(sendNotBeforeFromInput('2026-10-26T09:00'), '2026-10-26T08:00:00.000Z');
  assert.equal(sendNotBeforeFromInput(''), null);
  assert.throws(() => sendNotBeforeFromInput('jutro'), /startu wysyłki/);
  assert.equal(sendNotBeforeToInput('2026-10-26T08:00:00.000Z'), '2026-10-26T09:00');
  assert.equal(sendNotBeforeToInput(null), '');
});

test('#130 formatSchedule: start, okno i szacowany koniec w strefie z odpowiedzi; stan wstrzymania ma etykietę', () => {
  assert.equal(STATUS_LABELS.paused, 'Wstrzymana');
  const text = formatSchedule({
    sendNotBefore: '2026-03-27T08:00:00.000Z', timezone: 'Europe/Brussels', estimated: true,
    window: { enabled: true, timezone: 'Europe/Brussels', days: [1, 2, 3, 4, 5], startMinutes: 540, endMinutes: 1080 },
    startsAtLocal: '2026-03-27 09:00', endsAtLocal: '2026-04-06 18:00',
  });
  assert.match(text, /Start nie wcześniej niż: 27\.03\.2026 09:00 \(Europe\/Brussels\)/);
  assert.match(text, /Szacowany pierwszy przebieg: 27\.03\.2026 09:00/);
  assert.doesNotMatch(text, /2026-0/);
  assert.match(text, /09:00–18:00/);
  assert.match(text, /Szacowane zakończenie: do 06\.04\.2026 18:00/);
  assert.match(formatSchedule({ sendNotBefore: null, window: { enabled: false }, timezone: 'Europe/Brussels' }), /wyłączone/);
  assert.equal(formatSchedule(null), '');
  // Plan dni zwracany przez API jest liczbą.
  assert.match(formatDayPlan({ days: 7, dailyCap: 286, reservedForOtherMail: 0 }), /7 dni/);
});

test('isSnapshotStale: komunikat tylko dla istniejącej migawki, która przestała być aktualna', () => {
  assert.equal(isSnapshotStale(null), false);
  assert.equal(isSnapshotStale({ recipientsHash: null, snapshotCurrent: null }), false, 'świeży szkic bez migawki');
  assert.equal(isSnapshotStale({ recipientsHash: null, snapshotCurrent: false }), false, 'stara odpowiedź serwera bez migawki');
  assert.equal(isSnapshotStale({ recipientsHash: 'a'.repeat(64), snapshotCurrent: true }), false);
  assert.equal(isSnapshotStale({ recipientsHash: 'a'.repeat(64), snapshotCurrent: false }), true);
});

test('panel kampanii używa isSnapshotStale do komunikatu i do gotowości zatwierdzenia', () => {
  const main = readFileSync(new URL('../email/main.js', import.meta.url), 'utf8');
  assert.match(main, /byId\("detail-snapshot-current"\)\.hidden = !isSnapshotStale\(preview\)/);
  assert.match(main, /!isSnapshotStale\(preview\);/);
  assert.doesNotMatch(main, /snapshotCurrent/);
});

test('#209 pauza konta dostawcy: czytelna przyczyna po polsku, czas w Brukseli, nieznany kod wprost', () => {
  assert.equal(describeProviderPause(null), '');
  const text = describeProviderPause({ errorCode: 'provider_rejected_401', createdAt: '2026-10-05T08:00:00Z' });
  assert.match(text, /klucz API \(401/);
  assert.match(text, /05\.10\.2026.*10:00.*Brukseli/);
  for (const code of ['provider_rejected_401', 'provider_rejected_402', 'provider_rejected_403']) {
    assert.ok(PROVIDER_PAUSE_REASONS[code], code);
  }
  assert.match(describeProviderPause({ errorCode: 'provider_rejected_499', createdAt: null }), /kod provider_rejected_499/);
});

test('#209 stan kampanii: „W wysyłce” przy aktywnej pauzie konta to „Wstrzymana — błąd konta”', () => {
  const pause = { id: 'p1', errorCode: 'provider_rejected_401' };
  assert.equal(campaignStatusLabel({ status: 'sending' }, pause), 'Wstrzymana — błąd konta');
  assert.equal(campaignStatusLabel({ status: 'sending' }, null), STATUS_LABELS.sending);
  assert.equal(campaignStatusLabel({ status: 'done' }, pause), STATUS_LABELS.done);
});

test('#209 panel: przycisk potwierdzenia naprawy tylko dla zarządu, trasa zgodna z serwerem', () => {
  const main = readFileSync(new URL('../email/main.js', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../src/pg/routes/email.js', import.meta.url), 'utf8');
  assert.match(main, /byId\("provider-pause-lift"\)\.hidden = !approver/);
  assert.match(main, /hasApproverAccess\(state\.grants, state\.schoolYearId\)/);
  for (const path of ['/api/email/provider-pause/lift', '/api/email/provider-pause']) {
    assert.ok(main.includes(path), path);
    assert.ok(server.includes(`'${path}'`), path);
  }
});

test('#130 alarm zadania wysyłki: bez alarmu sekcja ukryta; kody → opisy, czas w Brukseli, bez danych rodzin', () => {
  assert.equal(describeWorkerStatus(null), null);
  assert.equal(describeWorkerStatus({ alarms: [] }), null);
  const view = describeWorkerStatus({
    alarms: ['worker_dry_run_only'],
    lastRun: { mode: 'dry_run', finishedAt: '2026-10-25T00:30:00.000Z', stoppedReason: null },
    campaigns: { due: 2, scheduled: 0, paused: 0 },
    alarmAfterHours: 2,
  });
  assert.deepEqual(view.lines, [WORKER_ALARM_LABELS.worker_dry_run_only]);
  // 25.10.2026 00:30 UTC = 02:30 czasu letniego w Brukseli (przed zmianą o 03:00).
  assert.match(view.details, /25\.10\.2026.*02:30.*tryb próbny/);
  assert.match(view.details, /czekające na wysyłkę w tym roku: 2/);
  assert.match(view.details, /Próg alarmu: 2 h/);
  const never = describeWorkerStatus({ alarms: ['worker_never_ran', 'nowy_kod'], lastRun: null, campaigns: { due: 1 } });
  assert.deepEqual(never.lines, [WORKER_ALARM_LABELS.worker_never_ran, 'Alarm zadania wysyłki (kod nowy_kod).']);
  assert.match(never.details, /Ostatni przebieg: brak/);
  const stale = describeWorkerStatus({ alarms: ['worker_stale'], lastRun: { mode: 'live', finishedAt: '2026-10-26T08:00:00.000Z', stoppedReason: 'outside_send_window' }, campaigns: { due: 1 }, alarmAfterHours: 2 });
  assert.match(stale.details, /26\.10\.2026.*09:00.*wysyłka, zatrzymanie: outside_send_window/);
});

test('#130 panel: alarm zadania wysyłki z trasy zgodnej z serwerem', () => {
  const main = readFileSync(new URL('../email/main.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../email/index.html', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../src/pg/routes/email.js', import.meta.url), 'utf8');
  assert.ok(main.includes('/api/email/worker-status?schoolYearId='));
  assert.ok(server.includes("'/api/email/worker-status'"));
  for (const code of Object.keys(WORKER_ALARM_LABELS)) assert.ok(server.includes(`'${code}'`), code);
  assert.match(html, /id="worker-status"[^>]*hidden/);
});
