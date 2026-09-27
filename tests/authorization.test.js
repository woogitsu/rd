import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorized, loadActiveGrants } from '../src/authorization.js';

function context(grants, mfaVerified = false) {
  return { session: { mfaVerified, user: { id: 'u1' } }, grants };
}

test('representative is limited to the exact assigned class', () => {
  const ctx = context([{ role: 'representative', classId: 'class-1a', schoolYearId: '2026' }]);
  assert.equal(isAuthorized(ctx, { roles: ['representative'], classId: 'class-1a', schoolYearId: '2026' }), true);
  assert.equal(isAuthorized(ctx, { roles: ['representative'], classId: 'class-2b', schoolYearId: '2026' }), false);
});

test('an unscoped grant covers classes only when its role is explicitly allowed', () => {
  const ctx = context([{ role: 'board', classId: null, schoolYearId: '2026' }]);
  assert.equal(isAuthorized(ctx, { roles: ['board'], classId: 'class-1a', schoolYearId: '2026' }), true);
  assert.equal(isAuthorized(ctx, { roles: ['treasurer'], classId: 'class-1a', schoolYearId: '2026' }), false);
});

test('a grant scoped to another school year is rejected', () => {
  const ctx = context([{ role: 'board', classId: null, schoolYearId: '2025' }]);
  assert.equal(isAuthorized(ctx, { roles: ['board'], schoolYearId: '2026' }), false);
});

test('MFA-sensitive policy requires an MFA-verified session', () => {
  const grant = [{ role: 'treasurer', classId: null, schoolYearId: '2026' }];
  assert.equal(isAuthorized(context(grant), { roles: ['treasurer'], requireMfa: true }), false);
  assert.equal(isAuthorized(context(grant, true), { roles: ['treasurer'], requireMfa: true }), true);
});

test('empty or malformed policy never grants access', () => {
  const ctx = context([{ role: 'admin', classId: null, schoolYearId: null }], true);
  assert.equal(isAuthorized(ctx, {}), false);
  assert.equal(isAuthorized(null, { roles: ['admin'] }), false);
});

test('only active grants are loaded and normalized', async () => {
  const calls = [];
  const DB = {
    prepare(sql) {
      return { bind(...values) {
        calls.push({ sql, values });
        return { all: async () => ({ results: [
          { role: 'representative', class_id: 'class-1a', school_year_id: '2026', expires_at: null },
        ] }) };
      } };
    },
  };
  const grants = await loadActiveGrants({ DB }, 'u1');
  assert.match(calls[0].sql, /expires_at IS NULL/);
  assert.deepEqual(calls[0].values, ['u1']);
  assert.deepEqual(grants, [{ role: 'representative', classId: 'class-1a', schoolYearId: '2026', expiresAt: null }]);
});
