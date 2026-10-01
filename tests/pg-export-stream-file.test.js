// #216: paczka eksportu bez kopii w pamięci — zapis fragmentami do ujścia
// (przeciążenie), bufor na dysku w trasie, strumieniowa weryfikacja i
// odtworzenie z pliku (scripts/verify-export.js). Wyłącznie dane syntetyczne.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import {
  buildYearlyExport, canonicalJson, EXPORT_BATCH_ROWS, restoreBundle, restoreBundleFile, sha256Hex, verifyBundle, verifyBundleFile,
} from '../src/pg/export.js';
import { JsonLinesScanner, readBundleStream, scanJsonLines } from '../src/pg/export-reader.js';
import { activeExportSpools, createExportSpool } from '../src/pg/export-spool.js';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedSchoolYear, seedUserSession } from './helpers/pg.js';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc');

const YEAR = 'y-export-file';
const EVENTS = EXPORT_BATCH_ROWS * 2 + 77;
const BIG_YEAR = 'y-export-file-big';
const BIG_EVENTS = 25_000;
let db;
let directory;
let buffered;

before(async () => {
  db = await createTestDb();
  directory = await mkdtemp(join(tmpdir(), 'rd-export-file-test-'));
  await seedSchoolYear(db, YEAR);
  // Znaki spoza ASCII, emoji (para surogatów), cudzysłowy, ukośniki, znaki sterujące i nowe linie w treści.
  await db.query(
    `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, occurred_at, metadata_json)
     SELECT 'ae-f-' || g, NULL, 'session.created', 'session', 'sess-' || g,
            timestamptz '2026-10-01 12:00:00+00' + (g || ' seconds')::interval,
            jsonb_build_object('note', 'zażółć "gęślą" \\ jaźń 😀 ' || g || E'\\n\\t' || chr(1) || '/', 'schoolYearId', $2::text)
       FROM generate_series(1, $1::int) g`,
    [EVENTS, YEAR],
  );
  buffered = await db.transaction(async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    return buildYearlyExport(tx, YEAR);
  });
});

after(async () => {
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function bundleFile(name, body) {
  const path = join(directory, name);
  await writeFile(path, body, { mode: 0o600 });
  return path;
}

test('ujście z przeciążeniem: najwyżej jeden zapis naraz, fragmenty wielkości partii, te same bajty co paczka w pamięci (licznik w procesie Node, nie transakcje bazy)', async () => {
  const chunks = [];
  let pending = 0;
  let maxPending = 0;
  const built = await db.transaction(async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    return buildYearlyExport(tx, YEAR, {
      async sink(chunk) {
        pending += 1;
        maxPending = Math.max(maxPending, pending);
        chunks.push(chunk);
        await new Promise((resolve) => { setImmediate(resolve); });
        pending -= 1;
      },
    });
  });
  assert.equal(maxPending, 1, 'budowa czeka na każdy zapis');
  assert.equal(built.bodyChunks, undefined, 'z ujściem nic nie jest zbierane w pamięci');
  assert.equal(built.bundle, undefined);
  const body = Buffer.concat(chunks);
  assert.equal(built.bodyBytes, body.byteLength);
  assert.equal(body.toString('utf8'), buffered.body);
  assert.equal(built.manifestSha256, buffered.manifestSha256);
  assert.deepEqual(Object.keys(built.rowCounts), Object.keys(buffered.rowCounts), 'kolejność liczności jak w EXPORT_TABLES');
  // Największy fragment to jedna partia audit_events, nie cały plik.
  const auditBytes = Buffer.byteLength(JSON.stringify(buffered.bundle.files['audit_events.jsonl']));
  const largest = Math.max(...chunks.map((chunk) => chunk.byteLength));
  assert.ok(largest < auditBytes / 2, `największy fragment ${largest} B przy pliku ${auditBytes} B`);
});

test('parser strumieniowy: dowolny podział na fragmenty (także w środku znaku UTF-8 i sekwencji \\u) daje te same wyniki', async () => {
  const body = Buffer.from(buffered.body, 'utf8');
  const expected = Object.fromEntries(Object.entries(buffered.bundle.files).map(([path, content]) => [path, scanJsonLines(content, path)]));
  for (const size of [1, 3, 7, 4096]) {
    const scanners = new Map();
    async function* source() {
      for (let offset = 0; offset < body.length; offset += size) yield body.subarray(offset, offset + size);
    }
    const shell = await readBundleStream(source(), {
      file(path) { const scanner = new JsonLinesScanner(path); scanners.set(path, scanner); return scanner; },
      nonString() { throw new Error('unexpected'); },
    });
    assert.equal(shell.fields.manifestSha256, buffered.manifestSha256);
    assert.deepEqual(shell.files.paths, Object.keys(buffered.bundle.files).sort());
    for (const [path, stats] of Object.entries(expected)) {
      const got = scanners.get(path).stats();
      assert.equal(got.sha256, stats.sha256, `${path} przy fragmentach ${size} B`);
      assert.equal(got.sha256, sha256Hex(buffered.bundle.files[path]));
      assert.equal(got.rows, stats.rows);
      assert.equal(got.error, null);
      assert.deepEqual([...got.cents], [...stats.cents]);
    }
  }
});

test('verifyBundleFile: ten sam raport co verifyBundle, także dla paczki w innej kolejności kluczy', async () => {
  const report = verifyBundle(buffered.bundle);
  assert.deepEqual(await verifyBundleFile(await bundleFile('ok.json', buffered.body)), report);
  const reordered = JSON.stringify({ manifestSha256: buffered.bundle.manifestSha256, manifest: buffered.bundle.manifest,
    formatVersion: buffered.bundle.formatVersion, format: buffered.bundle.format, files: buffered.bundle.files }, null, 2);
  assert.deepEqual(await verifyBundleFile(await bundleFile('reordered.json', `\n${reordered}\n`)), report);
});

test('verifyBundleFile: zmiany paczki dają te same kody co verifyBundle; błędy składni bez treści pliku', async () => {
  const clone = () => JSON.parse(buffered.body);
  const rehash = (bundle) => {
    for (const entry of bundle.manifest.files) entry.sha256 = sha256Hex(bundle.files[entry.path]);
    bundle.manifestSha256 = sha256Hex(canonicalJson(bundle.manifest));
    return bundle;
  };
  const cases = {
    hash: (() => { const b = clone(); b.files['students.jsonl'] += '{"x":1}\n'; return b; })(),
    extra: (() => { const b = clone(); b.files['users.jsonl'] = ''; return b; })(),
    unterminated: rehash((() => { const b = clone(); b.files['audit_events.jsonl'] = b.files['audit_events.jsonl'].slice(0, -1); return b; })()),
    nonCanonical: rehash((() => { const b = clone(); b.files['audit_events.jsonl'] = b.files['audit_events.jsonl'].replace(/^\{/, '{ '); return b; })()),
    invalidLine: rehash((() => { const b = clone(); b.files['audit_events.jsonl'] = `nie-json\n${b.files['audit_events.jsonl']}`; return b; })()),
    columns: rehash((() => { const b = clone(); const lines = b.files['audit_events.jsonl'].split('\n'); const r = JSON.parse(lines[1]); r.extra = 1; lines[1] = canonicalJson(r); b.files['audit_events.jsonl'] = lines.join('\n'); return b; })()),
    version: (() => { const b = clone(); b.formatVersion = 99; return b; })(),
    missing: (() => { const b = clone(); delete b.files['students.jsonl']; return b; })(),
    notString: (() => { const b = clone(); b.files['students.jsonl'] = ['x']; return b; })(),
  };
  for (const [name, bundle] of Object.entries(cases)) {
    let expected;
    try { verifyBundle(bundle); } catch (error) { expected = error.code; }
    assert.ok(expected, `${name}: verifyBundle odrzuca`);
    await assert.rejects(verifyBundleFile(await bundleFile(`${name}.json`, JSON.stringify(bundle))), { code: expected }, name);
  }
  const syntax = {
    garbage: 'SEKRET nie json',
    truncated: buffered.body.slice(0, Math.floor(buffered.body.length / 2)),
    trailing: `${buffered.body} {}`,
    duplicateFiles: buffered.body.replace('{"files":{', '{"files":{},"files":{'),
  };
  for (const [name, text] of Object.entries(syntax)) {
    await assert.rejects(verifyBundleFile(await bundleFile(`${name}.json`, text)), (error) => {
      assert.match(error.code, /^(invalid_bundle_json|invalid_bundle|duplicate_file:.*)$/, name);
      assert.doesNotMatch(error.message, /SEKRET|zażółć/);
      return true;
    }, name);
  }
  const invalidUtf8 = Buffer.concat([Buffer.from(buffered.body.slice(0, 20)), Buffer.from([0xff, 0xfe]), Buffer.from(buffered.body.slice(20))]);
  await assert.rejects(verifyBundleFile(await bundleFile('utf8.json', invalidUtf8)), { code: 'invalid_bundle_json' });
  await assert.rejects(verifyBundleFile(join(directory, 'brak.json')), { code: 'bundle_not_found' });
});

test('restoreBundleFile: odtworzenie z pliku jak restoreBundle; zmieniony plik wycofuje całość', async () => {
  const fromMemory = await createTestDb();
  const fromFile = await createTestDb();
  const tamperedTarget = await createTestDb();
  try {
    const path = await bundleFile('restore.json', buffered.body);
    const expected = await restoreBundle(fromMemory, JSON.parse(buffered.body));
    const report = await restoreBundleFile(fromFile, path);
    assert.deepEqual(report, expected);
    assert.equal(report.reexportFilesMatch, true);
    const again = await fromFile.transaction((tx) => buildYearlyExport(tx, YEAR));
    assert.equal(again.manifestSha256, buffered.manifestSha256);

    const tampered = JSON.parse(buffered.body);
    tampered.files['students.jsonl'] += '{"x":1}\n';
    await assert.rejects(restoreBundleFile(tamperedTarget, await bundleFile('tampered.json', JSON.stringify(tampered))),
      { code: 'file_hash_mismatch:students.jsonl' });
    assert.equal((await tamperedTarget.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n, 0);
  } finally {
    await fromMemory.close();
    await fromFile.close();
    await tamperedTarget.close();
  }
});

async function spoolFilesLeft() {
  return (await readdir(tmpdir())).filter((name) => name.startsWith('rd-export-') && !name.startsWith('rd-export-file-test-')).length;
}

test('POST /api/exports: paczka czeka na wysyłkę na dysku, nie w pamięci; bufor zamknięty po pobraniu, przerwaniu i 409', async () => {
  const admin = await seedUserSession(db, { userId: 'u-file-admin', roles: [{ role: 'admin' }], mfa: true });
  const post = () => handlePgRequest(request('/api/exports', { cookie: admin, method: 'POST', body: { schoolYearId: YEAR } }), { db });
  const before = await spoolFilesLeft();

  // Rozgrzewka (pamięć PGlite rośnie przy pierwszym przebiegu), pełne pobranie.
  const first = await post();
  assert.equal(first.status, 200);
  const bytes = Buffer.from(await first.arrayBuffer());
  assert.equal(bytes.toString('utf8'), buffered.body);
  assert.equal(first.headers.get('content-length'), String(bytes.byteLength));
  assert.equal(first.headers.get('x-export-manifest-sha256'), buffered.manifestSha256);
  assert.equal(activeExportSpools(), 0, 'uchwyt zamknięty po pobraniu');
  assert.equal(await spoolFilesLeft(), before, 'nic nie zostaje w katalogu tymczasowym');

  // Pamięć zatrzymana przez gotową, nieodebraną odpowiedź — mierzona po GC,
  // więc niezależna od czasu i obciążenia. Większy rok (ok. 10 MB paczki);
  // pierwszy przebieg rozgrzewa pamięć PGlite, drugi jest mierzony.
  await seedSchoolYear(db, BIG_YEAR);
  await db.query(
    `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, occurred_at, metadata_json)
     SELECT 'ae-big-' || g, NULL, 'session.created', 'session', 'sess-big-' || g,
            timestamptz '2026-10-01 12:00:00+00' + (g || ' seconds')::interval,
            jsonb_build_object('note', repeat('zdarzenie syntetyczne ', 15) || g, 'schoolYearId', $2::text)
       FROM generate_series(1, $1::int) g`,
    [BIG_EVENTS, BIG_YEAR],
  );
  const postBig = () => handlePgRequest(request('/api/exports', { cookie: admin, method: 'POST', body: { schoolYearId: BIG_YEAR } }), { db });
  const warm = await postBig();
  const bigBytes = (await warm.arrayBuffer()).byteLength;
  assert.ok(bigBytes > 8 * 1024 * 1024, `paczka ${bigBytes} B`);
  const usage = async () => {
    for (let i = 0; i < 3; i += 1) { gc(); await new Promise((resolve) => { setImmediate(resolve); }); }
    const m = process.memoryUsage();
    return m.heapUsed + m.arrayBuffers;
  };
  const baseline = await usage();
  const held = await postBig();
  assert.equal(held.status, 200);
  const retained = (await usage()) - baseline;
  // Dawniej odpowiedź trzymała całą paczkę w buforach (ok. bigBytes).
  assert.ok(retained < bigBytes / 8, `zatrzymane ${retained} B przy paczce ${bigBytes} B`);
  assert.equal(activeExportSpools(), 1);
  await held.body.cancel();
  assert.equal(activeExportSpools(), 0);

  const pending = await post();
  assert.equal(pending.status, 200);
  // Klient przerywa pobieranie po pierwszym fragmencie.
  const reader = pending.body.getReader();
  const { value } = await reader.read();
  assert.ok(value.byteLength > 0 && value.byteLength < bytes.byteLength);
  await reader.cancel();
  assert.equal(activeExportSpools(), 0, 'przerwanie zamyka uchwyt');

  // Równoległy przebieg tego samego roku (blokada zajęta): 409 i bufor zwolniony.
  const busyDb = {
    query: (sql, params) => db.query(sql, params),
    transaction: (fn, options) => db.transaction((tx) => fn({
      query: (sql, params) => (sql.includes('pg_try_advisory_xact_lock') ? { rows: [{ locked: false }] } : tx.query(sql, params)),
    }), options),
  };
  const busy = await handlePgRequest(request('/api/exports', { cookie: admin, method: 'POST', body: { schoolYearId: YEAR } }), { db: busyDb });
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).error, 'export_in_progress');
  assert.equal(activeExportSpools(), 0);
  assert.equal(await spoolFilesLeft(), before);
});

test('bufor na dysku: reset po ponowieniu, bezczynny bufor zamyka się sam', async () => {
  const spool = await createExportSpool({ idleMs: 20 });
  await spool.write(Buffer.from('pierwsza próba'));
  await spool.reset();
  await spool.write(Buffer.from('abc'));
  assert.equal(spool.size, 3);
  const text = Buffer.from(await new Response(spool.body()).arrayBuffer()).toString('utf8');
  assert.equal(text, 'abc');
  assert.equal(spool.closed, true);

  const idle = await createExportSpool({ idleMs: 20 });
  await idle.write(Buffer.from('x'));
  idle.body();
  await new Promise((resolve) => { setTimeout(resolve, 60); });
  assert.equal(idle.closed, true);
  assert.equal(activeExportSpools(), 0);
});
