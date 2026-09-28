// Sprawdzenie gotowości nadawcy przed wysyłką (issue #148). NIE wysyła poczty
// i NIGDY nie łączy się z API Brevo (`BREVO_API_KEY` nie jest wymagany).
// Sprawdza wyłącznie konfigurację i publiczne rekordy DNS domeny nadawcy.
//   npm run email:preflight
// Wynik: lista kodów `ok|missing|warning` na stdout, bez sekretów i bez adresów
// rodzin. Zależy od decyzji D-17 (domena, adres nadawcy i odpowiedzi).

import { promises as dns } from 'node:dns';
import { emailConfig, isFreeEmailDomain, senderDomain } from '../src/email/brevo.js';

const MIN_WEBHOOK_SECRET_LENGTH = 32;

function parseHostList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function lookupTxt(resolveTxt, hostname) {
  try {
    const records = await resolveTxt(hostname);
    return records.map((parts) => parts.join(''));
  } catch {
    return [];
  }
}

async function lookupAny(resolveTxt, resolveCname, hostname) {
  const txt = await lookupTxt(resolveTxt, hostname);
  if (txt.length) return { found: true, records: txt };
  try {
    const cname = await resolveCname(hostname);
    if (cname.length) return { found: true, records: cname };
  } catch { /* brak CNAME — sprawdzone niżej */ }
  return { found: false, records: [] };
}

// `resolveTxt`/`resolveCname` są wstrzykiwane w testach (fałszywy resolver DNS,
// bez sieci). Domyślnie: `node:dns/promises`.
export async function runPreflight(env = process.env, { resolveTxt = dns.resolveTxt, resolveCname = dns.resolveCname } = {}) {
  const config = emailConfig(env);
  const checks = [];
  const push = (code, status, detail) => checks.push({ code, status, detail });

  if (!config.sender.email) {
    push('sender_email', 'missing', 'BREVO_FROM_EMAIL nie jest ustawiony');
  } else if (isFreeEmailDomain(config.sender.email)) {
    push('sender_email', 'warning', `domena ${senderDomain(config.sender.email)} jest na liście domen darmowych`);
  } else {
    push('sender_email', 'ok', `domena nadawcy: ${senderDomain(config.sender.email)}`);
  }

  if (!config.replyTo) push('reply_to', 'missing', 'BREVO_REPLY_TO nie jest ustawiony');
  else push('reply_to', 'ok', 'adres odpowiedzi ustawiony');

  const secret = String(env.BREVO_WEBHOOK_SECRET ?? '');
  if (secret.length < MIN_WEBHOOK_SECRET_LENGTH) push('webhook_secret', 'missing', `BREVO_WEBHOOK_SECRET krótszy niż ${MIN_WEBHOOK_SECRET_LENGTH} znaków`);
  else push('webhook_secret', 'ok', 'sekret webhooka skonfigurowany');

  const allowlist = parseHostList(env.EMAIL_TEST_ALLOWLIST);
  const preview = parseHostList(env.EMAIL_PREVIEW_RECIPIENTS);
  if (!allowlist.length && !preview.length) push('test_recipients', 'warning', 'EMAIL_TEST_ALLOWLIST i EMAIL_PREVIEW_RECIPIENTS oba puste');
  else push('test_recipients', 'ok', 'skonfigurowana lista adresów technicznych');

  const domain = config.sender.email ? senderDomain(config.sender.email) : null;
  if (!domain) {
    push('dmarc', 'missing', 'brak domeny nadawcy do sprawdzenia');
  } else {
    const dmarc = await lookupTxt(resolveTxt, `_dmarc.${domain}`);
    const record = dmarc.find((line) => line.toLowerCase().startsWith('v=dmarc1'));
    if (!record) push('dmarc', 'missing', `brak rekordu TXT _dmarc.${domain}`);
    else if (/p=none/i.test(record)) push('dmarc', 'warning', `DMARC p=none (${record})`);
    else push('dmarc', 'ok', record);
  }

  const dkimHosts = parseHostList(env.EMAIL_DKIM_HOSTS);
  if (!dkimHosts.length) {
    push('dkim', 'warning', 'EMAIL_DKIM_HOSTS nie jest ustawiony — nie sprawdzono selektorów DKIM');
  } else {
    for (const host of dkimHosts) {
      const result = await lookupAny(resolveTxt, resolveCname, host);
      push('dkim', result.found ? 'ok' : 'missing', result.found ? `znaleziono rekord dla ${host}` : `brak rekordu DKIM dla ${host}`);
    }
  }

  return checks;
}

function formatLine(check) {
  return `[email-preflight] ${check.status.padEnd(7)} ${check.code.padEnd(16)} ${check.detail}`;
}

/* c8 ignore start -- ścieżka CLI, pokryta przez testy runPreflight */
async function main() {
  const checks = await runPreflight(process.env);
  for (const check of checks) console.log(formatLine(check));
  process.exitCode = checks.some((c) => c.status === 'missing') ? 1 : 0;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main();
}
/* c8 ignore stop */
