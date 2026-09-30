// #161, kryterium 1: dla każdej roli z ROLES i każdej trasy z wymogiem MFA, która tę rolę
// dopuszcza, polityka prowadzi do zapisu MFA. Test jest generowany z macierzy tras
// (tests/helpers/route-matrix.js) i listy ról (src/pg/auth.js), bez bazy:
// - rola z MFA_REQUIRED_ROLES → bramka routera sama wymusza zapis (403 mfa_enrollment_required),
// - rola spoza listy (D-10 — wariant zachowawczy, lista bez zmian) → trasa musi odmawiać kodem
//   `mfa_enrollment_required`/`mfa_required`, nie 404 ani `forbidden`; kod odpowiedzi dla każdej
//   takiej pary sprawdza tests/pg-authz-matrix.test.js (mfaOnlyDenial), a opis — ten plik.
// Dane wyłącznie syntetyczne.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ROLES } from '../src/pg/auth.js';
import { DEFAULT_MFA_REQUIRED_ROLES, mfaRequiredRoles } from '../src/pg/mfa-policy.js';
import { ACTORS, ROUTE_MATRIX, mfaOnlyDenial, requiresMfa, voluntaryMfaRoutePairs } from './helpers/route-matrix.js';

const liveRoles = (actor) => actor.grants.filter((grant) => !grant.revoked && !grant.expiresAt).map((grant) => grant.role);

test('macierz obejmuje każdą rolę z ROLES aktywnym przydziałem (inaczej reguła nie byłaby sprawdzona dla tej roli)', () => {
  const covered = new Set(ACTORS.filter((actor) => !actor.unauthenticated).flatMap(liveRoles));
  assert.deepEqual(ROLES.filter((role) => !covered.has(role)), []);
});

test('domyślna lista ról z wymogiem MFA to ta sama lista, z której korzysta macierz (bez kopii)', () => {
  assert.deepEqual(mfaRequiredRoles({ MFA_REQUIRED_ROLES: undefined }), [...DEFAULT_MFA_REQUIRED_ROLES]);
  assert.ok(DEFAULT_MFA_REQUIRED_ROLES.every((role) => ROLES.includes(role)));
  // Aktor zarządu bez MFA jest zatrzymany przez bramkę na trasie wymagającej MFA — dowód, że helper czyta listę.
  const board = ACTORS.find((actor) => actor.key === 'board');
  const route = ROUTE_MATRIX.find((item) => item.id === 'payments.list');
  assert.equal(mfaOnlyDenial(route, board, false, 'W1'), 'gate');
});

test('każda trasa × rola z wymogiem MFA prowadzi do zapisu MFA: bramka dla ról z listy, kod odmowy trasy dla pozostałych', () => {
  let checked = 0;
  const problems = [];
  for (const route of ROUTE_MATRIX) {
    if (route.allow === 'public' || route.allow === 'authenticated') continue;
    for (const actor of ACTORS) {
      if (actor.unauthenticated || !requiresMfa(route, actor)) continue;
      for (const targetKey of route.allow[actor.key] ?? []) {
        if (!route.targets.includes(targetKey)) continue;
        checked += 1;
        const reason = mfaOnlyDenial(route, actor, false, targetKey);
        if (!reason) { problems.push(`${route.id} | ${actor.key} | ${targetKey}: brak powodu odmowy MFA`); continue; }
        // Bramka routera zawsze odpowiada 403 mfa_enrollment_required. Trasa — tylko gdy odmowa MFA
        // to 403; celowe 404 (dokumenty, bez wyroczni istnienia) byłoby ślepym zaułkiem dla roli spoza listy.
        if (reason === 'route' && (route.mfaDeny ?? 403) !== 403) {
          problems.push(`${route.id} | ${actor.key}: rola spoza MFA_REQUIRED_ROLES, a odmowa bez MFA to ${route.mfaDeny} — konto nie dostanie kodu prowadzącego do zapisu MFA`);
        }
      }
    }
  }
  assert.ok(checked > 50, `sprawdzono tylko ${checked} par — macierz nie została wczytana?`);
  assert.deepEqual(problems, []);
});

test('pary „rola spoza listy MFA × trasa z MFA” są opisane w docs/AUTHORIZATION.md kodem mfa_enrollment_required', async () => {
  const pairs = voluntaryMfaRoutePairs();
  const ids = [...new Set(pairs.map(({ route }) => route.id))].sort();
  // Dziś (#161): lista klasy dla przedstawiciela i raport Komisji Rewizyjnej. Nowa para dopisuje się sama
  // (test niżej wymaga opisu w dokumentacji), a zniknięcie tych dwóch oznacza zmianę polityki do opisania.
  assert.ok(ids.includes('exports.classRoster') && ids.includes('reconciliation.auditReport'), ids.join(', '));
  assert.ok(pairs.every(({ actor }) => !liveRoles(actor).some((role) => DEFAULT_MFA_REQUIRED_ROLES.includes(role))));
  const doc = await readFile(new URL('../docs/AUTHORIZATION.md', import.meta.url), 'utf8');
  const rows = doc.split('\n').filter((line) => line.startsWith('| `'));
  const missing = [];
  for (const id of ids) {
    const route = ROUTE_MATRIX.find((item) => item.id === id);
    const row = rows.find((line) => line.startsWith(`| \`${route.method} ${route.path}\``));
    if (!row || !row.includes('mfa_enrollment_required')) missing.push(`${route.method} ${route.path}`);
  }
  assert.deepEqual(missing, [], 'wiersz trasy w docs/AUTHORIZATION.md musi wspominać mfa_enrollment_required (#161)');
});
