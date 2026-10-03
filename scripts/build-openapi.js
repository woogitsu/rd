// Generator docs/openapi.json (issue #160): OpenAPI 3.1 wyprowadzone z
// tests/helpers/route-matrix.js (ścieżki, metody, role, MFA, statusy), z katalogu
// kodów błędów docs/API_ERRORS.md oraz — od etapu 2 — ze schematów ciał żądań i
// odpowiedzi w src/pg/schemas/<moduł>.js (rejestr: src/pg/schemas/index.js).
// Bez zależności — czysty Node.
//
//   npm run openapi:build           # regeneruje docs/openapi.json
//   npm run openapi:build -- --check  # 0 = aktualny, 1 = trzeba regenerować
//
// Schematy mają dziś tylko moduły z `COVERED_MODULES` (wpłaty, księga z preliminarzem, kasą i centrami
// kosztów, rodziny, sesja, uzgodnienia wyciągów z raportem KR, kampanie e-mail, zebrania, dokumenty, wydarzenia, aktualności,
// administracja kont i ról, logowanie i MFA, historia obiektu, ścieżka kontroli KR, sprawozdanie roczne z migawkami,
// eksporty, kartki, pulpity zarządu i przedstawiciela, wnioski opiekunów, import, zamknięcie roku, informacja
// o przetwarzaniu danych); pozostałe są
// jawnie wymienione w `UNCOVERED_MODULES` i `x-rd-schema-coverage`. Generator nie zmienia
// tras. Role w `x-rd-roles` są ZAŁOŻENIAMI z docs/AUTHORIZATION.md (D-08/D-09) —
// „do zatwierdzenia” przez zarząd/szkołę.
// Plik jest deterministyczny: wszystkie klucze i listy są posortowane.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ACTORS, ROUTE_MATRIX, TARGETS, denyStatus, requiresMfa } from '../tests/helpers/route-matrix.js';
import { COVERED_MODULES, ROUTE_SCHEMAS, UNCOVERED_MODULES, schemaComponents } from '../src/pg/schemas/index.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const OPENAPI_PATH = `${ROOT}docs/openapi.json`;
const ERRORS_PATH = `${ROOT}docs/API_ERRORS.md`;

const ACTOR_BY_KEY = new Map(ACTORS.map((actor) => [actor.key, actor]));
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const uniqSorted = (items, compare = byString) => [...new Set(items)].sort(compare);

// Rola z aktora macierzy; przydział zarządu zawężony do klasy dostaje sufiks „:class”.
function roleOf(actorKey) {
  const actor = ACTOR_BY_KEY.get(actorKey);
  if (!actor) throw new Error(`nieznany aktor macierzy: ${actorKey}`);
  const role = actor.grants[0]?.role;
  return actor.classBoard ? `${role}:class` : role;
}

// Kody błędów z tabeli katalogu: | `kod` | znaczenie | czy ponawiać |
export function parseErrorCatalog(markdown) {
  const rows = [];
  for (const match of markdown.matchAll(/^\| `([a-z][a-z0-9_]*)` \| (.*) \| ([^|]*) \|$/gm)) {
    rows.push({ code: match[1], meaning: match[2].trim(), retry: match[3].trim() });
  }
  return rows.sort((a, b) => byString(a.code, b.code));
}

// Szablon macierzy → ścieżka OpenAPI i parametry ({param}, zapytanie z `?a=:b`).
function splitPath(template) {
  const [rawPath, rawQuery] = template.split('?');
  const path = rawPath.replace(/:([A-Za-z]\w*)/g, '{$1}');
  const parameters = [];
  for (const name of uniqSorted([...rawPath.matchAll(/:([A-Za-z]\w*)/g)].map((m) => m[1]))) {
    parameters.push({ name, in: 'path', required: true, schema: { type: 'string' } });
  }
  for (const pair of (rawQuery ?? '').split('&').filter(Boolean)) {
    const [name] = pair.split('=');
    parameters.push({ name, in: 'query', required: false, schema: { type: 'string' } });
  }
  return { path, parameters };
}

function describeEntry(route) {
  const targets = route.targets ?? ['-'];
  const publicRoute = route.allow === 'public';
  const authenticatedOnly = route.allow === 'authenticated';
  const allow = typeof route.allow === 'object' ? route.allow : {};
  const allowedActors = Object.keys(allow).sort(byString);
  const roles = uniqSorted(allowedActors.map(roleOf));
  const actorScopes = Object.fromEntries(allowedActors.map((key) => [key, [...allow[key]].sort(byString)]));

  // Statusy odmowy dla zalogowanych spoza uprawnień (wszystkie zakresy trasy, z MFA i bez).
  const denies = new Set();
  if (!publicRoute) {
    for (const actor of ACTORS) {
      if (actor.unauthenticated) continue;
      for (const targetKey of targets) {
        if ((allow[actor.key] ?? []).includes(targetKey) && !authenticatedOnly) continue;
        if (authenticatedOnly) continue;
        for (const mfa of [false, true]) denies.add(denyStatus(route, actor, targetKey, mfa));
      }
    }
  }
  if (authenticatedOnly) denies.add(denyStatus(route, ACTORS.find((a) => a.key === 'noGrant'), targets[0], true));

  const mfaRoles = typeof route.mfa === 'function'
    ? uniqSorted(allowedActors.filter((key) => requiresMfa(route, ACTOR_BY_KEY.get(key))).map(roleOf))
    : null;
  return {
    publicRoute, authenticatedOnly, roles, actorScopes,
    denyStatuses: [...denies].sort((a, b) => a - b),
    mfa: mfaRoles ? { requiredFor: mfaRoles } : Boolean(route.mfa),
    mfaDeny: route.mfaDeny ?? 403,
  };
}

const RESPONSE_TEXT = {
  200: 'Sukces.', 201: 'Utworzono.', 204: 'Sukces, bez treści.',
  400: 'Błąd walidacji żądania (kod z katalogu).', 401: 'Brak ważnej sesji.',
  403: 'Brak uprawnień lub wymaganego MFA (kod z katalogu).',
  404: 'Nie znaleziono albo obiekt poza zakresem (polityka 403/404 zależy od modułu).',
  409: 'Konflikt stanu albo klucza idempotencji (kod z katalogu).',
  413: 'Żądanie albo wynik za duży (kod z katalogu).',
  415: 'Nieobsługiwany typ treści (kod z katalogu).',
  422: 'Treść poprawna składniowo, ale odrzucona regułą (kod z katalogu).',
  429: 'Zbyt wiele prób (kod z katalogu; nagłówek Retry-After).',
  503: 'Usługa chwilowo niedostępna (kod z katalogu).',
};

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

// Odpowiedź sukcesu ze schematu trasy (src/pg/schemas): treść JSON albo plik; `content`
// (mapa typ → schemat) opisuje trasę z kilkoma formatami (parametr `format`); bez `schema`
// i `content` (np. 204 wylogowania) odpowiedź nie ma treści.
function schemaResponse(spec) {
  const response = { description: spec.description };
  if (spec.content) {
    response.content = Object.fromEntries(Object.entries(spec.content).map(([type, schema]) => [type, { schema }]));
  } else if (spec.schema !== undefined) {
    response.content = { [spec.contentType ?? 'application/json']: { schema: spec.schema } };
  }
  if (spec.replayed) {
    // Jedna wartość albo lista (#160 etap 5): zapis bez klucza idempotencji, np. zatwierdzenie
    // uzgodnienia, zwraca 200 i przy pierwszym wykonaniu (`false`), i przy ponowieniu (`true`).
    const values = [spec.replayed].flat();
    const text = {
      true: 'true: odpowiedź odtworzona po tym samym kluczu idempotencji, bez nowego zapisu.',
      false: 'false: zapis wykonany teraz.',
    };
    response.headers = {
      'Idempotency-Replayed': {
        description: values.length === 1 ? text[values[0]]
          : 'false: zapis wykonany teraz; true: ponowienie rozpoznane po osobie i treści, bez nowego zapisu.',
        schema: { type: 'string', enum: values },
      },
    };
  }

  // Nagłówek tylko przy ponowieniu (#160 etap 6): zapis bez klucza idempotencji (np. zatwierdzenie
  // kampanii e-mail) przy pierwszym wykonaniu odpowiada bez nagłówka, a ponowienie wysyła `true`.
  // Opcjonalny klucz idempotencji (#160 etap 12, rejestracja żądania osoby): `false` tylko przy zapisie z kluczem.
  if (spec.replayedOptional) {
    response.headers['Idempotency-Replayed'].required = false;
    response.headers['Idempotency-Replayed'].description = [spec.replayed].flat().includes('true')
      ? 'true: ponowienie rozpoznane po stanie obiektu, bez nowego zapisu; brak nagłówka: zapis wykonany teraz.'
      : 'false: zapis wykonany teraz z nagłówkiem Idempotency-Key; brak nagłówka: zapis bez klucza (klucz jest opcjonalny).';
  }
  return response;
}

// Parametry operacji z uwzględnieniem schematu trasy: identyfikatory ścieżki jako `Id`,
// zapytanie ze schematu (nadpisuje typ z macierzy), nagłówek Idempotency-Key.
function schemaParameters(parameters, entry) {
  const result = parameters.map((parameter) => (parameter.in === 'path' ? { ...parameter, schema: ref('Id') } : parameter));
  for (const [name, spec] of Object.entries(entry.query ?? {})) {
    const next = { name, in: 'query', required: Boolean(spec.required), schema: spec.schema };
    if (spec.description) next.description = spec.description;
    const index = result.findIndex((parameter) => parameter.in === 'query' && parameter.name === name);
    if (index >= 0) result[index] = next;
    else result.push(next);
  }
  if (entry.idempotencyKey) {
    result.push({
      name: 'Idempotency-Key', in: 'header', required: entry.idempotencyKey === true, schema: ref('IdempotencyKey'),
    });
  }
  return result;
}

// Dołącza schematy trasy do operacji: requestBody, odpowiedzi sukcesu z kształtem i kody błędów.
function applySchema(operation, entry) {
  if (entry.body) {
    // `bodyOptional` (#160 etap 12): trasa przyjmuje też żądanie bez treści i bez Content-Type.
    operation.requestBody = { required: !entry.bodyOptional, content: { 'application/json': { schema: entry.body } } };
  }
  // Ciało inne niż JSON (#160 etap 8): przesłanie dokumentu to surowe bajty pliku — mapa typ treści → schemat.
  if (entry.bodyContent) {
    if (entry.body) throw new Error('wpis trasy ma jednocześnie `body` i `bodyContent`');
    operation.requestBody = {
      required: true,
      ...(entry.bodyDescription ? { description: entry.bodyDescription } : {}),
      content: Object.fromEntries(Object.entries(entry.bodyContent).map(([type, schema]) => [type, { schema }])),
    };
  }
  for (const [status, spec] of Object.entries(entry.responses)) operation.responses[status] = schemaResponse(spec);
  for (const [status, codes] of Object.entries(entry.errors ?? {})) {
    const existing = operation.responses[status];
    if (existing?.$ref) throw new Error(`kody błędów dla statusu ${status} wskazującego wspólną odpowiedź (${existing.$ref})`);
    const response = existing ?? { description: RESPONSE_TEXT[status] ?? 'Błąd (kod z katalogu).', content: errorContent() };
    response['x-rd-error-codes'] = uniqSorted([...(response['x-rd-error-codes'] ?? []), ...codes]);
    // Opis błędu właściwy trasie (#160 etap 11), np. 401 logowania to złe dane logowania, a nie brak sesji.
    if (entry.errorDescriptions?.[status]) response.description = entry.errorDescriptions[status];
    // Pusta lista: status wynika z macierzy tras, ale trasa go nie zwraca (np. 403 dla tras sesji).
    if (!response['x-rd-error-codes'].length) {
      response.description = 'Status z macierzy tras (x-rd-deny-status); trasa go nie zwraca, więc lista kodów jest pusta.';
    }
    operation.responses[status] = response;
  }
  const orphanedDescriptions = Object.keys(entry.errorDescriptions ?? {}).filter((status) => !entry.errors?.[status]?.length);
  if (orphanedDescriptions.length) throw new Error(`opis błędu bez kodów dla statusu: ${orphanedDescriptions.join(', ')}`);
  operation.responses = sortKeys(operation.responses);
}

function operationFor(entries) {
  const described = entries.map((route) => ({ route, info: describeEntry(route) }));
  const first = described[0];
  const merged = described.length > 1;
  const okStatuses = uniqSorted(described.map(({ route }) => route.ok), (a, b) => a - b);
  const denyStatuses = uniqSorted(described.flatMap(({ info }) => info.denyStatuses), (a, b) => a - b);
  const publicRoute = described.every(({ info }) => info.publicRoute);
  const responses = {};
  for (const status of okStatuses) responses[String(status)] = { description: RESPONSE_TEXT[status] ?? 'Sukces.' };
  if (!publicRoute) responses['401'] = { $ref: '#/components/responses/Unauthenticated' };
  for (const status of denyStatuses) {
    if (status >= 400 && !responses[String(status)]) {
      responses[String(status)] = { description: RESPONSE_TEXT[status] ?? 'Odmowa.', content: errorContent() };
    }
  }
  const roles = uniqSorted(described.flatMap(({ info }) => info.roles));
  const op = {
    operationId: first.route.id.replace(/[^A-Za-z0-9_]/g, '_'),
    tags: [first.route.module],
    summary: first.route.id,
    responses: sortKeys(responses),
    security: publicRoute ? [] : [{ sessionCookie: [] }],
    'x-rd-matrix-ids': described.map(({ route }) => route.id).sort(byString),
    'x-rd-roles': roles,
    'x-rd-roles-status': 'założenie D-08/D-09 (docs/AUTHORIZATION.md), do zatwierdzenia',
    'x-rd-access': publicRoute ? 'public' : described.every(({ info }) => info.authenticatedOnly) ? 'authenticated' : 'role',
    'x-rd-mfa': merged ? mergeMfa(described.map(({ info }) => info.mfa)) : first.info.mfa,
    'x-rd-deny-status': denyStatuses,
    'x-rd-ok-status': okStatuses,
    'x-rd-actor-scopes': merged ? undefined : first.info.actorScopes,
  };
  if (first.info.mfaDeny !== 403 || described.some(({ info }) => info.mfaDeny !== 403)) {
    op['x-rd-mfa-deny-status'] = uniqSorted(described.map(({ info }) => info.mfaDeny), (a, b) => a - b);
  }
  if (merged) {
    op['x-rd-variants'] = described.map(({ route, info }) => ({
      id: route.id, roles: info.roles, actorScopes: info.actorScopes,
    })).sort((a, b) => byString(a.id, b.id));
    op.description = 'Ta ścieżka i metoda ma kilka wpisów macierzy (rodzaj obiektu wybiera treść żądania); '
      + 'x-rd-roles to suma, szczegóły w x-rd-variants.';
  }
  for (const key of Object.keys(op)) if (op[key] === undefined) delete op[key];
  return op;
}

function mergeMfa(values) {
  if (values.every((value) => value === true)) return true;
  if (values.every((value) => value === false)) return false;
  return { requiredFor: uniqSorted(values.flatMap((value) => (value && value.requiredFor) || [])), mixed: true };
}

const errorContent = () => ({
  'application/json': { schema: { $ref: '#/components/schemas/Error' } },
});

function sortKeys(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => byString(a, b)));
}

export function buildOpenApi(errorCatalogMarkdown) {
  const catalog = parseErrorCatalog(errorCatalogMarkdown);
  if (!catalog.length) throw new Error('docs/API_ERRORS.md: brak tabeli kodów');
  const groups = new Map();
  for (const route of ROUTE_MATRIX) {
    const { path } = splitPath(route.path);
    const key = `${path}\u0000${route.method.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, { path, method: route.method.toLowerCase(), parameters: splitPath(route.path).parameters, entries: [] });
    const group = groups.get(key);
    group.entries.push(route);
    // Parametry zapytania z różnych wpisów tej samej trasy łączymy po nazwie.
    for (const parameter of splitPath(route.path).parameters) {
      if (!group.parameters.some((p) => p.name === parameter.name && p.in === parameter.in)) group.parameters.push(parameter);
    }
  }
  const paths = {};
  const usedSchemaKeys = new Set();
  for (const group of [...groups.values()].sort((a, b) => byString(a.path, b.path) || byString(a.method, b.method))) {
    const operation = operationFor(group.entries);
    const schemaKey = `${group.method.toUpperCase()} ${group.path}`;
    const schemaEntry = ROUTE_SCHEMAS.get(schemaKey);
    let parameters = group.parameters;
    if (schemaEntry) {
      usedSchemaKeys.add(schemaKey);
      applySchema(operation, schemaEntry);
      parameters = schemaParameters(parameters, schemaEntry);
    }
    if (parameters.length) {
      operation.parameters = [...parameters].sort((a, b) => byString(a.in, b.in) || byString(a.name, b.name));
    }
    (paths[group.path] ??= {})[group.method] = sortKeys(operation);
  }
  const orphaned = [...ROUTE_SCHEMAS.keys()].filter((key) => !usedSchemaKeys.has(key));
  if (orphaned.length) throw new Error(`schematy bez trasy w macierzy: ${orphaned.join(', ')}`);
  const modules = uniqSorted(ROUTE_MATRIX.map((route) => route.module));
  const operations = Object.values(paths).flatMap((item) => Object.values(item));
  const withSchema = operations.filter((operation) => operation.tags.some((tag) => COVERED_MODULES.includes(tag))).length;
  const schemas = {
    ErrorCode: { type: 'string', enum: catalog.map((row) => row.code), description: 'Kody z docs/API_ERRORS.md.' },
    Error: {
      type: 'object', required: ['error'], additionalProperties: true,
      properties: { error: { $ref: '#/components/schemas/ErrorCode' } },
    },
  };
  for (const [name, schema] of Object.entries(schemaComponents())) {
    if (Object.hasOwn(schemas, name)) throw new Error(`schemat komponentu koliduje z wbudowanym: ${name}`);
    schemas[name] = schema;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'API Rady Rodziców (wewnętrzne, szkic)',
      version: '0.2.0',
      description: 'Plik GENEROWANY przez scripts/build-openapi.js z tests/helpers/route-matrix.js, docs/API_ERRORS.md '
        + 'i src/pg/schemas/*.js; nie edytuj ręcznie (npm run openapi:build). Ścieżki, metody, role, MFA, statusy i kody '
        + 'błędów opisują wszystkie trasy; schematy ciał żądań i odpowiedzi mają dopiero moduły wymienione w '
        + 'x-rd-schema-coverage (pozostałe operacje nie mają requestBody ani kształtu odpowiedzi). Błędy routera '
        + 'wspólne dla wszystkich tras (invalid_origin, read_only, service_unavailable, bramka MFA) są w katalogu kodów, '
        + 'a nie powtarzane przy każdej operacji. Role w x-rd-roles to założenia z docs/AUTHORIZATION.md '
        + '(D-08/D-09), do zatwierdzenia przez zarząd/szkołę — nie są rozstrzygnięciem. Dokument opisuje trasy '
        + 'wewnętrzne i nie jest publikowany publicznie. Zakresy w x-rd-actor-scopes to znaczniki macierzy testowej: '
        + Object.values(TARGETS).map((t) => `${t.key} (${t.classId ?? 'bez klasy'}, ${t.schoolYearId})`).join('; ') + '.',
    },
    tags: modules.map((name) => ({ name })),
    'x-rd-schema-coverage': {
      covered: [...COVERED_MODULES],
      uncovered: uniqSorted(UNCOVERED_MODULES),
      operations: { total: operations.length, withSchema },
    },
    paths,
    components: {
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: '__Host-rd_session', description: 'Sesja serwerowa; w środowisku lokalnym cookie nazywa się rd_session.' },
      },
      responses: {
        Unauthenticated: { description: RESPONSE_TEXT[401], content: errorContent() },
      },
      schemas: sortKeys(schemas),
      'x-rd-error-catalog': catalog.map((row) => ({ code: row.code, meaning: row.meaning, retry: row.retry })),
    },
  };
}

export async function renderOpenApi() {
  return `${JSON.stringify(buildOpenApi(await readFile(ERRORS_PATH, 'utf8')), null, 2)}\n`;
}

async function main() {
  const expected = await renderOpenApi();
  if (process.argv.includes('--check')) {
    const current = await readFile(OPENAPI_PATH, 'utf8').catch(() => '');
    if (current !== expected) {
      console.error('docs/openapi.json jest nieaktualny — uruchom: npm run openapi:build');
      process.exit(1);
    }
    console.log('docs/openapi.json jest aktualny');
    return;
  }
  await writeFile(OPENAPI_PATH, expected);
  console.log('Zapisano docs/openapi.json');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
