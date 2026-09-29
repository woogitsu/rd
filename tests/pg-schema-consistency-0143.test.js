// #198, część 2 (migracja 0143): news_photos.document_id -> documents(id) z
// kontrolą rodzaju dokumentu oraz walidacja role_grants_class_in_year.
// Wyłącznie dane syntetyczne (@example.invalid).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { registerPhoto } from '../src/pg/news.js';
import { loadMigrations } from '../src/postgres-migrations.js';
import { createTestDb, seedClass, seedDocument, seedUser } from './helpers/pg.js';

const migrationsDirectory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));
const TARGET = '0143_news_photo_document_fk_and_role_grants_validate.sql';
const admin = { userId: 'admin', grants: [{ role: 'admin', classId: null, schoolYearId: null }], mfaVerified: true };

// Baza po wszystkich migracjach przed 0143 — do sprawdzania zachowania
// migracji na istniejących (naruszających) danych.
async function dbBefore0143() {
  const migrations = await loadMigrations(migrationsDirectory);
  const db = new PGlite();
  for (const migration of migrations.filter((item) => item.name < TARGET)) await db.exec(migration.sql);
  await seedUser(db, { userId: 'admin' });
  return { db, target: migrations.find((item) => item.name === TARGET) };
}

const insertPhoto = (db, id, documentId) => db.query(
  `INSERT INTO news_photos (id, document_id, author, source, taken_on, license_text, depicts_children, uploaded_by, alt_text)
   VALUES ($1, $2, 'Autor testowy', 'own_work', '2026-10-10', 'Zdjęcie własne autora (syntetyczne)', false, 'admin', 'Opis zdjęcia')`,
  [id, documentId],
);

const photoInput = (documentId, key) => ({
  documentId, author: 'Fotograf testowy', source: 'own_work', takenOn: '2026-10-10',
  licenseText: 'Zdjęcie własne autora, udostępnione Radzie do publikacji.',
  altText: 'Stół kiermaszowy z ciastami', depictsChildren: false, idempotencyKey: key,
});

test('news_photos: zdjęcie z nieistniejącym dokumentem jest odrzucone, dokument zarządu przechodzi', async () => {
  const db = await createTestDb();
  try {
    await seedUser(db, { userId: 'admin' });
    await assert.rejects(insertPhoto(db, 'p-none', 'no-such-doc'), /news_photo_document_not_found/);
    await seedDocument(db, { id: 'doc-board' });
    await insertPhoto(db, 'p-ok', 'doc-board');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM news_photos")).rows[0].n, 1);
  } finally { await db.close(); }
});

test('news_photos: dokument finansowy, klasy i spoza API (np. z D1) jest odrzucony jako źródło zdjęcia', async () => {
  const db = await createTestDb();
  try {
    await seedUser(db, { userId: 'admin' });
    for (const kind of ['financial', 'class', 'receipt']) {
      await seedDocument(db, { id: `doc-${kind}`, kind });
      await assert.rejects(insertPhoto(db, `p-${kind}`, `doc-${kind}`), /news_photo_document_not_allowed/, kind);
    }
    assert.equal((await db.query('SELECT count(*)::int AS n FROM news_photos')).rows[0].n, 0);
    // Nic nie zostało zapisane także przez API: kody błędów zamiast 503.
    await assert.rejects(registerPhoto(db, admin, photoInput('doc-financial', 'photo-key-000001')), { code: 'invalid_document_id', status: 400 });
    await assert.rejects(registerPhoto(db, admin, photoInput('no-such-doc', 'photo-key-000002')), { code: 'invalid_document_id', status: 400 });
    await seedDocument(db, { id: 'doc-board' });
    const { photo, replayed } = await registerPhoto(db, admin, photoInput('doc-board', 'photo-key-000003'));
    assert.equal(photo.documentId, 'doc-board');
    assert.equal(replayed, false);
    assert.equal((await registerPhoto(db, admin, photoInput('doc-board', 'photo-key-000003'))).replayed, true);
  } finally { await db.close(); }
});

test('news_photos.document_id: klucz obcy i role_grants_class_in_year są zwalidowane', async () => {
  const db = await createTestDb();
  try {
    const { rows } = await db.query(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conname IN ('news_photos_document_fk', 'role_grants_class_in_year') ORDER BY conname`,
    );
    assert.deepEqual(rows, [
      { conname: 'news_photos_document_fk', convalidated: true },
      { conname: 'role_grants_class_in_year', convalidated: true },
    ]);
  } finally { await db.close(); }
});

test('migracja 0143 na poprawnych danych przechodzi i waliduje ograniczenia', async () => {
  const { db, target } = await dbBefore0143();
  try {
    await seedClass(db, { id: 'c-ok', schoolYearId: 'y-2026' });
    await seedUser(db, { userId: 'u-rep' });
    await db.query(`INSERT INTO role_grants (id, user_id, role, class_id, school_year_id)
                    VALUES ('rg-ok', 'u-rep', 'representative', 'c-ok', 'y-2026')`);
    await seedDocument(db, { id: 'doc-board' });
    await insertPhoto(db, 'p-ok', 'doc-board');
    await db.exec(target.sql);
    const { rows } = await db.query(
      "SELECT convalidated FROM pg_constraint WHERE conname IN ('news_photos_document_fk', 'role_grants_class_in_year')",
    );
    assert.deepEqual(rows.map((row) => row.convalidated), [true, true]);
  } finally { await db.close(); }
});

test('migracja 0143 zatrzymuje się z identyfikatorem przydziału klasy spoza roku i niczego nie zmienia', async () => {
  const { db, target } = await dbBefore0143();
  try {
    await seedClass(db, { id: 'c-2025', schoolYearId: 'y-2025' });
    await seedClass(db, { id: 'c-2026', schoolYearId: 'y-2026' });
    await seedUser(db, { userId: 'u-rep' });
    // Wiersz sprzed 0081 (albo z zapisu z pominięciem ograniczeń): triggery i FK wyłączone.
    await db.exec(`SET session_replication_role = replica;
      INSERT INTO role_grants (id, user_id, role, class_id, school_year_id)
      VALUES ('rg-mismatch-1', 'u-rep', 'representative', 'c-2025', 'y-2026');
      SET session_replication_role = origin;`);
    await assert.rejects(db.exec(target.sql), /role_grants_class_out_of_year: 1 .*rg-mismatch-1/);
    const { rows } = await db.query("SELECT convalidated FROM pg_constraint WHERE conname = 'role_grants_class_in_year'");
    assert.equal(rows[0].convalidated, false, 'ograniczenie nie zostało po cichu zwalidowane');
    assert.equal((await db.query("SELECT school_year_id FROM role_grants WHERE id = 'rg-mismatch-1'")).rows[0].school_year_id, 'y-2026', 'dane nie zostały przepisane');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'news_photos_document_fk'")).rows[0].n, 0, 'transakcja migracji wycofana w całości');
  } finally { await db.close(); }
});

test('migracja 0143 zatrzymuje się na zdjęciu z nieistniejącym dokumentem (identyfikator zdjęcia w błędzie)', async () => {
  const { db, target } = await dbBefore0143();
  try {
    await insertPhoto(db, 'p-orphan', 'no-such-doc');
    await assert.rejects(db.exec(target.sql), /news_photo_document_not_found: 1 .*p-orphan/);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM news_photos")).rows[0].n, 1, 'zdjęcie nie zostało usunięte');
  } finally { await db.close(); }
});

test('migracja 0143 zatrzymuje się na zdjęciu wskazującym dokument finansowy', async () => {
  const { db, target } = await dbBefore0143();
  try {
    await seedDocument(db, { id: 'doc-fin', kind: 'financial' });
    await insertPhoto(db, 'p-fin', 'doc-fin');
    await assert.rejects(db.exec(target.sql), /news_photo_document_not_allowed: 1 .*p-fin/);
  } finally { await db.close(); }
});
