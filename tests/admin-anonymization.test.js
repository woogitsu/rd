import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  COUNT_LABELS, HISTORY_PATH, REASON_LABELS, canExecute, executeBlocker, executeBody, executeConfirmation, historyRows,
  historySummary, planRows, previewBody, previewSummary, resultMessage, retainedNote, totalCount,
} from '../admin/anonymization.js';

const DIGEST = 'a'.repeat(64);
const preview = (over = {}) => ({
  status: 'dry_run', runId: null, householdId: 'h-1', reasonCode: 'data_subject_request', planSha256: DIGEST,
  counts: { guardians: 2, students: 1, payment_entries: 3 }, retained: { guardians: 0, students: 0 }, ...over,
});

test('powody i etykiety liczników zgadzają się z serwerem', () => {
  const source = readFileSync(new URL('../src/pg/anonymization.js', import.meta.url), 'utf8');
  const reasons = /ANONYMIZATION_REASON_CODES = Object\.freeze\(\[([^\]]+)\]\)/.exec(source)[1].match(/'([a-z_]+)'/g).map((v) => v.slice(1, -1));
  assert.ok(reasons.length > 0);
  assert.deepEqual(Object.keys(REASON_LABELS).sort(), [...reasons].sort());
  const tables = [...source.matchAll(/table: '([a-z_]+)'/g)].map((m) => m[1]);
  const keys = new Set(['guardians', 'students', ...tables].map((t) => (t === 'email_campaign_recipients' ? 'campaign_recipients' : t)));
  assert.ok(keys.size >= 15);
  assert.deepEqual(Object.keys(COUNT_LABELS).sort(), [...keys].sort());
});

test('previewBody: zawsze dryRun true, żądanie wymagane tylko dla żądania osoby', () => {
  assert.deepEqual(previewBody({ reasonCode: 'data_subject_request', householdId: ' h-1 ', dataRequestId: 'r-1' }),
    { householdId: 'h-1', reasonCode: 'data_subject_request', dataRequestId: 'r-1', dryRun: true });
  assert.deepEqual(previewBody({ reasonCode: 'retention_policy', householdId: 'h-1', dataRequestId: 'r-1' }),
    { householdId: 'h-1', reasonCode: 'retention_policy', dryRun: true });
  assert.throws(() => previewBody({ reasonCode: 'x', householdId: 'h-1' }), /powód/);
  assert.throws(() => previewBody({ reasonCode: 'retention_policy', householdId: '' }), /identyfikator gospodarstwa/);
  assert.throws(() => previewBody({ reasonCode: 'retention_policy', householdId: 'jan kowalski@example.invalid' }), /Niepoprawny/);
  assert.throws(() => previewBody({ reasonCode: 'data_subject_request', householdId: 'h-1' }), /żądania/);
  assert.throws(() => previewBody({ reasonCode: 'data_subject_request', householdId: 'h-1', dataRequestId: 'a b' }), /Niepoprawny identyfikator żądania/);
});

test('executeBody: zatwierdza dokładnie plan z podglądu', () => {
  assert.deepEqual(executeBody(preview(), { dataRequestId: 'r-1' }), {
    householdId: 'h-1', reasonCode: 'data_subject_request', dataRequestId: 'r-1', dryRun: false, confirm: 'h-1', expectedPlanSha256: DIGEST,
  });
  const retention = executeBody(preview({ reasonCode: 'retention_policy' }), { dataRequestId: 'r-1' });
  assert.equal('dataRequestId' in retention, false);
  assert.throws(() => executeBody(null), /podgląd/);
  assert.throws(() => executeBody(preview({ status: 'applied' })), /podgląd/);
  assert.throws(() => executeBody(preview({ counts: {} })), /podgląd/);
  assert.throws(() => executeBody(preview({ planSha256: 'xyz' })), /podgląd/);
});

test('canExecute i executeBlocker: pusty plan, zły stan, brak podglądu', () => {
  assert.equal(canExecute(preview()), true);
  assert.equal(executeBlocker(preview()), '');
  assert.equal(canExecute(null), false);
  assert.match(executeBlocker(null), /podgląd/);
  assert.equal(canExecute(preview({ status: 'replayed' })), false);
  assert.match(executeBlocker(preview({ status: 'replayed' })), /nie jest podglądem/);
  assert.equal(canExecute(preview({ counts: { guardians: 0 } })), false);
  assert.match(executeBlocker(preview({ counts: {} })), /pusty/);
  assert.equal(canExecute(preview({ planSha256: DIGEST.toUpperCase() })), false);
});

test('planRows i totalCount: tylko dodatnie liczniki, nieznany klucz surowo', () => {
  assert.equal(totalCount({ a: 2, b: 0, c: -1, d: 'x', e: 1.5, f: 3 }), 5);
  assert.equal(totalCount(undefined), 0);
  const rows = planRows({ guardians: 2, students: 0, nieznane: 4 });
  assert.deepEqual(rows.map((r) => [r.key, r.count]), [['guardians', 2], ['nieznane', 4]]);
  assert.equal(rows[1].label, 'nieznane');
  assert.deepEqual(planRows(null), []);
});

test('retainedNote i previewSummary', () => {
  assert.equal(retainedNote({ guardians: 0, students: 0 }), '');
  assert.equal(retainedNote(undefined), '');
  assert.match(retainedNote({ guardians: 1, students: 2 }), /opiekunów 1, uczniów 2/);
  assert.match(previewSummary(preview()), /6 pozycji w 3 kategoriach/);
  assert.match(previewSummary(preview({ counts: {} })), /pusty/);
  assert.equal(previewSummary(null), '');
});

test('executeConfirmation: nieodwracalny skutek, przepisanie identyfikatora, bez danych osobowych', () => {
  const dialog = executeConfirmation(preview());
  assert.equal(dialog.destructive, true);
  assert.equal(dialog.confirmLabel, 'Anonimizuj');
  assert.equal(dialog.input.expected, 'h-1');
  const text = dialog.effects.join(' ');
  assert.match(text, /nie można cofnąć/);
  assert.match(text, /kopii zapasowej/);
  assert.match(text, /Kwoty, daty/);
  assert.match(text, /MFA/);
  assert.match(text, /6 pozycji/);
});

test('resultMessage: zastosowano, powtórzenie, podgląd', () => {
  assert.match(resultMessage({ status: 'applied', runId: '12345678-aaaa', counts: { guardians: 2 } }), /12345678.*2 pozycji/);
  assert.match(resultMessage({ status: 'replayed' }), /już zanonimizowane/);
  assert.match(resultMessage({ status: 'dry_run' }), /nie zostały zmienione/);
});

test('historyRows: kształt GET /api/admin/anonymizations, tylko identyfikatory i liczniki', () => {
  const runs = [
    { id: 'run-1', householdId: 'h-1', reasonCode: 'data_subject_request', dataSubjectRequestId: 'r-1', retentionPolicyIds: [],
      planSha256: DIGEST, counts: { guardians: 2, students: 1 }, totalChanged: 3, executedBy: 'u-1', executedAt: '2026-10-01T10:00:00Z' },
    { id: 'run-2', householdId: null, reasonCode: null, counts: { guardians: 4 }, executedBy: null },
    { id: 'run-3' },
  ];
  const rows = historyRows(runs);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    id: 'run-1', occurredAt: '2026-10-01T10:00:00Z', actorId: 'u-1', householdId: 'h-1',
    reasonCode: 'data_subject_request', dataSubjectRequestId: 'r-1', total: 3, planSha256: DIGEST,
  });
  assert.equal(rows[1].total, 4);
  assert.equal(rows[1].actorId, null);
  assert.equal(rows[2].total, null);
  assert.equal(rows[2].planSha256, null);
  assert.deepEqual(historyRows(undefined), []);
  assert.match(historySummary(0, false), /Brak/);
  assert.match(historySummary(2, true), /Pokaż więcej/);
  assert.match(HISTORY_PATH, /^\/api\/admin\/anonymizations\?limit=\d+$/);
});

test('ekran: sekcja w panelu, wywołanie podglądu i wykonania, blokada podwójnego kliknięcia', () => {
  const html = readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../admin/main.js', import.meta.url), 'utf8');
  for (const id of ['anon-form', 'anon-plan-body', 'anon-execute', 'anon-history-body']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(main, /\/api\/admin\/anonymizations/);
  assert.doesNotMatch(main, /household\.anonymized|domain=privacy|auditListPath\("privacy"\)/);
  assert.match(main, /promptAction\(executeConfirmation/);
  assert.match(main, /if \(anon\.busy/);
  assert.doesNotMatch(main, /localStorage|sessionStorage/);
});
