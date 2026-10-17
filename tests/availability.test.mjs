import test from 'node:test';
import assert from 'node:assert/strict';
import { createAvailabilityLookup, parseAvailabilityPage } from '../availability.mjs';
import { fetchKinopoiskPage } from '../kinopoisk-http.mjs';
import { availabilityPresentation } from '../public/availability.mjs';

const uuid = '4bb999afe5782a85bcfec420fe420580';
const hd = `https://hd.kinopoisk.ru/film/${uuid}`;
const input = { url: 'https://www.kinopoisk.ru/film/461939/?socialAlias=public-example' };
const page = (id = 461939, watchable = true, status = 'WATCHABLE', extra = {}) => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { apolloState: { data: {
  ['__Movie:' + uuid]: { id, viewOption: { watchabilityStatus: status, availabilityAnnounce: null,
    'isWatchable({"filter":{"anyDevice":false,"anyRegion":false}})': watchable, ...extra } },
  '__Movie:recommendation': { id: 999, viewOption: { watchabilityStatus: 'WATCHABLE', 'isWatchable({"filter":{"anyDevice":false,"anyRegion":false}})': true } }
} } } } })}</script>`;

test('availability uses the exact title and current region/device field; redirects and trailers alone prove nothing', () => {
  assert.equal(parseAvailabilityPage(page(), '461939', hd).status, 'available');
  assert.equal(parseAvailabilityPage(page(461939, false, 'UNWATCHABLE'), '461939', hd).status, 'unavailable');
  for (const html of [page(123), page(461939, false), page(461939, true, 'UNKNOWN'), page(461939, true, 'WATCHABLE', { availabilityAnnounce: { text: 'Скоро' } }),
    '<h1>Смотреть онлайн</h1><button>Трейлер</button>', '<script id="__NEXT_DATA__">invalid</script>'])
    assert.equal(parseAvailabilityPage(html, '461939', hd).status, 'unknown');
  const wrongField = page().replace('anyRegion\\":false', 'anyRegion\\":true');
  assert.equal(parseAvailabilityPage(wrongField, '461939', hd).status, 'unknown');
  assert.equal(parseAvailabilityPage('<title>Подтвердите, что вы не робот</title>', '461939', hd).status, 'unknown');
});

test('public SSO accepts only anonymous matching navigation and scopes fresh cookies to the correct host/path', async () => {
  let starts = 0, finalReads = 0;
  const fetchImpl = async (url, options) => {
    if (url.hostname === 'www.kinopoisk.ru') {
      assert.equal(options.headers.Cookie, undefined); starts++;
      return new Response('', { status: 302, headers: { Location: hd } });
    }
    if (url.hostname === 'hd.kinopoisk.ru') {
      if (options.headers.Cookie?.includes('anon=example')) {
        finalReads++; assert.equal(options.headers.Cookie, 'hd_only=example; anon=example');
        return new Response(page());
      }
      return new Response('', { status: 302, headers: { Location: 'https://sso.passport.yandex.ru/push?retpath=' + encodeURIComponent(url.href),
        'Set-Cookie': 'hd_only=example; Path=/film/; Secure' } });
    }
    if (url.hostname === 'sso.passport.yandex.ru') {
      assert.equal(options.headers.Cookie, undefined);
      const config = { host: 'https://sso.kinopoisk.ru/install?sessionformat=example', retpath: url.searchParams.get('retpath') };
      return new Response(`var it = ${JSON.stringify(config)}; element2.value = 'example_container';`);
    }
    assert.equal(url.href, 'https://sso.kinopoisk.ru/install?sessionformat=example');
    assert.equal(options.method, 'POST'); assert.equal(options.headers.Cookie, undefined);
    const params = options.body; assert.equal(params.get('container'), 'example_container');
    const headers = new Headers();
    headers.append('Set-Cookie', 'anon=example; Domain=.kinopoisk.ru; Path=/; Secure');
    headers.append('Set-Cookie', 'wrong_path=example; Domain=.kinopoisk.ru; Path=/other; Secure');
    headers.append('Set-Cookie', 'wrong_domain=example; Domain=example.org; Path=/; Secure');
    // A sibling host cannot expire the HD host's private cookie.
    headers.append('Set-Cookie', 'hd_only=expired; Domain=.hd.kinopoisk.ru; Path=/film/; Max-Age=0');
    return new Response(`var it = ${JSON.stringify({ authStatus: 'noauth', currentDomain: 'kinopoisk.ru', retpath: params.get('retpath') })};`, { headers });
  };
  for (let i = 0; i < 2; i++) {
    const result = await fetchKinopoiskPage('https://www.kinopoisk.ru/film/461939/watch/', { fetchImpl });
    assert.equal(result.status, 200); assert.equal(parseAvailabilityPage(result.html, '461939', result.url).status, 'available');
  }
  assert.equal(starts, 2); assert.equal(finalReads, 2);
});

test('public lookup rejects external redirects, CAPTCHA, excessive responses and unexpected account SSO', async () => {
  await assert.rejects(fetchKinopoiskPage(hd, { fetchImpl: async () => new Response('', { status: 302, headers: { Location: 'https://example.org/login' } }) }), e => e.code === 'invalid_url');
  await assert.rejects(fetchKinopoiskPage(hd, { fetchImpl: async () => new Response('<title>Ой!</title><form action="/showcaptcha">') }), e => e.code === 'challenge');
  await assert.rejects(fetchKinopoiskPage(hd, { fetchImpl: async () => new Response('x', { headers: { 'Content-Length': 4 * 1024 * 1024 } }) }), e => e.code === 'response_too_large');
  await assert.rejects(fetchKinopoiskPage('https://hd.kinopoisk.ru/film/' + uuid, { fetchImpl: async (url, options) => {
    if (url.hostname === 'hd.kinopoisk.ru') return new Response('', { status: 302, headers: { Location: 'https://sso.passport.yandex.ru/push?retpath=' + encodeURIComponent(url.href) } });
    if (url.hostname === 'sso.passport.yandex.ru') return new Response(`var it = ${JSON.stringify({ host: 'https://sso.kinopoisk.ru/install', retpath: url.searchParams.get('retpath') })}; element2.value = 'example';`);
    return new Response(`var it = ${JSON.stringify({ authStatus: 'auth', currentDomain: 'kinopoisk.ru', retpath: options.body.get('retpath') })};`);
  } }), e => e.code === 'non_anonymous_sso');
});

test('availability deduplicates requests, persists results, expires them, and does not turn network failures into unavailable', async () => {
  let clock = Date.parse('2026-10-17T09:00:00Z'), requests = 0; const saved = [];
  const fetchImpl = async url => { requests++; return url.hostname === 'www.kinopoisk.ru'
    ? new Response('', { status: 302, headers: { Location: hd } }) : new Response(page()); };
  const lookup = createAvailabilityLookup({ now: () => clock, onResult: entry => saved.push(entry), fetchImpl });
  const [a, b] = await Promise.all([lookup.lookup(input), lookup.lookup(input)]);
  assert.equal(a.status, 'available'); assert.deepEqual(a, b); assert.equal(requests, 2); assert.equal(saved.length, 1);
  await lookup.lookup(input); assert.equal(requests, 2);
  const restarted = createAvailabilityLookup({ records: saved, now: () => clock, fetchImpl });
  assert.equal(restarted.peek(input.url).status, 'available'); assert.equal(restarted.isFresh(input.url), true);
  clock += 25 * 3600000; assert.equal(restarted.isFresh(input.url), false); assert.equal(restarted.peek(input.url).stale, true);
  const failed = createAvailabilityLookup({ fetchImpl: async () => { throw new Error('network'); } });
  assert.equal((await failed.lookup(input)).status, 'unknown');
  await assert.rejects(lookup.lookup({ url: 'https://127.0.0.1/admin' }));
  const disabled = createAvailabilityLookup({ enabled: false, fetchImpl: () => { throw new Error('No network expected'); } });
  assert.equal((await disabled.lookup(input)).status, 'unknown');
});

test('presentation distinguishes unknown, unavailable, manual confirmation, stale checks, and unsafe watch URLs', () => {
  assert.match(availabilityPresentation({ status: 'available' }).label, /Смотреть/);
  assert.match(availabilityPresentation({ status: 'unavailable' }).label, /нет онлайн/);
  assert.match(availabilityPresentation({}).label, /\?/);
  assert.equal(availabilityPresentation({ status: 'available', stale: true }).status, 'unknown');
  assert.match(availabilityPresentation({ status: 'available', source: 'manual' }).title, /вручную/);
  assert.equal(availabilityPresentation({ status: 'available', watchUrl: 'javascript:alert(1)' }).watchUrl, null);
  assert.equal(availabilityPresentation({ status: 'available', watchUrl: hd }).watchUrl, hd);
});
