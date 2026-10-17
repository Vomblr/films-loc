import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMetadataLookup, parseKinopoiskInput, metadataFromEntity, displayTitle } from '../metadata.mjs';

const statement = (v, extra = {}) => ({ rank: 'normal', mainsnak: { snaktype: 'value', datavalue: { value: v } }, ...extra });
const time = date => ({ time: `+${date}T00:00:00Z`, precision: 11 });
const film = { id: 'Q1', labels: { ru: { value: 'Тестовый фильм' } }, claims: {
  P2603: [statement('123')], P1476: [statement({ text: 'Original', language: 'en' })],
  P577: [statement(time('2025-03-01'), { rank: 'preferred' }), statement(time('2024-12-01'))],
  P2754: [statement(time('2023-01-01'))], P571: [statement(time('2022-01-01'))]
} };
const series = { ...film, id: 'Q2', claims: { ...film.claims, P31: [statement({ id: 'Q5398426' })],
  P580: [statement(time('2020-06-01'))],
  P527: [statement({ id: 'Q3' }, { qualifiers: { P1545: [{ datavalue: { value: '2' } }] } })]
} };
const season = { id: 'Q3', claims: { P31: [statement({ id: 'Q3464665' })], P580: [statement(time('2022-06-01'))] } };
const input = parseKinopoiskInput({ url: 'https://kinopoisk.ru/film/123/?utm_source=share#trailer' });

test('lookup accepts only exact HTTPS Kinopoisk card IDs and validates season numbers', () => {
  assert.equal(input.url, 'https://www.kinopoisk.ru/film/123/');
  for (const url of ['http://kinopoisk.ru/film/123/', 'https://kinopoisk.ru.evil.org/film/123/', 'https://user:pass@kinopoisk.ru/film/123/',
    'https://kinopoisk.ru:81/film/123/', 'https://127.0.0.1/film/123/', 'https://kinopoisk.ru/film/123/episodes/', 'https://kinopoisk.ru/index.php?kp_query=123'])
    assert.throws(() => parseKinopoiskInput({ url }));
  for (const n of [0, -1, 101, 1.5, '2', true]) assert.throws(() => parseKinopoiskInput({ url: input.url, season: n }));
});

test('first release includes festivals and ignores production, inception, and regional preferred rank', () => {
  const m = metadataFromEntity(film, input);
  assert.equal(m.releaseYear, 2024); assert.equal(m.premiereDate, '2024-12-01');
  assert.equal(displayTitle(m), 'Тестовый фильм (Original)');
  const deprecated = structuredClone(film); deprecated.claims.P577.push(statement(time('1990-01-01'), { rank: 'deprecated' }));
  assert.equal(metadataFromEntity(deprecated, input).releaseYear, 2024);
  assert.throws(() => metadataFromEntity(film, { ...input, id: '456' }), /ID/);
});

test('a series uses first broadcast and a specific season uses its own date without series-year fallback', () => {
  assert.equal(metadataFromEntity(series, input).releaseYear, 2020);
  const m = metadataFromEntity(series, { ...input, season: 2 }, season);
  assert.equal(m.releaseYear, 2022); assert.equal(m.yearKind, 'season-release');
  assert.equal(displayTitle(m), 'Тестовый фильм, 2 сезон (Original)');
  const missing = metadataFromEntity(series, { ...input, season: 99 });
  assert.equal(missing.releaseYear, null); assert.match(missing.warnings.join(' '), /сезона/);
  assert.throws(() => metadataFromEntity(film, { ...input, season: 2 }), /только у сериала/);
});

test('unconfirmed translations and production-only years are left for manual input', () => {
  const incomplete = structuredClone(film); delete incomplete.claims.P577; delete incomplete.claims.P1476;
  incomplete.labels.en = { value: 'English translation, not necessarily original' };
  const m = metadataFromEntity(incomplete, input);
  assert.equal(m.releaseYear, null); assert.equal(m.originalTitle, ''); assert.equal(m.warnings.length, 2);
  assert.equal(displayTitle({ russianTitle: 'За нас с вами', originalTitle: 'За нас с вами' }), 'За нас с вами');
});

test('remote lookup verifies the exact external ID, reads season data, deduplicates and caches requests', async () => {
  const requests = [];
  const lookup = createMetadataLookup({ fetchImpl: async (url, options) => {
    assert.equal(url.origin, 'https://www.wikidata.org'); assert.equal(url.pathname, '/w/api.php');
    assert.equal(options.redirect, 'error'); assert.match(options.headers['User-Agent'], /FilmsLoc/);
    requests.push(url.href);
    return Response.json(url.searchParams.get('action') === 'query' ? { query: { search: [{ title: 'Q2' }] } }
      : { entities: url.searchParams.get('ids') === 'Q3' ? { Q3: season } : { Q2: series } });
  } });
  const body = { url: input.url, season: 2 };
  const [a, b] = await Promise.all([lookup(body), lookup(body)]);
  assert.equal(a.releaseYear, 2022); assert.deepEqual(a, b); assert.equal(requests.length, 3);
  await lookup(body); assert.equal(requests.length, 3);
});

test('unavailable sources, missing matches and numbered episodes do not manufacture season years', async () => {
  const missing = createMetadataLookup({ fetchImpl: async () => Response.json({ query: { search: [] } }) });
  await assert.rejects(missing({ url: input.url }), e => e.status === 404);
  const unavailable = createMetadataLookup({ fetchImpl: async () => { throw new Error('network'); } });
  await assert.rejects(unavailable({ url: input.url }), e => e.status === 502);
  const episode = { ...season, claims: { ...season.claims, P31: [statement({ id: 'Q21191270' })] } };
  const lookup = createMetadataLookup({ fetchImpl: async url => Response.json(url.searchParams.get('action') === 'query'
    ? { query: { search: [{ title: 'Q2' }] } } : { entities: url.searchParams.get('ids') === 'Q3' ? { Q3: episode } : { Q2: series } }) });
  assert.equal((await lookup({ url: input.url, season: 2 })).releaseYear, null);
});

test('verified home catalog keeps reviewed first-premiere and season exceptions available offline', async () => {
  const catalog = JSON.parse(readFileSync(new URL('../metadata-catalog.json', import.meta.url), 'utf8'));
  const lookup = createMetadataLookup({ catalog, fetchImpl: () => { throw new Error('Must not access network'); }, now: () => Date.parse('2026-10-17') });
  for (const entry of catalog) {
    const m = await lookup({ url: entry.kinopoiskUrl, season: entry.season });
    assert.equal(m.releaseYear, entry.releaseYear); assert.ok(m.title); assert.equal(m.source, 'Проверенный каталог');
  }
  const mob = catalog.find(e => e.originalTitle === 'Stranger Things' && e.season === 2);
  assert.equal((await lookup({ url: mob.kinopoiskUrl, season: 2 })).releaseYear, 2017);
  assert.equal((await lookup({ url: mob.kinopoiskUrl })).releaseYear, 2016);
});
