import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { validateFilm } from '../lib.mjs';
import { sortFilms } from '../public/sort.mjs';

test('watched entries stay below planned entries; unknown dates stay last in either date direction', () => {
  const sample = [
    { id: 'note-1', title: 'А', watched: true, watchedAt: '2025-01-01', sourceOrder: 0 },
    { id: 'note-2', title: 'Я', watched: false, watchedAt: null, sourceOrder: 1 },
    { id: 'note-3', title: 'Б', watched: true, watchedAt: null, sourceOrder: 2 },
    { id: 'note-4', title: 'В', watched: true, watchedAt: '2026-01-01', sourceOrder: 3 }
  ];
  assert.deepEqual(sortFilms(sample, 'watched-desc').map(f => f.id), ['note-2', 'note-4', 'note-1', 'note-3']);
  assert.deepEqual(sortFilms(sample, 'watched-asc').map(f => f.id), ['note-2', 'note-1', 'note-4', 'note-3']);
  assert.equal(sortFilms(sample, 'title')[0].id, 'note-2');
});
test('validates actual calendar dates and Kinopoisk URLs', () => {
  assert.throws(() => validateFilm({ title: 'Фильм', watched: true, watchedAt: '2026-02-30' }));
  for (const url of ['javascript:alert(1)', 'https://kinopoisk.ru.evil.example/1', 'https://name:secret@kinopoisk.ru/1'])
    assert.throws(() => validateFilm({ title: 'Фильм', kinopoiskUrl: url }));
  assert.equal(validateFilm({ title: '  Фильм ', kinopoiskUrl: 'https://www.kinopoisk.ru/film/123/' }).title, 'Фильм');
  assert.throws(() => validateFilm({ title: 'Фильм', releaseYear: 2025.5 }));
  assert.throws(() => validateFilm({ title: 'Фильм', releaseYear: 1887 }));
  assert.throws(() => validateFilm({ title: 'Фильм', additionalLinks: [{ label: 'Другой фильм', url: 'javascript:alert(1)' }] }));
});

test('API preserves import flags, persists updates across restart, and blocks cross-origin and stale writes', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const testData = path.resolve(root, '.test-data', `api-test-${Date.now()}`);
  mkdirSync(testData, { recursive: true });
  // Start from the original deployed schema to exercise the upgrade in place.
  const legacy = new DatabaseSync(path.join(testData, 'films.sqlite'));
  legacy.exec(`CREATE TABLE films (id TEXT PRIMARY KEY,title TEXT NOT NULL,note TEXT NOT NULL,kinopoisk_url TEXT NOT NULL,watched INTEGER NOT NULL,watched_at TEXT,marked_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,source_order INTEGER NOT NULL,source_text TEXT,version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO metadata VALUES ('seeded','original');`);
  const oldInsert = legacy.prepare('INSERT INTO films (id,title,note,kinopoisk_url,watched,watched_at,marked_at,created_at,updated_at,source_order,source_text) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const seed = JSON.parse(readFileSync(path.join(root, 'seed.json'), 'utf8'));
  for (const f of seed.films) oldInsert.run(f.id, f.title, f.note, f.kinopoiskUrl, Number(f.watched), null, null, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', f.sourceOrder, f.sourceText);
  legacy.close();
  const origin = 'http://127.0.0.1:18081';
  let child;
  async function start() {
    child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'server.mjs')], {
      env: { ...process.env, FILMS_DATA_DIR: testData, PORT: '18081', HOST: '127.0.0.1', FILMS_AVAILABILITY_NETWORK: '0', FILMS_RATINGS_NETWORK: '0' }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null) throw new Error(log);
      try { const r = await fetch(origin + '/api/films'); if (r.ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 75));
    }
    throw new Error('Server did not become ready: ' + log);
  }
  async function stop() { if (child && child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } }
  const send = (url, method, body, headers = {}) => fetch(origin + url, { method, headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body) });
  try {
    await start();
    const imported = (await (await fetch(origin + '/api/films')).json()).films;
    assert.equal(imported.length, seed.films.length); assert.equal(imported.filter(f => f.watched).length, seed.films.filter(f => f.watched).length);
    assert.ok(imported.every(f => f.watchedAt === null && f.markedAt === null));
    assert.ok(imported.every(f => f.releaseYear === null && f.deletedAt === null));
    assert.ok(imported.every(f => f.kinopoiskAvailability.status === 'unknown' && f.kinopoiskAvailabilityOverride === null));
    assert.ok(imported.every(f => f.kinopoiskStats.rating === null && f.kinopoiskStats.positiveReviews === null));
    assert.equal(imported.find(f => f.id === seed.films.find(f => !f.watched).id).watched, false);
    assert.equal(imported.find(f => f.id === seed.films.find(f => f.watched).id).watched, true);
    assert.equal((await send('/api/kinopoisk/lookup', 'POST', { url: 'https://www.kinopoisk.ru/film/447301/' }, { Origin: 'http://example.org' })).status, 403);
    assert.equal((await send('/api/kinopoisk/lookup', 'POST', { url: 'https://127.0.0.1/admin' })).status, 400);
    assert.equal((await send('/api/kinopoisk/availability', 'POST', { url: 'https://127.0.0.1/admin' })).status, 400);
    assert.equal((await send('/api/kinopoisk/ratings', 'POST', { url: 'https://127.0.0.1/admin' })).status, 400);
    assert.equal((await send('/api/kinopoisk/ratings', 'POST', { url: 'https://www.kinopoisk.ru/film/447301/' }, { Origin: 'http://example.org' })).status, 403);
    assert.equal((await send('/api/kinopoisk/availability', 'POST', { url: 'https://www.kinopoisk.ru/film/447301/' }, { Origin: 'http://example.org' })).status, 403);
    const metadataResponse = await send('/api/kinopoisk/lookup', 'POST', { url: 'https://www.kinopoisk.ru/film/447301/' });
    assert.equal(metadataResponse.status, 200);
    const lookup = (await metadataResponse.json()).metadata;
    assert.equal(lookup.title, 'Начало (Inception)'); assert.equal(lookup.releaseYear, 2010);
    assert.equal((await (await fetch(origin + '/api/films')).json()).films.length, seed.films.length);
    const created = await send('/api/films', 'POST', { title: '<script>Проверка</script>', kinopoiskUrl: 'https://www.kinopoisk.ru/film/123/', note: 'API test', releaseYear: 1997, kinopoiskAvailabilityOverride: 'available',
      additionalLinks: [{ label: 'Другой сериал', url: 'https://www.kinopoisk.ru/series/789/' }] });
    assert.equal(created.status, 201); const f = (await created.json()).film;
    assert.equal(f.kinopoiskAvailability.status, 'available'); assert.equal(f.kinopoiskAvailability.source, 'manual'); assert.ok(f.kinopoiskAvailabilityMarkedAt);
    assert.equal(f.kinopoiskAdditionalStats[0].label, 'Другой сериал'); assert.equal(f.kinopoiskAdditionalStats[0].stats.rating, null);
    const changed = await send('/api/films/' + f.id, 'PATCH', { version: f.version, watched: true, watchedAt: '2026-01-02' });
    assert.equal(changed.status, 200); const seen = (await changed.json()).film;
    assert.equal(seen.watchedAt, '2026-01-02'); assert.ok(seen.markedAt);
    const conflict = await send('/api/films/' + f.id, 'PATCH', { version: f.version, title: 'Stale write' });
    assert.equal(conflict.status, 409);
    const concurrent = await Promise.all(['Device A', 'Device B'].map(note => send('/api/films/' + f.id, 'PATCH', { version: seen.version, note })));
    assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409]);
    assert.equal((await send('/api/films', 'POST', { title: 'Blocked' }, { Origin: 'http://example.org' })).status, 403);
    assert.equal((await send('/api/films', 'POST', { title: 'Bad URL', kinopoiskUrl: 'javascript:alert(1)' })).status, 400);
    assert.equal((await fetch(origin + '/data/films.sqlite')).status, 404);
    const exported = await (await fetch(origin + '/api/export')).json(); assert.equal(exported.films.length, seed.films.length + 1);
    await stop();
    const cachedDb = new DatabaseSync(path.join(testData, 'films.sqlite'));
    const stamp = new Date().toISOString();
    cachedDb.prepare('INSERT INTO kinopoisk_ratings VALUES (?,?)').run('123', JSON.stringify({ id: '123', rating: 7.5, positiveReviews: 2, negativeReviews: 1,
      neutralReviews: 2, totalReviews: 5, ratingCheckedAt: stamp, reviewsCheckedAt: stamp, checkedAt: stamp, attemptedAt: stamp, status: 'ok' }));
    cachedDb.close(); await start();
    const saved = (await (await fetch(origin + '/api/films')).json()).films.find(item => item.id === f.id);
    assert.equal(saved.title, '<script>Проверка</script>'); assert.equal(saved.watchedAt, '2026-01-02'); assert.equal(saved.markedAt, seen.markedAt);
    assert.equal(saved.releaseYear, 1997);
    assert.equal(saved.kinopoiskStats.rating, 7.5); assert.equal(saved.kinopoiskStats.positiveReviews, 2);
    assert.equal(saved.kinopoiskAvailability.status, 'available'); assert.equal(saved.kinopoiskAvailabilityMarkedAt, f.kinopoiskAvailabilityMarkedAt);
    const deletedResponse = await send('/api/films/' + f.id, 'PATCH', { version: saved.version, deleted: true });
    const deleted = (await deletedResponse.json()).film; assert.ok(deleted.deletedAt);
    assert.equal((await (await fetch(origin + '/api/films')).json()).films.length, seed.films.length);
    assert.equal((await (await fetch(origin + '/api/trash')).json()).films.length, 1);
    assert.equal((await (await fetch(origin + '/api/export')).json()).trash[0].id, f.id);
    assert.equal((await send('/api/films/' + f.id, 'PATCH', { version: deleted.version, title: 'Hidden change' })).status, 409);
    await stop(); await start();
    assert.equal((await (await fetch(origin + '/api/trash')).json()).films[0].deletedAt, deleted.deletedAt);
    const restoredResponse = await send('/api/films/' + f.id, 'PATCH', { version: deleted.version, deleted: false });
    const restored = (await restoredResponse.json()).film;
    assert.equal(restored.deletedAt, null); assert.equal(restored.watchedAt, saved.watchedAt); assert.equal(restored.markedAt, saved.markedAt); assert.equal(restored.releaseYear, 1997);
    assert.equal((await (await fetch(origin + '/api/trash')).json()).films.length, 0);
    const unwatch = await send('/api/films/' + f.id, 'PATCH', { version: restored.version, watched: false });
    const unmarked = (await unwatch.json()).film; assert.equal(unmarked.watchedAt, null); assert.equal(unmarked.markedAt, null);
    const relinkedResponse = await send('/api/films/' + f.id, 'PATCH', { version: unmarked.version, kinopoiskUrl: 'https://www.kinopoisk.ru/film/456/' });
    const relinked = (await relinkedResponse.json()).film;
    assert.equal(relinked.kinopoiskAvailability.status, 'unknown'); assert.equal(relinked.kinopoiskAvailabilityOverride, null); assert.equal(relinked.kinopoiskAvailabilityMarkedAt, null);
    assert.equal(relinked.kinopoiskStats.rating, null); assert.equal(relinked.kinopoiskStats.positiveReviews, null);
  } finally { await stop(); }
});
