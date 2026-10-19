import test from 'node:test';
import assert from 'node:assert/strict';
import { DukascopyUpstreamResponseError } from './downloader.js';
import { assertPlausibleLzmaHeader, bi5PriceDivisor, buildBi5Url, decodeBi5Records, fetchBi5Day, BI5_USER_AGENT } from './bi5.js';

const RAW = Buffer.from('AAAAAAACSmsAAkptAAJKaAACSnI/wAAAAAAAPAACSm0AAkpvAAJKagACSnMAAAAAAAAAeAACSm8AAkpsAAJKaQACSnFAEAAA', 'base64');
const LZMA = Buffer.from('XQAAgAD//////////wAAaP7lxjyWEnoVg4M2nHhYDTMo3akiI9Qtusdii6KIiS5eVWKxR0vc//r4fAA=', 'base64');
const LZMA_KNOWN_SIZE = Buffer.from('XQAAgABIAAAAAAAAAAAAaP7lxjyWEnoVg4M2nHhYDTMo3akiI9Qtusdii6KIiS5eVWKxR0vc//r4fAA=', 'base64');

const response = (status: number, body: Uint8Array | null = null, headers: Record<string, string> = {}) =>
  new Response(body as BodyInit | null, { status, headers });

test('price divisor: 1e3 for JPY pairs and metals, 1e5 otherwise', () => {
  assert.equal(bi5PriceDivisor('USDJPY'), 1000);
  assert.equal(bi5PriceDivisor('eurjpy'), 1000);
  assert.equal(bi5PriceDivisor('XAUUSD'), 1000);
  assert.equal(bi5PriceDivisor('EURUSD'), 100000);
  assert.equal(bi5PriceDivisor('AUDUSD'), 100000);
});

test('URL uses an upper-case symbol and a zero-based month', () => {
  assert.equal(
    buildBi5Url('https://datafeed.dukascopy.com/datafeed/', 'eurusd', '2024-01-02'),
    'https://datafeed.dukascopy.com/datafeed/EURUSD/2024/00/02/BID_candles_min_1.bi5',
  );
  assert.equal(buildBi5Url('http://x', 'AUDUSD', '2026-08-31'), 'http://x/AUDUSD/2026/07/31/BID_candles_min_1.bi5');
  assert.throws(() => buildBi5Url('http://x', 'EURUSD', '2024-1-2'), /Invalid date/);
  assert.throws(() => buildBi5Url('http://x', '../etc', '2024-01-02'), /Invalid instrument/);
});

test('decodes seconds offsets, open/close/low/high order and scale', () => {
  const candles = decodeBi5Records(new Uint8Array(RAW), '2024-01-02', 1000);
  assert.equal(candles.length, 3);
  const midnight = Date.parse('2024-01-02T00:00:00Z');
  assert.deepEqual(candles[0], { timestamp: midnight, open: 150.123, high: 150.13, low: 150.12, close: 150.125, volume: 1.5 });
  assert.equal(candles[1].timestamp, midnight + 60_000);
  assert.equal(candles[1].volume, 0);
  assert.equal(candles[2].timestamp, midnight + 120_000);
  assert.equal(candles[2].volume, 2.25);
});

test('rejects malformed payloads instead of importing wrong timestamps', () => {
  assert.throws(() => decodeBi5Records(new Uint8Array(RAW.subarray(0, 25)), '2024-01-02', 1000), /not a multiple of 24/);
  const bad = new Uint8Array(RAW);
  new DataView(bad.buffer).setUint32(0, 61);
  assert.throws(() => decodeBi5Records(bad, '2024-01-02', 1000), /whole minute/);
  new DataView(bad.buffer).setUint32(0, 86_400_000);
  assert.throws(() => decodeBi5Records(bad, '2024-01-02', 1000), /whole minute/);
});

test('fetchBi5Day downloads, decompresses and decodes a day', async () => {
  let seen: { url: string; ua: string | null } | null = null;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen = { url, ua: new Headers(init.headers).get('user-agent') };
    return response(200, LZMA);
  }) as unknown as typeof fetch;
  const candles = await fetchBi5Day({ symbol: 'USDJPY', date: '2024-01-02', baseUrl: 'http://feed', fetchImpl });
  assert.equal(candles.length, 3);
  assert.equal(candles[0].open, 150.123);
  assert.equal(seen!.url, 'http://feed/USDJPY/2024/00/02/BID_candles_min_1.bi5');
  assert.equal(seen!.ua, BI5_USER_AGENT);
});

test('decodes both LZMA header styles (known and unknown uncompressed size)', async () => {
  for (const body of [LZMA, LZMA_KNOWN_SIZE]) {
    const fetchImpl = (async () => response(200, body)) as unknown as typeof fetch;
    const candles = await fetchBi5Day({ symbol: 'USDJPY', date: '2024-01-02', fetchImpl });
    assert.equal(candles.length, 3);
    assert.equal(candles[2].close, 150.124);
  }
});

test('rejects bodies whose LZMA header could make the decoder allocate gigabytes', () => {
  const html = Buffer.from('<html>blocked</html>');
  assert.throws(() => assertPlausibleLzmaHeader(html), /not a valid LZMA/);
  assert.throws(() => assertPlausibleLzmaHeader(Buffer.alloc(5)), /only 5 bytes/);
  const hugeSize = Buffer.from(LZMA_KNOWN_SIZE);
  hugeSize.writeUInt32LE(0x7fffffff, 5);
  assert.throws(() => assertPlausibleLzmaHeader(hugeSize), /uncompressed size/);
  const hugeDict = Buffer.from(LZMA_KNOWN_SIZE);
  hugeDict.writeUInt32LE(0x7fffffff, 1);
  assert.throws(() => assertPlausibleLzmaHeader(hugeDict), /dictionary size/);
  const badProps = Buffer.from(LZMA_KNOWN_SIZE);
  badProps[0] = 0xff;
  assert.throws(() => assertPlausibleLzmaHeader(badProps), /properties/);
  assertPlausibleLzmaHeader(LZMA);
  assertPlausibleLzmaHeader(LZMA_KNOWN_SIZE);
});

test('404 and empty bodies mean "no file", not a failure', async () => {
  const make = (r: () => Response) => (async () => r()) as unknown as typeof fetch;
  assert.deepEqual(await fetchBi5Day({ symbol: 'EURUSD', date: '2024-01-06', fetchImpl: make(() => response(404)) }), []);
  assert.deepEqual(await fetchBi5Day({ symbol: 'EURUSD', date: '2024-01-06', fetchImpl: make(() => response(200, new Uint8Array())) }), []);
});

test('429, 202 and 403 stop the job; 5xx is a retryable plain error', async () => {
  const make = (r: () => Response) => (async () => r()) as unknown as typeof fetch;
  const limited = await fetchBi5Day({
    symbol: 'EURUSD', date: '2024-01-02', fetchImpl: make(() => response(429, null, { 'retry-after': '120' })),
  }).catch(e => e);
  assert.ok(limited instanceof DukascopyUpstreamResponseError);
  assert.equal(limited.isRateLimited, true);
  assert.equal(limited.diagnostic.retryAfter, '120');

  const challenge = await fetchBi5Day({
    symbol: 'EURUSD', date: '2024-01-02', fetchImpl: make(() => response(202, null, { 'x-amzn-waf-action': 'challenge' })),
  }).catch(e => e);
  assert.ok(challenge instanceof DukascopyUpstreamResponseError);
  assert.equal(challenge.isChallenge, true);

  const forbidden = await fetchBi5Day({ symbol: 'EURUSD', date: '2024-01-02', fetchImpl: make(() => response(403)) }).catch(e => e);
  assert.ok(forbidden instanceof DukascopyUpstreamResponseError);

  const unavailable = await fetchBi5Day({ symbol: 'EURUSD', date: '2024-01-02', fetchImpl: make(() => response(503)) }).catch(e => e);
  assert.ok(!(unavailable instanceof DukascopyUpstreamResponseError));
  assert.match(unavailable.message, /HTTP 503/);
});

test('network errors keep their original cause so logs can show it', async () => {
  const cause = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const fetchImpl = (async () => { throw new TypeError('fetch failed', { cause }); }) as unknown as typeof fetch;
  const error: any = await fetchBi5Day({ symbol: 'EURUSD', date: '2024-01-02', fetchImpl }).catch(e => e);
  assert.equal(error.message, 'fetch failed');
  assert.equal(error.cause.code, 'ETIMEDOUT');
});

test('a corrupt (non-LZMA) body is a clear, retryable error', async () => {
  const fetchImpl = (async () => response(200, Buffer.from('<html>blocked</html>'))) as unknown as typeof fetch;
  const error: any = await fetchBi5Day({ symbol: 'EURUSD', date: '2024-01-02', fetchImpl }).catch(e => e);
  assert.ok(error instanceof Error);
  assert.ok(!(error instanceof DukascopyUpstreamResponseError));
  assert.match(error.message, /not a valid LZMA/);
});

test('Stop button (abort signal) cancels a pending request', async () => {
  const controller = new AbortController();
  const fetchImpl = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
  })) as unknown as typeof fetch;
  const pending = fetchBi5Day({ symbol: 'EURUSD', date: '2024-01-02', signal: controller.signal, fetchImpl }).catch(e => e);
  controller.abort();
  const error: any = await pending;
  assert.equal(error.name, 'AbortError');
});
