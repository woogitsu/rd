import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMigrations } from '../src/postgres-migrations.js';

function fakeClient(initial = []) {
  const calls = [];
  const rows = [...initial];
  return {
    calls,
    async query(sql, params = []) {
      calls.push(sql);
      if (sql.startsWith('SELECT name, checksum')) return { rows };
      if (sql.startsWith('INSERT INTO schema_migrations')) rows.push({ name: params[0], checksum: params[1] });
      return { rows: [] };
    },
  };
}

test('migrator applies once inside a transaction', async () => {
  const client = fakeClient();
  const migration = { name: '0001_test.sql', checksum: 'a'.repeat(64), sql: 'SELECT 1' };
  assert.deepEqual(await applyMigrations(client, [migration]), ['0001_test.sql']);
  assert.deepEqual(await applyMigrations(client, [migration]), []);
  assert.equal(client.calls.filter((sql) => sql === 'SELECT 1').length, 1);
  assert.ok(client.calls.includes('COMMIT'));
  assert.ok(client.calls.includes('SELECT pg_advisory_unlock($1)'));
});

test('migrator rejects altered or missing applied SQL', async () => {
  const client = fakeClient([{ name: '0001_test.sql', checksum: 'a'.repeat(64) }]);
  await assert.rejects(applyMigrations(client, [{ name: '0001_test.sql', checksum: 'b'.repeat(64), sql: 'SELECT 2' }]), /checksum changed/);
  await assert.rejects(applyMigrations(client, []), /missing from source/);
});

test('migrator rolls back failed SQL and releases lock', async () => {
  const client = fakeClient();
  const original = client.query;
  client.query = async (sql, params) => {
    if (sql === 'INVALID') throw new Error('synthetic SQL error');
    return original(sql, params);
  };
  await assert.rejects(applyMigrations(client, [{ name: '0001_bad.sql', checksum: 'a'.repeat(64), sql: 'INVALID' }]), /synthetic SQL error/);
  assert.ok(client.calls.includes('ROLLBACK'));
  assert.ok(client.calls.includes('SELECT pg_advisory_unlock($1)'));
});
