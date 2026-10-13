# Atlas Forex Replay

Local-first forex replay, charting, trading journal, analytics, and Dukascopy M1 historical-data downloader. Runs locally with Docker Compose; no broker connection is required.

## Quick start

1. Install Docker Desktop (Windows) or Docker Engine with Compose v2 (Linux/WSL2).
2. In the project directory, run `./setup.sh` (or `./setup.ps1` in PowerShell).
3. Open `http://localhost:8080`.

## Useful commands

- Build and start: `docker compose up -d --build`
- Logs: `docker compose logs -f`
- Validate: `./validate.sh` (PowerShell: `./validate.ps1`)
- Back up: `./backup.sh` (PowerShell: `./backup.ps1`)

## Data safety

The app stores its database and downloaded candles in a persistent Docker volume. Do not run `docker compose down -v` unless you intentionally want to delete that volume. Back up before applying schema or replay changes. The app binds to localhost by default and has no multi-user authentication; do not expose it to a network.

## Limitations

Historical data are Dukascopy bid OHLC rather than tick-level bid/ask data. Intrabar stop/target collisions use conservative stop-first handling. This is a local practice simulator, not a live broker connection.
