// #203: kolejka scrypt (`withSlot`, src/pg/password.js) była wcześniej
// nieograniczona i bez limitu czasu — kilkaset małych żądań logowania z
// jednego adresu blokowało logowanie całej szkoły na dziesiątki sekund.
// Testy używają atrapy zamiast prawdziwego scrypt (kosztowny, niedeterministyczny
// pod obciążeniem współdzielonej maszyny CI), zgodnie z propozycją z issue.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CONCURRENT, MAX_WAITING, scryptQueueDepth, ScryptQueueBusyError, WAIT_TIMEOUT_MS, withSlot,
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
