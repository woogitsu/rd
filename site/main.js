// Public, read-only site. No login, no cookies (credentials: "omit"), no
// storage. API data is rendered exclusively through textContent.
import {
  NEWS_URL,
  calendarFeedUrls,
  eventIcsUrl,
  eventsUrl,
  formatDate,
  formatDay,
  formatEventTime,
  formatTime,
  RADA_NAME,
  formatSchoolYear,
  groupByMonth,
  minutesUrl,
  newsItems,
  noticesUrl,
  publicMinutes,
  publicNotices,
  schoolYearFromSearch,
  upcomingEvents,
  volunteerTaskLabel,
} from "./core.js";
import { applySchoolName } from "../shared/school.js";

applySchoolName();
document.title = RADA_NAME;

const byId = (id) => document.getElementById(id);

class HttpError extends Error {
  constructor(status) {
    super(`http_${status}`);
    this.status = status;
  }
}

async function getJson(url) {
  const response = await fetch(url, {
    credentials: "omit",
    headers: { Accept: "application/json" },
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) throw new HttpError(response.status);
  return response.json();
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

// #124: rozróżnienie stanu pustego/informacyjnego (role="status", grzeczne)
// od błędu wczytywania (role="alert", ogłaszane od razu) — dotąd oba stany
// dzieliły ten sam element z rolą "status", więc błąd nie był ogłaszany asertywnie.
function setStatus(id, text, isError = false) {
  const node = byId(id);
  node.textContent = text;
  node.hidden = !text;
  node.setAttribute("role", isError ? "alert" : "status");
}

function done(sectionId) {
  byId(sectionId).removeAttribute("aria-busy");
}

function detailRow(list, label, value) {
  if (!value) return;
  list.append(el("dt", label), el("dd", value));
}

function renderEvents(events) {
  const container = byId("events-list");
  container.replaceChildren();
  if (!events.length) {
    setStatus("events-status", "Brak opublikowanych wydarzeń.");
    return;
  }
  setStatus("events-status", "");
  for (const group of groupByMonth(events)) {
    const block = el("section", null, "month");
    const headingId = `miesiac-${group.key}`;
    block.setAttribute("aria-labelledby", headingId);
    const heading = el("h3", group.label, "month-title");
    heading.id = headingId;
    const list = el("ol", null, "event-list");
    for (const event of group.events) {
      const item = el("li", null, event.cancelled ? "event cancelled" : "event");
      const title = el("h4", null, "event-title");
      if (event.cancelled) title.append(el("span", "odwołane", "badge"), " ");
      title.append(el("span", event.title));
      const time = el("p", null, "event-time");
      const timeNode = el("time", formatEventTime(event));
      timeNode.dateTime = event.startsAt.toISOString();
      time.append(timeNode);
      item.append(time, title);
      const details = el("dl", null, "event-details");
      detailRow(details, "Miejsce", event.location);
      detailRow(details, "Organizator", event.organizer);
      if (details.childElementCount) item.append(details);
      if (event.description) item.append(el("p", event.description, "event-description"));
      if (event.volunteerTasks.length) {
        const help = el("div", null, "event-help");
        help.append(el("p", "Potrzebna pomoc przy wydarzeniu:", "event-help-title"));
        const tasks = el("ul", null, "event-help-list");
        for (const task of event.volunteerTasks) tasks.append(el("li", `${task.title} — ${volunteerTaskLabel(task)}`));
        help.append(tasks);
        item.append(help);
      }
      const icsUrl = event.cancelled ? null : eventIcsUrl(event.id);
      if (icsUrl) {
        const link = el("a", "Dodaj do kalendarza (.ics)");
        link.href = icsUrl;
        link.setAttribute("download", "");
        const p = el("p", null, "event-calendar");
        p.append(link);
        item.append(p);
      }
      list.append(item);
    }
    block.append(heading, list);
    container.append(block);
  }
}

function renderMinutes(minutes) {
  const container = byId("minutes-list");
  container.replaceChildren();
  if (!minutes.length) {
    setStatus("minutes-status", "Brak opublikowanych protokołów.");
    return;
  }
  setStatus("minutes-status", "");
  const list = el("ol", null, "minutes-list");
  for (const item of minutes) {
    const entry = el("li", null, "minutes");
    entry.append(el("h3", item.title, "minutes-title"));
    const meta = el("dl", null, "minutes-meta");
    detailRow(meta, "Rodzaj", item.kind);
    detailRow(meta, "Data zebrania", item.meetingDate ? formatDate(item.meetingDate) : null);
    detailRow(meta, "Zatwierdzono", item.approvedAt ? formatDate(item.approvedAt) : null);
    detailRow(meta, "Wersja", item.version ? String(item.version) : null);
    entry.append(meta);
    const details = el("details", null, "minutes-body");
    details.append(el("summary", "Treść protokołu"), el("div", item.body, "minutes-text"));
    entry.append(details);
    list.append(entry);
  }
  container.append(list);
}

function renderNotices(notices) {
  const container = byId("notices-list");
  container.replaceChildren();
  if (!notices.length) {
    setStatus("notices-status", "Brak opublikowanych zawiadomień o zebraniach.");
    return;
  }
  setStatus("notices-status", "");
  const list = el("ol", null, "event-list");
  for (const notice of notices) {
    const item = el("li", null, notice.cancelled ? "event cancelled" : "event");
    const title = el("h3", null, "event-title");
    if (notice.cancelled) title.append(el("span", "odwołane", "badge"), " ");
    title.append(el("span", notice.title));
    const time = el("p", null, "event-time");
    const timeNode = el("time", `${formatDay(notice.scheduledAt)}, ${formatTime(notice.scheduledAt)}`);
    timeNode.dateTime = notice.scheduledAt.toISOString();
    time.append(timeNode);
    item.append(time, title);
    const details = el("dl", null, "event-details");
    if (!notice.cancelled && notice.previousScheduledAt) {
      detailRow(details, "Poprzedni termin", `${formatDay(notice.previousScheduledAt)}, ${formatTime(notice.previousScheduledAt)}`);
    }
    if (!notice.cancelled) detailRow(details, "Miejsce", notice.location);
    if (details.childElementCount) item.append(details);
    if (!notice.cancelled && notice.agenda.length) {
      item.append(el("p", "Porządek obrad:", "event-description"));
      const agenda = el("ol", null, "agenda-list");
      for (const point of notice.agenda) agenda.append(el("li", point));
      item.append(agenda);
    }
    list.append(item);
  }
  container.append(list);
}

// #96: zdjęcia wyłącznie z publicznego API (adresy z newsPhotoUrl). Gdy plik
// nie istnieje albo zgoda została właśnie cofnięta (404), figura znika bez
// komunikatu o błędzie.
function renderPhotos(photos) {
  if (!photos?.length) return null;
  const gallery = el("div", null, "news-photos");
  for (const photo of photos) {
    const figure = el("figure", null, "news-photo");
    const img = document.createElement("img");
    img.src = photo.thumbUrl;
    img.srcset = `${photo.thumbUrl} 400w, ${photo.webUrl} 1600w`;
    img.sizes = "(max-width: 640px) 100vw, 640px";
    img.alt = photo.alt;
    img.loading = "lazy";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => figure.remove());
    figure.append(img);
    if (photo.caption) figure.append(el("figcaption", photo.caption, "news-photo-caption"));
    gallery.append(figure);
  }
  return gallery;
}

function renderNews(items) {
  const container = byId("news-list");
  container.replaceChildren();
  if (!items.length) {
    setStatus("news-status", "Brak opublikowanych aktualności.");
    return;
  }
  setStatus("news-status", "");
  const list = el("ol", null, "news-list");
  for (const item of items) {
    const entry = el("li", null, "news");
    if (item.publishedAt) {
      const date = el("time", formatDate(item.publishedAt), "news-date");
      date.dateTime = item.publishedAt.toISOString();
      entry.append(date);
    }
    entry.append(el("h3", item.title, "news-title"), el("p", item.body, "news-body"));
    const gallery = renderPhotos(item.photos);
    if (gallery) entry.append(gallery);
    list.append(entry);
  }
  container.append(list);
}

function showCalendarFeed() {
  const urls = calendarFeedUrls(window.location.host);
  if (!urls) return;
  byId("calendar-webcal").href = urls.webcal;
  byId("calendar-download").href = urls.https;
  byId("calendar-feed").hidden = false;
}

async function loadEvents() {
  try {
    const data = await getJson(eventsUrl());
    renderEvents(upcomingEvents(data?.events));
  } catch {
    setStatus("events-status", "Nie udało się wczytać wydarzeń. Spróbuj ponownie później.", true);
  } finally {
    done("wydarzenia");
  }
}

async function loadMinutes() {
  const schoolYearId = schoolYearFromSearch(window.location.search);
  byId("minutes-year").textContent = `Rok szkolny ${formatSchoolYear(schoolYearId)}. Protokoły zatwierdzone i udostępnione publicznie.`;
  try {
    const data = await getJson(minutesUrl(schoolYearId));
    renderMinutes(publicMinutes(data?.minutes));
  } catch (error) {
    // An unknown school year yields 400/404: nothing published for it.
    if (error instanceof HttpError && (error.status === 400 || error.status === 404)) renderMinutes([]);
    else setStatus("minutes-status", "Nie udało się wczytać protokołów. Spróbuj ponownie później.", true);
  } finally {
    done("protokoly");
  }
}

async function loadNotices() {
  const schoolYearId = schoolYearFromSearch(window.location.search);
  try {
    const data = await getJson(noticesUrl(schoolYearId));
    renderNotices(publicNotices(data?.notices));
  } catch (error) {
    // Starsze wdrożenie bez trasy albo nieznany rok: nic nie opublikowano.
    if (error instanceof HttpError && [400, 404, 405].includes(error.status)) renderNotices([]);
    else setStatus("notices-status", "Nie udało się wczytać zawiadomień. Spróbuj ponownie później.", true);
  } finally {
    done("zawiadomienia");
  }
}

// #124: pozycja "Aktualności" jest teraz zawsze widoczna w nawigacji i na
// stronie (WCAG 3.2.3 — nawigacja nie zmienia się po załadowaniu). Brak
// trasy API (404/405 — starsze wdrożenie bez tego modułu) i brak
// opublikowanych wpisów wyglądają dla odwiedzającego tak samo: pusty stan,
// nie zniknięcie sekcji.
async function loadNews() {
  const schoolYearId = newsYearFromSearch(window.location.search);
  try {
    const data = await getJson(newsListUrl(schoolYearId));
    const items = newsItems(data);
    renderNews(items);
    decorateNews(items);
  } catch (error) {
    if (error instanceof HttpError && (error.status === 404 || error.status === 405)) renderNews([]);
    else setStatus("news-status", "Nie udało się wczytać aktualności. Spróbuj ponownie później.", true);
  } finally {
    done("aktualnosci");
  }
  renderNewsArchive(schoolYearId);
  await showLinkedPost();
}

// #116: stały adres wpisu (#wpis-<id>) i archiwum według roku szkolnego.
// Nowe funkcje czyste są w core.js; tu tylko DOM (wyłącznie textContent).
import {
  NEWS_UNAVAILABLE_MESSAGE,
  archiveYears,
  newsIdFromHash,
  newsAnchorId,
  newsListUrl,
  newsPermalink,
  newsPostFromPayload,
  newsPostUrl,
  newsYearFromSearch,
} from "./core.js";

// Wpisy z listy dostają kotwicę i stały link; kolejność i filtr jak w renderNews.
function decorateNews(items) {
  const entries = byId("news-list").querySelectorAll("li.news");
  items.forEach((item, index) => {
    const entry = entries[index];
    if (!entry || !item.id) return;
    entry.id = newsAnchorId(item.id);
    const link = el("a", "Stały link do wpisu", "news-permalink");
    link.href = newsPermalink(item.id);
    const p = el("p", null, "news-permalink-row");
    p.append(link);
    entry.append(p);
  });
}

function renderNewsArchive(currentYear) {
  const nav = byId("news-archive");
  if (!nav) return;
  nav.replaceChildren();
  const list = el("ul", null, "news-archive-list");
  const all = el("li");
  const allLink = el("a", "Najnowsze");
  allLink.href = "?#aktualnosci";
  if (!currentYear) allLink.setAttribute("aria-current", "page");
  all.append(allLink);
  list.append(all);
  for (const id of archiveYears()) {
    const item = el("li");
    const link = el("a", `Rok szkolny ${formatSchoolYear(id)}`);
    link.href = `?${new URLSearchParams({ rok: id })}#aktualnosci`;
    if (id === currentYear) link.setAttribute("aria-current", "page");
    item.append(link);
    list.append(item);
  }
  nav.append(list);
  nav.hidden = false;
}

// Wybrany wpis pobieramy z GET /api/public/news/{id}. 404 (wycofany,
// nieopublikowany, nieistniejący) i każdy inny błąd odpowiedzi dają ten sam
// komunikat bez treści; nic nie jest pokazywane z pamięci podręcznej listy.
async function showLinkedPost() {
  const box = byId("news-linked");
  if (!box) return;
  box.replaceChildren();
  box.hidden = true;
  const id = newsIdFromHash(window.location.hash);
  if (!id) return;
  box.hidden = false;
  try {
    const post = newsPostFromPayload(await getJson(newsPostUrl(id)));
    if (!post) throw new HttpError(404);
    box.append(el("h3", "Wybrany wpis", "news-linked-title"));
    const entry = el("article", null, "news");
    if (post.publishedAt) {
      const date = el("time", formatDate(post.publishedAt), "news-date");
      date.dateTime = post.publishedAt.toISOString();
      entry.append(date);
    }
    entry.append(el("h4", post.title, "news-title"), el("p", post.body, "news-body"));
    const gallery = renderPhotos(post.photos);
    if (gallery) entry.append(gallery);
    box.append(entry);
    box.scrollIntoView?.();
  } catch (error) {
    const unavailable = error instanceof HttpError && (error.status === 404 || error.status === 400);
    box.append(el("p", unavailable ? NEWS_UNAVAILABLE_MESSAGE : "Nie udało się wczytać wpisu. Spróbuj ponownie później.", "status"));
    box.firstChild.setAttribute("role", unavailable ? "status" : "alert");
  }
}

window.addEventListener("hashchange", () => { showLinkedPost(); });

// Closed <details> hide minutes on paper: open them for printing, then restore.
let openedForPrint = [];
window.addEventListener("beforeprint", () => {
  openedForPrint = [...document.querySelectorAll("details:not([open])")];
  for (const node of openedForPrint) node.open = true;
});
window.addEventListener("afterprint", () => {
  for (const node of openedForPrint) node.open = false;
  openedForPrint = [];
});

loadNews();
showCalendarFeed();
loadEvents();
loadMinutes();
loadNotices();
