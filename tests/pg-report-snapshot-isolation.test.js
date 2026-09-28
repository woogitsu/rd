// #213: raport dla Komisji Rewizyjnej, zestawienie przekazania i widok
// uzgodnienia muszą czytać jedną migawkę bazy (REPEATABLE READ, READ ONLY),
// nie kilka osobnych zapytań w autocommit na puli połączeń — inaczej
// równoległy zapis między zapytaniami daje wewnętrznie sprzeczny dokument
// (patrz opis w issue #213: "sumy kategorii nie są zgodne z bilansem roku"
// mimo poprawnej księgi). Dane wyłącznie syntetyczne (@example.invalid).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestDb, seedSchoolYear } from './helpers/pg.js';
import { readSnapshot } from '../src/pg/db-snapshot.js';

test('readSnapshot: transakcja jest REPEATABLE READ i READ ONLY', async () => {
  const db = await createTestDb();
  const { isolation, readOnly } = await readSnapshot(db, async (tx) => {
    const iso = (await tx.query('SHOW transaction_isolation')).rows[0].transaction_isolation;
    const ro = (await tx.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
    return { isolation: iso, readOnly: ro };
  });
  assert.equal(isolation, 'repeatable read');
  assert.equal(readOnly, 'on');
  await db.close();
});

test('readSnapshot: próba zapisu wewnątrz migawki jest odrzucona (READ ONLY)', async () => {
  const db = await createTestDb();
  await seedSchoolYear(db, 'y-ro');
  await assert.rejects(
    readSnapshot(db, async (tx) => {
      await tx.query(`UPDATE school_years SET label = 'x' WHERE id = 'y-ro'`);
    }),
  );
  await db.close();
});

// Kryterium akceptacji #213: "W trasach raportowych nie ma Promise.all na
// env.db" — prosty test statyczny (przegląd tekstu pliku), bo prawdziwa
// współbieżność na PGlite i tak nie odtwarza przeplotu między połączeniami
// (PGlite serializuje transakcje — patrz uwaga w treści issue).
function readSource(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

test('reconciliation.js: buildAuditReport i getReconciliation nie używają Promise.all na env.db/tx', () => {
  const source = readSource('../src/pg/routes/reconciliation.js');
  const buildAuditReport = source.slice(
    source.indexOf('export async function buildAuditReport'),
    source.indexOf('async function auditReport'),
  );
  assert.doesNotMatch(buildAuditReport, /Promise\.all\(/, 'buildAuditReport musi czytać sekwencyjnie w jednej migawce');

  const getReconciliation = source.slice(
    source.indexOf('async function getReconciliation'),
    source.indexOf('async function importLines'),
  );
  assert.doesNotMatch(getReconciliation, /Promise\.all\(/, 'getReconciliation musi czytać sekwencyjnie w jednej migawce');
});

test('year-close.js: handover nie używa Promise.all na env.db', () => {
  const source = readSource('../src/pg/routes/year-close.js');
  // handover jest ostatnią funkcją handlera przed export async function
  // handle(...) w tym pliku — bierzemy tekst między nimi.
  const handover = source.slice(
    source.indexOf('async function handover'),
    source.indexOf('export async function handle'),
  );
  assert.doesNotMatch(handover, /Promise\.all\(/, 'handover musi czytać sekwencyjnie w jednej migawce (#213)');
});
