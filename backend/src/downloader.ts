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
  const wrappedFetch: typeof fetch = (input, init) => {
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
    if (externalSignal) signals.push(externalSignal);
    if (init?.signal) signals.push(init.signal as AbortSignal);
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    return originalFetch(input, { ...init, signal });
  };

  globalThis.fetch = wrappedFetch;
  try {
    return await request();
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
        /empty dataset|status(?:\s*code)?\s*[:=]?\s*404|no data|not found|no valid m1 candles/i.test(detail)
      ) {
        return { candles: [], attempts: attempt, empty: true };
      }

      lastError = error;
      if (attempt >= maxAttempts) break;

      const delayMs = getDownloadRetryDelay(attempt);
      options.onRetry?.({
        attempt,
        maxAttempts,
        delayMs,
        detail,
        retryable: isRetryableProviderError(detail),
      });
      await waitForRetry(delayMs, options);
    }
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error(describeDownloadError(lastError));
}
