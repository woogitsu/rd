import test from 'node:test';
import assert from 'node:assert/strict';
import { migrationDatabaseUrl } from '../src/migration-url.js';

test('SR-05: migrator używa DATABASE_MIGRATION_URL, a bez niego DATABASE_URL', () => {
  assert.equal(migrationDatabaseUrl({ DATABASE_MIGRATION_URL: 'postgres://owner@h/db', DATABASE_URL: 'postgres://app@h/db' }), 'postgres://owner@h/db');
  assert.equal(migrationDatabaseUrl({ DATABASE_URL: 'postgres://app@h/db' }), 'postgres://app@h/db');
  assert.equal(migrationDatabaseUrl({ DATABASE_MIGRATION_URL: '', DATABASE_URL: 'postgres://app@h/db' }), 'postgres://app@h/db');
  assert.equal(migrationDatabaseUrl({}), '');
});
