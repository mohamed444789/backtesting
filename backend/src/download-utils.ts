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
