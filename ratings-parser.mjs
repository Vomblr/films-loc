// Public Kinopoisk rating and viewer-review counters. Source scripts are parsed as JSON, never executed.
function balancedObject(source, start) {
  if (source[start] !== '{') return null;
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try { return JSON.parse(source.slice(start, index + 1)); } catch { return null; }
    }
  }
  return null;
}

export function extractKinopoiskPublicState(html) {
  let nextData = null, ssrData = null;
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bid\s*=\s*["']__NEXT_DATA__["']/i.test(match[1])) {
      try { nextData = JSON.parse(match[2]); } catch { /* Unknown schema. */ }
    }
    const assignment = /\bwindow\.Ya\.__ssr_initial_data\s*=\s*/g.exec(match[2]);
    if (assignment) ssrData = balancedObject(match[2], assignment.index + assignment[0].length);
  }
  const candidates = [
    ssrData?.apolloState?.data, ssrData?.apolloState,
    nextData?.props?.apolloState?.data,
    nextData?.props?.pageProps?.apolloState?.data,
  ];
  const state = candidates.find(value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length);
  return { nextData, state: state || null };
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function parseKinopoiskRating(html, id) {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const { nextData, state } = extractKinopoiskPublicState(html);
  if (!state) return null;
  const props = nextData?.props?.pageProps;
  let type, rootField;
  if (Number(props?.filmId) === id) { type = 'Film'; rootField = 'film'; }
  else if (Number(props?.tvSeriesId) === id) { type = 'TvSeries'; rootField = 'tvSeries'; }
  else return null;
  const key = `${type}:${id}`;
  const entity = state[key];
  const root = state.ROOT_QUERY?.[`${rootField}({"id":${id}})`];
  if (entity?.__typename !== type || entity.id !== id || root?.__ref !== key) return null;
  const rating = entity.rating?.kinopoisk;
  if (!rating || typeof rating.isActive !== 'boolean') return null;
  if (rating.isActive && rating.value !== null && !(typeof rating.value === 'number' && Number.isFinite(rating.value) && rating.value > 0 && rating.value <= 10)) return null;
  const value = rating?.isActive === true && typeof rating.value === 'number' &&
    Number.isFinite(rating.value) && rating.value > 0 && rating.value <= 10 ? rating.value : null;
  return {
    id, entityType: type, value,
    votes: nonnegativeInteger(rating?.count),
    reviewTotal: nonnegativeInteger(entity['userReviews({"limit":0})']?.total),
  };
}

function attribute(source, name) {
  const match = source.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? match[1] ?? match[2] ?? match[3] : null;
}

function hasClass(source, name) {
  return (attribute(source, 'class') || '').split(/\s+/).includes(name);
}

function text(source) {
  return source.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/\s+/g, ' ').trim();
}

export function parseKinopoiskViewerReviews(html, id) {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  // This is the reviews page's own back-link, not a related-title recommendation.
  const identities = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)].filter(match =>
    hasClass(match[1], 'all') &&
    new RegExp(`^/(?:film|series)/${id}/$`).test(attribute(match[1], 'href') || '') &&
    /^К описанию (?:фильма|сериала)/u.test(text(match[2])));
  if (identities.length !== 1) return null;
  const blocks = [...html.matchAll(/<ul\b([^>]*)>([\s\S]*?)<\/ul\s*>/gi)].filter(match => hasClass(match[1], 'resp_type'));
  if (blocks.length !== 1) return null;
  const expected = {
    all: { label: /^Все\s*:/u, output: 'total' },
    pos: { label: /^Положительные\s*:/u, output: 'positive', status: 'good' },
    neg: { label: /^Отрицательные\s*:/u, output: 'negative', status: 'bad' },
    neut: { label: /^Нейтральные\s*:/u, output: 'neutral', status: 'neutral' },
  };
  const counts = {};
  for (const item of blocks[0][2].matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li\s*>/gi)) {
    for (const [className, config] of Object.entries(expected)) {
      if (!hasClass(item[1], className)) continue;
      if (Object.hasOwn(counts, config.output) || !config.label.test(text(item[2]))) return null;
      const bolds = [...item[2].matchAll(/<b\b[^>]*>([\s\S]*?)<\/b\s*>/gi)];
      const raw = bolds.length === 1 ? text(bolds[0][1]).replace(/\s/g, '') : '';
      if (!/^\d+$/.test(raw)) return null;
      const count = nonnegativeInteger(Number(raw));
      if (count === null) return null;
      if (config.status) {
        const anchor = item[2].match(/<a\b([^>]*)>/i);
        const href = attribute(anchor?.[1] || '', 'href')?.replace(/&amp;/g, '&');
        if (!anchor && count !== 0) return null;
        if (anchor) {
          let url;
          try { url = new URL(href, 'https://www.kinopoisk.ru'); } catch { return null; }
          if (url.origin !== 'https://www.kinopoisk.ru' || url.pathname !== `/film/${id}/reviews/` ||
              url.searchParams.get('status') !== config.status) return null;
        }
      }
      counts[config.output] = count;
    }
  }
  if (Object.values(expected).some(config => !Object.hasOwn(counts, config.output))) return null;
  if (counts.positive + counts.negative + counts.neutral !== counts.total) return null;
  return { id, ...counts };
}
