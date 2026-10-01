// Logika czysta ekranu „Dzienny limit Brevo” (#84, część interfejsu). Bez sieci i bez DOM:
// tests/email-quota-panel-core.test.js. Serwer (src/pg/routes/email.js: quotaShow,
// recordOtherSend) i tak egzekwuje role, MFA, zakres liczby i doby — te funkcje tylko
// podpowiadają w interfejsie. Dziennik jest tylko do dopisywania: pomyłkę poprawia
// nowy wpis ujemny, nic nie jest edytowane ani usuwane.

// Jak QUOTA_REASON_CODES w src/pg/routes/email.js (pilnuje test).
export const QUOTA_REASON_LABELS = Object.freeze({
  manual_brevo_panel: 'Wysłano ręcznie z panelu Brevo',
  invitation: 'Zaproszenia do konta',
  audit_committee: 'Wiadomość Komisji Rewizyjnej',
  other: 'Inny powód',
});
export const CORRECTION_REASON = 'correction';
export const QUOTA_REASON_CODES = Object.freeze([...Object.keys(QUOTA_REASON_LABELS), CORRECTION_REASON]);
export const QUOTA_MAX_COUNT = 10_000;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function quotaUrl(schoolYearId) {
  return `/api/email/quota?schoolYearId=${encodeURIComponent(String(schoolYearId ?? '').trim())}`;
}

export const OTHER_SENDS_URL = '/api/email/quota/other-sends';

// Lista wpisów ręcznych i korekt (GET, #84): najnowsze pierwsze, bez adresów i treści.
export function otherSendsListUrl(schoolYearId) {
  return `${OTHER_SENDS_URL}?schoolYearId=${encodeURIComponent(String(schoolYearId ?? '').trim())}`;
}

function validDay(value) {
  return typeof value === 'string' && DAY_PATTERN.test(value)
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Pozostało w dobie = limit − rezerwa − zużycie doby (dla „dziś” dochodzą jeszcze
// wiadomości w locie, więc to wartość orientacyjna; wiążąca jest `remaining` z serwera).
export function dayRemaining(quota, usage) {
  return Math.max(0, number(quota?.dailyLimit) - number(quota?.dailyReserved) - number(usage?.total));
}

// Wiersze tabeli: doba UTC i doba w strefie konta, dziś i jutro. Brak danych -> pusta lista.
export function quotaRows(quota) {
  const windows = quota?.windows;
  if (!windows) return [];
  const rows = [];
  const add = (label, usage) => {
    if (!usage) return;
    rows.push({
      label, day: usage.day, campaign: number(usage.campaign), other: number(usage.other),
      total: number(usage.total), remaining: dayRemaining(quota, usage),
    });
  };
  const zone = windows.account?.timezone ? ` (${windows.account.timezone})` : '';
  add('Doba UTC — dziś', windows.utc?.today);
  add('Doba UTC — jutro', windows.utc?.tomorrow);
  add(`Doba konta${zone} — dziś`, windows.account?.today);
  add(`Doba konta${zone} — jutro`, windows.account?.tomorrow);
  return rows;
}

export function describeQuotaSummary(quota) {
  if (!quota) return '';
  const q = quota.queuedCampaigns ?? { campaigns: 0, queuedMessages: 0 };
  return [
    `Limit dzienny ${number(quota.dailyLimit)}, rezerwa ${number(quota.dailyReserved)}.`,
    `Pula dla najbliższego przebiegu: ${number(quota.remaining)} (w locie: ${number(quota.inFlight)}).`,
    `Kampanie w kolejce: ${number(q.campaigns)}, wiadomości oczekujące: ${number(q.queuedMessages)}.`,
  ].join(' ');
}

// Formularz wpisu albo korekty -> ciało POST. Wyjątek z komunikatem dla formularza.
// Wpis: dodatnia liczba i powód z listy; korekta: dodatnia liczba do odjęcia (wysyłamy
// ujemną), identyfikator korygowanego wpisu i ta sama doba co wpis.
export function buildOtherSendBody({ schoolYearId, kind, day, count, reasonCode, correctsId }) {
  if (!ID_PATTERN.test(String(schoolYearId ?? '').trim())) throw new Error('Wybierz rok szkolny.');
  if (!validDay(day)) throw new Error('Podaj dobę w formacie RRRR-MM-DD.');
  const n = Number(count);
  if (count === '' || !Number.isInteger(n) || n < 1 || n > QUOTA_MAX_COUNT) {
    throw new Error(`Liczba wiadomości: liczba całkowita od 1 do ${QUOTA_MAX_COUNT}.`);
  }
  if (kind === 'correction') {
    const target = String(correctsId ?? '').trim();
    if (!ID_PATTERN.test(target)) throw new Error('Podaj identyfikator korygowanego wpisu.');
    return { schoolYearId: String(schoolYearId).trim(), day, count: -n, reasonCode: CORRECTION_REASON, correctsId: target };
  }
  if (kind !== 'record') throw new Error('Wybierz wpis albo korektę.');
  if (!Object.hasOwn(QUOTA_REASON_LABELS, reasonCode)) throw new Error('Wybierz powód wpisu.');
  return { schoolYearId: String(schoolYearId).trim(), day, count: n, reasonCode };
}

// Skutki do okna potwierdzenia (confirmAction.effects).
export function describeOtherSendEffects(body) {
  if (body.reasonCode === CORRECTION_REASON) {
    return [
      `Korekta wpisu ${body.correctsId}: odjęcie ${Math.abs(body.count)} z doby ${body.day}.`,
      'Powstaje nowy wpis ujemny; wcześniejszy wpis zostaje w historii.',
      'Pula dnia wzrośnie o tę liczbę. Zapis trafia do dziennika zdarzeń. Nic nie jest wysyłane.',
    ];
  }
  return [
    `Wpis: ${body.count} wiadomości spoza kolejki w dobie ${body.day} (${QUOTA_REASON_LABELS[body.reasonCode]}).`,
    'Pula dnia dla kampanii zmaleje o tę liczbę. Zapis trafia do dziennika zdarzeń i nie da się go edytować — pomyłkę poprawia korekta.',
    'Nic nie jest wysyłane.',
  ];
}

export function describeEntry(entry) {
  if (!entry) return '';
  const kind = entry.count < 0 ? `korekta ${entry.count}` : `wpis +${entry.count}`;
  return `${kind}, doba ${entry.day}, identyfikator ${entry.id}`;
}

export function describeQuotaError(status, code) {
  const byCode = {
    invalid_idempotency_key: 'Niepoprawny klucz operacji. Odśwież stronę i spróbuj ponownie.',
    invalid_quota_reason: 'Niepoprawny powód wpisu.',
    invalid_quota_count: 'Niepoprawna liczba: wpis musi być dodatni, a korekta ujemna (do 10 000).',
    invalid_quota_day: 'Niepoprawna doba: nowy wpis dotyczy tylko bieżącej doby (UTC lub konta), korekta — doby korygowanego wpisu.',
    quota_correction_target_not_found: 'Nie znaleziono wpisu do korekty (musi to być wcześniejszy wpis „spoza kolejki”).',
    quota_correction_exceeds: 'Korekty przekraczają wartość korygowanego wpisu.',
    idempotency_conflict: 'Ten klucz operacji był już użyty z innymi danymi. Zamknij formularz i sprawdź stan limitu.',
  };
  if (byCode[code]) return byCode[code];
  if (status === 401) return 'Sesja wygasła. Zaloguj się ponownie.';
  if (code === 'mfa_required') return 'Potwierdź logowanie drugim składnikiem (MFA).';
  if (status === 403) return 'Brak uprawnień: stan limitu i ewidencję prowadzi zarząd lub skarbnik (z MFA, przydział bez klasy) w tym roku szkolnym.';
  return null;
}
