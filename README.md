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

## When the Dukascopy download is blocked

Dukascopy's JSON API (`jetta.dukascopy.com`) can answer plain HTTP clients with **HTTP 202** and an AWS WAF
challenge (`x-amzn-waf-action: challenge`). An HTTP client cannot pass that challenge, so retrying does not help.
The app then tries the legacy `.bi5` feed, which is itself unreliable at times.

What the app does now:

- Any provider request has a 30 s timeout and the **Stop** button aborts it immediately.
- After a 202 the JSON API is not called again for 30 minutes (`DUKASCOPY_JSON_COOLDOWN_MS` to change).
- A job pauses after 3 consecutive failed dates instead of retrying a whole range.
- Failures are never recorded as downloaded data.

- If either endpoint returns HTTP 429, the job now stops immediately (and stops the library's own retry loop after that first response). Use the provider's `Retry-After` value, if present, before attempting another download.

To get data in while the API is blocked, export **Bid** M1 candles from Dukascopy's official historical data
export (choose GMT/UTC) and import the CSV:

~~~
curl -X POST "http://localhost:8080/api/import/candles?symbol=EURUSD&priceType=bid" -F file=@EURUSD_M1.csv
~~~

Add `&utcOffsetMinutes=120` if the file's clock is UTC+2. Rows with invalid OHLC, off-minute times or unknown
dates are rejected and reported; existing candles are never overwritten. Volume is stored exactly as in the file,
so do not mix sources with different volume units for the same symbol.
