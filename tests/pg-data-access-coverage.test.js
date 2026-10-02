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
import { DATA_ACCESS_EXEMPT_ROUTES, DATA_ACCESS_KINDS, DATA_ACCESS_ROUTES } from '../src/pg/data-access.js';
import { createDraft, createSignup, createTask } from '../src/pg/events.js';
import { AUDIT_ACTION_CATALOG } from '../shared/audit-actions.js';
import { ROUTE_MATRIX } from './helpers/route-matrix.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUserSession, seedPublishedPrivacyNotice } from './helpers/pg.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const Y1 = 'y-2026';

// Pliki tras, które sięgają do tabel rodzin, ale NIE zwracają listy/karty danych
// osobowych dzieci i opiekunów (uzasadnienie przy każdym). Nowy plik trzeba
// świadomie dopisać tutaj albo do rejestru.
const NOT_A_CHILD_DATA_READ = new Map([
  ['board.js', 'liczności/flagi gotowości klas (agregaty bez imion i e-maili)'],
  ['representative.js', 'liczniki klasy przedstawiciela (agregaty bez imion i e-maili)'],
  ['guardian-updates.js', 'podgląd: samo imię opiekuna i nazwy klas dla właściciela jednorazowego linku; lista żądań (zarząd: imię, proponowany adres) ma ślad audytu guardian_update_request.list_viewed — patrz DATA_ACCESS_EXEMPT_ROUTES'],
  ['email.js', 'dobór adresatów kampanii; odczyt adresatów ma osobny ślad audytu email.recipients.viewed'],
  ['import.js', 'plan/zapis importu; ślad w import_batches i audycie, brak odczytu list rodzin'],
]);
const REGISTERED_FILES = new Set(DATA_ACCESS_ROUTES.map((route) => route.file.split('/').pop()));
const FAMILY_TABLES = /\b(?:FROM|JOIN)\s+(?:students|guardians|student_guardians_current|student_guardians|enrollments_current)\b/;

const templatePath = (path) => path.split('?')[0];

async function pgSources(dir = 'src/pg') {
  const out = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await pgSources(path));
    else if (entry.name.endsWith('.js')) out.push(path);
  }
  return out;
}

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

  // Poziom tras (nie plików): plik z rejestru może mieć inne trasy GET z danymi
  // rodzin, a moduł domenowy (np. src/pg/events.js) czyta tabele rodzin poza
  // src/pg/routes. Macierz uprawnień jest kompletna względem ROUTES
  // (tests/pg-authz-matrix.test.js), więc każda nowa trasa GET trafia tutaj.
  test('każda trasa GET z macierzy uprawnień zapisuje odczyt albo jest jawnym wyjątkiem z uzasadnieniem', () => {
    const matrixById = new Map(ROUTE_MATRIX.map((route) => [route.id, route]));
    const registered = new Map(DATA_ACCESS_ROUTES.map((route) => [route.id, route]));
    for (const route of DATA_ACCESS_ROUTES) {
      const entry = matrixById.get(route.id);
      assert.ok(entry, `${route.id}: trasy z rejestru nie ma w macierzy uprawnień`);
      assert.equal(entry.method, route.method, `${route.id}: inna metoda niż w macierzy`);
      assert.equal(templatePath(entry.path), route.path, `${route.id}: inna ścieżka niż w macierzy`);
    }
    const unclassified = [];
    for (const route of ROUTE_MATRIX) {
      if (route.method !== 'GET') continue;
      if (!registered.has(route.id) && !Object.hasOwn(DATA_ACCESS_EXEMPT_ROUTES, route.id)) unclassified.push(route.id);
    }
    assert.deepEqual(unclassified, [], 'trasa GET bez wpisu w DATA_ACCESS_ROUTES ani w DATA_ACCESS_EXEMPT_ROUTES (src/pg/data-access.js)');
    for (const [id, exemption] of Object.entries(DATA_ACCESS_EXEMPT_ROUTES)) {
      const entry = matrixById.get(id);
      assert.ok(entry, `wyjątek dla nieistniejącej trasy ${id}`);
      assert.equal(entry.method, 'GET', `${id}: wyjątek dotyczy tylko tras GET`);
      assert.ok(!registered.has(id), `${id} jest jednocześnie w rejestrze i wśród wyjątków`);
      assert.ok(exemption.reason.length >= 20, `${id}: uzasadnienie wyjątku za krótkie`);
    }
  });

  test('wyjątki „osobny ślad audytu” wskazują akcję ze słownika, zapisywaną w źródle', async () => {
    const sources = await Promise.all((await pgSources()).map((file) => readFile(join(root, file), 'utf8')));
    for (const [id, exemption] of Object.entries(DATA_ACCESS_EXEMPT_ROUTES)) {
      if (!exemption.audit) continue;
      assert.ok(Object.hasOwn(AUDIT_ACTION_CATALOG, exemption.audit), `${id}: akcji ${exemption.audit} nie ma w słowniku`);
      assert.ok(sources.some((text) => text.includes(`action: '${exemption.audit}'`)), `${id}: nikt nie zapisuje ${exemption.audit}`);
    }
  });

  // D-09 (#137): trasa, którą audit czyta za flagą, nie może być cichym wyjątkiem — wymaga śladu odczytu
  // (akcja ze słownika, zapisywana w źródle: sprawdza to test wyżej), a nie luki followUp.
  test('trasy odczytu audit za flagą AUDIT_LEDGER_READ mają ślad audytu, nie samo uzasadnienie', () => {
    const flagged = ROUTE_MATRIX.filter((route) => route.auditFlag);
    assert.ok(flagged.length >= 8, `za mało tras z auditFlag: ${flagged.length}`);
    for (const route of flagged) {
      const entry = DATA_ACCESS_EXEMPT_ROUTES[route.id];
      assert.ok(entry, `${route.id}: trasa z odczytem audit musi być sklasyfikowana`);
      assert.ok(entry.audit, `${route.id}: odczyt przez audit bez śladu audytu`);
      assert.equal(entry.followUp, false, `${route.id}: odczyt audit nie może być odłożoną luką`);
    }
  });

  test('lista odłożonych luk (followUp) nie rośnie bez decyzji', () => {
    // Zmniejszanie jest mile widziane; dopisanie nowej luki = świadoma zmiana tego testu i docs/SECURITY.md.
    const pending = Object.entries(DATA_ACCESS_EXEMPT_ROUTES).filter(([, e]) => e.followUp).map(([id]) => id).sort();
    assert.deepEqual(pending, ['events.tasksList', 'guardianUpdates.list', 'payment-references.list', 'payments.allocations.list']);
  });

  describe('wyjątki: ślad audytu odczytu danych opiekunów i agregaty bez danych osobowych', () => {
    let db;
    const env = {};
    let boardCookie;
    let adminCookie;
    let repCookie;
    const PII = ['Anna', 'Testowa', 'Ola', 'opiekun1@example.invalid', 'nowy1@example.invalid'];
    before(async () => {
      db = await createTestDb();
      await seedPublishedPrivacyNotice(db);
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
      boardCookie = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: Y1 }], mfa: true });
      adminCookie = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
      repCookie = await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: Y1 }] });
    });
    after(async () => { await db?.close(); });

    const call = async (path, { cookie, method = 'GET', body } = {}) => {
      const response = await handlePgRequest(request(path, { cookie, method, body }), env);
      const text = await response.text();
      return { status: response.status, text, json: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null };
    };
    const auditCount = async (action) => (await db.query(
      'SELECT count(*)::int AS n FROM audit_events WHERE action = $1', [action],
    )).rows[0].n;

    test('guardianUpdates.list: lista z imieniem i proponowanym adresem zapisuje ślad bez danych osobowych', async () => {
      const link = await call('/api/admin/guardian-links', { cookie: adminCookie, method: 'POST', body: { guardianId: 'g-1' } });
      assert.equal(link.status, 201);
      const sent = await call('/api/public/guardian-update', { method: 'POST', body: { token: link.json.token, email: 'nowy1@example.invalid' } });
      assert.ok(sent.status < 300, `wniosek: ${sent.status}`);
      const before = await auditCount('guardian_update_request.list_viewed');
      const list = await call('/api/admin/guardian-update-requests', { cookie: boardCookie });
      assert.equal(list.status, 200);
      assert.equal(list.json.requests.length, 1, 'lista zawiera wniosek (dane opiekuna)');
      assert.equal(await auditCount('guardian_update_request.list_viewed'), before + 1);
      const { rows } = await db.query(
        "SELECT actor_id, entity_id, metadata_json::text AS meta FROM audit_events WHERE action = 'guardian_update_request.list_viewed' ORDER BY occurred_at DESC LIMIT 1",
      );
      assert.equal(rows[0].actor_id, 'u-board');
      for (const value of [...PII, 'g-1', 'h-1']) assert.ok(!rows[0].meta.includes(value), `ślad zawiera ${value}`);
      // Przedstawiciel: 403 i brak śladu odczytu.
      assert.equal((await call('/api/admin/guardian-update-requests', { cookie: repCookie })).status, 403);
      assert.equal(await auditCount('guardian_update_request.list_viewed'), before + 1);
    });

    test('events.tasksList: nazwisko opiekuna w zgłoszeniach zapisuje ślad; lista bez opiekunów — bez śladu', async () => {
      const actor = { userId: 'u-board', grants: [{ role: 'board', classId: null, schoolYearId: Y1 }], mfaVerified: true };
      const { event } = await createDraft(db, actor, {
        schoolYearId: Y1, classId: 'c-1a', title: 'Piknik klasowy (syntetyczny)',
        startsAt: '2026-11-12T10:00', endsAt: '2026-11-12T14:00', audience: 'internal', idempotencyKey: 'cov-event-0001',
      });
      const { task } = await createTask(db, actor, { eventId: event.id, title: 'Stoisko z ciastami', slotsNeeded: 2, idempotencyKey: 'cov-task-0001' });
      const empty = await call(`/api/events/${event.id}/tasks`, { cookie: boardCookie });
      assert.equal(empty.status, 200);
      assert.equal(await auditCount('event.task_signups_viewed'), 0, 'bez opiekunów na liście nie ma czego rejestrować');
      await createSignup(db, actor, { eventId: event.id, taskId: task.id, guardianId: 'g-1', idempotencyKey: 'cov-signup-0001' });
      const listed = await call(`/api/events/${event.id}/tasks`, { cookie: boardCookie });
      assert.equal(listed.status, 200);
      assert.match(listed.text, /Anna Testowa/, 'lista pokazuje nazwisko opiekuna');
      assert.equal(await auditCount('event.task_signups_viewed'), 1);
      const { rows } = await db.query(
        "SELECT actor_id, entity_id, metadata_json AS meta FROM audit_events WHERE action = 'event.task_signups_viewed'",
      );
      assert.equal(rows[0].actor_id, 'u-board');
      assert.equal(rows[0].entity_id, event.id);
      assert.deepEqual(rows[0].meta, { schoolYearId: Y1, guardianSignups: 1 });
    });

    // Uzasadnienie „agregaty bez imion i e-maili” sprawdzone wywołaniem na danych
    // syntetycznych (XLSX jest skompresowany — jego zawartość to te same liczby co CSV).
    const aggregateCases = [
      ['families.classes', '/api/classes', () => boardCookie],
      ['board.overview', `/api/board/overview?schoolYearId=${Y1}`, () => boardCookie],
      ['board.overviewExportCsv', `/api/board/overview/export.csv?schoolYearId=${Y1}`, () => boardCookie],
      ['representative.overview', `/api/representative/overview?schoolYearId=${Y1}`, () => repCookie],
      ['admin.classCoverage', `/api/admin/class-coverage?schoolYearId=${Y1}`, () => adminCookie],
      ['yearClose.status', `/api/year-close/${Y1}`, () => boardCookie],
    ];
    for (const [id, path, cookie] of aggregateCases) {
      test(`${id}: odpowiedź bez imion, nazwisk i e-maili rodzin`, async () => {
        assert.ok(DATA_ACCESS_EXEMPT_ROUTES[id], `${id} nie jest wyjątkiem`);
        const response = await call(path, { cookie: cookie() });
        assert.equal(response.status, 200, `${id}: ${response.text.slice(0, 120)}`);
        for (const value of PII) assert.ok(!response.text.includes(value), `${id}: odpowiedź zawiera ${value}`);
      });
    }
  });

  describe('wywołanie każdej trasy z rejestru zapisuje wpis', () => {
    let db;
    let cookie;
    const env = {};
    before(async () => {
      db = await createTestDb();
      await seedPublishedPrivacyNotice(db);
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
      // #142: wydarzenie klasy 1A dla events.taskCandidates (opiekunowie klasy).
      const actor = { userId: 'u-board', grants: [{ role: 'board', classId: null, schoolYearId: Y1 }], mfaVerified: true };
      eventId = (await createDraft(db, actor, {
        schoolYearId: Y1, classId: 'c-1a', title: 'Piknik klasowy (syntetyczny)',
        startsAt: '2026-11-12T10:00', audience: 'internal', idempotencyKey: 'cov-reg-event-0001',
      })).event.id;
    });
    after(async () => { await db?.close(); });
    let eventId;

    const concretePath = (route) => {
      const path = route.path.replace(':classId', 'c-1a').replace(':householdId', 'h-1').replace(':eventId', eventId);
      if (route.id === 'print.cards') return `${path}?schoolYearId=${Y1}`;
      if (['payments.list', 'payments.exportCsv', 'payments.exportXlsx'].includes(route.id)) return `${path}?schoolYearId=${Y1}`;
      if (route.id === 'exports.classRoster') return `${path}?classId=c-1a`;
      return path;
    };

    // #100: eksport danych rodziny dla żądania osoby — wyłącznie admin z MFA
    // (wariant zachowawczy do D-07/D-08), żądanie po weryfikacji tożsamości.
    const ADMIN_ONLY_ROUTES = new Set(['admin.dataRequestExport']);
    async function adminDataRequest() {
      const adminCookie = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
      const call = (path, body) => handlePgRequest(request(path, { method: 'POST', cookie: adminCookie, body }), env);
      const created = await (await call('/api/admin/data-requests', { kind: 'access', householdId: 'h-1', receivedOn: '2026-10-01' })).json();
      await (await call(`/api/admin/data-requests/${created.request.id}/status`, { status: 'identity_verified' })).arrayBuffer();
      return { adminCookie, requestId: created.request.id };
    }

    for (const route of DATA_ACCESS_ROUTES) {
      test(route.id, async () => {
        let actorId = 'u-board';
        let path = concretePath(route);
        const options = { method: route.method, cookie };
        if (route.method === 'POST') options.body = { schoolYearId: Y1 };
        if (ADMIN_ONLY_ROUTES.has(route.id)) {
          const { adminCookie, requestId } = await adminDataRequest();
          actorId = 'u-admin';
          options.cookie = adminCookie;
          options.body = {};
          path = route.path.replace(':requestId', requestId);
        }
        const response = await handlePgRequest(request(path, options), env);
        assert.equal(response.status, 200, `${route.id}: oczekiwano 200`);
        await response.arrayBuffer();
        const { rows } = await db.query(
          `SELECT count(*)::int AS n FROM data_access_log WHERE actor_id = $2 AND access_kind = $1 AND outcome = 'ok'`,
          [route.accessKind, actorId],
        );
        assert.equal(rows[0].n, 1, `${route.id}: brak wpisu ${route.accessKind}`);
      });
    }
  });
});
