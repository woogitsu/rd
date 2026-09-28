// Jeden moduł kwot EUR dla przeglądarki i serwera (#173). Bez zależności.
// Przechowywanie pozostaje bez zmian: całkowite centy (INTEGER/BIGINT).
//
// - parseEurInput(text)       -> centy (kwota dodatnia, bez znaku), rzuca MoneyError
// - parseStatementAmount(text)-> centy ze znakiem (wyciąg bankowy), rzuca MoneyError
// - parseCentsCell(text)      -> centy z kolumny liczb całkowitych (^\d+$), rzuca MoneyError
// - formatEur(cents, opts)    -> tekst; null/NaN -> „—”, nigdy „0,00 €”
//
// Gramatyka wejścia (parseEurInput / parseStatementAmount): spacje (zwykła,
// NBSP U+00A0, wąska NBSP U+202F) i końcowe „€”/„EUR” są usuwane; przecinek
// lub kropka jako separator dziesiętny (1-2 cyfry); spacje i druga z tych
// dwóch cyfr jako separator tysięcy w grupach po 3 cyfry. Wejście z dokładnie
// jednym separatorem i trzema cyframi po nim („1,234”) jest niejednoznaczne
// (mogłoby być groszami z trzema cyframi albo tysiącami) i zostaje odrzucone.
// Wykładnik, zapis szesnastkowy i cyfry spoza ASCII są zawsze odrzucane.

export class MoneyError extends Error {
  constructor(code) {
    super(code);
    this.name = 'MoneyError';
    this.code = code;
  }
}

export const MIN_AMOUNT_CENTS = 1;
export const MAX_AMOUNT_CENTS = 100_000_000; // 1 000 000,00 EUR

const SPACE_LIKE = /[  ]/g;
const CURRENCY_SUFFIX = /[   ]*(€|EUR)$/i;
const CHARSET = /^[\d.,   ]+$/;

function stripCurrencySuffix(text) {
  return text.replace(CURRENCY_SUFFIX, '');
}

// Grupa cyfr oddzielona spacjami: pierwsza 1-3 cyfry, kolejne dokładnie 3 —
// ale tylko gdy faktycznie użyto więcej niż jednej grupy (inaczej zwykła
// liczba bez separatora tysięcy, dowolnej długości, jest poprawna).
function digitsFromSpaceGroups(text) {
  const groups = text.split(' ').filter((g) => g !== '');
  if (!groups.length) return null;
  if (groups.length === 1) {
    return /^\d+$/.test(groups[0]) ? groups[0] : null;
  }
  if (!/^\d{1,3}$/.test(groups[0])) return null;
  for (let i = 1; i < groups.length; i += 1) {
    if (!/^\d{3}$/.test(groups[i])) return null;
  }
  return groups.join('');
}

// Rozkłada tekst bez znaku i bez waluty na { integer, fraction } (centy jako
// dwucyfrowy tekst) albo rzuca MoneyError('invalid_amount_format').
function parseUnsignedAmountText(raw) {
  let text = String(raw ?? '').trim();
  if (!text) throw new MoneyError('invalid_amount_format');
  text = stripCurrencySuffix(text).trim();
  if (!text) throw new MoneyError('invalid_amount_format');
  if (!CHARSET.test(text)) throw new MoneyError('invalid_amount_format');
  text = text.replace(SPACE_LIKE, ' ');

  const parts = text.split(/([.,])/);
  const groups = parts.filter((_, index) => index % 2 === 0);
  const seps = parts.filter((_, index) => index % 2 === 1);
  // Podwójny separator, separator na początku/końcu itd. daje pustą grupę —
  // zawsze niepoprawne (np. "1,,2" albo ",50").
  if (groups.some((group) => group.trim() === '')) throw new MoneyError('invalid_amount_format');

  if (seps.length === 0) {
    const digits = digitsFromSpaceGroups(groups[0]);
    if (!digits) throw new MoneyError('invalid_amount_format');
    return { integer: digits, fraction: '00' };
  }

  const lastGroup = groups[groups.length - 1];
  if (seps.length === 1 && /^\d{3}$/.test(lastGroup)) {
    // Dokładnie jeden separator i trzy cyfry po nim: niejednoznaczne (#173).
    throw new MoneyError('invalid_amount_format');
  }
  if (!/^\d{1,2}$/.test(lastGroup)) throw new MoneyError('invalid_amount_format');
  const fraction = lastGroup.padEnd(2, '0');

  const digitGroups = [];
  for (const group of groups.slice(0, -1)) {
    for (const sub of group.split(' ').filter((g) => g !== '')) digitGroups.push(sub);
  }
  if (!digitGroups.length) throw new MoneyError('invalid_amount_format');
  if (digitGroups.length > 1) {
    if (!/^\d{1,3}$/.test(digitGroups[0])) throw new MoneyError('invalid_amount_format');
    for (let i = 1; i < digitGroups.length; i += 1) {
      if (!/^\d{3}$/.test(digitGroups[i])) throw new MoneyError('invalid_amount_format');
    }
  } else if (!/^\d+$/.test(digitGroups[0])) {
    throw new MoneyError('invalid_amount_format');
  }
  return { integer: digitGroups.join(''), fraction };
}

function toCents({ integer, fraction }) {
  const cents = Number(integer) * 100 + Number(fraction);
  if (!Number.isSafeInteger(cents)) throw new MoneyError('invalid_amount_format');
  return cents;
}

// Kwota dodatnia (wpłata, korekta, zwrot, wpis księgi): 0,01–1 000 000,00 EUR.
export function parseEurInput(raw, { min = MIN_AMOUNT_CENTS, max = MAX_AMOUNT_CENTS } = {}) {
  const cents = toCents(parseUnsignedAmountText(raw));
  if (cents < min || cents > max) throw new MoneyError('amount_out_of_range');
  return cents;
}

// Kwota ze znakiem (pozycja wyciągu bankowego): +/- na początku, ta sama gramatyka.
export function parseStatementAmount(raw, { max = MAX_AMOUNT_CENTS } = {}) {
  const text = String(raw ?? '').trim();
  const match = text.match(/^([+-]?)([\s\S]*)$/);
  const sign = match[1] === '-' ? -1 : 1;
  const cents = toCents(parseUnsignedAmountText(match[2]));
  if (cents > max) throw new MoneyError('amount_out_of_range');
  return sign * cents;
}

// Kolumna z centami całkowitymi (np. import z drukowanych kartek): wyłącznie
// cyfry ASCII, bez separatorów, bez wykładnika i zapisu szesnastkowego.
export function parseCentsCell(raw) {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) throw new MoneyError('invalid_amount_format');
  const cents = Number(text);
  if (!Number.isSafeInteger(cents)) throw new MoneyError('invalid_amount_format');
  return cents;
}

const NBSP = ' ';
const MINUS = { screen: '−', print: '−', csv: '-' };

function groupThousands(digits) {
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    const fromEnd = digits.length - i;
    out += digits[i];
    if (fromEnd > 1 && fromEnd % 3 === 1) out += NBSP;
  }
  return out;
}

// centy -> tekst. style: 'screen' (panel, „1 234,56 €”), 'print' (wydruk/raport
// KR, „1 234,56 EUR”), 'csv' (bez separatora tysięcy, minus ASCII, bez waluty —
// zgodnie z docs/EXPORT.md). null/undefined/nie-liczba -> „—” we wszystkich stylach.
export function formatEur(cents, { style = 'screen' } = {}) {
  if (cents === null || cents === undefined || typeof cents === 'boolean') return '—';
  const value = typeof cents === 'bigint' ? Number(cents) : Number(cents);
  if (!Number.isFinite(value) || !Number.isSafeInteger(value)) return '—';
  const negative = value < 0;
  const abs = Math.abs(value);
  const euros = String(Math.trunc(abs / 100));
  const fraction = String(abs % 100).padStart(2, '0');
  const wholeText = style === 'csv' ? euros : groupThousands(euros);
  const sign = negative ? MINUS[style] ?? MINUS.screen : '';
  const amount = `${sign}${wholeText},${fraction}`;
  if (style === 'csv') return amount;
  if (style === 'print') return `${amount}${NBSP}EUR`;
  return `${amount}${NBSP}€`;
}
