import { parseKinopoiskInput } from './metadata.mjs';
import { fetchKinopoiskPage } from './kinopoisk-http.mjs';
import { parseKinopoiskRating, parseKinopoiskViewerReviews, parseKinopoiskDescription } from './ratings-parser.mjs';

export const emptyRatings = (reason = 'not-checked') => ({ rating: null, ratingVotes: null, positiveReviews: null, negativeReviews: null,
  neutralReviews: null, totalReviews: null, ratingCheckedAt: null, reviewsCheckedAt: null, checkedAt: null, attemptedAt: null,
  description: null, descriptionCheckedAt: null, descriptionSource: null,
  status: 'unknown', reason, sourceUrl: null, reviewsUrl: null, stale: false });
const lifetime = entry => entry.status === 'ok' ? 24 * 3600000 : 15 * 60000;

export function createRatingsLookup({ records = [], onResult = () => {}, now = Date.now, fetchImpl = fetch, enabled = true } = {}) {
  const cache = new Map(records.filter(entry => entry && /^\d{1,12}$/.test(entry.id) && Number.isFinite(Date.parse(entry.attemptedAt)))
    .map(entry => [entry.id, entry]));
  const pending = new Map(); let active = 0;
  const isFresh = url => {
    try { const entry = cache.get(parseKinopoiskInput({ url }).id); return Boolean(entry && now() - Date.parse(entry.attemptedAt) < lifetime(entry)); }
    catch { return true; }
  };
  const peek = url => {
    try {
      const entry = cache.get(parseKinopoiskInput({ url }).id);
      return entry ? { ...entry, stale: !isFresh(url) || entry.status !== 'ok' } : emptyRatings(enabled ? 'not-checked' : 'disabled');
    } catch { return emptyRatings('no-card'); }
  };
  async function lookup(body) {
    const input = parseKinopoiskInput(body);
    if (body.refresh !== undefined && typeof body.refresh !== 'boolean') throw new Error('Некорректный запрос обновления оценки.');
    // A pre-description cache entry needs one new card fetch when used by the add form.
    if (!enabled || (!body.refresh && isFresh(input.url) && Object.hasOwn(cache.get(input.id) || {}, 'description'))) return peek(input.url);
    if (pending.has(input.id)) return pending.get(input.id);
    if (active >= 2) return emptyRatings('busy');
    active++;
    const task = (async () => {
      const signal = AbortSignal.timeout(8500), id = Number(input.id);
      const reviewsUrl = `https://www.kinopoisk.ru/film/${input.id}/reviews/`;
      const responses = await Promise.allSettled([
        fetchKinopoiskPage(input.url, { fetchImpl, signal }), fetchKinopoiskPage(reviewsUrl, { fetchImpl, signal })
      ]);
      const parsed = responses.map((result, index) => {
        if (result.status !== 'fulfilled') return { data: null, reason: ['challenge', 'non_anonymous_sso'].includes(result.reason?.code) ? 'blocked' : 'network-error' };
        if (result.value.status !== 200) return { data: null, reason: [401, 403, 429, 503].includes(result.value.status) ? 'blocked' : 'http-error' };
        const data = index === 0 ? parseKinopoiskRating(result.value.html, id) : parseKinopoiskViewerReviews(result.value.html, id);
        return { data, reason: data ? null : 'unrecognized-page' };
      });
      const stamp = new Date(now()).toISOString(), old = cache.get(input.id) || emptyRatings();
      const cardResponse = responses[0];
      const description = cardResponse.status === 'fulfilled' && cardResponse.value.status === 200
        ? parseKinopoiskDescription(cardResponse.value.html, id) : null;
      const rating = parsed[0].data;
      let reviews = parsed[1].data;
      // An explicitly empty exact-ID user-review list proves zero sentiments.
      // Nonzero modern totals are never mixed with legacy review counters.
      if (!reviews && rating?.reviewTotal === 0) {
        reviews = { positive: 0, negative: 0, neutral: 0, total: 0 };
        if (!['blocked', 'network-error'].includes(parsed[1].reason)) parsed[1].reason = null;
      }
      const successes = Number(Boolean(rating)) + Number(Boolean(reviews));
      const entry = { ...emptyRatings(), ...old, id: input.id, sourceUrl: input.url, reviewsUrl, attemptedAt: stamp,
        checkedAt: successes ? stamp : old.checkedAt, status: successes === 2 ? 'ok' : successes ? 'partial' : 'unknown',
        reason: parsed.some(part => part.reason === 'blocked') ? 'blocked' : parsed.find(part => part.reason)?.reason || null };
      if (rating) Object.assign(entry, { rating: rating.value, ratingVotes: rating.votes, ratingCheckedAt: stamp });
      if (description) Object.assign(entry, { description: description.text, descriptionSource: description.sourceField, descriptionCheckedAt: stamp });
      if (reviews) Object.assign(entry, { positiveReviews: reviews.positive, negativeReviews: reviews.negative,
        neutralReviews: reviews.neutral, totalReviews: reviews.total, reviewsCheckedAt: stamp });
      if (cache.size >= 1000 && !cache.has(input.id)) cache.delete(cache.keys().next().value);
      onResult(entry); cache.set(input.id, entry); return peek(input.url);
    })().finally(() => { active--; pending.delete(input.id); });
    pending.set(input.id, task); return task;
  }
  return { lookup, peek, isFresh, enabled };
}
