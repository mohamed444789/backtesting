import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDukascopyCliArgs,
  parseCsvRecords,
  parseDukascopyCliCsv,
} from './cli-downloader.js';

const date = '2026-10-16';
const startMs = Date.parse(date + 'T00:00:00.000Z');

test('parses quoted CSV, normalizes time as UTC, sorts and deduplicates candles', () => {
  const csv = [
    'timestamp,open,high,low,close,volume',
    '"2026-10-16 00:02:00",1.1,1.3,1.0,1.2,8',
    '"2026-10-16 00:01:00",1.0,1.2,0.9,1.1,7',
    '"2026-10-16 00:01:00",1.0,1.25,0.9,1.15,9',
    '"2026-10-15 23:59:00",1.0,1.2,0.9,1.1,4',
    '"2026-10-17 00:00:00",1.0,1.2,0.9,1.1,4',
    '',
  ].join('\r\n');

  const candles = parseDukascopyCliCsv(csv, date);

  assert.equal(candles.length, 2);
  assert.deepEqual(candles.map(candle => candle.time), [
    Math.floor(startMs / 1000) + 60,
    Math.floor(startMs / 1000) + 120,
  ]);
  assert.equal(candles[0].close, 1.15);
  assert.equal(candles[0].volume, 9);
});

test('accepts quoted commas and escaped quotes in CSV records', () => {
  assert.deepEqual(
    parseCsvRecords('timestamp,open,high,low,close,volume\n"2026-10-16 00:00:00",1,1.2,0.9,1.1,5\n'),
    [
      ['timestamp', 'open', 'high', 'low', 'close', 'volume'],
      ['2026-10-16 00:00:00', '1', '1.2', '0.9', '1.1', '5'],
    ],
  );
  assert.deepEqual(parseCsvRecords('a,b\n"quoted, value","escaped ""quote"""'), [
    ['a', 'b'],
    ['quoted, value', 'escaped "quote"'],
  ]);
});

test('returns no candles for an empty/header-only CLI CSV', () => {
  assert.deepEqual(
    parseDukascopyCliCsv('timestamp,open,high,low,close,volume\n', date),
    [],
  );
});

test('rejects CSV files with unexpected headers and malformed quoting', () => {
  assert.throws(
    () => parseDukascopyCliCsv('time,price\n2026-10-16 00:00:00,1.1\n', date),
    /Unexpected Dukascopy CLI CSV headers/,
  );
  assert.throws(() => parseCsvRecords('timestamp,open\n"unfinished'), /unterminated quoted field/);
});

test('CLI arguments select one UTC M1 bid day as disposable CSV with retries', () => {
  const args = buildDukascopyCliArgs({
    instrument: 'EURUSD',
    date,
    outputDirectory: '/data/staging',
    fileName: 'job-1',
  });

  assert.equal(args[0], '-i');
  assert.ok(args.includes('eurusd'));
  assert.ok(args.includes('m1'));
  assert.ok(args.includes('bid'));
  assert.ok(args.includes('csv'));
  assert.ok(args.includes(date));
  assert.ok(args.includes('2026-10-17'));
  assert.ok(args.includes('/data/staging'));
  assert.ok(args.includes('15'));
  assert.ok(args.includes('2000'));
  assert.ok(args.includes('-fr'));
});

test('rejects invalid date, instrument and required output paths when building CLI arguments', () => {
  assert.throws(
    () => buildDukascopyCliArgs({
      instrument: 'eurusd',
      date: '2026-02-31',
      outputDirectory: '/tmp/out',
      fileName: 'test',
    }),
    /Invalid CLI download date/,
  );
  assert.throws(
    () => buildDukascopyCliArgs({
      instrument: ' ',
      date,
      outputDirectory: '/tmp/out',
      fileName: 'test',
    }),
    /Instrument is required/,
  );
  assert.throws(
    () => buildDukascopyCliArgs({
      instrument: 'eurusd',
      date,
      outputDirectory: ' ',
      fileName: 'test',
    }),
    /CLI output directory is required/,
  );
  assert.throws(
    () => buildDukascopyCliArgs({
      instrument: 'eurusd',
      date,
      outputDirectory: '/tmp/out',
      fileName: ' ',
    }),
    /CLI file name is required/,
  );
  assert.throws(
    () => buildDukascopyCliArgs({
      instrument: 'EUR/USD',
      date,
      outputDirectory: '/tmp/out',
      fileName: 'test',
    }),
    /only letters and digits/,
  );
});
