// Regresja z przeglądu UI przed pokazem dla zarządu: `dialog:not(:has(form)){…}`
// w email/styles.css i year-close/styles.css nadpisywało domyślne `display:none`
// przeglądarki dla zamkniętego <dialog>, gdy okno nie zawierało bezpośrednio
// <form> (recipients-dialog, close-dialog, handover-dialog) — dialog był widoczny
// od razu po wejściu na stronę, zanim ktokolwiek go otworzył. Poprawka:
// `dialog[open]:not(:has(form))`. Ten test przegląda WSZYSTKIE aplikacje statyczne
// (jak w tests/a11y-static.test.js), żeby ten sam wzorzec nie wrócił gdzie indziej.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const nodeAppSource = readFileSync(new URL('../src/node-app.js', import.meta.url), 'utf8');
const staticPrefixesLiteral = nodeAppSource.match(/STATIC_PREFIXES = new Set\(\[([^\]]*)\]\)/)[1];
const APPS = [...staticPrefixesLiteral.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// Znajduje reguły CSS, których selektor to `dialog` (dowolna kombinacja
// pseudoklas/pseudoelementów) i które ustawiają `display` na coś innego niż
// `none`, BEZ warunku `[open]` w selektorze. Taka reguła nadpisuje domyślne
// UA-stylesheet (`dialog:not([open]){display:none}`) dla zamkniętego okna.
function findUnopenedDialogDisplayRules(css) {
  const problems = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectorList = match[1];
    const body = match[2];
    if (!/display\s*:(?!\s*none\b)/.test(body)) continue;
    for (const selector of selectorList.split(',')) {
      const trimmed = selector.trim();
      // Selektor musi dotyczyć DOKŁADNIE elementu <dialog> — sam tag plus
      // wyłącznie doklejone pseudoklasy/atrybuty (np. "dialog:not(:has(form))",
      // "dialog[open]"), bez kombinatora (spacja, >, +, ~), który przesunąłby
      // regułę na potomka jak "dialog form" albo "dialog h2". Odrzuca też
      // np. ".dialog-heading", gdzie "dialog" jest częścią nazwy klasy.
      if (!/^dialog(?![a-z0-9-])/i.test(trimmed)) continue;
      const rest = trimmed.slice('dialog'.length);
      if (/[\s>+~]/.test(rest)) continue; // kombinator → dotyczy potomka, nie samego <dialog>
      if (/\[open\]/.test(trimmed)) continue; // ograniczone do stanu otwartego — OK
      problems.push(trimmed);
    }
  }
  return problems;
}

test('wykrywacz łapie celowo wstawioną regresję (fixture)', () => {
  assert.deepEqual(
    findUnopenedDialogDisplayRules('dialog:not(:has(form)){display:grid}'),
    ['dialog:not(:has(form))'],
  );
  assert.deepEqual(findUnopenedDialogDisplayRules('dialog[open]:not(:has(form)){display:grid}'), []);
  assert.deepEqual(findUnopenedDialogDisplayRules('dialog{display:none}'), []); // display:none jest zawsze bezpieczne
  assert.deepEqual(findUnopenedDialogDisplayRules('.dialog-heading{display:flex}'), []); // nie dotyczy <dialog>
});

for (const app of APPS) {
  test(`${app}/styles.css: żadna reguła nie pokazuje zamkniętego <dialog> (brak [open])`, () => {
    let css;
    try {
      css = read(`${app}/styles.css`);
    } catch {
      return; // aplikacja bez własnego styles.css (np. korzysta wyłącznie z shared/)
    }
    assert.deepEqual(findUnopenedDialogDisplayRules(css), []);
  });
}

test('shared/*.css: żadna reguła nie pokazuje zamkniętego <dialog> (brak [open])', () => {
  for (const path of ['shared/shell.css', 'shared/print.css']) {
    assert.deepEqual(findUnopenedDialogDisplayRules(read(path)), [], path);
  }
});
