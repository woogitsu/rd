// Public, read-only site. No login, no cookies (credentials: "omit"), no
// storage. API data is rendered exclusively through textContent.
import {
  NEWS_URL,
  eventsUrl,
  formatDate,
  formatEventTime,
  formatSchoolYear,
  groupByMonth,
  minutesUrl,
  newsItems,
  publicMinutes,
  schoolYearFromSearch,
  upcomingEvents,
} from "./core.js";

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

// #124: pozycja "Aktualności" jest teraz zawsze widoczna w nawigacji i na
// stronie (WCAG 3.2.3 — nawigacja nie zmienia się po załadowaniu). Brak
// trasy API (404/405 — starsze wdrożenie bez tego modułu) i brak
// opublikowanych wpisów wyglądają dla odwiedzającego tak samo: pusty stan,
// nie zniknięcie sekcji.
async function loadNews() {
  try {
    const data = await getJson(NEWS_URL);
    renderNews(newsItems(data));
  } catch (error) {
    if (error instanceof HttpError && (error.status === 404 || error.status === 405)) renderNews([]);
    else setStatus("news-status", "Nie udało się wczytać aktualności. Spróbuj ponownie później.", true);
  } finally {
    done("aktualnosci");
  }
}

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
loadEvents();
loadMinutes();
