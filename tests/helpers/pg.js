// Wspólne narzędzia testowe dla API na PostgreSQL (PGlite w pamięci).
// Wyłącznie dane syntetyczne; domeny .invalid / .test.
//
//   const db = await createTestDb();                 // PGlite + wszystkie postgres/migrations/*.sql
//   const cookie = await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: 'y-2026' }] });
//   const res = await handlePgRequest(request('/api/access', { cookie }), { db });
//   await db.close();
//
// PGlite spełnia kontrakt src/db.js: db.query(sql, params) -> { rows },
// db.transaction(async (tx) => …). Można go podać bezpośrednio jako env.db.

import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { createPgDatabase, poolConfig } from '../../src/db.js';
import { createSessionSecret } from '../../src/auth.js';
import { loadMigrations } from '../../src/postgres-migrations.js';
import { loadAuthorizationContext } from '../../src/pg/authorization.js';
// #214: instaluje globalną pułapkę na sieć jako efekt uboczny importu — każdy
// plik, który używa tego helpera, jest chroniony bez osobnej konfiguracji.
import { networkGuardCalls } from './network-guard.js';

export { networkGuardCalls };
export const TEST_ORIGIN = 'https://rd.test';
const migrationsDirectory = fileURLToPath(new URL('../../postgres/migrations/', import.meta.url));

// #208: PGlite wykonuje transakcje po kolei (jedno połączenie, jedna blokada),
// więc NIE nadaje się do testów współbieżności — testy „parallel/double click”
// na nim sprawdzają tylko niezmiennik wyniku. Z RD_TEST_PG_BACKEND=real
// (ustawia je `npm run test:pg-real -- --all`) createTestDb() zwraca zamiast
// PGlite bazę na prawdziwym PostgreSQL (RD_TEST_PG_URL) przez createPgDatabase
// z src/db.js: osobna baza na wywołanie, sklonowana z szablonu z migracjami.
const realBackend = process.env.RD_TEST_PG_BACKEND === 'real' && Boolean(process.env.RD_TEST_PG_URL);
let realTemplate;
let realSeq = 0;

function withDatabaseName(url, name) {
  const next = new URL(url);
  next.pathname = `/${name}`;
  return next.toString();
}

async function adminQuery(sql) {
  const admin = new pg.Client({ connectionString: process.env.RD_TEST_PG_URL });
  await admin.connect();
  try { await admin.query(sql); } finally { await admin.end(); }
}

async function ensureRealTemplate() {
  realTemplate ??= (async () => {
    const name = `rd_tpl_${process.pid}_${Date.now()}`;
    await adminQuery(`CREATE DATABASE ${name}`);
    const client = new pg.Client({ connectionString: withDatabaseName(process.env.RD_TEST_PG_URL, name) });
    await client.connect();
    try { for (const migration of await loadMigrations(migrationsDirectory)) await client.query(migration.sql); } finally { await client.end(); }
    return name;
  })();
  return realTemplate;
}

export async function createRealTestDb() {
  const template = await ensureRealTemplate();
  const name = `rd_t_${process.pid}_${++realSeq}_${Date.now()}`;
  await adminQuery(`CREATE DATABASE ${name} TEMPLATE ${template}`);
  const url = withDatabaseName(process.env.RD_TEST_PG_URL, name);
  const pool = new pg.Pool(poolConfig({ connectionString: url, max: 10, statement_timeout: 30_000 }));
  const db = createPgDatabase(pool);
  const closePool = db.close.bind(db);
  return {
    url,
    query: db.query.bind(db),
    transaction: db.transaction.bind(db),
    probe: db.probe.bind(db),
    // Odpowiednik PGlite.exec: kilka instrukcji w jednym tekście (protokół prosty).
    async exec(sql) { await pool.query(sql); },
    async close() {
      await closePool();
      await adminQuery(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}

export async function createTestDb() {
  if (realBackend) return createRealTestDb();
  const db = new PGlite();
  for (const migration of await loadMigrations(migrationsDirectory)) await db.exec(migration.sql);
  return db;
}

// Rok szkolny o podanym id (idempotentnie). Etykieta pochodzi z id, by nie kolidować.
export async function seedSchoolYear(db, id = 'y-test', { startsOn = '2026-09-01', endsOn = '2027-08-31' } = {}) {
  await db.query(
    `INSERT INTO school_years (id, label, starts_on, ends_on) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [id, `test ${id}`, startsOn, endsOn],
  );
  return id;
}

// Klasa w roku szkolnym (idempotentnie; tworzy też rok, jeśli brak).
export async function seedClass(db, { id, schoolYearId = 'y-test', name = id }) {
  await seedSchoolYear(db, schoolYearId);
  await db.query(
    `INSERT INTO classes (id, school_year_id, name) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [id, schoolYearId, name],
  );
  return id;
}

// Użytkownik (idempotentnie). Domyślny e-mail jest syntetyczny.
// Domyślny e-mail jest zawsze małymi literami (#198: users.email wymaga
// lower(btrim(email))) niezależnie od wielkości liter w userId (np. klucze
// aktorów macierzy uprawnień 'repA', 'boardA').
export async function seedUser(db, { userId, email = `${String(userId).toLowerCase()}@example.invalid`, displayName = `Test ${userId}`, disabled = false }) {
  await db.query(
    `INSERT INTO users (id, email, display_name, disabled_at) VALUES ($1, $2, $3, CASE WHEN $4::boolean THEN now() END)
     ON CONFLICT (id) DO NOTHING`,
    [userId, String(email).trim().toLowerCase(), displayName, Boolean(disabled)],
  );
  return userId;
}

/**
 * Tworzy (w razie potrzeby) użytkownika, przydziały ról i sesję.
 * Brakujące lata i klasy wskazane w roles są tworzone syntetycznie
 * (klasa bez schoolYearId trafia do roku 'y-test').
 *
 * @param {object} db PGlite z createTestDb()
 * @param {object} options
 * @param {string} options.userId
 * @param {string} [options.email]       domyślnie `${userId.toLowerCase()}@example.invalid`
 * @param {Array<{role:string, classId?:string, schoolYearId?:string, expiresAt?:string|Date, revoked?:boolean}>} [options.roles]
 * @param {boolean} [options.mfa=false]  czy sesja ma potwierdzone MFA
 * @param {string|Date} [options.expiresAt] domyślnie za 1 godzinę; data w przeszłości = sesja wygasła
 * @param {boolean} [options.revoked=false]
 * @param {boolean} [options.disabled=false] konto wyłączone
 * @returns {Promise<string>} wartość nagłówka Cookie, np. `rd_session=…`
 */
export async function seedUserSession(db, {
  userId, email, displayName, roles = [], mfa = false, expiresAt, revoked = false, disabled = false, createdAt,
}) {
  if (!userId) throw new Error('seedUserSession: userId is required');
  await seedUser(db, { userId, email, displayName, disabled });
  for (const grant of roles) {
    if (grant.schoolYearId) await seedSchoolYear(db, grant.schoolYearId);
    if (grant.classId) await seedClass(db, { id: grant.classId, schoolYearId: grant.schoolYearId ?? 'y-test' });
    await db.query(
      `INSERT INTO role_grants (id, user_id, role, class_id, school_year_id, expires_at, revoked_at, revoked_by)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::boolean THEN now() END, CASE WHEN $7::boolean THEN $2 END)`,
      [crypto.randomUUID(), userId, grant.role, grant.classId ?? null, grant.schoolYearId ?? null,
        grant.expiresAt ? new Date(grant.expiresAt).toISOString() : null, Boolean(grant.revoked)],
    );
  }
  const { secret, tokenHash } = await createSessionSecret();
  const expires = expiresAt ? new Date(expiresAt) : new Date(Date.now() + 60 * 60 * 1000);
  // #150 (SR-10, migracja 0082 — session_guard_trigger): `created_at` sesji
  // jest niezmienne po zapisie (identity_immutable), więc symulacja "logowania
  // dawno temu" (absolutny limit rotacji, bezczynność) musi ustawić created_at
  // przy INSERT, nie przez UPDATE po fakcie — stąd jawny `createdAt`.
  const created = createdAt ? new Date(createdAt) : new Date(Math.min(Date.now(), expires.getTime() - 60 * 1000));
  await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, mfa_verified_at, revoked_at, revoked_reason)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::boolean THEN $4::timestamptz END,
             CASE WHEN $7::boolean THEN now() END, CASE WHEN $7::boolean THEN 'admin' END)`,
    [crypto.randomUUID(), userId, tokenHash, created.toISOString(), expires.toISOString(), Boolean(mfa), Boolean(revoked)],
  );
  return `rd_session=${secret}`;
}

/**
 * Buduje Web Request do testów handlePgRequest.
 * - url: ścieżka ('/api/session') względem TEST_ORIGIN albo pełny URL,
 * - body: obiekt → JSON z Content-Type application/json; string/Buffer bez zmian,
 * - cookie: wartość nagłówka Cookie (np. wynik seedUserSession),
 * - origin: domyślnie zgodny origin dla POST/PUT/PATCH/DELETE i brak dla GET/HEAD;
 *   false/null = bez nagłówka Origin, string = podany origin (test CSRF).
 */
export function request(url, { method = 'GET', headers = {}, body, cookie, origin } = {}) {
  const target = new URL(url, TEST_ORIGIN);
  const upper = method.toUpperCase();
  const finalHeaders = new Headers(headers);
  if (cookie) finalHeaders.set('Cookie', cookie);
  const resolvedOrigin = origin === undefined
    ? (['GET', 'HEAD'].includes(upper) ? null : target.origin)
    : origin;
  if (resolvedOrigin) finalHeaders.set('Origin', resolvedOrigin);
  let payload = body;
  if (body !== undefined && body !== null && typeof body === 'object' && !(body instanceof Uint8Array) && !(body instanceof ArrayBuffer)) {
    payload = JSON.stringify(body);
    if (!finalHeaders.has('Content-Type')) finalHeaders.set('Content-Type', 'application/json');
  }
  return new Request(target, { method: upper, headers: finalHeaders, body: payload });
}

// #214: aktor dla funkcji bibliotecznych (meetings/events/news) zbudowany TAK JAK
// w produkcji — przez ładowanie sesji i przydziałów (`loadAuthorizationContext`),
// a nie ręcznie. Dzięki temu wygasła/cofnięta sesja, wyłączone konto oraz
// wygasły/cofnięty przydział są odfiltrowywane przez prawdziwe zapytania SQL.
// Zwraca null, gdy sesja jest nieważna (odpowiednik 401 unauthenticated).
export async function actorFromSession(db, cookie) {
  const env = { db };
  const context = await loadAuthorizationContext(request('/api/session', { cookie }), env);
  if (!context?.session?.user?.id) return null;
  return {
    userId: context.session.user.id,
    grants: Array.isArray(context.grants) ? context.grants : [],
    mfaVerified: Boolean(context.session.mfaVerified),
  };
}

// Sześć aktorów o tej samej roli i zakresie, różniących się wyłącznie stanem
// sesji lub przydziału. `active` musi mieć dostęp; pozostali nie.
export async function lifecycleActors(db, { role, schoolYearId, classId, prefix = 'lc' }) {
  const past = new Date(Date.now() - 24 * 3600 * 1000);
  const grant = (extra = {}) => [{ role, schoolYearId, classId, ...extra }];
  const make = async (name, options) => actorFromSession(db, await seedUserSession(db, { userId: `${prefix}-${name}`, mfa: true, ...options }));
  return {
    active: await make('active', { roles: grant() }),
    expiredGrant: await make('expired-grant', { roles: grant({ expiresAt: past }) }),
    revokedGrant: await make('revoked-grant', { roles: grant({ revoked: true }) }),
    expiredSession: await make('expired-session', { roles: grant(), expiresAt: past }),
    revokedSession: await make('revoked-session', { roles: grant(), revoked: true }),
    disabledAccount: await make('disabled', { roles: grant(), disabled: true }),
  };
}
