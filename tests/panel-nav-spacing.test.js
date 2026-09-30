// Przegląd demo 5: w nawigacji Zebrań linki stały bez odstępu
// („RodzinyWpłatyKsięga…”), bo `nav a` miało poziomy padding 0, a odstęp `gap`
// z <nav> nie działa na linki w liście #shell-nav. Test statyczny: żaden arkusz
// panelu nie zeruje poziomego paddingu linków nawigacji.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const panels = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(new URL(`${entry.name}/styles.css`, root)))
  .map((entry) => entry.name);

// Selektor linku nawigacji (bez :hover/.active) → deklaracja padding.
const RULE = /(^|[},\s])((?:\.site-header\s+)?nav\s+a|#shell-nav\s+a)\s*\{([^}]*)\}/g;

function horizontalPadding(value) {
  const parts = value.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return parts[1];
}

test('linki nawigacji paneli mają poziomy odstęp (przegląd demo 5)', () => {
  assert.ok(panels.includes('meetings'));
  const offenders = [];
  for (const panel of panels) {
    const css = readFileSync(new URL(`${panel}/styles.css`, root), 'utf8');
    // Odstęp może dać lista linków (np. site/: `nav ul { gap: … }`); wspólny
    // shared/shell.css daje #shell-nav tylko .1rem, więc to się nie liczy.
    if (/(^|[},\s])(nav\s+ul|#shell-nav)\s*\{[^}]*\bgap\s*:\s*[^;}]*[1-9]/.test(css)) continue;
    for (const match of css.matchAll(RULE)) {
      const padding = /(?:^|;)\s*padding\s*:\s*([^;]+)/.exec(match[3]);
      if (!padding) continue;
      if (/^0(px|rem|em)?$/.test(horizontalPadding(padding[1]))) offenders.push(`${panel}: ${match[2]} { padding: ${padding[1].trim()} }`);
    }
  }
  assert.deepEqual(offenders, []);
});
