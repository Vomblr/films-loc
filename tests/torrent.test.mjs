import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { torrentMessage, torrentRequests, torrentUrl } from '../public/torrent.mjs';

test('Telegram URL carries one complete UTF-8 query to the fixed bot without note or watch data', () => {
  const film = { title: 'Кафе де флер 2011 (Café de Flore)', releaseYear: 2011, note: 'PRIVATE_NOTE', watchedAt: 'PRIVATE_DATE', kinopoiskUrl: 'PRIVATE_URL' };
  const message = torrentMessage(film);
  assert.equal(message, 'Кафе де флер Café de Flore 2011');
  const url = new URL(torrentUrl(message));
  assert.equal(url.origin, 'https://t.me'); assert.equal(url.pathname, '/torrents_2_bot');
  assert.equal(url.searchParams.get('text'), message); assert.equal([...url.searchParams].length, 1);
  assert.ok(!url.href.includes('PRIVATE'));
  const special = 'Русское & ещё (Original + / ? # (Part 2)) 2024';
  assert.equal(new URL(torrentUrl(special)).searchParams.get('text'), special);
});

test('queries preserve season titles, do not invent missing years and remove imported commentary', () => {
  assert.equal(torrentMessage({ title: 'Гангстерлэнд (MobLand)', releaseYear: 2026 }), 'Гангстерлэнд MobLand 2026');
  assert.equal(torrentMessage({ title: 'Очень странные дела, 2 сезон (Stranger Things)', releaseYear: 2017 }), 'Очень странные дела, 2 сезон Stranger Things 2017');
  assert.equal(torrentMessage({ title: 'Плохая мать сериал 2023 (Nappeun eomma)', releaseYear: 2023 }), 'Плохая мать Nappeun eomma 2023');
  assert.equal(torrentMessage({ title: 'Сериал Тьма (Dark)', releaseYear: 2017 }), 'Тьма Dark 2017');
  assert.equal(torrentMessage({ title: 'F1 - example imported comment', releaseYear: 2025 }), 'F1 2025');
  assert.equal(torrentMessage({ title: 'Фильм (Original)', releaseYear: null }), 'Фильм Original');
  assert.equal(torrentMessage({ title: '1917 (1917)', releaseYear: 2019 }), '1917 2019');
  assert.equal(torrentMessage({ title: 'Название 2024 (Title (Part 2))', releaseYear: 2024 }), 'Название Title Part 2 2024');
});

test('the combined Candy/Love & Death row has separate complete queries with its correct premiere years', () => {
  const film = { title: 'Кэнди / Любовь и Смерть (Candy / Love & Death)', releaseYear: 2022,
    additionalLinks: [{ label: 'Любовь и смерть (2023)', url: 'https://www.kinopoisk.ru/series/4468044/' }] };
  assert.deepEqual(torrentRequests(film).map(q => q.message), ['Кэнди Candy 2022', 'Любовь и смерть Love & Death 2023']);
});

test('every imported entry generates usable links, including titles with Cyrillic and original punctuation', () => {
  const seed = JSON.parse(readFileSync(new URL('../seed.json', import.meta.url), 'utf8'));
  for (const film of seed.films) {
    const requests = torrentRequests(film);
    assert.ok(requests.length);
    for (const query of requests) {
      assert.ok(query.message.length > 4 && query.message.length < 4096);
      assert.ok(!/[()]/.test(query.message));
      assert.equal(new URL(torrentUrl(query.message)).searchParams.get('text'), query.message);
    }
  }
});
