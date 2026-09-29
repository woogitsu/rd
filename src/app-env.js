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
// Funkcje nie czytają process.env — wywołujący przekazuje wartość.
// Walidacja startowa serwera (#114) może użyć `resolveAppEnv` / `appEnvWarning`.

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
