// Bufor paczki eksportu rocznego na dysku (#216). Prototyp — opis w docs/EXPORT.md.
//
// Trasa POST /api/exports buduje paczkę w transakcji, a wysyła ją dopiero po
// COMMIT (status 200, nagłówki z SHA-256 i Content-Length są znane przed
// wysyłką, a wolny klient nie trzyma otwartej transakcji). Dotąd paczka czekała
// na wysyłkę w pamięci procesu (ok. jednej kopii rozmiaru pliku). Tu fragmenty
// idą od razu do pliku tymczasowego, więc pamięć nie zależy od liczby wierszy.
//
// Plik zawiera dane osobowe i finansowe. Dlatego:
// - katalog z mkdtemp (0700), plik 0600, otwarty jednym uchwytem do zapisu i odczytu;
// - nazwa jest usuwana od razu po otwarciu (plik anonimowy): nic nie zostaje na
//   dysku po zamknięciu uchwytu, także gdy proces zostanie zabity;
// - uchwyt zamyka koniec pobierania, przerwanie przez klienta, błąd budowy
//   albo bezczynność (SPOOL_IDLE_MS), gdy odpowiedzi nikt nie czyta.

import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SPOOL_READ_CHUNK_BYTES = 256 * 1024;
export const SPOOL_IDLE_MS = 5 * 60 * 1000;

let openSpools = 0;
/** Liczba otwartych buforów (testy: po pobraniu/przerwaniu ma wrócić do zera). */
export function activeExportSpools() {
  return openSpools;
}

export async function createExportSpool({ directory = tmpdir(), idleMs = SPOOL_IDLE_MS } = {}) {
  const folder = await mkdtemp(join(directory, 'rd-export-'));
  let handle;
  try {
    handle = await open(join(folder, 'bundle.json'), 'wx+', 0o600);
  } finally {
    // Nazwa znika od razu; na POSIX uchwyt nadal działa (plik anonimowy).
    await rm(folder, { recursive: true, force: true }).catch(() => {});
  }
  openSpools += 1;
  let size = 0;
  let closed = false;
  let idleTimer = null;

  const close = async () => {
    if (closed) return;
    closed = true;
    openSpools -= 1;
    if (idleTimer) clearTimeout(idleTimer);
    await handle.close().catch(() => {});
  };
  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { close(); }, idleMs);
    idleTimer.unref?.();
  };

  return {
    get size() { return size; },
    get closed() { return closed; },
    /** Zapis kolejnego fragmentu (oczekiwany: przeciążenie dysku wstrzymuje budowę paczki). */
    async write(buffer) {
      if (closed) throw new Error('export_spool_closed');
      let offset = 0;
      while (offset < buffer.byteLength) {
        const { bytesWritten } = await handle.write(buffer, offset, buffer.byteLength - offset, size + offset);
        offset += bytesWritten;
      }
      size += buffer.byteLength;
    },
    /** Początek od zera (ponowienie transakcji po 40001/40P01 buduje paczkę jeszcze raz). */
    async reset() {
      if (closed) throw new Error('export_spool_closed');
      await handle.truncate(0);
      size = 0;
    },
    discard: close,
    /**
     * Ciało odpowiedzi: czyta plik fragmentami na żądanie odbiorcy (pull), po
     * ostatnim fragmencie albo anulowaniu zamyka uchwyt. Bez odbiorcy uchwyt
     * zamyka się po `idleMs` bezczynności.
     */
    body() {
      let position = 0;
      touch();
      return new ReadableStream({
        async pull(controller) {
          if (closed) { controller.error(new Error('export_spool_closed')); return; }
          touch();
          if (position >= size) { await close(); controller.close(); return; }
          const length = Math.min(SPOOL_READ_CHUNK_BYTES, size - position);
          const chunk = Buffer.allocUnsafe(length);
          const { bytesRead } = await handle.read(chunk, 0, length, position);
          if (!bytesRead) { await close(); controller.error(new Error('export_spool_truncated')); return; }
          position += bytesRead;
          controller.enqueue(bytesRead === length ? chunk : chunk.subarray(0, bytesRead));
        },
        async cancel() { await close(); },
      }, { highWaterMark: 1 });
    },
  };
}
