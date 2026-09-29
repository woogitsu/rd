// Testy czystych funkcji ekranu eksportu (issue #147): data-export/core.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ROSTER_ROLES, YEARLY_EXPORT_ROLES, canonicalJson, describeApiError, filenameFromDisposition, formatBytes,
  hasRosterAccess, hasYearlyAccess, isTotpShape, needsStepUp, normalizeTotp, rosterUrl, sha256Hex, verifyBundleText,
  yearlyBody, yearlyYears,
} from '../data-export/core.js';
import { canonicalJson as serverCanonicalJson, sha256Hex as serverSha256Hex } from '../src/pg/export.js';

const parse = (text) => [...text.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);

test('role panelu odpowiadają stałym w src/pg/routes/exports.js', () => {
  const source = readFileSync(new URL('../src/pg/routes/exports.js', import.meta.url), 'utf8');
  assert.deepEqual([...YEARLY_EXPORT_ROLES], parse(source.match(/YEARLY_EXPORT_ROLES = Object\.freeze\(\[([^\]]*)\]/)[1]));
  assert.deepEqual([...ROSTER_ROLES], parse(source.match(/ROSTER_ROLES = Object\.freeze\(\[([^\]]*)\]/)[1]));
});

test('granice ról: eksport roczny tylko admin/zarząd bez klasy; lista klasy także przedstawiciel; skarbnik i KR nic', () => {
  assert.equal(hasYearlyAccess([{ role: 'board', schoolYearId: 'y1' }]), true);
  assert.equal(hasYearlyAccess([{ role: 'admin' }]), true);
  assert.equal(hasYearlyAccess([{ role: 'board', classId: '1A' }]), false);
  assert.equal(hasYearlyAccess([{ role: 'representative', classId: '1A' }]), false);
  assert.equal(hasYearlyAccess([{ role: 'treasurer' }, { role: 'audit' }]), false);
  assert.equal(hasRosterAccess([{ role: 'representative', classId: '1A' }]), true);
  assert.equal(hasRosterAccess([{ role: 'treasurer' }, { role: 'audit' }]), false);
  assert.deepEqual(yearlyYears([{ role: 'board', schoolYearId: '2025-2026' }, { role: 'board', schoolYearId: '2026-2027' }, { role: 'representative', classId: 'c', schoolYearId: '2030-2031' }]), ['2026-2027', '2025-2026']);
});

test('adresy i ciała żądań: poprawny identyfikator, format csv/json', () => {
  assert.equal(rosterUrl('c1', 'json'), '/api/exports/class-roster?classId=c1&format=json');
  assert.throws(() => rosterUrl('../x'));
  assert.equal(rosterUrl('c1', 'xlsx'), '/api/exports/class-roster?classId=c1&format=xlsx');
  assert.throws(() => rosterUrl('c1', 'pdf'));
  assert.deepEqual(yearlyBody(' 2026-2027 '), { schoolYearId: '2026-2027' });
  assert.throws(() => yearlyBody(''));
});

test('krok w górę: tylko 403 mfa_stale; kod znormalizowany i sprawdzony', () => {
  assert.equal(needsStepUp({ status: 403, code: 'mfa_stale' }), true);
  assert.equal(needsStepUp({ status: 403, code: 'forbidden' }), false);
  assert.equal(needsStepUp({ status: 500, code: 'mfa_stale' }), false);
  assert.equal(normalizeTotp('123 456'), '123456');
  assert.equal(isTotpShape('123-456'), true);
  assert.equal(isTotpShape('12ab56'), false);
  assert.match(describeApiError(403, 'mfa_stale'), /15 minut/);
  assert.match(describeApiError(409, 'export_in_progress'), /trwa/);
});

test('nazwa pliku z nagłówka i rozmiar', () => {
  assert.equal(filenameFromDisposition('attachment; filename="rd-eksport-y1-v2.json"', 'x'), 'rd-eksport-y1-v2.json');
  assert.equal(filenameFromDisposition('attachment; filename="../../etc"', 'x'), 'x');
  assert.equal(filenameFromDisposition(null, 'fallback.json'), 'fallback.json');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2,0 KB');
  assert.equal(formatBytes(-1), '—');
});

function makeBundle() {
  const users = `${serverCanonicalJson({ id: 'a', amount_cents: 100 })}\n${serverCanonicalJson({ id: 'b', amount_cents: 50 })}\n`;
  const manifest = {
    format: 'rd-yearly-export', formatVersion: 2, schoolYearId: 'y1',
    files: [{ path: 'payment_entries.jsonl', table: 'payment_entries', columns: ['amount_cents', 'id'], rows: 2, sha256: serverSha256Hex(users), sums: { amount_cents: 150 } }],
  };
  return { format: 'rd-yearly-export', formatVersion: 2, manifest, manifestSha256: serverSha256Hex(serverCanonicalJson(manifest)), files: { 'payment_entries.jsonl': users } };
}

test('canonicalJson i sha256Hex zgodne z serwerem (src/pg/export.js)', async () => {
  const sample = { b: [1, { z: null, a: 'ż' }], a: true, u: undefined };
  assert.equal(canonicalJson(sample), serverCanonicalJson(sample));
  assert.equal(await sha256Hex('zażółć'), serverSha256Hex('zażółć'));
});

test('verifyBundleText: poprawna paczka zgodna; zmiana pliku, manifestu, nagłówka i dodatkowy plik wykrywane', async () => {
  const bundle = makeBundle();
  const good = await verifyBundleText(JSON.stringify(bundle), { expectedManifestSha256: bundle.manifestSha256 });
  assert.deepEqual({ ok: good.ok, files: good.files, rows: good.rows, year: good.schoolYearId }, { ok: true, files: 1, rows: 2, year: 'y1' });

  const tampered = structuredClone(bundle);
  tampered.files['payment_entries.jsonl'] = tampered.files['payment_entries.jsonl'].replace('100', '900');
  const t = await verifyBundleText(JSON.stringify(tampered));
  assert.equal(t.ok, false);
  assert.match(t.errors.join(' '), /Skrót pliku/);

  const badManifest = structuredClone(bundle);
  badManifest.manifest.schoolYearId = 'y2';
  assert.match((await verifyBundleText(JSON.stringify(badManifest))).errors.join(' '), /manifestu/);

  const header = await verifyBundleText(JSON.stringify(bundle), { expectedManifestSha256: 'f'.repeat(64) });
  assert.match(header.errors.join(' '), /serwer/);

  const extra = structuredClone(bundle);
  extra.files['obce.jsonl'] = '';
  assert.match((await verifyBundleText(JSON.stringify(extra))).errors.join(' '), /spoza manifestu/);

  const rows = structuredClone(bundle);
  rows.manifest.files[0].rows = 3;
  rows.manifestSha256 = serverSha256Hex(serverCanonicalJson(rows.manifest));
  assert.match((await verifyBundleText(JSON.stringify(rows))).errors.join(' '), /Liczba wierszy/);
});

test('verifyBundleText: nie-JSON i nie-paczka bez wyjątku, komunikaty bez treści pliku', async () => {
  assert.equal((await verifyBundleText('nie json {')).ok, false);
  assert.equal((await verifyBundleText('[]')).ok, false);
  assert.equal((await verifyBundleText(JSON.stringify({ format: 'inny' }))).ok, false);
  const r = await verifyBundleText('SEKRET nie json');
  assert.doesNotMatch(JSON.stringify(r), /SEKRET/);
});

test('ekran: brak localStorage, brak window.confirm, nieodwracalne akcje przez confirmAction, jedno żądanie naraz', () => {
  const main = readFileSync(new URL('../data-export/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /localStorage|sessionStorage|window\.confirm|\bfetch\s*\(/);
  assert.equal((main.match(/confirmAction\(/g) ?? []).length, 2);
  assert.match(main, /if \(state\.busy\) return;/);
  assert.match(main, /shared\/confirm-dialog\.js/);
});
