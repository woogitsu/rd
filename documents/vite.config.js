// Konfiguracja budowy panelu dokumentów. Jedyna różnica względem domyślnej: czcionki
// standardowe PDF.js (Foxit/Liberation z pakietu pdfjs-dist, ta sama wersja co biblioteka)
// trafiają do dist/documents/assets/standard_fonts/ i są serwowane z własnego originu
// (bez CDN). Bez nich PDF z niewbudowanymi czcionkami (np. Helvetica) nie ma tekstu.
import { readdirSync, readFileSync } from "node:fs";

const FONTS = new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url);

export default {
  plugins: [{
    name: "pdfjs-standard-fonts",
    generateBundle() {
      for (const name of readdirSync(FONTS)) {
        this.emitFile({ type: "asset", fileName: `assets/standard_fonts/${name}`, source: readFileSync(new URL(name, FONTS)) });
      }
    },
  }],
};
