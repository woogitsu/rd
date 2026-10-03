// #166 (kryterium 3), #191: tożsamość bazy docelowej w skryptach operatora.
//
// `--allow-production` czyta APP_ENV z powłoki operatora, a nie ze środowiska
// bazy: z DATABASE_URL produkcji skopiowanym do komendy z `APP_ENV=staging`
// strażnik przepuszcza zapis. Dlatego każdy skrypt, który ZAPISUJE do bazy
// (migracje, odtworzenie z migawki D1 i z paczki eksportu, próba odtworzenia,
// pierwszy administrator, rotacja klucza MFA), wymaga jawnego
// `--expect-database=<nazwa bazy>` i porównuje ją dwa razy, zanim cokolwiek
// zapisze:
//   1. z nazwą bazy w adresie (`requireExpectedDatabase`, bez łączenia się),
//   2. z `current_database()` po nawiązaniu połączenia
//      (`assertConnectedDatabase`; adres może prowadzić przez proxy).
// Nazwa bazy nie jest sekretem; komunikaty zawierają obie nazwy, nigdy adresu
// ani hasła.
//
// Ograniczenie (opisane w docs/RAILWAY_OPERATIONS.md): to ochrona przed
// pomyłką adresu, nie znacznik środowiska. Gdy staging i produkcja mają tę samą
// nazwę bazy (domyślna baza Railway to `railway` w obu), flaga ich nie odróżnia.
// Znacznik środowiska zapisany w samej bazie wymaga migracji i decyzji D-20.
//
// Moduł nie czyta process.env ani nie łączy się z bazą sam; wywołujący
// przekazuje adres, argumenty i klienta.

export const EXPECT_DATABASE_FLAG = '--expect-database';

export class DatabaseIdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DatabaseIdentityError';
    this.code = code;
  }
}

// Nazwy baz PostgreSQL mogą być dowolne, ale operatorom wystarczą bezpieczne
// znaki; wszystko inne to najpewniej literówka albo wklejony adres.
const DATABASE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.$-]{0,62}$/;

// Nazwa bazy z adresu postgres://…/<nazwa>?…; null, gdy adres jest niepoprawny
// albo nie zawiera nazwy.
export function databaseNameFromUrl(url) {
  try {
    const name = decodeURIComponent(new URL(String(url)).pathname.replace(/^\//, ''));
    return name === '' ? null : name;
  } catch {
    return null;
  }
}

// Wartość `--expect-database=<nazwa>` z listy argumentów albo undefined.
// Podanie flagi dwa razy, bez wartości albo z niepoprawną nazwą to błąd
// (nigdy cicha zmiana znaczenia).
export function parseExpectDatabase(args) {
  const matches = args.filter((arg) => arg === EXPECT_DATABASE_FLAG || arg.startsWith(`${EXPECT_DATABASE_FLAG}=`));
  if (matches.length === 0) return undefined;
  if (matches.length > 1) throw new DatabaseIdentityError('expect_database_duplicate', `Specify only one ${EXPECT_DATABASE_FLAG} option`);
  const value = matches[0].startsWith(`${EXPECT_DATABASE_FLAG}=`) ? matches[0].slice(EXPECT_DATABASE_FLAG.length + 1) : '';
  if (!DATABASE_NAME.test(value)) {
    throw new DatabaseIdentityError('expect_database_invalid', `${EXPECT_DATABASE_FLAG}=<database name> needs a plain database name (letters, digits, _ . $ -)`);
  }
  return value;
}

// Wymaga flagi i porównuje ją z nazwą bazy w adresie. Zwraca oczekiwaną nazwę.
// Wywoływać PRZED połączeniem: błąd oznacza „nic nie zapisano, nie łączono się”.
// `url: undefined` (połączenie wstrzyknięte, np. w testach) pomija tylko
// porównanie z adresem; nazwę z `current_database()` i tak sprawdza
// `assertConnectedDatabase`. Pusty adres to błąd, nie pominięcie.
export function requireExpectedDatabase({ url, args, label = 'target database' }) {
  const expected = parseExpectDatabase(args);
  if (expected === undefined) {
    throw new DatabaseIdentityError('expect_database_required', `${EXPECT_DATABASE_FLAG}=<database name> is required: the name of the ${label} from its URL. Nothing was changed.`);
  }
  if (url === undefined) return expected;
  const actual = databaseNameFromUrl(url);
  if (actual === null) {
    throw new DatabaseIdentityError('database_url_without_name', `The ${label} URL has no database name, so ${EXPECT_DATABASE_FLAG} cannot be verified. Nothing was changed.`);
  }
  if (actual !== expected) {
    throw new DatabaseIdentityError('database_identity_mismatch', `The ${label} URL points to database "${actual}", not "${expected}" (${EXPECT_DATABASE_FLAG}). Nothing was changed.`);
  }
  return expected;
}

// Porównanie z `current_database()` na połączeniu, którego skrypt użyje do zapisu.
// `executor` to cokolwiek z `query(sql)` zwracającym `{ rows }` (pg.Client, PGlite, createPgDatabase).
export async function assertConnectedDatabase(executor, expected) {
  const { rows } = await executor.query('SELECT current_database() AS name');
  const actual = rows?.[0]?.name;
  if (actual !== expected) {
    throw new DatabaseIdentityError('database_identity_mismatch', `Connected to database "${actual}", not "${expected}" (${EXPECT_DATABASE_FLAG}). Nothing was changed.`);
  }
}
