// Strukturalne logi techniczne (JSON, jedna linia na zdarzenie) dla serwera Node/Railway.
//
//   import { log } from './log.js';
//   log.info('http_request', { method: 'GET', path: '/api/payments/:id', status: 200, duration_ms: 12 });
//   log.error('api_route_error', { module: 'payments', code: '23505' });
//
// Każda linia: { time, level, event, message, ...pola }. Railway odczytuje `level`
// i `message` z JSON-a (stdout: debug/info, stderr: warn/error).
//
// Warstwa redakcji (redactFields) działa na KAŻDYM wpisie, zanim trafi do wyjścia:
// - usuwa pola o nazwach wskazujących na dane osobowe lub sekrety (e-mail, imię,
//   nazwisko, telefon, adres, IBAN, cookie, token, hasło, sesja, treść, query…),
// - w wartościach tekstowych obcina query string i fragment URL oraz zastępuje
//   adresy e-mail, numery podobne do IBAN, nagłówki Bearer, JWT i długie
//   losowe ciągi (tokeny) znacznikami,
// - obiekt Error zamienia na { code, kind } bez message/detail (PostgreSQL
//   umieszcza w nich wartości kolumn).
// Logi nie mogą zawierać ciał żądań ani odpowiedzi — nie przekazywać ich tutaj.

export const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });

const EVENT_PATTERN = /^[a-z][a-z0-9_.]{0,63}$/;
const MAX_STRING = 200;
const MAX_DEPTH = 3;
const MAX_ARRAY = 20;

// Nazwy pól, których wartości nigdy nie trafiają do logu.
const SENSITIVE_KEY = /cookie|authori[sz]ation|token|secret|passw|pwd|session|csrf|api[_-]?key|e[-_]?mail|mail|iban|bic|account|konto|name|imie|imię|nazwisk|surname|first|last|phone|telefon|address|adres|pesel|body|payload|message|detail|content|query|search|params|header|ip$|^ip|user[_-]?agent|recipient|odbiorc/i;
// Wyjątki: techniczne pola o nazwach kolidujących z wzorcem.
const ALLOWED_KEYS = new Set(['event', 'level', 'time', 'duration_ms', 'status', 'method', 'path', 'module', 'code', 'kind', 'mode', 'count', 'missing_count']);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IBAN = /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]{4}){2,7}(?:[ -]?[A-Z0-9]{1,3})?(?![\p{L}\p{N}])/gu;
const BEARER = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const KEY_VALUE_SECRET = /\b(rd_session|session|token|secret|password|api[_-]?key)=[^\s;&,]+/gi;
const LONG_TOKEN = /\b[A-Za-z0-9_-]{24,}\b/g;
const URL_QUERY = /(\?|#)[^\s"']*/g;

function looksRandom(value) {
  return /\d/.test(value) && /[A-Za-z]/.test(value);
}

export function redactString(input) {
  let value = String(input);
  value = value.replace(URL_QUERY, '');
  value = value.replace(KEY_VALUE_SECRET, '$1=[redacted]');
  value = value.replace(BEARER, '[token]');
  value = value.replace(JWT, '[token]');
  value = value.replace(EMAIL, '[email]');
  value = value.replace(IBAN, (match) => (/\d{6,}/.test(match.replace(/[ -]/g, '')) ? '[iban]' : match));
  value = value.replace(LONG_TOKEN, (match) => (looksRandom(match) ? '[token]' : match));
  if (value.length > MAX_STRING) value = `${value.slice(0, MAX_STRING)}…`;
  return value;
}

function safeCode(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(value) ? value : null;
}

export function describeError(error) {
  const code = safeCode(error?.code);
  const kind = typeof error?.name === 'string' && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'Error';
  return code ? { code, kind } : { kind };
}

function redactValue(value, depth) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return redactString(value);
  if (value instanceof Error) return describeError(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((item) => redactValue(item, depth + 1));
  if (typeof value === 'object') return redactObject(value, depth + 1).fields;
  return undefined;
}

function redactObject(input, depth) {
  const fields = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!ALLOWED_KEYS.has(key) && SENSITIVE_KEY.test(key)) { dropped += 1; continue; }
    const safe = redactValue(value, depth);
    if (safe !== undefined) fields[key] = safe;
  }
  return { fields, dropped };
}

// Zwraca kopię pól po redakcji; `redacted` = liczba usuniętych pól (bez ich nazw).
export function redactFields(input = {}) {
  const { fields, dropped } = redactObject(input, 0);
  if (dropped) fields.redacted = dropped;
  return fields;
}

// Ścieżka do logu: bez query stringu i fragmentu, segmenty wyglądające na
// identyfikatory (liczby, UUID, długie ciągi z cyframi, e-maile) → `:id`.
export function sanitizePath(input) {
  let path = String(input ?? '');
  const cut = path.search(/[?#]/);
  if (cut >= 0) path = path.slice(0, cut);
  if (!path.startsWith('/')) path = `/${path}`;
  const segments = path.split('/').map((segment) => {
    if (!segment) return segment;
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch { return ':id'; }
    if (/^\d+$/.test(decoded)) return ':id';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded)) return ':id';
    if (decoded.includes('@')) return ':id';
    if (decoded.length > 40) return ':id';
    if (decoded.length >= 8 && /\d/.test(decoded) && !/\.[a-z0-9]{1,5}$/i.test(decoded)) return ':id';
    if (!/^[A-Za-z0-9._~-]+$/.test(decoded)) return ':id';
    return decoded;
  });
  return segments.slice(0, 12).join('/') || '/';
}

// Przez console (stdout dla debug/info, stderr dla warn/error), aby istniejące
// testy przechwytujące console widziały również wpisy strukturalne.
function defaultSink(line, level) {
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

function levelFrom(value, fallback = 'info') {
  return Object.hasOwn(LEVELS, value) ? value : fallback;
}

export function createLogger({ level = globalThis.process?.env?.LOG_LEVEL, sink = defaultSink, now = () => new Date() } = {}) {
  const threshold = LEVELS[levelFrom(level)];
  function write(entryLevel, event, fields) {
    if (LEVELS[entryLevel] < threshold) return;
    const safeEvent = EVENT_PATTERN.test(event) ? event : 'invalid_event';
    const entry = { ...redactFields(fields), time: now().toISOString(), level: entryLevel, event: safeEvent, message: safeEvent };
    try { sink(JSON.stringify(entry), entryLevel); } catch { /* log nie może przerwać obsługi żądania */ }
  }
  return {
    level: levelFrom(level),
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}

export const log = createLogger();

// Liczniki w procesie (bez etykiet z danymi): liczba żądań wg klasy statusu
// i suma czasu. Nie są wystawiane przez HTTP — raportowane okresowo do logu.
export function createRequestMetrics() {
  let counters = empty();
  function empty() {
    return { requests: 0, status_2xx: 0, status_3xx: 0, status_4xx: 0, status_5xx: 0, duration_ms_total: 0, duration_ms_max: 0 };
  }
  return {
    record(status, durationMs) {
      counters.requests += 1;
      const bucket = `status_${Math.floor(Number(status) / 100)}xx`;
      if (Object.hasOwn(counters, bucket)) counters[bucket] += 1;
      const duration = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
      counters.duration_ms_total += duration;
      counters.duration_ms_max = Math.max(counters.duration_ms_max, duration);
    },
    snapshot() { return { ...counters }; },
    reset() { const previous = counters; counters = empty(); return previous; },
  };
}

// Co intervalMs zapisuje zdarzenie `http_metrics` i zeruje liczniki; pomija
// okresy bez ruchu. Timer nie blokuje zamknięcia procesu (unref).
export function startMetricsReporter({ metrics, logger = log, intervalMs = 5 * 60 * 1000 } = {}) {
  const timer = setInterval(() => {
    const counters = metrics.reset();
    if (!counters.requests) return;
    const { duration_ms_total: total, ...rest } = counters;
    logger.info('http_metrics', { ...rest, duration_ms_avg: Math.round(total / counters.requests), interval_s: Math.round(intervalMs / 1000) });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
