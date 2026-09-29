// Syntetyczne PDF-y do pokazu (scripts/demo-seed.js) — generowane w kodzie, bez
// plików binarnych w repozytorium i bez jakichkolwiek danych osobowych.
// Minimalny, poprawny PDF 1.4: jedna strona A4, czcionka standardowa Helvetica,
// tabela xref z prawdziwymi przesunięciami, %%EOF na końcu. Bez skryptów,
// akcji, osadzonych plików i szyfrowania — przechodzi tę samą walidację
// struktury (src/documents.js validateStructure) co plik z banku.
// Tekst tylko ASCII (bez polskich znaków), bo czcionka standardowa nie ma ich
// w kodowaniu WinAnsi; polskie tytuły trafiają do opisu dokumentu w panelu.

function pdfText(value) {
  return String(value).replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1');
}

export function buildDemoPdf({ title, lines }) {
  const content = [
    'BT /F1 18 Tf 56 780 Td 22 TL',
    `(${pdfText(title)}) Tj`,
    '/F1 11 Tf',
    ...lines.flatMap((line) => ['T*', `(${pdfText(line)}) Tj`]),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Uint8Array.from(out, (ch) => ch.charCodeAt(0));
}

export const DEMO_INVOICE_PDF = Object.freeze({
  title: 'Faktura - przyklad demo',
  lines: [
    'Dokument syntetyczny wygenerowany w kodzie demo. To nie jest prawdziwa faktura.',
    '',
    'Wystawca: Przykladowy Sklep (fikcyjny)',
    'Nabywca: Rada Rodzicow (dane przykladowe)',
    'Data: 2026-11-05',
    'Pozycja: Materialy plastyczne na zajecia dodatkowe',
    'Kwota: 150,00 EUR',
  ],
});

export const DEMO_MINUTES_PDF = Object.freeze({
  title: 'Protokol - przyklad demo',
  lines: [
    'Dokument syntetyczny wygenerowany w kodzie demo. To nie jest prawdziwy protokol.',
    '',
    'Zebranie zarzadu Rady (dane przykladowe), 2026-11-20',
    'Omowiono biezace wplaty i plan wydatkow na rok szkolny 2026/2027.',
    'Bez uchwal na tym zebraniu.',
  ],
});
