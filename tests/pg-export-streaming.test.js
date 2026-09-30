// #216: eksport roczny partiami i strumieniem — ten sam bajt w bajt JSON i
// SHA-256 manifestu co wersja buforowana, oddawanie pętli zdarzeń wewnątrz
// dużej tabeli, odpowiedź HTTP z Content-Length. Wyłącznie dane syntetyczne.
//
// Test wolumenowy (nocny, #111) włączany zmienną: RD_EXPORT_VOLUME_EVENTS=200000
// node --max-old-space-size=256 --test tests/pg-export-streaming.test.js
// (bez zmiennej pomijany; pomiar bez asercji: scripts/measure-export-memory.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildYearlyExport, canonicalJson, EXPORT_BATCH_ROWS, verifyBundle,
} from '../src/pg/export.js';
import { handlePgRequest } from '../src/pg/app.js';
import { createExportSpool } from '../src/pg/export-spool.js';
import {
  createTestDb, request, seedSchoolYear, seedUserSession,
} from './helpers/pg.js';

const YEAR = 'y-export-stream';
const EVENTS = EXPORT_BATCH_ROWS * 2 + 345; // trzy partie audit_events

async function seed(db, events) {
  await seedSchoolYear(db, YEAR);
  await db.query(
    `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, occurred_at, metadata_json)
     SELECT 'ae-s-' || g, NULL, 'session.created', 'session', 'sess-' || g,
            timestamptz '2026-10-01 12:00:00+00' + (g || ' seconds')::interval,
            jsonb_build_object('note', 'zdarzenie "syntetyczne" ' || g || E'\n' || 'zażółć gęślą', 'schoolYearId', $2::text)
       FROM generate_series(1, $1::int) g`,
    [events, YEAR],
  );
}

test('strumieniowy eksport daje ten sam JSON i SHA-256 manifestu co wersja buforowana, na wielu partiach', async () => {
  const db = await createTestDb();
  try {
    await seed(db, EVENTS);
    const buffered = await db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      return buildYearlyExport(tx, YEAR);
    });
    let ticks = 0;
    let running = true;
    (function spin() { if (running) setImmediate(() => { ticks += 1; spin(); }); })();
    const streamed = await db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      return buildYearlyExport(tx, YEAR, { stream: true });
    });
    running = false;

    assert.equal(streamed.manifestSha256, buffered.manifestSha256);
    assert.equal(canonicalJson(streamed.manifest), canonicalJson(buffered.manifest));
    assert.deepEqual(streamed.rowCounts, buffered.rowCounts);
    assert.equal(streamed.bundle, undefined, 'tryb strumieniowy nie trzyma obiektu paczki');
    const body = Buffer.concat(streamed.bodyChunks);
    assert.equal(streamed.bodyBytes, body.byteLength);
    assert.equal(body.toString('utf8'), buffered.body, 'bajt w bajt ten sam JSON');
    const audit = buffered.manifest.files.find((file) => file.table === 'audit_events');
    assert.equal(audit.rows, EVENTS);
    // Pętla zdarzeń dostała szansę co najmniej po każdej partii audit_events.
    assert.ok(ticks >= 3, `pętla zdarzeń oddana ${ticks} razy`);
    // Paczka przechodzi weryfikację i odtworzenie sum.
    const report = verifyBundle(JSON.parse(body.toString('utf8')));
    assert.equal(report.manifestSha256, buffered.manifestSha256);
  } finally {
    await db.close();
  }
});

test('POST /api/exports: odpowiedź ma Content-Length, nagłówek SHA-256 zgodny z paczką i weryfikuje się', async () => {
  const db = await createTestDb();
  try {
    await seed(db, EXPORT_BATCH_ROWS + 10);
    const admin = await seedUserSession(db, { userId: 'u-stream-admin', roles: [{ role: 'admin' }], mfa: true });
    const res = await handlePgRequest(request('/api/exports', { cookie: admin, method: 'POST', body: { schoolYearId: YEAR } }), { db });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(res.headers.get('content-length'), String(bytes.byteLength));
    const bundle = JSON.parse(bytes.toString('utf8'));
    assert.equal(canonicalJson(bundle), bytes.toString('utf8'), 'paczka jest kanonicznym JSON-em');
    assert.equal(res.headers.get('x-export-manifest-sha256'), bundle.manifestSha256);
    assert.equal(verifyBundle(bundle).manifestSha256, bundle.manifestSha256);
    const runs = await db.query("SELECT count(*)::int AS n FROM export_runs WHERE kind = 'yearly' AND school_year_id = $1", [YEAR]);
    assert.equal(runs.rows[0].n, 1);
  } finally {
    await db.close();
  }
});

const volume = Number(process.env.RD_EXPORT_VOLUME_EVENTS ?? 0);
test('wolumen: rok z dużą liczbą zdarzeń audytu mieści się w niskim limicie sterty', {
  skip: volume ? false : 'brak RD_EXPORT_VOLUME_EVENTS (test nocny, #111)',
}, async () => {
  const db = await createTestDb();
  try {
    await seed(db, volume);
    // Rozgrzewka: pierwszy przebieg powiększa pamięć WASM PGlite (liczona w
    // arrayBuffers), co nie jest kosztem eksportu; mierzony jest drugi przebieg.
    await db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      return buildYearlyExport(tx, YEAR, { sink: () => {} });
    });
    // Jak trasa: fragmenty paczki do bufora na dysku (src/pg/export-spool.js).
    const spool = await createExportSpool();
    const base = process.memoryUsage();
    let peakHeap = 0;
    let peakBuffers = 0;
    const timer = setInterval(() => {
      const usage = process.memoryUsage();
      peakHeap = Math.max(peakHeap, usage.heapUsed);
      peakBuffers = Math.max(peakBuffers, usage.arrayBuffers);
    }, 5);
    let built;
    try {
      built = await db.transaction(async (tx) => {
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        return buildYearlyExport(tx, YEAR, { sink: (chunk) => spool.write(chunk) });
      });
    } finally {
      clearInterval(timer);
      await spool.discard();
    }
    // Kryterium #216: szczyt sterty rośnie o mniej niż 64 MB niezależnie od liczby wierszy
    // (bufory paczki też nie rosną z rozmiarem — paczka jest na dysku).
    const MB = 1048576;
    assert.ok(peakHeap - base.heapUsed < 64 * MB,
      `wzrost sterty ${Math.round((peakHeap - base.heapUsed) / MB)} MB przy paczce ${Math.round(built.bodyBytes / MB)} MB`);
    assert.ok(peakBuffers - base.arrayBuffers < 64 * MB,
      `wzrost buforów ${Math.round((peakBuffers - base.arrayBuffers) / MB)} MB przy paczce ${Math.round(built.bodyBytes / MB)} MB`);
    assert.equal(built.rowCounts.audit_events, volume);
  } finally {
    await db.close();
  }
});
