import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFilm, toFilm, isPrivateAddress } from './lib.mjs';
import { createMetadataLookup } from './metadata.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const lookupMetadata = createMetadataLookup({ catalog: JSON.parse(readFileSync(path.join(root, 'metadata-catalog.json'), 'utf8')) });
const dataDir = path.resolve(process.env.FILMS_DATA_DIR || path.join(root, 'data'));
mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'films.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
  CREATE TABLE IF NOT EXISTS films (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', kinopoisk_url TEXT NOT NULL DEFAULT '',
    watched INTEGER NOT NULL DEFAULT 0, watched_at TEXT, marked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    source_order INTEGER NOT NULL, source_text TEXT, version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);

const columns = new Set(db.prepare('PRAGMA table_info(films)').all().map(column => column.name));
for (const [name, type] of [['release_year', 'INTEGER'], ['deleted_at', 'TEXT'], ['additional_links', "TEXT NOT NULL DEFAULT '[]'"]]) {
  if (!columns.has(name)) db.exec(`ALTER TABLE films ADD COLUMN ${name} ${type}`);
}

if (!db.prepare("SELECT value FROM metadata WHERE key='seeded'").get()) {
  const seed = JSON.parse(readFileSync(path.join(root, 'seed.json'), 'utf8'));
  const insert = db.prepare('INSERT INTO films (id,title,note,kinopoisk_url,watched,watched_at,marked_at,created_at,updated_at,source_order,source_text,release_year,additional_links) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const f of seed.films) insert.run(f.id, f.title, f.note, f.kinopoiskUrl, Number(f.watched), f.watchedAt, f.markedAt, now, now, f.sourceOrder, f.sourceText, f.releaseYear ?? null, JSON.stringify(f.additionalLinks ?? []));
    db.prepare('INSERT INTO metadata VALUES (?,?)').run('seeded', now);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

const allFilms = (trash = false) => db.prepare(`SELECT * FROM films WHERE deleted_at IS ${trash ? 'NOT ' : ''}NULL ORDER BY source_order`).all().map(toFilm);
const snapshot = () => ({ schemaVersion: 2, exportedAt: new Date().toISOString(), films: allFilms(), trash: allFilms(true) });
function dailyBackup() {
  const filename = path.join(dataDir, 'backups', `${new Date().toISOString().slice(0, 10)}.json`);
  if (!existsSync(filename)) writeFileSync(filename, JSON.stringify(snapshot(), null, 2), { encoding: 'utf8', flag: 'wx' });
}
dailyBackup();

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']], ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']], ['/sort.mjs', ['sort.mjs', 'text/javascript; charset=utf-8']],
  ['/torrent.mjs', ['torrent.mjs', 'text/javascript; charset=utf-8']],
  ['/apple-touch-icon.png', ['apple-touch-icon.png', 'image/png']]
]);
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY'
};
function json(res, status, payload) { res.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(payload)); }
async function readBody(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('Ожидался JSON.'), { status: 415 });
  let bytes = 0, chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 16384) throw Object.assign(new Error('Слишком большой запрос.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Некорректный JSON.'); }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!isPrivateAddress(req.socket.remoteAddress)) return json(res, 403, { error: 'Доступ разрешён только из домашней сети.' });
    const host = req.headers.host || '';
    let hostname;
    try { hostname = new URL(`http://${host}`).hostname; } catch { return json(res, 400, { error: 'Неверный адрес.' }); }
    if (!(hostname === 'localhost' || hostname === 'films.loc' || hostname === '[::1]' || isPrivateAddress(hostname))) return json(res, 403, { error: 'Неизвестное имя сервера.' });
    if (!['GET', 'HEAD'].includes(req.method) && (!req.headers.origin || req.headers.origin !== `http://${host}`))
      return json(res, 403, { error: 'Запрос должен быть отправлен с этого сайта.' });
    const url = new URL(req.url, `http://${host}`);
    if (req.method === 'GET' && url.pathname === '/api/films') return json(res, 200, { films: allFilms() });
    if (req.method === 'GET' && url.pathname === '/api/trash') return json(res, 200, { films: allFilms(true) });
    if (req.method === 'POST' && url.pathname === '/api/kinopoisk/lookup') {
      const metadata = await lookupMetadata(await readBody(req));
      return json(res, 200, { metadata });
    }
    if (req.method === 'GET' && url.pathname === '/api/export') {
      res.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="films-${new Date().toISOString().slice(0, 10)}.json"` });
      return res.end(JSON.stringify(snapshot(), null, 2));
    }
    if (req.method === 'POST' && url.pathname === '/api/films') {
      const body = await readBody(req);
      const f = validateFilm(body);
      const now = new Date().toISOString(), id = randomUUID();
      dailyBackup();
      const order = db.prepare('SELECT COALESCE(MAX(source_order),0)+1 AS n FROM films').get().n;
      db.prepare('INSERT INTO films (id,title,note,kinopoisk_url,watched,watched_at,marked_at,created_at,updated_at,source_order,release_year,additional_links) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, f.title, f.note, f.kinopoiskUrl, Number(f.watched), f.watchedAt, f.watched ? now : null, now, now, order, f.releaseYear, JSON.stringify(f.additionalLinks));
      return json(res, 201, { film: toFilm(db.prepare('SELECT * FROM films WHERE id=?').get(id)) });
    }
    const match = url.pathname.match(/^\/api\/films\/([\w-]+)$/);
    if (req.method === 'PATCH' && match) {
      const body = await readBody(req);
      const row = db.prepare('SELECT * FROM films WHERE id=?').get(match[1]);
      if (!row) return json(res, 404, { error: 'Фильм не найден.' });
      const old = toFilm(row);
      if (body.version !== old.version) return json(res, 409, { error: 'Запись уже изменена на другом устройстве. Обновите список и повторите.' });
      if (body.deleted !== undefined && typeof body.deleted !== 'boolean') return json(res, 400, { error: 'Некорректный статус удаления.' });
      if (old.deletedAt && body.deleted !== false) return json(res, 409, { error: 'Фильм в корзине. Сначала восстановите его.' });
      const f = validateFilm(body, old), now = new Date().toISOString();
      const markedAt = f.watched ? (old.watched ? old.markedAt : now) : null;
      const deletedAt = body.deleted === true ? now : body.deleted === false ? null : old.deletedAt;
      dailyBackup();
      db.prepare('UPDATE films SET title=?,note=?,kinopoisk_url=?,watched=?,watched_at=?,marked_at=?,updated_at=?,release_year=?,deleted_at=?,additional_links=?,version=version+1 WHERE id=?')
        .run(f.title, f.note, f.kinopoiskUrl, Number(f.watched), f.watchedAt, markedAt, now, f.releaseYear, deletedAt, JSON.stringify(f.additionalLinks), old.id);
      return json(res, 200, { film: toFilm(db.prepare('SELECT * FROM films WHERE id=?').get(old.id)) });
    }
    if (['GET', 'HEAD'].includes(req.method) && assets.has(url.pathname)) {
      const [name, type] = assets.get(url.pathname), filename = path.join(root, 'public', name);
      res.writeHead(200, { ...securityHeaders, 'Content-Type': type, 'Content-Length': statSync(filename).size });
      return res.end(req.method === 'HEAD' ? undefined : readFileSync(filename));
    }
    return json(res, 404, { error: 'Страница не найдена.' });
  } catch (error) {
    if (error.code?.startsWith('ERR_SQLITE') || error.code?.startsWith('E')) {
      console.error(new Date().toISOString(), error.code, error.message);
      return json(res, 500, { error: 'Не удалось сохранить данные. Проверьте свободное место и журнал сервера.' });
    }
    return json(res, error.status || 400, { error: error.message || 'Ошибка запроса.' });
  }
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
const port = Number(process.env.PORT || 8766), bind = process.env.HOST || '127.0.0.1';
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, bind, () => console.log(`Films ready: http://127.0.0.1:${port} | data: ${dataDir}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
