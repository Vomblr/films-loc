export function sortFilms(films, sort = 'note') {
  return [...films].sort((a, b) => {
    if (a.watched !== b.watched) return Number(a.watched) - Number(b.watched);
    if (sort === 'title') return a.title.localeCompare(b.title, 'ru');
    if (a.watched && (sort === 'watched-desc' || sort === 'watched-asc')) {
      if (!a.watchedAt || !b.watchedAt) {
        if (a.watchedAt !== b.watchedAt) return a.watchedAt ? -1 : 1;
      } else {
        const date = a.watchedAt.localeCompare(b.watchedAt);
        if (date) return sort === 'watched-asc' ? date : -date;
        const mark = (b.markedAt || '').localeCompare(a.markedAt || '');
        if (mark) return sort === 'watched-asc' ? -mark : mark;
      }
    }
    // New additions appear first; the imported note keeps its original order.
    const aNew = !a.id.startsWith('note-'), bNew = !b.id.startsWith('note-');
    if (aNew !== bNew) return aNew ? -1 : 1;
    if (aNew && a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
    return a.sourceOrder - b.sourceOrder;
  });
}
