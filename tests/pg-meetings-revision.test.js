// #215: kontrola wersji (optimistic concurrency) dla uchwał i zebrań.
// Kampania e-mail — patrz tests/pg-email.test.js. Wyłącznie dane syntetyczne;
// domeny .invalid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../src/postgres-migrations.js';
import {
  createMeeting, createResolution, updateMeeting, updateResolution,
} from '../src/pg/meetings.js';

const directory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));

const grant = (role, extra = {}) => ({ role, classId: null, schoolYearId: 'year', expiresAt: null, ...extra });
const board = { userId: 'board', grants: [grant('board')], mfaVerified: true };

let keySeq = 0;
const key = () => `test-key-${++keySeq}`;

async function newMeeting(db, extra = {}) {
  return createMeeting(db, board, {
    idempotencyKey: key(), schoolYearId: 'year', kind: 'plenary', title: 'Zebranie plenarne',
    scheduledAt: '2026-10-10T17:00:00Z', location: 'Sala 1', status: 'scheduled',
    quorumMode: 'fraction', quorumNumerator: 1, quorumDenominator: 2, quorumInclusive: true,
    votingBodySize: 4, quorumRuleSource: 'Założenie testowe', ...extra,
  });
}

async function meetingsDb() {
  const db = new PGlite();
  for (const migration of await loadMigrations(directory)) await db.exec(migration.sql);
  await db.query(`INSERT INTO school_years VALUES ('year','2026/27','2026-09-01','2027-08-31')`);
  await db.query("INSERT INTO classes (id, school_year_id, name) VALUES ('class-a','year','1A')");
  for (const id of ['board']) {
    await db.query('INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)',
      [id, `${id}@example.invalid`, `Synthetic ${id}`]);
  }
  return db;
}

test('two board members editing the same draft resolution: one 200, second 409 with a stale revision', async () => {
  const db = await meetingsDb();
  try {
    const { meeting } = await createMeeting(db, board, {
      idempotencyKey: key(), schoolYearId: 'year', kind: 'plenary', title: 'Zebranie plenarne',
      scheduledAt: '2026-10-10T17:00:00Z', location: 'Sala 1', status: 'scheduled',
      quorumMode: 'fraction', quorumNumerator: 1, quorumDenominator: 2, quorumInclusive: true,
      votingBodySize: 4, quorumRuleSource: 'Założenie testowe',
    });
    const draft = (await createResolution(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Zakup nagród na konkurs', body: 'Rada przeznacza 250 EUR na nagrody.',
    })).resolution;
    assert.equal(draft.revisionNo, 1);

    // A wczytuje wersję 1 i poprawia treść.
    const afterA = (await updateResolution(db, board, {
      resolutionId: draft.id, revision: 1, body: 'Rada przeznacza 300 EUR na nagrody (poprawka A).',
    })).resolution;
    assert.equal(afterA.revisionNo, 2);
    assert.equal(afterA.body, 'Rada przeznacza 300 EUR na nagrody (poprawka A).');

    // B wczytał tę samą wersję 1 (przed zmianą A) i próbuje poprawić inne pole — konflikt, nic nie ginie po cichu.
    await assert.rejects(
      updateResolution(db, board, { resolutionId: draft.id, revision: 1, title: 'Zakup nagród — poprawka B' }),
      { code: 'revision_conflict', status: 409 },
    );
    const stillA = (await updateResolution(db, board, { resolutionId: draft.id, revision: 2, votesFor: undefined })).resolution;
    assert.equal(stillA.body, 'Rada przeznacza 300 EUR na nagrody (poprawka A).');
  } finally { await db.close(); }
});

test('double submit of the same resolution edit (double click): 200 + 200, one audit event', async () => {
  const db = await meetingsDb();
  try {
    const { meeting } = await createMeeting(db, board, {
      idempotencyKey: key(), schoolYearId: 'year', kind: 'plenary', title: 'Zebranie plenarne',
      scheduledAt: '2026-10-10T17:00:00Z', location: 'Sala 1', status: 'scheduled',
      quorumMode: 'fraction', quorumNumerator: 1, quorumDenominator: 2, quorumInclusive: true,
      votingBodySize: 4, quorumRuleSource: 'Założenie testowe',
    });
    const draft = (await createResolution(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Projekt', body: 'Treść projektu wystarczająco długa.',
    })).resolution;
    const first = await updateResolution(db, board, { resolutionId: draft.id, revision: 1, title: 'Projekt poprawiony' });
    assert.equal(first.resolution.revisionNo, 2);
    // Ta sama treść, ten sam numer wersji bazowej — druga próba (np. powtórzenie po timeoucie).
    const second = await updateResolution(db, board, { resolutionId: draft.id, revision: 1, title: 'Projekt poprawiony' });
    assert.equal(second.resolution.revisionNo, 2, 'brak nowej wersji przy odtworzeniu');
    const { rows } = await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'resolution.updated'");
    assert.equal(rows[0].n, 1, 'jedno zdarzenie audytu mimo dwóch wywołań');
  } finally { await db.close(); }
});

test('adopting a resolution with a stale revision is rejected (409), not silently applied', async () => {
  const db = await meetingsDb();
  try {
    const { meeting } = await createMeeting(db, board, {
      idempotencyKey: key(), schoolYearId: 'year', kind: 'plenary', title: 'Zebranie plenarne',
      scheduledAt: '2026-10-10T17:00:00Z', location: 'Sala 1', status: 'scheduled',
      quorumMode: 'fraction', quorumNumerator: 1, quorumDenominator: 2, quorumInclusive: true,
      votingBodySize: 1, quorumRuleSource: 'Założenie testowe',
    });
    await updateMeeting(db, board, { meetingId: meeting.id, revision: 1, status: 'held' });
    const draft = (await createResolution(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Uchwała', body: 'Treść uchwały wystarczająco długa.',
    })).resolution;
    // A poprawia treść (rev 1 -> 2) w międzyczasie, zanim B zdąży rozstrzygnąć na podstawie rev 1.
    await updateResolution(db, board, { resolutionId: draft.id, revision: 1, body: 'Treść uchwały po poprawce A.' });
    await assert.rejects(
      updateResolution(db, board, {
        resolutionId: draft.id, revision: 1, status: 'adopted', number: 'U-1',
        votesFor: 1, votesAgainst: 0, votesAbstain: 0,
      }),
      { code: 'revision_conflict', status: 409 },
    );
    const { rows } = await db.query('SELECT status, body FROM resolutions WHERE id = $1', [draft.id]);
    assert.equal(rows[0].status, 'draft');
    assert.equal(rows[0].body, 'Treść uchwały po poprawce A.');
  } finally { await db.close(); }
});

test('sequential edits of different meeting fields, each with the fresh revision, keep both changes', async () => {
  const db = await meetingsDb();
  try {
    const { meeting } = await newMeeting(db);
    await updateMeeting(db, board, { meetingId: meeting.id, revision: 1, title: 'Nowy tytuł zebrania' });
    await updateMeeting(db, board, { meetingId: meeting.id, revision: 2, location: 'Sala 2' });
    const { rows } = await db.query('SELECT title, location, revision_no FROM meetings WHERE id = $1', [meeting.id]);
    assert.equal(rows[0].title, 'Nowy tytuł zebrania');
    assert.equal(rows[0].location, 'Sala 2');
    assert.equal(rows[0].revision_no, 3);
  } finally { await db.close(); }
});

test('meeting edit with a stale revision is rejected 409, matching revision is applied', async () => {
  const db = await meetingsDb();
  try {
    const { meeting } = await createMeeting(db, board, {
      idempotencyKey: key(), schoolYearId: 'year', kind: 'plenary', title: 'Zebranie plenarne',
      scheduledAt: '2026-10-10T17:00:00Z', location: 'Sala 1', status: 'scheduled',
      quorumMode: 'fraction', quorumNumerator: 1, quorumDenominator: 2, quorumInclusive: true,
      votingBodySize: 4, quorumRuleSource: 'Założenie testowe',
    });
    await updateMeeting(db, board, { meetingId: meeting.id, revision: 1, location: 'Sala 2' });
    await assert.rejects(
      updateMeeting(db, board, { meetingId: meeting.id, revision: 1, title: 'Inny tytuł' }),
      { code: 'revision_conflict', status: 409 },
    );
    const ok = await updateMeeting(db, board, { meetingId: meeting.id, revision: 2, title: 'Tytuł po sprawdzeniu wersji' });
    assert.equal(ok.meeting.title, 'Tytuł po sprawdzeniu wersji');
  } finally { await db.close(); }
});


// ---- Etap 2 #215: `revision` wymagane ----

test('meeting and resolution edits without revision: 400 invalid_revision, nothing written', async () => {
  const db = await meetingsDb();
  try {
    const { meeting } = await newMeeting(db);
    const draft = (await createResolution(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Projekt', body: 'Treść projektu wystarczająco długa.',
    })).resolution;
    for (const revision of [undefined, null, 'x', '1', 0, 1.5, -1]) {
      await assert.rejects(updateMeeting(db, board, { meetingId: meeting.id, revision, title: 'Bez wersji' }),
        { code: 'invalid_revision', status: 400 }, `zebranie, revision=${String(revision)}`);
      await assert.rejects(updateResolution(db, board, { resolutionId: draft.id, revision, title: 'Bez wersji' }),
        { code: 'invalid_revision', status: 400 }, `uchwała, revision=${String(revision)}`);
    }
    const m = (await db.query('SELECT title, revision_no FROM meetings WHERE id = $1', [meeting.id])).rows[0];
    const r = (await db.query('SELECT title, revision_no FROM resolutions WHERE id = $1', [draft.id])).rows[0];
    assert.deepEqual([m.title, m.revision_no, r.title, r.revision_no], ['Zebranie plenarne', 1, 'Projekt', 1]);
  } finally { await db.close(); }
});

test('role boundaries come first: auditor and representative get 403 even without revision', async () => {
  const db = await meetingsDb();
  try {
    const { meeting } = await newMeeting(db);
    const draft = (await createResolution(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Projekt', body: 'Treść projektu wystarczająco długa.',
    })).resolution;
    const auditor = { userId: 'aud', grants: [grant('auditor')], mfaVerified: true };
    const rep = { userId: 'rep', grants: [grant('representative', { classId: 'class-a' })], mfaVerified: true };
    for (const actor of [auditor, rep]) {
      await assert.rejects(updateMeeting(db, actor, { meetingId: meeting.id, title: 'Cudza zmiana' }), { code: 'forbidden' });
      await assert.rejects(updateMeeting(db, actor, { meetingId: meeting.id, revision: 1, title: 'Cudza zmiana' }), { code: 'forbidden' });
      await assert.rejects(updateResolution(db, actor, { resolutionId: draft.id, title: 'Cudza zmiana' }), { code: 'forbidden' });
      await assert.rejects(updateResolution(db, actor, { resolutionId: draft.id, revision: 1, title: 'Cudza zmiana' }), { code: 'forbidden' });
    }
  } finally { await db.close(); }
});

test('two resolution edits with the same revision via Promise.all (sequential on PGlite): exactly one 200, one 409, no lost change', async () => {
  const db = await meetingsDb();
  try {
    const { meeting } = await newMeeting(db);
    const draft = (await createResolution(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Zakup nagród na konkurs', body: 'Rada przeznacza 250 EUR na nagrody.',
    })).resolution;
    const results = await Promise.allSettled([
      updateResolution(db, board, { resolutionId: draft.id, revision: 1, body: 'Rada przeznacza 300 EUR na nagrody.' }),
      updateResolution(db, board, { resolutionId: draft.id, revision: 1, title: 'Zakup nagród na konkurs (poprawka B)' }),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const rejected = results.find(r => r.status === 'rejected');
    assert.equal(rejected.reason.code, 'revision_conflict');
    assert.equal(rejected.reason.status, 409);
    const { rows } = await db.query('SELECT title, body, revision_no FROM resolutions WHERE id = $1', [draft.id]);
    assert.equal(rows[0].revision_no, 2, 'dokładnie jedna zmiana zapisana');
    const winner = results.findIndex(r => r.status === 'fulfilled');
    if (winner === 0) assert.equal(rows[0].body, 'Rada przeznacza 300 EUR na nagrody.');
    else assert.equal(rows[0].title, 'Zakup nagród na konkurs (poprawka B)');
    const events = await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'resolution.updated' AND entity_id = $1", [draft.id]);
    assert.equal(events.rows[0].n, 1);
  } finally { await db.close(); }
});

test('stale revision via Promise.all (sequential on PGlite): A edits the text, B enters votes and adopts on the old revision: B gets 409, resolution stays a draft', async () => {
  const db = await meetingsDb();
  try {
    const { meeting } = await newMeeting(db, { votingBodySize: 1 });
    await updateMeeting(db, board, { meetingId: meeting.id, revision: 1, status: 'held' });
    const draft = (await createResolution(db, board, {
      idempotencyKey: key(), meetingId: meeting.id, title: 'Uchwała', body: 'Treść uchwały wystarczająco długa.',
    })).resolution;
    const [a, b] = await Promise.allSettled([
      updateResolution(db, board, { resolutionId: draft.id, revision: 1, body: 'Treść po poprawce A, wystarczająco długa.' }),
      updateResolution(db, board, { resolutionId: draft.id, revision: 1, status: 'adopted', number: 'U-1', votesFor: 1, votesAgainst: 0, votesAbstain: 0 }),
    ]);
    // Wygrywa dokładnie jedna; jeśli wygrała A, przyjęcie na starej wersji jest odrzucone.
    assert.equal([a, b].filter(r => r.status === 'fulfilled').length, 1);
    const loser = [a, b].find(r => r.status === 'rejected');
    assert.ok(['revision_conflict', 'quorum_check_required', 'resolution_quorum_check_required', 'resolution_final_immutable']
      .includes(loser.reason.code) || loser.reason.status === 409 || loser.reason.status === 400, loser.reason.code);
    if (a.status === 'fulfilled') {
      const { rows } = await db.query('SELECT status, body FROM resolutions WHERE id = $1', [draft.id]);
      assert.equal(rows[0].status, 'draft');
      assert.equal(rows[0].body, 'Treść po poprawce A, wystarczająco długa.');
    }
  } finally { await db.close(); }
});

test('two meeting edits with the same revision via Promise.all (sequential on PGlite): one 200, one 409; repeated identical edit: 200 + 200, one audit event', async () => {
  const db = await meetingsDb();
  try {
    const { meeting } = await newMeeting(db);
    const results = await Promise.allSettled([
      updateMeeting(db, board, { meetingId: meeting.id, revision: 1, title: 'Tytuł od A' }),
      updateMeeting(db, board, { meetingId: meeting.id, revision: 1, location: 'Sala od B' }),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'revision_conflict');
    const { rows } = await db.query('SELECT title, location, revision_no FROM meetings WHERE id = $1', [meeting.id]);
    assert.equal(rows[0].revision_no, 2);
    assert.ok(rows[0].title === 'Tytuł od A' || rows[0].location === 'Sala od B');

    // Podwójne kliknięcie: dwa identyczne żądania z tą samą wersją bazową.
    const twice = await Promise.allSettled([
      updateMeeting(db, board, { meetingId: meeting.id, revision: 2, location: 'Sala 3' }),
      updateMeeting(db, board, { meetingId: meeting.id, revision: 2, location: 'Sala 3' }),
    ]);
    assert.deepEqual(twice.map(r => r.status), ['fulfilled', 'fulfilled']);
    const after = await db.query('SELECT location, revision_no FROM meetings WHERE id = $1', [meeting.id]);
    assert.deepEqual([after.rows[0].location, after.rows[0].revision_no], ['Sala 3', 3]);
    const events = await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'meeting.updated' AND entity_id = $1", [meeting.id]);
    assert.equal(events.rows[0].n, 2, 'jedno zdarzenie na realną zmianę (A/B oraz Sala 3)');
  } finally { await db.close(); }
});
