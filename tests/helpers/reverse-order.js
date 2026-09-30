// Ręczna permutacja kolejności testów (#214). Node 22 nie ma `--test-shuffle`,
// więc niezależność testów od kolejności sprawdzamy, uruchamiając plik z
// ODWRÓCONĄ kolejnością rejestracji: `test`/`it` i `describe`/`suite` na
// każdym poziomie zagnieżdżenia wykonują się od ostatniego do pierwszego.
// Test, który po cichu korzysta ze stanu zostawionego przez poprzednika
// (wspólna baza, zmienna modułu), obleje taki przebieg.
//
// Użycie (tylko lokalnie/na żądanie, nie w domyślnym `npm test`):
//   npm run test:reverse -- tests/pg-families.test.js
// Moduł rejestruje hak ładowania, który dla plików testów podmienia
// `node:test` na nakładkę z tests/helpers/reverse-order-node-test.js.
import { register } from 'node:module';

const SHIM = new URL('./reverse-order-node-test.js', import.meta.url).href;
const hooks = `
const SHIM = ${JSON.stringify(SHIM)};
export async function resolve(specifier, context, next) {
  if ((specifier === 'node:test' || specifier === 'test') && context.parentURL !== SHIM) {
    return { url: SHIM, shortCircuit: true };
  }
  return next(specifier, context);
}`;

register(`data:text/javascript,${encodeURIComponent(hooks)}`, import.meta.url);
