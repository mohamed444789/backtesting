#!/usr/bin/env python3
"""Minimal day-by-day Dukascopy legacy BID M1 downloader; Python standard library only."""
import argparse
import csv
import datetime as dt
import io
import lzma
import struct
import sys
import urllib.error
import urllib.request

RECORD = struct.Struct(">5If")  # milliseconds from UTC day start, OHLC integer pips, volume float


def fetch_day(symbol, day):
    # Dukascopy's legacy feed uses zero-based months in its URL path.
    url = (
        "https://datafeed.dukascopy.com/datafeed/"
        f"{symbol}/{day.year}/{day.month - 1:02d}/{day.day:02d}/BID_candles_min_1.bi5"
    )
    request = urllib.request.Request(url, headers={"User-Agent": "AtlasSimpleDownloader/1.0"})
    with urllib.request.urlopen(request, timeout=25) as response:
        payload = response.read()
    if not payload:
        return [], url
    try:
        raw = lzma.decompress(payload)
    except lzma.LZMAError as exc:
        raise RuntimeError(f"Could not decompress Dukascopy data for {day}: {exc}") from exc
    if len(raw) % RECORD.size:
        raise RuntimeError(f"Unexpected .bi5 payload length {len(raw)} for {day}")
    candles = []
    midnight = dt.datetime.combine(day, dt.time(), tzinfo=dt.timezone.utc)
    for offset in range(0, len(raw), RECORD.size):
        millis, op, hi, lo, close, volume = RECORD.unpack_from(raw, offset)
        timestamp = int(midnight.timestamp()) + millis // 1000
        # Dukascopy candle prices are integers scaled by 1e-5 for FX and metals.
        scale = 100000.0
        candles.append((timestamp, op / scale, hi / scale, lo / scale, close / scale, max(0.0, volume)))
    return candles, url


def import_day(app, symbol, day, candles):
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(["time", "open", "high", "low", "close", "volume"])
    for timestamp, op, hi, lo, close, volume in candles:
        stamp = dt.datetime.fromtimestamp(timestamp, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        writer.writerow([stamp, f"{op:.8f}", f"{hi:.8f}", f"{lo:.8f}", f"{close:.8f}", f"{volume:.8f}"])
    boundary = "----AtlasSimpleDownloaderBoundary7MA4YWxkTrZu0gW"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{symbol}_{day.isoformat()}.csv"\r\n'
        "Content-Type: text/csv\r\n\r\n"
        + output.getvalue()
        + f"\r\n--{boundary}--\r\n"
    ).encode("utf-8")
    url = f"{app.rstrip('/')}/api/import/candles?symbol={symbol}&priceType=bid"
    req = urllib.request.Request(url, data=body, method="POST", headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=30) as response:
        return response.status, response.read().decode("utf-8", "replace")


def main():
    parser = argparse.ArgumentParser(description="Download Dukascopy BID M1 candles one calendar day at a time.")
    parser.add_argument("--symbol", required=True, help="Atlas instrument, e.g. EURUSD or XAUUSD")
    parser.add_argument("--start", required=True, help="First date, YYYY-MM-DD")
    parser.add_argument("--end", required=True, help="Last date, YYYY-MM-DD (inclusive)")
    parser.add_argument("--app", default="http://localhost:8080", help="Atlas base URL")
    args = parser.parse_args()
    symbol = args.symbol.upper()
    if not symbol.isalnum():
        parser.error("--symbol must contain only letters and digits")
    try:
        start = dt.date.fromisoformat(args.start)
        end = dt.date.fromisoformat(args.end)
    except ValueError:
        parser.error("--start and --end must be YYYY-MM-DD")
    if end < start:
        parser.error("--end must be on or after --start")
    if (end - start).days > 36600:
        parser.error("date range is too large")
    current = start
    successful = 0
    total = 0
    while current <= end:
        print(f"{current}: fetching {symbol} BID M1...", flush=True)
        try:
            candles, url = fetch_day(symbol, current)
            if not candles:
                print(f"{current}: no candles returned; skipping this date.", flush=True)
            else:
                status, response = import_day(args.app, symbol, current, candles)
                print(f"{current}: imported {len(candles)} candles (HTTP {status}); {response}", flush=True)
                successful += 1
                total += len(candles)
        except urllib.error.HTTPError as exc:
            print(f"{current}: STOP — provider/import HTTP {exc.code} {exc.reason}. No retries were made.", file=sys.stderr, flush=True)
            if exc.code == 429:
                print("Dukascopy rate-limited this request. Wait before trying again; this script will not bypass the limit.", file=sys.stderr)
            return 2
        except (urllib.error.URLError, TimeoutError, OSError, RuntimeError) as exc:
            print(f"{current}: STOP — {exc}. No retries were made.", file=sys.stderr, flush=True)
            return 2
        current += dt.timedelta(days=1)
    print(f"Done. Days with data imported: {successful}; candle rows sent: {total}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
