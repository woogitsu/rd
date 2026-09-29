// #161: ścieżka persony bez ślepego zaułka. Przedstawiciel klasy i Komisja Rewizyjna
// nie są na domyślnej liście MFA_REQUIRED_ROLES (D-10 — wariant zachowawczy, lista bez
// zmian), a ich trasy eksportu listy klasy i raportu KR wymagają MFA. Konto ma więc
// dostać czytelną odmowę `mfa_enrollment_required` (klient odsyła je do zapisu MFA),
// po jednym zapisie MFA dojść do obu tras, a obca klasa zostaje `forbidden`.
// Dane wyłącznie syntetyczne.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { handlePgRequest } from '../src/pg/app.js';
import { base32Decode, totp } from '../src/pg/mfa.js';
import { DEFAULT_MFA_REQUIRED_ROLES } from '../src/pg/mfa-policy.js';
import { ROSTER_ROLES } from '../src/pg/routes/exports.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const YEAR = 'y-2026';
let db;
let env;
before(async () => {
  db = await createTestDb();
  env = { db, MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64') };
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  for (const id of ['c-1a', 'c-1b', 'c-2b']) await seedClass(db, { id, schoolYearId: YEAR, name: id });
});
after(async () => { await db?.close(); });

const call = (path, cookie, extra = {}) => handlePgRequest(request(path, { cookie, ...extra }), env);
const roster = (classId, cookie) => call(`/api/exports/class-roster?classId=${classId}`, cookie);
const report = (cookie) => call(`/api/reports/audit?schoolYearId=${YEAR}&format=json`, cookie);
const errorOf = async (response) => (await response.json()).error;

async function enrollViaApi(cookie) {
  const enrolled = await call('/api/mfa/enroll', cookie, { method: 'POST' });
  assert.equal(enrolled.status, 201);
  const { secret } = await enrolled.json();
  const confirmed = await call('/api/mfa/confirm', cookie, { method: 'POST', body: { code: totp(base32Decode(secret), Date.now()) } });
  assert.equal(confirmed.status, 200);
  return confirmed.headers.get('Set-Cookie').split(';', 1)[0];
}

test('domyślna lista MFA nie obejmuje przedstawiciela i KR — zapis MFA jest dobrowolny, a nie wymuszony rolą (D-10, bez zmian)', () => {
  assert.deepEqual([...DEFAULT_MFA_REQUIRED_ROLES], ['admin', 'board', 'treasurer']);
  // Trasa eksportu listy klasy dopuszcza rolę spoza listy — dlatego odmowa musi mieć kod prowadzący do zapisu MFA.
  assert.ok(ROSTER_ROLES.includes('representative') && !DEFAULT_MFA_REQUIRED_ROLES.includes('representative'));
});

test('przedstawiciel dwóch klas (rodzeństwo) i członek KR: jeden zapis MFA otwiera listę obu klas i raport KR, obca klasa zostaje forbidden', async () => {
  const cookie = await seedUserSession(db, {
    userId: 'u-persona',
    roles: [
      { role: 'representative', classId: 'c-1a', schoolYearId: YEAR },
      { role: 'representative', classId: 'c-1b', schoolYearId: YEAR },
      { role: 'audit', schoolYearId: YEAR },
    ],
    mfa: false,
  });

  // Przed zapisem MFA: odmowa z powodu samego MFA, nie „forbidden” (klient przekierowuje do /login/).
  for (const classId of ['c-1a', 'c-1b']) {
    const response = await roster(classId, cookie);
    assert.equal(response.status, 403, classId);
    assert.equal(await errorOf(response), 'mfa_enrollment_required', classId);
  }
  const auditBefore = await report(cookie);
  assert.equal(auditBefore.status, 403);
  assert.equal(await errorOf(auditBefore), 'mfa_enrollment_required');
  // Zakres sprawdzany wcześniej: obca klasa nie zdradza, że wystarczyłoby MFA.
  const foreignBefore = await roster('c-2b', cookie);
  assert.equal(foreignBefore.status, 403);
  assert.equal(await errorOf(foreignBefore), 'forbidden');

  // Jeden zapis MFA (POST /api/mfa/enroll + /confirm) — ta sama droga, którą prowadzi ekran /login/.
  const verified = await enrollViaApi(cookie);

  for (const classId of ['c-1a', 'c-1b']) assert.equal((await roster(classId, verified)).status, 200, classId);
  assert.equal((await report(verified)).status, 200);
  const foreignAfter = await roster('c-2b', verified);
  assert.equal(foreignAfter.status, 403);
  assert.equal(await errorOf(foreignAfter), 'forbidden');
});

test('KR z czynnikiem, ale sesją bez kodu: mfa_required; przydział KR na inny rok: forbidden także po MFA', async () => {
  const enrolledCookie = await seedUserSession(db, { userId: 'u-audit-factor', roles: [{ role: 'audit', schoolYearId: YEAR }], mfa: false });
  const verified = await enrollViaApi(enrolledCookie);
  assert.equal((await report(verified)).status, 200);
  // Nowa sesja tego samego konta (samo hasło, bez kodu): czynnik jest, kodu brak.
  const fresh = await seedUserSession(db, { userId: 'u-audit-factor', mfa: false });
  const stale = await report(fresh);
  assert.equal(stale.status, 403);
  assert.equal(await errorOf(stale), 'mfa_required');

  await seedSchoolYear(db, 'y-2025', { startsOn: '2025-09-01', endsOn: '2026-08-31' });
  const oldYear = await seedUserSession(db, { userId: 'u-audit-old', roles: [{ role: 'audit', schoolYearId: 'y-2025' }], mfa: true });
  const denied = await report(oldYear);
  assert.equal(denied.status, 403);
  assert.equal(await errorOf(denied), 'forbidden');
});
