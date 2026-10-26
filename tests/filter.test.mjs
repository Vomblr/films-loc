import test from 'node:test';
import assert from 'node:assert/strict';
import { filmKind, filterFilms, sortFilms } from '../public/sort.mjs';

const sample = [
  { id: 'series-old', title: 'Сериал (Series)', note: 'Детектив', kinopoiskUrl: 'https://www.kinopoisk.ru/series/101/', watched: true, watchedAt: '2025-01-01', sourceOrder: 0 },
  { id: 'film-planned', title: 'Фильм (Film)', note: 'О съёмках сериала', kinopoiskUrl: 'https://www.kinopoisk.ru/film/102/', watched: false, releaseYear: 2011, sourceOrder: 1 },
  { id: 'series-planned', title: 'Ёлка, 2 сезон (Original)', note: 'Северный детектив', kinopoiskUrl: 'https://www.kinopoisk.ru/series/103/', watched: false, releaseYear: 2020, sourceOrder: 2 },
  { id: 'series-new', title: 'Новый сериал', note: '', kinopoiskUrl: 'https://www.kinopoisk.ru/series/104/', watched: true, watchedAt: '2026-01-01', sourceOrder: 3 },
  { id: 'no-card', title: 'Без ссылки', note: '', kinopoiskUrl: '', watched: false, sourceOrder: 4 }
];

test('type comes from the exact Kinopoisk card, including season entries and shared links', () => {
  assert.equal(filmKind({ kinopoiskUrl: 'https://kinopoisk.ru/series/103?socialAlias=example#details' }), 'series');
  assert.equal(filmKind(sample[1]), 'film');
  assert.equal(filmKind(sample[2]), 'series');
  for (const url of ['', 'series/103', 'http://kinopoisk.ru/series/103/', 'https://kinopoisk.ru.evil.example/series/103/',
    'https://user:example@kinopoisk.ru/series/103/', 'https://kinopoisk.ru/series/103/episodes/', 'https://kinopoisk.ru/index.php?kp_query=series'])
    assert.equal(filmKind({ kinopoiskUrl: url }), null);
});

test('type, watch status, Russian/original search, year, and note combine without mixing films and series', () => {
  const ids = options => filterFilms(sample, options).map(f => f.id);
  assert.deepEqual(ids({ kind: 'series', status: 'planned' }), ['series-planned']);
  assert.deepEqual(ids({ kind: 'series', status: 'watched' }), ['series-old', 'series-new']);
  for (const query of ['  елка  ', 'ORIGINAL', '2020', 'северный'])
    assert.deepEqual(ids({ kind: 'series', status: 'planned', query }), ['series-planned']);
  assert.deepEqual(ids({ kind: 'film', query: 'сериала' }), ['film-planned']);
  assert.deepEqual(ids({ kind: 'series', query: '2011' }), []);
});

test('unclassified entries remain under All; filtering preserves records and planned-before-watched date ordering', () => {
  const before = JSON.stringify(sample);
  assert.equal(filterFilms(sample).length, sample.length);
  assert.ok(!filterFilms(sample, { kind: 'film' }).some(f => f.id === 'no-card'));
  assert.ok(!filterFilms(sample, { kind: 'series' }).some(f => f.id === 'no-card'));
  const ordered = sortFilms(filterFilms(sample, { kind: 'series' }), 'watched-desc');
  assert.deepEqual(ordered.map(f => f.id), ['series-planned', 'series-new', 'series-old']);
  assert.equal(JSON.stringify(sample), before);
});
