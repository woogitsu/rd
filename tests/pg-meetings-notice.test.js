// #113: dziennik zdarzeń dla zmiany terminu zebrania. Pełny zakres issue
// (stan „odwołane”, wersje porządku obrad, zawiadomienie jako kampania
// e-mail) wymaga migracji schematu, poza dostępną w tym zadaniu pulą numerów
// (0060-0061 zajęte przez #102 i #135) — projekt opisany w docs/MEETINGS.md.
// Ten test pokrywa wyłącznie fragment możliwy bez zmiany schematu: zdarzenie
// `meeting.rescheduled` ze starą i nową datą jako znacznikami czasu, bez
// treści zebrania.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../src/postgres-migrations.js';
import { createMeeting, updateMeeting } from '../src/pg/meetings.js';

const directory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));

const grant = (role, extra = {}) => ({ role, classId: null, schoolYearId: 'year', expiresAt: null, ...extra });
const board = { userId: 'board', grants: [grant('board')], mfaVerified: false };

let keySeq = 0;
const key = () => `test-key-${++keySeq}`;

async function meetingsDb() {
  const db = new PGlite();
  for (const migration of await loadMigrations(directory)) await db.exec(migration.sql);
  await db.query("INSERT INTO school_years VALUES ('year','2026/27','2026-09-01','2027-08-31')");
  await db.query('INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)',
    ['board', 'board@example.invalid', 'Synthetic board']);
  return db;
}

async function lastAudit(db, action) {
  const { rows } = await db.query(
    'SELECT * FROM audit_events WHERE action = $1 ORDER BY occurred_at DESC LIMIT 1', [action]);
  return rows[0] ?? null;
}

test('changing scheduledAt logs meeting.rescheduled with old/new timestamps, no content', async () => {
  const db = await meetingsDb();
  try {
    const { meeting } = await createMeeting(db, board, {
      idempotencyKey: key(), schoolYearId: 'year', kind: 'plenary', title: 'Zebranie plenarne',
      scheduledAt: '2026-10-10T17:00:00Z', location: 'Sala 1', status: 'scheduled',
    });

    // Editing a field other than scheduledAt does not create a reschedule event.
    await updateMeeting(db, board, { meetingId: meeting.id, title: 'Nowy tytuł' });
    assert.equal(await lastAudit(db, 'meeting.rescheduled'), null);

    await updateMeeting(db, board, { meetingId: meeting.id, scheduledAt: '2026-10-17T17:00:00Z' });
    const event = await lastAudit(db, 'meeting.rescheduled');
    assert.ok(event);
    assert.equal(event.metadata_json.fromScheduledAt, '2026-10-10T17:00:00.000Z');
    assert.equal(event.metadata_json.toScheduledAt, '2026-10-17T17:00:00.000Z');
    // No meeting title, location, or other content leaks into the audit metadata.
    assert.deepEqual(Object.keys(event.metadata_json).sort(), ['fromScheduledAt', 'toScheduledAt']);

    // Re-sending the same scheduledAt (double click / retry) does not log a second event.
    await updateMeeting(db, board, { meetingId: meeting.id, scheduledAt: '2026-10-17T17:00:00Z' });
    const { rows } = await db.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'meeting.rescheduled'");
    assert.equal(rows[0].n, 1);
  } finally { await db.close(); }
});
