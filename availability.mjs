import { parseKinopoiskInput } from './metadata.mjs';
import { fetchKinopoiskPage } from './kinopoisk-http.mjs';

export const emptyAvailability = (reason = 'not-checked') => ({ status: 'unknown', checkedAt: null, watchUrl: null, source: null, reason });
const ttl = entry => entry.status === 'unknown' ? 15 * 60000 : 24 * 3600000;

export function parseAvailabilityPage(html, id, pageUrl) {
  const target = new URL(pageUrl);
  const uuid = target.hostname === 'hd.kinopoisk.ru' && target.pathname.match(/^\/film\/([a-f0-9]{32})\/?$/)?.[1];
  if (!uuid) return { status: 'unknown', reason: 'unrecognized-page' };
  if (/(?:showcaptcha|captcha-container|SmartCaptcha|Подтвердите, что вы не робот)/i.test(html)) return { status: 'unknown', reason: 'blocked' };
  const script = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].find(match => /\bid\s*=\s*["']__NEXT_DATA__["']/i.test(match[1]));
  if (!script) return { status: 'unknown', reason: 'unrecognized-page' };
  let records;
  try { records = JSON.parse(script[2]).props?.pageProps?.apolloState?.data; } catch { return { status: 'unknown', reason: 'unrecognized-page' }; }
  const record = Object.entries(records || {}).find(([key, item]) => key.endsWith(':' + uuid) && String(item?.id) === String(id))?.[1];
  if (!record) return { status: 'unknown', reason: 'identity-mismatch' };
  const option = record.viewOption?.__ref ? records[record.viewOption.__ref] : record.viewOption;
  const watchable = option?.['isWatchable({"filter":{"anyDevice":false,"anyRegion":false}})'];
  if (watchable === true && option.watchabilityStatus === 'WATCHABLE' && !option.availabilityAnnounce)
    return { status: 'available', reason: 'watchable', watchUrl: `https://hd.kinopoisk.ru/film/${uuid}` };
  if (watchable === false && option.watchabilityStatus === 'UNWATCHABLE')
    return { status: 'unavailable', reason: 'not-watchable', watchUrl: null };
  return { status: 'unknown', reason: 'unconfirmed-offer' };
}

export function createAvailabilityLookup({ records = [], onResult = () => {}, now = Date.now, fetchImpl = fetch, enabled = true } = {}) {
  const cache = new Map(records.filter(entry => /^\d{1,12}$/.test(entry.id) && ['available', 'unavailable', 'unknown'].includes(entry.status)
    && Number.isFinite(Date.parse(entry.checkedAt))).map(entry => [entry.id, entry]));
  const pending = new Map(); let active = 0;
  const isFresh = url => {
    try { const entry = cache.get(parseKinopoiskInput({ url }).id); return Boolean(entry && now() - Date.parse(entry.checkedAt) < ttl(entry)); }
    catch { return true; }
  };
  const peek = url => {
    try {
      const entry = cache.get(parseKinopoiskInput({ url }).id);
      return entry ? { ...entry, stale: !isFresh(url) } : emptyAvailability(enabled ? 'not-checked' : 'disabled');
    } catch { return emptyAvailability('no-card'); }
  };
  async function lookup(body) {
    const input = parseKinopoiskInput(body);
    if (body.refresh !== undefined && typeof body.refresh !== 'boolean') throw new Error('Некорректный запрос проверки.');
    if (!enabled) return peek(input.url);
    if (!body.refresh && isFresh(input.url)) return peek(input.url);
    if (pending.has(input.id)) return pending.get(input.id);
    if (active >= 2) return emptyAvailability('busy');
    active++;
    const task = (async () => {
      let result;
      try {
        // The public /film/ID/watch/ resolver also accepts series IDs.
        const page = await fetchKinopoiskPage(`https://www.kinopoisk.ru/film/${input.id}/watch/`, { fetchImpl, signal: AbortSignal.timeout(8500) });
        result = page.status === 200 ? parseAvailabilityPage(page.html, input.id, page.url) : { status: 'unknown', reason: 'http-error' };
      } catch (error) { result = { status: 'unknown', reason: ['challenge', 'non_anonymous_sso'].includes(error.code) ? 'blocked' : 'network-error' }; }
      const entry = { id: input.id, ...result, watchUrl: result.watchUrl || null, source: 'kinopoisk', checkedAt: new Date(now()).toISOString() };
      if (cache.size >= 1000 && !cache.has(input.id)) cache.delete(cache.keys().next().value);
      onResult(entry); cache.set(input.id, entry); return { ...entry, stale: false };
    })().finally(() => { active--; pending.delete(input.id); });
    pending.set(input.id, task); return task;
  }
  return { lookup, peek, isFresh, enabled };
}
