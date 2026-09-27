import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedUserSession } from './helpers/pg.js';

test('events and meetings are served by the PostgreSQL router with server-side sessions', async () => {
  const db = await createTestDb();
  try {
    const env = { db };
    const publicEvents = await handlePgRequest(request('/api/public/events'), env);
    assert.equal(publicEvents.status, 200);

    for (const path of ['/api/events?schoolYearId=y-test', '/api/meetings?schoolYearId=y-test']) {
      const anonymous = await handlePgRequest(request(path), env);
      assert.equal(anonymous.status, 401, path);
    }

    const board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: 'y-test' }], mfa: true });
    for (const path of ['/api/events?schoolYearId=y-test', '/api/meetings?schoolYearId=y-test']) {
      const allowed = await handlePgRequest(request(path, { cookie: board }), env);
      assert.equal(allowed.status, 200, path);
    }

    const crossOrigin = await handlePgRequest(request('/api/events', {
      method: 'POST', cookie: board, origin: 'https://evil.example', body: {},
      headers: { 'Idempotency-Key': 'event-cross-origin-1' },
    }), env);
    assert.equal(crossOrigin.status, 403);
  } finally {
    await db.close();
  }
});

// #157: student_guardians_current (postgres/migrations/0035) jest jedynym
// dozwolonym miejscem sprawdzania, czy relacja opiekun-uczeń jest "aktualna".
// Ponowne wpisanie warunku starts_on/ends_on gdziekolwiek w src/pg psuje ten test.
test('src/pg/** nie powtarza warunku aktualności student_guardians poza widokiem', () => {
  const srcDir = fileURLToPath(new URL('../src/pg', import.meta.url));
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.js')) {
        const text = readFileSync(path, 'utf8');
        for (const match of text.matchAll(/(\w+)\.(starts_on|ends_on)\b/g)) {
          const alias = match[1];
          // student_guardians_current(_on) i inne widoki/tabele z legalną
          // datą (school_years, students_households itd.) mają własną,
          // dozwoloną semantykę — dotyczy tylko aliasu student_guardians (sg/csg).
          if (!/^(sg|csg)$/.test(alias)) continue;
          offenders.push(`${path}: ${match[0]}`);
        }
      }
    }
  };
  walk(srcDir);
  assert.deepEqual(offenders, []);
});
