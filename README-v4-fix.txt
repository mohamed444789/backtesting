Atlas Forex Replay v4 reliability patch

Fixes: ensure a replay opens with an available candle, automatically reveals one candle for older empty sessions, fit the chart to first data instead of restoring an empty chart range, and expose theme toggle in the chart heading as well as the workspace header. Backend rejects unavailable date ranges with a clearer message.

Apply from the project root and rebuild with docker compose up -d --build. Keep the backup until verified.
