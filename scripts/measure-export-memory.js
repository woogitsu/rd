// Pomiar pamięci i blokady pętli zdarzeń przy eksporcie rocznym (#216).
// Dane wyłącznie syntetyczne (PGlite w procesie, zdarzenia audytu z generate_series).
//
//   node --max-old-space-size=256 scripts/measure-export-memory.js [--events 200000]
//
// Wypisuje JSON: rozmiar paczki, czas trasy, szczyt sterty JS (próbkowanie co
// 5 ms, więc dolne oszacowanie przy długich blokadach), szczyt RSS, najdłuższe
// opóźnienie pętli zdarzeń. Czasy PGlite nie są reprezentatywne dla Railway —
// rozmiary i proporcje pamięci zależą od kodu JS, nie od silnika bazy.
import { performance } from 'node:perf_hooks';
import { createTestDb, request, seedSchoolYear, seedUserSession } from '../tests/helpers/pg.js';
import { handlePgRequest } from '../src/pg/app.js';

const eventsArg = process.argv.indexOf('--events');
const EVENTS = eventsArg > 0 ? Number(process.argv[eventsArg + 1]) : 200_000;
const YEAR = 'y-measure';

const db = await createTestDb();
await seedSchoolYear(db, YEAR);
const admin = await seedUserSession(db, { userId: 'u-measure', roles: [{ role: 'admin' }], mfa: true });
await db.query(
  `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, occurred_at, metadata_json)
   SELECT 'ae-' || g, 'u-measure', 'session.created', 'session', 'sess-' || g,
          timestamptz '2026-10-01 12:00:00+00' + (g || ' seconds')::interval,
          jsonb_build_object('note', 'zdarzenie syntetyczne ' || g, 'ip', '203.0.113.' || (g % 250))
   FROM generate_series(1, $1::int) g`,
  [EVENTS],
);

let peakHeap = 0;
let peakRss = 0;
let maxLag = 0;
let last = performance.now();
const timer = setInterval(() => {
  const now = performance.now();
  maxLag = Math.max(maxLag, now - last - 5);
  last = now;
  const usage = process.memoryUsage();
  peakHeap = Math.max(peakHeap, usage.heapUsed);
  peakRss = Math.max(peakRss, usage.rss);
}, 5);

const baseHeap = process.memoryUsage().heapUsed;
const started = performance.now();
const response = await handlePgRequest(request('/api/exports', { cookie: admin, method: 'POST', body: { schoolYearId: YEAR } }), { db });
let bytes = 0;
if (response.status === 200) {
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
  }
}
const elapsedMs = Math.round(performance.now() - started);
clearInterval(timer);
const mb = (n) => Math.round((n / 1048576) * 10) / 10;
console.log(JSON.stringify({
  events: EVENTS, status: response.status, bundleMb: mb(bytes), routeMs: elapsedMs,
  heapBaseMb: mb(baseHeap), heapPeakMb: mb(peakHeap), rssPeakMb: mb(peakRss), maxEventLoopLagMs: Math.round(maxLag),
}));
await db.close();
