// #156: ponowienie transakcji przy 40001/40P01, lock_timeout, błąd w trakcie
// COMMIT (`commit_outcome_unknown`) i nagłówek Allow przy każdym 405.
// Wyłącznie dane syntetyczne; PGlite z atrapą puli wstrzykującą błędy SQLSTATE.
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommitOutcomeUnknownError, commitFailureIsDefinite, createPgDatabase } from '../src/db.js';
import { createPgHandler, ROUTES } from '../src/pg/app.js';
import { MESSAGES } from '../shared/messages.js';
import { ROUTE_MATRIX } from './helpers/route-matrix.js';
import { createTestDb, request, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const pgError = (code) => Object.assign(new Error(`synthetic ${code}`), { code });

// Pula udająca pg.Pool na jednym połączeniu PGlite. `inject(text, state)`
// może zgłosić błąd zamiast wykonać zapytanie (transakcja PGlite żyje dalej,
// więc ROLLBACK po błędzie działa jak na prawdziwym serwerze).
function poolOver(pglite, inject = () => {}) {
  const state = { begins: 0, commits: 0, rollbacks: 0, released: [], lockTimeouts: [], queries: [] };
  const client = {
    async query(text, params = []) {
      if (text === 'BEGIN') state.begins += 1;
      if (text === 'COMMIT') state.commits += 1;
      if (text === 'ROLLBACK') state.rollbacks += 1;
      const lockTimeout = /^SET LOCAL lock_timeout = (\d+)$/.exec(text);
      if (lockTimeout) state.lockTimeouts.push(Number(lockTimeout[1]));
      state.queries.push(text);
      inject(text, state);
      return pglite.query(text, params);
    },
    release(broken) {
      state.released.push(Boolean(broken));
      // Porzucone połączenie z niedokończoną transakcją: sprzątamy, jak zrobiłby serwer.
      if (broken) return pglite.query('ROLLBACK').catch(() => {});
      return undefined;
    },
  };
  return {
    state,
    pool: {
      on() {},
      async connect() { return client; },
      async query(text, params = []) { return pglite.query(text, params); },
      async end() {},
    },
  };
}

const noSleep = { sleep: async () => {}, backoffMs: () => 0 };

// Jedna baza PGlite na cały plik (migracje trwają kilka sekund); testy liczą
// przyrosty względem stanu początkowego i używają własnych kluczy idempotencji.
let sharedDb;
let sharedCookie;
let keySeq = 0;
async function shared() {
  if (!sharedDb) {
    sharedDb = await createTestDb();
    await seedSchoolYear(sharedDb, 'y2026');
    await sharedDb.query("INSERT INTO households (id) VALUES ('h1')");
    sharedCookie = await seedUserSession(sharedDb, { userId: 'u1', mfa: true, roles: [{ role: 'treasurer', schoolYearId: 'y2026' }] });
  }
  return { pglite: sharedDb, cookie: sharedCookie };
}
after(async () => { await sharedDb?.close(); });

async function withBackend(injectFor, fn, options = {}) {
  const { pglite, cookie } = await shared();
  const { pool, state } = poolOver(pglite, (text, s) => injectFor?.(text, s));
  const db = createPgDatabase(pool, { ...noSleep, ...options });
  {
    const baseline = {};
    const handler = createPgHandler(ROUTES);
    const post = () => handler(request('/api/payments', {
      method: 'POST', cookie,
      headers: { 'Idempotency-Key': `retry-key-${String(++keySeq).padStart(6, '0')}` },
      body: { householdId: 'h1', schoolYearId: 'y2026', amountCents: 7500, receivedOn: '2026-09-20', method: 'bank', reference: 'synthetic-reference' },
    }), { db });
    const raw = async (table, where) => Number((await pglite.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n);
    for (const [table, where] of [['payment_entries', 'TRUE'], ['audit_events', "action = 'payment.created'"]]) baseline[`${table}|${where}`] = await raw(table, where);
    const count = async (table, where = 'TRUE') => (await raw(table, where)) - (baseline[`${table}|${where}`] ?? 0);
    return await fn({ db, pglite, state, post, count });
  }
}

// Wstrzykuje błąd `count` razy przy pierwszym wstawieniu wpłaty.
function failInsert(code, times) {
  let left = times;
  return (text) => {
    if (left > 0 && text.includes('INSERT INTO payment_entries')) { left -= 1; throw pgError(code); }
  };
}

describe('#156: ponowienie transakcji przy 40001/40P01', () => {
  for (const code of ['40001', '40P01']) {
    test(`${code} raz: wpłata kończy się sukcesem po ponowieniu, jeden wpis i jedno zdarzenie audytu`, async () => {
      await withBackend(failInsert(code, 1), async ({ post, state, count }) => {
        const res = await post();
        assert.equal(res.status, 201);
        assert.equal(await count('payment_entries'), 1);
        assert.equal(await count('audit_events', "action = 'payment.created'"), 1);
        // Pierwsza próba wycofana, druga zatwierdzona.
        assert.equal(state.begins, 2);
        assert.equal(state.rollbacks, 1);
        assert.equal(state.commits, 1);
        assert.deepEqual(state.released, [false, false]);
      });
    });
  }

  test('40P01 przy każdej próbie: 3 próby, potem 503 retry_later + Retry-After, bez zapisu', async () => {
    await withBackend(failInsert('40P01', 99), async ({ post, state, count }) => {
      const res = await post();
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('Retry-After'), '1');
      assert.deepEqual(await res.json(), { error: 'retry_later' });
      assert.equal(state.begins, 3);
      assert.equal(state.commits, 0);
      assert.equal(await count('payment_entries'), 0);
      assert.equal(await count('audit_events', "action = 'payment.created'"), 0);
    });
  });

  test('40001 dwa razy: trzecia próba się udaje (dokładnie 3 próby)', async () => {
    await withBackend(failInsert('40001', 2), async ({ post, state, count }) => {
      assert.equal((await post()).status, 201);
      assert.equal(state.begins, 3);
      assert.equal(await count('payment_entries'), 1);
    });
  });

  test('40001 przy COMMIT to pewne wycofanie: ponawiane, a wynik zapisany raz', async () => {
    let failed = false;
    await withBackend((text) => {
      if (text === 'COMMIT' && !failed) { failed = true; throw pgError('40001'); }
    }, async ({ post, state, count }) => {
      assert.equal((await post()).status, 201);
      assert.equal(state.begins, 2);
      assert.equal(await count('payment_entries'), 1);
      assert.equal(await count('audit_events', "action = 'payment.created'"), 1);
    });
  });

  test('inne kody (23505, 55P03, 57014) nie są ponawiane', async () => {
    for (const code of ['55P03', '57014', '23505']) {
      await withBackend(null, async ({ db, state }) => {
        let calls = 0;
        await assert.rejects(db.transaction(async () => { calls += 1; throw pgError(code); }), { code });
        assert.equal(calls, 1, code);
        assert.equal(state.begins, 1, code);
      });
    }
  });

  test('{ retries: 0 } wyłącza ponowienie jawnie', async () => {
    await withBackend(null, async ({ db }) => {
      let calls = 0;
      await assert.rejects(db.transaction(async () => { calls += 1; throw pgError('40001'); }, { retries: 0 }), { code: '40001' });
      assert.equal(calls, 1);
    });
  });

  test('odstęp między próbami pochodzi z backoffMs (losowy jitter, rosnący)', async () => {
    const sleeps = [];
    await withBackend(null, async ({ db }) => {
      let calls = 0;
      await assert.rejects(db.transaction(async () => { calls += 1; throw pgError('40001'); }), { code: '40001' });
      assert.equal(calls, 3);
    }, { sleep: async (ms) => { sleeps.push(ms); }, backoffMs: (attempt) => 10 * (attempt + 1) });
    assert.deepEqual(sleeps, [10, 20]);
  });
});

describe('#156: lock_timeout w transakcjach', () => {
  test('domyślnie 3000 ms, ustawiane SET LOCAL po BEGIN i przed funkcją', async () => {
    await withBackend(null, async ({ db, state }) => {
      await db.transaction(async (tx) => { await tx.query('SELECT 1'); });
      assert.deepEqual(state.lockTimeouts, [3000]);
      assert.equal(state.queries[0], 'BEGIN');
      assert.match(state.queries[1], /^SET LOCAL lock_timeout = 3000$/);
    });
  });

  test('wartość z konfiguracji (opcja albo PG_LOCK_TIMEOUT_MS), zawężona do rozsądnego zakresu', async () => {
    await withBackend(null, async ({ db, state }) => {
      await db.transaction(async () => {});
      assert.deepEqual(state.lockTimeouts, [1500]);
    }, { lockTimeoutMs: 1500 });
    const previous = process.env.PG_LOCK_TIMEOUT_MS;
    try {
      process.env.PG_LOCK_TIMEOUT_MS = '999999999';
      await withBackend(null, async ({ db, state }) => {
        await db.transaction(async () => {});
        assert.deepEqual(state.lockTimeouts, [60_000]);
      });
      process.env.PG_LOCK_TIMEOUT_MS = 'abc';
      await withBackend(null, async ({ db, state }) => {
        await db.transaction(async () => {});
        assert.deepEqual(state.lockTimeouts, [3000]);
      });
    } finally {
      if (previous === undefined) delete process.env.PG_LOCK_TIMEOUT_MS; else process.env.PG_LOCK_TIMEOUT_MS = previous;
    }
  });

  test('set_config(..., true) z transakcji ustawia lock_timeout w PostgreSQL (lokalnie dla transakcji)', async () => {
    await withBackend(null, async ({ pglite }) => {
      await pglite.query('BEGIN');
      await pglite.query("SELECT set_config('lock_timeout', '1', true)");
      const { rows } = await pglite.query("SELECT current_setting('lock_timeout') AS v");
      await pglite.query('ROLLBACK');
      assert.equal(rows[0].v, '1ms');
    });
  });
});

describe('#156: błąd w trakcie COMMIT', () => {
  test('klasyfikacja: pewne wycofanie vs wynik nieznany', () => {
    for (const code of ['40001', '40P01', '23505', '23503', '25P02']) assert.equal(commitFailureIsDefinite(pgError(code)), true, code);
    for (const code of ['08006', '08003', '57P01', '57014', '53300', 'ECONNRESET', undefined]) {
      assert.equal(commitFailureIsDefinite(pgError(code)), false, String(code));
    }
    assert.equal(commitFailureIsDefinite(new Error('Connection terminated unexpectedly')), false);
  });

  for (const code of ['08006', 'ECONNRESET']) {
    test(`${code} przy COMMIT: 503 commit_outcome_unknown, bez ponowienia, połączenie wyrzucone z puli`, async () => {
      await withBackend((text) => { if (text === 'COMMIT') throw pgError(code); }, async ({ post, state, count }) => {
        const res = await post();
        assert.equal(res.status, 503);
        assert.deepEqual(await res.json(), { error: 'commit_outcome_unknown' });
        assert.equal(res.headers.get('Retry-After'), null);
        assert.equal(state.begins, 1); // żadnego automatycznego ponowienia
        assert.equal(state.rollbacks, 0); // ROLLBACK nic nie wyjaśni po zerwanym COMMIT (poza sprzątaniem w atrapie)
        assert.deepEqual(state.released, [true]);
        assert.equal(await count('payment_entries'), 0); // atrapa nie dowiozła COMMIT
      });
    });
  }

  test('wyjątek niesie kod i przyczynę', async () => {
    await withBackend((text) => { if (text === 'COMMIT') throw pgError('08006'); }, async ({ db }) => {
      await assert.rejects(db.transaction(async () => {}), (error) => {
        assert.ok(error instanceof CommitOutcomeUnknownError);
        assert.equal(error.code, 'commit_outcome_unknown');
        assert.equal(error.cause.code, '08006');
        return true;
      });
    });
  });

  test('komunikat istnieje w shared/messages.js i mówi o sprawdzeniu stanu', () => {
    assert.match(MESSAGES.commit_outcome_unknown, /Sprawdź/);
  });
});

// --- Efekty zewnętrzne wewnątrz transakcji -----------------------------------

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Zwraca indeks zamykającego nawiasu dla otwierającego na `open`, pomijając
// łańcuchy, szablony i komentarze.
function matchParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === "'" || c === '"') {
      for (i += 1; src[i] !== c; i += 1) if (src[i] === '\\') i += 1;
      continue;
    }
    if (c === '`') {
      for (i += 1; src[i] !== '`'; i += 1) {
        if (src[i] === '\\') i += 1;
        else if (src[i] === '$' && src[i + 1] === '{') { i = matchParen(src, i + 1) ; }
      }
      continue;
    }
    if (c === '(' || c === '{') depth += 1;
    if (c === ')' || c === '}') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

const EXTERNAL_EFFECT = /\b(transport\.send|storage\.(putObject|deleteObject|copyObject|getObject|headObject)|targetStorage\.|env\.storage\.|fetch\(|sendMail|sendEmail|nodemailer)/;

describe('#156: transakcje z ponowieniem nie mają efektów zewnętrznych', () => {
  test('funkcja db.transaction(...) nie woła transportu, Storage ani sieci, chyba że ma { retries: 0 }', () => {
    const problems = [];
    let inspected = 0;
    for (const file of [...sourceFiles(join(ROOT, 'src')), ...sourceFiles(join(ROOT, 'shared'))]) {
      const src = readFileSync(file, 'utf8');
      for (const match of src.matchAll(/\.transaction\(/g)) {
        const open = match.index + match[0].length - 1;
        const close = matchParen(src, open);
        assert.ok(close > open, `nie da się sparsować transakcji w ${file}`);
        const call = src.slice(open, close + 1);
        inspected += 1;
        if (/retries:\s*0\b/.test(call)) continue;
        const effect = call.match(EXTERNAL_EFFECT);
        if (effect) problems.push(`${file.replace(ROOT, '')}: ${effect[0]}`);
      }
    }
    assert.ok(inspected > 50, `sprawdzono tylko ${inspected} transakcji`);
    assert.deepEqual(problems, []);
  });

  test('wykrywacz łapie transakcję z transportem (kontrola samego testu)', () => {
    const src = 'db.transaction(async (tx) => { await transport.send({ to: "x" }); }, { retries: 1 })';
    const close = matchParen(src, src.indexOf('('));
    assert.match(src.slice(0, close + 1), EXTERNAL_EFFECT);
  });
});

// --- 405 zawsze z Allow -----------------------------------------------------

describe('#156: każde 405 ma nagłówek Allow', () => {
  test('statycznie: żadne 405 w src/pg/** nie powstaje bez Allow (ani przez RequestError)', () => {
    const problems = [];
    for (const file of sourceFiles(join(ROOT, 'src', 'pg'))) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        if (/new \w*Error\(\s*'method_not_allowed'/.test(line) && !/Allow/.test(line)) problems.push(`${file.replace(ROOT, '')}:${index + 1} wyjątek zamiast odpowiedzi z Allow`);
        if (/json\(\s*\{\s*error:\s*'method_not_allowed'\s*\}\s*,\s*405\s*\)/.test(line)) problems.push(`${file.replace(ROOT, '')}:${index + 1} 405 bez Allow`);
        if (/name:\s*'method'\s*\}/.test(line)) problems.push(`${file.replace(ROOT, '')}:${index + 1} { name: 'method' } bez allowed (TypeError zamiast 405)`);
        if (/'method_not_allowed'/.test(line) && /405/.test(line) && !/Allow/.test(line)) problems.push(`${file.replace(ROOT, '')}:${index + 1} 405 bez Allow`);
      });
    }
    assert.deepEqual(problems, []);
  });

  test('dynamicznie: nieobsługiwane metody na każdej ścieżce z macierzy tras', async () => {
    const { pglite: db } = await shared();
    try {
      const cookie = await seedUserSession(db, { userId: 'u-admin', mfa: true, roles: [{ role: 'admin' }] });
      const handler = createPgHandler(ROUTES);
      const methodsByPath = new Map();
      for (const entry of ROUTE_MATRIX) {
        const path = entry.path.split('?')[0].replace(/:[A-Za-z]+/g, 'x-1');
        if (!methodsByPath.has(path)) methodsByPath.set(path, new Set());
        methodsByPath.get(path).add(entry.method);
      }
      assert.ok(methodsByPath.size > 30);
      let seen405 = 0;
      for (const [path, supported] of methodsByPath) {
        for (const method of ['PUT', 'PATCH', 'DELETE']) {
          if (supported.has(method)) continue;
          const res = await handler(request(path, { method, cookie }), { db });
          if (res.status !== 405) continue; // 401/403/404/400 wcześniej: nie dotyczy tego testu
          seen405 += 1;
          const allow = res.headers.get('Allow');
          assert.ok(allow, `${method} ${path} -> 405 bez Allow`);
          for (const ok of supported) assert.ok(allow.split(/,\s*/).includes(ok), `${method} ${path}: Allow "${allow}" pomija ${ok}`);
        }
      }
      assert.ok(seen405 > 20, `tylko ${seen405} odpowiedzi 405 w przeglądzie`);
    } finally {
      // baza wspólna: zamyka ją after()
    }
  });

  test('trasy z luk #156 (events ICS, e-mail, księga transferów) zwracają Allow', async () => {
    const { pglite: db } = await shared();
    try {
      const cookie = await seedUserSession(db, { userId: 'u-admin', mfa: true, roles: [{ role: 'admin' }] });
      const handler = createPgHandler(ROUTES);
      const cases = [
        ['POST', '/api/public/events.ics', 'GET'],
        ['DELETE', '/api/email/preferences', 'GET, POST'],
        ['POST', '/api/email/suppressions', 'GET'],
        ['GET', `/api/email/suppressions/${'a'.repeat(64)}/release`, 'POST'],
        ['DELETE', '/api/ledger/transfers', 'GET, POST'],
        ['GET', '/api/ledger/opening-balance/adjustments', 'POST'],
      ];
      for (const [method, path, allow] of cases) {
        const res = await handler(request(path, { method, cookie }), { db });
        assert.equal(res.status, 405, `${method} ${path}`);
        assert.equal(res.headers.get('Allow'), allow, `${method} ${path}`);
      }
    } finally {
      // baza wspólna: zamyka ją after()
    }
  });
});
