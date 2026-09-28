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
    await updateMeeting(db, board, { meetingId: meeting.id, status: 'held' });
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

test('parallel edits to different meeting fields under FOR UPDATE do not lose either change (no revision sent)', async () => {
  const db = await meetingsDb();
  try {
    const { meeting } = await createMeeting(db, board, {
      idempotencyKey: key(), schoolYearId: 'year', kind: 'plenary', title: 'Zebranie plenarne',
      scheduledAt: '2026-10-10T17:00:00Z', location: 'Sala 1', status: 'scheduled',
      quorumMode: 'fraction', quorumNumerator: 1, quorumDenominator: 2, quorumInclusive: true,
      votingBodySize: 4, quorumRuleSource: 'Założenie testowe',
    });
    await updateMeeting(db, board, { meetingId: meeting.id, title: 'Nowy tytuł zebrania' });
    await updateMeeting(db, board, { meetingId: meeting.id, location: 'Sala 2' });
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

