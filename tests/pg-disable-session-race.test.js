// #256: wyłączenie konta a równoległe utworzenie sesji (logowanie, przyjęcie
// zaproszenia, rotacja) na prawdziwym PostgreSQL. PGlite ma jedno połączenie
// i serializuje transakcje, więc ten przeplot odtwarza tylko prawdziwy serwer.
// Test działa jedynie z RD_TEST_PG_URL (serwer testowy z prawem CREATE
// DATABASE) i jest pomijany bez tej zmiennej:
//
//   RD_TEST_PG_URL=postgres://postgres@127.0.0.1:55462/postgres node --test tests/pg-disable-session-race.test.js
//
// Przeplot: wyłączenie konta już zablokowało wiersz users (FOR UPDATE) i
// zapisało disabled_at, ale jeszcze nie zatwierdziło; w tym czasie
// createSession wstawia sesję. Bez blokady wiersza konta w createSession
// INSERT … SELECT widział jeszcze disabled_at = NULL (migawka sprzed COMMIT),
// czekał tylko na sprawdzenie klucza obcego i po COMMIT wyłączenia wstawiał
// sesję z revoked_at IS NULL — UPDATE sessions wyłączenia już jej nie
// widział. Po ponownym włączeniu konta taka sesja znów działała (#256).
//
// Wyłącznie dane syntetyczne.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createPgDatabase } from '../src/db.js';
import { applyMigrations, loadMigrations } from '../src/postgres-migrations.js';
import { handlePgRequest } from '../src/pg/app.js';
import { createSession } from '../src/pg/auth.js';
import { request, seedUser, seedUserSession } from './helpers/pg.js';

const ADMIN_URL = process.env.RD_TEST_PG_URL;
const skip = ADMIN_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';

async function withDatabase(fn) {
  const name = `rd_disable_race_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  const db = createPgDatabase({ connectionString: url.toString(), max: 8 });
  try {
    await applyMigrations(client, await loadMigrations(fileURLToPath(new URL('../postgres/migrations/', import.meta.url))));
    await client.end();
    await fn(db, url.toString());
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  }
}

test('#256: sesja tworzona w trakcie wyłączania konta nie zostaje aktywna (brak revoked_at IS NULL po COMMIT)', { skip }, async () => {
  await withDatabase(async (db, url) => {
    const admin = await seedUserSession(db, { userId: 'u-admin-race', roles: [{ role: 'admin' }], mfa: true });
    await seedUser(db, { userId: 'u-victim-race' });
    // Token resetu konta: wyłączenie go unieważnia (revokePasswordResetTokens)
    // PRZED wycofaniem sesji — trzymając blokadę tego wiersza zatrzymujemy
    // transakcję wyłączenia w połowie, po zapisaniu disabled_at.
    await db.query(
      `INSERT INTO password_reset_tokens (id, user_id, token_hash, created_by, expires_at)
       VALUES ('prt-race', 'u-victim-race', repeat('a', 64), 'u-admin-race', now() + interval '1 hour')`,
    );
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query("SELECT id FROM password_reset_tokens WHERE id = 'prt-race' FOR UPDATE");

    const disable = handlePgRequest(
      request('/api/admin/users/u-victim-race/disable', { method: 'POST', cookie: admin, body: {} }),
      { db },
    );
    await sleep(300); // wyłączenie trzyma już FOR UPDATE na users i czeka na wiersz tokenu
    const login = createSession(db, { userId: 'u-victim-race' }).then(
      (session) => ({ ok: true, session }),
      (error) => ({ ok: false, error: error.message }),
    );
    await sleep(300); // createSession dotarło do blokady wiersza konta

    await holder.query('COMMIT');
    await holder.end();
    const disabled = await disable;
    assert.equal(disabled.status, 200);
    const outcome = await login;
    assert.deepEqual(outcome, { ok: false, error: 'user_unavailable' });

    const { rows } = await db.query(
      "SELECT count(*)::int AS n FROM sessions WHERE user_id = 'u-victim-race' AND revoked_at IS NULL",
    );
    assert.equal(rows[0].n, 0, 'żadna sesja wyłączonego konta nie zostaje z revoked_at IS NULL');

    // Po ponownym włączeniu konta nic z okresu wyłączenia nie ożywa.
    const enabled = await handlePgRequest(
      request('/api/admin/users/u-victim-race/enable', { method: 'POST', cookie: admin, body: {} }),
      { db },
    );
    assert.equal(enabled.status, 200);
    const after = await db.query(
      "SELECT count(*)::int AS n FROM sessions WHERE user_id = 'u-victim-race' AND revoked_at IS NULL AND expires_at > now()",
    );
    assert.equal(after.rows[0].n, 0);
  });
});
