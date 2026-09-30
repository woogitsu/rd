// Nakładka na `node:test` dla tests/helpers/reverse-order.js (#214): zbiera
// rejestracje testów i zestawów, a następnie przekazuje je do prawdziwego
// `node:test` w odwrotnej kolejności. Haki (before/after/…) i wszystkie inne
// eksporty (mock, t.test itd.) działają bez zmian.
import * as real from 'node:test';

export * from 'node:test';

let collector = null; // lista rejestracji bieżącego poziomu (null = poziom pliku)
const root = [];
let flushScheduled = false;

function registerReversed(items) {
  for (const item of [...items].reverse()) {
    if (item.kind === 'describe') {
      const { name, options, fn } = item;
      real.describe(name, options, function (...args) {
        const previous = collector;
        const children = [];
        collector = children;
        let result;
        try {
          result = fn.apply(this, args);
        } finally {
          collector = previous;
        }
        registerReversed(children);
        return result;
      });
    } else {
      real.test(item.name, item.options, item.fn);
    }
  }
}

function normalize(name, options, fn) {
  if (typeof name === 'function') return { name: name.name || '<anonimowy>', options: {}, fn: name };
  if (typeof options === 'function') return { name, options: {}, fn: options };
  return { name, options: options ?? {}, fn };
}

function push(kind, extra, name, options, fn) {
  const item = { kind, ...normalize(name, options, fn) };
  item.options = { ...item.options, ...extra };
  if (collector) {
    collector.push(item);
    return;
  }
  root.push(item);
  if (!flushScheduled) {
    flushScheduled = true;
    // Plik testów rejestruje wszystko synchronicznie przy ewaluacji modułu;
    // po jej zakończeniu przekazujemy poziom pliku w odwrotnej kolejności.
    setImmediate(() => registerReversed(root.splice(0)));
  }
}

function variant(kind) {
  const fn = (name, options, body) => push(kind, {}, name, options, body);
  fn.skip = (name, options, body) => push(kind, { skip: true }, name, options, body);
  fn.todo = (name, options, body) => push(kind, { todo: true }, name, options, body);
  fn.only = (name, options, body) => push(kind, { only: true }, name, options, body);
  return fn;
}

export const test = variant('test');
export const it = test;
export const describe = variant('describe');
export const suite = describe;
test.describe = describe;
test.it = it;
test.test = test;
test.suite = suite;
for (const hook of ['before', 'after', 'beforeEach', 'afterEach']) test[hook] = real[hook];
test.mock = real.mock;
export default test;
