// #131: eksport CSV/XLSX tabeli „Statystyki klas” — te same uprawnienia, zakres i liczby co widok.
// Dane wyłącznie syntetyczne (.invalid).
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';

const Y = 'y-2026';
const Y_OTHER = 'y-2025';

async function raw(env, path, cookie, method = 'GET') {
  const response = await handlePgRequest(request(path, { cookie, method }), env);
  return { status: response.status, headers: response.headers, bytes: new Uint8Array(await response.arrayBuffer()) };
}
const textOf = (result) => new TextDecoder().decode(result.bytes);

async function seed(db) {
  await seedSchoolYear(db, Y);
  await seedSchoolYear(db, Y_OTHER);
  await seedClass(db, { id: 'c-1a', schoolYearId: Y, name: '1A' });
  await seedClass(db, { id: 'c-1b', schoolYearId: Y, name: '=1B' });
  await seedUser(db, { userId: 'u-seed' });
  const households = ['h-1', 'h-2', 'h-3', 'h-4', 'h-5', 'h-6'];
  await db.exec(`
    INSERT INTO households (id) VALUES ${households.map((id) => `('${id}')`).join(', ')};
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
      ${households.map((id, i) => `('g-${i + 1}', '${id}', 'Imie${i + 1}', 'Nazwisko${i + 1}', ${i === 1 ? 'NULL' : `'g${i + 1}@example.invalid'`}, true)`).join(',\n      ')};
    INSERT INTO students (id, household_id, first_name, last_name) VALUES
      ${households.map((id, i) => `('s-${i + 1}', '${id}', 'Uczen${i + 1}', 'Nazwisko${i + 1}')`).join(',\n      ')};
    INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES
      ${households.map((_, i) => `('s-${i + 1}', 'g-${i + 1}', true, true)`).join(', ')};
    INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
      ('e-1', 's-1', 'c-1a', '${Y}'), ('e-2', 's-2', 'c-1a', '${Y}'), ('e-3', 's-3', 'c-1a', '${Y}'),
      ('e-4', 's-4', 'c-1a', '${Y}'), ('e-5', 's-5', 'c-1a', '${Y}'), ('e-6', 's-6', 'c-1b', '${Y}');
    INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key)
      VALUES ('p-1', 'h-1', '${Y}', 10000, '2026-10-01', 'bank', 'recorded', 'u-seed', 'syn-key-p-1'),
             ('p-2', 'h-2', '${Y}', 2500, '2026-10-01', 'bank', 'recorded', 'u-seed', 'syn-key-p-2'),
             ('p-u', NULL, '${Y}', 1500, '2026-10-01', 'bank', 'unmatched', 'u-seed', 'syn-key-p-u');
  `);
}

// Wiersz CSV -> komórki (uproszczenie wystarczające: dane testowe nie mają średników ani cudzysłowów w komórkach).
const csvLines = (text) => text.replace(/^﻿/, '').split('\r\n').filter((line) => line !== '');

describe('eksport statystyk klas (#131)', () => {
  test('granice ról i sesji jak w widoku; nieprawidłowe wejście; metoda', async () => {
    const db = await createTestDb();
    await seed(db);
    const env = { db };
    const rep = await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: Y }] });
    const treasurer = await seedUserSession(db, { userId: 'u-treas', roles: [{ role: 'treasurer', schoolYearId: Y }], mfa: true });
    const audit = await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit' }], mfa: true });
    const board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: Y }], mfa: true });
    for (const format of ['csv', 'xlsx']) {
      const path = `/api/board/overview/export.${format}?schoolYearId=${Y}`;
      for (const cookie of [rep, treasurer, audit]) assert.equal((await raw(env, path, cookie)).status, 403);
      assert.equal((await raw(env, path)).status, 401);
      assert.equal((await raw(env, `/api/board/overview/export.${format}?schoolYearId=${Y_OTHER}`, board)).status, 404, 'rok poza przydziałem');
      assert.equal((await raw(env, `/api/board/overview/export.${format}?schoolYearId=..%2Fx`, board)).status, 400);
      assert.equal((await raw(env, `/api/board/overview/export.${format}`, board)).status, 400);
      const post = await raw(env, path, board, 'POST');
      assert.notEqual(post.status, 200);
    }
    assert.equal(await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'board.overview.exported'").then((r) => r.rows[0].n), 0, 'odmowy nie zapisują zdarzeń eksportu');
    await db.close();
  });

  test('admin z MFA: CSV ma te same liczby co widok, notę, próg 5 gospodarstw i neutralizację formuł; zdarzenie audytu', async () => {
    const db = await createTestDb();
    await seed(db);
    const env = { db };
    const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
    const view = JSON.parse(textOf(await raw(env, `/api/board/overview?schoolYearId=${Y}`, admin)));
    const csv = await raw(env, `/api/board/overview/export.csv?schoolYearId=${Y}`, admin);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('Content-Type'), /^text\/csv/);
    assert.match(csv.headers.get('Content-Disposition'), /^attachment; filename="statystyki-klas-y-2026-\d{8}\.csv"$/);
    assert.equal(csv.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual([...csv.bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF], 'BOM UTF-8');
    const lines = csvLines(textOf(csv));
    assert.ok(lines.includes(view.note) || lines.includes(`"${view.note}"`), 'stała nota o dobrowolności składki');
    assert.ok(lines.some((line) => line === `Rok szkolny: ${view.schoolYearLabel}`));
    const header = lines.find((line) => line.startsWith('Klasa;'));
    assert.equal(header, 'Klasa;Uczniowie;Gospodarstwa;Przedstawiciele;Zaproszenia;Kontakt e-mail;Do kartki;Wpisy wpłat (informacyjnie)');
    const dataLines = lines.slice(lines.indexOf(header) + 1).filter((line) => /^[^;]+;\d+;/.test(line));
    assert.equal(dataLines.length, view.classes.length + 1);
    const expected = (entry, label) => [
      label, entry.studentCount, entry.householdCount, entry.representative.active, entry.representative.pendingInvites,
      entry.contactEmailCount, entry.noContactCount,
      Number.isFinite(entry.paymentEntryRatePercent) ? `${entry.paymentEntryRatePercent}%` : '—',
    ].join(';');
    for (const entry of view.classes) {
      const label = entry.name.startsWith('=') ? `'${entry.name}` : entry.name;
      assert.ok(dataLines.includes(expected(entry, label)), `wiersz klasy ${entry.name}`);
    }
    assert.ok(dataLines.includes(expected(view.totals, 'Razem')), 'wiersz Razem');
    // 1A: 5 gospodarstw (próg spełniony), 2 z wpisem netto > 0 = 40%; 1B: 1 gospodarstwo → „—”.
    assert.ok(dataLines.some((line) => line.startsWith('1A;5;5;') && line.endsWith(';40%')));
    assert.ok(dataLines.some((line) => line.startsWith("'=1B;1;1;") && line.endsWith(';—')));
    assert.ok(lines.some((line) => line.startsWith('Wpłaty bez przypisania do rodziny: 1.')));

    const text = textOf(csv);
    assert.doesNotMatch(text, /h-\d|g-\d|Imie|Nazwisko|Uczen|example\.invalid/, 'bez identyfikatorów, imion i e-maili');
    assert.doesNotMatch(text, /dłużnik|zaległoś/i);

    const events = (await db.query("SELECT actor_id, entity_type, entity_id, metadata_json FROM audit_events WHERE action = 'board.overview.exported'")).rows;
    assert.equal(events.length, 1);
    assert.equal(events[0].actor_id, 'u-admin');
    assert.equal(events[0].entity_id, Y);
    const metadata = typeof events[0].metadata_json === 'string' ? JSON.parse(events[0].metadata_json) : events[0].metadata_json;
    assert.deepEqual(metadata, { schoolYearId: Y, format: 'csv', rowCount: 3, scope: 'school', withPaymentColumn: true });
    await db.close();
  });

  test('XLSX: te same dane co CSV, tekst jako inlineStr bez formuł, zdarzenie z formatem xlsx', async () => {
    const db = await createTestDb();
    await seed(db);
    const env = { db };
    const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
    const xlsx = await raw(env, `/api/board/overview/export.xlsx?schoolYearId=${Y}`, admin);
    assert.equal(xlsx.status, 200);
    assert.match(xlsx.headers.get('Content-Type'), /spreadsheetml\.sheet$/);
    assert.match(xlsx.headers.get('Content-Disposition'), /filename="statystyki-klas-y-2026-\d{8}\.xlsx"$/);
    const sheet = strFromU8(unzipSync(xlsx.bytes)['xl/worksheets/sheet1.xml']);
    assert.doesNotMatch(sheet, /<f>|<f /);
    for (const expectedText of ['Klasa', 'Wpisy wpłat (informacyjnie)', '1A', '=1B', 'Razem', '40%', '—']) {
      assert.ok(sheet.includes(`>${expectedText}</t>`), `komórka „${expectedText}”`);
    }
    assert.ok(sheet.includes('Składka jest dobrowolna.'));
    const events = (await db.query("SELECT metadata_json FROM audit_events WHERE action = 'board.overview.exported'")).rows;
    assert.equal(events.length, 1);
    const metadata = typeof events[0].metadata_json === 'string' ? JSON.parse(events[0].metadata_json) : events[0].metadata_json;
    assert.equal(metadata.format, 'xlsx');
    await db.close();
  });

  test('zarząd klasowy: tylko swoja klasa i bez kolumny wpłat; bez wymogu MFA także bez kolumny wpłat', async () => {
    const db = await createTestDb();
    await seed(db);
    const classBoard = await seedUserSession(db, { userId: 'u-cb', roles: [{ role: 'board', classId: 'c-1a', schoolYearId: Y }], mfa: true });
    const env = { db };
    const csv = textOf(await raw(env, `/api/board/overview/export.csv?schoolYearId=${Y}`, classBoard));
    const lines = csvLines(csv);
    const header = lines.find((line) => line.startsWith('Klasa;'));
    assert.equal(header, 'Klasa;Uczniowie;Gospodarstwa;Przedstawiciele;Zaproszenia;Kontakt e-mail;Do kartki');
    assert.ok(lines.some((line) => line.startsWith('1A;5;5;')));
    assert.ok(!csv.includes('=1B'), 'klasa spoza przydziału nie trafia do pliku');
    assert.doesNotMatch(csv, /Wpłaty bez przypisania|%/);
    const view = JSON.parse(textOf(await raw(env, `/api/board/overview?schoolYearId=${Y}`, classBoard)));
    assert.equal(view.scope, 'classes');

    const noMfaEnv = { db, MFA_REQUIRED_ROLES: 'admin' };
    const boardNoMfa = await seedUserSession(db, { userId: 'u-board-nomfa', roles: [{ role: 'board' }] });
    const noMfa = csvLines(textOf(await raw(noMfaEnv, `/api/board/overview/export.csv?schoolYearId=${Y}`, boardNoMfa)));
    assert.equal(noMfa.find((line) => line.startsWith('Klasa;')), 'Klasa;Uczniowie;Gospodarstwa;Przedstawiciele;Zaproszenia;Kontakt e-mail;Do kartki');
    assert.ok(!noMfa.some((line) => /%|Wpłaty bez przypisania/.test(line)));
    await db.close();
  });
});
