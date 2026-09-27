// Hasła (issue #3, D-10: wskazanie użytkownika 2026-09-27 — e-mail + hasło + TOTP;
// do formalnego potwierdzenia przez zarząd/IOD). Prototyp — nie jest wdrożony.
//
// Zasady:
// - scrypt z node:crypto, sól 16 bajtów na hasło, klucz 32 bajty; parametry są
//   zapisane w ciągu `scrypt$N$r$p$<sól>$<klucz>` (base64url), więc ich zmiana
//   nie unieważnia starych haseł — po udanym logowaniu hash jest przeliczany
//   z bieżącymi parametrami (needsRehash),
// - domyślnie N = 2^17, r = 8, p = 1 (OWASP Password Storage Cheat Sheet);
//   SCRYPT_COST_LOG2 (15–20) pozwala zmienić N bez zmiany kodu,
// - porównanie w czasie stałym (timingSafeEqual); nieznany e-mail jest
//   sprawdzany względem fikcyjnego hasha o tych samych parametrach,
// - najwyżej 2 obliczenia scrypt naraz (każde zajmuje ok. 128 MiB przy N = 2^17),
//   kolejne czekają — ochrona pamięci serwera przed zalewem prób logowania,
// - polityka NIST SP 800-63B: 12–128 znaków (po normalizacji NFKC), bez reguł
//   składu, odrzucenie haseł powszechnie używanych, powtórzeń i adresu e-mail,
// - hasło nigdy nie trafia do logów, audytu ani odpowiedzi.

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

export const PASSWORD_POLICY = Object.freeze({ minLength: 12, maxLength: 128 });
// Górny limit długości wejścia przy logowaniu (bajty UTF-8) — dłuższe nie są liczone.
export const MAX_PASSWORD_INPUT_BYTES = 1024;

const DEFAULT_COST_LOG2 = 17;
const MIN_COST_LOG2 = 15;
const MAX_COST_LOG2 = 20;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const HASH_PATTERN = /^scrypt\$(\d{4,8})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9_-]{22,64})\$([A-Za-z0-9_-]{43,128})$/;

export function currentParams(env) {
  const raw = env && Object.hasOwn(env, 'SCRYPT_COST_LOG2') ? env.SCRYPT_COST_LOG2 : process.env.SCRYPT_COST_LOG2;
  const log2 = raw === undefined || raw === null || raw === '' ? DEFAULT_COST_LOG2 : Number(raw);
  const safe = Number.isInteger(log2) && log2 >= MIN_COST_LOG2 && log2 <= MAX_COST_LOG2 ? log2 : DEFAULT_COST_LOG2;
  return { N: 2 ** safe, r: BLOCK_SIZE, p: PARALLELISM };
}

// --- Ograniczenie równoległości ---------------------------------------------

const MAX_CONCURRENT = 2;
let running = 0;
const waiting = [];

async function withSlot(fn) {
  if (running >= MAX_CONCURRENT) await new Promise((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await fn();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

function deriveKey(password, salt, { N, r, p }, length = KEY_BYTES) {
  return withSlot(() => new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 }, (error, key) => {
      if (error) reject(error); else resolve(key);
    });
  }));
}

// NFKC: ten sam znak wpisany na różnych klawiaturach daje ten sam hash (NIST 800-63B 5.1.1.2).
export function normalizePassword(password) {
  return String(password).normalize('NFKC');
}

export async function hashPassword(password, { env, params = currentParams(env) } = {}) {
  if (typeof password !== 'string') throw new TypeError('password_required');
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(normalizePassword(password), salt, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function parseHash(hash) {
  const match = HASH_PATTERN.exec(String(hash ?? ''));
  if (!match) return null;
  const [, N, r, p, salt, key] = match;
  const params = { N: Number(N), r: Number(r), p: Number(p) };
  // Tylko potęgi dwójki w dozwolonym zakresie — inaczej ktoś z zapisem do bazy mógłby wymusić ogromny koszt.
  const log2 = Math.log2(params.N);
  if (!Number.isInteger(log2) || log2 < MIN_COST_LOG2 || log2 > MAX_COST_LOG2 || params.r < 1 || params.r > 16 || params.p < 1 || params.p > 4) return null;
  return { params, salt: Buffer.from(salt, 'base64url'), key: Buffer.from(key, 'base64url') };
}

export async function verifyPassword(password, hash) {
  const parsed = parseHash(hash);
  if (!parsed || typeof password !== 'string') return false;
  const candidate = await deriveKey(normalizePassword(password), parsed.salt, parsed.params, parsed.key.length);
  return candidate.length === parsed.key.length && timingSafeEqual(candidate, parsed.key);
}

export function needsRehash(hash, env) {
  const parsed = parseHash(hash);
  if (!parsed) return true;
  const params = currentParams(env);
  return parsed.params.N !== params.N || parsed.params.r !== params.r || parsed.params.p !== params.p;
}

// Fikcyjny hash dla nieznanego adresu: ta sama ścieżka kodu i koszt co dla
// prawdziwego konta. Wyliczany raz na proces i zestaw parametrów.
const dummyHashes = new Map();
export async function dummyHash(env) {
  const params = currentParams(env);
  const cacheKey = `${params.N}:${params.r}:${params.p}`;
  if (!dummyHashes.has(cacheKey)) dummyHashes.set(cacheKey, hashPassword(randomBytes(24).toString('base64url'), { params }));
  return dummyHashes.get(cacheKey);
}

// Weryfikacja zawsze wykonuje jedno obliczenie scrypt, także gdy hash jest pusty.
export async function verifyPasswordOrDummy(password, hash, env) {
  if (hash && parseHash(hash)) return verifyPassword(password, hash);
  await verifyPassword(typeof password === 'string' ? password : '', await dummyHash(env));
  return false;
}

// --- Polityka ---------------------------------------------------------------

// Mała osadzona lista haseł powszechnie używanych (≥ 12 znaków, bo krótsze
// odrzuca już limit długości) oraz rdzeni, z których zbudowane są typowe
// hasła („haslo” + cyfry). Porównanie bez wielkości liter. To nie zastępuje
// listy z wycieków (np. Have I Been Pwned w trybie k-anonimowości) — do decyzji.
const COMMON_PASSWORDS = new Set([
  '123456789012', '1234567890123', '12345678901234', '123456789012345', '1234567890qwerty',
  '1q2w3e4r5t6y', '1q2w3e4r5t6y7u', '1qaz2wsx3edc', '1qaz2wsx3edc4rfv', 'zaq12wsxcde3', 'zaq1zaq1zaq1',
  'qwertyuiop12', 'qwertyuiop123', 'qwertyuiopasdf', 'qwerty123456', 'qwerty12345678', 'qwertyqwerty',
  'asdfghjkl123', 'asdfghjkl;\'', 'zxcvbnm12345', 'qazwsxedcrfv', 'password1234', 'password12345',
  'password123456', 'passwordpassword', 'password!123', 'p@ssw0rd1234', 'p@ssword1234', 'iloveyou1234',
  'administrator', 'administrator1', 'admin1234567', 'adminadmin123', 'welcome12345', 'welcome123456',
  'letmein12345', 'football1234', 'baseball1234', 'princess1234', 'sunshine1234', 'superman1234',
  'trustno1trustno1', 'abcdefghijkl', 'abcdefgh1234', 'abc123abc123', 'abcd12345678', '111111111111',
  '000000000000', '123123123123', '121212121212', '987654321098', '098765432109', 'aaaaaaaaaaaa',
  'haslo1234567', 'haslohaslo12', 'haslo12345678', 'haslohaslo123', 'mojehaslo123', 'tajnehaslo12',
  'zaq12wsxzaq1', 'polska123456', 'polska1234567', 'bruksela1234', 'bruxelles123', 'brussels1234',
  'radarodzicow', 'radarodzicow1', 'radarodzicow12', 'radarodzicow123', 'radarodzicow2026',
  'szkolapolska', 'szkolapolska1', 'szkolapolska123', 'kochamcie123', 'kochamcie1234',
]);
const COMMON_STEMS = ['password', 'passw0rd', 'haslo', 'qwerty', 'admin', 'welcome', 'letmein', 'zaq12wsx', 'radarodzicow', 'szkolapolska', 'polska', 'iloveyou'];

function isRepetitive(value) {
  // Jeden znak lub krótki wzorzec powtórzony (np. „abcabcabcabc”).
  for (let size = 1; size <= 4; size += 1) {
    const unit = value.slice(0, size);
    if (unit.repeat(Math.ceil(value.length / size)).slice(0, value.length) === value) return true;
  }
  return false;
}

function isSequential(value) {
  if (value.length < 8) return false;
  let ascending = true; let descending = true;
  for (let index = 1; index < value.length; index += 1) {
    const diff = value.charCodeAt(index) - value.charCodeAt(index - 1);
    if (diff !== 1) ascending = false;
    if (diff !== -1) descending = false;
  }
  return ascending || descending;
}

// Zwraca null albo kod błędu: password_too_short, password_too_long, password_common, password_contains_email.
export function checkPasswordPolicy(password, { email } = {}) {
  if (typeof password !== 'string') return 'password_required';
  const normalized = normalizePassword(password);
  const length = [...normalized].length;
  if (length < PASSWORD_POLICY.minLength) return 'password_too_short';
  if (length > PASSWORD_POLICY.maxLength) return 'password_too_long';
  const lower = normalized.toLowerCase();
  const compact = lower.replace(/[\s\-_.!@#$%^&*]+/g, '');
  if (COMMON_PASSWORDS.has(lower) || COMMON_PASSWORDS.has(compact)) return 'password_common';
  if (isRepetitive(lower) || isSequential(lower)) return 'password_common';
  // Rdzeń + same cyfry/znaki (np. „haslo12345678!”).
  const letters = compact.replace(/[^a-ząćęłńóśźż]/g, '');
  if (COMMON_STEMS.some((stem) => letters === stem.replace(/[^a-z]/g, '') || letters === stem.replace(/[^a-z]/g, '').repeat(2))) {
    return 'password_common';
  }
  if (email) {
    const address = String(email).trim().toLowerCase();
    const local = address.split('@')[0];
    if (lower === address || lower.includes(address) || (local.length >= 4 && compact.replace(/\d+$/, '') === local.replace(/[\s\-_.]+/g, ''))) {
      return 'password_contains_email';
    }
  }
  return null;
}
