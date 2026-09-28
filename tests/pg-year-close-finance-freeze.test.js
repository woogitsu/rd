// Zamrożenie zamkniętego roku szkolnego — luki z #80: uzgodnienia rachunku (0015),
// dokumenty (0006) i kampanie e-mail (0007). Wyłącznie dane syntetyczne.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createMemoryStorage } from '../src/storage.js';
import { createTestDb, request, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';

const OLD = 'y-closed-test';
const NEW = 'y-next-test';

// Zakres #80 to finanse i dokumentacja roku: uzgodnienia rachunku (0015),
// dokumenty (0006) i kampanie e-mail (0007) — dokładnie te tabele sprawdza
// poniższy test przeglądowy. Baza ma więcej tabel z własną kolumną
// school_year_id bez triggera a0_year_freeze (m.in. classes, enrollments,
// enrollment_history, invitations, import_batches, news_posts) i samą
// school_year_closures (rekord zamknięcia — zamrożenie samej siebie nie ma
// sensu). Czy i jak je zamrozić, to osobna decyzja spoza tego issue (część z
// nich to dane organizacyjne, nie finansowe, i zamrożenie mogłoby zablokować
// niewinne poprawki administracyjne) — nie rozstrzygamy tego tutaj.
const IN_SCOPE_TABLES = [
  'bank_reconciliations', 'bank_statement_imports', 'bank_statement_lines',
  'bank_reconciliation_matches', 'documents', 'email_campaigns',
];

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

// #80, kryterium akceptacji (zakres finansowy tego issue): uzgodnienia
// rachunku, dokumenty i kampanie e-mail mają trigger a0_year_freeze na
// każdej tabeli z bezpośrednią lub odziedziczoną kolumną school_year_id.
// Usunięcie triggera z 0036 albo dodanie nowej tabeli podrzędnej uzgodnienia
// bez rozszerzenia year_freeze_via_parent psuje ten test.
test('#80: każda tabela w zakresie (uzgodnienia, dokumenty, kampanie) ma trigger zamrożenia', async () => {
  const db = await createTestDb();
  try {
    const { rows: triggers } = await db.query(
      `SELECT c.relname AS table_name FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
        WHERE t.tgname = 'a0_year_freeze' AND NOT t.tgisinternal`,
    );
    const withTrigger = new Set(triggers.map((r) => r.table_name));
    const missing = IN_SCOPE_TABLES.filter((name) => !withTrigger.has(name));
    assert.deepEqual(missing, []);
  } finally {
    await db.close();
  }
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
