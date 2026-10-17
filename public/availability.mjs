export function availabilityPresentation(availability = {}, hasUrl = true) {
  const status = availability.stale ? 'unknown' : availability.status || 'unknown';
  const label = !hasUrl ? 'Найти на Кинопоиске ↗' : status === 'available' ? '▶ Смотреть на Кинопоиске'
    : status === 'unavailable' ? 'Кинопоиск · нет онлайн ↗' : 'Кинопоиск · ? ↗';
  const message = status === 'available' ? 'Доступен для просмотра на Кинопоиске.' : status === 'unavailable'
    ? 'Сейчас недоступен для просмотра на Кинопоиске.' : availability.checkedAt ? 'Не удалось подтвердить доступность просмотра.' : 'Доступность просмотра ещё не проверена.';
  let stamp = '';
  if (availability.checkedAt && Number.isFinite(Date.parse(availability.checkedAt)))
    stamp = new Intl.DateTimeFormat('ru', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(availability.checkedAt));
  const title = `${message}${availability.source === 'manual' ? ' Указано вручную.' : ''}${stamp ? ` Проверка: ${stamp}.` : ''}${availability.stale ? ' Проверка устарела.' : ''}`;
  let watchUrl = null;
  if (status === 'available' && typeof availability.watchUrl === 'string') {
    try { const url = new URL(availability.watchUrl); if (url.protocol === 'https:' && url.hostname === 'hd.kinopoisk.ru'
      && !url.port && !url.username && !url.password && /^\/film\/[a-f0-9]{32}\/?$/.test(url.pathname)) watchUrl = url.origin + url.pathname; } catch {}
  }
  return { status, label, message, title, watchUrl };
}
