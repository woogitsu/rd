// Jeden resolver zakresu przydziałów (issue #155): rok, klasa, MFA — zamiast
// dziewięciu lokalnych implementacji (families.js#scopeFromGrants,
// events.js/news.js, meetings.js#contextFor, print.js#printScope,
// documents.js, import.js, year-close.js, export.js#guardianScope/
// householdScope).
//
// `resolveScope` odpowiada na to samo pytanie, które dziś każdy moduł liczy
// po swojemu: „dla ról R (i roku Y, jeśli podany) — czy wywołujący ma zakres
// szkolny, a jeśli nie, to które pary (klasa, rok)?”. Semantyka pokrywa się z
// `isAuthorized` z `src/authorization.js` (patrz test własności w
// tests/pg-scope.test.js) — to jest źródło prawdy, `resolveScope` go tylko
// rozkłada na kształt użyteczny do budowania SQL.
//
// WAŻNE (SR-01): przydział z `classId` NIGDY nie daje zakresu szkolnego, nawet
// jeśli wywołujący pyta bez `classId` w wymogu — to samo rozróżnienie, które
// `schoolWideContext`/`isAuthorizedScoped` w `src/pg/authorization.js` robią
// filtrując `context.grants`. `resolveScope` liczy `schoolWide` wyłącznie z
// przydziałów bez `classId`.
//
// Ten moduł NIE jest jeszcze wpięty w żaden istniejący moduł tras — migracja
// `families.js` i pozostałych ośmiu miejsc zostaje do kolejnych PR (moduł po
// module, z macierzą autoryzacji jako siatką bezpieczeństwa), zgodnie z
// propozycją w #155.

/**
 * @typedef {{role: string, classId?: string|null, schoolYearId?: string|null}} Grant
 * @typedef {{session: {mfaVerified: boolean}, grants: Grant[]}} AuthContext
 * @typedef {{roles: string[], schoolYearId?: string, requireMfa?: boolean}} ScopeRequirement
 * @typedef {{classId: string, schoolYearId: string|null}} ClassScope
 * @typedef {{any: boolean, schoolWide: boolean, years: 'all'|string[], classes: ClassScope[]}} Scope
 */

const EMPTY_SCOPE = Object.freeze({ any: false, schoolWide: false, years: [], classes: [] });

/**
 * @param {AuthContext} context
 * @param {ScopeRequirement} requirement
 * @returns {Scope}
 */
export function resolveScope(context, requirement) {
  const roles = Array.isArray(requirement?.roles) ? requirement.roles : [];
  if (!context?.session || !Array.isArray(context.grants) || !roles.length) return EMPTY_SCOPE;
  if (requirement.requireMfa && !context.session.mfaVerified) return EMPTY_SCOPE;

  let schoolWide = false;
  let allYears = false;
  const years = new Set();
  const classes = [];

  for (const grant of context.grants) {
    if (!roles.includes(grant.role)) continue;
    // Wymóg z konkretnym rokiem: przydział na inny rok nie pasuje (tak samo
    // jak isAuthorized — patrz komentarz przy schoolYearId niżej).
    if (requirement.schoolYearId && grant.schoolYearId && grant.schoolYearId !== requirement.schoolYearId) continue;

    if (grant.classId) {
      classes.push({ classId: grant.classId, schoolYearId: grant.schoolYearId ?? null });
    } else if (grant.schoolYearId) {
      years.add(grant.schoolYearId);
      schoolWide = true;
    } else {
      allYears = true;
      schoolWide = true;
    }
  }

  return {
    any: schoolWide || classes.length > 0,
    schoolWide,
    years: allYears ? 'all' : [...years],
    classes,
  };
}

/**
 * SQL warunkujący, czy wiersz z kolumną klasy `classAlias` (odwołanie do
 * tabeli/aliasu klas z `id` i kolumną roku `yearColumn`) mieści się w zakresie.
 * Parametry zaczynają się od `firstParam` (koniec ze stałym `$1–$4` z
 * `families.js`).
 *
 * @param {Scope} scope
 * @param {object} options
 * @param {string} options.classAlias alias tabeli klas w zapytaniu (kolumna `id`)
 * @param {string} [options.yearColumn] kolumna roku na aliasie klas, domyślnie `school_year_id`
 * @param {number} [options.firstParam] numer pierwszego wolnego parametru (domyślnie 1)
 * @returns {{sql: string, params: unknown[]}}
 */
export function scopeSql(scope, { classAlias, yearColumn = 'school_year_id', firstParam = 1 } = {}) {
  const p1 = firstParam;
  const p2 = firstParam + 1;
  const p3 = firstParam + 2;
  const p4 = firstParam + 3;
  const classIds = scope.classes.map((entry) => entry.classId);
  const classYears = scope.classes.map((entry) => entry.schoolYearId);
  const sql = `($${p1}::boolean OR ${classAlias}.${yearColumn} = ANY($${p2}::text[])
  OR EXISTS (SELECT 1 FROM unnest($${p3}::text[], $${p4}::text[]) AS g(class_id, school_year_id)
              WHERE g.class_id = ${classAlias}.id AND (g.school_year_id IS NULL OR g.school_year_id = ${classAlias}.${yearColumn})))`;
  const params = [
    scope.schoolWide && scope.years === 'all',
    scope.schoolWide && scope.years !== 'all' ? scope.years : [],
    classIds,
    classYears,
  ];
  return { sql, params };
}

/** Zakres wyłącznie klasowy — przedstawiciel, także zarząd z przydziałem klasy (bez zakresu szkolnego). */
export function isClassOnlyScope(scope) {
  return scope.any && !scope.schoolWide;
}
