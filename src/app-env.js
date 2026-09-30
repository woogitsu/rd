// #166: jedna wspólna normalizacja APP_ENV dla serwera i skryptów operatorskich.
//
// Wcześniej każde miejsce porównywało APP_ENV po swojemu (dosłowne
// 'production', 'production'|'prod', brak porównania), więc 'prod', 'Production'
// albo brak zmiennej omijały blokady (`--allow-production`, IMPORT_ENABLED).
//
// Zasady:
// - wielkość liter i otaczające spacje są ignorowane; 'prod' = 'production';
// - znane środowiska: development, test, staging, production;
// - brak zmiennej i wartość nieznana (literówka) NIE są środowiskiem
//   nieszkodliwym: dla blokad niebezpiecznych operacji (import danych rodzin,
//   migracja/odtworzenie/kopia, bootstrap administratora) traktujemy je
//   zachowawczo jak produkcję (`isProductionLikeEnv`) i wypisujemy ostrzeżenie
//   (`appEnvWarning`). Ustawienie APP_ENV=development|test|staging odblokowuje
//   lokalną pracę bez `--allow-production`.
//
// - lokalne (dev na http://localhost) są wyłącznie: brak zmiennej, development,
//   test (`isLocalAppEnv`) — tylko tam cookie sesji bez prefiksu `__Host-`
//   i serwer bez obowiązkowej konfiguracji (#114);
// - serwer HTTP nie startuje z nieznaną wartością ani bez APP_ENV na Railway
//   (`appEnvStartupProblem`, wywoływane przez src/config.js).
//
// To JEDYNE miejsce, które porównuje wartość APP_ENV. Pozostały kod woła
// funkcje z tego modułu; tests/app-env-single-source.test.js odrzuca bezpośrednie
// porównania `APP_ENV === …`, `.toLowerCase()` na APP_ENV itp. poza tym plikiem.
//
// Funkcje nie czytają process.env — wywołujący przekazuje wartość.

export const KNOWN_APP_ENVS = Object.freeze(['development', 'test', 'staging', 'production']);
const ALIASES = Object.freeze({ prod: 'production' });

// -> { name, raw, known, unset, production }
//   name: znormalizowana nazwa ('' gdy brak; dla nieznanej — wartość małymi literami)
export function resolveAppEnv(value) {
  const raw = value == null ? '' : String(value);
  const lowered = raw.trim().toLowerCase();
  const name = ALIASES[lowered] ?? lowered;
  const unset = name === '';
  const known = KNOWN_APP_ENVS.includes(name);
  return { name, raw, known, unset, production: name === 'production' };
}

// Tylko jawna produkcja ('production'/'prod', dowolna wielkość liter).
export function isProductionEnv(value) {
  return resolveAppEnv(value).production;
}

// Produkcja albo brak/nieznana wartość — do blokad niebezpiecznych operacji.
export function isProductionLikeEnv(value) {
  const env = resolveAppEnv(value);
  return env.production || !env.known;
}

// Środowisko lokalne: brak APP_ENV, development albo test. Każda inna wartość
// (staging, production, prod, literówka) jest traktowana zachowawczo jak
// środowisko wystawione do sieci.
export function isLocalAppEnv(value) {
  const env = resolveAppEnv(value);
  return env.unset || env.name === 'development' || env.name === 'test';
}

// Jawne APP_ENV=test (dowolna wielkość liter). Atrapa transportu e-mail.
export function isTestEnv(value) {
  return resolveAppEnv(value).name === 'test';
}

// Etykieta do logów i rejestrów (np. backup_runs.environment): znana nazwa
// albo 'unknown' — nigdy surowa wartość zmiennej (literówka, długi tekst).
export function appEnvLabel(value) {
  const env = resolveAppEnv(value);
  return env.known ? env.name : 'unknown';
}

// Zmienne, które Railway ustawia sam w każdej usłudze. Ich obecność przy braku
// APP_ENV oznacza zapomnianą zmienną w usłudze, a nie lokalny dev.
const RAILWAY_MARKERS = Object.freeze(['RAILWAY_ENVIRONMENT_ID', 'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_ENVIRONMENT', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID']);

// Problem startowy serwera ({ variable: 'APP_ENV', reason }) albo null.
// Nieznana wartość zawsze; brak wartości tylko wtedy, gdy proces działa na
// Railway (lokalnie brak APP_ENV nadal oznacza development).
export function appEnvStartupProblem(processEnv = {}) {
  const env = resolveAppEnv(processEnv.APP_ENV);
  if (env.known) return null;
  if (!env.unset) return { variable: 'APP_ENV', reason: `nieznana wartość; dozwolone: ${KNOWN_APP_ENVS.join(', ')}` };
  if (RAILWAY_MARKERS.some((name) => String(processEnv[name] ?? '').trim() !== '')) {
    return { variable: 'APP_ENV', reason: 'wymagane w usłudze Railway (staging albo production)' };
  }
  return null;
}

// Ostrzeżenie (tekst bez wartości sekretów) dla brakującego/nieznanego APP_ENV; null gdy znane.
export function appEnvWarning(value) {
  const env = resolveAppEnv(value);
  if (env.known) return null;
  const shown = env.unset ? 'brak (APP_ENV nie jest ustawione)' : `nieznana wartość "${env.raw.trim().slice(0, 40)}"`;
  return `APP_ENV: ${shown}. Dozwolone: ${KNOWN_APP_ENVS.join(', ')}. `
    + 'Niebezpieczne operacje są traktowane jak w produkcji (wymagają --allow-production / IMPORT_ENABLED=true).';
}

// Wspólny strażnik skryptów: zwraca { refused, warning }. `refused` gdy
// środowisko produkcyjne lub nierozpoznane, a brak jawnej zgody.
export function guardDangerousOperation(value, { allowProduction = false } = {}) {
  return {
    refused: isProductionLikeEnv(value) && allowProduction !== true,
    warning: appEnvWarning(value),
  };
}
