// #152: wykrywanie możliwych danych osobowych w polach wolnego tekstu.
//
// Deterministyczne, bez usług zewnętrznych i bez wysyłania tekstu gdziekolwiek.
// Zwraca WYŁĄCZNIE kategorie i liczby trafień — nigdy dopasowany fragment ani
// nazwisko. To środek wspierający (ostrzeżenie/blokada publikacji), nie
// zastępuje odpowiedzialności osoby zapisującej (patrz issue #152).

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// IBAN: BE (16 znaków: BE + 2 cyfry kontrolne + 12 cyfr) i PL (28 znaków:
// PL + 2 cyfry kontrolne + 24 cyfry), zapis ze spacjami co 4 znaki dozwolony.
// Walidacja mod-97 (ISO 7064) ogranicza fałszywe trafienia na przypadkowych
// ciągach cyfr poprzedzonych "BE"/"PL".
const IBAN_CANDIDATE = /\b(BE|PL)[ -]?\d{2}(?:[ -]?\d{4}){2,6}[ -]?\d{0,4}\b/gi;

function ibanChecksumValid(raw) {
  const compact = raw.replace(/[ -]/g, '').toUpperCase();
  if (!/^(BE\d{14}|PL\d{26})$/.test(compact)) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  // mod 97 na długim ciągu cyfr, kawałkami (BigInt byłby prostszy, ale
  // zostajemy przy liczbach bezpiecznych dla zgodności ze starszymi silnikami).
  let remainder = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    remainder = Number(`${remainder}${numeric.slice(i, i + 7)}`) % 97;
  }
  return remainder === 1;
}

// Telefon PL/BE: opcjonalny prefiks kraju, 9-10 cyfr w grupach rozdzielonych
// spacjami/kropkami/myślnikami. Wymaga separatora albo prefiksu +/00, żeby nie
// łapać przypadkowych długich liczb (np. kwot, numerów referencyjnych).
const PHONE_PATTERN = /(?<!\d)(?:\+|00)(?:32|48)[ .-]?(?:\d[ .-]?){8,9}(?!\d)|\b0\d(?:[ .-]?\d){7,8}\b/g;

// Numer rejestru krajowego BE (RRN): 11 cyfr YY.MM.DD-XXX.CC, gdzie CC to
// 97 - (pierwsze 9 cyfr mod 97); dla urodzonych od 2000 r. liczy się z prefiksem
// "2". Miesiąc 00-12 (lub +20/+40 dla numerów bis). Suma kontrolna i zakres
// miesiąca ograniczają fałszywe trafienia na zwykłych 11-cyfrowych liczbach.
const NATIONAL_ID_CANDIDATE = /(?<![\d])\d{2}[.\- ]?\d{2}[.\- ]?\d{2}[.\- ]?\d{3}[.\- ]?\d{2}(?![\d])/g;

function nationalIdValid(raw) {
  const digits = raw.replace(/[.\- ]/g, '');
  if (!/^\d{11}$/.test(digits)) return false;
  const month = Number(digits.slice(2, 4));
  if (!(month <= 12 || (month >= 20 && month <= 32) || (month >= 40 && month <= 52))) return false;
  const base = Number(digits.slice(0, 9));
  const check = Number(digits.slice(9));
  return 97 - (base % 97) === check || 97 - ((2_000_000_000 + base) % 97) === check;
}

function stripDiacritics(value) {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

function normalizeWord(value) {
  return stripDiacritics(String(value ?? '')).toLocaleLowerCase('pl-PL').trim();
}

// Dopasowanie "znanego imienia i nazwiska": liczy się jako trafienie, gdy w
// tekście występuje ZARÓWNO imię, JAK I nazwisko tej samej osoby (dowolna
// kolejność, gdziekolwiek w tekście) — tak żeby np. "Anna i Piotr Testowy"
// trafiło jako dwie osoby (Anna Testowy, Piotr Testowy), nie tylko jedna.
// Dopasowanie na granicy słowa, bez rozróżniania wielkości liter i diakrytyków.
function countKnownNameHits(text, knownNames) {
  const normalizedText = normalizeWord(text);
  if (!normalizedText) return 0;
  const words = new Set(normalizedText.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  let hits = 0;
  for (const { firstName, lastName } of knownNames) {
    const first = normalizeWord(firstName);
    const last = normalizeWord(lastName);
    // Imię/nazwisko z wielu wyrazów (np. "van der Berg"): każdy wyraz musi wystąpić.
    const firstParts = first.split(/\s+/).filter(Boolean);
    const lastParts = last.split(/\s+/).filter(Boolean);
    if (!firstParts.length && !lastParts.length) continue;
    const firstPresent = firstParts.length > 0 && firstParts.every((part) => words.has(part));
    const lastPresent = lastParts.length > 0 && lastParts.every((part) => words.has(part));
    if (firstPresent && lastPresent) hits += 1;
  }
  return hits;
}

/**
 * @param {string} text
 * @param {{knownNames?: Array<{firstName: string, lastName: string}>}} [options]
 * @returns {{categories: string[], counts: {email: number, iban: number, national_id: number, phone: number, known_name: number}}}
 */
export function detectPossiblePersonalData(text, { knownNames = [] } = {}) {
  const value = String(text ?? '');
  const emailHits = value.match(EMAIL_PATTERN)?.length ?? 0;
  const ibanCandidates = value.match(IBAN_CANDIDATE) ?? [];
  const ibanHits = ibanCandidates.filter(ibanChecksumValid).length;
  const nationalIds = (value.match(NATIONAL_ID_CANDIDATE) ?? []).filter(nationalIdValid);
  // Numer rejestru krajowego zapisany z separatorami wyglądałby też jak telefon —
  // wycinamy go przed liczeniem telefonów, żeby kategorie się nie dublowały.
  const withoutNationalIds = value.replace(NATIONAL_ID_CANDIDATE, (match) => (nationalIdValid(match) ? ' ' : match));
  const phoneHits = withoutNationalIds.match(PHONE_PATTERN)?.length ?? 0;
  const nationalIdHits = nationalIds.length;
  const knownNameHits = countKnownNameHits(value, knownNames);
  const counts = { email: emailHits, iban: ibanHits, national_id: nationalIdHits, phone: phoneHits, known_name: knownNameHits };
  const categories = Object.entries(counts).filter(([, count]) => count > 0).map(([category]) => category);
  return { categories, counts };
}

export function hasPossiblePersonalData(text, options) {
  return detectPossiblePersonalData(text, options).categories.length > 0;
}
