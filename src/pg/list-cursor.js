// Wspólny kontrakt list z kursorem keyset (issue #159). Dotyczy tras, które
// wcześniej obcinały wynik po cichu (LIMIT bez sygnału) lub używały OFFSET.
//
// Odpowiedź listy: dotychczasowe pola + `nextCursor` (string|null) + `truncated`
// (true, gdy są dalsze wiersze) + `limit`. Kursor jest nieprzezroczysty, związany
// z filtrem, który go wydał (inny filtr → 400 invalid_cursor).
//
// Kolejność wszystkich list: (znacznik czasu DESC, id ASC) albo (klucz ASC, id ASC).
// Znacznik czasu w kursorze ma mikrosekundy (tekst z bazy) — obcięcie do
// milisekund w JS zgubiłoby lub powtórzyło wiersze o zbliżonym czasie.

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const MAX_CURSOR_LENGTH = 1024;
const MAX_KEY_LENGTH = 512;

/** Wyrażenie SQL: znacznik czasu jako tekst ISO z mikrosekundami (do kursora). */
export function cursorTimestampSql(column) {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/**
 * Parsuje `limit`. Brak parametru → `defaultLimit`; zła wartość → fail('invalid_limit').
 * @param {string|null} raw
 * @param {{ defaultLimit: number, maxLimit: number }} options
 * @param {(code: string) => never} fail
 */
export function parseListLimit(raw, { defaultLimit, maxLimit }, fail) {
  if (raw === null || raw === undefined || raw === '') return defaultLimit;
  if (!/^\d{1,6}$/.test(raw)) fail('invalid_limit');
  const limit = Number(raw);
  if (limit < 1 || limit > maxLimit) fail('invalid_limit');
  return limit;
}

/**
 * @param {{ kind: 'timestamp'|'text', key: string, id: string }} position
 * @param {string} scope opis filtra (dowolny tekst deterministyczny)
 */
export function encodeListCursor(position, scope) {
  return Buffer.from(JSON.stringify([position.key, position.id, scope]), 'utf8').toString('base64url');
}

/**
 * @param {string|null|undefined} raw
 * @param {{ kind: 'timestamp'|'text', scope: string }} expected
 * @param {(code: string) => never} fail
 * @returns {{ key: string, id: string }|null}
 */
export function decodeListCursor(raw, { kind, scope }, fail) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) fail('invalid_cursor');
  let payload;
  try {
    payload = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    fail('invalid_cursor');
  }
  if (!Array.isArray(payload) || payload.length !== 3) fail('invalid_cursor');
  const [key, id, cursorScope] = payload;
  if (typeof key !== 'string' || typeof id !== 'string' || cursorScope !== scope
    || key.length > MAX_KEY_LENGTH || id.length < 1 || id.length > MAX_KEY_LENGTH
    || (kind === 'timestamp' && !TIMESTAMP_PATTERN.test(key))) {
    fail('invalid_cursor');
  }
  return { key, id };
}

/**
 * Warunek „po kursorze” dla kolejności (ts DESC, id ASC).
 * Dopisuje parametry do `values` i zwraca fragment SQL.
 */
export function afterTimestampDescSql(tsColumn, idColumn, cursor, values) {
  values.push(cursor.key, cursor.id);
  const ts = `$${values.length - 1}::timestamptz`;
  const id = `$${values.length}`;
  return `(${tsColumn} < ${ts} OR (${tsColumn} = ${ts} AND ${idColumn} > ${id}))`;
}

/**
 * Warunek „po kursorze” dla kolejności rosnącej po krotce kolumn (klucz…, id):
 * `(k1, k2, id) > ($1, $2, $3)`. `casts` (np. '::date') dopisuje rzutowanie parametru.
 * @param {string[]} columns wyrażenia SQL w kolejności ORDER BY
 * @param {string[]} parts wartości z kursora, w tej samej kolejności
 * @param {string[]} values tablica parametrów zapytania (jest dopisywana)
 * @param {string[]} [casts]
 */
export function afterTupleAscSql(columns, parts, values, casts = []) {
  const placeholders = parts.map((part, index) => {
    values.push(part);
    return `$${values.length}${casts[index] ?? ''}`;
  });
  return `(${columns.join(', ')}) > (${placeholders.join(', ')})`;
}

/**
 * Z `limit + 1` pobranych wierszy robi stronę i kursor następnej strony.
 * @param {object[]} rows wiersze z zapytania z `LIMIT limit + 1`
 * @param {number} limit
 * @param {(row: object) => { key: string, id: string }} positionOf
 * @param {string} scope
 */
export function pageOf(rows, limit, positionOf, scope) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? encodeListCursor(positionOf(items[items.length - 1]), scope) : null;
  return { items, nextCursor, truncated: hasMore, limit };
}
