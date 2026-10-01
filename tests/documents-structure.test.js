// Kontrola struktury pliku (issue #89): czyste funkcje, syntetyczne bajty.
// Heurystyka na surowych bajtach — nie zastępuje skanu antywirusowego
// (docs/DOCUMENTS.md, sekcja „Ryzyka i ograniczenia”).
import test from 'node:test';
import assert from 'node:assert/strict';

import { deflateSync } from 'node:zlib';

import { syntheticJpeg, syntheticPng, pngChunk } from './helpers/synthetic-images.js';
import { detectType, PDF_OBJECT_STREAM_MAX_BYTES, validateStructure } from '../src/documents.js';

const encoder = new TextEncoder();

const validPng = () => syntheticPng();
const validJpeg = () => syntheticJpeg();

test('poprawny PDF z %%EOF przechodzi kontrolę', () => {
  const bytes = encoder.encode('%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF\n');
  assert.deepEqual(validateStructure(bytes, 'application/pdf'), { ok: true });
});

test('PDF bez %%EOF w ostatnim 1 KiB jest odrzucony jako uszkodzony', () => {
  const bytes = encoder.encode('%PDF-1.4\n1 0 obj <<>> endobj\n');
  assert.deepEqual(validateStructure(bytes, 'application/pdf'), { ok: false, code: 'document_malformed' });
});

test('PDF poliglota z danymi ZIP doklejonymi po %%EOF jest odrzucony', () => {
  const pdf = encoder.encode('%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF\n');
  const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // 1 KiB odstępu, tak że %%EOF (koniec PDF-a) nie znajduje się już w ostatnim 1 KiB pliku.
  const padding = new Uint8Array(1200).fill(0x20);
  const bytes = new Uint8Array(pdf.length + padding.length + zip.length);
  bytes.set(pdf, 0);
  bytes.set(padding, pdf.length);
  bytes.set(zip, pdf.length + padding.length);
  assert.deepEqual(validateStructure(bytes, 'application/pdf'), { ok: false, code: 'document_malformed' });
});

test('PDF z /JavaScript, /Launch, /EmbeddedFile albo /Encrypt jest odrzucony jako aktywna treść', () => {
  for (const key of ['/JavaScript', '/JS', '/Launch', '/EmbeddedFile', '/RichMedia', '/XFA', '/Encrypt']) {
    const bytes = encoder.encode(`%PDF-1.4\n1 0 obj << ${key} 2 0 R >> endobj\n%%EOF\n`);
    assert.deepEqual(validateStructure(bytes, 'application/pdf'), { ok: false, code: 'document_active_content' }, key);
  }
});

test('słowo kluczowe zaszyte w treści bez ukośnika nie wywołuje fałszywego odrzucenia', () => {
  const bytes = encoder.encode('%PDF-1.4\n1 0 obj (JavaScript bez ukosnika) endobj\n%%EOF\n');
  assert.deepEqual(validateStructure(bytes, 'application/pdf'), { ok: true });
});

test('poprawny PNG (sygnatura + IHDR + IEND) przechodzi kontrolę', () => {
  assert.deepEqual(validateStructure(validPng(), 'image/png'), { ok: true });
});

test('PNG z danymi doklejonymi po IEND jest odrzucony', () => {
  const png = validPng();
  const bytes = new Uint8Array(png.length + 9);
  bytes.set(png, 0);
  bytes.set(encoder.encode('extradata'), png.length);
  assert.deepEqual(validateStructure(bytes, 'image/png'), { ok: false, code: 'document_malformed' });
});

test('PNG z uciętym łańcuchem chunków jest odrzucony', () => {
  const png = validPng();
  assert.deepEqual(validateStructure(png.subarray(0, png.length - 5), 'image/png'), { ok: false, code: 'document_malformed' });
});

test('poprawny JPEG (FF D9 na końcu) przechodzi kontrolę, z tolerancją na dopełnienie zerami', () => {
  assert.deepEqual(validateStructure(validJpeg(), 'image/jpeg'), { ok: true });
  const padded = new Uint8Array([...validJpeg(), 0, 0, 0]);
  assert.deepEqual(validateStructure(padded, 'image/jpeg'), { ok: true });
});

test('JPEG bez FF D9 na końcu (dane doklejone po znaczniku) jest odrzucony', () => {
  const bytes = new Uint8Array([...validJpeg(), 0x41, 0x42]);
  assert.deepEqual(validateStructure(bytes, 'image/jpeg'), { ok: false, code: 'document_malformed' });
});

test('typ spoza dozwolonej trójki jest zawsze odrzucony', () => {
  assert.deepEqual(validateStructure(encoder.encode('x'), 'text/csv'), { ok: false, code: 'document_malformed' });
  assert.deepEqual(validateStructure('not bytes', 'application/pdf'), { ok: false, code: 'document_malformed' });
});

test('nazwy PDF zapisane szesnastkowo (/J#61vaScript, /La#75nch) nie omijają kontroli (#89)', () => {
  for (const key of ['/J#61vaScript', '/#4AS', '/La#75nch', '/Embedded#46ile', '/#45ncrypt']) {
    const bytes = encoder.encode(`%PDF-1.4\n1 0 obj << ${key} 2 0 R >> endobj\n%%EOF\n`);
    assert.deepEqual(validateStructure(bytes, 'application/pdf'), { ok: false, code: 'document_active_content' }, key);
  }
});

test('/OpenAction: akcja wpisana w miejscu odrzucona, cel-strona (tablica/odnośnik) przechodzi (#89)', () => {
  const pdf = (body) => encoder.encode(`%PDF-1.4\n1 0 obj << ${body} >> endobj\n%%EOF\n`);
  assert.deepEqual(validateStructure(pdf('/OpenAction << /S /URI /URI (x) >>'), 'application/pdf'), { ok: false, code: 'document_active_content' });
  assert.deepEqual(validateStructure(pdf('/OpenAction [3 0 R /Fit]'), 'application/pdf'), { ok: true });
  assert.deepEqual(validateStructure(pdf('/OpenAction 5 0 R'), 'application/pdf'), { ok: true });
  // Odnośnik do akcji ze skryptem jest wychwycony przez słowo kluczowe akcji.
  assert.deepEqual(validateStructure(pdf('/OpenAction 5 0 R') && encoder.encode('%PDF-1.4\n<< /OpenAction 5 0 R >>\n5 0 obj << /S /JavaScript /JS (x) >>\n%%EOF\n'), 'application/pdf'), { ok: false, code: 'document_active_content' });
});

// --- #89 część 2: strumienie obiektów PDF, formularze, PNG, SVG -----------------------

// Syntetyczny PDF 1.5 ze słownikami schowanymi w skompresowanym strumieniu obiektów.
function pdfWithObjectStream(inner, { dict = '/Type /ObjStm /N 1 /First 4', compress = deflateSync, raw } = {}) {
  const payload = raw ?? compress(Buffer.from(`5 0 ${inner}`, 'latin1'));
  const head = Buffer.from(`%PDF-1.5\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n9 0 obj\n<< ${dict} /Length ${payload.length}${raw || compress === deflateSync ? ' /Filter /FlateDecode' : ''} >>\nstream\n`, 'latin1');
  const tail = Buffer.from('\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
  return new Uint8Array(Buffer.concat([head, payload, tail]));
}

test('słownik z /JavaScript albo /OpenAction << >> schowany w skompresowanym strumieniu obiektów jest odrzucony', () => {
  for (const inner of ['<< /S /JavaScript /JS (app.alert(1)) >>', '<< /OpenAction << /S /Launch /F (x.exe) >> >>', '<< /S /J#61vaScript >>', '<< /Type /Catalog /OpenAction << /S /URI /URI (x) >> >>']) {
    assert.deepEqual(validateStructure(pdfWithObjectStream(inner), 'application/pdf'), { ok: false, code: 'document_active_content' }, inner);
  }
});

test('strumień obiektów rozpoznany także bez /Type (klucz /First) i z nazwami zapisanymi szesnastkowo', () => {
  const inner = '<< /S /JavaScript >>';
  assert.deepEqual(validateStructure(pdfWithObjectStream(inner, { dict: '/N 1 /First 4' }), 'application/pdf'), { ok: false, code: 'document_active_content' });
  const escaped = pdfWithObjectStream(inner, { dict: '/Type /Obj#53tm /N 1 /First 4' });
  assert.deepEqual(validateStructure(escaped, 'application/pdf'), { ok: false, code: 'document_active_content' });
});

test('czysty skompresowany strumień obiektów przechodzi kontrolę', () => {
  const bytes = pdfWithObjectStream('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>');
  assert.deepEqual(validateStructure(bytes, 'application/pdf'), { ok: true });
});

test('skompresowany strumień treści/obrazu (nie ObjStm) nie jest przeszukiwany — brak fałszywych odrzuceń', () => {
  // Bajty "/JS" wewnątrz strumienia obrazu nie są słownikiem PDF.
  const data = deflateSync(Buffer.from('xx/JSyy/Launch binarne dane obrazu', 'latin1'));
  const head = Buffer.from(`%PDF-1.5\n7 0 obj\n<< /Type /XObject /Subtype /Image /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, 'latin1');
  const bytes = new Uint8Array(Buffer.concat([head, data, Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1')]));
  assert.deepEqual(validateStructure(bytes, 'application/pdf'), { ok: true });
});

test('strumień obiektów, którego nie da się sprawdzić, jest odrzucony jako uszkodzony', () => {
  const inner = '<< /S /JavaScript >>';
  const hex = Buffer.from(Buffer.from(`5 0 ${inner}`, 'latin1').toString('hex') + '>', 'latin1');
  const cases = {
    'filtr ASCIIHex': pdfWithObjectStream(inner, { dict: '/Type /ObjStm /N 1 /First 4 /Filter /ASCIIHexDecode', raw: undefined, compress: () => hex }),
    'łańcuch filtrów': pdfWithObjectStream(inner, { dict: '/Type /ObjStm /N 1 /First 4 /Filter [/ASCIIHexDecode /FlateDecode]', compress: () => hex }),
    'predyktor': pdfWithObjectStream(inner, { dict: '/Type /ObjStm /N 1 /First 4 /DecodeParms << /Predictor 12 /Columns 5 >>' }),
    'uszkodzone dane zlib': pdfWithObjectStream(inner, { raw: Buffer.from('to nie jest zlib', 'latin1') }),
  };
  for (const [label, bytes] of Object.entries(cases)) {
    assert.deepEqual(validateStructure(bytes, 'application/pdf'), { ok: false, code: 'document_malformed' }, label);
  }
});

test('„bomba” zlib w strumieniu obiektów (ponad limit rozpakowania) jest odrzucona bez rozpakowania całości', () => {
  const bomb = deflateSync(Buffer.alloc(PDF_OBJECT_STREAM_MAX_BYTES + 1024, 0x20));
  assert.ok(bomb.length < 64 * 1024, 'syntetyczna bomba jest mała po kompresji');
  assert.deepEqual(validateStructure(pdfWithObjectStream('', { raw: bomb }), 'application/pdf'), { ok: false, code: 'document_malformed' });
});

test('akcje formularza /SubmitForm i /ImportData są odrzucone (także w strumieniu obiektów)', () => {
  for (const key of ['/SubmitForm', '/ImportData', '/Submit#46orm']) {
    const bytes = encoder.encode(`%PDF-1.4\n1 0 obj << /S ${key} /F (https://example.invalid/x) >> endobj\n%%EOF\n`);
    assert.deepEqual(validateStructure(bytes, 'application/pdf'), { ok: false, code: 'document_active_content' }, key);
  }
  assert.deepEqual(validateStructure(pdfWithObjectStream('<< /S /SubmitForm >>'), 'application/pdf'), { ok: false, code: 'document_active_content' });
});

test('PNG: pierwszy chunk musi być IHDR, typ chunku to cztery litery ASCII', () => {
  const png = validPng();
  const noIhdr = png.slice();
  noIhdr.set([0x74, 0x45, 0x58, 0x74], 12); // tEXt zamiast IHDR
  assert.deepEqual(validateStructure(noIhdr, 'image/png'), { ok: false, code: 'document_malformed' });
  const badType = png.slice();
  badType.set([0x3c, 0x68, 0x3e, 0x00], 37); // "<h>\0" zamiast IEND
  assert.deepEqual(validateStructure(badType, 'image/png'), { ok: false, code: 'document_malformed' });
});

test('SVG (także zadeklarowany jako obraz) nie ma dozwolonej sygnatury i nie przechodzi detectType', () => {
  const svg = encoder.encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');
  assert.equal(detectType(svg), null);
  assert.equal(detectType(encoder.encode('<?xml version="1.0"?><svg/>')), null);
  // Struktura dla SVG/innych typów jest zawsze odrzucona (lista zamknięta).
  assert.deepEqual(validateStructure(svg, 'image/svg+xml'), { ok: false, code: 'document_malformed' });
});

test('strumień obiektów z długością pośrednią (/Length 12 0 R) jest rozpakowany do słowa endstream', () => {
  const build = (inner) => {
    const payload = deflateSync(Buffer.from(`5 0 ${inner}`, 'latin1'));
    return new Uint8Array(Buffer.concat([
      Buffer.from('%PDF-1.5\n9 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Length 12 0 R /Filter /FlateDecode >>\nstream\n', 'latin1'),
      payload,
      Buffer.from(`\nendstream\nendobj\n12 0 obj ${payload.length} endobj\n%%EOF\n`, 'latin1'),
    ]));
  };
  assert.deepEqual(validateStructure(build('<< /Type /Page >>'), 'application/pdf'), { ok: true });
  assert.deepEqual(validateStructure(build('<< /S /JavaScript >>'), 'application/pdf'), { ok: false, code: 'document_active_content' });
});

test('PNG: wymiary w IHDR muszą być dodatnie i w limicie, typ koloru i głębia spójne (#89)', () => {
  const bad = { ok: false, code: 'document_malformed' };
  assert.deepEqual(validateStructure(syntheticPng({ width: 1, height: 1 }), 'image/png'), { ok: true });
  for (const opts of [{ width: 0 }, { height: 0 }, { width: 30001 }, { width: 20000, height: 20000 },
    { bitDepth: 3 }, { colorType: 5 }, { colorType: 2, bitDepth: 4 }]) {
    assert.deepEqual(validateStructure(syntheticPng(opts), 'image/png'), bad, JSON.stringify(opts));
  }
});

test('PNG: błędna suma CRC chunku, brak IDAT albo zła długość IHDR są odrzucone (#89)', () => {
  const bad = { ok: false, code: 'document_malformed' };
  const png = syntheticPng();
  const flipped = png.slice();
  flipped[19] ^= 0x01; // bajt szerokości w IHDR, CRC przestaje pasować
  assert.deepEqual(validateStructure(flipped, 'image/png'), bad);
  assert.deepEqual(validateStructure(syntheticPng({ idat: false }), 'image/png'), bad);
  const shortIhdr = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk('IHDR', new Array(12).fill(1)), ...pngChunk('IDAT', [1, 2]), ...pngChunk('IEND')]);
  assert.deepEqual(validateStructure(shortIhdr, 'image/png'), bad);
});

test('JPEG: nagłówek ramki z dodatnimi wymiarami przed SOS jest wymagany, segmenty muszą mieścić się w pliku (#89)', () => {
  const bad = { ok: false, code: 'document_malformed' };
  assert.deepEqual(validateStructure(syntheticJpeg(), 'image/jpeg'), { ok: true });
  for (const opts of [{ width: 0 }, { height: 0 }, { precision: 0 }, { width: 30001 }, { width: 20000, height: 20000 }]) {
    assert.deepEqual(validateStructure(syntheticJpeg(opts), 'image/jpeg'), bad, JSON.stringify(opts));
  }
  const jpeg = syntheticJpeg();
  const sofAt = jpeg.findIndex((byte, i) => byte === 0xff && jpeg[i + 1] === 0xc0);
  assert.ok(sofAt > 0);
  // Bez SOF: wycinamy segment ramki (13 bajtów) — SOS bez nagłówka ramki.
  assert.deepEqual(validateStructure(Uint8Array.from([...jpeg.subarray(0, sofAt), ...jpeg.subarray(sofAt + 13)]), 'image/jpeg'), bad);
  // Segment dłuższy niż plik.
  const long = jpeg.slice();
  long[4] = 0xff; long[5] = 0xff;
  assert.deepEqual(validateStructure(long, 'image/jpeg'), bad);
  // Dwa nagłówki ramki.
  assert.deepEqual(validateStructure(Uint8Array.from([...jpeg.subarray(0, sofAt + 13), ...jpeg.subarray(sofAt)]), 'image/jpeg'), bad);
});
