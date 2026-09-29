// Logika czysta ekranu aktualności (issue #147 — src/pg/news.js, trasy /api/news*
// i /api/news-photos). Bez sieci, bez DOM: testy w tests/news-panel-core.test.js.
// Zdjęcia: ekran tylko czyta rejestr i status zgody; rejestracji, weryfikacji ani
// cofania praw tu nie ma. Kontrolę dostępu wykonuje wyłącznie serwer.

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

// Role z NEWS_POLICY w src/pg/news.js — parzystość pilnuje testu.
export const SCHOOL_WIDE_EDITOR_ROLES = Object.freeze(['admin', 'board']);
export const CLASS_EDITOR_ROLES = Object.freeze(['representative']);
export const REVIEW_ROLES = Object.freeze(['board']);
export const PHOTO_READ_ROLES = Object.freeze(['admin', 'board']);

export const MAX_PHOTOS = 20;
export const TITLE_LIMITS = Object.freeze({ min: 3, max: 200 });
export const BODY_LIMITS = Object.freeze({ min: 1, max: 20000 });
export const REASON_LIMITS = Object.freeze({ min: 3, max: 500 });

export const STATUS_LABELS = Object.freeze({
  draft: 'Szkic',
  submitted: 'Zgłoszony do zatwierdzenia',
  approved: 'Zatwierdzony',
  published: 'Opublikowany',
  withdrawn: 'Wycofany',
});

export const RIGHTS_LABELS = Object.freeze({
  pending: 'Prawa do weryfikacji',
  verified: 'Prawa zweryfikowane',
  revoked: 'Prawa cofnięte',
  unknown: 'Status nieznany (brak dostępu do rejestru)',
});

export const CONSENT_SCOPE_LABELS = Object.freeze({
  rada_website: 'strona Rady',
  print: 'druk',
  social_media: 'media społecznościowe',
});

export function isValidId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value.trim());
}

function matchingGrants(grants, roles, { schoolYearId = '', classId } = {}) {
  return (Array.isArray(grants) ? grants : []).filter((grant) => roles.includes(grant?.role)
    && (classId === undefined ? !grant.classId : grant.classId === classId)
    && (!schoolYearId || !grant.schoolYearId || grant.schoolYearId === String(schoolYearId).trim()));
}

// PRZYBLIŻENIA widoczności przycisków (AGENTS.md: ukrycie nie jest kontrolą dostępu).
export function isSchoolWideEditor(grants, schoolYearId = '') {
  return matchingGrants(grants, SCHOOL_WIDE_EDITOR_ROLES, { schoolYearId }).length > 0;
}

export function isReviewer(grants, schoolYearId = '') {
  return matchingGrants(grants, REVIEW_ROLES, { schoolYearId }).length > 0;
}

export function representedClassIds(grants, schoolYearId = '') {
  return [...new Set((Array.isArray(grants) ? grants : [])
    .filter((g) => CLASS_EDITOR_ROLES.includes(g?.role) && g.classId
      && (!schoolYearId || !g.schoolYearId || g.schoolYearId === String(schoolYearId).trim()))
    .map((g) => g.classId))];
}

export function hasNewsAccess(grants) {
  return (Array.isArray(grants) ? grants : []).some((g) => [...SCHOOL_WIDE_EDITOR_ROLES, ...CLASS_EDITOR_ROLES, ...REVIEW_ROLES].includes(g?.role));
}

export function canReadPhotoRegister(grants, schoolYearId = '') {
  return matchingGrants(grants, PHOTO_READ_ROLES, { schoolYearId }).length > 0;
}

export function newsYears(grants) {
  return [...new Set((Array.isArray(grants) ? grants : [])
    .filter((g) => [...SCHOOL_WIDE_EDITOR_ROLES, ...CLASS_EDITOR_ROLES].includes(g?.role) && g.schoolYearId)
    .map((g) => g.schoolYearId))].sort((a, b) => b.localeCompare(a));
}

export function listUrl(schoolYearId) {
  if (!isValidId(schoolYearId)) throw new Error('Podaj poprawny identyfikator roku szkolnego.');
  return `/api/news?schoolYearId=${encodeURIComponent(schoolYearId.trim())}`;
}

export function postUrl(postId, action = '') {
  if (!isValidId(postId)) throw new Error('Niepoprawny identyfikator wpisu.');
  if (action && !['submit', 'approve', 'publish', 'withdraw'].includes(action)) throw new Error('Nieznana akcja.');
  return `/api/news/${encodeURIComponent(postId.trim())}${action ? `/${action}` : ''}`;
}

export function photoUrl(photoId) {
  if (!isValidId(photoId)) throw new Error('Niepoprawny identyfikator zdjęcia.');
  return `/api/news-photos/${encodeURIComponent(photoId.trim())}`;
}

// Klucz idempotencji tworzenia szkicu: generowany raz na otwarcie okna, więc
// ponowienie po błędzie sieci nie tworzy drugiego wpisu (POST /api/news).
export function makeIdempotencyKey(random = () => globalThis.crypto.randomUUID()) {
  return `news-${random()}`;
}

function normalizeText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

// Walidacja jak w src/pg/news.js (parseContent); serwer i tak waliduje ponownie.
export function validateDraft({ title, body, photoIds = [] }, { classId = null, requireClass = false } = {}) {
  const errors = [];
  const t = normalizeText(title);
  const b = normalizeText(body);
  if (t.length < TITLE_LIMITS.min || t.length > TITLE_LIMITS.max || t.includes('\n')) errors.push('Tytuł musi mieć od 3 do 200 znaków, w jednej linii.');
  if (b.length < BODY_LIMITS.min || b.length > BODY_LIMITS.max) errors.push('Treść musi mieć od 1 do 20000 znaków.');
  if (photoIds.length > MAX_PHOTOS) errors.push(`Najwyżej ${MAX_PHOTOS} zdjęć we wpisie.`);
  if (new Set(photoIds).size !== photoIds.length) errors.push('Zdjęcie jest wybrane więcej niż raz.');
  if (requireClass && !classId) errors.push('Wybierz klasę wpisu.');
  return errors;
}

export function validateReason(reason) {
  const value = normalizeText(reason);
  return value.length < REASON_LIMITS.min || value.length > REASON_LIMITS.max
    ? ['Powód musi mieć od 3 do 500 znaków.'] : [];
}

// Przybliżenie reguły czterech oczu: zatwierdzający nie jest autorem wpisu ani
// autorem bieżącej wersji (serwer i trigger bazy egzekwują to niezależnie).
export function isLikelyOwnPost(post, actorId) {
  return Boolean(post && actorId && (post.createdBy === actorId || post.updatedBy === actorId));
}

// Które akcje pokazać dla wpisu — czysta funkcja, wynik to wyłącznie wskazówka UI.
export function availableActions(post, { grants = [], actorId = null } = {}) {
  const none = { edit: false, submit: false, approve: false, publish: false, withdraw: false, waitingForSecondPerson: false };
  if (!post || post.status === 'withdrawn') return none;
  const year = post.schoolYearId;
  const wide = isSchoolWideEditor(grants, year);
  const classEditor = Boolean(post.classId) && matchingGrants(grants, CLASS_EDITOR_ROLES, { schoolYearId: year, classId: post.classId }).length > 0;
  const editor = wide || classEditor;
  const reviewer = isReviewer(grants, year);
  const own = isLikelyOwnPost(post, actorId);
  return {
    edit: editor,
    submit: editor && post.status === 'draft',
    approve: reviewer && post.status === 'submitted' && !own,
    publish: reviewer && post.status === 'approved',
    withdraw: reviewer || (post.publishedRevision === null && editor),
    waitingForSecondPerson: reviewer && post.status === 'submitted' && own,
  };
}

// Zdjęcia do wyboru we wpisie: tylko ze zweryfikowanymi prawami (serwer i tak
// blokuje zatwierdzenie i publikację wpisu z niezweryfikowanym lub cofniętym zdjęciem).
export function selectablePhotos(photos) {
  return (Array.isArray(photos) ? photos : []).filter((p) => p?.rightsStatus === 'verified');
}

export function photoSummary(photo) {
  if (!photo) return '';
  const parts = [photo.author, photo.takenOn];
  if (photo.decorative) parts.push('dekoracyjne');
  else if (photo.altText) parts.push(`opis: ${photo.altText}`);
  else parts.push('brak opisu alternatywnego');
  return parts.filter(Boolean).join(' · ');
}

export function peopleSummary(photo) {
  if (!photo?.depictsChildren) return `bez dzieci, dorosłych rozpoznawalnych: ${photo?.identifiableAdults ?? 0}`;
  return `z dziećmi (rozpoznawalnych: ${photo.identifiableChildren ?? 0}), dorosłych rozpoznawalnych: ${photo.identifiableAdults ?? 0}`;
}

export function consentSummary(consent) {
  const scope = (Array.isArray(consent?.scope) ? consent.scope : []).map((s) => CONSENT_SCOPE_LABELS[s] ?? s);
  const kind = consent?.subjectKind === 'child' ? 'dziecko' : 'dorosły';
  const until = consent?.validUntil ? `ważna do ${consent.validUntil}` : 'bez terminu ważności';
  return `${kind} nr ${consent?.subjectNo ?? '?'} · zakres: ${scope.length ? scope.join(', ') : 'nie określono'} · ${until}`;
}

const dateTimeFormatter = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Brussels' });

// Czas w Europe/Brussels, jak w Wydarzeniach, Zebraniach i Kontach (przegląd demo).
export function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : dateTimeFormatter.format(date);
}

export function describeApiError(status, code) {
  if (status === 401 || code === 'unauthenticated') return 'Sesja wygasła. Zaloguj się ponownie.';
  if (code === 'mfa_required') return 'Zatwierdzenie i publikacja wymagają potwierdzenia logowania drugim składnikiem (MFA).';
  if (code === 'revision_conflict') return 'Ktoś zmienił wpis w międzyczasie. Widok został odświeżony — sprawdź zmiany i powtórz operację.';
  if (status === 404 || code === 'post_not_found') return 'Nie znaleziono wpisu albo nie masz do niego dostępu.';
  if (status === 403 && code === 'forbidden') return 'Nie masz uprawnień do tej operacji w wybranym zakresie.';
  return null;
}
