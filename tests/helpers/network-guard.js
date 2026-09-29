// Pułapka na sieć dla testów (#214): żaden test nie może wykonać prawdziwego
// żądania HTTP — AGENTS.md zabrania wysyłki do prawdziwego rodzica z zadania
// testowego. Wcześniej pułapka istniała tylko lokalnie w tests/pg-email.test.js
// i chroniła jedynie ten plik. Instalacja jest efektem ubocznym importu tego
// modułu (idempotentna — bezpieczna przy wielokrotnym imporcie w jednym
// procesie), więc każdy plik, który korzysta z tests/helpers/pg.js, dostaje
// ochronę automatycznie.
let installed = false;
let realFetch;
let calls = 0;

export function installNetworkGuard() {
  if (installed) return;
  installed = true;
  realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    // Testy serwera HTTP łączą się z własnym procesem przez pętlę zwrotną —
    // to nie jest ruch do świata zewnętrznego.
    if (isLoopback(input)) return realFetch(input, init);
    calls += 1;
    throw new Error('network_forbidden_in_tests');
  };
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
export function isLoopback(input) {
  try {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    return LOOPBACK_HOSTS.has(new URL(raw).hostname);
  } catch {
    return false;
  }
}

// Liczba prób sieciowych przechwyconych od startu procesu (wszystkie pliki
// współdzielą jeden licznik w ramach procesu testowego).
export function networkGuardCalls() {
  return calls;
}

// Tylko do użytku diagnostycznego/testów samej pułapki — produkcyjne testy
// nie powinny przywracać prawdziwego fetch w trakcie przebiegu.
export function restoreNetworkGuardForTest() {
  if (!installed) return;
  globalThis.fetch = realFetch;
  installed = false;
  calls = 0;
}

installNetworkGuard();
