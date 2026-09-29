// Generuje import/public/template.xlsx (#109). Bez nowych zależności (fflate).
// Użycie: node scripts/build-import-template.js
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildTemplateXlsx } from '../import/template-xlsx.js';

const target = fileURLToPath(new URL('../import/public/template.xlsx', import.meta.url));
writeFileSync(target, buildTemplateXlsx());
console.log(`Zapisano ${target}`);
