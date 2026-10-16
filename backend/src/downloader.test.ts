import test from 'node:test';
import assert from 'node:assert/strict';
import { DownloadCancelledError, fetchDateCandles } from './downloader.js';

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


test('does not retry a malformed empty day at the outer layer', async () => {
  let calls = 0;

  await assert.rejects(
    fetchDateCandles({
      date,
      maxAttempts: 6,
      request: async () => {
        calls++;
        return [];
      },
      sleep: async () => {
        assert.fail('A non-retryable empty-day error should not back off and repeat');
      },
    }),
    /Provider returned no valid M1 candles/,
  );

  assert.equal(calls, 1);
});
