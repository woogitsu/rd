// Logika czysta ekranu eksportu (issue #147 — src/pg/routes/exports.js). Bez sieci
// i bez DOM: testy w tests/data-export-panel-core.test.js. Weryfikacja paczki w
// przeglądarce (WebCrypto) sprawdza sumy kontrolne i liczności; pełne sprawdzenie
// (kolumny, sumy w centach, odtworzenie do pustej bazy) robi `npm run db:verify-export`.

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

// Role z src/pg/routes/exports.js — parzystość pilnuje tests/data-export-panel-core.test.js.
export const YEARLY_EXPORT_ROLES = Object.freeze(['admin', 'board']);
export const ROSTER_ROLES = Object.freeze(['representative', 'board', 'admin']);

export function isValidId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value.trim());
}

// PRZYBLIŻENIE widoczności sekcji (ukrycie przycisku nie jest kontrolą dostępu).
// Eksport roczny: przydział bez klasy (jak isAuthorizedScoped bez classId).
export function hasYearlyAccess(grants) {
  return (Array.isArray(grants) ? grants : []).some((g) => YEARLY_EXPORT_ROLES.includes(g?.role) && !g.classId);
}

export function hasRosterAccess(grants) {
  return (Array.isArray(grants) ? grants : []).some((g) => ROSTER_ROLES.includes(g?.role));
}

export function yearlyYears(grants) {
  const ids = new Set((Array.isArray(grants) ? grants : [])
    .filter((g) => YEARLY_EXPORT_ROLES.includes(g?.role) && !g.classId && g.schoolYearId)
    .map((g) => g.schoolYearId));
  return [...ids].sort((a, b) => b.localeCompare(a));
}

export function rosterUrl(classId, format = 'csv') {
  if (!isValidId(classId)) throw new Error('Wybierz klasę.');
  if (format !== 'csv' && format !== 'json') throw new Error('Nieznany format.');
  return `/api/exports/class-roster?classId=${encodeURIComponent(classId.trim())}&format=${format}`;
}

export function yearlyBody(schoolYearId) {
  if (!isValidId(schoolYearId)) throw new Error('Wybierz rok szkolny.');
  return { schoolYearId: schoolYearId.trim() };
}

// Kod z 6 cyfr do POST /api/mfa/verify: spacje i myślniki (wpisywane z aplikacji) ignorowane.
export function normalizeTotp(value) {
  return String(value ?? '').replace(/[\s-]/g, '');
}

export function isTotpShape(value) {
  return /^\d{6,8}$/.test(normalizeTotp(value));
}

// Krok w górę: 403 mfa_stale wymaga świeżego kodu (docs/AUTH.md, #150).
export function needsStepUp(error) {
  return error?.status === 403 && error?.code === 'mfa_stale';
}

export function describeApiError(status, code) {
  if (code === 'mfa_stale') return 'Eksport wymaga świeżego potwierdzenia kodem (ostatnie 15 minut).';
  if (status === 401 || code === 'unauthenticated') return 'Sesja wygasła. Zaloguj się ponownie.';
  if (code === 'export_in_progress') return 'Eksport tego roku już trwa. Poczekaj na jego zakończenie i spróbuj ponownie.';
  if (status === 403 && code === 'forbidden') return 'Nie masz uprawnień do tego eksportu w wybranym zakresie.';
  return null;
}

export function filenameFromDisposition(header, fallback) {
  const match = /filename="([A-Za-z0-9_.-]{1,200})"/.exec(String(header ?? ''));
  return match ? match[1] : fallback;
}

export function formatBytes(size) {
  if (!Number.isFinite(size) || size < 0) return '—';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(size / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

// Ten sam kanoniczny JSON co canonicalJson w src/pg/export.js (klucze posortowane,
// bez wartości undefined); kopia, bo moduł serwera importuje node:crypto.
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non_finite_number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error('unsupported_value');
}

export async function sha256Hex(text, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error('webcrypto_unavailable');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const VERIFY_ERROR_LABELS = Object.freeze({
  invalid_json: 'Plik nie jest poprawnym JSON.',
  invalid_bundle: 'To nie jest paczka eksportu rocznego.',
  invalid_manifest_sha256: 'Brak poprawnego skrótu manifestu.',
  manifest_hash_mismatch: 'Skrót manifestu nie zgadza się z zawartością — plik został zmieniony.',
  header_hash_mismatch: 'Skrót manifestu różni się od skrótu zwróconego przez serwer.',
  file_missing: 'Brak pliku wymienionego w manifeście.',
  file_hash_mismatch: 'Skrót pliku tabeli nie zgadza się z manifestem.',
  row_count_mismatch: 'Liczba wierszy nie zgadza się z manifestem.',
  unlisted_file: 'Paczka zawiera plik spoza manifestu.',
});

function errorLabel(code) {
  const [base, ...rest] = code.split(':');
  const label = VERIFY_ERROR_LABELS[base] ?? base;
  return rest.length ? `${label} (${rest.join(':')})` : label;
}

// Zwraca { ok, schoolYearId, files, rows, errors: [tekst] } — bez treści paczki.
// `expectedManifestSha256` (nagłówek X-Export-Manifest-Sha256) jest opcjonalny.
export async function verifyBundleText(text, { expectedManifestSha256 = null, subtle } = {}) {
  const errors = [];
  let bundle;
  try { bundle = JSON.parse(text); } catch { return { ok: false, errors: [errorLabel('invalid_json')] }; }
  const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!plain(bundle) || bundle.format !== 'rd-yearly-export' || !plain(bundle.manifest) || !plain(bundle.files) || !Array.isArray(bundle.manifest.files)) {
    return { ok: false, errors: [errorLabel('invalid_bundle')] };
  }
  if (typeof bundle.manifestSha256 !== 'string' || !SHA256_PATTERN.test(bundle.manifestSha256)) {
    return { ok: false, errors: [errorLabel('invalid_manifest_sha256')] };
  }
  if (await sha256Hex(canonicalJson(bundle.manifest), subtle) !== bundle.manifestSha256) errors.push(errorLabel('manifest_hash_mismatch'));
  if (expectedManifestSha256 && expectedManifestSha256 !== bundle.manifestSha256) errors.push(errorLabel('header_hash_mismatch'));
  const listed = new Set();
  let rows = 0;
  for (const entry of bundle.manifest.files) {
    listed.add(entry?.path);
    const content = bundle.files[entry?.path];
    if (typeof content !== 'string') { errors.push(errorLabel(`file_missing:${entry?.path}`)); continue; }
    if (await sha256Hex(content, subtle) !== entry.sha256) errors.push(errorLabel(`file_hash_mismatch:${entry.path}`));
    const count = content === '' ? 0 : content.split('\n').length - 1;
    if (count !== entry.rows) errors.push(errorLabel(`row_count_mismatch:${entry.path}`));
    rows += count;
  }
  for (const path of Object.keys(bundle.files)) if (!listed.has(path)) errors.push(errorLabel(`unlisted_file:${path}`));
  return { ok: errors.length === 0, schoolYearId: bundle.manifest.schoolYearId ?? null, files: bundle.manifest.files.length, rows, errors };
}
