// Ekran „Do sprawdzenia w logach dostawcy” (#139) — logika bez DOM i sieci.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESOLUTION_LABELS,
  allowedResolutions,
  attentionUrl,
  canResolve,
  describeAttention,
  describeResolution,
  describeResolutionError,
  parseEvidenceCode,
  reportCsvUrl,
  resolutionsUrl,
} from '../email/resolutions-core.js';

test('adresy tras: lista, rozstrzygnięcie i CSV raportu; niepoprawny identyfikator odrzucony', () => {
  assert.equal(attentionUrl('camp-1'), '/api/email/campaigns/camp-1/attention');
  assert.equal(attentionUrl('camp-1', 'a b'), '/api/email/campaigns/camp-1/attention?cursor=a%20b');
  assert.equal(resolutionsUrl('camp-1'), '/api/email/campaigns/camp-1/resolutions');
  assert.equal(reportCsvUrl('camp-1'), '/api/email/campaigns/camp-1/report?format=csv');
  assert.throws(() => reportCsvUrl('../x'));
  assert.throws(() => attentionUrl(''));
});

test('zarząd widzi obie opcje, skarbnik tylko potwierdzenie wysłania', () => {
  assert.deepEqual(allowedResolutions(true), ['confirmed_delivered', 'confirmed_not_sent']);
  assert.deepEqual(allowedResolutions(false), ['confirmed_delivered']);
  for (const code of allowedResolutions(true)) assert.ok(RESOLUTION_LABELS[code]);
});

test('rozstrzyga się tylko nierozstrzygnięte wiersze failed', () => {
  assert.equal(canResolve({ state: 'failed', resolution: null }), true);
  assert.equal(canResolve({ state: 'failed', resolution: 'confirmed_delivered' }), false);
  assert.equal(canResolve({ state: 'sent', resolution: null, softBounceCount: 4 }), false);
});

test('opis powodu i wyniku bez adresu', () => {
  assert.equal(describeAttention({ state: 'failed', lastError: 'delivery_unknown', softBounceCount: 0 }), 'Nie wiadomo, czy wysłano');
  assert.equal(describeAttention({ state: 'failed', lastError: 'provider_rejected_400' }), 'Odrzucone przez dostawcę (kod provider_rejected_400)');
  assert.equal(describeAttention({ state: 'sent', softBounceCount: 3 }), 'Powtarzające się odbicia tymczasowe: 3');
  assert.equal(describeResolution({ resolution: null }), 'Brak');
  assert.equal(describeResolution({ resolution: 'confirmed_not_sent' }), RESOLUTION_LABELS.confirmed_not_sent);
});

test('kod dowodu: krótki kod, bez adresów i spacji', () => {
  assert.equal(parseEvidenceCode(' brevo_log_delivered '), 'brevo_log_delivered');
  for (const bad of ['', 'rodzic@example.invalid', 'Brevo Log', 'x'.repeat(61)]) assert.throws(() => parseEvidenceCode(bad), /Kod dowodu/);
});

test('komunikaty błędów serwera', () => {
  assert.match(describeResolutionError(409, 'not_resolvable'), /stanie końcowym/);
  assert.match(describeResolutionError(403, 'forbidden'), /zarząd/);
  assert.equal(describeResolutionError(500, 'internal_error'), null);
});
