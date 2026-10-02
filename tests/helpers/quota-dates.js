// Daty scenariuszy przełomu doby konta Brevo (#84) liczone względem rzeczywistego
// dnia, żeby test nie starzał się z kalendarzem.
//
// Dlaczego nie sztywne daty: `now` przebiegu workera jest wstrzykiwany, ale
// kolejka powstaje przez API w rzeczywistym czasie — `email_outbox.next_attempt_at`
// dostaje DEFAULT now() z zegara bazy, a `claim()` (src/email/worker.js) przejmuje
// tylko wiersze z `next_attempt_at <= now` przebiegu. Gdy wstrzyknięte `now` jest
// WCZEŚNIEJSZE niż rzeczywista chwila zakolejkowania, A nie przejmuje niczego,
// bariera `gated.reached` nigdy się nie spełnia i test wisi. Wstrzyknięte „teraz”
// musi więc leżeć w przyszłości względem zegara bazy (stąd minimalny zapas dni).
//
// Dlaczego kwiecień–wrzesień: asercje zależą od tego, że 22:00 UTC to północ w
// Brukseli, czyli od czasu letniego (CEST = UTC+2). Czas letni trwa od ostatniej
// niedzieli marca do ostatniej niedzieli października, więc wybieramy dzień między
// 1 kwietnia a 27 września (dzień D i następny D+1 leżą w pełni w CEST, bez
// przełomu czasu). Bierzemy najbliższy taki dzień nie wcześniejszy niż dziś + zapas.
//
// Rok szkolny seedowany dla testu obejmuje i rzeczywiste „dziś”, i dzień D
// (kod kolejki nie sprawdza dat roku, ale scenariusz ma być spójny).

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LEAD_DAYS = 30;

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const utcMidnight = (date) => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

// Rok kalendarzowy, w którym zaczyna się (1.09) rok szkolny obejmujący dzień `ms`.
function schoolYearStartYear(ms) {
  const date = new Date(ms);
  return date.getUTCMonth() >= 8 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
}

/**
 * @param {Date} [today] rzeczywista chwila (w testach jednostkowych: podstawiana)
 * @param {{ minLeadDays?: number }} [options] minimalny zapas dni do dnia D
 * @returns {{ day: string, nextDay: string, schoolYear: { startsOn: string, endsOn: string } }}
 */
export function quotaScenarioDates(today = new Date(), { minLeadDays = DEFAULT_LEAD_DAYS } = {}) {
  const todayMs = utcMidnight(today);
  const earliest = todayMs + minLeadDays * DAY_MS;
  for (let offset = 0; offset <= 366; offset += 1) {
    const ms = earliest + offset * DAY_MS;
    const date = new Date(ms);
    const month = date.getUTCMonth() + 1;
    if (month >= 4 && month <= 9 && date.getUTCDate() <= 27) {
      return {
        day: iso(ms),
        nextDay: iso(ms + DAY_MS),
        schoolYear: {
          startsOn: `${schoolYearStartYear(todayMs)}-09-01`,
          endsOn: `${schoolYearStartYear(ms) + 1}-08-31`,
        },
      };
    }
  }
  throw new Error('quota_scenario_day_not_found');
}
