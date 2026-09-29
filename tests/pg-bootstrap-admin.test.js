// Pierwszy administrator na pustej bazie (issue #187). Dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hashSecret } from '../src/auth.js';
import { assertNoPii } from '../src/pg/audit.js';
import { acceptInvitation } from '../src/pg/auth.js';
import { BootstrapRefused, bootstrapAdmin } from '../src/pg/bootstrap-admin.js';
import { runBootstrapCli } from '../scripts/bootstrap-admin.js';
import { createTestDb, seedUser, seedUserSession } from './helpers/pg.js';

const EMAIL = 'first-admin@example.invalid';

async function withDb(fn) {
  const db = await createTestDb();
  try { return await fn(db); } finally { await db.close(); }
}

function sink() {
  const chunks = [];
  return { write: (chunk) => { chunks.push(String(chunk)); return true; }, text: () => chunks.join('') };
}

// Przechwytuje wszystko, co trafiłoby na prawdziwe stdout/stderr procesu
// (w tym src/log.js i console.*), poza przekazanymi strumieniami CLI.
async function captureProcessOutput(fn) {
  const captured = [];
  const originals = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (chunk, ...rest) => { captured.push(String(chunk)); return true; };
  process.stderr.write = (chunk, ...rest) => { captured.push(String(chunk)); return true; };
  try { return { result: await fn(), captured: captured.join('') }; } finally {
    process.stdout.write = originals.out;
    process.stderr.write = originals.err;
  }
}

async function runCli(db, argv, env = { APP_ENV: 'staging' }) {
  const stdout = sink();
  const stderr = sink();
  const { result: code, captured } = await captureProcessOutput(() => runBootstrapCli({ argv, env, db, stdout, stderr }));
  const token = /^token: ([A-Za-z0-9_-]{43})$/m.exec(stdout.text())?.[1] ?? null;
  return { code, stdout: stdout.text(), stderr: stderr.text(), captured, token };
}

async function auditRows(db) {
  return (await db.query('SELECT actor_id, action, entity_type, entity_id, metadata_json::text AS metadata FROM audit_events ORDER BY occurred_at, id')).rows;
}

test('pusta baza: konto, jednorazowe zaproszenie admin, audyt bez e-maila i tokenu', async () => {
  await withDb(async (db) => {
    const run = await runCli(db, [EMAIL]);
    assert.equal(run.code, 0, run.stderr);
    assert.ok(run.token, 'token wypisany na stdout');
    assert.equal(run.stdout.split(run.token).length - 1, 1, 'token wypisany dokładnie raz');
    assert.equal(run.stderr, '');
    assert.equal(run.captured, '', 'nic poza stdout CLI (brak logów)');

    const users = (await db.query('SELECT id, email, disabled_at FROM users')).rows;
    assert.equal(users.length, 1);
    assert.equal(users[0].email, EMAIL);
    const invitations = (await db.query('SELECT id, email, role, token_hash, created_by, expires_at > now() + interval \'23 hours\' AS ttl_ok FROM invitations')).rows;
    assert.equal(invitations.length, 1);
    assert.equal(invitations[0].role, 'admin');
    assert.equal(invitations[0].created_by, users[0].id);
    assert.equal(invitations[0].token_hash, await hashSecret(run.token), 'w bazie tylko skrót');
    assert.equal(invitations[0].ttl_ok, true);
    // Bootstrap nie nadaje roli — nadaje ją dopiero przyjęcie zaproszenia.
    assert.equal((await db.query('SELECT count(*)::int AS n FROM role_grants')).rows[0].n, 0);

    const audit = await auditRows(db);
    const issued = audit.find((row) => row.action === 'auth.bootstrap_issued');
    assert.ok(issued);
    assert.equal(issued.actor_id, null);
    assert.equal(issued.entity_id, invitations[0].id);
    assert.deepEqual(JSON.parse(issued.metadata).actor, 'system:bootstrap');
    assert.ok(audit.some((row) => row.action === 'user.created' && row.entity_id === users[0].id));
    const dump = JSON.stringify(audit);
    assert.ok(!dump.includes(run.token), 'token nie trafia do audytu');
    assert.ok(!dump.includes(EMAIL) && !dump.includes('@'), 'e-mail nie trafia do audytu');
  });
});

test('zaproszenie przyjęte istniejącym mechanizmem daje aktywnego admina; kolejne uruchomienie odmawia', async () => {
  await withDb(async (db) => {
    const first = await runCli(db, [EMAIL]);
    assert.equal(first.code, 0);
    const userId = (await db.query('SELECT id FROM users')).rows[0].id;
    const accepted = await acceptInvitation({ db }, { token: first.token, userId });
    assert.equal(accepted.ok, true);
    const grants = (await db.query("SELECT role, user_id FROM role_grants WHERE revoked_at IS NULL")).rows;
    assert.deepEqual(grants, [{ role: 'admin', user_id: userId }]);
    // #184: pierwsza rola ma ślad role_grant.created ze źródłem 'bootstrap' (aktor = przyjmujący, bez PII).
    const grantEvents = (await db.query("SELECT actor_id, entity_id, metadata_json AS metadata FROM audit_events WHERE action = 'role_grant.created'")).rows;
    assert.equal(grantEvents.length, 1);
    assert.equal(grantEvents[0].actor_id, userId);
    const grantMeta = typeof grantEvents[0].metadata === 'string' ? JSON.parse(grantEvents[0].metadata) : grantEvents[0].metadata;
    assert.equal(grantMeta.source, 'bootstrap');
    assert.equal(grantMeta.role, 'admin');
    assertNoPii(grantMeta);

    const again = await runCli(db, ['other-admin@example.invalid']);
    assert.equal(again.code, 2);
    assert.equal(again.token, null);
    assert.match(again.stderr, /active administrator already exists/);
    assert.ok(!again.stderr.includes('@'), 'komunikat bez adresu e-mail');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM invitations')).rows[0].n, 1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 1);
  });
});

test('istniejący aktywny admin → odmowa bez zmian w bazie', async () => {
  await withDb(async (db) => {
    await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
    const before = (await auditRows(db)).length;
    const run = await runCli(db, [EMAIL]);
    assert.equal(run.code, 2);
    assert.equal(run.token, null);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM invitations')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM users WHERE email = $1', [EMAIL])).rows[0].n, 0);
    assert.equal((await auditRows(db)).length, before);
  });
});

test('admin z wygasłą rolą, cofniętą rolą lub na wyłączonym koncie nie blokuje bootstrapu', async () => {
  await withDb(async (db) => {
    await seedUserSession(db, { userId: 'u-expired', roles: [{ role: 'admin', expiresAt: new Date(Date.now() - 3600_000) }] });
    await seedUserSession(db, { userId: 'u-revoked', roles: [{ role: 'admin', revoked: true }] });
    await seedUserSession(db, { userId: 'u-disabled', roles: [{ role: 'admin' }], disabled: true });
    await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board' }] });
    const run = await runCli(db, [EMAIL]);
    assert.equal(run.code, 0, run.stderr);
  });
});

test('drugie uruchomienie przy ważnym zaproszeniu → czytelna odmowa (idempotencja)', async () => {
  await withDb(async (db) => {
    const first = await runCli(db, [EMAIL]);
    assert.equal(first.code, 0);
    const second = await runCli(db, [EMAIL]);
    assert.equal(second.code, 2);
    assert.equal(second.token, null);
    assert.match(second.stderr, /unused admin invitation is still valid/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM invitations')).rows[0].n, 1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 1);
  });
});

test('po wygaśnięciu niewykorzystanego zaproszenia można ponowić; konto jest ponownie użyte', async () => {
  await withDb(async (db) => {
    const first = await bootstrapAdmin(db, { email: EMAIL, appEnv: 'staging' });
    // Symulacja upływu czasu: trigger invitation_guard nie pozwala zmienić expires_at,
    // więc test wyłącza go tylko na czas tej instrukcji.
    await db.exec(`ALTER TABLE invitations DISABLE TRIGGER invitations_guard;
      UPDATE invitations SET expires_at = now() - interval '1 minute';
      ALTER TABLE invitations ENABLE TRIGGER invitations_guard;`);
    const second = await bootstrapAdmin(db, { email: EMAIL.toUpperCase(), appEnv: 'staging' });
    assert.equal(second.userId, first.userId);
    assert.equal(second.userCreated, false);
    assert.notEqual(second.secret, first.secret);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 1);
  });
});

test('podwójne kliknięcie: dwa równoległe uruchomienia dają co najwyżej jeden ważny token', async () => {
  await withDb(async (db) => {
    const results = await Promise.allSettled([
      bootstrapAdmin(db, { email: EMAIL, appEnv: 'staging' }),
      bootstrapAdmin(db, { email: EMAIL, appEnv: 'staging' }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1);
    assert.equal(refused.length, 1);
    assert.ok(refused[0].reason instanceof BootstrapRefused);
    assert.equal(refused[0].reason.code, 'pending_admin_invitation');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM invitations WHERE role = 'admin'")).rows[0].n, 1);
  });
});

test('APP_ENV=production bez --allow-production → odmowa bez kontaktu z bazą', async () => {
  await withDb(async (db) => {
    for (const appEnv of ['production', 'PRODUCTION', ' prod ']) {
      const run = await runCli(db, [EMAIL], { APP_ENV: appEnv });
      assert.equal(run.code, 2);
      assert.equal(run.token, null);
      assert.match(run.stderr, /--allow-production/);
    }
    assert.equal((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n, 0);
    const allowed = await runCli(db, [EMAIL, '--allow-production'], { APP_ENV: 'production' });
    assert.equal(allowed.code, 0);
  });
});

test('konto wyłączone z tym adresem → odmowa', async () => {
  await withDb(async (db) => {
    await seedUser(db, { userId: 'u-off', email: EMAIL, disabled: true });
    const run = await runCli(db, [EMAIL]);
    assert.equal(run.code, 2);
    assert.match(run.stderr, /disabled/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM invitations')).rows[0].n, 0);
  });
});

test('błędne argumenty i brak DATABASE_URL → kod 1, brak zmian', async () => {
  await withDb(async (db) => {
    assert.equal((await runCli(db, [])).code, 1);
    assert.equal((await runCli(db, [EMAIL, '--ttl-hours=500'])).code, 1);
    const invalid = await runCli(db, ['not-an-email']);
    assert.equal(invalid.code, 2);
    assert.match(invalid.stderr, /invalid/);
    const stdout = sink();
    const stderr = sink();
    assert.equal(await runBootstrapCli({ argv: [EMAIL], env: {}, stdout, stderr }), 1);
    assert.match(stderr.text(), /DATABASE_URL is required/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 0);
  });
});
