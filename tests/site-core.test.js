import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  RADA_NAME,
  brusselsDate,
  cleanText,
  defaultSchoolYearId,
  eventsUrl,
  formatEventTime,
  groupByMonth,
  isPast,
  minutesUrl,
  newsItems,
  normalizeEvent,
  publicMinutes,
  schoolYearFromSearch,
  upcomingEvents,
} from "../site/core.js";

const NOW = new Date("2026-09-27T10:00:00Z");

function event(id, startsAtUtc, extra = {}) {
  return { id, title: `Wydarzenie ${id}`, startsAtUtc, endsAtUtc: null, status: "scheduled", ...extra };
}

test("nazwa Rady jest pełna i poprawna", () => {
  assert.equal(RADA_NAME, "Rada Rodziców Szkoły Polskiej im. Joachima Lelewela w Brukseli");
});

test("czas wydarzenia jest formatowany w strefie Europe/Brussels", () => {
  // 08:00 UTC w październiku = 10:00 CEST; w grudniu 09:00 UTC = 10:00 CET.
  const october = normalizeEvent(event("a", "2026-10-03T08:00:00Z", { endsAtUtc: "2026-10-03T10:00:00Z" }));
  assert.equal(formatEventTime(october), "sobota, 3 października 2026, 10:00–12:00");
  const december = normalizeEvent(event("b", "2026-12-05T09:00:00Z"));
  assert.equal(formatEventTime(december), "sobota, 5 grudnia 2026, 10:00");
  const multiDay = normalizeEvent(event("c", "2026-10-03T08:00:00Z", { endsAtUtc: "2026-10-04T16:00:00Z" }));
  assert.equal(formatEventTime(multiDay), "sobota, 3 października 2026, 10:00 – niedziela, 4 października 2026, 18:00");
  // 23:30 UTC 31.10 to już 1 listopada w Brukseli.
  assert.equal(brusselsDate(new Date("2026-10-31T23:30:00Z")), "2026-11-01");
});

test("przeszłe wydarzenia są pomijane, bieżące i przyszłe zostają", () => {
  const list = upcomingEvents([
    event("past", "2026-09-20T08:00:00Z"),
    event("ended-today", "2026-09-27T06:00:00Z", { endsAtUtc: "2026-09-27T08:00:00Z" }),
    event("today-no-end", "2026-09-27T06:00:00Z"),
    event("running", "2026-09-26T08:00:00Z", { endsAtUtc: "2026-09-28T08:00:00Z" }),
    event("future", "2026-10-03T08:00:00Z"),
  ], NOW);
  assert.deepEqual(list.map((e) => e.id), ["running", "today-no-end", "future"]);
  assert.equal(isPast(normalizeEvent(event("x", "2026-09-26T22:30:00Z")), NOW), false); // 27.09 00:30 lokalnie
});

test("wydarzenia są sortowane i grupowane według miesiąca w Brukseli", () => {
  const list = upcomingEvents([
    event("nov", "2026-11-14T09:00:00Z"),
    event("oct-late", "2026-10-31T23:30:00Z"), // 1 listopada lokalnie
    event("oct", "2026-10-03T08:00:00Z"),
    event("oct", "2026-10-03T08:00:00Z"), // duplikat
  ], NOW);
  const groups = groupByMonth(list);
  assert.deepEqual(groups.map((g) => g.key), ["2026-10", "2026-11"]);
  assert.equal(groups[0].label, "Październik 2026");
  assert.equal(groups[1].label, "Listopad 2026");
  assert.deepEqual(groups[1].events.map((e) => e.id), ["oct-late", "nov"]);
  assert.equal(groups[0].events.length, 1);
});

test("odwołane wydarzenie jest oznaczone, a brak danych daje pustą listę", () => {
  const [cancelled] = upcomingEvents([event("c", "2026-10-03T08:00:00Z", { status: "cancelled" })], NOW);
  assert.equal(cancelled.cancelled, true);
  assert.deepEqual(upcomingEvents(undefined, NOW), []);
  assert.deepEqual(upcomingEvents([], NOW), []);
  assert.deepEqual(groupByMonth([]), []);
  assert.deepEqual(publicMinutes(null), []);
  assert.deepEqual(newsItems({}), []);
});

test("niepoprawne wiersze są odrzucane", () => {
  assert.equal(normalizeEvent(null), null);
  assert.equal(normalizeEvent({ id: "a", title: "", startsAtUtc: "2026-10-03T08:00:00Z" }), null);
  assert.equal(normalizeEvent({ id: "a", title: "X", startsAtUtc: "nie-data" }), null);
  assert.equal(normalizeEvent({ id: "../x", title: "X", startsAtUtc: "2026-10-03T08:00:00Z" }), null);
  assert.equal(normalizeEvent({ id: "a", title: 42, startsAtUtc: "2026-10-03T08:00:00Z" }), null);
});

test("ładunek XSS pozostaje zwykłym tekstem i nie zmienia struktury danych", () => {
  const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const [item] = upcomingEvents([event("xss", "2026-10-03T08:00:00Z", {
    title: payload, description: payload, location: payload, organizer: { toString: () => payload },
  })], NOW);
  assert.equal(item.title, payload);
  assert.equal(item.description, payload);
  assert.equal(item.location, payload);
  assert.equal(item.organizer, null); // obiekt zamiast tekstu jest odrzucany
  const [minutes] = publicMinutes([{ minutesId: "m1", title: payload, body: payload, kind: "<b>", visibility: "public" }]);
  assert.equal(minutes.body, payload);
  assert.equal(minutes.kind, "Zebranie");
  assert.equal(cleanText("a\u0000b\u001Fc\nd"), "abc\nd");
});

test("kod strony renderuje dane API wyłącznie przez textContent", async () => {
  const source = await readFile(new URL("../site/main.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  assert.match(source, /credentials: "omit"/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie|indexedDB/);
});

test("protokoły: tylko publiczne, od najnowszego zebrania", () => {
  const list = publicMinutes([
    { minutesId: "old", title: "Zebranie wrześniowe", body: "Treść", kind: "plenary", scheduledAt: "2026-09-10T17:00:00Z", approvedAt: "2026-09-20T10:00:00Z", version: 1, visibility: "public" },
    { minutesId: "new", title: "Zebranie zarządu", body: "Treść", kind: "board", scheduledAt: "2026-09-24T17:00:00Z", version: 2, visibility: "public" },
    { minutesId: "par", title: "Dla rodziców", body: "Treść", kind: "board", scheduledAt: "2026-09-25T17:00:00Z", visibility: "parents" },
    { minutesId: "empty", title: "Bez treści", body: "", visibility: "public" },
  ]);
  assert.deepEqual(list.map((m) => m.id), ["new", "old"]);
  assert.equal(list[0].kind, "Zebranie zarządu");
  assert.equal(list[1].kind, "Zebranie ogólne");
});

test("aktualności: kanoniczne posts, sortowanie od najnowszej, pusta lista (#237)", () => {
  const items = newsItems({ posts: [
    { id: "p1", title: "Starsza", body: "Treść 1", publishedAt: "2026-09-01T10:00:00Z", photos: [] },
    { id: "p2", title: "Nowsza", body: "Treść 2", publishedAt: "2026-09-20T10:00:00Z", photos: [] },
  ] });
  assert.deepEqual(items.map((n) => n.id), ["p2", "p1"]);
  assert.deepEqual(newsItems({ posts: [] }), []);
  assert.deepEqual(newsItems({}), []);
  assert.deepEqual(newsItems(null), []);
});

test("aktualności akceptują news lub items i pomijają wpisy bez treści", () => {
  assert.deepEqual(newsItems({ news: [{ title: "A", body: "B", publishedAt: "2026-09-01T10:00:00Z" }] }).map((n) => n.title), ["A"]);
  assert.deepEqual(newsItems({ items: [{ title: "A", summary: "S" }, { title: "Bez treści" }] }).map((n) => n.body), ["S"]);
});

test("rok szkolny i adresy API", () => {
  assert.equal(defaultSchoolYearId(NOW), "2026-2027");
  assert.equal(defaultSchoolYearId(new Date("2026-08-31T12:00:00Z")), "2025-2026");
  assert.equal(defaultSchoolYearId(new Date("2026-08-31T22:30:00Z")), "2026-2027"); // 1.09 w Brukseli
  assert.equal(schoolYearFromSearch("?rok=2025-2026", NOW), "2025-2026");
  assert.equal(schoolYearFromSearch("?rok=%3Cscript%3E", NOW), "2026-2027");
  assert.equal(eventsUrl(NOW), "/api/public/events?from=2026-09-27&limit=200");
  assert.equal(minutesUrl("2026-2027"), "/api/meetings/public-minutes?schoolYearId=2026-2027");
  assert.throws(() => minutesUrl("../x"));
});
