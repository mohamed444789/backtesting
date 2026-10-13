# Atlas Forex Replay

<<<<<<< HEAD
Local-first forex replay, charting, trading journal, analytics and Dukascopy M1 data downloader. No cloud account or broker connection.

## First run
- Install and start Docker Desktop (Windows/macOS) or Docker Engine + Compose v2 (Linux).
- Windows PowerShell: `./setup.ps1`
- macOS/Linux: `chmod +x setup.sh && ./setup.sh`
- Open the URL printed (usually `http://localhost:8080`).

## Operate
- Start: `./start.sh` / `./start.ps1`
- Stop: `./stop.sh` / `./stop.ps1`
- Validate: `./validate.sh` / `./validate.ps1`
- Backup: `./backup.sh` / `./backup.ps1`
- Restore: `./restore.sh path/to/backup.tar.gz` / `./restore.ps1 -Archive path/to/backup.zip`

Database and files are in named Docker volume `atlas_forex_replay_data`. Do not run `docker compose down -v` unless intentionally deleting persistent data. The app binds to localhost by default and has no multi-user authentication; do not expose it to a network.

## Important limitations
Data are Dukascopy historical bid OHLC, not tick-level bid/ask. Provider availability and `dukascopy-node` API behavior may change. M1 intrabar stop/target collisions use stop-first. Position P&L currently assumes 100,000 units per lot and is not a complete pip-value/account-currency conversion engine; configurable spread/slippage/commission settings are stored but are not fully applied to fills. Replay is a local practice simulator, not a live broker connection.
# backtesting
=======
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
>>>>>>> 2a6c899b514608e8227b1d906c624a13c033c298
