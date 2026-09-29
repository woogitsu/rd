// Logika czysta ekranu „Lista wyłączeń” (#94). Bez sieci i bez DOM:
// tests/email-suppressions-panel-core.test.js. Serwer (src/pg/routes/email.js)
// i tak egzekwuje każdą regułę — te funkcje tylko podpowiadają w interfejsie.

export const SUPPRESSION_REASON_LABELS = Object.freeze({
  hard_bounce: 'Odbicie wiadomości (adres nie istnieje lub jest nieaktywny)',
  invalid_email: 'Adres odrzucony jako niepoprawny',
  blocked: 'Adres na liście blokad dostawcy',
  complaint: 'Skarga (oznaczenie wiadomości jako spam)',
  unsubscribed: 'Wypisanie z komunikacji',
});

export const RELEASE_REASON_LABELS = Object.freeze({
  address_corrected: 'Adres został poprawiony lub potwierdzony',
  provider_unblocked: 'Dostawca odblokował adres',
  bounce_reviewed: 'Odbicie sprawdzone (awaria przejściowa)',
  parent_request: 'Na wniosek rodzica',
});

// Jak PARENT_ONLY_REASONS w src/pg/routes/email.js.
export const PARENT_ONLY_REASONS = Object.freeze(['complaint', 'unsubscribed']);
export const RELEASE_REASONS = Object.freeze(Object.keys(RELEASE_REASON_LABELS));

// Jak NOTE_PATTERN w src/pg/routes/email.js: krótki kod, nigdy treść rozmowy ani adres.
export const CONFIRMATION_NOTE_PATTERN = /^[a-z0-9_]{1,40}$/;

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export function suppressionsUrl(schoolYearId) {
  return `/api/email/suppressions?schoolYearId=${encodeURIComponent(schoolYearId)}`;
}

export function suppressionActionUrl(emailHash, action) {
  if (!HASH_PATTERN.test(String(emailHash))) throw new Error('Niepoprawny skrót adresu.');
  if (!['release-request', 'release'].includes(action)) throw new Error('Nieznana akcja.');
  return `/api/email/suppressions/${emailHash}/${action}`;
}

export function allowedReleaseReasons(suppressionReason) {
  return PARENT_ONLY_REASONS.includes(suppressionReason) ? ['parent_request'] : [...RELEASE_REASONS];
}

// Pusty kod = brak; zły kod = wyjątek z komunikatem dla formularza.
export function parseConfirmationNote(value, { required = false } = {}) {
  const text = String(value ?? '').trim();
  if (!text) {
    if (required) throw new Error('Podaj kod sposobu potwierdzenia (np. parent_email_reply).');
    return null;
  }
  if (!CONFIRMATION_NOTE_PATTERN.test(text)) {
    throw new Error('Kod: małe litery bez polskich znaków, cyfry i „_”, do 40 znaków. Bez adresów i treści rozmowy.');
  }
  return text;
}

// Stan wiersza: co można teraz zrobić. Zgłaszający nie zatwierdza własnego wniosku.
export function rowAction(item) {
  const pending = item?.pendingRequest;
  if (!pending) return 'request';
  return pending.requestedByMe ? 'waiting' : 'approve';
}

export function describeFamily(item) {
  if (!item?.householdId) return 'Nie znaleziono opiekuna z tym adresem (adres mógł zostać już poprawiony w danych)';
  return `Rodzina ${item.householdId}, opiekun ${item.guardianId}`;
}

export function formatSuppressionCount(count) {
  const n = Number(count) || 0;
  if (n === 1) return '1 adres do sprawdzenia';
  const last = n % 10;
  const teen = n % 100 >= 12 && n % 100 <= 14;
  return `${n} ${last >= 2 && last <= 4 && !teen ? 'adresy' : 'adresów'} do sprawdzenia`;
}

export function describeSuppressionError(status, code) {
  if (code === 'self_approval_forbidden') return 'Zdjęcie blokady musi zatwierdzić inna osoba niż ta, która złożyła wniosek.';
  if (code === 'suppression_not_active') return 'Ta blokada nie jest już aktywna. Odśwież listę.';
  if (code === 'request_already_consumed') return 'Ten wniosek został już rozpatrzony. Odśwież listę.';
  if (code === 'release_reason_not_allowed') return 'Blokadę po skardze lub wypisaniu można zdjąć wyłącznie na wniosek rodzica.';
  if (status === 401) return 'Sesja wygasła. Zaloguj się ponownie.';
  if (code === 'mfa_required') return 'Potwierdź logowanie drugim składnikiem (MFA).';
  if (status === 403) return 'Nie masz uprawnień do listy wyłączeń w tym roku szkolnym.';
  return null;
}
