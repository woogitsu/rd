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
// jeśli wywołujący pyta bez `classId` w wymogu. `resolveScope` liczy
// `schoolWide` wyłącznie z przydziałów bez `classId`; `isAuthorizedScoped`
// (także za `requireAccess` w src/pg/authorization.js) jest z niego liczone.
//
// Moduły `src/pg/**` NIE filtrują `context.grants`/`actor.grants` samodzielnie
// ani nie wołają surowego `isAuthorized` — korzystają z funkcji poniżej
// (pilnuje tego test statyczny w tests/pg-routes-wiring.test.js). Opis:
// docs/AUTHORIZATION.md, sekcja „Jeden resolver zakresu”.

import { isAuthorized } from '../authorization.js';

/**
 * @typedef {{role: string, classId?: string|null, schoolYearId?: string|null}} Grant
 * @typedef {{session: {mfaVerified: boolean}, grants: Grant[]}} AuthContext
 * @typedef {{roles: string[], schoolYearId?: string, requireMfa?: unknown, schoolWideRoles?: Iterable<string>}} ScopeRequirement
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

  // `schoolWideRoles` (opcjonalnie): role, których przydział BEZ `classId`
  // daje zakres szkolny; przydział bez klasy innej roli jest wtedy pomijany.
  // Używa tego wyłącznie moduł rodzin (dawne `scopeFromGrants`, WIDE_ROLES) —
  // przy ograniczeniu bazy `representative_requires_class` (0001) różnica
  // jest dziś nieosiągalna, ale zostaje zachowana 1:1 (refaktor #155 bez
  // zmiany zachowania).
  const wideRoles = requirement.schoolWideRoles ? new Set(requirement.schoolWideRoles) : null;
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
    } else if (wideRoles && !wideRoles.has(grant.role)) {
      continue;
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
  return { sql: scopeSqlFragment({ classAlias, yearColumn, firstParam }), params: scopeSqlParams(scope) };
}

/** Sam fragment SQL z `scopeSql` (bez wartości) — gdy moduł składa kilka warunków na tych samych parametrach. */
export function scopeSqlFragment({ classAlias, yearColumn = 'school_year_id', firstParam = 1 } = {}) {
  const p1 = firstParam;
  const p2 = firstParam + 1;
  const p3 = firstParam + 2;
  const p4 = firstParam + 3;
  return `($${p1}::boolean OR ${classAlias}.${yearColumn} = ANY($${p2}::text[])
  OR EXISTS (SELECT 1 FROM unnest($${p3}::text[], $${p4}::text[]) AS g(class_id, school_year_id)
              WHERE g.class_id = ${classAlias}.id AND (g.school_year_id IS NULL OR g.school_year_id = ${classAlias}.${yearColumn})))`;
}

/**
 * Wartości czterech parametrów `scopeSqlFragment`: [wszystkie lata, lata
 * szkolne, klasy, lata klas]. Pierwsze dwa to także gotowy filtr roku
 * (`$a::boolean OR rok = ANY($b)`) dla danych szkolnych.
 */
export function scopeSqlParams(scope) {
  return [
    scope.schoolWide && scope.years === 'all',
    scope.schoolWide && scope.years !== 'all' ? scope.years : [],
    scope.classes.map((entry) => entry.classId),
    scope.classes.map((entry) => entry.schoolYearId),
  ];
}

/** Zakres wyłącznie klasowy — przedstawiciel, także zarząd z przydziałem klasy (bez zakresu szkolnego). */
export function isClassOnlyScope(scope) {
  return scope.any && !scope.schoolWide;
}

/** Zakres szkolny obejmuje rok `schoolYearId` (przydział bez klasy na ten rok albo bez roku). */
export function scopeCoversYear(scope, schoolYearId) {
  return scope.schoolWide && (scope.years === 'all' || scope.years.includes(schoolYearId));
}

/**
 * Identyfikatory klas z przydziałów klasowych zakresu (bez powtórzeń, w
 * kolejności przydziałów). Z `schoolYearId` — tylko przydziały tego roku albo
 * bez roku. Zakres liczony już z `schoolYearId` w wymogu jest zawężony wcześniej.
 */
export function scopeClassIds(scope, schoolYearId) {
  const ids = scope.classes
    .filter((entry) => !schoolYearId || entry.schoolYearId === null || entry.schoolYearId === schoolYearId)
    .map((entry) => entry.classId);
  return [...new Set(ids)];
}

/** Klasy, dla których wywołujący ma przydział KLASOWY spełniający wymóg (rola, rok, MFA). */
export function authorizedClassIds(context, requirement) {
  return scopeClassIds(resolveScope(context, requirement));
}

/**
 * Bramka zakresu (SR-01/SR-02): z `classId` — przydział szkolny albo przydział
 * tej klasy; bez `classId` — WYŁĄCZNIE przydział bez `classId`. Wynik zgodny z
 * dawnym `isAuthorized(schoolWideContext(context), …)` / `isAuthorized(context, …)`
 * (test własności w tests/pg-scope.test.js).
 */
export function isAuthorizedScoped(context, requirement) {
  const scope = resolveScope(context, requirement);
  if (scope.schoolWide) return true;
  const classId = requirement?.classId;
  return Boolean(classId) && scope.classes.some((entry) => entry.classId === classId);
}

/**
 * Wyłącznie przydział KLASOWY dla `requirement.classId` (przydział szkolny się
 * nie liczy) — np. szkic wydarzenia/aktualności własnej klasy przedstawiciela,
 * gdzie zakres szkolny sprawdza się osobno innym zestawem ról.
 */
export function isAuthorizedForOwnClass(context, requirement) {
  const classId = requirement?.classId;
  if (!classId) return false;
  return resolveScope(context, requirement).classes.some((entry) => entry.classId === classId);
}

/**
 * Jakikolwiek pasujący przydział — także klasowy, gdy wymóg nie podaje klasy
 * (surowe `isAuthorized`). Tylko do bramki listy, której wiersze są dalej
 * filtrowane zakresem (np. lista zebrań/rejestr uchwał); nigdy jako zgoda na
 * dane całej szkoły (SR-01).
 */
export function hasAnyMatchingGrant(context, requirement) {
  return isAuthorized(context, requirement);
}

/** Kontekst z przydziałami bez `classId` — zgodność wsteczna dla modułów sprzed #155. */
export function schoolWideContext(context) {
  if (!context || !Array.isArray(context.grants)) return context;
  return { ...context, grants: context.grants.filter((grant) => !grant.classId) };
}

/**
 * Kontekst autoryzacji z „aktora” modułów domenowych (events/news/meetings:
 * `{ userId, grants, mfaVerified }`). Bez `userId` lub tablicy przydziałów —
 * `null` (każda bramka odmawia).
 */
export function actorContext(actor) {
  if (!actor?.userId || !Array.isArray(actor.grants)) return null;
  return { session: { user: { id: actor.userId }, mfaVerified: Boolean(actor.mfaVerified) }, grants: actor.grants };
}
