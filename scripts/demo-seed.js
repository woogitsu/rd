// Dane DEMO do pokazu dla zarządu — WYŁĄCZNIE lokalnie, WYŁĄCZNIE dane syntetyczne.
//
// To jest OSOBNY seed od `scripts/lib/synthetic-seed.js` (ten pozostaje bez zmian,
// bo służy testom wolumenu/wydajności). Ten skrypt buduje mały, czytelny zestaw do
// pokazu: kilka klas, ok. 20 rodzin (z rodzeństwem i dwojgiem opiekunów), wpłaty
// częściowe i pełne, wpisy księgi, zapowiedzi wydarzeń, jedno zebranie z protokołem
// zatwierdzonym do publikacji, jeden SZKIC kampanii e-mail (nigdy nie wysyłany) oraz
// konta ról demo z hasłami wypisywanymi tylko na konsoli.
//
//   npm run demo:seed     — tworzy/nadpisuje bazę demo (domyślnie PGlite w .demo-data/)
//   npm run demo:start    — uruchamia serwer Node na tej samej bazie
//
// Bezpieczeństwo (patrz assertSafeEnvironment): skrypt ODMAWIA działania, gdy
// DATABASE_URL wskazuje poza localhost/PGlite, gdy NODE_ENV/APP_ENV to produkcja,
// albo gdy ustawiony jest BREVO_API_KEY — żadne demo nie może wysłać e-maila ani
// dotknąć bazy szkoły. Email worker (scripts/email-worker.js) NIE jest uruchamiany.
//
// Tam, gdzie istnieje API/funkcja domenowa (konta, MFA, wpłaty, księga, wydarzenia,
// zebrania, e-mail), skrypt korzysta z niej (przez handlePgRequest, tak jak prawdziwy
// panel), więc dane przechodzą te same walidacje i zostawiają ten sam dziennik zdarzeń.
// Bezpośredni SQL jest użyty tylko tam, gdzie nie ma API zbiorczego zapisu: roster
// rodzin/uczniów/opiekunów (families/ jest dziś tylko do odczytu poza importem CSV)
// i kategorie księgi (GET /api/ledger/categories nie ma odpowiednika POST) — oba
// miejsca są oznaczone komentarzem „SQL — brak API” poniżej.

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations, applyMigrations } from '../src/postgres-migrations.js';
import { pgliteClient } from './smoke-postgres.js';
import { createPgDatabase } from '../src/db.js';
import { isProductionEnv } from '../src/app-env.js';
import { bootstrapAdmin } from '../src/pg/bootstrap-admin.js';
import { handlePgRequest } from '../src/pg/app.js';
import { base32Decode, totp } from '../src/pg/mfa.js';
import { pad } from './lib/synthetic-seed.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..');
export const DEMO_DATA_DIR = join(REPO_ROOT, '.demo-data');
export const DEMO_PGLITE_DIR = join(DEMO_DATA_DIR, 'pgdata');
export const DEMO_MFA_KEY_FILE = join(DEMO_DATA_DIR, 'mfa-encryption-key.local');

export const DEMO_ORIGIN = 'http://localhost:3000';
// UWAGA: /site/ (publiczna strona) nie ma API do wylistowania lat szkolnych —
// site/core.js#defaultSchoolYearId ZAKŁADA, że identyfikator roku ma postać
// „<rok>-<rok+1>” i liczy go z dzisiejszej daty (wrzesień = początek roku).
// Jeśli SCHOOL_YEAR_ID tu nie pasuje do tego wzorca, /site/ pyta serwer o inny
// rok niż ten, do którego seed wpisał zebranie/wydarzenia/protokół — publiczna
// strona wygląda pusto („Brak opublikowanych protokołów”), mimo że dane
// istnieją. Dlatego identyfikator jest w tym samym formacie (nie np. „y2026”);
// zob. też druga asercja w tests/demo-seed.test.js (GET
// /api/meetings/public-minutes zwraca ≥1 protokół) i wypisywany na konsoli
// link z jawnym „?rok=”, gdyby demo działo się poza wrześniem bieżącego roku.
export const SCHOOL_YEAR_ID = '2026-2027';
export const SCHOOL_YEAR_LABEL = '2026/2027';
export const HOUSEHOLD_COUNT = 20;
export const CLASS_NAMES = ['0-A', 'I-A', 'II-A', 'III-A', 'IV-A'];

export class DemoSeedRefused extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'DemoSeedRefused';
  }
}

// #166: demo działa zawsze lokalnie na PGlite i danych syntetycznych, więc brak
// APP_ENV oznacza 'development' (bez ręcznego ustawiania zmiennych; import w demie
// nie wymaga IMPORT_ENABLED). Jawnie ustawiona produkcja jest odrzucana wcześniej
// przez assertSafeEnvironment; nieznana wartość zostaje bez zmian (zachowawczo).
export function demoAppEnv(env = process.env) {
  return env.APP_ENV || 'development';
}

// --- Bezpieczeństwo -----------------------------------------------------------
// AGENTS.md/brief: to demo NIE może dotknąć produkcji, zdalnej bazy ani wysłać
// żadnej wiadomości. Sprawdzane PRZED otwarciem jakiejkolwiek bazy.
export function assertSafeEnvironment(env = process.env) {
  const nodeEnv = String(env.NODE_ENV ?? '').trim().toLowerCase();
  if (nodeEnv === 'production' || isProductionEnv(env.APP_ENV)) {
    throw new DemoSeedRefused(
      'production_env',
      'Seed demo odmówiony: NODE_ENV lub APP_ENV wskazuje na środowisko produkcyjne. '
      + 'To demo jest wyłącznie lokalne — nic nie zostało zmienione.',
    );
  }
  if (env.BREVO_API_KEY) {
    throw new DemoSeedRefused(
      'brevo_key_present',
      'Seed demo odmówiony: BREVO_API_KEY jest ustawiony w środowisku. Żadne zadanie '
      + 'demo/testowe nie może mieć możliwości wysyłki do prawdziwego rodzica — usuń zmienną '
      + 'i uruchom ponownie. Nic nie zostało zmienione.',
    );
  }
  if (env.DATABASE_URL) {
    let host;
    try {
      host = new URL(env.DATABASE_URL).hostname;
    } catch {
      throw new DemoSeedRefused('invalid_database_url', 'Seed demo odmówiony: DATABASE_URL nie jest poprawnym adresem. Nic nie zostało zmienione.');
    }
    const allowedHosts = new Set(['localhost', '127.0.0.1', '::1']);
    if (!allowedHosts.has(host)) {
      throw new DemoSeedRefused(
        'remote_database_url',
        `Seed demo odmówiony: DATABASE_URL wskazuje na host „${host}”, nie na localhost/PGlite. `
        + 'To demo wolno uruchamiać wyłącznie lokalnie. Nic nie zostało zmienione.',
      );
    }
  }
}

// --- Baza ----------------------------------------------------------------------

async function applyDemoMigrations(migrationClient) {
  const migrationsDir = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));
  const migrations = await loadMigrations(migrationsDir);
  return applyMigrations(migrationClient, migrations);
}

// Otwiera bazę demo: domyślnie PGlite trwałe na dysku (.demo-data/pgdata), żeby
// `npm run demo:seed` i `npm run demo:start` widziały te same dane w dwóch osobnych
// procesach; `{ inMemory: true }` (używane w tests/demo-seed.test.js) trzyma
// wszystko w pamięci. Z DATABASE_URL (już zweryfikowanym przez assertSafeEnvironment)
// migracje idą przez pojedyncze połączenie pg.Client (BEGIN/COMMIT wymaga jednej
// sesji — tak samo jak scripts/migrate-postgres.js), a env.db do zapisu danych to
// osobna pula z src/db.js, ten sam kontrakt co środowisko produkcyjne.
export async function openDemoDatabase({ databaseUrl = process.env.DATABASE_URL, dataDir = DEMO_PGLITE_DIR, inMemory = false, fresh = true } = {}) {
  if (databaseUrl) {
    const migrationClient = new Client({ connectionString: databaseUrl });
    await migrationClient.connect();
    try {
      await applyDemoMigrations(migrationClient);
    } finally {
      await migrationClient.end().catch(() => {});
    }
    const db = createPgDatabase({ connectionString: databaseUrl, max: 5 });
    return { db, mode: 'postgres', close: () => db.close() };
  }
  if (!inMemory && fresh) {
    await mkdir(DEMO_DATA_DIR, { recursive: true });
    await rm(dataDir, { recursive: true, force: true });
  }
  const pglite = new PGlite(inMemory ? undefined : dataDir);
  await applyDemoMigrations(pgliteClient(pglite));
  return { db: pglite, mode: 'pglite', close: () => pglite.close() };
}

// --- Wywołania API (tak jak prawdziwy panel — przez handlePgRequest) ----------

function extractCookie(response) {
  const setCookie = response.headers.get('Set-Cookie');
  return setCookie ? setCookie.split(';', 1)[0] : null;
}

// Wyeksportowane dla testów (tests/demo-seed.test.js), żeby sprawdzić publiczny
// endpoint po seedzie tym samym mechanizmem, którego seed sam używa.
export async function apiCall(env, { method = 'GET', path, cookie, body, idempotencyKey } = {}) {
  const headers = new Headers();
  if (cookie) headers.set('Cookie', cookie);
  if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers.set('Content-Type', 'application/json');
  }
  if (method !== 'GET' && method !== 'HEAD') headers.set('Origin', DEMO_ORIGIN);
  const request = new Request(new URL(path, DEMO_ORIGIN), { method, headers, body: payload });
  const response = await handlePgRequest(request, env);
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (response.status >= 400) {
    throw new Error(`Seed demo: ${method} ${path} -> ${response.status} ${JSON.stringify(data)}`);
  }
  return { status: response.status, data, cookie: extractCookie(response) };
}

function idKey(prefix) {
  return `${prefix}-${randomUUID()}`;
}

function demoPassword() {
  // 12–128 znaków (polityka haseł, docs/AUTH.md); losowe, tylko do lokalnego demo.
  return `Demo-${randomBytes(9).toString('base64url')}`;
}

// Konto pierwszego administratora (bootstrapAdmin — funkcja domenowa, ta sama co
// `npm run auth:bootstrap-admin`), potem zaproszenia administratora dla reszty ról
// (POST /api/admin/invitations — ta sama trasa co panel /admin/), przyjęcie
// zaproszenia z hasłem (POST /api/invitations/accept) i — dla ról z obowiązkowym
// MFA (domyślnie admin/board/treasurer) — zapis i potwierdzenie czynnika TOTP
// (POST /api/mfa/enroll, /api/mfa/confirm). Konto powstaje więc dokładnie tak samo
// jak w prawdziwym /admin/ + /login/, tylko kod TOTP liczymy tu sami zamiast
// przepisywać go z aplikacji uwierzytelniającej.
async function createDemoAccount(env, { email, displayName, role, classId, schoolYearId, adminCookie, enrollMfa }) {
  const password = demoPassword();
  let token;
  if (!adminCookie) {
    const bootstrap = await bootstrapAdmin(env.db, { email, appEnv: 'development' /* produkcję odrzucono wyżej */, ttlSeconds: 3600 });
    token = bootstrap.secret;
  } else {
    const invitation = await apiCall(env, {
      method: 'POST',
      path: '/api/admin/invitations',
      cookie: adminCookie,
      body: { email, role, classId: classId ?? null, schoolYearId: schoolYearId ?? null },
    });
    token = invitation.data.token;
  }
  const accepted = await apiCall(env, {
    method: 'POST',
    path: '/api/invitations/accept',
    body: { token, password, passwordRepeat: password, displayName },
  });
  let cookie = accepted.cookie;
  let mfaSecret = null;
  if (enrollMfa) {
    const enrolled = await apiCall(env, { method: 'POST', path: '/api/mfa/enroll', cookie });
    mfaSecret = enrolled.data.secret;
    const code = totp(base32Decode(mfaSecret), Date.now());
    const confirmed = await apiCall(env, { method: 'POST', path: '/api/mfa/confirm', cookie, body: { code } });
    cookie = confirmed.cookie ?? cookie;
  }
  // POST /api/invitations/accept nie zwraca userId (celowo — patrz src/pg/routes/login.js);
  // GET /api/session, tak jak ekran logowania, zna go z bieżącej sesji.
  const state = await apiCall(env, { method: 'GET', path: '/api/session', cookie });
  return { email, displayName, role, classId, schoolYearId, password, mfaSecret, cookie, userId: state.data.user.id };
}

// --- Roster rodzin (SQL — brak API zbiorczego zapisu poza importem CSV) --------
//
// families/ jest dziś wyłącznie do odczytu (README: „Chroniony katalog rodzin…
// odczyt zakresu zależnego od roli”); jedyna droga zapisu to import CSV/XLSX
// (src/pg/routes/import.js), zbyt ciężka dla 20 syntetycznych rodzin w skrypcie
// demo. Wstawiamy więc bezpośrednio przez SQL, tak jak testy (tests/helpers/pg.js)
// i scripts/lib/synthetic-seed.js — ten sam kształt tabel, dane wyłącznie syntetyczne
// (@example.invalid, nazwiska jawnie fikcyjne „Przykładowy/-a”).
function buildDemoRoster() {
  const classes = CLASS_NAMES.map((name, i) => [`c${pad(i + 1)}`, SCHOOL_YEAR_ID, `Klasa ${name} (dane przykładowe)`]);
  const households = [];
  const students = [];
  const enrollments = [];
  const guardians = [];
  const links = [];
  for (let h = 1; h <= HOUSEHOLD_COUNT; h += 1) {
    const hid = `h${pad(h)}`;
    households.push([hid]);
    // Pierwsze 5 rodzin: rodzeństwo (dwoje dzieci w różnych klasach).
    const childCount = h <= 5 ? 2 : 1;
    const studentIds = [];
    for (let c = 1; c <= childCount; c += 1) {
      const sid = `s${pad(h)}${c}`;
      students.push([sid, hid, `Uczeń ${c}`, `Przykładowy ${pad(h)}`]);
      const classId = classes[(h + c - 1) % classes.length][0];
      enrollments.push([`e${pad(h)}${c}`, sid, classId, SCHOOL_YEAR_ID]);
      studentIds.push(sid);
    }
    // Co czwarta rodzina ma jednego opiekuna wpisanego do systemu; reszta — dwoje
    // (scenariusz „dwie osoby opiekujące się jednym dzieckiem” z AGENTS.md).
    const guardianCount = h % 4 === 0 ? 1 : 2;
    const guardianIds = [];
    for (let g = 1; g <= guardianCount; g += 1) {
      const gid = `g${pad(h)}${g}`;
      guardians.push([gid, hid, g === 1 ? 'Opiekun A' : 'Opiekun B', `Przykładowy ${pad(h)}`,
        `rodzina${pad(h)}-opiekun${g}@example.invalid`, true]);
      guardianIds.push(gid);
    }
    for (const sid of studentIds) {
      guardianIds.forEach((gid, index) => {
        links.push([sid, gid, true, index === 0]);
      });
    }
  }
  return { classes, households, students, enrollments, guardians, links };
}

async function insertRows(db, table, columns, rows, chunkSize = 200) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values = [];
    const placeholders = chunk.map((row, rowIndex) => {
      const base = rowIndex * columns.length;
      values.push(...row);
      return `(${columns.map((_, colIndex) => `$${base + colIndex + 1}`).join(',')})`;
    }).join(',');
    await db.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders}`, values);
  }
}

async function seedRoster(db) {
  await db.query(
    `INSERT INTO school_years (id, label, starts_on, ends_on) VALUES ($1,$2,$3,$4)`,
    [SCHOOL_YEAR_ID, SCHOOL_YEAR_LABEL, '2026-09-01', '2027-08-31'],
  );
  const roster = buildDemoRoster();
  await insertRows(db, 'classes', ['id', 'school_year_id', 'name'], roster.classes);
  await insertRows(db, 'households', ['id'], roster.households);
  await insertRows(db, 'students', ['id', 'household_id', 'first_name', 'last_name'], roster.students);
  await insertRows(db, 'enrollments', ['id', 'student_id', 'class_id', 'school_year_id'], roster.enrollments);
  await insertRows(db, 'guardians', ['id', 'household_id', 'first_name', 'last_name', 'email', 'contact_allowed'], roster.guardians);
  await insertRows(db, 'student_guardians', ['student_id', 'guardian_id', 'contact_allowed', 'is_primary_contact'], roster.links);
  return roster;
}

// --- Wpłaty (POST /api/payments — panel /panel/) --------------------------------
// Częściowe i pełne, bez żadnego automatycznego statusu „dłużnik” (AGENTS.md:
// składki są dobrowolne) — po prostu część rodzin ma wpłatę, część nie.
async function seedPayments(env, cookie, roster) {
  const paid = roster.households.slice(0, 12);
  let created = 0;
  for (let i = 0; i < paid.length; i += 1) {
    const [householdId] = paid[i];
    if (i % 3 === 0) {
      // Wpłata częściowa w dwóch ratach.
      await apiCall(env, {
        method: 'POST', path: '/api/payments', cookie, idempotencyKey: idKey('demo-payment'),
        body: { schoolYearId: SCHOOL_YEAR_ID, householdId, amountCents: 3000, receivedOn: '2026-10-05', method: 'bank', reference: `DEMO-${householdId}-1` },
      });
      await apiCall(env, {
        method: 'POST', path: '/api/payments', cookie, idempotencyKey: idKey('demo-payment'),
        body: { schoolYearId: SCHOOL_YEAR_ID, householdId, amountCents: 2000, receivedOn: '2026-12-01', method: 'bank', reference: `DEMO-${householdId}-2` },
      });
      created += 2;
    } else {
      // Wpłata pełna, jednorazowa.
      await apiCall(env, {
        method: 'POST', path: '/api/payments', cookie, idempotencyKey: idKey('demo-payment'),
        body: { schoolYearId: SCHOOL_YEAR_ID, householdId, amountCents: 5000, receivedOn: '2026-10-15', method: i % 2 === 0 ? 'bank' : 'cash', reference: `DEMO-${householdId}` },
      });
      created += 1;
    }
  }
  return created;
}

// --- Uzgodnienie wyciągu bankowego (POST /api/reconciliations + .../lines) -----
// Tylko SZKIC — bez POST .../confirm (żadne zadanie/seed testowy nie potwierdza
// uzgodnienia w cudzym imieniu, AGENTS.md). Wyciąg importowany jako CSV przez
// ISTNIEJĄCĄ trasę importu (src/pg/routes/reconciliation.js#parseStatementCsv,
// nagłówki PL/EN — patrz HEADER_ALIASES), tak jak w prawdziwym panelu
// /reconciliation/. IBAN w treści notatek to publicznie znany testowy numer
// (Stripe, dokumentacja testowa) — nie należy do żadnego prawdziwego rachunku.
// Kwoty większości pozycji odpowiadają wpłatom z seedPayments (ten sam
// harmonogram: częściowe raty h01/h04/h07/h10 i pełne wpłaty „bank” h03/h05/
// h09/h11) oraz dwóm wpisom księgi (składki, darowizna, opłata bankowa) — dzięki
// temu panel może zaproponować dopasowania tak jak przy prawdziwych danych.
// Dwie pozycje (2026-11-18, 2026-11-25) celowo NIE odpowiadają żadnej wpłacie
// ani wpisowi księgi — do pokazu stanu „niedopasowana” / „do wyjaśnienia”.
const DEMO_TEST_IBAN = 'BE62 5100 0754 7061'; // testowy IBAN z dokumentacji Stripe — nie jest prawdziwym rachunkiem
async function seedReconciliation(env, treasurerCookie) {
  const created = await apiCall(env, {
    method: 'POST', path: '/api/reconciliations', cookie: treasurerCookie, idempotencyKey: idKey('demo-reconciliation'),
    body: {
      schoolYearId: SCHOOL_YEAR_ID,
      statementDate: '2026-12-05',
      statementBalanceCents: 274975,
      notes: `Wyciąg testowy dla rachunku ${DEMO_TEST_IBAN} (IBAN testowy, dane syntetyczne — do pokazu importu i dopasowań). Szkic, nie zatwierdzony.`,
    },
  });
  const reconciliationId = created.data.reconciliation.id;
  const csv = [
    'data,kwota,tytuł',
    '2026-10-05,30.00,DEMO wpłata h01 rata 1',
    '2026-10-15,50.00,DEMO wpłata h03',
    '2026-10-31,450.00,Zestawienie wpłat składek — październik (dane przykładowe)',
    '2026-11-10,200.00,Darowizna na cele statutowe Rady (dane przykładowe)',
    '2026-11-18,15.50,Wpłata nieznanego nadawcy — do wyjaśnienia (dane przykładowe)',
    '2026-11-25,-3.75,Opłata SWIFT — do wyjaśnienia (dane przykładowe)',
    '2026-12-01,20.00,DEMO wpłata h10 rata 2',
    '2026-12-01,-12.00,Opłata za prowadzenie rachunku Rady (dane przykładowe)',
  ].join('\n');
  const imported = await apiCall(env, {
    method: 'POST', path: `/api/reconciliations/${reconciliationId}/lines`, cookie: treasurerCookie,
    idempotencyKey: idKey('demo-reconciliation-lines'), body: { csv },
  });
  return { reconciliationId, lineCount: imported.data.import.lineCount };
}

// --- Księga (kategorie: SQL — brak API POST; wpisy: POST /api/ledger) ----------
async function seedLedger(env, cookie, actorUserId) {
  // SQL — brak API: GET /api/ledger/categories istnieje, ale nie ma odpowiednika
  // POST (docs/NODE_SERVER.md, src/pg/routes/ledger.js). Tak samo robią testy
  // (tests/pg-authz-matrix.test.js).
  // Identyfikatory kategorii muszą być ASCII (walidacja validId w src/pg/routes/ledger.js);
  // polskie nazwy są w kolumnie `name`, bez tego ograniczenia.
  const categories = [
    ['cat-income-skladki', SCHOOL_YEAR_ID, 'income', 'Składki dobrowolne', actorUserId],
    ['cat-income-darowizny', SCHOOL_YEAR_ID, 'income', 'Darowizny', actorUserId],
    ['cat-expense-materialy', SCHOOL_YEAR_ID, 'expense', 'Materiały i pomoce', actorUserId],
    ['cat-expense-wydarzenia', SCHOOL_YEAR_ID, 'expense', 'Wydarzenia szkolne', actorUserId],
    ['cat-expense-oplaty', SCHOOL_YEAR_ID, 'expense', 'Opłaty bankowe', actorUserId],
  ];
  await insertRows(env.db, 'ledger_categories', ['id', 'school_year_id', 'direction', 'name', 'created_by'], categories);

  const entries = [
    { direction: 'income', categoryId: 'cat-income-skladki', amountCents: 45000, description: 'Wpłaty składek — zestawienie za październik (dane przykładowe)', occurredOn: '2026-10-31', method: 'bank' },
    { direction: 'income', categoryId: 'cat-income-darowizny', amountCents: 20000, description: 'Darowizna na cele statutowe Rady (dane przykładowe)', occurredOn: '2026-11-10', method: 'bank' },
    { direction: 'expense', categoryId: 'cat-expense-materialy', amountCents: 15000, description: 'Materiały plastyczne na zajęcia dodatkowe (dane przykładowe)', occurredOn: '2026-11-05', method: 'card' },
    { direction: 'expense', categoryId: 'cat-expense-wydarzenia', amountCents: 25000, description: 'Poczęstunek na spotkanie andrzejkowe (dane przykładowe)', occurredOn: '2026-11-25', method: 'cash' },
    { direction: 'expense', categoryId: 'cat-expense-oplaty', amountCents: 1200, description: 'Opłata za prowadzenie rachunku Rady (dane przykładowe)', occurredOn: '2026-12-01', method: 'bank' },
  ];
  for (const entry of entries) {
    await apiCall(env, {
      method: 'POST', path: '/api/ledger', cookie, idempotencyKey: idKey('demo-ledger'),
      body: { schoolYearId: SCHOOL_YEAR_ID, ...entry },
    });
  }
  return entries.length;
}

// --- Wydarzenia: zapowiedzi z datą/miejscem/opisem organizacyjnym, NIE sprawozdania
async function seedEvents(env, authorCookie, approverCookie) {
  const drafts = [
    {
      title: 'Zebranie ogólne rodziców (zapowiedź) — dane przykładowe',
      description: 'Zapowiedź organizacyjna: termin i miejsce zebrania ogólnego Rady Rodziców na rok 2026/2027. To dane przykładowe do pokazu, nie zapis rzeczywistego wydarzenia.',
      location: 'Sala gimnastyczna, Szkoła Polska im. J. Lelewela w Brukseli',
      startsAt: '2026-11-14T18:00',
      organizer: 'Rada Rodziców (dane przykładowe)',
    },
    {
      title: 'Kiermasz świąteczny (zapowiedź) — dane przykładowe',
      description: 'Zapowiedź organizacyjna kiermaszu przed przerwą świąteczną — termin i miejsce. Dane przykładowe do pokazu.',
      location: 'Hol główny szkoły',
      startsAt: '2026-12-12T16:00',
      organizer: 'Rada Rodziców (dane przykładowe)',
    },
  ];
  let published = 0;
  for (const draft of drafts) {
    const created = await apiCall(env, {
      method: 'POST', path: '/api/events', cookie: authorCookie, idempotencyKey: idKey('demo-event'),
      body: { schoolYearId: SCHOOL_YEAR_ID, ...draft, audience: 'public' },
    });
    const eventId = created.data.event.id;
    const revision = created.data.event.revision;
    await apiCall(env, { method: 'POST', path: `/api/events/${eventId}/submit`, cookie: authorCookie, body: { revision } });
    await apiCall(env, { method: 'POST', path: `/api/events/${eventId}/approve`, cookie: approverCookie, body: { revision } });
    await apiCall(env, { method: 'POST', path: `/api/events/${eventId}/publish`, cookie: approverCookie, body: { revision } });
    published += 1;
  }
  return published;
}

// --- Zebranie z protokołem zatwierdzonym do publikacji --------------------------
async function seedMeeting(env, hostCookie, hostUserId, approverCookie) {
  const created = await apiCall(env, {
    method: 'POST', path: '/api/meetings', cookie: hostCookie, idempotencyKey: idKey('demo-meeting'),
    body: {
      schoolYearId: SCHOOL_YEAR_ID, kind: 'board', title: 'Zebranie zarządu Rady — dane przykładowe',
      scheduledAt: '2026-11-20T18:30:00Z', location: 'Sala nauczycielska (dane przykładowe)', status: 'draft',
      quorumMode: 'minimum_count', quorumMinCount: 3, votingBodySize: 7,
      quorumRuleSource: 'Regulamin Rady Rodziców, §8 (dane przykładowe)',
    },
  });
  const meetingId = created.data.meeting.id;
  await apiCall(env, {
    method: 'PATCH', path: `/api/meetings/${meetingId}`, cookie: hostCookie, body: { status: 'scheduled' },
  });
  await apiCall(env, {
    method: 'PATCH', path: `/api/meetings/${meetingId}`, cookie: hostCookie, body: { status: 'held' },
  });
  await apiCall(env, {
    method: 'POST', path: `/api/meetings/${meetingId}/agenda-items`, cookie: hostCookie, idempotencyKey: idKey('demo-agenda'),
    body: { title: 'Podsumowanie wpłat i planu wydatków (dane przykładowe)', position: 1 },
  });
  await apiCall(env, {
    method: 'POST', path: `/api/meetings/${meetingId}/attendance`, cookie: hostCookie,
    body: { userId: hostUserId, capacity: 'board_member', votingEligible: true, present: true },
  });
  await apiCall(env, {
    method: 'POST', path: `/api/meetings/${meetingId}/quorum-checks`, cookie: hostCookie, idempotencyKey: idKey('demo-quorum'),
    body: {},
  });
  const minutes = await apiCall(env, {
    method: 'POST', path: `/api/meetings/${meetingId}/minutes`, cookie: hostCookie, idempotencyKey: idKey('demo-minutes'),
    body: { body: 'Protokół zebrania zarządu — dane przykładowe. Omówiono bieżące wpłaty i plan wydatków na rok szkolny 2026/2027. Bez uchwał na tym zebraniu.' },
  });
  const minutesId = minutes.data.minutes.id;
  // Zasada czterech oczu: zatwierdzający musi różnić się od autora wersji —
  // dlatego zatwierdza inne konto (drugi członek zarządu) niż to, które prowadziło zebranie.
  await apiCall(env, {
    method: 'POST', path: `/api/meetings/${meetingId}/minutes/${minutesId}/approval`, cookie: approverCookie,
    body: { approvalNote: 'Zatwierdzono do pokazu — dane przykładowe.' },
  });
  await apiCall(env, {
    method: 'POST', path: `/api/meetings/${meetingId}/minutes/${minutesId}/visibility`, cookie: approverCookie,
    idempotencyKey: idKey('demo-visibility'), body: { visibility: 'public' },
  });
  return { meetingId, minutesId };
}

// --- Kampania e-mail: TYLKO szkic, nigdy nie zatwierdzana ani kolejkowana -------
async function seedEmailDraft(env, cookie) {
  const created = await apiCall(env, {
    method: 'POST', path: '/api/email/campaigns', cookie, idempotencyKey: idKey('demo-campaign'),
    body: {
      schoolYearId: SCHOOL_YEAR_ID, title: 'Przypomnienie o składce — SZKIC demo', audience: 'all_households',
      subject: '[DANE PRZYKŁADOWE] Przypomnienie o dobrowolnej składce',
      bodyText: 'To jest wyłącznie SZKIC do pokazu (dane przykładowe). Wiadomość nie została i nie zostanie wysłana z tego demo — brak klucza Brevo, worker e-mail nie jest uruchamiany.',
    },
  });
  return created.data.campaign.id;
}

// --- Aktualności: neutralne ogłoszenia, bez zdjęć, bez relacji z wydarzeń -------
async function seedNews(env, authorCookie, approverCookie) {
  const created = await apiCall(env, {
    method: 'POST', path: '/api/news', cookie: authorCookie, idempotencyKey: idKey('demo-news'),
    body: {
      schoolYearId: SCHOOL_YEAR_ID,
      title: '[DANE PRZYKŁADOWE] Rada Rodziców rozpoczyna rok szkolny 2026/2027',
      body: 'Neutralne ogłoszenie organizacyjne do pokazu (dane przykładowe): Rada Rodziców zaprasza na najbliższe zebranie ogólne — szczegóły w zakładce „Wydarzenia”.',
    },
  });
  const postId = created.data.post.id;
  const revision = created.data.post.revision;
  await apiCall(env, { method: 'POST', path: `/api/news/${postId}/submit`, cookie: authorCookie, body: { revision } });
  await apiCall(env, { method: 'POST', path: `/api/news/${postId}/approve`, cookie: approverCookie, body: { revision } });
  await apiCall(env, { method: 'POST', path: `/api/news/${postId}/publish`, cookie: approverCookie, body: { revision } });
  return postId;
}

// --- Punkt wejścia ----------------------------------------------------------------

export async function runDemoSeed({
  env: processEnv = process.env, databaseUrl, inMemory = false, log = console.log,
  // Testy (tests/demo-seed.test.js) ustawiają `keepOpen: true`, żeby po seedzie
  // odpytać jeszcze GET /api/meetings/public-minutes na tej samej bazie — wtedy
  // WYWOŁUJĄCY odpowiada za zamknięcie zwróconego `env.db` (patrz `result.env`).
  keepOpen = false,
} = {}) {
  assertSafeEnvironment(processEnv);
  const { db, mode, close } = await openDemoDatabase({ databaseUrl: databaseUrl ?? processEnv.DATABASE_URL, inMemory });
  const mfaEncryptionKey = randomBytes(32).toString('hex');
  const env = {
    db,
    MFA_ENCRYPTION_KEY: mfaEncryptionKey,
    APP_ENV: demoAppEnv(processEnv),
    // Origin sprawdzany przez handlePgRequest — apiCall() zawsze wysyła DEMO_ORIGIN.
  };
  try {
    log(`Seed demo: baza w trybie „${mode}”.`);
    const roster = await seedRoster(db);
    log(`Roster: ${roster.classes.length} klas, ${roster.households.length} rodzin, ${roster.students.length} uczniów, ${roster.guardians.length} opiekunów.`);

    const admin = await createDemoAccount(env, {
      email: 'admin@example.invalid', displayName: 'Administrator (demo)', role: 'admin', enrollMfa: true,
    });
    const board1 = await createDemoAccount(env, {
      email: 'zarzad1@example.invalid', displayName: 'Zarząd — prezes (demo)', role: 'board',
      schoolYearId: SCHOOL_YEAR_ID, adminCookie: admin.cookie, enrollMfa: true,
    });
    const board2 = await createDemoAccount(env, {
      email: 'zarzad2@example.invalid', displayName: 'Zarząd — sekretarz (demo)', role: 'board',
      schoolYearId: SCHOOL_YEAR_ID, adminCookie: admin.cookie, enrollMfa: true,
    });
    const treasurer = await createDemoAccount(env, {
      email: 'skarbnik@example.invalid', displayName: 'Skarbnik (demo)', role: 'treasurer',
      schoolYearId: SCHOOL_YEAR_ID, adminCookie: admin.cookie, enrollMfa: true,
    });
    const representative = await createDemoAccount(env, {
      email: 'przedstawiciel@example.invalid', displayName: 'Przedstawiciel klasy 0-A (demo)', role: 'representative',
      classId: roster.classes[0][0], adminCookie: admin.cookie, enrollMfa: false,
    });
    const audit = await createDemoAccount(env, {
      email: 'komisja-rewizyjna@example.invalid', displayName: 'Komisja Rewizyjna (demo)', role: 'audit',
      schoolYearId: SCHOOL_YEAR_ID, adminCookie: admin.cookie, enrollMfa: false,
    });
    const accounts = [admin, board1, board2, treasurer, representative, audit];
    log(`Konta demo utworzone: ${accounts.map((a) => a.role).join(', ')}.`);

    const paymentsCreated = await seedPayments(env, treasurer.cookie, roster);
    log(`Wpłaty: ${paymentsCreated} wpisów (częściowe i pełne, bez statusu „dłużnik”).`);

    const ledgerCreated = await seedLedger(env, treasurer.cookie, treasurer.userId);
    log(`Księga: ${ledgerCreated} wpisów.`);

    const reconciliation = await seedReconciliation(env, treasurer.cookie);
    log(`Uzgodnienie wyciągu: ${reconciliation.reconciliationId}, ${reconciliation.lineCount} pozycji zaimportowanych (SZKIC, nie zatwierdzony).`);

    const eventsPublished = await seedEvents(env, admin.cookie, board1.cookie);
    log(`Wydarzenia: ${eventsPublished} zapowiedzi opublikowanych.`);

    const meeting = await seedMeeting(env, board1.cookie, board1.userId, board2.cookie);
    log(`Zebranie: ${meeting.meetingId}, protokół ${meeting.minutesId} zatwierdzony i udostępniony publicznie.`);

    // Samokontrola: protokół zatwierdzony i „public” ma się rzeczywiście pojawić
    // na /site/ pod TYM identyfikatorem roku, nie tylko w wewnętrznym API — inaczej
    // seed „mówi” o publikacji, a publiczna strona pokazuje pusty stan (patrz
    // komentarz przy SCHOOL_YEAR_ID: site/core.js zgaduje rok z dzisiejszej daty).
    const publicMinutes = await apiCall(env, {
      method: 'GET', path: `/api/meetings/public-minutes?schoolYearId=${encodeURIComponent(SCHOOL_YEAR_ID)}`,
    });
    if (!Array.isArray(publicMinutes.data.minutes) || publicMinutes.data.minutes.length < 1) {
      throw new Error(
        'Seed demo: protokół zatwierdzony do publikacji nie pojawia się na GET /api/meetings/public-minutes '
        + `dla schoolYearId=${SCHOOL_YEAR_ID} — /site/ pokazałby „Brak opublikowanych protokołów”.`,
      );
    }

    const campaignId = await seedEmailDraft(env, board1.cookie);
    log(`Kampania e-mail: szkic ${campaignId} (NIE zatwierdzony, NIE zakolejkowany, nic nie zostało wysłane).`);

    const newsId = await seedNews(env, admin.cookie, board1.cookie);
    log(`Aktualności: wpis ${newsId} opublikowany.`);

    return {
      mode, accounts, roster, meeting, campaignId, newsId, reconciliation,
      counts: { payments: paymentsCreated, ledger: ledgerCreated, events: eventsPublished },
      // Tylko gdy keepOpen: true (testy) — env.db zostaje otwarty, wywołujący
      // odpowiada za close(). W zwykłym użyciu (CLI, demo:seed) undefined.
      env: keepOpen ? env : undefined,
    };
  } finally {
    if (mode === 'pglite' && !inMemory) {
      // Zapisujemy klucz MFA obok bazy na dysku, żeby `npm run demo:start`
      // (osobny proces) mógł odszyfrować te same czynniki TOTP.
      await mkdir(DEMO_DATA_DIR, { recursive: true });
      await (await import('node:fs/promises')).writeFile(DEMO_MFA_KEY_FILE, mfaEncryptionKey, 'utf8');
    }
    if (!keepOpen) await close();
  }
}

function printCredentials(accounts) {
  console.log('');
  console.log('=== Konta demo — WYŁĄCZNIE do lokalnego pokazu, hasła nigdzie indziej nie są zapisane ===');
  console.log('Nie używać tych kont ani haseł poza lokalnym środowiskiem demo. Nie wysyłać ich e-mailem.');
  for (const account of accounts) {
    const mfaNote = account.mfaSecret ? `sekret TOTP (base32): ${account.mfaSecret}` : 'MFA nieskonfigurowane (rola bez wymogu)';
    console.log(`- ${account.role.padEnd(14)} ${account.email.padEnd(32)} hasło: ${account.password}   ${mfaNote}`);
  }
  console.log('==========================================================================================');
  console.log('');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await runDemoSeed();
    printCredentials(result.accounts);
    console.log(`Baza demo gotowa (${result.mode}). Uruchom „npm run demo:start”, żeby wystawić panel lokalnie.`);
    // site/core.js#defaultSchoolYearId zgaduje rok z dzisiejszej daty — poza
    // wrześniem–sierpniem roku ${SCHOOL_YEAR_ID} zgadnie inny rok niż ten,
    // do którego seed wpisał dane, i /site/ pokaże puste sekcje mimo danych
    // w bazie. „?rok=” wymusza właściwy rok niezależnie od dzisiejszej daty.
    console.log(`Strona publiczna: http://localhost:3000/site/?rok=${SCHOOL_YEAR_ID} (bez „?rok=” zależy od dzisiejszej daty).`);
  } catch (error) {
    if (error instanceof DemoSeedRefused) {
      console.error(error.message);
      process.exitCode = 2;
    } else {
      console.error('Seed demo nie powiódł się:', error.message);
      process.exitCode = 1;
    }
  }
}
