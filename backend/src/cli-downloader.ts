import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { valid, type Candle } from './core.js';

export interface CliCandleDownloadOptions {
  jobId: number;
  instrument: string;
  date: string;
  dataRoot: string;
  signal?: AbortSignal;
  allowEmpty?: boolean;
}

export interface CliCandleDownloadResult {
  candles: Candle[];
  csvPath: string;
  /** Call only after the candle insert transaction has committed. */
  cleanup: () => Promise<void>;
}

const CLI_TIMEOUT_MS = 180_000;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const MAX_PROCESS_OUTPUT_CHARS = 4_000;

function utcDayStartSeconds(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('Invalid CLI download date; expected YYYY-MM-DD');
  }

  const milliseconds = Date.parse(date + 'T00:00:00.000Z');
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 10) !== date
  ) {
    throw new Error('Invalid CLI download date: ' + date);
  }

  return Math.floor(milliseconds / 1000);
}

function nextUtcDate(date: string): string {
  return new Date((utcDayStartSeconds(date) + 86_400) * 1000).toISOString().slice(0, 10);
}

/** Parse quoted CSV fields, escaped quotes, CRLF, and quoted newlines. */
export function parseCsvRecords(contents: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < contents.length; index++) {
    const character = contents[index];

    if (quoted) {
      if (character === '"') {
        if (contents[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && contents[index + 1] === '\n') index++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error('Malformed CLI CSV: unterminated quoted field');
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter(record => record.some(value => value.trim() !== ''));
}

function parseCsvTimestamp(raw: string): number {
  const value = raw.trim();
  if (!value) return NaN;

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.floor(Math.abs(numeric) < 1e12 ? numeric : numeric / 1000);
  }

  const isoLike = value.includes('T') ? value : value.replace(' ', 'T');
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(isoLike);
  const milliseconds = Date.parse(hasTimezone ? isoLike : isoLike + 'Z');
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : NaN;
}

function parseNumeric(value: string | undefined): number {
  if (value == null || value.trim() === '') return NaN;
  return Number(value);
}

/** Normalize CLI CSV rows into the app's UTC Unix-second Candle model. */
export function parseDukascopyCliCsv(contents: string, date: string): Candle[] {
  const from = utcDayStartSeconds(date);
  const until = from + 86_400;
  const records = parseCsvRecords(contents.replace(/^\uFEFF/, ''));

  if (records.length < 2) return [];

  const headers = records[0].map(value => value.trim().toLowerCase());
  const column = (...names: string[]) => headers.findIndex(header => names.includes(header));
  const timeIndex = column('timestamp', 'time', 'datetime', 'date');
  const openIndex = column('open');
  const highIndex = column('high');
  const lowIndex = column('low');
  const closeIndex = column('close');
  const volumeIndex = column('volume', 'vol');

  if ([timeIndex, openIndex, highIndex, lowIndex, closeIndex].some(index => index < 0)) {
    throw new Error('Unexpected Dukascopy CLI CSV headers: ' + headers.join(','));
  }

  const unique = new Map<number, Candle>();
  for (const row of records.slice(1)) {
    const time = parseCsvTimestamp(row[timeIndex] ?? '');
    if (!Number.isFinite(time) || time < from || time >= until) continue;

    const open = parseNumeric(row[openIndex]);
    const high = parseNumeric(row[highIndex]);
    const low = parseNumeric(row[lowIndex]);
    const close = parseNumeric(row[closeIndex]);
    const rawVolume = volumeIndex < 0 ? '' : (row[volumeIndex] ?? '');
    const parsedVolume = rawVolume.trim() === '' ? 0 : Number(rawVolume);
    const volume = Number.isFinite(parsedVolume) && parsedVolume >= 0 ? parsedVolume : 0;
    const candle: Candle = { time, open, high, low, close, volume };

    if (valid(candle)) unique.set(time, candle);
  }

  return [...unique.values()].sort((left, right) => left.time - right.time);
}

export interface DukascopyCliArgs {
  instrument: string;
  date: string;
  outputDirectory: string;
  fileName: string;
}

/** Kept pure/exported so the CLI contract can be tested without network access. */
export function buildDukascopyCliArgs(options: DukascopyCliArgs): string[] {
  const instrument = options.instrument.trim().toLowerCase();
  if (!instrument) throw new Error('Instrument is required');
  if (!/^[a-z0-9]+$/.test(instrument)) throw new Error('Instrument must contain only letters and digits');
  if (!options.outputDirectory.trim()) throw new Error('CLI output directory is required');
  if (!options.fileName.trim()) throw new Error('CLI file name is required');

  const nextDate = nextUtcDate(options.date);
  return [
    '-i', instrument,
    '-from', options.date,
    '-to', nextDate,
    '-t', 'm1',
    '-p', 'bid',
    '-utc', '0',
    '-v',
    '-vu', 'millions',
    '-fl',
    '-f', 'csv',
    '-dir', options.outputDirectory,
    '-df', 'YYYY-MM-DD HH:mm:ss',
    '-tz', 'UTC',
    '-r', '15',
    '-rp', '2000',
    '-re',
    '-fr',
    '-fn', options.fileName,
    '-s',
  ];
}

async function resolveCliCommand(): Promise<string> {
  const binaryName = process.platform === 'win32' ? 'dukascopy-node.cmd' : 'dukascopy-node';
  const candidates = [
    path.resolve(process.cwd(), 'node_modules', '.bin', binaryName),
    path.resolve(process.cwd(), '..', 'node_modules', '.bin', binaryName),
    path.resolve(MODULE_DIR, '..', '..', 'node_modules', '.bin', binaryName),
  ];

  for (const candidate of [...new Set(candidates)]) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next workspace/root-relative location.
    }
  }

  throw new Error('Could not locate the installed dukascopy-node CLI. Install workspace dependencies first.');
}

async function runCli(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  if (signal?.aborted) throw new Error('CLI download cancelled');
  const command = await resolveCliCommand();
  if (signal?.aborted) throw new Error('CLI download cancelled');

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let killTimeout: NodeJS.Timeout | undefined;

    const appendBounded = (current: string, chunk: Buffer): string =>
      (current + chunk.toString('utf8')).slice(-MAX_PROCESS_OUTPUT_CHARS);

    const terminate = () => {
      if (child.exitCode != null || child.killed) return;
      child.kill('SIGTERM');
      killTimeout = setTimeout(() => {
        if (child.exitCode == null) child.kill('SIGKILL');
      }, 2_000);
      killTimeout.unref?.();
    };

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
    };

    const onAbort = () => {
      aborted = true;
      terminate();
    };

    child.stdout.on('data', (chunk: Buffer) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = appendBounded(stderr, chunk); });
    child.on('error', error => {
      finish(new Error('Could not start the Dukascopy CLI via npx: ' + error.message));
    });
    child.on('close', code => {
      if (aborted || signal?.aborted) {
        finish(new Error('CLI download cancelled'));
        return;
      }
      if (timedOut) {
        finish(new Error('Dukascopy CLI timed out after ' + CLI_TIMEOUT_MS + 'ms'));
        return;
      }
      if (code !== 0) {
        const detail = (stderr || stdout).trim().slice(-1_500);
        finish(new Error(
          'Dukascopy CLI exited with code ' + String(code) +
          (detail ? ': ' + detail : ''),
        ));
        return;
      }

      if (!settled) {
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (killTimeout) clearTimeout(killTimeout);
        signal?.removeEventListener('abort', onAbort);
        resolve({ stdout, stderr });
      }
    });

    signal?.addEventListener('abort', onAbort, { once: true });
    timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, CLI_TIMEOUT_MS);
    timeout.unref?.();
  });
}

/**
 * Download one UTC day with the dukascopy-node CLI to a staging folder.
 * The caller must invoke cleanup only after the database insert transaction
 * succeeds. On CLI/import failures, the staged CSV is retained for diagnosis.
 */
export async function downloadDateCandlesViaCli(
  options: CliCandleDownloadOptions,
): Promise<CliCandleDownloadResult> {
  utcDayStartSeconds(options.date);
  if (!Number.isSafeInteger(options.jobId) || options.jobId < 1) {
    throw new Error('A positive download job ID is required');
  }

  const stagingRoot = path.join(options.dataRoot, 'dukascopy-cli-staging');
  await fs.mkdir(stagingRoot, { recursive: true });
  const workDir = await fs.mkdtemp(
    path.join(stagingRoot, 'job-' + options.jobId + '-' + options.date + '-'),
  );
  const fileName = 'dukascopy-' + options.instrument.toLowerCase() + '-' + options.date;
  const csvPath = path.join(workDir, fileName + '.csv');
  const args = buildDukascopyCliArgs({
    instrument: options.instrument,
    date: options.date,
    outputDirectory: workDir,
    fileName,
  });

  try {
    await runCli(args, options.signal);
    const csv = await fs.readFile(csvPath, 'utf8');
    const candles = parseDukascopyCliCsv(csv, options.date);
    if (!candles.length && !options.allowEmpty) {
      throw new Error(
        'Dukascopy CLI produced no valid M1 candles for ' + options.date +
        '; staged CSV retained at ' + csvPath,
      );
    }

    return {
      candles,
      csvPath,
      cleanup: async () => fs.rm(workDir, { recursive: true, force: true }),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(detail + ' | CLI staging directory=' + workDir);
  }
}
