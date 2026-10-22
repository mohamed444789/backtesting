export const MIN_SESSION_GAP_SECONDS = 12 * 60 * 60;

export type SessionGap = {
  time: number;
  gapSeconds: number;
};

/**
 * Find the first significant market-data gap after a replay cursor.
 *
 * The first future candle is compared with the replay cursor itself, which is
 * important when the cursor is already on Friday's final candle and the next
 * stored candle is Monday's first candle. SQLite's LAG keeps this efficient
 * for large histories without sending thousands of candle rows to the browser.
 */
export function findNextSessionGap(
  db: any,
  symbol: string,
  cursor: number,
  endTime: number | null,
): SessionGap | null {
  const row = db.prepare(`
    SELECT time, gap_seconds
    FROM (
      SELECT
        time,
        time - LAG(time, 1, ?) OVER (ORDER BY time) AS gap_seconds
      FROM candles
      WHERE symbol = ?
        AND time > ?
        AND (? IS NULL OR time <= ?)
    )
    WHERE gap_seconds >= ?
    ORDER BY time
    LIMIT 1
  `).get(
    cursor,
    symbol,
    cursor,
    endTime,
    endTime,
    MIN_SESSION_GAP_SECONDS,
  ) as { time: number; gap_seconds: number } | undefined;

  if (!row) return null;

  return {
    time: Number(row.time),
    gapSeconds: Number(row.gap_seconds),
  };
}
