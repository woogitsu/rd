// Generator docs/openapi.json (issue #160, etap 1): OpenAPI 3.1 wyprowadzone z
// tests/helpers/route-matrix.js (ścieżki, metody, role, MFA, statusy) oraz z
// katalogu kodów błędów docs/API_ERRORS.md. Bez zależności — czysty Node.
//
//   npm run openapi:build           # regeneruje docs/openapi.json
//   npm run openapi:build -- --check  # 0 = aktualny, 1 = trzeba regenerować
//
// Etap 1 NIE opisuje schematów ciał żądań/odpowiedzi (to kolejny etap: schematy
// obok parserów) ani nie zmienia tras. Role w `x-rd-roles` są ZAŁOŻENIAMI z
// docs/AUTHORIZATION.md (D-08/D-09) — „do zatwierdzenia” przez zarząd/szkołę.
// Plik jest deterministyczny: wszystkie klucze i listy są posortowane.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ACTORS, ROUTE_MATRIX, TARGETS, denyStatus, requiresMfa } from '../tests/helpers/route-matrix.js';

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
};

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
  for (const group of [...groups.values()].sort((a, b) => byString(a.path, b.path) || byString(a.method, b.method))) {
    const operation = operationFor(group.entries);
    if (group.parameters.length) {
      operation.parameters = [...group.parameters].sort((a, b) => byString(a.in, b.in) || byString(a.name, b.name));
    }
    (paths[group.path] ??= {})[group.method] = sortKeys(operation);
  }
  const modules = uniqSorted(ROUTE_MATRIX.map((route) => route.module));
  return {
    openapi: '3.1.0',
    info: {
      title: 'API Rady Rodziców (wewnętrzne, szkic)',
      version: '0.1.0',
      description: 'Plik GENEROWANY przez scripts/build-openapi.js z tests/helpers/route-matrix.js i docs/API_ERRORS.md; '
        + 'nie edytuj ręcznie (npm run openapi:build). Etap 1: ścieżki, metody, role, MFA, statusy i kody błędów; '
        + 'brak schematów ciał żądań i odpowiedzi. Role w x-rd-roles to założenia z docs/AUTHORIZATION.md '
        + '(D-08/D-09), do zatwierdzenia przez zarząd/szkołę — nie są rozstrzygnięciem. Dokument opisuje trasy '
        + 'wewnętrzne i nie jest publikowany publicznie. Zakresy w x-rd-actor-scopes to znaczniki macierzy testowej: '
        + Object.values(TARGETS).map((t) => `${t.key} (${t.classId ?? 'bez klasy'}, ${t.schoolYearId})`).join('; ') + '.',
    },
    tags: modules.map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: '__Host-rd_session', description: 'Sesja serwerowa; w środowisku lokalnym cookie nazywa się rd_session.' },
      },
      responses: {
        Unauthenticated: { description: RESPONSE_TEXT[401], content: errorContent() },
      },
      schemas: {
        ErrorCode: { type: 'string', enum: catalog.map((row) => row.code), description: 'Kody z docs/API_ERRORS.md.' },
        Error: {
          type: 'object', required: ['error'], additionalProperties: true,
          properties: { error: { $ref: '#/components/schemas/ErrorCode' } },
        },
      },
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
