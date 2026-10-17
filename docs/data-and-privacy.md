# Data, privacy, and recovery

[← README](../README.md)

## What stays on the server

The catalogue, private notes, viewing dates, mark timestamps, and Trash are stored in the local SQLite database. They are shared with any device that can access this installation; there are no separate user accounts.

The checked-in `seed.json` is a demonstration authored for this repository. Its viewing states and dates are fictional. It contains no personal note export. Existing installations are not replaced by the seed on restart.

## What leaves the server

| Action | Destination | Data |
| --- | --- | --- |
| Uncached metadata lookup | `www.wikidata.org` | Public Kinopoisk ID, public entity IDs, and requested season relationships. |
| Open Kinopoisk | `www.kinopoisk.ru` | The chosen public card URL. |
| Click torrent | `t.me/torrents_2_bot` | Russian/original title and the stored release year in the `text` query parameter. |

The metadata client does not send notes or viewing dates. Third-party websites and clients have their own privacy policies. The app does not send analytics, use advertising scripts, or load external poster images. API keys and signed-in browser cookies are not required for metadata lookup.

## Backups

### Current JSON export

Use **Скачать копию** in the footer, or request `/api/export`. The export includes active entries, Trash, notes, and dates. Treat it as private data. The export endpoint is readable to devices with access to the application.

### Daily snapshot

The app writes `data/backups/YYYY-MM-DD.json` once per UTC day, on startup or before the first mutation. This is the **first snapshot of that day**, not a continuously updated copy. Use the export action for a current snapshot.

### Complete database backup

Stop the app before copying the **entire data directory** to a private backup destination. SQLite may have WAL/SHM sidecar files; copying a live main database file alone is not a safe backup procedure.

Windows example, from the project directory:

```powershell
.\Stop-Films.ps1
Copy-Item -LiteralPath '.\data' -Destination 'D:\PrivateBackups\films-2026-10-17' -Recurse
.\Start-Films.ps1
```

Replace the example destination with your own location. For a foreground process, stop it first with Ctrl+C. For a custom data directory, use that directory consistently.

## Restore without overwriting the current catalogue

1. Stop the application.
2. Copy a complete stopped-server backup into a **new, empty directory**.
3. Start the app with `FILMS_DATA_DIR` pointing at that restored directory.
4. Check the active list, Trash, notes, and viewing dates before retiring the previous data directory.

Windows background example:

```powershell
.\Start-Films.ps1 -DataDirectory 'D:\RestoredData\films'
```

Foreground example:

```powershell
$env:FILMS_DATA_DIR = 'D:\RestoredData\films'
node --disable-warning=ExperimentalWarning server.mjs
```

There is no JSON-import UI in this version. A JSON export is useful for inspection and migration; complete database recovery uses a full data-directory backup.

## Before publishing your own fork

Keep personal databases, exports, backups, logs, local proxy settings, and original note files out of Git. `.gitignore` covers the normal runtime paths, but it cannot protect a renamed export you deliberately add. Screenshots should use demo data or be reviewed before publishing.

The public repository intentionally excludes the original installation's catalogue, network settings, absolute user paths, and migration journals.
