// #203: kolejka scrypt (`withSlot`, src/pg/password.js) była wcześniej
// nieograniczona i bez limitu czasu — kilkaset małych żądań logowania z
// jednego adresu blokowało logowanie całej szkoły na dziesiątki sekund.
// Testy używają atrapy zamiast prawdziwego scrypt (kosztowny, niedeterministyczny
// pod obciążeniem współdzielonej maszyny CI), zgodnie z propozycją z issue.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import {
  dummyHash, loginQueueMetrics, MAX_CONCURRENT, MAX_PER_CLIENT, MAX_WAITING, scryptQueueDepth, ScryptQueueBusyError, verifyPasswordOrDummy, WAIT_TIMEOUT_MS, withQueueClient, withSlot,
} from '../src/pg/password.js';

// Atrapa "scrypt": trzyma slot zajęty, dopóki test nie zwolni `release()`.
function heldSlot() {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const done = withSlot(() => held);
  return { done, release };
}

test('withSlot: przepełnienie kolejki daje ScryptQueueBusyError bez wykonania fn, kolejność FIFO, zwolnienie slotu po błędzie', async () => {
  assert.equal(MAX_CONCURRENT, 2, 'test zakłada bieżącą wartość — zmiana stałej wymaga przejrzenia testu');
  const holders = Array.from({ length: MAX_CONCURRENT }, heldSlot);
  assert.equal(scryptQueueDepth().running, MAX_CONCURRENT);

  // Do limitu MAX_WAITING kolejne wywołania czekają (nie odrzucamy przedwcześnie).
  const order = [];
  const waiters = Array.from({ length: MAX_WAITING }, (_, index) => withSlot(async () => { order.push(index); return index; }));
  assert.equal(scryptQueueDepth().waiting, MAX_WAITING);

  // MAX_WAITING+1-sze żądanie: kolejka pełna → 503 login_busy natychmiast, BEZ wykonania fn
  // (licznik nie rośnie, fn się nie odpala — sprawdzamy przez fn, które rzuca, gdyby się wykonało).
  await assert.rejects(
    withSlot(() => { throw new Error('fn nie powinno się wykonać przy pełnej kolejce'); }),
    (error) => error instanceof ScryptQueueBusyError && error.code === 'login_busy' && error.reason === 'queueFull',
  );

  // Zwolnienie jednego trwającego slotu wpuszcza pierwszego oczekującego (FIFO), nie ostatniego.
  holders[0].release();
  await waiters[0];
  assert.equal(order[0], 0, 'pierwsze zwolnione miejsce trafia do najdłużej czekającego (FIFO)');

  // Sprzątanie: reszta oczekujących kończy się po zwolnieniu drugiego trwającego slotu.
  holders[1].release();
  await Promise.all(waiters.slice(1));
  assert.equal(order.length, MAX_WAITING);
  await new Promise((resolve) => setTimeout(resolve, 0)); // pozwól running-- się zaktualizować
  assert.equal(scryptQueueDepth().running <= MAX_CONCURRENT, true);
});

test('withSlot: oczekiwanie dłuższe niż WAIT_TIMEOUT_MS kończy się ScryptQueueBusyError i zwalnia miejsce w kolejce', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const holders = Array.from({ length: MAX_CONCURRENT }, heldSlot);
    const waiterPromise = withSlot(async () => 'nie powinno się wykonać po timeout');
    const rejected = assert.rejects(
      waiterPromise,
      (error) => error instanceof ScryptQueueBusyError && error.code === 'login_busy' && error.reason === 'waitTimeout',
    );
    assert.equal(scryptQueueDepth().waiting, 1);
    mock.timers.tick(WAIT_TIMEOUT_MS);
    await rejected;
    // Miejsce w kolejce jest zwolnione natychmiast po timeout, niezależnie od trwających slotów.
    assert.equal(scryptQueueDepth().waiting, 0);
    for (const holder of holders) holder.release();
  } finally {
    mock.timers.reset();
  }
});

test('withSlot: błąd fn (np. złe hasło) zwalnia slot tak samo jak sukces — kolejka nie zostaje "zatkana"', async () => {
  const before = scryptQueueDepth();
  await assert.rejects(withSlot(() => Promise.reject(new Error('błąd hasła, nie kolejki'))), /błąd hasła/);
  assert.deepEqual(scryptQueueDepth(), before, 'slot wraca do puli natychmiast po odrzuceniu fn');
  assert.equal(await withSlot(async () => 42), 42);
  assert.deepEqual(scryptQueueDepth(), before);
});

test('withSlot: limit per klient odrzuca nadmiar jednego klienta, inny klient dostaje miejsce, miejsca wracają po zwolnieniu', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let ran = 0;
  const flood = Array.from({ length: MAX_PER_CLIENT }, () => withQueueClient('klient-a', () => withSlot(async () => { ran += 1; await held; })));
  const overflow = await Promise.allSettled(Array.from({ length: 10 }, () => withQueueClient('klient-a', () => withSlot(async () => { ran += 100; }))));
  for (const result of overflow) {
    assert.equal(result.status, 'rejected');
    assert.ok(result.reason instanceof ScryptQueueBusyError);
    assert.equal(result.reason.reason, 'clientQueueFull');
  }
  assert.equal(ran, MAX_CONCURRENT, 'nadmiar nie uruchomił fn');
  assert.equal(scryptQueueDepth().waiting, MAX_PER_CLIENT - MAX_CONCURRENT);
  // Inny klient nie jest odrzucony — czeka w kolejce globalnej (MAX_WAITING nie wyczerpane).
  const other = withQueueClient('klient-b', () => withSlot(async () => 'b'));
  assert.equal(scryptQueueDepth().waiting, MAX_PER_CLIENT - MAX_CONCURRENT + 1);
  // Bez klienta (spoza HTTP) obowiązuje tylko limit globalny.
  const anonymous = withSlot(async () => 'anon');
  const before = loginQueueMetrics();
  assert.equal(before.login_queue_depth, MAX_PER_CLIENT - MAX_CONCURRENT + 2);
  release();
  await Promise.all(flood);
  assert.equal(await other, 'b');
  assert.equal(await anonymous, 'anon');
  assert.equal(loginQueueMetrics().login_queue_depth, 0);
  // Miejsca klienta wróciły: kolejne wywołanie przechodzi.
  assert.equal(await withQueueClient('klient-a', () => withSlot(async () => 'znowu')), 'znowu');
});

test('withSlot: miejsce klienta wraca po błędzie fn i po przekroczeniu czasu oczekiwania; login_busy_total rośnie tylko przy odrzuceniu', async () => {
  const start = loginQueueMetrics().login_busy_total;
  await assert.rejects(withQueueClient('klient-c', () => withSlot(async () => { throw new Error('x'); })), /x/);
  assert.equal(loginQueueMetrics().login_busy_total, start);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const running = Array.from({ length: MAX_CONCURRENT }, () => withSlot(() => held));
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const queued = withQueueClient('klient-c', () => withSlot(async () => 'nie'));
    const settled = assert.rejects(queued, (error) => error.reason === 'waitTimeout');
    mock.timers.tick(WAIT_TIMEOUT_MS + 1);
    await settled;
  } finally {
    mock.timers.reset();
  }
  assert.equal(loginQueueMetrics().login_busy_total, start + 1);
  release();
  await Promise.all(running);
  // Wszystkie MAX_PER_CLIENT miejsc klienta-c jest znowu wolnych.
  const again = await Promise.all(Array.from({ length: MAX_PER_CLIENT }, () => withQueueClient('klient-c', () => withSlot(async () => 1))));
  assert.equal(again.length, MAX_PER_CLIENT);
});

test('dummyHash: odrzucenie przez pełną kolejkę nie zostaje w cache (nie psuje kolejnych logowań nieznanym e-mailem)', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const occupied = Array.from({ length: MAX_CONCURRENT + MAX_WAITING }, () => withSlot(() => held).catch(() => {}));
  const env = { SCRYPT_COST_LOG2: '16' }; // osobny zestaw parametrów, więc pusty cache
  await assert.rejects(dummyHash(env), ScryptQueueBusyError);
  release();
  await Promise.all(occupied);
  assert.match(await dummyHash(env), /^scrypt\$65536\$8\$1\$/);
});

// #203 pkt 4/5 (kryterium akceptacji „pierwsze żądanie z nieznanym e-mailem po starcie: jedno
// obliczenie scrypt”): liczymy wywołania scrypt z node:crypto (atrapa deleguje do prawdziwej
// funkcji), zamiast mierzyć czas — wynik nie zależy od obciążenia maszyny.
test('verifyPasswordOrDummy: po rozgrzaniu dummyHash (jak przy starcie serwera) nieznany e-mail liczy dokładnie jedno scrypt; zimny cache dwa', async () => {
  const env = { SCRYPT_COST_LOG2: '15' }; // osobny zestaw parametrów, więc pusty cache
  const spy = mock.method(crypto, 'scrypt');
  syncBuiltinESMExports();
  try {
    // Zimny start: hash fikcyjny + weryfikacja = 2 obliczenia (dlatego src/server.js rozgrzewa cache).
    assert.equal(await verifyPasswordOrDummy('Syntetyczne haslo dlugie', '', env), false);
    assert.equal(spy.mock.callCount(), 2);

    // Rozgrzany cache: nieznany e-mail (brak hasha) i hash o niepoprawnych parametrach to po jednym scrypt.
    spy.mock.resetCalls();
    assert.equal(await verifyPasswordOrDummy('Syntetyczne haslo dlugie', null, env), false);
    assert.equal(spy.mock.callCount(), 1);
    spy.mock.resetCalls();
    assert.equal(await verifyPasswordOrDummy('Syntetyczne haslo dlugie', 'scrypt$1048576$16$1$AAAA$AAAA', env), false);
    assert.equal(spy.mock.callCount(), 1);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
});
