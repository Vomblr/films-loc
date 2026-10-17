const botUrl = 'https://t.me/torrents_2_bot';

function cleanRussianTitle(title, year) {
  let name = title.replace(/^(?:мини[ -]+)?сериал\s+/iu, '').trim();
  if (year) name = name.replace(new RegExp(`\\s+${year}$`, 'u'), '').trim();
  name = name.replace(/\s+сериал$/iu, '').trim();
  // The imported note has a recommendation appended to the original F1 title.
  if (/^F1\s+[-–—]\s+.+$/u.test(name)) name = 'F1';
  return name;
}

export function torrentMessage(film) {
  const title = String(film.title || '').trim();
  const year = Number.isInteger(film.releaseYear) && film.releaseYear >= 1888 && film.releaseYear <= 2100 ? film.releaseYear : null;
  const split = title.indexOf(' (');
  const original = split > 0 && title.endsWith(')') ? title.slice(split + 2, -1).trim() : '';
  const russian = cleanRussianTitle(original ? title.slice(0, split) : title, year);
  const name = original && original.toLocaleLowerCase('ru') !== russian.toLocaleLowerCase('ru') ? `${russian} ${original}` : russian;
  return [name, year].filter(Boolean).join(' ').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function torrentUrl(message) {
  return `${botUrl}?text=${encodeURIComponent(message)}`;
}

export function torrentRequests(film) {
  // This single imported row contains two separate series with different premiere years.
  const extra = film.additionalLinks?.find(link => /^https:\/\/(?:www\.)?kinopoisk\.ru\/series\/4468044\/?$/.test(link.url));
  if (film.title === 'Кэнди / Любовь и Смерть (Candy / Love & Death)' && extra) {
    const extraYear = Number(extra.label.match(/\((\d{4})\)/)?.[1]) || 2023;
    return [
      { label: 'torrent', message: torrentMessage({ title: 'Кэнди (Candy)', releaseYear: film.releaseYear }) },
      { label: 'torrent · Любовь и смерть', message: torrentMessage({ title: 'Любовь и смерть (Love & Death)', releaseYear: extraYear }) }
    ];
  }
  return [{ label: 'torrent', message: torrentMessage(film) }];
}
