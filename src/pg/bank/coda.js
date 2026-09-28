// Parser wyciągu CODA (Febelfin, rekordy stałej długości 128 znaków) — #105.
// Czysta funkcja: nie zapisuje pliku, nie loguje treści. Zwraca rachunek
// (wyłącznie do porównania z zatwierdzonym rachunkiem Rady), numer wyciągu,
// saldo początkowe i końcowe oraz ruchy z identyfikatorem transakcji banku.
//
// Założenie (do weryfikacji na pliku syntetycznym wybranego banku, D-13):
// układ pól według ogólnego opisu standardu CODA 2.x:
//   0  nagłówek
//   1  saldo początkowe: 2 struktura rachunku, 3-5 nr wyciągu, 6-42 rachunek i waluta,
//      43 znak (0 = Ma, 1 = Wn), 44-58 saldo (3 miejsca dziesiętne), 59-64 data DDMMRR
//   21 ruch: 3-6 nr kolejny, 7-10 nr szczegółu, 11-31 referencja banku, 32 znak,
//      33-47 kwota, 62 typ komunikatu (1 = strukturalny), 63-115 komunikat,
//      116-121 data księgowania DDMMRR
//   22, 23 ciąg dalszy komunikatu (23 zawiera też rachunek kontrahenta — pomijany)
//   3x, 4 informacje dodatkowe — pomijane
//   8  saldo końcowe: 5-41 rachunek i waluta, 42 znak, 43-57 saldo, 58-63 data
//   9  stopka
// Ruchy zbiorcze (globalizacja): liczymy tylko rekord 21 ze szczegółem 0000,
// żeby nie policzyć dwa razy kwoty rozbitej na szczegóły.

import {
  MAX_BALANCE_CENTS, MAX_MOVEMENT_CENTS, MAX_STATEMENT_MOVEMENTS, StatementFileError,
  belgianBbanToIban, normalizeIban, validIsoDate,
} from './common.js';

const RECORD_LENGTH = 128;

// Pola 1-indeksowane, włącznie z obu stron — jak w opisie standardu.
const field = (line, from, to) => line.slice(from - 1, to);

function codaDate(text, record) {
  if (!/^\d{6}$/.test(text)) throw new StatementFileError('invalid_statement_file', record);
  const iso = `20${text.slice(4, 6)}-${text.slice(2, 4)}-${text.slice(0, 2)}`;
  if (!validIsoDate(iso)) throw new StatementFileError('invalid_statement_file', record);
  return iso;
}

// Kwota: 15 cyfr, trzy miejsca dziesiętne; EUR ma dwa, więc ostatnia cyfra = 0.
function codaAmount(sign, digits, record, max) {
  if (!/^[01]$/.test(sign) || !/^\d{15}$/.test(digits) || !digits.endsWith('0')) {
    throw new StatementFileError('invalid_statement_file', record);
  }
  const cents = Number(digits.slice(0, 14));
  if (!Number.isSafeInteger(cents) || cents > max) throw new StatementFileError('statement_amount_out_of_range', record);
  return sign === '1' ? -cents : cents;
}

function codaAccount(structure, text, record) {
  let iban = null;
  let currency;
  if (structure === '0') {
    iban = belgianBbanToIban(text.slice(0, 12));
    currency = text.slice(13, 16);
  } else if (structure === '2' || structure === '3') {
    iban = normalizeIban(text.slice(0, 34).trim());
    currency = text.slice(34, 37);
  } else {
    // Struktura 1 (rachunek zagraniczny bez IBAN) — nieobsługiwana.
    throw new StatementFileError('statement_account_unsupported', record);
  }
  if (!iban) throw new StatementFileError('invalid_statement_file', record);
  return { iban, currency };
}

export function parseCoda(text) {
  if (typeof text !== 'string' || !text.trim()) throw new StatementFileError('invalid_statement_file');
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((line) => line.trim() !== '');
  let opening = null;
  let closing = null;
  let header = false;
  let trailer = false;
  const movements = [];
  let current = null;

  lines.forEach((raw, index) => {
    const record = index + 1;
    if (raw.length > RECORD_LENGTH) throw new StatementFileError('invalid_statement_file', record);
    const line = raw.padEnd(RECORD_LENGTH, ' ');
    if (trailer) throw new StatementFileError('invalid_statement_file', record);
    const type = line[0];
    if (!header) {
      if (type !== '0') throw new StatementFileError('invalid_statement_file', record);
      header = true;
      return;
    }
    if (type === '0') throw new StatementFileError('statement_multiple_not_supported', record);
    if (type === '1') {
      if (opening) throw new StatementFileError('statement_multiple_not_supported', record);
      const account = codaAccount(line[1], field(line, 6, 42), record);
      opening = {
        ...account,
        structure: line[1],
        statementNumber: field(line, 3, 5),
        balanceCents: codaAmount(field(line, 43, 43), field(line, 44, 58), record, MAX_BALANCE_CENTS),
        date: codaDate(field(line, 59, 64), record),
      };
      return;
    }
    if (!opening) throw new StatementFileError('invalid_statement_file', record);
    if (type === '2') {
      const part = line[1];
      if (part === '1') {
        const detail = field(line, 7, 10);
        if (!/^\d{4}$/.test(detail) || !/^\d{4}$/.test(field(line, 3, 6))) {
          throw new StatementFileError('invalid_statement_file', record);
        }
        if (detail !== '0000') { current = null; return; }
        const amountCents = codaAmount(field(line, 32, 32), field(line, 33, 47), record, MAX_MOVEMENT_CENTS);
        if (amountCents === 0) throw new StatementFileError('invalid_statement_line', record);
        const bankReference = field(line, 11, 31).trim();
        const structured = line[61] === '1';
        const communication = field(line, 63, 115);
        current = {
          record,
          bookedOn: codaDate(field(line, 116, 121), record),
          amountCents,
          // Rok z daty salda początkowego: numer wyciągu zaczyna się od nowa co rok.
          transactionId: `coda:${opening.date.slice(0, 4)}:${opening.statementNumber}:${field(line, 3, 6)}:${bankReference}`,
          structured,
          parts: [communication],
        };
        movements.push(current);
        if (movements.length > MAX_STATEMENT_MOVEMENTS) throw new StatementFileError('invalid_line_count', record);
        return;
      }
      if (part === '2' || part === '3') {
        if (current && !current.structured) {
          current.parts.push(part === '2' ? field(line, 11, 63) : field(line, 83, 125));
        }
        return;
      }
      throw new StatementFileError('invalid_statement_file', record);
    }
    if (type === '3' || type === '4') return;
    if (type === '8') {
      if (closing) throw new StatementFileError('invalid_statement_file', record);
      closing = {
        balanceCents: codaAmount(field(line, 42, 42), field(line, 43, 57), record, MAX_BALANCE_CENTS),
        date: codaDate(field(line, 58, 63), record),
      };
      const account = codaAccount(opening.structure, field(line, 5, 41), record);
      if (account.iban !== opening.iban) throw new StatementFileError('invalid_statement_file', record);
      return;
    }
    if (type === '9') { trailer = true; return; }
    throw new StatementFileError('invalid_statement_file', record);
  });

  if (!opening || !closing) throw new StatementFileError('invalid_statement_file');
  if (opening.currency !== 'EUR') throw new StatementFileError('statement_currency_unsupported');
  if (!movements.length) throw new StatementFileError('invalid_line_count');
  return {
    format: 'coda',
    accountIban: opening.iban,
    statementNumber: opening.statementNumber,
    openingBalanceCents: opening.balanceCents,
    openingDate: opening.date,
    closingBalanceCents: closing.balanceCents,
    closingDate: closing.date,
    movements: movements.map(({ record, bookedOn, amountCents, transactionId, structured, parts }) => ({
      record, bookedOn, amountCents, transactionId, reference: codaReference(structured, parts),
    })),
  };
}

// Komunikat strukturalny typu 101 = belgijski +++123/4567/89012+++; inny typ
// albo tekst wolny — złączone części. Wynik trafia wyłącznie do skrótu.
function codaReference(structured, parts) {
  if (structured) {
    const text = parts[0];
    if (text.slice(0, 3) === '101' && /^\d{12}$/.test(text.slice(3, 15))) {
      const digits = text.slice(3, 15);
      return `+++${digits.slice(0, 3)}/${digits.slice(3, 7)}/${digits.slice(7)}+++`;
    }
    return text.slice(3).trim() || null;
  }
  return parts.join('').replace(/\s+/g, ' ').trim() || null;
}
