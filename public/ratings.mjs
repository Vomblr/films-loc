const count = value => Number.isSafeInteger(value) && value >= 0 ? new Intl.NumberFormat('ru').format(value) : null;
const stamp = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('ru', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '';

export function ratingPresentation(stats = {}) {
  const rating = typeof stats.rating === 'number' && Number.isFinite(stats.rating) && stats.rating > 0 && stats.rating <= 10 ? stats.rating : null;
  const value = rating === null ? '—' : new Intl.NumberFormat('ru', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(rating);
  const tier = rating === null ? 'none' : rating >= 7 ? 'high' : rating >= 5 ? 'medium' : 'low';
  const votes = count(stats.ratingVotes), positive = count(stats.positiveReviews), negative = count(stats.negativeReviews);
  const neutral = count(stats.neutralReviews), total = count(stats.totalReviews);
  const ratingTime = stamp(stats.ratingCheckedAt), reviewsTime = stamp(stats.reviewsCheckedAt);
  const stale = stats.stale ? ' Показаны последние полученные данные; обновление не подтверждено.' : '';
  return { value, tier, positive, negative,
    ratingTitle: `${rating === null ? stats.ratingCheckedAt ? 'Кинопоиск ещё не опубликовал оценку.' : 'Оценка Кинопоиска не получена.' : `Оценка Кинопоиска: ${value} из 10.`}${votes !== null ? ` Голосов: ${votes}.` : ''}${ratingTime ? ` Обновлено: ${ratingTime}.` : ''}${stale}`,
    reviewsTitle: `${positive !== null && negative !== null ? `Рецензии зрителей: положительных ${positive}, отрицательных ${negative}${neutral !== null ? `, нейтральных ${neutral}` : ''}${total !== null ? `, всего ${total}` : ''}.` : 'Количество рецензий зрителей пока не получено.'}${reviewsTime ? ` Обновлено: ${reviewsTime}.` : ''}${stale}` };
}

export function ratingLinks(value) {
  try {
    const url = new URL(value), match = url.pathname.match(/^\/(film|series)\/(\d+)\/?$/);
    if (!match || url.protocol !== 'https:' || !['kinopoisk.ru', 'www.kinopoisk.ru'].includes(url.hostname) || url.port || url.username || url.password) return null;
    return { card: `https://www.kinopoisk.ru/${match[1]}/${match[2]}/`, reviews: `https://www.kinopoisk.ru/film/${match[2]}/reviews/` };
  } catch { return null; }
}
