// #116: strona publiczna renderowana po stronie serwera, kanał Atom, mapa
// strony, archiwum (kursor) i publiczna lista lat. Wyłącznie dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handlePgRequest } from '../src/pg/app.js';
import {
  approve, createDraft, listPublic, publish, submit, updateDraft, withdraw,
} from '../src/pg/news.js';
import * as events from '../src/pg/events.js';
import {
  FEED_LIMIT, INDEX_MARKERS, PUBLIC_SITE_PATH, escapeText, h, handlePublicSite,
} from '../src/pg/public-site.js';
import { PUBLIC_SITE_DYNAMIC_PATH, createNodeHandler, robotsTxtBody } from '../src/node-app.js';
import { classifyRequest } from '../src/rate-limit.js';
import { COUNCIL_FULL_NAME } from '../shared/school.js';
import { NEWS_UNAVAILABLE_MESSAGE, excerpt, newsArchiveHref, newsCursorFromSearch, newsListUrl } from '../site/core.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';
import { assertEvery } from './helpers/assertions.js';

const ORIGIN = 'https://rd.test';
const board1 = { userId: 'board1', grants: [{ role: 'board', classId: null, schoolYearId: null }], mfaVerified: true };
const board2 = { userId: 'board2', grants: [{ role: 'board', classId: null, schoolYearId: null }], mfaVerified: true };
const TEMPLATE = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
// Szablon jak po `vite build`: zasoby pod ./assets/ (base ./).
const BUILT_TEMPLATE = TEMPLATE
  .replace('<link rel="stylesheet" href="/styles.css" />', '<script type="module" crossorigin src="./assets/index-TEST.js"></script>\n    <link rel="stylesheet" crossorigin href="./assets/index-TEST.css">')
  .replace('<script type="module" src="/main.js"></script>', '');

let counter = 0;
const key = (prefix) => `${prefix}-${String(++counter).padStart(6, '0')}`;

// Rok szkolny RRRR-RRRR (od 1 września) z klasą 1A.
async function addYear(db, start) {
  const id = `${start}-${start + 1}`;
  await seedSchoolYear(db, id, { startsOn: `${start}-09-01`, endsOn: `${start + 1}-08-31` });
  await seedClass(db, { id: `${id}-1a`, schoolYearId: id });
  return id;
}

// Osobna baza na test: listy publiczne (kanał, mapa, archiwum) obejmują
// wszystkie lata, więc wspólna baza mieszałaby wyniki testów.
async function withDb(fn) {
  const db = await createTestDb();
  try {
    for (const userId of ['board1', 'board2']) await seedUser(db, { userId });
    const year = await addYear(db, 2030);
    await fn({ db, year });
  } finally {
    await db.close();
  }
}

async function publishedPost(db, year, overrides = {}) {
  const { post } = await createDraft(db, board1, {
    schoolYearId: year, title: 'Kiermasz (syntetyczne)', body: 'Dziękujemy za udział.\nDruga linia.',
    idempotencyKey: key('news'), ...overrides,
  });
  await submit(db, board1, { postId: post.id, revision: 1 });
  await approve(db, board2, { postId: post.id, revision: 1 });
  return (await publish(db, board2, { postId: post.id, revision: 1 })).post;
}

async function publishedEvent(db, year, overrides = {}) {
  const { event } = await events.createDraft(db, board1, {
    schoolYearId: year, title: 'Piknik (syntetyczny)', startsAt: '2099-06-12T10:00', endsAt: '2099-06-12T14:00',
    location: 'Boisko testowe', organizer: 'Rada Rodziców', audience: 'public', idempotencyKey: key('event'), ...overrides,
  });
  await events.submit(db, board1, { eventId: event.id, revision: 1 });
  await events.approve(db, board2, { eventId: event.id, revision: 1 });
  return (await events.publish(db, board2, { eventId: event.id, revision: 1 })).event;
}

async function site(db, path, { template = BUILT_TEMPLATE, now } = {}) {
  const response = await handlePublicSite(new Request(`${ORIGIN}${path}`), { db }, { template, ...(now ? { now } : {}) });
  return response ? { status: response.status, headers: response.headers, text: await response.text() } : null;
}

test('szablon: znaczniki renderowania istnieją w site/index.html; ścieżki serwera Node i modułu są zgodne', () => {
  for (const [name, marker] of Object.entries(INDEX_MARKERS)) {
    if (marker instanceof RegExp) assert.match(TEMPLATE, marker, name);
    else assert.ok(TEMPLATE.includes(marker), `site/index.html: brak znacznika ${name}`);
  }
  assert.equal(PUBLIC_SITE_DYNAMIC_PATH.source, PUBLIC_SITE_PATH.source);
  for (const ok of ['/site/', '/site/index.html', '/site/feed.xml', '/site/sitemap.xml', '/site/aktualnosci/x', '/site/wydarzenia/y']) {
    assert.ok(PUBLIC_SITE_PATH.test(ok), ok);
  }
  for (const no of ['/site', '/site/main.js', '/site/assets/a.css', '/site/aktualnosci/', '/site/aktualnosci/a/b', '/api/public/news']) {
    assert.equal(PUBLIC_SITE_PATH.test(no), false, no);
  }
});

test('escapowanie: szablon h zamienia &<>"\' i usuwa znaki niedozwolone w XML', () => {
  const value = '<script>alert("x")</script> & \'y\'\u0001￿';
  assert.equal(String(h`<p title="${value}">${value}</p>`),
    '<p title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;</p>');
  assert.equal(String(h`${h`<b>${'<i>'}</b>`}`), '<b>&lt;i&gt;</b>');
  assert.equal(escapeText('\uD800a'), 'a');
  assert.equal(excerpt('  Ala   ma\nkota  '), 'Ala ma kota');
  assert.equal(excerpt('słowo '.repeat(60)).length <= 160, true);
});

test('strona wpisu: treść bez JavaScriptu, escapowanie, canonical i Open Graph bez obrazu; identyczne 404 (#116)', () => withDb(async ({ db, year }) => {
  const draft = (await createDraft(db, board1, { schoolYearId: year, title: 'Szkic tajny', body: 'Treść szkicu.', idempotencyKey: key('news') })).post;
  const approved = (await createDraft(db, board1, { schoolYearId: year, title: 'Zatwierdzony tajny', body: 'Treść.', idempotencyKey: key('news') })).post;
  await submit(db, board1, { postId: approved.id, revision: 1 });
  await approve(db, board2, { postId: approved.id, revision: 1 });
  const published = await publishedPost(db, year, {
    title: 'Zbiórka <script>alert(1)</script> & "cytat"', body: 'Pierwsza linia <b>tekst</b>.\nDruga linia.', classId: `${year}-1a`,
  });

  const page = await site(db, `/site/aktualnosci/${published.id}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(page.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(page.headers.get('x-robots-tag'), null);
  assert.ok(page.text.includes('<h1>Zbiórka &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;cytat&quot;</h1>'));
  assert.equal(page.text.includes('<script>alert(1)</script>'), false);
  assert.equal(page.text.includes('<b>tekst</b>'), false);
  assert.ok(page.text.includes('Pierwsza linia &lt;b&gt;tekst&lt;/b&gt;.\nDruga linia.'));
  assert.ok(page.text.includes(`<link rel="canonical" href="${ORIGIN}/site/aktualnosci/${published.id}" />`));
  assert.ok(page.text.includes(`<meta property="og:url" content="${ORIGIN}/site/aktualnosci/${published.id}" />`));
  assert.match(page.text, /<meta property="og:title" content="Zbiórka &lt;script&gt;/);
  assert.match(page.text, /<meta name="description" content="Pierwsza linia &lt;b&gt;tekst&lt;\/b&gt;\. Druga linia\." \/>/);
  assert.equal(page.text.includes('og:image'), false, 'bez og:image (D-18)');
  assert.ok(page.text.includes('<link rel="stylesheet" href="/site/assets/index-TEST.css" />'));
  assert.equal(/<script\b/.test(page.text), false, 'strona wpisu bez skryptów');
  assert.equal(/\sstyle=/.test(page.text), false, 'bez wstawianych stylów (CSP style-src self)');
  assert.ok(page.text.includes(COUNCIL_FULL_NAME));
  for (const leak of [`${year}-1a`, 'board1', 'board2', 'classId', year]) {
    assert.equal(page.text.includes(leak), false, `strona wpisu ujawnia ${leak}`);
  }

  // Nowsza, niezatwierdzona wersja: publicznie nadal wersja opublikowana.
  await updateDraft(db, board1, { postId: published.id, revision: 1, title: 'Wersja robocza', body: 'Robocza treść' });
  const still = await site(db, `/site/aktualnosci/${published.id}`);
  assert.equal(still.text.includes('Wersja robocza'), false);
  assert.equal(still.text.includes('Robocza treść'), false);
  assert.ok(still.text.includes('Zbiórka &lt;script&gt;'));

  // Szkic, zatwierdzony nieopublikowany, nieistniejący i zły adres: to samo 404.
  const missing = await site(db, '/site/aktualnosci/brak-takiego-wpisu');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cache-control'), 'no-store');
  assert.equal(missing.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.ok(missing.text.includes(NEWS_UNAVAILABLE_MESSAGE));
  assert.ok(missing.text.includes('<meta name="robots" content="noindex" />'));
  for (const path of [`/site/aktualnosci/${draft.id}`, `/site/aktualnosci/${approved.id}`, '/site/aktualnosci/%E0%A4%A', '/site/aktualnosci/..%2F..%2Fapi']) {
    const other = await site(db, path);
    assert.equal(other.status, 404, path);
    assert.equal(other.text, missing.text, `${path}: odpowiedź nieodróżnialna od nieistniejącego wpisu`);
  }

  // Wycofanie: od następnego żądania to samo 404.
  await withdraw(db, board1, { postId: published.id, revision: 2, reason: 'Błąd w treści' });
  const gone = await site(db, `/site/aktualnosci/${published.id}`);
  assert.equal(gone.status, 404);
  assert.equal(gone.text, missing.text);
}));

test('strona główna: aktualności, wydarzenia i archiwum w HTML bez JavaScriptu; wycofany wpis znika (#116)', () => withDb(async ({ db, year }) => {
  const post = await publishedPost(db, year, { title: 'Aktualność <script>x</script> jawna' });
  const hidden = (await createDraft(db, board1, { schoolYearId: year, title: 'Szkic SEKRET', body: 'Treść.', idempotencyKey: key('news') })).post;
  const event = await publishedEvent(db, year, { title: 'Piknik <img src=x> jawny' });
  await events.createDraft(db, board1, {
    schoolYearId: year, title: 'Wydarzenie SEKRET', startsAt: '2099-06-13T10:00', audience: 'public', idempotencyKey: key('event'),
  });

  const index = await site(db, '/site/');
  assert.equal(index.status, 200);
  assert.equal(index.headers.get('cache-control'), 'public, max-age=60');
  const html = index.text;
  assert.ok(html.includes('Aktualność &lt;script&gt;x&lt;/script&gt; jawna'));
  assert.equal(html.includes('<script>x</script>'), false);
  assert.ok(html.includes('Piknik &lt;img src=x&gt; jawny'));
  assert.equal(html.includes('SEKRET'), false);
  assert.ok(html.includes(`id="wpis-${post.id}"`), 'kotwica dawnych linków #wpis-<id>');
  assert.ok(html.includes(`href="/site/aktualnosci/${post.id}"`));
  assert.ok(html.includes(`href="/site/wydarzenia/${event.id}"`));
  assert.ok(html.includes(`<link rel="canonical" href="${ORIGIN}/site/" />`));
  assert.ok(html.includes('<link rel="alternate" type="application/atom+xml" title="Aktualności" href="/site/feed.xml" />'));
  assert.ok(html.includes(`<title>${COUNCIL_FULL_NAME}</title>`));
  assert.ok(html.includes(`data-school-name="council">${COUNCIL_FULL_NAME}</p>`));
  assert.ok(html.includes('src="/site/assets/index-TEST.js"'), 'zasoby z adresem bezwzględnym /site/assets/');
  assert.equal(html.includes('"./assets/'), false);
  assert.equal(/<section id="(aktualnosci|wydarzenia|zawiadomienia|protokoly)"[^>]*aria-busy/.test(html), false,
    'sekcje wyrenderowane przez serwer nie są oznaczone jako wczytywane');
  assert.equal(html.includes('Wczytywanie…'), false);
  assert.ok(html.includes('Brak opublikowanych protokołów.'));
  assert.ok(html.includes(`href="?rok=${year}#aktualnosci"`), 'archiwum: rok z opublikowaną treścią');
  assert.equal(/\sstyle=/.test(html), false);
  assert.equal(html.includes(hidden.id), false);
  assert.equal(html.includes(`${year}-1a`), false);

  // Archiwum wybranego roku: canonical z rokiem, zaznaczony rok.
  const archive = await site(db, `/site/?rok=${year}`);
  assert.ok(archive.text.includes(`<link rel="canonical" href="${ORIGIN}/site/?rok=${year}" />`));
  assert.match(archive.text, new RegExp(`href="\\?rok=${year}#aktualnosci" aria-current="page"`));

  await withdraw(db, board1, { postId: post.id, revision: 1, reason: 'Nieaktualne' });
  const after = await site(db, '/site/');
  assert.equal(after.text.includes('jawna'), false, 'wycofany wpis znika przy następnym żądaniu');
  assert.ok(after.text.includes('Brak opublikowanych aktualności.'));

  // Bez szablonu (strony niezbudowane) serwer Node wydaje plik statyczny.
  assert.equal(await site(db, '/site/', { template: null }), null);
  assert.equal(await site(db, '/site/', { template: '<html>inny szablon</html>' }), null);
}));

test('archiwum: kursor prowadzi do najstarszego wpisu bez powtórzeń; zły kursor 400 w API i pierwsza strona w HTML', () => withDb(async ({ db, year }) => {
  const ids = [];
  for (let i = 0; i < 23; i += 1) ids.push((await publishedPost(db, year, { title: `Wpis archiwalny ${i}` })).id);

  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const response = await handlePgRequest(request(newsListUrl(null, cursor)), { db });
    assert.equal(response.status, 200);
    const body = await response.json();
    seen.push(...body.posts.map((p) => p.id));
    cursor = body.nextCursor;
    pages += 1;
  } while (cursor && pages < 10);
  assert.equal(pages, 2);
  assert.equal(new Set(seen).size, seen.length, 'bez powtórzeń');
  assert.deepEqual([...seen].sort(), [...ids].sort(), 'dochodzi do najstarszego');

  // Kursor zawiera tylko czas publikacji i publiczny identyfikator wpisu.
  const first = await listPublic(db, {});
  const decoded = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8'));
  assert.equal(decoded.length, 3);
  assert.match(decoded[0], /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(ids.includes(decoded[1]));

  // Kursor innego filtra (rok) i śmieci: 400 invalid_cursor.
  for (const bad of [first.nextCursor, 'nie-kursor', 'x'.repeat(2000)]) {
    const response = await handlePgRequest(request(`/api/public/news?schoolYearId=${year}&cursor=${bad}`), { db });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_cursor');
  }

  // HTML: „Starsze wpisy” z kursorem; druga strona zawiera najstarszy wpis.
  const index = await site(db, '/site/');
  const href = /<p class="news-more"><a href="([^"]+)">Starsze wpisy<\/a><\/p>/.exec(index.text)?.[1];
  assert.ok(href, 'link do starszych wpisów');
  const older = await site(db, `/site/${href.replace(/&amp;/g, '&').replace(/#.*$/, '')}`);
  assert.ok(older.text.includes(`id="wpis-${ids[0]}"`), 'najstarszy wpis na drugiej stronie');
  assert.equal(older.text.includes('Starsze wpisy'), false);
  assert.equal(newsCursorFromSearch(href.replace(/&amp;/g, '&').replace(/#.*$/, '')), first.nextCursor);
  const stale = await site(db, '/site/?kursor=nieaktualny-kursor');
  assert.equal(stale.status, 200);
  assert.ok(stale.text.includes('Wpis archiwalny 22'), 'zły kursor: pierwsza strona');
  assert.equal(newsArchiveHref(year, 'abc'), `?rok=${year}&kursor=abc#aktualnosci`);
}));

test('GET /api/public/school-years: tylko lata z treściami publicznymi, tylko identyfikatory', () => withDb(async ({ db, year }) => {
  const empty = await addYear(db, 2031);
  const eventOnly = await addYear(db, 2032);
  await publishedPost(db, year);
  await publishedEvent(db, eventOnly);
  await createDraft(db, board1, { schoolYearId: empty, title: 'Szkic', body: 'Treść.', idempotencyKey: key('news') });
  const response = await handlePgRequest(request('/api/public/school-years'), { db });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=60');
  const { schoolYears } = await response.json();
  const listed = schoolYears.map((y) => y.id);
  assert.ok(listed.includes(year));
  assert.ok(listed.includes(eventOnly));
  assert.equal(listed.includes(empty), false);
  for (const entry of schoolYears) assert.deepEqual(Object.keys(entry), ['id']);
  assert.ok(listed.indexOf(eventOnly) < listed.indexOf(year), 'od najnowszego roku');
  assert.equal((await handlePgRequest(request('/api/public/school-years', { method: 'POST', body: {} }), { db })).status, 405);
}));

test('strona wydarzenia: tylko opublikowane wydarzenie publiczne, mikrodane schema.org/Event, identyczne 404', () => withDb(async ({ db, year }) => {
  const event = await publishedEvent(db, year, { title: 'Festyn "jawny" <b>', description: 'Opis <i>festynu</i>.' });
  const internal = (await events.createDraft(db, board1, {
    schoolYearId: year, title: 'Wewnętrzne', startsAt: '2099-06-14T10:00', audience: 'internal', idempotencyKey: key('event'),
  })).event;
  const page = await site(db, `/site/wydarzenia/${event.id}`);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('itemtype="https://schema.org/Event"'));
  assert.ok(page.text.includes('<span itemprop="name">Festyn &quot;jawny&quot; &lt;b&gt;</span>'));
  assert.ok(page.text.includes('Opis &lt;i&gt;festynu&lt;/i&gt;.'));
  assert.ok(page.text.includes(`<link rel="canonical" href="${ORIGIN}/site/wydarzenia/${event.id}" />`));
  assert.ok(page.text.includes(`href="/api/public/events/${event.id}.ics"`));
  assert.equal(page.text.includes('og:image'), false);
  const missing = await site(db, '/site/wydarzenia/brak');
  assert.equal(missing.status, 404);
  const other = await site(db, `/site/wydarzenia/${internal.id}`);
  assert.equal(other.status, 404);
  assert.equal(other.text, missing.text);
}));

test('kanał Atom: 20 ostatnich wpisów, bez zdjęć i danych wewnętrznych, bez powtórzeń przy publikacji w tle', () => withDb(async ({ db, year }) => {
  const ids = [];
  for (let i = 0; i < FEED_LIMIT + 2; i += 1) {
    ids.push((await publishedPost(db, year, { title: `Wpis kanału ${i} <&>`, classId: i === 0 ? `${year}-1a` : undefined })).id);
  }
  const feed = await site(db, '/site/feed.xml');
  assert.equal(feed.status, 200);
  assert.equal(feed.headers.get('content-type'), 'application/atom+xml; charset=utf-8');
  assert.equal(feed.headers.get('cache-control'), 'public, max-age=60');
  const xml = feed.text;
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="pl">'));
  for (const required of ['<title>', '<id>', '<updated>', '<author><name>', `<link rel="self" type="application/atom+xml" href="${ORIGIN}/site/feed.xml" />`]) {
    assert.ok(xml.includes(required), required);
  }
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  assert.equal(entries.length, FEED_LIMIT);
  for (const entry of entries) {
    for (const element of ['<title type="text">', '<id>', '<link rel="alternate"', '<published>', '<updated>', '<content type="text">']) {
      assert.ok(entry.includes(element), `wpis kanału bez ${element}`);
    }
    assert.match(entry, /<updated>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z<\/updated>/);
  }
  const entryIds = entries.map((entry) => /<id>([^<]+)<\/id>/.exec(entry)[1]);
  assert.equal(new Set(entryIds).size, entryIds.length);
  assertEvery(entryIds, (id) => id.startsWith(`${ORIGIN}/site/aktualnosci/`), 'identyfikatory wpisów kanału');
  assert.ok(xml.includes('Wpis kanału 21 &lt;&amp;&gt;'));
  assert.equal(xml.includes('<&>'), false);
  for (const leak of ['<img', 'news-photos', `${year}-1a`, 'board1', 'board2']) {
    assert.equal(xml.includes(leak), false, `kanał ujawnia ${leak}`);
  }

  // Równoległe żądania kanału podczas publikacji: każda odpowiedź bez duplikatów.
  const results = await Promise.all([
    site(db, '/site/feed.xml'), publishedPost(db, year, { title: 'Wpis w tle' }), site(db, '/site/feed.xml'), site(db, '/site/feed.xml'),
  ]);
  for (const result of [results[0], results[2], results[3]]) {
    const idsInFeed = [...result.text.matchAll(/<entry>[\s\S]*?<id>([^<]+)<\/id>/g)].map((m) => m[1]);
    assert.equal(new Set(idsInFeed).size, idsInFeed.length);
    assert.ok(idsInFeed.length <= FEED_LIMIT);
  }

  // Wycofany wpis znika z kanału przy następnym żądaniu.
  const latest = ids[ids.length - 1];
  await withdraw(db, board1, { postId: latest, revision: 1, reason: 'Nieaktualne' });
  assert.equal((await site(db, '/site/feed.xml')).text.includes(`/site/aktualnosci/${latest}<`), false);
}));

test('mapa strony: wyłącznie adresy /site/, bez wycofanych wpisów i szkiców', () => withDb(async ({ db, year }) => {
  const post = await publishedPost(db, year);
  const gone = await publishedPost(db, year);
  await withdraw(db, board1, { postId: gone.id, revision: 1, reason: 'Nieaktualne' });
  const draft = (await createDraft(db, board1, { schoolYearId: year, title: 'Szkic', body: 'Treść.', idempotencyKey: key('news') })).post;
  const event = await publishedEvent(db, year);
  const map = await site(db, '/site/sitemap.xml');
  assert.equal(map.status, 200);
  assert.equal(map.headers.get('content-type'), 'application/xml; charset=utf-8');
  const locs = [...map.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assertEvery(locs, (loc) => loc.startsWith(`${ORIGIN}/site/`), 'adresy mapy strony');
  assert.ok(locs.includes(`${ORIGIN}/site/`));
  assert.ok(locs.includes(`${ORIGIN}/site/aktualnosci/${post.id}`));
  assert.ok(locs.includes(`${ORIGIN}/site/wydarzenia/${event.id}`));
  assert.equal(locs.some((loc) => loc.includes(gone.id) || loc.includes(draft.id)), false);
}));

test('serwer Node: strona publiczna przez siteHandler z CSP stron statycznych; robots.txt z mapą tylko przy PUBLIC_BASE_URL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rd-public-site-'));
  await mkdir(join(root, 'site'), { recursive: true });
  await writeFile(join(root, 'site', 'index.html'), BUILT_TEMPLATE);
  await writeFile(join(root, 'site', 'main.js'), 'export {};');
  const calls = [];
  const siteHandler = async (req, env, { template }) => {
    calls.push(new URL(req.url).pathname);
    const path = new URL(req.url).pathname;
    if (path === '/site/aktualnosci/brak') return new Response('<p>brak</p>', { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' } });
    if (path === '/site/') return new Response(template.includes('news-list') ? '<p>ok</p>' : 'bez szablonu', { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' } });
    return null;
  };
  const handler = createNodeHandler({
    distRoot: root, fetchHandler: async () => Response.json({ error: 'not_found' }, { status: 404 }), siteHandler,
    publicBaseUrl: 'https://rd.example.invalid', logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const index = await fetch(`${base}/site/`);
    assert.equal(await index.text(), '<p>ok</p>');
    assert.match(index.headers.get('content-security-policy'), /script-src 'self'; style-src 'self'/);
    assert.equal(index.headers.get('x-frame-options'), 'DENY');
    assert.equal(index.headers.get('cache-control'), 'public, max-age=60');
    assert.equal(index.headers.get('x-robots-tag'), null);
    const missing = await fetch(`${base}/site/aktualnosci/brak`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('x-robots-tag'), 'noindex, nofollow');
    // siteHandler zwraca null: plik statyczny (index.html) albo dalej do API.
    const fallback = await fetch(`${base}/site/index.html`);
    assert.equal(fallback.status, 200);
    assert.ok((await fallback.text()).includes('news-list'));
    // Pliki statyczne nie przechodzą przez siteHandler.
    const asset = await fetch(`${base}/site/main.js`);
    assert.equal(asset.status, 200);
    assert.equal(calls.includes('/site/main.js'), false);
    const robots = await (await fetch(`${base}/robots.txt`)).text();
    assert.ok(robots.endsWith('Sitemap: https://rd.example.invalid/site/sitemap.xml\n'));
    assert.match(robots, /Disallow: \/admin\//);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(robotsTxtBody(undefined, true).includes('Sitemap'), false);
  assert.equal(robotsTxtBody('https://rd.example.invalid', false).includes('Sitemap'), false);
  assert.equal(robotsTxtBody('javascript:alert(1)', true).includes('Sitemap'), false);
  assert.deepEqual(classifyRequest('/site/feed.xml', ''), { cls: 'public', session: null });
});

test('strona główna: informacja o przetwarzaniu danych tylko z opublikowanej wersji; brak publikacji = neutralny komunikat (#145)', () => withDb(async ({ db }) => {
  const missing = await site(db, '/site/');
  assert.equal(missing.status, 200);
  assert.ok(missing.text.includes('Informacja o przetwarzaniu danych nie została jeszcze opublikowana.'));
  assert.ok(missing.text.includes('<dl class="minutes-meta" id="privacy-meta" hidden></dl>'));
  assert.ok(missing.text.includes('href="#informacja-o-danych"'));

  const author = await seedUserSession(db, { userId: 'u-author', roles: [{ role: 'admin' }], mfa: true });
  const approver = await seedUserSession(db, { userId: 'u-approver', roles: [{ role: 'board' }], mfa: true });
  const env = { db };
  const call = async (path, cookie, body) => {
    const response = await handlePgRequest(request(path, { method: 'POST', cookie, body }), env);
    return { status: response.status, data: await response.json() };
  };
  const created = await call('/api/admin/privacy-notices', author, { bodyText: 'Treść syntetyczna <b>x</b> & "y".\nDruga linia.', decisionRef: 'D-06/test' });
  assert.equal(created.status, 201);
  const id = created.data.notice.id;
  assert.equal((await site(db, '/site/')).text.includes('Treść syntetyczna'), false, 'szkic niewidoczny');
  assert.equal((await call(`/api/admin/privacy-notices/${id}/approve`, approver)).status, 200);
  assert.equal((await site(db, '/site/')).text.includes('Treść syntetyczna'), false, 'zatwierdzona, ale nieopublikowana — niewidoczna');
  assert.equal((await call(`/api/admin/privacy-notices/${id}/publish`, approver)).status, 200);

  const published = await site(db, '/site/');
  assert.ok(published.text.includes('<div class="privacy-text" id="privacy-text">Treść syntetyczna &lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;.\nDruga linia.</div>'));
  assert.equal(published.text.includes('<b>x</b>'), false);
  assert.match(published.text, /<dl class="minutes-meta" id="privacy-meta"><dt>Wersja<\/dt><dd>1<\/dd><dt>Data publikacji<\/dt><dd>[^<]+<\/dd><\/dl>/);
  assert.equal(published.text.includes('nie została jeszcze opublikowana'), false);
  for (const leak of ['u-author', 'u-approver', 'D-06/test', 'decisionRef']) {
    assert.equal(published.text.includes(leak), false, `strona ujawnia ${leak}`);
  }
  const eventPage = await site(db, '/site/wydarzenia/nie-ma');
  assert.ok(eventPage.text.includes('href="/site/#informacja-o-danych"'), 'link w nawigacji i stopce stron serwera');
}));
