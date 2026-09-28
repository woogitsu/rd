// Indeksy pod listy z kursorem (issue #159, migracja 0059). Dane syntetyczne.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/pg.js';

let db;
before(async () => { db = await createTestDb(); });
after(async () => { await db?.close(); });

async function indexDef(name) {
  const { rows } = await db.query('SELECT indexdef FROM pg_indexes WHERE indexname = $1', [name]);
  return rows[0]?.indexdef ?? null;
}

test('migracja 0059 tworzy audit_occurred_at_idx (occurred_at DESC, id)', async () => {
  const def = await indexDef('audit_occurred_at_idx');
  assert.ok(def, 'indeks istnieje');
  assert.match(def, /occurred_at DESC/);
  assert.match(def, /audit_events/);
});

test('migracja 0059 tworzy audit_action_occurred_at_idx (action, occurred_at DESC)', async () => {
  const def = await indexDef('audit_action_occurred_at_idx');
  assert.ok(def);
  assert.match(def, /\(action, occurred_at DESC\)/);
});

test('migracja 0059 tworzy częściowy payment_list_idx dla status recorded/unmatched', async () => {
  const def = await indexDef('payment_list_idx');
  assert.ok(def);
  assert.match(def, /received_on DESC/);
  assert.match(def, /id DESC/);
  assert.match(def, /WHERE .*status/);
  assert.doesNotMatch(def, /'reversed'/, 'reversed nie wchodzi w częściowy indeks listy');
});

test('EXPLAIN listAudit (occurred_at DESC z filtrem action) nie robi Seq Scan po audit_events przy dużej liczbie zdarzeń', async () => {
  // Wolumen wystarczający, by planer wybrał indeks zamiast Seq Scan (PGlite
  // respektuje statystyki po ANALYZE tak jak zwykły Postgres).
  await db.query("INSERT INTO users (id, email, display_name) VALUES ('u-seed', 'seed@example.invalid', 'Seed') ON CONFLICT (id) DO NOTHING");
  const values = [];
  const params = [];
  for (let i = 0; i < 5000; i += 1) {
    const base = params.length;
    values.push(`($${base + 1}, 'u-seed', $${base + 2}, 'test', $${base + 3}, now() - ($${base + 4}::int || ' seconds')::interval)`);
    params.push(`ae-vol-${i}`, i % 5 === 0 ? 'role_grant.created' : 'session.created', `x-${i}`, i);
  }
  await db.query(`INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, occurred_at) VALUES ${values.join(',')}`, params);
  await db.query('ANALYZE audit_events');

  const { rows } = await db.query(
    "EXPLAIN (FORMAT JSON) SELECT id FROM audit_events WHERE action = ANY($1::text[]) ORDER BY occurred_at DESC LIMIT 50",
    [['role_grant.created']],
  );
  const plan = JSON.stringify(rows[0]['QUERY PLAN']);
  assert.doesNotMatch(plan, /Seq Scan/, `oczekiwano planu z indeksem, dostano: ${plan}`);
});
