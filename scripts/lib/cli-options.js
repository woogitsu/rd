// Prosty parser opcji `--nazwa=wartość` i `--flaga` dla skryptów operatorskich
// (bez zależności). Nieznana opcja, powtórzona opcja jednokrotna i argument
// pozycyjny to błędy — skrypt nie zgaduje, co operator miał na myśli.
//
//   parseCliOptions(argv, { values: ['actor'], repeatable: ['log'], flags: ['dry-run'] })
//   -> { values: { actor: 'u-1' }, lists: { log: ['a.json'] }, flags: Set { 'dry-run' }, errors: [] }
export function parseCliOptions(argv, { values = [], repeatable = [], flags = [] } = {}) {
  const out = { values: {}, lists: Object.fromEntries(repeatable.map((name) => [name, []])), flags: new Set(), errors: [] };
  for (const arg of argv) {
    if (!arg.startsWith('--')) { out.errors.push('unexpected_argument'); continue; }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    const value = eq < 0 ? null : arg.slice(eq + 1);
    if (flags.includes(name)) {
      if (value !== null) out.errors.push(`flag_takes_no_value:${name}`);
      else out.flags.add(name);
    } else if (values.includes(name)) {
      if (!value) out.errors.push(`missing_value:${name}`);
      else if (name in out.values) out.errors.push(`duplicate_option:${name}`);
      else out.values[name] = value;
    } else if (repeatable.includes(name)) {
      if (!value) out.errors.push(`missing_value:${name}`);
      else out.lists[name].push(value);
    } else {
      out.errors.push(`unknown_option:${name}`);
    }
  }
  return out;
}
