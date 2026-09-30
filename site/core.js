// Pure logic of the public site. No DOM, no network, no storage: everything
// here is testable in Node. Values from the API are treated as untrusted text;
// callers render them with textContent only.

import { COUNCIL_FULL_NAME } from "../shared/school.js";
import { formatSchoolYear, heuristicSchoolYearId } from "../shared/school-year.js";

export const RADA_NAME = COUNCIL_FULL_NAME;
export const TIMEZONE = "Europe/Brussels";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_TEXT = 20_000;

export const MEETING_KIND_LABELS = Object.freeze({
  plenary: "Zebranie ogólne",
  board: "Zebranie zarządu",
  class: "Zebranie klasowe",
});

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const dayFormatter = new Intl.DateTimeFormat("pl-PL", {
  timeZone: TIMEZONE,
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});
const dateFormatter = new Intl.DateTimeFormat("pl-PL", {
  timeZone: TIMEZONE,
  day: "numeric",
  month: "long",
  year: "numeric",
});
const timeFormatter = new Intl.DateTimeFormat("pl-PL", {
  timeZone: TIMEZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const monthFormatter = new Intl.DateTimeFormat("pl-PL", {
  timeZone: TIMEZONE,
  month: "long",
  year: "numeric",
});

// Untrusted value -> plain string (or null). Control characters other than
// newline and tab are removed; length is capped. The result is still meant
// for textContent, never for HTML.
export function cleanText(value, max = MAX_TEXT) {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toDate(value) {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Calendar date "RRRR-MM-DD" of an instant in Europe/Brussels.
export function brusselsDate(date) {
  const parts = Object.fromEntries(partsFormatter.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function monthKey(date) {
  return brusselsDate(date).slice(0, 7);
}

export function formatMonth(date) {
  const text = monthFormatter.format(date);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function formatDate(date) {
  return dateFormatter.format(date);
}

export function formatDay(date) {
  return dayFormatter.format(date);
}

export function formatTime(date) {
  return timeFormatter.format(date);
}

// "sobota, 3 października 2026, 10:00–12:00" or across days
// "sobota, 3 października 2026, 10:00 – niedziela, 4 października 2026, 18:00".
export function formatEventTime(event) {
  const { startsAt, endsAt } = event;
  const start = `${formatDay(startsAt)}, ${formatTime(startsAt)}`;
  if (!endsAt) return start;
  if (brusselsDate(startsAt) === brusselsDate(endsAt)) return `${start}–${formatTime(endsAt)}`;
  return `${start} – ${formatDay(endsAt)}, ${formatTime(endsAt)}`;
}

// API row -> safe view model. Returns null for rows that cannot be shown.
export function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" && ID_PATTERN.test(raw.id) ? raw.id : null;
  const title = cleanText(raw.title, 300);
  const startsAt = toDate(raw.startsAtUtc) ?? toDate(raw.startsAt);
  if (!id || !title || !startsAt) return null;
  let endsAt = toDate(raw.endsAtUtc) ?? toDate(raw.endsAt);
  if (endsAt && endsAt < startsAt) endsAt = null;
  return {
    id,
    title,
    description: cleanText(raw.description),
    location: cleanText(raw.location, 300),
    organizer: cleanText(raw.organizer, 300),
    startsAt,
    endsAt,
    cancelled: raw.status === "cancelled",
    volunteerTasks: raw.status === "cancelled" ? [] : volunteerTasks(raw.volunteerTasks),
  };
}

// #142: zadania wolontariuszy oznaczone jako publiczne — wyłącznie tytuł
// i liczba brakujących osób (API nie zwraca żadnych danych osób).
export function volunteerTasks(rawTasks) {
  if (!Array.isArray(rawTasks)) return [];
  return rawTasks.slice(0, 50).map((task) => {
    if (!task || typeof task !== "object") return null;
    const title = cleanText(task.title, 200);
    const stillNeeded = Number.isSafeInteger(task.stillNeeded) && task.stillNeeded >= 0 ? task.stillNeeded : null;
    if (!title || stillNeeded === null) return null;
    return { title, stillNeeded };
  }).filter(Boolean);
}

export function volunteerTaskLabel(task) {
  return task.stillNeeded > 0 ? `potrzebni jeszcze: ${task.stillNeeded}` : "komplet chętnych";
}

// An event with an end is past once it ended; without an end it stays
// visible until the end of its day in Brussels.
export function isPast(event, now = new Date()) {
  if (event.endsAt) return event.endsAt.getTime() < now.getTime();
  return brusselsDate(event.startsAt) < brusselsDate(now);
}

export function upcomingEvents(rawEvents, now = new Date()) {
  if (!Array.isArray(rawEvents)) return [];
  const seen = new Set();
  return rawEvents
    .map(normalizeEvent)
    .filter((event) => event && !seen.has(event.id) && seen.add(event.id) && !isPast(event, now))
    .sort((a, b) => a.startsAt - b.startsAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Sorted events -> [{ key: "2026-10", label: "Październik 2026", events: [...] }].
export function groupByMonth(events) {
  const groups = [];
  for (const event of events) {
    const key = monthKey(event.startsAt);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, label: formatMonth(event.startsAt), events: [] };
      groups.push(group);
    }
    group.events.push(event);
  }
  return groups;
}

export function normalizeMinutes(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.visibility !== undefined && raw.visibility !== "public") return null;
  const id = typeof raw.minutesId === "string" && ID_PATTERN.test(raw.minutesId) ? raw.minutesId : null;
  const title = cleanText(raw.title, 300);
  const body = cleanText(raw.body);
  if (!id || !title || !body) return null;
  return {
    id,
    title,
    kind: MEETING_KIND_LABELS[raw.kind] ?? "Zebranie",
    meetingDate: toDate(raw.scheduledAt),
    approvedAt: toDate(raw.approvedAt),
    version: Number.isSafeInteger(raw.version) && raw.version > 0 ? raw.version : null,
    body,
  };
}

export function publicMinutes(rawList) {
  if (!Array.isArray(rawList)) return [];
  return rawList
    .map(normalizeMinutes)
    .filter(Boolean)
    .sort((a, b) => (b.meetingDate?.getTime() ?? 0) - (a.meetingDate?.getTime() ?? 0));
}

// Kanoniczny kontrakt GET /api/public/news (src/pg/news.js listPublic):
// { posts: [{ id, title, body, publishedAt, photos }] }. Historyczne warianty
// { news: [...] } i { items: [...] } (title + body/summary) zostają dla zgodności.
export function normalizeNews(raw) {
  if (!raw || typeof raw !== "object") return null;
  const title = cleanText(raw.title, 300);
  const body = cleanText(raw.body) ?? cleanText(raw.summary);
  if (!title || !body) return null;
  const id = typeof raw.id === "string" && ID_PATTERN.test(raw.id) ? raw.id : null;
  return { id, title, body, publishedAt: toDate(raw.publishedAt), photos: normalizePhotos(raw.photos) };
}

// #96: adresy zdjęć budujemy WYŁĄCZNIE z identyfikatora, na stałych trasach
// publicznego API (`/api/public/news-photos/{id}/{web|thumb}`); adresu
// z odpowiedzi nie przyjmujemy. Serwer i tak wydaje plik tylko dla zdjęcia
// zweryfikowanego, z ważną zgodą i z opublikowanej wersji wpisu — tu tylko
// nie pokazujemy niczego, czego API nie zwróciło. Zdjęcie bez opisu i bez
// znacznika `decorative` pomijamy (WCAG 1.1.1); dekoracyjne dostaje `alt=""`.
const MAX_PHOTOS_PER_POST = 20;

export function newsPhotoUrl(id, variant) {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new Error("invalid_photo_id");
  if (variant !== "web" && variant !== "thumb") throw new Error("invalid_photo_variant");
  return `/api/public/news-photos/${encodeURIComponent(id)}/${variant}`;
}

export function normalizePhoto(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || !ID_PATTERN.test(raw.id)) return null;
  const decorative = raw.decorative === true;
  const alt = decorative ? "" : cleanText(raw.altText, 500);
  if (alt === null || alt === undefined) return null;
  const caption = [cleanText(raw.author, 200), cleanText(raw.source, 200), cleanText(raw.license, 300)]
    .filter(Boolean);
  return {
    id: raw.id,
    alt,
    decorative,
    caption: caption.join(" · "),
    thumbUrl: newsPhotoUrl(raw.id, "thumb"),
    webUrl: newsPhotoUrl(raw.id, "web"),
  };
}

export function normalizePhotos(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_PHOTOS_PER_POST).map(normalizePhoto).filter(Boolean);
}

export function newsItems(payload) {
  const list = [payload?.posts, payload?.news, payload?.items].find(Array.isArray) ?? [];
  return list
    .map(normalizeNews)
    .filter(Boolean)
    .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
}

// ASSUMPTION: school year identifiers look like "2026-2027" and a year starts
// on 1 September (Brussels). `?rok=` overrides it. Replace with a public list
// of school years once the API provides one. Logika w shared/school-year.js —
// panele autoryzowane korzystają z niej też jako wartości awaryjnej (bez kopii).
export function defaultSchoolYearId(now = new Date()) {
  return heuristicSchoolYearId(now);
}

export function schoolYearFromSearch(search, now = new Date()) {
  const value = new URLSearchParams(search).get("rok");
  return value && ID_PATTERN.test(value) ? value : defaultSchoolYearId(now);
}

// Wspólna funkcja formatująca (shared/school-year.js) — bez własnej kopii.
export { formatSchoolYear };

// Pojedynczy plik .ics wydarzenia (publiczny, tylko opublikowana wersja).
export function eventIcsUrl(id) {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
  return `/api/public/events/${encodeURIComponent(id)}.ics`;
}

// Kanał subskrypcji: https (pobranie) i webcal (subskrypcja w aplikacji kalendarza).
// Host pochodzi z bieżącego adresu strony; brak poprawnego hosta = brak linków.
export function calendarFeedUrls(host) {
  if (typeof host !== "string" || !/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) return null;
  const path = "/api/public/events.ics";
  return { https: `https://${host}${path}`, webcal: `webcal://${host}${path}` };
}

export function eventsUrl(now = new Date()) {
  return `/api/public/events?${new URLSearchParams({ from: brusselsDate(now), limit: "200" })}`;
}

export function minutesUrl(schoolYearId) {
  if (!ID_PATTERN.test(schoolYearId)) throw new Error("invalid_school_year");
  return `/api/meetings/public-minutes?${new URLSearchParams({ schoolYearId })}`;
}

// #113: zatwierdzone zawiadomienia o zebraniach ogólnych (bez powodu odwołania i opisów punktów).
export function noticesUrl(schoolYearId) {
  if (!ID_PATTERN.test(schoolYearId)) throw new Error("invalid_school_year");
  return `/api/meetings/public-notices?${new URLSearchParams({ schoolYearId })}`;
}

export function normalizeNotice(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" && ID_PATTERN.test(raw.id) ? raw.id : null;
  const title = cleanText(raw.title, 300);
  const scheduledAt = toDate(raw.scheduledAt);
  if (!id || !title || !scheduledAt) return null;
  const agenda = Array.isArray(raw.agenda)
    ? raw.agenda.map((item) => cleanText(item?.title, 300)).filter(Boolean) : [];
  return {
    id,
    title,
    cancelled: raw.cancelled === true,
    scheduledAt,
    previousScheduledAt: toDate(raw.previousScheduledAt),
    location: cleanText(raw.location, 200),
    agenda,
  };
}

export function publicNotices(rawList) {
  if (!Array.isArray(rawList)) return [];
  return rawList
    .map(normalizeNotice)
    .filter(Boolean)
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
}

export const NEWS_URL = "/api/public/news";

// ---------- #116: stały adres wpisu i archiwum aktualności ----------
//
// Stały adres to fragment `#wpis-<id>` strony /site/ (bez nowej trasy HTML):
// działa po wklejeniu do wiadomości, a identyfikator jest tym samym `id`, które
// zwraca publiczne API. W adresie nie ma identyfikatorów użytkowników, klas,
// dokumentów ani zgód. Treść wpisu pobiera GET /api/public/news/{id}, który
// czyta wyłącznie widok public_news; wycofany, nieopublikowany i nieistniejący
// wpis dają tę samą odpowiedź 404 i ten sam komunikat (bez treści).

export const NEWS_UNAVAILABLE_MESSAGE =
  "Ten wpis nie jest dostępny. Mógł zostać wycofany albo adres jest nieprawidłowy.";

const POST_HASH_PATTERN = /^#wpis-([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/;

export function newsAnchorId(id) {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new Error("invalid_post_id");
  return `wpis-${id}`;
}

// Względny adres stałego linku (do atrybutu href): "#wpis-<id>".
export function newsPermalink(id) {
  return `#${newsAnchorId(id)}`;
}

// location.hash -> identyfikator wpisu albo null (inny fragment, np. #wydarzenia).
export function newsIdFromHash(hash) {
  const match = typeof hash === "string" ? POST_HASH_PATTERN.exec(hash) : null;
  return match ? match[1] : null;
}

export function newsPostUrl(id) {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new Error("invalid_post_id");
  return `/api/public/news/${encodeURIComponent(id)}`;
}

// Odpowiedź GET /api/public/news/{id}: { post } -> model widoku albo null.
export function newsPostFromPayload(payload) {
  return normalizeNews(payload?.post);
}

// Archiwum: rok wskazany jawnie w `?rok=`; bez niego strona pokazuje
// najnowsze wpisy ze wszystkich lat (limit po stronie API).
export function newsYearFromSearch(search) {
  const value = new URLSearchParams(search).get("rok");
  return value && ID_PATTERN.test(value) ? value : null;
}

export function newsListUrl(schoolYearId = null) {
  if (schoolYearId === null) return NEWS_URL;
  if (!ID_PATTERN.test(schoolYearId)) throw new Error("invalid_school_year");
  return `${NEWS_URL}?${new URLSearchParams({ schoolYearId, limit: "50" })}`;
}

// ZAŁOŻENIE (do czasu publicznej listy lat szkolnych, #78): archiwum
// proponuje bieżący rok szkolny i kilka poprzednich (RRRR-RRRR, rok od
// 1 września). Rok bez wpisów pokazuje zwykły pusty stan.
export function archiveYears(now = new Date(), count = 6) {
  const current = defaultSchoolYearId(now);
  const match = /^(\d{4})-(\d{4})$/.exec(current);
  if (!match) return [current];
  const start = Number(match[1]);
  return Array.from({ length: count }, (_, i) => `${start - i}-${start - i + 1}`);
}
