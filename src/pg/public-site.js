// #116: strona publiczna renderowana po stronie serwera (Node + PostgreSQL).
//
//   GET /site/ (i /site/index.html)   szablon z dist/site/index.html z treścią
//                                      aktualności, wydarzeń, zawiadomień, protokołów
//                                      i opublikowanej informacji o przetwarzaniu danych (#145)
//   GET /site/aktualnosci/{id}         stały adres wpisu (tytuł, treść, canonical, Open Graph)
//   GET /site/wydarzenia/{id}          stały adres wydarzenia (schema.org/Event w mikrodanych)
//   GET /site/feed.xml                 kanał Atom: 20 ostatnio opublikowanych wpisów
//   GET /site/sitemap.xml              mapa strony: wyłącznie adresy /site/
//
// Źródła danych: WYŁĄCZNIE te same funkcje i widoki co publiczne API
// (public_news, public_events, public_meeting_notices, protokoły z widocznością
// `public`). Wpis wycofany znika z HTML, kanału i mapy przy następnym żądaniu
// (pamięć podręczna najwyżej PUBLIC_CACHE_SECONDS = 60 s).
//
// Bezpieczeństwo: każdy tekst z bazy przechodzi przez `h` (automatyczne
// escapowanie &<>"'); nie ma innerHTML ani wstawianych stylów/skryptów
// (CSP `script-src 'self'; style-src 'self'` nadaje serwer Node). Normalizacja
// i formatowanie dat — te same funkcje co w przeglądarce (site/core.js).
//
// Podglądy linków i kanał są BEZ zdjęć (założenie do D-18: brak og:image, w
// kanale tylko tekst i link). Strony HTML pokazują zdjęcia tak samo jak wersja
// z JavaScriptem — wyłącznie te, które widok public_news już dopuścił
// (zweryfikowane prawa i zgody, #96).
//
// JavaScript strony (site/main.js) pozostaje ulepszeniem: po wczytaniu
// odświeża te same sekcje z API.

import { COUNCIL_FULL_NAME } from '../../shared/school.js';
import { describeError, log } from '../log.js';
import {
  EVENT_UNAVAILABLE_MESSAGE, FEED_PATH, NEWS_UNAVAILABLE_MESSAGE, SITE_PATH,
  brusselsDate, cleanText, eventIcsUrl, eventPagePath, excerpt, formatDate, formatDay, formatEventTime,
  formatSchoolYear, formatTime, groupByMonth, newsAnchorId, newsArchiveHref, newsCursorFromSearch,
  PRIVACY_NOTICE_UNAVAILABLE_MESSAGE, newsItems, newsPagePath, newsYearFromSearch, normalizeEvent, normalizePrivacyNotice, publicMinutes, publicNotices,
  schoolYearFromSearch, upcomingEvents, volunteerTaskLabel,
} from '../../site/core.js';
import { loadPublicNotice } from './routes/privacy-notice.js';
import { getPublic as getPublicEvent, listPublic as listPublicEvents } from './events.js';
import { listPublicMeetingNotices, listPublicMinutes } from './meetings.js';
import {
  PUBLIC_CACHE_SECONDS, getPublicPost, listPublic as listPublicNews, listPublicSchoolYears,
} from './news.js';

// Ścieżki obsługiwane przez ten moduł (serwer Node kieruje tu tylko GET/HEAD).
export const PUBLIC_SITE_PATH = /^\/site\/(?:index\.html)?$|^\/site\/(?:feed|sitemap)\.xml$|^\/site\/(?:aktualnosci|wydarzenia)\/[^/]+$/;

export const FEED_LIMIT = 20;
export const SITEMAP_LIMIT = 5000;
const CACHE_PUBLIC = `public, max-age=${PUBLIC_CACHE_SECONDS}`;
const DESCRIPTION = 'Aktualności, wydarzenia, zawiadomienia o zebraniach i zatwierdzone protokoły Rady Rodziców.';
const FOOTER_NOTE = 'Strona nie używa plików cookie i nie wymaga logowania.';

// ---------- escapowanie ----------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// Znaki niedozwolone w XML 1.0 (poza \t \n \r) i samotne surogaty — usuwane
// z tekstu, żeby kanał Atom i mapa strony były poprawnym XML.
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function escapeText(value) {
  return String(value).replace(XML_INVALID, '').replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

class Safe {
  constructor(text) { this.text = text; }
  toString() { return this.text; }
}

function render(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof Safe) return value.text;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeText(value);
}

// Szablon z automatycznym escapowaniem: każda wstawiana wartość jest tekstem,
// chyba że pochodzi z innego wywołania `h` (już bezpieczny fragment).
export function h(strings, ...values) {
  let out = strings[0];
  values.forEach((value, index) => { out += render(value) + strings[index + 1]; });
  return new Safe(out);
}

// ---------- adresy ----------

function absolute(origin, path) {
  return `${origin}${path}`;
}

function isoOf(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// ---------- fragmenty wspólne ----------

function stylesheetsFrom(template) {
  if (typeof template !== 'string') return [];
  return [...template.matchAll(/<link rel="stylesheet"[^>]*href="\.\/assets\/([A-Za-z0-9_.-]+\.css)"[^>]*>/g)]
    .map((match) => `/site/assets/${match[1]}`);
}

function metaTags({ title, description, canonical, type }) {
  return h`<link rel="canonical" href="${canonical}" />
    <meta property="og:type" content="${type}" />
    <meta property="og:site_name" content="${COUNCIL_FULL_NAME}" />
    <meta property="og:locale" content="pl_PL" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:url" content="${canonical}" />
    <link rel="alternate" type="application/atom+xml" title="Aktualności" href="${FEED_PATH}" />`;
}

function page({ title, description, canonical, type = 'article', stylesheets, main, noindex = false }) {
  return `<!doctype html>\n${h`<html lang="pl">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="referrer" content="no-referrer" />
    ${noindex ? h`<meta name="robots" content="noindex" />` : ''}
    <title>${title}</title>
    <meta name="description" content="${description}" />
    ${canonical ? metaTags({ title, description, canonical, type }) : ''}
    ${stylesheets.map((href) => h`<link rel="stylesheet" href="${href}" />`)}
  </head>
  <body>
    <a class="skip-link" href="#main">Przejdź do treści</a>
    <header class="site-header">
      <p class="site-name">${COUNCIL_FULL_NAME}</p>
      <nav aria-label="Sekcje strony">
        <ul>
          <li><a href="/site/#aktualnosci">Aktualności</a></li>
          <li><a href="/site/#wydarzenia">Wydarzenia</a></li>
          <li><a href="/site/#zawiadomienia">Zebrania</a></li>
          <li><a href="/site/#protokoly">Protokoły</a></li>
          <li><a href="/site/#informacja-o-danych">Informacja o danych</a></li>
        </ul>
      </nav>
    </header>
    <main id="main" tabindex="-1">
${main}
    </main>
    <footer class="site-footer">
      <p>${COUNCIL_FULL_NAME}</p>
      <p>${FOOTER_NOTE}</p>
      <p><a href="/site/#informacja-o-danych">Informacja o przetwarzaniu danych</a></p>
    </footer>
  </body>
</html>
`}`;
}

function photosHtml(photos) {
  if (!photos?.length) return '';
  return h`<div class="news-photos">${photos.map((photo) => h`<figure class="news-photo"><img src="${photo.thumbUrl}" srcset="${`${photo.thumbUrl} 400w, ${photo.webUrl} 1600w`}" sizes="(max-width: 640px) 100vw, 640px" alt="${photo.alt}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />${photo.caption ? h`<figcaption class="news-photo-caption">${photo.caption}</figcaption>` : ''}</figure>`)}</div>`;
}

function dateHtml(date, className) {
  return date ? h`<time class="${className}" datetime="${date.toISOString()}">${formatDate(date)}</time>` : '';
}

function detailRows(pairs) {
  const rows = pairs.filter(([, value]) => value);
  return rows.length ? h`<dl class="event-details">${rows.map(([label, value]) => h`<dt>${label}</dt><dd>${value}</dd>`)}</dl>` : '';
}

function volunteerHtml(event) {
  if (!event.volunteerTasks.length) return '';
  return h`<div class="event-help"><p class="event-help-title">Potrzebna pomoc przy wydarzeniu:</p><ul class="event-help-list">${event.volunteerTasks.map((task) => h`<li>${`${task.title} — ${volunteerTaskLabel(task)}`}</li>`)}</ul></div>`;
}

function icsHtml(event) {
  const icsUrl = event.cancelled ? null : eventIcsUrl(event.id);
  return icsUrl ? h`<p class="event-calendar"><a href="${icsUrl}" download="">Dodaj do kalendarza (.ics)</a></p>` : '';
}

// ---------- sekcje strony głównej ----------

function statusHtml(id, text) {
  return text ? h`<p class="status" id="${id}" role="status">${text}</p>` : h`<p class="status" id="${id}" role="status" hidden></p>`;
}

function newsListHtml(items, nextHref) {
  const list = items.length ? h`<ol class="news-list">${items.map((item) => h`<li class="news"${item.id ? h` id="${newsAnchorId(item.id)}"` : ''}>${dateHtml(item.publishedAt, 'news-date')}<h3 class="news-title">${item.title}</h3><p class="news-body">${item.body}</p>${photosHtml(item.photos)}${item.id ? h`<p class="news-permalink-row"><a class="news-permalink" href="${newsPagePath(item.id)}">Stały link do wpisu</a></p>` : ''}</li>`)}</ol>` : '';
  const more = nextHref ? h`<p class="news-more"><a href="${nextHref}">Starsze wpisy</a></p>` : '';
  return h`<div id="news-list">${list}${more}</div>`;
}

function archiveHtml(years, currentYear) {
  return h`<nav id="news-archive" class="news-archive" aria-label="Archiwum aktualności"><ul class="news-archive-list"><li><a href="${newsArchiveHref()}"${currentYear ? '' : h` aria-current="page"`}>Najnowsze</a></li>${years.map((id) => h`<li><a href="${newsArchiveHref(id)}"${id === currentYear ? h` aria-current="page"` : ''}>${`Rok szkolny ${formatSchoolYear(id)}`}</a></li>`)}</ul></nav>`;
}

function eventsListHtml(events) {
  if (!events.length) return h`<div id="events-list"></div>`;
  return h`<div id="events-list">${groupByMonth(events).map((group) => h`<section class="month" aria-labelledby="${`miesiac-${group.key}`}"><h3 class="month-title" id="${`miesiac-${group.key}`}">${group.label}</h3><ol class="event-list">${group.events.map((event) => h`<li class="${event.cancelled ? 'event cancelled' : 'event'}"><p class="event-time"><time datetime="${event.startsAt.toISOString()}">${formatEventTime(event)}</time></p><h4 class="event-title">${event.cancelled ? h`<span class="badge">odwołane</span> ` : ''}<span>${event.title}</span></h4>${detailRows([['Miejsce', event.location], ['Organizator', event.organizer]])}${event.description ? h`<p class="event-description">${event.description}</p>` : ''}${volunteerHtml(event)}${icsHtml(event)}<p class="event-page-link"><a href="${eventPagePath(event.id)}">Szczegóły wydarzenia</a></p></li>`)}</ol></section>`)}</div>`;
}

function noticeTime(date) {
  return `${formatDay(date)}, ${formatTime(date)}`;
}

function noticesListHtml(notices) {
  if (!notices.length) return h`<div id="notices-list"></div>`;
  return h`<div id="notices-list"><ol class="event-list">${notices.map((notice) => h`<li class="${notice.cancelled ? 'event cancelled' : 'event'}"><p class="event-time"><time datetime="${notice.scheduledAt.toISOString()}">${noticeTime(notice.scheduledAt)}</time></p><h3 class="event-title">${notice.cancelled ? h`<span class="badge">odwołane</span> ` : ''}<span>${notice.title}</span></h3>${detailRows([
    ['Poprzedni termin', !notice.cancelled && notice.previousScheduledAt ? noticeTime(notice.previousScheduledAt) : null],
    ['Miejsce', notice.cancelled ? null : notice.location],
  ])}${!notice.cancelled && notice.agenda.length ? h`<p class="event-description">Porządek obrad:</p><ol class="agenda-list">${notice.agenda.map((point) => h`<li>${point}</li>`)}</ol>` : ''}</li>`)}</ol></div>`;
}

function minutesListHtml(minutes) {
  if (!minutes.length) return h`<div id="minutes-list"></div>`;
  return h`<div id="minutes-list"><ol class="minutes-list">${minutes.map((item) => h`<li class="minutes"><h3 class="minutes-title">${item.title}</h3><dl class="minutes-meta">${[
    ['Rodzaj', item.kind],
    ['Data zebrania', item.meetingDate ? formatDate(item.meetingDate) : null],
    ['Zatwierdzono', item.approvedAt ? formatDate(item.approvedAt) : null],
    ['Wersja', item.version ? String(item.version) : null],
  ].filter(([, value]) => value).map(([label, value]) => h`<dt>${label}</dt><dd>${value}</dd>`)}</dl><details class="minutes-body"><summary>Treść protokołu</summary><div class="minutes-text">${item.body}</div></details></li>`)}</ol></div>`;
}

// #145: treść i numer wersji wyłącznie z opublikowanej wersji (ten sam odczyt co
// GET /api/public/privacy-notice); null = nic nie opublikowano (komunikat neutralny).
function privacyNoticeHtml(notice) {
  if (!notice) {
    return {
      status: statusHtml('privacy-status', PRIVACY_NOTICE_UNAVAILABLE_MESSAGE),
      meta: h`<dl class="minutes-meta" id="privacy-meta" hidden></dl>`,
      text: h`<div class="privacy-text" id="privacy-text"></div>`,
    };
  }
  const published = notice.publishedAt ? formatDate(notice.publishedAt) : null;
  return {
    status: statusHtml('privacy-status', ''),
    meta: h`<dl class="minutes-meta" id="privacy-meta"><dt>Wersja</dt><dd>${String(notice.version)}</dd>${published ? h`<dt>Data publikacji</dt><dd>${published}</dd>` : ''}</dl>`,
    text: h`<div class="privacy-text" id="privacy-text">${notice.bodyText}</div>`,
  };
}

// Podmiana znacznika szablonu; brak znacznika = szablon niezgodny (zwracamy
// null, a serwer Node wydaje wtedy zwykły plik statyczny).
class TemplateMismatch extends Error {}
function replaceOnce(html, marker, replacement) {
  const index = html.indexOf(marker);
  if (index < 0) throw new TemplateMismatch(marker);
  return `${html.slice(0, index)}${render(replacement)}${html.slice(index + marker.length)}`;
}

// Sekcja, której dane nie dały się wczytać, zostaje w postaci z szablonu
// (stan „Wczytywanie…”) — JavaScript spróbuje ją wczytać z API.
async function section(load) {
  try {
    return await load();
  } catch (error) {
    if (error instanceof TemplateMismatch) throw error;
    log.error('public_site_section_failed', describeError(error));
    return null;
  }
}

export const INDEX_MARKERS = Object.freeze({
  title: /<title>[^<]*<\/title>/,
  description: /<meta name="description" content="[^"]*" \/>/,
  newsSection: '<section id="aktualnosci" aria-labelledby="news-title" aria-busy="true">',
  newsArchive: '<nav id="news-archive" class="news-archive" aria-label="Archiwum aktualności" hidden></nav>',
  newsStatus: '<p class="status" id="news-status" role="status">Wczytywanie…</p>',
  newsList: '<div id="news-list"></div>',
  eventsSection: '<section id="wydarzenia" aria-labelledby="events-title" aria-busy="true">',
  eventsStatus: '<p class="status" id="events-status" role="status">Wczytywanie…</p>',
  calendarFeed: '<p class="section-note" id="calendar-feed" hidden>',
  eventsList: '<div id="events-list"></div>',
  noticesSection: '<section id="zawiadomienia" aria-labelledby="notices-title" aria-busy="true">',
  noticesStatus: '<p class="status" id="notices-status" role="status">Wczytywanie…</p>',
  noticesList: '<div id="notices-list"></div>',
  minutesSection: '<section id="protokoly" aria-labelledby="minutes-title" aria-busy="true">',
  minutesYear: '<p class="section-note" id="minutes-year"></p>',
  minutesStatus: '<p class="status" id="minutes-status" role="status">Wczytywanie…</p>',
  minutesList: '<div id="minutes-list"></div>',
  privacySection: '<section id="informacja-o-danych" aria-labelledby="privacy-title" aria-busy="true">',
  privacyStatus: '<p class="status" id="privacy-status" role="status">Wczytywanie…</p>',
  privacyMeta: '<dl class="minutes-meta" id="privacy-meta" hidden></dl>',
  privacyText: '<div class="privacy-text" id="privacy-text"></div>',
});

export async function renderIndex(db, template, { origin, search = '', now = new Date() } = {}) {
  if (typeof template !== 'string') return null;
  const m = INDEX_MARKERS;
  const schoolYearId = newsYearFromSearch(search);
  const cursor = newsCursorFromSearch(search);
  const minutesYear = schoolYearFromSearch(search, now);
  const [news, years, events, notices, minutes, privacy] = await Promise.all([
    section(async () => {
      let result;
      try {
        result = await listPublicNews(db, { schoolYearId, cursor, ...(schoolYearId ? { limit: 50 } : {}) });
      } catch (error) {
        // Nieaktualny/obcy kursor: zamiast błędu pierwsza strona (najnowsze).
        if (error?.code !== 'invalid_cursor') throw error;
        result = await listPublicNews(db, { schoolYearId, ...(schoolYearId ? { limit: 50 } : {}) });
      }
      return { items: newsItems(result), nextCursor: result.nextCursor };
    }),
    section(async () => (await listPublicSchoolYears(db)).schoolYears.map((year) => year.id)),
    section(async () => upcomingEvents((await listPublicEvents(db, { from: brusselsDate(now), limit: 200 })).events, now)),
    section(async () => publicNotices((await listPublicMeetingNotices(db, { schoolYearId: minutesYear })).notices)),
    section(async () => publicMinutes((await listPublicMinutes(db, { schoolYearId: minutesYear })).minutes)),
    section(async () => ({ notice: normalizePrivacyNotice(await loadPublicNotice(db)) })),
  ]);
  const canonical = absolute(origin, `${SITE_PATH}${schoolYearId ? `?${new URLSearchParams({ rok: schoolYearId })}` : ''}`);
  try {
    let html = template.replaceAll('"./assets/', '"/site/assets/');
    html = html.replace(m.title, render(h`<title>${COUNCIL_FULL_NAME}</title>`));
    if (!m.description.test(html)) throw new TemplateMismatch(m.description.source);
    html = html.replace(m.description, render(h`<meta name="description" content="${DESCRIPTION}" />
    ${metaTags({ title: COUNCIL_FULL_NAME, description: DESCRIPTION, canonical, type: 'website' })}`));
    html = html.replace(/(<[a-z]+ [^>]*data-school-name="council"[^>]*>)(<\/[a-z]+>)/g,
      (_, open, close) => `${open}${escapeText(COUNCIL_FULL_NAME)}${close}`);
    if (news) {
      html = replaceOnce(html, m.newsSection, h`<section id="aktualnosci" aria-labelledby="news-title">`);
      if (years) html = replaceOnce(html, m.newsArchive, archiveHtml(years, schoolYearId));
      html = replaceOnce(html, m.newsStatus, statusHtml('news-status', news.items.length ? '' : 'Brak opublikowanych aktualności.'));
      html = replaceOnce(html, m.newsList, newsListHtml(news.items, news.nextCursor ? newsArchiveHref(schoolYearId, news.nextCursor) : null));
    }
    if (events) {
      html = replaceOnce(html, m.eventsSection, h`<section id="wydarzenia" aria-labelledby="events-title">`);
      html = replaceOnce(html, m.eventsStatus, statusHtml('events-status', events.length ? '' : 'Brak opublikowanych wydarzeń.'));
      html = replaceOnce(html, m.calendarFeed, h`<p class="section-note" id="calendar-feed">`);
      html = replaceOnce(html, m.eventsList, eventsListHtml(events));
    }
    if (notices) {
      html = replaceOnce(html, m.noticesSection, h`<section id="zawiadomienia" aria-labelledby="notices-title">`);
      html = replaceOnce(html, m.noticesStatus, statusHtml('notices-status', notices.length ? '' : 'Brak opublikowanych zawiadomień o zebraniach.'));
      html = replaceOnce(html, m.noticesList, noticesListHtml(notices));
    }
    html = replaceOnce(html, m.minutesYear, h`<p class="section-note" id="minutes-year">${`Rok szkolny ${formatSchoolYear(minutesYear)}. Protokoły zatwierdzone i udostępnione publicznie.`}</p>`);
    if (minutes) {
      html = replaceOnce(html, m.minutesSection, h`<section id="protokoly" aria-labelledby="minutes-title">`);
      html = replaceOnce(html, m.minutesStatus, statusHtml('minutes-status', minutes.length ? '' : 'Brak opublikowanych protokołów.'));
      html = replaceOnce(html, m.minutesList, minutesListHtml(minutes));
    }
    if (privacy) {
      const view = privacyNoticeHtml(privacy.notice);
      html = replaceOnce(html, m.privacySection, h`<section id="informacja-o-danych" aria-labelledby="privacy-title">`);
      html = replaceOnce(html, m.privacyStatus, view.status);
      html = replaceOnce(html, m.privacyMeta, view.meta);
      html = replaceOnce(html, m.privacyText, view.text);
    }
    return html;
  } catch (error) {
    if (error instanceof TemplateMismatch) {
      log.warn('public_site_template_mismatch', { marker: String(error.message).slice(0, 120) });
      return null;
    }
    throw error;
  }
}

// ---------- strony wpisu i wydarzenia ----------

function unavailablePage(message, stylesheets) {
  return page({
    title: `Strona niedostępna — ${COUNCIL_FULL_NAME}`,
    description: message,
    canonical: null,
    stylesheets,
    noindex: true,
    main: h`      <h1>Strona niedostępna</h1>
      <p class="status" role="status">${message}</p>
      <p><a href="/site/">Strona główna Rady Rodziców</a></p>`,
  });
}

export async function renderPostPage(db, postId, { origin, template = null } = {}) {
  const stylesheets = stylesheetsFrom(template);
  let payload;
  try {
    payload = await getPublicPost(db, { postId });
  } catch (error) {
    if (error?.status === 404) return { status: 404, html: unavailablePage(NEWS_UNAVAILABLE_MESSAGE, stylesheets) };
    throw error;
  }
  const [post] = newsItems({ posts: [payload.post] });
  if (!post?.id) return { status: 404, html: unavailablePage(NEWS_UNAVAILABLE_MESSAGE, stylesheets) };
  const description = excerpt(post.body) || DESCRIPTION;
  return {
    status: 200,
    html: page({
      title: `${post.title} — ${COUNCIL_FULL_NAME}`,
      description,
      canonical: absolute(origin, newsPagePath(post.id)),
      stylesheets,
      main: h`      <article class="news news-page">
        ${dateHtml(post.publishedAt, 'news-date')}
        <h1>${post.title}</h1>
        <p class="news-body">${post.body}</p>
        ${photosHtml(post.photos)}
      </article>
      <p class="news-back"><a href="/site/#aktualnosci">Wszystkie aktualności</a></p>`,
    }),
  };
}

export async function renderEventPage(db, eventId, { origin, template = null } = {}) {
  const stylesheets = stylesheetsFrom(template);
  let payload;
  try {
    payload = await getPublicEvent(db, { eventId });
  } catch (error) {
    if (error?.status === 404) return { status: 404, html: unavailablePage(EVENT_UNAVAILABLE_MESSAGE, stylesheets) };
    throw error;
  }
  const event = normalizeEvent(payload.event);
  if (!event) return { status: 404, html: unavailablePage(EVENT_UNAVAILABLE_MESSAGE, stylesheets) };
  const when = formatEventTime(event);
  const description = [event.cancelled ? 'Wydarzenie odwołane.' : null, when, event.location, excerpt(event.description, 120)]
    .filter(Boolean).join(' · ');
  return {
    status: 200,
    html: page({
      title: `${event.title} — ${COUNCIL_FULL_NAME}`,
      description,
      canonical: absolute(origin, eventPagePath(event.id)),
      stylesheets,
      main: h`      <article class="${event.cancelled ? 'event event-page cancelled' : 'event event-page'}" itemscope itemtype="https://schema.org/Event">
        <link itemprop="eventStatus" href="${event.cancelled ? 'https://schema.org/EventCancelled' : 'https://schema.org/EventScheduled'}" />
        <h1>${event.cancelled ? h`<span class="badge">odwołane</span> ` : ''}<span itemprop="name">${event.title}</span></h1>
        <p class="event-time"><time itemprop="startDate" datetime="${event.startsAt.toISOString()}">${when}</time>${event.endsAt ? h`<meta itemprop="endDate" content="${event.endsAt.toISOString()}" />` : ''}</p>
        ${detailRows([['Miejsce', event.location], ['Organizator', event.organizer]])}
        ${event.location ? h`<meta itemprop="location" content="${event.location}" />` : ''}
        ${event.description ? h`<p class="event-description" itemprop="description">${event.description}</p>` : ''}
        ${volunteerHtml(event)}
        ${icsHtml(event)}
      </article>
      <p class="news-back"><a href="/site/#wydarzenia">Wszystkie wydarzenia</a></p>`,
    }),
  };
}

// ---------- kanał Atom i mapa strony ----------

export async function renderFeed(db, { origin, now = new Date() } = {}) {
  const { rows } = await db.query(
    `SELECT id, title, body, published_at, first_published_at FROM public_news
      ORDER BY published_at DESC, id LIMIT ${FEED_LIMIT}`,
  );
  const seen = new Set();
  const entries = rows.filter((row) => !seen.has(row.id) && seen.add(row.id)).map((row) => {
    const [post] = newsItems({ posts: [{ id: row.id, title: row.title, body: row.body, publishedAt: isoOf(row.published_at) }] });
    if (!post?.id || !post.publishedAt) return null;
    return { ...post, firstPublishedAt: isoOf(row.first_published_at) ?? post.publishedAt.toISOString() };
  }).filter(Boolean);
  const updated = entries.length
    ? entries.reduce((latest, entry) => (entry.publishedAt > latest ? entry.publishedAt : latest), entries[0].publishedAt).toISOString()
    : new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString();
  const siteUrl = absolute(origin, SITE_PATH);
  return `<?xml version="1.0" encoding="utf-8"?>\n${h`<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="pl">
  <title>${`Aktualności — ${COUNCIL_FULL_NAME}`}</title>
  <subtitle>Wpisy zatwierdzone i opublikowane przez Radę Rodziców. Pełna treść i zdjęcia na stronie wpisu.</subtitle>
  <id>${siteUrl}</id>
  <link rel="self" type="application/atom+xml" href="${absolute(origin, FEED_PATH)}" />
  <link rel="alternate" type="text/html" href="${siteUrl}" />
  <updated>${updated}</updated>
  <author><name>${COUNCIL_FULL_NAME}</name></author>
${entries.map((entry) => {
    const url = absolute(origin, newsPagePath(entry.id));
    return h`  <entry>
    <title type="text">${entry.title}</title>
    <id>${url}</id>
    <link rel="alternate" type="text/html" href="${url}" />
    <published>${entry.firstPublishedAt}</published>
    <updated>${entry.publishedAt.toISOString()}</updated>
    <content type="text">${entry.body}</content>
  </entry>
`;
  })}</feed>
`}`;
}

export async function renderSitemap(db, { origin } = {}) {
  const [{ rows: posts }, { rows: events }] = await Promise.all([
    db.query(`SELECT id, published_at FROM public_news ORDER BY published_at DESC, id LIMIT ${SITEMAP_LIMIT}`),
    db.query(`SELECT id, published_at FROM public_events ORDER BY begins_at DESC, id LIMIT ${SITEMAP_LIMIT}`),
  ]);
  const urls = [{ loc: absolute(origin, SITE_PATH), lastmod: null }];
  const add = (rows, pathOf) => {
    const seen = new Set();
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      let path;
      try { path = pathOf(row.id); } catch { continue; }
      urls.push({ loc: absolute(origin, path), lastmod: isoOf(row.published_at) });
    }
  };
  add(posts, newsPagePath);
  add(events, eventPagePath);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${h`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((entry) => h`  <url><loc>${entry.loc}</loc>${entry.lastmod ? h`<lastmod>${entry.lastmod}</lastmod>` : ''}</url>
`)}</urlset>
`}`;
}

// ---------- HTTP ----------

function respond(body, status, type, extra = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': type, 'Cache-Control': status === 200 ? CACHE_PUBLIC : 'no-store', ...extra },
  });
}

const HTML = 'text/html; charset=utf-8';

function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

// Obsługuje wyłącznie GET/HEAD na ścieżkach PUBLIC_SITE_PATH; inne -> null.
// `template` — treść dist/site/index.html (albo null, gdy nie zbudowano stron).
// Błąd bazy: 503 bez szczegółów (strona główna: null, czyli plik statyczny).
export async function handlePublicSite(request, env, { template = null, now = new Date() } = {}) {
  if (!['GET', 'HEAD'].includes(request.method)) return null;
  const url = new URL(request.url);
  const path = url.pathname;
  if (!PUBLIC_SITE_PATH.test(path) || !env?.db) return null;
  const origin = url.origin;
  const post = path.match(/^\/site\/aktualnosci\/([^/]+)$/);
  const event = path.match(/^\/site\/wydarzenia\/([^/]+)$/);
  try {
    if (path === '/site/' || path === '/site/index.html') {
      const html = await renderIndex(env.db, template, { origin, search: url.search, now });
      return html === null ? null : respond(html, 200, HTML);
    }
    if (post || event) {
      const id = cleanText(decodeSegment((post ?? event)[1]), 200) ?? '';
      const result = post
        ? await renderPostPage(env.db, id, { origin, template })
        : await renderEventPage(env.db, id, { origin, template });
      return respond(result.html, result.status, HTML, result.status === 200 ? {} : { 'X-Robots-Tag': 'noindex, nofollow' });
    }
    if (path === '/site/feed.xml') {
      return respond(await renderFeed(env.db, { origin, now }), 200, 'application/atom+xml; charset=utf-8');
    }
    return respond(await renderSitemap(env.db, { origin }), 200, 'application/xml; charset=utf-8');
  } catch (error) {
    log.error('public_site_render_failed', describeError(error));
    if (path === '/site/' || path === '/site/index.html') return null;
    return respond('Serwis chwilowo niedostępny. Spróbuj ponownie później.', 503, 'text/plain; charset=utf-8', { 'Retry-After': '30' });
  }
}
