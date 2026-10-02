// Podgląd PDF w panelu dokumentów (issue #89): biblioteka PDF.js dołączona do repozytorium
// (pdfjs-dist, bez CDN), worker serwowany z tego samego originu jako zasób bundla.
// Bajty pobiera wywołujący z autoryzowanego endpointu (purpose=preview); tu tylko
// renderowanie stron do <canvas>. Bez warstwy adnotacji (brak linków i formularzy),
// bez XFA, bez eval (CSP `script-src 'self'` zostaje bez zmian).
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// Opcje getDocument, które utrzymują podgląd w granicach CSP i bez aktywnej treści.
export const PDF_LOAD_OPTIONS = Object.freeze({
  isEvalSupported: false,
  enableXfa: false,
  disableFontFace: true,
  useWorkerFetch: false,
  // Czcionki standardowe z własnego originu (documents/vite.config.js), bez CDN.
  standardFontDataUrl: new URL("./standard_fonts/", import.meta.url).href,
  useSystemFonts: false,
  stopAtErrors: false,
});

export function pageLabel(page, total) {
  return `Strona ${page} z ${total}`;
}

// Montuje podgląd w `container`; zwraca { destroy }. `bytes` to Uint8Array/ArrayBuffer.
export async function mountPdfPreview(container, bytes, { onError } = {}) {
  const task = pdfjsLib.getDocument({ ...PDF_LOAD_OPTIONS, data: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes) });
  let destroyed = false;
  let current = 1;
  let rendering = null;
  let pdf;
  try {
    pdf = await task.promise;
  } catch (error) {
    await task.destroy().catch(() => {});
    throw error;
  }
  const total = pdf.numPages;

  const controls = document.createElement("div");
  controls.className = "pdf-controls";
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "Stronicowanie podglądu PDF");
  const prev = document.createElement("button");
  prev.type = "button";
  prev.textContent = "Poprzednia";
  prev.setAttribute("aria-label", "Poprzednia strona");
  const next = document.createElement("button");
  next.type = "button";
  next.textContent = "Następna";
  next.setAttribute("aria-label", "Następna strona");
  const status = document.createElement("span");
  status.className = "pdf-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  controls.append(prev, status, next);

  const canvas = document.createElement("canvas");
  canvas.className = "pdf-canvas";
  canvas.setAttribute("role", "img");
  container.replaceChildren(controls, canvas);

  async function show(number) {
    current = Math.min(Math.max(number, 1), total);
    const label = pageLabel(current, total);
    status.textContent = label;
    canvas.setAttribute("aria-label", label);
    canvas.title = label;
    prev.disabled = current <= 1;
    next.disabled = current >= total;
    rendering?.cancel();
    try {
      const page = await pdf.getPage(current);
      if (destroyed) return;
      const base = page.getViewport({ scale: 1 });
      const width = Math.max(container.clientWidth || 600, 200);
      const scale = Math.min(Math.max(width / base.width, 0.25), 3);
      const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: scale * ratio });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
      canvas.style.maxWidth = "100%";
      canvas.style.height = "auto";
      rendering = page.render({ canvas, viewport, annotationMode: pdfjsLib.AnnotationMode.DISABLE, background: "#ffffff" });
      await rendering.promise;
      canvas.dataset.renderedPage = String(current);
    } catch (error) {
      if (destroyed || error?.name === "RenderingCancelledException") return;
      onError?.(error);
    }
  }

  prev.addEventListener("click", () => { show(current - 1); });
  next.addEventListener("click", () => { show(current + 1); });
  await show(1);

  return {
    destroy() {
      destroyed = true;
      rendering?.cancel();
      task.destroy().catch(() => {});
      container.replaceChildren();
    },
  };
}
