const MAX_BYTES = 3 * 1024 * 1024;
const HOSTS = new Set([
  'www.kinopoisk.ru', 'hd.kinopoisk.ru',
  'sso.passport.yandex.ru', 'sso.kinopoisk.ru',
]);

export class KinopoiskPublicFetchError extends Error {
  constructor(code) {
    super(`Public Kinopoisk lookup could not finish (${code})`);
    this.name = 'KinopoiskPublicFetchError';
    this.code = code;
  }
}

function fail(code) { throw new KinopoiskPublicFetchError(code); }

function officialUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('invalid_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !HOSTS.has(url.hostname) || url.hash) fail('invalid_url');
  return url;
}

function publicUrl(value) {
  const url = officialUrl(value);
  const valid = url.hostname === 'www.kinopoisk.ru'
    ? /^\/(?:film|series)\/\d+\/(?:watch\/)?$/.test(url.pathname)
    : url.hostname === 'hd.kinopoisk.ru' && /^\/film\/[a-f\d]{32}\/?$/.test(url.pathname);
  if (!valid || [...url.searchParams.keys()].some(key => key !== 'utm_referrer')) fail('invalid_target');
  // This is the ordinary URL returned by Kinopoisk's anonymous SSO navigation.
  url.searchParams.set('utm_referrer', 'organic.kinopoisk.ru');
  return url;
}

function isChallenge(html) {
  return /<form\b[^>]*(?:showcaptcha|checkcaptcha)|Подтвердите,?\s+что\s+вы\s+не\s+робот|<title[^>]*>\s*(?:Just a moment|Доступ ограничен|Проверка безопасности|Ой!)/i.test(html);
}

function configFrom(html) {
  const match = html.match(/\bvar it\s*=\s*(\{[^;]+\});/);
  if (!match) fail('unsupported_sso');
  try { return JSON.parse(match[1]); } catch { fail('unsupported_sso'); }
}

async function boundedHtml(response) {
  if (Number(response.headers.get('content-length') || 0) > MAX_BYTES) { await response.body?.cancel(); fail('response_too_large'); }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) {
        await reader.cancel();
        fail('response_too_large');
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
  } finally { reader.releaseLock(); }
  return parts.join('');
}

// Reads only public pages. All session cookies are fresh, anonymous, and local to
// this call; browser profiles, account credentials, and persistent jars are unused.
export async function fetchKinopoiskPage(target, { fetchImpl = fetch, signal } = {}) {
  let page = publicUrl(target);
  const operationSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
    : AbortSignal.timeout(8000);
  const cookies = [];
  let hops = 0;

  function storeCookies(response, url) {
    for (const raw of response.headers.getSetCookie()) {
      const [pair, ...attributes] = raw.split(';');
      const separator = pair.indexOf('=');
      if (separator < 1) continue;
      const cookie = {
        name: pair.slice(0, separator), value: pair.slice(separator + 1),
        domain: url.hostname, hostOnly: true,
        path: url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1) || '/',
        secure: false, expires: Infinity,
      };
      for (const attribute of attributes) {
        const [name, ...values] = attribute.trim().split('=');
        const value = values.join('=');
        switch (name.toLowerCase()) {
          case 'domain': cookie.domain = value.replace(/^\./, '').toLowerCase(); cookie.hostOnly = false; break;
          case 'path': if (value.startsWith('/')) cookie.path = value; break;
          case 'secure': cookie.secure = true; break;
          case 'max-age': if (Number.isFinite(Number(value))) cookie.expires = Date.now() + Number(value) * 1000; break;
          case 'expires': if (Number.isFinite(Date.parse(value))) cookie.expires = Date.parse(value); break;
        }
      }
      if (!(url.hostname === cookie.domain || url.hostname.endsWith(`.${cookie.domain}`)) ||
          !['kinopoisk.ru', 'yandex.ru'].some(root => cookie.domain === root || cookie.domain.endsWith(`.${root}`)) ||
          /[\r\n]/.test(cookie.name + cookie.value)) continue;
      const old = cookies.findIndex(item => item.name === cookie.name && item.domain === cookie.domain && item.path === cookie.path);
      if (old >= 0) cookies.splice(old, 1);
      if (cookie.expires > Date.now() && cookies.length < 64) cookies.push(cookie);
    }
  }

  async function request(value, options = {}) {
    if (++hops > 8) fail('hop_limit');
    const url = officialUrl(value);
    const cookieHeader = cookies.filter(cookie =>
      (cookie.hostOnly ? url.hostname === cookie.domain : url.hostname === cookie.domain || url.hostname.endsWith(`.${cookie.domain}`)) &&
      (url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`)) &&
      (!cookie.secure || url.protocol === 'https:') && cookie.expires > Date.now()
    ).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    const response = await fetchImpl(url, {
      ...options, redirect: 'manual', signal: operationSignal,
      headers: { ...options.headers, ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    });
    storeCookies(response, url);
    const html = await boundedHtml(response);
    if (isChallenge(html)) fail('challenge');
    return { response, html };
  }

  try {
    for (;;) {
      const result = await request(page);
      if (result.response.status < 300 || result.response.status >= 400) {
        return { status: result.response.status, url: page.href, html: result.html };
      }
      const location = result.response.headers.get('location');
      if (!location) fail('missing_redirect');
      const next = officialUrl(new URL(location, page).href);
      if (next.hostname === 'hd.kinopoisk.ru' && page.hostname === 'www.kinopoisk.ru' && /\/watch\/$/.test(page.pathname)) {
        page = publicUrl(next.href);
        continue;
      }
      if (next.hostname !== 'sso.passport.yandex.ru' || next.pathname !== '/push' ||
          next.searchParams.get('retpath') !== page.href) fail('unsupported_redirect');
      const pushed = await request(next);
      if (pushed.response.status !== 200) fail('sso_status');
      const config = configFrom(pushed.html);
      const install = officialUrl(config.host);
      const container = pushed.html.match(/element2\.value = '([^']+)'/);
      if (install.hostname !== 'sso.kinopoisk.ru' || install.pathname !== '/install' ||
          config.retpath !== page.href || !container || !/^[A-Za-z\d._~=-]{1,8192}$/.test(container[1])) fail('unsupported_sso');
      // Replays only the normal, public auto-submitted anonymous SSO form.
      const installed = await request(install, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ retpath: page.href, container: container[1] }),
      });
      if (installed.response.status !== 200) fail('sso_status');
      const finished = configFrom(installed.html);
      if (finished.authStatus !== 'noauth' || finished.currentDomain !== 'kinopoisk.ru' ||
          finished.retpath !== page.href) fail('non_anonymous_sso');
      // The real SSO script performs location.replace(it.retpath). No scripts are
      // evaluated here, and no alternate/form-provided destination is followed.
    }
  } catch (error) {
    if (error instanceof KinopoiskPublicFetchError) throw error;
    if (operationSignal.aborted) fail('timeout_or_aborted');
    fail('network_error');
  }
}
