export type DownloadDateChunk = { start: string; end: string };

const DAY_MS = 86400000;
const toUtcMidnight = (date: string) => new Date(date + 'T00:00:00Z').getTime();
const isoDate = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10);

/**
 * Split a UTC date range into consecutive trading-day chunks.
 * Dukascopy's M1 API fetches one daily artifact per date. Saturdays are
 * omitted, but Sundays are retained for the Sunday evening FX/XAUUSD session.
 */
export function splitDateRange(start: string, end: string, maxTradingDaysPerChunk = 6): DownloadDateChunk[] {
  const first = toUtcMidnight(start);
  const last = toUtcMidnight(end);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return [];

  const maxDays = Number.isFinite(maxTradingDaysPerChunk)
    ? Math.max(1, Math.floor(maxTradingDaysPerChunk))
    : 6;
  const chunks: DownloadDateChunk[] = [];
  let cursor = first;

  while (cursor <= last) {
    const day = new Date(cursor).getUTCDay();
    if (day === 6) {
      cursor += DAY_MS;
      continue;
    }

    const chunkStart = cursor;
    let chunkEnd = cursor;
    let weekdaysInChunk = 0;

    while (cursor <= last && weekdaysInChunk < maxDays) {
      const currentDay = new Date(cursor).getUTCDay();
      if (currentDay === 6) break;
      chunkEnd = cursor;
      cursor += DAY_MS;
      weekdaysInChunk++;
    }

    chunks.push({ start: isoDate(chunkStart), end: isoDate(chunkEnd) });
  }

  return chunks;
}


/** Preserve useful detail from fetch errors and wrapped/cause errors. */
export function describeDownloadError(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (value == null || depth > 4 || seen.has(value)) return;
    if (typeof value === 'string') {
      if (value.trim()) parts.push(value.trim());
      return;
    }
    if (typeof value !== 'object') {
      parts.push(String(value));
      return;
    }
    seen.add(value);
    const item = value as {
      message?: unknown; code?: unknown; errno?: unknown; address?: unknown;
      port?: unknown; cause?: unknown; errors?: unknown; name?: unknown;
    };
    if (item.cause) visit(item.cause, depth + 1);
    if (Array.isArray(item.errors)) item.errors.forEach(nested => visit(nested, depth + 1));
    if (item.code) parts.push(String(item.code));
    if (item.errno && item.errno !== item.code) parts.push(String(item.errno));
    if (item.address) parts.push('address ' + String(item.address) + (item.port ? ':' + String(item.port) : ''));
    if (item.message) parts.push(String(item.message));
    else if (item.name) parts.push(String(item.name));
  };
  visit(error, 0);
  const details = [...new Set(parts.filter(Boolean))];
  return (details.length ? details.join(' | ') : String(error || 'Unknown error')).slice(0, 700);
}

/** Recognize common native-fetch/network failures for clearer job diagnostics. */
export function isLikelyNetworkError(message: string): boolean {
  return /(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_SOCKET|socket hang up|fetch failed|failed to fetch|network error)/i.test(message);
}


/** Retry transport, rate-limit and server errors; malformed/empty payloads are bounded. */
export function isRetryableProviderError(message: string): boolean {
  return isLikelyNetworkError(message) ||
    /(?:http(?: response)?|status(?: code)?)\s*[:=]?\s*(?:429|500|502|503|504|5\d\d)\b/i.test(message) ||
    /\b(?:429|500|502|503|504)\b.*(?:rate|limit|server|temporar|request)/i.test(message);
}

/** Exponential backoff capped at one minute. */
export function getDownloadRetryDelay(attempt: number): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  return Math.min(60_000, 1_500 * Math.pow(2, Math.min(safeAttempt - 1, 6)));
}
