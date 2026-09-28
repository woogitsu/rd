// Generator syntetycznych wyciągów CODA i CAMT.053 do testów (#105).
// Wyłącznie dane fikcyjne: rachunki to przykładowe IBAN z dokumentacji
// standardów (BE68 5390 0754 7034, BE71 0961 2345 6769), nazwy „Test”.

export const RADA_IBAN = 'BE68539007547034';
export const OTHER_IBAN = 'BE71096123456769';

// Rekord CODA: 128 znaków, pola 1-indeksowane [od, tekst].
function codaRecord(parts) {
  const chars = Array(128).fill(' ');
  for (const [from, text] of parts) {
    [...text].forEach((char, index) => { chars[from - 1 + index] = char; });
  }
  return chars.join('');
}

const ddmmyy = (iso) => `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(2, 4)}`;
const codaAmount = (cents) => [cents < 0 ? '1' : '0', String(Math.abs(cents) * 10).padStart(15, '0')];

/**
 * @param {object} o
 * @param {Array<{seq:number, bankRef:string, cents:number, bookedOn:string, communication?:string, structured?:string, detail?:number}>} o.movements
 */
export function codaFile({
  iban = RADA_IBAN, statementNumber = '001', openingCents = 100000, openingDate = '2026-09-01',
  closingCents, closingDate = '2026-09-30', movements = [],
}) {
  const closing = closingCents ?? openingCents + movements.filter((m) => !m.detail).reduce((s, m) => s + m.cents, 0);
  const account = iban.padEnd(34, ' ') + 'EUR';
  const lines = [
    codaRecord([[1, '0'], [2, '0000'], [6, ddmmyy(closingDate)], [9, '300'], [12, '05'], [14, 'D'], [25, 'SYNTETYCZNY TEST'.padEnd(26)], [128, '2']]),
    codaRecord([[1, '1'], [2, '2'], [3, statementNumber], [6, account], [43, codaAmount(openingCents)[0]],
      [44, codaAmount(openingCents)[1]], [59, ddmmyy(openingDate)], [65, 'RADA TEST'], [126, statementNumber]]),
  ];
  for (const movement of movements) {
    const [sign, digits] = codaAmount(movement.cents);
    const communication = movement.structured
      ? `101${movement.structured}`
      : (movement.communication ?? '').slice(0, 53);
    lines.push(codaRecord([[1, '21'], [3, String(movement.seq).padStart(4, '0')],
      [7, String(movement.detail ?? 0).padStart(4, '0')], [11, movement.bankRef.padEnd(21)], [32, sign], [33, digits],
      [48, ddmmyy(movement.bookedOn)], [54, '00150000'], [62, movement.structured ? '1' : '0'], [63, communication],
      [116, ddmmyy(movement.bookedOn)], [122, statementNumber], [125, '0'], [126, '1'], [128, '0']]));
    lines.push(codaRecord([[1, '22'], [3, String(movement.seq).padStart(4, '0')], [7, '0000'],
      [11, movement.structured ? '' : (movement.communication ?? '').slice(53, 106)], [126, '1'], [128, '0']]));
    // Rekord 23: rachunek i nazwa kontrahenta — parser musi je pominąć.
    lines.push(codaRecord([[1, '23'], [3, String(movement.seq).padStart(4, '0')], [7, '0000'],
      [11, `${OTHER_IBAN.padEnd(34)}EUR`], [48, 'KONTRAHENT TESTOWY'], [126, '0'], [128, '0']]));
  }
  const [closingSign, closingDigits] = codaAmount(closing);
  lines.push(codaRecord([[1, '8'], [2, statementNumber], [5, account], [42, closingSign], [43, closingDigits],
    [58, ddmmyy(closingDate)], [128, '0']]));
  lines.push(codaRecord([[1, '9'], [17, String(lines.length - 1).padStart(6, '0')], [128, '2']]));
  return `${lines.join('\r\n')}\r\n`;
}

const eur = (cents) => (Math.abs(cents) / 100).toFixed(2);
const indicator = (cents) => (cents < 0 ? 'DBIT' : 'CRDT');

/**
 * @param {object} o
 * @param {Array<{ref:string|null, cents:number, bookedOn:string, ustrd?:string, strd?:string, status?:string}>} o.movements
 */
export function camtFile({
  iban = RADA_IBAN, sequence = '1', openingCents = 100000, openingDate = '2026-09-01',
  closingCents, closingDate = '2026-09-30', movements = [], extra = '',
}) {
  const closing = closingCents ?? openingCents
    + movements.filter((m) => (m.status ?? 'BOOK') === 'BOOK').reduce((s, m) => s + m.cents, 0);
  const balance = (code, cents, date) => `
      <Bal><Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp>
        <Amt Ccy="EUR">${eur(cents)}</Amt><CdtDbtInd>${indicator(cents)}</CdtDbtInd><Dt><Dt>${date}</Dt></Dt></Bal>`;
  const entries = movements.map((m) => `
      <Ntry>
        ${m.ref ? `<NtryRef>N-${m.ref}</NtryRef>` : ''}
        <Amt Ccy="EUR">${eur(m.cents)}</Amt><CdtDbtInd>${indicator(m.cents)}</CdtDbtInd>
        <Sts><Cd>${m.status ?? 'BOOK'}</Cd></Sts>
        <BookgDt><Dt>${m.bookedOn}</Dt></BookgDt><ValDt><Dt>${m.bookedOn}</Dt></ValDt>
        ${m.ref ? `<AcctSvcrRef>${m.ref}</AcctSvcrRef>` : ''}
        <NtryDtls><TxDtls>
          <RltdPties><Dbtr><Nm>Kontrahent Testowy</Nm></Dbtr><DbtrAcct><Id><IBAN>${OTHER_IBAN}</IBAN></Id></DbtrAcct></RltdPties>
          <RmtInf>${m.strd ? `<Strd><CdtrRefInf><Ref>${m.strd}</Ref></CdtrRefInf></Strd>` : ''}${m.ustrd ? `<Ustrd>${m.ustrd}</Ustrd>` : ''}</RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>SYNTH-${sequence}</MsgId><CreDtTm>${closingDate}T18:00:00</CreDtTm></GrpHdr>
    <Stmt>
      <Id>STMT-${sequence}</Id><ElctrncSeqNb>${sequence}</ElctrncSeqNb>
      <Acct><Id><IBAN>${iban}</IBAN></Id><Ccy>EUR</Ccy></Acct>${balance('OPBD', openingCents, openingDate)}${balance('CLBD', closing, closingDate)}${entries}
    </Stmt>${extra}
  </BkToCstmrStmt>
</Document>
`;
}
