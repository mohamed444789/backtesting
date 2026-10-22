export type DateCandleTarget = {
  time: number;
  date: string;
};

const BERLIN_TIME_ZONE = 'Europe/Berlin';
const DAY_MS = 24 * 60 * 60 * 1000;

export function isValidDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

/** Calendar date shown by the replay chart and its Berlin-time axis. */
export function dateInBerlin(timestampSeconds: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BERLIN_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestampSeconds * 1000));
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? '';
  return part('year') + '-' + part('month') + '-' + part('day');
}

/**
 * Convert a Berlin local midnight to UTC epoch milliseconds. Iterating the
 * timezone offset avoids depending on the server's local timezone and handles
 * CET/CEST changes for dates either side of daylight-saving transitions.
 */
function berlinMidnightUtcMs(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  const desiredWallTime = Date.UTC(year, month - 1, day);
  let guess = desiredWallTime;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: BERLIN_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  for (let i = 0; i < 4; i++) {
    const parts = formatter.formatToParts(new Date(guess));
    const part = (type: string) => Number(parts.find(item => item.type === type)?.value);
    const representedWallTime = Date.UTC(
      part('year'), part('month') - 1, part('day'),
      part('hour'), part('minute'), part('second'),
    );
    const correction = desiredWallTime - representedWallTime;
    if (correction === 0) break;
    guess += correction;
  }
  return guess;
}

/**
 * Return the first stored BID M1 candle on the selected Berlin calendar date
 * that is strictly after the current replay cursor and inside the session end.
 * It deliberately never falls forward to another date when the selected day
 * has no candles, so Saturdays/holidays return null without moving the session.
 */
export function findFirstCandleOnDate(
  db: any,
  symbol: string,
  date: string,
  cursor: number,
  endTime: number | null,
): DateCandleTarget | null {
  if (!isValidDateOnly(date)) return null;

  const dayStart = Math.floor(berlinMidnightUtcMs(date) / 1000);
  const nextDate = new Date(Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)) + 1,
  )).toISOString().slice(0, 10);
  const nextDayStart = Math.floor(berlinMidnightUtcMs(nextDate) / 1000);

  const row = db.prepare(`
    SELECT time
    FROM candles
    WHERE symbol = ?
      AND price_type = 'bid'
      AND time >= ?
      AND time < ?
      AND time > ?
      AND (? IS NULL OR time <= ?)
    ORDER BY time
    LIMIT 1
  `).get(symbol, dayStart, nextDayStart, cursor, endTime, endTime) as { time: number } | undefined;

  return row ? { time: Number(row.time), date } : null;
}
