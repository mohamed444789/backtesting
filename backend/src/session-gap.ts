export type NextSundayCandle = {
  time: number;
  targetSunday: string;
};

/**
 * Find the first available candle from the next Sunday after the replay
 * cursor's displayed calendar date (Europe/Berlin, matching the chart UI).
 * The search starts at Sunday 00:00 UTC so Sunday evening FX reopen candles
 * are included while Saturday candles are never selected as the target.
 */
export function findNextSundayCandle(
  db: any,
  symbol: string,
  cursor: number,
  endTime: number | null,
): NextSundayCandle | null {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(cursor * 1000));
  const part = (type: string) => Number(parts.find(item => item.type === type)?.value);
  const year = part('year');
  const month = part('month');
  const day = part('day');
  if (![year, month, day].every(Number.isFinite)) return null;

  const displayedDateUtc = Date.UTC(year, month - 1, day);
  const weekday = new Date(displayedDateUtc).getUTCDay();
  // Strictly next Sunday: if the current displayed date is Sunday, use the
  // Sunday a week later, not the Sunday already being replayed.
  const daysUntilSunday = weekday === 0 ? 7 : 7 - weekday;
  const targetSundayMs = displayedDateUtc + daysUntilSunday * 86400000;
  const targetSunday = new Date(targetSundayMs).toISOString().slice(0, 10);
  const targetTime = Math.floor(targetSundayMs / 1000);

  const row = db.prepare(`
    SELECT time
    FROM candles
    WHERE symbol = ?
      AND time >= ?
      AND (? IS NULL OR time <= ?)
    ORDER BY time
    LIMIT 1
  `).get(symbol, targetTime, endTime, endTime) as { time: number } | undefined;

  return row ? { time: Number(row.time), targetSunday } : null;
}
