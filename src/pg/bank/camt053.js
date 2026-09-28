// Parser wyciągu CAMT.053 (ISO 20022 BankToCustomerStatement) — #105.
// Czysta funkcja: nie zapisuje pliku, nie loguje treści. Własny, minimalny
// czytnik XML: bez DTD i encji zewnętrznych (DOCTYPE = odrzucenie, brak XXE),
// przestrzenie nazw pomijane (liczy się nazwa lokalna elementu).
//
// Założenie (do weryfikacji na pliku syntetycznym wybranego banku, D-13):
//   Document/BkToCstmrStmt/Stmt — dokładnie jeden wyciąg w pliku
//     Id, ElctrncSeqNb (numer wyciągu), Acct/Id/IBAN, Acct/Ccy
//     Bal: Tp/CdOrPrtry/Cd = OPBD (albo PRCD) — saldo początkowe, CLBD — końcowe;
//          Amt, CdtDbtInd (CRDT/DBIT), Dt/Dt
//     Ntry: Amt (Ccy="EUR"), CdtDbtInd, Sts (BOOK; inne pomijane), BookgDt/Dt,
//           AcctSvcrRef albo NtryRef (identyfikator transakcji banku),
//           NtryDtls/TxDtls/RmtInf/Strd/CdtrRefInf/Ref albo RmtInf/Ustrd (tytuł)
// Rekord w błędach = numer kolejny elementu Ntry (albo Bal) w pliku.

import {
  MAX_BALANCE_CENTS, MAX_MOVEMENT_CENTS, MAX_STATEMENT_MOVEMENTS, StatementFileError,
  normalizeIban, validIsoDate,
} from './common.js';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (match, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      if (!Number.isInteger(code) || code < 1 || code > 0x10ffff) throw new StatementFileError('invalid_statement_file');
      return String.fromCodePoint(code);
    }
    if (!(name in ENTITIES)) throw new StatementFileError('invalid_statement_file');
    return ENTITIES[name];
  });
}

const localName = (qualified) => qualified.slice(qualified.indexOf(':') + 1);

export function parseXml(source) {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new StatementFileError('invalid_statement_file');
  const root = { name: '#root', children: [], text: '' };
  const stack = [root];
  const token = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([A-Za-z_][\w.:-]*)\s*>|<([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|([^<]+)|(<)/g;
  let match;
  while ((match = token.exec(source)) !== null) {
    const [, cdata, closeName, openName, attrText, selfClose, text, stray] = match;
    const top = stack[stack.length - 1];
    if (stray) throw new StatementFileError('invalid_statement_file');
    if (cdata !== undefined) top.text += cdata;
    else if (text !== undefined) top.text += decodeEntities(text);
    else if (closeName) {
      if (stack.length < 2 || top.qualified !== closeName) throw new StatementFileError('invalid_statement_file');
      stack.pop();
    } else if (openName) {
      const attrs = {};
      for (const [, key, dq, sq] of (attrText ?? '').matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        attrs[localName(key)] = decodeEntities(dq ?? sq);
      }
      const node = { name: localName(openName), qualified: openName, attrs, children: [], text: '' };
      top.children.push(node);
      if (!selfClose) stack.push(node);
    }
  }
  if (stack.length !== 1) throw new StatementFileError('invalid_statement_file');
  return root;
}

const child = (node, name) => node?.children.find((item) => item.name === name) ?? null;
const children = (node, name) => node?.children.filter((item) => item.name === name) ?? [];
const path = (node, ...names) => names.reduce((current, name) => child(current, name), node);
const textOf = (node) => (node ? node.text.trim() : null);

function camtAmount(amountNode, indicatorNode, record, max) {
  const text = textOf(amountNode);
  if (!text || !/^\d{1,13}(\.\d{1,2})?$/.test(text)) throw new StatementFileError('invalid_statement_file', record);
  if ((amountNode.attrs.Ccy ?? 'EUR') !== 'EUR') throw new StatementFileError('statement_currency_unsupported', record);
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents > max) throw new StatementFileError('statement_amount_out_of_range', record);
  const indicator = textOf(indicatorNode);
  if (indicator === 'CRDT') return cents;
  if (indicator === 'DBIT') return -cents;
  throw new StatementFileError('invalid_statement_file', record);
}

function camtDate(node, record) {
  const text = textOf(child(node, 'Dt')) ?? textOf(child(node, 'DtTm'))?.slice(0, 10) ?? null;
  if (!validIsoDate(text)) throw new StatementFileError('invalid_statement_file', record);
  return text;
}

function entryStatus(entry) {
  const status = child(entry, 'Sts');
  if (!status) return null;
  return textOf(child(status, 'Cd')) ?? textOf(status);
}

function entryReference(entry) {
  for (const details of children(entry, 'NtryDtls')) {
    for (const tx of children(details, 'TxDtls')) {
      const remittance = child(tx, 'RmtInf');
      const structured = textOf(path(remittance, 'Strd', 'CdtrRefInf', 'Ref'));
      if (structured) return structured;
      const unstructured = children(remittance, 'Ustrd').map(textOf).filter(Boolean).join(' ');
      if (unstructured) return unstructured;
    }
  }
  return textOf(child(entry, 'AddtlNtryInf'));
}

export function parseCamt053(text) {
  if (typeof text !== 'string' || !text.trim()) throw new StatementFileError('invalid_statement_file');
  const document = child(parseXml(text.replace(/^﻿/, '')), 'Document');
  const report = child(document, 'BkToCstmrStmt');
  const statements = children(report, 'Stmt');
  if (!statements.length) throw new StatementFileError('invalid_statement_file');
  if (statements.length > 1) throw new StatementFileError('statement_multiple_not_supported');
  const statement = statements[0];

  const account = child(statement, 'Acct');
  const iban = normalizeIban(textOf(path(account, 'Id', 'IBAN')) ?? '');
  if (!iban) throw new StatementFileError('statement_account_unsupported');
  const currency = textOf(child(account, 'Ccy'));
  if (currency && currency !== 'EUR') throw new StatementFileError('statement_currency_unsupported');

  let opening = null;
  let closing = null;
  children(statement, 'Bal').forEach((balance, index) => {
    const record = index + 1;
    const code = textOf(path(balance, 'Tp', 'CdOrPrtry', 'Cd'));
    const value = () => ({
      balanceCents: camtAmount(child(balance, 'Amt'), child(balance, 'CdtDbtInd'), record, MAX_BALANCE_CENTS),
      date: camtDate(child(balance, 'Dt'), record),
    });
    if ((code === 'OPBD' || code === 'PRCD') && !opening) opening = value();
    else if (code === 'CLBD' && !closing) closing = value();
  });
  if (!opening || !closing) throw new StatementFileError('invalid_statement_file');

  const statementNumber = textOf(child(statement, 'ElctrncSeqNb')) ?? textOf(child(statement, 'LglSeqNb'))
    ?? textOf(child(statement, 'Id'));
  const entries = children(statement, 'Ntry');
  const movements = [];
  entries.forEach((entry, index) => {
    const record = index + 1;
    if (entryStatus(entry) !== 'BOOK') return;
    const amountCents = camtAmount(child(entry, 'Amt'), child(entry, 'CdtDbtInd'), record, MAX_MOVEMENT_CENTS);
    if (amountCents === 0) throw new StatementFileError('invalid_statement_line', record);
    const bankId = textOf(child(entry, 'AcctSvcrRef')) || textOf(child(entry, 'NtryRef'));
    if (!bankId) throw new StatementFileError('statement_transaction_id_missing', record);
    movements.push({
      record,
      bookedOn: camtDate(child(entry, 'BookgDt'), record),
      amountCents,
      transactionId: `camt:${bankId}`,
      reference: entryReference(entry),
    });
    if (movements.length > MAX_STATEMENT_MOVEMENTS) throw new StatementFileError('invalid_line_count', record);
  });
  if (!movements.length) throw new StatementFileError('invalid_line_count');
  return {
    format: 'camt053',
    accountIban: iban,
    statementNumber,
    openingBalanceCents: opening.balanceCents,
    openingDate: opening.date,
    closingBalanceCents: closing.balanceCents,
    closingDate: closing.date,
    movements,
  };
}
