// Czyste funkcje kodu QR do kartek (#92). Bez zależności sieciowych: biblioteka
// qrcode-generator jest już w repo (używana w login/core.js dla TOTP) i działa
// wyłącznie lokalnie w przeglądarce — dane nigdy nie trafiają do żadnej usługi
// zewnętrznej. Osobny moduł od login/core.js, bo tamten qrMatrix waliduje
// wyłącznie adresy otpauth://; tu kodujemy dowolny tekst (ładunek EPC).

import qrcode from "qrcode-generator";

// Macierz modułów kodu QR (poziom korekcji M, tryb bajtowy, wersja dobierana
// automatycznie przez bibliotekę na podstawie długości tekstu).
export function qrMatrix(text, correction = "M") {
  const value = String(text ?? "");
  if (!value) throw new Error("empty_qr_text");
  const qr = qrcode(0, correction);
  qr.addData(value, "Byte");
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => qr.isDark(row, col)));
}

// Ścieżka SVG (jeden <path>) z marginesem `quiet` modułów (norma QR wymaga co
// najmniej 4). Zwraca { size, d } — size to bok kwadratu w jednostkach modułu,
// przydatny do ustawienia viewBox="0 0 size size".
export function qrSvgPath(matrix, quiet = 4) {
  const size = matrix.length + quiet * 2;
  const parts = [];
  matrix.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) { x += 1; continue; }
      const start = x;
      while (x < row.length && row[x]) x += 1;
      parts.push(`M${start + quiet} ${y + quiet}h${x - start}v1h-${x - start}z`);
    }
  });
  return { size, d: parts.join("") };
}

// Gotowy znacznik <svg> (string) do osadzenia w kartce. `title` trafia do
// <title> dla czytników ekranu — obok kodu QR kartka i tak pokazuje pełny
// tekst IBAN/tytułu (dostępność, druk czarno-biały, patrz #92 AC).
export function qrSvgMarkup(text, { quiet = 4, title = "Kod QR do przelewu" } = {}) {
  const { size, d } = qrSvgPath(qrMatrix(text), quiet);
  const escapedTitle = String(title).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
  return `<svg class="card-qr-svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${escapedTitle}" xmlns="http://www.w3.org/2000/svg"><title>${escapedTitle}</title><path d="${d}" /></svg>`;
}
