import { randomUUID } from 'node:crypto';
import { parseKinopoiskInput } from './metadata.mjs';

const pauseReasons = new Set(['blocked', 'network-error']);
const cardId = url => { try { return parseKinopoiskInput({ url }).id; } catch { return null; } };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// One server-owned job survives a closed browser tab. Film writes stay in the repository callback.
export function createPlannedRefresh({ listFilms, getFilm, fillEmptyNote, ratings, availability,
  beforeStart = () => {}, now = Date.now, delay = wait, interval = 750 } = {}) {
  let state = { status: 'idle', id: null, total: 0, processed: 0, checked: 0, notesAdded: 0, skipped: 0, errors: 0,
    startedAt: null, finishedAt: null, currentTitle: '', reason: null, stopRequested: false };
  let task = null;
  const peek = () => ({ ...state });
  const finish = (status, reason = null) => Object.assign(state, { status, reason, currentTitle: '', finishedAt: new Date(now()).toISOString() });
  async function run(ids) {
    const ratingResults = new Map(), availabilityResults = new Map();
    try {
      for (const id of ids) {
        if (state.stopRequested) { finish('stopped'); return; }
        // Re-read after every await: an item may have been watched, edited, or trashed elsewhere.
        const film = getFilm(id);
        if (!film || film.watched || film.deletedAt) { state.skipped++; state.processed++; continue; }
        const urls = [film.kinopoiskUrl, ...film.additionalLinks.map(link => link.url)].filter(url => cardId(url));
        if (!urls.length) { state.skipped++; state.processed++; continue; }
        state.currentTitle = film.title;
        let reason = null, incomplete = false;
        for (const url of urls) {
          if (state.stopRequested) break;
          const key = cardId(url), isMain = key === cardId(film.kinopoiskUrl);
          const needsRating = ratings.enabled && !ratingResults.has(key);
          const needsAvailability = availability.enabled && isMain && !film.kinopoiskAvailabilityOverride && !availabilityResults.has(key);
          const [score, viewing] = await Promise.all([
            needsRating ? ratings.lookup({ url, refresh: true }) : ratingResults.get(key),
            needsAvailability ? availability.lookup({ url, refresh: true }) : availabilityResults.get(key),
          ]);
          if (needsRating) ratingResults.set(key, score);
          if (needsAvailability) availabilityResults.set(key, viewing);
          if (ratings.enabled && score?.status !== 'ok') incomplete = true;
          if (viewing && ['blocked', 'network-error', 'http-error', 'busy'].includes(viewing.reason)) incomplete = true;
          reason = [score?.reason, viewing?.reason].find(value => pauseReasons.has(value)) || null;
          if (reason) break;
          if (needsRating || needsAvailability) await delay(interval);
        }
        const current = getFilm(id);
        const description = ratingResults.get(cardId(film.kinopoiskUrl))?.description;
        // The callback must repeat these conditions atomically to preserve edits from other devices.
        if (current && !current.watched && !current.deletedAt && current.kinopoiskUrl === film.kinopoiskUrl &&
            !current.note.trim() && description && fillEmptyNote(current, description)) state.notesAdded++;
        state.checked++; state.processed++;
        if (incomplete) state.errors++;
        if (reason) { finish('paused', reason); return; }
      }
      finish(state.stopRequested ? 'stopped' : 'completed');
    } catch { finish('failed', 'refresh-error'); }
  }
  function start() {
    if (state.status === 'running') return peek();
    const ids = listFilms().filter(film => !film.watched && !film.deletedAt).map(film => film.id);
    beforeStart();
    state = { status: 'running', id: randomUUID(), total: ids.length, processed: 0, checked: 0, notesAdded: 0, skipped: 0, errors: 0,
      startedAt: new Date(now()).toISOString(), finishedAt: null, currentTitle: '', reason: null, stopRequested: false };
    if (!ratings.enabled && !availability.enabled) { finish('paused', 'disabled'); return peek(); }
    task = run(ids);
    return peek();
  }
  function stop() { if (state.status === 'running') state.stopRequested = true; return peek(); }
  return { start, stop, peek, get running() { return state.status === 'running'; }, settled: () => task };
}
