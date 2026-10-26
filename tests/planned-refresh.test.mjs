import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlannedRefresh } from '../planned-refresh.mjs';

const film = (id, extra = {}) => ({ id, title: `Фильм ${id}`, note: '', watched: false, deletedAt: null,
  kinopoiskUrl: `https://www.kinopoisk.ru/film/${id}/`, additionalLinks: [], version: 1, releaseYear: 2020, ...extra });
function setup(items, options = {}) {
  const films = new Map(items.map(item => [item.id, structuredClone(item)]));
  const ratingCalls = [], viewingCalls = [], saves = []; let backups = 0;
  const ratings = { enabled: true, lookup: async input => { ratingCalls.push(input); return { status: 'ok', description: 'Краткое описание' }; } };
  const availability = { enabled: true, lookup: async input => { viewingCalls.push(input); return { status: 'available' }; } };
  const job = createPlannedRefresh({ listFilms: () => [...films.values()], getFilm: id => structuredClone(films.get(id)),
    fillEmptyNote: (current, note) => {
      const saved = films.get(current.id);
      if (saved.watched || saved.deletedAt || saved.note.trim() || saved.version !== current.version) return false;
      saved.note = note; saved.version++; saves.push(current.id); return true;
    }, ratings, availability, beforeStart: () => { backups++; }, delay: async () => {}, ...options });
  return { job, films, ratingCalls, viewingCalls, saves, ratings, availability, backups: () => backups };
}

test('manual refresh selects unwatched active entries, deduplicates IDs, fills only empty notes and respects overrides', async () => {
  const env = setup([film('1'), film('2', { note: 'Моя заметка', kinopoiskAvailabilityOverride: 'available', additionalLinks: [{ label: 'Ещё', url: 'https://www.kinopoisk.ru/series/1/' }] }),
    film('3', { watched: true }), film('4', { deletedAt: '2026-01-01' }), film('5', { kinopoiskUrl: '' }),
    film('6', { kinopoiskUrl: 'https://kinopoisk.ru/index.php?kp_query=6' })]);
  const before = structuredClone([...env.films.values()]);
  env.job.start(); await env.job.settled();
  const state = env.job.peek();
  assert.equal(state.status, 'completed'); assert.equal(state.total, 4); assert.equal(state.processed, 4);
  assert.equal(state.checked, 2); assert.equal(state.notesAdded, 1); assert.equal(state.skipped, 2);
  assert.equal(env.ratingCalls.length, 2); assert.ok(env.ratingCalls.every(input => input.refresh));
  assert.equal(env.viewingCalls.length, 1); assert.deepEqual(env.saves, ['1']);
  assert.equal(env.films.get('2').note, 'Моя заметка'); assert.equal(env.backups(), 1);
  for (const original of before) {
    const current = env.films.get(original.id);
    assert.deepEqual({ ...current, note: original.note, version: original.version }, original);
  }
});

test('repeated starts share one job; edits, watching and Trash changes made during requests survive', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const env = setup([film('1'), film('2'), film('3')], { ratings: { enabled: true, lookup: async () => {
    entered(); await gate; return { status: 'ok', description: 'Не заменить ручную заметку' };
  } } });
  const first = env.job.start(); await started;
  assert.equal(env.job.start().id, first.id); assert.equal(env.backups(), 1);
  env.films.get('1').note = 'Введено на другом устройстве'; env.films.get('1').version++;
  env.films.get('2').watched = true; env.films.get('3').deletedAt = '2026-01-02';
  release(); await env.job.settled();
  assert.equal(env.job.peek().checked, 1); assert.equal(env.job.peek().skipped, 2); assert.equal(env.saves.length, 0);
  assert.equal(env.films.get('1').note, 'Введено на другом устройстве');
});

test('a film watched or relinked in flight never receives an automatic note', async () => {
  for (const changed of [{ watched: true }, { kinopoiskUrl: 'https://www.kinopoisk.ru/film/99/' }]) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const env = setup([film('1')], { ratings: { enabled: true, lookup: async () => {
      await gate; return { status: 'ok', description: 'Описание прежней карточки' };
    } } });
    env.job.start(); Object.assign(env.films.get('1'), changed); release(); await env.job.settled();
    assert.equal(env.saves.length, 0); assert.equal(env.films.get('1').note, '');
  }
});

test('source blocks pause the pass, cancellation stops after the current request, and jobs can be restarted', async () => {
  const blocked = setup([film('1'), film('2')], { ratings: { enabled: true, lookup: async () => ({ status: 'unknown', reason: 'blocked' }) } });
  blocked.job.start(); await blocked.job.settled();
  assert.equal(blocked.job.peek().status, 'paused'); assert.equal(blocked.job.peek().reason, 'blocked'); assert.equal(blocked.job.peek().processed, 1);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const cancelled = setup([film('1'), film('2')], { delay: () => gate });
  const first = cancelled.job.start(); cancelled.job.stop(); release(); await cancelled.job.settled();
  assert.equal(cancelled.job.peek().status, 'stopped'); assert.equal(cancelled.ratingCalls.length, 1);
  const second = cancelled.job.start(); await cancelled.job.settled();
  assert.notEqual(second.id, first.id); assert.equal(cancelled.job.peek().status, 'completed');
});

test('disabled networking makes no requests and unexpected failures produce an inspectable terminal state', async () => {
  const disabled = setup([film('1')], { ratings: { enabled: false }, availability: { enabled: false } });
  assert.equal(disabled.job.start().reason, 'disabled'); assert.equal(disabled.job.running, false);
  assert.equal(disabled.films.get('1').note, '');
  const failed = setup([film('1')], { ratings: { enabled: true, lookup: async () => { throw new Error('Source unavailable'); } } });
  failed.job.start(); await failed.job.settled(); assert.equal(failed.job.peek().status, 'failed');
});
