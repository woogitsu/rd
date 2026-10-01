import net from 'node:net';

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
  trackListeningServers();
  realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    // Testy serwera HTTP łączą się z serwerem uruchomionym przez ten sam proces
    // testowy (listen na pętli zwrotnej) — to nie jest ruch do świata zewnętrznego.
    // Pętla zwrotna na porcie, którego nie otworzył żaden test (np. lokalna usługa
    // dewelopera), jest blokowana i liczona jak każda inna próba sieciowa.
    if (isOwnLoopbackServer(input)) return realFetch(input, init);
    calls += 1;
    throw new Error('network_forbidden_in_tests');
  };
}

// Porty serwerów wystartowanych w tym procesie (net.Server#listen, w tym http).
const ownPorts = new Set();
let originalListen;
function trackListeningServers() {
  originalListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function listenTracked(...args) {
    this.once('listening', () => {
      const address = this.address();
      if (address && typeof address === 'object') ownPorts.add(address.port);
    });
    return originalListen.apply(this, args);
  };
}

export function isOwnLoopbackServer(input) {
  if (!isLoopback(input)) return false;
  try {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    const url = new URL(raw);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return ownPorts.has(port);
  } catch {
    return false;
  }
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
  net.Server.prototype.listen = originalListen;
  installed = false;
  calls = 0;
}

installNetworkGuard();
