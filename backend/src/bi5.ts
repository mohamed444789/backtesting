import { createRequire } from 'node:module';
import { DukascopyUpstreamResponseError, type DukascopyResponseDiagnostic } from './downloader.js';

const require = createRequire(import.meta.url);
const lzma = require('lzma-purejs-requirejs') as { decompressFile(input: Uint8Array): Uint8Array };

export const BI5_DEFAULT_BASE_URL = 'https://datafeed.dukascopy.com/datafeed';
export const BI5_USER_AGENT = 'Mozilla/5.0 AtlasDownloader/3.0';
const RECORD_BYTES = 24;

const MAX_COMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_DICTIONARY_BYTES = 64 * 1024 * 1024;
const MAX_DECODED_BYTES = 1024 * 1024;
const LZMA_HEADER_BYTES = 13;

export function assertPlausibleLzmaHeader(body: Uint8Array): void {
  const invalid = (why: string) =>
    new Error('Response is not a valid LZMA .bi5 file (' + why + '); it may be an error page from the provider');
  if (body.length > MAX_COMPRESSED_BYTES) throw invalid('body is ' + body.length + ' bytes');
  if (body.length < LZMA_HEADER_BYTES) throw invalid('only ' + body.length + ' bytes');
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  if (view.getUint8(0) >= 225) throw invalid('bad properties byte');
  if (view.getUint32(1, true) > MAX_DICTIONARY_BYTES) throw invalid('implausible dictionary size');
  const low = view.getUint32(5, true);
  const high = view.getUint32(9, true);
  const unknownSize = low === 0xffffffff && high === 0xffffffff;
  if (!unknownSize && (high !== 0 || low > MAX_DECODED_BYTES)) throw invalid('implausible uncompressed size');
}

export interface Bi5Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function bi5PriceDivisor(symbol: string): number {
  const s = symbol.toUpperCase();
  return s.includes('JPY') || s === 'XAUUSD' || s === 'XAGUSD' ? 1_000 : 100_000;
}

export function buildBi5Url(baseUrl: string, symbol: string, date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error('Invalid date (expected YYYY-MM-DD): ' + date);
  if (!/^[A-Za-z0-9]+$/.test(symbol)) throw new Error('Invalid instrument symbol: ' + symbol);
  const [, year, month, day] = match;
  const monthIndex = String(Number(month) - 1).padStart(2, '0');
  return baseUrl.replace(/\/+$/, '') + '/' + symbol.toUpperCase() + '/' + year + '/' + monthIndex + '/' + day + '/BID_candles_min_1.bi5';
}

export function decodeBi5Records(raw: Uint8Array, date: string, divisor: number): Bi5Candle[] {
  if (raw.length % RECORD_BYTES !== 0) {
    throw new Error('Unexpected .bi5 payload length ' + raw.length + ' (not a multiple of ' + RECORD_BYTES + ')');
  }
  const midnight = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(midnight)) throw new Error('Invalid date: ' + date);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const out: Bi5Candle[] = [];
  for (let pos = 0; pos < raw.length; pos += RECORD_BYTES) {
    const seconds = view.getUint32(pos);
    if (seconds % 60 !== 0 || seconds >= 86_400) {
      throw new Error('Candle offset ' + seconds + 's is not a whole minute inside the UTC day');
    }
    const open = view.getInt32(pos + 4) / divisor;
    const close = view.getInt32(pos + 8) / divisor;
    const low = view.getInt32(pos + 12) / divisor;
    const high = view.getInt32(pos + 16) / divisor;
    const volume = view.getFloat32(pos + 20);
    out.push({
      timestamp: midnight + seconds * 1000,
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) && volume > 0 ? volume : 0,
    });
  }
  return out;
}

export interface FetchBi5Options {
  symbol: string;
  date: string;
  baseUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

function upstreamError(url: string, response: Response): DukascopyUpstreamResponseError {
  const diagnostic: DukascopyResponseDiagnostic = {
    url,
    status: response.status,
    statusText: response.statusText,
    server: response.headers.get('server'),
    via: response.headers.get('via'),
    wafAction: response.headers.get('x-amzn-waf-action'),
    contentType: response.headers.get('content-type'),
    contentLength: response.headers.get('content-length'),
    retryAfter: response.headers.get('retry-after'),
    cloudFrontId: response.headers.get('x-amz-cf-id') || response.headers.get('x-amz-cf-pop'),
  };
  return new DukascopyUpstreamResponseError(diagnostic);
}

export async function fetchBi5Day(options: FetchBi5Options): Promise<Bi5Candle[]> {
  const { symbol, date, baseUrl = BI5_DEFAULT_BASE_URL, timeoutMs = 30_000, signal, fetchImpl = fetch } = options;
  const url = buildBi5Url(baseUrl, symbol, date);
  const signals: AbortSignal[] = [];
  if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (signal) signals.push(signal);
  const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

  const response = await fetchImpl(url, {
    headers: { 'User-Agent': BI5_USER_AGENT, Accept: '*/*' },
    signal: combined,
  });

  if (response.status === 404) return [];
  if (response.status === 202 || response.status === 429 || (response.status >= 400 && response.status < 500)) {
    throw upstreamError(url, response);
  }
  if (response.status !== 200) {
    throw new Error('Dukascopy returned HTTP ' + response.status + ' for ' + url);
  }
  if (response.headers.get('x-amzn-waf-action')?.toLowerCase() === 'challenge') {
    throw upstreamError(url, response);
  }

  const body = new Uint8Array(await response.arrayBuffer());
  if (body.length === 0) return [];
  assertPlausibleLzmaHeader(body);

  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(lzma.decompressFile(body) as ArrayLike<number>);
  } catch (error) {
    throw new Error('Could not decompress the .bi5 file for ' + date + ': ' + (error instanceof Error ? error.message : String(error)));
  }
  return decodeBi5Records(raw, date, bi5PriceDivisor(symbol));
}
