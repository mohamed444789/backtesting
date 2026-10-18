import test from 'node:test';
import assert from 'node:assert/strict';
import { DownloadCancelledError, DukascopyUpstreamResponseError, buildDukascopyLegacyM1Config, buildDukascopyM1Config, fetchDateCandles, withDukascopyResponseDiagnostics } from './downloader.js';

const date = '2026-10-16';
const start = Date.parse(date + 'T00:00:00.000Z');

function row(offsetMinutes: number, close = 1.1) {
  return {
    timestamp: start + offsetMinutes * 60_000,
    open: 1.0,
    high: Math.max(1.2, close),
    low: 0.9,
    close,
    volume: 10,
  };
}

test('normalizes, filters, sorts, and deduplicates provider candles', async () => {
  const result = await fetchDateCandles({
    date,
    maxAttempts: 1,
    request: async () => [
      row(2),
      row(1, 1.05),
      row(1, 1.07),
      { ...row(-1), timestamp: start - 60_000 },
      { ...row(3), high: 0.8 },
      [start + 3 * 60_000, 1.0, 1.2, 0.9, 1.1, 5],
    ],
  });

  assert.equal(result.attempts, 1);
  assert.equal(result.empty, false);
  assert.deepEqual(result.candles.map(candle => candle.time), [
    Math.floor(start / 1000) + 60,
    Math.floor(start / 1000) + 120,
    Math.floor(start / 1000) + 180,
  ]);
  assert.equal(result.candles[0].close, 1.07);
  assert.equal(result.candles[2].volume, 5);
});

test('retries transient network errors, then completes the date', async () => {
  let calls = 0;
  const retryDelays: number[] = [];
  const sleepDelays: number[] = [];
  const result = await fetchDateCandles({
    date,
    maxAttempts: 4,
    request: async () => {
      calls++;
      if (calls < 3) throw new Error('fetch failed');
      return [row(0)];
    },
    sleep: async milliseconds => { sleepDelays.push(milliseconds); },
    onRetry: info => { retryDelays.push(info.delayMs); },
  });

  assert.equal(calls, 3);
  assert.equal(result.attempts, 3);
  assert.equal(result.candles.length, 1);
  assert.deepEqual(retryDelays, [1500, 3000]);
  assert.deepEqual(sleepDelays, [1500, 3000]);
});

test('bounds persistent network failures instead of retrying forever', async () => {
  let calls = 0;
  const waits: number[] = [];
  await assert.rejects(
    fetchDateCandles({
      date,
      maxAttempts: 3,
      request: async () => {
        calls++;
        throw Object.assign(new Error('connect ETIMEDOUT provider:443'), { code: 'ETIMEDOUT' });
      },
      sleep: async milliseconds => { waits.push(milliseconds); },
    }),
    /ETIMEDOUT/,
  );

  assert.equal(calls, 3);
  assert.deepEqual(waits, [1500, 3000]);
});

test('an expected empty Sunday response is not treated as a failed job', async () => {
  const result = await fetchDateCandles({
    date: '2026-10-18',
    allowEmpty: true,
    maxAttempts: 2,
    request: async () => [],
  });

  assert.deepEqual(result, { candles: [], attempts: 1, empty: true });
});

test('cancellation interrupts retry backoff', async () => {
  let cancelled = false;
  let calls = 0;

  await assert.rejects(
    fetchDateCandles({
      date,
      maxAttempts: 4,
      isCancelled: () => cancelled,
      request: async () => {
        calls++;
        throw new Error('fetch failed');
      },
      sleep: async () => { cancelled = true; },
    }),
    error => error instanceof DownloadCancelledError,
  );

  assert.equal(calls, 1);
});

test('rejects malformed dates rather than allowing JavaScript date rollover', async () => {
  await assert.rejects(
    fetchDateCandles({ date: '2026-02-31', request: async () => [] }),
    /Invalid download date/,
  );
});


test('retries empty weekday responses and succeeds when candles become available', async () => {
  let calls = 0;
  const delays: number[] = [];

  const result = await fetchDateCandles({
    date,
    maxAttempts: 4,
    request: async () => {
      calls++;
      return calls < 3 ? [] : [row(0)];
    },
    sleep: async milliseconds => { delays.push(milliseconds); },
  });

  assert.equal(calls, 3);
  assert.equal(result.candles.length, 1);
  assert.deepEqual(delays, [1500, 3000]);
});


test('builds the documented single-day M1 config with persistent cache and bounded retries', () => {
  const config = buildDukascopyM1Config('EURUSD', date, '/data/dukascopy-cache');

  assert.equal(config.instrument, 'eurusd');
  assert.equal(config.timeframe, 'm1');
  assert.equal(config.priceType, 'bid');
  assert.equal(config.format, 'json');
  assert.equal(config.utcOffset, 0);
  assert.equal(config.volumes, true);
  assert.equal(config.volumeUnits, 'millions');
  assert.equal(config.ignoreFlats, false);
  assert.equal(config.batchSize, 1);
  assert.equal(config.pauseBetweenBatchesMs, 1000);
  assert.equal(config.useCache, true);
  assert.equal(config.cacheFolderPath, '/data/dukascopy-cache');
  assert.equal(config.retryCount, 5);
  assert.equal(config.retryOnEmpty, true);
  assert.equal(config.failAfterRetryCount, true);
  assert.equal(config.pauseBetweenRetriesMs, 2000);
  assert.equal(config.dates.from.toISOString(), date + 'T00:00:00.000Z');
  assert.equal(config.dates.to.toISOString(), '2026-10-17T00:00:00.000Z');
  assert.equal(config.dates.to.getTime() - config.dates.from.getTime(), 86_400_000);
});

test('rejects an empty instrument or cache path', () => {
  assert.throws(() => buildDukascopyM1Config('', date, '/cache'), /Instrument is required/);
  assert.throws(() => buildDukascopyM1Config('eurusd', date, ''), /Cache folder path is required/);
});


test('detects AWS WAF HTTP 202 challenges and suppresses further provider requests', async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls++;
    return new Response('', {
      status: 202,
      headers: {
        'server': 'CloudFront',
        'x-amzn-waf-action': 'challenge',
        'content-type': 'text/html; charset=UTF-8',
        'content-length': '0',
      },
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      withDukascopyResponseDiagnostics(async () => {
        // Simulate the library's internal retry loop. After a confirmed
        // challenge, the wrapper must not issue more outbound requests.
        for (let attempt = 0; attempt < 6; attempt++) {
          const response = await fetch('https://jetta.dukascopy.com/v1/candles/minute/EUR-USD/BID/2019/1/4');
          if (response.status === 200) return response;
        }
        throw new Error('Request failed with status 202');
      }),
      (error: unknown) => {
        assert.ok(error instanceof DukascopyUpstreamResponseError);
        assert.equal(error.diagnostic.status, 202);
        assert.equal(error.diagnostic.wafAction, 'challenge');
        assert.equal(error.isChallenge, true);
        assert.match(error.message, /AWS WAF challenge/);
        return true;
      },
    );

    assert.equal(networkCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('builds a separate legacy .bi5 M1 config for the fallback library', () => {
  const config = buildDukascopyLegacyM1Config('EURUSD', date, '/data/dukascopy-legacy-cache');

  assert.equal(config.instrument, 'eurusd');
  assert.equal(config.timeframe, 'm1');
  assert.equal(config.priceType, 'bid');
  assert.equal(config.format, 'json');
  assert.equal(config.utcOffset, 0);
  assert.equal(config.volumes, true);
  assert.equal(config.volumeUnits, 'millions');
  assert.equal(config.ignoreFlats, false);
  assert.equal(config.batchSize, 1);
  assert.equal(config.pauseBetweenBatchesMs, 1000);
  assert.equal(config.useCache, true);
  assert.equal(config.cacheFolderPath, '/data/dukascopy-legacy-cache');
  assert.equal(config.retryCount, 2);
  assert.equal(config.retryOnEmpty, true);
  assert.equal(config.pauseBetweenRetriesMs, 1000);
  assert.equal(config.dates.from.toISOString(), date + 'T00:00:00.000Z');
  assert.equal(config.dates.to.toISOString(), '2026-10-17T00:00:00.000Z');
});
