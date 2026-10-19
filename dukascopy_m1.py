#!/usr/bin/env python3
"""
Download Dukascopy M1 BID candles day by day and store them in the
MH Forex Replay (Atlas) database through its /api/import/candles endpoint.

Install dependency:
    python3 -m pip install requests

Usage:
    python3 dukascopy_m1.py EURUSD 2019-01-28 2019-01-29
    python3 dukascopy_m1.py USDJPY 2023-06-01 2023-06-30 --app http://localhost:8080
    python3 dukascopy_m1.py EURUSD 2019-01-28 2019-01-29 --force

Only dates whose modeled market coverage is incomplete are fetched by default.
Existing timestamps on fetched days are corrected from the provider's values.
--force re-fetches even dates that appear complete. HTTP 429 stops immediately;
the script never tries to bypass provider rate limits.
"""
import argparse
import csv
import datetime as dt
import io
import json
import lzma
import struct
import sys
import time

import requests

PROVIDER = "https://datafeed.dukascopy.com/datafeed"
RECORD = struct.Struct(">5If")  # seconds-offset, open, close, low, high, volume
OK, NODATA, FAILED, RATE_LIMITED, BLOCKED = "ok", "nodata", "failed", "rate_limited", "blocked"


class StopRun(Exception):
    """Fatal condition: stop the whole run."""


def price_divisor(symbol: str) -> int:
    """Dukascopy price integer scaling: 1e3 for JPY pairs/metals, 1e5 otherwise."""
    s = symbol.upper()
    return 1000 if ("JPY" in s or s in ("XAUUSD", "XAGUSD")) else 100000


def new_session() -> requests.Session:
    session = requests.Session()
    session.headers["User-Agent"] = "Mozilla/5.0 AtlasDownloader/2.1"
    return session


def fetch_day(session, provider, symbol, day, retries, timeout):
    """Returns (status, decompressed payload, session)."""
    url = f"{provider}/{symbol}/{day.year}/{day.month - 1:02d}/{day.day:02d}/BID_candles_min_1.bi5"
    for attempt in range(1, retries + 2):
        try:
            response = session.get(url, timeout=timeout)
        except requests.RequestException as exc:
            print(f"[{type(exc).__name__}, attempt {attempt}] ", end="", flush=True)
            session.close()
            session = new_session()
        else:
            if response.status_code == 404:
                return NODATA, None, session
            if response.status_code == 429:
                wait = response.headers.get("Retry-After", "unknown")
                print(f"\n  Dukascopy rate-limited this request (HTTP 429, Retry-After: {wait}).", file=sys.stderr)
                return RATE_LIMITED, None, session
            if response.status_code == 202:
                print("\n  Dukascopy returned HTTP 202; the request may be blocked by a provider challenge.", file=sys.stderr)
                return BLOCKED, None, session
            if response.status_code == 200:
                if not response.content:
                    return NODATA, None, session
                try:
                    return OK, lzma.decompress(response.content), session
                except lzma.LZMAError as exc:
                    print(f"[corrupt download: {exc}, attempt {attempt}] ", end="", flush=True)
            else:
                print(f"[HTTP {response.status_code}, attempt {attempt}] ", end="", flush=True)
        if attempt <= retries:
            time.sleep(min(2 ** attempt, 30))
    return FAILED, None, session


def decode_day(raw, day, divisor):
    """Decode .bi5 records into (epoch seconds, open, high, low, close, volume)."""
    if len(raw) % RECORD.size:
        raise ValueError(f"unexpected payload length {len(raw)}")
    midnight = int(dt.datetime(day.year, day.month, day.day, tzinfo=dt.timezone.utc).timestamp())
    out = []
    for pos in range(0, len(raw), RECORD.size):
        seconds, open_, close, low, high, volume = RECORD.unpack_from(raw, pos)
        if seconds % 60 or not 0 <= seconds < 86400:
            raise ValueError(f"candle offset {seconds}s is not a whole minute inside the UTC day")
        out.append((midnight + seconds, open_ / divisor, high / divisor, low / divisor, close / divisor, max(0.0, volume)))
    return out


def check_app(app, symbol):
    try:
        health = requests.get(f"{app}/api/health", timeout=10)
        health.raise_for_status()
        instruments_response = requests.get(f"{app}/api/instruments", timeout=10)
        instruments_response.raise_for_status()
        symbols = {item["symbol"] for item in instruments_response.json()}
    except (requests.RequestException, ValueError, KeyError, TypeError) as exc:
        raise StopRun(f"Cannot verify the app at {app}: {exc}\nIs Atlas running? Start it with ./start.sh") from exc
    if symbol not in symbols:
        raise StopRun(f"{symbol} is not an instrument in the app. Available: {', '.join(sorted(symbols))}")


def complete_days(app, symbol, start, end):
    """Return only days modeled as complete/closed; a partial day is re-downloaded."""
    have = set()
    cursor = start
    while cursor <= end:
        chunk_end = min(end, cursor + dt.timedelta(days=365))
        try:
            response = requests.get(
                f"{app}/api/coverage/check",
                timeout=90,
                params={"symbol": symbol, "start": cursor.isoformat(), "end": chunk_end.isoformat()},
            )
            response.raise_for_status()
            daily = response.json().get("daily", [])
        except (requests.RequestException, ValueError, TypeError) as exc:
            raise StopRun(f"Could not check existing Atlas coverage: {exc}") from exc
        for item in daily:
            if item.get("status") in ("complete", "closed"):
                have.add(item["date"])
        cursor = chunk_end + dt.timedelta(days=1)
    return have


def import_day(app, symbol, day, candles, timeout=60, download_id=None):
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(["time", "open", "high", "low", "close", "volume"])
    for timestamp, open_, high, low, close, volume in candles:
        stamp = dt.datetime.fromtimestamp(timestamp, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        writer.writerow([stamp, f"{open_:.8f}", f"{high:.8f}", f"{low:.8f}", f"{close:.8f}", f"{volume:.8f}"])
    try:
        response = requests.post(
            f"{app}/api/import/candles",
            params={"symbol": symbol, "priceType": "bid", "replaceExisting": "true", **({"downloadId": str(download_id)} if download_id is not None else {})},
            timeout=timeout,
            files={"file": (f"{symbol}_{day.isoformat()}.csv", output.getvalue(), "text/csv")},
        )
    except requests.RequestException as exc:
        raise RuntimeError(f"cannot reach Atlas import API: {exc}") from exc
    try:
        body = response.json()
    except ValueError:
        body = {"error": response.text[:300]}
    if not response.ok:
        raise RuntimeError(f"Atlas import API returned HTTP {response.status_code}: {body.get('error', body)}")
    if body.get("accepted") != len(candles) or body.get("rejected") != 0:
        raise RuntimeError(
            f"validation mismatch: sent {len(candles)}, accepted {body.get('accepted')}, "
            f"rejected {body.get('rejected')}; samples: {body.get('rejectSamples', '')}"
        )
    return body


def daterange(start, end):
    while start <= end:
        yield start
        start += dt.timedelta(days=1)


def main():
    parser = argparse.ArgumentParser(description="Download Dukascopy M1 BID data into the Atlas database")
    parser.add_argument("instrument", help="e.g. EURUSD, USDJPY, XAUUSD (must exist in Atlas)")
    parser.add_argument("start", help="start date YYYY-MM-DD")
    parser.add_argument("end", help="end date YYYY-MM-DD (inclusive)")
    parser.add_argument("--app", default="http://localhost:8080", help="Atlas base URL")
    parser.add_argument("--force", action="store_true", help="re-download even dates already covered")
    parser.add_argument("--retries", type=int, default=5, help="retries per day for transient errors (0 = none)")
    parser.add_argument("--passes", type=int, default=2, help="extra passes over days that failed")
    parser.add_argument("--delay", type=float, default=1.0, help="seconds between Dukascopy requests")
    parser.add_argument("--timeout", type=float, default=60, help="Dukascopy request timeout in seconds")
    parser.add_argument("--job-id", type=int, default=None, help=argparse.SUPPRESS)
    parser.add_argument("--provider", default=PROVIDER, help=argparse.SUPPRESS)
    args = parser.parse_args()

    symbol = args.instrument.upper()
    app = args.app.rstrip("/")
    if not symbol.isalnum():
        parser.error("instrument must contain only letters and digits")
    if args.job_id is not None and args.job_id <= 0:
        parser.error("--job-id must be a positive integer")
    if args.retries < 0 or args.passes < 0 or args.delay < 0 or args.timeout <= 0:
        parser.error("retries, passes and delay must be non-negative; timeout must be positive")
    try:
        start = dt.date.fromisoformat(args.start)
        end = dt.date.fromisoformat(args.end)
    except ValueError:
        parser.error("start and end must be YYYY-MM-DD")
    if end < start:
        parser.error("end must be on or after start")
    end = min(end, dt.datetime.now(dt.timezone.utc).date())
    if (end - start).days > 100000:
        parser.error("date range is too large")

    try:
        check_app(app, symbol)
        covered = set() if args.force else complete_days(app, symbol, start, end)
    except StopRun as exc:
        print(exc, file=sys.stderr)
        return 2

    pending = [day for day in daterange(start, end) if day.isoformat() not in covered]
    if covered and not args.force:
        print(f"Skipping {len(covered)} complete/closed day(s); incomplete days will be fetched.")
    if not pending:
        print("Nothing to download; every requested date is already covered or market-closed.")
        return 0

    divisor = price_divisor(symbol)
    session = new_session()
    imported_days = no_data_days = candles_total = 0
    try:
        for pass_no in range(args.passes + 1):
            if not pending:
                break
            if pass_no:
                print(f"\n--- retry pass {pass_no}: {len(pending)} failed day(s) ---")
                time.sleep(10)
            failed = []
            for day in pending:
                print(f"{symbol} {day} ... ", end="", flush=True)
                status, raw, session = fetch_day(session, args.provider, symbol, day, args.retries, args.timeout)
                if status == RATE_LIMITED:
                    raise StopRun("Stopped on HTTP 429. Wait according to the provider's limit before trying again.")
                if status == BLOCKED:
                    raise StopRun("Stopped on HTTP 202/provider challenge. This script will not attempt to bypass it.")
                if status == NODATA:
                    no_data_days += 1
                    print("no data (weekend/holiday)")
                elif status == FAILED:
                    failed.append(day)
                    print("FAILED (will retry on a later pass)")
                else:
                    try:
                        candles = decode_day(raw, day, divisor)
                        body = import_day(app, symbol, day, candles, download_id=args.job_id)
                    except (ValueError, RuntimeError) as exc:
                        raise StopRun(f"\n{day}: STOP — {exc}. No later dates were attempted.") from exc
                    imported_days += 1
                    candles_total += len(candles)
                    print(
                        f"{len(candles)} validated candles (inserted {body.get('inserted', 0)}, "
                        f"corrected {body.get('updated', 0)}, duplicates {body.get('duplicatesIgnored', 0)})"
                    )
                time.sleep(args.delay)
            pending = failed
    except StopRun as exc:
        print(exc, file=sys.stderr)
        return 2
    finally:
        session.close()

    print(f"\nDone. Days imported: {imported_days}, no-data days: {no_data_days}, validated candle rows: {candles_total}.")
    if pending:
        print("These dates still failed after retries; run the same command again later:", file=sys.stderr)
        for day in pending:
            print(f"  {day}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())