// Meta-test pokrycia dziennika odczytu (#133): każda trasa zwracająca dane
// dzieci/opiekunów (rejestr DATA_ACCESS_ROUTES w src/pg/data-access.js)
// zapisuje wpis w data_access_log — sprawdzane źródłowo i wywołaniem — a nowy
// plik tras czytający tabele rodzin bez wpisu w rejestrze lub na liście
// wyjątków z uzasadnieniem wywraca test. Wyłącznie dane syntetyczne (.invalid).
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handlePgRequest } from '../src/pg/app.js';
import { DATA_ACCESS_KINDS, DATA_ACCESS_ROUTES } from '../src/pg/data-access.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const Y1 = 'y-2026';

// Pliki tras, które sięgają do tabel rodzin, ale NIE zwracają listy/karty danych
// osobowych dzieci i opiekunów (uzasadnienie przy każdym). Nowy plik trzeba
// świadomie dopisać tutaj albo do rejestru.
const NOT_A_CHILD_DATA_READ = new Map([
  ['admin.js', 'tylko SELECT 1 (istnienie obiektu) przy rejestrze żądań osób; bez zwracania danych'],
  ['board.js', 'liczności/flagi gotowości klas (agregaty bez imion i e-maili)'],
  ['representative.js', 'liczniki klasy przedstawiciela (agregaty bez imion i e-maili)'],
  ['guardian-updates.js', 'podgląd: samo imię opiekuna i nazwy klas dla właściciela jednorazowego linku; lista żądań (zarząd) bez e-maili i nazwisk'],
  ['email.js', 'dobór adresatów kampanii; odczyt adresatów ma osobny ślad audytu email.recipients.viewed'],
  ['import.js', 'plan/zapis importu; ślad w import_batches i audycie, brak odczytu list rodzin'],
]);
const REGISTERED_FILES = new Set(DATA_ACCESS_ROUTES.map((route) => route.file.split('/').pop()));
const FAMILY_TABLES = /\b(?:FROM|JOIN)\s+(?:students|guardians|student_guardians_current|student_guardians|enrollments_current)\b/;

async function routeFiles() {
  return (await readdir(join(root, 'src/pg/routes'))).filter((name) => name.endsWith('.js')).sort();
}

describe('pokrycie dziennika odczytu danych rodzin (#133)', () => {
  test('rejestr i lista rodzajów są spójne, a CHECK w bazie zna każdy rodzaj', async () => {
    assert.deepEqual([...new Set(DATA_ACCESS_ROUTES.map((r) => r.accessKind))].sort(), [...DATA_ACCESS_KINDS].sort());
    assert.equal(new Set(DATA_ACCESS_ROUTES.map((r) => r.id)).size, DATA_ACCESS_ROUTES.length);
    const db = await createTestDb();
    try {
      const { rows } = await db.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'data_access_log_access_kind_check'`,
      );
      for (const kind of DATA_ACCESS_KINDS) assert.ok(rows[0].def.includes(`'${kind}'`), `CHECK bez ${kind}`);
    } finally { await db.close(); }
  });

  test('źródło każdej trasy z rejestru wywołuje recordDataAccess ze swoim rodzajem', async () => {
    for (const route of DATA_ACCESS_ROUTES) {
      const text = await readFile(join(root, route.file), 'utf8');
      assert.match(text, /recordDataAccess/, `${route.id}: brak wywołania`);
      assert.ok(new RegExp(`accessKind:\\s*'${route.accessKind}'`).test(text), `${route.id}: brak accessKind ${route.accessKind}`);
      if (route.strict) assert.match(text, /strict:\s*true/, `${route.id}: eksport musi zapisywać w transakcji (strict)`);
    }
  });

  test('każdy plik tras czytający tabele rodzin jest w rejestrze albo ma uzasadniony wyjątek', async () => {
    const unclassified = [];
    for (const name of await routeFiles()) {
      const text = await readFile(join(root, 'src/pg/routes', name), 'utf8');
      if (!FAMILY_TABLES.test(text)) continue;
      if (!REGISTERED_FILES.has(name) && !NOT_A_CHILD_DATA_READ.has(name)) unclassified.push(name);
    }
    assert.deepEqual(unclassified, [], 'nowy odczyt danych rodzin bez wpisu w DATA_ACCESS_ROUTES / wyjątku z uzasadnieniem');
    for (const name of NOT_A_CHILD_DATA_READ.keys()) {
      assert.ok((await routeFiles()).includes(name), `wyjątek dla nieistniejącego pliku ${name}`);
      assert.ok(!REGISTERED_FILES.has(name), `${name} jest jednocześnie w rejestrze i wśród wyjątków`);
    }
  });

  describe('wywołanie każdej trasy z rejestru zapisuje wpis', () => {
    let db;
    let cookie;
    const env = {};
    before(async () => {
      db = await createTestDb();
      env.db = db;
      await seedSchoolYear(db, Y1, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
      await seedClass(db, { id: 'c-1a', schoolYearId: Y1, name: '1A' });
      await db.exec(`
        INSERT INTO households (id) VALUES ('h-1');
        INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
          VALUES ('g-1', 'h-1', 'Anna', 'Testowa', 'opiekun1@example.invalid', true);
        INSERT INTO students (id, household_id, first_name, last_name) VALUES ('s-1', 'h-1', 'Ola', 'Testowa');
        INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ('s-1', 'g-1', true, true);
        INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('e-1', 's-1', 'c-1a', '${Y1}');
      `);
      cookie = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: Y1 }], mfa: true });
    });
    after(async () => { await db?.close(); });

    const concretePath = (route) => {
      const path = route.path.replace(':classId', 'c-1a').replace(':householdId', 'h-1');
      if (route.id === 'print.cards') return `${path}?schoolYearId=${Y1}`;
      if (route.id === 'payments.list' || route.id === 'payments.exportCsv') return `${path}?schoolYearId=${Y1}`;
      if (route.id === 'exports.classRoster') return `${path}?classId=c-1a`;
      return path;
    };

    for (const route of DATA_ACCESS_ROUTES) {
      test(route.id, async () => {
        const options = { method: route.method, cookie };
        if (route.method === 'POST') options.body = { schoolYearId: Y1 };
        const response = await handlePgRequest(request(concretePath(route), options), env);
        assert.equal(response.status, 200, `${route.id}: oczekiwano 200`);
        await response.arrayBuffer();
        const { rows } = await db.query(
          `SELECT count(*)::int AS n FROM data_access_log WHERE actor_id = 'u-board' AND access_kind = $1 AND outcome = 'ok'`,
          [route.accessKind],
        );
        assert.equal(rows[0].n, 1, `${route.id}: brak wpisu ${route.accessKind}`);
      });
    }
  });
});
