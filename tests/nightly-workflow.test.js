// #111, #101: nocny workflow (.github/workflows/nightly-pg-real.yml) nie może po cichu
// przestać sprawdzać tego, do czego służy. Test statyczny: czyta pliki, niczego nie uruchamia.
//  - powtórzenia (`--repeat=N --name=wzorzec plik`) wskazują istniejący plik i wzorzec, który
//    pasuje do dokładnie jednego tytułu testu (węższy wzorzec = 0 testów = cichy zielony przebieg);
//  - każdy plik z listy powtórzeń istnieje i czyta RD_TEST_PG_URL (inaczej bez bazy byłby pomijany);
//  - przebieg na roli `rd_app` ustawia RD_TEST_PG_APP_ROLE, używa `--all` i jest blokujący (bez continue-on-error);
//  - każdy job ma własny limit czasu i usługę postgres z przypiętym digestem (resztę pilnuje
//    tests/ci-supply-chain.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const workflow = read('.github/workflows/nightly-pg-real.yml');
const jobsSection = workflow.slice(workflow.indexOf('\njobs:\n'));
const jobs = new Map([...jobsSection.matchAll(/^ {2}([a-z][a-z-]*):\n([\s\S]*?)(?=^ {2}[a-z][a-z-]*:\n|(?![\s\S]))/gm)].map((m) => [m[1], m[2]]));

test('nocny workflow ma trzy joby: pełny zestaw, rola rd_app i powtórzenia współbieżności', () => {
  assert.deepEqual([...jobs.keys()].sort(), ['nightly-concurrency', 'nightly-pg-real', 'nightly-pg-real-app-role']);
  for (const [name, body] of jobs) {
    assert.match(body, /^ {4}timeout-minutes: \d+$/m, `${name}: limit czasu`);
    assert.match(body, /image: postgres@sha256:[0-9a-f]{64}/, `${name}: przypięty obraz postgres`);
  }
});

test('przebieg na roli rd_app: pełny zestaw (--all) z RD_TEST_PG_APP_ROLE=rd_app', () => {
  const body = jobs.get('nightly-pg-real-app-role');
  assert.match(body, /npm run test:pg-real -- --all/);
  assert.match(body, /RD_TEST_PG_APP_ROLE: rd_app/);
  // Zwykły przebieg pełnego zestawu nie dostaje roli aplikacji (to przebieg właściciela).
  assert.doesNotMatch(jobs.get('nightly-pg-real'), /RD_TEST_PG_APP_ROLE/);
  // #101: przebieg na rd_app jest blokujący — niezgodności są sklasyfikowane (docs/TESTING.md), więc
  // powrót do trybu diagnostycznego wymaga świadomej zmiany tego testu. Krok z `| tee` musi mieć
  // `shell: bash` (w Actions: `bash -eo pipefail`), inaczej kod wyjścia testów ginie w potoku.
  assert.doesNotMatch(body, /^\s*continue-on-error:/m);
  const step = /- name: Zestaw na roli rd_app\n([\s\S]*?)(?=\n {6}- |$)/.exec(body)?.[1] ?? '';
  assert.match(step, /npm run test:pg-real -- --all/);
  assert.match(step, /^ {8}shell: bash$/m, 'krok z `| tee` wymaga shell: bash (pipefail)');
});

test('powtórzenia współbieżności: pliki istnieją, czytają RD_TEST_PG_URL, a --name pasuje do dokładnie jednego testu', () => {
  const body = jobs.get('nightly-concurrency');
  const commands = [...body.matchAll(/npm run test:pg-real -- ([^\n]+(?:\n {10}[^\n]+)*)/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
  assert.ok(commands.length >= 2, 'oczekiwano co najmniej dwóch przebiegów z powtórzeniami');
  for (const command of commands) {
    assert.match(command, /--repeat=\d{2,}/, `${command}: liczba powtórzeń`);
    const files = command.split(' ').filter((token) => /^tests\/.+\.test\.js$/.test(token));
    assert.ok(files.length > 0, `${command}: brak plików testowych`);
    for (const file of files) {
      assert.ok(existsSync(new URL(file, root)), `${file}: brak pliku`);
      assert.match(read(file), /process\.env\.RD_TEST_PG_URL/, `${file}: bez RD_TEST_PG_URL byłby pomijany`);
    }
    const name = /--name='([^']+)'/.exec(command)?.[1];
    if (!name) continue;
    assert.equal(files.length, 1, `${command}: --name dotyczy jednego pliku`);
    const titles = read(files[0]).split('\n').filter((line) => /^test\(/.test(line) && new RegExp(name).test(line));
    assert.equal(titles.length, 1, `--name='${name}' musi pasować do dokładnie jednego testu w ${files[0]}: ${JSON.stringify(titles)}`);
  }
});

test('kontrola pozytywna: wzorzec bez dopasowania jest wykrywany jako zero testów', () => {
  const source = "test('a: zaproszenia', () => {});\ntest('b: inne', () => {});\n";
  const matching = (name) => source.split('\n').filter((line) => /^test\(/.test(line) && new RegExp(name).test(line));
  assert.equal(matching('zaproszenia').length, 1);
  assert.equal(matching('zaprosz[o]nia').length, 0);
});
