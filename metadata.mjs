// Public metadata lookup by a Kinopoisk identifier. No browser sessions or API keys.
const api = 'https://www.wikidata.org/w/api.php';
const userAgent = 'FilmsLoc/1.0 (personal home movie catalog; read-only Wikidata client)';
const problem = (message, status = 400) => Object.assign(new Error(message), { status });
const claims = (entity, property) => (entity?.claims?.[property] || []).filter(s => s.rank !== 'deprecated' && s.mainsnak?.snaktype === 'value');
const value = statement => statement.mainsnak.datavalue?.value;
const values = (entity, property) => claims(entity, property).map(value);

export function parseKinopoiskInput(input) {
  if (!input || typeof input.url !== 'string' || input.url.length > 2048) throw problem('Вставьте ссылку на карточку Кинопоиска.');
  let url;
  try { url = new URL(input.url.trim()); } catch { throw problem('Проверьте ссылку на Кинопоиск.'); }
  if (url.protocol !== 'https:' || !['kinopoisk.ru', 'www.kinopoisk.ru'].includes(url.hostname) || url.port || url.username || url.password)
    throw problem('Нужна HTTPS-ссылка на kinopoisk.ru.');
  const match = url.pathname.match(/^\/(film|series)\/(\d{1,12})\/?$/);
  if (!match || !Number(match[2])) throw problem('Вставьте ссылку на сам фильм или сериал: /film/123/ или /series/123/.');
  const season = input.season === '' || input.season === undefined || input.season === null ? null : input.season;
  if (season !== null && (!Number.isInteger(season) || season < 1 || season > 100)) throw problem('Номер сезона должен быть от 1 до 100.');
  return { id: match[2].replace(/^0+(?=\d)/, ''), kind: match[1], season, url: `https://www.kinopoisk.ru/${match[1]}/${match[2].replace(/^0+(?=\d)/, '')}/` };
}

export function firstDate(entity, property) {
  // P577 = release/publication; P580 = first broadcast. Never use production/inception.
  return values(entity, property).filter(v => v?.precision >= 9 && /^\+\d{4}-/.test(v.time || ''))
    .map(v => ({ year: Number(v.time.slice(1, 5)), date: v.precision >= 11 ? v.time.slice(1, 11) : null }))
    .filter(v => v.year >= 1888 && v.year <= 2100)
    .sort((a, b) => a.year - b.year || String(a.date || '').localeCompare(String(b.date || '')))[0] || null;
}

export function seasonId(entity, season) {
  return claims(entity, 'P527').find(statement => statement.qualifiers?.P1545?.some(s => s.datavalue?.value === String(season)))?.mainsnak?.datavalue?.value?.id || null;
}

export function metadataFromEntity(entity, input, seasonEntity = null) {
  if (!values(entity, 'P2603').includes(input.id)) throw problem('Источник не подтвердил ID Кинопоиска.', 502);
  const seriesTypes = ['Q5398426', 'Q1259759', 'Q1366112', 'Q581714'];
  const kind = input.kind === 'series' || values(entity, 'P31').some(v => seriesTypes.includes(v?.id)) ? 'series' : 'film';
  if (input.season && kind !== 'series') throw problem('Сезон можно выбрать только у сериала.');
  const titles = values(entity, 'P1476').filter(v => v?.text);
  // A translated English label is not evidence of an original title.
  const original = [...new Set(titles.map(v => v.text))];
  const originalTitle = original.length === 1 ? original[0] : '';
  const russianTitle = entity.labels?.ru?.value || '';
  const premiere = input.season ? firstDate(seasonEntity, 'P580') || firstDate(seasonEntity, 'P577')
    : firstDate(entity, kind === 'series' ? 'P580' : 'P577');
  const warnings = [];
  if (!russianTitle) warnings.push('Русское название не найдено — введите его вручную.');
  if (!originalTitle) warnings.push('Оригинальное название не подтверждено — при необходимости добавьте его вручную.');
  if (!premiere) warnings.push(input.season ? 'Год выхода этого сезона не найден — укажите его вручную.' : kind === 'series' ? 'Год начала сериала не найден — укажите его вручную.' : 'Год премьеры не найден — укажите его вручную.');
  if (!russianTitle && !originalTitle) throw problem('Названия не найдены. Заполните карточку вручную.', 404);
  return { russianTitle, originalTitle, kind, season: input.season, releaseYear: premiere?.year ?? null, premiereDate: premiere?.date ?? null,
    yearKind: input.season ? 'season-release' : kind === 'series' ? 'series-start' : 'film-premiere',
    kinopoiskUrl: `https://www.kinopoisk.ru/${kind}/${input.id}/`, source: 'Wikidata', sourceUrl: `https://www.wikidata.org/wiki/${entity.id}`,
    warnings };
}

export function displayTitle(metadata) {
  const ru = metadata.russianTitle?.trim() || '', original = metadata.originalTitle?.trim() || '';
  const base = ru || original;
  const season = metadata.season ? `, ${metadata.season} сезон` : '';
  return `${base}${season}${original && ru && original.toLocaleLowerCase('ru') !== ru.toLocaleLowerCase('ru') ? ` (${original})` : ''}`;
}

export function createMetadataLookup({ catalog = [], fetchImpl = fetch, now = Date.now } = {}) {
  const verified = new Map(catalog.map(item => [`${item.id}:${item.season || ''}`, item]));
  const cache = new Map(), pending = new Map();
  let active = 0;
  async function fetchJson(parameters, signal) {
    const url = new URL(api); url.search = new URLSearchParams({ ...parameters, format: 'json' });
    const response = await fetchImpl(url, { signal, redirect: 'error', headers: { 'User-Agent': userAgent, Accept: 'application/json' } });
    if (!response.ok) throw problem('Источник метаданных временно недоступен. Попробуйте ещё раз или заполните вручную.', 502);
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 1500000) throw problem('Слишком большой ответ источника метаданных.', 502);
      chunks.push(chunk);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (result.error) throw problem('Источник метаданных временно занят. Попробуйте позже.', 502);
    return result;
  }
  async function entities(ids, signal) {
    return (await fetchJson({ action: 'wbgetentities', ids: ids.join('|'), props: 'labels|claims', languages: 'ru', }, signal)).entities || {};
  }
  async function remote(input) {
    const signal = AbortSignal.timeout(9500);
    try {
      const found = await fetchJson({ action: 'query', list: 'search', srsearch: `haswbstatement:P2603=${input.id}`, srprop: '', srlimit: '5' }, signal);
      const ids = (found.query?.search || []).map(r => r.title).filter(id => /^Q\d+$/.test(id));
      if (!ids.length) throw problem('Не нашли метаданные по этой ссылке. Название и год можно ввести вручную.', 404);
      const candidates = Object.values(await entities(ids, signal)).filter(e => values(e, 'P2603').includes(input.id));
      if (candidates.length !== 1) throw problem('Источник не дал однозначного совпадения. Заполните карточку вручную.', 404);
      const entity = candidates[0]; let seasonEntity = null;
      if (input.season) {
        const id = seasonId(entity, input.season);
        if (id && /^Q\d+$/.test(id)) {
          const candidate = (await entities([id], signal))[id];
          // A numbered part can be an episode; accept only an explicit television season.
          if (values(candidate, 'P31').some(v => v?.id === 'Q3464665')) seasonEntity = candidate;
        }
      }
      return metadataFromEntity(entity, input, seasonEntity);
    } catch (error) {
      if (error.status) throw error;
      throw problem('Не удалось получить метаданные. Проверьте интернет или заполните название и год вручную.', 502);
    }
  }
  return async body => {
    const input = parseKinopoiskInput(body), key = `${input.id}:${input.season || ''}`;
    let metadata = verified.get(key);
    if (!metadata) {
      const entry = cache.get(key);
      if (entry && entry.until > now()) metadata = entry.metadata;
      else {
        if (!pending.has(key)) {
          if (active >= 3) throw problem('Уже ищем несколько фильмов. Попробуйте через несколько секунд.', 429);
          active++;
          pending.set(key, remote(input).then(result => {
            if (cache.size >= 500) cache.delete(cache.keys().next().value);
            cache.set(key, { metadata: result, until: now() + 86400000 }); return result;
          }).finally(() => { active--; pending.delete(key); }));
        }
        metadata = await pending.get(key);
      }
    }
    const scheduled = metadata.premiereDate ? metadata.premiereDate > new Date(now()).toISOString().slice(0, 10) : metadata.releaseYear > new Date(now()).getFullYear();
    return { ...metadata, title: displayTitle(metadata), scheduled };
  };
}
