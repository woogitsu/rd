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
import * as news from '../../../src/pg/news.js';
import * as meetings from '../../../src/pg/meetings.js';
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
  if (role) await grantRole(db, userId, role);
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
const APPROVED_EVENT_TITLE = 'Zebranie otwarte do publikacji (syntetyczne)';

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

  // #136: wydarzenie zatwierdzone, ale nieopublikowane — test okna „Opublikować
  // wydarzenie?” na prawdziwej stronie events/ (confirm-dialog-pages.spec.js).
  // Publikuje je dopiero ten test (w bazie w pamięci), więc do tego czasu nie ma go
  // na stronie publicznej.
  const { event: approved } = await createDraft(db, board, {
    schoolYearId: 'e2e-y-2026',
    title: APPROVED_EVENT_TITLE,
    startsAt: '2026-12-10T17:00',
    endsAt: '2026-12-10T18:30',
    location: 'Sala gimnastyczna',
    organizer: 'Rada Rodziców',
    audience: 'public',
    idempotencyKey: 'e2e-event-approved-0001',
  });
  await submit(db, board, { eventId: approved.id, revision: 1 });
  await approve(db, boardReviewer, { eventId: approved.id, revision: 1 });

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

// #124: 20 opublikowanych aktualności (lista publiczna ma limit 20) z długimi
// tytułami — w tym jeden bez spacji i jeden z próbą wstrzyknięcia HTML — do
// testu strony publicznej przy 320 px (public-site-a11y.spec.js). Plus jeden
// szkic, który nie może się pojawić publicznie. Bez zdjęć (#96, D-18).
const NEWS_LONG_WORD = 'Sprawozdanie'.repeat(12);
const NEWS_INJECTION_TITLE = 'Wpis <img src=x onerror="window.__xss=1"> (syntetyczny)';
async function seedNews(db) {
  const author = { userId: 'e2e-board-events', grants: [{ role: 'board', classId: null, schoolYearId: null }], mfaVerified: true };
  const reviewer = { userId: 'e2e-board-reviewer', grants: [{ role: 'board', classId: null, schoolYearId: null }], mfaVerified: true };
  const titles = [];
  for (let i = 1; i <= 20; i += 1) {
    const title = i === 1 ? NEWS_LONG_WORD
      : i === 2 ? NEWS_INJECTION_TITLE
        : `Aktualność syntetyczna nr ${i}: podsumowanie spotkania Rady z bardzo długim tytułem, który musi się złamać na wąskim ekranie telefonu`;
    const { post } = await news.createDraft(db, author, {
      schoolYearId: 'e2e-y-2026',
      title,
      body: `Treść syntetyczna wpisu ${i}. ${'Długi akapit bez danych osobowych. '.repeat(4)}`,
      idempotencyKey: `e2e-news-${String(i).padStart(4, '0')}`,
    });
    await news.submit(db, author, { postId: post.id, revision: 1 });
    await news.approve(db, reviewer, { postId: post.id, revision: 1 });
    await news.publish(db, reviewer, { postId: post.id, revision: 1 });
    titles.push(title);
  }
  await news.createDraft(db, author, {
    schoolYearId: 'e2e-y-2026',
    title: 'Szkic aktualności SEKRET E2E',
    body: 'Treść szkicu, która nie może trafić na stronę publiczną.',
    idempotencyKey: 'e2e-news-draft-0001',
  });
  return titles;
}

// #124: dwa dokumenty zarządu w roku e2e (metadane w bazie, bez pliku w
// magazynie) — test powrotu fokusu po zamknięciu „Szczegóły” w documents/.
const E2E_DOCUMENTS = [
  { id: '00000000-0000-4000-8000-00000000e124', title: 'Protokół zebrania zarządu (syntetyczny)', category: 'protokol' },
  { id: '00000000-0000-4000-8000-00000000e125', title: 'Uchwała w sprawie budżetu (syntetyczna)', category: 'uchwala' },
];
async function seedDocuments(db) {
  for (const [index, doc] of E2E_DOCUMENTS.entries()) {
    await db.query(
      `INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by, school_year_id, sha256, idempotency_key, created_at)
       VALUES ($1, $2, 'application/pdf', 1024, 'board', 'e2e-board-events', 'e2e-y-2026', repeat('b', 64), $3, now() - ($4::int * interval '1 minute'))`,
      [doc.id, `docs/${doc.id}`, `e2e-document-${index + 1}`, index],
    );
    await db.query(
      `INSERT INTO document_descriptions (document_id, revision_no, title, category, created_by)
       VALUES ($1, 1, $2, $3, 'e2e-board-events')`,
      [doc.id, doc.title, doc.category],
    );
  }
}

// Wydruk zestawień (#151): osobny rok i osobny skarbnik, żeby 300 wpłat i 300
// wpisów księgi nie zmieniało list widzianych przez inne testy. Część wpłat ma
// korektę częściową (kolumny „Korekty” i „Netto” na wydruku). Dane syntetyczne.
const PRINT_YEAR_ID = 'e2e-y-print';
const PRINT_ROWS = 300;
async function seedPrintLists(db, userId) {
  await db.query(
    `INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by)
     VALUES ('e2e-cat-print', $1, 'income', 'Składki dobrowolne (e2e)', $2)`,
    [PRINT_YEAR_ID, userId],
  );
  await db.query(
    `INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, reference, status, created_by, idempotency_key)
     SELECT 'e2e-print-p-' || lpad(n::text, 3, '0'), NULL, $1, 123456 + n, DATE '2025-09-01' + (n % 300),
            'bank', 'Wpłata syntetyczna ' || lpad(n::text, 3, '0'), 'unmatched', $2, 'e2e-print-p-key-' || n
       FROM generate_series(1, ${PRINT_ROWS}) AS n`,
    [PRINT_YEAR_ID, userId],
  );
  await db.query(
    `INSERT INTO payment_corrections (id, payment_entry_id, amount_cents, reason, created_by, idempotency_key)
     SELECT 'e2e-print-c-' || n, 'e2e-print-p-' || lpad(n::text, 3, '0'), 1000, 'Korekta syntetyczna (zwrot części)', $1, 'e2e-print-c-key-' || n
       FROM generate_series(1, ${PRINT_ROWS}, 50) AS n`,
    [userId],
  );
  await db.query(
    `INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on, method, created_by, idempotency_key)
     SELECT 'e2e-print-l-' || lpad(n::text, 3, '0'), $1, 'income', 123456 + n, 'e2e-cat-print',
            'Wpis syntetyczny ' || lpad(n::text, 3, '0'), DATE '2025-09-01' + (n % 300), 'bank', $2, 'e2e-print-l-key-' || n
       FROM generate_series(1, ${PRINT_ROWS}) AS n`,
    [PRINT_YEAR_ID, userId],
  );
}

// Wydruk protokołu (#151): zebranie zarządu z listą obecności i projektem
// protokołu (niezatwierdzony → znak „PROJEKT”). Jedna bardzo długa linia
// sprawdza zawijanie tekstu na A4. Treść bez danych osobowych.
const PRINT_MEETING_TITLE = 'Zebranie zarządu (syntetyczne, wydruk)';
async function seedPrintMeeting(db, userId) {
  const actor = { userId, grants: [{ role: 'board', classId: null, schoolYearId: 'e2e-y-2026' }], mfaVerified: true };
  const { meeting } = await meetings.createMeeting(db, actor, {
    idempotencyKey: 'e2e-print-meeting-1', schoolYearId: 'e2e-y-2026', kind: 'board', status: 'scheduled',
    title: PRINT_MEETING_TITLE, scheduledAt: '2026-09-15T16:00:00Z', location: 'Sala syntetyczna',
    quorumMode: 'minimum_count', quorumMinCount: 1, votingBodySize: 2, quorumRuleSource: 'Regulamin syntetyczny § 1',
  });
  await meetings.updateMeeting(db, actor, { meetingId: meeting.id, revision: meeting.revisionNo, status: 'held' });
  for (const [attendeeId, present] of [[userId, true], ['e2e-board-reviewer', false]]) {
    await meetings.recordAttendance(db, actor, { meetingId: meeting.id, userId: attendeeId, capacity: 'board_member', votingEligible: true, present });
  }
  await meetings.determineQuorum(db, actor, { idempotencyKey: 'e2e-print-quorum-1', meetingId: meeting.id });
  await meetings.createMinutesVersion(db, actor, {
    idempotencyKey: 'e2e-print-minutes-1', meetingId: meeting.id,
    body: ['1. Otwarcie zebrania i przyjęcie porządku obrad.', `2. ${'Sprawozdanie '.repeat(40).trim()}.`, '3. Zamknięcie zebrania.'].join('\n'),
  });
  return meeting.id;
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
  const newsTitles = await seedNews(db);
  await seedDocuments(db);

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

  // 3b. Skarbnik wydruków (#151): przydział wyłącznie na rok e2e-y-print.
  await seedUser(db, 'e2e-treasurer-print');
  await seedSchoolYear(db, PRINT_YEAR_ID, { startsOn: '2025-09-01', endsOn: '2026-08-31' });
  await grantRole(db, 'e2e-treasurer-print', 'treasurer', { schoolYearId: PRINT_YEAR_ID });
  await seedPrintLists(db, 'e2e-treasurer-print');
  const treasurerPrintCookie = await seedCookieSession(db, { userId: 'e2e-treasurer-print', mfa: true });

  // 3a. Członek zarządu z przydziałem na rok e2e (#124: panel dokumentów) — sesja przez cookie.
  await seedUser(db, 'e2e-board-docs');
  await grantRole(db, 'e2e-board-docs', 'board', { schoolYearId: 'e2e-y-2026' });
  const boardDocsCookie = await seedCookieSession(db, { userId: 'e2e-board-docs', mfa: true });
  const printMeetingId = await seedPrintMeeting(db, 'e2e-board-docs');

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
  // a i b: konta BEZ roli chronionej (reset od razu); c: rola „board” — chroniona
  // (#146), więc reset hasła i MFA kończy się wnioskiem (202) do zatwierdzenia
  // przez drugiego administratora, bez tokenu i bez zmiany czynnika.
  for (const [id, role] of [['e2e-reset-a', null], ['e2e-reset-b', null], ['e2e-reset-c', 'board']]) {
    const password = `Syntetyczne haslo ${id} ${randomBytes(6).toString('hex')}`;
    await seedPasswordAccount(db, { userId: id, role, password });
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
    treasurerPrint: { userId: 'e2e-treasurer-print', cookie: treasurerPrintCookie, schoolYearId: PRINT_YEAR_ID, rows: PRINT_ROWS },
    adminReset: { userId: 'e2e-admin-reset', totpSecret: adminTotpSecret, staleCookie: adminStaleCookie, staleCookie2: adminStaleCookie2, freshCookie: adminFreshCookie, targets: resetTargets },
    publishedEventTitle: 'Piknik szkolny (syntetyczny)',
    draftEventTitle: 'Szkic niezatwierdzony SEKRET E2E',
    approvedEventTitle: APPROVED_EVENT_TITLE,
    boardDocs: { userId: 'e2e-board-docs', cookie: boardDocsCookie },
    printMeeting: { id: printMeetingId, title: PRINT_MEETING_TITLE },
    documents: E2E_DOCUMENTS,
    newsTitles,
    newsLongWord: NEWS_LONG_WORD,
    newsInjectionTitle: NEWS_INJECTION_TITLE,
    draftNewsTitle: 'Szkic aktualności SEKRET E2E',
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
