// Mały walidator JSON Schema (podzbiór 2020-12 / OpenAPI 3.1) do testów kontraktu
// API (#160, tests/openapi-contract.test.js). Bez nowej zależności: schematy w
// src/pg/schemas używają wąskiego zestawu słów kluczowych, a walidator ODRZUCA
// (rzuca wyjątek) każde słowo kluczowe, którego nie zna — schemat z nieobsługiwanym
// słowem nie może po cichu przepuszczać odpowiedzi.
//
//   const problems = validateSchema(schema, value, { components: spec.components.schemas });
//   // [] = zgodne; w przeciwnym razie lista opisów z wskaźnikiem ścieżki, np. "/payment/amountCents: oczekiwano integer"
//
// Obsługiwane: $ref (lokalne `#/components/schemas/Nazwa`), type (też lista, `null`, `integer`),
// enum, const, properties, required, additionalProperties (bool albo schemat), items, minItems,
// maxItems, minLength, maxLength, pattern, minimum, maximum, format (`date`, `date-time`, `binary`),
// oneOf, anyOf, allOf. Słowa opisowe (description, title, default, example(s), deprecated, a od #160 etapu 11
// także writeOnly/readOnly — oznaczenie pól tajnych żądania, np. hasła i tokenu) są ignorowane.

const ANNOTATIONS = new Set(['description', 'title', 'default', 'example', 'examples', 'deprecated', '$comment', 'writeOnly', 'readOnly']);
const KEYWORDS = new Set([
  '$ref', 'type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'format', 'oneOf', 'anyOf', 'allOf',
]);
const FORMATS = {
  date(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
  },
  'date-time'(value) {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
  },
  binary() {
    return true;
  },
};

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(expected, value) {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'integer' || actual === 'number';
  return actual === expected;
}

function resolveRef(reference, components) {
  const match = /^#\/components\/schemas\/([A-Za-z0-9_.-]+)$/.exec(reference);
  if (!match) throw new Error(`nieobsługiwane odwołanie $ref: ${reference}`);
  const schema = components?.[match[1]];
  if (!schema) throw new Error(`brak schematu w components.schemas: ${match[1]}`);
  return schema;
}

function walk(schema, value, path, components, problems) {
  if (schema === true) return;
  if (schema === false) { problems.push(`${path || '/'}: schemat false odrzuca każdą wartość`); return; }
  if (!schema || typeof schema !== 'object') throw new Error(`niepoprawny schemat w ${path || '/'}`);
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) throw new Error(`nieobsługiwane słowo kluczowe schematu: ${key} (${path || '/'})`);
  }
  const at = path || '/';
  if (schema.$ref !== undefined) walk(resolveRef(schema.$ref, components), value, path, components, problems);

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((expected) => matchesType(expected, value))) {
      problems.push(`${at}: oczekiwano ${types.join('|')}, jest ${typeOf(value)}`);
      return;
    }
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    problems.push(`${at}: oczekiwano stałej ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    problems.push(`${at}: wartość ${JSON.stringify(value)} spoza enum`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(`${at}: za krótki tekst (${value.length} < ${schema.minLength})`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${at}: za długi tekst (${value.length} > ${schema.maxLength})`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) problems.push(`${at}: tekst nie pasuje do wzorca ${schema.pattern}`);
    if (schema.format !== undefined) {
      const check = FORMATS[schema.format];
      if (!check) throw new Error(`nieobsługiwany format schematu: ${schema.format}`);
      if (!check(value)) problems.push(`${at}: zły format ${schema.format}`);
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${at}: ${value} < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${at}: ${value} > maksimum ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${at}: za mało elementów (${value.length} < ${schema.minItems})`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${at}: za dużo elementów (${value.length} > ${schema.maxItems})`);
    if (schema.items !== undefined) value.forEach((item, index) => walk(schema.items, item, `${path}/${index}`, components, problems));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) problems.push(`${path}/${name}: brak wymaganego pola`);
    }
    for (const [name, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, name)) walk(properties[name], child, `${path}/${name}`, components, problems);
      else if (schema.additionalProperties === false) problems.push(`${path}/${name}: pole spoza schematu`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        walk(schema.additionalProperties, child, `${path}/${name}`, components, problems);
      }
    }
  }
  if (schema.allOf) for (const part of schema.allOf) walk(part, value, path, components, problems);
  if (schema.anyOf) {
    const results = schema.anyOf.map((part) => { const own = []; walk(part, value, path, components, own); return own; });
    if (!results.some((own) => own.length === 0)) problems.push(`${at}: żaden wariant anyOf nie pasuje (${results.map((own) => own[0]).join(' | ')})`);
  }
  if (schema.oneOf) {
    const results = schema.oneOf.map((part) => { const own = []; walk(part, value, path, components, own); return own; });
    const matching = results.filter((own) => own.length === 0).length;
    if (matching !== 1) problems.push(`${at}: oneOf wymaga dokładnie jednego dopasowania, jest ${matching}`);
  }
}

/**
 * @param {object} schema schemat (z `$ref` do `components`)
 * @param {unknown} value sprawdzana wartość
 * @param {{ components?: Record<string, object> }} [options] `components.schemas` specyfikacji
 * @returns {string[]} lista problemów (pusta = zgodne)
 */
export function validateSchema(schema, value, { components } = {}) {
  const problems = [];
  walk(schema, value, '', components, problems);
  return problems;
}
