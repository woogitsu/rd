// Klient testów kontraktu API (#160, etap 2): wykonuje PRAWDZIWE żądania przez router
// (`handlePgRequest`) i sprawdza je względem wygenerowanej specyfikacji docs/openapi.json:
//   * operacja (metoda + ścieżka) istnieje w specyfikacji,
//   * ciało żądania zgodne ze schematem `requestBody` (chyba że test wysyła je celowo błędne),
//   * parametry zapytania są opisane w operacji,
//   * status odpowiedzi jest opisany, a treść JSON zgodna ze schematem tej odpowiedzi
//     (pliki: zgodny Content-Type), nagłówek Idempotency-Replayed zgodny ze specyfikacją,
//   * kod błędu należy do `x-rd-error-codes` danego statusu.
// Zebrane trójki `METODA /ścieżka status` (`client.validated`) pozwalają testowi sprawdzić,
// że każda odpowiedź sukcesu opisana w schematach została choć raz zwalidowana na prawdziwej odpowiedzi.
import assert from 'node:assert/strict';
import { validateSchema } from './json-schema.js';
import { request } from './pg.js';

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {{ spec: object, fetch: (req: Request) => Promise<Response> }} options
 */
export function createContractClient({ spec, fetch }) {
  const components = spec.components.schemas;
  const operations = Object.entries(spec.paths).map(([path, item]) => ({
    path,
    item,
    regex: new RegExp(`^${path.split(/\{[^}]+\}/).map(escapeRegex).join('[^/]+')}$`),
  }));
  const validated = new Set();

  function findOperation(method, pathname) {
    // Najpierw ścieżki bez parametrów (np. /api/ledger/categories/copy), potem szablony.
    const matching = operations.filter((operation) => operation.regex.test(pathname) && operation.item[method.toLowerCase()]);
    matching.sort((a, b) => (a.path.match(/\{/g)?.length ?? 0) - (b.path.match(/\{/g)?.length ?? 0));
    const found = matching[0];
    assert.ok(found, `brak operacji w docs/openapi.json: ${method} ${pathname}`);
    return { path: found.path, operation: found.item[method.toLowerCase()] };
  }

  function resolveResponse(declared) {
    if (!declared.$ref) return declared;
    const name = declared.$ref.replace('#/components/responses/', '');
    return spec.components.responses[name];
  }

  /**
   * @param {string} method
   * @param {string} path ścieżka z zapytaniem
   * @param {{ cookie?: string, body?: unknown, key?: string, expect: number, invalidRequest?: boolean, origin?: string|false }} options
   */
  async function call(method, path, { cookie, body, key, expect, invalidRequest = false, origin } = {}) {
    assert.ok(Number.isInteger(expect), 'call: podaj oczekiwany status (expect)');
    const url = new URL(path, 'https://rd.test');
    const { path: template, operation } = findOperation(method, url.pathname);

    if (!invalidRequest) {
      for (const name of url.searchParams.keys()) {
        assert.ok(operation.parameters?.some((p) => p.in === 'query' && p.name === name),
          `${method} ${template}: parametr zapytania „${name}” nie jest opisany w specyfikacji`);
      }
      if (key !== undefined) {
        assert.ok(operation.parameters?.some((p) => p.in === 'header' && p.name === 'Idempotency-Key'),
          `${method} ${template}: wysłano Idempotency-Key, a specyfikacja go nie opisuje`);
      }
      if (body !== undefined) {
        const schema = operation.requestBody?.content?.['application/json']?.schema;
        assert.ok(schema, `${method} ${template}: wysłano ciało, a specyfikacja nie opisuje requestBody`);
        assert.deepEqual(validateSchema(schema, body, { components }), [], `${method} ${template}: ciało żądania niezgodne ze schematem`);
      }
    }

    const headers = key ? { 'Idempotency-Key': key } : {};
    const response = await fetch(request(path, { method, cookie, body, headers, origin }));
    const contentType = response.headers.get('Content-Type') ?? '';
    const isJson = contentType.includes('application/json');
    const text = isJson ? await response.text() : null;
    const parsed = text ? JSON.parse(text) : null;
    const bytes = isJson ? null : new Uint8Array(await response.arrayBuffer());
    assert.equal(response.status, expect, `${method} ${path}: status ${response.status}, oczekiwano ${expect}; treść: ${text ?? `[${bytes.length} B]`}`);

    const declared = operation.responses[String(response.status)];
    assert.ok(declared, `${method} ${template}: status ${response.status} nie jest opisany w specyfikacji`);
    const described = resolveResponse(declared);
    const replayedHeader = response.headers.get('Idempotency-Replayed');
    const replayedSpec = described.headers?.['Idempotency-Replayed'];
    if (replayedSpec) {
      assert.ok(replayedSpec.schema.enum.includes(replayedHeader),
        `${method} ${template} ${response.status}: nagłówek Idempotency-Replayed „${replayedHeader}” niezgodny ze specyfikacją`);
    } else {
      assert.equal(replayedHeader, null, `${method} ${template} ${response.status}: odpowiedź ma Idempotency-Replayed, a specyfikacja go nie opisuje`);
    }
    if (described.content) {
      const [declaredType, media] = Object.entries(described.content)[0];
      if (declaredType === 'application/json') {
        assert.ok(isJson, `${method} ${template} ${response.status}: oczekiwano JSON, jest ${contentType}`);
        assert.deepEqual(validateSchema(media.schema, parsed, { components }), [],
          `${method} ${template} ${response.status}: odpowiedź niezgodna ze schematem`);
      } else {
        assert.equal(contentType, declaredType, `${method} ${template} ${response.status}: zły Content-Type`);
        assert.ok(bytes.length > 0, `${method} ${template} ${response.status}: pusty plik`);
      }
    }
    if (response.status >= 400 && parsed) {
      assert.ok(Object.hasOwn(components, 'ErrorCode') && components.ErrorCode.enum.includes(parsed.error),
        `${method} ${template} ${response.status}: kod „${parsed.error}” spoza katalogu docs/API_ERRORS.md`);
      const codes = described['x-rd-error-codes'];
      if (codes) {
        assert.ok(codes.includes(parsed.error),
          `${method} ${template} ${response.status}: kod „${parsed.error}” nie jest wymieniony w x-rd-error-codes (${codes.join(', ')})`);
      }
    }
    validated.add(`${method} ${template} ${response.status}`);
    return { status: response.status, body: parsed, bytes, headers: response.headers, template };
  }

  return { call, validated, findOperation };
}
