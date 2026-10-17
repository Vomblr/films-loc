import { sortFilms } from './sort.mjs';
import { torrentRequests, torrentUrl } from './torrent.mjs';
const $ = id => document.getElementById(id);
let films = [], trash = [], filter = 'all', editing = null, undoAction = null, toastTimer, refreshPending = false;
let sorting = 'watched-desc';
try { sorting = localStorage.getItem('films-sort') || sorting; } catch {}
if (![...$('sort').options].some(o => o.value === sorting)) sorting = 'watched-desc';
$('sort').value = sorting;
const busy = new Set();
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dateLabel = value => new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${value}T12:00:00`));
const stampLabel = value => new Intl.DateTimeFormat('ru', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
function errorIn(id, error) { $(id).textContent = error?.message || ''; $(id).hidden = !error; }
let metadataTimer, metadataSequence = 0, metadataPending = null, metadataKey = '', adding = false;
let autoTitle = null, autoYear = null;
const looksLikeLink = text => /^https?:\/\//i.test(text.trim());
const metadataFormKey = () => `${$('add-url').value.trim()}|${$('add-season').value}`;
function metadataStatus(message, error = false, metadata = null) {
  const status = $('metadata-status'); status.replaceChildren(document.createTextNode(message));
  status.hidden = !message; status.dataset.error = String(error);
  if (metadata) {
    const source = make('a', '', metadata.source); source.href = metadata.sourceUrl; source.target = '_blank'; source.rel = 'noopener noreferrer';
    status.append(document.createTextNode(' Источник: '), source, document.createTextNode('.'));
  }
}
function resetLookup({ clearAuto = false } = {}) {
  clearTimeout(metadataTimer); metadataSequence++; metadataPending = null; metadataKey = '';
  if (clearAuto) {
    if ($('add-title').value === autoTitle) $('add-title').value = '';
    if ($('add-year').value === autoYear) $('add-year').value = '';
    autoTitle = autoYear = null;
  }
  $('fill-metadata').disabled = false; document.querySelector('.add-button').disabled = adding;
  metadataStatus('');
}
async function fillMetadata(force = false) {
  clearTimeout(metadataTimer);
  const key = metadataFormKey();
  if (!force && key === metadataKey) return;
  if (metadataPending?.key === key) return metadataPending.promise;
  const sequence = ++metadataSequence, titleBefore = $('add-title').value, yearBefore = $('add-year').value;
  const seasonValue = $('add-season').value;
  $('fill-metadata').disabled = true; document.querySelector('.add-button').disabled = true;
  metadataStatus('Ищем названия и дату премьеры…');
  const promise = (async () => {
    try {
      const { metadata } = await request('/api/kinopoisk/lookup', { method: 'POST', body: JSON.stringify({ url: $('add-url').value.trim(), season: seasonValue ? Number(seasonValue) : null }) });
      if (sequence !== metadataSequence || key !== metadataFormKey()) return;
      let keptManual = false;
      if ($('add-title').value === titleBefore && (force || !titleBefore.trim() || looksLikeLink(titleBefore) || titleBefore === autoTitle)) {
        $('add-title').value = metadata.title; autoTitle = metadata.title;
      } else keptManual = true;
      if ($('add-year').value === yearBefore && (force || !yearBefore || yearBefore === autoYear)) {
        $('add-year').value = metadata.releaseYear || ''; autoYear = $('add-year').value;
      } else keptManual = true;
      $('add-url').value = metadata.kinopoiskUrl;
      $('season-fields').hidden = metadata.kind !== 'series';
      $('add-details').open = true;
      metadataKey = metadataFormKey();
      const yearLabel = metadata.season ? `Выход ${metadata.season} сезона` : metadata.kind === 'series' ? 'Начало сериала' : 'Первая премьера';
      const result = metadata.releaseYear ? `${yearLabel}: ${metadata.releaseYear}${metadata.scheduled ? ' (ожидается)' : ''}.` : 'Названия найдены.';
      metadataStatus(`${result}${keptManual ? ' Ваши правки сохранены; кнопка «Заполнить» заменит поля.' : ''}${metadata.warnings.length ? ' ' + metadata.warnings.join(' ') : ''}`, false, metadata);
    } catch (error) {
      if (sequence !== metadataSequence) return;
      metadataKey = key;
      metadataStatus(error.name === 'TimeoutError' ? 'Источник не ответил вовремя. Попробуйте ещё раз или заполните вручную.' : error.message, true);
      $('add-details').open = true;
    } finally {
      if (sequence === metadataSequence) {
        metadataPending = null; $('fill-metadata').disabled = false; document.querySelector('.add-button').disabled = adding;
      }
    }
  })();
  metadataPending = { key, promise }; return promise;
}
function urlChanged() {
  resetLookup({ clearAuto: true }); $('add-season').value = '';
  $('season-fields').hidden = !/^https:\/\/(www\.)?kinopoisk\.ru\/series\//i.test($('add-url').value.trim());
  if ($('add-url').value.trim()) metadataTimer = setTimeout(() => fillMetadata(), 450);
}
$('add-url').addEventListener('input', urlChanged);
$('add-title').addEventListener('input', () => {
  const text = $('add-title').value.trim();
  if (/^https:\/\/(www\.)?kinopoisk\.ru\/(film|series)\/\d+\/?(?:[?#].*)?$/i.test(text)) {
    $('add-url').value = text; $('add-details').open = true; urlChanged();
  }
});
$('add-season').addEventListener('input', () => { resetLookup({ clearAuto: true }); if ($('add-url').value.trim()) metadataTimer = setTimeout(() => fillMetadata(), 450); });
$('fill-metadata').addEventListener('click', () => fillMetadata(true));
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, cache: 'no-store', signal: AbortSignal.timeout(12000), headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Не удалось выполнить запрос.');
  return result;
}
async function load() {
  if (refreshPending) return;
  refreshPending = true;
  try {
    const [result, deleted] = await Promise.all([request('/api/films'), request('/api/trash')]);
    if (JSON.stringify(result.films) !== JSON.stringify(films) || JSON.stringify(deleted.films) !== JSON.stringify(trash) || $('film-list').getAttribute('aria-busy') === 'true') {
      films = result.films; trash = deleted.films; render();
    }
    $('connection').hidden = true;
  } catch {
    $('connection').textContent = 'Нет связи с домашним сервером. Проверьте Wi-Fi и включён ли ПК. Несохранённые изменения не применяются.';
    $('connection').hidden = false;
  } finally { refreshPending = false; $('film-list').setAttribute('aria-busy', 'false'); }
}
function toast(message, action = null) {
  clearTimeout(toastTimer); undoAction = action;
  $('toast-text').textContent = message; $('undo').hidden = !action; $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; undoAction = null; }, action ? 10000 : 5500);
}
function make(tag, className, text) { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; }
function copyTorrentMessage(text) {
  // films.loc uses HTTP on the LAN: the Clipboard API requires HTTPS.
  // The synchronous fallback also keeps the Telegram link in the original user gesture.
  const field = make('textarea', 'copy-buffer'); field.value = text; field.readOnly = true; field.tabIndex = -1;
  const focused = document.activeElement;
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const start = focused?.selectionStart, end = focused?.selectionEnd;
  try {
    document.body.append(field); field.focus({ preventScroll: true }); field.select(); field.setSelectionRange(0, text.length);
    return Boolean(document.execCommand('copy'));
  } catch { return false; }
  finally {
    field.remove(); focused?.focus({ preventScroll: true });
    if (typeof start === 'number' && typeof focused?.setSelectionRange === 'function') focused.setSelectionRange(start, end);
    else if (selection) { selection.removeAllRanges(); ranges.forEach(range => selection.addRange(range)); }
  }
}
function render() {
  const watched = films.filter(f => f.watched).length;
  $('count-all').textContent = films.length; $('count-planned').textContent = films.length - watched; $('count-watched').textContent = watched; $('count-trash').textContent = trash.length;
  $('summary').textContent = `${films.length - watched} в планах · ${watched} уже посмотрели`;
  const query = $('search').value.trim().toLocaleLowerCase('ru').replaceAll('ё', 'е');
  const inTrash = filter === 'trash';
  const matches = f => `${f.title} ${f.releaseYear || ''} ${f.note}`.toLocaleLowerCase('ru').replaceAll('ё', 'е').includes(query);
  const selected = inTrash ? trash.filter(matches).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt)) : sortFilms(films.filter(f => (filter === 'all' || f.watched === (filter === 'watched')) && matches(f)), sorting);
  const fragment = document.createDocumentFragment();
  for (const status of (inTrash ? [null] : [false, true])) {
    const entries = selected.filter(f => inTrash || f.watched === status);
    if (!entries.length) continue;
    const section = make('section', 'film-group');
    const heading = make('h2', 'group-heading', inTrash ? 'Корзина' : status ? 'Просмотрено' : 'В планах');
    heading.append(make('span', '', String(entries.length))); section.append(heading);
    for (const f of entries) {
      const row = make('article', `film-row${f.watched ? ' watched' : ''}`); row.dataset.id = f.id;
      const check = make('button', 'check-button'); check.type = 'button'; check.disabled = busy.has(f.id);
      if (inTrash) { check.dataset.restore = f.id; check.setAttribute('aria-label', `Восстановить: ${f.title}`); }
      else { check.dataset.toggle = f.id; check.setAttribute('aria-label', `${f.watched ? 'Вернуть в планы' : 'Отметить просмотренным'}: ${f.title}`); check.setAttribute('aria-pressed', String(f.watched)); }
      const circle = make('span', 'check-circle', inTrash ? '↶' : f.watched ? '✓' : ''); circle.setAttribute('aria-hidden', 'true'); check.append(circle);
      const content = make('div', 'film-content'); content.append(make('h3', 'film-title', f.title));
      if (f.note || f.releaseYear) {
        const note = make('p', 'film-note');
        const comment = f.releaseYear ? f.note.replace(new RegExp(`^${f.releaseYear}(?:[ \\t]*год(?:а)?)?(?:[ \\t]*[,·:][ \\t]*|[ \\t]+|$)`, 'gm'), '').trim() : f.note;
        if (f.releaseYear) note.append(make('span', 'release-year', String(f.releaseYear)));
        if (comment) note.append(document.createTextNode((f.releaseYear ? ' · ' : '') + comment));
        content.append(note);
      }
      const meta = make('div', 'film-meta');
      const link = make('a', 'kp-link', f.kinopoiskUrl ? 'Кинопоиск ↗' : 'Найти на Кинопоиске ↗');
      link.href = f.kinopoiskUrl || `https://www.kinopoisk.ru/index.php?kp_query=${encodeURIComponent(f.title)}`; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', `${f.kinopoiskUrl ? 'Кинопоиск' : 'Найти на Кинопоиске'}: ${f.title}`); meta.append(link);
      for (const extra of f.additionalLinks || []) {
        const additional = make('a', 'kp-link', `${extra.label} ↗`); additional.href = extra.url; additional.target = '_blank'; additional.rel = 'noopener noreferrer'; meta.append(additional);
      }
      for (const query of torrentRequests(f)) {
        const torrent = make('a', 'torrent-link', `${query.label} ↗`);
        torrent.href = torrentUrl(query.message); torrent.target = '_blank'; torrent.rel = 'noopener noreferrer';
        torrent.dataset.torrentQuery = query.message; torrent.title = query.message;
        torrent.setAttribute('aria-label', `torrent: ${query.message}`); meta.append(torrent);
      }
      if (f.watched) {
        const date = make('span', 'watched-date', f.watchedAt ? `Просмотрено ${dateLabel(f.watchedAt)}` : 'Дата просмотра не указана');
        if (f.markedAt) date.title = `Отметка поставлена ${stampLabel(f.markedAt)}`;
        meta.append(date);
      }
      if (inTrash) meta.append(make('span', 'watched-date', 'Удалено ' + stampLabel(f.deletedAt)));
      content.append(meta);
      const edit = make('button', 'edit-button', '⋯'); edit.type = 'button'; edit.dataset.edit = f.id; edit.setAttribute('aria-label', `Изменить: ${f.title}`);
      row.append(check, content); if (!inTrash) row.append(edit); section.append(row);
    }
    fragment.append(section);
  }
  $('film-list').replaceChildren(fragment); $('empty').hidden = selected.length !== 0;
  $('empty-text').textContent = query ? 'Попробуйте другое название или очистите поиск.' : inTrash ? 'Удалённые фильмы появятся здесь. Их можно будет восстановить.' : filter === 'watched' ? 'Первый просмотренный фильм появится здесь после отметки.' : 'Добавьте фильм в строке выше.';
}
$('film-list').addEventListener('click', event => {
  const link = event.target.closest('[data-torrent-query]');
  if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const message = link.dataset.torrentQuery;
  if (copyTorrentMessage(message)) {
    toast('Запрос скопирован. Если Telegram не подставит текст, вставьте его из буфера.');
    return;
  }
  $('torrent-message').value = message; $('open-torrent-bot').href = link.href;
  $('torrent-copy-status').textContent = 'Не удалось скопировать автоматически. Скопируйте строку и отправьте её боту одним сообщением.';
  $('torrent-dialog').showModal(); $('torrent-message').focus(); $('torrent-message').select();
});
$('close-torrent').addEventListener('click', () => $('torrent-dialog').close());
$('copy-torrent').addEventListener('click', () => {
  $('torrent-copy-status').textContent = copyTorrentMessage($('torrent-message').value) ? 'Скопировано. Откройте бота, вставьте строку и нажмите «Отправить».' : 'Зажмите текст, выберите «Скопировать», затем вставьте его в Telegram.';
});
$('torrent-dialog').addEventListener('click', event => { if (event.target === $('torrent-dialog')) { const r = event.target.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) event.target.close(); } });
async function patch(film, values) {
  const { film: saved } = await request(`/api/films/${film.id}`, { method: 'PATCH', body: JSON.stringify({ ...values, version: film.version }) });
  films = films.filter(f => f.id !== saved.id); trash = trash.filter(f => f.id !== saved.id);
  (saved.deletedAt ? trash : films).push(saved); render(); return saved;
}
async function restore(film) {
  if (busy.has(film.id)) return;
  busy.add(film.id); render();
  try { await patch(film, { deleted: false }); toast('Фильм восстановлен'); }
  catch (e) { toast(e.message); await load(); }
  finally { busy.delete(film.id); render(); }
}
async function toggle(film) {
  if (busy.has(film.id)) return;
  busy.add(film.id); render();
  try {
    const saved = await patch(film, { watched: !film.watched, watchedAt: film.watched ? null : today() });
    toast(film.watched ? 'Снова в планах' : 'Просмотрено. Перенесли в конец списка.', async () => {
      await patch(saved, { watched: film.watched, watchedAt: film.watchedAt }); toast('Отметка отменена');
    });
  } catch (e) { toast(e.message); await load(); }
  finally { busy.delete(film.id); render(); }
}
$('film-list').addEventListener('click', event => {
  const toggleButton = event.target.closest('[data-toggle]'), editButton = event.target.closest('[data-edit]'), restoreButton = event.target.closest('[data-restore]');
  if (restoreButton) { const f = trash.find(f => f.id === restoreButton.dataset.restore); if (f) restore(f); }
  if (toggleButton) { const f = films.find(f => f.id === toggleButton.dataset.toggle); if (f) toggle(f); }
  if (editButton) {
    editing = { ...films.find(f => f.id === editButton.dataset.edit) };
    $('edit-title').value = editing.title; $('edit-note').value = editing.note; $('edit-url').value = editing.kinopoiskUrl; $('edit-year').value = editing.releaseYear || '';
    $('date-fields').hidden = !editing.watched; $('edit-date').value = editing.watchedAt || ''; $('edit-date').max = today();
    $('marked-info').textContent = editing.markedAt ? `Отметка поставлена ${stampLabel(editing.markedAt)}` : 'Перенесено из Apple Notes без даты отметки.';
    errorIn('edit-error', null); $('edit-dialog').showModal();
  }
});
$('add-form').addEventListener('submit', async event => {
  event.preventDefault(); errorIn('add-error', null);
  if (adding) return;
  adding = true;
  const button = event.submitter || document.querySelector('.add-button'); button.disabled = true;
  try {
    if (looksLikeLink($('add-title').value) && !$('add-url').value.trim()) { $('add-url').value = $('add-title').value.trim(); resetLookup(); }
    if ($('add-url').value.trim() && metadataFormKey() !== metadataKey) await fillMetadata();
    const title = $('add-title').value.trim();
    if (!title) throw new Error('Введите название фильма.');
    if (looksLikeLink(title)) throw new Error('Не удалось заполнить название по ссылке. Введите его вручную в верхней строке.');
    const { film } = await request('/api/films', { method: 'POST', body: JSON.stringify({ title, note: $('add-note').value, kinopoiskUrl: $('add-url').value, releaseYear: $('add-year').value ? Number($('add-year').value) : null }) });
    films.push(film); $('add-form').reset(); resetLookup(); autoTitle = autoYear = null; $('season-fields').hidden = true; $('add-details').open = false;
    filter = 'all'; $('search').value = ''; updateTabs(); render(); toast('Добавлено в планы'); $('add-title').focus();
  } catch (e) { errorIn('add-error', e); }
  finally { adding = false; button.disabled = false; }
});
$('edit-form').addEventListener('submit', async event => {
  event.preventDefault(); errorIn('edit-error', null); event.submitter.disabled = true;
  try {
    await patch(editing, { title: $('edit-title').value, note: $('edit-note').value, kinopoiskUrl: $('edit-url').value, releaseYear: $('edit-year').value ? Number($('edit-year').value) : null, watchedAt: editing.watched ? $('edit-date').value || null : null });
    $('edit-dialog').close(); toast('Сохранено');
  } catch (e) { errorIn('edit-error', e); }
  finally { event.submitter.disabled = false; }
});
$('delete-film').addEventListener('click', async event => {
  event.currentTarget.disabled = true; errorIn('edit-error', null);
  try {
    const deleted = await patch(editing, { deleted: true }); $('edit-dialog').close();
    toast('Фильм перемещён в корзину', async () => { await patch(deleted, { deleted: false }); toast('Фильм восстановлен'); });
  } catch (e) { errorIn('edit-error', e); }
  finally { $('delete-film').disabled = false; }
});
function updateTabs() { document.querySelectorAll('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === filter))); }
document.querySelector('.tabs').addEventListener('click', event => { const button = event.target.closest('[data-filter]'); if (button) { filter = button.dataset.filter; updateTabs(); render(); } });
$('search').addEventListener('input', render);
$('sort').addEventListener('change', () => { sorting = $('sort').value; try { localStorage.setItem('films-sort', sorting); } catch {} render(); });
for (const id of ['close-edit', 'cancel-edit']) $(id).addEventListener('click', () => $('edit-dialog').close());
$('edit-dialog').addEventListener('click', event => { if (event.target === $('edit-dialog')) { const r = event.target.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) event.target.close(); } });
$('undo').addEventListener('click', async () => { const action = undoAction; $('toast').hidden = true; undoAction = null; if (action) try { await action(); } catch (e) { toast(e.message); await load(); } });
window.addEventListener('focus', load); document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
setInterval(() => { if (!document.hidden && !$('edit-dialog').open && !$('torrent-dialog').open && !busy.size) load(); }, 15000);
load();
