// Testy jednego resolvera zakresu przydziałów (issue #155). Dane syntetyczne.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isClassOnlyScope, resolveScope, scopeSql } from '../src/pg/scope.js';
import { isAuthorized } from '../src/authorization.js';

function ctx(grants, { mfaVerified = false } = {}) {
  return { session: { mfaVerified }, grants };
}

function scopeCoversClass(scope, classId, schoolYearId) {
  if (scope.schoolWide && (scope.years === 'all' || scope.years.includes(schoolYearId))) return true;
  return scope.classes.some((entry) => entry.classId === classId
    && (entry.schoolYearId === null || entry.schoolYearId === schoolYearId));
}

// --- Granice ról z AGENTS.md / testy z opisu issue #155 -------------------

test('przedstawiciel 1A widzi tylko klasę 1A, nie 1B', () => {
  const grants = [{ role: 'representative', classId: 'c-1a', schoolYearId: 'y-2026' }];
  const scope = resolveScope(ctx(grants), { roles: ['representative'] });
  assert.equal(scope.schoolWide, false);
  assert.equal(scopeCoversClass(scope, 'c-1a', 'y-2026'), true);
  assert.equal(scopeCoversClass(scope, 'c-1b', 'y-2026'), false);
});

test('zarząd z przydziałem class_id (SR-01) nie dostaje zakresu szkolnego', () => {
  const grants = [{ role: 'board', classId: 'c-1a', schoolYearId: 'y-2026' }];
  const scope = resolveScope(ctx(grants), { roles: ['board'] });
  assert.equal(scope.schoolWide, false, 'przydział klasowy nigdy nie daje zakresu szkolnego (SR-01)');
  assert.equal(isClassOnlyScope(scope), true);
  assert.equal(scopeCoversClass(scope, 'c-1a', 'y-2026'), true);
  assert.equal(scopeCoversClass(scope, 'c-2b', 'y-2026'), false);
});

test('przydział bez roku (schoolYearId null) obejmuje klasę w każdym roku', () => {
  const grants = [{ role: 'representative', classId: 'c-1a', schoolYearId: null }];
  const scope = resolveScope(ctx(grants), { roles: ['representative'] });
  assert.equal(scopeCoversClass(scope, 'c-1a', 'y-2025'), true);
  assert.equal(scopeCoversClass(scope, 'c-1a', 'y-2026'), true);
  assert.equal(scopeCoversClass(scope, 'c-1b', 'y-2026'), false);
});

test('przydział wygasły lub cofnięty nie trafia do resolveScope (odfiltrowany wcześniej przez loadActiveGrants)', () => {
  // context.grants zawiera już tylko aktywne przydziały — resolveScope nie
  // widzi w ogóle wygasłego/cofniętego wpisu, więc żadna klasa/rok nie jest w zakresie.
  const scope = resolveScope(ctx([]), { roles: ['representative'] });
  assert.equal(scope.any, false);
  assert.equal(scopeCoversClass(scope, 'c-1a', 'y-2026'), false);
});

test('ta sama klasa w dwóch latach: dwa osobne przydziały, oba w zakresie', () => {
  const grants = [
    { role: 'representative', classId: 'c-1a', schoolYearId: 'y-2025' },
    { role: 'representative', classId: 'c-1a', schoolYearId: 'y-2026' },
  ];
  const scope = resolveScope(ctx(grants), { roles: ['representative'] });
  assert.equal(scopeCoversClass(scope, 'c-1a', 'y-2025'), true);
  assert.equal(scopeCoversClass(scope, 'c-1a', 'y-2026'), true);
  assert.equal(scopeCoversClass(scope, 'c-1a', 'y-2027'), false);
});

test('MFA wymagane, sesja bez potwierdzonego MFA -> brak zakresu (any: false)', () => {
  const grants = [{ role: 'treasurer' }];
  const scope = resolveScope(ctx(grants, { mfaVerified: false }), { roles: ['treasurer'], requireMfa: true });
  assert.equal(scope.any, false);
  const withMfa = resolveScope(ctx(grants, { mfaVerified: true }), { roles: ['treasurer'], requireMfa: true });
  assert.equal(withMfa.any, true);
  assert.equal(withMfa.schoolWide, true);
});

test('rola szeroka bez schoolYearId -> zakres szkolny na wszystkie lata', () => {
  const grants = [{ role: 'admin' }];
  const scope = resolveScope(ctx(grants), { roles: ['admin'] });
  assert.equal(scope.schoolWide, true);
  assert.equal(scope.years, 'all');
});

test('rola szeroka z konkretnym schoolYearId -> zakres szkolny tylko dla tego roku', () => {
  const grants = [{ role: 'board', schoolYearId: 'y-2025' }];
  const scopeSameYear = resolveScope(ctx(grants), { roles: ['board'], schoolYearId: 'y-2025' });
  assert.equal(scopeSameYear.schoolWide, true);
  const scopeOtherYear = resolveScope(ctx(grants), { roles: ['board'], schoolYearId: 'y-2026' });
  assert.equal(scopeOtherYear.any, false, 'przydział na inny rok nie pasuje do wymogu z innym rokiem');
});

// --- Test własności: zgodność z isAuthorized (poza SR-01, sprawdzanym osobno) ---

const ROLES = ['admin', 'board', 'treasurer', 'representative'];
const CLASS_IDS = ['c-1a', 'c-1b'];
const YEAR_IDS = ['y-2025', 'y-2026'];

function randomGrants(rng) {
  const count = 1 + Math.floor(rng() * 4);
  const grants = [];
  for (let i = 0; i < count; i += 1) {
    const role = ROLES[Math.floor(rng() * ROLES.length)];
    const hasClass = rng() < 0.5;
    const hasYear = rng() < 0.5;
    grants.push({
      role,
      classId: hasClass ? CLASS_IDS[Math.floor(rng() * CLASS_IDS.length)] : null,
      schoolYearId: hasYear ? YEAR_IDS[Math.floor(rng() * YEAR_IDS.length)] : null,
    });
  }
  return grants;
}

// Generator deterministyczny (bez zależności) — powtarzalne wyniki testu.
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('resolveScope zgadza się z isAuthorized dla par (klasa, rok) — losowe zestawy przydziałów', () => {
  const rng = mulberry32(155);
  for (let sample = 0; sample < 200; sample += 1) {
    const grants = randomGrants(rng);
    const roles = [ROLES[Math.floor(rng() * ROLES.length)]];
    const context = ctx(grants, { mfaVerified: true });
    const scope = resolveScope(context, { roles });
    for (const classId of CLASS_IDS) {
      for (const schoolYearId of YEAR_IDS) {
        const expected = isAuthorized(context, { roles, classId, schoolYearId });
        const actual = scopeCoversClass(scope, classId, schoolYearId);
        assert.equal(actual, expected, `próbka ${sample}, klasa ${classId}, rok ${schoolYearId}, grants=${JSON.stringify(grants)}`);
      }
    }
  }
});

test('SR-01 (wyjątek z testu własności): przydział wyłącznie klasowy daje isAuthorized(bez classId)=true, ale resolveScope.schoolWide=false', () => {
  const grants = [{ role: 'board', classId: 'c-1a', schoolYearId: null }];
  const context = ctx(grants, { mfaVerified: true });
  // Stare zachowanie surowego isAuthorized bez schoolWideContext — pokazuje,
  // dlaczego moduły filtrują grants ręcznie (i czemu resolveScope tego nie robi tak).
  assert.equal(isAuthorized(context, { roles: ['board'] }), true);
  const scope = resolveScope(context, { roles: ['board'] });
  assert.equal(scope.schoolWide, false, 'resolveScope poprawnie NIE traktuje przydziału klasowego jako szkolnego');
});

// --- scopeSql: brak kolizji numerów parametrów przy różnym firstParam ----

test('scopeSql: firstParam przesuwa numerację parametrów bez kolizji', () => {
  const scope = resolveScope(ctx([
    { role: 'representative', classId: 'c-1a', schoolYearId: 'y-2026' },
  ]), { roles: ['representative'] });

  const atOne = scopeSql(scope, { classAlias: 'c' });
  assert.match(atOne.sql, /\$1::boolean/);
  assert.match(atOne.sql, /\$2::text\[\]/);
  assert.match(atOne.sql, /\$3::text\[\]/);
  assert.match(atOne.sql, /\$4::text\[\]/);

  const atFive = scopeSql(scope, { classAlias: 'c', firstParam: 5 });
  assert.match(atFive.sql, /\$5::boolean/);
  assert.match(atFive.sql, /\$6::text\[\]/);
  assert.match(atFive.sql, /\$7::text\[\]/);
  assert.match(atFive.sql, /\$8::text\[\]/);
  assert.doesNotMatch(atFive.sql, /\$1::/, 'brak kolizji ze starą numeracją');
  assert.deepEqual(atFive.params, atOne.params, 'te same wartości, inne tylko numery parametrów');
});

test('scopeSql: zakres szkolny na wszystkie lata -> pierwszy parametr true, reszta pusta', () => {
  const scope = resolveScope(ctx([{ role: 'admin' }]), { roles: ['admin'] });
  const { params } = scopeSql(scope, { classAlias: 'c' });
  assert.deepEqual(params, [true, [], [], []]);
});
