import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKinopoiskRating, parseKinopoiskViewerReviews } from '../ratings-parser.mjs';
import { createRatingsLookup } from '../ratings.mjs';
import { ratingPresentation, ratingLinks } from '../public/ratings.mjs';

function card({ id = 461939, type = 'Film', value = 8.094, active = true, total = 147 } = {}) {
  const field = type === 'Film' ? 'film' : 'tvSeries';
  const state = { ROOT_QUERY: { [`${field}({"id":${id}})`]: { __ref: `${type}:${id}` } },
    [`${type}:${id}`]: { __typename: type, id, title: { original: 'A {quoted} "title"' }, rating: {
      kinopoisk: { value, isActive: active, count: 822699 }, imdb: { value: 3.2, count: 12 }, worldwideCritics: { positiveCount: 143, negativeCount: 29 }
    }, 'userReviews({"limit":0})': { total } } };
  return `<script>window.Ya.__ssr_initial_data = ${JSON.stringify({ apolloState: state })};window.unexecuted=true;</script>`
    + `<script id="__NEXT_DATA__">${JSON.stringify({ props: { apolloState: { data: {} }, pageProps: { [field + 'Id']: id } } })}</script>`;
}
function reviews({ id = 461939, positive = 117, negative = 7, neutral = 17, total = positive + negative + neutral } = {}) {
  const counter = (name, label, value, status) => `<li class="${name}">${status ? `<a href="/film/${id}/reviews/?status=${status}">` : ''}${label}: <b>${value}</b>${status ? '</a>' : ''}</li>`;
  return `<a class="all" href="/film/${id}/">К описанию фильма</a><ul class="resp_type">`
    + counter('all', 'Все', total) + counter('pos', 'Положительные', positive, 'good')
    + counter('neg', 'Отрицательные', negative, 'bad') + counter('neut', 'Нейтральные', neutral, 'neutral') + '</ul>';
}
const input = { url: 'https://www.kinopoisk.ru/film/461939/?socialAlias=example' };

test('rating parsing verifies the exact main-card identity and selects Kinopoisk rather than IMDb or critics', () => {
  const parsed = parseKinopoiskRating(card(), 461939);
  assert.equal(parsed.value, 8.094); assert.equal(parsed.votes, 822699);
  assert.equal(parseKinopoiskRating(card({ id: 447301 }), 461939), null);
  assert.equal(parseKinopoiskRating(card().replace('Film:461939', 'Film:999'), 461939), null);
  assert.equal(parseKinopoiskRating(card().replace('"isActive":true,', ''), 461939), null);
  assert.equal(parseKinopoiskRating(card({ id: 915196, type: 'TvSeries' }), 915196).entityType, 'TvSeries');
  assert.equal(parseKinopoiskRating(card({ value: null }), 461939).value, null);
  assert.equal(parseKinopoiskRating(card({ active: false }), 461939).value, null);
  assert.equal(parseKinopoiskRating(card({ value: 11 }), 461939), null);
});

test('viewer-review counters require matching identity, sentiment links, complete integer counts, and internally consistent totals', () => {
  assert.deepEqual(parseKinopoiskViewerReviews(reviews(), 461939), { id: 461939, positive: 117, negative: 7, neutral: 17, total: 141 });
  const zeros = reviews({ positive: 0, negative: 0, neutral: 0 });
  assert.equal(parseKinopoiskViewerReviews(zeros, 461939).positive, 0);
  const noLinksAtZero = zeros.replace(/<a href="\/film\/461939\/reviews\/\?status=[^"]+">([^<]+<b>0<\/b>)<\/a>/g, '$1');
  assert.equal(parseKinopoiskViewerReviews(noLinksAtZero, 461939).negative, 0);
  for (const html of [reviews({ id: 123 }), reviews({ total: 999 }), reviews().replace('status=good', 'status=bad'),
    reviews().replace('<b>117</b>', '<b>117.5</b>'), reviews().replace('<b>7</b>', ''), reviews() + reviews(), '<h1>Нет данных</h1>'])
    assert.equal(parseKinopoiskViewerReviews(html, 461939), null);
});

test('lookup keeps modern totals separate from viewer sentiments and deduplicates/cache-persists two-page requests', async () => {
  let calls = 0, clock = Date.parse('2026-10-26T12:00:00Z'); const saved = [];
  const fetchImpl = async url => { calls++; assert.equal(url.hostname, 'www.kinopoisk.ru'); return new Response(url.pathname.endsWith('/reviews/') ? reviews() : card()); };
  const lookup = createRatingsLookup({ fetchImpl, onResult: entry => saved.push(entry), now: () => clock });
  const [a, b] = await Promise.all([lookup.lookup(input), lookup.lookup(input)]);
  assert.equal(calls, 2); assert.deepEqual(a, b); assert.equal(a.rating, 8.094);
  assert.equal(a.positiveReviews, 117); assert.equal(a.negativeReviews, 7); assert.equal(a.totalReviews, 141); assert.equal(a.status, 'ok');
  await lookup.lookup(input); assert.equal(calls, 2); assert.equal(saved.length, 1);
  const restarted = createRatingsLookup({ records: saved, now: () => clock, fetchImpl });
  assert.equal(restarted.peek(input.url).positiveReviews, 117);
  clock += 25 * 3600000; assert.equal(restarted.isFresh(input.url), false); assert.equal(restarted.peek(input.url).stale, true);
});

test('failed review refresh preserves prior counters while a new rating can update independently', async () => {
  let failReviews = false, failAll = false, clock = Date.parse('2026-10-26T12:00:00Z');
  const lookup = createRatingsLookup({ now: () => clock, fetchImpl: async url => {
    if (failAll) throw new Error('offline');
    if (url.pathname.endsWith('/reviews/')) return failReviews ? new Response('', { status: 500 }) : new Response(reviews());
    return new Response(card({ value: failReviews ? 8.2 : 8.094 }));
  } });
  const first = await lookup.lookup(input); clock += 1000; failReviews = true;
  const partial = await lookup.lookup({ ...input, refresh: true });
  assert.equal(partial.rating, 8.2); assert.equal(partial.positiveReviews, 117); assert.equal(partial.status, 'partial');
  assert.equal(partial.reviewsCheckedAt, first.reviewsCheckedAt); assert.notEqual(partial.ratingCheckedAt, first.ratingCheckedAt);
  clock += 1000; failAll = true;
  const failed = await lookup.lookup({ ...input, refresh: true });
  assert.equal(failed.rating, 8.2); assert.equal(failed.negativeReviews, 7); assert.equal(failed.status, 'unknown'); assert.equal(failed.stale, true);
});

test('explicit exact-card zero total proves zero reviews; missing data never becomes zero', async () => {
  const zero = createRatingsLookup({ fetchImpl: async url => new Response(url.pathname.endsWith('/reviews/') ? '<p>Написать рецензию</p>' : card({ value: null, total: 0 })) });
  const result = await zero.lookup(input);
  assert.equal(result.rating, null); assert.equal(result.ratingVotes, 822699); assert.equal(result.positiveReviews, 0); assert.equal(result.negativeReviews, 0); assert.equal(result.status, 'ok');
  const missing = createRatingsLookup({ fetchImpl: async () => new Response('<h1>Нет данных</h1>') });
  const unknown = await missing.lookup(input); assert.equal(unknown.rating, null); assert.equal(unknown.positiveReviews, null); assert.equal(unknown.status, 'unknown');
});

test('ratings stop on blocked sources, reject non-card URLs, and honor disabled network mode', async () => {
  const blocked = createRatingsLookup({ fetchImpl: async () => new Response('', { status: 429 }) });
  const result = await blocked.lookup(input); assert.equal(result.reason, 'blocked'); assert.equal(result.rating, null); assert.equal(result.negativeReviews, null);
  await assert.rejects(blocked.lookup({ url: 'https://127.0.0.1/admin' }));
  await assert.rejects(blocked.lookup({ ...input, refresh: 'yes' }));
  const disabled = createRatingsLookup({ enabled: false, fetchImpl: () => { throw new Error('No network expected'); } });
  assert.equal((await disabled.lookup(input)).attemptedAt, null);
});

test('presentation rounds scores, formats exact review counts and zeroes, and builds safe movie/series source links', () => {
  const view = ratingPresentation({ rating: 8.094, positiveReviews: 1298, negativeReviews: 0 });
  assert.equal(view.value, '8,1'); assert.equal(view.tier, 'high'); assert.equal(view.negative, '0'); assert.match(view.positive, /1\D298/);
  assert.equal(ratingPresentation({ rating: 6.4 }).tier, 'medium'); assert.equal(ratingPresentation({ rating: 4.1 }).tier, 'low');
  assert.equal(ratingPresentation({}).positive, null); assert.equal(ratingPresentation({ rating: NaN }).value, '—');
  assert.equal(ratingLinks('https://kinopoisk.ru/series/915196/?share=example').reviews, 'https://www.kinopoisk.ru/film/915196/reviews/');
  assert.equal(ratingLinks('javascript:alert(1)'), null); assert.equal(ratingLinks('https://kinopoisk.ru.evil.example/film/1/'), null);
});
