// Syntetyczny zestaw danych do testów wolumenu i wydajności (#16, #41):
// 1000 uczniów, 2000 kontaktów opiekunów, 50 użytkowników z przydziałami ról.
// Nazwy są generowane („Uczeń 0001”), każdy e-mail w zastrzeżonej domenie
// example.invalid. Żadnych prawdziwych danych. Tylko PGlite / baza testowa.
//
//   import { buildSyntheticData, insertSyntheticData, seedSyntheticSessions } from './lib/synthetic-seed.js';
//   const data = buildSyntheticData();
//   await insertSyntheticData(db, data);            // db: PGlite (exec + query)
//   const cookies = await seedSyntheticSessions(db, data.users.map(([id]) => id));

import { createSessionSecret } from '../../src/auth.js';

export const YEAR = 'y2026';
export const CLASS_COUNT = 20;
export const HOUSEHOLDS = 800; // 200 z rodzeństwem (2 dzieci), 600 z jednym dzieckiem
export const STUDENTS = 1000;
export const GUARDIANS = 2000; // 400 rodzin z 3 kontaktami, 400 z 2
export const USERS = 50;

export const pad = (n) => String(n).padStart(4, '0');
const q = (value) => (value === null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`);

// Wstawia wiersze wsadowo przez db.exec (bez parametrów; wartości są syntetyczne i cytowane).
export async function insertRows(db, table, columns, rows, chunk = 500) {
  for (let i = 0; i < rows.length; i += chunk) {
    const values = rows.slice(i, i + chunk).map((row) => `(${row.map(q).join(',')})`).join(',');
    await db.exec(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${values}`);
  }
}

export function buildSyntheticData() {
  const classes = Array.from({ length: CLASS_COUNT }, (_, i) => [`c${pad(i + 1)}`, YEAR, `Klasa ${pad(i + 1)}`]);
  const households = Array.from({ length: HOUSEHOLDS }, (_, i) => [`h${pad(i + 1)}`]);
  const students = [];
  const enrollments = [];
  for (let h = 0; h < HOUSEHOLDS; h += 1) {
    const children = h < STUDENTS - HOUSEHOLDS ? 2 : 1;
    for (let c = 0; c < children; c += 1) {
      const n = students.length + 1;
      students.push([`s${pad(n)}`, `h${pad(h + 1)}`, `Uczeń ${pad(n)}`, 'Syntetyczny']);
      // Rodzeństwo trafia do różnych klas.
      const classId = `c${pad(((n - 1) % CLASS_COUNT) + 1)}`;
      enrollments.push([`e${pad(n)}`, `s${pad(n)}`, classId, YEAR]);
    }
  }
  const guardians = [];
  for (let h = 0; h < HOUSEHOLDS; h += 1) {
    const count = h < GUARDIANS - 2 * HOUSEHOLDS ? 3 : 2;
    for (let g = 0; g < count; g += 1) {
      const n = guardians.length + 1;
      guardians.push([`g${pad(n)}`, `h${pad(h + 1)}`, `Opiekun ${pad(n)}`, 'Syntetyczny',
        `opiekun${pad(n)}@example.invalid`, 'true']);
    }
  }
  const byHousehold = new Map();
  for (const [id, household] of guardians) {
    if (!byHousehold.has(household)) byHousehold.set(household, []);
    byHousehold.get(household).push(id);
  }
  const links = [];
  for (const [studentId, household] of students) {
    byHousehold.get(household).forEach((guardianId, index) => {
      // Dwie osoby opiekujące się jednym dzieckiem: obie z kontaktem; trzecia bez.
      links.push([studentId, guardianId, index < 2 ? 'true' : 'false', index === 0 ? 'true' : 'false']);
    });
  }
  const users = Array.from({ length: USERS }, (_, i) => [`u${pad(i + 1)}`, `uzytkownik${pad(i + 1)}@example.invalid`, `Użytkownik ${pad(i + 1)}`]);
  const grants = [];
  users.forEach(([userId], i) => {
    if (i < 2) grants.push([`r${grants.length + 1}`, userId, 'admin', null, null]);
    else if (i < 8) grants.push([`r${grants.length + 1}`, userId, 'board', null, null]);
    else if (i < 10) grants.push([`r${grants.length + 1}`, userId, 'treasurer', null, YEAR]);
    else {
      // 40 przedstawicieli klas: 2 na klasę, część z drugą klasą.
      const classIndex = (i - 10) % CLASS_COUNT;
      grants.push([`r${grants.length + 1}`, userId, 'representative', `c${pad(classIndex + 1)}`, YEAR]);
      if (i % 5 === 0) grants.push([`r${grants.length + 1}`, userId, 'representative', `c${pad(((classIndex + 1) % CLASS_COUNT) + 1)}`, YEAR]);
    }
  });
  // Dobrowolne wpłaty częściowe: rodziny 1..600 wpłacają raz lub dwa razy.
  const payments = [];
  for (let h = 0; h < 600; h += 1) {
    const parts = h % 3 === 0 ? 2 : 1;
    for (let p = 0; p < parts; p += 1) {
      const n = payments.length + 1;
      payments.push([`p${pad(n)}`, `h${pad(h + 1)}`, YEAR, String(2000 + (h % 5) * 500), '2026-10-01', 'bank',
        `REF-${pad(n)}`, 'recorded', 'u0009', `volume-payment-${pad(n)}`]);
    }
  }
  const corrections = payments.slice(0, 50).map(([id], i) => [`pc${pad(i + 1)}`, id, '500', 'Korekta syntetyczna', 'u0009', `volume-correction-${pad(i + 1)}`]);
  return { classes, households, students, enrollments, guardians, links, users, grants, payments, corrections };
}

// Główna rola użytkownika w zestawie (pierwszy przydział).
export function primaryRoles(data) {
  const roles = new Map();
  for (const [, userId, role] of data.grants) if (!roles.has(userId)) roles.set(userId, role);
  return roles;
}

export async function insertSyntheticData(db, data = buildSyntheticData()) {
  await db.exec(`INSERT INTO school_years VALUES ('${YEAR}','2026/27','2026-09-01','2027-08-31')`);
  await insertRows(db, 'classes', ['id', 'school_year_id', 'name'], data.classes);
  await insertRows(db, 'households', ['id'], data.households);
  await insertRows(db, 'students', ['id', 'household_id', 'first_name', 'last_name'], data.students);
  await insertRows(db, 'enrollments', ['id', 'student_id', 'class_id', 'school_year_id'], data.enrollments);
  await insertRows(db, 'guardians', ['id', 'household_id', 'first_name', 'last_name', 'email', 'contact_allowed'], data.guardians);
  await insertRows(db, 'student_guardians', ['student_id', 'guardian_id', 'contact_allowed', 'is_primary_contact'], data.links);
  await insertRows(db, 'users', ['id', 'email', 'display_name'], data.users);
  await insertRows(db, 'role_grants', ['id', 'user_id', 'role', 'class_id', 'school_year_id'], data.grants);
  await insertRows(db, 'payment_entries', ['id', 'household_id', 'school_year_id', 'amount_cents', 'received_on', 'method',
    'reference', 'status', 'created_by', 'idempotency_key'], data.payments);
  // Pojedynczo: trigger korekt sprawdza pozostałą kwotę wiersz po wierszu.
  await insertRows(db, 'payment_corrections', ['id', 'payment_entry_id', 'amount_cents', 'reason', 'created_by', 'idempotency_key'], data.corrections, 1);
  return data;
}

// Sesja (z potwierdzonym MFA, ważna ttlSeconds) dla każdego użytkownika.
// Zwraca Map userId -> wartość nagłówka Cookie. Sekret nie trafia do bazy (tylko hash).
export async function seedSyntheticSessions(db, userIds, { mfa = true, ttlSeconds = 2 * 60 * 60 } = {}) {
  const cookies = new Map();
  const rows = [];
  for (const userId of userIds) {
    const { secret, tokenHash } = await createSessionSecret();
    cookies.set(userId, `rd_session=${secret}`);
    rows.push([crypto.randomUUID(), userId, tokenHash]);
  }
  const values = rows.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3}, now() + make_interval(secs => ${Number(ttlSeconds)}), ${mfa ? 'now()' : 'NULL'})`).join(',');
  await db.query(`INSERT INTO sessions (id, user_id, token_hash, expires_at, mfa_verified_at) VALUES ${values}`, rows.flat());
  return cookies;
}
