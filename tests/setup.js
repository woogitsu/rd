// Globalna konfiguracja testów (#214), ładowana przez `node --import ./tests/setup.js`
// (patrz skrypt `test` w package.json) w KAŻDYM procesie testowym:
//   1. APP_ENV=test, jeśli nie ustawiono — testy nie zależą od środowiska dewelopera;
//   2. pułapka na sieć: globalThis.fetch rzuca wyjątek, o ile nie celuje w serwer na pętli zwrotnej
//      uruchomiony przez ten sam proces testowy (inne porty/hosty są blokowane)
//      (AGENTS.md: żaden test nie może wysłać wiadomości do prawdziwego rodzica);
//   3. licznik prób sieciowych sprawdzany przy wyjściu — test, który połknął wyjątek
//      pułapki (try/catch), i tak oblewa przebieg kodem 1.
import { networkGuardCalls } from './helpers/network-guard.js';

process.env.APP_ENV ||= 'test';

process.on('exit', (code) => {
  const attempts = networkGuardCalls();
  if (attempts > 0 && code === 0) {
    process.stderr.write(`tests/setup.js: test próbował użyć sieci ${attempts} raz(y) (network_forbidden_in_tests)\n`);
    process.exitCode = 1;
  }
});
