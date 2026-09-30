// Logika czysta ekranu „Do sprawdzenia w logach dostawcy” (#139). Bez sieci
// i bez DOM: tests/email-resolutions-panel-core.test.js. Serwer
// (src/pg/routes/email.js) i tak egzekwuje każdą regułę — te funkcje tylko
// podpowiadają w interfejsie.

import { campaignUrl } from './core.js';

export const RESOLUTION_LABELS = Object.freeze({
  confirmed_delivered: 'Potwierdzono w logach dostawcy: wiadomość wyszła',
  confirmed_not_sent: 'Potwierdzono w logach dostawcy: wiadomość nie wyszła',
});

// Jak EVIDENCE_CODE_PATTERN w src/pg/routes/email.js: krótki kod, bez adresów i treści.
export const EVIDENCE_CODE_PATTERN = /^[a-z0-9_]{1,60}$/;

// campaignUrl odrzuca niepoprawny identyfikator (wyjątek), zanim powstanie adres.
function campaignBase(campaignId) {
  return campaignUrl(campaignId);
}

export function attentionUrl(campaignId, cursor = '') {
  const base = `${campaignBase(campaignId)}/attention`;
  return cursor ? `${base}?cursor=${encodeURIComponent(cursor)}` : base;
}

export function resolutionsUrl(campaignId) {
  return `${campaignBase(campaignId)}/resolutions`;
}

// Plik CSV raportu: te same liczby co tabela raportu, bez adresów.
export function reportCsvUrl(campaignId) {
  return `${campaignBase(campaignId)}/report?format=csv`;
}

// Dlaczego wiersz jest na liście. Kody z serwera; wyłącznie opis, bez adresu.
export function describeAttention(row) {
  const parts = [];
  if (row?.state === 'failed' && row?.lastError === 'delivery_unknown') parts.push('Nie wiadomo, czy wysłano');
  else if (row?.state === 'failed') parts.push(`Odrzucone przez dostawcę (kod ${row?.lastError ?? 'brak'})`);
  const soft = Number(row?.softBounceCount) || 0;
  if (soft >= 3) parts.push(`Powtarzające się odbicia tymczasowe: ${soft}`);
  return parts.join('; ') || 'Do sprawdzenia';
}

export function describeResolution(row) {
  if (!row?.resolution) return 'Brak';
  return RESOLUTION_LABELS[row.resolution] ?? row.resolution;
}

// Rozstrzyga się wyłącznie wiersze w stanie końcowym „failed”, raz.
export function canResolve(row) {
  return row?.state === 'failed' && !row?.resolution;
}

// „Nie wyszła” to twierdzenie silniejsze (otwiera ponowną wiadomość w nowej
// kampanii) — serwer wymaga roli zarządu; skarbnik widzi tylko pierwszą opcję.
export function allowedResolutions(isBoard) {
  return isBoard ? ['confirmed_delivered', 'confirmed_not_sent'] : ['confirmed_delivered'];
}

export function parseEvidenceCode(value) {
  const code = String(value ?? '').trim();
  if (!EVIDENCE_CODE_PATTERN.test(code)) {
    throw new Error('Kod dowodu: małe litery, cyfry i podkreślenia (do 60 znaków), np. brevo_log_delivered. Bez adresów i treści rozmów.');
  }
  return code;
}

export function describeResolutionError(status, code) {
  if (code === 'not_resolvable') return 'Tego wiersza nie można rozstrzygnąć: wiadomość nie jest w stanie końcowym.';
  if (code === 'outbox_not_found') return 'Nie znaleziono wiersza kolejki w tej kampanii.';
  if (status === 403) return 'Brak uprawnień. „Wiadomość nie wyszła” może potwierdzić wyłącznie zarząd z aktywnym MFA.';
  return null;
}
