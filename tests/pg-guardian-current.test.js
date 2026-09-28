// Jedna definicja „aktualnej” relacji opiekun–dziecko (#157): karta
// gospodarstwa, migawka kampanii i lista klasy dają ten sam zbiór opiekunów
// w dniach granicznych; priorytet kontaktu głównego liczy się wyłącznie z
// relacji bieżącej ze zgodą (komentarz do #157). Dane syntetyczne
// (@example.invalid); bez sieci i bez wysyłki.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { computeSnapshot } from '../src/pg/routes/email.js';
import { buildClassRoster } from '../src/pg/export.js';
import { brusselsDay } from '../src/pg/today.js';
import { createTestDb, request, seedClass, seedUserSession } from './helpers/pg.js';

const YEAR = 'y2026';

const shiftDay = (day, delta) => {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
};

async function guardian(db, id, householdId) {
  await db.query(
    `INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
     VALUES ($1, $2, 'Opiekun', $1, $3, true)`,
    [id, householdId, `${id}@example.invalid`],
  );
}

async function student(db, id, householdId, classId = 'c1') {
  await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, $2, 'Uczeń', $1)", [id, householdId]);
  await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)',
    [`e-${id}`, id, classId, YEAR]);
}

async function link(db, studentId, guardianId, { startsOn = null, endsOn = null, contactAllowed = true, primary = false } = {}) {
  await db.query(
    `INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact, starts_on, ends_on)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [studentId, guardianId, contactAllowed, primary, startsOn, endsOn],
  );
}

test('karta gospodarstwa, migawka kampanii i lista klasy: ten sam zbiór opiekunów w dniach granicznych', async () => {
  const db = await createTestDb();
  try {
    await seedClass(db, { id: 'c1', schoolYearId: YEAR, name: '1A' });
    const today = brusselsDay(new Date());
    // Każdy przypadek graniczny w osobnym gospodarstwie z jednym dzieckiem.
    const cases = {
      open: {},
      endsToday: { endsOn: today },
      endedYesterday: { endsOn: shiftDay(today, -1) },
      startsToday: { startsOn: today },
      startsTomorrow: { startsOn: shiftDay(today, 1) },
    };
    for (const [name, dates] of Object.entries(cases)) {
      await db.query('INSERT INTO households (id) VALUES ($1)', [`h-${name}`]);
      await guardian(db, `g-${name}`, `h-${name}`);
      await student(db, `s-${name}`, `h-${name}`);
      await link(db, `s-${name}`, `g-${name}`, { ...dates, primary: true });
    }
    // Semantyka [starts_on, ends_on] włącznie (0035, zgodnie z #194).
    const expected = ['g-endsToday', 'g-open', 'g-startsToday'];

    const snapshot = await computeSnapshot(db, { school_year_id: YEAR, audience: 'all_households' });
    assert.deepEqual(snapshot.recipients.map((r) => r.guardianId).sort(), expected);

    const { roster } = await buildClassRoster(db, 'c1');
    assert.deepEqual(roster.students.flatMap((s) => s.guardians.map((g) => g.id)).sort(), expected);

    const board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board' }], mfa: true });
    const rep = await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c1', schoolYearId: YEAR }] });
    for (const cookie of [board, rep]) {
      const current = [];
      for (const name of Object.keys(cases)) {
        const response = await handlePgRequest(request(`/api/households/h-${name}`, { cookie }), { db });
        // Przedstawiciel nie widzi gospodarstwa bez bieżącej relacji ze zgodą (#95) — 404.
        if (cookie === rep && !expected.includes(`g-${name}`)) {
          assert.equal(response.status, 404);
          continue;
        }
        assert.equal(response.status, 200, name);
        const body = await response.json();
        for (const g of body.guardians) if (g.relations.length) current.push(g.id);
      }
      assert.deepEqual(current.sort(), expected);
    }
  } finally {
    await db.close();
  }
});

test('migawka: relacja główna wygasła lub bez zgody nie podnosi priorytetu opiekuna (rodzeństwo)', async () => {
  const db = await createTestDb();
  try {
    await seedClass(db, { id: 'c1', schoolYearId: YEAR, name: '1A' });
    const today = brusselsDay(new Date());
    await db.query("INSERT INTO households (id) VALUES ('h-1'), ('h-2')");
    // A sortuje się przed B. Rodzeństwo S1, S2 w h-1.
    await guardian(db, 'g-a', 'h-1');
    await guardian(db, 'g-b', 'h-1');
    await student(db, 's-1', 'h-1');
    await student(db, 's-2', 'h-1');
    // A: kontakt główny dla S1, ale relacja wygasła; aktualna niegłówna relacja z S2.
    await link(db, 's-1', 'g-a', { endsOn: shiftDay(today, -1), primary: true });
    await link(db, 's-2', 'g-a', { primary: false });
    // B: aktualny kontakt główny ze zgodą.
    await link(db, 's-1', 'g-b', { primary: true });

    // h-2: A2 ma bieżącą relację główną BEZ zgody i bieżącą niegłówną ze zgodą.
    await guardian(db, 'g-a2', 'h-2');
    await guardian(db, 'g-b2', 'h-2');
    await student(db, 's-3', 'h-2');
    await student(db, 's-4', 'h-2');
    await link(db, 's-3', 'g-a2', { primary: true, contactAllowed: false });
    await link(db, 's-4', 'g-a2', { primary: false });
    await link(db, 's-3', 'g-b2', { primary: true });

    const first = await computeSnapshot(db, { school_year_id: YEAR, audience: 'all_households' });
    assert.deepEqual(first.recipients.map((r) => `${r.householdId}:${r.guardianId}`),
      ['h-1:g-b', 'h-2:g-b2']);
    // Ponowienie migawki bez zmian: ta sama lista i skrót.
    const again = await computeSnapshot(db, { school_year_id: YEAR, audience: 'all_households' });
    assert.equal(again.hash, first.hash);

    // Bez aktualnej relacji ze zgodą A nie jest kandydatem: B traci zgodę → h-1 wybiera A
    // (ma aktualną relację z S2), a po jej wygaśnięciu h-1 jest bez zgody.
    await db.query("UPDATE student_guardians SET contact_allowed = false WHERE guardian_id = 'g-b'");
    const noB = await computeSnapshot(db, { school_year_id: YEAR, audience: 'all_households' });
    assert.ok(noB.recipients.some((r) => r.householdId === 'h-1' && r.guardianId === 'g-a'));
    await db.query("UPDATE student_guardians SET ends_on = $1 WHERE guardian_id = 'g-a' AND student_id = 's-2'", [shiftDay(today, -1)]);
    const none = await computeSnapshot(db, { school_year_id: YEAR, audience: 'all_households' });
    assert.ok(!none.recipients.some((r) => r.householdId === 'h-1'));
    assert.ok(none.exclusions.some((e) => e.householdId === 'h-1' && e.reason === 'no_consent'));
  } finally {
    await db.close();
  }
});
