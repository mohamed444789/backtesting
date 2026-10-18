import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DukascopyUpstreamResponseError,
  withDukascopyResponseDiagnostics,
  jsonApiCooldownRemainingMs,
  noteJsonApiBlocked,
  resetJsonApiCooldown,
} from './downloader.js';
import { parseCandleCsv, parseCandleTime } from './csv-import.js';
import { sanitizeLogMessage } from './download-utils.js';

const URL1 = 'https://jetta.dukascopy.com/v1/candles/minute/EUR-USD/BID/2026/4/21';

async function withFakeFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await run(); } finally { globalThis.fetch = original; }
}

test('a stalled provider request is cut off by the per-attempt timeout (body read included)', async () => {
  const stalled = ((_u: unknown, init?: RequestInit) => new Promise((_res, rej) => {
    init?.signal?.addEventListener('abort', () => rej(init.signal!.reason), { once: true });
  })) as typeof fetch;
  // AbortSignal.timeout() uses an unref'd timer; a real socket keeps the loop alive in production, so the test needs a handle.
  const keepAlive = setInterval(() => {}, 25);
  try {
    await withFakeFetch(stalled, async () => {
      const started = Date.now();
      await assert.rejects(withDukascopyResponseDiagnostics(() => fetch(URL1), { timeoutMs: 120 }), /timed out|TimeoutError|aborted/i);
      assert.ok(Date.now() - started < 2000);
    });
  } finally { clearInterval(keepAlive); }
});

test('the Stop signal aborts an in-flight provider request', async () => {
  const stalled = ((_u: unknown, init?: RequestInit) => new Promise((_res, rej) => {
    init?.signal?.addEventListener('abort', () => rej(init.signal!.reason), { once: true });
  })) as typeof fetch;
  await withFakeFetch(stalled, async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('stopped by user')), 50);
    await assert.rejects(withDukascopyResponseDiagnostics(() => fetch(URL1), { signal: ac.signal }), /stopped by user/);
  });
});

test('global fetch is restored after success, failure and timeout', async () => {
  const original = globalThis.fetch;
  const ok = (async () => new Response('{}', { status: 200 })) as typeof fetch;
  await withFakeFetch(ok, async () => {
    const mine = globalThis.fetch;
    await withDukascopyResponseDiagnostics(() => fetch(URL1), { timeoutMs: 500 });
    assert.equal(globalThis.fetch, mine);
    await assert.rejects(withDukascopyResponseDiagnostics(async () => { throw new Error('boom'); }, { timeoutMs: 500 }));
    assert.equal(globalThis.fetch, mine);
  });
  assert.equal(globalThis.fetch, original);
});

test('a plain 202 (no WAF header) is reported as HTTP 202 with diagnostics, not as missing candles', async () => {
  const f = (async () => new Response('', { status: 202, headers: { 'content-type': 'text/html; charset=UTF-8' } })) as typeof fetch;
  await withFakeFetch(f, async () => {
    await assert.rejects(withDukascopyResponseDiagnostics(async () => { await fetch(URL1); throw new Error('Request failed with status 202'); }), (e: unknown) => {
      assert.ok(e instanceof DukascopyUpstreamResponseError);
      assert.equal(e.diagnostic.status, 202);
      assert.equal(e.isChallenge, false);
      assert.match(e.message, /DUKASCOPY_HTTP_202/);
      assert.equal(e.diagnostic.url, URL1);
      return true;
    });
  });
});

test('transient failure then 200 still succeeds through the guard', async () => {
  let n = 0;
  const f = (async () => (++n === 1 ? new Response('', { status: 503 }) : new Response('{"ok":true}', { status: 200 }))) as typeof fetch;
  await withFakeFetch(f, async () => {
    const result = await withDukascopyResponseDiagnostics(async () => {
      for (let i = 0; i < 3; i++) { const r = await fetch(URL1); if (r.status === 200) return r.json(); }
      throw new Error('never');
    }, { timeoutMs: 500 });
    assert.deepEqual(result, { ok: true });
  });
});

test('JSON API cool-down starts on demand, expires, and can be reset', () => {
  resetJsonApiCooldown();
  assert.equal(jsonApiCooldownRemainingMs(), 0);
  noteJsonApiBlocked(1_000_000);
  assert.ok(jsonApiCooldownRemainingMs(1_000_000 + 60_000) > 0);
  assert.equal(jsonApiCooldownRemainingMs(1_000_000 + 31 * 60_000), 0); // default 30 min
  resetJsonApiCooldown();
  assert.equal(jsonApiCooldownRemainingMs(1_000_001), 0);
});

// ------------------------------- CSV import ---------------------------------------------------------
test('parses a Dukascopy export (dd.MM.yyyy, GMT) with header', () => {
  const csv = 'Gmt time,Open,High,Low,Close,Volume\n21.04.2026 00:00:00.000,1.17000,1.17010,1.16990,1.17005,10.5\n21.04.2026 00:01:00.000,1.17005,1.17015,1.16985,1.17010,20.25\n';
  const r = parseCandleCsv(csv);
  assert.equal(r.candles.length, 2);
  assert.equal(r.candles[0].time, Date.UTC(2026, 3, 21) / 1000);
  assert.equal(r.candles[1].time - r.candles[0].time, 60);
  assert.equal(r.candles[0].volume, 10.5);
  assert.equal(r.rejected, 0);
});

test('applies a declared UTC offset to zone-less times', () => {
  const r = parseCandleCsv('time,open,high,low,close\n2026-04-21 02:00:00,1.1,1.2,1.0,1.15\n', { utcOffsetMinutes: 120 });
  assert.equal(r.candles[0].time, Date.UTC(2026, 3, 21, 0, 0) / 1000);
});

test('accepts headerless MetaTrader style rows and semicolon delimiters', () => {
  assert.equal(parseCandleCsv('2026.04.21 00:00,1.1,1.2,1.0,1.15,5\n2026.04.21 00:01,1.15,1.2,1.1,1.18,6\n').candles.length, 2);
  assert.equal(parseCandleCsv('time;open;high;low;close\n2026-04-21T00:00:00Z;1,1;1,2;1,0;1,15\n').candles.length, 1);
});

test('rejects bad rows instead of importing them: invalid OHLC, off-minute, bad date, duplicates keep first', () => {
  const csv = [
    'time,open,high,low,close,volume',
    '2026-04-21 00:00:00,1.1,1.2,1.0,1.15,5',
    '2026-04-21 00:00:00,9,9,9,9,9',          // duplicate timestamp: first wins
    '2026-04-21 00:01:00,1.1,1.0,1.2,1.15,5', // high < low
    '2026-04-21 00:02:30,1.1,1.2,1.0,1.15,5', // not on a minute
    '31.02.2026 00:00:00,1.1,1.2,1.0,1.15,5', // impossible date
    '2026-04-21 00:03:00,abc,1.2,1.0,1.15,5', // non numeric
  ].join('\n');
  const r = parseCandleCsv(csv);
  assert.equal(r.candles.length, 1);
  assert.equal(r.candles[0].open, 1.1);
  assert.equal(r.rejected, 4);
  assert.ok(r.rejectSamples.length > 0 && r.rejectSamples.length <= 5);
});

test('a header without the required columns is an error, and an empty file yields no candles', () => {
  assert.throws(() => parseCandleCsv('foo,bar\n1,2\n'), /must contain time, open, high, low and close/);
  assert.equal(parseCandleCsv('').candles.length, 0);
});

test('time parser: epoch, zone-less (UTC + declared offset) and explicit-zone ISO', () => {
  assert.equal(parseCandleTime('1776729600'), 1776729600);
  assert.equal(parseCandleTime('1776729600000'), 1776729600);
  assert.equal(parseCandleTime('2026-04-21T00:00:00'), Date.UTC(2026, 3, 21) / 1000);
  assert.equal(parseCandleTime('2026-04-21T02:00:00', 120), Date.UTC(2026, 3, 21) / 1000);
  assert.equal(parseCandleTime('2026-04-21T02:00:00+02:00'), Date.UTC(2026, 3, 21) / 1000);
  assert.equal(parseCandleTime('2026-04-21T02:00:00+02:00', 999), Date.UTC(2026, 3, 21) / 1000); // offset ignored when a zone is present
  assert.ok(Number.isNaN(parseCandleTime('not a time')));
});

test('log sanitizer collapses line breaks but never alters ordinary letters', () => {
  assert.equal(sanitizeLogMessage('Request failed\r\nerror: provider returned HTTP 202'), 'Request failed error: provider returned HTTP 202');
  assert.equal(sanitizeLogMessage('rrr nnn \\ ok'), 'rrr nnn \\ ok');
  assert.equal(sanitizeLogMessage('x'.repeat(2000)).length, 1200);
});


test('HTTP 429 stops retries at the first rate-limited network response', async () => {
  let networkCalls = 0;
  const f = (async () => {
    networkCalls++;
    return new Response(JSON.stringify({ message: 'Too Many Requests' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '60' },
    });
  }) as typeof fetch;

  await withFakeFetch(f, async () => {
    await assert.rejects(
      withDukascopyResponseDiagnostics(async () => {
        // Simulate a library retry loop. Only its first HTTP request should reach the provider.
        for (let attempt = 0; attempt < 6; attempt++) {
          const response = await fetch(URL1);
          if (response.status === 200) return response;
        }
        throw new Error('request attempts exhausted');
      }, { timeoutMs: 500 }),
      (error: unknown) => {
        assert.ok(error instanceof DukascopyUpstreamResponseError);
        assert.equal(error.diagnostic.status, 429);
        assert.equal(error.isRateLimited, true);
        assert.match(error.message, /DUKASCOPY_RATE_LIMITED/);
        assert.equal(error.diagnostic.retryAfter, '60');
        return true;
      },
    );
  });

  assert.equal(networkCalls, 1);
});
