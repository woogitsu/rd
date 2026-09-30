// Wskazówka sesji dla ekranu /login/ (#99, przegląd demo 4): bez niej ekran nie woła
// GET /api/auth/state (401 w konsoli przy każdym logowaniu). Kontrakt API bez zmian.
import test from 'node:test';
import assert from 'node:assert/strict';

import { SESSION_HINT_KEY, forgetSession, mayHaveSession, rememberSession, sessionExpiryFrom } from '../shared/session-hint.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
  };
}

const NOW = Date.parse('2026-09-30T10:00:00Z');

test('bez wpisu: nie pytać o stan sesji; po zalogowaniu: pytać do czasu wygaśnięcia', () => {
  const storage = memoryStorage();
  assert.equal(mayHaveSession(storage, NOW), false);
  rememberSession('2026-10-01T10:00:00Z', storage);
  assert.equal(storage.getItem(SESSION_HINT_KEY), '2026-10-01T10:00:00.000Z');
  assert.equal(mayHaveSession(storage, NOW), true);
  assert.equal(mayHaveSession(storage, Date.parse('2026-10-01T10:00:00Z')), false, 'sesja wygasła');
  assert.equal(storage.getItem(SESSION_HINT_KEY), null, 'nieaktualny wpis jest usuwany');
});

test('wylogowanie usuwa wskazówkę; zapisany jest tylko czas wygaśnięcia', () => {
  const storage = memoryStorage();
  rememberSession('2026-09-30T20:00:00Z', storage);
  assert.deepEqual([...storage.data.keys()], [SESSION_HINT_KEY]);
  assert.match(storage.getItem(SESSION_HINT_KEY), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  forgetSession(storage);
  assert.equal(mayHaveSession(storage, NOW), false);
});

test('uszkodzony wpis albo data dalej niż doba: brak wskazówki', () => {
  for (const value of ['jutro', '', '2026-10-05T10:00:00Z']) {
    const storage = memoryStorage({ [SESSION_HINT_KEY]: value });
    assert.equal(mayHaveSession(storage, NOW), false, value);
  }
  const storage = memoryStorage();
  rememberSession('nie-data', storage);
  rememberSession(undefined, storage);
  assert.equal(storage.getItem(SESSION_HINT_KEY), null);
});

test('niedostępny localStorage: pytać zawsze (zachowanie sprzed zmiany), bez wyjątku', () => {
  assert.equal(mayHaveSession(null, NOW), true);
  const throwing = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceeded'); }, removeItem() { throw new Error('x'); } };
  assert.equal(mayHaveSession(throwing, NOW), true);
  assert.doesNotThrow(() => rememberSession('2026-10-01T10:00:00Z', throwing));
  assert.doesNotThrow(() => forgetSession(throwing));
});

test('czas wygaśnięcia brany tylko z tras sesji, nie z podglądu zaproszenia', () => {
  const expiresAt = '2026-10-01T10:00:00Z';
  for (const url of ['/api/login', '/api/auth/state', '/api/mfa/verify', '/api/mfa/recovery', '/api/mfa/confirm', '/api/invitations/accept', '/api/password/change']) {
    assert.equal(sessionExpiryFrom(url, { expiresAt }), expiresAt, url);
  }
  assert.equal(sessionExpiryFrom('/api/invitations/preview', { expiresAt }), null);
  assert.equal(sessionExpiryFrom('/api/auth/state', { authenticated: false, expiresAt }), null);
  assert.equal(sessionExpiryFrom('/api/login', {}), null);
  assert.equal(sessionExpiryFrom('/api/login', null), null);
});
