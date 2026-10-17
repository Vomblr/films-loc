export function validateFilm(input, previous = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Некорректная запись.');
  const title = typeof input.title === 'string' ? input.title.trim() : previous.title;
  const note = typeof input.note === 'string' ? input.note.trim() : (previous.note ?? '');
  const kinopoiskUrl = typeof input.kinopoiskUrl === 'string' ? input.kinopoiskUrl.trim() : (previous.kinopoiskUrl ?? '');
  if (!title || title.length > 250) throw new Error('Введите название длиной до 250 символов.');
  if (note.length > 3000) throw new Error('Заметка должна быть короче 3000 символов.');
  const releaseYear = input.releaseYear !== undefined ? input.releaseYear : previous.releaseYear ?? null;
  if (releaseYear !== null && (!Number.isInteger(releaseYear) || releaseYear < 1888 || releaseYear > 2100))
    throw new Error('Введите год от 1888 до 2100 или оставьте поле пустым.');
  const additionalLinks = input.additionalLinks !== undefined ? input.additionalLinks : previous.additionalLinks ?? [];
  if (!Array.isArray(additionalLinks) || additionalLinks.length > 5) throw new Error('Некорректные дополнительные ссылки.');
  for (const link of additionalLinks) {
    if (!link || typeof link.label !== 'string' || link.label.length > 100 || typeof link.url !== 'string') throw new Error('Некорректная дополнительная ссылка.');
    let extra;
    try { extra = new URL(link.url); } catch { throw new Error('Проверьте дополнительную ссылку.'); }
    if (extra.protocol !== 'https:' || !['kinopoisk.ru', 'www.kinopoisk.ru'].includes(extra.hostname) || extra.username || extra.password || extra.port || link.url.length > 2048)
      throw new Error('Нужна HTTPS-ссылка на kinopoisk.ru.');
  }
  if (kinopoiskUrl) {
    let url;
    try { url = new URL(kinopoiskUrl); } catch { throw new Error('Проверьте ссылку на Кинопоиск.'); }
    if (url.protocol !== 'https:' || !['kinopoisk.ru', 'www.kinopoisk.ru'].includes(url.hostname) || url.username || url.password || url.port)
      throw new Error('Нужна HTTPS-ссылка на kinopoisk.ru.');
    if (kinopoiskUrl.length > 2048) throw new Error('Ссылка слишком длинная.');
  }
  if (input.watched !== undefined && typeof input.watched !== 'boolean') throw new Error('Некорректный статус.');
  const kinopoiskAvailabilityOverride = input.kinopoiskAvailabilityOverride !== undefined ? input.kinopoiskAvailabilityOverride
    : kinopoiskUrl === previous.kinopoiskUrl ? previous.kinopoiskAvailabilityOverride ?? null : null;
  if (![null, 'available', 'unavailable'].includes(kinopoiskAvailabilityOverride)) throw new Error('Проверьте доступность просмотра на Кинопоиске.');
  if (kinopoiskAvailabilityOverride && !kinopoiskUrl) throw new Error('Сначала добавьте ссылку на Кинопоиск.');
  const watched = input.watched ?? previous.watched ?? false;
  const watchedAt = watched ? (input.watchedAt !== undefined ? input.watchedAt : previous.watchedAt ?? null) : null;
  if (watchedAt !== null) {
    if (typeof watchedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(watchedAt) || Number.isNaN(Date.parse(watchedAt)) || new Date(watchedAt).toISOString().slice(0, 10) !== watchedAt)
      throw new Error('Проверьте дату просмотра.');
    if (watchedAt > new Date(Date.now() + 14 * 3600000).toISOString().slice(0, 10)) throw new Error('Дата просмотра не может быть в будущем.');
  }
  return { title, note, kinopoiskUrl, watched, watchedAt, releaseYear, additionalLinks, kinopoiskAvailabilityOverride };
}

export function toFilm(row) {
  return { id: row.id, title: row.title, note: row.note, kinopoiskUrl: row.kinopoisk_url,
    watched: Boolean(row.watched), watchedAt: row.watched_at, markedAt: row.marked_at,
    createdAt: row.created_at, updatedAt: row.updated_at, version: row.version,
    sourceOrder: row.source_order, sourceText: row.source_text, releaseYear: row.release_year ?? null,
    deletedAt: row.deleted_at ?? null, additionalLinks: JSON.parse(row.additional_links || '[]'),
    kinopoiskAvailabilityOverride: row.kinopoisk_availability_override ?? null,
    kinopoiskAvailabilityMarkedAt: row.kinopoisk_availability_marked_at ?? null };
}

export function isPrivateAddress(value = '') {
  const ip = value.replace(/^::ffff:/, '');
  if (ip === '::1' || ip.startsWith('127.') || ip.startsWith('192.168.') || ip.startsWith('10.')) return true;
  const match = ip.match(/^172\.(\d+)\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}
