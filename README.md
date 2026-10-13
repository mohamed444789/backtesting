# MH Forex Replay

A local-first forex backtesting and replay application with charting,
a trading journal, analytics, and Dukascopy historical-data downloads.

## Requirements

- Docker Desktop on Windows, or Docker Engine with Compose v2 on Linux/WSL2.

## Quick start

Linux / WSL2:

    ./setup.sh

Windows PowerShell:

    ./setup.ps1

Open the URL printed by the setup script, usually http://localhost:8080.

## Useful commands

- Start: `./start.sh`
- Stop: `./stop.sh`
- Validate: `./validate.sh`
- Back up: `./backup.sh`
- Restore: `./restore.sh path/to/backup.tar.gz`
- Rebuild: `docker compose up -d --build`
- Logs: `docker compose logs -f`

PowerShell equivalents are included.

## Data safety

The application stores its database, downloaded market data, and
screenshots in a persistent Docker volume.

Back up your data before applying database or replay changes.
Do not run `docker compose down -v` unless you intend to delete
the persistent volume.

The app binds to localhost by default and has no multi-user
authentication. Do not expose it directly to an untrusted network.

## Limitations

Historical candles are Dukascopy bid OHLC data, not tick-level bid/ask
data. Intrabar stop/target collisions use conservative stop-first
handling. This is a local practice simulator, not a live broker connection.
