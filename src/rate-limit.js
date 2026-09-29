// Ogólny limiter żądań serwera Node (#126, SR-13). W PAMIĘCI PROCESU: nie działa
// między replikami (przy więcej niż jednej replice potrzebny licznik w PostgreSQL)
// i zeruje się po restarcie. Uzupełnia — nie zastępuje — limity prób w bazie
// (`login_rate_limits`, `mfa_rate_limits`) i limit /api/email/preferences.
//
// Klasy (każda ma osobny próg na minutę, okno stałe 60 s):
// - webhook: /api/email/webhooks/* — klucz: adres klienta,
// - public: /api/public/*, /api/meetings/public-minutes i wszystkie żądania /api/*
//   bez ciasteczka sesji — klucz: adres klienta,
// - session: pozostałe /api/* z ciasteczkiem sesji (`__Host-rd_session` poza
//   środowiskiem lokalnym albo `rd_session`, wartość w formacie tokenu) — klucz:
//   skrót ciasteczka (wyższy próg). Ciasteczko nie jest sprawdzane w bazie, więc
//   dodatkowo WSZYSTKIE żądania klasy session z jednego adresu liczą się do
//   wspólnego progu adresu (sessionAddressPerWindow) — rotacja podrobionych
//   ciasteczek nie daje nieograniczonej liczby świeżych liczników (przegląd 29.09).
// Trasy bez sesji (logowanie, zaproszenia, reset hasła, publiczne) są zawsze klasy
// public po adresie, niezależnie od wysłanego ciasteczka.
// Kosztowne trasy (eksport roczny i lista klasy, podgląd importu, raporty) mają
// dodatkowo limit RÓWNOCZESNYCH żądań na sesję (bez sesji — na adres).
//
// Klucze to SHA-256 (adres/ciasteczko z dziedziną) skrócone do 32 znaków; adres,
// e-mail i ciasteczko nie są przechowywane ani logowane. Liczba kluczy jest
// ograniczona (MAX_KEYS), a przy przepełnieniu najstarsze są usuwane.
//
// Konfiguracja (zmienne środowiskowe, wartości całkowite ≥ 1; `0` w progu = klasa
// bez limitu; RATE_LIMIT_DISABLED=1 wyłącza całość). Progi domyślne są zachowawcze
// (wysokie) — do potwierdzenia po pomiarze ruchu na stagingu; szkoła za jednym NAT-em
// dzieli próg klasy public.
import { createHash } from 'node:crypto';

export const RATE_LIMIT_DEFAULTS = Object.freeze({
  windowMs: 60_000,
  webhookPerWindow: 600,
  publicPerWindow: 300,
  sessionPerWindow: 1200,
  // Suma żądań zalogowanych z jednego adresu (np. NAT szkoły): kilka pełnych sesji.
  sessionAddressPerWindow: 3000,
  heavyConcurrency: 2,
});
const MAX_KEYS = 20_000;
// Obie nazwy ciasteczka sesji (src/auth.js, #114): `__Host-` ma pierwszeństwo.
const SESSION_COOKIE_NAMES = ['__Host-rd_session', 'rd_session'];
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;
// Trasy obsługiwane bez sesji — ich limit zawsze liczy się po adresie klienta.
const UNAUTHENTICATED_PATHS = new Set([
  '/api/login', '/api/invitations/accept', '/api/invitations/preview', '/api/password/reset',
  '/api/meetings/public-minutes', '/api/meetings/public-notices',
]);

function sessionTokenFrom(cookieHeader) {
  const cookies = new Map();
  for (const part of String(cookieHeader ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (!cookies.has(name)) cookies.set(name, part.slice(index + 1).trim());
  }
  for (const name of SESSION_COOKIE_NAMES) {
    const value = cookies.get(name);
    if (value && SESSION_TOKEN.test(value)) return value;
  }
  return null;
}
const HEAVY_PREFIXES = ['/api/exports', '/api/import/', '/api/reports/'];

function intFrom(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

export function rateLimitConfig(env = {}) {
  const disabled = env.RATE_LIMIT_DISABLED === '1' || env.RATE_LIMIT_DISABLED === 'true';
  return {
    disabled,
    windowMs: RATE_LIMIT_DEFAULTS.windowMs,
    webhookPerWindow: intFrom(env.RATE_LIMIT_WEBHOOK_PER_MIN, RATE_LIMIT_DEFAULTS.webhookPerWindow),
    publicPerWindow: intFrom(env.RATE_LIMIT_PUBLIC_PER_MIN, RATE_LIMIT_DEFAULTS.publicPerWindow),
    sessionPerWindow: intFrom(env.RATE_LIMIT_SESSION_PER_MIN, RATE_LIMIT_DEFAULTS.sessionPerWindow),
    sessionAddressPerWindow: intFrom(env.RATE_LIMIT_SESSION_ADDRESS_PER_MIN, RATE_LIMIT_DEFAULTS.sessionAddressPerWindow),
    heavyConcurrency: intFrom(env.RATE_LIMIT_HEAVY_CONCURRENCY, RATE_LIMIT_DEFAULTS.heavyConcurrency),
  };
}

export function classifyRequest(pathname, cookieHeader) {
  if (!pathname.startsWith('/api/')) return null;
  if (pathname.startsWith('/api/email/webhooks/')) return { cls: 'webhook', session: null };
  if (pathname.startsWith('/api/public/') || UNAUTHENTICATED_PATHS.has(pathname)) return { cls: 'public', session: null };
  const token = sessionTokenFrom(cookieHeader);
  if (!token) return { cls: 'public', session: null };
  return { cls: 'session', session: token };
}

export const isHeavyPath = (pathname) => HEAVY_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));

const keyOf = (scope, value) => createHash('sha256').update(`rd-rate:${scope}:${value}`).digest('hex').slice(0, 32);

export function createRateLimiter({ env = {}, now = () => Date.now() } = {}) {
  const config = rateLimitConfig(env);
  const windows = new Map();
  const inFlight = new Map();

  function touch(map, key, value) {
    map.delete(key);
    map.set(key, value);
    if (map.size > MAX_KEYS) {
      const stamp = now();
      for (const [oldKey, entry] of map) {
        if (entry.resetAt !== undefined && entry.resetAt <= stamp) map.delete(oldKey);
      }
      while (map.size > MAX_KEYS) map.delete(map.keys().next().value);
    }
  }

  // Zwraca { ok: true, release } albo { ok: false, retryAfter }.
  function acquire({ pathname, cookieHeader, address }) {
    if (config.disabled) return { ok: true, release() {} };
    const klass = classifyRequest(pathname, cookieHeader);
    if (!klass) return { ok: true, release() {} };
    const limit = config[`${klass.cls}PerWindow`];
    const identity = klass.session ?? String(address ?? '');
    const stamp = now();
    if (limit > 0) {
      const key = keyOf(klass.cls, identity);
      let entry = windows.get(key);
      if (!entry || entry.resetAt <= stamp) entry = { count: 0, resetAt: stamp + config.windowMs };
      entry.count += 1;
      touch(windows, key, entry);
      if (entry.count > limit) return { ok: false, retryAfter: Math.max(1, Math.ceil((entry.resetAt - stamp) / 1000)) };
    }
    if (klass.cls === 'session' && config.sessionAddressPerWindow > 0) {
      const key = keyOf('session-address', String(address ?? ''));
      let entry = windows.get(key);
      if (!entry || entry.resetAt <= stamp) entry = { count: 0, resetAt: stamp + config.windowMs };
      entry.count += 1;
      touch(windows, key, entry);
      if (entry.count > config.sessionAddressPerWindow) {
        return { ok: false, retryAfter: Math.max(1, Math.ceil((entry.resetAt - stamp) / 1000)) };
      }
    }
    if (config.heavyConcurrency > 0 && isHeavyPath(pathname)) {
      const key = keyOf('heavy', identity);
      const current = inFlight.get(key) ?? { count: 0 };
      if (current.count >= config.heavyConcurrency) return { ok: false, retryAfter: 5 };
      current.count += 1;
      touch(inFlight, key, current);
      let released = false;
      return {
        ok: true,
        release() {
          if (released) return;
          released = true;
          const entry = inFlight.get(key);
          if (!entry) return;
          entry.count -= 1;
          if (entry.count <= 0) inFlight.delete(key);
        },
      };
    }
    return { ok: true, release() {} };
  }

  return { acquire, config, size: () => windows.size + inFlight.size };
}
