// #152: bramka danych osobowych dla tytułu/treści aktualności i tytułu/opisu
// wydarzenia (rewizje są niezmienne). Wyłącznie dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraft as createNews, updateDraft as updateNews, withdraw as withdrawNews } from '../src/pg/news.js';
import { createDraft as createEvent, updateDraft as updateEvent, cancel as cancelEvent } from '../src/pg/events.js';
import { createTestDb, seedClass, seedEnrolledHousehold, seedSchoolYear, seedUser } from './helpers/pg.js';

async function setup() {
  const db = await createTestDb();
  await seedSchoolYear(db, 'y2026');
  const classId = await seedClass(db, { id: 'cls-a', schoolYearId: 'y2026', name: 'Klasa A' });
  await seedEnrolledHousehold(db, 'h1', ['y2026'], { classIds: { y2026: classId } });
  await seedUser(db, { userId: 'u-rep' });
  await seedUser(db, { userId: 'u-board' });
  const rep = { userId: 'u-rep', grants: [{ role: 'representative', classId, schoolYearId: 'y2026' }], mfaVerified: true };
  const board = { userId: 'u-board', grants: [{ role: 'board', classId: null, schoolYearId: 'y2026' }], mfaVerified: true };
  const count = async (sql) => Number((await db.query(sql)).rows[0].n);
  const audit = async (action) => {
    const { rows } = await db.query('SELECT metadata_json FROM audit_events WHERE action = $1 ORDER BY occurred_at DESC LIMIT 1', [action]);
    const raw = rows[0]?.metadata_json;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  };
  return { db, classId, rep, board, count, audit };
}

const newsInput = (classId, overrides = {}) => ({
  schoolYearId: 'y2026', classId, title: 'Wycieczka klasy A', body: 'Zbiórka o ósmej przed szkołą.',
  idempotencyKey: 'news-pii-0001', ...overrides,
});

test('#152 aktualności: przedstawiciel klasy z imieniem i nazwiskiem dziecka dostaje ostrzeżenie, zapis po potwierdzeniu (jeden wpis przy ponowieniu)', async () => {
  const { db, classId, rep, count, audit } = await setup();
  try {
    const input = newsInput(classId, { body: 'Gratulacje dla Syntetyczny Uczeń za konkurs.' });
    await assert.rejects(createNews(db, rep, input), (error) => {
      assert.equal(error.code, 'possible_personal_data');
      assert.equal(error.status, 422);
      assert.deepEqual(error.extra.categories, ['known_name']);
      assert.ok(!JSON.stringify(error.extra).includes('Uczeń'));
      return true;
    });
    assert.equal(await count('SELECT count(*)::int AS n FROM news_posts'), 0);
    const first = await createNews(db, rep, { ...input, confirmPersonalData: true });
    const again = await createNews(db, rep, { ...input, confirmPersonalData: true });
    assert.equal(first.replayed, false);
    assert.equal(again.replayed, true);
    assert.equal(await count('SELECT count(*)::int AS n FROM news_post_revisions'), 1);
    const metadata = await audit('news_post.created');
    assert.equal(metadata.piiConfirmed, true);
    assert.deepEqual(metadata.piiCategories, ['known_name']);
    assert.ok(!JSON.stringify(metadata).includes('Uczeń'));
  } finally { await db.close(); }
});

test('#152 aktualności: e-mail i IBAN w treści są odrzucane bez obejścia, rewizja pyta tylko o zmienione pola', async () => {
  const { db, classId, rep, board, count } = await setup();
  try {
    await assert.rejects(
      createNews(db, rep, newsInput(classId, { body: 'Pisz: rodzic@example.invalid', confirmPersonalData: true })),
      { code: 'personal_data_forbidden', status: 422 },
    );
    await assert.rejects(
      createNews(db, rep, newsInput(classId, { title: 'Wpłata BE68 5390 0754 7034', confirmPersonalData: true })),
      { code: 'personal_data_forbidden', status: 422 },
    );
    assert.equal(await count('SELECT count(*)::int AS n FROM news_posts'), 0);
    const { post } = await createNews(db, board, newsInput(null, { idempotencyKey: 'news-pii-0002' }));
    await assert.rejects(
      updateNews(db, board, { postId: post.id, revision: 1, body: 'Nowy opis, tel. +32 470 12 34 56' }),
      { code: 'possible_personal_data', status: 422 },
    );
    assert.equal(await count('SELECT count(*)::int AS n FROM news_post_revisions'), 1);
    const updated = await updateNews(db, board, { postId: post.id, revision: 1, body: 'Nowy opis, tel. +32 470 12 34 56', confirmPersonalData: true });
    assert.equal(updated.post.revision, 2);
    // Zmiana samego tytułu nie wymaga ponownego potwierdzenia starej treści.
    const retitled = await updateNews(db, board, { postId: post.id, revision: 2, title: 'Nowy tytuł wycieczki' });
    assert.equal(retitled.post.revision, 3);
  } finally { await db.close(); }
});

test('#152 wydarzenia: tytuł i opis z danymi dziecka wymagają potwierdzenia, e-mail jest odrzucany, aktualizacja pyta o zmienione pola', async () => {
  const { db, classId, rep, count, audit } = await setup();
  try {
    const base = {
      schoolYearId: 'y2026', classId, startsAt: '2026-11-12T10:00', audience: 'internal',
      title: 'Piknik klasowy', idempotencyKey: 'event-pii-0001',
    };
    await assert.rejects(
      createEvent(db, rep, { ...base, description: 'Rodzic Syntetyczny Uczeń przyniesie ciasto' }),
      (error) => error.code === 'possible_personal_data' && error.status === 422
        && error.extra.categories.length === 1 && error.extra.categories[0] === 'known_name',
    );
    await assert.rejects(
      createEvent(db, rep, { ...base, description: 'Kontakt rodzic@example.invalid', confirmPersonalData: true }),
      { code: 'personal_data_forbidden', status: 422 },
    );
    assert.equal(await count('SELECT count(*)::int AS n FROM events'), 0);
    const created = await createEvent(db, rep, { ...base, description: 'Rodzic Syntetyczny Uczeń przyniesie ciasto', confirmPersonalData: true });
    assert.equal(created.replayed, false);
    assert.equal(await count('SELECT count(*)::int AS n FROM event_revisions'), 1);
    const metadata = await audit('event.created');
    assert.equal(metadata.piiConfirmed, true);
    assert.ok(!JSON.stringify(metadata).includes('Uczeń'));
    // Zmiana innego pola nie pyta ponownie o niezmieniony opis.
    const moved = await updateEvent(db, rep, { eventId: created.event.id, revision: 1, location: 'Sala gimnastyczna' });
    assert.equal(moved.event.revision, 2);
    await assert.rejects(
      updateEvent(db, rep, { eventId: created.event.id, revision: 2, title: 'Piknik, tel. +32 470 12 34 56' }),
      { code: 'possible_personal_data', status: 422 },
    );
    assert.equal(await count('SELECT count(*)::int AS n FROM event_revisions'), 2);
  } finally { await db.close(); }
});

test('#152 wycofanie aktualności: powód z imieniem i nazwiskiem dziecka wymaga potwierdzenia, e-mail jest odrzucany, ponowienie to jeden zapis', async () => {
  const { db, classId, rep, audit } = await setup();
  try {
    const { post } = await createNews(db, rep, newsInput(classId, { idempotencyKey: 'news-pii-0003' }));
    const reasonOf = async () => (await db.query('SELECT status, withdrawal_reason FROM news_posts WHERE id = $1', [post.id])).rows[0];
    await assert.rejects(
      withdrawNews(db, rep, { postId: post.id, revision: 1, reason: 'Rodzic prosi, tel. rodzic@example.invalid', confirmPersonalData: true }),
      { code: 'personal_data_forbidden', status: 422 },
    );
    await assert.rejects(withdrawNews(db, rep, { postId: post.id, revision: 1, reason: 'Na prośbę Syntetyczny Uczeń' }), (error) => {
      assert.equal(error.code, 'possible_personal_data');
      assert.equal(error.status, 422);
      assert.deepEqual(error.extra.categories, ['known_name']);
      assert.ok(!JSON.stringify(error.extra).includes('Uczeń'));
      return true;
    });
    assert.equal((await reasonOf()).status, 'draft');
    const input = { postId: post.id, revision: 1, reason: 'Na prośbę Syntetyczny Uczeń', confirmPersonalData: true };
    assert.equal((await withdrawNews(db, rep, input)).replayed, false);
    assert.equal((await withdrawNews(db, rep, input)).replayed, true);
    assert.equal((await reasonOf()).status, 'withdrawn');
    const metadata = await audit('news_post.withdrawn');
    assert.equal(metadata.piiConfirmed, true);
    assert.deepEqual(metadata.piiCategories, ['known_name']);
    assert.ok(!JSON.stringify(metadata).includes('Uczeń'));
  } finally { await db.close(); }
});

test('#152 odwołanie wydarzenia: powód z telefonem wymaga potwierdzenia, zwykły powód przechodzi bez metadanych PII', async () => {
  const { db, classId, rep, audit } = await setup();
  try {
    const base = { schoolYearId: 'y2026', classId, startsAt: '2026-11-12T10:00', audience: 'internal', title: 'Piknik klasowy' };
    const first = await createEvent(db, rep, { ...base, idempotencyKey: 'event-pii-0002' });
    const second = await createEvent(db, rep, { ...base, idempotencyKey: 'event-pii-0003' });
    await assert.rejects(
      cancelEvent(db, rep, { eventId: first.event.id, revision: 1, reason: 'Pisz na rodzic@example.invalid', confirmPersonalData: true }),
      { code: 'personal_data_forbidden', status: 422 },
    );
    await assert.rejects(
      cancelEvent(db, rep, { eventId: first.event.id, revision: 1, reason: 'Pytania: +32 470 12 34 56' }),
      { code: 'possible_personal_data', status: 422 },
    );
    const status = async (id) => (await db.query('SELECT status FROM events WHERE id = $1', [id])).rows[0].status;
    assert.equal(await status(first.event.id), 'draft');
    const input = { eventId: first.event.id, revision: 1, reason: 'Pytania: +32 470 12 34 56', confirmPersonalData: true };
    assert.equal((await cancelEvent(db, rep, input)).replayed, false);
    assert.equal((await cancelEvent(db, rep, input)).replayed, true);
    assert.equal(await status(first.event.id), 'cancelled');
    assert.equal((await audit('event.cancelled')).piiConfirmed, true);
    await cancelEvent(db, rep, { eventId: second.event.id, revision: 1, reason: 'Zła pogoda' });
    assert.equal(await status(second.event.id), 'cancelled');
    assert.equal((await audit('event.cancelled')).piiConfirmed, undefined);
  } finally { await db.close(); }
});
