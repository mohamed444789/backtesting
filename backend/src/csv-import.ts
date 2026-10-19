import { valid, type Candle } from './core.js';

/**
 * Parser for M1 candle CSV exports (Dukascopy "Historical data export", MetaTrader-style, or generic OHLCV).
 *
 * Rules, deliberately strict so bad input never becomes "successful" data:
 *   - Times without an explicit zone are read as UTC (export with the GMT/UTC option), shifted by utcOffsetMinutes.
 *   - Every candle must pass valid() and sit on a whole minute; anything else is rejected and counted.
 *   - Duplicate timestamps inside one file keep the first row.
 *   - The caller must refuse a file that yields no accepted candles.
 */
export interface CsvParseOptions {
  /** Minutes the file's clock is AHEAD of UTC (e.g. UTC+2 export => 120). Ignored for times with a zone or epoch. */
  utcOffsetMinutes?: number;
  maxRejectSamples?: number;
}

export interface CsvParseResult {
  candles: Candle[];
  totalRows: number;
  rejected: number;
  rejectSamples: string[];
  firstTime: number | null;
  lastTime: number | null;
}

const TIME_HEADERS = ['gmt time', 'utc time', 'time', 'timestamp', 'datetime', 'date', 'local time'];

function detectDelimiter(line: string): string {
  const counts = [',', ';', '\t'].map(d => [d, line.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

function splitLine(line: string, delimiter: string): string[] {
  return line.split(delimiter).map(cell => cell.trim().replace(/^"(.*)"$/, '$1'));
}

/** Returns epoch seconds, or NaN. */
export function parseCandleTime(raw: string, utcOffsetMinutes = 0): number {
  const text = raw.trim();
  if (!text) return NaN;

  if (/^\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);
    if (n >= 1e11) return Math.floor(n / 1000); // epoch milliseconds
    if (n >= 1e8) return Math.floor(n);          // epoch seconds
    return NaN;
  }

  // 21.04.2026 13:05:00(.000) — Dukascopy export
  let m = text.match(/^(\d{2})\.(\d{2})\.(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  let parts: number[] | null = m ? [Number(m[3]), Number(m[2]), Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)] : null;

  // 2026-04-21 13:05:00(.000) or 2026.04.21 13:05 (MetaTrader) or 2026/04/21 13:05
  if (!parts) {
    m = text.match(/^(\d{4})[-./](\d{2})[-./](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
    if (m) parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  }

  if (parts) {
    const [y, mo, d, h, mi, s] = parts;
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return NaN;
    const ms = Date.UTC(y, mo - 1, d, h, mi, s);
    const check = new Date(ms);
    if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return NaN; // rejects 31.02 style rollover
    return Math.floor(ms / 1000) - utcOffsetMinutes * 60;
  }

  // ISO 8601 with an explicit zone (Z or +hh:mm). Zone-less ISO strings were already handled above as UTC + offset.
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
  }
  return NaN;
}

export function parseCandleCsv(text: string, options: CsvParseOptions = {}): CsvParseResult {
  const maxSamples = options.maxRejectSamples ?? 5;
  const offset = options.utcOffsetMinutes ?? 0;
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim() !== '');
  const empty: CsvParseResult = { candles: [], totalRows: 0, rejected: 0, rejectSamples: [], firstTime: null, lastTime: null };
  if (!lines.length) return empty;

  const delimiter = detectDelimiter(lines[0]);
  const first = splitLine(lines[0], delimiter);
  const hasHeader = first.some(cell => cell !== '' && Number.isNaN(Number(cell.replace(',', '.'))) && Number.isNaN(parseCandleTime(cell)));

  let cols = { time: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 };
  if (hasHeader) {
    const names = first.map(cell => cell.toLowerCase());
    const find = (...candidates: string[]) => names.findIndex(n => candidates.includes(n));
    const time = names.findIndex(n => TIME_HEADERS.includes(n));
    const open = find('open'), high = find('high'), low = find('low'), close = find('close');
    const volume = names.findIndex(n => n === 'volume' || n === 'tick_volume' || n === 'vol');
    if (time < 0 || open < 0 || high < 0 || low < 0 || close < 0) {
      throw new Error('CSV header must contain time, open, high, low and close columns; found: ' + first.join(', '));
    }
    cols = { time, open, high, low, close, volume };
  }

  const out = new Map<number, Candle>();
  const rejectSamples: string[] = [];
  let totalRows = 0, rejected = 0;
  const reject = (lineNo: number, why: string) => { rejected++; if (rejectSamples.length < maxSamples) rejectSamples.push('line ' + lineNo + ': ' + why); };

  for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
    totalRows++;
    const cells = splitLine(lines[i], delimiter);
    const num = (idx: number) => (idx < 0 ? 0 : Number((cells[idx] ?? '').replace(',', '.')));
    const time = parseCandleTime(cells[cols.time] ?? '', offset);
    if (!Number.isFinite(time)) { reject(i + 1, 'unrecognised time "' + (cells[cols.time] ?? '') + '"'); continue; }
    if (time % 60 !== 0) { reject(i + 1, 'time is not on a whole minute (this importer is for M1 data)'); continue; }
    const volumeRaw = cols.volume >= 0 ? num(cols.volume) : 0;
    const candle: Candle = { time, open: num(cols.open), high: num(cols.high), low: num(cols.low), close: num(cols.close), volume: Number.isFinite(volumeRaw) && volumeRaw >= 0 ? volumeRaw : 0 };
    if (!valid(candle)) { reject(i + 1, 'invalid OHLC values'); continue; }
    if (!out.has(time)) out.set(time, candle);
  }

  const candles = [...out.values()].sort((a, b) => a.time - b.time);
  return {
    candles, totalRows, rejected, rejectSamples,
    firstTime: candles.length ? candles[0].time : null,
    lastTime: candles.length ? candles[candles.length - 1].time : null,
  };
}
