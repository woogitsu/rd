#!/usr/bin/env node
// Serwer testowy dla Playwright (E2E w CI): Node + PGlite (PostgreSQL w pamięci)
// + zbudowane panele (dist/, patrz `npm run build`). Dane wyłącznie syntetyczne
// (domeny .invalid, hasła i sekrety TOTP generowane tu, w tym procesie).
//
// Uruchamiany przez playwright.config.js jako `webServer.command`. Zapisuje
// dane logowania do tests/e2e/support/.runtime.json (poza repo — patrz
// .gitignore), zanim zacznie nasłuchiwać, żeby testy mogły je odczytać.
//
// E-mail: serwer HTTP nigdy nie wysyła e-maili synchronicznie (patrz
// scripts/email-worker.js — osobne zadanie, tu nieuruchamiane). BREVO_*
// nie jest ustawione, więc nawet gdyby jakiś kod spróbował wysłać, brak klucza
// API zatrzyma go przed jakimkolwiek wywołaniem zewnętrznym.
import { randomBytes } from 'node:crypto';
import { base32Encode, encryptSecret, loadEncryptionKey } from '../../../src/pg/mfa.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { createSessionSecret } from '../../../src/auth.js';
import { hashPassword } from '../../../src/pg/password.js';
import { createDraft, submit, approve, publish } from '../../../src/pg/events.js';
import { handlePgRequest } from '../../../src/pg/app.js';
import { loadMigrations, applyMigrations } from '../../../src/postgres-migrations.js';
import { startServer } from '../../../src/server.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const migrationsDir = fileURLToPath(new URL('../../../postgres/migrations/', import.meta.url));
const distRoot = fileURLToPath(new URL('../../../dist/', import.meta.url));
const RUNTIME_FILE = `${HERE}.runtime.json`;
const PORT = Number(process.env.E2E_PORT || 4317);

// Koszt scrypt jak w testach jednostkowych (tests/pg-login.test.js) — najniższy
// dozwolony (2^15), żeby logowanie w przeglądarce nie czekało na domyślny koszt 2^17.
const FAST_SCRYPT = { SCRYPT_COST_LOG2: '15' };

function pgliteClient(db) {
  return {
    async query(sql, params = []) {
      if (params.length) return db.query(sql, params);
      const results = await db.exec(sql);
      return results.at(-1) ?? { rows: [] };
    },
  };
}

async function seedSchoolYear(db, id, { startsOn = '2026-09-01', endsOn = '2027-08-31' } = {}) {
  await db.query(
    `INSERT INTO school_years (id, label, starts_on, ends_on) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
    [id, `e2e ${id}`, startsOn, endsOn],
  );
}

async function seedClass(db, id, schoolYearId, name = id) {
  await db.query(
    `INSERT INTO classes (id, school_year_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [id, schoolYearId, name],
  );
}

async function seedUser(db, userId, email) {
  await db.query(
    `INSERT INTO users (id, email, display_name) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
    [userId, email ?? `${userId}@example.invalid`],
  );
}

async function grantRole(db, userId, role, { classId = null, schoolYearId = null } = {}) {
  await db.query(
    `INSERT INTO role_grants (id, user_id, role, class_id, school_year_id) VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
    [userId, role, classId, schoolYearId],
  );
}

// Konto z hasłem, ale BEZ czynnika MFA — używane w teście logowania admina,
// który przechodzi realny zapis weryfikacji dwuetapowej w przeglądarce
// (klucz odczytany z ekranu, kod TOTP policzony w teście — patrz admin-mfa.spec.js).
async function seedPasswordAccount(db, { userId, role, password }) {
  await seedUser(db, userId);
  await grantRole(db, userId, role);
  await db.query(
    `INSERT INTO user_passwords (user_id, hash, set_reason) VALUES ($1, $2, 'invitation')`,
    [userId, await hashPassword(password, { env: FAST_SCRYPT })],
  );
}

// Sesja wstrzykiwana bezpośrednio przez cookie (jak scripts/smoke-postgres.js) —
// używana tam, gdzie test sprawdza granice roli/danych, a nie sam ekran logowania.
// `mfaAgeMinutes`: MFA potwierdzone tyle minut temu (domyślnie teraz) — starsze niż
// 15 min to sesja „mfa_stale” dla operacji wymagających kroku w górę (#150).
async function seedCookieSession(db, { userId, mfa = false, mfaAgeMinutes = 0 }) {
  const { secret, tokenHash } = await createSessionSecret();
  const expires = new Date(Date.now() + 60 * 60 * 1000);
  await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, mfa_verified_at)
     VALUES (gen_random_uuid(), $1, $2, now(), $3, CASE WHEN $4::boolean THEN now() - ($5::int * interval '1 minute') END)`,
    [userId, tokenHash, expires.toISOString(), Boolean(mfa), mfaAgeMinutes],
  );
  return secret;
}

// Potwierdzony czynnik TOTP ze znanym sekretem (syntetycznym) — test liczy kod
// tak jak aplikacja na telefonie. Klucz szyfrowania jak w serwerze testowym.
async function seedTotpFactor(db, { userId, factorId, encryptionKey }) {
  const secret = randomBytes(20);
  const sealed = encryptSecret(loadEncryptionKey({ MFA_ENCRYPTION_KEY: encryptionKey }), secret, { factorId, userId });
  await db.query(
    `INSERT INTO user_mfa_factors (id, user_id, method, secret_ciphertext, secret_iv, secret_tag, confirmed_at)
     VALUES ($1, $2, 'totp', $3, $4, $5, now())`,
    [factorId, userId, sealed.ciphertext, sealed.iv, sealed.tag],
  );
  return base32Encode(secret);
}

async function seedFamilies(db) {
  // Dwie klasy w tym samym roku szkolnym: przedstawiciel ma dostęp tylko do c-1a
  // (test granicy ról — families-scope.spec.js), c-2b musi pozostać niewidoczna.
  await db.exec(`
    INSERT INTO households (id) VALUES ('e2e-h-1a'), ('e2e-h-2b');
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
      ('e2e-g-1a', 'e2e-h-1a', 'Anna', 'Syntetyczna', 'opiekun-1a@example.invalid', true),
      ('e2e-g-2b', 'e2e-h-2b', 'Piotr', 'Syntetyczny', 'opiekun-2b@example.invalid', true);
    INSERT INTO students (id, household_id, first_name, last_name) VALUES
      ('e2e-s-1a', 'e2e-h-1a', 'Ola', 'Syntetyczna'),
      ('e2e-s-2b', 'e2e-h-2b', 'Jan', 'Syntetyczny');
    INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES
      ('e2e-s-1a', 'e2e-g-1a', true, true), ('e2e-s-2b', 'e2e-g-2b', true, true);
    INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
      ('e2e-e-1a', 'e2e-s-1a', 'e2e-c-1a', 'e2e-y-2026'),
      ('e2e-e-2b', 'e2e-s-2b', 'e2e-c-2b', 'e2e-y-2026');
  `);
}

// Wydarzenie opublikowane (widoczne publicznie) i szkic, który NIGDY nie jest
// zgłoszony — pilnuje, że site/ nie pokazuje danych niezatwierdzonych.
async function seedEvents(db) {
  // Zasada czterech oczu (four_eyes_required): kto zgłasza, nie może sam zatwierdzać —
  // stąd dwa osobne konta board do submit i do approve/publish.
  const board = { userId: 'e2e-board-events', grants: [{ role: 'board', classId: null, schoolYearId: null }], mfaVerified: true };
  const boardReviewer = { userId: 'e2e-board-reviewer', grants: [{ role: 'board', classId: null, schoolYearId: null }], mfaVerified: true };
  await seedUser(db, board.userId);
  await grantRole(db, board.userId, 'board');
  await seedUser(db, boardReviewer.userId);
  await grantRole(db, boardReviewer.userId, 'board');

  const publishedInput = {
    schoolYearId: 'e2e-y-2026',
    title: 'Piknik szkolny (syntetyczny)',
    startsAt: '2026-11-12T18:30',
    endsAt: '2026-11-12T20:00',
    location: 'Boisko szkolne',
    organizer: 'Rada Rodziców',
    audience: 'public',
    idempotencyKey: 'e2e-event-published-0001',
  };
  const { event: published } = await createDraft(db, board, publishedInput);
  await submit(db, board, { eventId: published.id, revision: 1 });
  await approve(db, boardReviewer, { eventId: published.id, revision: 1 });
  await publish(db, boardReviewer, { eventId: published.id, revision: 1 });

  // Szkic pozostaje w statusie 'draft' (brak submit/approve/publish) — musi
  // NIGDY nie pojawić się na stronie publicznej ani w /api/public/events.
  await createDraft(db, board, {
    schoolYearId: 'e2e-y-2026',
    title: 'Szkic niezatwierdzony SEKRET E2E',
    startsAt: '2026-12-01T18:00',
    endsAt: '2026-12-01T19:00',
    location: 'Do ustalenia',
    organizer: 'Rada Rodziców',
    audience: 'public',
    idempotencyKey: 'e2e-event-draft-0001',
  });
}

async function main() {
  const db = new PGlite();
  const client = pgliteClient(db);
  const migrations = await loadMigrations(migrationsDir);
  const applied = await applyMigrations(client, migrations);
  if (applied.length !== migrations.length) {
    throw new Error(`Nie wszystkie migracje zastosowane: ${applied.length}/${migrations.length}`);
  }

  await seedSchoolYear(db, 'e2e-y-2026');
  await seedClass(db, 'e2e-c-1a', 'e2e-y-2026', '1A');
  await seedClass(db, 'e2e-c-2b', 'e2e-y-2026', '2B');
  await seedFamilies(db);
  await seedEvents(db);

  // 1. Admin: hasło + logowanie w przeglądarce, MFA zapisywane w teście (TOTP
  //    liczony w Playwright z sekretu odczytanego z ekranu #manual-key).
  const adminPassword = `Syntetyczne haslo admina ${randomBytes(6).toString('hex')}`;
  await seedPasswordAccount(db, { userId: 'e2e-admin', role: 'admin', password: adminPassword });

  // 2. Przedstawiciel klasy 1A (nie ma dostępu do 2B) — sesja przez cookie.
  await seedUser(db, 'e2e-rep');
  await grantRole(db, 'e2e-rep', 'representative', { classId: 'e2e-c-1a', schoolYearId: 'e2e-y-2026' });
  const repCookie = await seedCookieSession(db, { userId: 'e2e-rep', mfa: false });

  // 3. Skarbnik z potwierdzonym MFA (poza zakresem tego testu — sesja przez cookie).
  await seedUser(db, 'e2e-treasurer');
  // schoolYearId jawnie (nie null): filtr roku w panel/ buduje listę wyłącznie
  // z przydziałów, które podają konkretny rok (shared/school-year.js#yearsFromGrants).
  await grantRole(db, 'e2e-treasurer', 'treasurer', { schoolYearId: 'e2e-y-2026' });
  const treasurerCookie = await seedCookieSession(db, { userId: 'e2e-treasurer', mfa: true });

  // 4. Panel „Konta i role” (#224): admin z czynnikiem TOTP i sesjami cookie —
  //    jedna ze starym MFA (krok w górę: mfa_stale), jedna ze świeżym; dwa konta
  //    docelowe (hasło + czynnik TOTP), na których test wykonuje resety.
  const mfaKey = randomBytes(32).toString('base64');
  await seedUser(db, 'e2e-admin-reset');
  await grantRole(db, 'e2e-admin-reset', 'admin');
  const adminTotpSecret = await seedTotpFactor(db, { userId: 'e2e-admin-reset', factorId: 'e2e-f-admin-reset', encryptionKey: mfaKey });
  const adminStaleCookie = await seedCookieSession(db, { userId: 'e2e-admin-reset', mfa: true, mfaAgeMinutes: 60 });
  const adminStaleCookie2 = await seedCookieSession(db, { userId: 'e2e-admin-reset', mfa: true, mfaAgeMinutes: 60 });
  const adminFreshCookie = await seedCookieSession(db, { userId: 'e2e-admin-reset', mfa: true });
  const resetTargets = [];
  for (const id of ['e2e-reset-a', 'e2e-reset-b']) {
    const password = `Syntetyczne haslo ${id} ${randomBytes(6).toString('hex')}`;
    await seedPasswordAccount(db, { userId: id, role: 'board', password });
    await seedTotpFactor(db, { userId: id, factorId: `e2e-f-${id}`, encryptionKey: mfaKey });
    resetTargets.push({ userId: id, email: `${id}@example.invalid`, password });
  }

  const runtime = {
    port: PORT,
    baseUrl: `http://127.0.0.1:${PORT}`,
    schoolYearId: 'e2e-y-2026',
    classRepId: 'e2e-c-1a',
    classOtherId: 'e2e-c-2b',
    admin: { userId: 'e2e-admin', email: 'e2e-admin@example.invalid', password: adminPassword },
    representative: { userId: 'e2e-rep', cookie: repCookie },
    treasurer: { userId: 'e2e-treasurer', cookie: treasurerCookie },
    adminReset: { userId: 'e2e-admin-reset', totpSecret: adminTotpSecret, staleCookie: adminStaleCookie, staleCookie2: adminStaleCookie2, freshCookie: adminFreshCookie, targets: resetTargets },
    publishedEventTitle: 'Piknik szkolny (syntetyczny)',
    draftEventTitle: 'Szkic niezatwierdzony SEKRET E2E',
  };
  await mkdir(HERE, { recursive: true });
  await writeFile(RUNTIME_FILE, JSON.stringify(runtime, null, 2));

  const server = await startServer({
    host: '127.0.0.1',
    port: PORT,
    distRoot,
    env: {
      db,
      APP_ENV: 'test',
      MFA_ENCRYPTION_KEY: mfaKey,
      SCRYPT_COST_LOG2: FAST_SCRYPT.SCRYPT_COST_LOG2,
    },
    fetchHandler: handlePgRequest,
  });

  const shutdown = async () => {
    await new Promise((resolve) => server.close(resolve));
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log(`rd e2e server: nasłuchuje na http://127.0.0.1:${PORT} (dane syntetyczne, PGlite w pamięci)`);
}

main().catch((error) => {
  console.error('rd e2e server: błąd startu', error);
  process.exit(1);
});
