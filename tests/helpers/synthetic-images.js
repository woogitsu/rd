// Syntetyczne obrazy do testów kontroli struktury (#89): generowane w teście,
// bez prawdziwych dokumentów. PNG z poprawnymi sumami CRC, JPEG z minimalnymi
// segmentami (SOI, APP0, SOF0, SOS, EOI) — strukturalnie poprawne, nie do dekodowania.
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const ascii = (text) => [...text].map((ch) => ch.charCodeAt(0));

export function pngChunk(type, data = []) {
  const body = [...ascii(type), ...data];
  return [...u32(data.length), ...body, ...u32(crc32(Uint8Array.from(body)))];
}

export function syntheticPng({ width = 2, height = 2, bitDepth = 8, colorType = 2, idat = true } = {}) {
  const ihdr = pngChunk('IHDR', [...u32(width), ...u32(height), bitDepth, colorType, 0, 0, 0]);
  const data = idat ? pngChunk('IDAT', [...deflateSync(Buffer.from([0, 1, 2, 3]))]) : [];
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr, ...data, ...pngChunk('IEND')]);
}

export function syntheticJpeg({ width = 2, height = 2, precision = 8 } = {}) {
  const app0 = [0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [0xff, 0xc0, 0, 11, precision, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0];
  const sos = [0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x12, 0x34];
  return Uint8Array.from([0xff, 0xd8, ...app0, ...sof, ...sos, 0xff, 0xd9]);
}
