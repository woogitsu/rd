// #137: spójność dostępu roli `audit` (Komisja Rewizyjna) — raport roczny tak (odczyt,
// MFA), zapis i szczegóły księgi/wpłat/uzgodnień nie. Poszczególne trasy mają już testy
// odmowy w swoich plikach (tests/pg-ledger-api.test.js, tests/pg-reconciliation.test.js,
// macierz tests/pg-authz-matrix.test.js); ten plik zbiera jawną, czytelną granicę roli w
// jednym miejscu, żeby przyszła zmiana zakresu audit (dopiero po decyzji D-09) musiała
// świadomie zmienić właśnie ten test, a nie tylko poszerzyć REPORT_ROLES gdzieś w kodzie.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const YEAR = 'y-audit137';

async function setup() {
  const db = await createTestDb();
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedClass(db, { id: 'c-audit137-1a', schoolYearId: YEAR });
  const audit = await seedUserSession(db, { userId: 'u-audit137', roles: [{ role: 'audit', schoolYearId: YEAR }], mfa: true });
  const auditNoMfa = await seedUserSession(db, { userId: 'u-audit137-nomfa', roles: [{ role: 'audit', schoolYearId: YEAR }], mfa: false });
  const auditClassScoped = await seedUserSession(db, {
    userId: 'u-audit137-class', roles: [{ role: 'audit', classId: 'c-audit137-1a', schoolYearId: YEAR }], mfa: true,
  });
  const auditOtherYear = await seedUserSession(db, { userId: 'u-audit137-other', roles: [{ role: 'audit', schoolYearId: 'y-audit137-other' }], mfa: true });
  const call = (path, options = {}) => handlePgRequest(request(path, options), { db });
  return { db, call, audit, auditNoMfa, auditClassScoped, auditOtherYear };
}

test('#137: audit czyta raport roczny wyłącznie z MFA, tym samym rokiem i bez zawężenia do klasy', async () => {
  const { db, call, audit, auditNoMfa, auditClassScoped, auditOtherYear } = await setup();
  try {
    const ok = await call(`/api/reports/audit?schoolYearId=${YEAR}&format=json`, { cookie: audit });
    assert.equal(ok.status, 200);

    const noMfa = await call(`/api/reports/audit?schoolYearId=${YEAR}&format=json`, { cookie: auditNoMfa });
    assert.equal(noMfa.status, 403);
    assert.equal((await noMfa.json()).error, 'mfa_enrollment_required');

    const classScoped = await call(`/api/reports/audit?schoolYearId=${YEAR}&format=json`, { cookie: auditClassScoped });
    assert.equal(classScoped.status, 403, 'przydział klasowy nie działa jak ogólnoszkolny (SR-01)');

    const otherYear = await call(`/api/reports/audit?schoolYearId=${YEAR}&format=json`, { cookie: auditOtherYear });
    assert.equal(otherYear.status, 403, 'przydział innego roku nie daje dostępu do tego raportu');
  } finally { await db.close(); }
});

test('#137: audit nie ma dziś żadnej trasy zapisu ani odczytu szczegółu księgi, wpłat i uzgodnień', async () => {
  const { db, call, audit } = await setup();
  try {
    // Trasy GET: rola sprawdzana przed jakimkolwiek odczytem.
    for (const path of [
      `/api/ledger?schoolYearId=${YEAR}`,
      `/api/ledger/summary?schoolYearId=${YEAR}`,
      `/api/ledger/export.csv?schoolYearId=${YEAR}`,
      `/api/payments?schoolYearId=${YEAR}`,
      `/api/reconciliations?schoolYearId=${YEAR}`,
    ]) {
      const response = await call(path, { cookie: audit });
      assert.equal(response.status, 403, path);
    }
    // Trasy POST: ciało w pełni poprawnym kształcie (jak w innych testach tych modułów),
    // żeby odmowa 403 wynikała jawnie z roli, a nie z walidacji treści przed autoryzacją
    // (te trasy w obecnym kodzie sprawdzają kształt ciała przed rolą — patrz kolejność
    // w src/pg/routes/{ledger,payments,reconciliation}.js — to osobna, nieporuszona tu sprawa).
    const posted = [
      ['/api/ledger', {
        schoolYearId: YEAR, direction: 'income', amountCents: 5000, categoryId: 'cat-dues',
        description: 'Syntetyczny wpis', occurredOn: '2026-09-20', method: 'bank',
      }],
      ['/api/payments', {
        schoolYearId: YEAR, householdId: 'h-audit137', amountCents: 2500, receivedOn: '2026-10-01',
        method: 'bank', reference: 'Wpłata syntetyczna',
      }],
      ['/api/reconciliations', { schoolYearId: YEAR, statementDate: '2026-09-30', statementBalanceCents: 0 }],
    ];
    for (const [path, body] of posted) {
      const response = await call(path, {
        method: 'POST', cookie: audit, body, headers: { 'Idempotency-Key': `audit137-${path.replace(/\W/g, '')}` },
      });
      assert.equal(response.status, 403, path);
    }
  } finally { await db.close(); }
});
