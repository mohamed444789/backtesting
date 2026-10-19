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

## Built-in downloader (Historical Data → Download)

The Historical Data UI runs the checked-in root `dukascopy_m1.py` as a managed Python subprocess. This is the same code path as running the working command-line downloader: `requests.Session`, the `Mozilla/5.0 AtlasDownloader/2.1` User-Agent, one daily `.bi5` request at a time, LZMA decoding, coverage checks, CSV validation/import, and retry passes.

The UI keeps the existing download-job row and streams the Python output into the application logs. A hidden `--job-id` option associates CSV imports with that parent job instead of creating a separate history row per day. Stop terminates the Python process.

The Docker runtime installs Python 3 and `requests`, and includes the root script. For a non-Docker local runtime, install `requests` for the Python interpreter used by the backend (`python3 -m pip install requests`). Set `PYTHON_EXECUTABLE` if the backend should use a Python executable other than `python3`.

The Python downloader retries transient request failures, waits one second between dates, and makes additional passes over dates that failed transiently. HTTP 429 and provider HTTP 202 challenges stop the job immediately; the downloader does not attempt to bypass provider rate limits or challenges.

## When the Dukascopy download is blocked

Dukascopy's JSON API (`jetta.dukascopy.com`) can answer plain HTTP clients with **HTTP 202** and an AWS WAF
challenge (`x-amzn-waf-action: challenge`). An HTTP client cannot pass that challenge, so retrying does not help.
The app then tries the legacy `.bi5` feed, which is itself unreliable at times.

When `DUKASCOPY_JSON_API=1` enables the JSON-API mode, the app:

- Any provider request has a 30 s timeout and the **Stop** button terminates the built-in Python worker immediately.
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

## Simple day-by-day Python downloader

The same downloader is checked into the repository root as `dukascopy_m1.py`, so after pulling the branch you can run it directly from `~/backtesting` without downloading it from the UI. The **Simple Python Downloader** menu still offers a browser download at `/dukascopy_m1.py` (the copy in `frontend/public`).

The script downloads one legacy Dukascopy BID M1 file at a time and imports it through `/api/import/candles`. It checks the app's modeled minute coverage and re-fetches incomplete dates; existing candle timestamps on fetched dates are corrected with Dukascopy values. The server rejects the whole replacement import if any row fails validation. Standard CSV imports continue to preserve existing candles by default.

From the repository root, install its one dependency and run the checked-in script:

```sh
python3 -m pip install requests
python3 dukascopy_m1.py EURUSD 2019-01-28 2019-01-29 --app http://localhost:8080
```

Use `--force` to re-fetch dates that appear complete. Temporary provider errors are retried with backoff; HTTP 429 stops immediately, and HTTP 202/provider challenges stop without attempting to bypass them. If the legacy feed continues returning HTTP 503, wait and try later or use Dukascopy's official CSV export. The downloader cannot override provider-side outages or rate limits.

## Python downloader verification

The day-by-day Python downloader has been successfully run in a local Atlas environment. It checks existing candle coverage, downloads Dukascopy BID M1 data one day at a time, and validates that every submitted row was accepted before continuing. Provider-side HTTP 429 or 202 challenge responses stop the run rather than attempting to bypass them.

Run it with:

```sh
python3 -m pip install requests
python3 dukascopy_m1.py EURUSD 2019-01-28 2019-01-29 --app http://localhost:8080
```
