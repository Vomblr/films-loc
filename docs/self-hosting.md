# Self-hosting

[← README](../README.md)

## Configuration

The server reads the following environment variables. It does not load `.env` files automatically.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Interface to listen on. |
| `PORT` | `8766` | HTTP port. |
| `FILMS_DATA_DIR` | `<project>/data` | SQLite, backups, and runtime files. Use an absolute path for predictable service setups. |
| `FILMS_AVAILABILITY_NETWORK` | enabled | Set to `0` to disable outbound Kinopoisk availability checks and background sweeps. Cached results and manual choices remain readable. |
| `FILMS_RATINGS_NETWORK` | enabled | Set to `0` to disable rating/review/description lookups and their background sweeps. Previously cached fields remain readable. This is independent of streaming-availability checks. |

### Windows

```powershell
$env:HOST = '0.0.0.0'
$env:PORT = '8766'
node --disable-warning=ExperimentalWarning server.mjs
```

Or use the optional hidden background process:

```powershell
.\Start-Films.ps1 -BindAddress '0.0.0.0' -Port 8766
.\Stop-Films.ps1
```

With a custom data directory, pass the same directory to Start and Stop. Node.js 24 must be on `PATH`; the scripts need PowerShell 7.4+.

### Linux / macOS

```sh
HOST=0.0.0.0 PORT=8766 FILMS_DATA_DIR=/absolute/path/to/films-data \
  node --disable-warning=ExperimentalWarning server.mjs
```

For an unattended server, run this command with the service manager you already use, under a dedicated unprivileged account with write access to the data directory. Set the working directory to the project checkout. The repository does not install a system service.

## Connect an iPhone or another device

1. Start the server with a LAN binding, as above.
2. Find the computer's LAN IPv4 address.
3. From a device on the same trusted Wi-Fi, open `http://SERVER_LAN_IP:8766/`.
4. If Windows asks about network access, restrict any permission you choose to the private network and the intended port. The project does not change firewall rules automatically.

Do not use `localhost` on the phone: it refers to the phone itself. A sleeping or powered-off computer cannot serve the app. Guest Wi-Fi isolation can also prevent access.

## Optional `films.loc` name

Create a record in your router or other local DNS that maps `films.loc` to the server's reserved LAN address. Client devices must use that DNS resolver. Configure a DHCP reservation so the address does not drift.

Without a reverse proxy, open:

```text
http://films.loc:8766/
```

For port 80 and a clean `http://films.loc/` address, run a reverse proxy on the same host. An illustrative [Caddyfile](../Caddyfile.example) is included:

```caddyfile
http://films.loc {
    reverse_proxy 127.0.0.1:8766
}
```

This is a configuration example, not an automatic router/proxy installer. Preserve the original `Host` header. If you already serve other sites, add a separate host route instead of replacing their configuration.

The current write-origin check expects HTTP. HTTPS termination requires a deliberate update to proxy-aware origin validation; adding a TLS proxy alone is not sufficient for working write requests.

The server accepts `localhost`, `films.loc`, loopback, and private IPv4 hostnames/addresses. Other custom hostnames need an intentional change to the host allowlist in `server.mjs`. Direct private IPv6 access is not supported by the current address checks; IPv6 loopback is supported.

## iPhone home-screen shortcut

Open the site in Safari, then use **Share → Add to Home Screen**. A web manifest and Apple touch icon are included. This is a shortcut to the live server: there is no offline service worker or background sync.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Local browser cannot connect | Node.js 24 is installed; the chosen port is free; inspect the terminal or `data/server-error.log`. |
| PC works, phone does not | LAN binding, same network, firewall scope, guest-network isolation, and PC sleep state. |
| IP works, name does not | Local DNS record and the DNS resolver used by the device. |
| Metadata fields stay empty | Inspect the message under the form. Wikidata might have no exact match, original title, or season date. Manual entry still works. |
| Kinopoisk shows a question mark | The source could not confirm an offer. Open the editor to retry, inspect the check time, or set a manual confirmation. Challenges are never treated as proof of unavailability. |
| A score or review counter shows `—` | The score may be unpublished, or the source could not provide the field. The editor can refresh the main card's Kinopoisk data. Missing values are not converted to zero. |
| A description does not fill the note | The exact Kinopoisk card may have no public description or its response may be unavailable. Existing manual notes are preserved. You can always type your own text. |
| Planned refresh pauses | Inspect the reason below **Обновить непросмотренные**. Wait before retrying a source limit, or restore connectivity. Completed writes remain stored. Closing the browser does not stop the job; use **Остановить**. |
| An edit is rejected | Another device changed the same entry. Reload and retry using the current version. |
| Telegram opens without a query | Start the bot if necessary, paste the copied query, then press Send. Client support for prepared text varies. |
| Clipboard fallback appears | Select/copy the shown text manually. The LAN HTTP site cannot rely on the modern HTTPS-only Clipboard API. |

## Updates

Back up the data directory before updating. Stop the application, update the source, run the tests, and restart. Additive schema migrations run on startup. Keep the data directory across updates; `seed.json` is imported only into a new database.

Before switching to an older version, restore a matching full data backup into a fresh directory. A database created by a newer schema is not guaranteed to work with older code.
