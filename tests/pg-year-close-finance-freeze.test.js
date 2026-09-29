// Zamrożenie zamkniętego roku szkolnego — luki z #80: uzgodnienia rachunku (0015),
// dokumenty (0006) i kampanie e-mail (0007). Wyłącznie dane syntetyczne.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createMemoryStorage } from '../src/storage.js';
import { createTestDb, request, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';

const OLD = 'y-closed-test';
const NEW = 'y-next-test';

// Świadome wyjątki od zamrożenia: tabele z kolumną school_year_id / class_id,
// które NIE mają triggera a0_year_freeze. Każdy wpis wymaga uzasadnienia
// (docs/YEAR_CLOSE.md, migracja 0113). Nowa tabela z rokiem/klasą bez triggera
// i bez wpisu tutaj psuje test przeglądowy poniżej.
const FREEZE_EXCEPTIONS = {
  school_year_closures: 'sam rekord zamknięcia; chroni go year_close_guard (0017)',
  export_runs: 'eksport archiwum zamkniętego roku ma działać po zamknięciu (0016)',
  data_access_log: 'rejestr dostępu (RODO) musi przyjmować zapisy zawsze (0067)',
  privacy_notices: 'informacja o przetwarzaniu danych nie zależy od stanu roku (0075, D-06)',
};

// Zamknięcie „na skróty” wyłącznie w bazie testowej (jak w
// tests/pg-school-year-dates.test.js i tests/security-scope-api.test.js):
// pomija listę kontrolną i procedurę /close, bo interesuje nas wyłącznie
// odpowiedź triggera a0_year_freeze na tabelach z #80, nie sama procedura
// zamknięcia (pokryta przez tests/pg-year-close.test.js). WAŻNE: wszystko, co
// ma odwoływać się do roku OLD (przydziały ról przez seedUserSession, wiersze
// zakładane przed zamknięciem), trzeba przygotować PRZED wywołaniem tej
// funkcji — nowy INSERT do roku OLD po jej wywołaniu ma się nie udać.
async function closeYear(db) {
  await seedSchoolYear(db, OLD, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, NEW, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  await db.exec(`
    SET session_replication_role = replica;
    INSERT INTO school_year_closures (id, school_year_id, next_school_year_id, status, initiated_by,
      closed_by, closed_at, income_cents, expense_cents, opening_balance_cents, closing_balance_cents,
      carried_opening_balance_id, expired_grant_count)
    VALUES ('clo-1', '${OLD}', '${NEW}', 'closed', 'u-a', 'u-b', now(), 0, 0, 0, 0, 'ob-next', 0);
    SET session_replication_role = origin;
  `);
}

// #80, kryterium akceptacji: test przeglądowy WYLICZA z katalogu bazy wszystkie
// tabele z kolumną school_year_id lub class_id (oraz samą school_years) i
// wymaga triggera a0_year_freeze albo wpisu w FREEZE_EXCEPTIONS. Dodanie
// nowej tabeli z rokiem bez decyzji psuje ten test.
test('#80: każda tabela z school_year_id/class_id (i school_years) ma trigger zamrożenia albo uzasadniony wyjątek', async () => {
  const db = await createTestDb();
  try {
    const { rows: tables } = await db.query(
      `SELECT DISTINCT c.table_name FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          AND c.column_name IN ('school_year_id', 'class_id')
        UNION SELECT 'school_years'`,
    );
    const { rows: triggers } = await db.query(
      `SELECT c.relname AS table_name FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
        WHERE t.tgname = 'a0_year_freeze' AND NOT t.tgisinternal`,
    );
    const withTrigger = new Set(triggers.map((r) => r.table_name));
    const names = tables.map((r) => r.table_name);
    assert.ok(names.length >= 30, `katalog zwrócił podejrzanie mało tabel: ${names.length}`);
    assert.ok(names.includes('classes') && names.includes('school_years') && names.includes('news_posts'));
    const missing = names.filter((name) => !withTrigger.has(name) && !(name in FREEZE_EXCEPTIONS));
    assert.deepEqual(missing, [], 'tabele bez triggera a0_year_freeze i bez wpisu w FREEZE_EXCEPTIONS');
    // Lista wyjątków musi być prawdziwa: tabela istnieje i naprawdę nie ma triggera.
    for (const name of Object.keys(FREEZE_EXCEPTIONS)) {
      assert.ok(names.includes(name), `wyjątek ${name} nie odpowiada tabeli z rokiem/klasą`);
      assert.ok(!withTrigger.has(name), `wyjątek ${name} ma trigger — usuń wpis z FREEZE_EXCEPTIONS`);
      assert.ok(FREEZE_EXCEPTIONS[name].length > 10);
    }
  } finally {
    await db.close();
  }
});

describe('#80 (0113): pozostałe tabele z rokiem i granice roku', () => {
  test('school_years i classes zamkniętego roku: UPDATE/DELETE/INSERT → school_year_closed; otwarty rok bez zmian', async () => {
    const db = await createTestDb();
    try {
      await seedSchoolYear(db, OLD, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
      await db.query(`INSERT INTO classes (id, school_year_id, name) VALUES ('c-old', $1, '1A')`, [OLD]);
      await closeYear(db);
      await db.query(`INSERT INTO classes (id, school_year_id, name) VALUES ('c-new', $1, '1A')`, [NEW]);

      // Atak z komentarza do #80: przesunięcie granic zamkniętego roku.
      await assert.rejects(db.query(`UPDATE school_years SET ends_on = '2027-12-31' WHERE id = $1`, [OLD]), /school_year_closed/);
      await assert.rejects(db.query(`UPDATE school_years SET label = 'inna' WHERE id = $1`, [OLD]), /school_year_closed/);
      await assert.rejects(db.query(`DELETE FROM school_years WHERE id = $1`, [OLD]), /school_year_closed/);
      const { rows } = await db.query(`SELECT to_char(ends_on, 'YYYY-MM-DD') AS e FROM school_years WHERE id = $1`, [OLD]);
      assert.equal(rows[0].e, '2027-08-31');

      await assert.rejects(db.query(`UPDATE classes SET name = '1Z' WHERE id = 'c-old'`), /school_year_closed/);
      await assert.rejects(db.query(`DELETE FROM classes WHERE id = 'c-old'`), /school_year_closed/);
      await assert.rejects(db.query(`INSERT INTO classes (id, school_year_id, name) VALUES ('c-old2', $1, '2B')`, [OLD]), /school_year_closed/);

      // Rok następny (otwarty) działa normalnie.
      await db.query(`UPDATE classes SET name = '1B' WHERE id = 'c-new'`);
      await db.query(`UPDATE school_years SET label = 'nowa etykieta' WHERE id = $1`, [NEW]);
    } finally {
      await db.close();
    }
  });

  // Trigger BEFORE INSERT odpala się przed sprawdzeniem NOT NULL/CHECK/FK, więc
  // wystarczą minimalne wiersze: dla zamkniętego roku błąd to school_year_closed,
  // dla otwartego (kontrola pozytywna) błąd musi być INNY — inaczej trigger
  // odrzucałby wszystko.
  const INSERTS = {
    enrollment_history: (y) => [`INSERT INTO enrollment_history (id, school_year_id) VALUES ('t1', $1)`, [y]],
    import_batches: (y) => [`INSERT INTO import_batches (id, school_year_id) VALUES ('t2', $1)`, [y]],
    invitations: (y) => [`INSERT INTO invitations (id, school_year_id) VALUES ('t3', $1)`, [y]],
    payment_instructions: (y) => [`INSERT INTO payment_instructions (id, school_year_id) VALUES ('t4', $1)`, [y]],
    payment_references: (y) => [`INSERT INTO payment_references (id, school_year_id) VALUES ('t5', $1)`, [y]],
    news_posts: (y) => [`INSERT INTO news_posts (id, school_year_id) VALUES ('t6', $1)`, [y]],
  };
  for (const [table, build] of Object.entries(INSERTS)) {
    test(`${table}: nowy wiersz zamkniętego roku → school_year_closed, otwartego → inny błąd`, async () => {
      const db = await createTestDb();
      try {
        await seedSchoolYear(db, OLD, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
        await closeYear(db);
        await assert.rejects(db.query(...build(OLD)), /school_year_closed/);
        await assert.rejects(db.query(...build(NEW)), (error) => !/school_year_closed/.test(String(error.message)));
      } finally {
        await db.close();
      }
    });
  }

  test('wariant zachowawczy: istniejące zaproszenie i wpis aktualności zamkniętego roku można wycofać (UPDATE nie jest blokowany)', async () => {
    const db = await createTestDb();
    try {
      await seedSchoolYear(db, OLD, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
      await seedUser(db, { userId: 'u-a' });
      await db.query(
        `INSERT INTO invitations (id, email, token_hash, role, created_by, expires_at, school_year_id)
         VALUES ('inv-1', 'rodzic@example.invalid', repeat('a', 64), 'board', 'u-a', now() + interval '1 day', $1)`,
        [OLD],
      );
      await db.query(
        `INSERT INTO news_posts (id, school_year_id, title, body, created_by, updated_by)
         VALUES ('np-1', $1, 'Tytuł', 'Treść', 'u-a', 'u-a')`,
        [OLD],
      );
      await closeYear(db);
      // Ten UPDATE nie może zostać odrzucony przez a0_year_freeze (mogą go
      // odrzucić inne reguły tabeli — wtedy błąd jest inny niż school_year_closed).
      for (const sql of [
        `UPDATE invitations SET expires_at = now() WHERE id = 'inv-1'`,
        `UPDATE news_posts SET updated_at = now() WHERE id = 'np-1'`,
      ]) {
        try { await db.query(sql); } catch (error) {
          assert.doesNotMatch(String(error.message), /school_year_closed/, sql);
        }
      }
    } finally {
      await db.close();
    }
  });

  test('POST /api/admin/school-years/{rok}/classes dla zamkniętego roku zwraca 409 school_year_closed, nie 503', async () => {
    const db = await createTestDb();
    try {
      await seedSchoolYear(db, OLD, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
      const cookie = await seedUserSession(db, { userId: 'u-adm', mfa: true, roles: [{ role: 'admin' }] });
      await closeYear(db);
      const res = await handlePgRequest(request(`/api/admin/school-years/${OLD}/classes`, {
        method: 'POST', cookie, body: { names: ['3C'] },
      }), { db });
      assert.equal(res.status, 409);
      assert.equal((await res.json()).error, 'school_year_closed');
    } finally {
      await db.close();
    }
  });
});

describe('#80: uzgodnienia rachunku zamkniętego roku', () => {
  test('nowe uzgodnienie, import, dopasowanie i cofnięcie dopasowania kończą się school_year_closed', async () => {
    const db = await createTestDb();
    try {
      // Uzgodnienie zakładane, gdy rok jest jeszcze otwarty (a0_year_freeze na
      // bank_reconciliations pozwala na ten INSERT); dopiero potem zamykamy
      // rok, żeby sprawdzić trigger year_freeze_via_parent na tabelach
      // podrzędnych bez przechodzenia przez procedurę /close.
      await seedSchoolYear(db, OLD, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
      await seedUser(db, { userId: 'u-a' });
      await db.query(
        `INSERT INTO bank_reconciliations
           (id, school_year_id, statement_date, statement_balance_cents, ledger_balance_cents,
            ledger_non_bank_cents, reference_salt, created_by, idempotency_key)
         VALUES ('br-open', $1, '2027-01-15', 0, 0, 0, repeat('b', 32), 'u-a', 'br-open-key-1')`,
        [OLD],
      );
      await closeYear(db);

      // Uzgodnienie i jego elementy podrzędne wstawione bezpośrednio (obejście
      // API), by sprawdzić sam trigger niezależnie od walidacji tras.
      await assert.rejects(
        db.query(
          `INSERT INTO bank_reconciliations
             (id, school_year_id, statement_date, statement_balance_cents, ledger_balance_cents,
              ledger_non_bank_cents, reference_salt, created_by, idempotency_key)
           VALUES ('br-1', $1, '2027-01-15', 0, 0, 0, repeat('a', 32), 'u-a', 'br-1-key-1')`,
          [OLD],
        ),
        /school_year_closed/,
      );

      await assert.rejects(
        db.query(
          `INSERT INTO bank_statement_imports (id, reconciliation_id, source, line_count, request_hash, created_by, idempotency_key)
           VALUES ('bsi-1', 'br-open', 'manual', 1, repeat('c', 64), 'u-a', 'bsi-1-key-1')`,
        ),
        /school_year_closed/,
      );
      await assert.rejects(
        db.query(
          `INSERT INTO bank_statement_lines (id, reconciliation_id, import_id, line_no, booked_on, amount_cents, created_by)
           VALUES ('bsl-1', 'br-open', 'bsi-missing', 1, '2027-01-10', 100, 'u-a')`,
        ),
        /school_year_closed|violates foreign key/,
      );
      await assert.rejects(
        db.query(
          `INSERT INTO bank_reconciliation_matches (id, reconciliation_id, statement_line_id, ledger_entry_id, created_by, idempotency_key)
           VALUES ('brm-1', 'br-open', 'bsl-missing', NULL, 'u-a', 'brm-1-key-1')`,
        ),
        /school_year_closed|violates foreign key/,
      );
    } finally {
      await db.close();
    }
  });

  test('POST /api/reconciliations dla zamkniętego roku zwraca 409, nie 503', async () => {
    const db = await createTestDb();
    try {
      await seedSchoolYear(db, OLD, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
      const cookie = await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: OLD }] });
      await closeYear(db);
      const res = await handlePgRequest(request('/api/reconciliations', {
        method: 'POST', cookie, headers: { 'Idempotency-Key': 'rec-close-key-1' },
        body: { schoolYearId: OLD, statementDate: '2027-01-15', statementBalanceCents: 0 },
      }), { db });
      assert.equal(res.status, 409);
      const body = await res.json();
      assert.equal(body.error, 'school_year_closed');
    } finally {
      await db.close();
    }
  });
});

describe('#80: dokumenty zamkniętego roku', () => {
  test('nowy dokument (dowolnego rodzaju) przypisany do zamkniętego roku → INSERT school_year_closed', async () => {
    const db = await createTestDb();
    try {
      await seedSchoolYear(db, OLD, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
      await seedUser(db, { userId: 'u-a' });
      await closeYear(db);
      await assert.rejects(
        db.query(
          `INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by, school_year_id, sha256, idempotency_key)
           VALUES ('doc-1', 'docs/00000000-0000-0000-0000-000000000001', 'application/pdf', 10, 'financial', 'u-a',
                   $1, repeat('a', 64), 'doc-1-key-1')`,
          [OLD],
        ),
        /school_year_closed/,
      );
    } finally {
      await db.close();
    }
  });

  test('POST /api/documents dla zamkniętego roku zwraca 409, nie 503', async () => {
    const db = await createTestDb();
    try {
      await seedSchoolYear(db, OLD, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
      const cookie = await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: OLD }] });
      await closeYear(db);
      const storage = createMemoryStorage();
      const bytes = new TextEncoder().encode('%PDF-1.4\n% syntetyczny\n%%EOF\n');
      const res = await handlePgRequest(request(`/api/documents?kind=financial&schoolYearId=${OLD}`, {
        method: 'POST', cookie, body: bytes,
        headers: { 'Content-Type': 'application/pdf', 'Idempotency-Key': 'doc-close-key-1' },
      }), { db, storage });
      assert.equal(res.status, 409);
      const body = await res.json();
      assert.equal(body.error, 'school_year_closed');
    } finally {
      await db.close();
    }
  });
});

describe('#80: kampanie e-mail zamkniętego roku', () => {
  test('nowa kampania przypisana do zamkniętego roku → INSERT school_year_closed', async () => {
    const db = await createTestDb();
    try {
      await seedSchoolYear(db, OLD, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
      await seedUser(db, { userId: 'u-a' });
      await closeYear(db);
      await assert.rejects(
        db.query(
          `INSERT INTO email_campaigns (id, school_year_id, title, audience, subject, body_text, content_hash, created_by, updated_by, idempotency_key)
           VALUES ('cmp-1', $1, 'Test', 'all_households', 'Temat', 'Treść wiadomości testowej o dostatecznej długości.', repeat('a', 64), 'u-a', 'u-a', 'cmp-1-key-1')`,
          [OLD],
        ),
        /school_year_closed/,
      );
    } finally {
      await db.close();
    }
  });

  test('POST /api/email/campaigns dla zamkniętego roku zwraca 409, nie 503', async () => {
    const db = await createTestDb();
    try {
      await seedSchoolYear(db, OLD, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
      const cookie = await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: OLD }] });
      await closeYear(db);
      const res = await handlePgRequest(request('/api/email/campaigns', {
        method: 'POST', cookie, headers: { 'Idempotency-Key': 'cmp-close-key-1' },
        body: {
          schoolYearId: OLD, title: 'Test', audience: 'all_households', subject: 'Dobrowolna składka',
          bodyText: 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}.',
        },
      }), { db, APP_ENV: 'development', EMAIL_SENDING_ENABLED: 'true' });
      assert.equal(res.status, 409);
      const body = await res.json();
      assert.equal(body.error, 'school_year_closed');
    } finally {
      await db.close();
    }
  });
});
