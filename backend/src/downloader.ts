import { valid, type Candle } from './core.js';
import {
  describeDownloadError,
  getDownloadRetryDelay,
  isLikelyNetworkError,
  isRetryableProviderError,
} from './download-utils.js';

export class DownloadCancelledError extends Error {
  constructor() {
    super('Download cancelled');
    this.name = 'DownloadCancelledError';
  }
}

export interface DownloadRetryInfo {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  detail: string;
  retryable: boolean;
}

export interface FetchDateOptions {
  date: string;
  request: () => Promise<unknown>;
  allowEmpty?: boolean;
  maxAttempts?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  isCancelled?: () => boolean;
  onAttempt?: (attempt: number) => void;
  onRetry?: (info: DownloadRetryInfo) => void;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface FetchDateResult {
  candles: Candle[];
  attempts: number;
  empty: boolean;
}


/** Safe HTTP metadata retained when the JSON data API rejects a request. */
export interface DukascopyResponseDiagnostic {
  url: string;
  status: number;
  statusText: string;
  server: string | null;
  via: string | null;
  wafAction: string | null;
  contentType: string | null;
  contentLength: string | null;
  retryAfter: string | null;
  cloudFrontId: string | null;
}

/**
 * dukascopy-node currently accepts only HTTP 200. In particular, an AWS WAF
 * Challenge is returned as HTTP 202 with x-amzn-waf-action=challenge; retrying
 * the same URL cannot satisfy that browser challenge. Surface it as an access
 * failure rather than letting the job mark dates as missing candles.
 */
export class DukascopyUpstreamResponseError extends Error {
  constructor(readonly diagnostic: DukascopyResponseDiagnostic) {
    const challenge = diagnostic.wafAction?.toLowerCase() === 'challenge';
    const details = [
      'url=' + diagnostic.url,
      'HTTP ' + diagnostic.status + (diagnostic.statusText ? ' ' + diagnostic.statusText : ''),
      diagnostic.server ? 'server=' + diagnostic.server : '',
      diagnostic.wafAction ? 'x-amzn-waf-action=' + diagnostic.wafAction : '',
      diagnostic.contentType ? 'content-type=' + diagnostic.contentType : '',
      diagnostic.contentLength ? 'content-length=' + diagnostic.contentLength : '',
      diagnostic.retryAfter ? 'retry-after=' + diagnostic.retryAfter : '',
      diagnostic.via ? 'via=' + diagnostic.via : '',
      diagnostic.cloudFrontId ? 'cloudfront-id=' + diagnostic.cloudFrontId : '',
    ].filter(Boolean).join(' | ');

    super(challenge
      ? 'DUKASCOPY_WAF_CHALLENGE: Dukascopy returned an AWS WAF challenge; this is an upstream access challenge, not an empty market-data date. ' + details
      : 'DUKASCOPY_HTTP_202: Dukascopy returned HTTP 202, which this dukascopy-node fetcher does not treat as a successful candle response. Stop the job instead of treating the date as missing. ' + details);
    this.name = 'DukascopyUpstreamResponseError';
  }

  get isChallenge(): boolean {
    return this.diagnostic.wafAction?.toLowerCase() === 'challenge';
  }
}

/**
 * Observe the provider's safe response metadata while calling dukascopy-node.
 * Once an explicit WAF Challenge is seen, suppress further network requests
 * during the library's internal retry loop and throw a distinct error.
 */
export async function withDukascopyResponseDiagnostics<T>(
  request: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  // Store diagnostics on a mutable object so TypeScript accounts for updates
  // made by the asynchronous fetch wrapper before the outer catch runs.
  const responseState: {
    lastNon200: DukascopyResponseDiagnostic | null;
    challenge: DukascopyResponseDiagnostic | null;
  } = {
    lastNon200: null,
    challenge: null,
  };

  const wrappedFetch: typeof fetch = async (input, init) => {
    if (responseState.challenge) {
      throw new Error('DUKASCOPY_WAF_CHALLENGE_ALREADY_DETECTED');
    }

    const response = await originalFetch(input, init);
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
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

    if (response.status !== 200) responseState.lastNon200 = diagnostic;
    if (diagnostic.wafAction?.toLowerCase() === 'challenge') responseState.challenge = diagnostic;
    return response;
  };

  globalThis.fetch = wrappedFetch;
  try {
    return await request();
  } catch (error) {
    const { challenge, lastNon200 } = responseState;
    if (challenge) throw new DukascopyUpstreamResponseError(challenge);
    if (lastNon200?.status === 202) throw new DukascopyUpstreamResponseError(lastNon200);
    if (lastNon200) {
      throw new Error(
        describeDownloadError(error) + ' | provider HTTP response=' + JSON.stringify(lastNon200),
      );
    }
    throw error;
  } finally {
    if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch;
  }
}

const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS_LIMIT = 10;
const MAX_REQUEST_TIMEOUT_MS = 120_000;

function isCancelled(options: FetchDateOptions): boolean {
  return Boolean(options.isCancelled?.() || options.signal?.aborted);
}

function throwIfCancelled(options: FetchDateOptions): void {
  if (isCancelled(options)) throw new DownloadCancelledError();
}

function utcDayStartSeconds(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('Invalid download date; expected YYYY-MM-DD');
  }

  const milliseconds = Date.parse(date + 'T00:00:00.000Z');
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== date) {
    throw new Error('Invalid download date: ' + date);
  }
  return Math.floor(milliseconds / 1000);
}

export function buildDukascopyM1Config(
  instrument: string,
  date: string,
  cacheFolderPath: string,
) {
  if (!instrument.trim()) throw new Error('Instrument is required');
  if (!cacheFolderPath.trim()) throw new Error('Cache folder path is required');

  const fromMs = utcDayStartSeconds(date) * 1000;
  return {
    instrument: instrument.toLowerCase(),
    dates: {
      from: new Date(fromMs),
      // The library filters the end as an exclusive boundary.
      to: new Date(fromMs + 86_400_000),
    },
    timeframe: 'm1',
    priceType: 'bid',
    format: 'json',
    utcOffset: 0,
    volumes: true,
    volumeUnits: 'millions',
    // Fill missing minutes with flat candles when the provider has no tick
    // change; this keeps replay/coverage sessions continuous.
    ignoreFlats: false,
    // Keep requests date-scoped for reliable resume/coverage tracking; the
    // library's batch size applies inside each daily request.
    batchSize: 10,
    pauseBetweenBatchesMs: 1000,
    useCache: true,
    cacheFolderPath,
    retryCount: 5,
    retryOnEmpty: true,
    failAfterRetryCount: true,
    // Match Dukascopy's recommended short retry pause; the outer downloader
    // also applies bounded backoff when a whole daily request fails.
    pauseBetweenRetriesMs: 250,
  } as const;
}

/**
 * Configuration for dukascopy-node 1.46.4, which still fetches the legacy
 * datafeed.com LZMA-compressed .bi5 candles and decodes them to JSON rows.
 * This is used only after the v1.50 JSON API returns an HTTP 202 challenge.
 */
export function buildDukascopyLegacyM1Config(
  instrument: string,
  date: string,
  cacheFolderPath: string,
) {
  if (!instrument.trim()) throw new Error('Instrument is required');
  if (!cacheFolderPath.trim()) throw new Error('Cache folder path is required');

  const fromMs = utcDayStartSeconds(date) * 1000;
  return {
    instrument: instrument.toLowerCase(),
    dates: {
      from: new Date(fromMs),
      to: new Date(fromMs + 86_400_000),
    },
    timeframe: 'm1',
    priceType: 'bid',
    format: 'json',
    utcOffset: 0,
    volumes: true,
    volumeUnits: 'millions',
    ignoreFlats: false,
    batchSize: 1,
    pauseBetweenBatchesMs: 1000,
    useCache: true,
    cacheFolderPath,
    // Keep this short because the calling job already applies its own
    // per-day error handling; a WAF challenge is not fixed by repetition.
    retryCount: 2,
    retryOnEmpty: true,
    pauseBetweenRetriesMs: 1000,
  } as const;
}

function timestampSeconds(rawTime: unknown): number {
  if (rawTime instanceof Date) {
    const milliseconds = rawTime.getTime();
    return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : NaN;
  }

  let numeric = NaN;
  if (typeof rawTime === 'number') {
    numeric = rawTime;
  } else if (typeof rawTime === 'string' && rawTime.trim() !== '') {
    numeric = Number(rawTime);
  }

  if (Number.isFinite(numeric)) {
    return Math.floor(Math.abs(numeric) < 1e12 ? numeric : numeric / 1000);
  }

  if (typeof rawTime === 'string') {
    const milliseconds = Date.parse(rawTime);
    return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : NaN;
  }

  return NaN;
}

function extractRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)) {
    return (payload as { data: unknown[] }).data;
  }
  throw new Error('Dukascopy returned an unexpected response shape');
}

function normalizeRows(rows: unknown[], date: string): Candle[] {
  const from = utcDayStartSeconds(date);
  const until = from + 86_400;
  const unique = new Map<number, Candle>();

  for (const row of rows) {
    const arrayRow = Array.isArray(row) ? row : null;
    const objectRow = row && typeof row === 'object' && !arrayRow
      ? row as Record<string, unknown>
      : null;

    const rawTime = arrayRow ? arrayRow[0] : objectRow?.timestamp ?? objectRow?.time;
    const time = timestampSeconds(rawTime);
    if (!Number.isFinite(time) || time < from || time >= until) continue;

    const open = Number(arrayRow ? arrayRow[1] : objectRow?.open);
    const high = Number(arrayRow ? arrayRow[2] : objectRow?.high);
    const low = Number(arrayRow ? arrayRow[3] : objectRow?.low);
    const close = Number(arrayRow ? arrayRow[4] : objectRow?.close);
    const rawVolume = arrayRow ? arrayRow[5] : objectRow?.volume;
    const numericVolume = rawVolume == null || rawVolume === '' ? 0 : Number(rawVolume);
    const volume = Number.isFinite(numericVolume) && numericVolume >= 0 ? numericVolume : 0;
    const candle: Candle = { time, open, high, low, close, volume };

    if (valid(candle)) unique.set(time, candle);
  }

  return [...unique.values()].sort((left, right) => left.time - right.time);
}

async function waitForRetry(milliseconds: number, options: FetchDateOptions): Promise<void> {
  throwIfCancelled(options);

  if (options.sleep) {
    await options.sleep(milliseconds);
    throwIfCancelled(options);
    return;
  }

  let remaining = milliseconds;
  while (remaining > 0) {
    throwIfCancelled(options);
    const pause = Math.min(500, remaining);
    await new Promise<void>(resolve => setTimeout(resolve, pause));
    remaining -= pause;
  }
}

/**
 * Dukascopy-node does not expose an AbortSignal through its public config.
 * Wrap Node's global fetch for one serialized provider request so stalled
 * sockets time out and the stop action can abort an active download. Restore
 * the original function in all cases.
 */
async function withProviderFetchTimeout<T>(
  request: () => Promise<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  const attemptDiagnostics: string[] = [];
  const wrappedFetch: typeof fetch = async (input, init) => {
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
    if (externalSignal) signals.push(externalSignal);
    if (init?.signal) signals.push(init.signal as AbortSignal);
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    let response: Response;
    try {
      response = await originalFetch(input, { ...init, signal });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attemptDiagnostics.push('network error: ' + message.slice(0, 140));
      throw error;
    }
    attemptDiagnostics.push('HTTP ' + response.status);

    // Dukascopy-node otherwise discards non-200 bodies and often reports only
    // "Unknown error". Preserve enough response context to diagnose 202/403/429
    // and upstream gateway errors without logging an unbounded response body.
    if (response.status !== 200) {
      const requestUrl = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const bodyPreview = await response.clone().text().catch(() => '');
      const details = [
        'Request failed with status ' + response.status + (response.statusText ? ' ' + response.statusText : ''),
        'url=' + requestUrl,
        'content-type=' + (response.headers.get('content-type') || 'unknown'),
        response.headers.get('retry-after') ? 'retry-after=' + response.headers.get('retry-after') : '',
        response.headers.get('location') ? 'location=' + response.headers.get('location') : '',
        ...['server', 'via', 'x-cache', 'x-request-id', 'cf-ray', 'x-amz-cf-id']
          .map(name => response.headers.get(name) ? name + '=' + response.headers.get(name) : '')
          .filter(Boolean),
        'body=' + (bodyPreview.trim().slice(0, 400) || '<empty>'),
      ].filter(Boolean);
      throw new Error(details.join(' | '));
    }

    return response;
  };

  globalThis.fetch = wrappedFetch;
  try {
    return await request();
  } catch (error) {
    if (attemptDiagnostics.length > 1) {
      const message = error instanceof Error ? error.message : String(error);
      const sequence = attemptDiagnostics.slice(-8).join(' -> ').slice(0, 600);
      throw new Error(message + ' | provider fetch attempts=' + attemptDiagnostics.length + '; sequence=' + sequence);
    }
    throw error;
  } finally {
    if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch;
  }
}

/** Fetch and validate one UTC day using bounded retries and cancellation. */
export async function fetchDateCandles(options: FetchDateOptions): Promise<FetchDateResult> {
  utcDayStartSeconds(options.date);
  const maxAttempts = Number.isFinite(options.maxAttempts)
    ? Math.max(1, Math.min(MAX_ATTEMPTS_LIMIT, Math.floor(options.maxAttempts!)))
    : DEFAULT_MAX_ATTEMPTS;
  const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs)
    ? Math.max(1_000, Math.min(MAX_REQUEST_TIMEOUT_MS, Math.floor(options.requestTimeoutMs!)))
    : DEFAULT_REQUEST_TIMEOUT_MS;

  let lastError: unknown = new Error('Provider request did not run');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfCancelled(options);
    options.onAttempt?.(attempt);

    try {
      const payload = await withProviderFetchTimeout(options.request, requestTimeoutMs, options.signal);
      throwIfCancelled(options);

      const rows = extractRows(payload);
      const candles = normalizeRows(rows, options.date);

      if (!candles.length) {
        if (options.allowEmpty) return { candles: [], attempts: attempt, empty: true };
        throw new Error(
          'Provider returned no valid M1 candles for ' + options.date +
          ' (response rows: ' + rows.length + ')',
        );
      }

      return { candles, attempts: attempt, empty: false };
    } catch (error) {
      if (error instanceof DownloadCancelledError || isCancelled(options)) {
        throw new DownloadCancelledError();
      }

      const detail = describeDownloadError(error);
      if (
        options.allowEmpty &&
        !isLikelyNetworkError(detail) &&
        /empty dataset|http\s*[:=]?\s*404|status(?:\s*code)?\s*[:=]?\s*404|no data|not found|no valid m1 candles/i.test(detail)
      ) {
        return { candles: [], attempts: attempt, empty: true };
      }

      lastError = error;
      const emptyPayload = /provider returned no valid m1 candles|request returned an empty dataset|empty data(?:set)?(?: response)?/i.test(detail);
      const retryable = isRetryableProviderError(detail) || emptyPayload;
      if (attempt >= maxAttempts || !retryable) break;

      const delayMs = getDownloadRetryDelay(attempt);
      options.onRetry?.({
        attempt,
        maxAttempts,
        delayMs,
        detail,
        retryable,
      });
      await waitForRetry(delayMs, options);
    }
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error(describeDownloadError(lastError));
}
